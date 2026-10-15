import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

const db = new Pool(databaseConfig());
const api = process.env.API_URL ?? 'http://localhost:8000';

async function main(): Promise<void> {
  const riskRuleStates = await db.query<{ id: string; enabled: boolean }>('SELECT id::text,enabled FROM risk_rules');
  await db.query('UPDATE risk_rules SET enabled=false');
  try {
    for (let trial = 1; trial <= 20; trial++) {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await db.query<{ id: string }>(
      `INSERT INTO users(name,email,phone,kyc_status) VALUES($1,$2,$3,'verified') RETURNING id`,
      [`Stampede ${trial}`, `${suffix}@example.test`, `+1${suffix.slice(0, 10)}`],
    );
    const userId = Number(user.rows[0].id);
    const source = await db.query<{ id: string }>(
      `INSERT INTO accounts(owner_user_id,kind,name,balance_paise) VALUES($1,'wallet','source',50000) RETURNING id`, [userId],
    );
    const destination = await db.query<{ id: string }>(
      `INSERT INTO accounts(owner_user_id,kind,name) VALUES($1,'wallet','destination') RETURNING id`, [userId],
    );
    const sourceId = Number(source.rows[0].id);
    const destinationId = Number(destination.rows[0].id);
    const responses = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
      const response = await fetch(`${api}/transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ user_id: userId, source_account_id: sourceId,
          destination_account_id: destinationId, amount_paise: 1000 }),
      });
      return { status: response.status, body: await response.json() as { transfer_id?: string } };
    }));
    const succeeded = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);
    if (succeeded.length !== 50 || rejected.length !== 50) {
      throw new Error(`run ${trial}: ${succeeded.length} succeeded, ${rejected.length} rejected`);
    }
    const balances = await db.query<{ id: string; balance_paise: string }>(
      'SELECT id,balance_paise FROM accounts WHERE id=ANY($1::bigint[]) ORDER BY id', [[sourceId, destinationId]],
    );
    const ledger = await db.query<{ debits: string; credits: string }>(
      `SELECT sum(amount_paise) FILTER(WHERE direction='debit') AS debits,
              sum(amount_paise) FILTER(WHERE direction='credit') AS credits
       FROM ledger_entries WHERE transfer_id=ANY($1::bigint[])`,
      [succeeded.map((r) => r.body.transfer_id)],
    );
    if (balances.rows[0].balance_paise !== '0' || balances.rows[1].balance_paise !== '50000' ||
        ledger.rows[0].debits !== '50000' || ledger.rows[0].credits !== '50000') {
      throw new Error(`run ${trial}: invalid balances or ledger totals`);
    }
    console.log(`run ${String(trial).padStart(2, '0')}/20: 50 succeeded, 50 rejected, source=0, debits=credits=50000 paise`);
    }
    console.log('PASS: all 20 stampede runs');
  } finally {
    for (const rule of riskRuleStates.rows) await db.query('UPDATE risk_rules SET enabled=$1 WHERE id=$2', [rule.enabled, rule.id]);
  }
}

main().catch((error: unknown) => {
  const pgError = error as { code?: string };
  if (pgError.code === '28000' || pgError.code === '28P01') {
    console.error('PostgreSQL rejected the configured user. Check DATABASE_URL and confirm it uses the wallet_app credentials configured for this Compose database.');
  }
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.end());
