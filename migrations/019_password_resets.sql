CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('admin', 'professional')),
  token_hash TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  requested_ip_hash TEXT NOT NULL CHECK (char_length(requested_ip_hash) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  email_message_id TEXT,
  email_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_pending_idx
  ON password_reset_tokens (user_id, audience, expires_at DESC)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE OR REPLACE FUNCTION revoke_pending_password_resets_on_password_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE password_reset_tokens
  SET revoked_at = NOW(), updated_at = NOW()
  WHERE user_id = NEW.id
    AND used_at IS NULL
    AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_revoke_password_resets_on_password_change ON users;

CREATE TRIGGER users_revoke_password_resets_on_password_change
AFTER UPDATE OF password_hash ON users
FOR EACH ROW
WHEN (OLD.password_hash IS DISTINCT FROM NEW.password_hash)
EXECUTE FUNCTION revoke_pending_password_resets_on_password_change();
