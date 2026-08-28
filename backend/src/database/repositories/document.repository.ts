import { query } from '../client.js';

export interface Document {
  id: string;
  user_id: string;
  name: string;
  file_url: string;
  mime_type: string;
  file_size: number;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export class DocumentRepository {
  static async create(
    userId: string,
    name: string,
    fileUrl: string,
    mimeType: string,
    fileSize: number,
    metadata: Record<string, any> = {}
  ): Promise<Document> {
    const sql = `
      INSERT INTO documents (user_id, name, file_url, mime_type, file_size, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, name, file_url, mime_type, file_size, metadata, created_at, updated_at
    `;
    const res = await query<Document>(sql, [
      userId,
      name,
      fileUrl,
      mimeType,
      fileSize,
      JSON.stringify(metadata),
    ]);
    return res.rows[0];
  }

  static async findById(id: string): Promise<Document | null> {
    const sql = `
      SELECT id, user_id, name, file_url, mime_type, file_size, metadata, created_at, updated_at
      FROM documents
      WHERE id = $1
    `;
    const res = await query<Document>(sql, [id]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async findByUserId(userId: string): Promise<Document[]> {
    const sql = `
      SELECT id, user_id, name, file_url, mime_type, file_size, metadata, created_at, updated_at
      FROM documents
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const res = await query<Document>(sql, [userId]);
    return res.rows;
  }

  static async delete(id: string): Promise<boolean> {
    const sql = `
      DELETE FROM documents
      WHERE id = $1
    `;
    const res = await query(sql, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
