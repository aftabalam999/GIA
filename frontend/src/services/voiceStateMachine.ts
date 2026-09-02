/**
 * GIA Phase 8: Continuous Voice Mode State Machine
 * Operates persistent voice mode cycle:
 * IDLE -> STARTING -> LISTENING -> SPEECH_DETECTED -> TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING -> LISTENING
 * Interruption transition: SYNTHESIZING / PLAYING -> INTERRUPTED -> LISTENING
 * Stop transitions: STOP_REQUESTED -> STOPPING -> IDLE
 */

import { voiceLatencyTracker } from './voiceLatencyTracker.js';
import { SpeechTextChunker } from './textChunker.js';
import { StreamingAudioQueue } from './streamingAudioQueue.js';

import { LiveVoiceController } from './liveVoiceController.js';

export type VoiceState =
  | 'IDLE'
  | 'STARTING'
  | 'LISTENING'
  | 'SPEECH_DETECTED'
  | 'TRANSCRIBING'
  | 'PROCESSING'
  | 'SYNTHESIZING'
  | 'PLAYING'
  | 'INTERRUPTED'
  | 'STOP_REQUESTED'
  | 'STOPPING';

export interface VoiceStateMachineCallbacks {
  onStateChange?: (state: VoiceState) => void;
  onTranscript?: (text: string) => void;
  onAssistantResponse?: (userMsg: any, assistantMsg: any) => void;
  onError?: (errorMsg: string) => void;
  onPauseCapture?: () => void;
  onResumeCapture?: () => void;
  onSetBargeInMode?: (enabled: boolean) => void;
  fetchTranscribeApi?: (audio: Blob | Buffer) => Promise<any>;
  fetchChatApi?: (convoId: string, text: string) => Promise<any>;
  fetchStreamChatApi?: (convoId: string, text: string, onChunk: (chunk: string) => void) => Promise<any>;
  fetchTtsApi?: (text: string) => Promise<ArrayBuffer | Buffer>;
  playAudioApi?: (audioBuffer: ArrayBuffer | Buffer) => Promise<void>;
  enableLiveMode?: boolean;
}

export class VoiceStateMachine {
  private _state: VoiceState = 'IDLE';
  private _isVoiceModeOn: boolean = false;
  private _isSessionActive: boolean = false;
  private _conversationId: string | null = null;
  private _token: string | null = null;
  private _callbacks: VoiceStateMachineCallbacks = {};
  private _activeAbortController: AbortController | null = null;
  private _isProcessingUtterance: boolean = false;
  private _streamingQueue: StreamingAudioQueue | null = null;
  private _currentGenerationId: number = 0;
  private _liveController: LiveVoiceController | null = null;
  private _isLiveMode: boolean = false;

  constructor(callbacks: VoiceStateMachineCallbacks = {}) {
    this._callbacks = callbacks;
  }

  public get state(): VoiceState {
    return this._state;
  }

  public get isVoiceModeOn(): boolean {
    return this._isVoiceModeOn;
  }

  public get isSessionActive(): boolean {
    return this._isSessionActive;
  }

  public get isLiveMode(): boolean {
    return this._isLiveMode;
  }

  public get liveController(): LiveVoiceController | null {
    return this._liveController;
  }

  public get currentGenerationId(): number {
    return this._currentGenerationId;
  }

  public resetSession(): void {
    this._isSessionActive = false;
  }

  public get token(): string | null {
    return this._token;
  }

  public setCallbacks(callbacks: VoiceStateMachineCallbacks) {
    this._callbacks = { ...this._callbacks, ...callbacks };
  }

  private setState(newState: VoiceState) {
    const prevState = this._state;
    this._state = newState;

    // Authoritative Microphone Input & Barge-In Policy
    if (newState === 'LISTENING' || newState === 'SPEECH_DETECTED' || newState === 'INTERRUPTED') {
      console.log(`[VOICE] ${newState.toLowerCase()}`);
      console.log('[VOICE] microphone-enabled');
      if (this._callbacks.onSetBargeInMode) {
        this._callbacks.onSetBargeInMode(false);
      }
      if (this._callbacks.onResumeCapture) {
        this._callbacks.onResumeCapture();
      }
    } else if (newState === 'SYNTHESIZING' || newState === 'PLAYING') {
      console.log(`[VOICE] ${newState.toLowerCase()}`);
      console.log('[VOICE] microphone-disabled-bargein-enabled');
      if (this._callbacks.onPauseCapture) {
        this._callbacks.onPauseCapture();
      }
      if (this._callbacks.onSetBargeInMode) {
        this._callbacks.onSetBargeInMode(true);
      }
    } else if (
      newState === 'IDLE' ||
      newState === 'PROCESSING' ||
      newState === 'TRANSCRIBING' ||
      newState === 'STOP_REQUESTED' ||
      newState === 'STOPPING'
    ) {
      console.log(`[VOICE] ${newState.toLowerCase()}`);
      console.log('[VOICE] microphone-disabled');
      if (this._callbacks.onSetBargeInMode) {
        this._callbacks.onSetBargeInMode(false);
      }
      if (this._callbacks.onPauseCapture) {
        this._callbacks.onPauseCapture();
      }
    }

    if (prevState !== newState && this._callbacks.onStateChange) {
      this._callbacks.onStateChange(newState);
    }
  }

