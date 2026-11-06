import { DocumentChunkRepository, ChunkSearchResult } from '../../database/repositories/documentChunk.repository.js';
import { MemoryService } from '../../memories/services/memory.service.js';
import { MessageRepository, Message } from '../../database/repositories/message.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { LLMGateway } from '../../ai/router/index.js';
import { getEmbeddingProvider } from '../../ai/embeddings/router.js';
import { ContextBuilder } from '../../ai/orchestrator/contextBuilder.js';
import { logger } from '../../shared/logger.js';
import { AuthorizationError, NotFoundError } from '../../shared/errors.js';
import { aiServiceClient } from '../../ai/ml-client/ai-service.client.js';

export interface RAGRetrieveOptions {
  limit?: number;
  threshold?: number;
  metadataFilter?: Record<string, any>;
  documentId?: string;
  category?: string;
}

export interface RAGSendMessageOptions extends RAGRetrieveOptions {
  strictGrounded?: boolean;
  fallbackMessage?: string;
}

export class RAGService {
  /**
   * Retrieves matching documents and preferences per tenant.
   * Document chunks are retrieved via PostgreSQL pgvector search and reranked via local Python Reranker Service.
   * Fully offline, supports metadata filtering and similarity thresholds.
   */
  static async queryAndRetrieve(
    userId: string,
    queryText: string,
    limitOrOptions: number | RAGRetrieveOptions = 3,
    thresholdArg = 0.5,
    metadataFilterArg?: Record<string, any>,
    documentIdArg?: string
  ): Promise<{ chunks: ChunkSearchResult[]; memories: any[] }> {
    try {
      let limit = 3;
      let threshold = 0.5;
      let metadataFilter: Record<string, any> | undefined = undefined;
      let documentId: string | undefined = undefined;
      let category: string | undefined = undefined;

      if (typeof limitOrOptions === 'object') {
        limit = limitOrOptions.limit ?? 3;
        threshold = limitOrOptions.threshold ?? 0.5;
        metadataFilter = limitOrOptions.metadataFilter;
        documentId = limitOrOptions.documentId;
        category = limitOrOptions.category;
      } else {
        limit = limitOrOptions;
        threshold = thresholdArg;
        metadataFilter = metadataFilterArg;
        documentId = documentIdArg;
      }

      const embeddingProvider = getEmbeddingProvider();
      const embedding = await embeddingProvider.embed(queryText);

      // Search document chunks semantically in PostgreSQL + pgvector
      const candidateChunks = await DocumentChunkRepository.searchSimilarChunks(
        userId,
        embedding,
        limit * 2,
        threshold,
        metadataFilter,
        documentId
      );

      let finalChunks = candidateChunks;

      // Execute local Python Reranker Service if candidate chunks exist
      if (candidateChunks.length > 1) {
        try {
          const docTexts = candidateChunks.map((c) => c.content);
          const rerankRes = await aiServiceClient.rerank(queryText, docTexts, limit);
          if (rerankRes.results && rerankRes.results.length > 0) {
            finalChunks = rerankRes.results
              .map((r) => candidateChunks[r.index])
              .filter(Boolean);
          }
        } catch (rerankErr: any) {
          logger.warn({ msg: 'Python Reranker Service call failed; preserving pgvector order', err: rerankErr.message });
          finalChunks = candidateChunks.slice(0, limit);
        }
      } else {
        finalChunks = candidateChunks.slice(0, limit);
      }

      // Search user preference memories semantically
      const memories = await MemoryService.searchMemoriesSemantic(
        userId,
        queryText,
        limit,
        threshold,
        category,
        metadataFilter
      );

      return { chunks: finalChunks, memories };
    } catch (err: any) {
      logger.warn({ msg: 'RAG retrieval step failed. Falling back to general generation', err: err.message });
      return { chunks: [], memories: [] };
    }
  }

