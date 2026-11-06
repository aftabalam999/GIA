import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from './provider.interface.js';
import { logger } from '../../shared/logger.js';

/**
 * Local Qwen 3.5 4B inference provider for GIA.
 * Communicates directly with the local Python FastAPI AI inference engine.
 * Never connects to any cloud provider or external network endpoint.
 */
export class LocalQwenProvider implements LLMProvider {
  private baseUrl: string;
  private defaultModel: string;

  constructor(baseUrl = 'http://127.0.0.1:8001', defaultModel = 'Qwen3.5-4B') {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:8001').replace(/\/+$/, '');
    this.defaultModel = defaultModel;
  }

  /**
   * Non-streaming chat completion via local Qwen 3.5 4B model.
   */
  async generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const endpoint = `${this.baseUrl}/api/llm/chat`;
    logger.info({
      msg: '🏠 [LOCAL QWEN PROVIDER] Invoking local Qwen 3.5 4B inference engine',
      endpoint,
      model: this.defaultModel,
      messageCount: request.messages.length,
    });

    const body: Record<string, any> = {
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      model: this.defaultModel,
    };

    if (request.systemPrompt) {
      body.system_prompt = request.systemPrompt;
    }

    if (typeof request.temperature === 'number') {
      body.temperature = request.temperature;
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    if (typeof request.maxTokens === 'number') {
      body.max_new_tokens = request.maxTokens;
    }

    body.enable_thinking = request.enableThinking ?? false;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Local Qwen API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = data.choices?.[0]?.message?.content || '';

    return {
      content,
      model: data.model || this.defaultModel,
      provider: 'qwen',
    };
  }

  /**
   * Real-time SSE streaming chat completion via local Qwen 3.5 4B model.
   */
  async *stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMChunk> {
    if (signal?.aborted) {
      const err = new Error('Operation aborted');
      err.name = 'AbortError';
      throw err;
    }

    const endpoint = `${this.baseUrl}/api/llm/chat/stream`;
    logger.info({
      msg: '🏠 [LOCAL QWEN PROVIDER STREAM] Initiating local Qwen SSE stream',
      endpoint,
      model: this.defaultModel,
    });

    const body: Record<string, any> = {
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      model: this.defaultModel,
      stream: true,
    };

    if (request.systemPrompt) {
      body.system_prompt = request.systemPrompt;
    }

    if (typeof request.temperature === 'number') {
      body.temperature = request.temperature;
    }

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    if (typeof request.maxTokens === 'number') {
      body.max_new_tokens = request.maxTokens;
    }

    body.enable_thinking = request.enableThinking ?? false;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Local Qwen streaming error: ${response.status} - ${errorText}`);
    }

    const bodyStream = response.body;
    if (!bodyStream) {
      throw new Error('Local Qwen streaming error: Missing readable response stream body');
    }

    const reader = (bodyStream as any).getReader ? (bodyStream as any).getReader() : null;
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    if (reader) {
      try {
        while (true) {
          if (signal?.aborted) {
            await reader.cancel();
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') {
              return;
            }
            try {
              const parsed = JSON.parse(dataStr);
              const chunkContent = parsed.choices?.[0]?.delta?.content;
              if (chunkContent) {
                yield { content: chunkContent };
              }
            } catch {
              // Ignore non-json or partial lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      for await (const chunk of bodyStream as any) {
        if (signal?.aborted) break;
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            return;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const chunkContent = parsed.choices?.[0]?.delta?.content;
            if (chunkContent) {
              yield { content: chunkContent };
            }
          } catch {
            // Ignore non-json lines
          }
        }
      }
    }
  }
}

