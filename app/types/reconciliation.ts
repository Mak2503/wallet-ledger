export type ReconciliationCheck =
  | 'global_totals'
  | 'transfer_balance'
  | 'stored_balance'
  | 'wallet_overdraft'
  | 'transfer_without_entries'
  | 'entry_without_transfer';

export interface ReconciliationFinding {
  checkName: ReconciliationCheck;
  subjectId: string;
  expected: string;
  actual: string;
  transferId?: string;
  accountId?: string;
}

export interface ReconciliationRunResult {
  status: 'completed' | 'already_running' | 'failed';
  runId?: string;
  findingCount?: number;
  checkCounts?: Partial<Record<ReconciliationCheck, number>>;
}

export interface NumericRow {
  id: string;
  expected: string;
  actual: string;
}

export interface TotalsRow {
  debit_total: string;
  credit_total: string;
}
