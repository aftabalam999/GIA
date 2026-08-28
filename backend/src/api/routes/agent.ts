import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { AgentOrchestrator } from '../../ai/orchestrator/orchestrator.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError } from '../../shared/errors.js';

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

    const result = await AgentOrchestrator.run(userId, conversationId, content);

    return reply.status(200).send({
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      runId: result.runId,
    });
  });
}
