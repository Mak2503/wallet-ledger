import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

const pool = new Pool(databaseConfig());
let arrivals = 0;
let release!: () => void;
const barrier = new Promise<void>((resolve) => { release = resolve; });
async function waitAtBarrier(): Promise<void> {
  arrivals++;
  if (arrivals === 2) release();
  await barrier;
}

async function main(): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '');
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users(name,email,phone) VALUES('Broken demo',$1,$2) RETURNING id`,
    [`${suffix}@example.test`, `+1${suffix.slice(0, 10)}`],
  );
  const userId = Number(user.rows[0].id);
  const source = await pool.query<{ id: string }>(
    `INSERT INTO accounts(owner_user_id,kind,name,balance_paise) VALUES($1,'wallet','broken source',500) RETURNING id`, [userId],
  );
  const dest = await pool.query<{ id: string }>(
    `INSERT INTO accounts(owner_user_id,kind,name) VALUES($1,'wallet','broken destination') RETURNING id`, [userId],
  );
  const sourceId = Number(source.rows[0].id);
  const destId = Number(dest.rows[0].id);
  await Promise.all([1, 2].map(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const read = await client.query<{ balance_paise: string }>('SELECT balance_paise FROM accounts WHERE id=$1', [sourceId]);
      const balance = Number(read.rows[0].balance_paise);
      if (balance < 400) throw new Error('unexpected initial funds');
      await waitAtBarrier();
      // Vulnerable: both sessions write a balance computed from the same stale read.
      const transfer = await client.query<{ id: string }>(
        `INSERT INTO transfers(type,status,amount_paise) VALUES('peer_transfer','succeeded',400) RETURNING id`,
      );
      const transferId = transfer.rows[0].id;
      await client.query('UPDATE accounts SET balance_paise=$1 WHERE id=$2', [balance - 400, sourceId]);
      await client.query('UPDATE accounts SET balance_paise=balance_paise+400 WHERE id=$1', [destId]);
      await client.query(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
         VALUES($1,$2,'debit',400),($1,$3,'credit',400)`, [transferId, sourceId, destId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }));
  const result = await pool.query<{ balance_paise: string; ledger_debits: string }>(
    `SELECT a.balance_paise,
       (SELECT sum(amount_paise) FROM ledger_entries WHERE account_id=a.id AND direction='debit') AS ledger_debits
     FROM accounts a WHERE a.id=$1`, [sourceId],
  );
  console.log(`cached source balance: ${result.rows[0].balance_paise} paise`);
  console.log(`ledger debits: ${result.rows[0].ledger_debits} paise`);
  console.log('Expected lost update: cache reflects one 400 paise debit (100 left), ledger records both debits (800 total).');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
