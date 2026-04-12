-- Persist selected PAY.JP plan id while subscribe operation is inflight (recovery / idempotency).
ALTER TABLE members ADD COLUMN IF NOT EXISTS inflight_subscribe_plan_id TEXT;
