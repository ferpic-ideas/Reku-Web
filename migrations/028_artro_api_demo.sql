-- Demo sessions are separate from patient/professional authentication.
CREATE TABLE artro_demo_sessions (
  token_hash TEXT PRIMARY KEY,
  gate_version TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX artro_demo_sessions_expiry_idx ON artro_demo_sessions (expires_at);
CREATE TABLE artro_demo_objects (
  session_hash TEXT NOT NULL REFERENCES artro_demo_sessions(token_hash) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hold', 'appointment')),
  response_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_hash, object_id)
);
