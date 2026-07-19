-- Durable routing-fee payment claim for public x402 preflight.
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS routing_payment_signature_hash text;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS routing_payment_settlement_id text;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS routing_payment_amount_usdc numeric;

CREATE UNIQUE INDEX IF NOT EXISTS uq_paylabs_public_runs_routing_payment_signature_hash
  ON paylabs_discovery_runs(routing_payment_signature_hash)
  WHERE routing_payment_signature_hash IS NOT NULL;
