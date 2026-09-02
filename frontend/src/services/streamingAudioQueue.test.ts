import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingAudioQueue, TTSPlayerAdapter } from './streamingAudioQueue.js';
import { DesktopAudioPlayer } from './desktopAudioPlayer.js';

describe('StreamingAudioQueue Unit Test Suite', () => {
  let mockPlayer: DesktopAudioPlayer;
  let playedAudios: string[];

  beforeEach(() => {
    playedAudios = [];
    mockPlayer = {
      play: vi.fn().mockImplementation(async (buf: ArrayBuffer) => {
        const str = new TextDecoder().decode(buf);
        playedAudios.push(str);
        // Small delay simulating physical audio playback duration
        await new Promise((res) => setTimeout(res, 20));
      }),
      stop: vi.fn(),
      state: 'STOPPED',
      isPlaying: false,
    } as any;
  });

  it('1. Multiple chunks & ordering: should synthesize concurrently and play strictly in order [chunk 0 -> chunk 1 -> chunk 2]', async () => {
    const mockSynthesize = vi.fn().mockImplementation(async (text: string) => {
      // Intentionally delay chunk 0 synthesis longer than chunk 1 to test order resolution
      if (text.includes('Chunk 0')) {
        await new Promise((res) => setTimeout(res, 40));
      } else {
        await new Promise((res) => setTimeout(res, 10));
      }
      return new TextEncoder().encode(`AudioFor:${text}`).buffer;
    });

    const adapter: TTSPlayerAdapter = {
      synthesize: mockSynthesize,
      player: mockPlayer,
    };

    const playedChunks: number[] = [];
    let completeFired = false;

    const queue = new StreamingAudioQueue(adapter, {
      onChunkStart: (idx) => playedChunks.push(idx),
      onQueueComplete: () => {
        completeFired = true;
      },
    });

    queue.pushChunk('Chunk 0: First phrase.');
    queue.pushChunk('Chunk 1: Second phrase.');
    queue.pushChunk('Chunk 2: Third phrase.');
    queue.markStreamComplete();

    // Await loop completion
    await new Promise((res) => setTimeout(res, 200));

    expect(playedChunks).toEqual([0, 1, 2]);
    expect(playedAudios).toEqual([
      'AudioFor:Chunk 0: First phrase.',
      'AudioFor:Chunk 1: Second phrase.',
      'AudioFor:Chunk 2: Third phrase.',
    ]);
    expect(completeFired).toBe(true);
  });

  it('2. Queue behavior & Gemini stream ending: should play queued items and fire onQueueComplete when stream ends', async () => {
    const adapter: TTSPlayerAdapter = {
      synthesize: async (t) => new TextEncoder().encode(`Audio:${t}`).buffer,
      player: mockPlayer,
    };

    let completeFired = false;
    const queue = new StreamingAudioQueue(adapter, {
      onQueueComplete: () => {
        completeFired = true;
      },
    });

    queue.pushChunk('Hello Afiya.');
    await new Promise((res) => setTimeout(res, 50));
    expect(completeFired).toBe(false);

    queue.markStreamComplete();
    await new Promise((res) => setTimeout(res, 50));
    expect(completeFired).toBe(true);
    expect(queue.isComplete).toBe(true);
  });

  it('3. Cancellation: should stop player, clear queue, and reject further processing when cancel() is called', async () => {
    const adapter: TTSPlayerAdapter = {
      synthesize: async (t) => {
        await new Promise((res) => setTimeout(res, 50));
        return new TextEncoder().encode(`Audio:${t}`).buffer;
      },
      player: mockPlayer,
    };

    let completeFired = false;
    const queue = new StreamingAudioQueue(adapter, {
      onQueueComplete: () => {
        completeFired = true;
      },
    });

    queue.pushChunk('Chunk 0 to be cancelled');
    queue.pushChunk('Chunk 1 to be cancelled');
    queue.cancel();

    await new Promise((res) => setTimeout(res, 100));

    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(completeFired).toBe(false);
    expect(queue.pushChunk('New Chunk')).toBe(-1);
  });

  it('4. TTS failure: should handle TTS synthesis errors gracefully without breaking queue playback', async () => {
    const adapter: TTSPlayerAdapter = {
      synthesize: async (text: string) => {
        if (text.includes('FAIL')) {
          throw new Error('TTS Network Error');
        }
        return new TextEncoder().encode(`Audio:${text}`).buffer;
      },
      player: mockPlayer,
    };

    const errors: Error[] = [];
    const playedChunks: number[] = [];

    const queue = new StreamingAudioQueue(adapter, {
      onChunkStart: (idx) => playedChunks.push(idx),
      onError: (err) => errors.push(err),
    });

    queue.pushChunk('Good Chunk 0.');
    queue.pushChunk('FAIL Chunk 1.');
    queue.pushChunk('Good Chunk 2.');
    queue.markStreamComplete();

    await new Promise((res) => setTimeout(res, 150));

    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('TTS Network Error');
    expect(playedChunks).toEqual([0, 2]); // Chunk 1 was skipped cleanly
  });
});
