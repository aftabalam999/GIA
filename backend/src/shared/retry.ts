import { AppError } from './errors.js';
import { logger } from './logger.js';

export interface RetryOptions {
  retries?: number;
  delay?: number; // Initial backoff delay in ms
  timeoutMs?: number; // Timeout per attempt in ms
}

/**
 * Executes an async task with retry logic, exponential backoff, and timeouts.
 * Aborts task execution via AbortSignal if timeout exceeds limits.
 */
export async function withRetryAndTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  let delay = options.delay ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10000; // 10s default

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err: any) {
      clearTimeout(timer);
      
      const isTimeout = err.name === 'AbortError' || err.message?.includes('aborted');
      const errMessage = isTimeout ? `Request timed out after ${timeoutMs}ms` : err.message;
      
      logger.warn({
        msg: `LLM execution attempt failed. Retrying... (${attempt}/${retries})`,
        err: errMessage,
      });

      if (attempt === retries) {
        throw new AppError(
          `LLM execution failed after ${retries} attempts: ${errMessage}`,
          500, // Internal Server Error
          { originalError: err.message }
        );
      }

      await new Promise((res) => setTimeout(res, delay));
      delay *= 2; // Exponential backoff
    }
  }

  throw new AppError('LLM execution failed: Max retry attempts reached', 500);
}
