-- Public x402 lifecycle statuses and safer idempotency keys.
ALTER TABLE paylabs_discovery_runs
  DROP CONSTRAINT IF EXISTS paylabs_discovery_runs_status_check;

ALTER TABLE paylabs_discovery_runs
  ADD CONSTRAINT paylabs_discovery_runs_status_check
  CHECK (status IN (
    'created',
    'awaiting_payment',
    'payment_processing',
    'paid',
    'executing',
    'queued',
    'running',
    'completed',
    'failed',
    'timed_out',
    'discovery_only',
    'paid_path_available'
  ));

DROP INDEX IF EXISTS uq_paylabs_public_runs_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paylabs_public_runs_challenge_idempotency
  ON paylabs_discovery_runs(public_api_version, client_request_id, request_hash)
  WHERE client_request_id IS NOT NULL AND public_api_version IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_paylabs_public_runs_paid_idempotency
  ON paylabs_discovery_runs(public_api_version, client_request_id, user_wallet, request_hash)
  WHERE client_request_id IS NOT NULL
    AND public_api_version IS NOT NULL
    AND user_wallet <> '0x0000000000000000000000000000000000000000';
