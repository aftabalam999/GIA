import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesktopAudioPlayer } from './desktopAudioPlayer.js';

describe('DesktopAudioPlayer Playback Completion Unit Tests', () => {
  let mockAudioContext: any;
  let mockSourceNode: any;

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
      decodeAudioData: vi.fn().mockImplementation(async (_buf: ArrayBuffer) => {
        return { duration: 2.0, length: 88200, numberOfChannels: 2, sampleRate: 44100 } as any;
      }),
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (globalThis as any).AudioContext = vi.fn().mockImplementation(() => mockAudioContext);
    (globalThis as any).window = globalThis;
  });

  it('should defer play() promise resolution until sourceNode.onended is fired', async () => {
    const onEndedMock = vi.fn();
    const player = new DesktopAudioPlayer({ onEnded: onEndedMock });

    const dummyAudioBuffer = new ArrayBuffer(64);
    let resolved = false;

    const playPromise = player.play(dummyAudioBuffer).then(() => {
      resolved = true;
    });

    // Wait a macro-task tick to allow decodeAudioData and startSourceNode to execute
    await new Promise((r) => setTimeout(r, 10));

    // After startSourceNode, player state must be PLAYING, but playPromise must NOT be resolved yet
    expect(player.state).toBe('PLAYING');
    expect(player.isPlaying).toBe(true);
    expect(resolved).toBe(false);

    // Trigger Web Audio API sourceNode.onended event
    mockSourceNode.onended();

    await playPromise;

    expect(resolved).toBe(true);
    expect(player.state).toBe('STOPPED');
    expect(player.isPlaying).toBe(false);
    expect(onEndedMock).toHaveBeenCalledTimes(1);
  });

  it('should resolve pending play() promise if stop() is explicitly called during playback', async () => {
    const player = new DesktopAudioPlayer();
    const dummyAudioBuffer = new ArrayBuffer(64);
    let resolved = false;

    const playPromise = player.play(dummyAudioBuffer).then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    player.stop();

    await playPromise;
    expect(resolved).toBe(true);
    expect(player.state).toBe('STOPPED');
  });

  it('should reject play() promise if decodeAudioData fails', async () => {
    const onErrorMock = vi.fn();
    mockAudioContext.decodeAudioData.mockRejectedValueOnce(new Error('Corrupt audio data'));

    const player = new DesktopAudioPlayer({ onError: onErrorMock });
    const dummyAudioBuffer = new ArrayBuffer(64);

    await expect(player.play(dummyAudioBuffer)).rejects.toThrow('Corrupt audio data');
    expect(player.state).toBe('STOPPED');
    expect(onErrorMock).toHaveBeenCalledWith('Audio playback failed: Corrupt audio data');
  });
});
