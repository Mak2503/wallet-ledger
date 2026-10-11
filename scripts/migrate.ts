import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

const pool = new Pool(databaseConfig({ max: 1 }));
const migrationsDirectory = join(process.cwd(), 'migrations');

async function main(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const migrations = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of migrations) {
    const alreadyApplied = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (alreadyApplied.rowCount) continue;
    const sql = await readFile(join(migrationsDirectory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  console.log('Database migrations are up to date.');
}

main().catch((error: unknown) => { console.error('Migration failed:', error); process.exitCode = 1; }).finally(() => pool.end());
