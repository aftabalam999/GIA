import { describe, it, expect } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { StreamingAudioQueue } from './streamingAudioQueue.js';
import { LocalVAD } from './localVad.js';

describe('Voice Pipeline Latency Optimization & Verification Suite', () => {
  it('1. Streaming Playback: First audio chunk begins playback immediately without waiting for complete response generation', async () => {
    let firstChunkPlayedTime: number | null = null;
    let streamCompleteTime: number | null = null;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => ({ text: 'Explain quantum computing' }),
      fetchStreamChatApi: async (_convoId, _text, onChunk) => {
        // Stream chunk 1
        onChunk('Quantum computing uses qubits ');
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Stream chunk 2
        onChunk('which leverage superposition and entanglement.');
        await new Promise((resolve) => setTimeout(resolve, 50));
        streamCompleteTime = Date.now();
      },
      fetchTtsApi: async () => new ArrayBuffer(8),
      playAudioApi: async () => {
        if (firstChunkPlayedTime === null) {
          firstChunkPlayedTime = Date.now();
        }
      },
    });

    await vsm.startVoiceMode('convo-latency-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(firstChunkPlayedTime).not.toBeNull();
    expect(streamCompleteTime).not.toBeNull();
    // First audio chunk playback started BEFORE the complete stream finished!
    expect(firstChunkPlayedTime!).toBeLessThan(streamCompleteTime!);
  });

  it('2. Persistent Session: Multiple turns reuse single persistent conversation session without reconnecting', async () => {
    let sessionCount = 0;
    const vsm = new VoiceStateMachine({
      fetchChatApi: async (convoId) => {
        sessionCount++;
        expect(convoId).toBe('persistent-live-convo');
        return { assistantMessage: { content: 'Response' } };
      },
    });

    await vsm.startVoiceMode('persistent-live-convo', 'token-123', false);

    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    await vsm.processSpeechUtterance(new Uint8Array([2]) as any);
    await vsm.processSpeechUtterance(new Uint8Array([3]) as any);

    expect(sessionCount).toBe(3);
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  it('3. Audio Initialization: Voice Mode pre-initializes audio state before the first response arrives', async () => {
    const vsm = new VoiceStateMachine({});
    expect(vsm.state).toBe('IDLE');

    await vsm.startVoiceMode('convo-audio-init', 'token-1', false);

    // Immediately after startVoiceMode, state is LISTENING with mic ready
    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  it('4. Queue Latency: StreamingAudioQueue does NOT wait for complete response before playing chunk 0', async () => {
    let chunk0PlayStarted = false;

    const queue = new StreamingAudioQueue({
      synthesize: async () => new ArrayBuffer(8),
      player: {
        play: async () => {
          chunk0PlayStarted = true;
        },
        stop: () => {},
        state: 'PLAYING',
        isPlaying: true,
      } as any,
    });

    queue.pushChunk('First immediate phrase');

    // Wait a brief tick for async synthesis and playback loop to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chunk0PlayStarted).toBe(true);
    expect(queue.isComplete).toBe(false); // Stream NOT yet marked complete!
  });

  it('5. Interruption Preservation: SPEAKING -> INTERRUPTED transition halts playback instantly under optimized settings', async () => {
    let playInterrupted = false;

    const vsm = new VoiceStateMachine({
      onStateChange: (state) => {
        if (state === 'INTERRUPTED') playInterrupted = true;
      },
      fetchTtsApi: async () => new ArrayBuffer(8),
      playAudioApi: async () => {
        // Simulating playback
        vsm.handleInterruption();
      },
    });

    await vsm.startVoiceMode('convo-interrupt', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(playInterrupted).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('6. VAD Turn-Finalization Optimization: 650ms VAD silence handover reduces turn-finalization delay compared to 1200ms', () => {
    let fired650 = false;
    let fired1200 = false;

    const vad1200 = new LocalVAD({ silenceDurationMs: 1200 }, { onSpeechEnd: () => { fired1200 = true; } });
    const vad650 = new LocalVAD({ silenceDurationMs: 650 }, { onSpeechEnd: () => { fired650 = true; } });

    vad1200.start();
    vad650.start();

    const tStart = 1000;
    vad1200.processAudioFrame(0.08, 100, tStart);
    vad650.processAudioFrame(0.08, 100, tStart);

    // Silence for 700ms (exceeds 650ms, but below 1200ms)
    vad1200.processAudioFrame(0.001, 700, tStart + 800);
    vad650.processAudioFrame(0.001, 700, tStart + 800);

    expect(fired650).toBe(true);
    expect(fired1200).toBe(false); // 1200ms still waiting for silence!
  });
});
