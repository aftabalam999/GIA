import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { UserRepository } from '../../database/repositories/user.repository.js';
import { hashPassword, verifyPassword } from '../../shared/auth.js';
import { ValidationError, AuthenticationError } from '../../shared/errors.js';
import { SessionService } from '../../auth/services/session.service.js';
import { authenticate } from '../middleware/auth.js';
import { config } from '../../config/index.js';

const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  name: z.string().min(1, 'Name is required'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export async function authRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  // Strict rate limit for auth endpoints: 10 requests per minute per IP
  const authRateLimit = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  };

  fastify.post('/auth/signup', { ...authRateLimit }, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { email, password, name } = parsed.data;

    // Check if user already exists
    const existing = await UserRepository.findByEmail(email);
    if (existing) {
      throw new ValidationError('Email is already registered');
    }

    // Hash password securely & save user
    const passwordHash = await hashPassword(password);
    const user = await UserRepository.create(email, name, passwordHash);

    // Create session record in Redis
    const session = await SessionService.createSession(user.id, user.email, user.name);

    // Set HttpOnly secure cookie
    reply.setCookie('session_id', session.id, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: config.SESSION_TTL_SECONDS,
    });

    return reply.status(201).send({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token: session.id, // For backwards compatibility with API/test clients
    });
  });

  fastify.post('/auth/login', { ...authRateLimit }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Validation failed', parsed.error.format());
    }

    const { email, password } = parsed.data;

    // Retrieve user and their stored password hash
    const user = await UserRepository.findByEmailWithPassword(email);
    if (!user) {
      throw new AuthenticationError('Invalid email or password');
    }

    // Validate credentials using constant-time timingSafeEqual scrypt check
    const isPasswordValid = await verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      throw new AuthenticationError('Invalid email or password');
    }

    // Create session record in Redis
    const session = await SessionService.createSession(user.id, user.email, user.name);

    // Set HttpOnly secure cookie
    reply.setCookie('session_id', session.id, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: config.SESSION_TTL_SECONDS,
    });

    return reply.status(200).send({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      token: session.id, // For backwards compatibility with API/test clients
    });
  });

  // GET /api/v1/auth/me
  fastify.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
    return reply.status(200).send({
      success: true,
      user: request.user,
    });
  });

  // POST /api/v1/auth/logout
  fastify.post('/auth/logout', async (request, reply) => {
    let sessionId = request.cookies?.session_id;

    // Fallback to Bearer token for logging out API/test clients
    if (!sessionId && request.headers.authorization) {
      const parts = request.headers.authorization.split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        sessionId = parts[1];
      }
    }

    if (sessionId) {
      await SessionService.revokeSession(sessionId);
    }

    reply.clearCookie('session_id', { path: '/' });
    return reply.status(200).send({ success: true });
  });

  // POST /api/v1/auth/revoke-all
  fastify.post('/auth/revoke-all', { preHandler: authenticate }, async (request, reply) => {
    await SessionService.revokeAllUserSessions(request.user.id);
    reply.clearCookie('session_id', { path: '/' });
    return reply.status(200).send({ success: true });
  });
}
