-- PayLabs Creator Distribution V1 Migration
-- Tables: creator claims, source attributions, payout events, memory, evaluator memory
-- Adds creator distribution columns to paylabs_receipts

-- 1. paylabs_creator_claims
-- Registry of verified creator wallets and their claim status
CREATE TABLE IF NOT EXISTS paylabs_creator_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_wallet text NOT NULL,
  creator_name text,
  source_domain text,
  source_url text,
  claim_status text NOT NULL CHECK (claim_status IN ('verified', 'unclaimed', 'rejected', 'revoked', 'unknown')),
  verification_method text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creator_claims_wallet ON paylabs_creator_claims (creator_wallet);
CREATE INDEX IF NOT EXISTS idx_creator_claims_status ON paylabs_creator_claims (claim_status);

-- 2. paylabs_source_attributions
-- Attribution records for each source in a discovery run
CREATE TABLE IF NOT EXISTS paylabs_source_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id uuid NOT NULL,
  feed_item_id text,
  source_url text NOT NULL,
  source_title text,
  publisher text,
  creator_wallet text,
  claim_status text NOT NULL,
  eligibility_status text NOT NULL,
  final_score numeric,
  risk_score numeric,
  attribution_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_attributions_run ON paylabs_source_attributions (discovery_run_id);
CREATE INDEX IF NOT EXISTS idx_source_attributions_url ON paylabs_source_attributions (source_url);

-- 3. paylabs_creator_payout_events
-- Actual payout events for creator distribution
CREATE TABLE IF NOT EXISTS paylabs_creator_payout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id uuid NOT NULL,
  route_tier text NOT NULL,
  feed_item_id text,
  source_url text NOT NULL,
  source_title text,
  creator_wallet text,
  status text NOT NULL,
  planned_amount_atomic text NOT NULL,
  planned_amount_usdc numeric NOT NULL,
  actual_amount_atomic text,
  actual_amount_usdc numeric,
  split_policy text NOT NULL,
  settlement_id text,
  settlement_url text,
  tx_hash text,
  explorer_url text,
  batch_tx_hash text,
  batch_explorer_url text,
  error text,
  safe_summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creator_payout_events_run ON paylabs_creator_payout_events (discovery_run_id);
CREATE INDEX IF NOT EXISTS idx_creator_payout_events_wallet ON paylabs_creator_payout_events (creator_wallet);
CREATE INDEX IF NOT EXISTS idx_creator_payout_events_status ON paylabs_creator_payout_events (status);

-- 4. paylabs_creator_memory
-- Safe memory for creator reliability tracking
CREATE TABLE IF NOT EXISTS paylabs_creator_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_wallet text,
  source_url text,
  source_domain text,
  memory_type text NOT NULL,
  safe_summary text NOT NULL,
  reliability_score numeric,
  usage_count int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_memory_unique
  ON paylabs_creator_memory (creator_wallet, source_url, memory_type)
  WHERE creator_wallet IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_creator_memory_url ON paylabs_creator_memory (source_url);

-- 5. paylabs_evaluator_memory
-- Safe memory for the Deep Agent evidence evaluator
CREATE TABLE IF NOT EXISTS paylabs_evaluator_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id uuid,
  route_tier text NOT NULL,
  source_ids text[] NOT NULL DEFAULT '{}',
  source_urls text[] NOT NULL DEFAULT '{}',
  safe_evaluator_summary text NOT NULL,
  why_two_sources_needed text,
  evaluator_confidence numeric,
  warnings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluator_memory_run ON paylabs_evaluator_memory (discovery_run_id);

-- 6. Add creator distribution columns to paylabs_receipts
ALTER TABLE paylabs_receipts
  ADD COLUMN IF NOT EXISTS execution_fee_usdc numeric,
  ADD COLUMN IF NOT EXISTS planned_creator_pool_usdc numeric,
  ADD COLUMN IF NOT EXISTS actual_creator_paid_usdc numeric,
  ADD COLUMN IF NOT EXISTS planned_creator_payout_count int,
  ADD COLUMN IF NOT EXISTS actual_creator_payout_count int,
  ADD COLUMN IF NOT EXISTS pending_creator_reserve_usdc numeric,
  ADD COLUMN IF NOT EXISTS bot_share_usdc numeric,
  ADD COLUMN IF NOT EXISTS service_share_usdc numeric,
  ADD COLUMN IF NOT EXISTS creator_split_policy text,
  ADD COLUMN IF NOT EXISTS creator_payout_status text,
  ADD COLUMN IF NOT EXISTS advanced_evaluator_used boolean,
  ADD COLUMN IF NOT EXISTS advanced_evaluator_confidence numeric,
  ADD COLUMN IF NOT EXISTS advanced_evaluator_rationale text,
  ADD COLUMN IF NOT EXISTS why_two_sources_needed text;
