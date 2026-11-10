import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWavBlobFromPcm, base64ToUint8Array } from './tauriMicrophone.js';
import { AudioRecorderService } from './audioRecorder.js';

const { mockInvoke, mockListeners } = vi.hoisted(() => {
  return {
    mockInvoke: vi.fn(),
    mockListeners: {} as Record<string, (event: any) => void>,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: any) => mockInvoke(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockImplementation((eventName: string, handler: any) => {
    mockListeners[eventName] = handler;
    return Promise.resolve(() => {
      delete mockListeners[eventName];
    });
  }),
}));

describe('Tauri Continuous Microphone Capture & WAV Packaging Suite', () => {
  describe('WAV Encoder & PCM Decoding', () => {
    it('base64ToUint8Array correctly converts base64 strings to raw bytes', () => {
      const raw = new Uint8Array([0, 1, 2, 127, 128, 255]);
      let binary = '';
      for (let i = 0; i < raw.length; i++) {
        binary += String.fromCharCode(raw[i]);
      }
      const b64 = btoa(binary);

      const decoded = base64ToUint8Array(b64);
      expect(decoded.length).toBe(raw.length);
      for (let i = 0; i < raw.length; i++) {
        expect(decoded[i]).toBe(raw[i]);
      }
    });

    it('createWavBlobFromPcm generates a compliant 44-byte RIFF/WAVE header', async () => {
      // 512 samples of 16-bit mono = 1024 bytes
      const pcmBytes = new Uint8Array(1024);
      for (let i = 0; i < pcmBytes.length; i++) {
        pcmBytes[i] = i % 256;
      }

      const blob = createWavBlobFromPcm(pcmBytes, 16000, 1);
      expect(blob.type).toBe('audio/wav');
      expect(blob.size).toBe(44 + 1024);

      const arrayBuffer = await blob.arrayBuffer();
      const view = new DataView(arrayBuffer);

      // Check RIFF header
      const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      expect(riff).toBe('RIFF');
      expect(view.getUint32(4, true)).toBe(36 + 1024);

      // Check WAVE header
      const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
      expect(wave).toBe('WAVE');

      // Check fmt subchunk
      const fmt = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
      expect(fmt).toBe('fmt ');
      expect(view.getUint32(16, true)).toBe(16); // PCM header size
      expect(view.getUint16(20, true)).toBe(1);  // Audio format 1 = PCM
      expect(view.getUint16(22, true)).toBe(1);  // Channels = 1
      expect(view.getUint32(24, true)).toBe(16000); // Sample rate = 16kHz
      expect(view.getUint32(28, true)).toBe(32000); // Byte rate = 16000 * 1 * 2 = 32000
      expect(view.getUint16(32, true)).toBe(2);  // Block align = 2
      expect(view.getUint16(34, true)).toBe(16); // Bits per sample = 16

      // Check data subchunk
      const data = String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39));
      expect(data).toBe('data');
      expect(view.getUint32(40, true)).toBe(1024); // PCM length
    });
  });

  describe('AudioRecorderService Native Tauri Mode Lifecycle', () => {
    beforeEach(() => {
      for (const k of Object.keys(mockListeners)) {
        delete mockListeners[k];
      }

      mockInvoke.mockReset();
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'check_microphone_permission' || cmd === 'request_microphone_permission') {
          return Promise.resolve({
            status: 'GRANTED',
            device_name: 'Mock MacBook Pro Microphone',
            message: 'Access granted',
          });
        }
        if (cmd === 'start_continuous_microphone_capture') {
          return Promise.resolve();
        }
        if (cmd === 'stop_continuous_microphone_capture') {
          return Promise.resolve();
        }
        return Promise.resolve({});
      });

      // Mock Tauri environment via globalThis.window
      const mockWin = {
        __TAURI_INTERNALS__: {
          invoke: mockInvoke,
        },
      };
      vi.stubGlobal('window', mockWin);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    it('starts continuous native capture in Tauri and processes audio frames', async () => {
      vi.useFakeTimers();
      const onSpeechStartMock = vi.fn();
      const onSpeechEndMock = vi.fn();
      const onUtteranceRecordedMock = vi.fn();

      const recorder = new AudioRecorderService({
        onSpeechStart: onSpeechStartMock,
        onSpeechEnd: onSpeechEndMock,
        onUtteranceRecorded: onUtteranceRecordedMock,
      });

      expect(recorder.hasReceivedFrames).toBe(false);

      await recorder.start();

      expect(mockInvoke).toHaveBeenCalledWith('request_microphone_permission', undefined);
      expect(mockInvoke).toHaveBeenCalledWith('start_continuous_microphone_capture', undefined);

      // Create a dummy 512-sample PCM chunk in base64
      const pcmBytes = new Uint8Array(1024);
      let binary = '';
      for (let i = 0; i < pcmBytes.length; i++) binary += String.fromCharCode(0);
      const b64 = btoa(binary);

      // Deliver silence frame
      const frameHandler = mockListeners['mic-audio-frame'];
      expect(frameHandler).toBeDefined();

      frameHandler({
        payload: {
          sample_rate: 16000,
          channels: 1,
          samples_count: 512,
          rms: 0.005, // Below speech threshold
          pcm_base64: b64,
        },
      });

      expect(recorder.hasReceivedFrames).toBe(true);
      expect(recorder.isSpeaking).toBe(false);

      // Deliver speech frames (> 0.015 threshold for > 100ms)
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(32);
        frameHandler({
          payload: {
            sample_rate: 16000,
            channels: 1,
            samples_count: 512,
            rms: 0.08,
            pcm_base64: b64,
          },
        });
      }

      expect(onSpeechStartMock).toHaveBeenCalledTimes(1);
      expect(recorder.isSpeaking).toBe(true);

      // Advance time beyond silence hangover (650ms)
      vi.advanceTimersByTime(700);

      // Deliver silence frame to trigger offset
      frameHandler({
        payload: {
          sample_rate: 16000,
          channels: 1,
          samples_count: 512,
          rms: 0.002,
          pcm_base64: b64,
        },
      });

      expect(onSpeechEndMock).toHaveBeenCalledTimes(1);
      expect(onUtteranceRecordedMock).toHaveBeenCalledTimes(1);
      const recordedBlob = onUtteranceRecordedMock.mock.calls[0][0];
      expect(recordedBlob).toBeInstanceOf(Blob);
      expect(recordedBlob.type).toBe('audio/wav');
      expect(recordedBlob.size).toBeGreaterThan(44);

      recorder.stop();
      expect(mockInvoke).toHaveBeenCalledWith('stop_continuous_microphone_capture', undefined);
      vi.useRealTimers();
    });

    it('pauses and resumes native audio input cleanly', async () => {
      const onSpeechStartMock = vi.fn();
      const recorder = new AudioRecorderService({
        onSpeechStart: onSpeechStartMock,
      });

      await recorder.start();
      const frameHandler = mockListeners['mic-audio-frame'];

      recorder.pause();

      // Send speech frame while paused
      frameHandler({
        payload: {
          sample_rate: 16000,
          channels: 1,
          samples_count: 512,
          rms: 0.09,
          pcm_base64: 'AAAA',
        },
      });

      // Should not trigger speech start while paused
      expect(onSpeechStartMock).not.toHaveBeenCalled();

      recorder.resume();

      // Send speech frames after resume
      for (let i = 0; i < 4; i++) {
        frameHandler({
          payload: {
            sample_rate: 16000,
            channels: 1,
            samples_count: 512,
            rms: 0.09,
            pcm_base64: 'AAAA',
          },
        });
      }

      expect(onSpeechStartMock).toHaveBeenCalledTimes(1);

      recorder.stop();
    });
  });
});
