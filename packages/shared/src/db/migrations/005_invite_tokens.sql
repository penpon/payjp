-- Signed invite URL: invite_tokens + invite_sessions (existing installs)
CREATE TABLE IF NOT EXISTS invite_tokens (
  id              UUID PRIMARY KEY,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invite_tokens_expires_at_idx ON invite_tokens (expires_at);

CREATE TABLE IF NOT EXISTS invite_sessions (
  invite_session_token_hash TEXT PRIMARY KEY,
  invite_token_id           UUID NOT NULL REFERENCES invite_tokens(id) ON DELETE CASCADE,
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invite_sessions_expires_at_idx ON invite_sessions (expires_at);
CREATE INDEX IF NOT EXISTS invite_sessions_invite_token_id_idx ON invite_sessions (invite_token_id);
