-- =====================================================================
-- 0012: AUTH HOOK app_metadata ROBUSTNESS (Phase 1B)
--
-- SECURITY-ADJACENT ROBUSTNESS FIX. The 0006 hook used
-- jsonb_set(claims, '{app_metadata,tenant_id}', ...) which silently
-- no-ops when the incoming claims contain NO 'app_metadata' object —
-- jsonb_set never creates intermediate objects. Hosted GoTrue normally
-- includes app_metadata in minted claims, but the hook must not depend
-- on that (e.g. claims shapes may vary across GoTrue versions/flows);
-- a silent no-op would mean tokens without the tenant context.
--
-- Fix: explicitly create app_metadata = {} before setting keys.
-- Everything else is unchanged from 0006 (0006 is already applied on
-- hosted — new migration, not a history rewrite; §35).
-- =====================================================================

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

  -- jsonb_set cannot create intermediate objects — ensure app_metadata
  -- exists before setting keys inside it.
  claims := jsonb_set(claims, '{app_metadata}',
                      COALESCE(claims->'app_metadata', '{}'::jsonb), true);
  claims := jsonb_set(claims, '{app_metadata,tenant_id}',
                      COALESCE(to_jsonb(v_tenant_id), 'null'::jsonb), true);
  claims := jsonb_set(claims, '{app_metadata,access_role}',
                      COALESCE(to_jsonb(v_access_role), 'null'::jsonb), true);

  RETURN jsonb_set(event, '{claims}', claims, true);
END;
$$;

-- Re-assert the Supabase hardening standard after redefinition:
REVOKE EXECUTE ON FUNCTION politicore.custom_access_token_hook(jsonb)
  FROM anon, authenticated, public;
