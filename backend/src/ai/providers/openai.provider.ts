import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from './provider.interface.js';
import { logger } from '../../shared/logger.js';
import { withRetryAndTimeout } from '../../shared/retry.js';

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = 'gpt-4o-mini') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push(...request.messages);

    const body: any = {
      model: this.defaultModel,
      messages,
      temperature: request.temperature ?? 0.7,
    };
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as any;
    return {
      content: data.choices[0].message.content,
      model: this.defaultModel,
      provider: 'openai',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const messages = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push(...request.messages);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.defaultModel,
          messages,
          temperature: request.temperature ?? 0.7,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API streaming error: ${response.status} - ${errorText}`);
      }

      const bodyStream = response.body as any;
      if (!bodyStream) {
        throw new Error('Response body is not readable');
      }

      // Read response chunks in a standard stream reader loop
      for await (const chunk of bodyStream) {
        const text = new TextDecoder('utf-8').decode(chunk as any);
        const lines = text.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            const data = JSON.parse(trimmed.slice(6));
            const chunkText = data.choices[0]?.delta?.content || '';
            if (chunkText) {
              yield { content: chunkText };
            }
          }
        }
      }
    } catch (err: any) {
      logger.error({ msg: 'OpenAI stream failed', err: err.message });
      throw err;
    }
  }
}