  public static readonly WELCOME_GREETING = "Hello! I am Afiya, your AI assistant. How can I help you today?";

  /**
   * Explicitly enables persistent continuous Voice Mode (VOICE_MODE = ON).
   * Attempts Gemini Live mode first, falling back to STT/TTS pipeline if unavailable.
   */
  public async startVoiceMode(conversationId: string, token: string, speakWelcome = true): Promise<void> {
    if (this._isVoiceModeOn) return;

    this._isVoiceModeOn = true;
    this._isSessionActive = false;
    this._conversationId = conversationId;
    this._token = token;

    this.setState('STARTING');

    const liveEnabled = this._callbacks.enableLiveMode !== false;
    if (liveEnabled) {
      try {
        const controller = new LiveVoiceController(this, {
          onStateChange: (s) => this.setState(s),
          onTranscript: (t) => {
            if (this._callbacks.onTranscript) this._callbacks.onTranscript(t);
          },
          onAssistantResponse: (u, a) => {
            if (this._callbacks.onAssistantResponse) this._callbacks.onAssistantResponse(u, a);
          },
          onError: (err) => this.handleError(err),
        });

        await controller.start(conversationId, token);
        this._liveController = controller;
        this._isLiveMode = true;
      } catch (err: any) {
        console.warn('[VOICE] Gemini Live initialization failed. Falling back to STT/TTS pipeline:', err.message);
        this._isLiveMode = false;
        this._liveController = null;
      }
    }

    if (speakWelcome && this._callbacks.fetchTtsApi && this._callbacks.playAudioApi) {
      try {
        const audioBuf = await this._callbacks.fetchTtsApi(VoiceStateMachine.WELCOME_GREETING);
        if (this._callbacks.onAssistantResponse) {
          this._callbacks.onAssistantResponse(null, { content: VoiceStateMachine.WELCOME_GREETING });
        }
        if (audioBuf && this._isVoiceModeOn) {
          this.setState('PLAYING');
          await this._callbacks.playAudioApi(audioBuf);
        }
      } catch (err: any) {
        console.warn('[VOICE] Welcome greeting play failed:', err.message);
      }
    }

    if (this._isVoiceModeOn) {
      this.setState('LISTENING');
    }
  }

  /**
   * Disables continuous Voice Mode and resets pipeline state.
   */
  public async stopVoiceMode(): Promise<void> {
    if (!this._isVoiceModeOn) return;

    this._isVoiceModeOn = false;
    this._currentGenerationId++;

    if (this._liveController) {
      try {
        this._liveController.stop();
      } catch {
        // ignore
      }
      this._liveController = null;
    }
    this._isLiveMode = false;

    if (this._streamingQueue) {
      this._streamingQueue.cancel();
      this._streamingQueue = null;
    }

    if (this._activeAbortController) {
      try {
        this._activeAbortController.abort();
      } catch {
        // ignore
      }
      this._activeAbortController = null;
    }

    this.setState('STOP_REQUESTED');
    this.setState('STOPPING');

    // Reset parameters
    this._isProcessingUtterance = false;
    this._conversationId = null;
    this._token = null;

    this.setState('IDLE');
  }

  /**
   * Triggers speech detection when VAD threshold is crossed.
   */
  public handleSpeechStart(): void {
    if (!this._isVoiceModeOn || this._state !== 'LISTENING') return;
    this.setState('SPEECH_DETECTED');
  }

