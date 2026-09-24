ALTER TABLE agreements
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'web' CHECK (access_mode IN ('web', 'api')),
  ADD COLUMN communication_sender TEXT NOT NULL DEFAULT 'reku' CHECK (communication_sender IN ('reku', 'integrator')),
  ADD COLUMN email_verification_required BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE agreements ADD CONSTRAINT agreement_access_policy CHECK (
  (access_mode = 'web' AND communication_sender = 'reku') OR
  (access_mode = 'api' AND NOT email_verification_required)
);

-- Snapshot the booking flow: API reservations do not use Reku's questionnaire.
ALTER TABLE appointments ADD COLUMN consultation_required BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE appointments appointment SET consultation_required = FALSE
WHERE booking_channel = 'agreement_api'
  AND NOT EXISTS (SELECT 1 FROM consultation_bot_usage usage
    WHERE usage.appointment_id = appointment.id
      AND usage.completed_at IS NOT NULL AND usage.report_encrypted IS NOT NULL);
