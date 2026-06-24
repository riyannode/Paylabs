-- Migration 18: Email OTP authentication for DCW
-- Stores hashed OTP codes (never plaintext) with TTL and attempt limits.

CREATE TABLE IF NOT EXISTS public.paylabs_email_otps (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email      text NOT NULL,
  code_hash  text NOT NULL,                    -- SHA-256 hex of the 6-digit code
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,           -- incremented on each verify attempt
  created_at timestamptz DEFAULT now()
);

-- Index: look up pending OTP by email (most recent first)
CREATE INDEX IF NOT EXISTS idx_email_otps_email_expires
  ON public.paylabs_email_otps (email, expires_at DESC);

-- RLS: deny-all (server-only table via service role key)
ALTER TABLE public.paylabs_email_otps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.paylabs_email_otps FROM anon;
REVOKE ALL ON public.paylabs_email_otps FROM authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'paylabs_email_otps'
      AND policyname = 'deny_anon_email_otps'
  ) THEN
    CREATE POLICY deny_anon_email_otps ON public.paylabs_email_otps
      FOR ALL TO anon USING (false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'paylabs_email_otps'
      AND policyname = 'deny_authenticated_email_otps'
  ) THEN
    CREATE POLICY deny_authenticated_email_otps ON public.paylabs_email_otps
      FOR ALL TO authenticated USING (false);
  END IF;
END
$$;
