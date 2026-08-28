export interface EmbeddingProvider {
  /**
   * Generates a 1536-dimensional float embedding array for the given input text.
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generates embeddings in batch for a list of input texts.
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}
