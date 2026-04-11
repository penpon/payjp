-- Migration 002: guilds.join support
-- discord_link_sessions に暗号化済み access_token カラムを追加

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'discord_link_sessions'
      AND column_name = 'discord_access_token_encrypted'
  ) THEN
    ALTER TABLE discord_link_sessions ADD COLUMN discord_access_token_encrypted TEXT;
  END IF;
END $$;
