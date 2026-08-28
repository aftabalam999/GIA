import { query } from '../../database/client.js';
import { VectorStore, VectorSearchResult } from './vectorstore.interface.js';
import { MemoryRepository } from '../../database/repositories/memory.repository.js';
import { logger } from '../../shared/logger.js';
import { DatabaseError } from '../../shared/errors.js';

export class PostgresVectorStore implements VectorStore {
  async saveMemoryEmbedding(id: string, embedding: number[]): Promise<void> {
    try {
      await MemoryRepository.updateEmbedding(id, embedding);
    } catch (err: any) {
      logger.error({ msg: 'Failed to update memory embedding in postgres', id, err: err.message });
      throw new DatabaseError(`Failed to save memory embedding: ${err.message}`, err);
    }
  }

  async searchMemories(
    userId: string,
    embedding: number[],
    limit = 5,
    threshold = 0.5
  ): Promise<VectorSearchResult[]> {
    const vectorStr = `[${embedding.join(',')}]`;
    const sql = `
      SELECT id, content, type, metadata, (1 - (embedding <=> $1::vector)) as score
      FROM memories
      WHERE user_id = $2 
        AND embedding IS NOT NULL 
        AND (1 - (embedding <=> $1::vector)) >= $3
      ORDER BY score DESC
      LIMIT $4
    `;

    try {
      const res = await query<{
        id: string;
        content: string;
        type: string;
        metadata: any;
        score: number;
      }>(sql, [vectorStr, userId, threshold, limit]);

      return res.rows.map((row) => ({
        id: row.id,
        content: row.content,
        type: row.type,
        score: row.score,
        metadata: row.metadata,
      }));
    } catch (err: any) {
      logger.error({ msg: 'PostgresVectorStore similarity query failed', userId, err: err.message });
      throw new DatabaseError(`Vector search failed: ${err.message}`, err);
    }
  }
}
