import { query } from '../client.js';

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export class ConversationRepository {
  static async create(
    userId: string,
    title: string,
    summary: string | null = null,
    metadata: Record<string, any> = {}
  ): Promise<Conversation> {
    const sql = `
      INSERT INTO conversations (user_id, title, summary, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING id, user_id, title, summary, metadata, created_at, updated_at
    `;
    const res = await query<Conversation>(sql, [
      userId,
      title,
      summary,
      JSON.stringify(metadata),
    ]);
    return res.rows[0];
  }

  static async findById(id: string): Promise<Conversation | null> {
    const sql = `
      SELECT id, user_id, title, summary, metadata, created_at, updated_at
      FROM conversations
      WHERE id = $1
    `;
    const res = await query<Conversation>(sql, [id]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async findByUserId(userId: string): Promise<Conversation[]> {
    const sql = `
      SELECT id, user_id, title, summary, metadata, created_at, updated_at
      FROM conversations
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const res = await query<Conversation>(sql, [userId]);
    return res.rows;
  }

  static async update(
    id: string,
    updates: { title?: string; summary?: string | null; metadata?: Record<string, any> }
  ): Promise<Conversation | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(updates.title);
    }
    if (updates.summary !== undefined) {
      fields.push(`summary = $${idx++}`);
      values.push(updates.summary);
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${idx++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    const sql = `
      UPDATE conversations
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id, user_id, title, summary, metadata, created_at, updated_at
    `;
    const res = await query<Conversation>(sql, values);
    return res.rows.length ? res.rows[0] : null;
  }

  static async delete(id: string): Promise<boolean> {
    const sql = `
      DELETE FROM conversations
      WHERE id = $1
    `;
    const res = await query(sql, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
