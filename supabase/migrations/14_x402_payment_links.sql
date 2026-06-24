-- PayLabs x402 payment link metadata.
-- Safe metadata only. Do not store raw signatures, raw x-payment headers,
-- raw Gateway responses, private keys, or secrets.
--
-- entry_payment_settlement_id already exists from migration 11.
-- This migration adds batch resolution columns only.

ALTER TABLE paylabs_discovery_runs
  ADD COLUMN IF NOT EXISTS entry_payment_batch_tx_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entry_payment_batch_explorer_url TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_paylabs_discovery_runs_entry_settlement_id
  ON paylabs_discovery_runs(entry_payment_settlement_id)
  WHERE entry_payment_settlement_id IS NOT NULL;
