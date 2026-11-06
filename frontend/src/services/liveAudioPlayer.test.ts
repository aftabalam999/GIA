import { describe, it, expect } from 'vitest';
import {
  convertInt16LEToFloat32,
  LiveAudioPlayer,
} from './liveAudioPlayer.js';

describe('LiveAudioPlayer & 24kHz PCM Decoding Suite', () => {
  it('Test 6 & 12 — Int16 S16LE to Float32 Decoding: silence, positive max, and negative max', () => {
    // Create 3 Int16 samples: 0, 32767 (0x7FFF), -32768 (0x8000)
    const pcmBytes = new Uint8Array([
      0x00, 0x00, // 0
      0xff, 0x7f, // 32767
      0x00, 0x80, // -32768
    ]);

    const float32Data = convertInt16LEToFloat32(pcmBytes);

    expect(float32Data.length).toBe(3);
    expect(float32Data[0]).toBeCloseTo(0.0, 4);
    expect(float32Data[1]).toBeCloseTo(1.0, 4);
    expect(float32Data[2]).toBeCloseTo(-1.0, 4);
  });

  it('Test 14 & 15 — Generation Protection & Interruption: stop() increments generationId and ignores stale chunks', () => {
    const player = new LiveAudioPlayer(24000);
    const initialGenId = player.generationId;

    player.stop();

    const newGenId = player.generationId;
    expect(newGenId).toBe(initialGenId + 1);

    // Play chunk with stale genId
    const pcmBytes = new Uint8Array([0, 0, 100, 0]);
    player.playChunk(pcmBytes, initialGenId); // Should be ignored because generationId updated

    expect(player.isPlaying).toBe(false);

    player.close();
  });
});
