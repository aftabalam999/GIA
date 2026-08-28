import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { ConversationService } from '../../conversations/services/conversation.service.js';
import { SessionService } from '../../auth/services/session.service.js';
import { logger } from '../../shared/logger.js';

export async function chatStreamRoute(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.get('/chat/stream', { websocket: true }, async (connection, request) => {
    let sessionId = request.cookies?.session_id;

    // Fallback to query param token for backward compatibility
    if (!sessionId) {
      sessionId = (request.query as { token?: string }).token;
    }

    if (!sessionId) {
      connection.socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Missing session ID' }));
      connection.socket.close();
      return;
    }

    let user: { id: string; email: string; name: string };
    try {
      const session = await SessionService.lookupSession(sessionId);
      if (!session) {
        connection.socket.send(JSON.stringify({ type: 'error', message: 'Unauthorized: Invalid or expired session' }));
        connection.socket.close();
        return;
      }
      user = {
        id: session.userId,
        email: session.email,
        name: session.name,
      };
    } catch (err: any) {
      connection.socket.send(JSON.stringify({ type: 'error', message: 'Authentication service temporarily unavailable' }));
      connection.socket.close();
      return;
    }

    logger.debug(`🔌 WebSocket connection established for user: ${user.email}`);

    connection.socket.on('message', async (messageBuffer: any) => {
      try {
        const rawMessage = messageBuffer.toString();
        const parsed = JSON.parse(rawMessage);
        const { conversation_id, content } = parsed;

        if (!conversation_id || !content) {
          connection.socket.send(JSON.stringify({
            type: 'error',
            message: 'Invalid payload: conversation_id and content required',
          }));
          return;
        }

        // Call streaming service method
        await ConversationService.sendMessageStream(
          user.id,
          conversation_id,
          content,
          {
            onChunk: (chunk) => {
              connection.socket.send(JSON.stringify({ type: 'chunk', content: chunk }));
            },
            onComplete: (assistantMessage) => {
              connection.socket.send(JSON.stringify({ type: 'done', message: assistantMessage }));
            },
            onError: (err) => {
              logger.error({ msg: 'Streaming processing failure', err: err.message });
              connection.socket.send(JSON.stringify({
                type: 'error',
                message: err.message || 'Stream processing error',
              }));
            },
          }
        );
      } catch (err: any) {
        logger.error({ msg: 'WebSocket socket message parse error', err: err.message });
        connection.socket.send(JSON.stringify({ type: 'error', message: 'Invalid payload JSON format' }));
      }
    });

    connection.socket.on('close', () => {
      logger.debug(`🔌 WebSocket connection closed for user: ${user.email}`);
    });
  });
}
