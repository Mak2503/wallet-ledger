import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

if (process.env.RESET_DATABASE !== '1') {
  console.error('Reset not run. Set RESET_DATABASE=1 to confirm that all wallet data should be deleted.');
  process.exit(1);
}
const adminPasswordFile = process.env.ADMIN_DB_PASSWORD_FILE;
if (!adminPasswordFile) {
  console.error('ADMIN_DB_PASSWORD_FILE is required. Reset needs the database administrator, not the restricted API user.');
  process.exit(1);
}
const pool = new Pool(databaseConfig({
  user: process.env.ADMIN_DB_USER ?? 'wallet_admin',
  password: readFileSync(adminPasswordFile, 'utf8').trim(),
  max: 1,
}));

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ database_name: string; database_user: string }>(
      'SELECT current_database() AS database_name, current_user AS database_user',
    );
    console.log(`Resetting wallet data in database "${rows[0].database_name}" as "${rows[0].database_user}".`);
    await client.query(`
      TRUNCATE TABLE
        reconciliation_mismatches, reconciliation_reports, transfer_status_audit_logs,
        fraud_reviews, fraud_rules, idempotency_keys, ledger_entries, transfers, accounts, users
      RESTART IDENTITY CASCADE
    `);
    await client.query('COMMIT');
    console.log('Database data cleared; schema and migration history were preserved.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error: unknown) => { console.error('Database reset failed:', error); process.exitCode = 1; }).finally(() => pool.end());
