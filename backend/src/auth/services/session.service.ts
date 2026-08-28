import crypto from 'crypto';
import { redis } from '../../shared/redis.js';
import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import { config } from '../../config/index.js';

export interface SessionRecord {
  id: string;
  userId: string;
  email: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
}

const SESSION_TTL_SECONDS = config.SESSION_TTL_SECONDS;

export class SessionService {
  /**
   * Helper to execute Redis commands, throwing a 503 service unavailable error if Redis is down.
   */
  private static async executeRedis<T>(op: () => Promise<T>): Promise<T> {
    if (redis.status !== 'ready') {
      throw new AppError('Authentication service temporarily unavailable', 503);
    }
    try {
      return await op();
    } catch (err: any) {
      logger.error({ msg: 'Redis command execution failed', err: err.message });
      throw new AppError('Authentication service temporarily unavailable', 503, { originalError: err.message });
    }
  }

  /**
   * Creates a new session record, saves it in Redis under gia:session:<id> and gia:user:sessions:<userId>
   */
  static async createSession(userId: string, email: string, name: string): Promise<SessionRecord> {
    const id = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_SECONDS * 1000;

    const record: SessionRecord = {
      id,
      userId,
      email,
      name,
      createdAt: now,
      lastActivity: now,
      expiresAt,
    };

    await this.executeRedis(async () => {
      const sessionKey = `gia:session:${id}`;
      const userSessionsKey = `gia:user:sessions:${userId}`;

      // Save session JSON with TTL
      await redis.setex(sessionKey, SESSION_TTL_SECONDS, JSON.stringify(record));
      // Add to user active sessions set
      await redis.sadd(userSessionsKey, id);
      // Set TTL on user sessions set to match the session TTL
      await redis.expire(userSessionsKey, SESSION_TTL_SECONDS);
    });

    return record;
  }

  /**
   * Looks up the session record from Redis and performs a sliding window rotation by updating lastActivity and extending TTL.
   */
  static async lookupSession(sessionId: string): Promise<SessionRecord | null> {
    if (!sessionId) return null;

    return this.executeRedis(async () => {
      const sessionKey = `gia:session:${sessionId}`;
      const data = await redis.get(sessionKey);

      if (!data) return null;

      const record = JSON.parse(data) as SessionRecord;
      const now = Date.now();

      // Enforce hard expiration check on parsed record
      if (now > record.expiresAt) {
        // Clean up expired session
        await this.revokeSession(sessionId);
        return null;
      }

      // Slide window: update timestamps
      record.lastActivity = now;
      record.expiresAt = now + SESSION_TTL_SECONDS * 1000;

      await redis.setex(sessionKey, SESSION_TTL_SECONDS, JSON.stringify(record));
      return record;
    });
  }

  /**
   * Revokes a single session, removing it from both user sessions index and session storage.
   */
  static async revokeSession(sessionId: string): Promise<void> {
    if (!sessionId) return;

    await this.executeRedis(async () => {
      const sessionKey = `gia:session:${sessionId}`;
      const data = await redis.get(sessionKey);

      if (data) {
        const record = JSON.parse(data) as SessionRecord;
        const userSessionsKey = `gia:user:sessions:${record.userId}`;

        await redis.srem(userSessionsKey, sessionId);
      }

      await redis.del(sessionKey);
    });
  }

  /**
   * Revokes all active sessions for a user (e.g. key compromise, account lock).
   */
  static async revokeAllUserSessions(userId: string): Promise<void> {
    if (!userId) return;

    await this.executeRedis(async () => {
      const userSessionsKey = `gia:user:sessions:${userId}`;
      const sessionIds = await redis.smembers(userSessionsKey);

      if (sessionIds.length > 0) {
        const pipeline = redis.pipeline();
        for (const sessionId of sessionIds) {
          pipeline.del(`gia:session:${sessionId}`);
        }
        pipeline.del(userSessionsKey);
        await pipeline.exec();
      }
    });
  }
}
