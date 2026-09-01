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

export class RAGService {
  /**
   * Retrieves matching documents and preferences per tenant.
   * Document chunks are retrieved via PostgreSQL pgvector search and reranked via Python Reranker Service.
   */
  static async queryAndRetrieve(
    userId: string,
    queryText: string,
    limit = 3,
    threshold = 0.5
  ): Promise<{ chunks: ChunkSearchResult[]; memories: any[] }> {
    try {
      const embeddingProvider = getEmbeddingProvider();
      const embedding = await embeddingProvider.embed(queryText);

      // Search document chunks semantically in PostgreSQL + pgvector
      const candidateChunks = await DocumentChunkRepository.searchSimilarChunks(userId, embedding, limit * 2, threshold);

      let finalChunks = candidateChunks;

      // Execute Python Reranker Service if candidate chunks exist
      if (candidateChunks.length > 1) {
        try {
          const docTexts = candidateChunks.map((c) => c.content);
          const rerankRes = await aiServiceClient.rerank(queryText, docTexts, limit);
          if (rerankRes.results && rerankRes.results.length > 0) {
            finalChunks = rerankRes.results.map((r) => candidateChunks[r.index]).filter(Boolean);
          }
        } catch (rerankErr: any) {
          logger.warn({ msg: 'Python Reranker Service call failed; preserving pgvector order', err: rerankErr.message });
          finalChunks = candidateChunks.slice(0, limit);
        }
      } else {
        finalChunks = candidateChunks.slice(0, limit);
      }

      // Search user preference memories semantically
      const memories = await MemoryService.searchMemoriesSemantic(userId, queryText, limit, threshold);

      return { chunks: finalChunks, memories };
    } catch (err: any) {
      logger.warn({ msg: 'RAG retrieval step failed. Falling back to general generation', err: err.message });
      return { chunks: [], memories: [] };
    }
  }

  /**
   * Executes a full RAG query: retrieves facts -> constructs prompt -> queries LLM -> persists output.
   */
  static async sendMessageRAG(
    userId: string,
    conversationId: string,
    content: string
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

    // 3. Execute retrieval pipeline
    const { chunks, memories } = await this.queryAndRetrieve(userId, content);

    // 4. Construct prompt sections
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
    const systemPrompt = `You are GIA, a modular personal assistant.
Answer the user's questions clearly, concisely, and accurately.

When formulating your response:
1. If "RETRIEVED DOCUMENT KNOWLEDGE" is provided, you must reference the Document Title. Citing sources strictly establishes authority.
2. If "USER PREFERENCES & MEMORIES" is provided, adapt your answers to match these traits.
3. Distinguish clearly between:
   - Retrieved facts (cites references)
   - User preferences/memories
   - Raw dialogue history
   - Your own general model knowledge
4. Avoid guaranteeing absolute factual correctness; acknowledge context source boundaries.

Retrieved Context Info:${contextStr || '\n(No relevant background documents or memories found)'}`;

    // 5. Build prompt context mapping recent dialog history
    const history = await MessageRepository.findByConversationId(conversationId);
    
    // Conforms message history list
    const llmRequest = ContextBuilder.buildContext(history);
    llmRequest.systemPrompt = systemPrompt;

    // 6. Generate answer using LLM Gateway
    const response = await LLMGateway.generate(llmRequest, { conversationId });

    // 7. Persist assistant reply
    const assistantMessage = await MessageRepository.create(
      conversationId,
      'assistant',
      response.content,
      { model: response.model, provider: response.provider, rag_sources: chunks.map(c => c.id) }
    );

    return {
      userMessage,
      assistantMessage,
      sources: chunks,
    };
  }
}
