/**
 * GIA Phase 8: Continuous Voice Mode State Machine
 * Operates persistent voice mode cycle:
 * IDLE -> STARTING -> LISTENING -> SPEECH_DETECTED -> TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING -> LISTENING
 * Stop transitions: STOP_REQUESTED -> STOPPING -> IDLE
 */

import { detectWakeWord } from '../utils/wakeWord.js';
import { voiceLatencyTracker } from './voiceLatencyTracker.js';
import { SpeechTextChunker } from './textChunker.js';
import { StreamingAudioQueue } from './streamingAudioQueue.js';

export type VoiceState =
  | 'IDLE'
  | 'STARTING'
  | 'LISTENING'
  | 'SPEECH_DETECTED'
  | 'TRANSCRIBING'
  | 'PROCESSING'
  | 'SYNTHESIZING'
  | 'PLAYING'
  | 'STOP_REQUESTED'
  | 'STOPPING';

export interface VoiceStateMachineCallbacks {
  onStateChange?: (state: VoiceState) => void;
  onTranscript?: (text: string) => void;
  onAssistantResponse?: (userMsg: any, assistantMsg: any) => void;
  onError?: (errorMsg: string) => void;
  onPauseCapture?: () => void;
  onResumeCapture?: () => void;
  fetchTranscribeApi?: (audio: Blob | Buffer) => Promise<any>;
  fetchChatApi?: (convoId: string, text: string) => Promise<any>;
  fetchStreamChatApi?: (convoId: string, text: string, onChunk: (chunk: string) => void) => Promise<any>;
  fetchTtsApi?: (text: string) => Promise<ArrayBuffer | Buffer>;
  playAudioApi?: (audioBuffer: ArrayBuffer | Buffer) => Promise<void>;
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
    if (prevState !== newState && this._callbacks.onStateChange) {
      this._callbacks.onStateChange(newState);
    }
  }

  public static readonly WELCOME_GREETING = "Hello! I am Afiya, your AI assistant. How can I help you today?";

  /**
   * Explicitly enables persistent continuous Voice Mode (VOICE_MODE = ON).
   * Plays introductory welcome greeting when activated.
   */
  public async startVoiceMode(conversationId: string, token: string, speakWelcome = true): Promise<void> {
    if (this._isVoiceModeOn) return;

    this._isVoiceModeOn = true;
    this._isSessionActive = false;
    this._conversationId = conversationId;
    this._token = token;

    this.setState('STARTING');

    if (speakWelcome && this._callbacks.fetchTtsApi) {
      if (this._callbacks.onPauseCapture) {
        this._callbacks.onPauseCapture();
      }

      try {
        const welcomeText = VoiceStateMachine.WELCOME_GREETING;

        this.setState('SYNTHESIZING');
        let audioBuffer: ArrayBuffer | Buffer | null = null;
        try {
          audioBuffer = await this._callbacks.fetchTtsApi(welcomeText);
        } catch {
          // If TTS synthesis fails, fall back cleanly to listening mode
        }

        if (this.checkStopRequested()) return;

        if (audioBuffer) {
          this.setState('PLAYING');

          if (this._callbacks.onAssistantResponse) {
            this._callbacks.onAssistantResponse(null, {
              id: 'welcome-' + Date.now(),
              role: 'assistant',
              content: welcomeText,
              created_at: new Date().toISOString(),
            });
          }

          if (this._callbacks.playAudioApi) {
            await this._callbacks.playAudioApi(audioBuffer);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }

          if (this.checkStopRequested()) return;

          // 400ms acoustic guard delay to clear room reverb/echo
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      } catch (err: any) {
        // Handle welcome greeting error gracefully
      } finally {
        if (this._callbacks.onResumeCapture) {
          this._callbacks.onResumeCapture();
        }
      }
    }

    if (this._isVoiceModeOn) {
      this.setState('LISTENING');
    }
  }

  /**
   * Explicitly stops persistent continuous Voice Mode (VOICE_MODE = OFF).
   * Cleanly cancels active capture, fetch requests, or audio playback at any point.
   */
  public async stopVoiceMode(): Promise<void> {
    if (!this._isVoiceModeOn && this._state === 'IDLE') return;

    this._isVoiceModeOn = false;
    this._isSessionActive = false;
    this.setState('STOP_REQUESTED');

    // Clean up active fetch requests and streaming audio queue
    if (this._streamingQueue) {
      try {
        this._streamingQueue.cancel();
      } catch {
        // ignore
      }
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
   * Processes a captured speech audio utterance through the continuous pipeline:
   * TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING -> LISTENING
   */
  public async processSpeechUtterance(audioBlob: Blob | Buffer): Promise<void> {
    if (!this._isVoiceModeOn || this._isProcessingUtterance) return;
    if (this._state !== 'LISTENING' && this._state !== 'SPEECH_DETECTED') return;

    this._isProcessingUtterance = true;
    this._activeAbortController = new AbortController();

    // Echo prevention: mute mic capture while processing utterance and playing audio
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

      if (!transcriptText || transcriptText.trim().length === 0) {
        // Pure silence or empty transcription -> end active session & cleanly return to LISTENING
        this._isSessionActive = false;
        this._isProcessingUtterance = false;
        if (this._callbacks.onResumeCapture) {
          this._callbacks.onResumeCapture();
        }
        if (this._isVoiceModeOn) {
          this.setState('LISTENING');
        }
        return;
      }

      // Command-Session & Wake-word / Greeting Evaluation
      const wakeWordRes = detectWakeWord(transcriptText);
      let commandText = '';

      if (wakeWordRes.isAuthorized) {
        // Strong wake phrase with "GIA" detected -> Authorize & Enter/Refresh active command session
        this._isSessionActive = true;

        if (wakeWordRes.command && wakeWordRes.command.trim().length > 0) {
          commandText = wakeWordRes.command;
        } else {
          // Spoke wake phrase only (e.g. "Hey Gia") -> Active session enabled for next sentence
          this._isProcessingUtterance = false;
          if (this._callbacks.onResumeCapture) {
            this._callbacks.onResumeCapture();
          }
          if (this._isVoiceModeOn) {
            this.setState('LISTENING');
          }
          return;
        }
      } else if (wakeWordRes.isGreeting) {
        // Standalone conversational greeting (e.g. "Hi", "Hello", "What's up?")
        // Enables active session for dialogue, but DOES NOT authorize tool/command execution
        this._isSessionActive = true;
        commandText = wakeWordRes.command;
      } else if (this._isSessionActive) {
        // Active command session in progress -> Continue natural conversational voice flow without requiring "GIA"
        commandText = transcriptText.trim();
      } else {
        // Outside active session & not a greeting & no GIA wake word -> Ignore transcript
        this._isProcessingUtterance = false;
        if (this._callbacks.onResumeCapture) {
          this._callbacks.onResumeCapture();
        }
        if (this._isVoiceModeOn) {
          this.setState('LISTENING');
        }
        return;
      }

      if (this._callbacks.onTranscript) {
        this._callbacks.onTranscript(commandText);
      }

      // Check if user requested stop during STT
      if (this.checkStopRequested()) return;

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
          }
        );
      }

      const chunker = new SpeechTextChunker();
      const pushSpeechChunk = (sc: string) => {
        if (this.checkStopRequested()) return;
        voiceLatencyTracker.record('firstSpeechReadyChunk');
        this.setState('SYNTHESIZING');
        if (this._streamingQueue) {
          this._streamingQueue.pushChunk(sc);
        }
      };

      if (this._callbacks.fetchStreamChatApi && this._conversationId) {
        await this._callbacks.fetchStreamChatApi(this._conversationId, commandText, (tokenChunk: string) => {
          if (this.checkStopRequested()) return;
          voiceLatencyTracker.record('firstGeminiTextChunk');
          assistantReplyText += tokenChunk;
          const speechChunks = chunker.push(tokenChunk);
          for (const sc of speechChunks) {
            pushSpeechChunk(sc);
          }
        });

        const finalChunks = chunker.flush();
        for (const sc of finalChunks) {
          pushSpeechChunk(sc);
        }

        if (this._streamingQueue) {
          this._streamingQueue.markStreamComplete();
        }
      } else if (this._callbacks.fetchChatApi && this._conversationId) {
        const chatRes = await this._callbacks.fetchChatApi(this._conversationId, commandText);
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

      if (this.checkStopRequested()) return;

      // 3. SYNTHESIZING / PLAYING: Await audio playback completion if non-streaming or queue fallback
      if (!this._streamingQueue) {
        this.setState('SYNTHESIZING');
        let audioBuffer: ArrayBuffer | Buffer | null = null;
        if (this._callbacks.fetchTtsApi && assistantReplyText) {
          audioBuffer = await this._callbacks.fetchTtsApi(assistantReplyText);
        }

        if (this.checkStopRequested()) return;

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
            if (this.checkStopRequested() || !this._streamingQueue || this._streamingQueue.isComplete || !this._isVoiceModeOn) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 20);
        });
      }

      if (this.checkStopRequested()) return;

      // 4. CONTINUOUS LOOP TRANSITION: Fast turn-taking re-arm (50ms guard delay)
      this._isProcessingUtterance = false;
      this._activeAbortController = null;
      this._streamingQueue = null;

      await new Promise((resolve) => setTimeout(resolve, 50));

      if (this._callbacks.onResumeCapture) {
        this._callbacks.onResumeCapture();
      }

      if (this._isVoiceModeOn) {
        this.setState('LISTENING');
      } else {
        this.setState('IDLE');
      }
    } catch (err: any) {
      this._isProcessingUtterance = false;
      this._activeAbortController = null;

      if (this._callbacks.onResumeCapture) {
        this._callbacks.onResumeCapture();
      }

      if (err.name === 'AbortError' || (this._state as string) === 'STOPPING' || (this._state as string) === 'STOP_REQUESTED') {
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

  private checkStopRequested(): boolean {
    if (!this._isVoiceModeOn || this._state === 'STOP_REQUESTED' || this._state === 'STOPPING') {
      this._isProcessingUtterance = false;
      this.setState('IDLE');
      return true;
    }
    return false;
  }

  private handleError(msg: string): void {
    if (this._callbacks.onError) {
      this._callbacks.onError(msg);
    }
  }
}
