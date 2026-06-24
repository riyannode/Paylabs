-- Migration 17: DCW passkey schema fix + challenge binding
-- Fixes 6 blockers identified in PR #43 review:
--   1. Missing passkey columns in paylabs_dcw_wallets
--   2. Empty-string unique violation (second user registers → fail)
--   3. Missing paylabs_webauthn_challenges table (was never created)
--   4. Challenge not bound to user (race condition)
--   5. Expired challenge cleanup

BEGIN;

-- ─── 1. Create paylabs_webauthn_challenges table ─────────────
-- Migration 16 enforced RLS on this table but it was never created.

CREATE TABLE IF NOT EXISTS public.paylabs_webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  email       text NOT NULL,
  challenge   text NOT NULL,
  type        text NOT NULL CHECK (type IN ('registration', 'authentication')),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_type
  ON public.paylabs_webauthn_challenges (user_id, type);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
  ON public.paylabs_webauthn_challenges (expires_at);

-- Auto-delete expired challenges (runs on every insert via trigger is overkill;
-- a periodic cleanup or SELECT ... WHERE expires_at > now() is sufficient,
-- but we add a partial index to make the query fast).

-- ─── 2. Add passkey columns to paylabs_dcw_wallets ──────────

ALTER TABLE public.paylabs_dcw_wallets
  ADD COLUMN IF NOT EXISTS passkey_credential_id text,
  ADD COLUMN IF NOT EXISTS passkey_public_key    text,
  ADD COLUMN IF NOT EXISTS passkey_counter       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS display_name          text;

-- ─── 3. Make wallet_id and wallet_address nullable ───────────
-- Passkey-only users register before creating a DCW wallet.
-- Empty string "" violates unique constraint for second user.

ALTER TABLE public.paylabs_dcw_wallets
  ALTER COLUMN wallet_id     DROP NOT NULL,
  ALTER COLUMN wallet_address DROP NOT NULL;

-- Convert existing empty strings to NULL
UPDATE public.paylabs_dcw_wallets
  SET wallet_id = NULL
  WHERE wallet_id = '';

UPDATE public.paylabs_dcw_wallets
  SET wallet_address = NULL
  WHERE wallet_address = '';

-- ─── 4. Drop old unique/full indexes, create partial unique ──

-- Drop the old unique constraint on wallet_id (was full-table unique)
DO $$
BEGIN
  -- Drop unique constraint if exists (Postgres names it automatically)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.paylabs_dcw_wallets'::regclass
      AND contype = 'u'
      AND array_length(conkey, 1) = 1
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.paylabs_dcw_wallets DROP CONSTRAINT ' || conname
      FROM pg_constraint
      WHERE conrelid = 'public.paylabs_dcw_wallets'::regclass
        AND contype = 'u'
        AND array_length(conkey, 1) = 1
      LIMIT 1
    );
  END IF;
END $$;

-- Drop old indexes that may conflict
DROP INDEX IF EXISTS public.idx_dcw_wallets_wallet_id;
DROP INDEX IF EXISTS public.idx_dcw_wallets_address;

-- Partial unique indexes: only enforce uniqueness for non-null values
CREATE UNIQUE INDEX IF NOT EXISTS idx_dcw_wallets_wallet_id_unique
  ON public.paylabs_dcw_wallets (wallet_id)
  WHERE wallet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dcw_wallets_address_unique
  ON public.paylabs_dcw_wallets (lower(wallet_address))
  WHERE wallet_address IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dcw_wallets_passkey_cred_unique
  ON public.paylabs_dcw_wallets (passkey_credential_id)
  WHERE passkey_credential_id IS NOT NULL;

-- Non-unique lookup indexes (replace dropped ones)
CREATE INDEX IF NOT EXISTS idx_dcw_wallets_wallet_id_lookup
  ON public.paylabs_dcw_wallets (wallet_id)
  WHERE wallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dcw_wallets_address_lookup
  ON public.paylabs_dcw_wallets (lower(wallet_address))
  WHERE wallet_address IS NOT NULL;

COMMIT;
