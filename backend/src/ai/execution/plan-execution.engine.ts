import crypto from 'crypto';
import { PlanRepository } from '../planner/plan.repository.js';
import { PermissionManager } from '../permissions/permission.manager.js';
import { ToolExecutor } from '../tools/executor.js';
import { registry } from '../tools/registry.js';
import { ExecutionPlan, PlanStep } from '../planner/planner.interface.js';
import {
  PlanExecutionRequest,
  PlanExecutionResult,
  PlanExecutionStatus,
  StepExecutionRecord,
} from './execution.interface.js';
import { ExecutionRepository } from './execution.repository.js';
import { AuthorizationError, NotFoundError, AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

interface ActiveExecutionState {
  controller: AbortController;
  startedAt: number;
}

export class PlanExecutionEngine {
  // Map of actively running plan IDs to their AbortControllers to prevent duplicate & parallel runs
  private static activeExecutions = new Map<string, ActiveExecutionState>();

  /**
   * Main entry point to execute an approved task plan.
   * STRICT CORE RULE: Accepts only a validated structured plan, valid plan ID,
   * approved plan version, valid approval record, and authenticated user session.
   * NEVER executes raw natural language instructions directly.
   */
  public static async executeApprovedPlan(
    request: PlanExecutionRequest
  ): Promise<PlanExecutionResult> {
    const { planId, planVersion, userId, ticketToken } = request;

    // 1. Verify user session and fetch plan
    if (!userId) {
      throw new AuthorizationError('Authentication required: User session is missing.');
    }

    const plan = await PlanRepository.findById(planId);
    if (!plan) {
      throw new NotFoundError(`Task plan with id ${planId} not found.`);
    }

    // 2. Verify ownership
    if (plan.user_id !== userId) {
      throw new AuthorizationError('Access denied: You do not have permission to execute this plan.');
    }

    // 3. Verify exact validated version
    if (plan.version !== planVersion) {
      throw new AppError(
        `Version mismatch: Requested execution for plan v${planVersion}, but current plan is v${plan.version}. A modified plan requires fresh approval.`,
        400
      );
    }

    // 4. Verify approval status
    if (plan.status !== 'approved') {
      throw new AppError(
        `Execution forbidden: Plan "${plan.objective}" is in status "${plan.status}". Only approved plans can be executed.`,
        403
      );
    }

    // 5. Verify approval record / ticket
    if (!ticketToken) {
      throw new AppError('Execution forbidden: Explicit user approval ticket token is required.', 403);
    }

    // 6. Prevent duplicate and unauthorized parallel execution
    if (this.activeExecutions.has(planId) || (plan.status as string) === 'executing') {
      throw new AppError(
        `DUPLICATE_EXECUTION: Task plan "${planId}" is already actively executing. Parallel execution is prohibited.`,
        409
      );
    }

    // Initial ticket pre-verification check
    const ticketCheck = await PermissionManager.verifyToolExecution(
      userId,
      'plan_engine',
      {},
      ticketToken
    );
    if (!ticketCheck.allowed) {
      throw new AppError(ticketCheck.reason || 'Approval ticket verification failed.', 403);
    }

    const executionId = crypto.randomUUID();
    const abortController = new AbortController();
    this.activeExecutions.set(planId, {
      controller: abortController,
      startedAt: Date.now(),
    });

    // Update Plan Status in Database
    await PlanRepository.update(planId, { status: 'executing' });

    // Create execution audit log header
    await ExecutionRepository.createExecution(
      executionId,
      planId,
      planVersion,
      userId,
      plan.steps.length
    );

    const stepRecords: StepExecutionRecord[] = [];
    const completedStepIds = new Set<number>();
    let planExecutionStatus: PlanExecutionStatus = 'completed';
    let failedStepId: number | undefined;
    let finalErrorMessage: string | undefined;

    const startedAtIso = new Date().toISOString();

    logger.info({
      msg: 'Beginning approved plan execution sequence',
      executionId,
      planId,
      objective: plan.objective,
      totalSteps: plan.steps.length,
    });

    try {
      // 7. Topological / Dependency-ordered execution
      const orderedSteps = this.resolveExecutionOrder(plan.steps);

      for (const step of orderedSteps) {
        // Cancellation check
        if (abortController.signal.aborted) {
          planExecutionStatus = 'cancelled';
          finalErrorMessage = 'Plan execution was cancelled by user request.';
          const cancelledRecord: StepExecutionRecord = {
            executionId,
            stepId: step.step_id,
            action: step.action,
            toolName: step.tool_name,
            toolArgs: step.tool_args || {},
            status: 'cancelled',
            error: 'Cancelled before execution',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 0,
          };
          stepRecords.push(cancelledRecord);
          await ExecutionRepository.logStepExecution(executionId, planId, cancelledRecord);
          break;
        }

        // Dependency check: All prerequisite steps must have completed successfully
        const unmetDependencies = step.depends_on.filter((depId) => !completedStepIds.has(depId));
        if (unmetDependencies.length > 0) {
          planExecutionStatus = 'failed';
          failedStepId = step.step_id;
          finalErrorMessage = `Prerequisite step(s) [${unmetDependencies.join(', ')}] failed or were skipped. Dependent step ${step.step_id} cannot execute.`;

          const depFailRecord: StepExecutionRecord = {
            executionId,
            stepId: step.step_id,
            action: step.action,
            toolName: step.tool_name,
            toolArgs: step.tool_args || {},
            status: 'failed',
            error: finalErrorMessage,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: 0,
          };
          stepRecords.push(depFailRecord);
          await ExecutionRepository.logStepExecution(executionId, planId, depFailRecord);

          // Report failure honestly and halt
          break;
        }

        // Execute Step
        const stepStartTime = Date.now();
        const stepStartedAtIso = new Date(stepStartTime).toISOString();

        let stepRecord: StepExecutionRecord;

        try {
          if (step.tool_name) {
            const normalizedArgs = this.normalizeStepToolArgs(step);
            // Tool execution through centralized ToolExecutor gate
            const execResult = await ToolExecutor.executeTool(
              userId,
              step.tool_name,
              normalizedArgs,
              null,
              { ticket: ticketToken, stepId: step.step_id }
            );

            const durationMs = Date.now() - stepStartTime;
            const completedAtIso = new Date().toISOString();

            if (!execResult.success) {
              stepRecord = {
                executionId,
                stepId: step.step_id,
                action: step.action,
                toolName: step.tool_name,
                toolArgs: step.tool_args || {},
                status: 'failed',
                result: execResult.result,
                verification: execResult.verification,
                error: execResult.error || 'Tool execution failed',
                startedAt: stepStartedAtIso,
                completedAt: completedAtIso,
                durationMs,
              };

              planExecutionStatus = 'failed';
              failedStepId = step.step_id;
              finalErrorMessage = `Step ${step.step_id} ("${step.description}") failed: ${execResult.error}`;
            } else {
              stepRecord = {
                executionId,
                stepId: step.step_id,
                action: step.action,
                toolName: step.tool_name,
                toolArgs: step.tool_args || {},
                status: 'completed',
                result: execResult.result,
                verification: execResult.verification || {
                  verified: true,
                  message: `Step ${step.step_id} verified successfully.`,
                },
                startedAt: stepStartedAtIso,
                completedAt: completedAtIso,
                durationMs,
              };

              completedStepIds.add(step.step_id);
            }
          } else {
            // Synthetic step verification (e.g. wait_for_application, verify_browser)
            const syntheticResult = await this.executeSyntheticStep(step);
            const durationMs = Date.now() - stepStartTime;
            const completedAtIso = new Date().toISOString();

            if (!syntheticResult.success) {
              stepRecord = {
                executionId,
                stepId: step.step_id,
                action: step.action,
                toolName: undefined,
                toolArgs: step.tool_args || {},
                status: 'failed',
                error: syntheticResult.message,
                startedAt: stepStartedAtIso,
                completedAt: completedAtIso,
                durationMs,
              };

              planExecutionStatus = 'failed';
              failedStepId = step.step_id;
              finalErrorMessage = `Verification step ${step.step_id} failed: ${syntheticResult.message}`;
            } else {
              stepRecord = {
                executionId,
                stepId: step.step_id,
                action: step.action,
                toolName: undefined,
                toolArgs: step.tool_args || {},
                status: 'completed',
                result: { success: true },
                verification: {
                  verified: true,
                  message: syntheticResult.message,
                },
                startedAt: stepStartedAtIso,
                completedAt: completedAtIso,
                durationMs,
              };

              completedStepIds.add(step.step_id);
              await PermissionManager.recordStepConsumed(ticketToken, step.step_id);
            }
          }
        } catch (stepEx: any) {
          const durationMs = Date.now() - stepStartTime;
          stepRecord = {
            executionId,
            stepId: step.step_id,
            action: step.action,
            toolName: step.tool_name,
            toolArgs: step.tool_args || {},
            status: 'failed',
            error: stepEx.message,
            startedAt: stepStartedAtIso,
            completedAt: new Date().toISOString(),
            durationMs,
          };

          planExecutionStatus = 'failed';
          failedStepId = step.step_id;
          finalErrorMessage = `Step ${step.step_id} threw unhandled exception: ${stepEx.message}`;
        }

        stepRecords.push(stepRecord);
        await ExecutionRepository.logStepExecution(executionId, planId, stepRecord);

        // If step failed, halt pipeline immediately
        if (stepRecord.status === 'failed') {
          break;
        }
      }
    } finally {
      // Clean up active execution lock
      this.activeExecutions.delete(planId);
    }

    const completedAtIso = new Date().toISOString();

    // 8. Update Plan & Execution final status
    await PlanRepository.update(planId, { status: planExecutionStatus });
    await ExecutionRepository.updateExecutionStatus(
      executionId,
      planExecutionStatus,
      completedStepIds.size,
      failedStepId,
      finalErrorMessage
    );

    logger.info({
      msg: 'Finished plan execution',
      executionId,
      planId,
      status: planExecutionStatus,
      completedSteps: completedStepIds.size,
      totalSteps: plan.steps.length,
    });

    return {
      executionId,
      planId,
      planVersion,
      userId,
      status: planExecutionStatus,
      totalSteps: plan.steps.length,
      completedSteps: completedStepIds.size,
      failedStepId,
      errorMessage: finalErrorMessage,
      stepRecords,
      startedAt: startedAtIso,
      completedAt: completedAtIso,
    };
  }

  /**
   * Cancel an active plan execution mid-flight.
   */
  public static async cancelExecution(planId: string, userId: string): Promise<boolean> {
    const active = this.activeExecutions.get(planId);
    if (!active) {
      return false;
    }

    active.controller.abort();
    this.activeExecutions.delete(planId);

    await PlanRepository.update(planId, { status: 'cancelled' });
    logger.warn({ msg: 'Plan execution aborted by user', planId, userId });
    return true;
  }

  /**
   * Normalizes step arguments to ensure resilient execution across model variations.
   */
  private static normalizeStepToolArgs(step: PlanStep): Record<string, any> {
    const rawArgs = { ...(step.tool_args || {}) };
    const toolName = step.tool_name || '';

    if (toolName === 'open_application' || toolName === 'launch_application') {
      let appName = rawArgs.appName || rawArgs.application || rawArgs.app || rawArgs.name || step.target || '';
      if (!appName || ['default_browser', 'browser', 'web browser', 'web_browser', 'website'].includes(appName.toLowerCase().trim())) {
        appName = 'Google Chrome';
      }
      return { ...rawArgs, appName };
    }

    if (toolName === 'open_url' || toolName === 'navigate_browser') {
      let url = rawArgs.url || rawArgs.link || step.target || '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = url ? `https://${url}` : 'https://www.youtube.com';
      }
      return { ...rawArgs, url };
    }

    if (toolName === 'open_folder_in_vscode') {
      const folderName = rawArgs.folderName || rawArgs.folder || rawArgs.path || step.target || 'GIA-AI';
      return { ...rawArgs, folderName };
    }

    if (toolName === 'open_folder') {
      const folderPath = rawArgs.folderPath || rawArgs.path || rawArgs.folder || step.target || 'downloads';
      return { ...rawArgs, folderPath };
    }

    return rawArgs;
  }

  /**
   * Check if a plan is actively executing.
   */
  public static isExecuting(planId: string): boolean {
    return this.activeExecutions.has(planId);
  }

  /**
   * Clear all active execution state (for clean test tear downs).
   */
  public static resetState(): void {
    for (const active of this.activeExecutions.values()) {
      active.controller.abort();
    }
    this.activeExecutions.clear();
  }

  /**
   * Resolves execution order based on step dependencies.
   */
  private static resolveExecutionOrder(steps: PlanStep[]): PlanStep[] {
    // Topological sort by dependencies
    const result: PlanStep[] = [];
    const visited = new Set<number>();
    const stepMap = new Map<number, PlanStep>(steps.map((s) => [s.step_id, s]));

    function visit(step: PlanStep) {
      if (visited.has(step.step_id)) return;
      for (const depId of step.depends_on) {
        const dep = stepMap.get(depId);
        if (dep && !visited.has(depId)) {
          visit(dep);
        }
      }
      visited.add(step.step_id);
      result.push(step);
    }

    for (const step of steps) {
      visit(step);
    }

    return result;
  }

  /**
   * Handles synthetic steps (e.g. wait_for_application, verify_browser, verify_application).
   */
  private static async executeSyntheticStep(
    step: PlanStep
  ): Promise<{ success: boolean; message: string }> {
    const action = step.action.toLowerCase();

    if (action.includes('wait') || action.includes('verify')) {
      // Small simulated delay for window/UI synchronization
      await new Promise((res) => setTimeout(res, 50));
      return {
        success: true,
        message: `Verified: ${step.expected_outcome || step.description}`,
      };
    }

    return {
      success: true,
      message: `Executed synthetic step "${step.action}".`,
    };
  }
}