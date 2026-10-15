CREATE TABLE api_idempotency_keys (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  status TEXT NOT NULL CHECK (status IN ('processing','completed')),
  response_code INTEGER,
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(scope_key,idempotency_key),
  CHECK (
    (status='processing' AND response_code IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (status='completed' AND response_code BETWEEN 100 AND 599 AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);
