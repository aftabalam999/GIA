import crypto from 'crypto';
import { config } from '../../config/index.js';
import { logger } from '../../shared/logger.js';
import {
  StructuredTranscriptionResult,
  STTStatusResult,
  AIHealthResult,
  DeepReadinessProbeResult,
  EmbedResult,
  RerankResult,
  EmbeddingStatusResult,
  RerankerStatusResult,
  ClientRequestOptions,
  AIServiceError,
  AIServiceUnavailableError,
  AIServiceTimeoutError,
  AIServiceValidationError,
  AIServiceExecutionError,
} from './ai-service.types.js';

export class AIServiceClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl?: string, defaultTimeoutMs?: number) {
    this.baseUrl = (baseUrl || config.AI_SERVICE_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
    this.defaultTimeoutMs = defaultTimeoutMs || config.AI_SERVICE_TIMEOUT_MS || 30000;
  }

  /**
   * Transcribes raw audio buffer via the Python AI service STT endpoint.
   */
  async transcribe(
    audio: Buffer,
    filename: string = 'audio.wav',
    language?: string,
    options: ClientRequestOptions = {}
  ): Promise<StructuredTranscriptionResult> {
    if (!audio || audio.length === 0) {
      throw new AIServiceValidationError('Empty audio buffer provided for transcription', 400);
    }

    const formData = new FormData();
    const blob = new Blob([audio], { type: 'audio/wav' });
    formData.append('file', blob, filename);
    if (language) {
      formData.append('language', language);
    }

    const endpoint = `${this.baseUrl}/v1/stt/transcribe`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return this.request<StructuredTranscriptionResult>(endpoint, {
      method: 'POST',
      body: formData,
      options,
      timeoutMs,
      shouldRetry: false, // Do not retry non-idempotent heavy inference
    });
  }

