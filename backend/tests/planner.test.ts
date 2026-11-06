import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { randomUUID } from 'crypto';
import { planRoutes } from '../src/api/routes/plans.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import {
  ExecutionPlanSchema,
  PlanStepSchema,
  ExecutionPlan,
} from '../src/ai/planner/planner.interface.js';
import { ToolExecutor } from '../src/ai/tools/executor.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA Autonomous Task Planning Engine (Phase 1)', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
  let otherToken: string;
  let otherUserId: string;
  let convoId: string;

  beforeAll(async () => {
    setTestProvider(new MockProvider());
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: 'test_jwt_secret_key_1234567890',
    });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query("DELETE FROM users WHERE email IN ('planner_test@gia.ai', 'planner_other@gia.ai')");

    // Primary user
    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'planner_test@gia.ai', password: 'secure_password_123', name: 'Planner Tester' },
    });
    const body = JSON.parse(signupRes.body);
    userToken = body.token;
    userId = body.user.id;

    // Secondary user for IDOR boundary testing
    const otherRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'planner_other@gia.ai', password: 'secure_password_123', name: 'Other User' },
    });
    const otherBody = JSON.parse(otherRes.body);
    otherToken = otherBody.token;
    otherUserId = otherBody.user.id;

    // Create a test conversation
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Planning Engine Chat' },
    });
    convoId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    setTestProvider(null);
    await query("DELETE FROM users WHERE email IN ('planner_test@gia.ai', 'planner_other@gia.ai')");
    await pool.end();
  });

  describe('1. Strict Schema Validation & Safety Restrictions', () => {
    it('should validate a well-formed execution plan matching the schema', () => {
      const validPlan: ExecutionPlan = {
        id: randomUUID(),
        conversation_id: randomUUID(),
        user_id: randomUUID(),
        objective: 'Open YouTube in Chrome',
        status: 'awaiting_approval',
        is_ambiguous: false,
        clarification_question: null,
        steps: [
          {
            step_id: 1,
            action: 'launch_application',
            target: 'Google Chrome',
            description: 'Launch Google Chrome',
            tool_name: 'open_application',
            tool_args: { appName: 'Google Chrome' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [],
            expected_outcome: 'Google Chrome launched',
          },
          {
            step_id: 2,
            action: 'navigate_browser',
            target: 'https://www.youtube.com',
            description: 'Navigate Chrome to YouTube',
            tool_name: 'open_url',
            tool_args: { url: 'https://www.youtube.com' },
            risk_level: 'low',
            requires_approval: true,
            depends_on: [1],
            expected_outcome: 'YouTube loaded',
          },
        ],
        approval: {
          required: true,
          approved: false,
          approved_at: null,
          feedback: null,
        },
        metadata: {},
        version: 1,
      };

      const parsed = ExecutionPlanSchema.safeParse(validPlan);
      expect(parsed.success).toBe(true);
    });

    it('should reject malformed plans with invalid step numbers, empty steps, or invalid risk levels', () => {
      const invalidPlan = {
        id: randomUUID(),
        conversation_id: randomUUID(),
        user_id: randomUUID(),
        objective: '', // Invalid empty objective
        status: 'invalid_status', // Invalid status
        steps: [], // Invalid: empty steps
      };

      const parsed = ExecutionPlanSchema.safeParse(invalidPlan);
      expect(parsed.success).toBe(false);

      const invalidStep = {
        step_id: -1, // Invalid negative step_id
        action: '',
        description: '',
        risk_level: 'extreme_danger', // Invalid enum value
      };
      const stepParsed = PlanStepSchema.safeParse(invalidStep);
      expect(stepParsed.success).toBe(false);
    });

    it('should NEVER execute tools or filesystem operations during plan generation', async () => {
      const toolSpy = vi.spyOn(ToolExecutor, 'executeTool');
      toolSpy.mockClear();

      const plan = await TaskPlanningEngine.createPlan(userId, convoId, 'Open YouTube in Chrome');

      expect(plan).toBeDefined();
      expect(plan.steps.length).toBeGreaterThanOrEqual(1);

      // Invariant: The planning engine must NEVER execute any tools
      expect(toolSpy).toHaveBeenCalledTimes(0);
      toolSpy.mockRestore();
    });
  });

  describe('2. Task Planning Engine & Atomic Step Decomposition', () => {
    it('should break "Open YouTube in Chrome" into ordered atomic steps with dependencies', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, convoId, 'Open YouTube in Chrome');

      expect(plan.objective).toContain('YouTube');
      expect(plan.status).toBe('awaiting_approval');
      expect(plan.approval.required).toBe(true);
      expect(plan.approval.approved).toBe(false);

      // Verify atomic steps
      expect(plan.steps.length).toBe(4);
      expect(plan.steps[0].action).toBe('launch_application');
      expect(plan.steps[0].target).toContain('Chrome');
      expect(plan.steps[0].depends_on).toEqual([]);

      expect(plan.steps[1].action).toBe('wait_for_application');
      expect(plan.steps[1].depends_on).toContain(1);

      expect(plan.steps[2].action).toBe('navigate_browser');
      expect(plan.steps[2].target).toBe('https://www.youtube.com');
      expect(plan.steps[2].depends_on).toContain(2);

      expect(plan.steps[3].action).toBe('verify_browser');
      expect(plan.steps[3].depends_on).toContain(3);

      // All steps must mandate approval
      plan.steps.forEach((step) => {
        expect(step.requires_approval).toBe(true);
        expect(step.risk_level).toBeDefined();
        expect(step.expected_outcome.length).toBeGreaterThan(0);
      });
    });

    it('should detect ambiguous instructions and generate a clarification question', async () => {
      const ambiguousPlan = await TaskPlanningEngine.createPlan(userId, convoId, 'open it');

      expect(ambiguousPlan.is_ambiguous).toBe(true);
      expect(ambiguousPlan.clarification_question).toBeDefined();
      expect(ambiguousPlan.clarification_question).toContain('Which specific');
      expect(ambiguousPlan.status).toBe('awaiting_approval');
    });

    it('should correctly format plan into human-readable presentation for chat UI', async () => {
      const plan = await TaskPlanningEngine.createPlan(userId, convoId, 'Open YouTube in Chrome');
      const presentation = TaskPlanningEngine.presentPlan(plan);

      expect(presentation).toContain('📋 **Execution Plan Formulated:');
      expect(presentation).toContain('Awaiting Approval');
      expect(presentation).toContain('Explicit Approval Required');
      expect(presentation).toContain('1.');
      expect(presentation).toContain('Launch Google Chrome');
      expect(presentation).toContain('Navigate Chrome to YouTube');
    });
  });

  describe('3. Conversation Handling & Plan Modifications', () => {
    let pendingPlan: ExecutionPlan;

    beforeAll(async () => {
      pendingPlan = await TaskPlanningEngine.createPlan(userId, convoId, 'Open Chrome');
    });

    it('should understand follow-up "Also open YouTube" and append step to pending plan without execution', async () => {
      const toolSpy = vi.spyOn(ToolExecutor, 'executeTool');
      toolSpy.mockClear();

      const initialCount = pendingPlan.steps.length;
      const modifiedPlan = await TaskPlanningEngine.modifyPlan(pendingPlan, 'Also open https://www.youtube.com');

      expect(modifiedPlan.steps.length).toBe(initialCount + 1);
      const addedStep = modifiedPlan.steps[modifiedPlan.steps.length - 1];
      expect(addedStep.target).toContain('youtube.com');
      expect(addedStep.requires_approval).toBe(true);
      expect(modifiedPlan.approval.approved).toBe(false);

      // Invariant: Must not execute anything during modification
      expect(toolSpy).toHaveBeenCalledTimes(0);
      toolSpy.mockRestore();

      pendingPlan = modifiedPlan;
    });

    it('should understand follow-up "Don\'t open YouTube, open GitHub" and update target', async () => {
      const modifiedPlan = await TaskPlanningEngine.modifyPlan(
        pendingPlan,
        "Don't open youtube.com, open github.com"
      );

      const targetFound = modifiedPlan.steps.some((s) => s.target.includes('github.com'));
      expect(targetFound).toBe(true);
      expect(modifiedPlan.approval.approved).toBe(false);
      expect(modifiedPlan.version).toBeGreaterThan(1);

      pendingPlan = modifiedPlan;
    });

    it('should understand follow-up "Remove the second step" and re-index steps', async () => {
      const beforeCount = pendingPlan.steps.length;
      const modifiedPlan = await TaskPlanningEngine.modifyPlan(pendingPlan, 'Remove the second step');

      expect(modifiedPlan.steps.length).toBe(beforeCount - 1);
      // Verify re-indexing
      modifiedPlan.steps.forEach((s, idx) => {
        expect(s.step_id).toBe(idx + 1);
      });
      expect(modifiedPlan.approval.approved).toBe(false);

      pendingPlan = modifiedPlan;
    });

    it('should explain plan actions without modifying or executing', () => {
      const explanation = TaskPlanningEngine.explainPlan(pendingPlan, 1);
      expect(explanation).toContain('Explanation for Step 1');
      expect(explanation).toContain('Risk Level:');
      expect(explanation).toContain('Expected Outcome:');
      expect(explanation).toContain('will NOT execute until you explicitly approve');

      const fullExplanation = TaskPlanningEngine.explainPlan(pendingPlan);
      expect(fullExplanation).toContain('Detailed Plan Breakdown');
      expect(fullExplanation).toContain('Safety Guarantee:');
    });

    it('should classify conversation intents accurately', () => {
      expect(TaskPlanningEngine.classifyIntent('Yes, proceed with the plan', true).intent).toBe('approve_plan');
      expect(TaskPlanningEngine.classifyIntent('Approved', true).intent).toBe('approve_plan');
      expect(TaskPlanningEngine.classifyIntent('Cancel the plan', true).intent).toBe('reject_plan');
      expect(TaskPlanningEngine.classifyIntent('Explain step 1', true).intent).toBe('explain_plan');
      expect(TaskPlanningEngine.classifyIntent('Also open Spotify', true).intent).toBe('modify_plan');
      expect(TaskPlanningEngine.classifyIntent("Don't open Spotify, open Music", true).intent).toBe('modify_plan');
      expect(TaskPlanningEngine.classifyIntent('Remove step 2', true).intent).toBe('modify_plan');
      expect(TaskPlanningEngine.classifyIntent('Open Chrome', false).intent).toBe('create_plan');
      expect(TaskPlanningEngine.classifyIntent('What is JavaScript?', false).intent).toBe('conversational');
    });
  });

  describe('4. Plan Lifecycle & REST Endpoints Integration', () => {
    let createdPlanId: string;

    it('should create plan via POST /api/v1/conversations/:id/plans', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/plans`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { instruction: 'Launch Google Chrome and visit youtube.com' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.plan.id).toBeDefined();
      expect(body.plan.status).toBe('awaiting_approval');
      expect(body.presentation).toContain('Execution Plan Formulated');
      createdPlanId = body.plan.id;
    });

    it('should fetch active pending plan via GET /api/v1/conversations/:id/plans/active', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${convoId}/plans/active`,
        headers: { authorization: `Bearer ${userToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.plan.id).toBe(createdPlanId);
      expect(body.plan.status).toBe('awaiting_approval');
    });

    it('should modify plan via PUT /api/v1/conversations/:id/plans/:planId', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/conversations/${convoId}/plans/${createdPlanId}`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { feedback: 'Also open Spotify' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.plan.steps.length).toBeGreaterThanOrEqual(2);
    });

    it('should approve plan via POST /api/v1/conversations/:id/plans/:planId/approve', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/plans/${createdPlanId}/approve`,
        headers: { authorization: `Bearer ${userToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.plan.status).toBe('approved');
      expect(body.plan.approval.approved).toBe(true);
      expect(body.plan.approval.approved_at).toBeDefined();
    });

    it('should enforce IDOR authorization boundaries and reject unauthorized users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${convoId}/plans/active`,
        headers: { authorization: `Bearer ${otherToken}` }, // Different user token!
      });

      expect(res.statusCode).toBe(403);
    });
  });
});

