import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import crypto from 'crypto';
import { initializeDatabase, query } from '../src/database/client.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../src/ai/execution/plan-execution.engine.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { ToolExecutor } from '../src/ai/tools/executor.js';

describe('PHASE 3.2: Execution Authorization Security Verification Suite', () => {
  let app: FastifyInstance;
  let userA: { id: string; email: string; token: string };
  let userB: { id: string; email: string; token: string };
  let convoAId: string;
  let convoBId: string;

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
    const emailA = `user_a_${Date.now()}@gia.ai`;
    const signupResA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: emailA, password: 'PasswordA123!', name: 'User A' },
    });
    const dataA = JSON.parse(signupResA.body);
    userA = { id: dataA.user.id, email: emailA, token: dataA.token };

    // 2. Create User B (Attacker / Unauthorized user)
    const emailB = `user_b_${Date.now()}@gia.ai`;
    const signupResB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: emailB, password: 'PasswordB123!', name: 'User B' },
    });
    const dataB = JSON.parse(signupResB.body);
    userB = { id: dataB.user.id, email: emailB, token: dataB.token };

    // 3. Create Conversations
    const convoResA = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { title: 'User A Security Audit Session' },
    });
    convoAId = JSON.parse(convoResA.body).conversation?.id || JSON.parse(convoResA.body).id;

    const convoResB = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userB.token}` },
      payload: { title: 'User B Session' },
    });
    convoBId = JSON.parse(convoResB.body).conversation?.id || JSON.parse(convoResB.body).id;
  });

  afterAll(async () => {
    try {
      await query('DELETE FROM step_executions WHERE execution_id IN (SELECT id FROM plan_executions WHERE user_id IN ($1, $2))', [userA.id, userB.id]);
      await query('DELETE FROM plan_executions WHERE user_id IN ($1, $2)', [userA.id, userB.id]);
      await query('DELETE FROM plan_approvals WHERE user_id IN ($1, $2)', [userA.id, userB.id]);
      await query('DELETE FROM task_plans WHERE user_id IN ($1, $2)', [userA.id, userB.id]);
      await query('DELETE FROM messages WHERE conversation_id IN ($1, $2)', [convoAId, convoBId]);
      await query('DELETE FROM conversations WHERE id IN ($1, $2)', [convoAId, convoBId]);
      await query('DELETE FROM users WHERE id IN ($1, $2)', [userA.id, userB.id]);
    } catch {
      // ignore
    }
    await app.close();
  });

  // 1. UUID Alone Rejection Test
  it('1. A raw UUID alone CANNOT authorize execution (strictly rejects with 403)', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(approval.success).toBe(true);
    expect(approval.ticket).toBeDefined();

    // ticketId is a UUID
    const rawUuid = approval.ticket!.ticketId;
    expect(rawUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Attempt execution using the UUID alone instead of the cryptographic ticket token
    const execRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/execute`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        ticketToken: rawUuid,
        planVersion: plan.version,
      },
    });

    expect(execRes.statusCode).toBe(403);
    const body = JSON.parse(execRes.body);
    const errMessage = body.error?.message || body.message;
    expect(errMessage).toContain('PERMISSION_DENIED');
  });

  // 2. Cryptographic Ticket Token Acceptance Test
  it('2. A valid cryptographic ticket token (gia_ticket_...) successfully authorizes execution', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(approval.success).toBe(true);
    expect(approval.ticket?.ticketToken).toBeDefined();
    expect(approval.ticket!.ticketToken).toMatch(/^gia_ticket_[0-9a-f]{32}$/);

    const execRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/execute`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        ticketToken: approval.ticket!.ticketToken,
        planVersion: plan.version,
      },
    });

    expect(execRes.statusCode).toBe(200);
    const body = JSON.parse(execRes.body);
    expect(body.success).toBe(true);
    expect(body.execution.status).toBe('completed');
  });

  // 3. Cross-User Authorization Rejection (IDOR)
  it('3. An execution ticket CANNOT be stolen or used by another user (Cross-User IDOR Protection)', async () => {
    const planA = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approvalA = await PermissionManager.requestApproval({
      planId: planA.id,
      planVersion: planA.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(approvalA.success).toBe(true);

    // User B tries to execute User A's plan using User A's ticket token
    const attackRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${planA.id}/execute`,
      headers: { authorization: `Bearer ${userB.token}` },
      payload: {
        ticketToken: approvalA.ticket!.ticketToken,
        planVersion: planA.version,
      },
    });

    expect(attackRes.statusCode).toBe(403);
  });

  // 4. Cross-Plan Authorization Rejection
  it('4. An execution ticket issued for Plan A CANNOT authorize Plan B', async () => {
    const planA = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approvalA = await PermissionManager.requestApproval({
      planId: planA.id,
      planVersion: planA.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });

    const planB = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    // Plan B is awaiting approval, User A tries to execute Plan B with Plan A's ticket
    const crossPlanRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${planB.id}/execute`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        ticketToken: approvalA.ticket!.ticketToken,
        planVersion: planB.version,
      },
    });

    // Plan B is awaiting approval, forbidden
    expect(crossPlanRes.statusCode).toBe(403);
  });

  // 5. Expired Ticket Rejection
  it('5. An expired execution ticket is strictly rejected', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    const ticketToken = approval.ticket!.ticketToken!;

    // Force expiration in database
    await query('UPDATE plan_approvals SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE ticket_token = $1', [ticketToken]);
    // Clear in-memory cache to force DB lookup
    (PermissionManager as any).tickets.delete(ticketToken);

    // Attempt execution with expired ticket
    const expiredRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/execute`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        ticketToken,
        planVersion: plan.version,
      },
    });

    expect(expiredRes.statusCode).toBe(403);
  });

  // 6. Revoked Ticket Rejection
  it('6. A revoked execution ticket is strictly rejected', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    const ticketToken = approval.ticket!.ticketToken!;

    // Invalidate / Revoke approval
    await PermissionManager.invalidateApproval(plan.id, 'User changed mind');

    const revokedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/execute`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        ticketToken,
        planVersion: plan.version,
      },
    });

    expect(revokedRes.statusCode).toBe(403);
  });

  // 7. Consumed Step Replay Rejection
  it('7. A single-use execution ticket cannot be replayed on already-consumed steps', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const approval = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId: userA.id,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    const ticketToken = approval.ticket!.ticketToken!;

    // Execute tool step 1
    const verify1 = await PermissionManager.verifyToolExecution(userA.id, 'get_system_info', {}, ticketToken, 1);
    expect(verify1.allowed).toBe(true);

    // Mark step 1 consumed
    await PermissionManager.recordStepConsumed(ticketToken, 1);

    // Replay attempt on same step 1
    const verifyReplay = await PermissionManager.verifyToolExecution(userA.id, 'get_system_info', {}, ticketToken, 1);
    expect(verifyReplay.allowed).toBe(false);
    expect(verifyReplay.reason).toContain('already been executed');
  });

  // 8. Mandatory Approval Gate: Forged tokens rejected
  it('8. Execution without approval or with forged tokens is strictly forbidden', async () => {
    const plan = await TaskPlanningEngine.createPlan(userA.id, convoAId, 'system info');
    const fakeToken = `gia_ticket_${crypto.randomBytes(16).toString('hex')}`;

    const forgedRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoAId}/plans/${plan.id}/execute`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        ticketToken: fakeToken,
        planVersion: plan.version,
      },
    });

    expect(forgedRes.statusCode).toBe(403);
  });
});

