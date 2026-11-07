import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { DesktopAudioPlayer } from './desktopAudioPlayer.js';
import { AudioRecorderService } from './audioRecorder.js';

describe('Tauri TTS Playback and Echo Suppression Verification Suite', () => {
  let mockAudioContext: any;
  let mockSourceNode: any;
  let mockMediaStream: any;
  let mockMediaRecorder: any;

  beforeEach(() => {
    mockSourceNode = {
      buffer: null,
      onended: null as any,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockAudioContext = {
      state: 'running',
      currentTime: 10,
      createBufferSource: vi.fn().mockReturnValue(mockSourceNode),
      createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn() }),
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 512,
        frequencyBinCount: 256,
        getFloatTimeDomainData: vi.fn(),
        getByteTimeDomainData: vi.fn(),
        getByteFrequencyData: vi.fn(),
      }),
      decodeAudioData: vi.fn().mockImplementation(async (_buf: ArrayBuffer) => {
        return { duration: 3.5, length: 84000, numberOfChannels: 1, sampleRate: 24000 } as any;
      }),
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.stubGlobal('AudioContext', vi.fn().mockImplementation(() => mockAudioContext));
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockImplementation((_cb: FrameRequestCallback) => {
      return 101;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    mockMediaStream = {
      getTracks: vi.fn().mockReturnValue([{ stop: vi.fn() }]),
      getAudioTracks: vi.fn().mockReturnValue([{ readyState: 'live', stop: vi.fn(), onended: null }]),
    };

    mockMediaRecorder = {
      state: 'recording',
      start: vi.fn(),
      stop: vi.fn(),
      requestData: vi.fn(),
      ondataavailable: null as any,
      onstop: null as any,
    };

    vi.stubGlobal('MediaRecorder', vi.fn().mockImplementation(() => mockMediaRecorder));
    (MediaRecorder as any).isTypeSupported = vi.fn().mockReturnValue(true);

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mockMediaStream),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Requirement 1-3 & 5-6 & 9: Five consecutive speech/playback cycles execute cleanly with strict echo suppression', async () => {
    let micPaused = false;
    let micResumeCount = 0;
    let micPauseCount = 0;
    let playStartCount = 0;
    let playCompleteCount = 0;

    const recorder = new AudioRecorderService({
      onSpeechStart: vi.fn(),
      onUtteranceRecorded: vi.fn(),
    });
    await recorder.start();
    expect(recorder.hasReceivedFrames).toBe(true);

    const player = new DesktopAudioPlayer({
      onStateChange: (s) => {
        if (s === 'PLAYING') playStartCount++;
        if (s === 'STOPPED') playCompleteCount++;
      },
    });

    const vsm = new VoiceStateMachine({
      onPauseCapture: () => {
        micPaused = true;
        micPauseCount++;
        recorder.pause();
      },
      onResumeCapture: () => {
        micPaused = false;
        micResumeCount++;
        recorder.resume();
      },
      fetchTranscribeApi: async (_blob) => {
        return { text: 'Test query' };
      },
      fetchChatApi: async (_convoId, text) => {
        return { assistantMessage: { content: 'Reply to: ' + text } };
      },
      fetchTtsApi: async (_text) => {
        return new ArrayBuffer(1024); // Simulated Kokoro WAV buffer
      },
      playAudioApi: async (buf) => {
        await player.play(buf);
      },
    });

    await vsm.startVoiceMode('convo-test', 'token-test', false);
    expect(vsm.state).toBe('LISTENING');

    // Run 5 consecutive speech/playback cycles
    for (let cycle = 1; cycle <= 5; cycle++) {
      // 1. User speaks -> process utterance
      const speechPromise = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

      // Wait for player to enter PLAYING
      let waitCount = 0;
      while (player.state !== 'PLAYING' && waitCount < 50) {
        await new Promise((r) => setTimeout(r, 10));
        waitCount++;
      }

      // While audio is playing:
      expect(player.state).toBe('PLAYING');
      expect(micPaused).toBe(true); // Microphone MUST be paused during playback
      expect(vsm.state).toBe('PLAYING');

      // Attempt to feed simulated audio into microphone while Afiya is speaking (Echo suppression test)
      expect((recorder as any).isPaused).toBe(true);
      expect(recorder.isSpeaking).toBe(false);

      // Simulate speaker playback completion (macOS audio output completes)
      if (mockSourceNode.onended) {
        mockSourceNode.onended();
      }

      await speechPromise;

      // After playback finishes, wait for turn-taking guard delay (50ms)
      await new Promise((r) => setTimeout(r, 70));

      // Microphone MUST now be resumed
      expect(player.state).toBe('STOPPED');
      expect(micPaused).toBe(false);
      expect((recorder as any).isPaused).toBe(false);
      expect(vsm.state).toBe('LISTENING');
    }

    expect(playStartCount).toBe(5);
    expect(playCompleteCount).toBe(5);
    expect(micPauseCount).toBeGreaterThanOrEqual(5);
    expect(micResumeCount).toBeGreaterThanOrEqual(5);

    // Teardown
    recorder.stop();
    player.stop();
    await vsm.stopVoiceMode();
    expect(vsm.state).toBe('IDLE');
  });

  it('Requirement 4 & 7: Playback or synthesis failure does not leave microphone permanently disabled', async () => {
    let micPaused = false;

    const recorder = new AudioRecorderService();
    await recorder.start();

    const vsm = new VoiceStateMachine({
      onPauseCapture: () => {
        micPaused = true;
        recorder.pause();
      },
      onResumeCapture: () => {
        micPaused = false;
        recorder.resume();
      },
      fetchTranscribeApi: async () => ({ text: 'Failing speech command' }),
      fetchChatApi: async () => ({ assistantMessage: { content: 'Synthesize error reply' } }),
      fetchTtsApi: async () => {
        throw new Error('Kokoro TTS synthesis engine timeout');
      },
      playAudioApi: async () => {},
    });

    await vsm.startVoiceMode('convo-test', 'token-test', false);
    expect(vsm.state).toBe('LISTENING');

    // Utterance with TTS error
    await vsm.processSpeechUtterance(new Uint8Array([1, 2]) as any);

    // State machine MUST recover to LISTENING and unpause microphone
    expect(vsm.state).toBe('LISTENING');
    expect(micPaused).toBe(false);
    expect((recorder as any).isPaused).toBe(false);

    recorder.stop();
    await vsm.stopVoiceMode();
  });

  it('Requirement 8: Stopping voice mode immediately halts playback and capture', async () => {
    let playerStopped = false;
    let recorderStopped = false;

    const player = new DesktopAudioPlayer({
      onStateChange: (s) => {
        if (s === 'STOPPED') playerStopped = true;
      },
    });

    const recorder = new AudioRecorderService();
    await recorder.start();

    const vsm = new VoiceStateMachine({
      onPauseCapture: () => recorder.pause(),
      onResumeCapture: () => recorder.resume(),
      fetchTtsApi: async () => new ArrayBuffer(64),
      playAudioApi: async (b) => {
        await player.play(b);
      },
    });

    await vsm.startVoiceMode('convo-test', 'token-test', false);
    const speechPromise = vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    let waitCount = 0;
    while (player.state !== 'PLAYING' && waitCount < 50) {
      await new Promise((r) => setTimeout(r, 10));
      waitCount++;
    }

    expect(player.state).toBe('PLAYING');

    // Emergency stop requested by user
    player.stop();
    recorder.stop();
    recorderStopped = true;
    await vsm.stopVoiceMode();

    await speechPromise;

    expect(vsm.state).toBe('IDLE');
    expect(player.state).toBe('STOPPED');
    expect(playerStopped).toBe(true);
    expect(recorderStopped).toBe(true);
  });

  it('Requirement 10: Echo suppression prevents assistant output from re-triggering speech detection', async () => {
    const onSpeechStartMock = vi.fn();
    const recorder = new AudioRecorderService({
      onSpeechStart: onSpeechStartMock,
    });
    await recorder.start();

    // While playing TTS, voice state machine pauses recorder:
    recorder.pause();
    expect((recorder as any).isPaused).toBe(true);

    // Simulate speaker acoustic feedback reaching the microphone (high energy frame)
    const vad = (recorder as any).vad;
    vad.processAudioFrame(0.12, 100, Date.now()); // High amplitude RMS = 0.12
    vad.processAudioFrame(0.15, 100, Date.now() + 100);

    // onSpeechStart MUST NOT be called because audioInputEnabled is false
    expect(onSpeechStartMock).not.toHaveBeenCalled();
    expect(vad.isSpeaking).toBe(false);

    // Resume capture after playback
    recorder.resume();
    expect((recorder as any).isPaused).toBe(false);

    // Real user speech after playback completes
    vad.processAudioFrame(0.08, 100, Date.now() + 500);
    vad.processAudioFrame(0.08, 100, Date.now() + 600);

    expect(vad.isSpeaking).toBe(true);
    expect(onSpeechStartMock).toHaveBeenCalledTimes(1);

    recorder.stop();
  });
});
