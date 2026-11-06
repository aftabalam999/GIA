import { describe, it, expect } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { detectWakeWord } from '../utils/wakeWord.js';

describe('GIA Voice Wake-Word Authorization Suite', () => {
  describe('detectWakeWord() Utility', () => {
    it('should authorize "Hey GIA, open terminal"', () => {
      const res = detectWakeWord('Hey GIA, open terminal');
      expect(res.isAuthorized).toBe(true);
      expect(res.command).toBe('open terminal');
      expect(res.wakeWord).toBe('GIA');
    });

    it('should authorize "GIA what is my next reminder"', () => {
      const res = detectWakeWord('GIA what is my next reminder');
      expect(res.isAuthorized).toBe(true);
      expect(res.command).toBe('what is my next reminder');
    });

    it('should detect wake-only for "Hey GIA"', () => {
      const res = detectWakeWord('Hey GIA');
      expect(res.isAuthorized).toBe(true);
      expect(res.isWakeOnly).toBe(true);
      expect(res.command).toBe('');
    });

    it('should reject speech without wake word', () => {
      const res = detectWakeWord('open Google Chrome immediately');
      expect(res.isAuthorized).toBe(false);
      expect(res.command).toBe('');
    });
  });

  describe('VoiceStateMachine Wake-Word Gating Integration', () => {
    it('should reject command execution when requireWakeWord=true and wake word is absent', async () => {
      let sttCount = 0;
      let agentCount = 0;
      let transcriptReported = '';

      const vsm = new VoiceStateMachine({
        requireWakeWord: true,
        fetchTranscribeApi: async () => {
          sttCount++;
          return { text: 'open VS Code' };
        },
        fetchChatApi: async () => {
          agentCount++;
          return { assistantMessage: { content: 'Opening VS Code' } };
        },
        onTranscript: (t) => {
          transcriptReported = t;
        },
      });

      await vsm.startVoiceMode('convo-wake-1', 'token-wake-1', false);
      await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

      expect(sttCount).toBe(1);
      expect(agentCount).toBe(0); // MUST NOT execute!
      expect(transcriptReported).toContain('Ignored: Wake word required');
      expect(vsm.state).toBe('LISTENING'); // Continuous listening preserved
    });

    it('should authorize and execute command when user speaks "Hey GIA, open VS Code"', async () => {
      let sttCount = 0;
      let agentExecutedCommand = '';
      let ttsCount = 0;

      const vsm = new VoiceStateMachine({
        requireWakeWord: true,
        fetchTranscribeApi: async () => {
          sttCount++;
          return { text: 'Hey GIA, open VS Code' };
        },
        fetchChatApi: async (_cid, cmd) => {
          agentExecutedCommand = cmd;
          return { assistantMessage: { content: 'Opening VS Code now.' } };
        },
        fetchTtsApi: async () => {
          ttsCount++;
          return new ArrayBuffer(8);
        },
        playAudioApi: async () => {},
      });

      await vsm.startVoiceMode('convo-wake-2', 'token-wake-2', false);
      await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

      expect(sttCount).toBe(1);
      expect(agentExecutedCommand).toBe('open VS Code');
      expect(ttsCount).toBe(1);
      expect(vsm.state).toBe('LISTENING');
    });

    it('should acknowledge stand-alone wake word "Hey GIA" with listening prompt', async () => {
      let ttsSpokenText = '';

      const vsm = new VoiceStateMachine({
        requireWakeWord: true,
        fetchTranscribeApi: async () => {
          return { text: 'Hey GIA' };
        },
        fetchChatApi: async () => {
          throw new Error('Chat API should not be called for wake-only');
        },
        fetchTtsApi: async (txt) => {
          ttsSpokenText = txt;
          return new ArrayBuffer(8);
        },
        playAudioApi: async () => {},
      });

      await vsm.startVoiceMode('convo-wake-3', 'token-wake-3', false);
      await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

      expect(ttsSpokenText).toContain("I'm listening");
      expect(vsm.state).toBe('LISTENING');
    });
  });
});

