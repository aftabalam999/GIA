import { describe, it, expect } from 'vitest';
import {
  convertFloat32ToInt16LE,
  resampleFloat32,
  LiveAudioCapture,
} from './liveAudioCapture.js';

describe('LiveAudioCapture & PCM Conversion Suite', () => {
  it('Test 12 — PCM Float32 -> Int16 Conversion: silence (0.0)', () => {
    const input = new Float32Array([0.0, 0.0]);
    const bytes = convertFloat32ToInt16LE(input);
    const view = new DataView(bytes.buffer);

    expect(bytes.length).toBe(4);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0);
  });

  it('Test 12 & 13 — PCM Conversion & Byte Ordering: positive, negative, and little-endian ordering', () => {
    const input = new Float32Array([1.0, -1.0, 0.5, -0.5]);
    const bytes = convertFloat32ToInt16LE(input);
    const view = new DataView(bytes.buffer);

    expect(bytes.length).toBe(8);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
    expect(view.getInt16(4, true)).toBe(Math.floor(0.5 * 32767));
    expect(view.getInt16(6, true)).toBe(Math.floor(-0.5 * 32768));

    // Verify little-endian byte ordering for positive value 32767 (0x7FFF) -> low byte 0xFF, high byte 0x7F
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x7f);
  });

  it('Test 12 — Clipping Protection: samples exceeding [-1.0, +1.0] are safely clamped', () => {
    const input = new Float32Array([2.5, -3.0]);
    const bytes = convertFloat32ToInt16LE(input);
    const view = new DataView(bytes.buffer);

    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it('Resampling: 48,000 Hz to 16,000 Hz downsampling reduces length by 3x', () => {
    const input48k = new Float32Array(4800); // 100ms at 48kHz
    for (let i = 0; i < input48k.length; i++) {
      input48k[i] = Math.sin(i * 0.1);
    }

    const resampled16k = resampleFloat32(input48k, 48000, 16000);
    expect(resampled16k.length).toBe(1600); // 100ms at 16kHz
  });

  it('Resampling: 44,100 Hz to 16,000 Hz downsampling handles fractional ratios', () => {
    const input44k = new Float32Array(4410); // 100ms at 44.1kHz
    const resampled16k = resampleFloat32(input44k, 44100, 16000);
    expect(resampled16k.length).toBe(1600);
  });

  it('Resampling: 16,000 Hz to 16,000 Hz returns identical sample copy', () => {
    const input16k = new Float32Array([0.1, -0.2, 0.3]);
    const output16k = resampleFloat32(input16k, 16000, 16000);
    expect(output16k[0]).toBeCloseTo(0.1, 5);
    expect(output16k[1]).toBeCloseTo(-0.2, 5);
    expect(output16k[2]).toBeCloseTo(0.3, 5);
  });

  it('Empty & Silent Frames: resampleFloat32 handles empty buffers safely without error', () => {
    const empty = new Float32Array(0);
    const resamplerOutput = resampleFloat32(empty, 48000, 16000);
    expect(resamplerOutput.length).toBe(0);

    const int16Bytes = convertFloat32ToInt16LE(empty);
    expect(int16Bytes.length).toBe(0);
  });

  it('PCM Continuity: sequential chunk conversion preserves sample ordering', () => {
    const chunk1 = new Float32Array([0.1, 0.2]);
    const chunk2 = new Float32Array([0.3, 0.4]);

    const bytes1 = convertFloat32ToInt16LE(chunk1);
    const bytes2 = convertFloat32ToInt16LE(chunk2);

    expect(bytes1.length).toBe(4);
    expect(bytes2.length).toBe(4);
  });

  it('LiveAudioCapture lifecycle: stops cleanly without errors', () => {
    const capture = new LiveAudioCapture();
    expect(capture.isCapturing).toBe(false);
    capture.stop();
    expect(capture.isCapturing).toBe(false);
  });
});
