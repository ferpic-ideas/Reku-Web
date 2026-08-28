ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_waiting_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_message_id TEXT,
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_error TEXT,
  ADD COLUMN IF NOT EXISTS patient_waiting_escalation_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_escalated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_escalation_message_id TEXT,
  ADD COLUMN IF NOT EXISTS patient_waiting_escalation_error TEXT;

CREATE INDEX IF NOT EXISTS appointments_patient_waiting_idx
  ON appointments (appointment_date, start_time)
  WHERE status = 'confirmed' AND patient_waiting_started_at IS NOT NULL;
