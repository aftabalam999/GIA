import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { ConversationOrchestrator } from '../../ai/orchestrator/conversation-orchestrator.service.js';
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

    const result = await ConversationOrchestrator.processUserMessage({
      conversationId,
      userId,
      content,
      inputType: 'text',
      options: { requestId: request.id },
    });

    return reply.status(result.success ? 200 : 400).send(result);
  });
}
