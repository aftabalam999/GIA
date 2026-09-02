import { describe, it, expect } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { LocalVAD } from './localVad.js';
import { AudioRecorderService } from './audioRecorder.js';

describe('Voice Microphone Input Gating Policy Test Suite', () => {
  it('Test 1-6 — Microphone State Policy: verifies microphone gating mapping for all voice states', async () => {
    const log: string[] = [];
    const vsm = new VoiceStateMachine({
      onPauseCapture: () => log.push('MIC_DISABLED'),
      onResumeCapture: () => log.push('MIC_ENABLED'),
    });

    // Test 1: Initial IDLE state (Voice Mode OFF)
    expect(vsm.state).toBe('IDLE');

    // Test 2: Enable Voice Mode -> LISTENING
    await vsm.startVoiceMode('convo-1', 'token-1', false);
    expect(vsm.state).toBe('LISTENING');
    expect(log[log.length - 1]).toBe('MIC_ENABLED');

    // Test 3: Speech start -> SPEECH_DETECTED / USER_SPEAKING
    vsm.handleSpeechStart();
    expect(vsm.state).toBe('SPEECH_DETECTED');
    expect(log[log.length - 1]).toBe('MIC_ENABLED');

    // Test 4 & 5: Utterance processing (TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING)
    vsm.setCallbacks({
      fetchTranscribeApi: async () => ({ text: 'hello' }),
      fetchChatApi: async () => ({ assistantMessage: { content: 'Hi' } }),
      fetchTtsApi: async () => new ArrayBuffer(8),
      playAudioApi: async () => {
        // While playing, mic must be disabled
        expect(log[log.length - 1]).toBe('MIC_DISABLED');
      },
    });

    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    // Test 6: Response finished -> Returns to LISTENING -> Microphone re-enabled
    expect(vsm.state).toBe('LISTENING');
    expect(log[log.length - 1]).toBe('MIC_ENABLED');
  });

  it('Test 7 — No self-trigger: audio frames arriving during PLAYING/SPEAKING state do NOT trigger speech events', () => {
    let speechStartCount = 0;
    const recorder = new AudioRecorderService({
      onSpeechStart: () => {
        speechStartCount++;
      },
    });

    // Mute microphone input (simulating PLAYING state microphone gating)
    recorder.pause();

    // Access underlying VAD and send loud speech-level audio frames
    const vad = (recorder as any).vad as LocalVAD;
    vad.processAudioFrame(0.08, 50, 1000);
    vad.processAudioFrame(0.09, 50, 1050);
    vad.processAudioFrame(0.10, 50, 1100);

    // Verify 0 speech start events fired
    expect(speechStartCount).toBe(0);
    expect(vad.isSpeaking).toBe(false);
  });

  it('Test 8 — Gemini session persistence: transitioning LISTENING -> PROCESSING -> PLAYING -> LISTENING maintains conversation session without reconnection', async () => {
    let chatCalls = 0;
    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => ({ text: 'Turn 1 query' }),
      fetchChatApi: async (convoId) => {
        chatCalls++;
        expect(convoId).toBe('persistent-convo-id');
        return { assistantMessage: { content: 'Response turn' } };
      },
    });

    await vsm.startVoiceMode('persistent-convo-id', 'token-123', false);
    expect(vsm.isVoiceModeOn).toBe(true);

    // Turn 1
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    expect(chatCalls).toBe(1);

    // Turn 2 in same persistent session
    await vsm.processSpeechUtterance(new Uint8Array([2]) as any);
    expect(chatCalls).toBe(2);

    expect(vsm.isVoiceModeOn).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });
});
