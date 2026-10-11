-- Preserve the exact serialized JSON body for replay, rather than relying on
-- JSONB's key reordering during a response round trip.
ALTER TABLE idempotency_keys
    ALTER COLUMN response_body TYPE TEXT USING response_body::text;
