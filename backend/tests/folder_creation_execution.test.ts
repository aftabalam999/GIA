import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../src/ai/execution/plan-execution.engine.js';
import { registry, resolveTargetDirectory } from '../src/ai/tools/registry.js';
import { ToolExecutor } from '../src/ai/tools/executor.js';
import { ContextBuilder } from '../src/ai/orchestrator/contextBuilder.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { agentRoutes } from '../src/api/routes/agent.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA — Desktop Folder Creation & Truthful Execution Pipeline Tests', () => {
  const app = Fastify();
  let userToken: string;
  let userId: string;
  let conversationId: string;
  let testDesktopDir: string;

  beforeAll(async () => {
    // 1. Create dedicated temporary Desktop directory to ensure real Desktop is NEVER touched
    testDesktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gia-test-desktop-'));
    process.env.GIA_DESKTOP_DIR = testDesktopDir;

    setTestProvider(new MockProvider());
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_key_folder_exec_test_12345' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(agentRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query("DELETE FROM users WHERE email = 'folder_tester@gia.ai'");

    // Create test user
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'folder_tester@gia.ai', password: 'secure_password_123', name: 'Folder Tester' },
    });
    const body = JSON.parse(signup.body);
    userToken = body.token;
    userId = body.user.id;

    // Create test conversation
    const convoRes = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: 'Folder Creation Test Conversation' },
    });
    conversationId = JSON.parse(convoRes.body).conversation.id;
  });

  afterAll(async () => {
    // Clean up temporary test desktop directory
    if (testDesktopDir && fs.existsSync(testDesktopDir)) {
      fs.rmSync(testDesktopDir, { recursive: true, force: true });
    }
    delete process.env.GIA_DESKTOP_DIR;
    await query("DELETE FROM users WHERE email = 'folder_tester@gia.ai'");
  });

  beforeEach(() => {
    PlanExecutionEngine.resetState();
  });

  // TEST 1: Real macOS folder creation via create_directory tool
  it('TEST 1: should create a new folder inside the resolved Desktop directory', async () => {
    const tool = registry.get('create_directory');
    expect(tool).toBeDefined();

    const result = await tool!.execute({
      directoryPath: 'Desktop',
      folderName: 'Jasin-Gia-test-1',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('create_directory');
    expect(result.folderName).toBe('Jasin-Gia-test-1');
    expect(result.verified).toBe(true);

    const expectedPath = path.join(testDesktopDir, 'Jasin-Gia-test-1');
    expect(result.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.statSync(expectedPath).isDirectory()).toBe(true);

    // Also verify alias create_folder works identically
    const aliasTool = registry.get('create_folder');
    expect(aliasTool).toBeDefined();
    const aliasResult = await aliasTool!.execute({
      directoryPath: 'Desktop',
      folderName: 'Jasin-Gia-alias-test',
    });
    expect(aliasResult.success).toBe(true);
    const aliasExpectedPath = path.join(testDesktopDir, 'Jasin-Gia-alias-test');
    expect(fs.existsSync(aliasExpectedPath)).toBe(true);
  });

  // TEST 2: Verifying that folder exists
  it('TEST 2: should verify that created directory exists on disk and detect absent ones', async () => {
    const tool = registry.get('create_directory');
    const folderName = 'Jasin-Gia-test-2';
    await tool!.execute({ directoryPath: 'Desktop', folderName });

    // Verify existing folder
    const verifyResult = await tool!.verify({ directoryPath: 'Desktop', folderName });
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.message).toContain('exists on disk');

    // Verify non-existent folder
    const absentVerify = await tool!.verify({ directoryPath: 'Desktop', folderName: 'non-existent-folder-xyz' });
    expect(absentVerify.verified).toBe(false);
    expect(absentVerify.message).toContain('was not found on disk');
  });

  // TEST 3: Handling existing folder (rejection / explicit error)
  it('TEST 3: should reject creation and throw an explicit error if folder already exists', async () => {
    const tool = registry.get('create_directory');
    const folderName = 'Jasin-Gia-existing-test';
    await tool!.execute({ directoryPath: 'Desktop', folderName });

    // Attempt to create again
    await expect(tool!.execute({ directoryPath: 'Desktop', folderName })).rejects.toThrow(
      /Directory already exists/
    );
  });

  // TEST 4: Handling invalid folder names (slashes, traversal, null bytes, empty)
  it('TEST 4: should reject invalid folder names containing slashes, null bytes, traversal, or whitespace', async () => {
    const tool = registry.get('create_directory');

    // Path traversal attempt
    await expect(tool!.execute({ directoryPath: 'Desktop', folderName: '../evil-folder' })).rejects.toThrow(
      /Invalid folder name/
    );

    // Nested slashes
    await expect(tool!.execute({ directoryPath: 'Desktop', folderName: 'nested/folder' })).rejects.toThrow(
      /Invalid folder name/
    );

    // Null byte
    await expect(tool!.execute({ directoryPath: 'Desktop', folderName: 'evil\0folder' })).rejects.toThrow(
      /Invalid folder name/
    );

    // Empty or pure dots
    await expect(tool!.execute({ directoryPath: 'Desktop', folderName: '..' })).rejects.toThrow(
      /Invalid folder name/
    );
    await expect(tool!.execute({ directoryPath: 'Desktop', folderName: '   ' })).rejects.toThrow(
      /Invalid folder name/
    );
  });

  // TEST 5: Handling filesystem permission errors and unauthorized boundaries
  it('TEST 5: should reject target directories outside permitted user boundaries', async () => {
    const tool = registry.get('create_directory');
    await expect(
      tool!.execute({ directoryPath: '/etc/forbidden-system-dir', folderName: 'test-folder' })
    ).rejects.toThrow(/Access denied: Directory path/);
  });

  // TEST 6: Handling missing Desktop directory or missing parent
  it('TEST 6: should reject creation if parent directory does not exist', async () => {
    const tool = registry.get('create_directory');
    const nonExistentBase = path.join(testDesktopDir, 'non_existent_sub_tree');
    await expect(
      tool!.execute({ directoryPath: nonExistentBase, folderName: 'test-folder' })
    ).rejects.toThrow(/Parent directory does not exist/);
  });

  // TEST 7: Multi-turn parameter preservation across turns
  it('TEST 7: should preserve parameters across multi-turn conversation and execute upon approval', async () => {
    // Turn 1: User says: "Make a folder on desktop."
    const turn1Text = 'Make a folder on desktop.';
    expect(TaskPlanningEngine.isActionableInstruction(turn1Text)).toBe(true);

    const plan1 = await TaskPlanningEngine.createPlan(userId, conversationId, turn1Text);
    expect(plan1.is_ambiguous).toBe(true);
    expect(plan1.clarification_question).toBe('What would you like to name this folder?');
    expect(plan1.metadata?.missing_param).toBe('folder_name');
    expect(plan1.metadata?.target_location).toBe('Desktop');

    // Turn 2: User responds: "Jasin-Gia-test."
    const turn2Text = 'Jasin-Gia-test.';
    const intentResult = TaskPlanningEngine.classifyIntent(turn2Text, true, plan1);
    expect(intentResult.intent).toBe('modify_plan');

    // Resolve the ambiguous plan with user feedback
    const resolvedPlan = await TaskPlanningEngine.modifyPlan(plan1, turn2Text);
    expect(resolvedPlan.is_ambiguous).toBe(false);
    expect(resolvedPlan.clarification_question).toBeNull();
    expect(resolvedPlan.objective).toBe('Create folder "Jasin-Gia-test" on Desktop');
    expect(resolvedPlan.steps).toHaveLength(2);
    expect(resolvedPlan.steps[0].tool_name).toBe('create_directory');
    expect(resolvedPlan.steps[0].tool_args).toEqual({ directoryPath: 'Desktop', folderName: 'Jasin-Gia-test' });
    expect(resolvedPlan.steps[1].action).toBe('verify_directory');

    // Turn 3: User says: "Approved"
    const approvalRes = await PermissionManager.requestApproval({
      planId: resolvedPlan.id,
      planVersion: resolvedPlan.version,
      userId,
      conversationId,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(approvalRes.success).toBe(true);
    expect(approvalRes.ticket).toBeDefined();

    const ticketToken = (approvalRes.ticket!.ticketToken || approvalRes.ticket!.ticketId)!;

    // Execute through PlanExecutionEngine
    const execResult = await PlanExecutionEngine.executeApprovedPlan({
      planId: resolvedPlan.id,
      planVersion: resolvedPlan.version,
      userId,
      ticketToken,
    });

    expect(execResult.status).toBe('completed');
    expect(execResult.completedSteps).toBe(2);
    expect(execResult.totalSteps).toBe(2);

    // Verify folder was ACTUALLY created on filesystem!
    const realPath = path.join(testDesktopDir, 'Jasin-Gia-test');
    expect(fs.existsSync(realPath)).toBe(true);
    expect(fs.statSync(realPath).isDirectory()).toBe(true);
  });

  // TEST 8: Rejecting execution without valid authorization ticket
  it('TEST 8: should reject execution without a valid authorization ticket', async () => {
    // One-shot actionable instruction
    const command = 'Make a folder on desktop named Jasin-Gia-secure-test';
    const plan = await TaskPlanningEngine.createPlan(userId, conversationId, command);
    expect(plan.is_ambiguous).toBe(false);

    // Attempt to execute without ticketToken -> must throw error
    await expect(
      PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: '',
      })
    ).rejects.toThrow();

    // Attempt to execute without approving plan first
    await expect(
      PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: 'forged_fake_token',
      })
    ).rejects.toThrow(/Execution forbidden: Plan/);
  });

  // TEST 9: Preventing fabricated success responses
  it('TEST 9: should enforce anti-fabrication rules and prevent LLM or agent from fabricating success', async () => {
    // 1. Verify ContextBuilder system prompt rules prohibit fabrication
    const assembled = ContextBuilder.assembleContext({
      currentUserRequest: 'Make a folder on desktop named Fake-Success-Folder',
    });
    expect(assembled.systemPrompt).toContain('NEVER claim, report, or fabricate');
    expect(assembled.systemPrompt).toContain('Never claim an action is "Done" or "Created" without verified tool execution');

    // 2. Test one-shot folder creation command through Agent API
    const agentRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages/agent`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: 'Make a folder on desktop named GIA-Agent-Test-Folder' },
    });
    const agentBody = JSON.parse(agentRes.body);
    expect(agentRes.statusCode).toBe(200);

    // Verify it did NOT fabricate "Done! The folder has been created". It formulated a plan!
    expect(agentBody.plan).toBeDefined();
    expect(agentBody.plan.status).toBe('awaiting_approval');
    expect(agentBody.assistantMessage.content).toContain('Execution Plan Formulated');
    expect(agentBody.assistantMessage.content).toContain('Explicit Approval Required');

    // Folder must NOT exist yet because approval has not occurred!
    const folderPath = path.join(testDesktopDir, 'GIA-Agent-Test-Folder');
    expect(fs.existsSync(folderPath)).toBe(false);

    // Now approve it via Agent API
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages/agent`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { content: 'Approved' },
    });
    const approveBody = JSON.parse(approveRes.body);
    expect(approveRes.statusCode).toBe(200);
    expect(approveBody.execution.status).toBe('completed');
    expect(approveBody.assistantMessage.content).toContain('executed successfully');
    expect(approveBody.assistantMessage.content).toContain('Verified directory "GIA-Agent-Test-Folder" exists on disk');

    // Now verify the folder ACTUALLY exists on disk after execution!
    expect(fs.existsSync(folderPath)).toBe(true);
    expect(fs.statSync(folderPath).isDirectory()).toBe(true);
  });

  // TEST 10: Reporting actual execution failures honestly
  it('TEST 10: should honestly report execution failure if folder creation encounters a conflict or error', async () => {
    // Pre-create the directory to force a collision/failure
    const conflictDir = path.join(testDesktopDir, 'Jasin-Gia-conflict-folder');
    fs.mkdirSync(conflictDir, { recursive: true });

    // Request to make the same folder again
    const plan = await TaskPlanningEngine.createPlan(
      userId,
      conversationId,
      'Make a folder on desktop named Jasin-Gia-conflict-folder'
    );

    // Approve the plan
    const approvalRes = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId,
      conversationId,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    const ticketToken = (approvalRes.ticket!.ticketToken || approvalRes.ticket!.ticketId)!;

    // Execute plan -> Step 1 should fail because folder already exists
    const execResult = await PlanExecutionEngine.executeApprovedPlan({
      planId: plan.id,
      planVersion: plan.version,
      userId,
      ticketToken,
    });

    expect(execResult.status).toBe('failed');
    expect(execResult.failedStepId).toBe(1);
    expect(execResult.errorMessage).toContain('Directory already exists');

    // Verify step 2 (synthetic verify) was NOT executed
    expect(execResult.completedSteps).toBe(0);
    expect(execResult.stepRecords[0].status).toBe('failed');
    expect(execResult.stepRecords[0].error).toContain('Directory already exists');
  });
});

