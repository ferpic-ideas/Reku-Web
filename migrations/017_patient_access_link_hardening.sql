ALTER TABLE patient_appointment_access_links
  ADD COLUMN IF NOT EXISTS exchange_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_exchanges INTEGER NOT NULL DEFAULT 5;

ALTER TABLE patient_appointment_access_links
  DROP CONSTRAINT IF EXISTS patient_appointment_access_links_exchange_count_check;

ALTER TABLE patient_appointment_access_links
  ADD CONSTRAINT patient_appointment_access_links_exchange_count_check
  CHECK (exchange_count >= 0 AND max_exchanges BETWEEN 1 AND 20);

UPDATE patient_appointment_access_links link
SET expires_at = LEAST(
  link.expires_at,
  GREATEST(
    NOW() + INTERVAL '1 day',
    ((appointment.appointment_date + appointment.end_time)
      AT TIME ZONE 'America/Argentina/Buenos_Aires') + INTERVAL '7 days'
  )
)
FROM appointments appointment
WHERE appointment.id = link.appointment_id;
