import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from './provider.interface.js';
import { logger } from '../../shared/logger.js';
import { withRetryAndTimeout } from '../../shared/retry.js';

export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = 'claude-3-5-sonnet-20241022') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const body: any = {
      model: this.defaultModel,
      messages: request.messages,
      max_tokens: 2048,
      temperature: request.temperature ?? 0.7,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = data.content?.[0]?.text || '';

    return {
      content,
      model: this.defaultModel,
      provider: 'anthropic',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const body: any = {
      model: this.defaultModel,
      messages: request.messages,
      max_tokens: 2048,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API streaming error: ${response.status} - ${errorText}`);
    }

    const bodyStream = response.body as any;
    if (!bodyStream) {
      throw new Error('Response body is not readable');
    }

    for await (const chunk of bodyStream) {
      const text = new TextDecoder('utf-8').decode(chunk as any);
      const lines = text.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.type === 'content_block_delta' && data.delta?.text) {
              yield { content: data.delta.text };
            }
          } catch {
            // Skip invalid parse lines
          }
        }
      }
    }
  }
}
