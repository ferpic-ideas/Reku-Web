CREATE TABLE IF NOT EXISTS agreement_api_credentials (
  id BIGSERIAL PRIMARY KEY,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Integración principal',
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (char_length(name) BETWEEN 1 AND 80),
  CHECK (char_length(token_prefix) BETWEEN 8 AND 32)
);

CREATE INDEX IF NOT EXISTS agreement_api_credentials_agreement_idx
  ON agreement_api_credentials (agreement_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS agreement_api_idempotency (
  id BIGSERIAL PRIMARY KEY,
  credential_id BIGINT NOT NULL REFERENCES agreement_api_credentials(id) ON DELETE CASCADE,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '45 days',
  completed_at TIMESTAMPTZ,
  UNIQUE (credential_id, idempotency_key),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 128)
);

CREATE INDEX IF NOT EXISTS agreement_api_idempotency_created_idx
  ON agreement_api_idempotency (created_at);

CREATE INDEX IF NOT EXISTS agreement_api_idempotency_expires_idx
  ON agreement_api_idempotency (expires_at);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_channel TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS agreement_api_credential_id BIGINT REFERENCES agreement_api_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agreement_api_external_id TEXT,
  ADD COLUMN IF NOT EXISTS agreement_api_public_id TEXT,
  ADD COLUMN IF NOT EXISTS agreement_api_created_at TIMESTAMPTZ;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_refund_status_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_refund_status_check CHECK (
    refund_status IN ('not_required', 'pending', 'approved', 'failed', 'external_management')
  );

CREATE UNIQUE INDEX IF NOT EXISTS appointments_agreement_api_public_id_key
  ON appointments (agreement_api_public_id)
  WHERE agreement_api_public_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_agreement_api_external_id_key
  ON appointments (agreement_id, agreement_api_external_id)
  WHERE agreement_id IS NOT NULL AND agreement_api_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_agreement_api_month_idx
  ON appointments (agreement_id, appointment_date, status)
  WHERE booking_channel = 'agreement_api';

CREATE TABLE IF NOT EXISTS agreement_settlements (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id),
  period_month DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'finalized')),
  total_appointments INTEGER NOT NULL DEFAULT 0,
  total_cancelled INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  snapshot JSONB NOT NULL,
  generated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  UNIQUE (agreement_id, period_month)
);

CREATE INDEX IF NOT EXISTS agreement_settlements_period_idx
  ON agreement_settlements (period_month DESC, agreement_id);
