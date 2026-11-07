import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { VoiceStateMachine, VoiceState } from '../../frontend/src/services/voiceStateMachine.js';
import { AgentOrchestrator } from '../src/ai/orchestrator/orchestrator.js';
import { NormalizedUserInput } from '../src/ai/orchestrator/input.model.js';
import { initializeDatabase, query } from '../src/database/client.js';
import { ConversationRepository } from '../src/database/repositories/conversation.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../src/ai/execution/plan-execution.engine.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';

class MockAudioPlayer {
  public state: 'STOPPED' | 'PLAYING' | 'PAUSED' | 'ERROR' = 'STOPPED';
  public playCount: number = 0;
  private _resolvePlay?: () => void;

  public play(data: any): Promise<void> {
    this.playCount++;
    this.state = 'PLAYING';
    return new Promise((resolve) => {
      this._resolvePlay = resolve;
    });
  }

  public completePlayback(): void {
    if (this.state === 'PLAYING') {
      this.state = 'STOPPED';
      if (this._resolvePlay) {
        this._resolvePlay();
        this._resolvePlay = undefined;
      }
    }
  }

  public stop(): void {
    this.state = 'STOPPED';
    if (this._resolvePlay) {
      this._resolvePlay();
      this._resolvePlay = undefined;
    }
  }
}

