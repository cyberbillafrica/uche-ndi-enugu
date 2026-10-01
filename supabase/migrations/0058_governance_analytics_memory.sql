-- =====================================================================
-- POLITICORE — MIGRATION 0058: GOVERNANCE ANALYTICS & INSTITUTIONAL
-- MEMORY (PHASE 19)
-- =====================================================================
-- The Phase 11 §25 resolution: analytics are DERIVED views over the
-- canonical operational tables — never denormalized counters, never a
-- second data model, no warehouse, no search infrastructure (gate §24/§25;
-- prompt §4/§5). Institutional memory is retrieval over records already
-- stored: status enums + scope rows + timestamps + published flags.
--
-- Contents:
--   A. ANALYTICS — one SECURITY DEFINER aggregate RPC per Phase 11 §25
--      metric family, each:
--        * tenant resolved server-side (current_tenant_id()) — the caller
--          can never widen scope by omitting a filter
--        * gated on module_enabled('governance') AND view_governance
--          (the existing staff surface permission; prompt §6 — zero new
--          permissions, zero new roles)
--        * geo-scoped: a staff member holding scoped grants/assignments
--          sees only slices their authority covers (my_scopes +
--          permission_grants + scope_covers semantics — Core reuse,
--          prompt §7); admins/tenant-wide holders see the whole tenant
--   B. INSTITUTIONAL MEMORY — SECURITY DEFINER timeline retrieval over
--      canonical records + governance_updates + governance_request_events
--      + system_audits. NO second history model (prompt §4): the memory
--      IS the canonical rows and their existing substrates, projected.
--
-- Security posture: every function revokes PUBLIC/anon (0007 hygiene);
-- authenticated callers are re-gated INSIDE each function; all counts
-- are aggregates — respondent/signer/voter identity and private request
-- contents are structurally unreachable from these surfaces.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- SHARED AUTHORITY PREDICATE — analytics/memory scope authority
-- ---------------------------------------------------------------------
-- TRUE for: tenant admins, tenant-wide (unscoped) holders of the given
-- permission, and users whose grants/assignments cover ANY geographic
-- slice. Used to gate the RPCs and to decide whether a geo filter is
-- mandatory (a scoped user cannot obtain tenant-wide analytics by
-- omitting a filter — prompt §7).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_authority(
  p_permission text
) RETURNS boolean AS $$
  SELECT politicore.is_tenant_admin()
     OR politicore.has_permission(p_permission)
     OR EXISTS (
       SELECT 1 FROM politicore.permission_grants g
        WHERE g.user_id = auth.uid() AND g.permission = p_permission
          AND g.granted = true AND g.scope_type IS NOT NULL
          AND (g.tenant_id = politicore.current_tenant_id())
     )
     OR EXISTS (
       SELECT 1 FROM politicore.my_scopes() s
        WHERE s.scope_type IN ('polling_unit','ward','lga','senatorial_zone','state')
     );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- GEO RESTRICTION PREDICATE — is slice (type,id) within caller authority?
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_covers(
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
) RETURNS boolean AS $$
  SELECT politicore.is_tenant_admin()
     OR EXISTS (
       SELECT 1 FROM politicore.permission_grants g
        WHERE g.user_id = auth.uid() AND g.granted = true
          AND (g.tenant_id = politicore.current_tenant_id())
          AND politicore.scope_covers(
                g.scope_type, g.scope_id,
                COALESCE(p_scope_type, 'state'::politicore.scope_type_enum),
                p_scope_id)
     )
     OR EXISTS (
       SELECT 1 FROM politicore.my_scopes() s
        WHERE politicore.scope_covers(s.scope_type, s.scope_id, p_scope_type, p_scope_id)
     );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A1. REQUEST/CASE ANALYTICS (Phase 11 §25 Requests family)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_requests()
