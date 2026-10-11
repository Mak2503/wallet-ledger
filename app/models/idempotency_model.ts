import { PoolClient } from 'pg';
import { Claim, ExistingKey, LockedClaim, SavedResponse } from '../types/idempotency';
import { IdRow } from '../types/database';

export async function insertClaim(client: PoolClient, userId: number, key: string, hash: Buffer, token: string) {
  return client.query<IdRow>(
    `INSERT INTO idempotency_keys
       (user_id,idempotency_key,request_hash,status,processing_token,processing_since)
     VALUES($1,$2,$3,'processing',$4,now())
     ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id`,
    [userId, key, hash, token],
  );
}

export async function findKey(client: PoolClient, userId: number, key: string) {
  return client.query<ExistingKey>(
    `SELECT id,request_hash,status,response_code,response_body,processing_since
     FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2`, [userId, key],
  );
}

export async function reclaimClaim(client: PoolClient, id: string, token: string) {
  return client.query<IdRow>(
    `UPDATE idempotency_keys SET processing_token=$1,processing_since=now()
     WHERE id=$2 AND status='processing' AND processing_since <= now() - interval '60 seconds'
     RETURNING id`, [token, id],
  );
}

export async function getClaimForUpdate(client: PoolClient, id: string) {
  return client.query<LockedClaim>(
    'SELECT status,processing_token FROM idempotency_keys WHERE id=$1 FOR UPDATE', [id],
  );
}

export async function getSavedResponse(client: PoolClient, id: string) {
  return client.query<SavedResponse>(
    'SELECT status,response_code,response_body FROM idempotency_keys WHERE id=$1', [id],
  );
}

export async function completeClaim(client: PoolClient, id: string, token: string, statusCode: number, body: string, transferId: string | null) {
  await client.query(
    `UPDATE idempotency_keys SET status='completed',response_code=$1,response_body=$2,transfer_id=$3,
       processing_token=NULL,processing_since=NULL
     WHERE id=$4 AND status='processing' AND processing_token=$5`,
    [statusCode, body, transferId, id, token],
  );
}

export async function failClaim(client: PoolClient, id: string, token: string, body: string) {
  await client.query(
    `UPDATE idempotency_keys SET status='completed',response_code=500,response_body=$1,
       processing_token=NULL,processing_since=NULL
     WHERE id=$2 AND status='processing' AND processing_token=$3`, [body, id, token],
  );
}
