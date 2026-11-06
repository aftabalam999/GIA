import pino from 'pino';
import { config } from '../config/index.js';

const isDevelopment = config.NODE_ENV === 'development';

export const logger = pino({
  level: config.NODE_ENV === 'test' ? 'silent' : (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});
