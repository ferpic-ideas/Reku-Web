ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS payment_return_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS payment_return_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS appointments_payment_return_token_idx
  ON appointments (payment_return_token_hash)
  WHERE payment_return_token_hash IS NOT NULL;
