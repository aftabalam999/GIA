import { ConversationRepository, Conversation } from '../../database/repositories/conversation.repository.js';
import { MessageRepository, Message } from '../../database/repositories/message.repository.js';
import { LLMGateway } from '../../ai/router/index.js';
import { ContextBuilder } from '../../ai/orchestrator/contextBuilder.js';
import { TaskPlanningEngine } from '../../ai/planner/planner.service.js';
import { PlanRepository } from '../../ai/planner/plan.repository.js';
import { PermissionManager } from '../../ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../../ai/execution/plan-execution.engine.js';
import { ConversationOrchestrator } from '../../ai/orchestrator/conversation-orchestrator.service.js';
import { NotFoundError, AuthorizationError } from '../../shared/errors.js';

export class ConversationService {
  /**
   * Helper to verify conversation ownership.
   * Throws NotFoundError if missing, AuthenticationError if owned by another user.
   */
  private static async verifyOwnership(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await ConversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    if (conversation.user_id !== userId) {
      throw new AuthorizationError('Access denied to this conversation');
    }
    return conversation;
  }

  static async createConversation(
    userId: string,
    title: string,
    summary: string | null = null,
    metadata: Record<string, any> = {}
  ): Promise<Conversation> {
    return ConversationRepository.create(userId, title, summary, metadata);
  }

  static async getConversationById(userId: string, id: string): Promise<Conversation> {
    return this.verifyOwnership(userId, id);
  }

  static async getUserConversations(userId: string): Promise<Conversation[]> {
    return ConversationRepository.findByUserId(userId);
  }

  static async getConversationMessages(userId: string, conversationId: string): Promise<Message[]> {
    await this.verifyOwnership(userId, conversationId);
    return MessageRepository.findByConversationId(conversationId);
  }

  /**
   * Sends a user message, delegates to the unified Conversation Orchestrator, and returns both messages.
   */
  static async sendMessageSync(
    userId: string,
    conversationId: string,
    content: string
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    const result = await ConversationOrchestrator.processUserMessage({
      conversationId,
      userId,
      content,
      inputType: 'text',
    });

    return {
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
    };
  }

  /**
   * Sends a user message, streams the LLM chunks, and persists the assistant reply on stream completion.
   */
  static async sendMessageStream(
    userId: string,
    conversationId: string,
    content: string,
    callbacks: {
      onChunk: (chunk: string) => void;
      onComplete: (assistantMessage: Message) => void;
      onError: (err: any) => void;
    }
  ): Promise<Message> {
    await this.verifyOwnership(userId, conversationId);

    // 1. Check for Active Pending Plan or Actionable Instruction -> Route to Unified Orchestrator
    const activePlan = await PlanRepository.findActiveByConversationId(conversationId);
    if (activePlan || TaskPlanningEngine.isActionableInstruction(content)) {
      try {
        const res = await ConversationOrchestrator.processUserMessage({
          conversationId,
          userId,
          content,
          inputType: 'text',
        });
        callbacks.onChunk(res.assistantMessage.content);
        callbacks.onComplete(res.assistantMessage);
        return res.userMessage;
      } catch (err: any) {
        callbacks.onError(err);
        throw err;
      }
    }

    // 1. Save user message
    const userMessage = await MessageRepository.create(conversationId, 'user', content);

    // 2. Load context
    const history = await MessageRepository.findByConversationId(conversationId);
    const llmRequest = ContextBuilder.buildContext(history);
    llmRequest.maxTokens = 350;
    llmRequest.enableThinking = false;

    // Async stream execution
    (async () => {
      let fullText = '';
      try {
        const stream = LLMGateway.stream(llmRequest, { conversationId });

        for await (const chunk of stream) {
          fullText += chunk.content;
          callbacks.onChunk(chunk.content);
        }

        // Save complete assistant reply
        const assistantMessage = await MessageRepository.create(
          conversationId,
          'assistant',
          fullText,
          { streamed: true }
        );
        callbacks.onComplete(assistantMessage);
      } catch (err: any) {
        callbacks.onError(err);
      }
    })();

    return userMessage;
  }
}
