-- Align payjp_events status contract:
-- processing_result(processed/ignored/failed) -> process_status(succeeded/ignored/failed)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'payjp_events'
      AND column_name = 'processing_result'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'payjp_events_processing_result_check'
    ) THEN
      ALTER TABLE payjp_events DROP CONSTRAINT payjp_events_processing_result_check;
    END IF;
    ALTER TABLE payjp_events RENAME COLUMN processing_result TO process_status;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'payjp_events'
      AND column_name = 'process_status'
  ) THEN
    UPDATE payjp_events
       SET process_status = 'succeeded'
     WHERE process_status = 'processed';

    IF EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'payjp_events_process_status_check'
    ) THEN
      ALTER TABLE payjp_events DROP CONSTRAINT payjp_events_process_status_check;
    END IF;

    ALTER TABLE payjp_events
      ADD CONSTRAINT payjp_events_process_status_check
      CHECK (process_status IN ('succeeded', 'ignored', 'failed'));
  END IF;
END $$;
