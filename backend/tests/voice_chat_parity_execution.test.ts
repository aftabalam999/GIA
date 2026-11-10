import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, query } from '../src/database/client.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { ConversationOrchestrator } from '../src/ai/orchestrator/conversation-orchestrator.service.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { agentRoutes } from '../src/api/routes/agent.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA — Voice Mode Tool Execution and Chat/Voice Parity Tests', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
  let conversationId: string;
  let testDesktopDir: string;

  beforeAll(async () => {
    // 1. Dedicated test desktop directory to ensure real desktop is never modified
    testDesktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gia-voice-parity-desktop-'));
    process.env.GIA_DESKTOP_DIR = testDesktopDir;

    setTestProvider(new MockProvider());
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_voice_parity_123456789' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(agentRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query("DELETE FROM users WHERE email = 'voice_parity_tester@gia.ai'");

    // Create test user
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'voice_parity_tester@gia.ai', password: 'secure_password_123', name: 'Voice Parity Tester' },
    });
    const body = JSON.parse(signup.body);
    userToken = body.token;
    userId = body.user.id;

    // Create test conversation
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Voice Parity Test Conversation' },
    });
    conversationId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    delete process.env.GIA_DESKTOP_DIR;
    try {
      fs.rmSync(testDesktopDir, { recursive: true, force: true });
    } catch {}
  });

  // TEST 1: Unified Voice Mode Multi-Turn Folder Creation with Execution Verification
  it('TEST 1: Voice Mode Multi-Turn Folder Creation: "Make a folder on desktop" -> "Jasin-Gia-test" -> "Approve"', async () => {
    // Turn 1 (Voice): "Make a folder on desktop."
    const turn1Result = await ConversationOrchestrator.processUserMessage({
      conversationId,
      userId,
      content: 'Make a folder on desktop.',
      inputType: 'voice',
    });

    expect(turn1Result.success).toBe(true);
    expect(turn1Result.plan).toBeDefined();
    expect(turn1Result.plan?.is_ambiguous).toBe(true);
    expect(turn1Result.plan?.metadata?.missing_param).toBe('folder_name');
    expect(turn1Result.speechText).toBe('What would you like to name this folder?');

    // Verify active plan is persisted in PostgreSQL
    const activeInDb1 = await PlanRepository.findActiveByConversationId(conversationId);
    expect(activeInDb1).toBeDefined();
    expect(activeInDb1?.id).toBe(turn1Result.plan?.id);

    // Turn 2 (Voice): "Jasin-Gia-test."
    const turn2Result = await ConversationOrchestrator.processUserMessage({
      conversationId,
      userId,
      content: 'Jasin-Gia-test.',
      inputType: 'voice',
    });

    expect(turn2Result.success).toBe(true);
    expect(turn2Result.plan).toBeDefined();
    expect(turn2Result.plan?.is_ambiguous).toBe(false);
    expect(turn2Result.plan?.status).toBe('awaiting_approval');
    expect(turn2Result.plan?.objective).toBe('Create folder "Jasin-Gia-test" on Desktop');
    expect(turn2Result.speechText).toContain('I formulated a plan to create the folder "Jasin-Gia-test" on your Desktop');

    // Verify plan is updated in DB with concrete steps
    const activeInDb2 = await PlanRepository.findActiveByConversationId(conversationId);
    expect(activeInDb2?.is_ambiguous).toBe(false);
    expect(activeInDb2?.steps[0].tool_name).toBe('create_directory');

    // Verify folder DOES NOT exist yet prior to approval
    const folderPath = path.join(testDesktopDir, 'Jasin-Gia-test');
    expect(fs.existsSync(folderPath)).toBe(false);

    // Turn 3 (Voice): "Approve"
    const turn3Result = await ConversationOrchestrator.processUserMessage({
      conversationId,
      userId,
      content: 'Approve',
      inputType: 'voice',
    });

    expect(turn3Result.success).toBe(true);
    expect(turn3Result.execution).toBeDefined();
    expect(turn3Result.execution?.status).toBe('completed');
    expect(turn3Result.speechText).toContain('Done! I have created and verified the folder Jasin-Gia-test on your Desktop.');

    // PROOF: Folder ACTUALLY exists on disk!
    expect(fs.existsSync(folderPath)).toBe(true);
    expect(fs.statSync(folderPath).isDirectory()).toBe(true);
  });

  // TEST 2: Text Chat vs Voice Mode Parity (Identical Steps, Execution, and Verification)
  it('TEST 2: Text Chat Mode executes the exact same folder creation through PlanExecutionEngine', async () => {
    // New conversation for Text Chat parity test
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Text Chat Parity Conversation' },
    });
    const textConvoId = JSON.parse(convoRes.body).conversation.id;

    // Turn 1 (Text): "Make a folder on desktop."
    const turn1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${textConvoId}/messages/agent`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: 'Make a folder on desktop.' },
    });
    const turn1Body = JSON.parse(turn1Res.body);
    expect(turn1Body.success).toBe(true);
    expect(turn1Body.plan.is_ambiguous).toBe(true);

    // Turn 2 (Text): "Jasin-Gia-text-test."
    const turn2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${textConvoId}/messages/agent`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: 'Jasin-Gia-text-test.' },
    });
    const turn2Body = JSON.parse(turn2Res.body);
    expect(turn2Body.success).toBe(true);
    expect(turn2Body.plan.is_ambiguous).toBe(false);
    expect(turn2Body.plan.objective).toBe('Create folder "Jasin-Gia-text-test" on Desktop');

    // Turn 3 (Text): "Proceed"
    const turn3Res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${textConvoId}/messages/agent`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: 'Proceed' },
    });
    const turn3Body = JSON.parse(turn3Res.body);
    expect(turn3Body.success).toBe(true);
    expect(turn3Body.execution.status).toBe('completed');

    // PROOF: Text created folder exists on disk!
    const textFolderPath = path.join(testDesktopDir, 'Jasin-Gia-text-test');
    expect(fs.existsSync(textFolderPath)).toBe(true);
    expect(fs.statSync(textFolderPath).isDirectory()).toBe(true);
  });

  // TEST 3: Cross-Channel Multi-Turn Continuity (Start Text -> Clarify Voice -> Approve Voice)
  it('TEST 3: Cross-channel continuity: Turn 1 in Text, Turn 2 in Voice, Turn 3 in Voice', async () => {
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Cross Channel Continuity Conversation' },
    });
    const crossConvoId = JSON.parse(convoRes.body).conversation.id;

    // Turn 1 (Text via HTTP API): "Make a folder on desktop."
    const turn1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${crossConvoId}/messages/agent`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: 'Make a folder on desktop.' },
    });
    expect(JSON.parse(turn1Res.body).plan.is_ambiguous).toBe(true);

    // Turn 2 (Voice input): "Jasin-Gia-cross-test."
    const turn2Result = await ConversationOrchestrator.processUserMessage({
      conversationId: crossConvoId,
      userId,
      content: 'Jasin-Gia-cross-test.',
      inputType: 'voice',
    });
    expect(turn2Result.plan?.is_ambiguous).toBe(false);
    expect(turn2Result.plan?.objective).toBe('Create folder "Jasin-Gia-cross-test" on Desktop');

    // Turn 3 (Voice approval): "Yes, go ahead"
    const turn3Result = await ConversationOrchestrator.processUserMessage({
      conversationId: crossConvoId,
      userId,
      content: 'Yes, go ahead',
      inputType: 'voice',
    });
    expect(turn3Result.execution?.status).toBe('completed');

    const crossFolderPath = path.join(testDesktopDir, 'Jasin-Gia-cross-test');
    expect(fs.existsSync(crossFolderPath)).toBe(true);
    expect(fs.statSync(crossFolderPath).isDirectory()).toBe(true);
  });

  // TEST 4: Voice Rejection Gate (Cancels plan, does NOT execute tool)
  it('TEST 4: Voice Rejection Gate: "Reject" cancels pending plan and does NOT create folder', async () => {
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Voice Rejection Test Conversation' },
    });
    const rejectConvoId = JSON.parse(convoRes.body).conversation.id;

    // Turn 1: "Make a folder on desktop."
    await ConversationOrchestrator.processUserMessage({
      conversationId: rejectConvoId,
      userId,
      content: 'Make a folder on desktop.',
      inputType: 'voice',
    });

    // Turn 2: "Jasin-Gia-reject-test."
    await ConversationOrchestrator.processUserMessage({
      conversationId: rejectConvoId,
      userId,
      content: 'Jasin-Gia-reject-test.',
      inputType: 'voice',
    });

    // Turn 3: "Cancel"
    const turn3Result = await ConversationOrchestrator.processUserMessage({
      conversationId: rejectConvoId,
      userId,
      content: 'Cancel',
      inputType: 'voice',
    });

    expect(turn3Result.speechText).toBe('Plan cancelled. No actions were performed.');
    expect(['cancelled', 'rejected']).toContain(turn3Result.plan?.status);

    // Verify folder was NEVER created
    const rejectedPath = path.join(testDesktopDir, 'Jasin-Gia-reject-test');
    expect(fs.existsSync(rejectedPath)).toBe(false);
  });

  // TEST 5: Honest Failure Reporting (Duplicate folder cannot be created; speaks real error)
  it('TEST 5: Truthful failure reporting: Attempting to create duplicate folder reports honest error', async () => {
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Failure Reporting Test' },
    });
    const dupConvoId = JSON.parse(convoRes.body).conversation.id;

    // "Jasin-Gia-test" was already created in TEST 1!
    // Try creating "Jasin-Gia-test" again:
    await ConversationOrchestrator.processUserMessage({
      conversationId: dupConvoId,
      userId,
      content: 'Make a folder on desktop.',
      inputType: 'voice',
    });

    await ConversationOrchestrator.processUserMessage({
      conversationId: dupConvoId,
      userId,
      content: 'Jasin-Gia-test.',
      inputType: 'voice',
    });

    const approveResult = await ConversationOrchestrator.processUserMessage({
      conversationId: dupConvoId,
      userId,
      content: 'Approve',
      inputType: 'voice',
    });

    expect(approveResult.success).toBe(false);
    expect(approveResult.execution?.status).toBe('failed');
    expect(approveResult.speechText).toContain('I could not complete the plan');
    expect(approveResult.speechText).toContain('Directory already exists');
    expect(approveResult.assistantMessage.content).toContain('Directory already exists');
  });

  // TEST 6: Exact user command: "Make one folder in the desktop with the name of \"Aftab\"."
  it('TEST 6: should recognize "Make one folder in the desktop with the name of \"Aftab\"." as actionable, formulate plan, and execute on approval', async () => {
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Aftab Folder Test' },
    });
    const aftabConvoId = JSON.parse(convoRes.body).conversation.id;

    const command = 'Make one folder in the desktop with the name of "Aftab".';
    expect(TaskPlanningEngine.isActionableInstruction(command)).toBe(true);

    const result = await ConversationOrchestrator.processUserMessage({
      conversationId: aftabConvoId,
      userId,
      content: command,
      inputType: 'text',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan?.is_ambiguous).toBe(false);
    expect(result.plan?.status).toBe('awaiting_approval');
    expect(result.plan?.objective).toBe('Create folder "Aftab" on Desktop');
    expect(result.plan?.steps).toHaveLength(2);
    expect(result.plan?.steps[0].tool_name).toBe('create_directory');
    expect(result.plan?.steps[0].tool_args).toEqual({ directoryPath: 'Desktop', folderName: 'Aftab' });

    // Approve the plan
    const approveResult = await ConversationOrchestrator.processUserMessage({
      conversationId: aftabConvoId,
      userId,
      content: 'Approve',
      inputType: 'text',
    });

    expect(approveResult.success).toBe(true);
    expect(approveResult.execution?.status).toBe('completed');

    // Verify folder was actually created on disk!
    const aftabDir = path.join(testDesktopDir, 'Aftab');
    expect(fs.existsSync(aftabDir)).toBe(true);
    expect(fs.statSync(aftabDir).isDirectory()).toBe(true);
  });

  // TEST 7: VS Code Dynamic Folder Extraction: "Open the folder \"New Go\" present on desktop in VS Code."
  it('TEST 7: should extract requested folder name "New Go" for VS Code and NOT hardcode GIA-AI', async () => {
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'VS Code Folder Extraction Test' },
    });
    const vsConvoId = JSON.parse(convoRes.body).conversation.id;

    const command = 'Open the folder "New Go" present on desktop in VS Code.';
    const result = await ConversationOrchestrator.processUserMessage({
      conversationId: vsConvoId,
      userId,
      content: command,
      inputType: 'text',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan?.objective).toBe('Open "New Go" in Visual Studio Code');
    expect(result.plan?.steps[0].tool_name).toBe('open_folder_in_vscode');
    expect(result.plan?.steps[0].tool_args).toEqual({ folderName: 'New Go' });
    expect(result.plan?.steps[0].description).toContain('New Go');
  });
});
