import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';

describe('PHASE 4: GIA Plan and Approval User Interface & Unified Multi-Modal Gate Suite', () => {
  let app: FastifyInstance;
  let testUser: { id: string; email: string; token: string };
  let testConvoId: string;

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_key_phase_4_ui_123' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();

    // Create unique test user
    const email = `phase4_ui_${Date.now()}@gia.ai`;
    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, password: 'Password123!', name: 'Phase 4 Tester' },
    });
    const signupData = JSON.parse(signupRes.body);
    testUser = { id: signupData.user.id, email, token: signupData.token };

    // Create test conversation
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${testUser.token}` },
      payload: { title: 'Phase 4 Plan UI Testing' },
    });
    const convoData = JSON.parse(convoRes.body);
    testConvoId = convoData.conversation?.id || convoData.id;
  });

  afterAll(async () => {
    try {
      await query('DELETE FROM step_executions WHERE execution_id IN (SELECT id FROM plan_executions WHERE user_id = $1)', [testUser.id]);
      await query('DELETE FROM plan_executions WHERE user_id = $1', [testUser.id]);
      await query('DELETE FROM approval_records WHERE user_id = $1', [testUser.id]);
      await query('DELETE FROM task_plans WHERE user_id = $1', [testUser.id]);
      await query('DELETE FROM messages WHERE conversation_id = $1', [testConvoId]);
      await query('DELETE FROM conversations WHERE id = $1', [testConvoId]);
      await query('DELETE FROM users WHERE id = $1', [testUser.id]);
    } catch {
      // ignore cleanup errors
    }
    await app.close();
  });

  describe('1. Plan Card Presentation & Data Integrity (Desktop UI)', () => {
    it('should generate a structured plan with all PlanCard required metadata', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'Open Chrome and search YouTube' },
      });

      if (res.statusCode !== 201) {
        console.error('ERROR RESPONSE:', res.body);
      }

      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);

      const plan: ExecutionPlan = data.plan;
      expect(plan.id).toBeDefined();
      expect(plan.conversation_id).toBe(testConvoId);
      expect(plan.objective).toBe('Open Chrome and search YouTube');
      expect(plan.status).toBe('awaiting_approval');
      expect(plan.steps.length).toBeGreaterThan(0);

      // Verify every step contains complete presentation fields for PlanCard
      for (const step of plan.steps) {
        expect(step.step_id).toBeGreaterThan(0);
        expect(step.action).toBeDefined();
        expect(step.description).toBeDefined();
        expect(step.risk_level).toMatch(/^(low|medium|high|critical)$/);
        expect(step.requires_approval).toBe(true);
        expect(step.expected_outcome).toBeDefined();
      }

      // Verify human-readable markdown presentation
      expect(data.presentation).toContain('Execution Plan Formulated');
      expect(data.presentation).toContain('Explicit Approval Required');
    });

    it('should fetch active plan for conversation to populate PlanCard on load', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${testConvoId}/plans/active`,
        headers: { authorization: `Bearer ${testUser.token}` },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.success).toBe(true);
      expect(data.plan).toBeDefined();
      expect(data.plan.objective).toBe('Open Chrome and search YouTube');
      expect(data.plan.status).toBe('awaiting_approval');
    });
  });

  describe('2. Unified Approval Controls: UI, Text, and Voice Interaction', () => {
    it('Desktop UI: should approve plan via Desktop UI controls and issue execution ticket', async () => {
      const activeRes = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${testConvoId}/plans/active`,
        headers: { authorization: `Bearer ${testUser.token}` },
      });
      const currentPlan = JSON.parse(activeRes.body).plan;

      const approveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${currentPlan.id}/approve`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          planVersion: currentPlan.version,
          channel: 'web_ui',
          explicitConfirmation: true,
        },
      });

      expect(approveRes.statusCode).toBe(200);
      const data = JSON.parse(approveRes.body);
      expect(data.success).toBe(true);
      expect(data.plan.status).toBe('approved');
      expect(data.ticket).toBeDefined();
      expect(data.ticket.ticketId).toBeDefined();
      expect(data.ticket.planId).toBe(currentPlan.id);
    });

    it('Voice Input: should approve plan via explicit voice command ("GIA, approve this plan")', async () => {
      // Create new plan for voice test
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'List files in current directory' },
      });
      const newPlan = JSON.parse(planRes.body).plan;

      // Approve via Voice Command endpoint
      const voiceRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/voice-command`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          transcript: 'GIA, approve this plan',
          isAssistantVoice: false,
        },
      });

      expect(voiceRes.statusCode).toBe(200);
      const vData = JSON.parse(voiceRes.body);
      expect(vData.success).toBe(true);
      expect(vData.plan.id).toBe(newPlan.id);
      expect(vData.plan.status).toBe('approved');
      expect(vData.ticket).toBeDefined();
    });

    it('Voice Input: should reject plan via explicit voice command ("GIA, reject this plan")', async () => {
      // Create another plan
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'Open Safari' },
      });
      const safariPlan = JSON.parse(planRes.body).plan;

      // Reject via Voice Command
      const voiceRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/voice-command`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          transcript: 'GIA, reject this plan',
          isAssistantVoice: false,
        },
      });

      expect(voiceRes.statusCode).toBe(200);
      const vData = JSON.parse(voiceRes.body);
      expect(vData.success).toBe(true);
      expect(vData.state).toBe('rejected');
      expect(vData.plan.status).toBe('rejected');
    });

    it('Security Barrier: should strictly block assistant TTS voice self-approval', async () => {
      // Create fresh plan
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'Read system info' },
      });
      const sysPlan = JSON.parse(planRes.body).plan;

      // Attempt self-approval with isAssistantVoice: true
      const voiceRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/voice-command`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          transcript: 'GIA, approve this plan',
          isAssistantVoice: true,
        },
      });

      expect(voiceRes.statusCode).toBe(400);
      const vData = JSON.parse(voiceRes.body);
      expect(vData.success).toBe(false);
      expect(vData.message).toContain('Assistant TTS voice output cannot approve actions');
    });
  });

  describe('3. Plan Modification & Control Invalidation (Phase 4 UI Controls)', () => {
    it('Modify Plan: should update plan steps, increment version, and invalidate previous approvals', async () => {
      // Create plan
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'Open Chrome' },
      });
      const initialPlan = JSON.parse(planRes.body).plan;
      expect(initialPlan.version).toBe(1);

      // Approve plan version 1
      const approveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${initialPlan.id}/approve`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { planVersion: 1, explicitConfirmation: true },
      });
      const staleTicket = JSON.parse(approveRes.body).ticket;
      expect(staleTicket).toBeDefined();

      // User modifies plan inline via UI control ("Also open YouTube")
      const modifyRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/conversations/${testConvoId}/plans/${initialPlan.id}`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { feedback: 'Also open YouTube' },
      });

      expect(modifyRes.statusCode).toBe(200);
      const modifiedData = JSON.parse(modifyRes.body);
      expect(modifiedData.success).toBe(true);
      expect(modifiedData.plan.status).toBe('modified');
      expect(modifiedData.plan.version).toBe(2);

      // Verify that stale ticket for v1 is now completely invalid
      const execRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${initialPlan.id}/execute`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          ticketToken: staleTicket.ticketId,
          planVersion: 2,
        },
      });
      expect(execRes.statusCode).toBe(403); // Forbidden / Invalid ticket
    });
  });

  describe('4. Execution Progress, Live Telemetry, & Cancellation', () => {
    it('should execute approved plan and provide step-by-step progress and verification telemetry', async () => {
      // Create simple actionable plan: check system info
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'system info' },
      });
      const plan = JSON.parse(planRes.body).plan;

      // Approve
      const approveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${plan.id}/approve`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { planVersion: plan.version, explicitConfirmation: true },
      });
      const ticket = JSON.parse(approveRes.body).ticket;

      // Execute approved plan
      const execRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${plan.id}/execute`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          ticketToken: ticket.ticketId,
          planVersion: plan.version,
        },
      });

      expect(execRes.statusCode).toBe(200);
      const execData = JSON.parse(execRes.body);
      expect(execData.success).toBe(true);
      expect(execData.execution.status).toBe('completed');
      expect(execData.execution.completedSteps).toBeGreaterThanOrEqual(1);

      // Verify step telemetry for PlanCard progress display
      const step = execData.execution.stepRecords[0];
      expect(step.stepId).toBe(1);
      expect(step.status).toBe('completed');
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
      expect(step.verification?.verified).toBe(true);

      // Audit logs retrieval endpoint for UI
      const logsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${testConvoId}/plans/${plan.id}/executions`,
        headers: { authorization: `Bearer ${testUser.token}` },
      });
      expect(logsRes.statusCode).toBe(200);
      const logsData = JSON.parse(logsRes.body);
      expect(logsData.executions.length).toBeGreaterThanOrEqual(1);
    });

    it('should support execution cancellation', async () => {
      // Create a plan
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'system info' },
      });
      const plan = JSON.parse(planRes.body).plan;

      // Cancel plan via UI cancel endpoint
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${plan.id}/cancel`,
        headers: { authorization: `Bearer ${testUser.token}` },
      });
      expect(cancelRes.statusCode).toBe(200);
    });
  });

  describe('5. Zero-Bypass Security Verification', () => {
    it('should reject execution request without valid approval ticket with 400 Validation Error', async () => {
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'system info' },
      });
      const plan = JSON.parse(planRes.body).plan;

      // Direct execution without approval
      const bypassRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${plan.id}/execute`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          ticketToken: '', // Missing ticket
          planVersion: plan.version,
        },
      });

      expect(bypassRes.statusCode).toBe(400);
    });

    it('should reject execution request with forged / non-existent ticket token with 400 error', async () => {
      const planRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: { instruction: 'system info' },
      });
      const plan = JSON.parse(planRes.body).plan;

      const forgedRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${testConvoId}/plans/${plan.id}/execute`,
        headers: { authorization: `Bearer ${testUser.token}` },
        payload: {
          ticketToken: 'forged_fake_token_1234567890',
          planVersion: plan.version,
        },
      });

      expect(forgedRes.statusCode).toBe(403);
    });
  });
});
