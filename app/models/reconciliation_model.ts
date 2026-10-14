import { PoolClient } from 'pg';
import { NumericRow, TotalsRow } from '../types/reconciliation';

export async function getLedgerTotals(client: PoolClient) {
  return client.query<TotalsRow>(
    `SELECT COALESCE(sum(amount_paise) FILTER (WHERE direction='debit'),0)::text AS debit_total,
            COALESCE(sum(amount_paise) FILTER (WHERE direction='credit'),0)::text AS credit_total
       FROM ledger_entries`,
  );
}

export async function getUnbalancedTransfers(client: PoolClient) {
  return client.query<NumericRow>(
    `SELECT t.id::text AS id,
            COALESCE(sum(e.amount_paise) FILTER (WHERE e.direction='debit'),0)::text AS expected,
            COALESCE(sum(e.amount_paise) FILTER (WHERE e.direction='credit'),0)::text AS actual
       FROM transfers t LEFT JOIN ledger_entries e ON e.transfer_id=t.id
      GROUP BY t.id
     HAVING COALESCE(sum(e.amount_paise) FILTER (WHERE e.direction='debit'),0)
          <> COALESCE(sum(e.amount_paise) FILTER (WHERE e.direction='credit'),0)`,
  );
}

export async function getStoredBalanceMismatches(client: PoolClient) {
  return client.query<NumericRow>(
    `SELECT a.id::text AS id, a.balance_paise::text AS expected,
            COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)::text AS actual
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
      GROUP BY a.id
     HAVING a.balance_paise <> COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)`,
  );
}

export async function getWalletOverdrafts(client: PoolClient) {
  return client.query<NumericRow>(
    `SELECT a.id::text AS id, '0'::text AS expected,
            COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0)::text AS actual
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
      WHERE a.kind='wallet'
      GROUP BY a.id
     HAVING COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount_paise ELSE -e.amount_paise END),0) < 0`,
  );
}

export async function getTransfersWithoutEntries(client: PoolClient) {
  return client.query<{ id: string }>(
    `SELECT t.id::text AS id FROM transfers t
      WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transfer_id=t.id)`,
  );
}

export async function getEntriesWithoutTransfer(client: PoolClient) {
  return client.query<{ id: string }>(
    `SELECT e.id::text AS id FROM ledger_entries e
      WHERE NOT EXISTS (SELECT 1 FROM transfers t WHERE t.id=e.transfer_id)`,
  );
}
