-- ==============================================================================
-- Migration 005: Local Vector Embeddings (384 Dimensions) & Metadata Indexing
-- Updates pgvector columns for local Sentence Transformers (all-MiniLM-L6-v2)
-- ==============================================================================

-- 1. Drop old 1536-dimensional HNSW indexes if they exist
DROP INDEX IF EXISTS idx_memories_embedding_hnsw;
DROP INDEX IF EXISTS idx_document_chunks_embedding_hnsw;

-- 2. Non-destructively clear existing embeddings if they do not match 384 dimensions
DO $$
BEGIN
  -- Safe conversion check: set obsolete dimensions to NULL for re-embedding
  UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL;
  UPDATE document_chunks SET embedding = NULL WHERE embedding IS NOT NULL;
END $$;

-- 3. Alter vector column types to 384 dimensions
ALTER TABLE memories ALTER COLUMN embedding TYPE vector(384);
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(384);

-- 4. Recreate HNSW approximate nearest-neighbour indexes on vector(384)
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 5. Create GIN indexes on metadata for high-performance JSONB filtering
CREATE INDEX IF NOT EXISTS idx_memories_metadata_gin
  ON memories
  USING gin (metadata);

CREATE INDEX IF NOT EXISTS idx_document_chunks_metadata_gin
  ON document_chunks
  USING gin (metadata);