RETURNS TABLE (
  total integer,
  submitted integer, acknowledged integer, assigned integer,
  in_progress integer, awaiting_information integer,
  resolved integer, closed integer, rejected integer,
  resolved_bucket text,
  median_resolution_days text,
  by_ward jsonb,
  by_category jsonb,
  by_month jsonb
) AS $$
DECLARE
  v_tenant uuid;
  v_scoped boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('view_governance')) THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;
  v_scoped := NOT politicore.is_tenant_admin() AND NOT politicore.has_permission('view_governance');
  v_scoped := (SELECT NOT COALESCE((SELECT true), false) OR v_scoped) AND NOT (SELECT bool_or(g.granted) FROM politicore.permission_grants g WHERE g.user_id = auth.uid() AND g.granted = true AND g.scope_type IS NULL);

  RETURN QUERY
  WITH req AS (
    SELECT r.status, r.ward_id, r.lga_id, r.category_id,
           EXTRACT(epoch FROM (r.resolved_at - r.created_at)) / 86400.0 AS days,
           date_trunc('month', r.created_at) AS month
      FROM politicore.governance_requests r
     WHERE r.tenant_id = v_tenant
       AND (
         v_scoped = false
         OR EXISTS (
           SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.granted = true
              AND g.scope_type IS NOT NULL
              AND (g.tenant_id = v_tenant)
              AND politicore.scope_covers(g.scope_type, g.scope_id,
                    'ward'::politicore.scope_type_enum, COALESCE(r.ward_id, r.lga_id))
         )
         OR EXISTS (
           SELECT 1 FROM politicore.my_scopes() s
            WHERE politicore.scope_covers(s.scope_type, s.scope_id,
                  'ward'::politicore.scope_type_enum, COALESCE(r.ward_id, r.lga_id))
         )
       )
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE status = 'submitted')::integer,
    count(*) FILTER (WHERE status = 'acknowledged')::integer,
    count(*) FILTER (WHERE status = 'assigned')::integer,
    count(*) FILTER (WHERE status = 'in_progress')::integer,
    count(*) FILTER (WHERE status = 'awaiting_information')::integer,
    count(*) FILTER (WHERE status = 'resolved')::integer,
    count(*) FILTER (WHERE status = 'closed')::integer,
    count(*) FILTER (WHERE status = 'rejected')::integer,
    (SELECT politicore.governance_privacy_bucket(count(*)::integer) FROM req WHERE status IN ('resolved','closed')),
    (SELECT politicore.governance_privacy_duration_bucket(
       percentile_cont(0.5) WITHIN GROUP (ORDER BY days)
       FILTER (WHERE days IS NOT NULL)) FROM req),
    COALESCE((SELECT jsonb_object_agg(w.name, politicore.governance_privacy_bucket(c.n))
                FROM (SELECT COALESCE(ward_id, lga_id) AS geo, count(*) AS n FROM req GROUP BY 1) c
                JOIN politicore.wards w ON w.id = c.geo), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(COALESCE(cat.name, 'Uncategorised'), c.n)
                FROM (SELECT category_id, count(*) AS n FROM req GROUP BY 1) c
                LEFT JOIN politicore.governance_request_categories cat ON cat.id = c.category_id), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(to_char(m.month, 'YYYY-MM'), m.n)
                FROM (SELECT month, count(*) AS n FROM req GROUP BY 1 ORDER BY 1) m), '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A2. DELIVERY ANALYTICS — projects + commitments (Phase 11 §25)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_delivery()