  /**
   * Triggers user interruption / barge-in while Afiya is speaking.
   * Immediately halts playback, increments response generation ID to drop late audio chunks,
   * and re-arms microphone for continuous listening.
   */
  public handleInterruption(): void {
    if (!this._isVoiceModeOn) return;
    if (this._state !== 'SYNTHESIZING' && this._state !== 'PLAYING' && this._state !== 'PROCESSING' && this._state !== 'SPEECH_DETECTED' && this._state !== 'TRANSCRIBING') return;

    console.log('[VOICE] interrupted');
    this._currentGenerationId++;

    if (this._isLiveMode && this._liveController) {
      this._liveController.handleInterruption();
    }

    if (this._activeAbortController) {
      try {
        this._activeAbortController.abort();
      } catch {
        // ignore
      }
      this._activeAbortController = null;
    }

    if (this._streamingQueue) {
      this._streamingQueue.cancel();
      this._streamingQueue = null;
    }

    this._isProcessingUtterance = false;
    this.setState('INTERRUPTED');

    if (this._isVoiceModeOn) {
      this.setState('LISTENING');
    }
  }

  /**
   * Processes a captured speech audio utterance through the continuous pipeline:
   * TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING -> LISTENING
   */
  public async processSpeechUtterance(audioBlob: Blob | Buffer): Promise<void> {
    if (!this._isVoiceModeOn || this._isProcessingUtterance || this._isLiveMode) return;
    if (this._state !== 'LISTENING' && this._state !== 'SPEECH_DETECTED') return;

    this._isProcessingUtterance = true;
    const utteranceGenId = ++this._currentGenerationId;
    this._activeAbortController = new AbortController();

    // Mute mic input while processing utterance
    if (this._callbacks.onPauseCapture) {
      this._callbacks.onPauseCapture();
    }

    try {
      // 1. TRANSCRIBING: Send audio to STT
      this.setState('TRANSCRIBING');
      let transcriptText = '';

      if (this._callbacks.fetchTranscribeApi) {
        const transcribeRes = await this._callbacks.fetchTranscribeApi(audioBlob);
        transcriptText = transcribeRes?.text || transcribeRes?.data?.text || '';
        voiceLatencyTracker.record('sttFinalTranscript');
      } else {
        // Fallback for tests/stub
        transcriptText = 'Gia Synthesized test utterance';
        voiceLatencyTracker.record('sttFinalTranscript');
      }

      if (this.checkInterrupted(utteranceGenId)) return;

      if (!transcriptText || transcriptText.trim().length === 0) {
        // Pure silence or empty transcription -> end active session & cleanly return to LISTENING
        this._isSessionActive = false;
        this._isProcessingUtterance = false;
        if (this._isVoiceModeOn) {
          this.setState('LISTENING');
        }
        return;
      }

      // Directly process captured user speech when Voice Mode is ON
      const commandText = transcriptText.trim();
      this._isSessionActive = true;

      if (this._callbacks.onTranscript) {
        this._callbacks.onTranscript(commandText);
      }

      if (this.checkInterrupted(utteranceGenId)) return;

      // 2. PROCESSING: Send command to AI Orchestrator & Stream Speech Chunks
      this.setState('PROCESSING');
      let assistantReplyText = '';
      voiceLatencyTracker.record('geminiRequestStart');

      // Initialize StreamingAudioQueue if TTS and Playback APIs are registered
      if (this._callbacks.fetchTtsApi && this._callbacks.playAudioApi) {
        const ttsApi = this._callbacks.fetchTtsApi;
        const playApi = this._callbacks.playAudioApi;

        this._streamingQueue = new StreamingAudioQueue(
          {
            synthesize: async (t) => {
              if (this.checkInterrupted(utteranceGenId)) return new ArrayBuffer(0);
              this.setState('SYNTHESIZING');
              const res = await ttsApi(t);
              if (res instanceof ArrayBuffer) return res;
              if (typeof Buffer !== 'undefined' && Buffer.isBuffer(res)) {
                return res.buffer.slice(res.byteOffset, res.byteOffset + res.byteLength) as ArrayBuffer;
              }
              return new ArrayBuffer(0);
            },
            player: {
              play: async (buf: ArrayBuffer | Buffer) => {
                if (this.checkInterrupted(utteranceGenId)) return;
                this.setState('PLAYING');
                await playApi(buf);
              },
              stop: () => {},
              state: 'PLAYING',
              isPlaying: true,
            } as any,
          },
          {
            onError: (err) => {
              this.handleError('TTS streaming error: ' + err.message);
            },
          },
          utteranceGenId
        );
      }

      const chunker = new SpeechTextChunker();
      const pushSpeechChunk = (sc: string) => {
        if (this.checkInterrupted(utteranceGenId)) return;
        voiceLatencyTracker.record('firstSpeechReadyChunk');
        this.setState('SYNTHESIZING');
        if (this._streamingQueue) {
          this._streamingQueue.pushChunk(sc, utteranceGenId);
        }
      };

      if (this._callbacks.fetchStreamChatApi && this._conversationId) {
        await this._callbacks.fetchStreamChatApi(this._conversationId, commandText, (tokenChunk: string) => {
          if (this.checkInterrupted(utteranceGenId)) return;
          voiceLatencyTracker.record('firstGeminiTextChunk');
          assistantReplyText += tokenChunk;
          const speechChunks = chunker.push(tokenChunk);
          for (const sc of speechChunks) {
            pushSpeechChunk(sc);
          }
        });

        if (this.checkInterrupted(utteranceGenId)) return;

        const finalChunks = chunker.flush();
        for (const sc of finalChunks) {
          pushSpeechChunk(sc);
        }

        if (this._streamingQueue) {
          this._streamingQueue.markStreamComplete();
        }
      } else if (this._callbacks.fetchChatApi && this._conversationId) {
        const chatRes = await this._callbacks.fetchChatApi(this._conversationId, commandText);
        if (this.checkInterrupted(utteranceGenId)) return;

        assistantReplyText = chatRes?.assistantMessage?.content || chatRes?.data?.assistantMessage?.content || '';
        if (this._callbacks.onAssistantResponse) {
          this._callbacks.onAssistantResponse(chatRes.userMessage, chatRes.assistantMessage);
        }

        if (assistantReplyText) {
          pushSpeechChunk(assistantReplyText);
        }

        if (this._streamingQueue) {
          this._streamingQueue.markStreamComplete();
        }
      } else {
        assistantReplyText = 'Response to: ' + transcriptText;
        if (assistantReplyText) {
          pushSpeechChunk(assistantReplyText);
        }

        if (this._streamingQueue) {
          this._streamingQueue.markStreamComplete();
        }
      }

      if (this.checkInterrupted(utteranceGenId)) return;

      // 3. SYNTHESIZING / PLAYING: Await audio playback completion
      if (!this._streamingQueue) {
        this.setState('SYNTHESIZING');
        let audioBuffer: ArrayBuffer | Buffer | null = null;
        if (this._callbacks.fetchTtsApi && assistantReplyText) {
          audioBuffer = await this._callbacks.fetchTtsApi(assistantReplyText);
        }

        if (this.checkInterrupted(utteranceGenId)) return;

        this.setState('PLAYING');
        if (this._callbacks.playAudioApi && audioBuffer) {
          await this._callbacks.playAudioApi(audioBuffer);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } else {
        // Wait for streaming audio queue to finish playing all chunks
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (this.checkInterrupted(utteranceGenId) || !this._streamingQueue || this._streamingQueue.isComplete || !this._isVoiceModeOn) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 20);
        });
      }

