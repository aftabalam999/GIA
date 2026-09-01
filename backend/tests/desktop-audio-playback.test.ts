import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoiceStateMachine, VoiceState } from '../../frontend/src/services/voiceStateMachine.js';

class MockAudioPlayer {
  public state: 'STOPPED' | 'PLAYING' | 'PAUSED' | 'STOPPING' | 'ERROR' = 'STOPPED';
  public onStateChange?: (state: string) => void;
  public onEnded?: () => void;
  private _resolvePlay?: () => void;

  public play(data: any): Promise<void> {
    this.state = 'PLAYING';
    if (this.onStateChange) this.onStateChange(this.state);
    return new Promise((resolve) => {
      this._resolvePlay = resolve;
    });
  }

  public pause(): void {
    if (this.state === 'PLAYING') {
      this.state = 'PAUSED';
      if (this.onStateChange) this.onStateChange(this.state);
    }
  }

  public resume(): void {
    if (this.state === 'PAUSED') {
      this.state = 'PLAYING';
      if (this.onStateChange) this.onStateChange(this.state);
    }
  }

  public stop(): void {
    this.state = 'STOPPING';
    if (this.onStateChange) this.onStateChange(this.state);
    this.state = 'STOPPED';
    if (this.onStateChange) this.onStateChange(this.state);
    if (this._resolvePlay) {
      this._resolvePlay();
      this._resolvePlay = undefined;
    }
  }

  public simulatePlaybackCompletion(): void {
    if (this.state === 'PLAYING') {
      this.state = 'STOPPED';
      if (this.onStateChange) this.onStateChange(this.state);
      if (this.onEnded) this.onEnded();
      if (this._resolvePlay) {
        this._resolvePlay();
        this._resolvePlay = undefined;
      }
    }
  }
}

describe('GIA Phase 10: Tauri Desktop Audio Playback & Feedback Control Suite', () => {
  let vsm: VoiceStateMachine;
  let player: MockAudioPlayer;
  let stateHistory: VoiceState[];

  beforeEach(() => {
    stateHistory = [];
    player = new MockAudioPlayer();
    vsm = new VoiceStateMachine({
      onStateChange: (s) => stateHistory.push(s),
      playAudioApi: (buf) => player.play(buf),
    });
  });

  it('should initialize player in STOPPED state', () => {
    expect(player.state).toBe('STOPPED');
  });

  it('should control playback transitions: STOPPED -> PLAYING -> PAUSED -> PLAYING -> STOPPED', async () => {
    const playPromise = player.play(new Uint8Array([1, 2, 3]));
    expect(player.state).toBe('PLAYING');

    player.pause();
    expect(player.state).toBe('PAUSED');

    player.resume();
    expect(player.state).toBe('PLAYING');

    player.stop();
    expect(player.state).toBe('STOPPED');
    await playPromise;
  });

  it('should suppress audio feedback (prevent GIA from transcribing her own output while PLAYING)', async () => {
    await vsm.startVoiceMode('convo-123', 'token-abc');

    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'Hello' });
    const mockChat = vi.fn().mockResolvedValue({ assistantMessage: { content: 'Hi there' } });
    const mockTts = vi.fn().mockResolvedValue(new ArrayBuffer(10));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
      playAudioApi: (buf) => player.play(buf),
    });

    // Start speech utterance processing
    vsm.handleSpeechStart();
    const processPromise = vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    // Wait until state reaches PLAYING
    await new Promise((r) => setTimeout(r, 20));
    expect(vsm.state).toBe('PLAYING');
    expect(player.state).toBe('PLAYING');

    // Attempt to trigger VAD speech start while GIA is speaking aloud
    vsm.handleSpeechStart();
    expect(vsm.state).toBe('PLAYING'); // Must remain in PLAYING! Mic feedback suppressed!

    // Finish audio playback
    player.simulatePlaybackCompletion();
    await processPromise;

    expect(vsm.state).toBe('LISTENING'); // Re-arms VAD listening only AFTER playback finishes!
  });

  it('should execute interruption behavior when user stops voice mode while GIA is speaking', async () => {
    await vsm.startVoiceMode('convo-123', 'token-abc');

    vsm.setCallbacks({
      fetchTranscribeApi: vi.fn().mockResolvedValue({ text: 'Interruption test' }),
      fetchChatApi: vi.fn().mockResolvedValue({ assistantMessage: { content: 'Speaking text...' } }),
      fetchTtsApi: vi.fn().mockResolvedValue(new ArrayBuffer(10)),
      playAudioApi: (buf) => player.play(buf),
    });

    vsm.handleSpeechStart();
    const processPromise = vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    await new Promise((r) => setTimeout(r, 20));
    expect(vsm.state).toBe('PLAYING');

    // USER INTERRUPTS: Manually stops voice mode while GIA is speaking
    await vsm.stopVoiceMode();
    player.stop();

    await processPromise;

    expect(player.state).toBe('STOPPED');
    expect(vsm.state).toBe('IDLE');
    expect(vsm.isVoiceModeOn).toBe(false);
  });
});
