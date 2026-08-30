CREATE TABLE IF NOT EXISTS agreement_api_holds (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  agreement_id BIGINT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  credential_id BIGINT NOT NULL REFERENCES agreement_api_credentials(id) ON DELETE CASCADE,
  service_id BIGINT NOT NULL REFERENCES services(id),
  professional_id BIGINT NOT NULL REFERENCES professionals(id),
  hold_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  consumed_at TIMESTAMPTZ,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_time < end_time),
  CHECK (public_id ~ '^hold_[a-f0-9]{32}$')
);

CREATE INDEX IF NOT EXISTS agreement_api_holds_slot_idx
  ON agreement_api_holds (professional_id, hold_date, start_time, end_time, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS agreement_api_holds_owner_idx
  ON agreement_api_holds (agreement_id, credential_id, created_at DESC);

