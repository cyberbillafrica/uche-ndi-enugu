-- =====================================================================
-- 0026: CAMPAIGN COORDINATION + MEMBER DIRECTORY (Phase E)
--       1. campaign_coordination_summary — an ORGANIZATIONAL AGGREGATE
--          over the already-migrated Campaign operational data
--          (members / activities / assignments / reports / issues).
--          Phase E §14: coordination is a composition of existing
--          Campaign/Core data — no campaign_coordination table, no new
--          settings, no second implementation of any module.
--       2. public.* wrapper (0015/0023/0024 convention).
--       No table or RLS changes: the member directory is the existing
--       campaign_members_in_scope RPC (0021, wrapped in 0024) over the
--       profiles RLS (0002) and the politicore_profiles view (0009);
--       organizational assignments remain the Core model (§12), read
--       through Core RLS. Coordination authority is admin/state/campaign
--       tenant-wide or view_area at a covered scope.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. campaign_coordination_summary — scoped aggregate for the caller.
--    Visibility mirrors the directory model: authority is resolved
--    server-side (never from route parameters, §15); higher scopes
--    cover descendants via scope_covers; cross-tenant rows are silent
--    by construction (every subquery is tenant-pinned).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_coordination_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_tenant_wide boolean;
  v_counts jsonb;
BEGIN
  IF auth.uid() IS NULL
     OR NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'not authorized to view campaign coordination'
      USING ERRCODE = '42501';
  END IF;

  -- Tenant-wide authority: admin, or an active campaign/state scope.
  -- Non-admin callers without any organizational scope are refused:
  -- coordination is an organizational operating view, not a member feed.
  SELECT politicore.is_admin()
      OR EXISTS (SELECT 1 FROM politicore.my_scopes() s
                 WHERE s.scope_type IN ('campaign','state'))
    INTO v_tenant_wide;

  IF NOT v_tenant_wide
     AND NOT EXISTS (SELECT 1 FROM politicore.my_scopes()
                     WHERE scope_type IN ('senatorial_zone','lga','ward','polling_unit')) THEN
    RAISE EXCEPTION 'not authorized to view campaign coordination'
      USING ERRCODE = '42501';
  END IF;

  -- -----------------------------------------------------------------
  -- Member population: same semantics as campaign_members_in_scope —
  -- tenant-wide branch for admin/state authority; covered-registered-
  -- location branch for zone/LGA/ward/PU scopes.
  -- -----------------------------------------------------------------
  WITH member_pool AS (
    SELECT pr.id
    FROM politicore.profiles pr
    WHERE pr.tenant_id = v_tenant
      AND 'campaign_member' = ANY(pr.membership_types)
      AND (
        v_tenant_wide
        OR EXISTS (
          SELECT 1
          FROM politicore.my_scopes() s
          WHERE s.scope_type IN ('senatorial_zone','lga','ward','polling_unit')
            AND (
              (s.scope_type = 'senatorial_zone'
               AND (politicore.scope_covers(s.scope_type, s.scope_id, 'lga', pr.lga_id)
                    OR politicore.scope_covers(s.scope_type, s.scope_id, 'ward', pr.ward_id)
                    OR politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id)))
              OR (s.scope_type = 'lga'
                  AND (politicore.scope_covers(s.scope_type, s.scope_id, 'lga', pr.lga_id)
                       OR politicore.scope_covers(s.scope_type, s.scope_id, 'ward', pr.ward_id)
                       OR politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id)))
              OR (s.scope_type = 'ward'
                  AND (politicore.scope_covers(s.scope_type, s.scope_id, 'ward', pr.ward_id)
                       OR politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id)))
              OR (s.scope_type = 'polling_unit'
                  AND politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id))
            )
        )
      )
  )
  SELECT jsonb_build_object(
    'members', (SELECT count(*) FROM member_pool),

    'activities', (
      SELECT jsonb_build_object(
        'total', count(*),
        'scheduled', count(*) FILTER (WHERE a.status = 'scheduled'),
        'postponed', count(*) FILTER (WHERE a.status = 'postponed'),
        'cancelled', count(*) FILTER (WHERE a.status = 'cancelled'),
        'completed', count(*) FILTER (WHERE a.status = 'completed'))
      FROM politicore.campaign_activities a
      WHERE a.tenant_id = v_tenant
        AND (v_tenant_wide OR EXISTS (
          SELECT 1 FROM politicore.my_scopes() s
          WHERE politicore.scope_covers(s.scope_type, s.scope_id,
                                        a.scope_type, a.scope_id)))),
    'assignments', (
      SELECT jsonb_build_object(
        'total', count(*),
        'not_started', count(*) FILTER (WHERE g.status = 'not_started'),
        'in_progress', count(*) FILTER (WHERE g.status = 'in_progress'),
        'submitted',   count(*) FILTER (WHERE g.status = 'submitted'),
        'under_review',count(*) FILTER (WHERE g.status = 'under_review'),
        'completed',   count(*) FILTER (WHERE g.status = 'completed'),
        'overdue',     count(*) FILTER (WHERE g.status = 'overdue'))
      FROM politicore.campaign_assignments g
      WHERE g.tenant_id = v_tenant
        AND (v_tenant_wide OR EXISTS (
          SELECT 1 FROM politicore.my_scopes() s
          WHERE politicore.scope_covers(s.scope_type, s.scope_id,
                                        g.scope_type, g.scope_id)))),
    'reports', (
      SELECT jsonb_build_object(
        'total',        count(*),
        'submitted',    count(*) FILTER (WHERE r.status = 'submitted'),
        'under_review', count(*) FILTER (WHERE r.status = 'under_review'),
        'accepted',     count(*) FILTER (WHERE r.status = 'accepted'),
        'returned',     count(*) FILTER (WHERE r.status = 'returned'))
      FROM politicore.campaign_field_reports r
      WHERE r.tenant_id = v_tenant
        AND (v_tenant_wide OR EXISTS (
          SELECT 1 FROM politicore.my_scopes() s
          WHERE politicore.scope_covers(s.scope_type, s.scope_id,
                                        r.scope_type, r.scope_id)))),
    'issues', (
      SELECT jsonb_build_object(
        'total',       count(*),
        'open',        count(*) FILTER (WHERE i.status NOT IN ('closed')),
        'reported',    count(*) FILTER (WHERE i.status = 'reported'),
        'acknowledged',count(*) FILTER (WHERE i.status = 'acknowledged'),
        'assigned',    count(*) FILTER (WHERE i.status = 'assigned'),
        'in_progress', count(*) FILTER (WHERE i.status = 'in_progress'),
        'resolved',    count(*) FILTER (WHERE i.status = 'resolved'),
        'verified',    count(*) FILTER (WHERE i.status = 'verified'),
        'closed',      count(*) FILTER (WHERE i.status = 'closed'))
      FROM politicore.campaign_issues i
      WHERE i.tenant_id = v_tenant
        AND (v_tenant_wide OR EXISTS (
          SELECT 1 FROM politicore.my_scopes() s
          WHERE politicore.scope_covers(s.scope_type, s.scope_id,
                                        i.scope_type, i.scope_id))))
  )
  INTO v_counts;

  RETURN v_counts;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. public wrapper (thin SECURITY INVOKER — the politicore RPC above
--    is authoritative; PostgREST resolves public.* only).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_coordination_summary()
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.campaign_coordination_summary();
$$;

