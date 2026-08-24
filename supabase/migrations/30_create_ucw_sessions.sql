-- Migration 30: Create the Supabase-backed UCW session store.
-- Session secrets remain server-side; anon/authenticated roles are denied.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ucw_sessions (
  sid uuid PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL
    DEFAULT (now() + interval '30 minutes')
);

ALTER TABLE public.ucw_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ucw_sessions FROM anon;
REVOKE ALL ON TABLE public.ucw_sessions FROM authenticated;
GRANT ALL ON TABLE public.ucw_sessions TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ucw_sessions'
      AND policyname = 'deny anon authenticated select'
  ) THEN
    CREATE POLICY "deny anon authenticated select"
      ON public.ucw_sessions
      FOR SELECT
      TO anon, authenticated
      USING (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ucw_sessions'
      AND policyname = 'deny anon authenticated insert'
  ) THEN
    CREATE POLICY "deny anon authenticated insert"
      ON public.ucw_sessions
      FOR INSERT
      TO anon, authenticated
      WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ucw_sessions'
      AND policyname = 'deny anon authenticated update'
  ) THEN
    CREATE POLICY "deny anon authenticated update"
      ON public.ucw_sessions
      FOR UPDATE
      TO anon, authenticated
      USING (false)
      WITH CHECK (false);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ucw_sessions'
      AND policyname = 'deny anon authenticated delete'
  ) THEN
    CREATE POLICY "deny anon authenticated delete"
      ON public.ucw_sessions
      FOR DELETE
      TO anon, authenticated
      USING (false);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.ucw_sessions_refresh_ttl()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.expires_at := now() + interval '30 minutes';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ucw_sessions_refresh_ttl
  ON public.ucw_sessions;

CREATE TRIGGER trg_ucw_sessions_refresh_ttl
BEFORE UPDATE ON public.ucw_sessions
FOR EACH ROW
EXECUTE FUNCTION public.ucw_sessions_refresh_ttl();

COMMIT;
