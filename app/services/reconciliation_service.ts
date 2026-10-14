import { PoolClient } from 'pg';
import { pool } from '../database';
import * as reconciliationModel from '../models/reconciliation_model';
import { NumericRow, ReconciliationCheck, ReconciliationFinding, ReconciliationRunResult } from '../types/reconciliation';
import { DatabaseError } from '../types/http';

const JOB_NAME = 'nightly_reconciliation';

function addNumericFindings(
  findings: ReconciliationFinding[], checkName: ReconciliationCheck, rows: NumericRow[],
  field: 'transferId' | 'accountId',
) {
  for (const row of rows) findings.push({
    checkName, subjectId: row.id, expected: row.expected, actual: row.actual, [field]: row.id,
  });
}

async function collectFindings(client: PoolClient): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];
  const transferMismatches = (await reconciliationModel.getUnbalancedTransfers(client)).rows;
  addNumericFindings(findings, 'transfer_balance', transferMismatches, 'transferId');

  const totals = (await reconciliationModel.getLedgerTotals(client)).rows[0];
  // Transfer-level findings identify the cause of an aggregate difference, so
  // do not save the same ledger corruption a second time as a global finding.
  if (totals.debit_total !== totals.credit_total && transferMismatches.length === 0) {
    findings.push({ checkName: 'global_totals', subjectId: 'all', expected: totals.debit_total, actual: totals.credit_total });
  }

  const balances = (await reconciliationModel.getStoredBalanceMismatches(client)).rows;
  const badTransferIds = new Set(transferMismatches.map((row) => row.id));
  if (badTransferIds.size) {
    const affectedAccounts = await client.query<{ id: string }>(
      'SELECT DISTINCT account_id::text AS id FROM ledger_entries WHERE transfer_id=ANY($1::bigint[])',
      [[...badTransferIds]],
    );
    const affected = new Set(affectedAccounts.rows.map((row) => row.id));
    addNumericFindings(findings, 'stored_balance', balances.filter((row) => !affected.has(row.id)), 'accountId');
  } else {
    addNumericFindings(findings, 'stored_balance', balances, 'accountId');
  }

  addNumericFindings(findings, 'wallet_overdraft', (await reconciliationModel.getWalletOverdrafts(client)).rows, 'accountId');
  for (const row of (await reconciliationModel.getTransfersWithoutEntries(client)).rows) {
    findings.push({ checkName: 'transfer_without_entries', subjectId: row.id, expected: 'at least 1', actual: '0', transferId: row.id });
  }
  for (const row of (await reconciliationModel.getEntriesWithoutTransfer(client)).rows) {
    findings.push({ checkName: 'entry_without_transfer', subjectId: row.id, expected: 'existing transfer', actual: 'missing' });
  }
  return findings;
}

function countByCheck(findings: ReconciliationFinding[]): Partial<Record<ReconciliationCheck, number>> {
  const counts: Partial<Record<ReconciliationCheck, number>> = {};
  for (const finding of findings) counts[finding.checkName] = (counts[finding.checkName] ?? 0) + 1;
  return counts;
}

async function persistFindings(client: PoolClient, runId: string, findings: ReconciliationFinding[]) {
  for (const finding of findings) {
    await client.query(
      `INSERT INTO reconciliation_mismatches
         (report_id,mismatch_type,check_name,subject_id,transfer_id,account_id,expected_paise,actual_paise,expected_value,actual_value,details)
       VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb)`,
      [runId, finding.checkName, finding.subjectId, finding.transferId ?? null, finding.accountId ?? null,
        /^-?\d+$/.test(finding.expected) ? finding.expected : null,
        /^-?\d+$/.test(finding.actual) ? finding.actual : null, finding.expected, finding.actual],
    );
  }
}

async function recordFailedRun(startedAt: Date) {
  await pool.query(
    `INSERT INTO reconciliation_reports(started_at,completed_at,status,mismatch_count,check_counts)
     VALUES($1,now(),'failed',0,'{}'::jsonb)`, [startedAt],
  );
}

export async function runReconciliation(): Promise<ReconciliationRunResult> {
  const startedAt = new Date();
  const client: PoolClient = await pool.connect();
  let lockBusy = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await client.query('SELECT job_name FROM job_locks WHERE job_name=$1 FOR UPDATE NOWAIT', [JOB_NAME]);
    } catch (error) {
      if ((error as DatabaseError).code === '55P03') {
        lockBusy = true;
      } else {
        throw error;
      }
    }
    if (lockBusy) {
      await client.query('ROLLBACK');
      return { status: 'already_running' };
    }

    const run = await client.query<{ id: string }>(
      `INSERT INTO reconciliation_reports(started_at,status) VALUES($1,'running') RETURNING id`, [startedAt],
    );
    const runId = run.rows[0].id;
    const findings = await collectFindings(client);
    const counts = countByCheck(findings);
    await persistFindings(client, runId, findings);
    await client.query(
      `UPDATE reconciliation_reports
          SET completed_at=now(),status='completed',mismatch_count=$1,check_counts=$2::jsonb
        WHERE id=$3`, [findings.length, JSON.stringify(counts), runId],
    );
    await client.query('COMMIT');
    return { status: 'completed', runId, findingCount: findings.length, checkCounts: counts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    try {
      await recordFailedRun(startedAt);
    } catch (recordError) {
      console.error('Could not save failed reconciliation run', recordError);
    }
    throw error;
  } finally {
    client.release();
  }
}
