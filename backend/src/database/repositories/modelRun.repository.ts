import { query } from '../client.js';

export interface ModelRun {
  id: string;
  agent_run_id: string | null;
  conversation_id: string | null;
  model_name: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  errors: string | null;
  created_at: Date;
}

export interface ModelRunInput {
  agentRunId?: string | null;
  conversationId?: string | null;
  modelName: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  errors?: string | null;
}

export class ModelRunRepository {
  /**
   * Records execution metrics in the model_runs table.
   */
  static async logRun(input: ModelRunInput): Promise<ModelRun> {
    const sql = `
      INSERT INTO model_runs (
        agent_run_id,
        conversation_id,
        model_name,
        provider,
        prompt_tokens,
        completion_tokens,
        latency_ms,
        errors
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, agent_run_id, conversation_id, model_name, provider, prompt_tokens, completion_tokens, latency_ms, errors, created_at
    `;
    const res = await query<ModelRun>(sql, [
      input.agentRunId || null,
      input.conversationId || null,
      input.modelName,
      input.provider,
      input.promptTokens,
      input.completionTokens,
      input.latencyMs,
      input.errors || null,
    ]);
    return res.rows[0];
  }

  /**
   * Fetches metrics logs for a given conversation.
   */
  static async findByConversationId(conversationId: string): Promise<ModelRun[]> {
    const sql = `
      SELECT id, agent_run_id, conversation_id, model_name, provider, prompt_tokens, completion_tokens, latency_ms, errors, created_at
      FROM model_runs
      WHERE conversation_id = $1
      ORDER BY created_at DESC
    `;
    const res = await query<ModelRun>(sql, [conversationId]);
    return res.rows;
  }
}
