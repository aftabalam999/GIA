import { describe, it, expect } from 'vitest';
import { LocalVAD } from './localVad.js';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { StreamingAudioQueue } from './streamingAudioQueue.js';

describe('Voice Barge-In & Interruption Unit Test Suite', () => {
  it('Test 1 — Normal playback: SPEAKING state completes playback normally when no interruption occurs', async () => {
    let playCompleted = false;
    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => ({ text: 'Test utterance' }),
      fetchChatApi: async () => ({ assistantMessage: { content: 'Normal response' } }),
      fetchTtsApi: async () => new ArrayBuffer(8),
      playAudioApi: async () => {
        playCompleted = true;
      },
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(playCompleted).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 2 — Confirmed interruption: sustained user speech above interruptionThreshold during SPEAKING immediately stops playback and triggers INTERRUPTED', async () => {
    let interruptionStateFired = false;

    const vad = new LocalVAD(
      {
        interruptionThreshold: 0.045,
        minInterruptionDurationMs: 150,
        allowBargeIn: true,
      },
      {
        onInterruption: () => {
          vsm.handleInterruption();
        },
      }
    );

    vad.start();

    const vsm = new VoiceStateMachine({
      onStateChange: (state) => {
        if (state === 'INTERRUPTED') interruptionStateFired = true;
      },
      playAudioApi: async () => {
        // Simulate playing state
        expect(vsm.state).toBe('PLAYING');

        // Simulate sustained strong speech from user during playback
        vad.processAudioFrame(0.08, 100, 1000);
        vad.processAudioFrame(0.09, 100, 1100);
      },
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);

    // Trigger process speech utterance asynchronously
    const processPromise = vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    // Send interruption signal while in motion
    vad.processAudioFrame(0.08, 100, 1000);
    vad.processAudioFrame(0.08, 100, 1100);

    await processPromise;

    expect(interruptionStateFired).toBe(true);
    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  it('Test 3 — Short noise: short audio spike (< minInterruptionDurationMs) during SPEAKING does NOT interrupt', () => {
    let interrupted = false;
    const vad = new LocalVAD(
      {
        interruptionThreshold: 0.045,
        minInterruptionDurationMs: 200,
        allowBargeIn: true,
      },
      {
        onInterruption: () => {
          interrupted = true;
        },
      }
    );

    vad.start();
    // Short spike of 50ms energy (< 200ms duration requirement)
    vad.processAudioFrame(0.08, 50, 1000);

    expect(interrupted).toBe(false);
  });

  it('Test 4 — Background noise: low-level noise (< interruptionThreshold) during SPEAKING does NOT interrupt', () => {
    let interrupted = false;
    const vad = new LocalVAD(
      {
        interruptionThreshold: 0.045,
        minInterruptionDurationMs: 200,
        allowBargeIn: true,
      },
      {
        onInterruption: () => {
          interrupted = true;
        },
      }
    );

    vad.start();
    // Sustained low-level background noise (0.02 < 0.045 threshold)
    vad.processAudioFrame(0.02, 100, 1000);
    vad.processAudioFrame(0.02, 100, 1100);
    vad.processAudioFrame(0.02, 100, 1200);

    expect(interrupted).toBe(false);
  });

  it('Test 5 — Voice Mode OFF: audio frames cannot trigger interruption when Voice Mode is inactive', () => {
    let interrupted = false;
    const vad = new LocalVAD(
      { allowBargeIn: false },
      {
        onInterruption: () => {
          interrupted = true;
        },
      }
    );

    // vad.start() NOT called
    vad.processAudioFrame(0.09, 300, 1000);
    expect(interrupted).toBe(false);
  });

  it('Test 6 — Same Gemini session: SPEAKING -> INTERRUPTED -> LISTENING maintains conversation session without reconnection', async () => {
    let chatCallCount = 0;
    const vsm = new VoiceStateMachine({
      fetchChatApi: async (convoId) => {
        chatCallCount++;
        expect(convoId).toBe('persistent-session-id');
        return { assistantMessage: { content: 'Response' } };
      },
    });

    await vsm.startVoiceMode('persistent-session-id', 'token-1', false);

    // Turn 1 interrupted midway
    vsm.handleInterruption();
    expect(vsm.state).toBe('LISTENING');

    // Turn 2 continues in same session
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    expect(chatCallCount).toBe(1);
    expect(vsm.isVoiceModeOn).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 7 — Late audio chunks: late audio chunk from previous interrupted generation is discarded and does NOT play', async () => {
    let playedIndices: number[] = [];

    const queue = new StreamingAudioQueue(
      {
        synthesize: async () => new ArrayBuffer(8),
        player: {
          play: async () => {
            playedIndices.push(1);
          },
          stop: () => {},
          state: 'PLAYING',
          isPlaying: true,
        } as any,
      },
      {},
      1 // Generation 1
    );

    // Push chunk under Generation 1
    queue.pushChunk('First phrase', 1);

    // Simulate interruption -> Bump generation to 2 and cancel
    queue.cancel(); // Now generation is 2

    // Attempt to push late audio chunk from old Generation 1
    const pushResult = queue.pushChunk('Late phrase from Gen 1', 1);

    expect(pushResult).toBe(-1);
    expect(playedIndices.length).toBe(0);
  });

  it('Test 8 — Repeated interruption: multiple successive interruptions cycle cleanly without state corruption', async () => {
    const vsm = new VoiceStateMachine({});

    await vsm.startVoiceMode('convo-repeat', 'token-1', false);

    // Cycle 1
    vsm.handleSpeechStart();
    vsm.handleInterruption();
    expect(vsm.state).toBe('LISTENING');

    // Cycle 2
    vsm.handleSpeechStart();
    vsm.handleInterruption();
    expect(vsm.state).toBe('LISTENING');

    // Cycle 3
    vsm.handleSpeechStart();
    vsm.handleInterruption();
    expect(vsm.state).toBe('LISTENING');

    expect(vsm.isVoiceModeOn).toBe(true);
  });
});
