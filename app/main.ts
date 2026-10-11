import Fastify from 'fastify';
import { createHash } from 'node:crypto';
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
  if (!Number.isSafeInteger(body?.user_id) || body.user_id <= 0 ||
      !Number.isSafeInteger(body?.source_account_id) || body.source_account_id <= 0 ||
      !Number.isSafeInteger(body?.destination_account_id) || body.destination_account_id <= 0 ||
      !Number.isSafeInteger(body?.amount_paise) || body.amount_paise <= 0) {
    return reply.code(400).send({ error: 'invalid transfer request' });
  }
  if (Object.keys(body).some((field) => !['user_id', 'source_account_id', 'destination_account_id', 'amount_paise'].includes(field))) {
    return reply.code(400).send({ error: 'unexpected transfer request field' });
  }
  if (!key || key.length > 200) return reply.code(400).send({ error: 'invalid Idempotency-Key' });
  if (body.source_account_id === body.destination_account_id) {
    return reply.code(400).send({ error: 'source and destination must differ' });
  }
  const digest = createHash('sha256').update(JSON.stringify({
    amount_paise: body.amount_paise,
    destination_account_id: body.destination_account_id,
    source_account_id: body.source_account_id,
    user_id: body.user_id,
  })).digest();

  try {
    const result = await withTransaction(async (client) => {
      const claimed = await client.query<{ id: string }>(
        `INSERT INTO idempotency_keys(user_id,idempotency_key,request_hash)
         VALUES($1,$2,$3) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id`,
        [body.user_id, key, digest],
      );
      if (claimed.rowCount === 0) {
        const prior = await client.query<{ request_hash: Buffer; response_body: unknown }>(
          `SELECT request_hash,response_body FROM idempotency_keys
           WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`, [body.user_id, key],
        );
        if (!prior.rows[0].request_hash.equals(digest)) {
          const error = new Error('idempotency key reused with a different request');
          Object.assign(error, { statusCode: 409 });
          throw error;
        }
        if (prior.rows[0].response_body === null) {
          const error = new Error('request is still processing');
          Object.assign(error, { statusCode: 409 });
          throw error;
        }
        return prior.rows[0].response_body;
      }

      const ids = [body.source_account_id, body.destination_account_id].sort((a, b) => a - b);
      const locked = await client.query<{
        id: string; owner_user_id: string | null; kind: string; balance_paise: string;
      }>(
        `SELECT id,owner_user_id,kind,balance_paise FROM accounts
         WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids],
      );
      if (locked.rowCount !== 2) {
        const error = new Error('account not found'); Object.assign(error, { statusCode: 404 }); throw error;
      }
      const accounts = new Map(locked.rows.map((row) => [Number(row.id), row]));
      const source = accounts.get(body.source_account_id)!;
      const destination = accounts.get(body.destination_account_id)!;
      if (Number(source.owner_user_id) !== body.user_id || source.kind !== 'wallet') {
        const error = new Error('source wallet does not belong to user'); Object.assign(error, { statusCode: 403 }); throw error;
      }
      if (destination.kind !== 'wallet') {
        const error = new Error('destination must be a wallet'); Object.assign(error, { statusCode: 400 }); throw error;
      }
      if (BigInt(source.balance_paise) < BigInt(body.amount_paise)) {
        const error = new Error('insufficient funds'); Object.assign(error, { statusCode: 409 }); throw error;
      }

      const transfer = await client.query<{ id: string }>(
        `INSERT INTO transfers(type,status,amount_paise) VALUES('peer_transfer','pending',$1) RETURNING id`,
        [body.amount_paise],
      );
      const transferId = transfer.rows[0].id;
      await client.query("SELECT set_config('wallet.actor_user_id',$1,true)", [String(body.user_id)]);
      await client.query("UPDATE transfers SET status='succeeded' WHERE id=$1", [transferId]);
      await client.query('UPDATE accounts SET balance_paise=balance_paise-$1 WHERE id=$2', [body.amount_paise, body.source_account_id]);
      await client.query('UPDATE accounts SET balance_paise=balance_paise+$1 WHERE id=$2', [body.amount_paise, body.destination_account_id]);
      await client.query(
        `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
         VALUES($1,$2,'debit',$3),($1,$4,'credit',$3)`,
        [transferId, body.source_account_id, body.amount_paise, body.destination_account_id],
      );
      const response = { transfer_id: transferId, status: 'succeeded', amount_paise: body.amount_paise };
      await client.query('UPDATE idempotency_keys SET transfer_id=$1,response_body=$2 WHERE id=$3',
        [transferId, response, claimed.rows[0].id]);
      return response;
    });
    return reply.code(200).send(result);
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) return reply.code(statusCode).send({ error: (error as Error).message });
    request.log.error(error);
    return reply.code(500).send({ error: 'transfer failed; transaction rolled back' });
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
