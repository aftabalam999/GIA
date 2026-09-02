import { describe, it, expect, vi } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';

describe('VoiceStateMachine Command Session & State Guard Tests', () => {
  it('should enforce wake-word outside session, allow continuous dialogue in active session, and return to wake-word listening on silence', async () => {
    const processedCommands: string[] = [];
    const mockTranscribe = vi.fn();
    const mockChat = vi.fn().mockImplementation((_convoId, text) => {
      processedCommands.push(text);
      return Promise.resolve({ assistantMessage: { content: 'OK' } });
    });

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    expect(vsm.isSessionActive).toBe(false);

    // 1. Outside active session: "open VS Code" without wake word -> IGNORED
    mockTranscribe.mockResolvedValueOnce({ text: 'open VS Code' });
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    expect(processedCommands).toEqual([]);
    expect(vsm.isSessionActive).toBe(false);

    // 2. Wake phrase + command: "Afiya open VS Code" -> ENTERS SESSION & EXECUTES
    mockTranscribe.mockResolvedValueOnce({ text: 'Afiya open VS Code' });
    await vsm.processSpeechUtterance(new Uint8Array([2]) as any);
    expect(processedCommands).toEqual(['open VS Code']);
    expect(vsm.isSessionActive).toBe(true);

    // 3. Follow-up sentence in active session: "create a new file" -> EXECUTES WITHOUT WAKE WORD
    mockTranscribe.mockResolvedValueOnce({ text: 'create a new file' });
    await vsm.processSpeechUtterance(new Uint8Array([3]) as any);
    expect(processedCommands).toEqual(['open VS Code', 'create a new file']);
    expect(vsm.isSessionActive).toBe(true);

    // 4. Silence / empty transcript -> RESETS ACTIVE SESSION
    mockTranscribe.mockResolvedValueOnce({ text: '' });
    await vsm.processSpeechUtterance(new Uint8Array([4]) as any);
    expect(vsm.isSessionActive).toBe(false);

    // 5. Outside active session again: "search React" without wake word -> IGNORED
    mockTranscribe.mockResolvedValueOnce({ text: 'search React' });
    await vsm.processSpeechUtterance(new Uint8Array([5]) as any);
    expect(processedCommands).toEqual(['open VS Code', 'create a new file']); // unchanged!
    expect(vsm.isSessionActive).toBe(false);
  });

  it('should ignore incoming audio events during non-listening states (TRANSCRIBING, PROCESSING, SYNTHESIZING, PLAYING)', async () => {
    let playResolver: (() => void) | null = null;

    const mockTranscribe = vi.fn().mockImplementation(async () => {
      return { text: 'Afiya hello' };
    });

    const mockChat = vi.fn().mockImplementation(async () => {
      return { assistantMessage: { content: 'Hello there' } };
    });

    const mockTts = vi.fn().mockImplementation(async () => {
      return new Uint8Array([1, 2, 3]).buffer;
    });

    const mockPlay = vi.fn().mockImplementation(() => {
      return new Promise<void>((resolve) => {
        playResolver = resolve;
      });
    });

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
      playAudioApi: mockPlay,
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    expect(vsm.state).toBe('LISTENING');

    // Start processing utterance 1 asynchronously
    let processErr: any = null;
    const processPromise = vsm.processSpeechUtterance(new Uint8Array([10]) as any).catch((err) => {
      processErr = err;
    });

    // Wait until state reaches PLAYING
    for (let i = 0; i < 100; i++) {
      if (vsm.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    if (processErr) {
      throw processErr;
    }

    expect(vsm.state).toBe('PLAYING');
    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Attempt to inject audio while in PLAYING state
    await vsm.processSpeechUtterance(new Uint8Array([20]) as any);

    // Verify STT was NOT called a second time for the ignored audio
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledTimes(1);

    // Finish audio playback for utterance 1
    if (playResolver) {
      (playResolver as Function)();
    }
    await processPromise;

    // After playback finishes, state returns to LISTENING
    expect(vsm.state).toBe('LISTENING');

    // Make mockPlay resolve automatically for subsequent utterances
    mockPlay.mockResolvedValue(undefined);

    // A legitimate follow-up utterance in active session is accepted
    mockTranscribe.mockImplementationOnce(async () => ({ text: 'what is the time?' }));
    await vsm.processSpeechUtterance(new Uint8Array([30]) as any);

    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });
});
