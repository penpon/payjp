-- Reusable access-gate browser sessions (__Host-access_gate) after shared passcode verification.
CREATE TABLE IF NOT EXISTS access_gate_sessions (
  access_gate_session_token_hash TEXT PRIMARY KEY,
  expires_at                      TIMESTAMPTZ NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_gate_sessions_expires_at_idx ON access_gate_sessions (expires_at);
