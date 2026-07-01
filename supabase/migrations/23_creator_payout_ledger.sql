-- PayLabs Creator Payout Ledger — Idempotency + Treasury Tracking
-- Migration 23: Canonical payout ledger with claim-before-transfer pattern
--
-- Replaces ad-hoc insert() in writeCreatorPayoutEvent with idempotent ledger.
-- Unique constraint on (discovery_run_id, payout_type, payout_subject_id)
-- prevents double-payout on retry.

-- 1. paylabs_payout_ledger — canonical idempotent payout ledger
CREATE TABLE IF NOT EXISTS paylabs_payout_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id uuid NOT NULL,
  payout_type text NOT NULL CHECK (payout_type IN (
    'creator_share',
    'bot_share',
    'service_share',
    'unallocated_reserve',
    'treasury_retained'
  )),
  payout_subject_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'pending',
    'paid',
    'gateway_accepted',
    'failed',
    'skipped'
  )),
  amount_atomic text NOT NULL,
  amount_usdc numeric NOT NULL,
  wallet_address text,
  route_tier text,
  settlement_id text,
  settlement_url text,
  tx_hash text,
  explorer_url text,
  batch_tx_hash text,
  batch_explorer_url text,
  reason text,
  error text,
  safe_metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one payout per run + type + subject
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_ledger_idempotent
  ON paylabs_payout_ledger (discovery_run_id, payout_type, payout_subject_id);

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_payout_ledger_run
  ON paylabs_payout_ledger (discovery_run_id);

CREATE INDEX IF NOT EXISTS idx_payout_ledger_status
  ON paylabs_payout_ledger (status);

CREATE INDEX IF NOT EXISTS idx_payout_ledger_type
  ON paylabs_payout_ledger (payout_type);

-- RLS: deny-all from anon/authenticated (service role only)
ALTER TABLE public.paylabs_payout_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.paylabs_payout_ledger FROM anon;
REVOKE ALL ON TABLE public.paylabs_payout_ledger FROM authenticated;
