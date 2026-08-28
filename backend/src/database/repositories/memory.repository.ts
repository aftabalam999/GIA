import { query } from '../client.js';

export interface Memory {
  id: string;
  user_id: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export class MemoryRepository {
  static async create(
    userId: string,
    type: string,
    content: string,
    importance: number,
    confidence: number,
    metadata: Record<string, any> = {}
  ): Promise<Memory> {
    const sql = `
      INSERT INTO memories (user_id, type, content, importance, confidence, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, type, content, importance, confidence, metadata, created_at, updated_at
    `;
    const res = await query<Memory>(sql, [
      userId,
      type,
      content,
      importance,
      confidence,
      JSON.stringify(metadata),
    ]);
    return res.rows[0];
  }

  static async findById(id: string): Promise<Memory | null> {
    const sql = `
      SELECT id, user_id, type, content, importance, confidence, metadata, created_at, updated_at
      FROM memories
      WHERE id = $1
    `;
    const res = await query<Memory>(sql, [id]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async findByUserId(userId: string): Promise<Memory[]> {
    const sql = `
      SELECT id, user_id, type, content, importance, confidence, metadata, created_at, updated_at
      FROM memories
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const res = await query<Memory>(sql, [userId]);
    return res.rows;
  }

  static async delete(id: string): Promise<boolean> {
    const sql = `
      DELETE FROM memories
      WHERE id = $1
    `;
    const res = await query(sql, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  static async update(
    id: string,
    fields: {
      content?: string;
      importance?: number;
      confidence?: number;
      metadata?: Record<string, any>;
    }
  ): Promise<Memory | null> {
    const setParts: string[] = [];
    const values: any[] = [id];
    let counter = 2;

    if (fields.content !== undefined) {
      setParts.push(`content = $${counter++}`);
      values.push(fields.content);
    }
    if (fields.importance !== undefined) {
      setParts.push(`importance = $${counter++}`);
      values.push(fields.importance);
    }
    if (fields.confidence !== undefined) {
      setParts.push(`confidence = $${counter++}`);
      values.push(fields.confidence);
    }
    if (fields.metadata !== undefined) {
      setParts.push(`metadata = $${counter++}`);
      values.push(JSON.stringify(fields.metadata));
    }

    if (setParts.length === 0) {
      return this.findById(id);
    }

    const sql = `
      UPDATE memories
      SET ${setParts.join(', ')}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, user_id, type, content, importance, confidence, metadata, created_at, updated_at
    `;
    const res = await query<Memory>(sql, values);
    return res.rows.length ? res.rows[0] : null;
  }

  static async search(userId: string, queryText: string): Promise<Memory[]> {
    const sql = `
      SELECT id, user_id, type, content, importance, confidence, metadata, created_at, updated_at
      FROM memories
      WHERE user_id = $1 AND content ILIKE $2
      ORDER BY importance DESC, created_at DESC
    `;
    const res = await query<Memory>(sql, [userId, `%${queryText}%`]);
    return res.rows;
  }

  static async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    const vectorStr = `[${embedding.join(',')}]`;
    const sql = `
      UPDATE memories
      SET embedding = $1
      WHERE id = $2
    `;
    await query(sql, [vectorStr, id]);
  }
}
