import { EmbeddingProvider } from './embeddings.interface.js';

export class MockEmbeddingProvider implements EmbeddingProvider {
  private shouldFail = false;

  setShouldFail(val: boolean) {
    this.shouldFail = val;
  }

  async embed(text: string): Promise<number[]> {
    if (this.shouldFail || text === 'fail_embedding') {
      throw new Error('Simulated embedding provider failure');
    }

    const vector = new Array(1536).fill(0);
    const lower = text.toLowerCase();

    // Map semantic zones to verify cosine similarity assertions in test suites
    if (lower.includes('python') || lower.includes('code') || lower.includes('programming')) {
      for (let i = 0; i < 100; i++) vector[i] = 0.8;
    } else if (lower.includes('java')) {
      for (let i = 0; i < 50; i++) vector[i] = 0.8;
    } else if (lower.includes('chocolate') || lower.includes('sweet') || lower.includes('food')) {
      for (let i = 1436; i < 1536; i++) vector[i] = 0.8;
    } else {
      // General fallbacks
      for (let i = 500; i < 600; i++) vector[i] = 0.5;
    }

    // Normalize vector to unit length
    let sumSquares = 0;
    for (let i = 0; i < 1536; i++) sumSquares += vector[i] * vector[i];
    const norm = Math.sqrt(sumSquares);
    if (norm > 0) {
      for (let i = 0; i < 1536; i++) vector[i] /= norm;
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
