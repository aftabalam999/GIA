import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { UserRepository } from '../src/database/repositories/user.repository.js';
import { MessageRepository } from '../src/database/repositories/message.repository.js';

describe('GIA Conversation Engine Integration Tests', () => {
  const app = Fastify();
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: 'test_jwt_secret_key_1234567890',
    });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User A
    const signupARes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'user_a@gia.ai', password: 'secure_password_a', name: 'User A' },
    });
    const bodyA = JSON.parse(signupARes.body);
    userAToken = bodyA.token;
    userAId = bodyA.user.id;

    // Create User B
    const signupBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'user_b@gia.ai', password: 'secure_password_b', name: 'User B' },
    });
    const bodyB = JSON.parse(signupBRes.body);
    userBToken = bodyB.token;
    userBId = bodyB.user.id;
  });

  afterAll(async () => {
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('Conversations CRUD & Isolation', () => {
    let convoAId: string;

    it('should allow User A to create a conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { title: 'First Conversation A' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.conversation.title).toBe('First Conversation A');
      expect(body.conversation.user_id).toBe(userAId);
      convoAId = body.conversation.id;
    });

    it('should list conversations only belonging to the authenticated user', async () => {
      // User A list should show 1 conversation
      const resA = await app.inject({
        method: 'GET',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userAToken}` },
      });
      expect(resA.statusCode).toBe(200);
      const bodyA = JSON.parse(resA.body);
      expect(bodyA.conversations.length).toBe(1);
      expect(bodyA.conversations[0].id).toBe(convoAId);

      // User B list should show 0 conversations
      const resB = await app.inject({
        method: 'GET',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userBToken}` },
      });
      expect(resB.statusCode).toBe(200);
      const bodyB = JSON.parse(resB.body);
      expect(bodyB.conversations.length).toBe(0);
    });

    it('should prevent User B from reading User As conversation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${convoAId}/messages`,
        headers: { authorization: `Bearer ${userBToken}` },
      });

      // Verification of User isolation blocks another user's access
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Access denied');
    });
  });

  describe('Message Flow & LLM Service', () => {
    let convoId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { title: 'Message Testing Convo' },
      });
      convoId = JSON.parse(res.body).conversation.id;
    });

    it('should send user message, invoke MockProvider, save assistant response and return history', async () => {
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Hello GIA, tell me about your stack' },
      });

      expect(sendRes.statusCode).toBe(200);
      const body = JSON.parse(sendRes.body);
      expect(body.success).toBe(true);
      expect(body.userMessage.content).toBe('Hello GIA, tell me about your stack');
      expect(body.userMessage.role).toBe('user');
      expect(body.assistantMessage.content).toContain('You said: "Hello GIA, tell me about your stack"');
      expect(body.assistantMessage.role).toBe('assistant');

      // Verify persistence by loading history
      const historyRes = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${convoId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
      });
      const history = JSON.parse(historyRes.body).messages;
      expect(history.length).toBe(2);
      expect(history[0].id).toBe(body.userMessage.id);
      expect(history[1].id).toBe(body.assistantMessage.id);
    });

    it('should handle LLM generation failures gracefully and prevent saving corrupted assistant records', async () => {
      // Prompt content 'fail_generation' triggers simulated failure in MockProvider
      const sendRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'fail_generation' },
      });

      expect(sendRes.statusCode).toBe(500);
      const body = JSON.parse(sendRes.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('LLM execution failed');

      // Verify that no assistant message was saved to the database on failure
      const history = await MessageRepository.findByConversationId(convoId);
      // Previous test saved 2 messages. If failure was handled correctly, there should be exactly 3 messages (2 old + 1 user 'fail_generation')
      expect(history.length).toBe(3);
      expect(history[history.length - 1].content).toBe('fail_generation');
      expect(history[history.length - 1].role).toBe('user');
    });
  });
});
