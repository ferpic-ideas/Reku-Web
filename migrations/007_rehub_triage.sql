ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS triage_url TEXT,
  ADD COLUMN IF NOT EXISTS triage_assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_assignment_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_assignment_error TEXT,
  ADD COLUMN IF NOT EXISTS patient_followup_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_followup_notification_message_id TEXT,
  ADD COLUMN IF NOT EXISTS patient_followup_notification_error TEXT;

CREATE INDEX IF NOT EXISTS appointments_triage_pending_idx
  ON appointments (updated_at)
  WHERE status = 'confirmed' AND triage_url IS NULL;

CREATE INDEX IF NOT EXISTS appointments_followup_pending_idx
  ON appointments (appointment_date, start_time)
  WHERE status = 'confirmed' AND patient_followup_notified_at IS NULL;

