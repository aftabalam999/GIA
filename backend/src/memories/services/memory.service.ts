import { MemoryRepository, Memory } from '../../database/repositories/memory.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { LLMGateway } from '../../ai/router/index.js';
import { getEmbeddingProvider } from '../../ai/embeddings/router.js';
import { PostgresVectorStore } from '../../ai/vectorstore/postgres.vectorstore.js';
import { AppError, AuthorizationError, AuthenticationError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export class MemoryService {
  /**
   * Asserts user ownership of the memory object.
   */
  private static async verifyOwnership(userId: string, id: string): Promise<Memory> {
    const memory = await MemoryRepository.findById(id);
    if (!memory) {
      throw new NotFoundError('Memory not found');
    }
    if (memory.user_id !== userId) {
      throw new AuthorizationError('Access denied to this memory record');
    }
    return memory;
  }

  static async createMemory(
    userId: string,
    type: string,
    content: string,
    importance: number,
    confidence: number,
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    if (importance < 1 || importance > 10) {
      throw new ValidationError('Importance score must be between 1 and 10');
    }
    if (confidence < 0.0 || confidence > 1.0) {
      throw new ValidationError('Confidence score must be between 0.0 and 1.0');
    }
    const memory = await MemoryRepository.create(userId, type, content, importance, confidence, metadata);

    try {
      const embeddingProvider = getEmbeddingProvider();
      const embedding = await embeddingProvider.embed(content);
      const vectorStore = new PostgresVectorStore();
      await vectorStore.saveMemoryEmbedding(memory.id, embedding);
    } catch (err: any) {
      logger.error({ msg: 'Failed to generate/save embedding during memory creation', id: memory.id, err: err.message });
    }

    return memory;
  }

  /**
   * 1. Short-Term Memory creation helper (current conversation state / active tasks).
   */
  static async createShortTermMemory(
    userId: string,
    content: string,
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    return this.createMemory(userId, 'short_term', content, 5, 0.9, { category: 'short_term', ...metadata });
  }

  /**
   * 2. Long-Term Semantic Memory creation helper (durable user facts, coding preferences, persistent context).
   */
  static async createLongTermSemanticMemory(
    userId: string,
    content: string,
    importance = 8,
    confidence = 0.95,
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    return this.createMemory(userId, 'long_term_semantic', content, importance, confidence, { category: 'long_term_semantic', ...metadata });
  }

  /**
   * 3. Episodic Memory creation helper (important events, architectural decisions, task milestones).
   */
  static async createEpisodicMemory(
    userId: string,
    content: string,
    importance = 9,
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    return this.createMemory(userId, 'episodic', content, importance, 0.95, { category: 'episodic', ...metadata });
  }

  static async getMemoryById(userId: string, id: string): Promise<Memory> {
    return this.verifyOwnership(userId, id);
  }

  static async getMemoriesByCategory(userId: string, category: string): Promise<Memory[]> {
    return MemoryRepository.findByType(userId, category);
  }

  static async updateMemory(
    userId: string,
    id: string,
    fields: {
      content?: string;
      importance?: number;
      confidence?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<Memory> {
    await this.verifyOwnership(userId, id);
    if (fields.importance !== undefined && (fields.importance < 1 || fields.importance > 10)) {
      throw new ValidationError('Importance score must be between 1 and 10');
    }
    if (fields.confidence !== undefined && (fields.confidence < 0.0 || fields.confidence > 1.0)) {
      throw new ValidationError('Confidence score must be between 0.0 and 1.0');
    }
    
    const updated = await MemoryRepository.update(id, fields);
    if (!updated) {
      throw new NotFoundError('Memory update failed');
    }
    return updated;
  }

  static async deleteMemory(userId: string, id: string): Promise<boolean> {
    await this.verifyOwnership(userId, id);
    return MemoryRepository.delete(id);
  }

  static async searchMemories(userId: string, queryText: string, category?: string): Promise<Memory[]> {
    return MemoryRepository.search(userId, queryText, category);
  }

  /**
   * Analyzes text, extracts relevant facts worth remembering, and persists them into long-term semantic / episodic memory.
   */
  static async extractAndSaveMemory(
    userId: string,
    conversationId: string,
    messageText: string
  ): Promise<Memory[]> {
    // Verify conversation ownership
    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) {
      throw new NotFoundError('Conversation not found');
    }
    if (convo.user_id !== userId) {
      throw new AuthorizationError('Access denied to this conversation');
    }

    // 1. Fallback deterministic keyword parsing for tests / Mock environments
    const lowerText = messageText.toLowerCase();
    if (lowerText.startsWith('remember that ')) {
      const fact = messageText.slice(14).trim();
      const created = await this.createLongTermSemanticMemory(userId, fact, 8, 0.95, { conversationId });
      return [created];
    }
    if (lowerText.startsWith('save note: ')) {
      const note = messageText.slice(11).trim();
      const created = await this.createEpisodicMemory(userId, note, 7, { conversationId });
      return [created];
    }

    // 2. Gateway extraction execution
    const prompt = `You are GIA's memory extraction module.
Analyze the user message and extract facts, decisions, or preferences worth remembering.
Return a valid JSON object matching this schema:
{
  "should_remember": boolean,
  "facts": [
    {
      "type": "long_term_semantic" | "episodic" | "short_term",
      "content": "the specific fact, preference, or event content",
      "importance": number (between 1 and 10),
      "confidence": number (between 0.0 and 1.0)
    }
  ]
}

User Message: "${messageText}"`;

    try {
      const response = await LLMGateway.generate({
        messages: [{ role: 'user', content: prompt }]
      }, { conversationId });

      const parsed = JSON.parse(response.content.trim());
      if (parsed.should_remember && Array.isArray(parsed.facts)) {
        const savedMemories: Memory[] = [];
        const validTypes = ['long_term_semantic', 'episodic', 'short_term', 'user_preference', 'explicit_note'];
        for (const fact of parsed.facts) {
          let type = validTypes.includes(fact.type) ? fact.type : 'long_term_semantic';
          if (type === 'user_preference') type = 'long_term_semantic';
          if (type === 'explicit_note') type = 'episodic';

          const importance = Math.max(1, Math.min(10, Math.round(fact.importance || 5)));
          const confidence = Math.max(0.0, Math.min(1.0, fact.confidence || 0.8));
          
          if (confidence >= 0.7) {
            const memory = await this.createMemory(
              userId,
              type,
              fact.content || '',
              importance,
              confidence,
              { conversationId, extracted: true, category: type }
            );
            savedMemories.push(memory);
          }
        }
        return savedMemories;
      }
    } catch (err: any) {
      logger.warn({ msg: 'Memory extraction failed or returned non-JSON response', err: err.message });
    }

    return [];
  }

  /**
   * Generates embedding for queryText and searches user vector store.
   */
  static async searchMemoriesSemantic(
    userId: string,
    queryText: string,
    limit = 5,
    threshold = 0.5,
    category?: string
  ): Promise<any[]> {
    try {
      const embeddingProvider = getEmbeddingProvider();
      const embedding = await embeddingProvider.embed(queryText);
      const vectorStore = new PostgresVectorStore();
      return await vectorStore.searchMemories(userId, embedding, limit, threshold, category);
    } catch (err: any) {
      throw new AppError(`Semantic search failed: ${err.message}`, 500, { originalError: err.message });
    }
  }
}
