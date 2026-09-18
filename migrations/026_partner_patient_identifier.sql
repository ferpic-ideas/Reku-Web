ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_identifier TEXT NOT NULL DEFAULT '';
