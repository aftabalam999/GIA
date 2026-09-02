import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { SessionService } from '../../auth/services/session.service.js';
import { GeminiLiveService, LiveServerEvent } from '../../ai/services/geminiLive.service.js';
import { logger } from '../../shared/logger.js';

import { registry } from '../../ai/tools/registry.js';
import { ToolExecutor } from '../../ai/tools/executor.js';

export type LiveClientMessage =
  | { type: 'audio'; data: string }
  | { type: 'text'; text: string }
  | { type: 'interrupt' }
  | { type: 'tool-response'; callId: string; result: Record<string, unknown> }
  | { type: 'close' };

export type LiveServerMessage =
  | { type: 'connected' }
  | { type: 'audio'; data: string }
  | { type: 'text'; text: string }
  | { type: 'tool-call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'turn-complete' }
  | { type: 'interrupted' }
  | { type: 'error'; code: string; message: string }
  | { type: 'disconnected' };

const MAX_MESSAGE_SIZE = 512 * 1024; // 512 KB per WebSocket frame limit

interface MinimalSocket {
  send?: (data: string) => void;
  close?: () => void;
  readyState?: number;
}

export async function voiceLiveRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.get('/voice/live', { websocket: true }, (connection: any, request: FastifyRequest) => {
    const socket: MinimalSocket | undefined = connection?.socket || connection;
    if (!socket) return;

    (async () => {
      let sessionId = request.cookies?.session_id;

      if (!sessionId) {
        const authHeader = request.headers?.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          sessionId = authHeader.substring(7).trim();
        }
      }

      if (!sessionId) {
        const queryObj = (request.query as Record<string, string | undefined>) || {};
        sessionId = queryObj.token || queryObj.session_id;
      }

      if (!sessionId && request.url) {
        try {
          const parsedUrl = new URL(request.url, 'http://localhost');
          sessionId = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('session_id') || undefined;
        } catch {
          // ignore
        }
      }

      if (!sessionId) {
        sendServerError(socket, 'UNAUTHORIZED', 'Unauthorized: Missing authentication token or session');
        tryClose(socket);
        return;
      }

      let userId: string;
      try {
        const session = await SessionService.lookupSession(sessionId);
        if (!session) {
          sendServerError(socket, 'UNAUTHORIZED', 'Unauthorized: Invalid or expired session');
          tryClose(socket);
          return;
        }
        userId = session.userId;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ msg: 'WebSocket session authentication error', err: errMsg });
        sendServerError(socket, 'AUTH_ERROR', 'Authentication service unavailable');
        tryClose(socket);
        return;
      }

      logger.info({ msg: '🔌 [VOICE LIVE WS] Client authenticated', userId });

      const liveService = new GeminiLiveService({
        systemInstruction: 'You are Afiya, a real-time voice assistant.',
      });

      const handleServiceEvent = (evt: LiveServerEvent) => {
        try {
          switch (evt.type) {
            case 'connected':
              sendServerMessage(socket, { type: 'connected' });
              break;
            case 'audio':
              if (evt.audioData && evt.audioData.length > 0) {
                const base64Audio = evt.audioData.toString('base64');
                sendServerMessage(socket, { type: 'audio', data: base64Audio });
              }
              break;
            case 'text':
              if (evt.text) {
                sendServerMessage(socket, { type: 'text', text: evt.text });
              }
              break;
            case 'tool-call': {
              const toolCall = evt.toolCall;
              if (toolCall) {
                sendServerMessage(socket, {
                  type: 'tool-call',
                  callId: toolCall.id,
                  name: toolCall.name,
                  args: toolCall.args,
                });
                if (registry.has(toolCall.name)) {
                  (async () => {
                    try {
                      const res = await ToolExecutor.executeTool(userId, toolCall.name, toolCall.args);
                      if (res.success) {
                        liveService.sendToolResponse(toolCall.id, { output: res.result });
                      } else {
                        liveService.sendToolResponse(toolCall.id, { error: res.error || 'Tool execution failed' });
                      }
                    } catch (err: unknown) {
                      const errMsg = err instanceof Error ? err.message : String(err);
                      liveService.sendToolResponse(toolCall.id, { error: errMsg });
                    }
                  })();
                }
              }
              break;
            }
            case 'turn-complete':
              sendServerMessage(socket, { type: 'turn-complete' });
              break;
            case 'interrupted':
              sendServerMessage(socket, { type: 'interrupted' });
              break;
            case 'error':
              sendServerError(socket, 'GEMINI_ERROR', evt.error?.message || 'Gemini Live error');
              break;
            case 'disconnected':
              sendServerMessage(socket, { type: 'disconnected' });
              break;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ msg: 'Error forwarding Gemini Live event to WebSocket client', err: errMsg });
        }
      };

      liveService.on(handleServiceEvent);

      const wsConnection: any = connection?.socket || connection;
      if (wsConnection && typeof wsConnection.on === 'function') {
        wsConnection.on('message', (rawBuffer: Buffer | string) => {
          try {
            const strData = rawBuffer.toString();
            if (strData.length > MAX_MESSAGE_SIZE) {
              sendServerError(socket, 'PAYLOAD_TOO_LARGE', 'WebSocket payload exceeds maximum allowed size (512 KB)');
              return;
            }

            const parsed = JSON.parse(strData) as unknown;
            if (!parsed || typeof parsed !== 'object') {
              sendServerError(socket, 'INVALID_PROTOCOL', 'Payload must be a JSON object');
              return;
            }

            const msgObj = parsed as Record<string, unknown>;
            const msgType = typeof msgObj.type === 'string' ? msgObj.type : '';

            switch (msgType) {
              case 'audio': {
                if (typeof msgObj.data !== 'string' || msgObj.data.length === 0) {
                  sendServerError(socket, 'INVALID_AUDIO', 'Audio message requires non-empty base64 string data');
                  return;
                }
                const pcmBuffer = Buffer.from(msgObj.data, 'base64');
                liveService.sendAudio(pcmBuffer);
                break;
              }
              case 'text': {
                if (typeof msgObj.text !== 'string' || msgObj.text.trim().length === 0) {
                  sendServerError(socket, 'INVALID_TEXT', 'Text message requires non-empty string text');
                  return;
                }
                liveService.sendText(msgObj.text);
                break;
              }
              case 'interrupt': {
                liveService.interrupt();
                break;
              }
              case 'tool-response': {
                if (typeof msgObj.callId !== 'string' || !msgObj.result || typeof msgObj.result !== 'object') {
                  sendServerError(socket, 'INVALID_TOOL_RESPONSE', 'tool-response requires string callId and result object');
                  return;
                }
                liveService.sendToolResponse(msgObj.callId, msgObj.result as Record<string, unknown>);
                break;
              }
              case 'close': {
                liveService.close();
                tryClose(socket);
                break;
              }
              default: {
                sendServerError(socket, 'UNKNOWN_MESSAGE_TYPE', `Unrecognized message type: ${msgType}`);
              }
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error({ msg: 'Malformed client WebSocket frame parse error', err: errMsg });
            sendServerError(socket, 'INVALID_JSON', 'Malformed JSON payload');
          }
        });

        wsConnection.on('close', () => {
          logger.info({ msg: '🔌 [VOICE LIVE WS] Client disconnected, cleaning up Gemini Live session', userId });
          liveService.off(handleServiceEvent);
          liveService.close();
        });

        wsConnection.on('error', (err: Error) => {
          logger.error({ msg: 'WebSocket connection error', err: err.message });
          liveService.off(handleServiceEvent);
          liveService.close();
        });
      }

      try {
        await liveService.connect();
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ msg: 'Failed to connect Gemini Live session', err: errMsg });
        sendServerError(socket, 'CONNECT_FAILED', 'Failed to connect Gemini Live session');
        tryClose(socket);
        return;
      }
    })();
  });
}

function sendServerMessage(socket: MinimalSocket, message: LiveServerMessage): void {
  if (socket && typeof socket.send === 'function') {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // ignore
    }
  }
}

function sendServerError(socket: MinimalSocket, code: string, message: string): void {
  sendServerMessage(socket, { type: 'error', code, message });
}

function tryClose(socket: MinimalSocket): void {
  if (socket && typeof socket.close === 'function') {
    try {
      socket.close();
    } catch {
      // ignore
    }
  }
}
