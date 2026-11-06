export interface VadOptions {
  speechThreshold?: number;
  minSpeechDurationMs?: number;
  silenceDurationMs?: number;
  interruptionThreshold?: number;
  minInterruptionDurationMs?: number;
  allowBargeIn?: boolean;
}

export interface VadCallbacks {
  onSpeechStart?: () => void;
  onSpeechEnd?: (durationMs: number) => void;
  onSpeechLevel?: (level: number) => void;
  onInterruption?: () => void;
}

/**
 * LocalVAD provides a lightweight, local Voice Activity Detection engine based on audio energy (RMS).
 * Supports both normal speech detection and conservative barge-in interruption detection during TTS output.
 */
export class LocalVAD {
  private speechThreshold: number;
  private minSpeechDurationMs: number;
  private silenceDurationMs: number;
  private interruptionThreshold: number;
  private minInterruptionDurationMs: number;

  private isSpeakingInternal: boolean = false;
  private speechStartTime: number | null = null;
  private lastAboveThresholdTime: number | null = null;
  private consecutiveSpeechMs: number = 0;
  private consecutiveInterruptionMs: number = 0;

  private isRunning: boolean = false;
  private audioInputEnabled: boolean = true;
  private isBargeInMode: boolean = false;

  private callbacks: VadCallbacks = {};

  constructor(options: VadOptions = {}, callbacks: VadCallbacks = {}) {
    this.speechThreshold = options.speechThreshold ?? 0.015;
    this.minSpeechDurationMs = options.minSpeechDurationMs ?? 100;
    this.silenceDurationMs = options.silenceDurationMs ?? 650;
    this.interruptionThreshold = options.interruptionThreshold ?? 0.045;
    this.minInterruptionDurationMs = options.minInterruptionDurationMs ?? 200;
    this.isBargeInMode = options.allowBargeIn ?? false;
    this.callbacks = callbacks;
  }

  public get isSpeaking(): boolean {
    return this.isSpeakingInternal;
  }

  public get active(): boolean {
    return this.isRunning;
  }

  public get bargeInMode(): boolean {
    return this.isBargeInMode;
  }

  public setAudioInputEnabled(enabled: boolean): void {
    this.audioInputEnabled = enabled;
    if (!enabled && this.isSpeakingInternal) {
      this.reset();
    }
  }

  public setBargeInMode(enabled: boolean): void {
    this.isBargeInMode = enabled;
    this.consecutiveInterruptionMs = 0;
  }

  public setCallbacks(callbacks: VadCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public start(): void {
    this.reset();
    this.isRunning = true;
  }

  public stop(): void {
    this.reset();
    this.isRunning = false;
  }

  public reset(): void {
    this.isSpeakingInternal = false;
    this.speechStartTime = null;
    this.lastAboveThresholdTime = null;
    this.consecutiveSpeechMs = 0;
    this.consecutiveInterruptionMs = 0;
  }

  /**
   * Processes a single audio frame represented by RMS energy or Float32Array PCM samples.
   * @param frame RMS float value [0..1] or Float32Array PCM buffer
   * @param frameDurationMs Duration of frame in milliseconds (default 50ms)
   * @param nowTimestamp Current timestamp in ms (defaults to Date.now())
   */
  public processAudioFrame(frame: number | Float32Array, frameDurationMs: number = 50, nowTimestamp: number = Date.now()): void {
    if (!this.isRunning) return;

    let rms = 0;
    if (typeof frame === 'number') {
      rms = frame;
    } else {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) {
        sum += frame[i] * frame[i];
      }
      rms = frame.length > 0 ? Math.sqrt(sum / frame.length) : 0;
    }

    if (this.callbacks.onSpeechLevel) {
      this.callbacks.onSpeechLevel(rms);
    }

    // --- BARGE-IN INTERRUPTION DETECTION DURING TTS OUTPUT ---
    if (this.isBargeInMode) {
      if (rms >= this.interruptionThreshold) {
        this.consecutiveInterruptionMs += frameDurationMs;
        if (this.consecutiveInterruptionMs >= this.minInterruptionDurationMs) {
          console.log('[VAD] barge-in-detected');
          this.consecutiveInterruptionMs = 0;
          if (this.callbacks.onInterruption) {
            this.callbacks.onInterruption();
          }
        }
      } else {
        this.consecutiveInterruptionMs = 0;
      }
      // If normal audio input is disabled while playing, skip normal speech processing
      if (!this.audioInputEnabled) return;
    }

    if (!this.audioInputEnabled) return;

    // --- NORMAL SPEECH START / SPEECH END DETECTION ---
    const isAbove = rms >= this.speechThreshold;

    if (isAbove) {
      this.lastAboveThresholdTime = nowTimestamp;
      this.consecutiveSpeechMs += frameDurationMs;

      if (!this.isSpeakingInternal) {
        if (this.consecutiveSpeechMs >= this.minSpeechDurationMs) {
          this.isSpeakingInternal = true;
          this.speechStartTime = nowTimestamp - this.consecutiveSpeechMs;
          console.log('[VAD] speech-start');
          if (this.callbacks.onSpeechStart) {
            this.callbacks.onSpeechStart();
          }
        }
      }
    } else {
      // Below threshold
      this.consecutiveSpeechMs = 0;

      if (this.isSpeakingInternal) {
        const timeSinceLastSpeech = this.lastAboveThresholdTime ? nowTimestamp - this.lastAboveThresholdTime : 0;
        if (timeSinceLastSpeech >= this.silenceDurationMs) {
          const duration = this.speechStartTime ? nowTimestamp - this.speechStartTime : 0;
          this.isSpeakingInternal = false;
          this.speechStartTime = null;
          this.lastAboveThresholdTime = null;
          console.log('[VAD] speech-end');
          if (this.callbacks.onSpeechEnd) {
            this.callbacks.onSpeechEnd(duration);
          }
        }
      }
    }
  }
}
