-- Wallet ledger schema, PostgreSQL 15+

CREATE TYPE kyc_status AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE account_kind AS ENUM ('wallet', 'cash_in', 'cash_out', 'fee_revenue');
CREATE TYPE transfer_type AS ENUM ('top_up', 'peer_transfer', 'withdrawal', 'fee', 'reversal');
CREATE TYPE transfer_status AS ENUM ('pending', 'held', 'succeeded', 'failed', 'reversed');
CREATE TYPE entry_direction AS ENUM ('debit', 'credit');
CREATE TYPE fraud_disposition AS ENUM ('hold', 'allow_with_flag');
CREATE TYPE fraud_review_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE status_actor_kind AS ENUM ('user', 'system');

CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL UNIQUE,
    kyc_status kyc_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallets and platform accounts share this table so every ledger line has one
-- account FK. owner_user_id is set only for wallet accounts.
CREATE TABLE accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id BIGINT REFERENCES users(id),
    kind account_kind NOT NULL,
    name TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    balance_paise BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT account_owner_kind_ck CHECK (
        (kind = 'wallet' AND owner_user_id IS NOT NULL AND balance_paise >= 0)
        OR (kind <> 'wallet' AND owner_user_id IS NULL)
    )
);
CREATE INDEX accounts_owner_idx ON accounts(owner_user_id, id) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX one_system_account_per_kind_idx ON accounts(kind) WHERE owner_user_id IS NULL;

CREATE TABLE transfers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type transfer_type NOT NULL,
    status transfer_status NOT NULL DEFAULT 'pending',
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reversal_of_transfer_id BIGINT REFERENCES transfers(id),
    CONSTRAINT reversal_type_link_ck CHECK (
        (type = 'reversal' AND reversal_of_transfer_id IS NOT NULL)
        OR (type <> 'reversal' AND reversal_of_transfer_id IS NULL)
    )
);
CREATE INDEX transfers_created_idx ON transfers(created_at DESC, id DESC);
CREATE INDEX transfers_reversal_idx ON transfers(reversal_of_transfer_id) WHERE reversal_of_transfer_id IS NOT NULL;

CREATE TABLE ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers(id),
    account_id BIGINT NOT NULL REFERENCES accounts(id),
    direction entry_direction NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_account_statement_idx ON ledger_entries(account_id, created_at DESC, id DESC);
CREATE INDEX ledger_transfer_idx ON ledger_entries(transfer_id, direction);

-- User-scoped idempotency. request_hash is a canonical request-body digest;
-- response_body stores the original API response for exact retries.
CREATE TABLE idempotency_keys (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL,
    request_hash BYTEA NOT NULL,
    response_body JSONB,
    transfer_id BIGINT REFERENCES transfers(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT idempotency_key_per_user_uq UNIQUE (user_id, idempotency_key),
    CONSTRAINT request_hash_length_ck CHECK (octet_length(request_hash) = 32)
);

CREATE TABLE fraud_rules (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    disposition fraud_disposition NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE fraud_reviews (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers(id),
    fraud_rule_id BIGINT NOT NULL REFERENCES fraud_rules(id),
    status fraud_review_status NOT NULL DEFAULT 'pending',
    flagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by_user_id BIGINT REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    CONSTRAINT fraud_reviewed_fields_ck CHECK (
        (status = 'pending' AND reviewed_at IS NULL)
        OR (status <> 'pending' AND reviewed_at IS NOT NULL)
    ),
    CONSTRAINT fraud_transfer_rule_uq UNIQUE (transfer_id, fraud_rule_id)
);
CREATE INDEX fraud_reviews_pending_idx ON fraud_reviews(flagged_at) WHERE status = 'pending';

CREATE TABLE transfer_status_audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id BIGINT NOT NULL REFERENCES transfers(id),
    old_status transfer_status,
    new_status transfer_status NOT NULL,
    actor_kind status_actor_kind NOT NULL,
    actor_user_id BIGINT REFERENCES users(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_actor_ck CHECK (
        (actor_kind = 'user' AND actor_user_id IS NOT NULL)
        OR (actor_kind = 'system' AND actor_user_id IS NULL)
    )
);
CREATE INDEX transfer_status_audit_transfer_idx ON transfer_status_audit_logs(transfer_id, changed_at DESC, id DESC);

CREATE TABLE reconciliation_reports (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    mismatch_count BIGINT NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0)
);
CREATE TABLE reconciliation_mismatches (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    report_id BIGINT NOT NULL REFERENCES reconciliation_reports(id),
    mismatch_type TEXT NOT NULL CHECK (mismatch_type IN ('unbalanced_transfer', 'balance_mismatch')),
    transfer_id BIGINT REFERENCES transfers(id),
    account_id BIGINT REFERENCES accounts(id),
    expected_paise BIGINT,
    actual_paise BIGINT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mismatch_subject_ck CHECK (
        (mismatch_type = 'unbalanced_transfer' AND transfer_id IS NOT NULL AND account_id IS NULL)
        OR (mismatch_type = 'balance_mismatch' AND account_id IS NOT NULL)
    )
);
CREATE INDEX reconciliation_mismatches_report_idx ON reconciliation_mismatches(report_id, id);

-- Ledger history is append-only. Separate privilege grants should also deny
-- UPDATE/DELETE to the application role; this trigger protects against mistakes.
CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries are append-only';
END;
$$;
CREATE TRIGGER ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Validate the final state at transaction commit, after all ledger lines have
-- been inserted. Each transfer must have >=2 lines and equal debit/credit sums.
CREATE FUNCTION assert_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_transfer_id BIGINT;
    entry_count BIGINT;
    debit_total NUMERIC;
    credit_total NUMERIC;
BEGIN
    target_transfer_id := COALESCE(NEW.transfer_id, OLD.transfer_id);
    SELECT count(*),
           COALESCE(sum(amount_paise) FILTER (WHERE direction = 'debit'), 0),
           COALESCE(sum(amount_paise) FILTER (WHERE direction = 'credit'), 0)
      INTO entry_count, debit_total, credit_total
      FROM ledger_entries
     WHERE transfer_id = target_transfer_id;
    IF entry_count < 2 OR debit_total = 0 OR credit_total = 0 OR debit_total <> credit_total THEN
        RAISE EXCEPTION 'transfer % must have at least two entries and equal nonzero debit/credit totals', target_transfer_id;
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transfer_balanced_ck
AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transfer_balanced();

CREATE FUNCTION assert_inserted_transfer_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    entry_count BIGINT;
    debit_total NUMERIC;
    credit_total NUMERIC;
BEGIN
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
CREATE CONSTRAINT TRIGGER transfer_has_balanced_ledger_ck
AFTER INSERT ON transfers DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_inserted_transfer_balanced();

-- Status changes automatically produce an audit record. The application sets
-- wallet.actor_user_id for user-initiated transitions; absent means system.
CREATE FUNCTION audit_transfer_status_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    actor_id BIGINT;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        actor_id := NULLIF(current_setting('wallet.actor_user_id', true), '')::BIGINT;
        INSERT INTO transfer_status_audit_logs
            (transfer_id, old_status, new_status, actor_kind, actor_user_id)
        VALUES
            (NEW.id, OLD.status, NEW.status,
             CASE WHEN actor_id IS NULL THEN 'system'::status_actor_kind ELSE 'user'::status_actor_kind END,
             actor_id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER transfers_status_audit
AFTER UPDATE OF status ON transfers
FOR EACH ROW EXECUTE FUNCTION audit_transfer_status_change();
