import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { ConversationService } from '../../conversations/services/conversation.service.js';
import { RAGService } from '../../rag/services/rag.service.js';
import { ConversationRepository } from '../../database/repositories/conversation.repository.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError, AuthorizationError, NotFoundError } from '../../shared/errors.js';

const createConvoSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  summary: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

const createMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required'),
});

export async function conversationRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  // Enforce JWT check on all routes in this plugin
  fastify.addHook('preHandler', authenticate);

  // POST /api/v1/conversations
  fastify.post('/conversations', async (request, reply) => {
    const parsed = createConvoSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { title, summary, metadata } = parsed.data;
    const userId = request.user.id;

    const conversation = await ConversationService.createConversation(
      userId,
      title,
      summary || null,
      metadata || {}
    );

    return reply.status(201).send({
      success: true,
      conversation,
    });
  });

  // GET /api/v1/conversations
  fastify.get('/conversations', async (request, reply) => {
    const userId = request.user.id;
    const conversations = await ConversationService.getUserConversations(userId);
    
    return reply.status(200).send({
      success: true,
      conversations,
    });
  });

  // GET /api/v1/conversations/:id/messages
  fastify.get('/conversations/:id/messages', async (request, reply) => {
    const userId = request.user.id;
    const { id: conversationId } = request.params as { id: string };

    const messages = await ConversationService.getConversationMessages(userId, conversationId);

    return reply.status(200).send({
      success: true,
      messages,
    });
  });

  // POST /api/v1/conversations/:id/messages (Sync message endpoint)
  fastify.post('/conversations/:id/messages', async (request, reply) => {
    const parsed = createMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const userId = request.user.id;
    const { id: conversationId } = request.params as { id: string };
    const { content } = parsed.data;

    const result = await ConversationService.sendMessageSync(userId, conversationId, content);

    return reply.status(200).send({
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
    });
  });

  // POST /api/v1/conversations/:id/messages/rag (RAG message endpoint)
  fastify.post('/conversations/:id/messages/rag', async (request, reply) => {
    const parsed = createMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const userId = request.user.id;
    const { id: conversationId } = request.params as { id: string };
    const { content } = parsed.data;

    const result = await RAGService.sendMessageRAG(userId, conversationId, content);

    return reply.status(200).send({
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      sources: result.sources,
    });
  });

  // DELETE /api/v1/conversations/:id
  fastify.delete('/conversations/:id', async (request, reply) => {
    const userId = request.user.id;
    const { id: conversationId } = request.params as { id: string };

    const conversation = await ConversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }
    if (conversation.user_id !== userId) {
      throw new AuthorizationError('Access denied to this conversation');
    }

    await ConversationRepository.delete(conversationId);

    return reply.status(200).send({
      success: true,
    });
  });
}