GRANT EXECUTE ON FUNCTION public.campaign_coordination_summary()
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Directory hardening (Phase E §8/§30/§31): server-side search,
--    narrowing geographic filters, stable ordering and clamped
--    pagination over the EXISTING authoritative directory RPC.
--
--    Composition, not duplication: campaign_members_in_scope() (0021)
--    remains the only authority boundary — these wrappers call it and
--    can only NARROW its result. No re-issued authorization, no client
--    fan-out, and page boundaries cannot leak unauthorized scopes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_members_page(
  p_search   text    DEFAULT NULL,
  p_lga_id   text    DEFAULT NULL,
  p_ward_id  text    DEFAULT NULL,
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
)
RETURNS TABLE (
  id            uuid,
  full_name     text,
  email         text,
  phone         text,
  position_name text,
  scope_type    politicore.scope_type_enum,
  scope_id      text,
  lga_id        text,
  ward_id       text,
  polling_unit_id text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = politicore, auth, pg_temp
AS $$
  SELECT m.id, m.full_name, m.email, m.phone, m.position_name, m.scope_type, m.scope_id,
         pr.lga_id, pr.ward_id, pr.polling_unit_id
  FROM politicore.campaign_members_in_scope() m
  JOIN politicore.profiles pr ON pr.id = m.id
  WHERE (p_search IS NULL OR p_search = ''
         OR m.full_name ILIKE '%' || p_search || '%'
         OR m.email    ILIKE '%' || p_search || '%'
         OR (m.phone IS NOT NULL AND m.phone ILIKE '%' || p_search || '%'))
    -- Registered-location narrowing (§30): applied to the ALREADY-
    -- authorized member set, so an unauthorized ward/LGA filter can
    -- only produce an empty page — never an unauthorized population.
    AND (p_lga_id IS NULL OR pr.lga_id = p_lga_id)
    AND (p_ward_id IS NULL OR pr.ward_id = p_ward_id)
  ORDER BY m.full_name ASC, m.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$$;

-- Total (post-search) count for pagination UIs. Same authority gate via
-- the composed definer RPC: unauthorized callers error out identically.
CREATE OR REPLACE FUNCTION politicore.campaign_members_page_count(
  p_search  text DEFAULT NULL,
  p_lga_id  text DEFAULT NULL,
  p_ward_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = politicore, auth, pg_temp
AS $$
  SELECT count(*)::integer
  FROM politicore.campaign_members_in_scope() m
  WHERE (p_search IS NULL OR p_search = ''
         OR m.full_name ILIKE '%' || p_search || '%'
         OR m.email    ILIKE '%' || p_search || '%'
         OR (m.phone IS NOT NULL AND m.phone ILIKE '%' || p_search || '%'))
    AND (p_lga_id IS NULL OR EXISTS (
      SELECT 1 FROM politicore.profiles pr
      WHERE pr.id = m.id AND pr.lga_id = p_lga_id))
    AND (p_ward_id IS NULL OR EXISTS (
      SELECT 1 FROM politicore.profiles pr
      WHERE pr.id = m.id AND pr.ward_id = p_ward_id));
$$;

CREATE OR REPLACE FUNCTION public.campaign_members_page(
  p_search text, p_lga_id text, p_ward_id text, p_limit integer, p_offset integer
)
RETURNS TABLE (
  id            uuid,
  full_name     text,
  email         text,
  phone         text,
  position_name text,
  scope_type    politicore.scope_type_enum,
  scope_id      text,
  lga_id        text,
  ward_id       text,
  polling_unit_id text
)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT * FROM politicore.campaign_members_page(p_search, p_lga_id, p_ward_id, p_limit, p_offset);
$$;

CREATE OR REPLACE FUNCTION public.campaign_members_page_count(
  p_search text, p_lga_id text, p_ward_id text
)
RETURNS integer
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.campaign_members_page_count(p_search, p_lga_id, p_ward_id);
$$;

GRANT EXECUTE ON FUNCTION public.campaign_members_page(text, text, text, integer, integer)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.campaign_members_page_count(text, text, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Organizational-assignment DISPLAY view (§12/§26): coordination and
--    the directory surface READ Core organizational_assignments through
--    the existing model — they never write it. security_invoker keeps
--    the Core RLS (own rows + tenant admins + platform admin) as the
--    exact boundary; the grant is SELECT-only, so the auto-updatable
--    view exposes NO mutation path (§28). Assignment administration
--    remains a Core operation outside Campaign.
--
--    HOSTED FINDING (Phase E smoke, L2/L3): the hosted project carried a
--    PRE-EXISTING public.organizational_assignments view with FULL DML
--    grants to anon/authenticated (legacy provisioning artifact).
--    CREATE OR REPLACE VIEW keeps existing grants, so the view is
--    dropped and recreated here and all mutation privileges are
--    explicitly revoked — the API surface becomes read-only by grant.
-- ---------------------------------------------------------------------
DO $view$
DECLARE
  v_kind text;
BEGIN
  SELECT c.relkind::text INTO v_kind
  FROM pg_class c WHERE c.oid = to_regclass('public.organizational_assignments');
  IF v_kind IS NOT NULL AND v_kind <> 'v' THEN
    RAISE EXCEPTION
      'public.organizational_assignments is a % — refusing to replace non-view relation', v_kind;
  END IF;
  DROP VIEW IF EXISTS public.organizational_assignments;
END
$view$;

CREATE OR REPLACE VIEW public.organizational_assignments
  WITH (security_invoker = true) AS SELECT * FROM politicore.organizational_assignments;

REVOKE ALL ON public.organizational_assignments FROM anon;
REVOKE ALL ON public.organizational_assignments FROM authenticated;
GRANT SELECT ON public.organizational_assignments TO authenticated, service_role;
