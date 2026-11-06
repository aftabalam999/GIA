import { describe, it, expect } from 'vitest';
import { SpeechTextChunker } from '../src/ai/services/textChunker.js';

describe('SpeechTextChunker Unit Test Suite', () => {
  it('1. Normal sentence: should emit completed sentence when punctuation is pushed', () => {
    const chunker = new SpeechTextChunker();
    const tokens = ['Sure', ', I', ' can', ' help', ' you', ' with', ' that.'];
    const chunks: string[] = [];

    tokens.forEach((t) => {
      chunks.push(...chunker.push(t));
    });
    chunks.push(...chunker.flush());

    expect(chunks).toEqual(['Sure, I can help you with that.']);
  });

  it('2. Multiple sentences: should emit each completed sentence individually as speech-ready chunks', () => {
    const chunker = new SpeechTextChunker();
    const tokens = ['Hello!', ' How', ' are', ' you', ' doing', ' today?', ' I am', ' ready.'];
    const chunks: string[] = [];

    tokens.forEach((t) => {
      chunks.push(...chunker.push(t));
    });
    chunks.push(...chunker.flush());

    expect(chunks).toEqual(['Hello!', 'How are you doing today?', 'I am ready.']);
  });

  it('3. Long sentence: should perform word boundary flush when maxChunkLength threshold is exceeded', () => {
    const chunker = new SpeechTextChunker({ minChunkLength: 15, maxChunkLength: 50 });
    const tokens = ['This is a very long continuous text token sequence ', 'without any explicit sentence punctuation ', 'until the very end of the stream.'];
    const chunks: string[] = [];

    tokens.forEach((t) => {
      chunks.push(...chunker.push(t));
    });
    chunks.push(...chunker.flush());

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('This is a very long continuous text token sequence');
    expect(chunks.join(' ')).toContain('until the very end of the stream.');
  });

  it('4. Punctuation: should preserve natural punctuation and clause boundaries', () => {
    const chunker = new SpeechTextChunker({ minChunkLength: 15, maxChunkLength: 80 });
    const tokens = ['First, open the settings menu, ', 'and select voice options.'];
    const chunks: string[] = [];

    tokens.forEach((t) => {
      chunks.push(...chunker.push(t));
    });
    chunks.push(...chunker.flush());

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toBe('First, open the settings menu,');
    expect(chunks[1]).toBe('and select voice options.');
  });

  it('5. Stream ending without punctuation: should flush remaining buffer upon final completion', () => {
    const chunker = new SpeechTextChunker();
    const tokens = ['Opening VS Code'];
    const chunks: string[] = [];

    tokens.forEach((t) => {
      chunks.push(...chunker.push(t));
    });
    // Pushing token without trailing punctuation yields no chunk yet
    expect(chunks).toEqual([]);

    // Flushing upon stream completion emits final chunk
    const finalChunks = chunker.flush();
    expect(finalChunks).toEqual(['Opening VS Code']);
  });

  it('6. Cancellation: should halt chunking and discard remaining buffer when cancel() is called', () => {
    const chunker = new SpeechTextChunker();
    chunker.push('Initial text without punctuation');
    
    chunker.cancel();

    expect(chunker.push(' More text.')).toEqual([]);
    expect(chunker.flush()).toEqual([]);
  });

  it('7. Empty response: should return empty array for empty tokens or empty stream', () => {
    const chunker = new SpeechTextChunker();

    expect(chunker.push('')).toEqual([]);
    expect(chunker.push('   ')).toEqual([]);
    expect(chunker.flush()).toEqual([]);
  });
});
