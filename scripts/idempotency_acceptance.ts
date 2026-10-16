import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { databaseConfig } from '../src/db_config';

const db = new Pool(databaseConfig());
const api = process.env.API_URL ?? 'http://localhost:8000';

function assertLocalTargets(): void {
  if (process.env.ACCEPTANCE_ALLOW_NONLOCAL === '1') return;
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const dbUrl = process.env.DATABASE_URL;
  const dbHost = dbUrl ? new URL(dbUrl).hostname : (process.env.DB_HOST ?? 'localhost');
  const apiHost = new URL(api).hostname;
  if (!allowedHosts.has(dbHost) || !allowedHosts.has(apiHost)) {
    throw new Error('Acceptance script only runs against localhost; refusing to create test transfers on a remote target.');
  }
}

interface Fixture { userId: number; sourceId: number; destinationId: number; }
interface ApiResponse { status: number; rawBody: string; body: Record<string, unknown>; retryAfter: string | null; }

async function fixture(label: string): Promise<Fixture> {
  const suffix = randomUUID().replaceAll('-', '');
  const user = await db.query<{ id: string }>(
    `INSERT INTO users(name,email,phone,kyc_status) VALUES($1,$2,$3,'verified') RETURNING id`,
    [label, `${suffix}@example.test`, `+1${suffix.slice(0, 10)}`],
  );
  const userId = Number(user.rows[0].id);
  const source = await db.query<{ id: string }>(
    `INSERT INTO accounts(owner_user_id,kind,name,balance_paise) VALUES($1,'wallet','source',10000) RETURNING id`, [userId],
  );
  const destination = await db.query<{ id: string }>(
    `INSERT INTO accounts(owner_user_id,kind,name) VALUES($1,'wallet','destination') RETURNING id`, [userId],
  );
  return { userId, sourceId: Number(source.rows[0].id), destinationId: Number(destination.rows[0].id) };
}

async function post(key: string | undefined, request: Record<string, number>): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const response = await fetch(`${api}/transfers`, { method: 'POST', headers, body: JSON.stringify(request) });
  const rawBody = await response.text();
  return { status: response.status, rawBody, body: JSON.parse(rawBody) as Record<string, unknown>,
    retryAfter: response.headers.get('retry-after') };
}

function bodyFor(f: Fixture, amount: number): Record<string, number> {
  return { user_id: f.userId, source_account_id: f.sourceId,
    destination_account_id: f.destinationId, amount_paise: amount };
}

async function transferCount(accountId: number): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(DISTINCT transfer_id)::int AS count FROM ledger_entries
     WHERE account_id=$1 AND direction='debit'`, [accountId],
  );
  return result.rows[0].count;
}

async function balances(f: Fixture): Promise<[string, string]> {
  const result = await db.query<{ id: string; balance_paise: string }>(
    'SELECT id,balance_paise FROM accounts WHERE id=ANY($1::bigint[]) ORDER BY id', [[f.sourceId, f.destinationId]],
  );
  return [result.rows[0].balance_paise, result.rows[1].balance_paise];
}

async function main(): Promise<void> {
  assertLocalTargets();
  const invalid = await post(undefined, { user_id: 1, source_account_id: 1, destination_account_id: 2, amount_paise: 1 });
  assert.equal(invalid.status, 400, 'missing Idempotency-Key must be rejected');
  const malformed = await post('not-a-uuid', { user_id: 1, source_account_id: 1, destination_account_id: 2, amount_paise: 1 });
  assert.equal(malformed.status, 400, 'non-UUID Idempotency-Key must be rejected');

  const sequential = await fixture('Sequential replay acceptance');
  const sequentialKey = randomUUID();
  const sequentialBody = bodyFor(sequential, 125);
  const sequentialResults: ApiResponse[] = [];
  for (let i = 0; i < 5; i++) {
    sequentialResults.push(await post(i % 2 === 0 ? sequentialKey.toUpperCase() : sequentialKey, sequentialBody));
  }
  for (const result of sequentialResults) {
    assert.equal(result.status, sequentialResults[0].status);
    assert.equal(result.rawBody, sequentialResults[0].rawBody, 'replayed response body must be byte-for-byte identical');
  }
  assert.equal(sequentialResults[0].status, 201);
  assert.equal(await transferCount(sequential.sourceId), 1);
  assert.deepEqual(await balances(sequential), ['9875', '125']);
  console.log('PASS: five sequential identical requests replay one response and create one transfer');

  const parallel = await fixture('Parallel replay acceptance');
  const parallelKey = randomUUID();
  const parallelBody = bodyFor(parallel, 250);
  const parallelResults = await Promise.all(Array.from({ length: 10 }, () => post(parallelKey, parallelBody)));
  const parallelCreated = parallelResults.filter((result) => result.status === 201);
  const parallelBusy = parallelResults.filter((result) => result.status === 409);
  assert.ok(parallelCreated.length >= 1);
  assert.equal(parallelCreated.length + parallelBusy.length, 10);
  for (const result of parallelCreated) assert.equal(result.rawBody, parallelCreated[0].rawBody);
  for (const result of parallelBusy) {
    assert.match(String(result.body.message), /still processing/);
    assert.equal(result.retryAfter, '1');
  }
  assert.equal(await transferCount(parallel.sourceId), 1);
  assert.deepEqual(await balances(parallel), ['9750', '250']);
  console.log('PASS: ten parallel identical requests create one transfer; duplicates replay 201 or return in-flight 409');

  const processing = await fixture('In-flight replay acceptance');
  const processingKey = randomUUID();
  const processingBody = bodyFor(processing, 175);
  const canonical = {
    amount_paise: processingBody.amount_paise,
    destination_account_id: processingBody.destination_account_id,
    source_account_id: processingBody.source_account_id,
    user_id: processingBody.user_id,
  };
  const requestHash = createHash('sha256').update(JSON.stringify(canonical)).digest();
  await db.query(
    `INSERT INTO idempotency_keys
       (user_id,idempotency_key,request_hash,status,processing_token,processing_since)
     VALUES($1,$2,$3,'processing',$4,now())`,
    [processing.userId, processingKey, requestHash, randomUUID()],
  );
  const inFlight = await post(processingKey, processingBody);
  assert.equal(inFlight.status, 409);
  assert.equal(inFlight.retryAfter, '1');
  assert.deepEqual(await balances(processing), ['10000', '0']);
  assert.equal(await transferCount(processing.sourceId), 0);
  console.log('PASS: same-body retry during processing returns 409 without moving money');

  const mismatch = await fixture('Mismatched replay acceptance');
  const mismatchKey = randomUUID();
  const first = await post(mismatchKey, bodyFor(mismatch, 300));
  const differentBody = await post(mismatchKey, bodyFor(mismatch, 301));
  assert.equal(first.status, 201);
  assert.equal(differentBody.status, 422);
  assert.equal(await transferCount(mismatch.sourceId), 1);
  assert.deepEqual(await balances(mismatch), ['9700', '300']);
  console.log('PASS: changing the amount for a used key returns 422 without moving more money');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(() => db.end());
