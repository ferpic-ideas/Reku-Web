CREATE TABLE IF NOT EXISTS google_oauth_states (
  id BIGSERIAL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  code_verifier_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_oauth_states_expiry_idx
  ON google_oauth_states (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS professional_google_connections (
  professional_id BIGINT PRIMARY KEY REFERENCES professionals(id) ON DELETE CASCADE,
  google_subject TEXT NOT NULL DEFAULT '',
  google_email TEXT NOT NULL DEFAULT '',
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  access_token_encrypted TEXT NOT NULL DEFAULT '',
  refresh_token_encrypted TEXT NOT NULL DEFAULT '',
  token_expires_at TIMESTAMPTZ,
  granted_scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT NOT NULL DEFAULT '',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT professional_google_connections_status_check
    CHECK (status IN ('active', 'error', 'revoked'))
);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS google_calendar_event_id TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_event_url TEXT,
  ADD COLUMN IF NOT EXISTS google_meet_url TEXT,
  ADD COLUMN IF NOT EXISTS google_sync_status TEXT NOT NULL DEFAULT 'not_connected',
  ADD COLUMN IF NOT EXISTS google_sync_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS google_synced_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_google_sync_status_check'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_google_sync_status_check
      CHECK (google_sync_status IN ('not_connected', 'pending', 'synced', 'failed', 'cancelled'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_google_event_id_idx
  ON appointments (google_calendar_event_id)
  WHERE google_calendar_event_id IS NOT NULL;
