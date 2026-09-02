import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { aiServiceClient } from '../../ai/ml-client/ai-service.client.js';
import { AgentOrchestrator } from '../../ai/orchestrator/orchestrator.js';
import { NormalizedUserInput } from '../../ai/orchestrator/input.model.js';
import { WakeWordDetector } from '../../shared/wakeword.js';
import {
  AIServiceUnavailableError,
  AIServiceTimeoutError,
  AIServiceValidationError,
  AIServiceExecutionError,
} from '../../ai/ml-client/ai-service.types.js';

export async function voiceRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/v1/voice/transcribe
   * Authenticated Speech-to-Text transcription endpoint.
   * Receives multipart audio file payload, delegates to Python AI Service via AIServiceClient.
   */
  fastify.post(
    '/voice/transcribe',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const filePart = await request.file();
        if (!filePart) {
          return reply.status(400).send({
            success: false,
            error: {
              message: 'Missing audio payload file in request',
              statusCode: 400,
            },
          });
        }

        const buffer = await filePart.toBuffer();
        if (!buffer || buffer.length === 0) {
          return reply.status(400).send({
            success: false,
            error: {
              message: 'Audio payload file is empty (0 bytes)',
              statusCode: 400,
            },
          });
        }

        const fields = filePart.fields as Record<string, any>;
        const languageField = fields?.language?.value || (request.query as any)?.language;
        const language = typeof languageField === 'string' ? languageField : undefined;

        const requestId = request.id;
        const correlationId = (request.headers['x-correlation-id'] as string) || requestId;

        const result = await aiServiceClient.transcribe(buffer, filePart.filename || 'audio.wav', language, {
          requestId,
          correlationId,
        });

        return reply.status(200).send({
          success: true,
          data: result,
        });
      } catch (err: any) {
        if (err instanceof AIServiceUnavailableError) {
          return reply.status(503).send({
            success: false,
            error: {
              message: err.message,
              statusCode: 503,
              detail: err.detail,
            },
          });
        }
        if (err instanceof AIServiceTimeoutError) {
          return reply.status(504).send({
            success: false,
            error: {
              message: err.message,
              statusCode: 504,
              detail: err.detail,
            },
          });
        }
        if (err instanceof AIServiceValidationError) {
          return reply.status(err.statusCode || 422).send({
            success: false,
            error: {
              message: err.message,
              statusCode: err.statusCode || 422,
              detail: err.detail,
            },
          });
        }
        if (err instanceof AIServiceExecutionError) {
          return reply.status(500).send({
            success: false,
            error: {
              message: err.message,
              statusCode: 500,
              detail: err.detail,
            },
          });
        }

        request.log.error({ msg: 'Unexpected error in voice transcription route', err: err.message });
        return reply.status(500).send({
          success: false,
          error: {
            message: 'Voice transcription failed: ' + (err.message || 'Internal Error'),
            statusCode: 500,
          },
        });
      }
    }
  );

  /**
   * POST /api/v1/voice/chat and POST /api/v1/conversations/:id/messages/voice
   * Authenticated End-to-End Voice Orchestration:
   * Audio -> STT -> Transcript -> NormalizedUserInput -> AI Orchestrator -> FSM (Router, RAG, Tools, LLM) -> Response
   */
  const handleVoiceChatOrchestration = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePart = await request.file();
      if (!filePart) {
        return reply.status(400).send({
          success: false,
          error: {
            message: 'Missing audio file payload for voice orchestration',
            statusCode: 400,
          },
        });
      }

      const buffer = await filePart.toBuffer();
      if (!buffer || buffer.length === 0) {
        return reply.status(400).send({
          success: false,
          error: {
            message: 'Audio payload file is empty (0 bytes)',
            statusCode: 400,
          },
        });
      }

      const fields = filePart.fields as Record<string, any>;
      const conversationIdFromParams = (request.params as any)?.id;
      const conversationIdFromForm = fields?.conversationId?.value;
      const conversationId = conversationIdFromParams || conversationIdFromForm;

      if (!conversationId) {
        return reply.status(400).send({
          success: false,
          error: {
            message: 'Missing conversationId parameter or form field',
            statusCode: 400,
          },
        });
      }

      const languageField = fields?.language?.value || (request.query as any)?.language;
      const language = typeof languageField === 'string' ? languageField : undefined;

      const userId = request.user.id;
      const requestId = request.id;
      const correlationId = (request.headers['x-correlation-id'] as string) || requestId;

      // 1. Transcribe audio using Python STT Service Client
      const transcription = await aiServiceClient.transcribe(buffer, filePart.filename || 'audio.wav', language, {
        requestId,
        correlationId,
      });

      // Wake-word activation filter: enforce strong activation phrase requirement
      const wakeWordResult = WakeWordDetector.detect(transcription.text);
      if (!wakeWordResult.detected || !wakeWordResult.command || wakeWordResult.command.trim().length === 0) {
        return reply.status(200).send({
          success: true,
          userMessage: null,
          assistantMessage: null,
          ignored: true,
          reason: 'No wake-word activation phrase detected or command empty',
        });
      }

      // 2. Build NormalizedUserInput structure for voice with activation phrase stripped
      const normalizedVoiceInput: NormalizedUserInput = {
        inputType: 'voice',
        content: wakeWordResult.command,
        userId,
        conversationId,
        requestId,
        timestamp: new Date().toISOString(),
        metadata: {
          voice: {
            duration: transcription.duration,
            confidence: transcription.confidence,
            language: transcription.language,
            processingTime: transcription.processing_time,
            audioFilename: filePart.filename || 'audio.wav',
            segmentsCount: transcription.segments.length,
          },
        },
      };

      // 3. Delegate to the unified AI Orchestrator
      const result = await AgentOrchestrator.run(userId, conversationId, normalizedVoiceInput, { requestId });

      // 4. Optionally synthesize TTS audio for assistant response if requested
      let ttsAudioBase64: string | undefined = undefined;
      const synthesizeRequested = fields?.synthesize?.value === 'true' || (request.query as any)?.synthesize === 'true';

      if (synthesizeRequested && result.assistantMessage?.content) {
        try {
          const audioBuffer = await aiServiceClient.synthesize(result.assistantMessage.content, undefined, undefined, {
            requestId,
            correlationId,
          });
          ttsAudioBase64 = audioBuffer.toString('base64');
        } catch {
          // Keep response intact if optional synthesis fails
        }
      }

      return reply.status(200).send({
        success: true,
        userMessage: result.userMessage,
        assistantMessage: result.assistantMessage,
        runId: result.runId,
        transcription,
        audioBase64: ttsAudioBase64,
      });
    } catch (err: any) {
      if (err instanceof AIServiceUnavailableError) {
        return reply.status(503).send({
          success: false,
          error: {
            message: 'Voice processing service is unavailable: ' + err.message,
            statusCode: 503,
          },
        });
      }
      if (err instanceof AIServiceTimeoutError) {
        return reply.status(504).send({
          success: false,
          error: {
            message: 'Voice processing timed out: ' + err.message,
            statusCode: 504,
          },
        });
      }
      if (err instanceof AIServiceValidationError) {
        return reply.status(err.statusCode || 422).send({
          success: false,
          error: {
            message: err.message,
            statusCode: err.statusCode || 422,
          },
        });
      }

      request.log.error({ msg: 'Error during voice chat orchestration', err: err.message });
      return reply.status(err.statusCode || 500).send({
        success: false,
        error: {
          message: err.message || 'Voice orchestration failed',
          statusCode: err.statusCode || 500,
        },
      });
    }
  };

  fastify.post('/voice/chat', { preHandler: [authenticate] }, handleVoiceChatOrchestration);
  fastify.post('/conversations/:id/messages/voice', { preHandler: [authenticate] }, handleVoiceChatOrchestration);

  /**
   * POST /api/v1/voice/tts
   * Authenticated Text-to-Speech synthesis route.
   */
  fastify.post('/voice/tts', { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body || {}) as { text?: string; voice?: string; speed?: string };
      if (!body.text || body.text.trim().length === 0) {
        return reply.status(400).send({
          success: false,
          error: { message: 'Missing text parameter for TTS synthesis', statusCode: 400 },
        });
      }

      const requestId = request.id;
      const correlationId = (request.headers['x-correlation-id'] as string) || requestId;

      const audioBuffer = await aiServiceClient.synthesize(body.text, body.voice, body.speed, {
        requestId,
        correlationId,
      });

      return reply
        .header('Content-Type', 'audio/wav')
        .header('Content-Disposition', 'attachment; filename="speech.wav"')
        .status(200)
        .send(audioBuffer);
    } catch (err: any) {
      if (err instanceof AIServiceUnavailableError) {
        return reply.status(503).send({ success: false, error: { message: err.message, statusCode: 503 } });
      }
      return reply.status(err.statusCode || 500).send({
        success: false,
        error: { message: err.message || 'TTS synthesis failed', statusCode: err.statusCode || 500 },
      });
    }
  });

  /**
   * GET /api/v1/voice/health
   * Health check for AI Service connection & STT model readiness.
   */
  fastify.get('/voice/health', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const requestId = request.id;
      const correlationId = (request.headers['x-correlation-id'] as string) || requestId;

      const healthRes = await aiServiceClient.health({ requestId, correlationId });
      const readinessRes = await aiServiceClient.readiness({ requestId, correlationId });

      return reply.status(200).send({
        success: true,
        data: {
          service: 'AI Subsystem',
          health: healthRes,
          stt_status: readinessRes,
          ready: readinessRes.is_ready,
        },
      });
    } catch (err: any) {
      return reply.status(503).send({
        success: false,
        error: {
          message: 'AI Service is unready or unreachable: ' + err.message,
          statusCode: 503,
        },
      });
    }
  });
}

