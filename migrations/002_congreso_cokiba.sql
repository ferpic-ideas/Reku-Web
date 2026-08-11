CREATE TABLE IF NOT EXISTS congreso_cokiba_registrations (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  profesion TEXT NOT NULL,
  telefono TEXT NOT NULL,
  email TEXT NOT NULL,
  source_path TEXT,
  email_message_id TEXT,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS congreso_cokiba_registrations_created_at_idx
  ON congreso_cokiba_registrations (created_at DESC);

CREATE INDEX IF NOT EXISTS congreso_cokiba_registrations_email_idx
  ON congreso_cokiba_registrations (lower(email));
