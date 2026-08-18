ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pending_payment_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_payment_notification_message_id TEXT,
  ADD COLUMN IF NOT EXISTS pending_payment_notification_error TEXT,
  ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS patient_appointment_access_links (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS patient_appointment_access_links_lookup_idx
  ON patient_appointment_access_links (appointment_id, expires_at);

CREATE TABLE IF NOT EXISTS patient_appointment_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  access_link_id BIGINT NOT NULL REFERENCES patient_appointment_access_links(id) ON DELETE CASCADE,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS patient_appointment_sessions_lookup_idx
  ON patient_appointment_sessions (appointment_id, expires_at);
