import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { memoryRoutes } from '../src/api/routes/memories.js';
import { documentRoutes } from '../src/api/routes/documents.js';
import { toolRoutes } from '../src/api/routes/tools.js';
import { agentRoutes } from '../src/api/routes/agent.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';

describe('GIA End-to-End System & Security Test Suite', () => {
  const app = Fastify();
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let convoAId: string;
  let docAId: string;

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: 'test_jwt_secret_key_1234567890',
    });
    
    // Register all API routes
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(memoryRoutes, { prefix: '/api/v1' });
    await app.register(documentRoutes, { prefix: '/api/v1' });
    await app.register(toolRoutes, { prefix: '/api/v1' });
    await app.register(agentRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');
  });

  afterAll(async () => {
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('1. User Authentication Flow', () => {
    it('should register User A and User B successfully', async () => {
      const resA = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'e2e_a@gia.ai', password: 'secure_password_a', name: 'User A' },
      });
      expect(resA.statusCode).toBe(201);
      const bodyA = JSON.parse(resA.body);
      userAToken = bodyA.token;
      userAId = bodyA.user.id;

      const resB = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'e2e_b@gia.ai', password: 'secure_password_b', name: 'User B' },
      });
      expect(resB.statusCode).toBe(201);
      userBToken = JSON.parse(resB.body).token;
      userBId = JSON.parse(resB.body).user.id;
    });

    it('should log in User A successfully with correct credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'e2e_a@gia.ai', password: 'secure_password_a' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).token).toBeDefined();
    });

    it('should reject login for User A with incorrect password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'e2e_a@gia.ai', password: 'wrong_password' },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).success).toBe(false);
    });
  });

  describe('2. Conversation Dialogue Flow', () => {
    it('should allow User A to create a conversation and send a message', async () => {
      const convoRes = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { title: 'E2E Dialogue' },
      });
      expect(convoRes.statusCode).toBe(201);
      convoAId = JSON.parse(convoRes.body).conversation.id;

      const msgRes = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Hello GIA! Who are you?' },
      });
      expect(msgRes.statusCode).toBe(200);
      const body = JSON.parse(msgRes.body);
      expect(body.userMessage.content).toBe('Hello GIA! Who are you?');
      expect(body.assistantMessage.content).toBeDefined();
    });
  });

  describe('3. Memory Extraction & Semantic Search Flow', () => {
    it('should extract memories explicitly via trigger content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/extract',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          conversationId: convoAId,
          content: 'Remember that User A likes green tea',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memories[0].content).toContain('User A likes green tea');
    });

    it('should retrieve memories semantically', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search',
        headers: { authorization: `Bearer ${userAToken}` },
        query: { q: 'tea preferences', semantic: 'true' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memories.length).toBeGreaterThan(0);
      expect(body.memories[0].content).toContain('User A likes green tea');
    });
  });

  describe('4. RAG Document Indexing & Context Injection Flow', () => {
    it('should ingest and partition document content successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          title: 'GIA Systems Doc',
          content: 'GIA utilizes Node.js and Fastify framework to handle REST interfaces. TypeScript is the core language.',
          sourceType: 'user_doc',
        },
      });
      expect(res.statusCode).toBe(201);
      docAId = JSON.parse(res.body).document.id;
    });

    it('should execute RAG queries and return source citations', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages/rag`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'What framework does GIA use?' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assistantMessage).toBeDefined();
      expect(body.sources.length).toBeGreaterThan(0);
      expect(body.sources[0].title).toBe('GIA Systems Doc');
    });
  });

  describe('5. Agent Loop & Tool Calling Flow', () => {
    it('should transition through orchestrator nodes and execute low-risk tools', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages/agent`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Please tell me the time' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assistantMessage).toBeDefined();
      expect(body.runId).toBeDefined();
    });
  });

  describe('6. Adversarial Security Controls', () => {
    it('should prevent User B from reading or accessing User A conversations (IDOR check)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${convoAId}/messages`,
        headers: { authorization: `Bearer ${userBToken}` },
      });
      expect(res.statusCode).toBe(403); // Blocked - access denied to other user's resource
    });

    it('should prevent User B from extracting memories via User A conversation (IDOR check)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/extract',
        headers: { authorization: `Bearer ${userBToken}` },
        payload: {
          conversationId: convoAId,
          content: 'Remember that user B hacks tea preference',
        },
      });
      expect(res.statusCode).toBe(403); // Blocked - access denied to other user's resource
    });

    it('should return 400 Bad Request on malformed query payloads', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: '' }, // Should violate minimum length check
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).success).toBe(false);
    });
  });
});
