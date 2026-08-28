import { EmbeddingProvider } from './embeddings.interface.js';
import { withRetryAndTimeout } from '../../shared/retry.js';
import { logger } from '../../shared/logger.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = 'text-embedding-3-small') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return withRetryAndTimeout(async (signal) => {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Embeddings API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as any;
      return data.data.map((item: any) => item.embedding);
    });
  }
}
