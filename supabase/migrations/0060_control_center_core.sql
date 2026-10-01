-- POLITICORE — MIGRATION 0060: CONTROL CENTER CORE — CONFIGURATION & SERVICE
-- ACTIVATION (PHASE 22).
--
-- Implements the Phase 21 Control Center Architecture Gate over EXISTING
-- substrate — zero new tables:
--
--   tenant_modules        — runtime activation state (existing; audited)
--   platform_settings     — service_entitlements key (platform authority)
--   public_site_settings  — configuration substrate (draft/published jsonb)
--
-- Authority: EXISTING is_tenant_admin() — zero new roles/permissions.
-- Audit:     EXISTING audit_module_change trigger + Core Audit entries.
--
--   1. Activation RPC      set_tenant_module_enabled(module, enabled)
--                          ENTITLED AND ENABLED = OPERATIONAL; entitlement
--                          enforced server-side; tenant/actor server-resolved;
--                          non-destructive; audited.
--   2. Overview RPC        control_center_overview() — entitlements,
--                          activation, operational state, config revisions.
--   3. Config RPCs         get_site_config(area) / save_site_config_draft(area,
--                          jsonb, base_revision) / publish_site_config(area,
--                          base_revision) — revision + optimistic concurrency,
--                          draft/published split, public reads of PUBLISHED
--                          only (draft excluded from anonymous surface).
--   4. Entitlement helper  service_entitled(module) + grant posture per the
--                          0000 blanket-grant / per-migration REVOKE convention.
-- ---------------------------------------------------------------------

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ENTITLEMENT HELPER
-- ═══════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════
-- 0. POLICY HARDENING — public_site_settings currently exposes its whole
-- row (drafts included) to anon via public_site_settings_read USING(true).
-- Phase 21 §25: unpublished configuration is never publicly readable.
-- Narrowed to the PUBLISHED state; full-row reads stay inside the
-- admin-gated RPCs. anon table grant (0000 blanket) is left untouched —--    the policy, not the grant, is the boundary (established pattern).
--    DIRECT GRANTS ARE REVOKED (anon + authenticated): the narrowed policy
--    alone cannot hide DRAFTS from cross-tenant row reads, and RLS cannot
--    shape columns. Anonymous/authenticated access flows exclusively
--    through the RPCs below — the published-only wrapper for the public
--    site, the admin-gated RPCs for full-row reads. service_role retains
--    the 0000 blanket grant.
-- ═════════════════════════════════════════════════════════════════

REVOKE ALL ON politicore.public_site_settings FROM anon, authenticated;

DROP POLICY IF EXISTS public_site_settings_read ON politicore.public_site_settings;
CREATE POLICY public_site_settings_read ON politicore.public_site_settings
  FOR SELECT USING (
    politicore.is_platform_admin()
    OR COALESCE((homepage ->> 'published_at') IS NOT NULL, false)
    OR COALESCE((navigation ->> 'published_at') IS NOT NULL, false)
    OR COALESCE((footer ->> 'published_at') IS NOT NULL, false)
    OR COALESCE((branding ->> 'published_at') IS NOT NULL, false)
    OR COALESCE((contact ->> 'published_at') IS NOT NULL, false)
    OR COALESCE((social_links ->> 'published_at') IS NOT NULL, false)
    OR COALESCE((seo ->> 'published_at') IS NOT NULL, false)
  );

