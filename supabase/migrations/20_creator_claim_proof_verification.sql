-- Creator Claim Proof Verification Migration
-- Adds deterministic proof columns to paylabs_creator_claims
-- Idempotent: uses IF NOT EXISTS and DO $$ constraint guards

-- 1. Add proof columns
ALTER TABLE paylabs_creator_claims
  ADD COLUMN IF NOT EXISTS proof_type text,
  ADD COLUMN IF NOT EXISTS proof_nonce text,
  ADD COLUMN IF NOT EXISTS proof_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS proof_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS proof_error text,
  ADD COLUMN IF NOT EXISTS proof_evidence_hash text;

-- 2. Add check constraint on proof_type (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_creator_claims_proof_type'
      AND conrelid = 'paylabs_creator_claims'::regclass
  ) THEN
    ALTER TABLE paylabs_creator_claims
      ADD CONSTRAINT chk_creator_claims_proof_type
      CHECK (proof_type IS NULL OR proof_type IN ('well_known_json', 'dns_txt'));
  END IF;
END $$;

-- 3. Add check constraint on proof_status (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_creator_claims_proof_status'
      AND conrelid = 'paylabs_creator_claims'::regclass
  ) THEN
    ALTER TABLE paylabs_creator_claims
      ADD CONSTRAINT chk_creator_claims_proof_status
      CHECK (proof_status IN ('not_started', 'pending', 'verified', 'failed'));
  END IF;
END $$;

-- 4. Index on proof_status for cron queries
CREATE INDEX IF NOT EXISTS idx_creator_claims_proof_status
  ON paylabs_creator_claims (proof_status)
  WHERE proof_status IN ('pending', 'failed');
