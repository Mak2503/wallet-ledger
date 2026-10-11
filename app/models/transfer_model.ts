import { PoolClient } from 'pg';
import { IdRow } from '../types/database';

export async function createTransfer(client: PoolClient, amount: number) {
  return client.query<IdRow>(
    `INSERT INTO transfers(type,status,amount_paise) VALUES('peer_transfer','pending',$1) RETURNING id`, [amount],
  );
}

export async function succeedTransfer(client: PoolClient, id: string) {
  await client.query("UPDATE transfers SET status='succeeded' WHERE id=$1", [id]);
}

export async function addTransferEntries(client: PoolClient, transferId: string, sourceId: number, destinationId: number, amount: number) {
  await client.query(
    `INSERT INTO ledger_entries(transfer_id,account_id,direction,amount_paise)
     VALUES($1,$2,'debit',$3),($1,$4,'credit',$3)`,
    [transferId, sourceId, amount, destinationId],
  );
}
