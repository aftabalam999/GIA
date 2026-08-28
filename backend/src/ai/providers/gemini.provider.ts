import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from './provider.interface.js';
import { logger } from '../../shared/logger.js';
import { withRetryAndTimeout } from '../../shared/retry.js';

export class GeminiProvider implements LLMProvider {
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel = 'gemini-2.5-flash') {
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

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.defaultModel}:streamGenerateContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      const text = new TextDecoder('utf-8').decode(chunk as any);
      try {
        // Strip array wrappers if present
        const cleanText = text.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
        if (!cleanText) continue;

        const objects = cleanText.split('\n');
        for (const obj of objects) {
          const trimmedObj = obj.trim();
          if (!trimmedObj) continue;

          // Strip comma prefix if streaming inside array
          const cleanObj = trimmedObj.replace(/^,/, '').trim();
          const data = JSON.parse(cleanObj);
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
