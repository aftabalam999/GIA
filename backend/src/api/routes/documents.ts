import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { DocumentService } from '../../documents/services/document.service.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError } from '../../shared/errors.js';

const createDocSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50000, 'Document content cannot exceed 50,000 characters'),
  sourceType: z.string().min(1).max(100),
  sourceUrl: z.string().url().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

export async function documentRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('preHandler', authenticate);

  // POST /api/v1/documents
  fastify.post('/documents', async (request, reply) => {
    const parsed = createDocSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { title, content, sourceType, sourceUrl, metadata } = parsed.data;
    const userId = request.user.id;

    const document = await DocumentService.createDocument(
      userId,
      title,
      content,
      sourceType,
      sourceUrl || null,
      metadata || {}
    );

    return reply.status(201).send({
      success: true,
      document,
    });
  });

  // GET /api/v1/documents
  fastify.get('/documents', async (request, reply) => {
    const userId = request.user.id;
    const documents = await DocumentService.getUserDocuments(userId);

    return reply.status(200).send({
      success: true,
      documents,
    });
  });

  // DELETE /api/v1/documents/:id
  fastify.delete('/documents/:id', async (request, reply) => {
    const userId = request.user.id;
    const { id } = request.params as { id: string };

    await DocumentService.deleteDocument(userId, id);

    return reply.status(200).send({
      success: true,
    });
  });
}
