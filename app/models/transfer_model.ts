import { PoolClient } from 'pg';
import { IdRow } from '../types/database';
import { ReversalTransferRequest, TransferRequest } from '../types/transfer';

export async function createTransfer(client: PoolClient, request: TransferRequest, status: 'pending' | 'held' | 'succeeded' = 'pending') {
  return client.query<IdRow>(
    `INSERT INTO transfers(type,status,amount_paise,source_account_id,destination_account_id,note)
     VALUES('peer_transfer',$1,$2,$3,$4,$5) RETURNING id`,
    [status, request.amount_paise, request.source_account_id, request.destination_account_id, request.note ?? null],
  );
}

export async function succeedTransfer(client: PoolClient, id: string) {
  await client.query("UPDATE transfers SET status='succeeded' WHERE id=$1", [id]);
}

export async function holdTransfer(client: PoolClient, id: string) {
  await client.query("UPDATE transfers SET status='held' WHERE id=$1", [id]);
}

export async function createAccountTransfer(
  client: PoolClient,
  type: 'top_up' | 'withdrawal',
  amount: number,
  sourceId: number,
  destinationId: number,
  note?: string,
) {
  return client.query<IdRow>(
    `INSERT INTO transfers(type,status,amount_paise,source_account_id,destination_account_id,note)
     VALUES($1,'pending',$2,$3,$4,$5) RETURNING id`, [type, amount, sourceId, destinationId, note ?? null],
  );
}

export async function createReversal(client: PoolClient, originalId: string, request: ReversalTransferRequest) {
  return client.query<IdRow>(
    `INSERT INTO transfers(type,status,amount_paise,source_account_id,destination_account_id,note,reversal_of_transfer_id)
     VALUES('reversal','pending',$1,$2,$3,$4,$5) RETURNING id`,
    [request.amount_paise, request.source_account_id, request.destination_account_id, request.note ?? null, originalId],
  );
}

export async function addTransferEntries(client: PoolClient, transferId: string, sourceId: number, destinationId: number, amount: number) {
  await client.query(
    `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
     VALUES($1,$2,'debit',$3),($1,$4,'credit',$3)`,
    [transferId, sourceId, amount, destinationId],
  );
}

export async function getTransferDetails(client: PoolClient, id: string) {
  return client.query(
    `SELECT to_jsonb(t) AS transfer,
       COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
                   FROM ledger_entries e WHERE e.transfer_id=t.id),'[]'::jsonb) AS entries,
       COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.changed_at,a.id)
                   FROM transfer_status_audit_logs a WHERE a.transfer_id=t.id),'[]'::jsonb) AS status_history
       FROM transfers t WHERE t.id=$1`, [id],
  );
}
