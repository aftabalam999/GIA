import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { agentRoutes } from '../src/api/routes/agent.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { LLMGateway, setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA Agent Orchestration Integration Tests', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
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
    await app.register(agentRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query("DELETE FROM users WHERE email = 'agent_orchestrator@gia.ai'");

    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'agent_orchestrator@gia.ai', password: 'secure_password_123', name: 'Orchestration Tester' },
    });
    const body = JSON.parse(signupRes.body);
    userToken = body.token;
    userId = body.user.id;

    // Create a conversation
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Orchestration Chat' },
    });
    convoId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    setTestProvider(null);
    await query("DELETE FROM users WHERE email = 'agent_orchestrator@gia.ai'");
    await pool.end();
  });

  describe('Agent State Machine & Transitions', () => {
    it('should bypass LLMGateway.generate() completely (0 calls) and return deterministic response for "open VS Code"', async () => {
      const spy = vi.spyOn(LLMGateway, 'generate');
      spy.mockClear();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'open VS Code' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.assistantMessage.content).toContain('VS Code opened successfully');

      // Verify LLMGateway.generate was called ZERO times across the entire request!
      expect(spy).toHaveBeenCalledTimes(0);
      spy.mockRestore();
    });

    it('should call LLMGateway.generate() for normal non-deterministic commands', async () => {
      const spy = vi.spyOn(LLMGateway, 'generate');
      spy.mockClear();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'Compare TypeScript vs JavaScript' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      // Verify LLMGateway.generate WAS called for normal AI query
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      spy.mockRestore();
    });

    it('should successfully run the state machine through: planning -> retrieval -> responding -> done', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'Tell me about python preferences' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.assistantMessage.content).toBeDefined();
      expect(body.runId).toBeDefined();

      // Verify db logs show planning -> retrieval -> responding transitions
      const dbRes = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [body.runId]);
      expect(dbRes.rows[0].status).toBe('completed');
      
      const steps = dbRes.rows[0].steps;
      expect(steps[0].node).toBe('planning');
      expect(steps[1].node).toBe('retrieval');
      expect(steps[2].node).toBe('responding');
    });

    it('should successfully run through: planning -> execution -> responding -> done for tool calling triggers', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'What is the current time?' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.runId).toBeDefined();

      // Verify db logs show planning -> execution -> responding transitions
      const dbRes = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [body.runId]);
      expect(dbRes.rows[0].status).toBe('completed');
      
      const steps = dbRes.rows[0].steps;
      expect(steps[0].node).toBe('planning');
      expect(steps[1].node).toBe('execution');
      expect(steps[2].node).toBe('responding');
    });

    it('should fall back gracefully to error transitions when generation failures occur', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'fail_generation' }, // triggers simulated provider failure
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.assistantMessage.content).toContain('runtime error');

      // Verify db run was marked as failed
      const dbRes = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [body.runId]);
      expect(dbRes.rows[0].status).toBe('failed');
      
      const steps = dbRes.rows[0].steps;
      expect(steps.some((s: any) => s.node === 'error')).toBe(true);
    });
  });
});
