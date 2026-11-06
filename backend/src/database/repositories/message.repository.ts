import { query } from '../client.js';

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata: Record<string, any>;
  created_at: Date;
}

export class MessageRepository {
  static async create(
    conversationId: string,
    role: string,
    content: string,
    metadata: Record<string, any> = {}
  ): Promise<Message> {
    const sql = `
      INSERT INTO messages (conversation_id, role, content, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING id, conversation_id, role, content, metadata, created_at
    `;
    const res = await query<Message>(sql, [
      conversationId,
      role,
      content,
      JSON.stringify(metadata),
    ]);
    return res.rows[0];
  }

  static async findByConversationId(conversationId: string): Promise<Message[]> {
    const sql = `
      SELECT id, conversation_id, role, content, metadata, created_at
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `;
    const res = await query<Message>(sql, [conversationId]);
    return res.rows;
  }

  static async findById(id: string): Promise<Message | null> {
    const sql = `
      SELECT id, conversation_id, role, content, metadata, created_at
      FROM messages
      WHERE id = $1
    `;
    const res = await query<Message>(sql, [id]);
    return res.rows[0] || null;
  }

  static async delete(id: string): Promise<boolean> {
    const sql = `
      DELETE FROM messages
      WHERE id = $1
    `;
    const res = await query(sql, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
