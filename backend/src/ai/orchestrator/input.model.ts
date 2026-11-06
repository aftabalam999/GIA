import crypto from 'crypto';

export type InputType = 'text' | 'voice';

export interface VoiceMetadata {
  duration?: number;
  confidence?: number;
  language?: string;
  processingTime?: number;
  audioFilename?: string;
  segmentsCount?: number;
  [key: string]: any;
}

export interface NormalizedUserInput {
  inputType: InputType;
  content: string;
  userId: string;
  conversationId: string;
  requestId: string;
  timestamp: string;
  metadata?: {
    voice?: VoiceMetadata;
    [key: string]: any;
  };
}

export interface NormalizeInputOptions {
  inputType?: InputType;
  requestId?: string;
  timestamp?: string;
  metadata?: Record<string, any>;
  voiceMetadata?: VoiceMetadata;
}

/**
 * Helper function normalizing raw text strings or partial input objects into a structured NormalizedUserInput.
 */
export function normalizeUserInput(
  input: string | Partial<NormalizedUserInput>,
  userId: string,
  conversationId: string,
  options: NormalizeInputOptions = {}
): NormalizedUserInput {
  const isObject = typeof input === 'object' && input !== null;
  const content = (isObject ? input.content : input) || '';
  const inputType: InputType = (isObject ? input.inputType : options.inputType) || 'text';
  const requestId = (isObject ? input.requestId : options.requestId) || crypto.randomUUID();
  const timestamp = (isObject ? input.timestamp : options.timestamp) || new Date().toISOString();

  let mergedMetadata: Record<string, any> = {
    ...(options.metadata || {}),
    ...(isObject && input.metadata ? input.metadata : {}),
  };

  if (options.voiceMetadata || (isObject && (input as any).voiceMetadata)) {
    mergedMetadata.voice = {
      ...(mergedMetadata.voice || {}),
      ...(options.voiceMetadata || (input as any).voiceMetadata || {}),
    };
  }

  return {
    inputType,
    content: content.trim(),
    userId,
    conversationId,
    requestId,
    timestamp,
    metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
  };
}
