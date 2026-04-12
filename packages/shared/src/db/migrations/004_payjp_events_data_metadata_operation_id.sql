-- Webhook persistence: store data.metadata.operation_id for PAY.JP operation tracing.
-- Required for INSERTs that reference payjp_events.data_metadata_operation_id; schema.sql
-- only affects new installs (CREATE TABLE IF NOT EXISTS does not alter existing tables).
ALTER TABLE payjp_events ADD COLUMN IF NOT EXISTS data_metadata_operation_id TEXT;
