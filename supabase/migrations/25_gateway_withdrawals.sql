-- Migration XX: Gateway Withdrawals
-- Dual-wallet withdrawal ledger for DCW Payment Wallet and UCW Creator Wallet.
-- Supports Arc Testnet USDC same-chain withdrawal via Circle Gateway.

BEGIN;

CREATE TABLE IF NOT EXISTS paylabs_gateway_withdrawals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  wallet_mode           text NOT NULL CHECK (wallet_mode IN ('dcw', 'creator_ucw')),
  owner_ref             text NOT NULL,            -- DCW: session.sub (uuid string) | UCW: Circle walletId
  wallet_id             text NOT NULL,            -- Circle wallet ID (for SDK calls)
  wallet_address        text NOT NULL,            -- 0x address (source AND destination, locked)

  -- Amounts
  amount_atomic         text NOT NULL,            -- BigInt string (6 decimals)
  amount_usdc           numeric NOT NULL,         -- Human-readable for display

  -- Idempotency
  idempotency_key       text NOT NULL,

  -- State machine
  status                text NOT NULL DEFAULT 'prepared'
                        CHECK (status IN (
                          'prepared',
                          'burn_signature_pending',
                          'burn_signed',
                          'gateway_submitted',
                          'attestation_received',
                          'mint_submission_pending',
                          'mint_approval_pending',
                          'mint_submitted',
                          'finalized',
                          'failed',
                          'expired',
                          'reconciliation_required'
                        )),

  -- BurnIntent (full canonical object from Gateway /v1/estimate)
  burn_intent           jsonb NOT NULL,
  burn_intent_hash      text NOT NULL,            -- keccak256 of canonical BurnIntent
  transfer_spec_hash    text,                     -- from estimate response

  -- Signing
  signing_challenge_id  text,                     -- UCW only: signTypedData challengeId

  -- Gateway
  gateway_transfer_id   text,                     -- from /v1/transfer response
  attestation_hash      text,                     -- keccak256 of attestation
  gateway_fee           text,                     -- maxFee from estimated BurnIntent
  gateway_expiration    bigint,                   -- maxBlockHeight from estimated BurnIntent

  -- Mint
  mint_challenge_id     text,                     -- UCW only: contractExecution challengeId
  mint_idempotency_key  text,                     -- Circle idempotency key for mint request
  circle_transaction_id text,                     -- from getChallenge → correlationIds → getTransaction
  tx_hash               text,
  explorer_url          text,

  -- Gas preflight
  gas_preflight_ok      boolean,
  gas_preflight_fee     text,
  gas_preflight_error   text,

  -- Error
  error_code            text,
  error_message         text,

  -- Metadata
  safe_metadata         jsonb DEFAULT '{}',

  -- Timestamps
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: unique per wallet_mode + wallet_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_idempotency
  ON public.paylabs_gateway_withdrawals
  (wallet_mode, wallet_id, idempotency_key);

-- Ownership lookup
CREATE INDEX IF NOT EXISTS idx_withdrawals_owner
  ON paylabs_gateway_withdrawals (wallet_mode, owner_ref);

-- Status scan for reconciliation
CREATE INDEX IF NOT EXISTS idx_withdrawals_reconcile
  ON paylabs_gateway_withdrawals (status, updated_at)
  WHERE status IN ('gateway_submitted', 'mint_submitted');

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_withdrawals_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_withdrawals_updated_at ON paylabs_gateway_withdrawals;
CREATE TRIGGER trg_withdrawals_updated_at
  BEFORE UPDATE ON paylabs_gateway_withdrawals
  FOR EACH ROW EXECUTE FUNCTION update_withdrawals_updated_at();

-- Service-role-only ledger: no anon/authenticated Data API access.
ALTER TABLE public.paylabs_gateway_withdrawals
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.paylabs_gateway_withdrawals FROM anon;
REVOKE ALL ON TABLE public.paylabs_gateway_withdrawals FROM authenticated;

COMMIT;
