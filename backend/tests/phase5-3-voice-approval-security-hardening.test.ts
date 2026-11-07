import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import crypto from 'node:crypto';
import { initializeDatabase, query } from '../src/database/client.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PlanExecutionEngine } from '../src/ai/execution/plan-execution.engine.js';
import { ExecutionPlan } from '../src/ai/planner/plan.interface.js';
import { NotFoundError, AuthorizationError } from '../src/shared/errors.js';

describe('PHASE 5.3: Voice Approval Security Hardening Suite', () => {
  let app: FastifyInstance;
  let userA: { id: string; email: string; token: string };
  let attacker: { id: string; email: string; token: string };
  let convoAId: string;
  let convoAttackerId: string;

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, { secret: 'auth_security_jwt_secret_987654321' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();

    // 1. Create User A
    const emailA = `sec_user_${Date.now()}@gia.ai`;
    const signupResA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: emailA, password: 'PasswordA123!', name: 'User A' },
    });
    const dataA = JSON.parse(signupResA.body);
    userA = { id: dataA.user.id, email: emailA, token: dataA.token };

    // 2. Create Attacker
    const emailAttacker = `sec_attacker_${Date.now()}@gia.ai`;
    const signupResB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: emailAttacker, password: 'PasswordAttacker123!', name: 'Attacker' },
    });
    const dataB = JSON.parse(signupResB.body);
    attacker = { id: dataB.user.id, email: emailAttacker, token: dataB.token };

    // 3. Create Conversations
    const convoResA = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'Security Audit Session A' },
    });
    convoAId = JSON.parse(convoResA.body).conversation?.id || JSON.parse(convoResA.body).id;

    const convoResB = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${attacker.token}` },
      payload: { title: 'Attacker Session B' },
    });
    convoAttackerId = JSON.parse(convoResB.body).conversation?.id || JSON.parse(convoResB.body).id;
  });

  beforeEach(() => {
    PermissionManager.resetState();
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Forged isAssistantVoice: false cannot approve sensitive / high-impact actions
  it('1. Forged isAssistantVoice: false CANNOT authorize sensitive / high-impact actions via voice', async () => {
    const sensitivePlan: ExecutionPlan = {
      id: crypto.randomUUID(),
      conversation_id: convoAId,
      user_id: userA.id,
      objective: 'Delete system configuration and erase disk',
      status: 'pending',
      version: 1,
      is_ambiguous: false,
      steps: [
        {
          step_id: 1,
          action: 'delete_file',
          target: '/etc/gia/config.json',
          description: 'Permanently delete config file',
          tool_name: 'delete_file',
          tool_args: { filePath: '/etc/gia/config.json' },
          risk_level: 'critical',
          requires_approval: true,
          depends_on: [],
          expected_outcome: 'File permanently erased',
        },
      ],
      approval: { required: true, approved: false, approved_at: null },
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await PlanRepository.create(sensitivePlan);

    // Attacker or speaker feedback submits voice approval claiming isAssistantVoice: false
    const forgedRequest = await PermissionManager.requestApproval({
      planId: sensitivePlan.id,
      planVersion: 1,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes proceed and approve',
      isAssistantVoice: false, // Forged boolean flag claiming it is human speech
      transcriptTimestamp: Date.now(),
    });

    expect(forgedRequest.success).toBe(false);
    expect(forgedRequest.state).toBe('pending');
    expect(forgedRequest.message).toContain('High-impact actions require trusted explicit UI confirmation');
    expect(forgedRequest.ticket).toBeUndefined();

    // Verify plan remains unapproved in repository
    const stored = await PlanRepository.findById(sensitivePlan.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.approval.approved).toBe(false);
  });

  // 2. Replayed approval transcript
  it('2. Replayed voice approval transcript is strictly rejected', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Chrome');
    const voiceNonce = crypto.randomUUID();
    const timestamp = Date.now();

    // First voice approval succeeds for non-sensitive action
    const firstApproval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes approve this plan',
      voiceSessionId: 'session_voice_001',
      approvalNonce: voiceNonce,
      transcriptTimestamp: timestamp,
    });
    expect(firstApproval.success).toBe(true);
    expect(firstApproval.ticket).toBeDefined();

    // Attacker replays identical approval transcript / nonce
    const replayedApproval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes approve this plan',
      voiceSessionId: 'session_voice_001',
      approvalNonce: voiceNonce,
      transcriptTimestamp: timestamp,
    });

    expect(replayedApproval.success).toBe(false);
    expect(replayedApproval.message).toContain('Replayed voice approval detected');
  });

  // 3. Stale approval (received before approval prompt or older than 60s)
  it('3. Stale approval received before prompt or older than 60s is strictly rejected', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Notes');
    const planCreatedTime = new Date(plan.created_at || Date.now()).getTime();

    // Case A: Transcript timestamp older than plan creation (approval before prompt)
    const prePromptApproval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes approve',
      transcriptTimestamp: planCreatedTime - 10000, // 10s before plan was even presented!
    });
    expect(prePromptApproval.success).toBe(false);
    expect(prePromptApproval.message).toContain('Approval must originate after the approval prompt was issued');

    // Case B: Transcript timestamp older than 60-second freshness window
    const expiredTimestampApproval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes approve',
      transcriptTimestamp: Date.now() - 75000, // 75 seconds ago!
    });
    expect(expiredTimestampApproval.success).toBe(false);
    expect(expiredTimestampApproval.message).toContain('Voice approval expired');
  });

  // 4. Wrong plan ID
  it('4. Approval for wrong or non-existent plan ID throws NotFoundError', async () => {
    const nonExistentPlanId = crypto.randomUUID();

    await expect(
      PermissionManager.requestApproval({
        planId: nonExistentPlanId,
        planVersion: 1,
        userId: userA.id,
        channel: 'web_ui',
        explicitConfirmation: true,
      })
    ).rejects.toThrow(NotFoundError);
  });

  // 5. Wrong user (IDOR prevention)
  it('5. Approval from unauthorized user throws AuthorizationError', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Terminal');

    await expect(
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: attacker.id, // Mismatching user attempting to approve victim's plan
        channel: 'web_ui',
        explicitConfirmation: true,
      })
    ).rejects.toThrow(AuthorizationError);
  });

  // 6. Modified execution arguments
  it('6. Modified execution arguments are detected and rejected by verifyToolExecution', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Chrome');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(approval.success).toBe(true);
    const ticket = approval.ticket!;

    // Legitimate execution with approved args succeeds
    const legitCheck = await PermissionManager.verifyToolExecution(
      userA.id,
      plan.steps[0].tool_name || 'launch_application',
      plan.steps[0].tool_args,
      ticket,
      1
    );
    expect(legitCheck.allowed).toBe(true);

    // Tampered execution with modified payload is rejected
    const tamperedCheck = await PermissionManager.verifyToolExecution(
      userA.id,
      plan.steps[0].tool_name || 'launch_application',
      { appName: 'MaliciousAppExploit' },
      ticket,
      1
    );
    expect(tamperedCheck.allowed).toBe(false);
    expect(tamperedCheck.reason).toContain('Execution argument tampering detected');
  });

  // 7. Expired ticket
  it('7. An expired execution ticket is strictly rejected', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Calendar');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    const ticket = approval.ticket!;

    // Artificially age the ticket past TTL
    ticket.expiresAt = Date.now() - 5000;

    const check = await PermissionManager.verifyToolExecution(
      userA.id,
      'launch_application',
      { appName: 'Calendar' },
      ticket,
      1
    );
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Execution ticket has expired');
  });

  // 8. Rejected plan
  it('8. A rejected plan cannot be approved or executed', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Music');

    // User rejects the plan
    const rejectResult = await PermissionManager.rejectPlan(plan.id, userA.id, 'User rejected via voice');
    expect(rejectResult.state).toBe('rejected');

    // Attempt to approve rejected plan fails
    const reApproval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(reApproval.success).toBe(false);
    expect(reApproval.state).toBe('rejected');
    expect(reApproval.message).toContain('A rejected plan must never execute');

    // Attempt to execute rejected plan fails
    await expect(
      PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        ticketToken: 'gia_ticket_dummy_token',
      })
    ).rejects.toThrow(/Only approved plans can be executed|Rejected plans must never execute/);
  });

  // 9. Missing approval
  it('9. Tool execution or plan execution without approval ticket is strictly forbidden', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'Open Calculator');

    // Tool execution without ticket token
    const toolCheck = await PermissionManager.verifyToolExecution(
      userA.id,
      'launch_application',
      { appName: 'Calculator' },
      undefined,
      1
    );
    expect(toolCheck.allowed).toBe(false);
    expect(toolCheck.reason).toContain('Explicit user approval ticket is mandatory');

    // Plan execution on unapproved plan without ticket
    await expect(
      PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        ticketToken: undefined as any,
      })
    ).rejects.toThrow(/Only approved plans can be executed/);

    // Approve plan, then attempt execution without ticket token
    await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });

    await expect(
      PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        ticketToken: undefined as any,
      })
    ).rejects.toThrow(/Explicit user approval ticket token is required/);
  });

  // 10. Valid explicit UI approval
  it('10. Valid explicit UI confirmation approves sensitive plans and issues cryptographic ticket', async () => {
    const sensitivePlan: ExecutionPlan = {
      id: crypto.randomUUID(),
      conversation_id: convoAId,
      user_id: userA.id,
      objective: 'Purge temp cache files',
      status: 'pending',
      version: 1,
      is_ambiguous: false,
      steps: [
        {
          step_id: 1,
          action: 'delete_file',
          target: '/tmp/cache.bin',
          description: 'Remove cache binary file',
          tool_name: 'delete_file',
          tool_args: { filePath: '/tmp/cache.bin' },
          risk_level: 'high',
          requires_approval: true,
          depends_on: [],
          expected_outcome: 'Cache cleared',
        },
      ],
      approval: { required: true, approved: false, approved_at: null },
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await PlanRepository.create(sensitivePlan);

    // UI approval with required sensitive confirmations checked
    const approvalResult = await PermissionManager.requestApproval({
      planId: sensitivePlan.id,
      planVersion: 1,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'web_ui',
      explicitConfirmation: true,
      sensitiveConfirmations: {
        step_1_PERMANENT_DELETION: true,
      },
    });

    expect(approvalResult.success).toBe(true);
    expect(approvalResult.state).toBe('approved');
    expect(approvalResult.ticket).toBeDefined();
    expect(approvalResult.ticket?.ticketToken).toMatch(/^gia_ticket_[a-f0-9]{32}$/);
    expect(approvalResult.ticket?.confirmedSensitiveOperations['step_1_PERMANENT_DELETION']).toBe(true);

    // Verify tool execution is authorized with valid ticket
    const toolCheck = await PermissionManager.verifyToolExecution(
      userA.id,
      'delete_file',
      { filePath: '/tmp/cache.bin' },
      approvalResult.ticket!.ticketToken,
      1
    );
    expect(toolCheck.allowed).toBe(true);
  });
});
