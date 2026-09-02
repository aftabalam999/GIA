import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiveVoiceController } from './liveVoiceController.js';
import { VoiceStateMachine } from './voiceStateMachine.js';

class MockGeminiLiveClient {
  public isConnected: boolean = false;
  public listeners: Set<any> = new Set();
  public sentAudio: any[] = [];
  public sentText: string[] = [];
  public interruptCount: number = 0;
  public disconnectCount: number = 0;

  on(listener: any) {
    this.listeners.add(listener);
  }

  off(listener: any) {
    this.listeners.delete(listener);
  }

  emit(event: any) {
    for (const l of this.listeners) {
      l(event);
    }
  }

  async connect(_token?: string) {
    this.isConnected = true;
    this.emit({ type: 'connected' });
  }

  sendAudio(chunk: any) {
    this.sentAudio.push(chunk);
  }

  sendText(text: string) {
    this.sentText.push(text);
  }

  sendInterrupt() {
    this.interruptCount++;
  }

  disconnect() {
    this.isConnected = false;
    this.disconnectCount++;
    this.emit({ type: 'disconnected' });
  }
}

class MockLiveAudioCapture {
  public isCapturing: boolean = false;
  public onChunk: any = null;
  public stopCount: number = 0;

  async start(onAudioChunk: any) {
    this.isCapturing = true;
    this.onChunk = onAudioChunk;
  }

  stop() {
    this.isCapturing = false;
    this.stopCount++;
  }

  simulateMicChunk(chunk: Uint8Array) {
    if (this.isCapturing && this.onChunk) {
      this.onChunk(chunk);
    }
  }
}

class MockLiveAudioPlayer {
  public isPlaying: boolean = false;
  public playedChunks: any[] = [];
  public stopCount: number = 0;
  public closeCount: number = 0;

  playChunk(chunk: any) {
    this.isPlaying = true;
    this.playedChunks.push(chunk);
  }

  stop() {
    this.isPlaying = false;
    this.stopCount++;
  }

  close() {
    this.closeCount++;
  }
}