  /**
   * Synthesizes text into audio binary buffer via Python AI service TTS endpoint.
   */
  async synthesize(
    text: string,
    voice?: string,
    speed?: string,
    options: ClientRequestOptions = {}
  ): Promise<Buffer> {
    if (!text || text.trim().length === 0) {
      throw new AIServiceValidationError('Text is required for TTS synthesis', 400);
    }

    const endpoint = `${this.baseUrl}/v1/tts/synthesize`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const res = await this.request<ArrayBuffer>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ text, voice, speed }),
      headers: { 'Content-Type': 'application/json' },
      options,
      timeoutMs,
      shouldRetry: false,
    });

    return Buffer.from(res);
  }

  /**
   * Generates vector embedding via the Python AI service embedding endpoint.
   */
  async embed(
    textInput: string | string[],
    options: ClientRequestOptions = {}
  ): Promise<EmbedResult> {
    const endpoint = `${this.baseUrl}/v1/embeddings/embed`;
    const timeoutMs = options.timeoutMs ?? 10000;
    const body = typeof textInput === 'string' ? { text: textInput } : { texts: textInput };

    return this.request<EmbedResult>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      options,
      timeoutMs,
      shouldRetry: true,
    });
  }

  /**
   * Reranks document candidate texts against a query using Python AI Reranker Service.
   */
  async rerank(
    query: string,
    documents: string[],
    topK?: number,
    options: ClientRequestOptions = {}
  ): Promise<RerankResult> {
    const endpoint = `${this.baseUrl}/v1/reranker/rerank`;
    const timeoutMs = options.timeoutMs ?? 10000;

    return this.request<RerankResult>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ query, documents, top_k: topK }),
      headers: { 'Content-Type': 'application/json' },
      options,
      timeoutMs,
      shouldRetry: true,
    });
  }

  /**
   * Fetches Embedding service readiness status.
   */
  async getEmbeddingStatus(options: ClientRequestOptions = {}): Promise<EmbeddingStatusResult> {
    const endpoint = `${this.baseUrl}/v1/embeddings/status`;
    const timeoutMs = options.timeoutMs ?? 5000;

    return this.request<EmbeddingStatusResult>(endpoint, {
      method: 'GET',
      options,
      timeoutMs,
      shouldRetry: true,
    });
  }

  /**
   * Fetches Reranker service readiness status.
   */
  async getRerankerStatus(options: ClientRequestOptions = {}): Promise<RerankerStatusResult> {
    const endpoint = `${this.baseUrl}/v1/reranker/status`;
    const timeoutMs = options.timeoutMs ?? 5000;

    return this.request<RerankerStatusResult>(endpoint, {
      method: 'GET',
      options,
      timeoutMs,
      shouldRetry: true,
    });
  }

  /**
   * Performs deep readiness & reachability probe against Python AI service.
   * Returns structured reachability, health, readiness, and subsystem status.
   */
  async checkDeepReadiness(options: ClientRequestOptions = {}): Promise<DeepReadinessProbeResult> {
    const endpoint = `${this.baseUrl}/v1/health/readiness`;
    const timeoutMs = options.timeoutMs ?? 3000;

    try {
      const res = await this.request<AIHealthResult>(endpoint, {
        method: 'GET',
        options,
        timeoutMs,
        shouldRetry: false,
      });

      const isHealthy = res.status === 'healthy';
      const isReady = res.ready ?? (isHealthy && Object.values(res.subsystems || {}).every(Boolean));

      return {
        reachable: true,
        healthy: isHealthy,
        ready: isReady,
        subsystems: res.subsystems || {},
      };
    } catch (err: any) {
      if (err instanceof AIServiceError && err.statusCode === 503 && err.detail) {
        try {
          const detailJson = JSON.parse(err.detail);
          return {
            reachable: true,
            healthy: true,
            ready: false,
            subsystems: detailJson.subsystems || {},
            error: 'One or more model subsystems failed readiness probe',
          };
        } catch {
          // ignore parse failure
        }
      }

      return {
        reachable: false,
        healthy: false,
        ready: false,
        subsystems: {
          audio_processor: false,
          vad: false,
          stt: false,
          tts: false,
          embedding: false,
          reranker: false,
        },
        error: err.message || 'Python AI Service unreachable',
      };
    }
  }

  /**
   * Fetches overall Python AI service health status.
   */
  async health(options: ClientRequestOptions = {}): Promise<AIHealthResult> {
    const endpoint = `${this.baseUrl}/health`;
    const timeoutMs = options.timeoutMs ?? 5000;

    return this.request<AIHealthResult>(endpoint, {
      method: 'GET',
      options,
      timeoutMs,
      shouldRetry: true, // Idempotent read: safe to retry
    });
  }

  /**
   * Fetches STT model readiness and status.
   */
  async readiness(options: ClientRequestOptions = {}): Promise<STTStatusResult> {
    const endpoint = `${this.baseUrl}/v1/stt/status`;
    const timeoutMs = options.timeoutMs ?? 5000;

    return this.request<STTStatusResult>(endpoint, {
      method: 'GET',
      options,
      timeoutMs,
      shouldRetry: true, // Idempotent read: safe to retry
    });
  }

  /**
   * Internal request executor handling timeout, retries, headers, and structured error mapping.
   */
  private async request<T>(
    url: string,
    params: {
      method: string;
      body?: any;
      headers?: Record<string, string>;
      options: ClientRequestOptions;
      timeoutMs: number;
      shouldRetry: boolean;
    }
  ): Promise<T> {
    const requestId = params.options.requestId || crypto.randomUUID();
    const correlationId = params.options.correlationId || requestId;
    const maxRetries = params.shouldRetry ? (params.options.retries ?? 2) : 0;

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        return await this.executeHttpCall<T>(url, {
          method: params.method,
          body: params.body,
          headers: params.headers,
          requestId,
          correlationId,
          timeoutMs: params.timeoutMs,
        });
      } catch (err: any) {
        lastError = err;
        const isRetryable =
          params.shouldRetry &&
          (err instanceof AIServiceUnavailableError || err instanceof AIServiceTimeoutError);

        if (isRetryable && attempt <= maxRetries) {
          const delayMs = attempt * 200;
          logger.warn({
            msg: `AI Service request failed (attempt ${attempt}/${maxRetries + 1}). Retrying in ${delayMs}ms...`,
            url,
            error: err.message,
            correlationId,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }

    throw lastError || new AIServiceUnavailableError('AI Service request failed after retries');
  }

  /**
   * Low-level fetch wrapper with timeout, header propagation, and status code mapping.
   */
  private async executeHttpCall<T>(
    url: string,
    params: {
      method: string;
      body?: any;
      headers?: Record<string, string>;
      requestId: string;
      correlationId: string;
      timeoutMs: number;
    }
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    const reqHeaders: Record<string, string> = {
      'x-request-id': params.requestId,
      'x-correlation-id': params.correlationId,
      'x-internal-api-key': config.INTERNAL_API_KEY,
      ...(params.headers || {}),
    };

    try {
      const response = await fetch(url, {
        method: params.method,
        body: params.body,
        headers: reqHeaders,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return (await response.json()) as T;
        }
        return (await response.arrayBuffer()) as unknown as T;
      }

      // Handle non-2xx error responses
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = null;
      }

      const errorMessage =
        errorBody?.detail ||
        errorBody?.error?.message ||
        `AI Service returned HTTP ${response.status}`;

      switch (response.status) {
        case 400:
        case 422:
          throw new AIServiceValidationError(errorMessage, response.status, JSON.stringify(errorBody));
        case 503:
          throw new AIServiceUnavailableError(errorMessage, JSON.stringify(errorBody));
        case 504:
          throw new AIServiceTimeoutError(errorMessage, JSON.stringify(errorBody));
        case 500:
          throw new AIServiceExecutionError(errorMessage, JSON.stringify(errorBody));
        default:
          throw new AIServiceError(errorMessage, response.status, 'AIServiceHTTPError', JSON.stringify(errorBody));
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (err instanceof AIServiceError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new AIServiceTimeoutError(`AI Service request timed out after ${params.timeoutMs}ms`);
      }
      logger.error({
        msg: 'AI Service connection failure',
        url,
        error: err.message,
        correlationId: params.correlationId,
      });
      throw new AIServiceUnavailableError(`Failed to connect to AI Service at ${this.baseUrl}: ${err.message}`);
    }
  }
}

export const aiServiceClient = new AIServiceClient();
