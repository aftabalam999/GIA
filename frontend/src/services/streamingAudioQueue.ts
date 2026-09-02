import { DesktopAudioPlayer } from './desktopAudioPlayer.js';
import { voiceLatencyTracker } from './voiceLatencyTracker.js';

export interface TTSPlayerAdapter {
  synthesize(text: string): Promise<ArrayBuffer>;
  player: DesktopAudioPlayer;
}

export interface StreamingAudioQueueCallbacks {
  onChunkStart?: (index: number, text: string) => void;
  onChunkEnd?: (index: number) => void;
  onQueueComplete?: () => void;
  onError?: (error: Error, index?: number) => void;
}

/**
 * StreamingAudioQueue coordinates concurrent TTS synthesis and strictly ordered,
 * non-overlapping audio playback for Afiya's real-time voice pipeline.
 * Supports response generation versioning to discard late audio chunks upon interruption.
 */
export class StreamingAudioQueue {
  private adapter: TTSPlayerAdapter;
  private callbacks: StreamingAudioQueueCallbacks;

  private textQueue: Array<{ index: number; text: string; genId: number }> = [];
  private audioMap: Map<number, { data: ArrayBuffer; genId: number }> = new Map();
  private failedMap: Map<number, boolean> = new Map();

  private nextSynthesizeIndex: number = 0;
  private nextPlayIndex: number = 0;
  private isStreamCompleted: boolean = false;
  private isPlayingLoop: boolean = false;
  private isCancelled: boolean = false;
  private currentGenId: number = 0;

  constructor(adapter: TTSPlayerAdapter, callbacks: StreamingAudioQueueCallbacks = {}, genId: number = 0) {
    this.adapter = adapter;
    this.callbacks = callbacks;
    this.currentGenId = genId;
  }

  public get generationId(): number {
    return this.currentGenId;
  }

  public setGenerationId(genId: number): void {
    this.currentGenId = genId;
  }

  public get pendingChunksCount(): number {
    return this.nextSynthesizeIndex - this.nextPlayIndex;
  }

  public get isComplete(): boolean {
    return this.isStreamCompleted && this.nextPlayIndex >= this.nextSynthesizeIndex;
  }

  /**
   * Enqueues a speech-ready text chunk for immediate TTS synthesis and ordered playback.
   */
  public pushChunk(text: string, genId: number = this.currentGenId): number {
    if (this.isCancelled || !text || text.trim().length === 0) return -1;
    if (genId !== this.currentGenId) return -1;

    const index = this.nextSynthesizeIndex++;
    this.textQueue.push({ index, text, genId });

    // Trigger concurrent synthesis asynchronously
    this.synthesizeNext(index, text, genId);

    // Trigger playback processing
    this.processPlaybackLoop();

    return index;
  }

  /**
   * Signals that Gemini response generation and text chunking have concluded.
   */
  public markStreamComplete(): void {
    if (this.isCancelled) return;
    this.isStreamCompleted = true;
    this.processPlaybackLoop();
  }

  /**
   * Immediately cancels active synthesis, halts audio playback, and purges all queued audio.
   */
  public cancel(): void {
    this.isCancelled = true;
    this.currentGenId++; // Increment generation to invalidate all pending async callbacks
    this.textQueue = [];
    this.audioMap.clear();
    this.failedMap.clear();

    try {
      this.adapter.player.stop();
    } catch {
      // ignore
    }

    this.isPlayingLoop = false;
  }

  /**
   * Asynchronously synthesizes TTS audio for a specific chunk index.
   */
  private async synthesizeNext(index: number, text: string, genId: number): Promise<void> {
    if (index === 0) {
      voiceLatencyTracker.record('firstTtsRequest');
    }
    try {
      const audioData = await this.adapter.synthesize(text);
      if (this.isCancelled || genId !== this.currentGenId) return;

      if (index === 0) {
        voiceLatencyTracker.record('firstTtsAudioReceived');
      }

      this.audioMap.set(index, { data: audioData, genId });
      this.processPlaybackLoop();
    } catch (err: any) {
      if (this.isCancelled || genId !== this.currentGenId) return;

      this.failedMap.set(index, true);
      if (this.callbacks.onError) {
        this.callbacks.onError(err instanceof Error ? err : new Error(String(err)), index);
      }
      this.processPlaybackLoop();
    }
  }

  /**
   * Serialized playback loop enforcing strict sequence order (chunk 0 -> chunk 1 -> chunk 2).
   */
  private async processPlaybackLoop(): Promise<void> {
    if (this.isPlayingLoop || this.isCancelled) return;
    this.isPlayingLoop = true;

    try {
      while (!this.isCancelled) {
        // Skip failed synthesis chunks cleanly without breaking the queue
        if (this.failedMap.has(this.nextPlayIndex)) {
          this.nextPlayIndex++;
          continue;
        }

        // Play next ordered chunk if audio data is ready in map
        if (this.audioMap.has(this.nextPlayIndex)) {
          const currentIndex = this.nextPlayIndex;
          const item = this.audioMap.get(currentIndex)!;

          // Discard late audio chunks from prior interrupted generation
          if (item.genId !== this.currentGenId || this.isCancelled) {
            this.audioMap.delete(currentIndex);
            this.nextPlayIndex++;
            continue;
          }

          const audioBuffer = item.data;
          this.audioMap.delete(currentIndex);

          const textItem = this.textQueue.find((t) => t.index === currentIndex);
          const chunkText = textItem ? textItem.text : '';

          if (currentIndex === 0) {
            voiceLatencyTracker.record('firstAudioPlayback');
          }

          if (this.callbacks.onChunkStart) {
            this.callbacks.onChunkStart(currentIndex, chunkText);
          }

          // Await physical audio completion (sourceNode.onended)
          await this.adapter.player.play(audioBuffer);

          if (this.isCancelled || item.genId !== this.currentGenId) break;

          if (this.callbacks.onChunkEnd) {
            this.callbacks.onChunkEnd(currentIndex);
          }

          this.nextPlayIndex++;
          continue;
        }

        // Check if stream is complete and all chunks have been played
        if (this.isStreamCompleted && this.nextPlayIndex >= this.nextSynthesizeIndex) {
          voiceLatencyTracker.record('completeResponsePlayback');
          voiceLatencyTracker.finishAndReport();
          if (this.callbacks.onQueueComplete) {
            this.callbacks.onQueueComplete();
          }
          break;
        }

        // Awaiting synthesis completion for nextPlayIndex or new incoming text chunks
        break;
      }
    } finally {
      this.isPlayingLoop = false;
    }
  }
}
