import { query } from '../../database/client.js';
import { PlanExecutionResult, StepExecutionRecord } from './execution.interface.js';

export class ExecutionRepository {
  static async createExecution(
    executionId: string,
    planId: string,
    planVersion: number,
    userId: string,
    totalSteps: number,
    approvalId?: string
  ): Promise<void> {
    const sql = `
      INSERT INTO plan_executions (
        id, plan_id, plan_version, approval_id, user_id,
        status, total_steps, completed_steps, started_at
      )
      VALUES ($1, $2, $3, $4, $5, 'running', $6, 0, NOW())
    `;
    await query(sql, [
      executionId,
      planId,
      planVersion,
      approvalId || null,
      userId,
      totalSteps,
    ]);
  }

  static async updateExecutionStatus(
    executionId: string,
    status: 'completed' | 'failed' | 'cancelled',
    completedSteps: number,
    failedStepId?: number,
    errorMessage?: string
  ): Promise<void> {
    const sql = `
      UPDATE plan_executions
      SET status = $1,
          completed_steps = $2,
          failed_step_id = $3,
          error_message = $4,
          completed_at = NOW()
      WHERE id = $5
    `;
    await query(sql, [
      status,
      completedSteps,
      failedStepId || null,
      errorMessage || null,
      executionId,
    ]);
  }

  static async logStepExecution(
    executionId: string,
    planId: string,
    record: StepExecutionRecord
  ): Promise<void> {
    const sql = `
      INSERT INTO plan_step_executions (
        execution_id, plan_id, step_id, action, tool_name,
        tool_args, status, result, verification, error,
        started_at, completed_at, duration_ms
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `;
    await query(sql, [
      executionId,
      planId,
      record.stepId,
      record.action,
      record.toolName || null,
      JSON.stringify(record.toolArgs || {}),
      record.status,
      record.result ? JSON.stringify(record.result) : null,
      record.verification ? JSON.stringify(record.verification) : null,
      record.error || null,
      record.startedAt || null,
      record.completedAt || null,
      record.durationMs || null,
    ]);
  }

  static async getExecutionHistory(planId: string): Promise<any[]> {
    const sql = `
      SELECT * FROM plan_executions
      WHERE plan_id = $1
      ORDER BY created_at DESC
    `;
    const res = await query(sql, [planId]);
    return res.rows;
  }

  static async getStepExecutions(executionId: string): Promise<any[]> {
    const sql = `
      SELECT * FROM plan_step_executions
      WHERE execution_id = $1
      ORDER BY step_id ASC
    `;
    const res = await query(sql, [executionId]);
    return res.rows;
  }
}

