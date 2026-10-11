import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { databaseConfig } from '../src/db_config';

const pool = new Pool(databaseConfig());
const app = Fastify({ logger: true });

interface TransferRequest {
  user_id: number;
  source_account_id: number;
  destination_account_id: number;
  amount_paise: number;
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // READ COMMITTED plus the row locks below serializes updates to these accounts.
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/health', async (_request, reply) => {
  await pool.query('SELECT 1');
  return reply.send({ status: 'ok' });
});

app.post<{ Body: TransferRequest; Headers: { 'idempotency-key'?: string } }>('/transfers', async (request, reply) => {
  const body = request.body;
  const key = request.headers['idempotency-key'];
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!key || !uuidPattern.test(key)) {
    return reply.code(400).send({ error: 'Idempotency-Key header must contain a UUID' });
  }
  const normalizedKey = key.toLowerCase();
  if (!Number.isSafeInteger(body?.user_id) || body.user_id <= 0 ||
      !Number.isSafeInteger(body?.source_account_id) || body.source_account_id <= 0 ||
      !Number.isSafeInteger(body?.destination_account_id) || body.destination_account_id <= 0 ||
      !Number.isSafeInteger(body?.amount_paise) || body.amount_paise <= 0) {
    return reply.code(400).send({ error: 'invalid transfer request' });
  }
  if (Object.keys(body).some((field) => !['user_id', 'source_account_id', 'destination_account_id', 'amount_paise'].includes(field))) {
    return reply.code(400).send({ error: 'unexpected transfer request field' });
  }
  if (body.source_account_id === body.destination_account_id) {
    return reply.code(400).send({ error: 'source and destination must differ' });
  }

  const requestBody = {
    amount_paise: body.amount_paise,
    destination_account_id: body.destination_account_id,
    source_account_id: body.source_account_id,
    user_id: body.user_id,
  };
  const requestHash = createHash('sha256').update(JSON.stringify(requestBody)).digest();
  const jsonResult = (statusCode: number, value: Record<string, unknown>) => ({
    statusCode, serializedBody: JSON.stringify(value),
  });
  type HttpResult = ReturnType<typeof jsonResult> & { retryAfter?: boolean };
  const processingResult = (): HttpResult => ({
    ...jsonResult(409, { error: 'request with this Idempotency-Key is still processing; retry shortly' }),
    retryAfter: true,
  });
  type Claim = { id: string; token: string };
  let activeClaim: Claim | null = null;
  const claimToken = randomUUID();

  try {
    // Commit the processing claim separately so concurrent retries can observe
    // it and receive 409 instead of blocking on an uncommitted unique insert.
    const claimOutcome = await withTransaction(async (client): Promise<{ claim?: Claim; result?: HttpResult }> => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO idempotency_keys
           (user_id,idempotency_key,request_hash,status,processing_token,processing_since)
         VALUES($1,$2,$3,'processing',$4,now())
         ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id`,
        [body.user_id, normalizedKey, requestHash, claimToken],
      );
      if (inserted.rowCount) return { claim: { id: inserted.rows[0].id, token: claimToken } };

      const priorResult = await client.query<{
        id: string; request_hash: Buffer; status: string; response_code: number | null;
        response_body: string | null; processing_since: Date | null;
      }>(
        `SELECT id,request_hash,status,response_code,response_body,processing_since
         FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2`,
        [body.user_id, normalizedKey],
      );
      const prior = priorResult.rows[0];
      if (!prior.request_hash.equals(requestHash)) {
        return { result: jsonResult(422, { error: 'Idempotency-Key was already used with a different request' }) };
      }
      if (prior.status === 'completed' && prior.response_code !== null && prior.response_body !== null) {
        return { result: { statusCode: prior.response_code, serializedBody: prior.response_body } };
      }

      // Abandoned claims become recoverable after one minute. The processing
      // token fences off an old worker if it wakes after another request takes over.
      const leaseExpired = prior.processing_since !== null &&
        Date.now() - prior.processing_since.getTime() >= 60_000;
      if (leaseExpired) {
        await client.query("SET LOCAL lock_timeout = '100ms'");
        const reclaimed = await client.query<{ id: string }>(
          `UPDATE idempotency_keys
              SET processing_token=$1,processing_since=now()
            WHERE id=$2 AND status='processing' AND processing_since <= now() - interval '60 seconds'
            RETURNING id`,
          [claimToken, prior.id],
        );
        if (reclaimed.rowCount) return { claim: { id: prior.id, token: claimToken } };
        const current = await client.query<{
          status: string; response_code: number | null; response_body: string | null;
        }>('SELECT status,response_code,response_body FROM idempotency_keys WHERE id=$1', [prior.id]);
        const row = current.rows[0];
        if (row.status === 'completed' && row.response_code !== null && row.response_body !== null) {
          return { result: { statusCode: row.response_code, serializedBody: row.response_body } };
        }
      }
      return { result: processingResult() };
    });

    if (claimOutcome.result) {
      const response = reply.code(claimOutcome.result.statusCode).type('application/json');
      if (claimOutcome.result.retryAfter) response.header('Retry-After', '1');
      return response.send(claimOutcome.result.serializedBody);
    }
    activeClaim = claimOutcome.claim!;

    const result = await withTransaction(async (client): Promise<HttpResult> => {
      // Lock and verify the claim before locking money rows. A reclaimed stale
      // claim cannot let an old worker perform a second transfer.
      const claimRow = await client.query<{ status: string; processing_token: string | null }>(
        `SELECT status,processing_token FROM idempotency_keys WHERE id=$1 FOR UPDATE`, [activeClaim!.id],
      );
      if (claimRow.rows[0]?.status !== 'processing' || claimRow.rows[0]?.processing_token !== activeClaim!.token) {
        const current = await client.query<{ status: string; response_code: number | null; response_body: string | null }>(
          'SELECT status,response_code,response_body FROM idempotency_keys WHERE id=$1', [activeClaim!.id],
        );
        const row = current.rows[0];
        if (row?.status === 'completed' && row.response_code !== null && row.response_body !== null) {
          return { statusCode: row.response_code, serializedBody: row.response_body };
        }
        return processingResult();
      }

      let result: HttpResult;
      let transferId: string | null = null;
      const accountIds = [body.source_account_id, body.destination_account_id].sort((a, b) => a - b);
      const locked = await client.query<{
        id: string; owner_user_id: string | null; kind: string; balance_paise: string;
      }>(
        `SELECT id,owner_user_id,kind,balance_paise FROM accounts
         WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [accountIds],
      );
      if (locked.rowCount !== 2) {
        result = jsonResult(404, { error: 'account not found' });
      } else {
        const accounts = new Map(locked.rows.map((row) => [Number(row.id), row]));
        const source = accounts.get(body.source_account_id)!;
        const destination = accounts.get(body.destination_account_id)!;
        if (Number(source.owner_user_id) !== body.user_id || source.kind !== 'wallet') {
          result = jsonResult(403, { error: 'source wallet does not belong to user' });
        } else if (destination.kind !== 'wallet') {
          result = jsonResult(400, { error: 'destination must be a wallet' });
        } else if (BigInt(source.balance_paise) < BigInt(body.amount_paise)) {
          result = jsonResult(409, { error: 'insufficient funds' });
        } else {
          const transfer = await client.query<{ id: string }>(
            `INSERT INTO transfers(type,status,amount_paise) VALUES('peer_transfer','pending',$1) RETURNING id`,
            [body.amount_paise],
          );
          transferId = transfer.rows[0].id;
          await client.query("SELECT set_config('wallet.actor_user_id',$1,true)", [String(body.user_id)]);
          await client.query("UPDATE transfers SET status='succeeded' WHERE id=$1", [transferId]);
          await client.query('UPDATE accounts SET balance_paise=balance_paise-$1 WHERE id=$2', [body.amount_paise, body.source_account_id]);
          await client.query('UPDATE accounts SET balance_paise=balance_paise+$1 WHERE id=$2', [body.amount_paise, body.destination_account_id]);
          await client.query(
            `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
             VALUES($1,$2,'debit',$3),($1,$4,'credit',$3)`,
            [transferId, body.source_account_id, body.amount_paise, body.destination_account_id],
          );
          result = jsonResult(201, { transfer_id: transferId, status: 'succeeded', amount_paise: body.amount_paise });
        }
      }

      await client.query(
        `UPDATE idempotency_keys
            SET status='completed',response_code=$1,response_body=$2,transfer_id=$3,
                processing_token=NULL,processing_since=NULL
          WHERE id=$4 AND status='processing' AND processing_token=$5`,
        [result.statusCode, result.serializedBody, transferId, activeClaim!.id, activeClaim!.token],
      );
      return result;
    });
    activeClaim = null;
    const response = reply.code(result.statusCode).type('application/json');
    if (result.retryAfter) response.header('Retry-After', '1');
    return response.send(result.serializedBody);
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') {
      return reply.code(409).header('Retry-After', '1')
        .send({ error: 'request with this Idempotency-Key is still processing; retry shortly' });
    }
    request.log.error(error);
    if (activeClaim) {
      try {
        const failedBody = JSON.stringify({ error: 'transfer failed; transaction rolled back' });
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE idempotency_keys
                SET status='completed',response_code=500,response_body=$1,
                    processing_token=NULL,processing_since=NULL
              WHERE id=$2 AND status='processing' AND processing_token=$3`,
            [failedBody, activeClaim!.id, activeClaim!.token],
          );
        });
      } catch (finalizeError) {
        request.log.error(finalizeError, 'could not finalize failed idempotency claim');
      }
    }
    return reply.code(500).type('application/json').send({ error: 'transfer failed; transaction rolled back' });
  }
});
app.addHook('onClose', async () => pool.end());
const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? '0.0.0.0';
app.listen({ host, port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.close().catch((error) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
