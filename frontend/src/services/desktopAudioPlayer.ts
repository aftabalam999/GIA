/**
 * GIA Phase 10: Desktop Audio Playback Layer
 * Manages desktop speech audio playback with explicit states:
 * STOPPED | PLAYING | PAUSED | STOPPING | ERROR
 */

export type PlaybackState = 'STOPPED' | 'PLAYING' | 'PAUSED' | 'STOPPING' | 'ERROR';

export interface DesktopAudioPlayerCallbacks {
  onStateChange?: (state: PlaybackState) => void;
  onEnded?: () => void;
  onError?: (errorMsg: string) => void;
}

export class DesktopAudioPlayer {
  private _state: PlaybackState = 'STOPPED';
  private _callbacks: DesktopAudioPlayerCallbacks = {};
  private _audioContext: AudioContext | null = null;
  private _sourceNode: AudioBufferSourceNode | null = null;
  private _audioBuffer: AudioBuffer | null = null;
  private _startTime: number = 0;
  private _pauseOffset: number = 0;
  private _isPlaying: boolean = false;

  constructor(callbacks: DesktopAudioPlayerCallbacks = {}) {
    this._callbacks = callbacks;
  }

  public get state(): PlaybackState {
    return this._state;
  }

  public get isPlaying(): boolean {
    return this._isPlaying;
  }

  public setCallbacks(callbacks: DesktopAudioPlayerCallbacks): void {
    this._callbacks = { ...this._callbacks, ...callbacks };
  }

  private setState(newState: PlaybackState): void {
    const prevState = this._state;
    this._state = newState;
    if (prevState !== newState && this._callbacks.onStateChange) {
      this._callbacks.onStateChange(newState);
    }
  }

  /**
   * Initializes or returns active Web Audio API AudioContext.
   */
  private getOrCreateAudioContext(): AudioContext {
    if (!this._audioContext || this._audioContext.state === 'closed') {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Web Audio API is not supported in this environment');
      }
      this._audioContext = new AudioContextClass();
    }
    if (this._audioContext.state === 'suspended') {
      this._audioContext.resume();
    }
    return this._audioContext;
  }

  /**
   * Decodes binary audio data (WAV/MP3) and begins playback.
   */
  public async play(audioData: ArrayBuffer | Buffer): Promise<void> {
    try {
      this.stop(); // Stop any active playback first

      const ctx = this.getOrCreateAudioContext();
      
      // Convert Buffer to ArrayBuffer if needed
      let bufferToDecode: ArrayBuffer;
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(audioData)) {
        bufferToDecode = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength) as ArrayBuffer;
      } else {
        bufferToDecode = audioData as ArrayBuffer;
      }

      this._audioBuffer = await ctx.decodeAudioData(bufferToDecode.slice(0));
      this._pauseOffset = 0;
      this._startSourceNode(0);
    } catch (err: any) {
      this.setState('ERROR');
      if (this._callbacks.onError) {
        this._callbacks.onError('Audio playback failed: ' + (err.message || String(err)));
      }
      this.setState('STOPPED');
    }
  }

  private _startSourceNode(offset: number): void {
    if (!this._audioContext || !this._audioBuffer) return;

    this._sourceNode = this._audioContext.createBufferSource();
    this._sourceNode.buffer = this._audioBuffer;
    this._sourceNode.connect(this._audioContext.destination);

    this._startTime = this._audioContext.currentTime - offset;

    this._sourceNode.onended = () => {
      if (this._state === 'PLAYING') {
        this._isPlaying = false;
        this.setState('STOPPED');
        if (this._callbacks.onEnded) {
          this._callbacks.onEnded();
        }
      }
    };

    this._sourceNode.start(0, offset);
    this._isPlaying = true;
    this.setState('PLAYING');
  }

  /**
   * Pauses active speech audio playback.
   */
  public pause(): void {
    if (this._state !== 'PLAYING' || !this._audioContext || !this._sourceNode) return;

    try {
      this._pauseOffset = this._audioContext.currentTime - this._startTime;
      this._sourceNode.onended = null; // Prevent onended trigger
      this._sourceNode.stop();
      this._sourceNode.disconnect();
      this._sourceNode = null;
      this._isPlaying = false;
      this.setState('PAUSED');
    } catch (err: any) {
      this.setState('ERROR');
      if (this._callbacks.onError) {
        this._callbacks.onError('Failed to pause audio playback: ' + err.message);
      }
    }
  }

  /**
   * Resumes paused speech audio playback.
   */
  public resume(): void {
    if (this._state !== 'PAUSED' || !this._audioBuffer) return;

    try {
      this._startSourceNode(this._pauseOffset);
    } catch (err: any) {
      this.setState('ERROR');
      if (this._callbacks.onError) {
        this._callbacks.onError('Failed to resume audio playback: ' + err.message);
      }
    }
  }

  /**
   * Halts speech audio playback immediately and disposes nodes.
   */
  public stop(): void {
    if (this._state === 'STOPPED') return;

    this.setState('STOPPING');

    if (this._sourceNode) {
      try {
        this._sourceNode.onended = null;
        this._sourceNode.stop();
        this._sourceNode.disconnect();
      } catch {
        // ignore
      }
      this._sourceNode = null;
    }

    this._audioBuffer = null;
    this._pauseOffset = 0;
    this._isPlaying = false;
    this.setState('STOPPED');
  }

  /**
   * Tears down AudioContext and disposes resources.
   */
  public close(): void {
    this.stop();
    if (this._audioContext && this._audioContext.state !== 'closed') {
      try {
        this._audioContext.close();
      } catch {
        // ignore
      }
      this._audioContext = null;
    }
  }
}
