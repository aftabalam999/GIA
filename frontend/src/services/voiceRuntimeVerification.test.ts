import { describe, it, expect } from 'vitest';
import { VoiceStateMachine } from './voiceStateMachine.js';

describe('GIA Voice Pipeline Runtime Verification Suite', () => {
  it('Test 0 — Voice Mode Start should play introductory welcome greeting', async () => {
    let ttsRequestedText = '';
    let playedAudio = false;
    let assistantGreetingText = '';

    const vsm = new VoiceStateMachine({
      fetchTtsApi: async (txt) => {
        ttsRequestedText = txt;
        return new ArrayBuffer(8);
      },
      playAudioApi: async () => {
        playedAudio = true;
      },
      onAssistantResponse: (_u, aMsg) => {
        if (aMsg) assistantGreetingText = aMsg.content;
      },
    });

    await vsm.startVoiceMode('convo-1', 'token-1', true);

    expect(ttsRequestedText).toBe(VoiceStateMachine.WELCOME_GREETING);
    expect(assistantGreetingText).toBe(VoiceStateMachine.WELCOME_GREETING);
    expect(playedAudio).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 1 — User command ("open VS Code") when Voice Mode is ON should process directly without wake word', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: 'open VS Code' };
      },
      fetchChatApi: async () => {
        agentCount++;
        geminiCount++;
        return { assistantMessage: { content: 'Opening VS Code' } };
      },
      fetchTtsApi: async () => {
        ttsCount++;
        return new ArrayBuffer(8);
      },
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(sttCount).toBe(1);
    expect(agentCount).toBe(1);
    expect(geminiCount).toBe(1);
    expect(ttsCount).toBe(1);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 2 — Conversational query ("explain APIs") should trigger full voice pipeline directly', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: 'explain APIs' };
      },
      fetchChatApi: async () => {
        agentCount++;
        geminiCount++;
        return { assistantMessage: { content: 'An API allows software to communicate.' } };
      },
      fetchTtsApi: async () => {
        ttsCount++;
        return new ArrayBuffer(8);
      },
      playAudioApi: async () => {},
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(sttCount).toBe(1);
    expect(agentCount).toBe(1);
    expect(geminiCount).toBe(1);
    expect(ttsCount).toBe(1);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 3 — Pure silence or empty transcription should cleanly return to LISTENING state', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: '   ' };
      },
      fetchChatApi: async () => {
        agentCount++;
        geminiCount++;
        return { assistantMessage: { content: 'Hello' } };
      },
      fetchTtsApi: async () => {
        ttsCount++;
        return new ArrayBuffer(8);
      },
      playAudioApi: async () => {},
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(sttCount).toBe(1);
    expect(agentCount).toBe(0);
    expect(geminiCount).toBe(0);
    expect(ttsCount).toBe(0);
    expect(vsm.state).toBe('LISTENING');
  });
});
