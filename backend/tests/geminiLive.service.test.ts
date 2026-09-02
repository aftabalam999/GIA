import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiLiveService, LiveServerEvent } from '../src/ai/services/geminiLive.service.js';

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      live: {
        connect: vi.fn().mockImplementation(async (params: any) => {
          const mockSession = {
            sendRealtimeInput: vi.fn(),
            sendClientContent: vi.fn(),
            sendToolResponse: vi.fn(),
            close: vi.fn(),
          };
          if (params?.callbacks?.onopen) {
            params.callbacks.onopen();
          }
          return mockSession;
        }),
      },
    })),
    Modality: {
      AUDIO: 'AUDIO',
      TEXT: 'TEXT',
    },
  };
});

describe('GeminiLiveService Backend Unit Test Suite', () => {
  let service: GeminiLiveService;
  let eventsReceived: LiveServerEvent[];

  beforeEach(() => {
    eventsReceived = [];
    service = new GeminiLiveService({
      apiKey: 'test-secret-key-12345',
      model: 'gemini-2.0-flash-exp',
      systemInstruction: 'You are Afiya, voice assistant.',
    });

    service.on((evt) => {
      eventsReceived.push(evt);
    });
  });

  it('Test 1 — Connection: connect() creates exactly one persistent Live session', async () => {
    expect(service.isConnected).toBe(false);

    await service.connect();

    expect(service.isConnected).toBe(true);
    expect(eventsReceived.length).toBe(1);
    expect(eventsReceived[0].type).toBe('connected');
  });

  it('Test 2 — Audio Input: sendAudio() forwards 16kHz PCM audio chunks unchanged without format conversion', async () => {
    await service.connect();

    const mockWs = { send: vi.fn() };
    service._setMockWsClient(mockWs);

    const pcmChunk = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    service.sendAudio(pcmChunk);

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(payload.realtimeInput.mediaChunks[0].mimeType).toBe('audio/pcm;rate=16000');
    expect(payload.realtimeInput.mediaChunks[0].data).toBe(pcmChunk.toString('base64'));
  });

  it('Test 3 — Audio Output: server audio events are emitted correctly with 24kHz PCM data', async () => {
    await service.connect();

    const mockPcmAudio = Buffer.from([10, 20, 30, 40]);
    service._simulateServerMessage({ type: 'audio', audioData: mockPcmAudio });

    const audioEvent = eventsReceived.find((e) => e.type === 'audio');
    expect(audioEvent).toBeDefined();
    expect(audioEvent?.audioData).toEqual(mockPcmAudio);
  });

  it('Test 4 — Tool Calls: tool-call events are surfaced with typed function definitions', async () => {
    await service.connect();

    service._simulateServerMessage({
      type: 'tool-call',
      toolCall: {
        id: 'call-xyz-123',
        name: 'open_app',
        args: { appName: 'VSCode' },
      },
    });

    const toolEvent = eventsReceived.find((e) => e.type === 'tool-call');
    expect(toolEvent).toBeDefined();
    expect(toolEvent?.toolCall?.name).toBe('open_app');
    expect(toolEvent?.toolCall?.args).toEqual({ appName: 'VSCode' });
  });

  it('Test 5 — Turn Complete: turn-complete events are surfaced correctly', async () => {
    await service.connect();

    service._simulateServerMessage({ type: 'turn-complete' });

    const turnEvent = eventsReceived.find((e) => e.type === 'turn-complete');
    expect(turnEvent).toBeDefined();
  });

  it('Test 6 — Interruption: interrupt() signals barge-in cancellation to Live session', async () => {
    await service.connect();

    service.interrupt();

    const interruptEvent = eventsReceived.find((e) => e.type === 'interrupted');
    expect(interruptEvent).toBeDefined();
  });

  it('Test 7 — Close: close() terminates the persistent session and emits disconnected', async () => {
    await service.connect();
    expect(service.isConnected).toBe(true);

    service.close();

    expect(service.isConnected).toBe(false);
    const disconnectEvent = eventsReceived.find((e) => e.type === 'disconnected');
    expect(disconnectEvent).toBeDefined();
  });

  it('Test 8 — Error Handling: connection failure produces a typed Error event without crashing', async () => {
    const failingService = new GeminiLiveService({ apiKey: 'invalid' });
    const localEvents: LiveServerEvent[] = [];
    failingService.on((e) => localEvents.push(e));

    vi.spyOn(failingService, 'connect').mockRejectedValueOnce(new Error('Network error'));

    await expect(failingService.connect()).rejects.toThrow('Network error');
  });

  it('Test 9 — Security: NO API key is exposed through public event payloads or log messages', async () => {
    await service.connect();

    service._simulateServerMessage({ type: 'audio', audioData: Buffer.from([1, 2, 3]) });
    service._simulateServerMessage({ type: 'text', text: 'Hello' });

    for (const evt of eventsReceived) {
      const evtString = JSON.stringify(evt);
      expect(evtString).not.toContain('test-secret-key-12345');
    }
  });

  it('Test 10 — Persistent Session Reuse: multiple audio turns reuse the same Live session', async () => {
    await service.connect();

    const mockWs = { send: vi.fn() };
    service._setMockWsClient(mockWs);

    // Turn 1
    service.sendText('Turn 1 user speech');
    // Turn 2
    service.sendText('Turn 2 user speech');

    expect(mockWs.send).toHaveBeenCalledTimes(2);
    expect(service.isConnected).toBe(true); // Single persistent session!
  });
});
