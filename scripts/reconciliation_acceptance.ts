import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:8000';

async function main() {
  if (process.env.RECONCILIATION_ACCEPTANCE !== '1') {
    throw new Error('Set RECONCILIATION_ACCEPTANCE=1 to seed and clean up reconciliation test data.');
  }
  const passwordFile = process.env.ADMIN_DB_PASSWORD_FILE;
  const adminPool = new Pool(databaseConfig({
    user: process.env.ADMIN_DB_USER ?? 'wallet_admin',
    password: passwordFile ? readFileSync(passwordFile, 'utf8').trim() : process.env.ADMIN_DB_PASSWORD,
    max: 1,
  }));
  const client = await adminPool.connect();
  const transferIds: string[] = [];
  let userId: string | undefined;
  let accountIds: string[] = [];
  let cashAccountId: string | undefined;
  let cashAccountOriginalBalance: string | undefined;
  let createdCashAccount = false;
  let reportId: string | undefined;
  try {
    const tag = randomUUID();
    const user = await client.query<{ id: string }>(
      `INSERT INTO users(name,email,phone,kyc_status) VALUES($1,$2,$3,'verified') RETURNING id`,
      ['reconciliation acceptance', `recon-${tag}@example.test`, `+91${Date.now().toString().slice(-10)}`],
    );
    userId = user.rows[0].id;
    const accountNames = ['recon-source-1', 'recon-destination-1', 'recon-source-2', 'recon-destination-2', 'recon-source-main', 'recon-destination-main'];
    const accounts = await client.query<{ id: string; name: string }>(
      `INSERT INTO accounts(owner_user_id,kind,name,balance_paise)
       SELECT $1,'wallet',name,0 FROM unnest($2::text[]) AS names(name) RETURNING id,name`,
      [userId, accountNames],
    );
    const accountIdByName = new Map(accounts.rows.map((row) => [row.name, row.id]));
    accountIds = accountNames.map((name) => accountIdByName.get(name)!);
    let cashAccount = await client.query<{ id: string; balance_paise: string }>(
      "SELECT id,balance_paise::text FROM accounts WHERE kind='cash_in' AND owner_user_id IS NULL",
    );
    if (!cashAccount.rowCount) {
      cashAccount = await client.query<{ id: string; balance_paise: string }>(
        `INSERT INTO accounts(kind,name) VALUES('cash_in','reconciliation acceptance funding') RETURNING id,balance_paise::text`,
      );
      createdCashAccount = true;
    }
    cashAccountId = cashAccount.rows[0].id;
    cashAccountOriginalBalance = cashAccount.rows[0].balance_paise;

    const openers = await client.query<{ id: string }>(
      `WITH ids AS (
         SELECT n,nextval(pg_get_serial_sequence('transfers','id'))::bigint AS id
           FROM generate_series(1,3) AS numbers(n)
       ), inserted AS (
         INSERT INTO transfers(id,type,status,amount_paise) OVERRIDING SYSTEM VALUE
         SELECT id,'top_up','succeeded',1000000 FROM ids RETURNING id
      )
       INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
       SELECT ids.id,$1,'debit'::entry_direction,1000000 FROM ids JOIN inserted USING(id)
       UNION ALL
       SELECT ids.id,($2::bigint[])[ids.n*2-1],'credit'::entry_direction,1000000 FROM ids JOIN inserted USING(id)
       RETURNING transfer_id::text AS id`,
      [cashAccountId, accountIds],
    );
    transferIds.push(...new Set(openers.rows.map((row) => row.id)));

    const seeded = await client.query<{ id: string }>(
      `WITH ids AS (
         SELECT n,nextval(pg_get_serial_sequence('transfers','id'))::bigint AS id
           FROM generate_series(1,10000) AS numbers(n)
       ), inserted AS (
         INSERT INTO transfers(id,type,status,amount_paise) OVERRIDING SYSTEM VALUE
         SELECT id,'peer_transfer','succeeded',100 FROM ids RETURNING id
       ), entries AS (
         SELECT ids.n,ids.id,CASE WHEN ids.n=1 THEN $1::bigint WHEN ids.n=2 THEN $3::bigint ELSE $5::bigint END AS source_id,
                CASE WHEN ids.n=1 THEN $2::bigint WHEN ids.n=2 THEN $4::bigint ELSE $6::bigint END AS destination_id
           FROM ids JOIN inserted USING(id)
       )
       INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
       SELECT id,source_id,'debit'::entry_direction,100 FROM entries
       UNION ALL SELECT id,destination_id,'credit'::entry_direction,100 FROM entries
       RETURNING transfer_id::text AS id`, [accountIds[0], accountIds[1], accountIds[2], accountIds[3], accountIds[4], accountIds[5]],
    );
    transferIds.push(...new Set(seeded.rows.map((row) => row.id)));
    await client.query(
      `UPDATE accounts a SET balance_paise=COALESCE((
         SELECT sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END)
           FROM ledger_entries e WHERE e.account_id=a.id
       ),0) WHERE a.id=ANY($1::bigint[])`, [[...accountIds, cashAccountId]],
    );

    const corruptTransferIds = [...new Set(seeded.rows.map((row) => row.id))];
    const firstTransfer = corruptTransferIds[0];
    const secondTransfer = corruptTransferIds[1];
    await client.query('SET session_replication_role = replica');
    await client.query(
      `UPDATE ledger_entries SET amount_paise=amount_paise+1
        WHERE transfer_id=$1 AND direction='debit'`, [firstTransfer],
    );
    await client.query('DELETE FROM ledger_entries WHERE transfer_id=$1 AND direction=\'credit\'', [secondTransfer]);
    await client.query(
      `UPDATE accounts a SET balance_paise=COALESCE((
         SELECT sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END)
           FROM ledger_entries e WHERE e.account_id=a.id
       ),0) WHERE a.id=$1`, [accountIds[3]],
    );
    await client.query('UPDATE accounts SET balance_paise=balance_paise+50 WHERE id=$1', [accountIds[4]]);
    await client.query('SET session_replication_role = origin');

    const response = await fetch(`${apiUrl}/admin/reconciliation/run`, { method: 'POST' });
    const result = await response.json() as { status: string; runId?: string; findingCount?: number };
    if (result.runId) reportId = result.runId;
    if (!response.ok || result.status !== 'completed' || result.findingCount !== 3 || !result.runId) {
      throw new Error(`Expected a completed run with exactly three findings; received HTTP ${response.status}: ${JSON.stringify(result)}`);
    }
    const saved = await client.query<{ check_name: string; subject_id: string }>(
      `SELECT check_name,subject_id FROM reconciliation_mismatches WHERE report_id=$1 ORDER BY check_name,subject_id`,
      [reportId],
    );
    const checks = saved.rows.map((row) => row.check_name).sort();
    if (checks.join(',') !== ['stored_balance', 'transfer_balance', 'transfer_balance'].sort().join(',')) {
      throw new Error(`Unexpected reconciliation findings: ${JSON.stringify(saved.rows)}`);
    }
    console.log('PASS: 10,000 transfers with two ledger corruptions and one cached-balance corruption produce exactly three findings.');
  } finally {
    await client.query('SET session_replication_role = replica').catch(() => undefined);
    if (reportId) {
      await client.query('DELETE FROM reconciliation_mismatches WHERE report_id=$1', [reportId]).catch(() => undefined);
      await client.query('DELETE FROM reconciliation_reports WHERE id=$1', [reportId]).catch(() => undefined);
    }
    if (transferIds.length) {
      await client.query('DELETE FROM ledger_entries WHERE transfer_id=ANY($1::bigint[])', [transferIds]).catch(() => undefined);
      await client.query('DELETE FROM transfers WHERE id=ANY($1::bigint[])', [transferIds]).catch(() => undefined);
    }
    if (accountIds.length) await client.query('DELETE FROM accounts WHERE id=ANY($1::bigint[])', [accountIds]).catch(() => undefined);
    if (createdCashAccount && cashAccountId) await client.query('DELETE FROM accounts WHERE id=$1', [cashAccountId]).catch(() => undefined);
    else if (cashAccountId && cashAccountOriginalBalance !== undefined) {
      await client.query('UPDATE accounts SET balance_paise=$1 WHERE id=$2', [cashAccountOriginalBalance, cashAccountId]).catch(() => undefined);
    }
    if (userId) await client.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => undefined);
    await client.query('SET session_replication_role = origin').catch(() => undefined);
    client.release();
    await adminPool.end();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
