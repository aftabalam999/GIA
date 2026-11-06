import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { memoryRoutes } from '../src/api/routes/memories.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { getEmbeddingProvider, setTestEmbeddingProvider } from '../src/ai/embeddings/router.js';
import { MockEmbeddingProvider } from '../src/ai/embeddings/mock.embeddings.js';

describe('GIA Semantic Memory Integration Tests', () => {
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
    await app.register(memoryRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User A
    const signupARes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'semantic_a@gia.ai', password: 'secure_password_a', name: 'User A' },
    });
    const bodyA = JSON.parse(signupARes.body);
    userAToken = bodyA.token;
    userAId = bodyA.user.id;

    // Create User B
    const signupBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'semantic_b@gia.ai', password: 'secure_password_b', name: 'User B' },
    });
    const bodyB = JSON.parse(signupBRes.body);
    userBToken = bodyB.token;
    userBId = bodyB.user.id;
  });

  afterAll(async () => {
    setTestEmbeddingProvider(null);
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('Semantic Memory Search Flow', () => {
    it('should create a memory, generate its embedding, and save it in pgvector', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          type: 'user_preference',
          content: 'Alice loves Python coding',
          importance: 8,
          confidence: 0.99,
        },
      });

      expect(res.statusCode).toBe(201);
      const memoryId = JSON.parse(res.body).memory.id;

      // Verify in db that embedding vector exists and is not null
      const dbRes = await query('SELECT embedding FROM memories WHERE id = $1', [memoryId]);
      expect(dbRes.rows[0].embedding).not.toBeNull();
    });

    it('should retrieve memories semantically based on cosine similarity ranking', async () => {
      // 1. Insert a chocolate preference
      await app.inject({
        method: 'POST',
        url: '/api/v1/memories',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          type: 'explicit_note',
          content: 'Keep a stash of dark chocolate bars',
          importance: 6,
          confidence: 0.95,
        },
      });

      // 2. Search semantically for 'programming'
      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search?q=programming&semantic=true&threshold=0.4',
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(searchRes.statusCode).toBe(200);
      const body = JSON.parse(searchRes.body);
      expect(body.success).toBe(true);
      expect(body.memories.length).toBe(1);
      // 'Alice loves Python coding' should be matched due to semantic zone 'programming'
      expect(body.memories[0].content).toBe('Alice loves Python coding');
      expect(body.memories[0].score).toBeGreaterThan(0.7);
    });

    it('should respect similarity score thresholds and filter out low-relevance results', async () => {
      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search?q=java&semantic=true&threshold=0.8', // overlap similarity is 0.707
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(searchRes.statusCode).toBe(200);
      const body = JSON.parse(searchRes.body);
      expect(body.success).toBe(true);
      expect(body.memories.length).toBe(0); // similarity is 0.707, so filtered out under threshold 0.8
    });

    it('should enforce user isolation and keep vector searches private per user', async () => {
      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search?q=programming&semantic=true&threshold=0.4',
        headers: { authorization: `Bearer ${userBToken}` }, // User B queries
      });

      expect(searchRes.statusCode).toBe(200);
      const body = JSON.parse(searchRes.body);
      expect(body.success).toBe(true);
      // User B should get 0 results because memories belong to User A
      expect(body.memories.length).toBe(0);
    });

    it('should handle embedding provider failures gracefully on search requests', async () => {
      const mockProvider = new MockEmbeddingProvider();
      mockProvider.setShouldFail(true);
      setTestEmbeddingProvider(mockProvider);

      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/v1/memories/search?q=programming&semantic=true',
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(searchRes.statusCode).toBe(500);
      const body = JSON.parse(searchRes.body);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('failure');
    });
  });
});
