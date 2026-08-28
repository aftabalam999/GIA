import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { redis } from '../src/shared/redis.js';
import { SessionService } from '../src/auth/services/session.service.js';
import { AppError } from '../src/shared/errors.js';

describe('GIA Redis Session Store & Revocation Tests', () => {
  const testUserId = '8c226315-bb8a-40a3-bf2e-85a0c71a36ab';
  const testEmail = 'session_tester@gia.ai';
  const testName = 'Session Tester';

  beforeAll(async () => {
    // Ensure Redis is ready
    await redis.ping();
  });

  afterAll(async () => {
    // Clean up test keys
    const keys = await redis.keys('gia:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe('Session Lifecycle', () => {
    it('should create a session record successfully', async () => {
      const session = await SessionService.createSession(testUserId, testEmail, testName);

      expect(session).toBeDefined();
      expect(session.id).toHaveLength(64); // 32 bytes hex
      expect(session.userId).toBe(testUserId);
      expect(session.email).toBe(testEmail);
      expect(session.name).toBe(testName);
      expect(session.createdAt).toBeLessThanOrEqual(Date.now());

      const redisData = await redis.get(`gia:session:${session.id}`);
      expect(redisData).not.toBeNull();
      const record = JSON.parse(redisData!);
      expect(record.userId).toBe(testUserId);
    });

    it('should look up and rotate session (sliding window)', async () => {
      const session = await SessionService.createSession(testUserId, testEmail, testName);
      
      // Delay slightly to test lastActivity change
      await new Promise((res) => setTimeout(res, 50));

      const lookedUp = await SessionService.lookupSession(session.id);
      expect(lookedUp).not.toBeNull();
      expect(lookedUp!.id).toBe(session.id);
      expect(lookedUp!.lastActivity).toBeGreaterThan(session.lastActivity);
      expect(lookedUp!.expiresAt).toBeGreaterThan(session.expiresAt);

      const ttl = await redis.ttl(`gia:session:${session.id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60);
    });

    it('should return null for an invalid/non-existent session', async () => {
      const result = await SessionService.lookupSession('non_existent_session_id');
      expect(result).toBeNull();
    });

    it('should revoke a single session', async () => {
      const session = await SessionService.createSession(testUserId, testEmail, testName);
      
      await SessionService.revokeSession(session.id);

      const lookedUp = await SessionService.lookupSession(session.id);
      expect(lookedUp).toBeNull();

      const exists = await redis.exists(`gia:session:${session.id}`);
      expect(exists).toBe(0);

      // Verify removed from user set
      const isMember = await redis.sismember(`gia:user:sessions:${testUserId}`, session.id);
      expect(isMember).toBe(0);
    });

    it('should revoke all active sessions for a user', async () => {
      const session1 = await SessionService.createSession(testUserId, testEmail, testName);
      const session2 = await SessionService.createSession(testUserId, testEmail, testName);

      const userSessionsBefore = await redis.smembers(`gia:user:sessions:${testUserId}`);
      expect(userSessionsBefore).toContain(session1.id);
      expect(userSessionsBefore).toContain(session2.id);

      await SessionService.revokeAllUserSessions(testUserId);

      const lookedUp1 = await SessionService.lookupSession(session1.id);
      const lookedUp2 = await SessionService.lookupSession(session2.id);
      expect(lookedUp1).toBeNull();
      expect(lookedUp2).toBeNull();

      const userSessionsAfter = await redis.exists(`gia:user:sessions:${testUserId}`);
      expect(userSessionsAfter).toBe(0);
    });
  });

  describe('Adversarial & Fail-safe Scenarios', () => {
    it('should reject an expired session', async () => {
      const session = await SessionService.createSession(testUserId, testEmail, testName);
      
      // Force modify expiresAt in Redis to simulate expired session
      const rawData = await redis.get(`gia:session:${session.id}`);
      const record = JSON.parse(rawData!);
      record.expiresAt = Date.now() - 10000; // 10s in the past
      await redis.set(`gia:session:${session.id}`, JSON.stringify(record));

      const lookedUp = await SessionService.lookupSession(session.id);
      expect(lookedUp).toBeNull(); // Rejected
    });

    it('should distinguish user contexts and prevent cross-user session corruption', async () => {
      const userAId = 'a6d092d6-47b2-4d43-aa9d-29bcbb3f374c';
      const userBId = 'b8d092d6-47b2-4d43-aa9d-29bcbb3f374c';

      const sessionA = await SessionService.createSession(userAId, 'a@gia.ai', 'User A');
      const sessionB = await SessionService.createSession(userBId, 'b@gia.ai', 'User B');

      const sessionsA = await redis.smembers(`gia:user:sessions:${userAId}`);
      const sessionsB = await redis.smembers(`gia:user:sessions:${userBId}`);

      expect(sessionsA).toContain(sessionA.id);
      expect(sessionsA).not.toContain(sessionB.id);
      expect(sessionsB).toContain(sessionB.id);
      expect(sessionsB).not.toContain(sessionA.id);
    });

    it('should throw a 503 error when Redis is unavailable', async () => {
      // Disconnect Redis to simulate connection outage
      await redis.disconnect();

      try {
        await expect(
          SessionService.createSession(testUserId, testEmail, testName)
        ).rejects.toThrowError('Authentication service temporarily unavailable');
      } finally {
        // Reconnect so subsequent tests and runs can continue
        await redis.connect();
      }
    });
  });
});
