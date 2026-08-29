import { describe, it, expect } from 'vitest';
import { WakeWordDetector } from '../src/shared/wakeword.js';

describe('WakeWordDetector Unit Tests', () => {
  it('should detect wake word and extract basic command', () => {
    const result = WakeWordDetector.detect('GIA open YouTube');
    expect(result.detected).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.command).toBe('open YouTube');
  });

  it('should return detected = false when wake word is absent', () => {
    const result = WakeWordDetector.detect('I think I should open VS Code tomorrow.');
    expect(result.detected).toBe(false);
    expect(result.confidence).toBe(0.0);
    expect(result.command).toBeNull();
  });

  it('should handle different capitalizations of GIA', () => {
    const capsResult = WakeWordDetector.detect('gia search memories');
    expect(capsResult.detected).toBe(true);
    expect(capsResult.command).toBe('search memories');

    const camelResult = WakeWordDetector.detect('Gia list documents');
    expect(camelResult.detected).toBe(true);
    expect(camelResult.command).toBe('list documents');
  });

  it('should handle wake word trailers and punctuation properly', () => {
    const result1 = WakeWordDetector.detect('GIA, open YouTube');
    expect(result1.detected).toBe(true);
    expect(result1.command).toBe('open YouTube');

    const result2 = WakeWordDetector.detect('Hey GIA, open YouTube!');
    expect(result2.detected).toBe(true);
    expect(result2.command).toBe('open YouTube!');
  });

  it('should handle the wake word at the beginning with optional greetings', () => {
    const result1 = WakeWordDetector.detect('GIA search memories');
    expect(result1.detected).toBe(true);

    const result2 = WakeWordDetector.detect('Hey GIA search memories');
    expect(result2.detected).toBe(true);
    expect(result2.command).toBe('search memories');

    const result3 = WakeWordDetector.detect('ok GIA please list documents');
    expect(result3.detected).toBe(true);
    expect(result3.command).toBe('list documents');
  });

  it('should isolate wake word from word boundaries to avoid partial matching', () => {
    // Word boundary checks (not matching "giant", "plagiarize", etc)
    const result1 = WakeWordDetector.detect('GIAnt open VS Code');
    expect(result1.detected).toBe(false);

    const result2 = WakeWordDetector.detect('plagiarize this file');
    expect(result2.detected).toBe(false);
  });

  it('should support wake word detected with no trailing command', () => {
    const result = WakeWordDetector.detect('Hey GIA');
    expect(result.detected).toBe(true);
    expect(result.command).toBeNull();
  });

  it('should ignore normal conversation containing no wake word', () => {
    const result = WakeWordDetector.detect('Hello, I was just speaking with my colleague.');
    expect(result.detected).toBe(false);
    expect(result.command).toBeNull();
  });
});
