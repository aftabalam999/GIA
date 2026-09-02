import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GeminiStreamService, GeminiStreamHandle } from '../src/ai/services/geminiStream.service.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';
import { LLMRequest } from '../src/ai/providers/provider.interface.js';

describe('Gemini Stream Service Suite', () => {
  beforeEach(() => {
    setTestProvider(null);
  });

  afterEach(() => {
    setTestProvider(null);
  });

  it('1. should stream incremental text chunks, trigger onStart, onTextChunk, and onComplete', async () => {
    const mockProvider = new MockProvider();
    setTestProvider(mockProvider);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Hello Afiya' }],
    };

    const receivedChunks: string[] = [];
    let started = false;
    let completedText = '';

    await new Promise<void>((resolve, reject) => {
      GeminiStreamService.startGeneration(
        request,
        {
          onStart: () => {
            started = true;
          },
          onTextChunk: (chunk) => {
            receivedChunks.push(chunk);
          },
          onComplete: (fullText) => {
            completedText = fullText;
            resolve();
          },
          onError: (err) => reject(err),
        },
        { modelType: 'general' }
      );
    });

    expect(started).toBe(true);
    expect(receivedChunks.length).toBeGreaterThan(0);
    expect(completedText).toBe(receivedChunks.join(''));
    expect(completedText).toContain('[Mock Stream Response] Echo: "Hello Afiya"');
  });

  it('2. should support cancellation via cancelGeneration()', async () => {
    const mockProvider = new MockProvider();
    setTestProvider(mockProvider);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Long response generation test' }],
    };

    const receivedChunks: string[] = [];
    let completed = false;

    const handle: GeminiStreamHandle = GeminiStreamService.startGeneration(
      request,
      {
        onTextChunk: (chunk) => {
          receivedChunks.push(chunk);
          if (receivedChunks.length === 5) {
            handle.cancelGeneration();
          }
        },
        onComplete: () => {
          completed = true;
        },
      },
      { modelType: 'general' }
    );

    // Wait for stream processing to conclude
    await new Promise((res) => setTimeout(res, 100));

    expect(handle.isCancelled).toBe(true);
    expect(completed).toBe(false);
    expect(receivedChunks.length).toBe(5);
  });

  it('3. should handle API errors and trigger onError callback', async () => {
    const failingProvider = new MockProvider(true); // shouldFail = true
    setTestProvider(failingProvider);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Trigger error' }],
    };

    let caughtError: Error | null = null;

    await new Promise<void>((resolve) => {
      GeminiStreamService.startGeneration(request, {
        onError: (err) => {
          caughtError = err;
          resolve();
        },
        onComplete: () => {
          resolve();
        },
      });
    });

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('Simulated LLM stream failure');
  });
});
