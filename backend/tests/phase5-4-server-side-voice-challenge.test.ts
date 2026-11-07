import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import crypto from 'node:crypto';
import { initializeDatabase } from '../src/database/client.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';

describe('PHASE 5.4: Server-Side Voice Approval Challenge Suite', () => {
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
    const emailA = `chal_user_${Date.now()}@gia.ai`;
    const signupResA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: emailA, password: 'PasswordA123!', name: 'User A' },
    });
    const dataA = JSON.parse(signupResA.body);
    userA = { id: dataA.user.id, email: emailA, token: dataA.token };

    // 2. Create Attacker
    const emailAttacker = `chal_attacker_${Date.now()}@gia.ai`;
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
      payload: { title: 'User A Voice Session' },
    });
    convoAId = JSON.parse(convoResA.body).conversation?.id || JSON.parse(convoResA.body).id;

    const convoResB = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${attacker.token}` },
      payload: { title: 'Attacker Voice Session' },
    });
    convoAttackerId = JSON.parse(convoResB.body).conversation?.id || JSON.parse(convoResB.body).id;
  });

  beforeEach(() => {
    PermissionManager.resetState();
  });

  afterAll(async () => {
    await app.close();
  });

  // Helper to create a benign test plan
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

  // 1. Valid challenge approval
  it('1. Valid challenge approval succeeds and returns a cryptographic execution ticket', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);

    // Request server challenge via REST endpoint
    const challengeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/challenge`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(challengeRes.statusCode).toBe(200);
    const challengeData = JSON.parse(challengeRes.body);
    expect(challengeData.success).toBe(true);
    expect(challengeData.challenge.challengeToken).toMatch(/^gia_chal_[0-9a-f]{32}$/);
    expect(challengeData.challenge.planId).toBe(plan.id);
    expect(challengeData.challenge.consumed).toBe(false);

    // Submit voice approval with valid challenge token
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/approve`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        channel: 'voice_command',
        voiceTranscript: 'gia approve this plan',
        challengeToken: challengeData.challenge.challengeToken,
      },
    });

    expect(approveRes.statusCode).toBe(200);
    const approveData = JSON.parse(approveRes.body);
    expect(approveData.success).toBe(true);
    expect(approveData.plan.status).toBe('approved');
    expect(approveData.ticket).toBeDefined();
    expect(approveData.ticket.ticketToken).toMatch(/^gia_ticket_[0-9a-f]{32}$/);
    expect(approveData.ticket.planId).toBe(plan.id);

    // Verify challenge is marked consumed in memory/DB
    const storedChallenge = await PermissionManager.getChallenge(challengeData.challenge.challengeToken);
    expect(storedChallenge?.consumed).toBe(true);
  });

  // 2. Reused challenge
  it('2. Reused challenge is rejected with replay attack protection error', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // First use: succeeds
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
    expect(firstRes.state).toBe('approved');

    // Second use with the same challenge: must fail
    const secondRes = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'yes proceed',
      challengeToken: challenge.challengeToken,
    });
    expect(secondRes.success).toBe(false);
    expect(secondRes.message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');
  });

  // 3. Expired challenge
  it('3. Expired challenge is rejected based on server clock', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Simulate expiration by setting expiresAt in the past
    challenge.expiresAt = Date.now() - 5000;

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
    expect(result.message).toContain('Voice approval challenge has expired (exceeded 60-second window)');
  });

  // 4. Forged timestamp
  it('4. Forged client timestamp cannot bypass an expired server challenge', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Challenge expired on server 2 minutes ago
    challenge.expiresAt = Date.now() - 120_000;

    // Client forges transcriptTimestamp to say "I just spoke this 100ms ago"
    const forgedTimestamp = Date.now();
    const result = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve the plan',
      challengeToken: challenge.challengeToken,
      transcriptTimestamp: forgedTimestamp,
    });

    expect(result.success).toBe(false);
    // Server authoritative clock rejects it despite fresh client timestamp
    expect(result.message).toContain('Voice approval challenge has expired');
  });

  // 5. Wrong user
  it('5. Challenge created for User A cannot be approved by Attacker', async () => {
    const planA = await createBenignPlan(userA.id, convoAId);
    const challengeA = await PermissionManager.createApprovalChallenge(planA.id, userA.id, convoAId, planA.version);

    // Attacker attempts to use User A's challenge on their own plan
    const planAttacker = await createBenignPlan(attacker.id, convoAttackerId);

    const result = await PermissionManager.requestApproval({
      planId: planAttacker.id,
      planVersion: planAttacker.version,
      userId: attacker.id,
      conversationId: convoAttackerId,
      channel: 'voice_command',
      voiceTranscript: 'yes proceed',
      challengeToken: challengeA.challengeToken,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Challenge user mismatch');
  });

  // 6. Wrong conversation
  it('6. Challenge issued for Conversation A cannot be used in Conversation B', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);

    // Create another conversation for User A
    const convoResA2 = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'User A Other Session' },
    });
    const convoA2Id = JSON.parse(convoResA2.body).conversation?.id || JSON.parse(convoResA2.body).id;

    // Challenge generated explicitly for convoA2Id
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoA2Id, plan.version);

    // Submit for convoAId where plan resides
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
    expect(result.message).toContain('Challenge conversation mismatch');
  });

  // 7. Wrong plan
  it('7. Challenge issued for Plan 1 cannot authorize Plan 2', async () => {
    const plan1 = await createBenignPlan(userA.id, convoAId);
    const plan2 = await createBenignPlan(userA.id, convoAId);

    // Challenge issued for plan 1
    const challenge1 = await PermissionManager.createApprovalChallenge(plan1.id, userA.id, convoAId, plan1.version);

    // Attempt to approve plan 2 with challenge 1
    const result = await PermissionManager.requestApproval({
      planId: plan2.id,
      planVersion: plan2.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challenge1.challengeToken,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Challenge plan mismatch');
  });

  // 8. Modified plan version
  it('8. Challenge issued for v1 cannot authorize modified plan v2', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challengeV1 = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, 1);

    // Modify plan (increments version to 2 and invalidates old approval)
    const modifiedPlan = await TaskPlanningEngine.modifyPlan(plan, 'Also open YouTube music');
    expect(modifiedPlan.version).toBe(2);

    // Attempt to approve modified plan with v1 challenge
    const result = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: modifiedPlan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: challengeV1.challengeToken,
    });

    expect(result.success).toBe(false);
    expect(result.state).toBe('modified');
    expect(result.message).toContain('Challenge plan version mismatch');
  });

  // 9. Concurrent duplicate approval requests
  it('9. Concurrent duplicate approval requests atomically permit only one winner', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);
    const challenge = await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Dispatch two simultaneous approval calls with the exact same challenge token
    const [res1, res2] = await Promise.all([
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'approve',
        challengeToken: challenge.challengeToken,
      }),
      PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: userA.id,
        conversationId: convoAId,
        channel: 'voice_command',
        voiceTranscript: 'approve',
        challengeToken: challenge.challengeToken,
      }),
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const failures = [res1, res2].filter((r) => !r.success);

    // Exactly one must succeed, exactly one must fail
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0].ticket).toBeDefined();
    expect(failures[0].message).toContain('Challenge has already been consumed. Replay attacks are prohibited.');
  });

  // 10. Rejected or cancelled plan
  it('10. Plan rejection or cancellation immediately revokes challenges and blocks approval', async () => {
    // 10a. Plan Rejection test
    const planReject = await createBenignPlan(userA.id, convoAId);
    const chalReject = await PermissionManager.createApprovalChallenge(
      planReject.id,
      userA.id,
      convoAId,
      planReject.version
    );

    await PermissionManager.rejectPlan(planReject.id, userA.id, 'User rejected via UI');
    expect(chalReject.consumed).toBe(true);

    const afterRejectResult = await PermissionManager.requestApproval({
      planId: planReject.id,
      planVersion: planReject.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: chalReject.challengeToken,
    });
    expect(afterRejectResult.success).toBe(false);
    expect(afterRejectResult.message).toContain('A rejected plan must never execute');

    // 10b. Plan Cancellation test
    const planCancel = await createBenignPlan(userA.id, convoAId);
    const chalCancel = await PermissionManager.createApprovalChallenge(
      planCancel.id,
      userA.id,
      convoAId,
      planCancel.version
    );

    await PermissionManager.cancelPlan(planCancel.id, 'User cancelled');
    expect(chalCancel.consumed).toBe(true);

    const afterCancelResult = await PermissionManager.requestApproval({
      planId: planCancel.id,
      planVersion: planCancel.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
      challengeToken: chalCancel.challengeToken,
    });
    expect(afterCancelResult.success).toBe(false);
    expect(afterCancelResult.message).toContain('A cancelled plan cannot be approved');
  });

  // 11. Missing challenge
  it('11. Missing challenge token is rejected when challenge is active or enforced', async () => {
    const plan = await createBenignPlan(userA.id, convoAId);

    // Issue a challenge for this plan
    await PermissionManager.createApprovalChallenge(plan.id, userA.id, convoAId, plan.version);

    // Request voice approval without passing challengeToken
    const result = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Missing server-issued voice approval challenge token');

    // Also test with global challenge enforcement enabled
    PermissionManager.resetState();
    PermissionManager.setChallengeEnforced(true);

    const freshPlan = await createBenignPlan(userA.id, convoAId);
    const enforcedResult = await PermissionManager.requestApproval({
      planId: freshPlan.id,
      planVersion: freshPlan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'approve',
    });

    expect(enforcedResult.success).toBe(false);
    expect(enforcedResult.message).toContain('Missing server-issued voice approval challenge token');
  });

  // 12. High-impact action requiring UI confirmation
  it('12. High-impact action requires UI confirmation and is BLOCKED via voice even with a valid challenge', async () => {
    const sensitivePlan: ExecutionPlan = {
      id: crypto.randomUUID(),
      conversation_id: convoAId,
      user_id: userA.id,
      objective: 'Permanently delete system configuration and credentials',
      status: 'pending',
      version: 1,
      is_ambiguous: false,
      steps: [
        {
          step_id: 1,
          action: 'delete_file',
          target: '/etc/gia/system_secrets.env',
          tool_name: 'delete_file',
          tool_args: { path: '/etc/gia/system_secrets.env' },
          description: 'Permanently remove system credentials file',
          risk_level: 'critical',
          requires_approval: true,
          depends_on: [],
          expected_outcome: 'File permanently deleted',
        },
      ],
      approval: { required: true, approved: false, approved_at: null },
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await PlanRepository.create(sensitivePlan);

    // Issue a valid server challenge
    const challenge = await PermissionManager.createApprovalChallenge(
      sensitivePlan.id,
      userA.id,
      convoAId,
      sensitivePlan.version
    );

    // Attempt voice approval with valid challenge token
    const voiceResult = await PermissionManager.requestApproval({
      planId: sensitivePlan.id,
      planVersion: sensitivePlan.version,
      userId: userA.id,
      conversationId: convoAId,
      channel: 'voice_command',
      voiceTranscript: 'gia approve this plan',
      challengeToken: challenge.challengeToken,
    });

    // Voice channel MUST be strictly blocked for high-impact actions
    expect(voiceResult.success).toBe(false);
    expect(voiceResult.message).toContain(
      'High-impact actions require trusted explicit UI confirmation. Voice commands cannot authorize sensitive operations.'
    );

    // Web UI approval with step-specific sensitive confirmation succeeds
    const uiResult = await PermissionManager.requestApproval({
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

    expect(uiResult.success).toBe(true);
    expect(uiResult.ticket).toBeDefined();
    expect(uiResult.ticket?.ticketToken).toMatch(/^gia_ticket_[0-9a-f]{32}$/);
  });
});
