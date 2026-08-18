ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS triage_reminder_last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_reminder_message_id TEXT,
  ADD COLUMN IF NOT EXISTS triage_reminder_error TEXT,
  ADD COLUMN IF NOT EXISTS triage_reminder_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS appointments_triage_reminder_lookup_idx
  ON appointments (professional_id, appointment_date, triage_reminder_sent_at)
  WHERE status = 'confirmed' AND triage_url IS NOT NULL;
