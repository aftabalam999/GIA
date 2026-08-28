-- Add HNSW approximate nearest-neighbour indexes to embedding columns.
-- Without these, every vector similarity search performs a full sequential table scan,
-- which degrades from ~5ms to 5+ seconds as data grows.
--
-- HNSW (Hierarchical Navigable Small World) provides O(log n) approximate nearest
-- neighbour search with high recall at the cost of ~2x storage and index build time.
--
-- NOTE: Building these indexes on large existing datasets is a blocking operation.
-- For production tables with >100k rows, consider using CREATE INDEX CONCURRENTLY.

-- Index on memories.embedding (cosine distance)
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index on document_chunks.embedding (cosine distance)
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