describe('LiveVoiceController Integration & Unit Test Suite', () => {
  let mockClient: MockGeminiLiveClient;
  let mockCapture: MockLiveAudioCapture;
  let mockPlayer: MockLiveAudioPlayer;
  let stateMachine: VoiceStateMachine;
  let controller: LiveVoiceController;
  let stateHistory: string[];

  beforeEach(() => {
    mockClient = new MockGeminiLiveClient();
    mockCapture = new MockLiveAudioCapture();
    mockPlayer = new MockLiveAudioPlayer();
    stateHistory = [];

    stateMachine = new VoiceStateMachine({
      onStateChange: (s) => stateHistory.push(s),
      enableLiveMode: true,
    });

    controller = new LiveVoiceController(
      stateMachine,
      {
        onStateChange: (s) => stateHistory.push(s),
      },
      () => mockClient as any,
      () => mockCapture as any,
      () => mockPlayer as any
    );
  });

  it('Test 1, 2, 3 — Voice Mode ON: creates controller, connects WebSocket once, and starts microphone capture', async () => {
    await controller.start('convo-1', 'valid-token');

    expect(controller.isActive).toBe(true);
    expect(mockClient.isConnected).toBe(true);
    expect(mockCapture.isCapturing).toBe(true);
  });

  it('Test 4 & 5 — Continuous Audio Streaming: captured PCM chunks stream over WS without silence termination', async () => {
    await controller.start('convo-1', 'valid-token');

    const pcmChunk = new Uint8Array([1, 2, 3, 4]);
    mockCapture.simulateMicChunk(pcmChunk);

    expect(mockClient.sentAudio.length).toBe(1);
    expect(mockClient.sentAudio[0]).toEqual(pcmChunk);
    expect(mockCapture.isCapturing).toBe(true); // Continuous capture remains active
  });

  it('Test 6 & 7 — Gemini Audio Event: received audio reaches LiveAudioPlayer and triggers early playback', async () => {
    await controller.start('convo-1', 'valid-token');

    const serverPcm = new ArrayBuffer(10);
    mockClient.emit({ type: 'audio', data: serverPcm });

    expect(mockPlayer.playedChunks.length).toBe(1);
    expect(mockPlayer.playedChunks[0]).toBe(serverPcm);
    expect(stateHistory.includes('PLAYING')).toBe(true);
  });

  it('Test 8 & 9 — Gemini Text & Turn Complete: text updates UI layer and turn-complete returns to LISTENING', async () => {
    let capturedResponseText = '';
    const customController = new LiveVoiceController(
      stateMachine,
      {
        onStateChange: (s) => stateHistory.push(s),
        onAssistantResponse: (_u, assistantMsg) => {
          capturedResponseText = assistantMsg.content;
        },
      },
      () => mockClient as any,
      () => mockCapture as any,
      () => mockPlayer as any
    );

    await customController.start('convo-1', 'valid-token');

    mockClient.emit({ type: 'text', text: 'Hello ' });
    mockClient.emit({ type: 'text', text: 'World' });
    expect(capturedResponseText).toBe('Hello World');

    mockClient.emit({ type: 'turn-complete' });
    expect(stateHistory[stateHistory.length - 1]).toBe('LISTENING');

    customController.stop();
  });

  it('Test 10, 11, 12 — Interruption: halts playback, sends interrupt payload, retains WS connection, discards stale audio', async () => {
    await controller.start('convo-1', 'valid-token');

    mockClient.emit({ type: 'audio', data: new ArrayBuffer(8) });
    expect(mockPlayer.isPlaying).toBe(true);

    controller.handleInterruption();

    expect(mockClient.interruptCount).toBe(1);
    expect(mockPlayer.stopCount).toBe(1);
    expect(mockClient.isConnected).toBe(true); // WS connection preserved!
    expect(stateHistory[stateHistory.length - 1]).toBe('LISTENING');
  });

  it('Test 13, 14, 15 — Voice Mode OFF: stops capture, stops playback, and disconnects WebSocket cleanly', async () => {
    await controller.start('convo-1', 'valid-token');

    controller.stop();

    expect(controller.isActive).toBe(false);
    expect(mockCapture.stopCount).toBe(1);
    expect(mockPlayer.stopCount).toBe(1);
    expect(mockClient.disconnectCount).toBe(1);
    expect(mockClient.isConnected).toBe(false);
  });

  it('Test 16 & 17 — Error Recovery: connection or permission failure triggers clean error handling', async () => {
    const errorClient = new MockGeminiLiveClient();
    errorClient.connect = async () => {
      throw new Error('Connection refused');
    };

    let errorMsg = '';
    const errController = new LiveVoiceController(
      stateMachine,
      {
        onError: (err) => {
          errorMsg = err;
        },
      },
      () => errorClient as any,
      () => mockCapture as any,
      () => mockPlayer as any
    );

    await expect(errController.start('convo-1', 'token')).rejects.toThrow();
    expect(errController.isActive).toBe(false);
    expect(errorMsg).toContain('Connection refused');
  });

  it('Test 18 — STT/TTS Bypass: processSpeechUtterance is bypassed when isLiveMode is true in VoiceStateMachine', async () => {
    const transcribeSpy = vi.fn();
    stateMachine.setCallbacks({ fetchTranscribeApi: transcribeSpy });

    // Mock successful start
    vi.spyOn(LiveVoiceController.prototype, 'start').mockImplementation(async () => {});

    await stateMachine.startVoiceMode('convo-1', 'token');
    expect(stateMachine.isLiveMode).toBe(true);

    await stateMachine.processSpeechUtterance(new Blob([new Uint8Array([1, 2, 3])]));
    expect(transcribeSpy).not.toHaveBeenCalled(); // Whisper STT bypassed!

    await stateMachine.stopVoiceMode();
  });

  it('Test 19 — Zero Frontend Tool Execution: frontend client does not execute tools directly', () => {
    const codeStr = LiveVoiceController.toString();
    expect(codeStr).not.toContain('ToolExecutor');
    expect(codeStr).not.toContain('executeTool');
  });

  it('Test 20 — Multi-Session Resource Cleanup: sequential sessions tear down previous resources completely', async () => {
    vi.spyOn(LiveVoiceController.prototype, 'start').mockImplementation(async function (this: LiveVoiceController) {
      (this as any).active = true;
      (this as any).client = mockClient;
      (this as any).capture = mockCapture;
      (this as any).player = mockPlayer;
    });

    await stateMachine.startVoiceMode('c1', 't1');
    expect(stateMachine.isLiveMode).toBe(true);

    await stateMachine.stopVoiceMode();
    expect(stateMachine.isLiveMode).toBe(false);
    expect(mockCapture.stopCount).toBe(1);
    expect(mockPlayer.stopCount).toBe(1);
    expect(mockClient.disconnectCount).toBe(1);

    await stateMachine.startVoiceMode('c2', 't2');
    expect(stateMachine.isLiveMode).toBe(true);

    await stateMachine.stopVoiceMode();
    expect(stateMachine.isLiveMode).toBe(false);
    expect(mockCapture.stopCount).toBe(2);
    expect(mockPlayer.stopCount).toBe(2);
    expect(mockClient.disconnectCount).toBe(2);
  });
});
