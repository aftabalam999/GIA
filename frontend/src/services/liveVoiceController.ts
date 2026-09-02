import { GeminiLiveClient, GeminiLiveClientEvent } from './geminiLiveClient.js';
import { LiveAudioCapture } from './liveAudioCapture.js';
import { LiveAudioPlayer } from './liveAudioPlayer.js';
import { VoiceStateMachine, VoiceState } from './voiceStateMachine.js';

export interface LiveVoiceControllerCallbacks {
  onStateChange?: (state: VoiceState) => void;
  onTranscript?: (text: string) => void;
  onAssistantResponse?: (userMsg: any, assistantMsg: any) => void;
  onError?: (errorMsg: string) => void;
}

export class LiveVoiceController {
  private client: GeminiLiveClient | null = null;
  private capture: LiveAudioCapture | null = null;
  private player: LiveAudioPlayer | null = null;
  private callbacks: LiveVoiceControllerCallbacks;
  private active: boolean = false;
  private assistantTextBuffer: string = '';
  private clientFactory: () => GeminiLiveClient;
  private captureFactory: () => LiveAudioCapture;
  private playerFactory: () => LiveAudioPlayer;

  constructor(
    _stateMachine: VoiceStateMachine,
    callbacks: LiveVoiceControllerCallbacks = {},
    clientFactory?: () => GeminiLiveClient,
    captureFactory?: () => LiveAudioCapture,
    playerFactory?: () => LiveAudioPlayer
  ) {
    this.callbacks = callbacks;
    this.clientFactory = clientFactory || (() => new GeminiLiveClient());
    this.captureFactory = captureFactory || (() => new LiveAudioCapture());
    this.playerFactory = playerFactory || (() => new LiveAudioPlayer(24000));
  }

  public get isActive(): boolean {
    return this.active;
  }

  public async start(_conversationId: string, token: string): Promise<void> {
    if (this.active) return;

    try {
      this.client = this.clientFactory();
      this.capture = this.captureFactory();
      this.player = this.playerFactory();
      this.assistantTextBuffer = '';

      this.client.on((evt: GeminiLiveClientEvent) => {
        this.handleClientEvent(evt);
      });

      await this.client.connect(token);
      this.active = true;

      // Start continuous audio streaming
      await this.capture.start((pcmChunk: Uint8Array) => {
        if (this.active && this.client && this.client.isConnected) {
          this.client.sendAudio(pcmChunk);
        }
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[LIVE VOICE CONTROLLER START ERROR]:', errMsg, err);
      this.stop();
      if (this.callbacks.onError) {
        this.callbacks.onError(`Live Voice Controller start failed: ${errMsg}`);
      }
      throw err;
    }
  }

  private handleClientEvent(evt: GeminiLiveClientEvent): void {
    if (!this.active) return;

    switch (evt.type) {
      case 'connected': {
        break;
      }
      case 'audio': {
        if (this.player && evt.data) {
          this.player.playChunk(evt.data);
          this.updateState('PLAYING');
        }
        break;
      }
      case 'text': {
        if (evt.text) {
          this.assistantTextBuffer += evt.text;
          if (this.callbacks.onAssistantResponse) {
            this.callbacks.onAssistantResponse(null, { content: this.assistantTextBuffer });
          }
        }
        break;
      }
      case 'turn-complete': {
        this.assistantTextBuffer = '';
        this.updateState('LISTENING');
        break;
      }
      case 'interrupted': {
        if (this.player) {
          this.player.stop();
        }
        this.assistantTextBuffer = '';
        this.updateState('LISTENING');
        break;
      }
      case 'error': {
        if (this.callbacks.onError) {
          this.callbacks.onError(`Gemini Live Error (${evt.code}): ${evt.message}`);
        }
        break;
      }
      case 'disconnected': {
        this.active = false;
        this.updateState('IDLE');
        break;
      }
    }
  }

  public handleInterruption(): void {
    if (!this.active) return;

    if (this.player) {
      this.player.stop();
    }
    if (this.client && this.client.isConnected) {
      this.client.sendInterrupt();
    }
    this.assistantTextBuffer = '';
    this.updateState('LISTENING');
  }

  public sendText(text: string): void {
    if (this.active && this.client && this.client.isConnected) {
      this.client.sendText(text);
      this.updateState('PROCESSING');
    }
  }

  private updateState(newState: VoiceState): void {
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(newState);
    }
  }

  public stop(): void {
    this.active = false;
    this.assistantTextBuffer = '';

    if (this.capture) {
      try {
        this.capture.stop();
      } catch {
        // ignore
      }
      this.capture = null;
    }

    if (this.player) {
      try {
        this.player.stop();
        this.player.close();
      } catch {
        // ignore
      }
      this.player = null;
    }

    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }
}
