import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from '../src/api/routes/health.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool } from '../src/database/client.js';
import { HealthService, healthTestOverrides } from '../src/shared/health.service.js';

describe('GIA Backend Health & Dependency Check Integration Suite', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(healthRoutes, { prefix: '/api/v1' });
    await initializeDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    HealthService.resetOverrides();
  });

  describe('Liveness Probe (/health/live)', () => {
    it('should return 200 healthy indicating process liveness', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/live',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('Readiness Probe (/health/ready)', () => {
    it('should return 200 ready when core database and redis are healthy', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/ready',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
    });

    it('should return 503 unhealthy when database connection fails', async () => {
      healthTestOverrides.databaseHealthy = false;
      healthTestOverrides.redisHealthy = true;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/ready',
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.database).toBe('unhealthy');
    });

    it('should return 503 unhealthy when Redis connection fails', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = false;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/ready',
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.redis).toBe('unhealthy');
    });
  });

  describe('Deep Dependency Probe (/health & /health/dependencies)', () => {
    it('should return 200 healthy with detailed services statuses and latencies when all are online', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.llmHealthy = true;
      healthTestOverrides.embeddingsHealthy = true;
      healthTestOverrides.databaseLatency = 12;
      healthTestOverrides.redisLatency = 5;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/dependencies',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
      expect(body.dependencies.database).toBe('healthy');
      expect(body.dependencies.redis).toBe('healthy');
      expect(body.dependencies.llm).toBe('healthy');
      expect(body.dependencies.embeddings).toBe('healthy');
      expect(body.latency.database).toBe(12);
      expect(body.latency.redis).toBe(5);
    });

    it('should return 200 degraded when only external services fail (e.g. LLM / Embeddings API down)', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.llmHealthy = false;
      healthTestOverrides.embeddingsHealthy = true;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      expect(res.statusCode).toBe(200); // 200 but degraded status
      const body = JSON.parse(res.body);
      expect(body.status).toBe('degraded');
      expect(body.dependencies.database).toBe('healthy');
      expect(body.dependencies.redis).toBe('healthy');
      expect(body.dependencies.llm).toBe('unhealthy');
      expect(body.dependencies.embeddings).toBe('healthy');
    });

    it('should return 503 unhealthy when both external services and core database fail', async () => {
      healthTestOverrides.databaseHealthy = false;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.llmHealthy = false;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/dependencies',
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unhealthy');
    });
  });
});
