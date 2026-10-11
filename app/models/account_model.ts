import { PoolClient } from 'pg';
import { AccountRow } from '../types/account';

export async function lockAccounts(client: PoolClient, accountIds: number[]) {
  return client.query<AccountRow>(
    `SELECT id,owner_user_id,kind,balance_paise FROM accounts
     WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [accountIds],
  );
}

export async function debit(client: PoolClient, accountId: number, amount: number) {
  await client.query('UPDATE accounts SET balance_paise=balance_paise-$1 WHERE id=$2', [amount, accountId]);
}

export async function credit(client: PoolClient, accountId: number, amount: number) {
  await client.query('UPDATE accounts SET balance_paise=balance_paise+$1 WHERE id=$2', [amount, accountId]);
}
