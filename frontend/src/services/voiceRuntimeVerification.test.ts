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

  it('Test 1 — Non-wake-word command ("open VS Code") should be completely ignored', async () => {
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
    expect(vsm.isSessionActive).toBe(false);

    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(sttCount).toBe(1);
    expect(agentCount).toBe(0);
    expect(geminiCount).toBe(0);
    expect(ttsCount).toBe(0);
    expect(vsm.isSessionActive).toBe(false);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 2 — Wake-word command ("Afiya open VS Code") should trigger exactly 1 request across pipeline', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: 'Afiya open VS Code' };
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
      playAudioApi: async () => {},
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(sttCount).toBe(1);
    expect(agentCount).toBe(1);
    expect(geminiCount).toBe(1);
    expect(ttsCount).toBe(1);
    expect(vsm.isSessionActive).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 3 — Greeting without wake word ("Hello") should activate session for dialogue without authorizing tool execution', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: 'Hello' };
      },
      fetchChatApi: async () => {
        agentCount++;
        geminiCount++;
        return { assistantMessage: { content: 'Hello! How can I help you today?' } };
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
    expect(vsm.isSessionActive).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 4 — Greeting + command without wake word ("Hi, open VS Code") should be rejected by wake-word gate', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: 'Hi, open VS Code' };
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
      playAudioApi: async () => {},
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    expect(sttCount).toBe(1);
    expect(agentCount).toBe(0);
    expect(geminiCount).toBe(0);
    expect(ttsCount).toBe(0);
    expect(vsm.isSessionActive).toBe(false);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 5 — Wake word alone ("Afiya") followed by command ("Open VS Code")', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;

    let currentTranscript = 'Afiya';

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: currentTranscript };
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
      playAudioApi: async () => {},
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);
    
    // Step 5a: Say "Afiya" alone
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);
    expect(sttCount).toBe(1);
    expect(agentCount).toBe(0);
    expect(geminiCount).toBe(0);
    expect(ttsCount).toBe(0);
    expect(vsm.isSessionActive).toBe(true);
    expect(vsm.state).toBe('LISTENING');

    // Step 5b: Say "Open VS Code" in active session
    currentTranscript = 'Open VS Code';
    await vsm.processSpeechUtterance(new Uint8Array([2]) as any);

    expect(sttCount).toBe(2);
    expect(agentCount).toBe(1);
    expect(geminiCount).toBe(1);
    expect(ttsCount).toBe(1);
    expect(vsm.isSessionActive).toBe(true);
    expect(vsm.state).toBe('LISTENING');
  });

  it('Test 6 — Self-listening / TTS feedback test ("Afiya hello" + silence)', async () => {
    let sttCount = 0;
    let agentCount = 0;
    let geminiCount = 0;
    let ttsCount = 0;
    let isMicPaused = false;

    const vsm = new VoiceStateMachine({
      fetchTranscribeApi: async () => {
        sttCount++;
        return { text: 'Afiya hello' };
      },
      fetchChatApi: async () => {
        agentCount++;
        geminiCount++;
        return { assistantMessage: { content: 'Hello! I am Afiya.' } };
      },
      fetchTtsApi: async () => {
        ttsCount++;
        return new ArrayBuffer(8);
      },
      onPauseCapture: () => {
        isMicPaused = true;
      },
      onResumeCapture: () => {
        isMicPaused = false;
      },
      playAudioApi: async () => {
        // Simulate playback duration
        await new Promise((r) => setTimeout(r, 50));
      },
    });

    await vsm.startVoiceMode('convo-1', 'token-1', false);

    // User says "Afiya hello"
    await vsm.processSpeechUtterance(new Uint8Array([1]) as any);

    // After complete processing cycle:
    expect(sttCount).toBe(1);
    expect(agentCount).toBe(1);
    expect(geminiCount).toBe(1);
    expect(ttsCount).toBe(1);

    // State returns to LISTENING and mic capture is unpaused
    expect(vsm.state).toBe('LISTENING');
    expect(isMicPaused).toBe(false);

    // Simulate 15 seconds of silence (no additional utterances triggered)
    await new Promise((r) => setTimeout(r, 100));

    // Verify request counts remain exactly 1 x each
    expect(sttCount).toBe(1);
    expect(agentCount).toBe(1);
    expect(geminiCount).toBe(1);
    expect(ttsCount).toBe(1);
  });
});
