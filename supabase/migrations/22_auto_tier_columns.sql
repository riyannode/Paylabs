-- Migration 22: Auto-tier and recovery columns for paylabs_discovery_runs
-- Adds columns that PR76/PR77 code selects or updates directly.
-- All idempotent (IF NOT EXISTS). No destructive changes.

-- effective_route_tier: written by route-preflight when locking a tier,
-- selected by execute-locked and dcw/run-paid for recovery/response.
ALTER TABLE paylabs_discovery_runs
  ADD COLUMN IF NOT EXISTS effective_route_tier TEXT DEFAULT NULL;

-- final_answer: selected by dcw/run-paid for result recovery.
-- Primary write path stores inside agent_trace JSONB; column allows
-- direct select without JSONB extraction.
ALTER TABLE paylabs_discovery_runs
  ADD COLUMN IF NOT EXISTS final_answer TEXT DEFAULT NULL;

-- brain_route_tier_hint: selected by dcw/run-paid for recovery response.
-- Written inline by execute-locked flow.
ALTER TABLE paylabs_discovery_runs
  ADD COLUMN IF NOT EXISTS brain_route_tier_hint TEXT DEFAULT NULL;

-- source_snapshot: selected by dcw/run-paid for source context recovery.
-- Stores structured source context alongside agent_trace.
ALTER TABLE paylabs_discovery_runs
  ADD COLUMN IF NOT EXISTS source_snapshot JSONB DEFAULT NULL;

-- Index for querying by effective route tier
CREATE INDEX IF NOT EXISTS idx_discovery_runs_effective_tier
  ON paylabs_discovery_runs (effective_route_tier)
  WHERE effective_route_tier IS NOT NULL;
