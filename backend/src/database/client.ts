import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../shared/logger.js';
import { DatabaseError } from '../shared/errors.js';
import { runMigrations } from './migrate.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_SIZE,
});

pool.on('error', (err) => {
  logger.error({ msg: 'Unexpected error on idle pg client', err });
});

export async function query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const res = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug({ msg: 'Database query executed', query: text, duration, rowsCount: res.rowCount });
    return res;
  } catch (err: any) {
    logger.error({ msg: 'Database query failed', query: text, err });
    throw new DatabaseError(`Database query failed: ${err.message}`, err);
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ msg: 'Database connection check failed', err });
    return false;
  }
}

export async function initializeDatabase(retries = 5, delay = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      logger.info('✅ Successfully connected to PostgreSQL database');
      await runMigrations();
      return;
    } catch (err: any) {
      logger.warn({
        msg: `Failed to connect to database. Retrying... (${i + 1}/${retries})`,
        err: err.message,
      });
      if (i === retries - 1) {
        throw new Error('Could not establish database connection after multiple retries.');
      }
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2; // exponential backoff
    }
  }
}
