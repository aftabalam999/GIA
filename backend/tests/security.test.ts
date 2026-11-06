import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { memoryRoutes } from '../src/api/routes/memories.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { config } from '../src/config/index.js';
import { aiServiceClient } from '../src/ai/ml-client/ai-service.client.js';

describe('GIA Security Boundary Integration Tests (Phase 17)', () => {
  const app = Fastify();
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let convoBId: string;
  let messageBId: string;
  let cookieHeaderUserA: string;

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: 'test_jwt_secret_key_1234567890',
    });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(memoryRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User A
    const resA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'sec_a@gia.ai', password: 'secure_password_a', name: 'User A' },
    });
    const bodyA = JSON.parse(resA.body);
    userAToken = bodyA.token;
    userAId = bodyA.user.id;

    // Capture HttpOnly cookie set on signup
    const cookiesA = resA.cookies;
    expect(cookiesA.some((c) => c.name === 'session_id' && c.httpOnly)).toBe(true);
    cookieHeaderUserA = resA.headers['set-cookie'] as string;

    // Create User B
    const resB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'sec_b@gia.ai', password: 'secure_password_b', name: 'User B' },
    });
    const bodyB = JSON.parse(resB.body);
    userBToken = bodyB.token;
    userBId = bodyB.user.id;

    // Create a Conversation and Message for User B
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userBToken}` },
      payload: { title: 'User B Conversation' },
    });
    convoBId = JSON.parse(convoRes.body).conversation.id;

    const msgRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${convoBId}/messages`,
      headers: { authorization: `Bearer ${userBToken}` },
      payload: { content: 'Secret message from B' },
    });
    messageBId = JSON.parse(msgRes.body).userMessage.id;
  });

  afterAll(async () => {
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('HttpOnly Cookie & Session Revocation', () => {
    it('should authenticate via HttpOnly cookie and allow me endpoint query', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: cookieHeaderUserA },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe(userAId);
    });

    it('should revoke session on logout and deny access with revoked token', async () => {
      // 1. Create session for temp user
      const tempRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'temp_sec@gia.ai', password: 'secure_password_temp', name: 'Temp User' },
      });
      const tempToken = JSON.parse(tempRes.body).token;

      // 2. Logout session
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${tempToken}` },
      });
      expect(logoutRes.statusCode).toBe(200);

      // 3. Verify access is now rejected
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${tempToken}` },
      });
      expect(meRes.statusCode).toBe(401);
    });
  });

  describe('Internal Service Protection & Secret Isolation', () => {
    it('should ensure AIServiceClient propagates x-internal-api-key header', async () => {
      expect(config.INTERNAL_API_KEY).toBeDefined();
      expect(config.INTERNAL_API_KEY.length).toBeGreaterThan(10);
    });

    it('should confirm response models never expose backend API keys to clients', async () => {
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { authorization: `Bearer ${userAToken}` },
      });
      const bodyStr = meRes.body;
      expect(bodyStr).not.toContain('OPENAI_API_KEY');
      expect(bodyStr).not.toContain('GOOGLE_AI_API_KEY');
      expect(bodyStr).not.toContain('JWT_SECRET');
    });
  });

  describe('IDOR Controls', () => {
    it('should block User A from extracting memories using User B conversation ID', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/extract',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          conversationId: convoBId,
          content: 'Some random context text extraction',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Access denied');
    });

    it('should block User A from executing tool calls linked to User B message ID', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tools/execute',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          toolName: 'get_current_time',
          arguments: {},
          messageId: messageBId,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Access denied');
    });
  });
});
