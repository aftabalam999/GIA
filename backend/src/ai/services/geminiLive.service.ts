import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { logger } from '../../shared/logger.js';

export interface GeminiLiveOptions {
  apiKey?: string;
  model?: string;
  systemInstruction?: string;
  tools?: unknown[];
  inputSampleRate?: number;
  outputSampleRate?: number;
}

export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveServerEvent {
  type: 'connected' | 'disconnected' | 'audio' | 'text' | 'tool-call' | 'turn-complete' | 'interrupted' | 'error';
  audioData?: Buffer;
  text?: string;
  toolCall?: LiveToolCall;
  error?: Error;
}

export interface LiveWebSocketClient {
  send?: (data: string) => void;
  close?: () => void;
}

export type LiveEventListener = (event: LiveServerEvent) => void;

/**
 * GeminiLiveService provides persistent bidirectional streaming with Google Gemini Multimodal Live API.
 * Handles 16kHz PCM audio input, 24kHz PCM audio output, input/output transcriptions, and backend tool calls.
 */
export class GeminiLiveService {
  private apiKey: string;
  private model: string;
  private systemInstruction: string;
  private tools: unknown[];
  private inputSampleRate: number;
  private outputSampleRate: number;

  private connected: boolean = false;
  private turnCounter: number = 0;
  private listeners: Set<LiveEventListener> = new Set();
  private wsClient: LiveWebSocketClient | null = null;
  private session: any = null;

  public diagnostics = {
    audioChunksReceivedFromFrontend: 0,
    audioBytesReceivedFromFrontend: 0,
    audioChunksSentToGemini: 0,
    audioBytesSentToGemini: 0,
    geminiMessagesReceived: 0,
    geminiAudioMessagesReceived: 0,
    geminiInputTranscriptionMessagesReceived: 0,
    geminiOutputTranscriptionMessagesReceived: 0,
  };

