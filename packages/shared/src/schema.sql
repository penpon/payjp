-- PAY.JP × Discord 連携サービス — PostgreSQL DDL
-- 全5テーブル定義

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table 1: members — 会員・購読状態の正 (billing-service / sync-service 管理)
CREATE TABLE IF NOT EXISTS members (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id                 TEXT UNIQUE,
  email                           TEXT NOT NULL UNIQUE,
  subscription_status             TEXT CHECK (subscription_status IN ('active', 'trial', 'canceled', 'paused', 'deleted')),
  payjp_plan_id                   TEXT,
  payjp_customer_id               TEXT UNIQUE,
  payjp_subscription_id           TEXT UNIQUE,
  payjp_initial_charge_id         TEXT UNIQUE,
  access_end_at                   TIMESTAMPTZ,
  next_billing_at                 TIMESTAMPTZ,
  first_trial_granted_at          TIMESTAMPTZ,
  initial_charge_paid_at          TIMESTAMPTZ,
  cancel_requested_at             TIMESTAMPTZ,
  role_state                      TEXT NOT NULL DEFAULT 'unknown' CHECK (role_state IN ('granted', 'revoked', 'unknown')),
  last_synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_payjp_event_created_at     BIGINT,
  inflight_operation_id           TEXT,
  inflight_operation_type         TEXT CHECK (inflight_operation_type IN ('subscribe', 'cancel')),
  inflight_operation_started_at   TIMESTAMPTZ,
  inflight_subscribe_plan_id      TEXT,
  privacy_consented_at            TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS members_payjp_subscription_id_idx ON members (payjp_subscription_id) WHERE payjp_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS members_subscription_status_idx ON members (subscription_status);

-- Table 2: payjp_events — Webhook受信履歴と処理結果 (sync-service 管理)
CREATE TABLE IF NOT EXISTS payjp_events (
  id                TEXT PRIMARY KEY,   -- payjp_event_id (冪等キー)
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  processing_result TEXT NOT NULL CHECK (processing_result IN ('processed', 'ignored', 'failed')),
  data_metadata_operation_id TEXT,
  member_id         UUID REFERENCES members(id),
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payjp_events_received_at_idx ON payjp_events (received_at);
CREATE INDEX IF NOT EXISTS payjp_events_member_id_idx ON payjp_events (member_id) WHERE member_id IS NOT NULL;

-- Table 3: oauth_states — OAuth state ワンタイム検証 (auth-service 管理)
CREATE TABLE IF NOT EXISTS oauth_states (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash          TEXT NOT NULL UNIQUE,
  oauth_session_hash  TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx ON oauth_states (expires_at);

-- Table 4: discord_link_sessions — 課金前連携セッション (auth-service 発行 / billing-service 消費)
CREATE TABLE IF NOT EXISTS discord_link_sessions (
  id                                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_session_token_hash           TEXT NOT NULL UNIQUE,
  discord_user_id                   TEXT NOT NULL,
  discord_access_token_encrypted    TEXT,
  expires_at                        TIMESTAMPTZ NOT NULL,
  used_at                           TIMESTAMPTZ,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discord_link_sessions_expires_at_idx ON discord_link_sessions (expires_at);

-- Table 5: cancel_form_tokens — Google Form退会の署名付きワンタイムトークン
CREATE TABLE IF NOT EXISTS cancel_form_tokens (
  id              UUID PRIMARY KEY,
  member_id       UUID NOT NULL REFERENCES members(id),
  email           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cancel_form_tokens_member_id_idx ON cancel_form_tokens (member_id);
CREATE INDEX IF NOT EXISTS cancel_form_tokens_expires_at_idx ON cancel_form_tokens (expires_at);

-- Table 6: member_sessions — 課金完了後のセッション管理 (billing-service 発行)
CREATE TABLE IF NOT EXISTS member_sessions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_session_token_hash   TEXT NOT NULL UNIQUE,
  member_id                   UUID NOT NULL REFERENCES members(id),
  expires_at                  TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_sessions_expires_at_idx ON member_sessions (expires_at);
CREATE INDEX IF NOT EXISTS member_sessions_member_id_idx ON member_sessions (member_id);

-- Table 7: member_impact_logs — 会員影響の未解決/解消追跡 (sync-service / resync CLI 管理)
CREATE TABLE IF NOT EXISTS member_impact_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       UUID NOT NULL REFERENCES members(id),
  issue_code      TEXT NOT NULL,
  detail          JSONB,
  operation_id    TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_impact_logs_member_id_idx ON member_impact_logs (member_id);
CREATE INDEX IF NOT EXISTS member_impact_logs_resolved_at_idx ON member_impact_logs (resolved_at) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS member_impact_logs_member_issue_unresolved_idx
  ON member_impact_logs (member_id, issue_code)
  WHERE resolved_at IS NULL;

-- Table 8: invite_tokens — 署名付き招待URLのワンタイム消費（購読成功まで used_at は NULL）
CREATE TABLE IF NOT EXISTS invite_tokens (
  id              UUID PRIMARY KEY,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invite_tokens_expires_at_idx ON invite_tokens (expires_at);

-- Table 9: invite_sessions — 招待受理後の __Host-invite_session 用（DB はハッシュのみ保持）
CREATE TABLE IF NOT EXISTS invite_sessions (
  invite_session_token_hash TEXT PRIMARY KEY,
  invite_token_id           UUID NOT NULL REFERENCES invite_tokens(id) ON DELETE CASCADE,
  expires_at                TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invite_sessions_expires_at_idx ON invite_sessions (expires_at);
CREATE INDEX IF NOT EXISTS invite_sessions_invite_token_id_idx ON invite_sessions (invite_token_id);

-- Table 10: access_gate_sessions — 共有パスコード検証後の __Host-access_gate 用（DB はハッシュのみ保持）
CREATE TABLE IF NOT EXISTS access_gate_sessions (
  access_gate_session_token_hash TEXT PRIMARY KEY,
  expires_at                      TIMESTAMPTZ NOT NULL,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_gate_sessions_expires_at_idx ON access_gate_sessions (expires_at);
