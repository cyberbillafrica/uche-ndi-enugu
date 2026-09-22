-- =====================================================================
-- 0010: PROVISION_TENANT GUARD FIX (Phase 1B — hosted acceptance finding)
--
-- SECURITY FIX. Discovered during hosted acceptance testing: the 0007
-- bootstrap guard
--
--     IF NOT politicore.is_platform_admin()
--        AND EXISTS (SELECT 1 FROM politicore.profiles) THEN RAISE ...
--
-- is bypassed by three-valued logic when the caller has NO JWT subject:
-- is_platform_admin() evaluates `NULL = 'platform_super_admin'` → NULL,
-- `NOT NULL` → NULL, and plpgsql treats a NULL IF condition as false —
-- so the guard never fires for unauthenticated/unattached callers.
--
-- Fix: explicit IS TRUE semantics. The function is SECURITY DEFINER, so
-- the profiles existence check runs as the owner and is RLS-independent
-- (profiles is NO FORCE — owner bypass), which also closes the "caller
-- sees zero profiles through their own RLS" variant of the same hole.
--
-- 0007 is already applied on hosted/local (no history rewrite); this
-- migration supersedes its definition. Fresh databases run 0007 then
-- this correction, in order — history remains deterministic.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.provision_tenant(
  p_slug text,
  p_name text,
  p_admin_email text,
  p_admin_full_name text DEFAULT 'Administrator',
  p_modules jsonb DEFAULT '{"social":true,"campaign":true,"election":true,"governance":false}'::jsonb
)
RETURNS TABLE (tenant_id uuid, admin_email text, next_step text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  m text;
  v_existing_profiles integer;
BEGIN
  -- RLS-independent count (definer context): how many member profiles
  -- exist platform-wide. This is the bootstrap marker.
  SELECT count(*) INTO v_existing_profiles FROM politicore.profiles;

  -- Explicit IS TRUE: NULL is_platform_admin() (no JWT subject) must be
  -- treated as NOT platform admin, never as guard-bypass.
  IF v_existing_profiles > 0 AND NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'provision_tenant requires platform_super_admin';
  END IF;

  IF p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'invalid tenant slug: %', p_slug;
  END IF;
  IF length(p_name) < 2 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'invalid tenant name length';
  END IF;
  IF p_admin_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid admin email';
  END IF;
  IF EXISTS (SELECT 1 FROM politicore.tenants WHERE slug = p_slug) THEN
    RAISE EXCEPTION 'tenant slug already exists: %', p_slug;
  END IF;

  INSERT INTO politicore.tenants (slug, name)
  VALUES (p_slug, p_name)
  RETURNING id INTO v_tenant;

  FOREACH m IN ARRAY ARRAY['social','campaign','election','governance']::text[]
  LOOP
    INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
    VALUES (
      v_tenant, m::politicore.module_code_enum,
      COALESCE((p_modules ->> m)::boolean, false)
    );
  END LOOP;

  INSERT INTO politicore.tenant_settings (tenant_id) VALUES (v_tenant);
  INSERT INTO politicore.public_site_settings (tenant_id) VALUES (v_tenant);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(), 'tenant:provisioned', 'tenants', v_tenant::text,
     jsonb_build_object('slug', p_slug, 'modules', p_modules,
                        'admin_email', p_admin_email));

  RETURN QUERY SELECT
    v_tenant,
    p_admin_email,
    ('Ask the administrator to sign up with metadata {"tenant_slug":"' || p_slug ||
     '","full_name":"' || p_admin_full_name || '"}; the profile is backfilled as a plain member.')::text;
END;
$$;
