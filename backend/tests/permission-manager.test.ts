import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { ToolExecutor } from '../src/ai/tools/executor.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';

describe('PHASE 2: Centralized User Approval and Permission Gate Suite', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
  let user2Token: string;
  let user2Id: string;
  let conversationId: string;

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_key_permission_gate_123' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User 1
    const signup1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'permission_tester@gia.ai', password: 'secure_password_123', name: 'Permission Tester' },
    });
    const body1 = JSON.parse(signup1.body);
    userToken = body1.token;
    userId = body1.user.id;

    // Create User 2 (for authorization isolation tests)
    const signup2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'other_user@gia.ai', password: 'secure_password_123', name: 'Other User' },
    });
    const body2 = JSON.parse(signup2.body);
    user2Token = body2.token;
    user2Id = body2.user.id;

    // Create Conversation for User 1
    const convoRes = await query<{ id: string }>(
      'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id',
      [userId, 'Permission Gate Tests']
    );
    conversationId = convoRes.rows[0].id;
  });

  afterAll(async () => {
    PermissionManager.setGateEnforced(false);
    await query('DELETE FROM users');
    await pool.end();
  });

  beforeEach(() => {
    PermissionManager.resetState();
    PermissionManager.setGateEnforced(false);
  });

  describe('1. The 12 Approval Rules & State Transitions', () => {
    it('Rule 1: Silence or absence of explicit confirmation is never approval', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const result = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: false,
      });

      expect(result.success).toBe(false);
      expect(result.state).toBe('pending');
      expect(result.message).toContain('Silence or absence of explicit confirmation is never approval');
    });

    it('Rule 2: An ambiguous response is never approval', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const ambiguousResponses = ['maybe', 'perhaps', 'I think so', 'wait', 'tell me more', 'what does this do'];
      for (const phrase of ambiguousResponses) {
        const result = await PermissionManager.requestApproval({
          planId: plan.id,
          planVersion: plan.version,
          userId,
          channel: 'voice_command',
          voiceTranscript: phrase,
        });

        expect(result.success).toBe(false);
        expect(result.state).toBe('pending');
        expect(result.message).toContain('Ambiguous');
      }
    });

    it('Rule 3: Unambiguous "yes" or "proceed" approves the pending plan and issues ExecutionTicket', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const result = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'voice_command',
        voiceTranscript: 'GIA, yes, proceed.',
      });

      expect(result.success).toBe(true);
      expect(result.state).toBe('approved');
      expect(result.ticket).toBeDefined();
      expect(result.ticket?.planId).toBe(plan.id);
      expect(result.ticket?.userId).toBe(userId);
      expect(result.ticket?.approvedSteps).toContain(1);

      // Verify task plan status in DB
      const updatedPlan = await PlanRepository.findById(plan.id);
      expect(updatedPlan?.status).toBe('approved');
      expect(updatedPlan?.approval.approved).toBe(true);
    });

    it('Rule 4: A rejected plan must never execute or be approved without re-planning', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      // Explicitly reject
      const rejectRes = await PermissionManager.rejectPlan(plan.id, userId, 'User rejected this operation');
      expect(rejectRes.success).toBe(true);
      expect(rejectRes.state).toBe('rejected');

      // Attempt to approve rejected plan
      const reApproval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      expect(reApproval.success).toBe(false);
      expect(reApproval.state).toBe('rejected');
      expect(reApproval.message).toContain('A rejected plan must never execute');
    });

    it('Rule 5 & 9: Modifying a plan invalidates existing approval and requires fresh approval', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      // Approve version 1
      const approval1 = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });
      expect(approval1.success).toBe(true);
      expect(approval1.ticket).toBeDefined();

      // Modify the plan
      const modifiedPlan = await TaskPlanningEngine.modifyPlan(plan, 'Also open YouTube');
      await PermissionManager.invalidateApproval(plan.id, 'Plan modified by user');

      expect(modifiedPlan.version).toBe(2);

      // Old ticket verification should fail
      const toolCheck = await PermissionManager.verifyToolExecution(
        userId,
        'open_application',
        {},
        approval1.ticket,
        1
      );
      // Plan status is now modified, old ticket cannot be used
      const recheckedPlan = await PlanRepository.findById(plan.id);
      expect(recheckedPlan?.status).toBe('modified');
      expect(recheckedPlan?.approval.approved).toBe(false);

      // Fresh approval for v2 succeeds
      const approval2 = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: modifiedPlan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });
      expect(approval2.success).toBe(true);
      expect(approval2.ticket?.planVersion).toBe(2);
    });

    it('Rule 6: An expired plan requires fresh approval and cannot execute', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      // Artificially age plan beyond 10 minutes TTL
      await query(
        `UPDATE task_plans SET created_at = NOW() - INTERVAL '15 minutes' WHERE id = $1`,
        [plan.id]
      );

      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      expect(approval.success).toBe(false);
      expect(approval.state).toBe('expired');
      expect(approval.message).toContain('expired');
    });

    it('Rule 7: Approval must be linked to a unique plan ID', async () => {
      const fakePlanId = '00000000-0000-0000-0000-000000000000';

      await expect(
        PermissionManager.requestApproval({
          planId: fakePlanId,
          planVersion: 1,
          userId,
          channel: 'web_ui',
          explicitConfirmation: true,
        })
      ).rejects.toThrow(/not found/);
    });

    it('Rule 8: Approval must match the exact validated plan version', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');
      const modified = await TaskPlanningEngine.modifyPlan(plan, 'Also open YouTube');

      // Attempt approval using old version 1
      const approvalOldVersion = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: 1, // Wrong version
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      expect(approvalOldVersion.success).toBe(false);
      expect(approvalOldVersion.state).toBe('modified');
      expect(approvalOldVersion.message).toContain('Plan version mismatch');
    });

    it('Rule 10: Do not allow LLM or Assistant to approve its own plan', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const llmApproval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'model' as any,
        explicitConfirmation: true,
      });

      expect(llmApproval.success).toBe(false);
      expect(llmApproval.message).toContain('Assistant or LLM cannot approve its own plan');
    });

    it('Rule 11: Never infer approval from different users or previous conversations', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      // User 2 attempts to approve User 1's plan
      await expect(
        PermissionManager.requestApproval({
          planId: plan.id,
          planVersion: plan.version,
          userId: user2Id,
          channel: 'web_ui',
          explicitConfirmation: true,
        })
      ).rejects.toThrow(/Access denied/);
    });

    it('Rule 12: Never reuse approval for a different task or replay consumed steps', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      const ticket = approval.ticket!;

      // Verify Step 1 is allowed
      const check1 = await PermissionManager.verifyToolExecution(userId, 'open_application', {}, ticket, 1);
      expect(check1.allowed).toBe(true);

      // Record Step 1 consumed
      await PermissionManager.recordStepConsumed(ticket.ticketId, 1);

      // Attempt to re-execute Step 1 under same ticket
      const reCheck = await PermissionManager.verifyToolExecution(userId, 'open_application', {}, ticket, 1);
      expect(reCheck.allowed).toBe(false);
      expect(reCheck.reason).toContain('has already been executed');
    });
  });

  describe('2. Voice Approval and Acoustic Safety Gate', () => {
    it('should parse explicit voice approvals', () => {
      const approveCmds = [
        'GIA, approve this plan.',
        'GIA, execute the plan.',
        'GIA, yes, proceed.',
        'approve this plan',
        'execute the plan',
        'yes proceed',
        'yes',
        'approve',
      ];

      for (const cmd of approveCmds) {
        const parsed = PermissionManager.parseVoiceApproval(cmd);
        expect(parsed.isApproval).toBe(true);
        expect(parsed.isRejection).toBe(false);
        expect(parsed.isValid).toBe(true);
      }
    });

    it('should parse explicit voice rejections', () => {
      const rejectCmds = [
        'GIA, reject this plan.',
        'GIA, cancel.',
        'reject this plan',
        'cancel',
        'no',
        'stop',
        'abort',
      ];

      for (const cmd of rejectCmds) {
        const parsed = PermissionManager.parseVoiceApproval(cmd);
        expect(parsed.isApproval).toBe(false);
        expect(parsed.isRejection).toBe(true);
        expect(parsed.isValid).toBe(true);
      }
    });

    it('Acoustic Gating: Must reject GIA TTS output to prevent assistant self-approval loop', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const assistantEcho = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'voice_command',
        voiceTranscript: 'GIA, approve this plan.',
        isAssistantVoice: true, // Echo / loopback detected!
      });

      expect(assistantEcho.success).toBe(false);
      expect(assistantEcho.message).toContain('Assistant TTS voice output cannot approve actions');
    });
  });

  describe('3. Sensitive Operations and Step-Specific Confirmation Gate', () => {
    it('should detect sensitive operations across 8 categories', async () => {
      const sensitivePlan: ExecutionPlan = {
        id: '11111111-1111-1111-1111-111111111111',
        conversation_id: conversationId,
        user_id: userId,
        objective: 'System maintenance tasks',
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: [
          {
            step_id: 1,
            action: 'remove_file',
            target: 'old_cache.log',
            description: 'Permanently delete old cache files using rm -rf',
            tool_name: 'run_project_frontend',
            tool_args: {},
            risk_level: 'critical',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Files removed',
          },
          {
            step_id: 2,
            action: 'configure_system',
            target: 'firewall',
            description: 'Run privileged sudo defaults write command',
            tool_name: 'run_project_frontend',
            tool_args: {},
            risk_level: 'critical',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'Firewall updated',
          },
          {
            step_id: 3,
            action: 'export_credentials',
            target: '.env',
            description: 'Read and expose .env private key secrets',
            tool_name: 'read_file_content',
            tool_args: { filePath: '.env' },
            risk_level: 'high',
            requires_approval: true,
            depends_on: [2],
            expected_outcome: 'Env read',
          },
        ],
        approval: { required: true, approved: false, approved_at: null, feedback: null },
        metadata: {},
        version: 1,
      };

      const sensitivities = PermissionManager.assessPlanSensitivities(sensitivePlan);

      expect(sensitivities.get(1)?.isSensitive).toBe(true);
      expect(sensitivities.get(1)?.operationTypes).toContain('PERMANENT_DELETION');

      expect(sensitivities.get(2)?.isSensitive).toBe(true);
      expect(sensitivities.get(2)?.operationTypes).toContain('PRIVILEGED_COMMAND');
      expect(sensitivities.get(2)?.operationTypes).toContain('SYSTEM_CONFIGURATION');

      expect(sensitivities.get(3)?.isSensitive).toBe(true);
      expect(sensitivities.get(3)?.operationTypes).toContain('SHARING_PRIVATE_INFO');
    });

    it('should block plan approval when sensitive step confirmations are missing', async () => {
      // Create plan with sensitive deletion step
      const rawPlan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');
      const sensitivePlan = await PlanRepository.update(rawPlan.id, {
        steps: [
          {
            step_id: 1,
            action: 'permanent_deletion',
            target: 'database.sqlite',
            description: 'Permanently delete database file with rm -rf',
            tool_name: 'run_project_frontend',
            tool_args: {},
            risk_level: 'critical',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Database deleted',
          },
        ],
      });

      // Submit general approval without sensitive confirmation
      const res = await PermissionManager.requestApproval({
        planId: sensitivePlan.id,
        planVersion: sensitivePlan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      expect(res.success).toBe(false);
      expect(res.state).toBe('pending');
      expect(res.missingSensitiveConfirmations).toContain('step_1_PERMANENT_DELETION');
      expect(res.message).toContain('Additional step-specific confirmation is required');
    });

    it('should grant approval when explicit sensitive confirmations are provided', async () => {
      const rawPlan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');
      const sensitivePlan = await PlanRepository.update(rawPlan.id, {
        steps: [
          {
            step_id: 1,
            action: 'permanent_deletion',
            target: 'database.sqlite',
            description: 'Permanently delete database file with rm -rf',
            tool_name: 'run_project_frontend',
            tool_args: {},
            risk_level: 'critical',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Database deleted',
          },
        ],
      });

      const res = await PermissionManager.requestApproval({
        planId: sensitivePlan.id,
        planVersion: sensitivePlan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
        sensitiveConfirmations: {
          step_1_PERMANENT_DELETION: true,
        },
      });

      expect(res.success).toBe(true);
      expect(res.state).toBe('approved');
      expect(res.ticket?.confirmedSensitiveOperations['step_1_PERMANENT_DELETION']).toBe(true);
    });
  });

  describe('4. Centralized Tool Gate Enforcement in ToolExecutor', () => {
    it('should block tool execution when gate is active and no approval ticket is provided', async () => {
      PermissionManager.setGateEnforced(true);

      const res = await ToolExecutor.executeTool(userId, 'get_system_info', {});
      expect(res.success).toBe(false);
      expect(res.error).toContain('PERMISSION_DENIED');
      expect(res.error).toContain('approval ticket is mandatory');
    });

    it('should allow tool execution when a valid approval ticket is presented', async () => {
      PermissionManager.setGateEnforced(true);

      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      expect(approval.success).toBe(true);
      const ticket = approval.ticket!;

      const res = await ToolExecutor.executeTool(userId, 'get_system_info', {}, null, {
        ticket,
        stepId: 1,
      });

      expect(res.success).toBe(true);
      expect(res.result).toBeDefined();

      // Step should now be consumed
      expect(ticket.usedSteps).toContain(1);
    });

    it('should reject execution ticket with expired TTL', async () => {
      PermissionManager.setGateEnforced(true);

      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'system info');
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      const ticket = approval.ticket!;
      ticket.expiresAt = Date.now() - 5000; // Expired

      const res = await ToolExecutor.executeTool(userId, 'get_system_info', {}, null, {
        ticket,
        stepId: 1,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('expired');
    });
  });

  describe('5. REST API Integration for Permission Gate', () => {
    it('POST /conversations/:id/plans/:planId/approve with valid body grants approval', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/plans/${plan.id}/approve`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          planVersion: plan.version,
          channel: 'web_ui',
          explicitConfirmation: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.ticket).toBeDefined();
      expect(body.plan.status).toBe('approved');
    });

    it('POST /conversations/:id/plans/:planId/reject rejects plan and invalidates tickets', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/plans/${plan.id}/reject`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { reason: 'I changed my mind' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.plan.status).toBe('rejected');
    });

    it('POST /conversations/:id/plans/voice-command parses voice approval and issues ticket', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/plans/voice-command`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          transcript: 'GIA, approve this plan.',
          isAssistantVoice: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.state).toBe('approved');
      expect(body.ticket).toBeDefined();
    });

    it('POST /conversations/:id/plans/voice-command rejects assistant loopback voice', async () => {
      await TaskPlanningEngine.createPlan(userId, conversationId, 'Open Chrome');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${conversationId}/plans/voice-command`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          transcript: 'GIA, approve this plan.',
          isAssistantVoice: true,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message).toContain('Assistant TTS voice output cannot approve actions');
    });
  });
});