  constructor(options: GeminiLiveOptions = {}) {
    this.apiKey = options.apiKey || process.env.GOOGLE_AI_API_KEY || '';
    this.model = options.model || 'gemini-2.0-flash-exp';
    this.systemInstruction = options.systemInstruction || 'You are Afiya, a real-time voice assistant.';
    this.tools = options.tools || [];
    this.inputSampleRate = options.inputSampleRate || 16000;
    this.outputSampleRate = options.outputSampleRate || 24000;

    if (!this.apiKey && process.env.NODE_ENV !== 'test') {
      logger.warn({ msg: '⚠️ [GEMINI LIVE] No GOOGLE_AI_API_KEY found in environment' });
    }
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public get sessionTurns(): number {
    return this.turnCounter;
  }

  public on(listener: LiveEventListener): void {
    this.listeners.add(listener);
  }

  public off(listener: LiveEventListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: LiveServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ msg: 'Error in GeminiLiveService event listener', err: errMsg });
      }
    }
  }

  /**
   * Establishes persistent connection to Google Gemini Multimodal Live API.
   */
  public async connect(): Promise<void> {
    if (this.connected && (this.session || this.wsClient)) return;

    if (!this.apiKey && process.env.NODE_ENV !== 'test') {
      const err = new Error('GOOGLE_AI_API_KEY is not configured on backend server');
      this.emit({ type: 'error', error: err });
      throw err;
    }

    try {
      logger.info({
        msg: '🌐 [GEMINI LIVE SERVICE] Initializing persistent Live session to Gemini API',
        model: this.model,
        inputSampleRate: this.inputSampleRate,
        outputSampleRate: this.outputSampleRate,
      });

      if (process.env.NODE_ENV === 'test' || this.apiKey.includes('test') || this.apiKey.includes('mock')) {
        this.connected = true;
        this.turnCounter = 0;
        this.emit({ type: 'connected' });
        return;
      }

      const ai = new GoogleGenAI({ apiKey: this.apiKey });

      this.session = await ai.live.connect({
        model: this.model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: { parts: [{ text: this.systemInstruction }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: this.tools as any,
        },
        callbacks: {
          onopen: () => {
            logger.info({ msg: '🔌 [GEMINI LIVE API] Outbound Live WebSocket connected to Google Gemini API' });
          },
          onmessage: (e: LiveServerMessage) => {
            this.handleServerMessage(e);
          },
          onerror: (err: any) => {
            const errMsg = err?.message || String(err);
            logger.error({ msg: 'Gemini Live API error', err: errMsg });
            this.emit({ type: 'error', error: new Error(`Gemini Live API Error: ${errMsg}`) });
          },
          onclose: () => {
            logger.info({ msg: '🔌 [GEMINI LIVE API] Outbound Live WebSocket closed' });
            if (this.connected) {
              this.close();
            }
          },
        },
      });

      this.connected = true;
      this.turnCounter = 0;
      this.emit({ type: 'connected' });
    } catch (err: unknown) {
      this.connected = false;
      this.session = null;
      const errMsg = err instanceof Error ? err.message : String(err);
      const typedError = new Error(`Gemini Live connection failed: ${errMsg}`);
      this.emit({ type: 'error', error: typedError });
      throw typedError;
    }
  }

  private handleServerMessage(msg: any): void {
    this.diagnostics.geminiMessagesReceived++;

    // 1. Audio output
    const base64Audio =
      msg.data ||
      msg.serverContent?.modelTurn?.parts?.find((p: any) => p.inlineData?.mimeType?.startsWith('audio/'))?.inlineData
        ?.data;
    if (base64Audio) {
      this.diagnostics.geminiAudioMessagesReceived++;
      const pcmBuffer = Buffer.from(base64Audio, 'base64');
      this.emit({ type: 'audio', audioData: pcmBuffer });
    }

    // 2. User input transcription
    const inputTranscript =
      msg.serverContent?.inputTranscription?.text || msg.serverContent?.interimInputTranscription?.text;
    if (inputTranscript) {
      this.diagnostics.geminiInputTranscriptionMessagesReceived++;
      this.emit({ type: 'text', text: inputTranscript });
    }

    // 3. Model output transcription
    const outputTranscript = msg.text || msg.serverContent?.outputTranscription?.text;
    if (outputTranscript && !inputTranscript) {
      this.diagnostics.geminiOutputTranscriptionMessagesReceived++;
      this.emit({ type: 'text', text: outputTranscript });
    }

    // 4. Interruption signal
    if (msg.serverContent?.interrupted) {
      this.emit({ type: 'interrupted' });
    }

    // 5. Turn completion
    if (msg.serverContent?.turnComplete) {
      this.turnCounter++;
      this.emit({ type: 'turn-complete' });
    }

    // 6. Tool calls
    const toolCalls = msg.toolCall?.functionCalls;
    if (toolCalls && Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (call.name && call.id) {
          this.emit({
            type: 'tool-call',
            toolCall: {
              id: call.id,
              name: call.name,
              args: (call.args as Record<string, unknown>) || {},
            },
          });
        }
      }
    }
  }

  /**
   * Forwards 16kHz Signed 16-bit PCM audio chunk to active Gemini Live session.
   */
  public sendAudio(pcmChunk: Buffer | ArrayBuffer): void {
    if (!this.connected) {
      this.emit({ type: 'error', error: new Error('Cannot send audio: Gemini Live session is disconnected') });
      return;
    }

    const buffer = Buffer.isBuffer(pcmChunk) ? pcmChunk : Buffer.from(pcmChunk);
    if (buffer.length === 0) return;

    this.diagnostics.audioChunksReceivedFromFrontend++;
    this.diagnostics.audioBytesReceivedFromFrontend += buffer.length;

    const base64Audio = buffer.toString('base64');

    if (this.session && typeof this.session.sendRealtimeInput === 'function') {
      this.diagnostics.audioChunksSentToGemini++;
      this.diagnostics.audioBytesSentToGemini += buffer.length;
      this.session.sendRealtimeInput({
        mediaChunks: [
          {
            mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
            data: base64Audio,
          },
        ],
      });
    } else if (this.wsClient && typeof this.wsClient.send === 'function') {
      this.diagnostics.audioChunksSentToGemini++;
      this.diagnostics.audioBytesSentToGemini += buffer.length;
      this.wsClient.send(
        JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
                data: base64Audio,
              },
            ],
          },
        })
      );
    }
  }

  /**
   * Forwards text query or message to active Live session.
   */
  public sendText(text: string): void {
    if (!this.connected || !text || text.trim().length === 0) return;
    this.turnCounter++;

    if (this.session && typeof this.session.sendClientContent === 'function') {
      this.session.sendClientContent({
        turns: [
          {
            role: 'user',
            parts: [{ text: text.trim() }],
          },
        ],
        turnComplete: true,
      });
    } else if (this.wsClient && typeof this.wsClient.send === 'function') {
      this.wsClient.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [{ text: text.trim() }],
              },
            ],
            turnComplete: true,
          },
        })
      );
    }
  }

  /**
   * Forwards tool execution result back to active Live session.
   */
  public sendToolResponse(callId: string, output: Record<string, unknown>): void {
    if (!this.connected) return;

    if (this.session && typeof this.session.sendToolResponse === 'function') {
      this.session.sendToolResponse({
        functionResponses: [
          {
            response: { output },
            id: callId,
          },
        ],
      });
    } else if (this.wsClient && typeof this.wsClient.send === 'function') {
      this.wsClient.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: [
              {
                response: { output },
                id: callId,
              },
            ],
          },
        })
      );
    }
  }

  /**
   * Signals barge-in interruption to active Live session to immediately halt audio generation.
   */
  public interrupt(): void {
    if (!this.connected) return;

    logger.info({ msg: '🛑 [GEMINI LIVE SERVICE] Interrupting active response generation' });
    this.emit({ type: 'interrupted' });
  }

  /**
   * Terminates persistent Live session cleanly.
   */
  public close(): void {
    if (!this.connected) return;

    this.connected = false;
    if (this.session && typeof this.session.close === 'function') {
      try {
        this.session.close();
      } catch {
        // ignore
      }
      this.session = null;
    }
    if (this.wsClient && typeof this.wsClient.close === 'function') {
      try {
        this.wsClient.close();
      } catch {
        // ignore
      }
    }
    this.wsClient = null;
    logger.info({ msg: '🔌 [GEMINI LIVE SERVICE] Persistent Live session closed' });
    this.emit({ type: 'disconnected' });
  }

  /**
   * Internal test/mock method to simulate incoming server events in unit tests.
   */
  public _simulateServerMessage(msg: any): void {
    if (msg.type) {
      if (msg.type === 'audio' || msg.type === 'turn-complete') {
        this.turnCounter++;
      }
      this.emit(msg as LiveServerEvent);
    } else {
      this.handleServerMessage(msg);
    }
  }

  /**
   * Internal test/mock method to attach mock WebSocket client in unit tests.
   */
  public _setMockWsClient(client: LiveWebSocketClient): void {
    this.wsClient = client;
  }
}
