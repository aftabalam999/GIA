/**
 * Converts 16-bit signed little-endian PCM bytes (S16LE)
 * into a Float32Array (-1.0 to +1.0).
 */
export function convertInt16LEToFloat32(pcmData: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = pcmData instanceof Uint8Array ? pcmData : new Uint8Array(pcmData);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true); // true = little-endian
    result[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
  }

  return result;
}

export class LiveAudioPlayer {
  private audioContext: AudioContext | null = null;
  private activeSourceNodes: Set<AudioBufferSourceNode> = new Set();
  private nextPlayTime: number = 0;
  private currentGenId: number = 0;
  private sampleRate: number;

  constructor(sampleRate: number = 24000) {
    this.sampleRate = sampleRate;
  }

  public get generationId(): number {
    return this.currentGenId;
  }

  public get isPlaying(): boolean {
    return this.activeSourceNodes.size > 0;
  }

  private getOrCreateAudioContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  /**
   * Enqueues a 24kHz Int16 S16LE PCM chunk for immediate streaming playback.
   */
  public playChunk(pcmChunk: ArrayBuffer | Uint8Array, genId: number = this.currentGenId): void {
    if (genId !== this.currentGenId) return;

    const float32Data = convertInt16LEToFloat32(pcmChunk);
    if (float32Data.length === 0) return;

    try {
      const ctx = this.getOrCreateAudioContext();
      const audioBuffer = ctx.createBuffer(1, float32Data.length, this.sampleRate);
      audioBuffer.copyToChannel(float32Data, 0);

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(ctx.destination);

      const currentTime = ctx.currentTime;
      const startTime = Math.max(currentTime, this.nextPlayTime);
      this.nextPlayTime = startTime + audioBuffer.duration;

      sourceNode.onended = () => {
        sourceNode.onended = null;
        sourceNode.disconnect();
        this.activeSourceNodes.delete(sourceNode);
      };

      this.activeSourceNodes.add(sourceNode);
      sourceNode.start(startTime);
    } catch (err: unknown) {
      console.error('Error playing 24kHz PCM chunk', err);
    }
  }

  /**
   * Halts active playback immediately and purges scheduled audio queues.
   */
  public stop(): void {
    this.currentGenId++; // Invalidate pending chunks
    this.nextPlayTime = 0;

    for (const sourceNode of this.activeSourceNodes) {
      try {
        sourceNode.onended = null;
        sourceNode.stop();
        sourceNode.disconnect();
      } catch {
        // ignore
      }
    }
    this.activeSourceNodes.clear();
  }

  public close(): void {
    this.stop();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
  }
}