      if (this.checkInterrupted(utteranceGenId)) return;

      // 4. CONTINUOUS LOOP TRANSITION: Fast turn-taking re-arm (50ms guard delay)
      this._isProcessingUtterance = false;
      this._activeAbortController = null;
      this._streamingQueue = null;

      await new Promise((resolve) => setTimeout(resolve, 50));

      if (this._isVoiceModeOn) {
        this.setState('LISTENING');
      } else {
        this.setState('IDLE');
      }
    } catch (err: any) {
      this._isProcessingUtterance = false;
      this._activeAbortController = null;

      const s = this._state as string;
      if (err.name === 'AbortError' || s === 'INTERRUPTED' || s === 'STOPPING' || s === 'STOP_REQUESTED') {
        // Clean cancellation
        return;
      }

      this.handleError(err.message || 'Voice pipeline execution failed');

      // Recover safely to LISTENING if still in voice mode
      if (this._isVoiceModeOn) {
        this.setState('LISTENING');
      } else {
        this.setState('IDLE');
      }
    }
  }

  private checkInterrupted(expectedGenId: number): boolean {
    if (!this._isVoiceModeOn || this._currentGenerationId !== expectedGenId || this._state === 'INTERRUPTED' || this._state === 'STOP_REQUESTED' || this._state === 'STOPPING') {
      this._isProcessingUtterance = false;
      return true;
    }
    return false;
  }

  private handleError(errorMsg: string): void {
    console.error('[VoiceStateMachine Error]:', errorMsg);
    if (this._callbacks.onError) {
      this._callbacks.onError(errorMsg);
    }
  }
}
