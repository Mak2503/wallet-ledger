ALTER TABLE reconciliation_reports
  ADD COLUMN check_counts JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE reconciliation_mismatches
  DROP CONSTRAINT mismatch_subject_ck,
  DROP CONSTRAINT reconciliation_mismatches_mismatch_type_check;

ALTER TABLE reconciliation_mismatches
  ADD COLUMN check_name TEXT,
  ADD COLUMN subject_id TEXT;

UPDATE reconciliation_mismatches
   SET check_name = mismatch_type,
       subject_id = COALESCE(transfer_id::text, account_id::text);

ALTER TABLE reconciliation_mismatches
  ALTER COLUMN check_name SET NOT NULL,
  ALTER COLUMN subject_id SET NOT NULL,
  ADD CONSTRAINT reconciliation_mismatch_type_ck CHECK (mismatch_type IN (
    'global_totals', 'transfer_balance', 'stored_balance', 'wallet_overdraft',
    'transfer_without_entries', 'entry_without_transfer', 'balance_mismatch', 'unbalanced_transfer'
  )),
  ADD CONSTRAINT mismatch_subject_ck CHECK (
    (mismatch_type IN ('transfer_balance', 'transfer_without_entries', 'unbalanced_transfer') AND transfer_id IS NOT NULL AND account_id IS NULL)
    OR (mismatch_type IN ('stored_balance', 'wallet_overdraft', 'balance_mismatch') AND account_id IS NOT NULL)
    OR mismatch_type IN ('global_totals', 'entry_without_transfer')
  );

CREATE TABLE reconciliation_job_locks (
  job_name TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO reconciliation_job_locks(job_name) VALUES ('nightly_reconciliation');

CREATE INDEX ledger_entries_direction_idx ON ledger_entries(direction);
