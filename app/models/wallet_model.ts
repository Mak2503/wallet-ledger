import { PoolClient } from 'pg';
import { UserCreateBody, WalletBalanceRow, WalletStatementRow } from '../types/wallet';

export async function createUser(client: PoolClient, input: UserCreateBody) {
  return client.query<{ id: string; name: string; email: string; phone: string }>(
    `INSERT INTO users(name,email,phone) VALUES($1,$2,$3)
     RETURNING id::text,name,email,phone`, [input.name, input.email.toLowerCase(), input.phone],
  );
}

export async function createWallet(client: PoolClient, userId: number, name: string) {
  return client.query<{ id: string; balance_paise: string }>(
    `INSERT INTO accounts(owner_user_id,kind,name) VALUES($1,'wallet',$2)
     RETURNING id::text,balance_paise::text`, [userId, name],
  );
}

export async function getWalletBalance(client: PoolClient, walletId: number) {
  return client.query<WalletBalanceRow>(
    `SELECT id::text AS wallet_id,owner_user_id::text AS user_id,balance_paise::text
       FROM accounts WHERE id=$1 AND kind='wallet'`, [walletId],
  );
}

export async function getStatementPage(
  client: PoolClient,
  walletId: number,
  limit: number,
  offset: number,
  cursor?: { created_at: string; id: string },
) {
  return client.query<WalletStatementRow>(
    `SELECT e.id::text,e.transfer_id::text,e.direction::text,e.amount_paise::text,e.created_at::text AS created_at,
            t.type::text AS transfer_type,t.status::text AS transfer_status,t.note
       FROM accounts a JOIN ledger_entries e ON e.account_id=a.id
       JOIN transfers t ON t.id=e.transfer_id
      WHERE a.id=$1 AND a.kind='wallet'
        AND ($4::timestamptz IS NULL OR (e.created_at,e.id)<($4::timestamptz,$5::bigint))
      ORDER BY e.created_at DESC,e.id DESC LIMIT $2 OFFSET $3`,
    [walletId, limit + 1, cursor ? 0 : offset, cursor?.created_at ?? null, cursor?.id ?? null],
  );
}

export async function getCashAccount(client: PoolClient, kind: 'cash_in' | 'cash_out') {
  return client.query<{ id: string }>(
    `SELECT id::text FROM accounts WHERE kind=$1 AND owner_user_id IS NULL`, [kind],
  );
}
