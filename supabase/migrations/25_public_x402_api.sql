-- Public x402 API additive metadata for PayLabs discovery runs.
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS public_request_id uuid;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS client_request_id text;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS payment_signature_hash text;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS read_token_hash text;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS challenge_expires_at timestamptz;
ALTER TABLE paylabs_discovery_runs ADD COLUMN IF NOT EXISTS public_api_version text;

CREATE INDEX IF NOT EXISTS idx_paylabs_public_runs_request_hash ON paylabs_discovery_runs(request_hash) WHERE request_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paylabs_public_runs_buyer ON paylabs_discovery_runs(user_wallet, created_at DESC) WHERE public_api_version IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paylabs_public_runs_status ON paylabs_discovery_runs(status, created_at DESC) WHERE public_api_version IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paylabs_public_runs_client_request ON paylabs_discovery_runs(client_request_id, user_wallet) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paylabs_public_runs_payment_signature_hash ON paylabs_discovery_runs(payment_signature_hash) WHERE payment_signature_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paylabs_public_runs_idempotency ON paylabs_discovery_runs(client_request_id, user_wallet, request_hash) WHERE client_request_id IS NOT NULL AND public_api_version IS NOT NULL;
