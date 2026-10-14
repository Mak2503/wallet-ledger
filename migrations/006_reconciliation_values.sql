ALTER TABLE reconciliation_mismatches
  ADD COLUMN expected_value TEXT,
  ADD COLUMN actual_value TEXT;

UPDATE reconciliation_mismatches
   SET expected_value = COALESCE(expected_paise::text, 'unknown'),
       actual_value = COALESCE(actual_paise::text, 'unknown');

ALTER TABLE reconciliation_mismatches
  ALTER COLUMN expected_value SET NOT NULL,
  ALTER COLUMN actual_value SET NOT NULL;
