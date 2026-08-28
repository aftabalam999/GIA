import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { MemoryService } from '../../memories/services/memory.service.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError } from '../../shared/errors.js';

const createMemorySchema = z.object({
  type: z.string().min(1),
  content: z.string().min(1),
  importance: z.number().int().min(1).max(10),
  confidence: z.number().min(0.0).max(1.0),
  metadata: z.record(z.any()).optional(),
});

const updateMemorySchema = z.object({
  content: z.string().optional(),
  importance: z.number().int().min(1).max(10).optional(),
  confidence: z.number().min(0.0).max(1.0).optional(),
  metadata: z.record(z.any()).optional(),
});

const extractMemorySchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1),
});

export async function memoryRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('preHandler', authenticate);

  // POST /api/v1/memories
  fastify.post('/memories', async (request, reply) => {
    const parsed = createMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { type, content, importance, confidence, metadata } = parsed.data;
    const userId = request.user.id;

    const memory = await MemoryService.createMemory(
      userId,
      type,
      content,
      importance,
      confidence,
      metadata || {}
    );

    return reply.status(201).send({
      success: true,
      memory,
    });
  });

  // GET /api/v1/memories
  fastify.get('/memories', async (request, reply) => {
    const userId = request.user.id;
    const memories = await MemoryService.searchMemories(userId, ''); // empty query gets all

    return reply.status(200).send({
      success: true,
      memories,
    });
  });

  // GET /api/v1/memories/search
  fastify.get('/memories/search', async (request, reply) => {
    const userId = request.user.id;
    const { q, semantic, threshold, limit } = request.query as {
      q?: string;
      semantic?: string;
      threshold?: string;
      limit?: string;
    };
    if (!q) {
      throw new ValidationError('Query parameter "q" is required for search');
    }

    let memories;
    if (semantic === 'true') {
      const limitNum = limit ? parseInt(limit, 10) : 5;
      const thresholdNum = threshold ? parseFloat(threshold) : 0.5;
      memories = await MemoryService.searchMemoriesSemantic(userId, q, limitNum, thresholdNum);
    } else {
      memories = await MemoryService.searchMemories(userId, q);
    }

    return reply.status(200).send({
      success: true,
      memories,
    });
  });

  // PUT /api/v1/memories/:id
  fastify.put('/memories/:id', async (request, reply) => {
    const parsed = updateMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const userId = request.user.id;
    const { id } = request.params as { id: string };

    const memory = await MemoryService.updateMemory(userId, id, parsed.data);

    return reply.status(200).send({
      success: true,
      memory,
    });
  });

  // DELETE /api/v1/memories/:id
  fastify.delete('/memories/:id', async (request, reply) => {
    const userId = request.user.id;
    const { id } = request.params as { id: string };

    await MemoryService.deleteMemory(userId, id);

    return reply.status(200).send({
      success: true,
    });
  });

  // POST /api/v1/memories/extract (Explicit LLM Extraction)
  fastify.post('/memories/extract', async (request, reply) => {
    const parsed = extractMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const userId = request.user.id;
    const { conversationId, content } = parsed.data;

    const memories = await MemoryService.extractAndSaveMemory(userId, conversationId, content);

    return reply.status(200).send({
      success: true,
      memories,
    });
  });
}
