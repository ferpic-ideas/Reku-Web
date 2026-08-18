ALTER TABLE professionals
  ADD COLUMN IF NOT EXISTS license_number TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS specialty TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bio TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS professional_id BIGINT REFERENCES professionals(id) ON DELETE SET NULL;

UPDATE users
SET role = 'user',
    professional_id = NULL
WHERE role NOT IN ('user', 'admin', 'professional');

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'professional'));

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_professional_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_professional_role_check CHECK (
    (role = 'professional' AND professional_id IS NOT NULL)
    OR (role <> 'professional' AND professional_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS users_professional_id_key
  ON users (professional_id)
  WHERE professional_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS patients (
  id BIGSERIAL PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email_normalized = lower(trim(email)))
);

CREATE UNIQUE INDEX IF NOT EXISTS patients_email_normalized_key
  ON patients (email_normalized);

INSERT INTO patients
  (first_name, last_name, full_name, email, email_normalized, phone, created_at, updated_at)
SELECT
  source.nombre,
  source.apellido,
  trim(concat_ws(' ', source.nombre, source.apellido)),
  trim(source.email),
  lower(trim(source.email)),
  COALESCE(source.telefono, ''),
  source.created_at,
  NOW()
FROM (
  SELECT DISTINCT ON (lower(trim(email)))
    nombre,
    apellido,
    email,
    telefono,
    created_at
  FROM patient_intakes
  WHERE trim(email) <> ''
    AND position('@' IN email) > 1
  ORDER BY lower(trim(email)), created_at DESC, id DESC
) AS source
ON CONFLICT (email_normalized) DO NOTHING;

INSERT INTO patients
  (full_name, email, email_normalized, phone, created_at, updated_at)
SELECT
  source.patient_name,
  trim(source.patient_email),
  lower(trim(source.patient_email)),
  COALESCE(source.patient_phone, ''),
  source.created_at,
  NOW()
FROM (
  SELECT DISTINCT ON (lower(trim(patient_email)))
    patient_name,
    patient_email,
    patient_phone,
    created_at
  FROM appointments
  WHERE trim(patient_email) <> ''
    AND position('@' IN patient_email) > 1
  ORDER BY lower(trim(patient_email)), created_at DESC, id DESC
) AS source
ON CONFLICT (email_normalized) DO NOTHING;

ALTER TABLE patient_intakes
  ADD COLUMN IF NOT EXISTS patient_id BIGINT REFERENCES patients(id) ON DELETE SET NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_id BIGINT REFERENCES patients(id) ON DELETE SET NULL;

UPDATE patient_intakes intake
SET patient_id = patient.id
FROM patients patient
WHERE intake.patient_id IS NULL
  AND patient.email_normalized = lower(trim(intake.email));

UPDATE appointments appointment
SET patient_id = patient.id
FROM patients patient
WHERE appointment.patient_id IS NULL
  AND patient.email_normalized = lower(trim(appointment.patient_email));

CREATE INDEX IF NOT EXISTS patient_intakes_patient_id_idx
  ON patient_intakes (patient_id);

CREATE INDEX IF NOT EXISTS appointments_patient_id_idx
  ON appointments (patient_id);
