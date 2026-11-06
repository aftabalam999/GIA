import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from './logger.js';

let isConnected = false;

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 100, 2000);
    logger.warn({ msg: `Retrying Redis connection in ${delay}ms...`, attempt: times });
    return delay;
  },
});

redis.on('connect', () => {
  logger.info('🔌 Connecting to Redis server...');
});

redis.on('ready', () => {
  isConnected = true;
  logger.info('✅ Successfully connected to Redis database');
});

redis.on('error', (err: any) => {
  isConnected = false;
  logger.error({ msg: '❌ Redis connection error', err: err.message });
});

redis.on('close', () => {
  isConnected = false;
  logger.warn('🔌 Redis connection closed');
});

export async function checkRedisConnection(): Promise<boolean> {
  if (!isConnected) return false;
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (err: any) {
    logger.error({ msg: 'Redis connection check failed', err: err.message });
    return false;
  }
}

export async function initializeRedis(retries = 5, delay = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await redis.ping();
      logger.info('✅ Redis service is fully operational');
      return;
    } catch (err: any) {
      logger.warn({
        msg: `Failed to ping Redis. Retrying... (${i + 1}/${retries})`,
        err: err.message,
      });
      if (i === retries - 1) {
        throw new Error('Could not establish Redis connection after multiple retries.');
      }
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2;
    }
  }
}
