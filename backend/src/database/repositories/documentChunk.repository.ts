import { query } from '../client.js';

export interface DocumentChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
  metadata: Record<string, any>;
  created_at: Date;
}

export interface ChunkSearchResult {
  id: string;
  document_id: string;
  title: string;
  source_url: string | null;
  content: string;
  score: number;
  metadata: Record<string, any>;
}

export class DocumentChunkRepository {
  static async create(
    documentId: string,
    chunkIndex: number,
    content: string,
    metadata: Record<string, any> = {}
  ): Promise<DocumentChunk> {
    const sql = `
      INSERT INTO document_chunks (document_id, chunk_index, content, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING id, document_id, chunk_index, content, embedding, metadata, created_at
    `;
    const res = await query<DocumentChunk>(sql, [
      documentId,
      chunkIndex,
      content,
      JSON.stringify(metadata),
    ]);
    return res.rows[0];
  }

  static async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    const vectorStr = `[${embedding.join(',')}]`;
    const sql = `
      UPDATE document_chunks
      SET embedding = $1
      WHERE id = $2
    `;
    await query(sql, [vectorStr, id]);
  }

  static async findById(id: string): Promise<DocumentChunk | null> {
    const sql = `
      SELECT id, document_id, chunk_index, content, embedding, metadata, created_at
      FROM document_chunks
      WHERE id = $1
    `;
    const res = await query<DocumentChunk>(sql, [id]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async searchSimilarChunks(
    userId: string,
    embedding: number[],
    limit = 5,
    threshold = 0.5
  ): Promise<ChunkSearchResult[]> {
    const vectorStr = `[${embedding.join(',')}]`;
    // Cosine similarity matching joined on documents table to filter by user_id
    const sql = `
      SELECT dc.id, dc.document_id, dc.content, dc.metadata, d.name AS title, d.file_url AS source_url,
             (1 - (dc.embedding <=> $1::vector)) as score
      FROM document_chunks dc
      JOIN documents d ON dc.document_id = d.id
      WHERE d.user_id = $2 
        AND dc.embedding IS NOT NULL 
        AND (1 - (dc.embedding <=> $1::vector)) >= $3
      ORDER BY score DESC
      LIMIT $4
    `;
    const res = await query<any>(sql, [vectorStr, userId, threshold, limit]);
    return res.rows.map((row) => ({
      id: row.id,
      document_id: row.document_id,
      title: row.title,
      source_url: row.source_url,
      content: row.content,
      score: row.score,
      metadata: row.metadata,
    }));
  }
}
