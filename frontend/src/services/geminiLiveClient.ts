export type GeminiLiveClientEvent =
  | { type: 'connected' }
  | { type: 'audio'; data: ArrayBuffer }
  | { type: 'text'; text: string }
  | { type: 'tool-call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'turn-complete' }
  | { type: 'interrupted' }
  | { type: 'error'; code: string; message: string }
  | { type: 'disconnected' };

export type GeminiLiveClientListener = (event: GeminiLiveClientEvent) => void;

function getWebSocketUrl(token?: string): string {
  const envUrl = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:5000';
  let wsUrl = envUrl.replace(/^http/, 'ws');
  if (wsUrl.endsWith('/')) {
    wsUrl = wsUrl.slice(0, -1);
  }
  const endpoint = `${wsUrl}/api/v1/voice/live`;
  return token ? `${endpoint}?token=${encodeURIComponent(token)}` : endpoint;
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = typeof window !== 'undefined' && window.atob ? window.atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof window !== 'undefined' && window.btoa) {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private isConnectedState: boolean = false;
  private listeners: Set<GeminiLiveClientListener> = new Set();
  private wsFactory?: (url: string) => WebSocket;

  constructor(wsFactory?: (url: string) => WebSocket) {
    this.wsFactory = wsFactory;
  }

  public get isConnected(): boolean {
    return this.isConnectedState && this.ws !== null && (this.ws.readyState === 1 || this.ws.readyState === undefined);
  }

  public on(listener: GeminiLiveClientListener): void {
    this.listeners.add(listener);
  }

  public off(listener: GeminiLiveClientListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: GeminiLiveClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        console.error('Error in GeminiLiveClient listener', err);
      }
    }
  }

  public connect(token?: string): Promise<void> {
    if (this.isConnected) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      try {
        const url = getWebSocketUrl(token);
        const WSClass = typeof window !== 'undefined' ? window.WebSocket : WebSocket;
        this.ws = this.wsFactory ? this.wsFactory(url) : new (WSClass as any)(url);

        let connectionTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          if (!this.isConnectedState) {
            this.cleanup();
            reject(new Error('WebSocket connection timed out'));
          }
        }, 10000);

        if (!this.ws) {
          reject(new Error('Failed to instantiate WebSocket'));
          return;
        }

        this.ws.onopen = () => {
          // Open connection — awaiting server "connected" event
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const rawData = typeof event.data === 'string' ? event.data : '';
            if (!rawData) return;

            const parsed = JSON.parse(rawData) as unknown;
            if (!parsed || typeof parsed !== 'object') return;

            const msg = parsed as Record<string, unknown>;
            const msgType = typeof msg.type === 'string' ? msg.type : '';

            switch (msgType) {
              case 'connected': {
                this.isConnectedState = true;
                if (connectionTimeout) {
                  clearTimeout(connectionTimeout);
                  connectionTimeout = null;
                }
                this.emit({ type: 'connected' });
                resolve();
                break;
              }
              case 'audio': {
                if (typeof msg.data === 'string' && msg.data.length > 0) {
                  const audioBuf = base64ToArrayBuffer(msg.data);
                  this.emit({ type: 'audio', data: audioBuf });
                }
                break;
              }
              case 'text': {
                if (typeof msg.text === 'string') {
                  this.emit({ type: 'text', text: msg.text });
                }
                break;
              }
              case 'tool-call': {
                if (typeof msg.callId === 'string' && typeof msg.name === 'string') {
                  const args = msg.args && typeof msg.args === 'object' ? (msg.args as Record<string, unknown>) : {};
                  this.emit({
                    type: 'tool-call',
                    callId: msg.callId,
                    name: msg.name,
                    args,
                  });
                }
                break;
              }
              case 'turn-complete': {
                this.emit({ type: 'turn-complete' });
                break;
              }
              case 'interrupted': {
                this.emit({ type: 'interrupted' });
                break;
              }
              case 'error': {
                const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN';
                const message = typeof msg.message === 'string' ? msg.message : 'Unknown server error';
                this.emit({ type: 'error', code, message });
                if (!this.isConnectedState) {
                  if (connectionTimeout) {
                    clearTimeout(connectionTimeout);
                    connectionTimeout = null;
                  }
                  reject(new Error(`WebSocket authentication/connection error: ${message}`));
                }
                break;
              }
              case 'disconnected': {
                this.isConnectedState = false;
                this.emit({ type: 'disconnected' });
                break;
              }
            }
          } catch (err: unknown) {
            console.error('Error handling WebSocket message', err);
          }
        };

        this.ws.onerror = (_err: Event) => {
          if (!this.isConnectedState) {
            if (connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = null;
            }
            reject(new Error('WebSocket network error'));
          }
          this.emit({ type: 'error', code: 'NETWORK_ERROR', message: 'WebSocket network error' });
        };

        this.ws.onclose = () => {
          const wasConnected = this.isConnectedState;
          this.isConnectedState = false;
          if (wasConnected) {
            this.emit({ type: 'disconnected' });
          }
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to create WebSocket: ${errMsg}`));
      }
    });
  }

  private wsFramesSentAcc: number = 0;
  private wsBytesSentAcc: number = 0;
  private lastWsDiagTime: number = Date.now();

  public sendAudio(pcmChunk: ArrayBuffer | Uint8Array): void {
    if (!this.isConnected || !this.ws) return;
    const base64Data = arrayBufferToBase64(pcmChunk);
    const jsonMsg = JSON.stringify({ type: 'audio', data: base64Data });
    this.ws.send(jsonMsg);

    this.wsFramesSentAcc++;
    this.wsBytesSentAcc += jsonMsg.length;

    const now = Date.now();
    if (now - this.lastWsDiagTime >= 1000) {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[WEBSOCKET DIAGNOSTICS]', {
          websocketFramesSent: this.wsFramesSentAcc,
          websocketBytesSent: this.wsBytesSentAcc,
        });
      }
      this.lastWsDiagTime = now;
      this.wsFramesSentAcc = 0;
      this.wsBytesSentAcc = 0;
    }
  }

  public sendText(text: string): void {
    if (!this.isConnected || !this.ws || !text.trim()) return;
    this.ws.send(JSON.stringify({ type: 'text', text: text.trim() }));
  }

  public sendInterrupt(): void {
    if (!this.isConnected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'interrupt' }));
  }

  public sendToolResponse(callId: string, result: Record<string, unknown>): void {
    if (!this.isConnected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: 'tool-response', callId, result }));
  }

  public disconnect(): void {
    this.cleanup();
  }

  private cleanup(): void {
    this.isConnectedState = false;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
