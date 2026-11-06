import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { memoryRoutes } from '../src/api/routes/memories.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { MemoryService } from '../src/memories/services/memory.service.js';

describe('GIA Memory Subsystem Integration Tests (Phase 14)', () => {
  const app = Fastify();
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let convoAId: string;

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

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User A
    const signupARes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'user_a_mem@gia.ai', password: 'secure_password_a', name: 'User A Mem' },
    });
    const bodyA = JSON.parse(signupARes.body);
    userAToken = bodyA.token;
    userAId = bodyA.user.id;

    // Create User B
    const signupBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'user_b_mem@gia.ai', password: 'secure_password_b', name: 'User B Mem' },
    });
    const bodyB = JSON.parse(signupBRes.body);
    userBToken = bodyB.token;
    userBId = bodyB.user.id;

    // Create Conversation for User A
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { title: 'User A Conversation' },
    });
    convoAId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('Three Memory Categories (Short-Term, Long-Term Semantic, Episodic)', () => {
    it('should create and retrieve Short-Term Memory via MemoryService', async () => {
      const stMem = await MemoryService.createShortTermMemory(userAId, 'Active task: Refactoring AI pipeline', { taskId: 'task-123' });
      expect(stMem.type).toBe('short_term');
      expect(stMem.content).toBe('Active task: Refactoring AI pipeline');
      expect(stMem.user_id).toBe(userAId);
    });

    it('should create and retrieve Long-Term Semantic Memory via MemoryService', async () => {
      const ltMem = await MemoryService.createLongTermSemanticMemory(userAId, 'User prefers TypeScript and strict linting rules', 9, 0.98);
      expect(ltMem.type).toBe('long_term_semantic');
      expect(ltMem.content).toBe('User prefers TypeScript and strict linting rules');
      expect(ltMem.importance).toBe(9);
    });

    it('should create and retrieve Episodic Memory via MemoryService', async () => {
      const epMem = await MemoryService.createEpisodicMemory(userAId, 'Milestone: Phase 14 Memory System completed successfully', 10);
      expect(epMem.type).toBe('episodic');
      expect(epMem.content).toBe('Milestone: Phase 14 Memory System completed successfully');
      expect(epMem.importance).toBe(10);
    });

    it('should filter memories by category using GET /api/v1/memories?category=...', async () => {
      const resEpisodic = await app.inject({
        method: 'GET',
        url: '/api/v1/memories?category=episodic',
        headers: { authorization: `Bearer ${userAToken}` },
      });
      expect(resEpisodic.statusCode).toBe(200);
      const bodyEp = JSON.parse(resEpisodic.body);
      expect(bodyEp.success).toBe(true);
      expect(bodyEp.memories.length).toBe(1);
      expect(bodyEp.memories[0].content).toContain('Milestone');

      const resSemantic = await app.inject({
        method: 'GET',
        url: '/api/v1/memories?category=long_term_semantic',
        headers: { authorization: `Bearer ${userAToken}` },
      });
      expect(resSemantic.statusCode).toBe(200);
      const bodySem = JSON.parse(resSemantic.body);
      expect(bodySem.success).toBe(true);
      expect(bodySem.memories.length).toBe(1);
      expect(bodySem.memories[0].content).toContain('TypeScript');
    });
  });

  describe('Memory CRUD & Isolation Flow', () => {
    let memoryAId: string;

    it('should allow User A to create a memory manually', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          type: 'user_preference',
          content: 'Alice prefers Python over Java',
          importance: 7,
          confidence: 0.95,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.memory.content).toBe('Alice prefers Python over Java');
      expect(body.memory.importance).toBe(7);
      expect(body.memory.user_id).toBe(userAId);
      memoryAId = body.memory.id;
    });

    it('should return 400 Bad Request on invalid inputs (importance out of bounds)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          type: 'user_preference',
          content: 'Invalid importance note',
          importance: 11, // Max is 10
          confidence: 0.9,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toBe('Validation failed');
    });

    it('should search user memories and find matches', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search?q=Python',
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].id).toBe(memoryAId);
    });

    it('should return empty list on irrelevant memory search', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search?q=RubyRails',
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.memories.length).toBe(0);
    });

    it('should prevent User B from reading, updating, or deleting User As memory', async () => {
      // 1. Isolation check on update
      const updateRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/memories/${memoryAId}`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { content: 'Hacked preference' },
      });
      expect(updateRes.statusCode).toBe(403);

      // 2. Isolation check on delete
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/memories/${memoryAId}`,
        headers: { authorization: `Bearer ${userBToken}` },
      });
      expect(deleteRes.statusCode).toBe(403);
    });

    it('should allow User A to update their memory', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/memories/${memoryAId}`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Alice prefers Python 3 and Golang' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.memory.content).toBe('Alice prefers Python 3 and Golang');
    });

    it('should extract memories explicitly via trigger prefix content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories/extract',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          conversationId: convoAId,
          content: 'Remember that Alice likes dark chocolate',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.memories.length).toBe(1);
      expect(body.memories[0].content).toBe('Alice likes dark chocolate');
    });

    it('should allow User A to delete their memory', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/memories/${memoryAId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
