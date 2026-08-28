CREATE TABLE IF NOT EXISTS professional_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '',
  device_kind TEXT NOT NULL DEFAULT 'desktop'
    CHECK (device_kind IN ('mobile', 'desktop')),
  user_agent TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS professional_push_subscriptions_professional_idx
  ON professional_push_subscriptions (professional_id, active, device_kind);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_push_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_push_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS patient_waiting_professional_push_error TEXT;
