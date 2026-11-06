import crypto from 'crypto';
import { query } from '../../database/client.js';
import { PlanRepository } from '../planner/plan.repository.js';
import { ExecutionPlan, PlanStep } from '../planner/planner.interface.js';
import {
  ApprovalRequest,
  ApprovalResult,
  ApprovalState,
  ExecutionTicket,
  SensitiveOperationAssessment,
  SensitiveOperationType,
  VoiceApprovalParseResult,
  ToolVerificationResult,
} from './permission.interface.js';
import { AuthorizationError, NotFoundError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export class PermissionManager {
  // Plan approval expiration TTL (10 minutes)
  public static readonly APPROVAL_TTL_MS = 10 * 60 * 1000;

  // Gate enforcement flag (active by default in production)
  private static _gateEnforced: boolean = process.env.NODE_ENV !== 'test' || process.env.STRICT_APPROVAL_GATE === 'true';

  // In-memory execution ticket cache (synchronized with database)
  private static tickets = new Map<string, ExecutionTicket>();

  public static isGateEnforced(): boolean {
    if (process.env.STRICT_APPROVAL_GATE === 'true') return true;
    return this._gateEnforced;
  }

  public static setGateEnforced(enforced: boolean): void {
    this._gateEnforced = enforced;
  }

  /**
   * Assess sensitive operations required by each step in the plan.
   * Identifies 8 sensitive operation categories:
   * 1. PERMANENT_DELETION
   * 2. OVERWRITE_FILE
   * 3. PRIVILEGED_COMMAND
   * 4. INSTALL_SOFTWARE
   * 5. SYSTEM_CONFIGURATION
   * 6. EXTERNAL_COMMUNICATION
   * 7. FINANCIAL_TRANSACTION
   * 8. SHARING_PRIVATE_INFO
   */
  public static assessPlanSensitivities(plan: ExecutionPlan): Map<number, SensitiveOperationAssessment> {
    const assessments = new Map<number, SensitiveOperationAssessment>();

    for (const step of plan.steps) {
      const types: SensitiveOperationType[] = [];
      const reasons: string[] = [];
      const requiredConfirmations: string[] = [];

      const fullText = [
        step.action,
        step.description,
        step.target || '',
        step.tool_name || '',
        JSON.stringify(step.tool_args || {}),
      ]
        .join(' ')
        .toLowerCase();

      // 1. Permanent Deletion
      if (
        /\b(delete|remove|rm\s+-rf|rm\s+|unlink|destroy|drop\s+table|drop\s+database|wipe|erase|purge)\b/i.test(
          fullText
        )
      ) {
        types.push('PERMANENT_DELETION');
        reasons.push('Step involves permanent deletion of files or data.');
        requiredConfirmations.push(`step_${step.step_id}_PERMANENT_DELETION`);
      }

      // 2. Overwrite File
      if (
        /\b(overwrite|replace\s+file|truncate\s+file|write\s+over|force\s+write)\b/i.test(
          fullText
        )
      ) {
        types.push('OVERWRITE_FILE');
        reasons.push('Step will overwrite or replace existing files.');
        requiredConfirmations.push(`step_${step.step_id}_OVERWRITE_FILE`);
      }

      // 3. Privileged Command
      if (
        /\b(sudo|chmod|chown|chgrp|su\s|root|privilege|admin|launchctl|sysctl|pfctl)\b/i.test(
          fullText
        )
      ) {
        types.push('PRIVILEGED_COMMAND');
        reasons.push('Step requires elevated or root system privileges.');
        requiredConfirmations.push(`step_${step.step_id}_PRIVILEGED_COMMAND`);
      }

      // 4. Install Software
      if (
        /\b(brew\s+install|npm\s+i(\s+|-g)|yarn\s+add|pip\s+install|cargo\s+install|apt(-get)?\s+install|install\s+package|softwareupdate)\b/i.test(
          fullText
        )
      ) {
        types.push('INSTALL_SOFTWARE');
        reasons.push('Step executes software or package installation.');
        requiredConfirmations.push(`step_${step.step_id}_INSTALL_SOFTWARE`);
      }

      // 5. System Configuration
      if (
        /\b(defaults\s+write|networksetup|scutil|system\s+settings|systempreferences|hosts\s+file|firewall|change\s+dns|modify\s+system)\b/i.test(
          fullText
        )
      ) {
        types.push('SYSTEM_CONFIGURATION');
        reasons.push('Step alters operating system or network configuration.');
        requiredConfirmations.push(`step_${step.step_id}_SYSTEM_CONFIGURATION`);
      }

      // 6. External Communication
      if (
        /\b(send\s+email|send\s+message|curl\s+-x\s+post|webhook|slack\s+api|discord\s+webhook|http\s+post|external\s+api)\b/i.test(
          fullText
        )
      ) {
        types.push('EXTERNAL_COMMUNICATION');
        reasons.push('Step communicates or dispatches data to external network endpoints.');
        requiredConfirmations.push(`step_${step.step_id}_EXTERNAL_COMMUNICATION`);
      }

      // 7. Financial Transaction
      if (
        /\b(pay|purchase|buy|checkout|credit\s+card|stripe|paypal|transfer\s+money|bank|wire\s+transfer)\b/i.test(
          fullText
        )
      ) {
        types.push('FINANCIAL_TRANSACTION');
        reasons.push('Step triggers a financial transaction or payment authorization.');
        requiredConfirmations.push(`step_${step.step_id}_FINANCIAL_TRANSACTION`);
      }

      // 8. Sharing Private Information
      if (
        /\b(\.env|id_rsa|private\s+key|password|secret|apikey|api_key|token|credentials|ssh_key|certificate)\b/i.test(
          fullText
        )
      ) {
        types.push('SHARING_PRIVATE_INFO');
        reasons.push('Step exposes sensitive environment variables, credentials, or private keys.');
        requiredConfirmations.push(`step_${step.step_id}_SHARING_PRIVATE_INFO`);
      }

      assessments.set(step.step_id, {
        isSensitive: types.length > 0,
        operationTypes: types,
        reasons,
        requiredConfirmations,
      });
    }

    return assessments;
  }

  /**
   * Parse voice commands for explicit plan approval or rejection.
   * Enforces acoustic safety: Rejects GIA's own TTS output immediately.
   */
  public static parseVoiceApproval(
    transcript: string,
    isAssistantVoice?: boolean
  ): VoiceApprovalParseResult {
    // Acoustic Feedback & Self-Approval Prevention Rule
    if (isAssistantVoice) {
      return {
        isApproval: false,
        isRejection: false,
        isValid: false,
        reason: 'Security violation: Assistant TTS voice output cannot approve actions.',
        commandType: 'unrecognized',
      };
    }

    if (!transcript || typeof transcript !== 'string') {
      return {
        isApproval: false,
        isRejection: false,
        isValid: false,
        reason: 'Approval denied: Silence or empty voice transcript is not approval.',
        commandType: 'unrecognized',
      };
    }

    const normalized = transcript
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return {
        isApproval: false,
        isRejection: false,
        isValid: false,
        reason: 'Approval denied: Silence or empty voice transcript is not approval.',
        commandType: 'unrecognized',
      };
    }

    // Ambiguity Detection Rule
    const ambiguousPhrases = [
      'maybe',
      'perhaps',
      'i guess',
      'i think so',
      'probably',
      'not sure',
      'tell me more',
      'what does this do',
      'wait',
      'hmm',
      'hold on',
    ];
    for (const phrase of ambiguousPhrases) {
      if (normalized.includes(phrase)) {
        return {
          isApproval: false,
          isRejection: false,
          isValid: false,
          reason: `Approval denied: Ambiguous voice response ("${phrase}") cannot be treated as approval.`,
          commandType: 'ambiguous',
        };
      }
    }

    // Explicit Approval Patterns
    const approvalPatterns = [
      'gia approve this plan',
      'gia approve the plan',
      'gia execute the plan',
      'gia execute this plan',
      'gia yes proceed',
      'approve this plan',
      'approve the plan',
      'execute the plan',
      'execute this plan',
      'yes proceed',
      'approve',
      'approved',
      'execute',
      'yes',
      'proceed',
      'go ahead',
      'confirmed',
      'confirm',
      'okay',
      'ok',
    ];

    // Explicit Rejection Patterns
    const rejectionPatterns = [
      'gia reject this plan',
      'gia reject the plan',
      'gia cancel',
      'gia stop',
      'reject this plan',
      'reject the plan',
      'cancel',
      'reject',
      'rejected',
      'no',
      'do not execute',
      'stop',
      'abort',
      'disapprove',
    ];

    for (const pattern of rejectionPatterns) {
      if (normalized === pattern || normalized.startsWith(pattern) || normalized.includes(pattern)) {
        return {
          isApproval: false,
          isRejection: true,
          isValid: true,
          commandType: 'reject',
        };
      }
    }

    for (const pattern of approvalPatterns) {
      if (normalized === pattern || normalized.startsWith(pattern) || normalized.includes(pattern)) {
        return {
          isApproval: true,
          isRejection: false,
          isValid: true,
          commandType: 'approve',
        };
      }
    }

    return {
      isApproval: false,
      isRejection: false,
      isValid: false,
      reason: `Approval denied: Unrecognized voice response ("${transcript}"). Explicit approval or rejection required.`,
      commandType: 'unrecognized',
    };
  }

  /**
   * Centralized user approval gate.
   * Enforces all 12 approval rules:
   * 1. Silence is never approval
   * 2. Ambiguous response is never approval
   * 3. Unambiguous "yes"/"okay" on active displayed plan only
   * 4. A rejected plan must never execute
   * 5. A modified plan requires fresh approval
   * 6. An expired plan requires fresh approval
   * 7. Approval must be linked to unique plan ID
   * 8. Approval must match exact validated plan version
   * 9. Action changes after approval invalidate approval
   * 10. LLM / Assistant cannot approve its own plan
   * 11. Never infer approval from previous conversations
   * 12. Never reuse approval for a different task
   */
  public static async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    // Rule 10: LLM / Assistant cannot approve plans
    if ((request.channel as any) === 'model' || request.isAssistantVoice) {
      logger.warn({ msg: 'Security violation: Assistant or LLM attempted self-approval', request });
      return {
        success: false,
        state: 'rejected',
        message: request.isAssistantVoice
          ? 'Security violation: Assistant TTS voice output cannot approve actions.'
          : 'Security violation: Assistant or LLM cannot approve its own plan.',
      };
    }

    // Rule 1: Silence is never approval
    if (!request.explicitConfirmation && !request.voiceTranscript) {
      return {
        success: false,
        state: 'pending',
        message: 'Approval denied: Silence or absence of explicit confirmation is never approval.',
      };
    }

    // Voice command channel handling
    if (request.channel === 'voice_command') {
      const voiceParse = this.parseVoiceApproval(request.voiceTranscript || '', request.isAssistantVoice);
      if (!voiceParse.isValid) {
        return {
          success: false,
          state: 'pending',
          message: voiceParse.reason || 'Approval denied: Invalid voice command.',
        };
      }
      if (voiceParse.isRejection) {
        return await this.rejectPlan(request.planId, request.userId, 'Explicitly rejected via voice command');
      }
      // If voice parsed as approval, proceed
    }

    // Fetch plan
    const plan = await PlanRepository.findById(request.planId);
    if (!plan) {
      throw new NotFoundError(`Task plan with id ${request.planId} not found`);
    }

    // Rule 11: Never infer approval from previous conversations or wrong users
    if (plan.user_id !== request.userId) {
      throw new AuthorizationError('Access denied: You do not have permission to approve this plan.');
    }

    // Rule 4: A rejected plan must never execute
    if (plan.status === 'rejected') {
      return {
        success: false,
        state: 'rejected',
        message: 'Approval denied: A rejected plan must never execute. Please generate a new task plan.',
      };
    }

    // Rule 8: Approval must match exact validated plan version
    if (request.planVersion !== plan.version) {
      return {
        success: false,
        state: 'modified',
        message: `Approval denied: Plan version mismatch (requested v${request.planVersion}, current plan is v${plan.version}). A modified plan requires fresh approval.`,
      };
    }

    // Rule 6: Check expiration
    const isExpired = await this.checkPlanExpired(plan);
    if (isExpired) {
      await PlanRepository.update(plan.id, { status: 'expired' });
      return {
        success: false,
        state: 'expired',
        message: 'Approval denied: Task plan has expired (exceeded 10-minute TTL). Fresh approval is required.',
      };
    }

    // Sensitive Operations Assessment & Step-Specific Confirmation Gate
    const sensitivities = this.assessPlanSensitivities(plan);
    const missingConfirmations: string[] = [];
    const confirmedSensitives: Record<string, boolean> = {};

    for (const [stepId, assessment] of sensitivities.entries()) {
      if (assessment.isSensitive) {
        for (const reqConf of assessment.requiredConfirmations) {
          if (request.sensitiveConfirmations && request.sensitiveConfirmations[reqConf] === true) {
            confirmedSensitives[reqConf] = true;
          } else {
            missingConfirmations.push(reqConf);
          }
        }
      }
    }

    // If there are sensitive operations that lack step-specific confirmations, block approval
    if (missingConfirmations.length > 0) {
      return {
        success: false,
        state: 'pending',
        message: `Approval blocked: Additional step-specific confirmation is required for sensitive operations: ${missingConfirmations.join(', ')}`,
        missingSensitiveConfirmations: missingConfirmations,
      };
    }

    // Update Plan in Database to approved
    const updatedPlan = await PlanRepository.update(plan.id, {
      status: 'approved',
      approval: {
        required: true,
        approved: true,
        approved_at: new Date().toISOString(),
        feedback: request.voiceTranscript
          ? `Approved via voice command: "${request.voiceTranscript}"`
          : 'Approved via web UI',
      },
    });

    // Generate unique single-use execution ticket
    const ticketId = crypto.randomUUID();
    const ticketToken = `gia_ticket_${crypto.randomBytes(16).toString('hex')}`;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.APPROVAL_TTL_MS;

    const ticket: ExecutionTicket = {
      ticketId,
      planId: plan.id,
      planVersion: plan.version,
      userId: request.userId,
      issuedAt,
      expiresAt,
      approvedSteps: plan.steps.map((s) => s.step_id),
      confirmedSensitiveOperations: confirmedSensitives,
      usedSteps: [],
    };

    // Persist approval record in database
    await query(
      `
      INSERT INTO plan_approvals (
        id, plan_id, plan_version, user_id, channel, status,
        sensitive_confirmations, ticket_token, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
      `,
      [
        ticketId,
        plan.id,
        plan.version,
        request.userId,
        request.channel,
        'approved',
        JSON.stringify(confirmedSensitives),
        ticketToken,
        expiresAt,
      ]
    );

    // Cache ticket in-memory for lightning fast runtime verification
    this.tickets.set(ticketToken, ticket);
    this.tickets.set(ticketId, ticket);

    logger.info({
      msg: 'Plan approval granted. Execution ticket issued.',
      planId: plan.id,
      version: plan.version,
      ticketToken,
    });

    return {
      success: true,
      state: 'approved',
      message: `Plan "${updatedPlan.objective}" (v${updatedPlan.version}) has been explicitly approved for execution.`,
      ticket,
    };
  }

  /**
   * Explicitly reject a plan.
   * Transitions status to 'rejected' and invalidates any existing tickets.
   */
  public static async rejectPlan(
    planId: string,
    userId: string,
    reason = 'Explicitly rejected by user'
  ): Promise<ApprovalResult> {
    const plan = await PlanRepository.findById(planId);
    if (!plan) {
      throw new NotFoundError(`Task plan with id ${planId} not found`);
    }

    if (plan.user_id !== userId) {
      throw new AuthorizationError('Access denied: You do not have permission to reject this plan.');
    }

    await PlanRepository.update(planId, {
      status: 'rejected',
      approval: {
        required: true,
        approved: false,
        approved_at: null,
        feedback: reason,
      },
    });

    // Invalidate tickets for this plan
    await this.revokePlanTickets(planId, 'Plan rejected');

    return {
      success: true,
      state: 'rejected',
      message: `Plan "${plan.objective}" has been rejected. It will not be executed.`,
    };
  }

  /**
   * Rule 9: If actions or details change after approval, invalidate approval immediately.
   */
  public static async invalidateApproval(planId: string, reason: string): Promise<void> {
    await PlanRepository.update(planId, {
      status: 'modified',
      approval: {
        required: true,
        approved: false,
        approved_at: null,
        feedback: `Approval invalidated: ${reason}`,
      },
    });

    await this.revokePlanTickets(planId, reason);
    logger.warn({ msg: 'Plan approval invalidated due to modification', planId, reason });
  }

  /**
   * Cancel an active or pending task plan and revoke associated approval tickets.
   */
  public static async cancelPlan(planId: string, reason: string): Promise<void> {
    await PlanRepository.update(planId, {
      status: 'cancelled',
      approval: {
        required: true,
        approved: false,
        approved_at: null,
        feedback: `Plan cancelled: ${reason}`,
      },
    });

    await this.revokePlanTickets(planId, reason);
    logger.warn({ msg: 'Plan cancelled by user', planId, reason });
  }

  /**
   * Rule 6: Check if a plan has exceeded its active TTL.
   */
  public static async checkPlanExpired(plan: ExecutionPlan): Promise<boolean> {
    if (plan.status === 'expired') return true;
    const timestampStr = plan.created_at || plan.updated_at;
    if (!timestampStr) return false;
    const planTime = new Date(timestampStr).getTime();
    return Date.now() - planTime > this.APPROVAL_TTL_MS;
  }

  /**
   * Verify whether a tool execution is authorized by an active ticket.
   * Central gate for all tool invocations across the system.
   */
  public static async verifyToolExecution(
    userId: string,
    toolName: string,
    args: any,
    ticketOrToken?: ExecutionTicket | string,
    stepId?: number
  ): Promise<ToolVerificationResult> {
    if (!ticketOrToken) {
      return {
        allowed: false,
        reason: 'PERMISSION_DENIED: Explicit user approval ticket is mandatory for tool execution.',
      };
    }

    let ticket: ExecutionTicket | undefined;
    let tokenStr = '';

    if (typeof ticketOrToken === 'string') {
      tokenStr = ticketOrToken;
      ticket = this.tickets.get(ticketOrToken);
      if (!ticket) {
        // Query database for ticket
        const res = await query<any>(
          `SELECT * FROM plan_approvals WHERE ticket_token = $1 AND status = 'approved' AND revoked_at IS NULL`,
          [ticketOrToken]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const expMs = new Date(row.expires_at).getTime();
          ticket = {
            ticketId: row.id,
            planId: row.plan_id,
            planVersion: row.plan_version,
            userId: row.user_id,
            issuedAt: new Date(row.created_at).getTime(),
            expiresAt: expMs,
            approvedSteps: [], // will check with plan
            confirmedSensitiveOperations:
              typeof row.sensitive_confirmations === 'string'
                ? JSON.parse(row.sensitive_confirmations)
                : row.sensitive_confirmations || {},
            usedSteps: [],
          };
          this.tickets.set(tokenStr, ticket);
        }
      }
    } else {
      ticket = ticketOrToken;
      tokenStr = ticket.ticketId;
    }

    if (!ticket) {
      return {
        allowed: false,
        reason: 'PERMISSION_DENIED: Invalid or revoked execution ticket.',
      };
    }

    // Check user ownership
    if (ticket.userId !== userId) {
      return {
        allowed: false,
        reason: 'PERMISSION_DENIED: Ticket user mismatch. Approval tickets cannot be shared across users.',
      };
    }

    // Rule 6: Check ticket expiration
    if (Date.now() > ticket.expiresAt) {
      return {
        allowed: false,
        reason: 'PERMISSION_DENIED: Execution ticket has expired. Fresh user approval required.',
      };
    }

    // If stepId is provided, verify step permissions
    if (stepId !== undefined) {
      // Rule 12: Single-use check
      if (ticket.usedSteps.includes(stepId)) {
        return {
          allowed: false,
          reason: `PERMISSION_DENIED: Step ${stepId} has already been executed. Approval tickets cannot be reused.`,
        };
      }

      // Check step is in plan
      const plan = await PlanRepository.findById(ticket.planId);
      if (!plan) {
        return {
          allowed: false,
          reason: 'PERMISSION_DENIED: Associated task plan not found.',
        };
      }

      if (plan.status === 'rejected') {
        return {
          allowed: false,
          reason: 'PERMISSION_DENIED: Plan was rejected. Rejected plans must never execute.',
        };
      }

      const step = plan.steps.find((s) => s.step_id === stepId);
      if (!step) {
        return {
          allowed: false,
          reason: `PERMISSION_DENIED: Step ${stepId} not found in approved task plan.`,
        };
      }

      // Check sensitive operations confirmation for this step
      const sensitivities = this.assessPlanSensitivities(plan);
      const stepSensitivity = sensitivities.get(stepId);
      if (stepSensitivity && stepSensitivity.isSensitive) {
        for (const reqConf of stepSensitivity.requiredConfirmations) {
          if (!ticket.confirmedSensitiveOperations[reqConf]) {
            return {
              allowed: false,
              reason: `PERMISSION_DENIED: Missing step-specific sensitive confirmation "${reqConf}" for step ${stepId}.`,
            };
          }
        }
      }
    }

    return {
      allowed: true,
      ticket,
    };
  }

  /**
   * Consume a step execution under a valid ticket, tracking usage and preventing reuse.
   */
  public static async recordStepConsumed(
    ticketTokenOrId: string,
    stepId: number
  ): Promise<void> {
    let ticket = this.tickets.get(ticketTokenOrId);
    if (!ticket) {
      for (const t of this.tickets.values()) {
        if (t.ticketId === ticketTokenOrId || t.planId === ticketTokenOrId) {
          ticket = t;
          break;
        }
      }
    }
    if (ticket) {
      if (!ticket.usedSteps.includes(stepId)) {
        ticket.usedSteps.push(stepId);
      }
      // If all steps executed, update plan status to 'completed'
      if (
        ticket.approvedSteps.length > 0 &&
        ticket.approvedSteps.every((s) => ticket.usedSteps.includes(s))
      ) {
        await PlanRepository.update(ticket.planId, { status: 'completed' });
      }
    }
  }

  /**
   * Revoke all tickets for a given plan.
   */
  private static async revokePlanTickets(planId: string, reason: string): Promise<void> {
    // Database update
    await query(
      `
      UPDATE plan_approvals
      SET status = 'cancelled', revoked_at = NOW()
      WHERE plan_id = $1 AND status = 'approved'
      `,
      [planId]
    );

    // Evict from in-memory cache
    for (const [token, ticket] of this.tickets.entries()) {
      if (ticket.planId === planId) {
        this.tickets.delete(token);
      }
    }
  }

  /**
   * Clear in-memory tickets cache (used for clean test suites).
   */
  public static resetState(): void {
    this.tickets.clear();
  }
}
