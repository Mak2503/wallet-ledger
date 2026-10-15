import { PoolClient } from 'pg';
import * as walletModel from '../models/wallet_model';
import * as transferModel from '../models/transfer_model';
import * as accounts from '../models/account_model';
import { jsonResult } from '../models/transfer';
import { HttpResult } from '../types/transfer';
import { WalletTransferBody } from '../types/wallet';
import { ReversalTransferRequest } from '../types/transfer';
import { DatabaseError } from '../types/http';

export async function createUser(client: PoolClient, input: { name: string; email: string; phone: string }): Promise<HttpResult> {
  if (!input.name.trim() || !input.email.trim() || !input.phone.trim()) return jsonResult(400, { error: 'name, email and phone are required' });
  try {
    const created = await walletModel.createUser(client, input);
    return jsonResult(201, { user: created.rows[0] });
  } catch (error) {
    if ((error as DatabaseError).code === '23505') return jsonResult(409, { error: 'email or phone already exists' });
    throw error;
  }
}

export async function createWallet(client: PoolClient, userId: number, name: string): Promise<HttpResult> {
  const user = await client.query('SELECT 1 FROM users WHERE id=$1', [userId]);
  if (!user.rowCount) return jsonResult(404, { error: 'user not found' });
  const created = await walletModel.createWallet(client, userId, name);
  return jsonResult(201, { wallet_id: created.rows[0].id, balance_paise: created.rows[0].balance_paise });
}

export async function reverseTransfer(client: PoolClient, transferId: string): Promise<HttpResult> {
  const found = await client.query<{
    id: string; status: string; amount_paise: string; source_account_id: string | null;
    destination_account_id: string | null;
  }>(
    `SELECT id::text,status::text,amount_paise::text,source_account_id::text,destination_account_id::text
       FROM transfers WHERE id=$1 FOR UPDATE`, [transferId],
  );
  const original = found.rows[0];
  if (!original) return jsonResult(404, { error: 'transfer not found' });
  if (original.status !== 'succeeded' || !original.source_account_id || !original.destination_account_id) {
    return jsonResult(409, { error: 'only a succeeded transfer can be reversed' });
  }
  const reversal: ReversalTransferRequest = {
    amount_paise: Number(original.amount_paise),
    source_account_id: Number(original.destination_account_id),
    destination_account_id: Number(original.source_account_id),
    note: `Reversal of transfer ${transferId}`,
  };
  const ids = [reversal.source_account_id, reversal.destination_account_id].sort((a, b) => a - b);
  const locked = await accounts.lockAccounts(client, ids);
  const source = locked.rows.find((row) => Number(row.id) === reversal.source_account_id);
  if (!source) return jsonResult(404, { error: 'transfer account not found' });
  if (source.kind === 'wallet' && BigInt(source.balance_paise) < BigInt(reversal.amount_paise)) {
    return jsonResult(409, { error: 'insufficient funds to reverse transfer' });
  }
  const created = await transferModel.createReversal(client, transferId, reversal);
  await accounts.debit(client, reversal.source_account_id, reversal.amount_paise);
  await accounts.credit(client, reversal.destination_account_id, reversal.amount_paise);
  await transferModel.addTransferEntries(client, created.rows[0].id, reversal.source_account_id, reversal.destination_account_id, reversal.amount_paise);
  await transferModel.succeedTransfer(client, created.rows[0].id);
  await client.query("UPDATE transfers SET status='reversed' WHERE id=$1", [transferId]);
  return jsonResult(201, { transfer_id: created.rows[0].id, reversal_of_transfer_id: transferId, status: 'succeeded' });
}

export async function moveCash(client: PoolClient, input: WalletTransferBody, direction: 'topup' | 'withdraw', type: 'top_up' | 'withdrawal'): Promise<HttpResult> {
  const wallet = (await walletModel.getWalletBalance(client, input.wallet_id)).rows[0];
  if (!wallet || Number(wallet.user_id) !== input.user_id) return jsonResult(404, { error: 'wallet not found for user' });
  const system = (await walletModel.getCashAccount(client, direction === 'topup' ? 'cash_in' : 'cash_out')).rows[0];
  if (!system) return jsonResult(409, { error: `system ${direction} account is not configured` });
  const sourceId = direction === 'topup' ? Number(system.id) : input.wallet_id;
  const destinationId = direction === 'topup' ? input.wallet_id : Number(system.id);
  const locked = await accounts.lockAccounts(client, [sourceId, destinationId].sort((a, b) => a - b));
  const source = locked.rows.find((row) => Number(row.id) === sourceId);
  if (!source) return jsonResult(404, { error: 'transfer account not found' });
  if (direction === 'withdraw' && BigInt(source.balance_paise) < BigInt(input.amount_paise)) return jsonResult(409, { error: 'insufficient funds' });
  const transfer = await transferModel.createAccountTransfer(client, type, input.amount_paise, sourceId, destinationId, input.note);
  await transferModel.succeedTransfer(client, transfer.rows[0].id);
  await accounts.debit(client, sourceId, input.amount_paise);
  await accounts.credit(client, destinationId, input.amount_paise);
  await transferModel.addTransferEntries(client, transfer.rows[0].id, sourceId, destinationId, input.amount_paise);
  return jsonResult(201, { transfer_id: transfer.rows[0].id, status: 'succeeded', amount_paise: input.amount_paise });
}
