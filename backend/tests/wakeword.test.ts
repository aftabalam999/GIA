import { describe, it, expect } from 'vitest';
import { WakeWordDetector } from '../src/shared/wakeword.js';

describe('GIA WakeWordDetector Unit Tests', () => {
  it('should detect GIA wake word and extract basic command', () => {
    const result = WakeWordDetector.detect('GIA open VS Code');
    expect(result.detected).toBe(true);
    expect(result.isAuthorized).toBe(true);
    expect(result.isWakeOnly).toBe(false);
    expect(result.command).toBe('open VS Code');
    expect(result.wakeWord).toBe('GIA');
  });

  it('should detect Hey GIA prefix with punctuation and extract command', () => {
    const result = WakeWordDetector.detect('Hey GIA, what is the weather today?');
    expect(result.detected).toBe(true);
    expect(result.isAuthorized).toBe(true);
    expect(result.isWakeOnly).toBe(false);
    expect(result.command).toBe('what is the weather today?');
  });

  it('should recognize stand-alone wake word as wake-only (authorizing without immediate command)', () => {
    const r1 = WakeWordDetector.detect('Hey GIA');
    expect(r1.detected).toBe(true);
    expect(r1.isAuthorized).toBe(true);
    expect(r1.isWakeOnly).toBe(true);
    expect(r1.command).toBeNull();

    const r2 = WakeWordDetector.detect('GIA');
    expect(r2.detected).toBe(true);
    expect(r2.isAuthorized).toBe(true);
    expect(r2.isWakeOnly).toBe(true);
    expect(r2.command).toBeNull();

    const r3 = WakeWordDetector.detect('Hello GIA!');
    expect(r3.detected).toBe(true);
    expect(r3.isAuthorized).toBe(true);
    expect(r3.isWakeOnly).toBe(true);
  });

  it('should return detected = false and isAuthorized = false when wake word is absent', () => {
    const r1 = WakeWordDetector.detect('open VS Code');
    expect(r1.detected).toBe(false);
    expect(r1.isAuthorized).toBe(false);
    expect(r1.command).toBeNull();

    const r2 = WakeWordDetector.detect('I think I should write more unit tests today.');
    expect(r2.detected).toBe(false);
    expect(r2.isAuthorized).toBe(false);
    expect(r2.command).toBeNull();
  });

  it('should handle all prefix variations (Hello, Hi, OK, Okay, Yo)', () => {
    expect(WakeWordDetector.detect('Hello GIA list documents').isAuthorized).toBe(true);
    expect(WakeWordDetector.detect('Hi GIA summarize this file').isAuthorized).toBe(true);
    expect(WakeWordDetector.detect('OK GIA open terminal').isAuthorized).toBe(true);
    expect(WakeWordDetector.detect('Okay GIA check system health').isAuthorized).toBe(true);
    expect(WakeWordDetector.detect('Yo GIA turn on voice mode').isAuthorized).toBe(true);
  });

  it('should maintain backward compatibility for Afiya wake word', () => {
    const result = WakeWordDetector.detect('Hey Afiya open Chrome');
    expect(result.detected).toBe(true);
    expect(result.isAuthorized).toBe(true);
    expect(result.command).toBe('open Chrome');
    expect(result.wakeWord).toBe('AFIYA');
  });

  it('should handle casing, punctuation, and whitespace variations', () => {
    const res = WakeWordDetector.detect('   hey   gia   ,   open   VS Code   ');
    expect(res.detected).toBe(true);
    expect(res.isAuthorized).toBe(true);
    expect(res.command).toBe('open   VS Code');
  });

  it('should handle empty or whitespace inputs safely', () => {
    expect(WakeWordDetector.detect('')).toEqual({
      detected: false,
      isAuthorized: false,
      isWakeOnly: false,
      wakeWord: null,
      command: null,
    });
    expect(WakeWordDetector.detect('   ')).toEqual({
      detected: false,
      isAuthorized: false,
      isWakeOnly: false,
      wakeWord: null,
      command: null,
    });
  });
});

