import Fastify from 'fastify';
import crypto from 'crypto';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCookie from '@fastify/cookie';
import { config } from './config/index.js';
import { logger } from './shared/logger.js';
import { errorHandler } from './api/middleware/errorHandler.js';
import { initializeDatabase } from './database/client.js';
import { initializeRedis } from './shared/redis.js';
import { healthRoutes } from './api/routes/health.js';
import { authRoutes } from './api/routes/auth.js';
import { conversationRoutes } from './api/routes/conversations.js';
import { chatStreamRoute } from './api/routes/chatStream.js';
import { memoryRoutes } from './api/routes/memories.js';
import { documentRoutes } from './api/routes/documents.js';
import { toolRoutes } from './api/routes/tools.js';
import { agentRoutes } from './api/routes/agent.js';

import fastifyMultipart from '@fastify/multipart';
import { voiceRoutes } from './api/routes/voice.js';

const fastify = Fastify({
  logger: false, // Custom logger handled separately
  genReqId: () => crypto.randomUUID(),
  disableRequestLogging: true,
  bodyLimit: 1 * 1024 * 1024, // 1MB global body size limit
});

// Configure custom error handler
fastify.setErrorHandler(errorHandler);

// Register Multipart Plugin for audio file uploads
await fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max audio file size
  },
});

// Enable CORS
await fastify.register(cors, {
  origin: (origin, cb) => {
    // If no origin (e.g. non-browser clients), allow
    if (!origin) {
      cb(null, true);
      return;
    }
    // If CORS_ORIGIN is specified and matches, allow. Else, in development allow localhost
    if (config.CORS_ORIGIN) {
      const allowedOrigins = config.CORS_ORIGIN.split(',').map(o => o.trim());
      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
    } else if (config.NODE_ENV === 'development' || config.NODE_ENV === 'test') {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// Register Cookie Plugin
await fastify.register(fastifyCookie);

// Global rate limit: 200 requests per minute per IP (fallback)
await fastify.register(fastifyRateLimit, {
  global: true,
  max: 200,
  timeWindow: '1 minute',
  skipOnError: config.NODE_ENV === 'test',
  errorResponseBuilder: (_request, context) => ({
    success: false,
    error: {
      message: `Rate limit exceeded. Try again in ${context.after}`,
      statusCode: 429,
    },
  }),
});

// Configure request lifecycle observability hooks
fastify.addHook('onRequest', async (request) => {
  request.log = logger.child({ requestId: request.id });
  (request as any).startTime = Date.now();
  
  const headers = { ...request.headers };
  if (headers.authorization) {
    headers.authorization = '[REDACTED]';
  }
  if (headers.cookie) {
    headers.cookie = '[REDACTED]';
  }

  request.log.info({
    msg: 'Incoming HTTP Request',
    method: request.method,
    url: request.url,
    ip: request.ip,
    headers,
  });
});

fastify.addHook('onResponse', async (request, reply) => {
  const duration = Date.now() - ((request as any).startTime || Date.now());

  let body = request.body as any;
  if (body && typeof body === 'object') {
    body = { ...body };
    if ('password' in body) {
      body.password = '[REDACTED]';
    }
  }

  request.log.info({
    msg: 'HTTP Request Completed',
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    durationMs: duration,
    payload: body,
  });
});

// Register JWT Plugin (Still registered to prevent type issues, though we use Redis sessions)
await fastify.register(fastifyJwt, {
  secret: config.JWT_SECRET,
});

// Register WebSocket Plugin
await fastify.register(fastifyWebsocket);

// Register routes under prefix
await fastify.register(healthRoutes, { prefix: '/api/v1' });
await fastify.register(authRoutes, { prefix: '/api/v1' });
await fastify.register(conversationRoutes, { prefix: '/api/v1' });
await fastify.register(chatStreamRoute, { prefix: '/api/v1' });
await fastify.register(memoryRoutes, { prefix: '/api/v1' });
await fastify.register(documentRoutes, { prefix: '/api/v1' });
await fastify.register(toolRoutes, { prefix: '/api/v1' });
await fastify.register(agentRoutes, { prefix: '/api/v1' });
await fastify.register(voiceRoutes, { prefix: '/api/v1' });

async function start() {
  try {
    // Initialize PostgreSQL client connection pool
    await initializeDatabase();

    // Initialize Redis connection
    await initializeRedis();

    // Start Fastify server
    await fastify.listen({ port: config.PORT, host: config.HOST });
    logger.info(`🚀 GIA Fastify Backend server running at http://${config.HOST}:${config.PORT}`);
  } catch (err: any) {
    logger.fatal({ msg: 'Failed to start GIA Backend Server', err: err.message });
    process.exit(1);
  }
}

/**
 * Graceful shutdown: drain in-flight requests, then close the DB pool.
 * Triggered on SIGTERM (container stop) or SIGINT (Ctrl+C).
 */
async function shutdown(signal: string) {
  logger.info({ msg: `Received ${signal}. Initiating graceful shutdown...` });
  try {
    await fastify.close();
    logger.info('✅ Fastify server closed cleanly');
  } catch (err: any) {
    logger.error({ msg: 'Error during Fastify shutdown', err: err.message });
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();