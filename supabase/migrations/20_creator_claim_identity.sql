-- Migration 20: Creator Claim Identity Model
-- Extends paylabs_creator_claims with structured identity fields
-- for domain-level and repo-level creator matching.
--
-- New concepts:
--   canonical_url  — normalized HTTPS URL (primary matching key)
--   claim_scope    — exact_url | domain | host | github_repo | manual
--   claim_scope_key — deterministic key for unique matching
--   source_platform — domain | github | vercel | netlify | github_pages | rss_publisher | unsupported
--   proof_method   — well_known_json | github_repo_file | manual_review
--   proof_status   — not_started | pending | verified | failed | manual_required
--   proof_nonce    — random nonce for verification challenge
--   proof_checked_at — last verification attempt timestamp
--   proof_error    — last verification error (safe, no raw bodies)
--   proof_evidence_hash — SHA-256 of proof response (no raw body stored)
--
-- Unique constraint: one verified claim per scope_key.

-- ─── 1. Add new columns to paylabs_creator_claims ──────────────

ALTER TABLE paylabs_creator_claims
  ADD COLUMN IF NOT EXISTS canonical_url text,
  ADD COLUMN IF NOT EXISTS claim_scope text
    CHECK (claim_scope IN ('exact_url', 'domain', 'host', 'github_repo', 'manual')),
  ADD COLUMN IF NOT EXISTS claim_scope_key text,
  ADD COLUMN IF NOT EXISTS source_platform text
    CHECK (source_platform IN ('domain', 'github', 'vercel', 'netlify', 'github_pages', 'rss_publisher', 'unsupported')),
  ADD COLUMN IF NOT EXISTS proof_method text
    CHECK (proof_method IN ('well_known_json', 'github_repo_file', 'manual_review')),
  ADD COLUMN IF NOT EXISTS proof_nonce text,
  ADD COLUMN IF NOT EXISTS proof_status text NOT NULL DEFAULT 'pending'
    CHECK (proof_status IN ('not_started', 'pending', 'verified', 'failed', 'manual_required')),
  ADD COLUMN IF NOT EXISTS proof_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS proof_error text,
  ADD COLUMN IF NOT EXISTS proof_evidence_hash text;

-- ─── 2. Indexes ────────────────────────────────────────────────

-- Fast lookup by scope key (primary matching path)
CREATE INDEX IF NOT EXISTS idx_creator_claims_scope_key
  ON paylabs_creator_claims (claim_scope_key)
  WHERE claim_scope_key IS NOT NULL;

-- Fast lookup by canonical URL
CREATE INDEX IF NOT EXISTS idx_creator_claims_canonical_url
  ON paylabs_creator_claims (canonical_url)
  WHERE canonical_url IS NOT NULL;

-- Fast lookup by domain (domain-level claims)
CREATE INDEX IF NOT EXISTS idx_creator_claims_domain
  ON paylabs_creator_claims (source_domain)
  WHERE source_domain IS NOT NULL;

-- ─── 3. Unique verified scope constraint ───────────────────────

-- GLOBAL uniqueness: one verified claim per scope_key across ALL wallets.
-- If wallet A verifies domain:coindesk.com, wallet B cannot also verify it.
-- This prevents payout hijack — only one wallet can own a given source scope.
CREATE UNIQUE INDEX IF NOT EXISTS idx_creator_claims_verified_scope
  ON paylabs_creator_claims (claim_scope_key)
  WHERE claim_status = 'verified' AND claim_scope_key IS NOT NULL;

-- ─── 4. Backfill existing rows ─────────────────────────────────

-- Set canonical_url = source_url for existing rows
UPDATE paylabs_creator_claims
SET canonical_url = source_url
WHERE canonical_url IS NULL AND source_url IS NOT NULL;

-- Set claim_scope = 'exact_url' for existing rows with source_url
UPDATE paylabs_creator_claims
SET claim_scope = 'exact_url'
WHERE claim_scope IS NULL AND source_url IS NOT NULL;

-- Set claim_scope_key for existing rows
UPDATE paylabs_creator_claims
SET claim_scope_key = 'url:' || encode(digest(coalesce(source_url, ''), 'sha256'), 'hex')
WHERE claim_scope_key IS NULL AND source_url IS NOT NULL;

-- Set source_platform based on source_domain
UPDATE paylabs_creator_claims
SET source_platform = CASE
  WHEN source_domain LIKE '%.github.io' THEN 'github_pages'
  WHEN source_domain LIKE '%.vercel.app' THEN 'vercel'
  WHEN source_domain LIKE '%.netlify.app' THEN 'netlify'
  WHEN source_domain = 'github.com' THEN 'github'
  ELSE 'domain'
END
WHERE source_platform IS NULL AND source_domain IS NOT NULL;

-- Set proof_method based on source_platform
UPDATE paylabs_creator_claims
SET proof_method = CASE
  WHEN source_platform = 'github' THEN 'github_repo_file'
  ELSE 'well_known_json'
END
WHERE proof_method IS NULL;

-- Set proof_status for existing verified claims
UPDATE paylabs_creator_claims
SET proof_status = 'verified'
WHERE proof_status = 'pending' AND claim_status = 'verified';

-- Set proof_status for existing manual_review claims
UPDATE paylabs_creator_claims
SET proof_status = 'manual_required'
WHERE proof_status = 'pending' AND verification_method = 'manual_review';
