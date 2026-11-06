import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioRecorderService } from './audioRecorder.js';

describe('AudioRecorderService VAD Pause Guard Unit Tests', () => {
  let mockMediaStream: any;
  let mockMediaRecorder: any;
  let mockAudioContext: any;
  let mockAnalyserNode: any;
  let animCallback: FrameRequestCallback | null = null;

  beforeEach(() => {
    animCallback = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      animCallback = cb;
      return 123;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    mockMediaStream = {
      getTracks: vi.fn().mockReturnValue([{ stop: vi.fn() }]),
    };

    mockMediaRecorder = {
      state: 'recording',
      start: vi.fn(),
      stop: vi.fn().mockImplementation(function (this: any) {
        if (this.onstop) this.onstop();
      }),
      ondataavailable: null,
      onstop: null,
    };

    mockAnalyserNode = {
      fftSize: 512,
      frequencyBinCount: 256,
      getByteFrequencyData: vi.fn().mockImplementation((array: Uint8Array) => {
        // Simulate high volume above threshold
        array.fill(100);
      }),
    };

    mockAudioContext = {
      state: 'running',
      createMediaStreamSource: vi.fn().mockReturnValue({
        connect: vi.fn(),
      }),
      createAnalyser: vi.fn().mockReturnValue(mockAnalyserNode),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.stubGlobal('MediaRecorder', vi.fn().mockImplementation(() => mockMediaRecorder));
    (MediaRecorder as any).isTypeSupported = vi.fn().mockReturnValue(true);

    vi.stubGlobal('AudioContext', vi.fn().mockImplementation(() => mockAudioContext));
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(mockMediaStream),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should suppress volume/VAD calculations and speech start events while isPaused is true', async () => {
    const onSpeechStartMock = vi.fn();
    const onUtteranceRecordedMock = vi.fn();

    const recorder = new AudioRecorderService({
      onSpeechStart: onSpeechStartMock,
      onUtteranceRecorded: onUtteranceRecordedMock,
    });

    await recorder.start();
    
    // Clear initial start calls
    mockAnalyserNode.getByteFrequencyData.mockClear();
    onSpeechStartMock.mockClear();

    // Pause recorder
    recorder.pause();

    // Trigger next animation frame
    if (animCallback) {
      (animCallback as Function)();
    }

    // While paused, getByteFrequencyData must NOT be called and onSpeechStart must NOT fire
    expect(mockAnalyserNode.getByteFrequencyData).not.toHaveBeenCalled();
    expect(onSpeechStartMock).not.toHaveBeenCalled();

    // Resume recorder
    recorder.resume();

    // Trigger next animation frame
    if (animCallback) {
      (animCallback as Function)();
    }

    // After resume, getByteFrequencyData must run and detect speech
    expect(mockAnalyserNode.getByteFrequencyData).toHaveBeenCalledTimes(1);
    expect(onSpeechStartMock).toHaveBeenCalledTimes(1);

    recorder.stop();
  });
});
