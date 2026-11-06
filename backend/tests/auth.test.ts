import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { authRoutes } from '../src/api/routes/auth.js';
import { authenticate } from '../src/api/middleware/auth.js';
import { errorHandler } from '../src/api/middleware/errorHandler.js';
import { initializeDatabase, pool, query } from '../src/database/client.js';

describe('GIA Authentication & Authorization Integration Tests', () => {
  const app = Fastify();

  beforeAll(async () => {
    app.setErrorHandler(errorHandler);
    await app.register(cors);
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, {
      secret: 'test_jwt_secret_key_1234567890',
    });
    await app.register(authRoutes, { prefix: '/api/v1' });

    // Protected dummy endpoint to verify token validation and identity propagation
    app.get('/api/v1/test/protected', { preHandler: [authenticate] }, async (request, reply) => {
      return reply.send({
        success: true,
        user: request.user,
      });
    });

    await initializeDatabase();
    await query('DELETE FROM users');
  });

  afterAll(async () => {
    await query('DELETE FROM users');
    await pool.end();
  });

  it('should sign up a new user and generate a valid JWT', async () => {
    const signupPayload = {
      email: 'auth_test@gia.ai',
      password: 'secure_password_123',
      name: 'Authentication Tester',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: signupPayload,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.user.email).toBe(signupPayload.email);
    expect(body.user.name).toBe(signupPayload.name);
    expect(body.token).toBeDefined();
  });

  it('should fail to signup with a duplicate email', async () => {
    const duplicatePayload = {
      email: 'auth_test@gia.ai',
      password: 'another_password',
      name: 'Duplicate Tester',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: duplicatePayload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('already registered');
  });

  it('should fail to signup with invalid inputs', async () => {
    const invalidPayload = {
      email: 'not_an_email',
      password: 'short', // less than 8 chars
      name: '',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: invalidPayload,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.message).toBe('Validation failed');
  });

  it('should login successfully with correct credentials', async () => {
    const loginPayload = {
      email: 'auth_test@gia.ai',
      password: 'secure_password_123',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: loginPayload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.token).toBeDefined();
  });

  it('should fail to login with wrong credentials', async () => {
    const wrongPayload = {
      email: 'auth_test@gia.ai',
      password: 'incorrect_password',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: wrongPayload,
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('Invalid email or password');
  });

  it('should allow access to protected route with a valid token', async () => {
    // 1. Get a token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'auth_test@gia.ai',
        password: 'secure_password_123',
      },
    });
    const { token } = JSON.parse(loginRes.body);

    // 2. Access protected endpoint
    const protectedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(protectedRes.statusCode).toBe(200);
    const body = JSON.parse(protectedRes.body);
    expect(body.success).toBe(true);
    expect(body.user.email).toBe('auth_test@gia.ai');
    expect(body.user.id).toBeDefined();
  });

  it('should block access to protected route without a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('should block access to protected route with an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/test/protected',
      headers: {
        authorization: 'Bearer invalid_token_value_xyz',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });
});
