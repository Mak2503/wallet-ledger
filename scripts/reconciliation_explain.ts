import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { databaseConfig } from '../src/db_config';

const checks: Array<{ name: string; sql: string }> = [
  {
    name: 'global debit and credit totals',
    sql: `SELECT sum(amount_paise) FILTER (WHERE direction='debit'),
                 sum(amount_paise) FILTER (WHERE direction='credit') FROM ledger_entries`,
  },
  {
    name: 'per-transfer debit and credit totals',
    sql: `SELECT transfer_id,
                 sum(amount_paise) FILTER (WHERE direction='debit'),
                 sum(amount_paise) FILTER (WHERE direction='credit')
            FROM ledger_entries GROUP BY transfer_id
          HAVING sum(amount_paise) FILTER (WHERE direction='debit')
              <> sum(amount_paise) FILTER (WHERE direction='credit')`,
  },
  {
    name: 'cached balances by account',
    sql: `SELECT a.id,a.balance_paise,
                 COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)
            FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
           GROUP BY a.id HAVING a.balance_paise <>
                 COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)`,
  },
  {
    name: 'computed wallet overdrafts',
    sql: `SELECT a.id,
                 COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)
            FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
           WHERE a.kind='wallet' GROUP BY a.id HAVING
                 COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)<0`,
  },
  {
    name: 'transfers with no entries',
    sql: `SELECT t.id FROM transfers t
           WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transfer_id=t.id)`,
  },
  {
    name: 'entries with no transfer',
    sql: `SELECT e.id FROM ledger_entries e
           WHERE NOT EXISTS (SELECT 1 FROM transfers t WHERE t.id=e.transfer_id)`,
  },
];

async function main() {
  const adminPasswordFile = process.env.ADMIN_DB_PASSWORD_FILE;
  const pool = new Pool(databaseConfig({
    user: process.env.ADMIN_DB_USER ?? 'wallet_admin',
    password: adminPasswordFile ? readFileSync(adminPasswordFile, 'utf8').trim() : process.env.ADMIN_DB_PASSWORD,
    max: 1,
  }));
  const client = await pool.connect();
  let temporaryUserId: string | undefined;
  let temporaryAccountIds: string[] = [];
  let temporaryTransferId: string | undefined;
  let seeded = false;
  try {
    const count = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM ledger_entries');
    if (BigInt(count.rows[0].count) < 1_000_000n) {
      if (process.env.RECONCILIATION_EXPLAIN_SEED !== '1') {
        throw new Error(`Set RECONCILIATION_EXPLAIN_SEED=1 to temporarily seed one million rows; found ${count.rows[0].count}.`);
      }
      const suffix = randomUUID();
      const user = await client.query<{ id: string }>(
        `INSERT INTO users(name,email,phone) VALUES('reconciliation explain',$1,$2) RETURNING id`,
        [`explain-${suffix}@example.test`, `+91${Date.now().toString().slice(-10)}`],
      );
      temporaryUserId = user.rows[0].id;
      const accounts = await client.query<{ id: string }>(
        `INSERT INTO accounts(owner_user_id,kind,name) VALUES
          ($1,'wallet','explain debit'),($1,'wallet','explain credit') RETURNING id`, [temporaryUserId],
      );
      temporaryAccountIds = accounts.rows.map((row) => row.id);
      await client.query('SET session_replication_role = replica');
      seeded = true;
      const transfer = await client.query<{ id: string }>(
        `INSERT INTO transfers(type,status,amount_paise) VALUES('peer_transfer','succeeded',500000) RETURNING id`,
      );
      temporaryTransferId = transfer.rows[0].id;
      await client.query(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
         SELECT $1,CASE WHEN n % 2 = 0 THEN $2::bigint ELSE $3::bigint END,
                CASE WHEN n % 2 = 0 THEN 'debit'::entry_direction ELSE 'credit'::entry_direction END,1
           FROM generate_series(1,1000000) AS rows(n)`,
        [temporaryTransferId, temporaryAccountIds[0], temporaryAccountIds[1]],
      );
      await client.query('SET session_replication_role = origin');
    }
    for (const check of checks) {
      const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${check.sql}`);
      console.log(`\n${check.name}\n${plan.rows.map((row) => row['QUERY PLAN']).join('\n')}`);
    }
  } finally {
    if (seeded || temporaryUserId || temporaryAccountIds.length || temporaryTransferId) {
      await client.query('SET session_replication_role = replica').catch(() => undefined);
      if (temporaryTransferId) {
        await client.query('DELETE FROM ledger_entries WHERE transfer_id=$1', [temporaryTransferId]).catch(() => undefined);
        await client.query('DELETE FROM transfers WHERE id=$1', [temporaryTransferId]).catch(() => undefined);
      }
      if (temporaryAccountIds.length) await client.query('DELETE FROM accounts WHERE id=ANY($1::bigint[])', [temporaryAccountIds]).catch(() => undefined);
      if (temporaryUserId) await client.query('DELETE FROM users WHERE id=$1', [temporaryUserId]).catch(() => undefined);
      await client.query('SET session_replication_role = origin').catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
