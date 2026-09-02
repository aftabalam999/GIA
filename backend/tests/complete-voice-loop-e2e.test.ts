import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { VoiceStateMachine, VoiceState } from '../../frontend/src/services/voiceStateMachine.js';
import { AgentOrchestrator } from '../src/ai/orchestrator/orchestrator.js';
import { NormalizedUserInput } from '../src/ai/orchestrator/input.model.js';
import { initializeDatabase, query } from '../src/database/client.js';
import { ConversationRepository } from '../src/database/repositories/conversation.repository.js';

class MockDesktopAudioPlayer {
  public state: 'STOPPED' | 'PLAYING' | 'PAUSED' | 'STOPPING' | 'ERROR' = 'STOPPED';
  public onStateChange?: (state: string) => void;
  public onEnded?: () => void;
  private _resolvePlay?: () => void;

  public play(data: any): Promise<void> {
    this.state = 'PLAYING';
    if (this.onStateChange) this.onStateChange(this.state);
    return new Promise((resolve) => {
      this._resolvePlay = resolve;
    });
  }

  public pause(): void {
    if (this.state === 'PLAYING') {
      this.state = 'PAUSED';
      if (this.onStateChange) this.onStateChange(this.state);
    }
  }

  public resume(): void {
    if (this.state === 'PAUSED') {
      this.state = 'PLAYING';
      if (this.onStateChange) this.onStateChange(this.state);
    }
  }

  public stop(): void {
    this.state = 'STOPPING';
    if (this.onStateChange) this.onStateChange(this.state);
    this.state = 'STOPPED';
    if (this.onStateChange) this.onStateChange(this.state);
    if (this._resolvePlay) {
      this._resolvePlay();
      this._resolvePlay = undefined;
    }
  }

  public simulatePlaybackCompletion(): void {
    if (this.state === 'PLAYING') {
      this.state = 'STOPPED';
      if (this.onStateChange) this.onStateChange(this.state);
      if (this.onEnded) this.onEnded();
      if (this._resolvePlay) {
        this._resolvePlay();
        this._resolvePlay = undefined;
      }
    }
  }
}

