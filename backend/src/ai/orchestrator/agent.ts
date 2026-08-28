import { LLMGateway } from '../router/index.js';
import { registry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { MessageRepository, Message } from '../../database/repositories/message.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { ContextBuilder } from './contextBuilder.js';
import { AuthenticationError, NotFoundError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

export class Agent {
  /**
   * Runs GIA multi-turn agent loop. Triggers tool requests when structured JSON payloads
   * are returned, executes validations, appends inputs/results to conversation history,
   * and repeats loop sequences until a final conversational reply is generated.
   */
  static async runAgentLoop(
    userId: string,
    conversationId: string,
    content: string
  ): Promise<{ userMessage: Message; assistantMessage: Message }> {
    // 1. Verify conversation ownership
    const conversation = await ConversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    if (conversation.user_id !== userId) {
      throw new AuthenticationError('Unauthorized access to conversation');
    }

    // 2. Persist user message
    const userMessage = await MessageRepository.create(conversationId, 'user', content);

    // Prepare tool lists
    const toolsList = registry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
    }));

    const systemPrompt = `You are GIA, a modular personal assistant.
You have access to the following tools:
${JSON.stringify(toolsList, null, 2)}

If you need to call a tool to answer the user's query, you MUST return a structured JSON response matching this schema:
{
  "tool_call": {
    "name": "tool_name",
    "arguments": { ... }
  }
}

Important rules:
1. Output ONLY the JSON block. Do not include markdown code block syntax (like \`\`\`json) or any conversational text.
2. If you do not need to call any tools, or if you have already received the tool results and are ready to compile the final answer, reply with a normal conversational text response.
3. Be helpful, concise, and accurate.`;

    let loopCount = 0;
    const maxLoops = 5;

    while (loopCount < maxLoops) {
      loopCount++;

      // Fetch message history
      const history = await MessageRepository.findByConversationId(conversationId);
      const llmRequest = ContextBuilder.buildContext(history);
      llmRequest.systemPrompt = systemPrompt;

      // Invoke LLM Gateway
      const response = await LLMGateway.generate(llmRequest, { conversationId });

      // Check if response contains a tool call payload
      let toolCallData: any = null;
      try {
        const parsed = JSON.parse(response.content.trim());
        if (parsed && typeof parsed === 'object' && parsed.tool_call) {
          toolCallData = parsed.tool_call;
        }
      } catch {
        // Not a JSON block or invalid keys -> treat as final conversational response
      }

      if (toolCallData) {
        // Save the assistant's tool-call request message
        const toolRequestMsg = await MessageRepository.create(
          conversationId,
          'assistant',
          response.content,
          { model: response.model, provider: response.provider }
        );

        // Execute tool call through ToolExecutor
        const executionResult = await ToolExecutor.executeTool(
          userId,
          toolCallData.name,
          toolCallData.arguments,
          toolRequestMsg.id
        );

        // Append the tool result back into message history as a user message
        await MessageRepository.create(
          conversationId,
          'user',
          `Tool execution result for "${toolCallData.name}": ${JSON.stringify(executionResult)}`
        );

        // Loop again so the LLM processes results
        continue;
      } else {
        // No tool call requested -> save final reply and break loop
        const assistantMessage = await MessageRepository.create(
          conversationId,
          'assistant',
          response.content,
          { model: response.model, provider: response.provider }
        );
        return { userMessage, assistantMessage };
      }
    }

    // Safeguard loop boundary fallback
    const assistantMessage = await MessageRepository.create(
      conversationId,
      'assistant',
      'I encountered a tool execution loop limit safeguard.'
    );
    return { userMessage, assistantMessage };
  }
}
