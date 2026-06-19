-- PayLabs Migration: Add monetization gate fields
-- Run against Supabase database

-- 1. Routes: make creator_wallet nullable, add is_monetized
ALTER TABLE paylabs_rsshub_routes ALTER COLUMN creator_wallet DROP NOT NULL;
ALTER TABLE paylabs_rsshub_routes ADD COLUMN IF NOT EXISTS is_monetized boolean NOT NULL DEFAULT false;

-- 2. Routes: default prices to 0
ALTER TABLE paylabs_rsshub_routes ALTER COLUMN default_price_per_citation_usdc SET DEFAULT 0;
ALTER TABLE paylabs_rsshub_routes ALTER COLUMN default_price_per_unlock_usdc SET DEFAULT 0;

-- 3. Feed items: make creator_wallet nullable, add is_monetized, default prices
ALTER TABLE paylabs_feed_items ALTER COLUMN creator_wallet DROP NOT NULL;
ALTER TABLE paylabs_feed_items ADD COLUMN IF NOT EXISTS is_monetized boolean NOT NULL DEFAULT false;
ALTER TABLE paylabs_feed_items ALTER COLUMN price_per_citation_usdc SET DEFAULT 0;
ALTER TABLE paylabs_feed_items ALTER COLUMN price_per_unlock_usdc SET DEFAULT 0;

-- 4. Source path items: add is_monetized, evidence/marginal scores
ALTER TABLE paylabs_source_path_items ADD COLUMN IF NOT EXISTS is_monetized boolean NOT NULL DEFAULT false;
ALTER TABLE paylabs_source_path_items ADD COLUMN IF NOT EXISTS evidence_score numeric;
ALTER TABLE paylabs_source_path_items ADD COLUMN IF NOT EXISTS marginal_value_score numeric;

-- 5. Source paths: add effective_spend_cap, stop fields, estimated splits
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS effective_spend_cap_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS estimated_creator_payout_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS estimated_agent_fee_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS estimated_treasury_fee_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS route_limits jsonb;
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS stop_reason text;
ALTER TABLE paylabs_source_paths ADD COLUMN IF NOT EXISTS stop_limit_hit boolean NOT NULL DEFAULT false;

-- 6. Source payments: add split fields
ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS creator_amount_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS agent_fee_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS treasury_fee_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_source_payments ADD COLUMN IF NOT EXISTS split_rule_version text NOT NULL DEFAULT 'v1_85_10_5';

-- 7. Agent actions: expand with new columns
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS agent_name text;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS route_tier text;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS decision_label text;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS source_path_id uuid;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS feed_item_id uuid;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS evidence_score numeric;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS marginal_value_score numeric;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS cost_usdc numeric NOT NULL DEFAULT 0;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS max_cost_usdc numeric;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS stop_reason text;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS paid_via_payment_adapter boolean NOT NULL DEFAULT false;
ALTER TABLE paylabs_agent_actions ADD COLUMN IF NOT EXISTS metadata jsonb;

-- 8. New indexes
CREATE INDEX IF NOT EXISTS idx_rsshub_routes_monetized ON paylabs_rsshub_routes(is_monetized) WHERE is_monetized = true;
CREATE INDEX IF NOT EXISTS idx_rsshub_routes_verified ON paylabs_rsshub_routes(verification_status) WHERE verification_status = 'verified';
CREATE INDEX IF NOT EXISTS idx_feed_items_monetized ON paylabs_feed_items(is_monetized) WHERE is_monetized = true;
CREATE INDEX IF NOT EXISTS idx_agent_actions_agent_name ON paylabs_agent_actions(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_actions_source_path ON paylabs_agent_actions(source_path_id);
