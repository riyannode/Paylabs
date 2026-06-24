-- PayLabs x402 batch visibility links.
-- Safe metadata only. No raw signatures, Gateway responses, or secrets.
--
-- Adds settlement/batch tracking columns to visibility tables.
-- All columns nullable, ADD COLUMN IF NOT EXISTS for idempotency.

-- paylabs_run_events: per-edge settlement/batch metadata
ALTER TABLE paylabs_run_events
  ADD COLUMN IF NOT EXISTS settlement_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS settlement_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS batch_tx_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS batch_explorer_url TEXT DEFAULT NULL;

-- paylabs_service_payment_events: per-edge settlement/batch metadata
ALTER TABLE paylabs_service_payment_events
  ADD COLUMN IF NOT EXISTS settlement_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS settlement_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS batch_tx_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS batch_explorer_url TEXT DEFAULT NULL;

-- paylabs_receipts: last paid edge batch metadata
ALTER TABLE paylabs_receipts
  ADD COLUMN IF NOT EXISTS last_explorer_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_settlement_id TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_settlement_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_batch_tx_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_batch_explorer_url TEXT DEFAULT NULL;

-- Indexes for settlement lookups
CREATE INDEX IF NOT EXISTS idx_paylabs_run_events_settlement_id
  ON paylabs_run_events(settlement_id)
  WHERE settlement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paylabs_service_payment_events_settlement_id
  ON paylabs_service_payment_events(settlement_id)
  WHERE settlement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_paylabs_receipts_last_settlement_id
  ON paylabs_receipts(last_settlement_id)
  WHERE last_settlement_id IS NOT NULL;
