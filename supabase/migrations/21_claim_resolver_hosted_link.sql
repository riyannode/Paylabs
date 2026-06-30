-- Migration 21: Claim Resolver + Hosted Link Backlink Verification
-- Adds hosted_link_backlink proof method for platforms that can't host .well-known files.
-- Proof URL is derived: NEXT_PUBLIC_APP_URL + /creator-proof/<claim_id>/<proof_nonce>
--
-- Also adds platform_profile proof method for future social platform support.

-- ─── 1. Update claim_scope CHECK for platform_profile ──────

ALTER TABLE paylabs_creator_claims
  DROP CONSTRAINT IF EXISTS paylabs_creator_claims_claim_scope_check;

ALTER TABLE paylabs_creator_claims
  ADD CONSTRAINT paylabs_creator_claims_claim_scope_check
  CHECK (claim_scope IN ('exact_url', 'domain', 'host', 'github_repo', 'platform_profile', 'manual'));

-- ─── 2. Update source_platform CHECK for social platforms ───

ALTER TABLE paylabs_creator_claims
  DROP CONSTRAINT IF EXISTS paylabs_creator_claims_source_platform_check;

ALTER TABLE paylabs_creator_claims
  ADD CONSTRAINT paylabs_creator_claims_source_platform_check
  CHECK (source_platform IN ('domain', 'github', 'vercel', 'netlify', 'github_pages', 'rss_publisher', 'twitter', 'youtube', 'medium', 'substack', 'unsupported'));

-- ─── 3. Add hosted_link_backlink to proof_method CHECK ────────

ALTER TABLE paylabs_creator_claims
  DROP CONSTRAINT IF EXISTS paylabs_creator_claims_proof_method_check;

ALTER TABLE paylabs_creator_claims
  ADD CONSTRAINT paylabs_creator_claims_proof_method_check
  CHECK (proof_method IN ('well_known_json', 'github_repo_file', 'manual_review', 'hosted_link_backlink'));

-- ─── 4. Index for resolver: domain-level verified claims ──────
-- Resolver queries by source_domain WHERE claim_status='verified'
-- Migration 20 already created idx_creator_claims_domain on source_domain.
-- Add composite index for resolver priority lookups.

CREATE INDEX IF NOT EXISTS idx_creator_claims_resolver
  ON paylabs_creator_claims (claim_scope_key, claim_status)
  WHERE claim_status = 'verified' AND claim_scope_key IS NOT NULL;
