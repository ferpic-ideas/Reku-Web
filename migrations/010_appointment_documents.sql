CREATE TABLE IF NOT EXISTS appointment_documents (
  id BIGSERIAL PRIMARY KEY,
  appointment_id BIGINT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'link')),
  original_name TEXT NOT NULL DEFAULT '',
  storage_path TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  external_url TEXT,
  uploaded_by TEXT NOT NULL DEFAULT 'patient' CHECK (uploaded_by IN ('patient', 'professional', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'file' AND storage_path IS NOT NULL AND external_url IS NULL)
    OR (kind = 'link' AND storage_path IS NULL AND external_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS appointment_documents_appointment_idx
  ON appointment_documents (appointment_id, created_at);
