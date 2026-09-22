-- =====================================================================
-- 0011: PROVISION MODULE DEFAULTS (Phase 1B)
--
-- Corrects the provision_tenant module default: a newly provisioned
-- tenant starts with ALL FOUR modules disabled. Module activation is a
-- deliberate subscription act (Phase 1B spec §3/§16), never a silent
-- side effect of provisioning. Callers may still pass p_modules to
-- enable specific modules at provision time.
--
-- Migration discipline (§35): 0007 is already applied on hosted
-- Supabase, so this is a new migration (CREATE OR REPLACE) rather than
-- an edit of applied history. The body is 0010's security-fixed guard
-- (NULL-bypass regression) UNCHANGED — only the p_modules DEFAULT
-- differs from 0010. Fresh databases run 0007 → 0010 → 0011 in order;
-- history remains deterministic.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.provision_tenant(
  p_slug text,
  p_name text,
  p_admin_email text,
  p_admin_full_name text DEFAULT 'Administrator',
  p_modules jsonb DEFAULT '{}'::jsonb
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
  -- treated as NOT platform admin, never as guard-bypass. (0010 fix.)
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

  -- All four modules are ALWAYS materialized; p_modules only sets flags.
  -- Missing keys default to false (explicit activation required).
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
