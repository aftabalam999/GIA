import { query } from '../../database/client.js';
import { registry } from './registry.js';
import { ValidationError, NotFoundError, AppError, AuthorizationError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { MessageRepository } from '../../database/repositories/message.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { UserRepository } from '../../database/repositories/user.repository.js';
import { PermissionManager } from '../permissions/permission.manager.js';
import { ExecutionTicket } from '../permissions/permission.interface.js';

import { ToolResult } from './tool.interface.js';

export interface ToolExecutionContext {
  ticket?: ExecutionTicket | string;
  stepId?: number;
  testBypass?: boolean;
}

export class ToolExecutor {
  /**
   * Validates tool input, checks authorizations, enforces execution timeouts,
   * handles failures gracefully, and logs execution records to tool_calls relations.
   */
  static async executeTool(
    userId: string,
    toolName: string,
    rawArgs: any,
    messageId: string | null = null,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    // 0. Central Permission Gate check (Mandatory User Approval)
    const isGateEnforced = PermissionManager.isGateEnforced();
    if (context?.ticket || (isGateEnforced && !context?.testBypass)) {
      const verification = await PermissionManager.verifyToolExecution(
        userId,
        toolName,
        rawArgs,
        context?.ticket,
        context?.stepId
      );
      if (!verification.allowed) {
        const errMessage = verification.reason || 'PERMISSION_DENIED: Explicit user approval required.';
        await this.logToolCall(messageId, toolName, rawArgs, 'failed', null, errMessage);
        return { success: false, error: errMessage };
      }
    }
    // 1. Fetch tool definition
    const tool = registry.get(toolName);
    if (!tool) {
      const errMessage = `Tool "${toolName}" not found in registry`;
      await this.logToolCall(messageId, toolName, rawArgs, 'failed', null, errMessage);
      throw new NotFoundError(errMessage);
    }

    // 2. Validate input schema server-side
    const parsed = tool.inputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const errMessage = `Input validation failed: ${JSON.stringify(parsed.error.format())}`;
      await this.logToolCall(messageId, toolName, rawArgs, 'failed', null, errMessage);
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    // 3. Authorization bounds check
    if (tool.permissions && tool.permissions.length > 0) {
      const user = await UserRepository.findById(userId);
      if (!user) {
        const errMessage = `Unauthorized to run tool "${toolName}": User session not found`;
        await this.logToolCall(messageId, toolName, parsed.data, 'failed', null, errMessage);
        throw new AppError(errMessage, 403);
      }

      // Default authorized developer permissions for personal workspace
      const userPermissions = [
        'read:system',
        'open:apps',
        'close:apps',
        'open:folders',
        'read:files',
        'write:files',
        'delete:files',
        'run:commands',
        'capture:screen',
      ];
      const hasAllPermissions = tool.permissions.every((p) => userPermissions.includes(p));
      if (!hasAllPermissions) {
        const missing = tool.permissions.filter((p) => !userPermissions.includes(p));
        const errMessage = `Unauthorized to run tool "${toolName}": Missing permissions: ${missing.join(', ')}`;
        await this.logToolCall(messageId, toolName, parsed.data, 'failed', null, errMessage);
        throw new AppError(errMessage, 403);
      }
    }

    // Enforce associated message owner verification to prevent IDOR logs hijacking
    if (messageId) {
      const msg = await MessageRepository.findById(messageId);
      if (!msg) {
        throw new NotFoundError('Associated message not found');
      }
      const convo = await ConversationRepository.findById(msg.conversation_id);
      if (!convo || convo.user_id !== userId) {
        throw new AuthorizationError('Access denied to this message');
      }
    }

    // Create log placeholder first (status: running)
    const callId = await this.logToolCall(messageId, toolName, parsed.data, 'running');

    // 4. Timeout-bounded execution
    try {
      const executionPromise = tool.execute(parsed.data, { userId });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs)
      );

      const result = await Promise.race([executionPromise, timeoutPromise]);

      // 5. Verification logic (Phase 3)
      let verification;
      if (typeof tool.verify === 'function') {
        try {
          verification = await tool.verify(parsed.data, result, { userId });
          if (!verification.verified) {
            const verifyErr = `Action verification failed: ${verification.message}`;
            await this.updateToolCall(callId, 'failed', result, verifyErr);
            return { success: false, result, verification, error: verifyErr };
          }
        } catch (verifyEx: any) {
          const verifyErr = `Action verification exception: ${verifyEx.message}`;
          await this.updateToolCall(callId, 'failed', result, verifyErr);
          return { success: false, result, error: verifyErr };
        }
      }

      // Update call logs as success
      await this.updateToolCall(callId, 'success', result);

      // Consume step in ticket if ticket & stepId provided
      if (context?.ticket && context?.stepId !== undefined) {
        const token = typeof context.ticket === 'string' ? context.ticket : context.ticket.ticketId;
        await PermissionManager.recordStepConsumed(token, context.stepId);
      }

      return { success: true, result, verification };
    } catch (err: any) {
      logger.error({ msg: 'Tool execution failed', toolName, error: err.message });
      // Update logs as failed
      await this.updateToolCall(callId, 'failed', null, err.message);
      return { success: false, error: err.message };
    }
  }

  private static async logToolCall(
    messageId: string | null,
    toolName: string,
    args: any,
    status: string,
    result: any = null,
    error: string | null = null
  ): Promise<string> {
    const sql = `
      INSERT INTO tool_calls (message_id, tool_name, arguments, status, result, error)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    const res = await query<{ id: string }>(sql, [
      messageId,
      toolName,
      JSON.stringify(args || {}),
      status,
      result ? JSON.stringify(result) : null,
      error,
    ]);
    return res.rows[0].id;
  }

  private static async updateToolCall(
    id: string,
    status: string,
    result: any = null,
    error: string | null = null
  ): Promise<void> {
    const sql = `
      UPDATE tool_calls
      SET status = $1, result = $2, error = $3
      WHERE id = $4
    `;
    await query(sql, [status, result ? JSON.stringify(result) : null, error, id]);
  }
}
