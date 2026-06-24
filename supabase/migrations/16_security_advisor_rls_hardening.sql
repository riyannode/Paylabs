-- Migration 16: Supabase Security Advisor — RLS Hardening
--
-- Fixes:
--   1. RLS Disabled in Public (5 tables)
--   2. RLS Enabled No Policy (6 tables)
--   3. Function Search Path Mutable (2 functions)
--   4. Duplicate index on paylabs_rsshub_routes
--
-- All backend-only tables: RLS enabled, anon/authenticated denied,
-- access only via supabaseAdmin() (service role).
-- Idempotent — uses DO blocks to skip existing policies.

-- ═══════════════════════════════════════════════════════════════
-- 1. RLS DISABLED IN PUBLIC — enable + deny all
-- ═══════════════════════════════════════════════════════════════

-- ─── paylabs_dcw_wallets ─────────────────────────────────────
ALTER TABLE public.paylabs_dcw_wallets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.paylabs_dcw_wallets FROM anon;
REVOKE ALL ON TABLE public.paylabs_dcw_wallets FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_dcw_wallets') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_dcw_wallets FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_dcw_wallets') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_dcw_wallets FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_dcw_wallets') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_dcw_wallets FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_dcw_wallets') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_dcw_wallets FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_service_payment_events ──────────────────────────
ALTER TABLE public.paylabs_service_payment_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.paylabs_service_payment_events FROM anon;
REVOKE ALL ON TABLE public.paylabs_service_payment_events FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_service_payment_events') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_service_payment_events FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_service_payment_events') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_service_payment_events FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_service_payment_events') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_service_payment_events FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_service_payment_events') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_service_payment_events FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_receipts ────────────────────────────────────────
ALTER TABLE public.paylabs_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.paylabs_receipts FROM anon;
REVOKE ALL ON TABLE public.paylabs_receipts FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_receipts') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_receipts FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_receipts') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_receipts FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_receipts') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_receipts FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_receipts') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_receipts FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_run_events ──────────────────────────────────────
ALTER TABLE public.paylabs_run_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.paylabs_run_events FROM anon;
REVOKE ALL ON TABLE public.paylabs_run_events FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_run_events') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_run_events FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_run_events') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_run_events FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_run_events') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_run_events FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_run_events') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_run_events FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_webauthn_challenges ─────────────────────────────
ALTER TABLE public.paylabs_webauthn_challenges ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.paylabs_webauthn_challenges FROM anon;
REVOKE ALL ON TABLE public.paylabs_webauthn_challenges FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_webauthn_challenges') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_webauthn_challenges FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_webauthn_challenges') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_webauthn_challenges FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_webauthn_challenges') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_webauthn_challenges FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_webauthn_challenges') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_webauthn_challenges FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 2. RLS ENABLED NO POLICY — add deny all
-- ═══════════════════════════════════════════════════════════════

-- ─── paylabs_agent_actions ───────────────────────────────────
REVOKE ALL ON TABLE public.paylabs_agent_actions FROM anon;
REVOKE ALL ON TABLE public.paylabs_agent_actions FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_agent_actions') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_agent_actions FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_agent_actions') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_agent_actions FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_agent_actions') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_agent_actions FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_agent_actions') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_agent_actions FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_agent_payments ──────────────────────────────────
REVOKE ALL ON TABLE public.paylabs_agent_payments FROM anon;
REVOKE ALL ON TABLE public.paylabs_agent_payments FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_agent_payments') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_agent_payments FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_agent_payments') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_agent_payments FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_agent_payments') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_agent_payments FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_agent_payments') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_agent_payments FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_route_payments ──────────────────────────────────
REVOKE ALL ON TABLE public.paylabs_route_payments FROM anon;
REVOKE ALL ON TABLE public.paylabs_route_payments FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_route_payments') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_route_payments FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_route_payments') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_route_payments FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_route_payments') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_route_payments FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_route_payments') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_route_payments FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_source_path_items ───────────────────────────────
REVOKE ALL ON TABLE public.paylabs_source_path_items FROM anon;
REVOKE ALL ON TABLE public.paylabs_source_path_items FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_source_path_items') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_source_path_items FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_source_path_items') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_source_path_items FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_source_path_items') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_source_path_items FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_source_path_items') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_source_path_items FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── paylabs_source_paths ────────────────────────────────────
REVOKE ALL ON TABLE public.paylabs_source_paths FROM anon;
REVOKE ALL ON TABLE public.paylabs_source_paths FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'paylabs_source_paths') THEN
    CREATE POLICY "deny anon authenticated select" ON public.paylabs_source_paths FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'paylabs_source_paths') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.paylabs_source_paths FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'paylabs_source_paths') THEN
    CREATE POLICY "deny anon authenticated update" ON public.paylabs_source_paths FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'paylabs_source_paths') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.paylabs_source_paths FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ─── ucw_sessions ────────────────────────────────────────────
REVOKE ALL ON TABLE public.ucw_sessions FROM anon;
REVOKE ALL ON TABLE public.ucw_sessions FROM authenticated;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated select' AND tablename = 'ucw_sessions') THEN
    CREATE POLICY "deny anon authenticated select" ON public.ucw_sessions FOR SELECT TO anon, authenticated USING (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated insert' AND tablename = 'ucw_sessions') THEN
    CREATE POLICY "deny anon authenticated insert" ON public.ucw_sessions FOR INSERT TO anon, authenticated WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated update' AND tablename = 'ucw_sessions') THEN
    CREATE POLICY "deny anon authenticated update" ON public.ucw_sessions FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deny anon authenticated delete' AND tablename = 'ucw_sessions') THEN
    CREATE POLICY "deny anon authenticated delete" ON public.ucw_sessions FOR DELETE TO anon, authenticated USING (false);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- 3. FUNCTION SEARCH PATH MUTABLE
-- ═══════════════════════════════════════════════════════════════

ALTER FUNCTION public.update_discovery_payments_updated_at()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.update_dcw_wallets_updated_at()
  SET search_path = public, pg_temp;

-- ═══════════════════════════════════════════════════════════════
-- 4. DUPLICATE INDEX on paylabs_rsshub_routes
-- ═══════════════════════════════════════════════════════════════

-- Drop the duplicate; keep uq_rsshub_routes_base_path (named constraint)
-- The "index" is actually backed by a unique constraint — drop the constraint
ALTER TABLE public.paylabs_rsshub_routes
  DROP CONSTRAINT IF EXISTS paylabs_rsshub_routes_rsshub_base_url_route_path_key;
