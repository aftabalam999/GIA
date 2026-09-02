import {
  requestNativeMicrophonePermission,
  startNativeMicrophoneTestCapture,
  stopNativeMicrophoneTestCapture,
  base64ToBlob,
} from './tauriMicrophone.js';
import { voiceLatencyTracker } from './voiceLatencyTracker.js';
import { LocalVAD } from './localVad.js';

export interface AudioRecorderCallbacks {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onInterruption?: () => void;
  onUtteranceRecorded?: (blob: Blob) => void;
  onError?: (errMessage: string) => void;
}

export class AudioRecorderService {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;

  private isRecording: boolean = false;
  private isPaused: boolean = false;
  private audioChunks: Blob[] = [];

  private callbacks: AudioRecorderCallbacks = {};
  private vad: LocalVAD;

  public get isSpeaking(): boolean {
    return this.vad.isSpeaking;
  }

  public setBargeInMode(enabled: boolean): void {
    this.vad.setBargeInMode(enabled);
  }

  // VAD Volume parameters
  private readonly VOLUME_THRESHOLD = 0.015;
  private readonly SILENCE_DURATION_MS = 650;

  constructor(callbacks: AudioRecorderCallbacks = {}) {
    this.callbacks = callbacks;
    this.vad = new LocalVAD(
      {
        speechThreshold: this.VOLUME_THRESHOLD,
        silenceDurationMs: this.SILENCE_DURATION_MS,
      },
      {
        onSpeechStart: () => {
          voiceLatencyTracker.startUtterance();
          voiceLatencyTracker.record('micSpeechStart');
          if (this.callbacks.onSpeechStart) {
            this.callbacks.onSpeechStart();
          }
        },
        onInterruption: () => {
          if (this.callbacks.onInterruption) {
            this.callbacks.onInterruption();
          }
        },
        onSpeechEnd: () => {
          voiceLatencyTracker.record('micSpeechEnd');
          if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            this.mediaRecorder.stop();
            setTimeout(() => {
              if (this.isRecording && this.mediaStream) {
                this.mediaRecorder = new MediaRecorder(this.mediaStream);
                this.mediaRecorder.ondataavailable = (e) => {
                  if (e.data.size > 0) this.audioChunks.push(e.data);
                };
                this.mediaRecorder.onstop = () => {
                  if (this.audioChunks.length > 0 && this.callbacks.onUtteranceRecorded && this.isRecording && !this.isPaused) {
                    const audioBlob = new Blob(this.audioChunks);
                    this.audioChunks = [];
                    this.callbacks.onUtteranceRecorded(audioBlob);
                  }
                };
                this.mediaRecorder.start(100);
              }
            }, 200);
          }
        },
      }
    );
  }

  public setCallbacks(callbacks: AudioRecorderCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async start(): Promise<void> {
    if (this.isRecording) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Setup Web Audio API AnalyserNode for volume VAD
      const AudioCtx = (typeof window !== 'undefined' ? (window.AudioContext || (window as any).webkitAudioContext) : null) || (globalThis as any).AudioContext;
      this.audioContext = new AudioCtx();
      if (!this.audioContext) return;
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      // Setup MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/wav';

      this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, { type: mimeType });
          this.audioChunks = [];
          if (this.callbacks.onUtteranceRecorded && this.isRecording && !this.isPaused) {
            this.callbacks.onUtteranceRecorded(audioBlob);
          }
        }
      };

      this.isRecording = true;
      this.vad.start();

      this.mediaRecorder.start(100); // 100ms timeslice
      this.monitorVolume();
    } catch (err: any) {
      // Fallback to Tauri Native Desktop Microphone Capture if WebKitGTK / browser getUserMedia is restricted
      const nativePerm = await requestNativeMicrophonePermission();
      if (nativePerm.status === 'GRANTED') {
        this.isRecording = true;
        this.vad.start();
        this.startNativeCaptureLoop();
        return;
      }

      const msg = `Microphone access error: ${err.message || 'Permission denied'}`;
      if (this.callbacks.onError) {
        this.callbacks.onError(msg);
      }
      throw new Error(msg);
    }
  }

  public pause() {
    this.isPaused = true;
    this.vad.setAudioInputEnabled(false);
  }

  public resume() {
    this.isPaused = false;
    this.vad.setAudioInputEnabled(true);
  }

  private async startNativeCaptureLoop() {
    while (this.isRecording) {
      if (this.isPaused) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }

      const res = await startNativeMicrophoneTestCapture(4);
      if (!this.isRecording) break;

      if (this.isPaused) {
        // Discard audio captured while recorder was muted during TTS playback
        continue;
      }

      if (res.success && res.wav_base64 && res.samples_captured > 1000) {
        const blob = base64ToBlob(res.wav_base64, 'audio/wav');
        if (this.callbacks.onUtteranceRecorded && !this.isPaused) {
          this.callbacks.onUtteranceRecorded(blob);
        }
      } else if (!res.success && res.error) {
        if (this.callbacks.onError) {
          this.callbacks.onError(res.error);
        }
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  private monitorVolume() {
    if (!this.isRecording || !this.analyser) return;

    if (this.isPaused) {
      this.animFrameId = requestAnimationFrame(() => this.monitorVolume());
      return;
    }

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);

    // Calculate RMS volume normalized to [0, 1]
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = dataArray[i] / 255;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / dataArray.length);

    // Delegate VAD speech start / end detection to LocalVAD
    this.vad.processAudioFrame(rms);

    this.animFrameId = requestAnimationFrame(() => this.monitorVolume());
  }

  public stop() {
    this.isRecording = false;
    this.isPaused = false;
    this.vad.stop();

    stopNativeMicrophoneTestCapture().catch(() => {});

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.audioChunks = [];
  }
}