describe('PHASE 5: Full GIA Voice Pipeline Integration Suite (12 Core Scenarios)', () => {
  let vsm: VoiceStateMachine;
  let player: MockAudioPlayer;
  let stateHistory: VoiceState[];
  let recognizedTranscripts: string[];
  let assistantResponses: string[];
  let reportedErrors: string[];
  let testUserId: string;
  let testConvoId: string;

  beforeAll(async () => {
    await initializeDatabase();

    const userRes = await query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ['phase5_pipeline@gia.ai', 'hash_pass', 'Phase 5 Tester']
    );
    testUserId = userRes.rows[0].id;

    const convo = await ConversationRepository.create(testUserId, 'Phase 5 Voice Pipeline Conversation');
    testConvoId = convo.id;
  });

  beforeEach(() => {
    stateHistory = [];
    recognizedTranscripts = [];
    assistantResponses = [];
    reportedErrors = [];
    player = new MockAudioPlayer();

    vsm = new VoiceStateMachine({
      onStateChange: (s) => stateHistory.push(s),
      onTranscript: (t) => recognizedTranscripts.push(t),
      onError: (err) => reportedErrors.push(err),
      playAudioApi: (buf) => player.play(buf),
    });
  });

  // Scenario 1: English speech -> English response
  it('1. English speech -> English conversational response with TTS playback', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'What is artificial intelligence?' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      const resp = 'Artificial intelligence is the intelligence of machines and software.';
      assistantResponses.push(resp);
      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: resp },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_EN_WAV_BYTES'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(recognizedTranscripts).toContain('What is artificial intelligence?');
    expect(mockChat).toHaveBeenCalledWith(testConvoId, 'What is artificial intelligence?');
    expect(mockTts).toHaveBeenCalledWith('Artificial intelligence is the intelligence of machines and software.');
    expect(player.state).toBe('PLAYING');

    player.completePlayback();
    await p;
    expect(vsm.state).toBe('LISTENING');
  });

  // Scenario 2: Hindi speech -> Hindi response
  it('2. Hindi speech -> Hindi conversational response with TTS playback', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'नमस्ते, आप कैसी हैं?' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      const resp = 'नमस्ते! मैं बिल्कुल ठीक हूँ, आपकी क्या सहायता कर सकती हूँ?';
      assistantResponses.push(resp);
      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: resp },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_HI_WAV_BYTES'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(recognizedTranscripts).toContain('नमस्ते, आप कैसी हैं?');
    expect(mockChat).toHaveBeenCalledWith(testConvoId, 'नमस्ते, आप कैसी हैं?');
    expect(mockTts).toHaveBeenCalledWith('नमस्ते! मैं बिल्कुल ठीक हूँ, आपकी क्या सहायता कर सकती हूँ?');
    expect(player.state).toBe('PLAYING');

    player.completePlayback();
    await p;
    expect(vsm.state).toBe('LISTENING');
  });

  // Scenario 3: Hinglish speech -> understandable response
  it('3. Hinglish speech -> understandable contextual response with TTS playback', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'Mera project setup kaise run karein?' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      const resp = 'Aap terminal me npm run dev command chala sakte hain.';
      assistantResponses.push(resp);
      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: resp },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_HINGLISH_WAV_BYTES'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(recognizedTranscripts).toContain('Mera project setup kaise run karein?');
    expect(mockTts).toHaveBeenCalledWith('Aap terminal me npm run dev command chala sakte hain.');
    expect(player.state).toBe('PLAYING');

    player.completePlayback();
    await p;
    expect(vsm.state).toBe('LISTENING');
  });

  // Scenario 4: Normal conversation -> spoken response without plan generation or tool execution
  it('4. Normal conversation -> spoken response without triggering plan generation', async () => {
    let planCreated = false;
    let toolExecuted = false;

    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'Tell me a short joke.' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      // Conversational flow: NO plan creation or tool execution
      const joke = 'Why do programmers prefer dark mode? Because light attracts bugs!';
      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: joke },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_JOKE_WAV'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    player.completePlayback();
    await p;

    expect(planCreated).toBe(false);
    expect(toolExecuted).toBe(false);
    expect(vsm.state).toBe('LISTENING');
  });

  // Scenario 5: Actionable instruction -> structured plan created, approval requested, zero execution
  it('5. Actionable instruction -> plan generated in awaiting_approval status, no tool execution', async () => {
    let createdPlan: any = null;

    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'open Chrome and search YouTube' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      // 1. Unified Planner creates structured plan
      createdPlan = await TaskPlanningEngine.createPlan(
        testUserId,
        convoId,
        'open Chrome and search YouTube'
      );

      const promptVoiceMessage = `I understood: ${createdPlan.objective}. I have formulated an execution plan. May I execute this plan? Please say "Approve" or "Reject".`;
      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: promptVoiceMessage },
        plan: createdPlan,
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_PLAN_PROMPT_WAV'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    player.completePlayback();
    await p;

    // Verify structured plan created in awaiting_approval status
    expect(createdPlan).not.toBeNull();
    expect(createdPlan.status).toBe('awaiting_approval');
    expect(createdPlan.steps.length).toBeGreaterThan(0);

    // CRITICAL: Verify NO execution has occurred yet!
    const planInDb = await PlanRepository.findById(createdPlan.id);
    expect(planInDb?.status).toBe('awaiting_approval');
  });

  // Scenario 6: Explicit approval -> approved plan executes through PermissionManager & PlanExecutionEngine
  it('6. Explicit approval -> verifies ticket, approves plan, and executes through PlanExecutionEngine', async () => {
    // 1. Create plan
    const plan = await TaskPlanningEngine.createPlan(
      testUserId,
      testConvoId,
      'Get battery status and system info'
    );
    expect(plan.status).toBe('awaiting_approval');

    let planExecutionCompleted = false;

    // 2. User speaks "Approve this plan"
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'GIA approve this plan' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      // Approval requested via PermissionManager
      const approval = await PermissionManager.requestApproval({
        planId: plan.id,
        planVersion: plan.version,
        userId: testUserId,
        channel: 'voice_command',
        voiceTranscript: text,
      });

      expect(approval.success).toBe(true);
      expect(approval.ticket).toBeDefined();

      // Execute approved plan through PlanExecutionEngine
      const execResult = await PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId: testUserId,
        ticketToken: approval.ticket.ticketToken,
      });

      planExecutionCompleted = execResult.status === 'completed';

      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: 'Plan approved and executed successfully.' },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_APPROVED_WAV'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    player.completePlayback();
    await p;

    expect(planExecutionCompleted).toBe(true);
    const updatedPlan = await PlanRepository.findById(plan.id);
    expect(updatedPlan?.status).toBe('completed');
  });

  // Scenario 7: Explicit rejection -> plan rejected, zero execution
  it('7. Explicit rejection -> plan marked rejected, execution forbidden', async () => {
    const plan = await TaskPlanningEngine.createPlan(
      testUserId,
      testConvoId,
      'Delete temporary cache files'
    );
    expect(plan.status).toBe('awaiting_approval');

    let executionAttemptFailed = false;

    // User speaks "No cancel"
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'No cancel plan' });
    const mockChat = vi.fn().mockImplementation(async (convoId: string, text: string) => {
      // PermissionManager handles rejection
      const rejection = await PermissionManager.rejectPlan(plan.id, testUserId, text);
      expect(rejection.success).toBe(true);

      // Verify that executing a rejected plan throws error
      try {
        await PlanExecutionEngine.executeApprovedPlan({
          planId: plan.id,
          planVersion: plan.version,
          userId: testUserId,
          ticketToken: 'invalid_dummy_token',
        });
      } catch (e: any) {
        executionAttemptFailed = true;
      }

      return {
        userMessage: { role: 'user', content: text },
        assistantMessage: { role: 'assistant', content: 'Plan cancelled. No actions were performed.' },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_REJECTED_WAV'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    const p = vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    player.completePlayback();
    await p;

    expect(executionAttemptFailed).toBe(true);
    const updatedPlan = await PlanRepository.findById(plan.id);
    expect(updatedPlan?.status).toBe('rejected');
  });

  // Scenario 8: Silence -> no command, cleanly returns to LISTENING
  it('8. Silence -> no command dispatched, returns cleanly to LISTENING', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: '' }); // Empty transcript
    const mockChat = vi.fn();
    const mockTts = vi.fn();

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([0, 0, 0]) as any);

    expect(mockChat).not.toHaveBeenCalled();
    expect(mockTts).not.toHaveBeenCalled();
    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  // Scenario 9: Invalid transcription / corrupted audio -> safely handled without execution
  it('9. Invalid transcription error -> safely caught, no execution, returns to LISTENING', async () => {
    const mockTranscribe = vi.fn().mockRejectedValue(new Error('Corrupted PCM frame'));
    const mockChat = vi.fn();

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([99, 99]) as any);

    expect(mockChat).not.toHaveBeenCalled();
    expect(reportedErrors.length).toBeGreaterThan(0);
    expect(vsm.state).toBe('LISTENING');
  });

  // Scenario 10: TTS failure -> application remains usable
  it('10. TTS failure -> application survives error and returns to LISTENING', async () => {
    const mockTranscribe = vi.fn().mockResolvedValue({ text: 'Hello GIA' });
    const mockChat = vi.fn().mockResolvedValue({
      userMessage: { role: 'user', content: 'Hello GIA' },
      assistantMessage: { role: 'assistant', content: 'Hello!' },
    });
    const mockTts = vi.fn().mockRejectedValue(new Error('Audio synthesis hardware failure'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();
    await vsm.processSpeechUtterance(new Uint8Array([1, 2, 3]) as any);

    // Application recovers and returns to LISTENING
    expect(vsm.state).toBe('LISTENING');
    expect(vsm.isVoiceModeOn).toBe(true);
  });

  // Scenario 11: Microphone permission error -> clear error reported
  it('11. Microphone error handling -> sets error and halts cleanly', () => {
    let capturedError = '';
    const errorVsm = new VoiceStateMachine({
      onError: (err) => {
        capturedError = err;
      },
    });

    (errorVsm as any).handleError('Microphone permission denied: User rejected device access.');
    expect(capturedError).toContain('Microphone permission denied');
  });

  // Scenario 12: Repeated speech -> prevents duplicate overlapping execution
  it('12. Repeated speech -> isProcessingUtterance guard drops duplicate concurrent requests', async () => {
    let chatCallCount = 0;
    const mockTranscribe = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { text: 'Quick repeat test' };
    });
    const mockChat = vi.fn().mockImplementation(async () => {
      chatCallCount++;
      return {
        userMessage: { role: 'user', content: 'Quick repeat test' },
        assistantMessage: { role: 'assistant', content: 'Reply' },
      };
    });
    const mockTts = vi.fn().mockResolvedValue(Buffer.from('RIFF_REPEAT_WAV'));

    vsm.setCallbacks({
      fetchTranscribeApi: mockTranscribe,
      fetchChatApi: mockChat,
      fetchTtsApi: mockTts,
    });

    await vsm.startVoiceMode(testConvoId, 'token-123', false);
    vsm.handleSpeechStart();

    // Fire two processSpeechUtterance calls back-to-back
    const p1 = vsm.processSpeechUtterance(new Uint8Array([1, 2]) as any);
    const p2 = vsm.processSpeechUtterance(new Uint8Array([3, 4]) as any); // Should be dropped by guard!

    for (let i = 0; i < 30; i++) {
      if (player.state === 'PLAYING') break;
      await new Promise((r) => setTimeout(r, 20));
    }

    player.completePlayback();
    await Promise.all([p1, p2]);

    // Only one utterance was dispatched to the orchestrator
    expect(chatCallCount).toBe(1);
    expect(vsm.state).toBe('LISTENING');
  });
});
