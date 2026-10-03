-- ============================================================================
-- POLITICORE — PHASE 26 — CONTROL CENTER ADMINISTRATION INTEGRATION
-- ============================================================================
--
-- Scope per the Phase 26 implementation gate (§6/§18/§19/§20/§34):
--
--   * The Control Center is an ADMINISTRATIVE CONTROL PLANE, not a fifth
--     business module. Nothing here touches module_code_enum, roles,
--     permissions or business tables (§1/§34 stop conditions 1–3).
--   * Administration integration is ORIENTATION + LINK-OUT: module consoles
--     remain the authoritative owners of their domain operations (§3).
--   * The ONE server-side addition authorized by §18 is a bounded,
--     tenant-scoped, read-only, aggregate-only summary RPC so the
--     administration surface can show configuration status WITHOUT five
--     round-trip get_site_config calls (anti-N+1) and WITHOUT exposing any
--     draft/history/revision internals (§20 "status, not a second
--     configuration system").
--
-- PURE CREATE OR REPLACE FUNCTION — zero DDL, zero new tables, zero new
-- roles, zero new permissions. The area list reuses
-- politicore.cc_is_site_config_area (Phase 22/25 authority) — no second
-- activation or area mechanism.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- Configuration status summary (§20).
--
-- For each website configuration area of the CALLER'S tenant (resolved via
-- current_tenant_id() — never a browser-supplied tenant_id, §17), report:
--
--   area          — the canonical configuration area
--   has_config    — a draft OR published payload exists
--   published     — a PUBLISHED payload exists (the public website's state)
--   published_at  — when it was last published (null = never published)
--
-- Deliberately EXCLUDED: draft payloads, history, revisions, publisher ids —
-- status only; the editors (Phases 22–25) remain the sole configuration
-- read/mutate surfaces. Tenant-administration authority is enforced exactly
-- like control_center_overview (§15: is_tenant_admin, no new permission).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.control_center_site_config_status()
RETURNS TABLE (
  area         text,
  has_config   boolean,
  published    boolean,
  published_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF politicore.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  -- §15: Control Center remains tenant-admin controlled through
  -- is_tenant_admin(); no new permission, no new role.
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for Control Center administration.';
  END IF;

  -- Each area column is itself the lifecycle object written by the Phase
  -- 22 RPCs: {revision, draft, published, published_at, history}. Status
  -- reads only the draft/published/published_at facets — never the payload
  -- contents, history or revision internals. The areas LEFT JOIN guarantees
  -- exactly one row per area (all-false when the tenant has no settings
  -- row yet — a pristine tenant is a valid status picture, not an error).
  RETURN QUERY
  WITH areas(area, ord) AS (
    VALUES
      ('branding'::text,   1),
      ('seo'::text,        2),
      ('homepage'::text,   3),
      ('navigation'::text, 4),
      ('footer'::text,     5)
  ),
  s AS (
    SELECT pss.*
      FROM politicore.public_site_settings pss
     WHERE pss.tenant_id = politicore.current_tenant_id()
  ),
  j AS (
    SELECT a.ord,
           a.area,
           CASE a.area
             WHEN 'branding'   THEN s.branding
             WHEN 'seo'        THEN s.seo
             WHEN 'homepage'   THEN s.homepage
             WHEN 'navigation' THEN s.navigation
             WHEN 'footer'     THEN s.footer
           END AS cfg
      FROM areas a
      LEFT JOIN s ON TRUE
  )
  SELECT
    j.area,
    (j.cfg -> 'draft')     IS NOT NULL OR (j.cfg -> 'published') IS NOT NULL,
    (j.cfg -> 'published') IS NOT NULL,
    (j.cfg ->> 'published_at')::timestamptz
  FROM j
  ORDER BY j.ord;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- Public wrapper (Phase 22 convention): SECURITY INVOKER passthrough so the
-- PostgREST surface is schema-qualified as public.* while ALL authority
-- remains inside the SECURITY DEFINER body.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.control_center_site_config_status()
RETURNS TABLE (
  area         text,
  has_config   boolean,
  published    boolean,
  published_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.control_center_site_config_status();
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- ACL discipline (Phase 22 pattern): authenticated may EXECUTE the public
-- wrapper (the SECURITY DEFINER body enforces tenant-admin authority);
-- anon and PUBLIC hold nothing.
-- ─────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.control_center_site_config_status() TO authenticated;

REVOKE ALL ON FUNCTION public.control_center_site_config_status() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.control_center_site_config_status() FROM anon, PUBLIC;
