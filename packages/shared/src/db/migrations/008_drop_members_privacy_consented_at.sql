-- Remove unused consent timestamp column (not part of MVP data contract).
ALTER TABLE members
  DROP COLUMN IF EXISTS privacy_consented_at;
