import {
  requestNativeMicrophonePermission,
  startContinuousMicrophoneCapture,
  stopContinuousMicrophoneCapture,
  listenToMicrophoneAudioFrames,
  listenToMicrophoneCaptureError,
  stopNativeMicrophoneTestCapture,
  createWavBlobFromPcm,
  base64ToUint8Array,
  AudioFramePayload,
} from './tauriMicrophone.js';
import { isTauriEnvironment } from './tauriServices.js';
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
  private isNativeContinuous: boolean = false;
  private _hasReceivedFrames: boolean = false;
  private lastDiagLogTime: number = 0;
  private audioChunks: Blob[] = [];
  private selectedMimeType: string = '';

  private nativePcmChunks: Uint8Array[] = [];
  private nativePreRollChunks: Uint8Array[] = [];
  private readonly PRE_ROLL_LIMIT: number = 4; // ~128ms pre-roll (4 x 32ms frames)

  private unlistenAudioFrames: (() => void) | null = null;
  private unlistenCaptureError: (() => void) | null = null;

  private callbacks: AudioRecorderCallbacks = {};
  private vad: LocalVAD;

  public get isSpeaking(): boolean {
    return this.vad.isSpeaking;
  }

  public get hasReceivedFrames(): boolean {
    return this._hasReceivedFrames;
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
          console.log('[AUDIO_PIPELINE] Speech onset detected by VAD');

          if (this.isNativeContinuous) {
            this.nativePcmChunks = [...this.nativePreRollChunks];
            this.nativePreRollChunks = [];
          }

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
          console.log('[AUDIO_PIPELINE] Speech offset detected by VAD');
          if (this.callbacks.onSpeechEnd) {
            this.callbacks.onSpeechEnd();
          }

          // 1. Native continuous capture: package accumulated 16kHz PCM chunks into standard WAV Blob
          if (this.isNativeContinuous) {
            if (this.nativePcmChunks.length > 0) {
              let totalBytes = 0;
              for (const chunk of this.nativePcmChunks) {
                totalBytes += chunk.length;
              }
              const combinedPcm = new Uint8Array(totalBytes);
              let offset = 0;
              for (const chunk of this.nativePcmChunks) {
                combinedPcm.set(chunk, offset);
                offset += chunk.length;
              }
              const chunksRecorded = this.nativePcmChunks.length;
              this.nativePcmChunks = [];

              const wavBlob = createWavBlobFromPcm(combinedPcm, 16000, 1);
              console.log('[AUDIO_PIPELINE] Native utterance packaged:', {
                chunks: chunksRecorded,
                totalBytes: wavBlob.size,
                durationSec: (combinedPcm.length / (16000 * 2)).toFixed(2),
                mimeType: 'audio/wav',
              });

              if (this.callbacks.onUtteranceRecorded && this.isRecording) {
                this.callbacks.onUtteranceRecorded(wavBlob);
              }
            } else {
              console.warn('[AUDIO_PIPELINE] Speech ended with 0 native audio frames.');
            }
            return;
          }

          // 2. Browser WebAudio MediaRecorder path
          if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            try {
              if (typeof (this.mediaRecorder as any).requestData === 'function') {
                (this.mediaRecorder as any).requestData();
              }
            } catch {}
            this.mediaRecorder.stop();
            setTimeout(() => {
              if (this.isRecording && this.mediaStream) {
                const recOpts = this.selectedMimeType ? { mimeType: this.selectedMimeType } : undefined;
                this.mediaRecorder = new MediaRecorder(this.mediaStream, recOpts);
                this.mediaRecorder.ondataavailable = (e) => {
                  if (e.data.size > 0) this.audioChunks.push(e.data);
                };
                this.mediaRecorder.onstop = () => {
                  if (this.audioChunks.length > 0) {
                    const audioBlob = new Blob(this.audioChunks, this.selectedMimeType ? { type: this.selectedMimeType } : undefined);
                    console.log('[AUDIO_PIPELINE] Subsequent utterance packaged:', {
                      chunks: this.audioChunks.length,
                      totalBytes: audioBlob.size,
                      mimeType: this.selectedMimeType || audioBlob.type,
                    });
                    this.audioChunks = [];
                    if (this.callbacks.onUtteranceRecorded && this.isRecording) {
                      this.callbacks.onUtteranceRecorded(audioBlob);
                    }
                  } else {
                    console.warn('[AUDIO_PIPELINE] Speech ended with 0 audio chunks.');
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
    if (this.isRecording) {
      console.warn('[AudioRecorder] Recording already active, ignoring duplicate start request.');
      return;
    }

    const runtimeType = isTauriEnvironment() ? 'tauri' : 'browser';

    // Clean up any stale handles before starting new stream to prevent duplicate streams/leaks
    if (this.mediaStream || this.audioContext || this.animFrameId || this.isNativeContinuous) {
      this.stop();
    }

    this._hasReceivedFrames = false;

    // 1. In Tauri environment: prefer reliable continuous native capture via CPAL/CoreAudio
    if (isTauriEnvironment()) {
      try {
        console.log('[MIC_DIAGNOSTIC] selectedCaptureImplementation:', 'tauri_native_continuous');
        await this.startNativeContinuousCapture();
        return;
      } catch (err: any) {
        console.warn('[MIC_DIAGNOSTIC] Native continuous capture initialization failed, checking getUserMedia fallback:', err);
      }
    }

    // 2. In browser environment (or fallback): use WebAudio navigator.mediaDevices.getUserMedia
    const hasGetUserMedia =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices) &&
      typeof navigator.mediaDevices.getUserMedia === 'function';

    console.log('[MIC_DIAGNOSTIC] start() initiated:', {
      runtimeType,
      hasGetUserMedia,
    });

    if (hasGetUserMedia) {
      try {
        console.log('[MIC_DIAGNOSTIC] selectedCaptureImplementation:', 'webaudio_getusermedia');
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        // Verify that the capture stream started successfully
        const audioTracks = this.mediaStream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) {
          throw new Error('No audio input tracks returned by media device.');
        }

        const activeTrack = audioTracks[0];
        if (activeTrack.readyState !== 'live') {
          throw new Error(`Microphone track not active (readyState: ${activeTrack.readyState})`);
        }

        activeTrack.onended = () => {
          console.warn('[AudioRecorder] Microphone input track disconnected.');
          if (this.isRecording) {
            this.stop();
            if (this.callbacks.onError) {
              this.callbacks.onError('Microphone input device disconnected.');
            }
          }
        };

        // Setup Web Audio API AnalyserNode for volume VAD (16kHz target)
        const AudioCtx = (typeof window !== 'undefined' ? (window.AudioContext || (window as any).webkitAudioContext) : null) || (globalThis as any).AudioContext;
        this.audioContext = new AudioCtx({ sampleRate: 16000 });
        if (this.audioContext) {
          if (this.audioContext.state === 'suspended' && typeof this.audioContext.resume === 'function') {
            await this.audioContext.resume().catch(() => {});
          }
          const source = this.audioContext.createMediaStreamSource(this.mediaStream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 512;
          source.connect(this.analyser);
        }

        // Setup MediaRecorder with platform-supported container (supports webm, mp4 on WebKit/macOS, ogg)
        const candidates = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4;codecs=mp4a.40.2',
          'audio/mp4',
          'audio/aac',
          'audio/ogg;codecs=opus',
        ];
        this.selectedMimeType = (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function')
          ? (candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '')
          : '';

        const recorderOptions = this.selectedMimeType ? { mimeType: this.selectedMimeType } : undefined;
        this.mediaRecorder = new MediaRecorder(this.mediaStream, recorderOptions);
        this.audioChunks = [];

        const trackSettings = typeof activeTrack.getSettings === 'function' ? activeTrack.getSettings() : {};
        console.log('[AUDIO_PIPELINE_INIT]', {
          sampleRate: trackSettings.sampleRate || this.audioContext?.sampleRate || 16000,
          channels: trackSettings.channelCount || 1,
          mimeType: this.selectedMimeType,
          audioContextState: this.audioContext?.state,
        });

        console.log('[MIC_DIAGNOSTIC] captureStartResult:', {
          runtimeType,
          selectedCaptureImplementation: 'webaudio_getusermedia',
          success: true,
          sampleRate: trackSettings.sampleRate || this.audioContext?.sampleRate || 16000,
          channelCount: trackSettings.channelCount || 1,
          audioFrameSize: this.analyser?.fftSize || 512,
        });

        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            this.audioChunks.push(event.data);
          }
        };

        this.mediaRecorder.onstop = () => {
          if (this.audioChunks.length > 0) {
            const audioBlob = new Blob(this.audioChunks, this.selectedMimeType ? { type: this.selectedMimeType } : undefined);
            console.log('[AUDIO_PIPELINE] Initial utterance packaged:', {
              chunks: this.audioChunks.length,
              totalBytes: audioBlob.size,
              mimeType: this.selectedMimeType || audioBlob.type,
            });
            this.audioChunks = [];
            if (this.callbacks.onUtteranceRecorded && this.isRecording) {
              this.callbacks.onUtteranceRecorded(audioBlob);
            }
          } else {
            console.warn('[AUDIO_PIPELINE] Initial utterance ended with 0 audio chunks.');
          }
        };

        this.isRecording = true;
        this.vad.start();

        this.mediaRecorder.start(100); // 100ms timeslice
        this.monitorVolume();
        return;
      } catch (err: any) {
        console.warn('[MIC_DIAGNOSTIC] captureError (getUserMedia):', {
          runtimeType,
          selectedCaptureImplementation: 'webaudio_getusermedia',
          errorName: err?.name,
          errorMessage: err?.message || String(err),
        });
      }
    }

    const msg = 'Microphone capture failed: No active audio capture method available.';
    if (this.callbacks.onError) {
      this.callbacks.onError(msg);
    }
    throw new Error(msg);
  }

  private async startNativeContinuousCapture(): Promise<void> {
    const nativePerm = await requestNativeMicrophonePermission();
    console.log('[MIC_DIAGNOSTIC] permissionRequestResult:', {
      runtimeType: 'tauri',
      selectedCaptureImplementation: 'tauri_native_continuous',
      status: nativePerm.status,
      message: nativePerm.message,
    });

    if (nativePerm.status !== 'GRANTED') {
      const msg = `Microphone access denied: ${nativePerm.message || 'Permission denied'}`;
      if (this.callbacks.onError) {
        this.callbacks.onError(msg);
      }
      throw new Error(msg);
    }

    this.nativePcmChunks = [];
    this.nativePreRollChunks = [];

    // Register audio frame listener
    this.unlistenAudioFrames = await listenToMicrophoneAudioFrames((frame: AudioFramePayload) => {
      this.handleNativeAudioFrame(frame);
    });

    // Register capture error listener
    this.unlistenCaptureError = await listenToMicrophoneCaptureError((errMsg: string) => {
      console.error('[MIC_DIAGNOSTIC] captureError (native stream):', errMsg);
      if (this.callbacks.onError) {
        this.callbacks.onError(errMsg);
      }
    });

    // Start continuous CPAL CoreAudio stream
    await startContinuousMicrophoneCapture();

    this.isRecording = true;
    this.isNativeContinuous = true;
    this.vad.start();

    console.log('[MIC_DIAGNOSTIC] captureStartResult:', {
      runtimeType: 'tauri',
      selectedCaptureImplementation: 'tauri_native_continuous',
      success: true,
      sampleRate: 16000,
      channelCount: 1,
      audioFrameSize: 512,
    });
  }

  private handleNativeAudioFrame(frame: AudioFramePayload) {
    if (!this.isRecording) return;

    if (!this._hasReceivedFrames) {
      this._hasReceivedFrames = true;
      console.log('[MIC_DIAGNOSTIC] firstAudioFrameReceived:', {
        runtimeType: 'tauri',
        selectedCaptureImplementation: 'tauri_native_continuous',
        sampleRate: frame.sample_rate,
        channelCount: frame.channels,
        audioFrameSize: frame.samples_count,
        initialRms: Number(frame.rms.toFixed(4)),
      });
    }

    // Process frame in LocalVAD (speech start/end and barge-in interruption detection)
    this.vad.processAudioFrame(frame.rms, 32);

    const now = Date.now();
    if (now - this.lastDiagLogTime >= 3000) {
      this.lastDiagLogTime = now;
      console.log('[AUDIO_PIPELINE_DIAGNOSTIC]', {
        framesReceived: this._hasReceivedFrames,
        currentRms: Number(frame.rms.toFixed(4)),
        isSpeaking: this.vad.isSpeaking,
        bargeInMode: this.vad.bargeInMode,
        nativeContinuous: true,
      });
    }

    // If recorder is muted/paused during TTS playback, discard audio for speech recognition
    if (this.isPaused) {
      return;
    }

    if (frame.pcm_base64) {
      const pcmBytes = base64ToUint8Array(frame.pcm_base64);
      if (this.vad.isSpeaking) {
        this.nativePcmChunks.push(pcmBytes);
      } else {
        this.nativePreRollChunks.push(pcmBytes);
        if (this.nativePreRollChunks.length > this.PRE_ROLL_LIMIT) {
          this.nativePreRollChunks.shift();
        }
      }
    }
  }

  public pause() {
    this.isPaused = true;
    this.vad.setAudioInputEnabled(false);
    this.nativePcmChunks = [];
    this.nativePreRollChunks = [];
  }

  public resume() {
    this.isPaused = false;
    this.vad.setAudioInputEnabled(true);
  }

  private monitorVolume() {
    if (!this.isRecording || !this.analyser) return;

    if (this.isPaused) {
      this.animFrameId = requestAnimationFrame(() => this.monitorVolume());
      return;
    }

    let rms = 0;
    if (typeof this.analyser.getFloatTimeDomainData === 'function') {
      const floatData = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(floatData);
      let sum = 0;
      for (let i = 0; i < floatData.length; i++) {
        sum += floatData[i] * floatData[i];
      }
      rms = Math.sqrt(sum / floatData.length);
    } else if (typeof this.analyser.getByteTimeDomainData === 'function') {
      const byteData = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(byteData);
      let sum = 0;
      for (let i = 0; i < byteData.length; i++) {
        const norm = (byteData[i] - 128) / 128;
        sum += norm * norm;
      }
      rms = Math.sqrt(sum / byteData.length);
    } else if (typeof this.analyser.getByteFrequencyData === 'function') {
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = dataArray[i] / 255;
        sum += normalized * normalized;
      }
      rms = Math.sqrt(sum / dataArray.length);
    }

    // Delegate VAD speech start / end detection to LocalVAD
    if (!this._hasReceivedFrames) {
      this._hasReceivedFrames = true;
      console.log('[MIC_DIAGNOSTIC] firstAudioFrameReceived:', {
        runtimeType: isTauriEnvironment() ? 'tauri' : 'browser',
        selectedCaptureImplementation: 'webaudio_getusermedia',
        sampleRate: this.audioContext?.sampleRate || 16000,
        channelCount: 1,
        audioFrameSize: this.analyser.fftSize,
        initialRms: Number(rms.toFixed(4)),
      });
    }
    this.vad.processAudioFrame(rms);

    const now = Date.now();
    if (now - this.lastDiagLogTime >= 3000) {
      this.lastDiagLogTime = now;
      console.log('[AUDIO_PIPELINE_DIAGNOSTIC]', {
        framesReceived: this._hasReceivedFrames,
        currentRms: Number(rms.toFixed(4)),
        isSpeaking: this.vad.isSpeaking,
        bargeInMode: this.vad.bargeInMode,
        audioContextState: this.audioContext?.state,
      });
    }

    this.animFrameId = requestAnimationFrame(() => this.monitorVolume());
  }

  public stop() {
    this.isRecording = false;
    this.isPaused = false;
    this._hasReceivedFrames = false;
    this.vad.stop();

    if (this.unlistenAudioFrames) {
      try {
        this.unlistenAudioFrames();
      } catch {}
      this.unlistenAudioFrames = null;
    }

    if (this.unlistenCaptureError) {
      try {
        this.unlistenCaptureError();
      } catch {}
      this.unlistenCaptureError = null;
    }

    if (this.isNativeContinuous) {
      this.isNativeContinuous = false;
      stopContinuousMicrophoneCapture().catch(() => {});
    }

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
    this.nativePcmChunks = [];
    this.nativePreRollChunks = [];
  }
}
