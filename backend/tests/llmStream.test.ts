import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LLMStreamService, LLMStreamHandle } from '../src/ai/services/llmStream.service.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';
import { LLMRequest } from '../src/ai/providers/provider.interface.js';

describe('Local LLM Stream Service Suite', () => {
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
      messages: [{ role: 'user', content: 'Hello GIA' }],
    };

    const receivedChunks: string[] = [];
    let started = false;
    let completedText = '';

    await new Promise<void>((resolve, reject) => {
      LLMStreamService.startGeneration(
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
    expect(completedText).toContain('[Mock Stream Response] Echo: "Hello GIA"');
  });

  it('2. should support cancellation via cancelGeneration()', async () => {
    const mockProvider = new MockProvider();
    setTestProvider(mockProvider);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Long response generation test' }],
    };

    let handle: LLMStreamHandle;
    let chunkCount = 0;

    await new Promise<void>((resolve) => {
      handle = LLMStreamService.startGeneration(
        request,
        {
          onTextChunk: () => {
            chunkCount++;
            if (chunkCount >= 1) {
              handle.cancelGeneration();
              resolve();
            }
          },
        },
        { modelType: 'general' }
      );
    });

    expect(handle!.isCancelled).toBe(true);
  });

  it('3. should dispatch natural speech-ready chunks for TTS integration', async () => {
    const mockProvider = new MockProvider();
    setTestProvider(mockProvider);

    const request: LLMRequest = {
      messages: [{ role: 'user', content: 'Short speech chunk test' }],
    };

    const speechChunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      LLMStreamService.startGeneration(
        request,
        {
          onSpeechChunk: (sc) => {
            speechChunks.push(sc);
          },
          onComplete: () => {
            resolve();
          },
          onError: (err) => reject(err),
        },
        { modelType: 'general' }
      );
    });

    expect(speechChunks.length).toBeGreaterThan(0);
  });
});

