import { describe, it, expect } from 'vitest';
import { detectWakeWord } from './wakeWord.js';

describe('Focused Wake-Word Detection & Authorization Unit Tests', () => {
  describe('Should Activate (Strong Afiya Authorization)', () => {
    const activateCases = [
      { input: 'Afiya', expectedCommand: '' },
      { input: 'afiya', expectedCommand: '' },
      { input: 'Afiya open VS Code', expectedCommand: 'open VS Code' },
      { input: 'Afiya open VS Code', expectedCommand: 'open VS Code' },
      { input: 'Hey Afiya open Chrome', expectedCommand: 'open Chrome' },
      { input: 'Hey, Afiya, open Chrome', expectedCommand: 'open Chrome' },
      { input: 'Hello Afiya search React', expectedCommand: 'search React' },
      { input: 'Hi Afiya create a file', expectedCommand: 'create a file' },
      { input: 'Okay Afiya run this', expectedCommand: 'run this' },
      { input: 'Ok Afiya close Chrome', expectedCommand: 'close Chrome' },
      { input: "Yo Afiya what's the weather", expectedCommand: "what's the weather" },
    ];

    for (const { input, expectedCommand } of activateCases) {
      it(`should activate for "${input}"`, () => {
        const res = detectWakeWord(input);
        expect(res.activated).toBe(true);
        expect(res.isAuthorized).toBe(true);
        expect(res.command).toBe(expectedCommand);
      });
    }
  });

  describe('Should NOT Activate (Un-authorized / No Afiya Authorization)', () => {
    const notAuthorizeCases = [
      'open VS Code',
      'open Chrome',
      'search React',
      'create a file',
      'hi',
      'hello',
      'hey',
      "what's up",
      'whats up',
      'how are you',
      'good morning',
      'good afternoon',
      'good evening',
      'Hi, open VS Code',
      'Hello, search React',
    ];

    for (const input of notAuthorizeCases) {
      it(`should NOT authorize command execution for "${input}"`, () => {
        const res = detectWakeWord(input);
        expect(res.isAuthorized).toBe(false);
      });
    }
  });

  describe('Command Extraction', () => {
    it('extracts "open VS Code" from "Afiya open VS Code"', () => {
      const res = detectWakeWord('Afiya open VS Code');
      expect(res.command).toBe('open VS Code');
    });

    it('extracts "open Chrome" from "Hey Afiya, open Chrome"', () => {
      const res = detectWakeWord('Hey Afiya, open Chrome');
      expect(res.command).toBe('open Chrome');
    });

    it('extracts "search React" from "Hello Afiya search React"', () => {
      const res = detectWakeWord('Hello Afiya search React');
      expect(res.command).toBe('search React');
    });

    it('extracts empty command from "Afiya"', () => {
      const res = detectWakeWord('Afiya');
      expect(res.command).toBe('');
    });
  });

  describe('Formatting & Edge Cases', () => {
    it('handles uppercase/lowercase variations', () => {
      const res1 = detectWakeWord('afiya');
      expect(res1.isAuthorized).toBe(true);

      const res2 = detectWakeWord('Afiya');
      expect(res2.isAuthorized).toBe(true);

      const res3 = detectWakeWord('hEy aFiYa OpeN cHrOmE');
      expect(res3.isAuthorized).toBe(true);
      expect(res3.command).toBe('OpeN cHrOmE');
    });

    it('handles punctuation correctly', () => {
      const res = detectWakeWord('Hey, Afiya: open Chrome!');
      expect(res.isAuthorized).toBe(true);
      expect(res.command).toBe('open Chrome!');
    });

    it('handles extra and leading/trailing whitespace', () => {
      const res = detectWakeWord('   Hey   Afiya ,   open   Chrome   ');
      expect(res.isAuthorized).toBe(true);
      expect(res.command).toBe('open   Chrome');
    });

    it('handles empty transcript', () => {
      const res1 = detectWakeWord('');
      expect(res1.activated).toBe(false);
      expect(res1.isAuthorized).toBe(false);
      expect(res1.command).toBe('');

      const res2 = detectWakeWord('   ');
      expect(res2.activated).toBe(false);
      expect(res2.isAuthorized).toBe(false);
      expect(res2.command).toBe('');
    });

    it('handles null and undefined transcript inputs safely', () => {
      const res1 = detectWakeWord(null as any);
      expect(res1.activated).toBe(false);
      expect(res1.isAuthorized).toBe(false);
      expect(res1.command).toBe('');

      const res2 = detectWakeWord(undefined as any);
      expect(res2.activated).toBe(false);
      expect(res2.isAuthorized).toBe(false);
      expect(res2.command).toBe('');
    });
  });
});
