import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from './provider.interface.js';
import { logger } from '../../shared/logger.js';
import { withRetryAndTimeout } from '../../shared/retry.js';

export class GeminiProvider implements LLMProvider {
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = 'gemini-3.6-flash') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const contents = request.messages.map((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      return {
        role,
        parts: [{ text: m.content }],
      };
    });

    const body: any = { contents };

    if (request.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    if (request.responseFormat === 'json') {
      body.generationConfig = {
        responseMimeType: 'application/json',
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.defaultModel}:generateContent?key=${this.apiKey}`;
    logger.info({
      msg: '🌐 [GEMINI API] Hitting Google Gemini Generative Language API',
      model: this.defaultModel,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return {
      content,
      model: this.defaultModel,
      provider: 'gemini',
    };
  }

  async *stream(request: LLMRequest, signal?: AbortSignal): AsyncIterable<LLMChunk> {
    if (signal?.aborted) {
      const err = new Error('Operation aborted');
      err.name = 'AbortError';
      throw err;
    }

    const contents = request.messages.map((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      return {
        role,
        parts: [{ text: m.content }],
      };
    });

    const body: any = { contents };
    if (request.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.defaultModel}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    logger.info({
      msg: '🌐 [GEMINI API STREAM] Streaming content from Google Gemini Generative Language API',
      model: this.defaultModel,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API streaming error: ${response.status} - ${errorText}`);
    }

    const bodyStream = response.body as any;
    if (!bodyStream) {
      throw new Error('Response body is not readable');
    }

    for await (const chunk of bodyStream) {
      if (signal?.aborted) {
        break;
      }
      const text = new TextDecoder('utf-8').decode(chunk as any);
      try {
        const lines = text.split('\n');
        for (const line of lines) {
          if (signal?.aborted) break;
          const trimmed = line.trim();
          if (!trimmed) continue;

          let jsonStr = trimmed;
          if (trimmed.startsWith('data:')) {
            jsonStr = trimmed.slice(5).trim();
          } else {
            jsonStr = trimmed.replace(/^\[/, '').replace(/\]$/, '').replace(/^,/, '').trim();
          }
          if (!jsonStr || jsonStr === '[DONE]') continue;

          const data = JSON.parse(jsonStr);
          const chunkText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (chunkText) {
            yield { content: chunkText };
          }
        }
      } catch (err) {
        logger.debug({ msg: 'Ignored malformed stream chunk parsing error', text });
      }
    }
  }
}
