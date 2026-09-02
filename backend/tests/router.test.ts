import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import { agentRoutes } from '../src/api/routes/agent.js';
import { conversationRoutes } from '../src/api/routes/conversations.js';
import { authRoutes } from '../src/api/routes/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';
import { AgentRouter, routerTestOverrides, RoutingDecision } from '../src/ai/orchestrator/router.js';
import { setTestProvider } from '../src/ai/router/index.js';
import { LLMProvider, LLMRequest, LLMResponse, LLMChunk } from '../src/ai/providers/provider.interface.js';

class MockLLMRoutingProvider implements LLMProvider {
  public responseContent = '';
  public shouldFail = false;
  public shouldTimeout = false;

  async generate(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    if (this.shouldFail) {
      throw new Error('Simulated LLM Provider Failure');
    }
    if (this.shouldTimeout) {
      throw new Error('Simulated LLM Provider Timeout');
    }
    return {
      content: this.responseContent,
      model: 'mock-routing-model',
      provider: 'mock-provider',
    };
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMChunk> {
    yield { content: this.responseContent };
  }
}

describe('GIA Agent Router & Policy Validation Tests', () => {
  const mockProvider = new MockLLMRoutingProvider();

  beforeAll(async () => {
    setTestProvider(mockProvider);
  });

  afterAll(async () => {
    setTestProvider(null);
  });

  beforeEach(() => {
    AgentRouter.resetOverrides();
    mockProvider.responseContent = '';
    mockProvider.shouldFail = false;
    mockProvider.shouldTimeout = false;
  });

  describe('AgentRouter.route() Direct Unit Tests', () => {
    it('should deterministically route "open VS Code" to open_folder_in_vscode without calling Gemini LLM', async () => {
      const decision = await AgentRouter.route('open VS Code', 'test-user-id');
      expect(decision.route).toBe('tool');
      expect(decision.requires_tool).toBe(true);
      expect(decision.tool?.name).toBe('open_folder_in_vscode');
      expect(decision.deterministic).toBe(true);
    });

    it('should deterministically route "open vscode" to open_folder_in_vscode without calling Gemini LLM', async () => {
      const decision = await AgentRouter.route('open vscode', 'test-user-id');
      expect(decision.route).toBe('tool');
      expect(decision.requires_tool).toBe(true);
      expect(decision.tool?.name).toBe('open_folder_in_vscode');
      expect(decision.deterministic).toBe(true);
    });

    it('should deterministically route "launch VS Code" to open_folder_in_vscode without calling Gemini LLM', async () => {
      const decision = await AgentRouter.route('launch VS Code', 'test-user-id');
      expect(decision.route).toBe('tool');
      expect(decision.requires_tool).toBe(true);
      expect(decision.tool?.name).toBe('open_folder_in_vscode');
      expect(decision.deterministic).toBe(true);
    });

    it('should not match deterministic local router for general questions like "Explain recursion in JavaScript"', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'direct_response',
        reason: 'General explanation',
        requires_memory: false,
        requires_rag: false,
        requires_tool: false,
        tool: null,
      });

      const decision = await AgentRouter.route('Explain recursion in JavaScript', 'test-user-id');
      expect(decision.deterministic).toBeUndefined();
      expect(decision.route).toBe('direct_response');
    });

    it('should not match deterministic local router for questions mentioning VS Code like "Can you help me with VS Code?"', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'direct_response',
        reason: 'General conversation about VS Code',
        requires_memory: false,
        requires_rag: false,
        requires_tool: false,
        tool: null,
      });

