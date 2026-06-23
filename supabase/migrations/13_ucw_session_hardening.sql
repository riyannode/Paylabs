-- UCW session hardening: authMethod + expires_at with automatic default
-- Safe to run on existing table — adds columns only if missing.

-- 1. Ensure expires_at has a sane default (30 minutes from now)
ALTER TABLE ucw_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 minutes');

-- 2. Backfill any rows with NULL expires_at (stale rows)
UPDATE ucw_sessions SET expires_at = now() + interval '30 minutes' WHERE expires_at IS NULL;

-- 3. Make expires_at NOT NULL now that default + backfill are in place
ALTER TABLE ucw_sessions
  ALTER COLUMN expires_at SET NOT NULL;

-- 4. Add authMethod column inside the JSONB data field
--    (the app stores session fields inside a `data` JSONB column)
--    This is a no-op for existing rows — the app reads authMethod with || "" fallback.

-- 5. Auto-refresh expires_at on any UPDATE via trigger
CREATE OR REPLACE FUNCTION ucw_sessions_refresh_ttl()
RETURNS TRIGGER AS $$
BEGIN
  NEW.expires_at := now() + interval '30 minutes';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ucw_sessions_refresh_ttl ON ucw_sessions;
CREATE TRIGGER trg_ucw_sessions_refresh_ttl
  BEFORE UPDATE ON ucw_sessions
  FOR EACH ROW
  EXECUTE FUNCTION ucw_sessions_refresh_ttl();
