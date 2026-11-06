import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PlanRepository } from '../../ai/planner/plan.repository.js';
import { TaskPlanningEngine } from '../../ai/planner/planner.service.js';
import { PermissionManager } from '../../ai/permissions/permission.manager.js';
import { PlanExecutionEngine } from '../../ai/execution/plan-execution.engine.js';
import { ExecutionRepository } from '../../ai/execution/execution.repository.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { authenticate } from '../middleware/auth.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../../shared/errors.js';

export async function planRoutes(fastify: FastifyInstance) {
  // Enforce JWT check on all routes in this plugin
  fastify.addHook('preHandler', authenticate);

  // 1. Get active plan for a conversation
  fastify.get('/conversations/:id/plans/active', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const activePlan = await PlanRepository.findActiveByConversationId(conversationId);
    return reply.send({ success: true, plan: activePlan });
  });

  // 2. Create a new plan from an instruction
  fastify.post('/conversations/:id/plans', async (request: FastifyRequest<{ Params: { id: string }; Body: { instruction: string } }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const schema = z.object({ instruction: z.string().min(1) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const plan = await TaskPlanningEngine.createPlan(userId, conversationId, parsed.data.instruction);
    const presentation = TaskPlanningEngine.presentPlan(plan);

    return reply.status(201).send({
      success: true,
      plan,
      presentation,
    });
  });

  // 3. Modify an existing plan
  fastify.put('/conversations/:id/plans/:planId', async (request: FastifyRequest<{ Params: { id: string; planId: string }; Body: { feedback: string } }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { planId } = request.params;

    const schema = z.object({ feedback: z.string().min(1) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const existingPlan = await PlanRepository.findById(planId);
    if (!existingPlan) throw new NotFoundError('Task plan not found');
    if (existingPlan.conversation_id !== conversationId) throw new AuthorizationError('Plan mismatch');

    // Rule 9: Modification invalidates existing approval and tickets
    await PermissionManager.invalidateApproval(planId, 'Plan modified by user');

    const updatedPlan = await TaskPlanningEngine.modifyPlan(existingPlan, parsed.data.feedback);
    const presentation = TaskPlanningEngine.presentPlan(updatedPlan);

    return reply.send({
      success: true,
      plan: updatedPlan,
      presentation,
    });
  });

  // 4. Approve plan via Centralized Permission Manager
  fastify.post('/conversations/:id/plans/:planId/approve', async (request: FastifyRequest<{
    Params: { id: string; planId: string };
    Body?: {
      planVersion?: number;
      channel?: 'web_ui' | 'voice_command' | 'api';
      explicitConfirmation?: boolean;
      voiceTranscript?: string;
      sensitiveConfirmations?: Record<string, boolean>;
      isAssistantVoice?: boolean;
    };
  }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { planId } = request.params;
    const body = request.body || {};

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const plan = await PlanRepository.findById(planId);
    if (!plan) throw new NotFoundError('Task plan not found');
    if (plan.conversation_id !== conversationId) throw new AuthorizationError('Plan mismatch');

    const approvalResult = await PermissionManager.requestApproval({
      planId,
      planVersion: body.planVersion ?? plan.version,
      userId,
      channel: body.channel || 'web_ui',
      explicitConfirmation: body.explicitConfirmation ?? true,
      voiceTranscript: body.voiceTranscript,
      sensitiveConfirmations: body.sensitiveConfirmations,
      isAssistantVoice: body.isAssistantVoice,
    });

    if (!approvalResult.success) {
      return reply.status(400).send({
        success: false,
        state: approvalResult.state,
        message: approvalResult.message,
        missingSensitiveConfirmations: approvalResult.missingSensitiveConfirmations,
      });
    }

    const approvedPlan = await PlanRepository.findById(planId);

    return reply.send({
      success: true,
      plan: approvedPlan,
      ticket: approvalResult.ticket,
      message: approvalResult.message,
    });
  });

  // 5. Reject plan via Centralized Permission Manager
  fastify.post('/conversations/:id/plans/:planId/reject', async (request: FastifyRequest<{ Params: { id: string; planId: string }; Body?: { reason?: string } }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { planId } = request.params;

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const plan = await PlanRepository.findById(planId);
    if (!plan) throw new NotFoundError('Task plan not found');
    if (plan.conversation_id !== conversationId) throw new AuthorizationError('Plan mismatch');

    const rejectionResult = await PermissionManager.rejectPlan(
      planId,
      userId,
      request.body?.reason || 'Rejected by user'
    );

    const rejectedPlan = await PlanRepository.findById(planId);

    return reply.send({
      success: true,
      plan: rejectedPlan,
      message: rejectionResult.message,
    });
  });

  // 6. Voice command approval processing endpoint
  fastify.post('/conversations/:id/plans/voice-command', async (request: FastifyRequest<{
    Params: { id: string };
    Body: { transcript: string; isAssistantVoice?: boolean };
  }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;

    const schema = z.object({
      transcript: z.string().min(1),
      isAssistantVoice: z.boolean().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const activePlan = await PlanRepository.findActiveByConversationId(conversationId);
    if (!activePlan) {
      return reply.status(404).send({
        success: false,
        message: 'No active pending task plan found for this conversation.',
      });
    }

    const approvalResult = await PermissionManager.requestApproval({
      planId: activePlan.id,
      planVersion: activePlan.version,
      userId,
      channel: 'voice_command',
      voiceTranscript: parsed.data.transcript,
      isAssistantVoice: parsed.data.isAssistantVoice,
    });

    const updatedPlan = await PlanRepository.findById(activePlan.id);

    return reply.status(approvalResult.success ? 200 : 400).send({
      success: approvalResult.success,
      state: approvalResult.state,
      message: approvalResult.message,
      plan: updatedPlan,
      ticket: approvalResult.ticket,
    });
  });

  // 7. Execute approved plan via PlanExecutionEngine
  fastify.post('/conversations/:id/plans/:planId/execute', async (request: FastifyRequest<{
    Params: { id: string; planId: string };
    Body: { ticketToken: string; planVersion?: number };
  }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { planId } = request.params;

    const schema = z.object({
      ticketToken: z.string().min(1, 'Approval ticket token is required'),
      planVersion: z.number().int().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const plan = await PlanRepository.findById(planId);
    if (!plan) throw new NotFoundError('Task plan not found');
    if (plan.conversation_id !== conversationId) throw new AuthorizationError('Plan mismatch');

    const executionResult = await PlanExecutionEngine.executeApprovedPlan({
      planId,
      planVersion: parsed.data.planVersion ?? plan.version,
      userId,
      ticketToken: parsed.data.ticketToken,
    });

    return reply.status(200).send({
      success: executionResult.status === 'completed',
      execution: executionResult,
    });
  });

  // 8. Cancel active plan execution
  fastify.post('/conversations/:id/plans/:planId/cancel', async (request: FastifyRequest<{
    Params: { id: string; planId: string };
  }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { planId } = request.params;

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const cancelled = await PlanExecutionEngine.cancelExecution(planId, userId);
    if (!cancelled) {
      // If not actively running in engine, allow cancelling pending, approved, or modified plans
      const plan = await PlanRepository.findById(planId);
      if (plan && ['awaiting_approval', 'pending', 'approved', 'modified'].includes(plan.status)) {
        await PermissionManager.cancelPlan(planId, 'Plan cancelled by user');
        return reply.send({
          success: true,
          message: 'Plan cancelled.',
        });
      }
    }
    return reply.send({
      success: cancelled,
      message: cancelled ? 'Plan execution cancelled.' : 'No active execution found to cancel.',
    });
  });

  // 9. Get execution audit logs for a plan
  fastify.get('/conversations/:id/plans/:planId/executions', async (request: FastifyRequest<{
    Params: { id: string; planId: string };
  }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { planId } = request.params;

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const executions = await ExecutionRepository.getExecutionHistory(planId);
    return reply.send({ success: true, executions });
  });

  // 10. Get step execution details for an execution run
  fastify.get('/conversations/:id/plans/:planId/executions/:executionId/steps', async (request: FastifyRequest<{
    Params: { id: string; planId: string; executionId: string };
  }>, reply: FastifyReply) => {
    const userId = request.user.id;
    const conversationId = request.params.id;
    const { executionId } = request.params;

    const convo = await ConversationRepository.findById(conversationId);
    if (!convo) throw new NotFoundError('Conversation not found');
    if (convo.user_id !== userId) throw new AuthorizationError('Access denied');

    const stepLogs = await ExecutionRepository.getStepExecutions(executionId);
    return reply.send({ success: true, steps: stepLogs });
  });
}
