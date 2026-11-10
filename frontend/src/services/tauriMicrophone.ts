/**
 * GIA Native Desktop Microphone Service
 * Manages desktop microphone state and native capture IPC communication with Tauri/Rust.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriEnvironment } from './tauriServices.js';

export type NativeMicState =
  | 'UNKNOWN'
  | 'CHECKING'
  | 'AVAILABLE'
  | 'REQUESTING'
  | 'GRANTED'
  | 'DENIED'
  | 'ERROR';

export interface MicPermissionResponse {
  status: 'GRANTED' | 'DENIED' | 'UNAVAILABLE' | 'ERROR';
  device_name?: string;
  message: string;
}

export interface MicCaptureTestResult {
  success: boolean;
  status: string;
  samples_captured: number;
  duration_seconds: number;
  max_amplitude: number;
  rms_volume: number;
  sample_rate: number;
  channels: number;
  wav_file_path: string;
  wav_base64?: string;
  error?: string;
}

export interface AudioFramePayload {
  sample_rate: number;
  channels: number;
  samples_count: number;
  rms: number;
  pcm_base64: string;
}

export function base64ToBlob(base64: string, mimeType: string = 'audio/wav'): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes raw 16-bit little-endian PCM bytes into a standard 44-byte RIFF/WAV format Blob.
 */
export function createWavBlobFromPcm(
  pcmBytes: Uint8Array,
  sampleRate: number = 16000,
  channels: number = 1
): Blob {
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const totalDataLen = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + totalDataLen);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  view.setUint8(0, 'R'.charCodeAt(0));
  view.setUint8(1, 'I'.charCodeAt(0));
  view.setUint8(2, 'F'.charCodeAt(0));
  view.setUint8(3, 'F'.charCodeAt(0));
  view.setUint32(4, 36 + totalDataLen, true);
  view.setUint8(8, 'W'.charCodeAt(0));
  view.setUint8(9, 'A'.charCodeAt(0));
  view.setUint8(10, 'V'.charCodeAt(0));
  view.setUint8(11, 'E'.charCodeAt(0));

  // "fmt " sub-chunk
  view.setUint8(12, 'f'.charCodeAt(0));
  view.setUint8(13, 'm'.charCodeAt(0));
  view.setUint8(14, 't'.charCodeAt(0));
  view.setUint8(15, ' '.charCodeAt(0));
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample (16 bits)

  // "data" sub-chunk
  view.setUint8(36, 'd'.charCodeAt(0));
  view.setUint8(37, 'a'.charCodeAt(0));
  view.setUint8(38, 't'.charCodeAt(0));
  view.setUint8(39, 'a'.charCodeAt(0));
  view.setUint32(40, totalDataLen, true);

  const wavArray = new Uint8Array(buffer);
  wavArray.set(pcmBytes, 44);

  return new Blob([wavArray], { type: 'audio/wav' });
}

/**
 * Checks system microphone availability via Tauri native command or browser mediaDevices.
 */
export async function checkNativeMicrophonePermission(): Promise<MicPermissionResponse> {
  const runtimeType = isTauriEnvironment() ? 'tauri' : 'browser';
  if (!isTauriEnvironment()) {
    if (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      const res: MicPermissionResponse = {
        status: 'GRANTED',
        device_name: 'Browser Default Microphone',
        message: 'Browser WebAudio capture available.',
      };
      console.log('[MIC_DIAGNOSTIC] checkNativeMicrophonePermission:', { runtimeType, result: res });
      return res;
    }
    const res: MicPermissionResponse = {
      status: 'UNAVAILABLE',
      message: 'Browser mediaDevices API not supported.',
    };
    console.log('[MIC_DIAGNOSTIC] checkNativeMicrophonePermission:', { runtimeType, result: res });
    return res;
  }
  try {
    const res = await invoke<MicPermissionResponse>('check_microphone_permission');
    console.log('[MIC_DIAGNOSTIC] checkNativeMicrophonePermission:', { runtimeType, result: res });
    return res;
  } catch (err: any) {
    const res: MicPermissionResponse = {
      status: 'ERROR',
      message: `Failed to check microphone permission: ${err?.message || String(err)}`,
    };
    console.warn('[MIC_DIAGNOSTIC] checkNativeMicrophonePermission error:', { runtimeType, error: res.message });
    return res;
  }
}

