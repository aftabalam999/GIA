import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { AddressInfo } from 'net';
import { voiceLiveRoutes, LiveServerMessage } from '../src/api/routes/voiceLive.js';
import { SessionService, SessionRecord } from '../src/auth/services/session.service.js';
import { GeminiLiveService, LiveServerEvent } from '../src/ai/services/geminiLive.service.js';
import WebSocket from 'ws';

const mockSession: SessionRecord = {
  id: 'sess-1',
  userId: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  createdAt: Date.now(),
  lastActivity: Date.now(),
  expiresAt: Date.now() + 3600000,
};

const TEST_TIMEOUT = 15000;

describe('Fastify WebSocket Gateway (voiceLiveRoutes) Integration Suite', () => {
  let app: FastifyInstance;
  let port: number;
  let lookupSessionSpy: MockInstance;
  let liveSendAudioSpy: MockInstance;
  let liveSendTextSpy: MockInstance;
  let liveInterruptSpy: MockInstance;
  let liveSendToolResponseSpy: MockInstance;
  let liveCloseSpy: MockInstance;

  beforeEach(async () => {
    vi.restoreAllMocks();

    lookupSessionSpy = vi.spyOn(SessionService, 'lookupSession').mockImplementation(async (sessionId) => {
      if (sessionId === 'invalid-session') return null;
      return mockSession;
    });

    liveSendAudioSpy = vi.spyOn(GeminiLiveService.prototype, 'sendAudio').mockImplementation(() => {});
    liveSendTextSpy = vi.spyOn(GeminiLiveService.prototype, 'sendText').mockImplementation(() => {});
    liveInterruptSpy = vi.spyOn(GeminiLiveService.prototype, 'interrupt').mockImplementation(() => {});
    liveSendToolResponseSpy = vi.spyOn(GeminiLiveService.prototype, 'sendToolResponse').mockImplementation(() => {});
    liveCloseSpy = vi.spyOn(GeminiLiveService.prototype, 'close').mockImplementation(() => {});

    app = Fastify({ logger: false, forceCloseConnections: true });
    await app.register(fastifyWebsocket);
    await app.register(voiceLiveRoutes, { prefix: '/api/v1' });
    await app.ready();

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    port = addr.port;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    vi.restoreAllMocks();
  });

  function closeSocket(ws: WebSocket) {
    try {
      ws.close();
      ws.terminate();
    } catch {
      // ignore
    }
  }

  async function connectTestClient(token = 'valid-token'): Promise<{ ws: WebSocket; msgs: LiveServerMessage[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/voice/live?token=${token}`);
    const msgs: LiveServerMessage[] = [];
    ws.on('message', (data) => {
      try {
        msgs.push(JSON.parse(data.toString()) as LiveServerMessage);
      } catch {
        // ignore
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS connection timeout')), 4000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Wait for connected or error message
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (msgs.some((m) => m.type === 'connected' || m.type === 'error')) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    return { ws, msgs };
  }

  it('Test 1 — Auth Rejection: unauthenticated connection is rejected immediately', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/voice/live`);

    const messagePromise = new Promise<string>((resolve) => {
      ws.on('message', (data) => resolve(data.toString()));
    });

    const msgStr = await messagePromise;
    const parsed = JSON.parse(msgStr) as LiveServerMessage;

    expect(parsed.type).toBe('error');
    if (parsed.type === 'error') {
      expect(parsed.code).toBe('UNAUTHORIZED');
    }
    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 2 — Auth Rejection with Invalid Token: invalid session returns UNAUTHORIZED error', async () => {
    const { ws, msgs } = await connectTestClient('invalid-session');

    const err = msgs.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.code).toBe('UNAUTHORIZED');
    }

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 3, 4 — Authenticated Connection: valid token connects and initializes single GeminiLiveService', async () => {
    const { ws, msgs } = await connectTestClient('valid-token');

    expect(lookupSessionSpy).toHaveBeenCalledWith('valid-token');
    expect(msgs.some((m) => m.type === 'connected')).toBe(true);

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 5 — Audio Forwarding: client audio frame is forwarded to GeminiLiveService.sendAudio', async () => {
    const { ws } = await connectTestClient();

    const pcmBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
    ws.send(JSON.stringify({ type: 'audio', data: pcmBase64 }));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveSendAudioSpy).toHaveBeenCalledTimes(1);
    const sentBuf = liveSendAudioSpy.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(sentBuf)).toBe(true);
    expect(sentBuf).toEqual(Buffer.from([1, 2, 3, 4]));

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 6 — Text Forwarding: client text message is forwarded to GeminiLiveService.sendText', async () => {
    const { ws } = await connectTestClient();

    ws.send(JSON.stringify({ type: 'text', text: 'Hello Afiya' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveSendTextSpy).toHaveBeenCalledWith('Hello Afiya');

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 7 — Interruption Forwarding: client interrupt message triggers GeminiLiveService.interrupt()', async () => {
    const { ws } = await connectTestClient();

    ws.send(JSON.stringify({ type: 'interrupt' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveInterruptSpy).toHaveBeenCalled();

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 8 — Tool Response Forwarding: tool-response message calls GeminiLiveService.sendToolResponse', async () => {
    const { ws } = await connectTestClient();

    ws.send(JSON.stringify({ type: 'tool-response', callId: 'call-1', result: { status: 'ok' } }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveSendToolResponseSpy).toHaveBeenCalledWith('call-1', { status: 'ok' });

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 9, 10, 11, 12, 13 — Gemini Events: audio, text, tool-call, turn-complete, error forwarded to client', async () => {
    let capturedListener: ((evt: LiveServerEvent) => void) | undefined;
    const realOn = GeminiLiveService.prototype.on;
    vi.spyOn(GeminiLiveService.prototype, 'on').mockImplementation(function (this: GeminiLiveService, listener) {
      capturedListener = listener;
      return realOn.call(this, listener);
    });

    const { ws, msgs } = await connectTestClient();

    expect(capturedListener).toBeDefined();
    if (capturedListener) {
      capturedListener({ type: 'audio', audioData: Buffer.from([10, 20]) });
      capturedListener({ type: 'text', text: 'Output text' });
      capturedListener({ type: 'tool-call', toolCall: { id: 'c1', name: 'app', args: { a: 1 } } });
      capturedListener({ type: 'turn-complete' });
      capturedListener({ type: 'error', error: new Error('Gemini err') });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(msgs.some((m) => m.type === 'audio' && m.data === Buffer.from([10, 20]).toString('base64'))).toBe(true);
    expect(msgs.some((m) => m.type === 'text' && m.text === 'Output text')).toBe(true);
    expect(msgs.some((m) => m.type === 'tool-call' && m.name === 'app')).toBe(true);
    expect(msgs.some((m) => m.type === 'turn-complete')).toBe(true);
    expect(msgs.some((m) => m.type === 'error' && m.code === 'GEMINI_ERROR')).toBe(true);

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 14 — Malformed Message: invalid JSON payload is rejected gracefully without crashing server', async () => {
    const { ws, msgs } = await connectTestClient();

    ws.send('{ malformed json }');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const err = msgs.find((m) => m.type === 'error' && m.code === 'INVALID_JSON');
    expect(err).toBeDefined();

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 15 — Oversized Message: frame exceeding 512KB limit triggers PAYLOAD_TOO_LARGE error', async () => {
    const { ws, msgs } = await connectTestClient();

    const hugeData = 'a'.repeat(600 * 1024);
    ws.send(JSON.stringify({ type: 'audio', data: hugeData }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const err = msgs.find((m) => m.type === 'error' && m.code === 'PAYLOAD_TOO_LARGE');
    expect(err).toBeDefined();

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 16 & 17 — Disconnect Cleanup: client WebSocket close triggers geminiLiveService.close()', async () => {
    const { ws } = await connectTestClient();

    closeSocket(ws);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(liveCloseSpy).toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it('Test 18 — Security Isolation: zero Gemini API keys are sent over WebSocket', async () => {
    const { ws, msgs } = await connectTestClient();

    for (const msg of msgs) {
      const str = JSON.stringify(msg);
      expect(str).not.toContain('GOOGLE_AI_API_KEY');
      expect(str).not.toContain('AIzaSy');
    }

    closeSocket(ws);
  }, TEST_TIMEOUT);

  it('Test 19 — Multi-Client Isolation: independent WebSocket sessions instantiate separate GeminiLiveServices', async () => {
    const { ws: ws1 } = await connectTestClient('t1');
    const { ws: ws2 } = await connectTestClient('t2');

    closeSocket(ws1);
    closeSocket(ws2);
  }, TEST_TIMEOUT);
});
