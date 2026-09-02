import { describe, it, expect, beforeEach } from 'vitest';
import {
  GeminiLiveClient,
  GeminiLiveClientEvent,
  arrayBufferToBase64,
} from './geminiLiveClient.js';

class MockWebSocket {
  public url: string;
  public readyState: number = 1; // OPEN
  public sentMessages: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: ((err: any) => void) | null = null;
  public onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 10);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  simulateServerMessage(data: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

describe('GeminiLiveClient Suite', () => {
  let mockWs: MockWebSocket;
  let client: GeminiLiveClient;

  beforeEach(() => {
    mockWs = new MockWebSocket('ws://localhost:5000/api/v1/voice/live');
    client = new GeminiLiveClient(() => mockWs as any);
  });

  it('Test 1 & 2 — WebSocket Connection & Connected Event: connects and receives server connected event', async () => {
    const events: GeminiLiveClientEvent[] = [];
    client.on((evt) => events.push(evt));

    const connectPromise = client.connect('test-token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    expect(client.isConnected).toBe(true);
    expect(events.some((e) => e.type === 'connected')).toBe(true);
  });

  it('Test 3 — Audio Sending: sendAudio converts Uint8Array/ArrayBuffer to base64 JSON payload', async () => {
    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    const pcmChunk = new Uint8Array([1, 2, 3, 4]);
    client.sendAudio(pcmChunk);

    expect(mockWs.sentMessages.length).toBe(1);
    const parsed = JSON.parse(mockWs.sentMessages[0]);
    expect(parsed.type).toBe('audio');
    expect(parsed.data).toBe(arrayBufferToBase64(pcmChunk));
  });

  it('Test 4 — Text Sending: sendText formats and sends client text message', async () => {
    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    client.sendText('Hello Afiya');

    expect(mockWs.sentMessages.length).toBe(1);
    const parsed = JSON.parse(mockWs.sentMessages[0]);
    expect(parsed.type).toBe('text');
    expect(parsed.text).toBe('Hello Afiya');
  });

  it('Test 5 — Interrupt Sending: sendInterrupt formats and sends interrupt payload', async () => {
    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    client.sendInterrupt();

    expect(mockWs.sentMessages.length).toBe(1);
    const parsed = JSON.parse(mockWs.sentMessages[0]);
    expect(parsed.type).toBe('interrupt');
  });

  it('Test 6 — Server Audio Decoding: incoming base64 audio event is decoded into ArrayBuffer', async () => {
    const events: GeminiLiveClientEvent[] = [];
    client.on((evt) => events.push(evt));

    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    const base64Audio = arrayBufferToBase64(new Uint8Array([10, 20, 30]));
    mockWs.simulateServerMessage({ type: 'audio', data: base64Audio });

    const audioEvt = events.find((e) => e.type === 'audio');
    expect(audioEvt).toBeDefined();
    if (audioEvt && audioEvt.type === 'audio') {
      const bytes = new Uint8Array(audioEvt.data);
      expect(Array.from(bytes)).toEqual([10, 20, 30]);
    }
  });

  it('Test 7 & 8 — Server Text & Turn Complete: text and turn-complete events emit typed events', async () => {
    const events: GeminiLiveClientEvent[] = [];
    client.on((evt) => events.push(evt));

    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    mockWs.simulateServerMessage({ type: 'text', text: 'Output speech' });
    mockWs.simulateServerMessage({ type: 'turn-complete' });

    expect(events.some((e) => e.type === 'text' && e.text === 'Output speech')).toBe(true);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('Test 9 — Error Handling: structured server error event emits typed error event', async () => {
    const events: GeminiLiveClientEvent[] = [];
    client.on((evt) => events.push(evt));

    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    mockWs.simulateServerMessage({ type: 'error', code: 'RATE_LIMIT', message: 'Rate limit exceeded' });

    const errEvt = events.find((e) => e.type === 'error');
    expect(errEvt).toBeDefined();
    if (errEvt && errEvt.type === 'error') {
      expect(errEvt.code).toBe('RATE_LIMIT');
      expect(errEvt.message).toBe('Rate limit exceeded');
    }
  });

  it('Test 10 & 11 — Disconnect Cleanup & Malformed JSON: disconnect cleans socket and malformed frames are ignored safely', async () => {
    const events: GeminiLiveClientEvent[] = [];
    client.on((evt) => events.push(evt));

    const connectPromise = client.connect('token');
    mockWs.simulateServerMessage({ type: 'connected' });
    await connectPromise;

    // Send malformed message
    if (mockWs.onmessage) {
      mockWs.onmessage({ data: '{ malformed json string' });
    }

    client.disconnect();

    expect(client.isConnected).toBe(false);
  });

  it('Test 16 — Security Audit: zero Gemini API keys exist in client implementation', () => {
    const codeStr = GeminiLiveClient.toString();
    expect(codeStr).not.toContain('GOOGLE_AI_API_KEY');
    expect(codeStr).not.toContain('GEMINI_API_KEY');
    expect(codeStr).not.toContain('AIzaSy');
  });
});
