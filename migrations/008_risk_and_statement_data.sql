ALTER TABLE transfers
  ADD COLUMN source_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN destination_account_id BIGINT REFERENCES accounts(id),
  ADD COLUMN note TEXT CHECK (note IS NULL OR char_length(note) <= 500);

INSERT INTO accounts(owner_user_id,kind,name) VALUES
  (NULL,'cash_in','Cash-in clearing'),
  (NULL,'cash_out','Cash-out clearing')
ON CONFLICT DO NOTHING;

CREATE INDEX transfers_source_created_idx ON transfers(source_account_id, created_at DESC, id DESC)
  WHERE source_account_id IS NOT NULL;
CREATE INDEX transfers_destination_created_idx ON transfers(destination_account_id, created_at DESC, id DESC)
  WHERE destination_account_id IS NOT NULL;

CREATE TABLE risk_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  threshold NUMERIC(20,4) NOT NULL CHECK (threshold > 0),
  window_seconds INTEGER CHECK (window_seconds IS NULL OR window_seconds > 0),
  period_seconds INTEGER CHECK (period_seconds IS NULL OR period_seconds > 0),
  action fraud_disposition NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO risk_rules(rule_key,name,threshold,window_seconds,period_seconds,action,description) VALUES
  ('velocity_10m','Velocity',5,600,NULL,'hold','More than 5 outgoing transfers from one wallet in 10 minutes'),
  ('amount_spike_30d','Amount spike',5,NULL,2592000,'hold','Transfer amount is more than 5 times the wallet 30-day average outgoing amount'),
  ('new_payee_large','New payee, large amount',1000000,NULL,NULL,'allow_with_flag','First transfer to this recipient above 1,000,000 paise');

ALTER TABLE fraud_reviews
  ALTER COLUMN fraud_rule_id DROP NOT NULL,
  ADD COLUMN risk_rule_id BIGINT REFERENCES risk_rules(id),
  ADD CONSTRAINT fraud_review_rule_source_ck CHECK (fraud_rule_id IS NOT NULL OR risk_rule_id IS NOT NULL),
  ADD CONSTRAINT fraud_transfer_risk_rule_uq UNIQUE (transfer_id,risk_rule_id);
CREATE INDEX fraud_reviews_risk_rule_idx ON fraud_reviews(risk_rule_id,flagged_at DESC);

CREATE INDEX ledger_account_direction_created_idx
  ON ledger_entries(account_id,direction,created_at DESC,transfer_id);
CREATE INDEX ledger_account_transfer_idx ON ledger_entries(account_id,transfer_id,direction);

CREATE TABLE risk_flags (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fraud_review_id BIGINT NOT NULL UNIQUE REFERENCES fraud_reviews(id),
  transfer_id BIGINT NOT NULL REFERENCES transfers(id),
  label TEXT NOT NULL CHECK (label IN ('likely_ok','review','likely_fraud')),
  explanation TEXT NOT NULL CHECK (char_length(explanation) > 0),
  model_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX risk_flags_transfer_idx ON risk_flags(transfer_id);

CREATE OR REPLACE FUNCTION assert_inserted_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    entry_count BIGINT;
    debit_total NUMERIC;
    credit_total NUMERIC;
    current_status transfer_status;
BEGIN
    SELECT status INTO current_status FROM transfers WHERE id = NEW.id;
    IF current_status = 'held' OR current_status = 'failed' THEN
        RETURN NULL;
    END IF;
    SELECT count(*),
           COALESCE(sum(amount_paise) FILTER (WHERE direction = 'debit'), 0),
           COALESCE(sum(amount_paise) FILTER (WHERE direction = 'credit'), 0)
      INTO entry_count, debit_total, credit_total
      FROM ledger_entries
     WHERE transfer_id = NEW.id;
    IF entry_count < 2 OR debit_total = 0 OR credit_total = 0 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'transfer % must have at least two entries and equal nonzero debit/credit totals', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION assert_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_transfer_id BIGINT;
    current_status transfer_status;
    entry_count BIGINT;
    debit_total NUMERIC;
    credit_total NUMERIC;
BEGIN
    target_transfer_id := COALESCE(NEW.transfer_id, OLD.transfer_id);
    SELECT status INTO current_status FROM transfers WHERE id = target_transfer_id;
    IF current_status = 'held' OR current_status = 'failed' THEN
        RETURN NULL;
    END IF;
    SELECT count(*),
           COALESCE(sum(amount_paise) FILTER (WHERE direction = 'debit'), 0),
           COALESCE(sum(amount_paise) FILTER (WHERE direction = 'credit'), 0)
      INTO entry_count, debit_total, credit_total
      FROM ledger_entries WHERE transfer_id = target_transfer_id;
    IF entry_count < 2 OR debit_total = 0 OR credit_total = 0 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'transfer % must have at least two entries and equal nonzero debit/credit totals', target_transfer_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER transfer_balanced_when_succeeded_ck
AFTER UPDATE ON transfers DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION assert_inserted_transfer_balanced();
