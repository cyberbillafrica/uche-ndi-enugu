-- =====================================================================
-- 0007: POSTGREST SURFACE + TENANT PROVISIONING (Phase 1B)
--
-- 1. public.* RPC wrappers: hosted Supabase exposes only the `public`
--    schema through the data API (changing db_schema config requires
--    project settings access this repository does not currently have).
--    Thin SECURITY INVOKER one-liners delegating to politicore.* — the
--    callers' RLS still fully applies inside the delegated functions.
-- 2. Tenant provisioning path (pre-Control-Center): platform-admin (or
--    first-run bootstrap) creates tenant + module subscriptions +
--    settings. It NEVER creates profiles — the initial administrator
--    claims their account by signing up with `tenant_slug` metadata,
--    which backfills a plain `member` profile. No user can manufacture
--    administrator authority, and no profile is created without a real
--    Supabase Auth identity.
-- 3. Member ≠ public participant (spec §5): the backfill creates only
--    tenant MEMBER profiles from explicit provisioning metadata. There
--    is no path by which an arbitrary signup becomes a member: without
--    `tenant_slug` in metadata, NO profile is created and the identity
--    is merely an unprivileged auth user. A future public-participant
--    identity class can therefore be introduced without touching the
--    member authorization model.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PostgREST-visible wrappers (public schema). Same semantics as the
--    politicore.* functions from 0005; SECURITY INVOKER throughout.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_tenant_id() RETURNS uuid AS $$
  SELECT politicore.my_tenant_id();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.my_access_role()
RETURNS politicore.access_role_enum AS $$
  SELECT politicore.my_access_role();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.my_module_enabled(m politicore.module_code_enum)
RETURNS boolean AS $$
  SELECT politicore.my_module_enabled(m);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.politicore_has_permission(
  p_permission text,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
) RETURNS boolean AS $$
  SELECT politicore.politicore_has_permission(p_permission, p_scope_type, p_scope_id);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.my_scopes_rpc()
RETURNS TABLE (position_name text, scope_type politicore.scope_type_enum, scope_id text) AS $$
  SELECT * FROM politicore.my_scopes_rpc();
$$ LANGUAGE sql STABLE;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Tenant provisioning (pre-Control-Center mechanism)
-- ---------------------------------------------------------------------
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
BEGIN
  -- Authority: platform admin, OR the documented first-run bootstrap
  -- (empty system — no profiles exist yet). After bootstrap, provisioning
  -- is platform-admin-only. Provisioning never elevates the caller and
  -- never creates a profile.
  IF NOT politicore.is_platform_admin()
     AND EXISTS (SELECT 1 FROM politicore.profiles) THEN
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

-- The signup backfill: canonical Supabase handle_new_user pattern.
-- Creates ONLY a plain member profile for the tenant named in signup
-- metadata. Everything else about a user (roles, memberships,
-- assignments, grants) remains an explicit administrative act.
CREATE OR REPLACE FUNCTION politicore.backfill_profile_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_slug text;
  v_name text;
BEGIN
  v_slug := NEW.raw_user_meta_data ->> 'tenant_slug';
  IF v_slug IS NULL THEN
    -- Not a provisioned-member signup (e.g. a future public participant).
    -- Deliberately creates nothing — see header note 3.
    RETURN NEW;
  END IF;

  SELECT id INTO v_tenant FROM politicore.tenants WHERE slug = v_slug;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'signup references unknown tenant_slug: %', v_slug;
  END IF;

  v_name := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    split_part(COALESCE(NEW.email, 'user'), '@', 1)
  );

  INSERT INTO politicore.profiles
    (id, tenant_id, email, full_name, access_role, membership_types)
  VALUES
    (NEW.id, v_tenant, NEW.email, v_name, 'member', '{}')
  ON CONFLICT (id) DO NOTHING;   -- idempotent (auth retries, replays)

  RETURN NEW;
END;
$$;

-- Canonical onauth hook (official Supabase pattern; works on hosted).
DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION politicore.backfill_profile_on_signup();

-- ---------------------------------------------------------------------
-- 3. Notifications helpers (vertical slice) — SECURITY INVOKER, so the
--    notifications RLS policies (own-rows) fully apply.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.mark_notifications_read(p_ids uuid[])
RETURNS integer AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE politicore.notifications
     SET read_at = now()
   WHERE id = ANY(p_ids)
     AND user_id = auth.uid()
     AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION politicore.my_unread_count()
RETURNS bigint AS $$
  SELECT count(*) FROM politicore.notifications
  WHERE user_id = auth.uid() AND read_at IS NULL;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- 4. Server-side audit for module activation changes (security-
--    sensitive settings change — spec §31). Trigger-based, so even a
--    tenant admin's enable/disable lands in system_audits.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.audit_module_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.enabled <> NEW.enabled THEN
    INSERT INTO politicore.system_audits
      (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value)
    VALUES
      (NEW.tenant_id, auth.uid(),
       'tenant_modules:' || lower(TG_OP) || ':module_' || NEW.module::text,
       'tenant_modules', NEW.module::text,
       jsonb_build_object('enabled', OLD.enabled),
       jsonb_build_object('enabled', NEW.enabled));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE TRIGGER trg_audit_module_change
  AFTER UPDATE OF enabled ON politicore.tenant_modules
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_module_change();

-- ---------------------------------------------------------------------
-- 5. Execute grants for app roles on new functions (and future ones).
-- ---------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION politicore.provision_tenant(text, text, text, text, jsonb)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.mark_notifications_read(uuid[])
  TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.my_unread_count()
  TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA politicore
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
