-- =====================================================================
-- 0000: AUTH SCHEMA SHIM (local/testing)
--
-- Mirrors the parts of Supabase's `auth` schema the PolitiCore core
-- schema depends on. STRUCTURALLY SELF-GUARDING: when a real Supabase
-- auth schema is already present (auth.users + auth.uid() exist, as on
-- every hosted project — including via `supabase db push`), every shim
-- element no-ops and Supabase-owned objects are never touched. On a
-- fresh local database (pglite) the full shim is created.
-- =====================================================================

-- Shim mode = the auth schema has NO real users table yet.
-- Captured once; valid for this migration session.
CREATE TEMP TABLE IF NOT EXISTS _shim_mode (shim boolean NOT NULL);
DELETE FROM _shim_mode;
INSERT INTO _shim_mode (shim)
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_namespace n
  JOIN pg_class c ON c.relnamespace = n.oid
  WHERE n.nspname = 'auth' AND c.relname = 'users'
);

-- ---------------------------------------------------------------------
-- auth schema + users table (subset used by profiles FK + tests)
-- ---------------------------------------------------------------------
DO $shim$
BEGIN
  IF (SELECT shim FROM _shim_mode) THEN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS auth';
    RAISE NOTICE '0000: creating local auth shim';
  ELSE
    RAISE NOTICE '0000: real auth schema detected — skipping shim creation';
  END IF;
END
$shim$;

-- auth.users shim (subset used by profiles FK + tests) — created ONLY on
-- local databases (hosted: supabase_auth_admin owns the real one and even
-- IF NOT EXISTS requires schema privileges we must not assume).
DO $shim$
BEGIN
  IF (SELECT shim FROM _shim_mode) THEN
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS auth.users (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text UNIQUE,
        encrypted_password text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    $ddl$;
  END IF;
END
$shim$;

-- auth.uid() — created ONLY when it does not already exist, so the real
-- Supabase implementation is never replaced. Reads the request JWT GUC
-- exactly like PostgREST/Superbase do (tests set it per-request).
DO $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    EXECUTE $body$
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
        SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid;
      $$ LANGUAGE sql STABLE
    $body$;
  END IF;
END
$fn$;

-- ---------------------------------------------------------------------
-- Supabase roles (real ones exist on hosted Supabase; IF NOT EXISTS is
-- a no-op there). Tests run as these roles so RLS is exercised exactly
-- as in production.
-- ---------------------------------------------------------------------
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS politicore;

-- ---------------------------------------------------------------------
-- Grants. politicore grants are unconditional (safe on both hosts).
-- Grants on auth.* apply only to the local shim (we would not be the
-- owner of the real hosted auth tables, and must not re-grant them).
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA politicore TO anon, authenticated, service_role;

-- Row-level statements only: no TRUNCATE (TRUNCATE bypasses RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA politicore TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA politicore TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA politicore TO anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA politicore TO anon, authenticated, service_role;

DO $shim$
BEGIN
  IF (SELECT shim FROM _shim_mode) THEN
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA auth TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA auth TO service_role';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role';
  END IF;
END
$shim$;

ALTER DEFAULT PRIVILEGES IN SCHEMA politicore
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA politicore
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA politicore
  GRANT SELECT ON TABLES TO anon;
