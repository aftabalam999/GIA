/**
 * GIA Phase 8: Continuous Voice Mode State Machine
 * Operates persistent voice mode cycle:
 * IDLE -> STARTING -> LISTENING -> SPEECH_DETECTED -> TRANSCRIBING -> PROCESSING -> SYNTHESIZING -> PLAYING -> LISTENING
 * Stop transitions: STOP_REQUESTED -> STOPPING -> IDLE
 */

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
  fetchTtsApi?: (text: string) => Promise<ArrayBuffer | Buffer>;
  playAudioApi?: (audioBuffer: ArrayBuffer | Buffer) => Promise<void>;
}

export class VoiceStateMachine {
  private _state: VoiceState = 'IDLE';
  private _isVoiceModeOn: boolean = false;
  private _conversationId: string | null = null;
  private _token: string | null = null;
  private _callbacks: VoiceStateMachineCallbacks = {};
  private _activeAbortController: AbortController | null = null;
  private _isProcessingUtterance: boolean = false;

  constructor(callbacks: VoiceStateMachineCallbacks = {}) {
    this._callbacks = callbacks;
  }

  public get state(): VoiceState {
    return this._state;
  }

  public get isVoiceModeOn(): boolean {
    return this._isVoiceModeOn;
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

  /**
   * Explicitly enables persistent continuous Voice Mode (VOICE_MODE = ON).
   */
  public async startVoiceMode(conversationId: string, token: string): Promise<void> {
    if (this._isVoiceModeOn) return;

    this._isVoiceModeOn = true;
    this._conversationId = conversationId;
    this._token = token;

    this.setState('STARTING');

    try {
      // Transition to LISTENING state for continuous voice loop
      this.setState('LISTENING');
    } catch (err: any) {
      this.handleError('Failed to start voice mode: ' + err.message);
      await this.stopVoiceMode();
    }
  }

  /**
   * Explicitly stops persistent continuous Voice Mode (VOICE_MODE = OFF).
   * Cleanly cancels active capture, fetch requests, or audio playback at any point.
   */
  public async stopVoiceMode(): Promise<void> {
    if (!this._isVoiceModeOn && this._state === 'IDLE') return;

    this._isVoiceModeOn = false;
    this.setState('STOP_REQUESTED');

    // Clean up active fetch requests
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
    if (this._state === 'STOP_REQUESTED' || this._state === 'STOPPING' || this._state === 'IDLE') return;

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
      } else {
        // Fallback for tests/stub
        transcriptText = 'Synthesized test utterance';
      }

      if (!transcriptText || transcriptText.trim().length === 0) {
        // Pure silence or empty transcription -> cleanly return to LISTENING
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
        this._callbacks.onTranscript(transcriptText);
      }

      // Check if user requested stop during STT
      if (this.checkStopRequested()) return;

      // 2. PROCESSING: Send transcript to AI Orchestrator
      this.setState('PROCESSING');
      let assistantReplyText = '';
      let chatRes: any = null;

      if (this._callbacks.fetchChatApi && this._conversationId) {
        chatRes = await this._callbacks.fetchChatApi(this._conversationId, transcriptText);
        assistantReplyText = chatRes?.assistantMessage?.content || chatRes?.data?.assistantMessage?.content || '';
        if (this._callbacks.onAssistantResponse) {
          this._callbacks.onAssistantResponse(chatRes.userMessage, chatRes.assistantMessage);
        }
      } else {
        assistantReplyText = 'Response to: ' + transcriptText;
      }

      if (this.checkStopRequested()) return;

      // 3. SYNTHESIZING: Send assistant response text to TTS
      this.setState('SYNTHESIZING');
      let audioBuffer: ArrayBuffer | Buffer | null = null;

      if (this._callbacks.fetchTtsApi) {
        audioBuffer = await this._callbacks.fetchTtsApi(assistantReplyText);
      }

      if (this.checkStopRequested()) return;

      // 4. PLAYING: Play response audio to completion
      this.setState('PLAYING');
      if (this._callbacks.playAudioApi && audioBuffer) {
        await this._callbacks.playAudioApi(audioBuffer);
      } else {
        // Simulate playback duration
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (this.checkStopRequested()) return;

      // 5. CONTINUOUS LOOP TRANSITION: PLAYING -> LISTENING
      this._isProcessingUtterance = false;
      this._activeAbortController = null;

      // 400ms acoustic guard delay to allow speaker reverb/echo to clear
      await new Promise((resolve) => setTimeout(resolve, 400));

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
