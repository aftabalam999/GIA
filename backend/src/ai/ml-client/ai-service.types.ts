/**
 * Type definitions and Domain Exceptions for GIA Python AI Service Client.
 */

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export interface StructuredTranscriptionResult {
  text: string;
  language: string;
  confidence: number;
  duration: number;
  segments: TranscriptionSegment[];
  processing_time: number;
}

export interface STTStatusResult {
  state: 'UNINITIALIZED' | 'LOADING' | 'READY' | 'FAILED' | string;
  model_name: string;
  device: string;
  compute_type: string;
  is_ready: boolean;
  error?: string | null;
}

export interface AIHealthResult {
  status: string;
  ready?: boolean;
  version: string;
  service_name: string;
  timestamp: string;
  subsystems: Record<string, boolean>;
}

export interface DeepReadinessProbeResult {
  reachable: boolean;
  healthy: boolean;
  ready: boolean;
  subsystems: Record<string, boolean>;
  error?: string;
}

export interface EmbedResult {
  embedding?: number[];
  embeddings?: number[][];
  dimension: number;
  processing_time: number;
}

export interface RerankResultItem {
  index: number;
  document: string;
  relevance_score: number;
}

export interface RerankResult {
  results: RerankResultItem[];
  processing_time: number;
}

export interface EmbeddingStatusResult {
  is_ready: boolean;
  model_name: string;
  dimension: number;
  device: string;
}

export interface RerankerStatusResult {
  is_ready: boolean;
  model_name: string;
  device: string;
}

export interface ClientRequestOptions {
  requestId?: string;
  correlationId?: string;
  timeoutMs?: number;
  retries?: number;
}

/** Base domain exception for Python AI Service communication failures */
export class AIServiceError extends Error {
  public readonly statusCode: number;
  public readonly errorType: string;
  public readonly detail?: string;

  constructor(message: string, statusCode: number = 500, errorType: string = 'AIServiceError', detail?: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorType = errorType;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 503 Service Unavailable or Connection Refused */
export class AIServiceUnavailableError extends AIServiceError {
  constructor(message: string = 'AI Service is currently unavailable or unready', detail?: string) {
    super(message, 503, 'AIServiceUnavailableError', detail);
  }
}

/** 504 Gateway Timeout */
export class AIServiceTimeoutError extends AIServiceError {
  constructor(message: string = 'AI Service request timed out', detail?: string) {
    super(message, 504, 'AIServiceTimeoutError', detail);
  }
}

/** 400 / 422 Request Validation or Corrupt Payload Error */
export class AIServiceValidationError extends AIServiceError {
  constructor(message: string = 'Invalid request payload or malformed audio', statusCode: number = 422, detail?: string) {
    super(message, statusCode, 'AIServiceValidationError', detail);
  }
}

/** 500 Internal Service Execution Failure */
export class AIServiceExecutionError extends AIServiceError {
  constructor(message: string = 'AI Service internal execution failure', detail?: string) {
    super(message, 500, 'AIServiceExecutionError', detail);
  }
}
