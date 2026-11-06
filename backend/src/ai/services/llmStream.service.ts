import { LLMRequest } from '../providers/provider.interface.js';
import { LLMGateway, GatewayOptions } from '../router/index.js';
import { logger } from '../../shared/logger.js';
import { SpeechTextChunker } from './textChunker.js';

export interface StreamGenerationCallbacks {
  onStart?: () => void;
  onTextChunk?: (chunk: string) => void;
  onSpeechChunk?: (speechChunk: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
}

export class LLMStreamHandle {
  private controller: AbortController;
  private _isCancelled = false;
  private _isCompleted = false;

  constructor() {
    this.controller = new AbortController();
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isCancelled(): boolean {
    return this._isCancelled;
  }

  public get isCompleted(): boolean {
    return this._isCompleted;
  }

  /**
   * Immediately halts active local LLM text stream generation.
   */
  public cancelGeneration(): void {
    if (this._isCancelled || this._isCompleted) return;
    this._isCancelled = true;
    this.controller.abort();
    logger.info({ msg: '🛑 [LLM STREAM] Stream generation cancelled by caller' });
  }

  public markCompleted(): void {
    this._isCompleted = true;
  }
}

/**
 * LLMStreamService provides an event-driven incremental streaming abstraction over the local LLM.
 * Dispatches raw text chunks and speech-ready chunks immediately without full response buffering.
 */
export class LLMStreamService {
  /**
   * Initiates streaming generation for GIA using the local Qwen 3.5 4B model.
   * Returns an LLMStreamHandle exposing cancelGeneration().
   */
  static startGeneration(
    request: LLMRequest,
    callbacks: StreamGenerationCallbacks,
    options: GatewayOptions = {}
  ): LLMStreamHandle {
    const handle = new LLMStreamHandle();
    const chunker = new SpeechTextChunker();

    (async () => {
      let fullText = '';
      try {
        if (callbacks.onStart) {
          callbacks.onStart();
        }

        const stream = LLMGateway.stream(request, options, handle.signal);

        for await (const chunk of stream) {
          if (handle.isCancelled || handle.signal.aborted) {
            chunker.cancel();
            break;
          }
          if (chunk.content) {
            fullText += chunk.content;
            if (callbacks.onTextChunk) {
              callbacks.onTextChunk(chunk.content);
            }
            if (callbacks.onSpeechChunk) {
              const speechChunks = chunker.push(chunk.content);
              for (const sc of speechChunks) {
                callbacks.onSpeechChunk(sc);
              }
            }
          }
        }

        if (!handle.isCancelled && !handle.signal.aborted) {
          if (callbacks.onSpeechChunk) {
            const finalSpeechChunks = chunker.flush();
            for (const sc of finalSpeechChunks) {
              callbacks.onSpeechChunk(sc);
            }
          }
          handle.markCompleted();
          if (callbacks.onComplete) {
            callbacks.onComplete(fullText);
          }
        }
      } catch (err: any) {
        if (handle.isCancelled || handle.signal.aborted) {
          logger.info({ msg: 'Local LLM stream generation aborted cleanly' });
          return;
        }
        logger.error({ msg: 'Local LLM stream generation encountered an error', err: err.message });
        if (callbacks.onError) {
          callbacks.onError(err);
        }
      }
    })();

    return handle;
  }
}


