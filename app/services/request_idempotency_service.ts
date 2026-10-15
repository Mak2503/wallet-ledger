import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { withTransaction } from '../database';
import { HttpResult } from '../types/transfer';
import { jsonResult } from '../models/transfer';

export async function executeIdempotentRequest(
  scope: string,
  key: string,
  requestBody: unknown,
  operation: (client: PoolClient) => Promise<HttpResult>,
): Promise<HttpResult> {
  const hash = createHash('sha256').update(JSON.stringify(requestBody)).digest();
  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO api_idempotency_keys(scope_key,idempotency_key,request_hash,status)
       VALUES($1,$2,$3,'processing') ON CONFLICT(scope_key,idempotency_key) DO NOTHING RETURNING id`,
      [scope, key, hash],
    );
    if (!inserted.rowCount) {
      const prior = (await client.query<{
        request_hash: Buffer; status: string; response_code: number | null; response_body: string | null;
      }>(
        `SELECT request_hash,status,response_code,response_body FROM api_idempotency_keys
          WHERE scope_key=$1 AND idempotency_key=$2 FOR UPDATE`, [scope, key],
      )).rows[0];
      if (!prior.request_hash.equals(hash)) {
        return jsonResult(422, { error: 'Idempotency-Key was already used with a different request' });
      }
      if (prior.status === 'completed' && prior.response_code !== null && prior.response_body !== null) {
        return { statusCode: prior.response_code, serializedBody: prior.response_body };
      }
      return jsonResult(409, { error: 'request with this Idempotency-Key is still processing; retry shortly' });
    }

    const result = await operation(client);
    await client.query(
      `UPDATE api_idempotency_keys SET status='completed',response_code=$1,response_body=$2,completed_at=now()
        WHERE id=$3`, [result.statusCode, result.serializedBody, inserted.rows[0].id],
    );
    return result;
  });
}

export function validIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
}