  /**
   * Executes a full RAG query: retrieves facts -> constructs prompt -> queries Qwen LLM -> persists output.
   * Preserves conversation context across multi-turn interactions.
   * Provides grounded fallback responses when relevant documents are unavailable.
   */
  static async sendMessageRAG(
    userId: string,
    conversationId: string,
    content: string,
    options: RAGSendMessageOptions = {}
  ): Promise<{ userMessage: Message; assistantMessage: Message; sources: ChunkSearchResult[] }> {
    // 1. Verify conversation ownership
    const conversation = await ConversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    if (conversation.user_id !== userId) {
      throw new AuthorizationError('Access denied to this conversation');
    }

    // 2. Persist user message
    const userMessage = await MessageRepository.create(conversationId, 'user', content);

    // 3. Execute retrieval pipeline with thresholds and metadata filters
    const { chunks, memories } = await this.queryAndRetrieve(userId, content, options);

    // 4. Grounded Fallback handling if no documents were found
    if (chunks.length === 0 && options.strictGrounded) {
      const fallbackContent =
        options.fallbackMessage ||
        "I could not find any relevant documents or facts in your knowledge base to answer this question. Please upload relevant documentation or clarify your query.";

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        fallbackContent,
        { model: 'qwen3.5-4b', provider: 'qwen', rag_sources: [], grounded: false, fallback: true }
      );

      return {
        userMessage,
        assistantMessage,
        sources: [],
      };
    }

    // 5. Construct prompt sections
    let contextStr = '';
    
    if (memories.length > 0) {
      contextStr += '\n=== USER PREFERENCES & MEMORIES ===\n';
      memories.forEach((m) => {
        contextStr += `- [Memory preference] ${m.content} (confidence: ${m.confidence})\n`;
      });
    }

    if (chunks.length > 0) {
      contextStr += '\n=== RETRIEVED DOCUMENT KNOWLEDGE ===\n';
      chunks.forEach((chunk, idx) => {
        const sourceUrl = chunk.source_url ? ` (Source: ${chunk.source_url})` : '';
        contextStr += `[Reference #${idx + 1}] Document: "${chunk.title}"${sourceUrl}\n`;
        contextStr += `Content: ${chunk.content}\n\n`;
      });
    }

    // Assemble system instructions
    let groundingInstructions = '';
    if (chunks.length > 0) {
      groundingInstructions = `
When formulating your response:
1. Ground your answer strictly on the facts provided under "RETRIEVED DOCUMENT KNOWLEDGE".
2. You must cite each document title (e.g. [Reference #1: "${chunks[0]?.title}"]).
3. If the user question cannot be fully answered from the retrieved documents, clearly state what information is missing.
4. Adapt your tone and response style to match "USER PREFERENCES & MEMORIES" if provided.`;
    } else {
      groundingInstructions = `
Note: No relevant documents were found in the knowledge base matching this query.
Acknowledge that no matching background documents were found, and then provide a helpful response using your general knowledge while clarifying that it is not sourced from uploaded documents.`;
    }

    const systemPrompt = `You are GIA (General Intelligent Assistant), a helpful, concise, and capable personal desktop AI assistant.
${groundingInstructions}

Retrieved Context Info:${contextStr || '\n(No relevant background documents or memories found)'}`;

    // 6. Build prompt context mapping recent dialog history (preserves multi-turn context)
    const history = await MessageRepository.findByConversationId(conversationId);
    
    const llmRequest = ContextBuilder.buildContext(history);
    llmRequest.systemPrompt = systemPrompt;
    llmRequest.maxTokens = 400;
    llmRequest.enableThinking = false;

    // 7. Generate answer using local Qwen 3.5 4B via LLM Gateway
    const response = await LLMGateway.generate(llmRequest, { conversationId });

    // 8. Persist assistant reply with citations
    const assistantMessage = await MessageRepository.create(
      conversationId,
      'assistant',
      response.content,
      {
        model: response.model,
        provider: response.provider,
        rag_sources: chunks.map((c) => c.id),
        grounded: chunks.length > 0,
      }
    );

    return {
      userMessage,
      assistantMessage,
      sources: chunks,
    };
  }
}
