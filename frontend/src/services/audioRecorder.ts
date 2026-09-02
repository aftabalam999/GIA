import {
  requestNativeMicrophonePermission,
  startNativeMicrophoneTestCapture,
  stopNativeMicrophoneTestCapture,
  base64ToBlob,
} from './tauriMicrophone.js';
import { voiceLatencyTracker } from './voiceLatencyTracker.js';

export interface AudioRecorderCallbacks {
  onSpeechStart?: () => void;
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
  private isSpeaking: boolean = false;
  private silenceStartTime: number | null = null;
  private audioChunks: Blob[] = [];

  private callbacks: AudioRecorderCallbacks = {};

  // VAD Volume parameters
  private readonly VOLUME_THRESHOLD = 0.015; // Normalized volume threshold for speech detection
  private readonly SILENCE_DURATION_MS = 1200; // 1.2s silence triggers end of utterance

  constructor(callbacks: AudioRecorderCallbacks = {}) {
    this.callbacks = callbacks;
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
      this.isSpeaking = false;
      this.silenceStartTime = null;

      this.mediaRecorder.start(100); // 100ms timeslice
      this.monitorVolume();
    } catch (err: any) {
      // Fallback to Tauri Native Desktop Microphone Capture if WebKitGTK / browser getUserMedia is restricted
      const nativePerm = await requestNativeMicrophonePermission();
      if (nativePerm.status === 'GRANTED') {
        this.isRecording = true;
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

  private isPaused: boolean = false;

  public pause() {
    this.isPaused = true;
  }

  public resume() {
    this.isPaused = false;
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
      this.isSpeaking = false;
      this.silenceStartTime = null;
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

    const now = Date.now();

    if (rms > this.VOLUME_THRESHOLD) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        voiceLatencyTracker.startUtterance();
        voiceLatencyTracker.record('micSpeechStart');
        if (this.callbacks.onSpeechStart) {
          this.callbacks.onSpeechStart();
        }
      }
      this.silenceStartTime = null;
    } else if (this.isSpeaking) {
      if (this.silenceStartTime === null) {
        this.silenceStartTime = now;
      } else if (now - this.silenceStartTime >= this.SILENCE_DURATION_MS) {
        // Speech ended -> stop slice to emit Blob and start new recorder slice for continuous listening
        this.isSpeaking = false;
        this.silenceStartTime = null;
        voiceLatencyTracker.record('micSpeechEnd');

        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
          // Restart recorder slice for continuous listening loop
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
      }
    }

    this.animFrameId = requestAnimationFrame(() => this.monitorVolume());
  }

  public stop() {
    this.isRecording = false;
    this.isSpeaking = false;
    this.silenceStartTime = null;

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
