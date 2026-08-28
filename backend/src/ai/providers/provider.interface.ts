export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  systemPrompt?: string;
  messages: LLMMessage[];
  temperature?: number;
  responseFormat?: 'json' | 'text';
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
}

export interface LLMChunk {
  content: string;
}

export interface LLMProvider {
  generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncIterable<LLMChunk>;
}