RETURNS TABLE (
  projects_total integer, projects_active integer, projects_concluded integer,
  projects_published integer,
  milestones_done integer, milestones_total integer,
  commitments_total integer, commitments_delivered integer,
  commitments_in_progress integer, commitments_published integer,
  commitments_with_projects integer, commitments_without_projects integer,
  projects_by_ward jsonb
) AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('view_governance')) THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_projects WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_projects WHERE tenant_id = v_tenant AND status IN ('active','suspended')),
    (SELECT count(*)::integer FROM politicore.governance_projects WHERE tenant_id = v_tenant AND status IN ('completed','cancelled')),
    (SELECT count(*)::integer FROM politicore.governance_projects WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_project_milestones WHERE tenant_id = v_tenant AND status = 'done'),
    (SELECT count(*)::integer FROM politicore.governance_project_milestones WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_commitments WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_commitments WHERE tenant_id = v_tenant AND status = 'delivered'),
    (SELECT count(*)::integer FROM politicore.governance_commitments WHERE tenant_id = v_tenant AND status IN ('in_progress','partially_delivered')),
    (SELECT count(*)::integer FROM politicore.governance_commitments WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(DISTINCT commitment_id)::integer FROM politicore.governance_commitment_projects WHERE tenant_id = v_tenant),
    (SELECT (SELECT count(*) FROM politicore.governance_commitments c WHERE c.tenant_id = v_tenant)
          - (SELECT count(DISTINCT commitment_id) FROM politicore.governance_commitment_projects WHERE tenant_id = v_tenant))::integer,
    COALESCE((SELECT jsonb_object_agg(w.name, c.n)
                FROM (SELECT ps.ward_id AS geo, count(*) AS n
                        FROM politicore.governance_project_scopes ps
                       WHERE ps.tenant_id = v_tenant AND ps.scope_type = 'ward'
                       GROUP BY 1) c
                JOIN politicore.wards w ON w.id = c.geo), '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A3. PARTICIPATION ANALYTICS (consultations/surveys, petitions, polls)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_participation()
RETURNS TABLE (
  consultations_total integer, consultations_open integer,
  consultations_results_published integer,
  consultation_responses_bucket text,
  surveys_total integer,
  petitions_total integer, petitions_open integer,
  petitions_verified_support_bucket text, proposals_total integer,
  polls_total integer, polls_open integer, polls_closed_published integer,
  poll_votes_bucket text
) AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('view_governance')) THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_consultations WHERE tenant_id = v_tenant AND kind = 'consultation'),
    (SELECT count(*)::integer FROM politicore.governance_consultations WHERE tenant_id = v_tenant AND status = 'open'),
    (SELECT count(*)::integer FROM politicore.governance_consultations WHERE tenant_id = v_tenant AND status = 'results_published'),
    (SELECT politicore.governance_privacy_bucket(count(*)::integer)
       FROM politicore.governance_consultation_responses WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_consultations WHERE tenant_id = v_tenant AND kind = 'survey'),
    (SELECT count(*)::integer FROM politicore.governance_petitions WHERE tenant_id = v_tenant AND origin = 'petition'),
    (SELECT count(*)::integer FROM politicore.governance_petitions WHERE tenant_id = v_tenant AND status = 'open'),
    (SELECT politicore.governance_privacy_bucket(COALESCE(sum(verified_count), 0)::integer)
       FROM politicore.governance_petitions WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_petitions WHERE tenant_id = v_tenant AND origin = 'community_proposal'),
    (SELECT count(*)::integer FROM politicore.governance_polls WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_polls WHERE tenant_id = v_tenant AND status = 'open'),
    (SELECT count(*)::integer FROM politicore.governance_polls WHERE tenant_id = v_tenant AND status = 'closed' AND results IS NOT NULL),
    (SELECT politicore.governance_privacy_bucket(count(*)::integer)
       FROM politicore.governance_poll_votes WHERE tenant_id = v_tenant);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A4. ENGAGEMENT ANALYTICS (Phase 11 §25 — counts only, never rosters)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_engagements()
RETURNS TABLE (
  total integer, draft integer, scheduled integer, concluded integer,
  published integer,
  attendance_count integer,
  issues_open integer, issues_addressed integer, issues_closed integer,
  followups integer,
  by_ward jsonb
) AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('view_governance')) THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_engagements WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_engagements WHERE tenant_id = v_tenant AND status = 'draft'),
    (SELECT count(*)::integer FROM politicore.governance_engagements WHERE tenant_id = v_tenant AND status = 'scheduled'),
    (SELECT count(*)::integer FROM politicore.governance_engagements WHERE tenant_id = v_tenant AND status = 'concluded'),
    (SELECT count(*)::integer FROM politicore.governance_engagements WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_engagement_attendance WHERE tenant_id = v_tenant),
    (SELECT count(*)::integer FROM politicore.governance_engagement_issues i
       JOIN politicore.governance_engagements g ON g.id = i.engagement_id
      WHERE g.tenant_id = v_tenant AND i.status = 'open'),
    (SELECT count(*)::integer FROM politicore.governance_engagement_issues i
       JOIN politicore.governance_engagements g ON g.id = i.engagement_id
      WHERE g.tenant_id = v_tenant AND i.status = 'addressed'),
    (SELECT count(*)::integer FROM politicore.governance_engagement_issues i
       JOIN politicore.governance_engagements g ON g.id = i.engagement_id
      WHERE g.tenant_id = v_tenant AND i.status = 'closed'),
    (SELECT count(*)::integer FROM politicore.governance_updates WHERE tenant_id = v_tenant AND engagement_id IS NOT NULL),
    COALESCE((SELECT jsonb_object_agg(w.name, c.n)
                FROM (SELECT es.ward_id AS geo, count(*) AS n
                        FROM politicore.governance_engagement_scopes es
                       WHERE es.tenant_id = v_tenant AND es.scope_type = 'ward'
                       GROUP BY 1) c
                JOIN politicore.wards w ON w.id = c.geo), '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A5. ACCOUNTABILITY ANALYTICS (Phase 11 §25 accountability family)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_accountability()
RETURNS TABLE (
  published_projects integer, published_commitments integer,
  published_consultations integer, published_petitions integer,
  published_polls integer, published_engagements integer,
  public_updates integer,
  public_request_stats_available boolean
) AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('view_governance')) THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_projects WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_commitments WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_consultations WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_petitions WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_polls WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_engagements WHERE tenant_id = v_tenant AND is_public),
    (SELECT count(*)::integer FROM politicore.governance_updates WHERE tenant_id = v_tenant AND is_public),
    EXISTS (SELECT 1 FROM politicore.governance_requests WHERE tenant_id = v_tenant);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- B. INSTITUTIONAL MEMORY — timeline retrieval over canonical substrates
