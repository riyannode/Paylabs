-- Unique index to prevent duplicate verified claims for the same source_url
-- Idempotent: uses IF NOT EXISTS
-- Only applies to non-empty source_url rows with claim_status='verified'

CREATE UNIQUE INDEX IF NOT EXISTS paylabs_creator_claims_verified_source_url_unique
ON paylabs_creator_claims (lower(source_url))
WHERE claim_status = 'verified'
  AND source_url IS NOT NULL
  AND source_url <> '';
