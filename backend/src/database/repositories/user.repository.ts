import { query } from '../client.js';

export interface User {
  id: string;
  email: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  password_hash?: string; // Optional to prevent accidental leakage in standard DTOs
}

export class UserRepository {
  static async create(email: string, name: string, passwordHash: string): Promise<User> {
    const sql = `
      INSERT INTO users (email, name, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, email, name, created_at, updated_at
    `;
    const res = await query<User>(sql, [email, name, passwordHash]);
    return res.rows[0];
  }

  static async findById(id: string): Promise<User | null> {
    const sql = `
      SELECT id, email, name, created_at, updated_at
      FROM users
      WHERE id = $1
    `;
    const res = await query<User>(sql, [id]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async findByEmail(email: string): Promise<User | null> {
    const sql = `
      SELECT id, email, name, created_at, updated_at
      FROM users
      WHERE email = $1
    `;
    const res = await query<User>(sql, [email]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async findByEmailWithPassword(email: string): Promise<(User & { password_hash: string }) | null> {
    const sql = `
      SELECT id, email, name, password_hash, created_at, updated_at
      FROM users
      WHERE email = $1
    `;
    const res = await query<User & { password_hash: string }>(sql, [email]);
    return res.rows.length ? res.rows[0] : null;
  }

  static async update(
    id: string,
    updates: { email?: string; name?: string; passwordHash?: string }
  ): Promise<User | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (updates.email !== undefined) {
      fields.push(`email = $${idx++}`);
      values.push(updates.email);
    }
    if (updates.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(updates.name);
    }
    if (updates.passwordHash !== undefined) {
      fields.push(`password_hash = $${idx++}`);
      values.push(updates.passwordHash);
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    const sql = `
      UPDATE users
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id, email, name, created_at, updated_at
    `;
    const res = await query<User>(sql, values);
    return res.rows.length ? res.rows[0] : null;
  }

  static async delete(id: string): Promise<boolean> {
    const sql = `
      DELETE FROM users
      WHERE id = $1
    `;
    const res = await query(sql, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
