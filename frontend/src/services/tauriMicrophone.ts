/**
 * GIA Native Desktop Microphone Service
 * Manages desktop microphone state and native capture IPC communication with Tauri/Rust.
 */
import { invoke } from '@tauri-apps/api/core';

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

export function base64ToBlob(base64: string, mimeType: string = 'audio/wav'): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

/**
 * Checks system microphone availability via Tauri native command.
 */
export async function checkNativeMicrophonePermission(): Promise<MicPermissionResponse> {
  try {
    return await invoke<MicPermissionResponse>('check_microphone_permission');
  } catch (err: any) {
    return {
      status: 'ERROR',
      message: `Failed to check microphone permission: ${err?.message || String(err)}`,
    };
  }
}

/**
 * Requests explicit desktop microphone access via Tauri native command.
 */
export async function requestNativeMicrophonePermission(): Promise<MicPermissionResponse> {
  try {
    return await invoke<MicPermissionResponse>('request_microphone_permission');
  } catch (err: any) {
    return {
      status: 'ERROR',
      message: `Failed to acquire microphone access: ${err?.message || String(err)}`,
    };
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
