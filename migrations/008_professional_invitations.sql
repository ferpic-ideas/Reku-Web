CREATE TABLE IF NOT EXISTS professional_invitations (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  email_message_id TEXT,
  email_error TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS professional_invitations_professional_pending_idx
  ON professional_invitations (professional_id, expires_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS professional_invitations_user_pending_idx
  ON professional_invitations (user_id, expires_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
