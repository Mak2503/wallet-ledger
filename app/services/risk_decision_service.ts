import { PoolClient } from 'pg';
import * as accounts from '../models/account_model';
import * as riskModel from '../models/risk_model';
import * as transferModel from '../models/transfer_model';
import { jsonResult } from '../models/transfer';
import { HttpResult } from '../types/transfer';

export async function decideRiskTransfer(
  client: PoolClient,
  transferId: string,
  action: 'release' | 'reverse',
): Promise<HttpResult> {
  const transferResult = await client.query<{
    id: string; status: string; amount_paise: string; source_account_id: string | null;
    destination_account_id: string | null; note: string | null; type: string;
  }>(
    `SELECT id::text,status::text,amount_paise::text,source_account_id::text,destination_account_id::text,note,type::text
       FROM transfers WHERE id=$1 FOR UPDATE`, [transferId],
  );
  const transfer = transferResult.rows[0];
  if (!transfer) return jsonResult(404, { error: 'transfer not found' });
  const reviews = await client.query<{ id: string }>(
    "SELECT id::text FROM fraud_reviews WHERE transfer_id=$1 AND status='pending' ORDER BY id FOR UPDATE", [transferId],
  );
  if (!reviews.rowCount) return jsonResult(409, { error: 'transfer has no pending risk review' });

  if (action === 'release') {
    if (transfer.status !== 'held' || !transfer.source_account_id || !transfer.destination_account_id) {
      return jsonResult(409, { error: 'only a held transfer can be released' });
    }
    const ids = [Number(transfer.source_account_id), Number(transfer.destination_account_id)].sort((a, b) => a - b);
    const locked = await accounts.lockAccounts(client, ids);
    if (locked.rowCount !== 2) return jsonResult(404, { error: 'transfer account not found' });
    const source = locked.rows.find((row) => Number(row.id) === Number(transfer.source_account_id))!;
    const destination = locked.rows.find((row) => Number(row.id) === Number(transfer.destination_account_id))!;
    if (source.kind !== 'wallet' || destination.kind !== 'wallet') return jsonResult(409, { error: 'transfer accounts are not wallets' });
    if (BigInt(source.balance_paise) < BigInt(transfer.amount_paise)) return jsonResult(409, { error: 'insufficient funds to release held transfer' });
    await accounts.debit(client, Number(transfer.source_account_id), Number(transfer.amount_paise));
    await accounts.credit(client, Number(transfer.destination_account_id), Number(transfer.amount_paise));
    await transferModel.addTransferEntries(client, transfer.id, Number(transfer.source_account_id), Number(transfer.destination_account_id), Number(transfer.amount_paise));
    await transferModel.succeedTransfer(client, transfer.id);
    await client.query("UPDATE fraud_reviews SET status='approved',reviewed_at=now(),review_note='released by admin' WHERE transfer_id=$1 AND status='pending'", [transferId]);
    return jsonResult(200, { transfer_id: transferId, status: 'succeeded', action });
  }

  if (transfer.status === 'held') {
    await client.query("UPDATE transfers SET status='failed' WHERE id=$1", [transferId]);
    await client.query("UPDATE fraud_reviews SET status='rejected',reviewed_at=now(),review_note='held transfer rejected by admin' WHERE transfer_id=$1 AND status='pending'", [transferId]);
    return jsonResult(200, { transfer_id: transferId, status: 'failed', action });
  }
  if (transfer.status !== 'succeeded' || !transfer.source_account_id || !transfer.destination_account_id) {
    return jsonResult(409, { error: 'only a succeeded or held transfer can be reversed' });
  }

  const reversedRequest = {
    amount_paise: Number(transfer.amount_paise),
    source_account_id: Number(transfer.destination_account_id),
    destination_account_id: Number(transfer.source_account_id),
    note: `Reversal of transfer ${transferId}`,
  };
  const ids = [reversedRequest.source_account_id, reversedRequest.destination_account_id].sort((a, b) => a - b);
  const locked = await accounts.lockAccounts(client, ids);
  const source = locked.rows.find((row) => Number(row.id) === reversedRequest.source_account_id);
  const destination = locked.rows.find((row) => Number(row.id) === reversedRequest.destination_account_id);
  if (!source || !destination) return jsonResult(404, { error: 'transfer account not found' });
  if (BigInt(source.balance_paise) < BigInt(reversedRequest.amount_paise)) return jsonResult(409, { error: 'insufficient funds to reverse transfer' });
  const reversalId = (await transferModel.createReversal(client, transferId, reversedRequest)).rows[0].id;
  await accounts.debit(client, reversedRequest.source_account_id, reversedRequest.amount_paise);
  await accounts.credit(client, reversedRequest.destination_account_id, reversedRequest.amount_paise);
  await transferModel.addTransferEntries(client, reversalId, reversedRequest.source_account_id, reversedRequest.destination_account_id, reversedRequest.amount_paise);
  await transferModel.succeedTransfer(client, reversalId);
  await client.query("UPDATE transfers SET status='reversed' WHERE id=$1", [transferId]);
  await client.query("UPDATE fraud_reviews SET status='approved',reviewed_at=now(),review_note='transfer reversed by admin' WHERE transfer_id=$1 AND status='pending'", [transferId]);
  return jsonResult(200, { transfer_id: reversalId, reversal_of_transfer_id: transferId, status: 'succeeded', action });
}

export async function getPendingRiskQueue(client: PoolClient) {
  return riskModel.getRiskQueue(client);
}