      const decision = await AgentRouter.route('Can you help me with VS Code?', 'test-user-id');
      expect(decision.deterministic).toBeUndefined();
      expect(decision.route).toBe('direct_response');
    });

    it('should route to direct_response for conversational queries', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'direct_response',
        reason: 'General greetings',
        requires_memory: false,
        requires_rag: false,
        requires_tool: false,
        tool: null,
      });

      const decision = await AgentRouter.route('Hello', 'test-user-id');
      expect(decision.route).toBe('direct_response');
      expect(decision.requires_tool).toBe(false);
    });

    it('should route to memory_retrieval for preference queries', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'memory_retrieval',
        reason: 'User asks for preference history',
        requires_memory: true,
        requires_rag: false,
        requires_tool: false,
        tool: null,
      });

      const decision = await AgentRouter.route('What was my favorite programming language?', 'test-user-id');
      expect(decision.route).toBe('memory_retrieval');
      expect(decision.requires_memory).toBe(true);
    });

    it('should route to rag for uploaded knowledge documents', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'rag',
        reason: 'User queries technical specification manual',
        requires_memory: false,
        requires_rag: true,
        requires_tool: false,
        tool: null,
      });

      const decision = await AgentRouter.route('Retrieve document constraints', 'test-user-id');
      expect(decision.route).toBe('rag');
      expect(decision.requires_rag).toBe(true);
    });

    it('should route to tool with args when requesting get_current_time', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'tool',
        reason: 'Wants system time',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: { name: 'get_current_time', args: {} },
      });

      const decision = await AgentRouter.route('What time is it now?', 'test-user-id');
      expect(decision.route).toBe('tool');
      expect(decision.requires_tool).toBe(true);
      expect(decision.tool?.name).toBe('get_current_time');
    });

    it('should route to multi_step when combining rag and tool steps', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'multi_step',
        reason: 'Needs to check schema documents and get time',
        requires_memory: false,
        requires_rag: true,
        requires_tool: true,
        tool: { name: 'list_documents', args: {} },
      });

      const decision = await AgentRouter.route('List my document titles and read docs', 'test-user-id');
      expect(decision.route).toBe('multi_step');
      expect(decision.requires_rag).toBe(true);
      expect(decision.tool?.name).toBe('list_documents');
    });

    // Fallbacks and Policy Violations
    it('should fallback to direct_response when LLM returns invalid JSON', async () => {
      mockProvider.responseContent = 'this is not valid JSON';

      const decision = await AgentRouter.route('Hello', 'test-user-id');
      expect(decision.route).toBe('direct_response');
      expect(decision.reason).toContain('Fallback');
    });

    it('should fallback to direct_response when LLM returns an unknown route name', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'destroy_database_route', // invalid route enum
        reason: 'Malicious injection',
        requires_memory: false,
        requires_rag: false,
        requires_tool: false,
        tool: null,
      });

      const decision = await AgentRouter.route('Inject', 'test-user-id');
      expect(decision.route).toBe('direct_response');
      expect(decision.reason).toContain('Fallback');
    });

    it('should fallback to direct_response when LLM proposes an unregistered tool name', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'tool',
        reason: 'Exploit attempt',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: { name: 'execute_arbitrary_shell_command', args: { cmd: 'rm -rf /' } },
      });

      const decision = await AgentRouter.route('Run shell command', 'test-user-id');
      expect(decision.route).toBe('direct_response');
      expect(decision.tool).toBeNull();
    });

    it('should fallback to direct_response when provider fails', async () => {
      mockProvider.shouldFail = true;

      const decision = await AgentRouter.route('Try error', 'test-user-id');
      expect(decision.route).toBe('direct_response');
    });

    it('should fallback to direct_response when provider times out', async () => {
      mockProvider.shouldTimeout = true;

      const decision = await AgentRouter.route('Try timeout', 'test-user-id');
      expect(decision.route).toBe('direct_response');
    });

    it('should gracefully handle empty or very long requests', async () => {
      mockProvider.responseContent = JSON.stringify({
        route: 'direct_response',
        reason: 'empty',
        requires_memory: false,
        requires_rag: false,
        requires_tool: false,
        tool: null,
      });

      const decision1 = await AgentRouter.route('', 'test-user-id');
      expect(decision1.route).toBe('direct_response');

      const longQuery = 'A'.repeat(10000);
      const decision2 = await AgentRouter.route(longQuery, 'test-user-id');
      expect(decision2.route).toBe('direct_response');
    });
  });

  describe('Agent Orchestration Integration with AgentRouter', () => {
    const app = Fastify();
    let userToken: string;
    let convoId: string;

    beforeAll(async () => {
      app.setErrorHandler(errorHandler);
      await app.register(cors);
      await app.register(fastifyCookie);
      await app.register(fastifyJwt, {
        secret: 'test_jwt_secret_key_1234567890',
      });
      await app.register(authRoutes, { prefix: '/api/v1' });
      await app.register(conversationRoutes, { prefix: '/api/v1' });
      await app.register(agentRoutes, { prefix: '/api/v1' });

      await initializeDatabase();
      await query("DELETE FROM users WHERE email = 'router_test@gia.ai'");

      const signupRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: 'router_test@gia.ai', password: 'secure_password_123', name: 'Router Tester' },
      });
      userToken = JSON.parse(signupRes.body).token;

      const convoRes = await app.inject({
        method: 'POST',
        url: '/api/v1/conversations',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { title: 'Router Integration Chat' },
      });
      convoId = JSON.parse(convoRes.body).conversation.id;
    });

    afterAll(async () => {
      await query("DELETE FROM users WHERE email = 'router_test@gia.ai'");
    });

    it('should execute tool node when router returns tool decision', async () => {
      routerTestOverrides.mockDecision = {
        route: 'tool',
        reason: 'User asks for current date',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: { name: 'get_current_time', args: {} },
      };

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'Give me the current date' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);

      const dbRes = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [body.runId]);
      const steps = dbRes.rows[0].steps;
      expect(steps.some((s: any) => s.node === 'execution')).toBe(true);
    });

    it('should execute retrieval node when router returns RAG decision', async () => {
      routerTestOverrides.mockDecision = {
        route: 'rag',
        reason: 'User queries documents',
        requires_memory: false,
        requires_rag: true,
        requires_tool: false,
        tool: null,
      };

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'Check GIA system specifications' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      const dbRes = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [body.runId]);
      const steps = dbRes.rows[0].steps;
      expect(steps.some((s: any) => s.node === 'retrieval')).toBe(true);
    });

    it('should fail-safe and route directly to responding when invalid tool is requested in override', async () => {
      // Propose an invalid/unregistered tool to verify orchestrator doesn't execute it
      routerTestOverrides.mockDecision = {
        route: 'tool',
        reason: 'Malicious override injection',
        requires_memory: false,
        requires_rag: false,
        requires_tool: true,
        tool: { name: 'rm_rf_tool', args: {} },
      };

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/conversations/${convoId}/messages/agent`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: { content: 'Delete everything' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      const dbRes = await query('SELECT status, steps FROM agent_runs WHERE id = $1', [body.runId]);
      const steps = dbRes.rows[0].steps;
      // Should bypass 'execution' and go straight to responding because of the validation policy rejection fallback
      expect(steps.some((s: any) => s.node === 'execution')).toBe(false);
    });
  });
});
