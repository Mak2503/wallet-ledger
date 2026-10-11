-- Persist the complete HTTP result so a retry replays both successful and
-- deterministic business-error responses. Existing successful keys returned 200.
ALTER TABLE idempotency_keys
    ADD COLUMN status TEXT NOT NULL DEFAULT 'processing',
    ADD COLUMN response_code INTEGER;

UPDATE idempotency_keys
   SET status = 'completed', response_code = 200
 WHERE response_body IS NOT NULL;

ALTER TABLE idempotency_keys
    ADD CONSTRAINT idempotency_status_ck CHECK (status IN ('processing', 'completed')),
    ADD CONSTRAINT idempotency_response_ck CHECK (
        (status = 'processing' AND response_code IS NULL AND response_body IS NULL)
        OR
        (status = 'completed' AND response_code BETWEEN 100 AND 599 AND response_body IS NOT NULL)
    );
