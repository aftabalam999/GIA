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
    it('should return 200 ready when database, redis, and Python AI service models are healthy & ready', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.pythonAiHealthy = true;
      healthTestOverrides.pythonAiReady = true;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/ready',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
      expect(body.python_ai_service.ready).toBe(true);
    });

    it('should return 503 unhealthy when database connection fails', async () => {
      healthTestOverrides.databaseHealthy = false;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.pythonAiHealthy = true;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/ready',
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.database).toBe('unhealthy');
    });

    it('should return 503 unhealthy when Python AI service is unreachable or unready', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.pythonAiHealthy = false;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/ready',
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.python_ai_service).toBe('unhealthy');
    });
  });

  describe('Deep Dependency Probe (/health & /health/dependencies)', () => {
    it('should return 200 healthy with detailed services statuses and latencies when all are online', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.pythonAiHealthy = true;
      healthTestOverrides.pythonAiReady = true;
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
      expect(body.dependencies.python_ai_service).toBe('healthy');
      expect(body.dependencies.llm).toBe('healthy');
      expect(body.dependencies.embeddings).toBe('healthy');
      expect(body.python_ai_service.subsystems.stt).toBe(true);
      expect(body.python_ai_service.subsystems.tts).toBe(true);
    });

    it('should return 200 degraded when Python service is UP but STT or TTS model is not ready', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.pythonAiHealthy = true;
      healthTestOverrides.pythonAiReady = false; // Python UP, but model loading failed/unready!

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      expect(res.statusCode).toBe(200); // 200 response with degraded status report
      const body = JSON.parse(res.body);
      expect(body.status).toBe('degraded');
      expect(body.dependencies.python_ai_service).toBe('degraded');
      expect(body.python_ai_service.healthy).toBe(true);
      expect(body.python_ai_service.ready).toBe(false);
    });

    it('should return 503 unhealthy when Python AI service is completely unreachable', async () => {
      healthTestOverrides.databaseHealthy = true;
      healthTestOverrides.redisHealthy = true;
      healthTestOverrides.pythonAiHealthy = false;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/health/dependencies',
      });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('unhealthy');
      expect(body.dependencies.python_ai_service).toBe('unhealthy');
    });
  });
});
