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
ON CONFLICT (email_normalized) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  full_name = EXCLUDED.full_name,
  email = EXCLUDED.email,
  phone = EXCLUDED.phone,
  active = TRUE,
  updated_at = NOW();

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

UPDATE patient_intakes intake
SET patient_id = patient.id,
    updated_at = NOW()
FROM patients patient
WHERE patient.email_normalized = lower(trim(intake.email))
  AND intake.patient_id IS DISTINCT FROM patient.id;

UPDATE appointments appointment
SET patient_id = patient.id,
    updated_at = NOW()
FROM patients patient
WHERE patient.email_normalized = lower(trim(appointment.patient_email))
  AND appointment.patient_id IS DISTINCT FROM patient.id;