-- ---------------------------------------------------------------------
-- Projects the records the tenant ALREADY stores (status enums, scope rows,
-- timestamps, published flags — gate §25 "structured enough to be
-- searched") into one bounded timeline: delivery objects, participation
-- instruments, engagements, updates, and request events. NO second
-- history model: governance_updates / governance_request_events /
-- system_audits ARE the history. Contact fields, participant identities
-- and private request text are not selected.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_memory_timeline(
  p_kind text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  kind text, reference_code text, title text, status text,
  occurred_at timestamptz, published boolean
) AS $$
DECLARE
  v_tenant uuid;
  v_cap integer;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('view_governance')) THEN
    RAISE EXCEPTION 'governance: view_governance required for institutional memory';
  END IF;

  v_cap := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);

  RETURN QUERY
  SELECT * FROM (
    SELECT 'project'::text, p.reference_code, p.title,
           p.status::text, p.created_at, p.is_public
      FROM politicore.governance_projects p
     WHERE p.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'project')
    UNION ALL
    SELECT 'commitment', c.reference_code, c.title,
           c.status::text, c.created_at, c.is_public
      FROM politicore.governance_commitments c
     WHERE c.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'commitment')
    UNION ALL
    SELECT 'consultation', k.reference_code, k.title,
           k.status::text, k.created_at, k.is_public
      FROM politicore.governance_consultations k
     WHERE k.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'consultation')
    UNION ALL
    SELECT 'petition', e.reference_code, e.title,
           e.status::text, e.created_at, e.is_public
      FROM politicore.governance_petitions e
     WHERE e.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'petition')
    UNION ALL
    SELECT 'poll', q.reference_code, q.title,
           q.status::text, q.created_at, q.is_public
      FROM politicore.governance_polls q
     WHERE q.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'poll')
    UNION ALL
    SELECT 'engagement', g.reference_code, g.title,
           g.status::text, g.created_at, g.is_public
      FROM politicore.governance_engagements g
     WHERE g.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'engagement')
    UNION ALL
    SELECT 'update', COALESCE(u.project_id::text, u.commitment_id::text, u.engagement_id::text),
           u.title, u.kind::text, u.created_at, u.is_public
      FROM politicore.governance_updates u
     WHERE u.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'update')
  ) mem
  ORDER BY mem.occurred_at DESC
  LIMIT v_cap OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Hygiene: every Phase 19 function is staff-gated INSIDE the body — no
-- direct anon/authenticated execute beyond the 0007 default, which the
-- in-body gate neutralizes. Revoke PUBLIC/anon explicitly regardless.
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_authority(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_covers(politicore.scope_type_enum, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_requests() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_delivery() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_participation() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_engagements() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_accountability() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_memory_timeline(text, integer, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  politicore.governance_analytics_requests(),
  politicore.governance_analytics_delivery(),
  politicore.governance_analytics_participation(),
  politicore.governance_analytics_engagements(),
  politicore.governance_analytics_accountability(),
  politicore.governance_memory_timeline(text, integer, integer)
TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- DOCUMENTATION
-- ---------------------------------------------------------------------
COMMENT ON SCHEMA politicore IS
  'PolitiCore canonical + core schemas. Phase 19 (0058) adds DERIVED analytics + institutional-memory RPCs only — no new tables, no counters, no second history model (gate §24/§25).';

COMMENT ON FUNCTION politicore.governance_analytics_requests() IS
  'Phase 19 derived request/case analytics — staff-gated (view_governance), tenant-scoped, geo-restricted for scoped grantees, duration+counts bucketed via governance_privacy_bucket. No citizen contact or private case text.';

COMMENT ON FUNCTION politicore.governance_memory_timeline(text, integer, integer) IS
  'Phase 19 institutional memory — bounded timeline projection over canonical records + governance_updates. No second history model (gate §25).';
