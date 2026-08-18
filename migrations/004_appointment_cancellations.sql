ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS refund_id TEXT,
  ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS refund_error TEXT,
  ADD COLUMN IF NOT EXISTS patient_cancellation_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_cancellation_message_id TEXT,
  ADD COLUMN IF NOT EXISTS patient_cancellation_error TEXT;

ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_refund_status_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_refund_status_check CHECK (
    refund_status IN ('not_required', 'pending', 'approved', 'failed')
  );

CREATE INDEX IF NOT EXISTS appointments_refund_pending_idx
  ON appointments (refund_status, updated_at)
  WHERE refund_status IN ('pending', 'failed');
