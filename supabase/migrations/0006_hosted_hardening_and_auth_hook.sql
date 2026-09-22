-- =====================================================================
-- 0006: HOSTED-SUPABASE HARDENING + CUSTOM ACCESS TOKEN HOOK (Phase 1B)
--
-- Found during the Phase 1B hosted-environment review of the Phase 1A
-- migrations. Three issues were masked by the local pglite environment
-- (where the migration runner is a true superuser):
--
-- 1. FORCE ROW LEVEL SECURITY made table owners subject to their own
--    policies. On hosted Supabase `postgres` is NOT a superuser, so the
--    SECURITY DEFINER identity helpers (current_profile /
--    current_tenant_id / module_enabled) and the audit trigger would
--    have recursed into / been denied by the very policies that consult
--    them. Fix: NO FORCE on the two tables definer code touches.
--    Enforcement is unchanged for anon/authenticated/service_role.
-- 2. PostgREST on hosted Supabase exposes only `public` (plus storage/
--    auth) unless the project config is changed. Since the repository
--    cannot currently change project config (no CLI/Dashboard access
--    from this environment), 0007 adds thin `public.*` RPC wrappers.
--    This migration prepares the hosted privilege surface (grants for
--    the real Supabase roles + the auth hook service role).
-- 3. Custom Access Token Hook: embeds ONLY stable identity context
--    (tenant_id, access_role) in the JWT. Permissions/assignments/
--    scope remain database-authoritative (Phase 1B spec §9) — the DB
--    resolver, not the token, decides every authorization question.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. NO FORCE on the two tables touched by SECURITY DEFINER code.
--    RLS stays ENABLED + fully enforced for app roles; only the
--    table-owner bypass (needed by definer helpers/triggers) returns.
-- ---------------------------------------------------------------------
ALTER TABLE politicore.profiles      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.system_audits NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- 2. Hosted privilege replication (idempotent; mirrors 0000 which runs
--    before the tables exist — default privileges normally cover this,
--    these grants make the hosted state explicit and self-healing).
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA politicore TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA politicore TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA politicore TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA politicore TO anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA politicore TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Custom Access Token Hook
--    Event shape: supabase.auth.users hook v1 (GoTrue). Returns the
--    event unchanged apart from app_metadata claims injection.
--    SECURITY DEFINER + locked search_path (Supabase hard requirement);
--    executes as the owner (postgres), which can read profiles without
--    RLS interference (profiles is NO FORCE per item 1).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  claims jsonb;
  v_tenant_id text;
  v_access_role text;
BEGIN
  -- GoTrue always supplies event->'claims'; fail closed if not.
  claims := COALESCE(event->'claims', '{}'::jsonb);

  IF claims->>'sub' IS NULL THEN
    RETURN event;
  END IF;

  -- The user's own profile row: stable tenant + application role.
  -- (Auth identity comes from the JWT subject only — never from
  -- client-writable metadata. Membership/permissions/scope are NOT
  -- embedded; they stay database-authoritative.)
  SELECT p.tenant_id::text, p.access_role::text
    INTO v_tenant_id, v_access_role
  FROM politicore.profiles p
  WHERE p.id = (claims->>'sub')::uuid
    AND p.lifecycle_status = 'active';

  claims := jsonb_set(claims, '{app_metadata,tenant_id}',
                      COALESCE(to_jsonb(v_tenant_id), 'null'::jsonb), true);
  claims := jsonb_set(claims, '{app_metadata,access_role}',
                      COALESCE(to_jsonb(v_access_role), 'null'::jsonb), true);

  RETURN jsonb_set(event, '{claims}', claims, true);
END;
$$;

-- Supabase hardening standard for hook functions:
REVOKE EXECUTE ON FUNCTION politicore.custom_access_token_hook(jsonb) FROM anon, authenticated, public;

-- supabase_auth_admin owns/invokes hooks on hosted Supabase. The
-- IF-missing branch also lets the local pglite suite exercise the hook.
DO $hook$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT;
  END IF;
END
$hook$;
GRANT USAGE ON SCHEMA politicore TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION politicore.custom_access_token_hook(jsonb) TO supabase_auth_admin;

-- Activate the hook in GoTrue config (documented; cannot be done via SQL):
--   Dashboard → Authentication → Hooks → Custom Access Token Hook
--     → politicore.custom_access_token_hook
--   or supabase/config.toml:
--     [auth.hook.custom_access_token]
--     enabled = true
--     uri = "pg-functions://postgres/politicore/custom_access_token_hook"
-- Until activated, auth.uid()/current_tenant_id() resolve tenant identity
-- directly from the DB (JWT sub), so the vertical slice works either way.
