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

describe('GIA Security Boundary Integration Tests', () => {
  const app = Fastify();
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let convoBId: string;
  let messageBId: string;

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
