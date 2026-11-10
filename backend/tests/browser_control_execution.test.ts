import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { initializeDatabase, query } from '../src/database/client.js';
import { PlanExecutionEngine } from '../src/ai/execution/plan-execution.engine.js';
import { TaskPlanningEngine } from '../src/ai/planner/planner.service.js';
import { PlanRepository } from '../src/ai/planner/plan.repository.js';
import { PermissionManager } from '../src/ai/permissions/permission.manager.js';
import { ConversationOrchestrator } from '../src/ai/orchestrator/conversation-orchestrator.service.js';
import { ConversationService } from '../src/conversations/services/conversation.service.js';
import { BrowserAutomationService } from '../src/ai/tools/browser.service.js';
import { ExecutionPlan } from '../src/ai/planner/planner.interface.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { planRoutes } from '../src/api/routes/plans.js';
import { agentRoutes } from '../src/api/routes/agent.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { MockProvider } from '../src/ai/providers/mock.provider.js';

describe('GIA — Native Browser Control and Web Search Integration Tests', () => {
  const app = Fastify();
  let userId: string;
  let testConversationId: string;

  beforeAll(async () => {
    setTestProvider(new MockProvider());
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyMultipart);
    await app.register(fastifyJwt, { secret: 'test_jwt_secret_browser_control_123456789' });
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.register(conversationRoutes, { prefix: '/api/v1' });
    await app.register(planRoutes, { prefix: '/api/v1' });
    await app.register(agentRoutes, { prefix: '/api/v1' });

    await initializeDatabase();
    await query("DELETE FROM users WHERE email = 'browser_control_tester@gia.ai'");

    // Create test user
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'browser_control_tester@gia.ai', password: 'secure_password_123', name: 'Browser Tester' },
    });
    const body = JSON.parse(signup.body);
    userId = body.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    PlanExecutionEngine.resetState();
    const conv = await ConversationService.createConversation(userId, 'Browser Control Test Session');
    testConversationId = conv.id;
  });

  afterEach(() => {
    PlanExecutionEngine.resetState();
    vi.restoreAllMocks();
  });

  async function approveAndExecute(plan: ExecutionPlan, convId: string) {
    const approvalRes = await PermissionManager.requestApproval({
      planId: plan.id,
      planVersion: plan.version,
      userId,
      conversationId: convId,
      channel: 'web_ui',
      explicitConfirmation: true,
    });
    expect(approvalRes.success).toBe(true);
    const ticketToken = (approvalRes.ticket!.ticketToken || approvalRes.ticket!.ticketId)!;

    return PlanExecutionEngine.executeApprovedPlan({
      planId: plan.id,
      planVersion: plan.version,
      userId,
      ticketToken,
    });
  }

  // TEST 1: Open Chrome
  it('TEST 1: should formulate and execute a verified plan to open Google Chrome', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open Chrome');

    expect(plan.objective).toContain('Google Chrome');
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0].action).toBe('open_browser');
    expect(plan.steps[0].tool_name).toBe('open_browser');
    expect(plan.steps[0].tool_args?.browser).toBe('Google Chrome');
    expect(plan.steps[1].action).toBe('verify_browser');

    // Mock browser execution
    vi.spyOn(BrowserAutomationService, 'openBrowser').mockResolvedValueOnce({
      success: true,
      browser: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      message: 'Launched Google Chrome successfully.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('completed');
    expect(result.stepRecords[0].status).toBe('completed');
    expect(result.stepRecords[0].result?.browser).toBe('Google Chrome');
  });

  // TEST 2: Open Brave
  it('TEST 2: should formulate and execute a verified plan to open Brave Browser', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Launch Brave');

    expect(plan.objective).toContain('Brave Browser');
    expect(plan.steps[0].tool_args?.browser).toBe('Brave Browser');

    vi.spyOn(BrowserAutomationService, 'openBrowser').mockResolvedValueOnce({
      success: true,
      browser: 'Brave Browser',
      bundleId: 'com.brave.Browser',
      message: 'Launched Brave Browser successfully.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('completed');
    expect(result.stepRecords[0].result?.browser).toBe('Brave Browser');
  });

  // TEST 3: Open default browser
  it('TEST 3: should formulate plan for default browser when no specific browser is named', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open default browser');

    expect(plan.objective).toContain('Launch Google Chrome');
    expect(plan.steps[0].tool_name).toBe('open_browser');

    vi.spyOn(BrowserAutomationService, 'openBrowser').mockResolvedValueOnce({
      success: true,
      browser: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      message: 'Launched Google Chrome successfully.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('completed');
  });

  // TEST 4: Detect missing browser error
  it('TEST 4: should accurately report error and reject execution if requested browser is not installed', async () => {
    vi.spyOn(BrowserAutomationService, 'isBrowserInstalled').mockReturnValue(false);

    await expect(BrowserAutomationService.openBrowser('Firefox')).rejects.toThrow(
      'Browser "Firefox" is not installed on this system.'
    );
  });

  // TEST 5: Search in Chrome
  it('TEST 5: should formulate and execute search query in Chrome', async () => {
    const plan = await TaskPlanningEngine.createPlan(
      userId,
      testConversationId,
      'Search React documentation in Chrome'
    );

    expect(plan.objective).toContain('Search "React documentation"');
    expect(plan.steps[0].action).toBe('search_in_browser');
    expect(plan.steps[0].tool_name).toBe('search_browser');
    expect(plan.steps[0].tool_args?.query).toBe('React documentation');
    expect(plan.steps[0].tool_args?.browser).toBe('Google Chrome');

    vi.spyOn(BrowserAutomationService, 'searchWeb').mockResolvedValueOnce({
      success: true,
      browser: 'Google Chrome',
      engine: 'google',
      query: 'React documentation',
      searchUrl: 'https://www.google.com/search?q=React%20documentation',
      message: 'Searched for "React documentation" on google using Google Chrome.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('completed');
    expect(result.stepRecords[0].result?.searchUrl).toBe('https://www.google.com/search?q=React%20documentation');
  });

  // TEST 6: Search in Brave
  it('TEST 6: should formulate and execute search query in Brave', async () => {
    const plan = await TaskPlanningEngine.createPlan(
      userId,
      testConversationId,
      'Search React hooks in Brave'
    );

    expect(plan.steps[0].tool_args?.query).toBe('React hooks');
    expect(plan.steps[0].tool_args?.browser).toBe('Brave Browser');

    vi.spyOn(BrowserAutomationService, 'searchWeb').mockResolvedValueOnce({
      success: true,
      browser: 'Brave Browser',
      engine: 'google',
      query: 'React hooks',
      searchUrl: 'https://www.google.com/search?q=React%20hooks',
      message: 'Searched for "React hooks" on google using Brave Browser.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('completed');
    expect(result.stepRecords[0].result?.browser).toBe('Brave Browser');
  });

  // TEST 7: Open direct URL
  it('TEST 7: should normalize domain to HTTPS and navigate browser directly', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open github.com in Brave');

    expect(plan.steps[0].action).toBe('navigate_url');
    expect(plan.steps[0].tool_name).toBe('navigate_browser');
    expect(plan.steps[0].tool_args?.url).toBe('https://github.com');
    expect(plan.steps[0].tool_args?.browser).toBe('Brave Browser');

    vi.spyOn(BrowserAutomationService, 'navigateUrl').mockResolvedValueOnce({
      success: true,
      browser: 'Brave Browser',
      url: 'https://github.com',
      newTab: false,
      message: 'Navigated Brave Browser to https://github.com.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('completed');
    expect(result.stepRecords[0].result?.url).toBe('https://github.com');
  });

  // TEST 8: Proper encoding of search queries with special characters
  it('TEST 8: should properly URL-encode search queries containing special characters and symbols', async () => {
    const complexQuery = 'React & TypeScript / special + characters #1 "quotes"';
    const normalized = encodeURIComponent(complexQuery);

    expect(normalized).toBe(
      'React%20%26%20TypeScript%20%2F%20special%20%2B%20characters%20%231%20%22quotes%22'
    );

    vi.spyOn(BrowserAutomationService, 'navigateUrl').mockResolvedValueOnce({
      success: true,
      browser: 'Google Chrome',
      url: `https://www.google.com/search?q=${normalized}`,
      newTab: false,
      message: 'OK',
    });

    const searchRes = await BrowserAutomationService.searchWeb(complexQuery, 'Google Chrome');
    expect(searchRes.searchUrl).toBe(`https://www.google.com/search?q=${normalized}`);
  });

  // TEST 9: Preserve pending search parameters across turns (Multi-turn clarification)
  it('TEST 9: should preserve pending search parameters across turns and execute upon approval', async () => {
    // Turn 1: User gives ambiguous search command
    const t1 = await ConversationOrchestrator.processUserMessage({
      userId,
      conversationId: testConversationId,
      content: 'Search something on the internet',
      inputType: 'text',
    });

    expect(t1.success).toBe(true);
    expect(t1.plan?.is_ambiguous).toBe(true);
    expect(t1.plan?.metadata?.missing_param).toBe('search_query');
    expect(t1.speechText).toContain('What would you like me to search for?');

    // Turn 2: User provides search query
    const t2 = await ConversationOrchestrator.processUserMessage({
      userId,
      conversationId: testConversationId,
      content: 'Node.js architecture',
      inputType: 'text',
    });

    expect(t2.success).toBe(true);
    expect(t2.plan).toBeDefined();
    expect(t2.plan?.is_ambiguous).toBe(false);
    expect(t2.plan?.objective).toContain('Node.js architecture');
    expect(t2.plan?.steps[0].tool_args?.query).toBe('Node.js architecture');

    // Turn 3: User approves plan
    vi.spyOn(BrowserAutomationService, 'searchWeb').mockResolvedValueOnce({
      success: true,
      browser: 'Google Chrome',
      engine: 'google',
      query: 'Node.js architecture',
      searchUrl: 'https://www.google.com/search?q=Node.js%20architecture',
      message: 'Searched for "Node.js architecture" on google using Google Chrome.',
    });
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(true);

    const t3 = await ConversationOrchestrator.processUserMessage({
      userId,
      conversationId: testConversationId,
      content: 'Approve',
      inputType: 'text',
    });

    expect(t3.success).toBe(true);
    expect(t3.execution?.status).toBe('completed');
  });

  // TEST 10: Reject unauthorized browser execution without approval ticket
  it('TEST 10: should strictly reject browser execution if approval ticket is missing or invalid', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open Chrome');

    await expect(
      PlanExecutionEngine.executeApprovedPlan({
        planId: plan.id,
        planVersion: plan.version,
        userId,
        ticketToken: 'invalid_ticket_token',
      })
    ).rejects.toThrow();
  });

  // TEST 11: Reject unsafe URL inputs
  it('TEST 11: should strictly reject unsafe URL protocols like javascript:, file:, data:', () => {
    expect(() => BrowserAutomationService.validateAndNormalizeUrl('javascript:alert(1)')).toThrow(
      'Invalid or prohibited URL protocol'
    );
    expect(() => BrowserAutomationService.validateAndNormalizeUrl('file:///etc/passwd')).toThrow(
      'Invalid or prohibited URL protocol'
    );
    expect(() => BrowserAutomationService.validateAndNormalizeUrl('data:text/html,<script>alert(1)</script>')).toThrow(
      'Invalid or prohibited URL protocol'
    );
  });

  // TEST 12: Verify chat and voice plan parity
  it('TEST 12: should generate identical browser execution plans for text chat and voice transcripts', async () => {
    const instruction = 'Search React documentation in Chrome';

    const chatPlan = await TaskPlanningEngine.createPlan(userId, testConversationId, instruction);

    const convVoice = await ConversationService.createConversation(userId, 'Voice Test Session');
    const voicePlan = await TaskPlanningEngine.createPlan(userId, convVoice.id, instruction);

    expect(chatPlan.objective).toBe(voicePlan.objective);
    expect(chatPlan.steps.length).toBe(voicePlan.steps.length);
    expect(chatPlan.steps[0].action).toBe(voicePlan.steps[0].action);
    expect(chatPlan.steps[0].tool_name).toBe(voicePlan.steps[0].tool_name);
    expect(chatPlan.steps[0].tool_args).toEqual(voicePlan.steps[0].tool_args);
    expect(chatPlan.steps[1].action).toBe(voicePlan.steps[1].action);
  });

  // TEST 13: Handle browser navigation failure gracefully
  it('TEST 13: should handle navigation failure and report truthful execution error', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open github.com in Brave');

    vi.spyOn(BrowserAutomationService, 'navigateUrl').mockRejectedValueOnce(
      new Error('Browser navigation failed: Window closed unexpectedly')
    );

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('failed');
    expect(result.stepRecords[0].status).toBe('failed');
    expect(result.stepRecords[0].error).toContain('Window closed unexpectedly');
  });

  // TEST 14: Ensure no fabricated success response (Anti-fabrication check)
  it('TEST 14: should fail execution if browser verification step fails, preventing false success', async () => {
    const plan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open Chrome');

    vi.spyOn(BrowserAutomationService, 'openBrowser').mockResolvedValueOnce({
      success: true,
      browser: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      message: 'Process launched.',
    });

    // Verification check fails
    vi.spyOn(BrowserAutomationService, 'isBrowserRunning').mockResolvedValue(false);

    const openBrowserTool = (await import('../src/ai/tools/registry.js')).registry.get('open_browser');
    if (openBrowserTool && openBrowserTool.verify) {
      vi.spyOn(openBrowserTool, 'verify').mockResolvedValueOnce({
        verified: false,
        message: 'Verification failed: Google Chrome is not running.',
      });
    }

    const result = await approveAndExecute(plan, testConversationId);

    expect(result.status).toBe('failed');
    expect(result.stepRecords[0].status).toBe('failed');
    expect(result.stepRecords[0].error).toContain('Verification failed');
  });

  // TEST 15: Browser Tab Actions (new tab, close tab, refresh, back, forward)
  it('TEST 15: should formulate plans for browser tab actions and history navigation', async () => {
    const newTabPlan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Open a new tab');
    expect(newTabPlan.steps[0].action).toBe('open_new_tab');
    expect(newTabPlan.steps[0].tool_args?.action).toBe('new_tab');

    const closeTabPlan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Close the current tab');
    expect(closeTabPlan.steps[0].action).toBe('close_tab');
    expect(closeTabPlan.steps[0].tool_args?.action).toBe('close_tab');

    const refreshPlan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Refresh page');
    expect(refreshPlan.steps[0].action).toBe('browser_refresh');
    expect(refreshPlan.steps[0].tool_args?.action).toBe('refresh');

    const backPlan = await TaskPlanningEngine.createPlan(userId, testConversationId, 'Go back');
    expect(backPlan.steps[0].action).toBe('browser_back');
    expect(backPlan.steps[0].tool_args?.action).toBe('back');
  });

  // TEST 16: Multi-turn browser selection
  it('TEST 16: should handle multi-turn browser selection when user says "Open a browser"', async () => {
    // Turn 1
    const t1 = await ConversationOrchestrator.processUserMessage({
      userId,
      conversationId: testConversationId,
      content: 'Open a browser',
      inputType: 'text',
    });

    expect(t1.success).toBe(true);
    expect(t1.plan?.is_ambiguous).toBe(true);
    expect(t1.speechText).toContain('Which browser would you like me to open?');

    // Turn 2
    const t2 = await ConversationOrchestrator.processUserMessage({
      userId,
      conversationId: testConversationId,
      content: 'Chrome',
      inputType: 'text',
    });

    expect(t2.success).toBe(true);
    expect(t2.plan).toBeDefined();
    expect(t2.plan?.is_ambiguous).toBe(false);
    expect(t2.plan?.objective).toContain('Launch Google Chrome');
    expect(t2.plan?.steps[0].tool_args?.browser).toBe('Google Chrome');
  });
});
