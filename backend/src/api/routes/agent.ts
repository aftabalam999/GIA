import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AgentOrchestrator } from '../../ai/orchestrator/orchestrator.js';
import { TaskPlanningEngine } from '../../ai/planner/planner.service.js';
import { PlanRepository } from '../../ai/planner/plan.repository.js';
import { PermissionManager } from '../../ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../../ai/execution/plan-execution.engine.js';
import { MessageRepository } from '../../database/repositories/message.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError, NotFoundError, AuthorizationError } from '../../shared/errors.js';

const messageSchema = z.object({
  content: z.string().min(1, 'Message content is required'),
});

export async function agentRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('preHandler', authenticate);

  // POST /api/v1/conversations/:id/messages/agent
  fastify.post('/conversations/:id/messages/agent', async (request, reply) => {
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { content } = parsed.data;
    const userId = request.user.id;
    const { id: conversationId } = request.params as { id: string };

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied to this conversation');

    // 1. Check for active pending plan in conversation
    const activePlan = await PlanRepository.findActiveByConversationId(conversationId);
    const intentResult = TaskPlanningEngine.classifyIntent(content, Boolean(activePlan));

    // Handle Active Plan Approval
    if (activePlan && intentResult.intent === 'approve_plan') {
      const userMessage = await MessageRepository.create(conversationId, 'user', content);
      const approvalResult = await PermissionManager.requestApproval({
        planId: activePlan.id,
        planVersion: activePlan.version,
        userId,
        conversationId,
        channel: 'web_ui',
        explicitConfirmation: true,
      });

      if (!approvalResult.success || !approvalResult.ticket) {
        const assistantMessage = await MessageRepository.create(
          conversationId,
          'assistant',
          `⚠️ Plan approval failed: ${approvalResult.message}`
        );
        return reply.status(400).send({
          success: false,
          error: { message: approvalResult.message, statusCode: 400 },
          message: approvalResult.message,
          userMessage,
          assistantMessage,
          plan: await PlanRepository.findById(activePlan.id),
        });
      }

      const executionResult = await PlanExecutionEngine.executeApprovedPlan({
        planId: activePlan.id,
        planVersion: activePlan.version,
        userId,
        ticketToken: (approvalResult.ticket.ticketToken || approvalResult.ticket.ticketId)!,
      });

      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        `✅ Plan "${activePlan.objective}" approved and executed.\n\nStatus: **${executionResult.status.toUpperCase()}** (${executionResult.completedSteps}/${executionResult.totalSteps} steps completed).`
      );

      return reply.status(200).send({
        success: true,
        userMessage,
        assistantMessage,
        plan: await PlanRepository.findById(activePlan.id),
        execution: executionResult,
      });
    }

    // Handle Active Plan Rejection / Cancellation
    if (activePlan && intentResult.intent === 'reject_plan') {
      const userMessage = await MessageRepository.create(conversationId, 'user', content);
      await PermissionManager.cancelPlan(activePlan.id, content);
      const updatedPlan = await PlanRepository.findById(activePlan.id);
      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        `🛑 Plan "${activePlan.objective}" has been cancelled. No actions were performed.`
      );
      return reply.status(200).send({
        success: true,
        userMessage,
        assistantMessage,
        plan: updatedPlan,
      });
    }

    // Handle Active Plan Modification
    if (activePlan && intentResult.intent === 'modify_plan') {
      const userMessage = await MessageRepository.create(conversationId, 'user', content);
      await PermissionManager.invalidateApproval(activePlan.id, 'User modified plan');
      const modifiedPlan = await TaskPlanningEngine.modifyPlan(activePlan, content);
      const presentation = TaskPlanningEngine.presentPlan(modifiedPlan);
      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        presentation
      );
      return reply.status(200).send({
        success: true,
        userMessage,
        assistantMessage,
        plan: modifiedPlan,
      });
    }

    // Handle Active Plan Explanation
    if (activePlan && intentResult.intent === 'explain_plan') {
      const userMessage = await MessageRepository.create(conversationId, 'user', content);
      const explanation = TaskPlanningEngine.explainPlan(activePlan, intentResult.stepIdToExplain);
      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        explanation
      );
      return reply.status(200).send({
        success: true,
        userMessage,
        assistantMessage,
        plan: activePlan,
      });
    }

    // 2. Actionable Instruction -> Formulate Plan First (MANDATORY REQUIREMENT)
    if (TaskPlanningEngine.isActionableInstruction(content) || intentResult.intent === 'create_plan') {
      const userMessage = await MessageRepository.create(conversationId, 'user', content);
      const plan = await TaskPlanningEngine.createPlan(userId, conversationId, content);
      const presentation = TaskPlanningEngine.presentPlan(plan);
      const assistantMessage = await MessageRepository.create(
        conversationId,
        'assistant',
        presentation
      );

      return reply.status(200).send({
        success: true,
        userMessage,
        assistantMessage,
        plan,
        presentation,
      });
    }

    // 3. Conversational / Q&A messages route to Agent Orchestrator
    const result = await AgentOrchestrator.run(userId, conversationId, content);

    return reply.status(200).send({
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      runId: result.runId,
    });
  });
}
