import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { documentRoutes } from '../src/api/routes/documents.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { setTestEmbeddingProvider } from '../src/ai/embeddings/router.js';
import { MockEmbeddingProvider } from '../src/ai/embeddings/mock.embeddings.js';

describe('GIA RAG Pipeline Integration Tests', () => {
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
    await app.register(documentRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    // Create User A
    const signupARes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'rag_a@gia.ai', password: 'secure_password_a', name: 'User A' },
    });
    const bodyA = JSON.parse(signupARes.body);
    userAToken = bodyA.token;
    userAId = bodyA.user.id;

    // Create User B
    const signupBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'rag_b@gia.ai', password: 'secure_password_b', name: 'User B' },
    });
    const bodyB = JSON.parse(signupBRes.body);
    userBToken = bodyB.token;
    userBId = bodyB.user.id;

    // Create a Conversation for User A
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { title: 'RAG Conversation' },
    });
    convoAId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    setTestEmbeddingProvider(null);
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('Document Ingestion & Chunking', () => {
    it('should ingest a document and split it into vector-embedded chunks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          title: 'Python Framework Guide',
          content: 'GIA uses Python coding for some services. Python is highly modular.',
          sourceType: 'guide_doc',
          sourceUrl: 'https://docs.gia.ai/python',
        },
      });

      if (res.statusCode !== 201) {
        console.error('Document Ingestion Failed:', res.body);
      }
      expect(res.statusCode).toBe(201);
      const doc = JSON.parse(res.body).document;
      expect(doc.name).toBe('Python Framework Guide');

      // Verify chunks were created and embeddings calculated
      const chunksRes = await query('SELECT id, content, embedding FROM document_chunks WHERE document_id = $1', [doc.id]);
      expect(chunksRes.rows.length).toBeGreaterThan(0);
      expect(chunksRes.rows[0].embedding).not.toBeNull();
    });
  });

  describe('RAG Context Retrieval and Generation', () => {
    it('should retrieve chunks semantically and return answer with citations', async () => {
      // Send RAG message containing word 'python' (which matches the guide vector)
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages/rag`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Tell me about python services' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.assistantMessage.content).toBeDefined();
      expect(body.sources.length).toBe(1);
      expect(body.sources[0].title).toBe('Python Framework Guide');
    });

    it('should ignore irrelevant documents below relevance score thresholds', async () => {
      // Query about 'chocolate' which doesn't match python document vector
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages/rag`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Quantum computing details' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.sources.length).toBe(0); // low similarity should return empty sources list
    });

    it('should enforce user isolation and keep document collections private per user', async () => {
      // User B creates a conversation
      const convoBRes = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { title: 'RAG Convo B' },
      });
      const convoBId = JSON.parse(convoBRes.body).conversation.id;

      // User B queries about 'python'
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoBId}/messages/rag`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { content: 'Tell me about python services' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.sources.length).toBe(0); // User B cannot fetch User A's uploaded documents!
    });

    it('should recover gracefully and answer using general LLM knowledge if retrieval step fails', async () => {
      // Force embedding provider to fail
      const failingEmbed = new MockEmbeddingProvider();
      failingEmbed.setShouldFail(true);
      setTestEmbeddingProvider(failingEmbed);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoAId}/messages/rag`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { content: 'Tell me about python services' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true); // Call should succeed
      expect(body.sources.length).toBe(0); // general recovery fallback means empty sources
      expect(body.assistantMessage.content).toContain('Mock Response');
    });
  });
});
