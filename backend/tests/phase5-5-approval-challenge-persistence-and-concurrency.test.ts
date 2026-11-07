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
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';

describe('PHASE 5.5: Approval Challenge Persistence and Production Concurrency Audit', () => {
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
    await app.register(fastifyJwt, { secret: 'audit_persistence_jwt_secret_123456789' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();

    // 1. Create User A
    const emailA = `audit_p55_user_${Date.now()}@gia.ai`;
    const signupResA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: emailA, password: 'PasswordA123!', name: 'User A' },
    });
    const dataA = JSON.parse(signupResA.body);
    userA = { id: dataA.user.id, email: emailA, token: dataA.token };

    // 2. Create Attacker
    const emailAttacker = `audit_p55_attacker_${Date.now()}@gia.ai`;
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
      payload: { title: 'Persistence Audit Session A' },
    });
    convoAId = JSON.parse(convoResA.body).conversation?.id || JSON.parse(convoResA.body).id;

    const convoResB = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${attacker.token}` },
      payload: { title: 'Persistence Audit Attacker Session' },
    });
    convoAttackerId = JSON.parse(convoResB.body).conversation?.id || JSON.parse(convoResB.body).id;
  });

  beforeEach(() => {
    PermissionManager.resetState();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createBenignPlan(userId: string, conversationId: string): Promise<ExecutionPlan> {
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      user_id: userId,
      objective: 'Open Chrome and play music',
      status: 'pending',
      version: 1,
      is_ambiguous: false,
      steps: [
        {
          step_id: 1,
          action: 'launch_application',
          target: 'Google Chrome',
          tool_name: 'launch_application',
          tool_args: { application_name: 'Google Chrome' },
          description: 'Launch Google Chrome application',
          risk_level: 'low',
          requires_approval: false,
          depends_on: [],
          expected_outcome: 'Google Chrome launched',
        },
      ],
      approval: { required: true, approved: false, approved_at: null },
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return await PlanRepository.create(plan);
  }

  // 1. Multi-instance / multi-worker concurrent submission of the same challenge
  it('1. Two backend processes submitting the same challenge simultaneously: exactly one succeeds via atomic row lock', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Verify challenge is persisted in PostgreSQL
    const dbCheck = await query<any>(
      `SELECT * FROM voice_approval_challenges WHERE challenge_token = $1`,
      [challenge.challengeToken]
    );
    expect(dbCheck.rows).toHaveLength(1);
    expect(dbCheck.rows[0].consumed).toBe(false);

    // Clear process memory to simulate two independent worker processes communicating via PostgreSQL
    PermissionManager.resetState();

    // Two simultaneous workers dispatch approval with the same challenge token
    const [workerA, workerB] = await Promise.all([
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'gia approve this plan',
        challengeToken: challenge.challengeToken,
      }),
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'gia approve this plan',
        challengeToken: challenge.challengeToken,
      }),
    ]);

    const successes = [workerA, workerB].filter((r) => r.success);
    const failures = [workerA, workerB].filter((r) => !r.success);

    // Exactly one winner, exactly one atomic failure
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0].ticket?.ticketToken).toMatch(/^gia_ticket_[0-9a-f]{32}$/);
    expect(failures[0].message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');

    // Database state check: must be marked consumed = true
    const postDbCheck = await query<any>(
      `SELECT * FROM voice_approval_challenges WHERE challenge_token = $1`,
      [challenge.challengeToken]
    );
    expect(postDbCheck.rows[0].consumed).toBe(true);
    expect(postDbCheck.rows[0].consumed_at).not.toBeNull();
  });

  // 2. Challenge reuse after backend restart
  it('2. Challenge reuse after backend restart is strictly rejected via persistent database check', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // First use in Session 1
    const firstRes = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes proceed',
      challengeToken: challenge.challengeToken,
    });
    expect(firstRes.success).toBe(true);
    expect(firstRes.ticket).toBeDefined();

    // SIMULATE BACKEND CRASH / RESTART: complete memory wipe
    PermissionManager.resetState();

    // In Session 2 (post-restart), client attempts to reuse the consumed challenge
    const replayedRes = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes proceed',
      challengeToken: challenge.challengeToken,
    });

    expect(replayedRes.success).toBe(false);
    expect(replayedRes.message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');
  });

  // 3. Expired challenge after restart
  it('3. Expired challenge after restart is strictly rejected based on persistent database timestamp', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Artificially expire the challenge in PostgreSQL (e.g. 5 minutes ago)
    await query(
      `
      UPDATE voice_approval_challenges
      SET expires_at = NOW() - INTERVAL '5 minutes'
      WHERE challenge_token = $1
      `,
      [challenge.challengeToken]
    );

    // SIMULATE BACKEND RESTART: memory wipe
    PermissionManager.resetState();

    // Client submits expired challenge to restarted backend
    const result = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challenge.challengeToken,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Voice approval challenge has expired');
  });

  // 4. Revoked challenge after plan modification
  it('4. Revoked challenge after plan modification remains revoked across backend restarts', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Modify plan (which increments version to 2 and invalidates prior approval/challenges)
    const modifiedPlan = await TaskPlanningEngine.modifyPlan(plan, 'Updated target application');
    expect(modifiedPlan.version).toBe(2);
    await PermissionManager.invalidateApproval(plan.id, 'Plan modified by user');

    // Verify revocation in PostgreSQL
    const dbCheck = await query<any>(
      `SELECT * FROM voice_approval_challenges WHERE challenge_token = $1`,
      [challenge.challengeToken]
    );
    expect(dbCheck.rows[0].revoked).toBe(true);
    expect(dbCheck.rows[0].revoked_at).not.toBeNull();

    // SIMULATE BACKEND RESTART
    PermissionManager.resetState();

    // Attempt to approve modified plan with the revoked challenge
    const result = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: modifiedPlan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challenge.challengeToken,
    });

    expect(result.success).toBe(false);
    // Revoked challenge or version mismatch rejected
    expect(result.message).toMatch(/(Challenge has been revoked|Challenge plan version mismatch)/);
  });

  // 5. Concurrent approval and rejection
  it('5. Concurrent approval and rejection: state remains consistent, no usable ticket on rejection', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Dispatch simultaneous approval and rejection
    const [approvalRes, rejectionRes] = await Promise.all([
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'gia approve this plan',
        challengeToken: challenge.challengeToken,
      }),
      PermissionManager.rejectPlan(plan.id, userA.id, 'User clicked reject concurrently'),
    ]);

    expect(rejectionRes.state).toBe('rejected');

    // Final database status check
    const updatedPlan = await PlanRepository.findById(plan.id);
    expect(updatedPlan).not.toBeNull();

    if (updatedPlan?.status === 'rejected') {
      // If rejection won or ran, any ticket must be revoked
      if (approvalRes.ticket) {
        const verify = await PermissionManager.verifyToolExecution(
          userA.id,
          'launch_application',
          { application_name: 'Google Chrome' },
          approvalRes.ticket.ticketToken,
          1
        );
        expect(verify.allowed).toBe(false);
        expect(verify.reason).toContain('Plan was rejected. Rejected plans must never execute.');
      }
    }
  });

  // 6. Concurrent approval and cancellation
  it('6. Concurrent approval and cancellation: plan cancellation revokes ticket and challenge', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    const [approvalRes] = await Promise.all([
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'gia approve this plan',
        challengeToken: challenge.challengeToken,
      }),
      PermissionManager.cancelPlan(plan.id, 'User clicked cancel concurrently'),
    ]);

    // Plan must be cancelled
    const updatedPlan = await PlanRepository.findById(plan.id);
    expect(updatedPlan?.status).toBe('cancelled');

    // Tool execution under any issued ticket must be denied
    if (approvalRes.ticket) {
      const verify = await PermissionManager.verifyToolExecution(
        userA.id,
        'launch_application',
        { application_name: 'Google Chrome' },
        approvalRes.ticket.ticketToken,
        1
      );
      expect(verify.allowed).toBe(false);
    }
  });

  // 7. Wrong user and wrong plan after restart
  it('7. Wrong user and wrong plan attacks fail closed even after backend restart', async () => {
    const planA = await createBenignPlan(userA.id, convoAId);
    const challengeA = await PermissionManager.createApprovalChallenge(planA.id, userA.id, convoAId, planA.version);

    // SIMULATE BACKEND RESTART
    PermissionManager.resetState();

    // 7a. Attacker attempts to use User A's challenge on Attacker's plan
    const planAttacker = await createBenignPlan(attacker.id, convoAttackerId);
    const attackerResult = await PermissionManager.requestApproval({
      planId: planAttacker.id,
      planVersion: planAttacker.version,
      userId: attacker.id,
      conversationId: convoAttackerId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challengeA.challengeToken,
    });
    expect(attackerResult.success).toBe(false);
    expect(attackerResult.message).toContain('Challenge user mismatch');

    // 7b. User A attempts to use challenge on a different plan
    const planA2 = await createBenignPlan(userA.id, convoAId);
    const planMismatchResult = await PermissionManager.requestApproval({
      planId: planA2.id,
      planVersion: planA2.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challengeA.challengeToken,
    });
    expect(planMismatchResult.success).toBe(false);
    expect(planMismatchResult.message).toContain('Challenge plan mismatch');
  });

  // 8. High-impact action still requiring explicit UI confirmation
  it('8. High-impact action requires UI confirmation and is strictly blocked via voice with persistent challenges', async () => {
    const sensitivePlan: ExecutionPlan = {
      id: crypto.randomUUID(),
      conversation_id: convoAId,
      user_id: userA.id,
      objective: 'Purge database and private keys',
      status: 'pending',
      version: 1,
      is_ambiguous: false,
      steps: [
        {
          step_id: 1,
          action: 'delete_file',
          target: '/var/data/keys.env',
          tool_name: 'delete_file',
          tool_args: { path: '/var/data/keys.env' },
          description: 'Purge secret keys',
          risk_level: 'critical',
          requires_approval: true,
          depends_on: [],
          expected_outcome: 'Keys purged',
        },
      ],
      approval: { required: true, approved: false, approved_at: null },
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await PlanRepository.create(sensitivePlan);

    const challenge = await PermissionManager.createApprovalChallenge(
      sensitivePlan.id,
      userA.id,
      convoAId,
      sensitivePlan.version
    );

    // Voice channel MUST be strictly blocked
    const voiceRes = await PermissionManager.requestApproval({
      planId: sensitivePlan.id,
      planVersion: sensitivePlan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'gia approve this plan',
      challengeToken: challenge.challengeToken,
    });

    expect(voiceRes.success).toBe(false);
    expect(voiceRes.message).toContain(
      'High-impact actions require trusted explicit UI confirmation. Voice commands cannot authorize sensitive operations.'
    );

    // Web UI approval with step-specific sensitive confirmation succeeds
    const uiRes = await PermissionManager.requestApproval({
      planId: sensitivePlan.id,
      planVersion: sensitivePlan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'web_ui',
      explicitConfirmation: true,
      sensitiveConfirmations: {
        step_1_PERMANENT_DELETION: true,
        step_1_SHARING_PRIVATE_INFO: true,
      },
    });

    expect(uiRes.success).toBe(true);
    expect(uiRes.ticket).toBeDefined();
  });

  // 9. Execution-ticket consistency: A ticket cannot be issued twice from one challenge
  it('9. A ticket cannot be issued twice from one challenge under any sequence of calls', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // First call: generates ticket 1
    const res1 = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challenge.challengeToken,
    });
    expect(res1.success).toBe(true);
    expect(res1.ticket).toBeDefined();

    // Repeated call 1ms later: blocked, no ticket
    const res2 = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challenge.challengeToken,
    });
    expect(res2.success).toBe(false);
    expect(res2.ticket).toBeUndefined();

    // Check count in plan_approvals table: exactly 1 approval record
    const approvalsCheck = await query<any>(
      `SELECT * FROM plan_approvals WHERE plan_id = $1`,
      [plan.id]
    );
    expect(approvalsCheck.rows).toHaveLength(1);
    expect(approvalsCheck.rows[0].ticket_token).toBe(res1.ticket?.ticketToken);
  });

  // 10. Execution-ticket consistency: Ticket revocation remains effective after backend restart
  it('10. Ticket revocation remains strictly effective in PostgreSQL after backend restart', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    const approvalRes = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challenge.challengeToken,
    });
    expect(approvalRes.success).toBe(true);
    const ticketToken = approvalRes.ticket!.ticketToken!;

    // Ticket works before revocation
    const verifyBefore = await PermissionManager.verifyToolExecution(
      userA.id,
      'launch_application',
      { application_name: 'Google Chrome' },
      ticketToken,
      1
    );
    expect(verifyBefore.allowed).toBe(true);

    // Cancel plan (revokes ticket in PostgreSQL and in-memory)
    await PermissionManager.cancelPlan(plan.id, 'User aborted');

    // SIMULATE BACKEND RESTART: completely wipe in-memory cache
    PermissionManager.resetState();

    // Tool execution verification after restart: must query PostgreSQL and deny execution
    const verifyAfter = await PermissionManager.verifyToolExecution(
      userA.id,
      'launch_application',
      { application_name: 'Google Chrome' },
      ticketToken,
      1
    );
    expect(verifyAfter.allowed).toBe(false);
    expect(verifyAfter.reason).toContain('PERMISSION_DENIED: Invalid or revoked execution ticket.');
  });
});
