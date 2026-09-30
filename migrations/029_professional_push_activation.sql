CREATE TABLE professional_push_activation_links (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  professional_id BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  subscription_hash TEXT,
  revoked_at TIMESTAMPTZ,
  CHECK ((used_at IS NULL) = (subscription_hash IS NULL))
);

CREATE INDEX professional_push_activation_professional_idx
  ON professional_push_activation_links (professional_id);
