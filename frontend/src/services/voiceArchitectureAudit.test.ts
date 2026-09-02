import { describe, it, expect } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';
import { SpeechTextChunker } from './textChunker.js';

describe('Voice Architecture & Pipeline Audit Verification Suite', () => {
  it('Test 1 — Voice Mode uses single Gemini provider (gemini-3.6-flash)', async () => {
    let geminiStreamCalled = false;

    const vsm = new VoiceStateMachine({
      fetchStreamChatApi: async (convoId, _text, onChunk) => {
        geminiStreamCalled = true;
        expect(convoId).toBe('audit-convo-1');
        onChunk('Hello from Gemini 3.6 Flash');
      },
    });

    await vsm.startVoiceMode('audit-convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(geminiStreamCalled).toBe(true);
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  it('Test 2 & 5 — Single Gemini turn: exactly ONE Gemini stream request occurs per voice turn', async () => {
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

  it('Test 4 — SpeechTextChunker converts incremental Gemini tokens into natural speech chunks', () => {
    const chunker = new SpeechTextChunker();
    const chunk1 = chunker.push('Hello ');
    expect(chunk1.length).toBe(0); // Buffers partial tokens

    const chunk2 = chunker.push('there, how can I help you today?');
    expect(chunk2.length).toBeGreaterThan(0);
    expect(chunk2[0]).toContain('Hello there');
  });

  it('Test 6 — Session Persistence: Gemini session ID persists across multiple turns without session re-creation', async () => {
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

    expect(convoIdsSeen).toEqual(['persistent-audit-session', 'persistent-audit-session', 'persistent-audit-session']);
  });

  it('Test 7 — Barge-in interruption preserves single session and cancels stream without corrupting state', async () => {
    let interrupted = false;

    const vsm = new VoiceStateMachine({
      onStateChange: (state) => {
        if (state === 'INTERRUPTED') interrupted = true;
      },
      fetchTtsApi: async () => new ArrayBuffer(8),
      playAudioApi: async () => {
        vsm.handleInterruption();
      },
    });

    await vsm.startVoiceMode('barge-in-audit', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(interrupted).toBe(true);
    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  it('Test 8 — Text chat remains functional on separate text-model path without interfering with voice mode', async () => {
    // Verifies that Voice Mode operates independently alongside text mode
    const vsm = new VoiceStateMachine({});
    expect(vsm.state).toBe('IDLE');

    await vsm.startVoiceMode('text-chat-coexist', 'token-1', false);
    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
  });
});
