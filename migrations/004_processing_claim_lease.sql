-- The key claim must commit before transfer work so duplicates can observe the
-- in-flight state. The token fences a slow owner if a stale claim is recovered.
ALTER TABLE idempotency_keys
    ADD COLUMN processing_token UUID,
    ADD COLUMN processing_since TIMESTAMPTZ;

UPDATE idempotency_keys
   SET processing_token = md5(id::text || random()::text || clock_timestamp()::text)::uuid,
       processing_since = created_at
 WHERE status = 'processing';

ALTER TABLE idempotency_keys
    ADD CONSTRAINT idempotency_processing_claim_ck CHECK (
        (status = 'processing' AND processing_token IS NOT NULL AND processing_since IS NOT NULL)
        OR
        (status = 'completed' AND processing_token IS NULL AND processing_since IS NULL)
    );

CREATE INDEX idempotency_processing_since_idx
    ON idempotency_keys(processing_since)
    WHERE status = 'processing';