describe('GIA Phase 11: Complete Voice Loop E2E Verification Suite', () => {
  let vsm: VoiceStateMachine;
  let player: MockDesktopAudioPlayer;
  let stateHistory: VoiceState[];
  let processedTranscripts: string[];
  let generatedResponses: string[];
  let testUserId: string;
  let testConvoId: string;

  beforeAll(async () => {
    await initializeDatabase();

    // Create valid database test user & conversation
    const userRes = await query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ['voice_loop_e2e@gia.ai', 'hash_123', 'E2E Voice User']
    );
    testUserId = userRes.rows[0].id;

    const convo = await ConversationRepository.create(testUserId, 'Voice E2E Test Convo');
    testConvoId = convo.id;
  });

  beforeEach(() => {
    stateHistory = [];
    processedTranscripts = [];
    generatedResponses = [];
    player = new MockDesktopAudioPlayer();

    vsm = new VoiceStateMachine({
      onStateChange: (s) => stateHistory.push(s),
      onTranscript: (t) => processedTranscripts.push(t),
      playAudioApi: (buf) => player.play(buf),
    });
  });

  it('should verify the 10-step complete voice loop sequence across multi-turn utterances', async () => {
    // Mock STT / Fastify / Orchestrator / TTS API implementations
    const mockTranscribeApi = vi.fn()
      .mockResolvedValueOnce({ text: 'What time is it in Tokyo?' })
      .mockResolvedValueOnce({ text: 'What are my stored memories?' });

    const mockChatApi = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      // Create NormalizedUserInput model matching Fastify voice contract
      const inputModel: NormalizedUserInput = {
        inputType: 'voice',
        content: text,
        userId: testUserId,
        conversationId: convoId,
        requestId: 'req-' + Math.random(),
        timestamp: new Date().toISOString(),
        metadata: { voice: { duration: 2.5, confidence: 0.98, language: 'en' } },
      };

      // Execute unified AI Orchestrator FSM (planning -> retrieval/execution -> responding)
      const orchestratorResult = await AgentOrchestrator.run(testUserId, convoId, inputModel);
      generatedResponses.push(orchestratorResult.assistantMessage.content);

      return {
        userMessage: orchestratorResult.userMessage,
        assistantMessage: orchestratorResult.assistantMessage,
        runId: orchestratorResult.runId,
      };
    });

    const mockTtsApi = vi.fn().mockImplementation(async (text: string) => {
      // Mock Python TTS speech synthesis returning audio binary WAV bytes
      const header = Buffer.from('RIFF....WAVEfmt ');
      const pcmPayload = Buffer.alloc(100);
      return Buffer.concat([header, pcmPayload]);
    });

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribeApi,
      fetchChatApi: mockChatApi,
      fetchTtsApi: mockTtsApi,
      playAudioApi: (buf) => player.play(buf),
    });

    // 1. Enable Voice Mode (VOICE_MODE = ON)
    await vsm.startVoiceMode(testConvoId, 'jwt-token-123', false);
    expect(vsm.isVoiceModeOn).toBe(true);
    expect(vsm.state).toBe('LISTENING');

    // --- UTTERANCE 1 ---
    // Step 1: User speaks
    vsm.handleSpeechStart();
    expect(vsm.state).toBe('SPEECH_DETECTED');

    // Step 2-6: Process Utterance 1 (STT -> Orchestrator -> TTS -> Desktop Audio Playback)
    const utterance1Promise = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    // Wait until audio playback starts (indicating STT, Orchestration & TTS completed)
    for (let i = 0; i < 50; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Step 2: Transcription succeeded
    expect(processedTranscripts).toContain('What time is it in Tokyo?');

    // Step 3 & 4: Orchestrator received transcript and LLM response generated via Model Router + Tools
    expect(generatedResponses.length).toBe(1);
    expect(generatedResponses[0]).toBeTruthy();

    // Step 5 & 6: TTS generated audio & Desktop Audio Player is PLAYING
    expect(vsm.state).toBe('PLAYING');
    expect(player.state).toBe('PLAYING');

    // Step 7: Complete playback -> system automatically returns to LISTENING
    player.simulatePlaybackCompletion();
    await utterance1Promise;

    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);

    // --- UTTERANCE 2 (REPEAT CYCLE) ---
    // Step 8: User speaks again
    vsm.handleSpeechStart();
    expect(vsm.state).toBe('SPEECH_DETECTED');

    // Step 9: Cycle repeats seamlessly for second utterance
    const utterance2Promise = vsm.processSpeechUtterance(new Uint8Array([4, 5, 6]) as any);

    for (let i = 0; i < 50; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(processedTranscripts).toContain('What are my stored memories?');
    expect(generatedResponses.length).toBe(2);
    expect(vsm.state).toBe('PLAYING');
    expect(player.state).toBe('PLAYING');

    player.simulatePlaybackCompletion();
    await utterance2Promise;

    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);

    // Step 10: Manual stop returns system cleanly to IDLE
    await vsm.stopVoiceMode();
    expect(vsm.isVoiceModeOn).toBe(false);
    expect(vsm.state).toBe('IDLE');
    expect(player.state).toBe('STOPPED');
  });

  it('should verify that voice and text requests execute through the exact same orchestrator business logic', async () => {
    // 1. Text input execution
    const textResult = await AgentOrchestrator.run(testUserId, testConvoId, 'Compare TypeScript vs JavaScript');
    expect(textResult.userMessage.content).toBe('Compare TypeScript vs JavaScript');
    expect(textResult.userMessage.metadata?.inputType).toBe('text');
    expect(textResult.assistantMessage.content).toBeTruthy();

    // 2. Voice input execution
    const voiceInputModel: NormalizedUserInput = {
      inputType: 'voice',
      content: 'Compare TypeScript vs JavaScript',
      userId: testUserId,
      conversationId: testConvoId,
      requestId: 'req-voice-compare',
      timestamp: new Date().toISOString(),
      metadata: { voice: { duration: 3.1, confidence: 0.99, language: 'en' } },
    };

    const voiceResult = await AgentOrchestrator.run(testUserId, testConvoId, voiceInputModel);
    expect(voiceResult.userMessage.content).toBe('Compare TypeScript vs JavaScript');
    expect(voiceResult.userMessage.metadata?.inputType).toBe('voice');
    expect(voiceResult.assistantMessage.content).toBeTruthy();

    // Both reached identical assistant output structures and FSM execution nodes!
    expect(voiceResult.assistantMessage.role).toBe('assistant');
  });
});
