import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { z } from 'zod';
import { toolRoutes } from '../src/api/routes/tools.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { registry } from '../src/ai/tools/registry.js';
import { Agent } from '../src/ai/orchestrator/agent.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA Tool execution Integration Tests', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: 'test_jwt_secret_key_1234567890',
    });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'tools_test@gia.ai', password: 'secure_password_123', name: 'Tools Tester' },
    });
    const body = JSON.parse(signupRes.body);
    userToken = body.token;
    userId = body.user.id;
  });

  afterAll(async () => {
    setTestProvider(null);
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('Direct Tool Executions', () => {
    it('should successfully execute a valid read-only tool', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tools/execute',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          toolName: 'get_current_time',
          arguments: {},
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.result.currentTime).toBeDefined();

      // Check database logs
      const dbRes = await query('SELECT status, error FROM tool_calls WHERE tool_name = $1', ['get_current_time']);
      expect(dbRes.rows.length).toBeGreaterThan(0);
      expect(dbRes.rows[0].status).toBe('success');
    });

    it('should fail validation when passing invalid arguments', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tools/execute',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          toolName: 'search_memories',
          arguments: { query: '' }, // empty search query should trigger validation failure
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toBe('Validation failed');
    });

    it('should return 404 on unknown tools', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tools/execute',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          toolName: 'non_existent_tool_name',
          arguments: {},
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should abort and log execution errors when a tool times out', async () => {
      // Register custom timeout test tool
      registry.register({
        name: 'timeout_test_tool',
        description: 'Testing timeout bounds',
        inputSchema: z.object({}),
        permissions: [],
        riskLevel: 'low',
        timeoutMs: 100, // short timeout
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { done: true };
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tools/execute',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          toolName: 'timeout_test_tool',
          arguments: {},
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('timed out');
    });
  });

  describe('Agent multi-turn tool calling loops', () => {
    it('should parse tool calls, execute them, and yield final response from LLM', async () => {
      class ToolCallingMockProvider extends MockProvider {
        public callCount = 0;
        override async generate(request: any): Promise<any> {
          this.callCount++;
          if (this.callCount === 1) {
            return {
              content: JSON.stringify({
                tool_call: { name: 'get_current_time', arguments: {} },
              }),
              model: 'mock-model',
              provider: 'mock',
            };
          }
          return {
            content: 'The current time is 2026-08-29T12:00:00Z',
            model: 'mock-model',
            provider: 'mock',
          };
        }
      }

      const mockLLM = new ToolCallingMockProvider();
      setTestProvider(mockLLM);

      // Create conversation
      const convoSql = `
        INSERT INTO conversations (user_id, title)
        VALUES ($1, $2)
        RETURNING id
      `;
      const convoRes = await query<{ id: string }>(convoSql, [userId, 'Agent Loop Chat']);
      const convoId = convoRes.rows[0].id;

      const result = await Agent.runAgentLoop(userId, convoId, 'What time is it?');
      expect(result.assistantMessage.content).toBe('The current time is 2026-08-29T12:00:00Z');
      expect(mockLLM.callCount).toBe(2);
    });
  });
});