/**
 * Requests explicit desktop microphone access via Tauri native command or browser mediaDevices.
 */
export async function requestNativeMicrophonePermission(): Promise<MicPermissionResponse> {
  const runtimeType = isTauriEnvironment() ? 'tauri' : 'browser';
  if (!isTauriEnvironment()) {
    if (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        const res: MicPermissionResponse = {
          status: 'GRANTED',
          device_name: 'Browser Default Microphone',
          message: 'Browser microphone access acquired successfully.',
        };
        console.log('[MIC_DIAGNOSTIC] requestNativeMicrophonePermission:', { runtimeType, result: res });
        return res;
      } catch (err: any) {
        const res: MicPermissionResponse = {
          status: 'DENIED',
          message: `Browser microphone permission denied: ${err?.message || String(err)}`,
        };
        console.warn('[MIC_DIAGNOSTIC] requestNativeMicrophonePermission denied:', { runtimeType, result: res });
        return res;
      }
    }
    const res: MicPermissionResponse = {
      status: 'UNAVAILABLE',
      message: 'Browser mediaDevices API not supported.',
    };
    console.log('[MIC_DIAGNOSTIC] requestNativeMicrophonePermission:', { runtimeType, result: res });
    return res;
  }
  try {
    const res = await invoke<MicPermissionResponse>('request_microphone_permission');
    console.log('[MIC_DIAGNOSTIC] requestNativeMicrophonePermission:', { runtimeType, result: res });
    return res;
  } catch (err: any) {
    const res: MicPermissionResponse = {
      status: 'ERROR',
      message: `Failed to acquire microphone access: ${err?.message || String(err)}`,
    };
    console.error('[MIC_DIAGNOSTIC] requestNativeMicrophonePermission error:', { runtimeType, error: res.message });
    return res;
  }
}

/**
 * Starts continuous native microphone capture in Tauri via CPAL (16kHz mono).
 */
export async function startContinuousMicrophoneCapture(): Promise<void> {
  if (!isTauriEnvironment()) return;
  await invoke('start_continuous_microphone_capture');
}

/**
 * Stops continuous native microphone capture in Tauri.
 */
export async function stopContinuousMicrophoneCapture(): Promise<void> {
  if (!isTauriEnvironment()) return;
  await invoke('stop_continuous_microphone_capture');
}

/**
 * Subscribes to continuous 16kHz PCM audio frames emitted from the Tauri native audio thread.
 */
export async function listenToMicrophoneAudioFrames(
  callback: (frame: AudioFramePayload) => void
): Promise<() => void> {
  if (!isTauriEnvironment()) return () => {};
  try {
    const unlisten = await listen<AudioFramePayload>('mic-audio-frame', (event) => {
      callback(event.payload);
    });
    return unlisten;
  } catch (err) {
    console.error('[MIC_DIAGNOSTIC] Failed to listen to mic-audio-frame events:', err);
    return () => {};
  }
}

/**
 * Subscribes to microphone capture error events emitted from Tauri.
 */
export async function listenToMicrophoneCaptureError(
  callback: (errorMessage: string) => void
): Promise<() => void> {
  if (!isTauriEnvironment()) return () => {};
  try {
    const unlisten = await listen<string>('mic-capture-error', (event) => {
      callback(event.payload);
    });
    return unlisten;
  } catch (err) {
    console.error('[MIC_DIAGNOSTIC] Failed to listen to mic-capture-error events:', err);
    return () => {};
  }
}

/**
 * Runs a minimal native microphone capture test (~5s) to verify raw PCM audio frames.
 */
export async function startNativeMicrophoneTestCapture(durationSecs: number = 5): Promise<MicCaptureTestResult> {
  try {
    return await invoke<MicCaptureTestResult>('start_microphone_test_capture', {
      durationSecs: durationSecs,
    });
  } catch (err: any) {
    return {
      success: false,
      status: 'ERROR',
      samples_captured: 0,
      duration_seconds: 0,
      max_amplitude: 0,
      rms_volume: 0,
      sample_rate: 0,
      channels: 0,
      wav_file_path: '',
      error: `Native capture test failed: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Stops an active native capture test cleanly.
 */
export async function stopNativeMicrophoneTestCapture(): Promise<void> {
  try {
    await invoke('stop_microphone_test_capture');
  } catch {
    // ignore
  }
}
