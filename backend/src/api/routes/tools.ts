import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { ToolExecutor } from '../../ai/tools/executor.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError } from '../../shared/errors.js';

const executeToolSchema = z.object({
  toolName: z.string().min(1),
  arguments: z.record(z.any()),
  messageId: z.string().uuid().nullable().optional(),
});

export async function toolRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('preHandler', authenticate);

  // POST /api/v1/tools/execute
  fastify.post('/tools/execute', async (request, reply) => {
    const parsed = executeToolSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { toolName, arguments: rawArgs, messageId } = parsed.data;
    const userId = request.user.id;

    const result = await ToolExecutor.executeTool(userId, toolName, rawArgs, messageId || null);

    return reply.status(200).send(result);
  });
}
