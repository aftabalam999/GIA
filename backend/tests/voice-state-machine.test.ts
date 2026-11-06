import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoiceStateMachine, VoiceState } from '../../frontend/src/services/voiceStateMachine.js';

describe('GIA Phase 8: Voice State Machine Integration & Lifecycle Suite', () => {
  let vsm: VoiceStateMachine;
  let stateHistory: VoiceState[];

  beforeEach(() => {
    stateHistory = [];
    vsm = new VoiceStateMachine({
      onStateChange: (s) => stateHistory.push(s),
    });
  });

  it('should initialize in IDLE state with voice mode OFF', () => {
    expect(vsm.state).toBe('IDLE');
    expect(vsm.isVoiceModeOn).toBe(false);
  });

  it('should transition IDLE -> STARTING -> LISTENING on startVoiceMode()', async () => {
    await vsm.startVoiceMode('convo-123', 'token-abc');
    expect(vsm.isVoiceModeOn).toBe(true);
    expect(vsm.state).toBe('LISTENING');
    expect(stateHistory).toEqual(['STARTING', 'LISTENING']);
  });

  it('should transition LISTENING -> SPEECH_DETECTED on handleSpeechStart()', async () => {
    await vsm.startVoiceMode('convo-123', 'token-abc');
    vsm.handleSpeechStart();
    expect(vsm.state).toBe('SPEECH_DETECTED');
  });

  it('should execute complete state loop: TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING -> LISTENING', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'open Chrome' });
    const mockChat = vi.fn().mockResolvedValue({
      userMessage: { content: 'open Chrome' },
      assistantMessage: { content: 'Hello user' },
    });
    const mockTts = vi.fn().mockResolvedValue(new ArrayBuffer(100));
    const mockPlay = vi.fn().mockResolvedValue(undefined);

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
      playAudioApi: mockPlay,
    });

    await vsm.startVoiceMode('convo-123', 'token-abc', false);
    stateHistory = []; // Reset after start

    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    expect(stateHistory).toEqual([
      'SPEECH_DETECTED',
      'TRANSCRIBING',
      'PROCESSING',
      'SYNTHESIZING',
      'PLAYING',
      'LISTENING', // Automatic return to listening for continuous mode!
    ]);

    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledWith('convo-123', 'open Chrome');
    expect(mockTts).toHaveBeenCalledWith('Hello user');
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it('should execute multiple utterances continuously without turning voice mode off', async () => {
    const mockTranscribe = vi.fn()
      .mockResolvedValueOnce({ text: 'Utterance 1' })
      .mockResolvedValueOnce({ text: 'Utterance 2' });

    const mockChat = vi.fn()
      .mockResolvedValueOnce({ assistantMessage: { content: 'Response 1' } })
      .mockResolvedValueOnce({ assistantMessage: { content: 'Response 2' } });

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
    });

    await vsm.startVoiceMode('convo-123', 'token-abc');

    // Utterance 1
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    expect(vsm.state).toBe('LISTENING');

    // Utterance 2
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([2]) as any);
    expect(vsm.state).toBe('LISTENING');

    expect(vsm.isVoiceModeOn).toBe(true);
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
  });

  it('should transition to IDLE on explicit stopVoiceMode() from LISTENING', async () => {
    await vsm.startVoiceMode('convo-123', 'token-abc');
    stateHistory = [];

    await vsm.stopVoiceMode();
    expect(vsm.isVoiceModeOn).toBe(false);
    expect(vsm.state).toBe('IDLE');
    expect(stateHistory).toEqual(['STOP_REQUESTED', 'STOPPING', 'IDLE']);
  });

  it('should cancel active processing cleanly when stopVoiceMode() is called during TRANSCRIBING', async () => {
    const slowTranscribe = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(async () => {
          await vsm.stopVoiceMode(); // User clicks stop while transcribing
          resolve({ text: 'Slow transcript' });
        }, 10);
      });
    });

    vsm.setCallbacks({ fetchTranscribeApi: slowTranscribe });
    await vsm.startVoiceMode('convo-123', 'token-abc');

    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(vsm.isVoiceModeOn).toBe(false);
    expect(vsm.state).toBe('IDLE');
  });

  it('should handle pure silence by cleanly returning to LISTENING without invoking chat API', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: '' }); // Empty transcript (silence)
    const mockChat = vi.fn();

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
    });

    await vsm.startVoiceMode('convo-123', 'token-abc');
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([0, 0, 0]) as any);

    expect(mockChat).not.toHaveBeenCalled();
    expect(vsm.state).toBe('LISTENING');
  });

  it('should prevent accidental duplicate submissions when already processing', async () => {
    const mockTranscribe = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ text: 'Test' }), 50)));
    vsm.setCallbacks({ fetchTranscribeApi: mockTranscribe });

    await vsm.startVoiceMode('convo-123', 'token-abc');
    vsm.handleSpeechStart();

    // Call processSpeechUtterance twice concurrently
    const p1 = vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    const p2 = vsm.processSpeechUtterance(new Uint8Array([2]) as any);

    await Promise.all([p1, p2]);
    expect(mockTranscribe).toHaveBeenCalledTimes(1); // Only 1 utterance processed!
  });

  it('should recover safely to LISTENING on network error during transcription', async () => {
    const mockError = vi.fn();
    const mockTranscribe = vi.fn().mockRejectedValue(new Error('Network offline'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      onError: mockError,
    });

    await vsm.startVoiceMode('convo-123', 'token-abc');
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(mockError).toHaveBeenCalledWith('Network offline');
    expect(vsm.state).toBe('LISTENING'); // Safely recovers to LISTENING
    expect(vsm.isVoiceModeOn).toBe(true);
  });
});
