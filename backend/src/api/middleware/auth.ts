import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthenticationError } from '../../shared/errors.js';
import { SessionService } from '../../auth/services/session.service.js';

// Extend `@fastify/jwt` User representation to avoid breaking route files typing
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      id: string;
      email: string;
      name: string;
    };
  }
}

// Extend FastifyRequest type interfaces
declare module 'fastify' {
  interface FastifyRequest {
    cookies: { [key: string]: string | undefined };
    sessionId?: string;
  }
}

/**
 * Fastify preHandler hook to enforce Redis session validation on protected routes.
 * Extracts session ID from HttpOnly cookie or Authorization Bearer header,
 * verifies it in Redis, and populates request.user context.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  let sessionId = request.cookies?.session_id;

  // Fallback to Bearer token for API clients, testing, and backward compatibility
  if (!sessionId && request.headers.authorization) {
    const parts = request.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      sessionId = parts[1];
    }
  }

  if (!sessionId) {
    throw new AuthenticationError('Unauthorized: Missing session ID');
  }

  const session = await SessionService.lookupSession(sessionId);
  if (!session) {
    throw new AuthenticationError('Unauthorized: Invalid or expired session');
  }

  // Attach session context to request
  request.user = {
    id: session.userId,
    email: session.email,
    name: session.name,
  };
  request.sessionId = session.id;
}
