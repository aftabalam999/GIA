import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { normalizeUserInput, NormalizedUserInput } from '../src/ai/orchestrator/input.model.js';
import { AgentOrchestrator } from '../src/ai/orchestrator/orchestrator.js';
import { voiceRoutes } from '../src/api/routes/voice.js';
import { agentRoutes } from '../src/api/routes/agent.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { aiServiceClient } from '../src/ai/ml-client/ai-service.client.js';
import { MessageRepository } from '../src/database/repositories/message.repository.js';

describe('GIA Phase 7: STT + AI Orchestrator Integration Suite', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
  let convoId: string;

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_phase7_12345' });

    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(agentRoutes, { prefix: '/api/v1' });
    await app.register(voiceRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query('DELETE FROM users');

    const signupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'voice_orchestrator@gia.ai', password: 'secure_password_123', name: 'Voice Orchestrator Tester' },
    });
    const body = JSON.parse(signupRes.body);
    userToken = body.token;
    userId = body.user.id;

    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Voice & Text Unified Chat' },
    });
    convoId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    await query('DELETE FROM users');
    await pool.end();
  });

  describe('Normalized User Input Model Unit Tests', () => {
    it('normalizeUserInput() should normalize text input string properly', () => {
      const normalized = normalizeUserInput('Open my project.', userId, convoId, { inputType: 'text' });
      expect(normalized.inputType).toBe('text');
      expect(normalized.content).toBe('Open my project.');
      expect(normalized.userId).toBe(userId);
      expect(normalized.conversationId).toBe(convoId);
      expect(normalized.requestId).toBeDefined();
      expect(normalized.timestamp).toBeDefined();
    });

    it('normalizeUserInput() should normalize voice input and attach voice metadata', () => {
      const voiceInput: Partial<NormalizedUserInput> = {
        inputType: 'voice',
        content: '  Open my project.  ',
        metadata: {
          voice: {
            duration: 1.8,
            confidence: 0.96,
            language: 'en',
            processingTime: 0.12,
          },
        },
      };

      const normalized = normalizeUserInput(voiceInput, userId, convoId);
      expect(normalized.inputType).toBe('voice');
      expect(normalized.content).toBe('Open my project.');
      expect(normalized.metadata?.voice?.duration).toBe(1.8);
      expect(normalized.metadata?.voice?.confidence).toBe(0.96);
    });
  });

  describe('Orchestration Convergence (Text vs Voice Inputs)', () => {
    it('text input should continue working through FSM orchestrator', async () => {
      const result = await AgentOrchestrator.run(userId, convoId, 'What is the current time?');
      expect(result.userMessage).toBeDefined();
      expect(result.assistantMessage).toBeDefined();
      expect(result.runId).toBeDefined();

      const userMsgMeta = result.userMessage.metadata as any;
      expect(userMsgMeta.inputType).toBe('text');

      const dbRun = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [result.runId]);
      expect(dbRun.rows[0].status).toBe('completed');
    });

    it('voice input transcript should reach orchestrator and run through identical FSM steps', async () => {
      const normalizedVoiceInput: NormalizedUserInput = {
        inputType: 'voice',
        content: 'Tell me about python preferences',
        userId,
        conversationId: convoId,
        requestId: 'voice-req-001',
        timestamp: new Date().toISOString(),
        metadata: {
          voice: {
            duration: 2.5,
            confidence: 0.97,
            language: 'en',
            processingTime: 0.14,
          },
        },
      };

      const result = await AgentOrchestrator.run(userId, convoId, normalizedVoiceInput);
      expect(result.userMessage.content).toBe('Tell me about python preferences');
      expect(result.assistantMessage.content).toBeDefined();

      // Verify metadata preserved in message
      const msgInDb = await MessageRepository.findByConversationId(convoId);
      const voiceMsg = msgInDb.find((m) => m.id === result.userMessage.id);
      expect(voiceMsg).toBeDefined();
      expect((voiceMsg?.metadata as any).inputType).toBe('voice');
      expect((voiceMsg?.metadata as any).voice.duration).toBe(2.5);

      // Verify DB run step history is identical (planning -> retrieval -> responding)
      const dbRun = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [result.runId]);
      expect(dbRun.rows[0].status).toBe('completed');
      const steps = dbRun.rows[0].steps;
      expect(steps[0].node).toBe('planning');
      expect(steps[1].node).toBe('retrieval');
      expect(steps[2].node).toBe('responding');
    });
  });

  describe('End-to-End Fastify Voice Orchestration Endpoint', () => {
    it('POST /api/v1/conversations/:id/messages/voice should process audio, transcribe, and run orchestrator', async () => {
      const mockTranscription = {
        text: 'What is the current time?',
        language: 'en',
        confidence: 0.98,
        duration: 1.5,
        segments: [{ start: 0, end: 1.5, text: 'What is the current time?', confidence: 0.98 }],
        processing_time: 0.1,
      };

      vi.spyOn(aiServiceClient, 'transcribe').mockResolvedValue(mockTranscription);

      // Construct multipart form payload using boundary string
      const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
      const payloadParts = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="test.wav"',
        'Content-Type: audio/wav',
        '',
        'RIFF....WAVEfmt ....data....',
        `--${boundary}--`,
        '',
      ].join('\r\n');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/voice`,
        headers: {
          authorization: `Bearer ${userToken}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: payloadParts,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.transcription.text).toBe('What is the current time?');
      expect(body.userMessage.content).toBe('What is the current time?');
      expect(body.assistantMessage.content).toBeDefined();
      expect(body.runId).toBeDefined();

      // Verify conversation history stored the message
      const history = await MessageRepository.findByConversationId(convoId);
      const lastUserMsg = history.filter((m) => m.role === 'user').pop();
      expect(lastUserMsg?.content).toBe('What is the current time?');
      expect((lastUserMsg?.metadata as any).inputType).toBe('voice');
    });
  });
});
