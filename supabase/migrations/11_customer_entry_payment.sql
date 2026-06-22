-- Customer Entry Payment columns on paylabs_discovery_runs
-- Adds dedicated columns for the customer x402 entry payment gate.
--
-- Data stored safely:
--   customer_wallet_type, customer_auth_method, entry_payment_status,
--   entry_payment_amount_usdc, entry_payment_tx_hash, entry_payment_explorer_url
--
-- Data NOT stored (by design):
--   raw PAYMENT-SIGNATURE, raw x402 payload, EIP-712 signature,
--   Circle raw Gateway response, userToken, refreshToken, private keys, secrets

ALTER TABLE paylabs_discovery_runs
  ADD COLUMN IF NOT EXISTS customer_wallet_type TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS customer_auth_method TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entry_payment_status TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entry_payment_amount_usdc NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entry_payment_tx_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entry_payment_explorer_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS entry_payment_settlement_id TEXT DEFAULT NULL;

-- Index for querying by entry payment status
CREATE INDEX IF NOT EXISTS idx_discovery_runs_entry_payment_status
  ON paylabs_discovery_runs (entry_payment_status)
  WHERE entry_payment_status IS NOT NULL;

-- Index for querying by customer wallet type
CREATE INDEX IF NOT EXISTS idx_discovery_runs_customer_wallet_type
  ON paylabs_discovery_runs (customer_wallet_type)
  WHERE customer_wallet_type IS NOT NULL;
