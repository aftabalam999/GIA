import { query } from '../../database/client.js';
import { ExecutionPlan } from './planner.interface.js';

export class PlanRepository {
  static async create(plan: Omit<ExecutionPlan, 'created_at' | 'updated_at'>): Promise<ExecutionPlan> {
    const sql = `
      INSERT INTO task_plans (
        id, conversation_id, user_id, objective, status,
        is_ambiguous, clarification_question, steps, approval, metadata, version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const res = await query<any>(sql, [
      plan.id,
      plan.conversation_id,
      plan.user_id,
      plan.objective,
      plan.status,
      plan.is_ambiguous,
      plan.clarification_question,
      JSON.stringify(plan.steps),
      JSON.stringify(plan.approval),
      JSON.stringify(plan.metadata),
      plan.version,
    ]);

    return this.mapRow(res.rows[0]);
  }

  static async findById(id: string): Promise<ExecutionPlan | null> {
    const sql = `SELECT * FROM task_plans WHERE id = $1`;
    const res = await query<any>(sql, [id]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  static async findActiveByConversationId(conversationId: string): Promise<ExecutionPlan | null> {
    const sql = `
      SELECT * FROM task_plans
      WHERE conversation_id = $1
        AND status IN ('awaiting_approval', 'draft', 'modifying', 'approved', 'executing')
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    const res = await query<any>(sql, [conversationId]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  static async update(id: string, updates: Partial<ExecutionPlan>): Promise<ExecutionPlan> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Task plan with id ${id} not found`);
    }

    if (updates.status === 'approved' && (existing.status === 'cancelled' || existing.status === 'rejected')) {
      throw new Error(`Cannot approve plan: plan has already been ${existing.status}`);
    }

    const merged = { ...existing, ...updates };
    const newVersion = (updates.steps || updates.objective) ? (existing.version + 1) : existing.version;
    const approvalGuard = updates.status === 'approved' ? "AND status NOT IN ('cancelled', 'rejected')" : '';

    const sql = `
      UPDATE task_plans
      SET objective = $1,
          status = $2,
          is_ambiguous = $3,
          clarification_question = $4,
          steps = $5,
          approval = $6,
          metadata = $7,
          version = $8,
          updated_at = NOW()
      WHERE id = $9 ${approvalGuard}
      RETURNING *
    `;

    const res = await query<any>(sql, [
      merged.objective,
      merged.status,
      merged.is_ambiguous,
      merged.clarification_question,
      JSON.stringify(merged.steps),
      JSON.stringify(merged.approval),
      JSON.stringify(merged.metadata),
      newVersion,
      id,
    ]);

    if (res.rows.length === 0) {
      const current = await this.findById(id);
      throw new Error(`Plan update failed: current status is '${current?.status || 'unknown'}'`);
    }

    return this.mapRow(res.rows[0]);
  }

  static async delete(id: string): Promise<boolean> {
    const sql = `DELETE FROM task_plans WHERE id = $1`;
    const res = await query(sql, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  static async listByConversationId(conversationId: string): Promise<ExecutionPlan[]> {
    const sql = `
      SELECT * FROM task_plans
      WHERE conversation_id = $1
      ORDER BY created_at DESC
    `;
    const res = await query<any>(sql, [conversationId]);
    return res.rows.map((row) => this.mapRow(row));
  }

  private static mapRow(row: any): ExecutionPlan {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      user_id: row.user_id,
      objective: row.objective,
      status: row.status,
      is_ambiguous: Boolean(row.is_ambiguous),
      clarification_question: row.clarification_question || null,
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps || []),
      approval: typeof row.approval === 'string' ? JSON.parse(row.approval) : (row.approval || { required: true, approved: false }),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      version: Number(row.version) || 1,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    };
  }
}

