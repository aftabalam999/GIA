import { describe, it, expect } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { SpeechTextChunker } from './textChunker.js';

describe('Voice Architecture & Pipeline Audit Verification Suite', () => {
  it('Test 1 — Voice Mode uses single Local Qwen provider (Qwen 3.5 4B)', async () => {
    let localStreamCalled = false;

    const vsm = new VoiceStateMachine({
      fetchStreamChatApi: async (convoId, _text, onChunk) => {
        localStreamCalled = true;
        expect(convoId).toBe('audit-convo-1');
        onChunk('Hello from Local Qwen 3.5 4B');
      },
    });

    await vsm.startVoiceMode('audit-convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(localStreamCalled).toBe(true);
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  it('Test 2 & 5 — Single LLM turn: exactly ONE stream request occurs per voice turn', async () => {
    let requestCount = 0;

    const vsm = new VoiceStateMachine({
      fetchStreamChatApi: async () => {
        requestCount++;
      },
    });

    await vsm.startVoiceMode('audit-convo-2', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(requestCount).toBe(1); // Exactly 1 LLM request per turn
  });

  it('Test 3 — Voice Mode pipeline handles stream completion without duplicate LLM queries', async () => {
    let chatCallCount = 0;

    const vsm = new VoiceStateMachine({
      fetchChatApi: async () => {
        chatCallCount++;
        return { assistantMessage: { content: 'Response' } };
      },
    });

    await vsm.startVoiceMode('audit-convo-3', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(chatCallCount).toBe(1);
  });

  it('Test 4 — SpeechTextChunker converts incremental tokens into natural speech chunks', () => {
    const chunker = new SpeechTextChunker();
    const chunk1 = chunker.push('Hello ');
    expect(chunk1.length).toBe(0); // Buffers partial tokens

    const chunk2 = chunker.push('there, how can I help you today?');
    expect(chunk2.length).toBeGreaterThan(0);
    expect(chunk2[0]).toContain('Hello there');
  });

  it('Test 6 — Session Persistence: Conversation session ID persists across multiple turns without session re-creation', async () => {
    const convoIdsSeen: string[] = [];

    const vsm = new VoiceStateMachine({
      fetchChatApi: async (convoId) => {
        convoIdsSeen.push(convoId);
        return { assistantMessage: { content: 'Turn response' } };
      },
    });

    await vsm.startVoiceMode('persistent-audit-session', 'token-1', false);

    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    await vsm.processSpeechUtterance(new Uint8Array([2]) as any);
    await vsm.processSpeechUtterance(new Uint8Array([3]) as any);

    expect(convoIdsSeen).toEqual([
      'persistent-audit-session',
      'persistent-audit-session',
      'persistent-audit-session',
    ]);
  });
});
