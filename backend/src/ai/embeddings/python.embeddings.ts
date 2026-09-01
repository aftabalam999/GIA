import { EmbeddingProvider } from './embeddings.interface.js';
import { aiServiceClient } from '../ml-client/ai-service.client.js';

export class PythonEmbeddingProvider implements EmbeddingProvider {
  /**
   * Generates a float vector embedding using Python AI Service EmbeddingService.
   */
  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('Text is required for embedding generation');
    }
    const res = await aiServiceClient.embed(text);
    if (!res.embedding) {
      throw new Error('Python AI Service failed to return valid embedding vector');
    }
    return res.embedding;
  }

  /**
   * Batch embeds multiple strings using Python AI Service EmbeddingService.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }
    const res = await aiServiceClient.embed(texts);
    if (!res.embeddings) {
      throw new Error('Python AI Service failed to return valid batch embeddings');
    }
    return res.embeddings;
  }
}
