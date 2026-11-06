import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalQwenProvider } from '../src/ai/providers/qwen.provider.js';
import { LLMRequest } from '../src/ai/providers/provider.interface.js';

describe('LocalQwenProvider Unit Tests', () => {
  let provider: LocalQwenProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new LocalQwenProvider('http://127.0.0.1:8001', 'Qwen3.5-4B');
  });

  it('should successfully execute non-streaming chat generation via local AI service', async () => {
    const mockResponse = {
      id: 'chatcmpl-test-123',
      model: 'Qwen3.5-4B',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello! I am GIA powered by local Qwen 3.5 4B.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as any);

    const request: LLMRequest = {
      systemPrompt: 'You are GIA, a private local assistant.',
      messages: [{ role: 'user', content: 'Who are you?' }],
      temperature: 0.7,
    };

    const result = await provider.generate(request);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8001/api/llm/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const callArgs = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(callArgs.model).toBe('Qwen3.5-4B');
    expect(callArgs.system_prompt).toBe('You are GIA, a private local assistant.');
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'Who are you?' }]);

    expect(result.content).toBe('Hello! I am GIA powered by local Qwen 3.5 4B.');
    expect(result.provider).toBe('qwen');
    expect(result.model).toBe('Qwen3.5-4B');
  });

  it('should pass response_format when json is requested', async () => {
    const mockResponse = {
      choices: [{ message: { content: '{"route": "direct_response"}' } }],
      model: 'Qwen3.5-4B',
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as any);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Classify this intent' }],
      responseFormat: 'json',
    };

    const result = await provider.generate(request);

    const callArgs = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(callArgs.response_format).toEqual({ type: 'json_object' });
    expect(result.content).toBe('{"route": "direct_response"}');
  });

  it('should throw structured error when local inference engine returns HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Model currently unready or loading',
    } as any);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Test fail' }],
    };

    await expect(provider.generate(request)).rejects.toThrow(
      'Local Qwen API error: 503 - Model currently unready or loading'
    );
  });

  it('should stream Server-Sent Events from local Qwen SSE endpoint', async () => {
    const ssePayload = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"2","choices":[{"delta":{"content":" from"}}]}\n\n',
      'data: {"id":"3","choices":[{"delta":{"content":" Qwen"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: stream,
    } as any);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Stream test' }],
    };

    const chunks: string[] = [];
    for await (const chunk of provider.stream(request)) {
      chunks.push(chunk.content);
    }

    expect(chunks).toEqual(['Hello', ' from', ' Qwen']);
  });

  it('should halt streaming cleanly when AbortSignal triggers', async () => {
    const controller = new AbortController();
    controller.abort();

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Stream aborted' }],
    };

    await expect(async () => {
      for await (const _chunk of provider.stream(request, controller.signal)) {
        // should not reach
      }
    }).rejects.toThrow('Operation aborted');
  });
});

