export interface VectorSearchResult {
  id: string;
  content: string;
  type: string;
  score: number;
  metadata: Record<string, any>;
}

export interface VectorStore {
  /**
   * Updates a memory's embedding vector in storage.
   */
  saveMemoryEmbedding(id: string, embedding: number[]): Promise<void>;

  /**
   * Perfroms cosine similarity search on memories.
   */
  searchMemories(
    userId: string,
    embedding: number[],
    limit?: number,
    threshold?: number,
    category?: string,
    metadataFilter?: Record<string, any>
  ): Promise<VectorSearchResult[]>;
}
