CREATE TABLE IF NOT EXISTS professional_applications (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL DEFAULT '',
  profesion TEXT NOT NULL,
  telefono TEXT NOT NULL,
  email TEXT NOT NULL,
  ambitos TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  interes_telerehabilitacion TEXT,
  interes_tecnologia TEXT,
  comentario TEXT,
  source_path TEXT,
  email_message_id TEXT,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS professional_applications_created_at_idx
  ON professional_applications (created_at DESC);

CREATE INDEX IF NOT EXISTS professional_applications_email_idx
  ON professional_applications (LOWER(email));
