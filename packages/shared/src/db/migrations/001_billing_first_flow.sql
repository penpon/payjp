-- Migration 001: Billing-first flow
-- members.discord_user_id を NULL 許容に変更（歴史的マイグレーション名 billing_first。現仕様の用語は `2weeks-spec.md` §5 / CR-008）
-- members.email に UNIQUE 制約追加（重複防止キー）

-- discord_user_id: NOT NULL → NULL 許容（既存データに影響なし）
ALTER TABLE members ALTER COLUMN discord_user_id DROP NOT NULL;

-- email: UNIQUE 制約追加（ON CONFLICT (email) で upsert するため）
-- 既存データに重複がないことを前提とする
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'members_email_unique'
  ) THEN
    ALTER TABLE members ADD CONSTRAINT members_email_unique UNIQUE (email);
  END IF;
END $$;