CREATE OR REPLACE FUNCTION politicore.service_entitled(
  p_module politicore.module_code_enum
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
  -- Entitlement is PER-TENANT but PLATFORM-administered: the singleton
  -- platform_settings row holds service_entitlements keyed by tenant id,
  -- so tenants can be entitled independently. Absent key ⇒ not entitled.
  SELECT COALESCE(
    ((SELECT ps.settings -> 'service_entitlements'
             -> politicore.current_tenant_id()::text -> p_module::text
      FROM politicore.platform_settings ps WHERE ps.id = 1)
     #>> '{}' )::boolean,
    false);
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. ACTIVATION RPC — the only mutation path for service activation
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.set_tenant_module_enabled(
  p_module politicore.module_code_enum,
  p_enabled boolean
) RETURNS TABLE (
  module        politicore.module_code_enum,
  entitled      boolean,
  enabled       boolean,
  operational   boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant  uuid := politicore.current_tenant_id();
  v_entitled boolean;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;

  -- §7: tenant administration authority (existing predicate — no new role,
  -- no new permission, no reproduced authority logic).
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for service activation.';
  END IF;

  -- §5: entitled AND enabled = operational. Entitlement is enforced HERE,
  -- server-side — a stray enabled row never circumvents it.
  v_entitled := politicore.service_entitled(p_module);
  IF p_enabled AND NOT v_entitled THEN
    RAISE EXCEPTION 'Service % is not entitled for this tenant.', p_module;
  END IF;

  -- §6: update only the current tenant's row; the AFTER UPDATE trigger
  -- (audit_module_change, 0007) writes the Core Audit record automatically.
  -- No cascade, no deletion, no historical mutation.
  UPDATE politicore.tenant_modules tm
     SET enabled = p_enabled,
         enabled_at = CASE WHEN p_enabled THEN now() ELSE NULL END,
         updated_at = now()
   WHERE tm.tenant_id = v_tenant
     AND tm.module = p_module;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service % is not configured for this tenant.', p_module;
  END IF;

  RETURN QUERY
  SELECT p_module, v_entitled, p_enabled, (v_entitled AND p_enabled);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. OVERVIEW RPC — Control Center read model (server-resolved tenant)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.control_center_overview()
RETURNS TABLE (
  module              politicore.module_code_enum,
  label               text,
  entitled            boolean,
  enabled             boolean,
  operational         boolean,
  enabled_at          timestamptz,
  config_revision     integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF politicore.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  -- §9/§23: the overview is a tenant-administration read model.
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for the Control Center overview.';
  END IF;

  RETURN QUERY
  SELECT
    tm.module::politicore.module_code_enum,
    CASE tm.module
      WHEN 'social' THEN 'Social Force'
      WHEN 'campaign' THEN 'Campaign'
      WHEN 'election' THEN 'Election'
      WHEN 'governance' THEN 'Governance'
    END::text,
    politicore.service_entitled(tm.module),
    tm.enabled,
    politicore.service_entitled(tm.module) AND tm.enabled,
    tm.enabled_at,
    COALESCE(
      (SELECT (pss.homepage ->> 'revision')::integer
         FROM politicore.public_site_settings pss
        WHERE pss.tenant_id = tm.tenant_id), 0)
  FROM politicore.tenant_modules tm
  WHERE tm.tenant_id = politicore.current_tenant_id()
  ORDER BY
    CASE tm.module WHEN 'social' THEN 1 WHEN 'campaign' THEN 2
                   WHEN 'election' THEN 3 WHEN 'governance' THEN 4 END;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. CONFIGURATION RPC FOUNDATION — draft/published + optimistic concurrency
--    over the EXISTING public_site_settings columns (one area per column).
--    No editors here (Phases 23–25); these are the safe primitives later
--    phases consume.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.cc_is_site_config_area(
  p_area text
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = politicore, pg_temp
AS $$
  SELECT p_area IN ('branding','navigation','footer','homepage','contact','social_links','seo');
$$;

-- READ: tenant admins get DRAFT + PUBLISHED; members get nothing;
-- anonymous PUBLIC reads flow exclusively through the wrapper in §5,
-- which exposes the PUBLISHED state only — drafts are never anonymous-
-- readable.
CREATE OR REPLACE FUNCTION politicore.get_site_config(p_area text)
RETURNS TABLE (
  area           text,
  revision       integer,
  draft          jsonb,
  published      jsonb,
  published_at   timestamptz,
  published_by   uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration reads.';
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT %L::text,
            COALESCE((p.%I ->> ''revision'')::integer, 0),
            p.%I -> ''draft'',
            p.%I -> ''published'',
            (p.%I ->> ''published_at'')::timestamptz,
            (p.%I ->> ''published_by'')::uuid
       FROM politicore.public_site_settings p WHERE p.tenant_id = $1',
    p_area, p_area, p_area, p_area, p_area, p_area)
  USING v_tenant;
END;
$$;

-- SAVE DRAFT: admin-only, revision-checked (optimistic concurrency),
-- audit-logged (coarse, Core Audit), never touches PUBLISHED.
CREATE OR REPLACE FUNCTION politicore.save_site_config_draft(
  p_area         text,
  p_draft        jsonb,
  p_base_revision integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant  uuid := politicore.current_tenant_id();
  v_current integer;
  v_ok      integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration writes.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;
  IF jsonb_typeof(p_draft) <> 'object' THEN
    RAISE EXCEPTION 'Configuration draft must be a JSON object.';
  END IF;

  -- Area-scoped current revision (friendly pre-check; the atomic statement
  -- below remains the real concurrency boundary). Scalar-subquery form so a
  -- missing settings row yields 0 (a bare SELECT … INTO would return zero
  -- rows and leave the variable NULL).
  EXECUTE format(
    'SELECT COALESCE((SELECT (%I ->> %L)::integer
                       FROM politicore.public_site_settings WHERE tenant_id = $1), 0)',
    p_area, 'revision') INTO v_current USING v_tenant;

  IF v_current <> p_base_revision THEN
    RAISE EXCEPTION 'Configuration conflict: expected revision %, current is %.', p_base_revision, v_current;
  END IF;

  -- Atomic upsert: a concurrent writer that already advanced the revision
  -- makes the conditional DO UPDATE match zero rows → conflict, no overwrite.
  -- (Handles the not-yet-provisioned settings row as revision 0.)
  EXECUTE format(
    'INSERT INTO politicore.public_site_settings (tenant_id, %I)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET %I = EXCLUDED.%I,
           updated_at = now()
       WHERE COALESCE((politicore.public_site_settings.%I ->> ''revision'')::integer, 0) = $3
     RETURNING 1',
    p_area, p_area, p_area, p_area, p_area)
  INTO v_ok
  USING v_tenant,
        jsonb_build_object('revision', v_current + 1, 'draft', p_draft,
                           'updated_at', to_jsonb(now()),
                           'updated_by', to_jsonb(auth.uid())),
        p_base_revision;

  IF v_ok IS NULL THEN
    RAISE EXCEPTION 'Configuration conflict: area % was modified concurrently.', p_area;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(),
     'site_config:' || p_area || ':draft_saved',
     'public_site_settings', v_tenant::text,
     jsonb_build_object('area', p_area, 'revision', v_current + 1));

  RETURN v_current + 1;
END;
$$;

-- PUBLISH: promotes the saved DRAFT to PUBLISHED atomically, stamps
-- provenance, archives the previous published state (bounded history),
-- audit-logged with from/to revisions. Static per-area UPDATE branches:
-- dynamic EXECUTE/USING proved unreliable for this conditional write
-- under role-impersonated sessions; every existing migration uses static
-- statement shapes and so does this function.
CREATE OR REPLACE FUNCTION politicore.publish_site_config(
  p_area          text,
  p_base_revision integer
) RETURNS TABLE (revision integer, published_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_row    jsonb;
  v_rev    integer;
  v_prev   jsonb;
  v_hist   jsonb;
  v_new    jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration publication.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;

  -- Read the CURRENT row for the requested area (static per-area branch).
  IF p_area = 'branding' THEN
    SELECT branding INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'navigation' THEN
    SELECT navigation INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'footer' THEN
    SELECT footer INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'homepage' THEN
    SELECT homepage INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'contact' THEN
    SELECT contact INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'social_links' THEN
    SELECT social_links INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'seo' THEN
    SELECT seo INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  END IF;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No draft configuration to publish for area %.', p_area;
  END IF;
  v_rev := COALESCE(v_row ->> 'revision', '0')::integer;
  IF v_rev <> p_base_revision THEN
    RAISE EXCEPTION 'Configuration conflict: expected revision %, current is %.', p_base_revision, v_rev;
  END IF;
  IF v_row ? 'draft' = false THEN
    RAISE EXCEPTION 'No draft configuration to publish for area %.', p_area;
  END IF;

  v_prev := v_row -> 'published';

  -- Archive the previous published state; keep the LAST 10 (oldest drops).
  v_hist := COALESCE(v_row -> 'history', '[]'::jsonb) || jsonb_build_array(
              jsonb_build_object('revision', v_rev, 'published', v_prev,
                                 'published_at', v_row -> 'published_at'));
  IF jsonb_array_length(v_hist) > 10 THEN
    v_hist := (SELECT jsonb_agg(e ORDER BY ord DESC)
                 FROM (SELECT e, ord FROM jsonb_array_elements(v_hist)
                         WITH ORDINALITY AS t(e, ord) LIMIT 10) s);
  END IF;

  v_new := jsonb_build_object('revision', v_rev + 1,
                              'draft', v_row -> 'draft',
                              'published', v_row -> 'draft',
                              'published_at', to_jsonb(now()),
                              'published_by', to_jsonb(auth.uid()),
                              'history', v_hist);

  -- Conditional promotion (static per-area branch). Zero rows updated ⇒
  -- a concurrent writer moved the revision ⇒ conflict, no overwrite.
  IF p_area = 'branding' THEN
    UPDATE politicore.public_site_settings SET branding = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(branding ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'navigation' THEN
    UPDATE politicore.public_site_settings SET navigation = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(navigation ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'footer' THEN
    UPDATE politicore.public_site_settings SET footer = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(footer ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'homepage' THEN
    UPDATE politicore.public_site_settings SET homepage = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(homepage ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'contact' THEN
    UPDATE politicore.public_site_settings SET contact = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(contact ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'social_links' THEN
    UPDATE politicore.public_site_settings SET social_links = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(social_links ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'seo' THEN
    UPDATE politicore.public_site_settings SET seo = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(seo ->> 'revision', '0')::integer = p_base_revision;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Configuration conflict: area % was modified concurrently.', p_area;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value)
  VALUES
    (v_tenant, auth.uid(),
     'site_config:' || p_area || ':published',
     'public_site_settings', v_tenant::text,
     jsonb_build_object('revision', v_rev),
     jsonb_build_object('revision', v_rev + 1, 'area', p_area));

  RETURN QUERY SELECT v_rev + 1, now();
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. PUBLIC WRAPPERS (0007/0056 convention) — PostgREST data-API surface
-- ═══════════════════════════════════════════════════════════════════════

-- Public PUBLISHED-ONLY read for website rendering, resolved by the
-- established public-site slug seam (never a client tenant id). SECURITY
-- DEFINER: base-table grants are revoked (§0), so this RPC IS the public
-- read surface; it projects the PUBLISHED state of the requested area
-- only — the draft key never leaves the server, and no other tenant's
-- row is reachable.
CREATE OR REPLACE FUNCTION public.get_published_site_config(
  p_tenant_slug text,
  p_area text
)
RETURNS TABLE (area text, revision integer, published jsonb, published_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, public, pg_temp
AS $$
BEGIN
  IF p_area NOT IN ('branding','navigation','footer','homepage','contact','social_links','seo') THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT %L::text,
            COALESCE((p.%I ->> ''revision'')::integer, 0),
            COALESCE(p.%I -> ''published'', ''{}''::jsonb),
            (p.%I ->> ''published_at'')::timestamptz
       FROM politicore.public_site_settings p
       JOIN politicore.tenants t ON t.id = p.tenant_id
      WHERE t.slug = $1 AND p.%I ? ''published''',
    p_area, p_area, p_area, p_area, p_area)
  USING p_tenant_slug;
END;
$$;

CREATE OR REPLACE FUNCTION public.control_center_overview()
RETURNS TABLE (
  module politicore.module_code_enum, label text, entitled boolean,
  enabled boolean, operational boolean, enabled_at timestamptz, config_revision integer
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.control_center_overview();
$$;

CREATE OR REPLACE FUNCTION public.get_site_config(p_area text)
RETURNS TABLE (area text, revision integer, draft jsonb, published jsonb,
               published_at timestamptz, published_by uuid)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.get_site_config(p_area);
$$;

CREATE OR REPLACE FUNCTION public.save_site_config_draft(
  p_area text, p_draft jsonb, p_base_revision integer)
RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.save_site_config_draft($1, $2, $3);
$$;

CREATE OR REPLACE FUNCTION public.publish_site_config(
  p_area text, p_base_revision integer)
RETURNS TABLE (revision integer, published_at timestamptz)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.publish_site_config($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.set_tenant_module_enabled(
  p_module text, p_enabled boolean)
RETURNS TABLE (module politicore.module_code_enum, entitled boolean,
               enabled boolean, operational boolean)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.set_tenant_module_enabled($1::politicore.module_code_enum, $2);
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. GRANT POSTURE — per the established convention:
--    0000/0006 blanket-grant everything; per-migration REVOKEs narrow.
-- ═══════════════════════════════════════════════════════════════════════

-- Public wrapper (published-only) — the single anonymous-readable surface.
GRANT EXECUTE ON FUNCTION public.get_published_site_config(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.control_center_overview()        TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_site_config(text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_site_config_draft(text, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_site_config(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_tenant_module_enabled(text, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.control_center_overview()          FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.get_site_config(text)              FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.save_site_config_draft(text, jsonb, integer) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.publish_site_config(text, integer) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.set_tenant_module_enabled(text, boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.get_published_site_config(text, text) FROM PUBLIC;

REVOKE ALL ON FUNCTION politicore.service_entitled(politicore.module_code_enum) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.set_tenant_module_enabled(politicore.module_code_enum, boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.control_center_overview() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.get_site_config(text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.save_site_config_draft(text, jsonb, integer) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.publish_site_config(text, integer) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.cc_is_site_config_area(text) FROM anon, PUBLIC;
