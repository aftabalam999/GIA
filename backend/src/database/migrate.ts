import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './client.js';
import { logger } from '../shared/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Create schema_migrations table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // 2. Read migration files in the migrations folder
    const migrationsDir = path.resolve(__dirname, 'migrations');
    const files = await fs.readdir(migrationsDir);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

    logger.info(`🔍 Found ${sqlFiles.length} migration file(s)`);

    // 3. Get applied migrations
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    // 4. Run unapplied migrations sequentially in transactions
    for (const file of sqlFiles) {
      if (applied.has(file)) {
        logger.debug(`⏭️ Migration ${file} already applied`);
        continue;
      }

      logger.info(`🔄 Applying migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info(`✅ Successfully applied migration: ${file}`);
      } catch (err: any) {
        await client.query('ROLLBACK');
        logger.error({ msg: `❌ Failed to apply migration: ${file}`, err: err.message });
        throw err;
      }
    }
  } catch (err: any) {
    logger.error({ msg: 'Database migrations failed', err: err.message });
    throw err;
  } finally {
    client.release();
  }
}
