import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';
import { evaluateRiskRules } from '../app/models/risk_model';
import { TransferRequest } from '../app/types/transfer';

async function main() {
  if (process.env.RISK_RULES_ACCEPTANCE !== '1') throw new Error('Set RISK_RULES_ACCEPTANCE=1 to create and clean up temporary risk-rule data.');
  const passwordFile = process.env.ADMIN_DB_PASSWORD_FILE;
  const pool = new Pool(databaseConfig({ user: process.env.ADMIN_DB_USER ?? 'wallet_admin', password: passwordFile ? readFileSync(passwordFile, 'utf8').trim() : process.env.ADMIN_DB_PASSWORD, max: 1 }));
  const client = await pool.connect();
  let userId: string | undefined;
  let accountIds: string[] = [];
  let transferIds: string[] = [];
  try {
    const tag = randomUUID();
    const user = await client.query<{ id: string }>(
      'INSERT INTO users(name,email,phone) VALUES($1,$2,$3) RETURNING id::text',
      ['risk acceptance', `risk-${tag}@example.test`, `+91${Math.floor(1000000000 + Math.random() * 8999999999)}`],
    );
    userId = user.rows[0].id;
    const wallets = await client.query<{ id: string; name: string }>(
      `INSERT INTO accounts(owner_user_id,kind,name) VALUES
        ($1,'wallet','velocity source'),($1,'wallet','spike source'),($1,'wallet','new-payee source'),
        ($1,'wallet','existing recipient'),($1,'wallet','new recipient') RETURNING id::text,name`, [userId],
    );
    const ids = new Map(wallets.rows.map((row) => [row.name, row.id]));
    accountIds = ['velocity source', 'spike source', 'new-payee source', 'existing recipient', 'new recipient'].map((name) => ids.get(name)!);

    await client.query('BEGIN');
    const seed = [
      ...Array.from({ length: 5 }, (_, index) => ({ source: accountIds[0], destination: accountIds[3], amount: 1000, key: `velocity-${index}` })),
      ...Array.from({ length: 2 }, (_, index) => ({ source: accountIds[1], destination: accountIds[3], amount: 100, key: `spike-${index}` })),
      { source: accountIds[2], destination: accountIds[3], amount: 300000, key: 'payee-history' },
    ];
    for (const item of seed) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO transfers(type,status,amount_paise,source_account_id,destination_account_id)
         VALUES('peer_transfer','pending',$1,$2,$3) RETURNING id::text`, [item.amount, item.source, item.destination],
      );
      transferIds.push(inserted.rows[0].id);
      await client.query(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
         VALUES($1,$2,'debit',$3),($1,$4,'credit',$3)`, [inserted.rows[0].id, item.source, item.amount, item.destination],
      );
      await client.query("UPDATE transfers SET status='succeeded' WHERE id=$1", [inserted.rows[0].id]);
    }
    await client.query('COMMIT');

    const evaluate = async (source: string, destination: string, amount: number): Promise<string[]> => {
      const body: TransferRequest = {
        user_id: Number(userId), source_account_id: Number(source), destination_account_id: Number(destination), amount_paise: amount,
      };
      const timings: Array<{ rule: string; elapsedMs: number; fired: boolean }> = [];
      const result = await evaluateRiskRules(client, body, (rule, elapsedMs, fired) => timings.push({ rule, elapsedMs, fired }));
      console.log(`Risk rule timings: ${JSON.stringify(timings.map(({ rule, elapsedMs, fired }) => ({ rule, elapsed_ms: Number(elapsedMs.toFixed(3)), fired })))}`);
      assert.equal(timings.length, 3);
      return result.map((rule) => rule.rule_key).sort();
    };
    assert.deepEqual(await evaluate(accountIds[0], accountIds[3], 1000), ['velocity_10m']);
    assert.deepEqual(await evaluate(accountIds[1], accountIds[3], 501), ['amount_spike_30d']);
    assert.deepEqual(await evaluate(accountIds[2], accountIds[4], 1000001), ['new_payee_large']);
    console.log('PASS: velocity and amount-spike rules hold; a first large payee transfer is flagged and allowed.');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('SET session_replication_role = replica');
    if (transferIds.length) {
      await client.query('DELETE FROM transfer_status_audit_logs WHERE transfer_id=ANY($1::bigint[])', [transferIds]).catch(() => undefined);
      await client.query('DELETE FROM ledger_entries WHERE transfer_id=ANY($1::bigint[])', [transferIds]).catch(() => undefined);
      await client.query('DELETE FROM transfers WHERE id=ANY($1::bigint[])', [transferIds]).catch(() => undefined);
    }
    if (accountIds.length) await client.query('DELETE FROM accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => undefined);
    if (userId) await client.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => undefined);
    await client.query('SET session_replication_role = origin').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
