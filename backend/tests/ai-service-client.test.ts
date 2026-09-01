import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { AIServiceClient } from '../src/ai/ml-client/ai-service.client.js';
import {
  AIServiceUnavailableError,
  AIServiceTimeoutError,
  AIServiceValidationError,
  AIServiceExecutionError,
} from '../src/ai/ml-client/ai-service.types.js';
import { voiceRoutes } from '../src/api/routes/voice.js';
import { SessionService } from '../src/auth/services/session.service.js';

describe('GIA Phase 6: AIServiceClient & Voice Gateway Integration Suite', () => {
  let client: AIServiceClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new AIServiceClient('http://127.0.0.1:8001', 5000);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('AIServiceClient Unit Methods & Protocol', () => {
    it('transcribe() should successfully POST audio and parse structured transcription response', async () => {
      const mockResult = {
        text: 'Hello GIA this is a test',
        language: 'en',
        confidence: 0.98,
        duration: 2.5,
        segments: [
          { start: 0.0, end: 1.2, text: 'Hello GIA', confidence: 0.99 },
          { start: 1.2, end: 2.5, text: 'this is a test', confidence: 0.97 },
        ],
        processing_time: 0.15,
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockResult,
      } as Response);

      const audio = Buffer.from('FAKE_PCM_AUDIO_DATA');
      const res = await client.transcribe(audio, 'speech.wav', 'en', {
        requestId: 'req-123',
        correlationId: 'corr-456',
      });

      expect(res).toEqual(mockResult);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const [url, init] = (global.fetch as any).mock.calls[0];
      expect(url).toBe('http://127.0.0.1:8001/v1/stt/transcribe');
      expect(init.method).toBe('POST');
      expect(init.headers['x-request-id']).toBe('req-123');
      expect(init.headers['x-correlation-id']).toBe('corr-456');
    });

    it('transcribe() should throw AIServiceValidationError when provided empty audio buffer', async () => {
      await expect(client.transcribe(Buffer.alloc(0))).rejects.toThrow(AIServiceValidationError);
    });

    it('health() and readiness() should return status objects', async () => {
      const mockHealth = {
        status: 'healthy',
        version: '1.0.0',
        service_name: 'GIA AI Service',
        timestamp: '2026-09-01T12:00:00Z',
        subsystems: { stt: true, tts: false, audio_processor: true, vad: true },
      };

      const mockReadiness = {
        state: 'READY',
        model_name: 'tiny',
        device: 'cpu',
        compute_type: 'int8',
        is_ready: true,
        error: null,
      };

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/health')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => mockHealth,
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => mockReadiness,
        });
      });

      const healthRes = await client.health();
      const readyRes = await client.readiness();

      expect(healthRes).toEqual(mockHealth);
      expect(readyRes).toEqual(mockReadiness);
    });

    it('should translate 503 HTTP status to AIServiceUnavailableError', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'STT model is not ready (State: UNINITIALIZED)' }),
      } as Response);

      await expect(client.transcribe(Buffer.from('test'))).rejects.toThrow(AIServiceUnavailableError);
    });

    it('should translate 504 HTTP status to AIServiceTimeoutError', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 504,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'Transcription timed out' }),
      } as Response);

      await expect(client.transcribe(Buffer.from('test'))).rejects.toThrow(AIServiceTimeoutError);
    });

    it('should translate 422 HTTP status to AIServiceValidationError', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ detail: 'Corrupt audio header' }),
      } as Response);

      await expect(client.transcribe(Buffer.from('test'))).rejects.toThrow(AIServiceValidationError);
    });

    it('should handle fetch connection refusal as AIServiceUnavailableError', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8001'));

      await expect(client.transcribe(Buffer.from('test'))).rejects.toThrow(AIServiceUnavailableError);
    });

    it('should safely retry idempotent health() calls on transient 503 errors', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ detail: 'Starting up' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ status: 'healthy', subsystems: { stt: true } }),
        });
      });

      const res = await client.health({ retries: 2 });
      expect(res.status).toBe('healthy');
      expect(callCount).toBe(2);
    });
  });

  describe('Fastify Voice Gateway Endpoints (/api/v1/voice/*)', () => {
    let app: any;

    beforeEach(async () => {
      app = Fastify();
      await app.register(fastifyMultipart);
      await app.register(voiceRoutes, { prefix: '/api/v1' });

      // Mock session auth lookup
      vi.spyOn(SessionService, 'lookupSession').mockImplementation(async (sessionId: string) => {
        if (sessionId === 'valid-session-id') {
          return {
            id: 'valid-session-id',
            userId: 'user-123',
            email: 'user@example.com',
            name: 'Test User',
          } as any;
        }
        return null;
      });
    });

    it('POST /api/v1/voice/transcribe should reject unauthenticated requests with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/voice/transcribe',
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET /api/v1/voice/health should return AI service and STT status', async () => {
      const mockHealth = { status: 'healthy', version: '1.0.0', service_name: 'AI', timestamp: 'now', subsystems: { stt: true } };
      const mockReadiness = { state: 'READY', model_name: 'tiny', device: 'cpu', compute_type: 'int8', is_ready: true, error: null };

      vi.spyOn(client, 'health').mockResolvedValue(mockHealth as any);
      vi.spyOn(client, 'readiness').mockResolvedValue(mockReadiness as any);

      // Replace global client instance for route testing if needed or test endpoint directly
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/health')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => mockHealth,
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => mockReadiness,
        });
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/voice/health',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.ready).toBe(true);
    });
  });
});
