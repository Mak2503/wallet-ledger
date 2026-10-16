import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

const USER_COUNT = 1_000;
const WALLETS_PER_USER = 2;
const TRANSFER_COUNT = 100_000;
const adminPasswordFile = process.env.ADMIN_DB_PASSWORD_FILE;
const pool = new Pool(databaseConfig({
  user: process.env.ADMIN_DB_USER ?? 'wallet_admin',
  password: adminPasswordFile ? readFileSync(adminPasswordFile, 'utf8').trim() : process.env.ADMIN_DB_PASSWORD,
  max: 1,
}));

async function main() {
  const client = await pool.connect();
  const seedTag = randomUUID();
  try {
    await client.query('BEGIN');
    const users = await client.query<{ id: string }>(
      `INSERT INTO users(name,email,phone,kyc_status)
       SELECT 'Seed User ' || n, 'seed-' || $1 || '-' || n || '@example.test',
              'seed-' || $1 || '-' || n, 'verified'::kyc_status
         FROM generate_series(1,$2::int) AS series(n)
       RETURNING id::text`,
      [seedTag, USER_COUNT],
    );
    const userIds = users.rows.map((row) => row.id);
    const wallets = await client.query<{ id: string; owner_user_id: string }>(
      `INSERT INTO accounts(owner_user_id,kind,name)
       SELECT u.id,'wallet','Seed wallet ' || n
         FROM unnest($1::bigint[]) AS u(id) CROSS JOIN generate_series(1,$2::int) AS series(n)
       RETURNING id::text,owner_user_id::text`,
      [userIds, WALLETS_PER_USER],
    );
    const walletIds = wallets.rows
      .sort((a, b) => BigInt(a.owner_user_id) < BigInt(b.owner_user_id) ? -1 : BigInt(a.owner_user_id) > BigInt(b.owner_user_id) ? 1 : BigInt(a.id) < BigInt(b.id) ? -1 : 1)
      .map((row) => row.id);
    if (userIds.length !== USER_COUNT || walletIds.length !== USER_COUNT * WALLETS_PER_USER) {
      throw new Error(`Seed generated ${userIds.length} users and ${walletIds.length} wallets.`);
    }

    const inserted = await client.query<{ transfer_count: number; ledger_entry_count: number }>(
      `WITH inserted AS (
         INSERT INTO transfers(type,status,amount_paise,source_account_id,destination_account_id)
         SELECT 'peer_transfer','succeeded',100,
                ($1::bigint[])[((n-1) % $3::int)+1],
                ($1::bigint[])[(n % $3::int)+1]
           FROM generate_series(1,$2::int) AS series(n)
         RETURNING id,source_account_id,destination_account_id,amount_paise
       ), ledger_rows AS (
         INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
         SELECT id,source_account_id,'debit'::entry_direction,amount_paise FROM inserted
         UNION ALL
         SELECT id,destination_account_id,'credit'::entry_direction,amount_paise FROM inserted
         RETURNING 1
       )
       SELECT (SELECT count(*)::int FROM inserted) AS transfer_count,
              (SELECT count(*)::int FROM ledger_rows) AS ledger_entry_count`,
      [walletIds, TRANSFER_COUNT, walletIds.length],
    );
    await client.query(
      `UPDATE accounts a SET balance_paise=COALESCE((
         SELECT sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END)
           FROM ledger_entries e WHERE e.account_id=a.id
       ),0) WHERE a.id=ANY($1::bigint[])`, [walletIds],
    );
    const integrity = await client.query<{ negative_wallets: number; cached_balance_mismatches: number }>(
      `SELECT count(*) FILTER (WHERE a.balance_paise < 0)::int AS negative_wallets,
              count(*) FILTER (WHERE a.balance_paise <> COALESCE(ledger.balance,0))::int AS cached_balance_mismatches
         FROM accounts a
         LEFT JOIN LATERAL (
           SELECT sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END) AS balance
             FROM ledger_entries e WHERE e.account_id=a.id
         ) ledger ON true
        WHERE a.id=ANY($1::bigint[])`, [walletIds],
    );
    if (integrity.rows[0].negative_wallets !== 0 || integrity.rows[0].cached_balance_mismatches !== 0) {
      throw new Error(`Seed balance validation failed: ${JSON.stringify(integrity.rows[0])}`);
    }
    const actual = inserted.rows[0];
    if (actual.transfer_count !== TRANSFER_COUNT || actual.ledger_entry_count !== TRANSFER_COUNT * 2) {
      throw new Error(`Seed generated ${actual.transfer_count} transfers and ${actual.ledger_entry_count} ledger entries.`);
    }
    await client.query('COMMIT');
    console.log(`Seed complete: ${userIds.length} users, ${walletIds.length} wallets, ${actual.transfer_count} balanced transfers, ${actual.ledger_entry_count} ledger entries.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error: unknown) => {
  console.error('Demo seed failed:', error);
  process.exitCode = 1;
}).finally(() => pool.end());
