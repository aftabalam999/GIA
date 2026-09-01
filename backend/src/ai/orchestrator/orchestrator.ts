import { query } from '../../database/client.js';
import { RAGService } from '../../rag/services/rag.service.js';
import { ToolExecutor } from '../tools/executor.js';
import { LLMGateway } from '../router/index.js';
import { ContextBuilder } from './contextBuilder.js';
import { MessageRepository, Message } from '../../database/repositories/message.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { AuthorizationError, NotFoundError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import { AgentRouter } from './router.js';
import { NormalizedUserInput, normalizeUserInput } from './input.model.js';

export interface AgentState {
  conversationId: string;
  userId: string;
  inputQuery: string;
  inputModel: NormalizedUserInput;
  currentNode: 'planning' | 'retrieval' | 'execution' | 'responding' | 'error' | 'done';
  retrievedContext: {
    chunks: any[];
    memories: any[];
  };
  toolCalls: Array<{ name: string; args: any; result?: any; error?: string }>;
  finalResponse?: string;
  stepCount: number;
  maxSteps: number;
  stepsHistory: Array<{ node: string; timestamp: string }>;
  error?: string;
}

export class AgentOrchestrator {
  /**
   * Operates GIA's Finite State Machine (FSM) orchestrator.
   * Accepts text or voice input via NormalizedUserInput model and routes through unified state transitions.
   */
  static async run(
    userId: string,
    conversationId: string,
    inputQuery: string | NormalizedUserInput,
    options?: { requestId?: string }
  ): Promise<{ userMessage: Message; assistantMessage: Message; runId: string }> {
    const AGENT_TIMEOUT_MS = 60_000; // 60 second wall-clock deadline

    const runPromise = this._runInternal(userId, conversationId, inputQuery, options);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Agent execution timed out after 60 seconds')),
        AGENT_TIMEOUT_MS
      )
    );

    return Promise.race([runPromise, timeoutPromise]);
  }

  /**
   * Internal FSM execution — called by run() with a wall-clock timeout wrapper.
   */
  private static async _runInternal(
    userId: string,
    conversationId: string,
    inputQuery: string | NormalizedUserInput,
    options?: { requestId?: string }
  ): Promise<{ userMessage: Message; assistantMessage: Message; runId: string }> {
    // 1. Verify ownership
    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) {
      throw new NotFoundError('Conversation not found');
    }
    if (convo.user_id !== userId) {
      throw new AuthorizationError('Access denied to this conversation');
    }

    // Normalize text or voice input into structured model
    const inputModel = normalizeUserInput(inputQuery, userId, conversationId, options);

    logger.info({
      msg: 'Agent orchestrator processing input',
      inputType: inputModel.inputType,
      requestId: inputModel.requestId,
      conversationId,
      userId,
      contentLength: inputModel.content.length,
    });

    // 2. Initialize state machine variables
    const state: AgentState = {
      conversationId,
      userId,
      inputQuery: inputModel.content,
      inputModel,
      currentNode: 'planning',
      retrievedContext: { chunks: [], memories: [] },
      toolCalls: [],
      stepCount: 0,
      maxSteps: 5,
      stepsHistory: [],
    };

    // Save initial user message with metadata
    const userMessage = await MessageRepository.create(
      conversationId,
      'user',
      inputModel.content,
      {
        inputType: inputModel.inputType,
        requestId: inputModel.requestId,
        timestamp: inputModel.timestamp,
        ...(inputModel.metadata || {}),
      }
    );

    // Create database observability run log
    const runId = await this.createAgentRun(conversationId, 'running');

    // 3. Execution loop
    try {
      while (state.currentNode !== 'done' && state.stepCount < state.maxSteps) {
        state.stepCount++;
        state.stepsHistory.push({
          node: state.currentNode,
          timestamp: new Date().toISOString(),
        });

        // Observability updates on each transition
        await this.updateAgentRun(runId, 'running', state.stepsHistory);

        switch (state.currentNode) {
          case 'planning':
            await this.planningNode(state);
            break;
          case 'retrieval':
            await this.retrievalNode(state);
            break;
          case 'execution':
            await this.executionNode(state);
            break;
          case 'responding':
            await this.respondingNode(state);
            break;
          case 'error':
            await this.errorNode(state);
            break;
          default:
            state.currentNode = 'done';
        }
      }

      // Safeguard threshold check
      if (state.stepCount >= state.maxSteps && state.currentNode !== 'done') {
        logger.warn({ msg: 'Agent orchestrator exceeded step limit threshold', runId, conversationId });
        state.currentNode = 'error';
        state.error = 'Maximum loop execution steps limit reached';
        state.stepsHistory.push({
          node: 'error',
          timestamp: new Date().toISOString(),
        });
        await this.errorNode(state);
      }

      // 4. Save assistant reply
      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        state.finalResponse || 'I encountered an execution boundary error.',
        { runId, steps: state.stepsHistory }
      );

      // Log success or failure status
      await this.updateAgentRun(runId, state.error ? 'failed' : 'completed', state.stepsHistory);

      return { userMessage, assistantMessage, runId };
    } catch (err: any) {
      logger.error({ msg: 'Agent orchestrator crashed during node transitions', err: err.message });
      state.currentNode = 'error';
      state.error = err.message;
      state.stepsHistory.push({
        node: 'error',
        timestamp: new Date().toISOString(),
      });
      await this.errorNode(state);

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        state.finalResponse || 'A fatal system transition error occurred.'
      );

      await this.updateAgentRun(runId, 'failed', state.stepsHistory);

      return { userMessage, assistantMessage, runId };
    }
  }

  // --- NODE TRANSITIONS ---

  private static async planningNode(state: AgentState): Promise<void> {
    const decision = await AgentRouter.route(state.inputQuery, state.userId);

    // Apply the parsed routing decision
    if (decision.route === 'tool' && decision.tool) {
      state.toolCalls.push({ name: decision.tool.name, args: decision.tool.args });
      state.currentNode = 'execution';
    } else if (decision.route === 'memory_retrieval' || decision.route === 'rag' || decision.route === 'multi_step') {
      state.currentNode = 'retrieval';
      if (decision.tool) {
        state.toolCalls.push({ name: decision.tool.name, args: decision.tool.args });
      }
    } else {
      state.currentNode = 'responding';
    }
  }

  /**
   * The original static heuristic planner is preserved here for verification comparison
   * and backwards compatibility until tests confirm full router stability.
   */
  private static async staticPlanningNode(state: AgentState): Promise<void> {
    const query = state.inputQuery.toLowerCase();

    // Check keyword cues
    if (query.includes('time') || query.includes('clock') || query.includes('date')) {
      state.toolCalls.push({ name: 'get_current_time', args: {} });
      state.currentNode = 'execution';
    } else if (
      query.includes('python') ||
      query.includes('chocolate') ||
      query.includes('guide') ||
      query.includes('remember') ||
      query.includes('preference')
    ) {
      state.currentNode = 'retrieval';
    } else {
      state.currentNode = 'responding';
    }
  }

  private static async retrievalNode(state: AgentState): Promise<void> {
    const { chunks, memories } = await RAGService.queryAndRetrieve(state.userId, state.inputQuery);
    state.retrievedContext.chunks = chunks;
    state.retrievedContext.memories = memories;
    
    // Support multi-step execution transitions
    if (state.toolCalls.length > 0) {
      state.currentNode = 'execution';
    } else {
      state.currentNode = 'responding';
    }
  }

  private static async executionNode(state: AgentState): Promise<void> {
    const pending = state.toolCalls.find((tc) => tc.result === undefined && tc.error === undefined);
    if (!pending) {
      state.currentNode = 'responding';
      return;
    }

    try {
      const execResult = await ToolExecutor.executeTool(state.userId, pending.name, pending.args);
      if (execResult.success) {
        pending.result = execResult.result;
      } else {
        pending.error = execResult.error;
      }
    } catch (err: any) {
      pending.error = err.message;
    }

    state.currentNode = 'responding';
  }

  private static async respondingNode(state: AgentState): Promise<void> {
    let retrievedText = '';

    if (state.retrievedContext.memories.length > 0) {
      retrievedText += '\n=== RETRIEVED MEMORIES ===\n';
      state.retrievedContext.memories.forEach((m) => {
        retrievedText += `- ${m.content}\n`;
      });
    }

    if (state.retrievedContext.chunks.length > 0) {
      retrievedText += '\n=== RETRIEVED DOCUMENTS ===\n';
      state.retrievedContext.chunks.forEach((chunk, idx) => {
        retrievedText += `[Doc reference #${idx + 1}] "${chunk.title}": ${chunk.content}\n`;
      });
    }

    if (state.toolCalls.length > 0) {
      retrievedText += '\n=== EXECUTED TOOL RESULTS ===\n';
      state.toolCalls.forEach((tc) => {
        retrievedText += `Tool: "${tc.name}" -> Result: ${JSON.stringify(tc.result || tc.error)}\n`;
      });
    }

    const systemPrompt = `You are GIA, a modular personal assistant.
Answer the user's question leveraging the provided context. If documents are cited, mention document titles.

Context details:${retrievedText || '\n(No background context retrieved)'}`;

    const history = await MessageRepository.findByConversationId(state.conversationId);
    const llmRequest = ContextBuilder.buildContext(history);
    llmRequest.systemPrompt = systemPrompt;

    const response = await LLMGateway.generate(llmRequest, { conversationId: state.conversationId });
    state.finalResponse = response.content;
    state.currentNode = 'done';
  }

  private static async errorNode(state: AgentState): Promise<void> {
    state.finalResponse = `I encountered an orchestration runtime error: ${state.error || 'Unknown error'}`;
    state.currentNode = 'done';
  }

  // --- OBSERVABILITY METHODS ---

  private static async createAgentRun(conversationId: string, status: string): Promise<string> {
    const sql = `
      INSERT INTO agent_runs (conversation_id, status, steps)
      VALUES ($1, $2, '[]'::jsonb)
      RETURNING id
    `;
    const res = await query<{ id: string }>(sql, [conversationId, status]);
    return res.rows[0].id;
  }

  private static async updateAgentRun(id: string, status: string, steps: any[]): Promise<void> {
    const sql = `
      UPDATE agent_runs
      SET status = $1, steps = $2, updated_at = NOW()
      WHERE id = $3
    `;
    await query(sql, [status, JSON.stringify(steps), id]);
  }
}
