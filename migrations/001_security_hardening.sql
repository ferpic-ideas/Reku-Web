ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS patient_intake_verifications (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  patient_intake_id BIGINT NOT NULL REFERENCES patient_intakes(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patient_intake_verifications_patient_idx
  ON patient_intake_verifications (patient_intake_id, expires_at);

CREATE INDEX IF NOT EXISTS patient_intake_verifications_expiry_idx
  ON patient_intake_verifications (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE professional_access_links
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exchanged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS professional_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  access_link_id BIGINT REFERENCES professional_access_links(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS professional_sessions_lookup_idx
  ON professional_sessions (professional_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public_rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  bucket_started_at TIMESTAMPTZ NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key_hash, bucket_started_at)
);

CREATE INDEX IF NOT EXISTS public_rate_limits_expiry_idx
  ON public_rate_limits (bucket_started_at);
