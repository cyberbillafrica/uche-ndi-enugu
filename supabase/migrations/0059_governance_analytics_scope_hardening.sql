-- =====================================================================
-- POLITICORE — MIGRATION 0059: GOVERNANCE ANALYTICS SCOPE HARDENING
-- (PHASE 19 CONVERGENCE)
-- =====================================================================
-- 0058 shipped the Phase 19 derived analytics + institutional memory
-- RPCs. Post-ship audit found one real gap against the authorization
-- contract (Phase 19 prompt §7):
--
--   * politicore.has_permission('view_governance') — the BARE form —
--     returns TRUE for a POSITION-DEFAULT holder at ANY geographic
--     scope (the position-default branch skips scope_covers when no
--     target scope is passed). A ward-scoped staffer could therefore
--     obtain TENANT-WIDE aggregates, and four of the five analytics
--     RPCs plus the memory timeline applied no geographic filter at
--     all.
--
-- This migration redefines the two 0058 authority helpers and restates
-- all six surfaces with the corrected model. Function SIGNATURES are
-- unchanged — the application service layer is unaffected.
--
-- Corrected authorization model (Core reuse only — no new geography
-- logic, no new permissions, no new roles):
--
--   TENANT-WIDE caller   is_tenant_admin / is_platform_admin, or an
--                        EXPLICIT UNSCOPED (tenant-wide) grant of
--                        view_governance. Position defaults NEVER
--                        confer tenant-wide analytics (they are
--                        inherently scoped — that is the §7 fix).
--   SCOPED caller        sees ONLY the geographic slices their
--                        authority covers, per row, via the existing
--                        Core resolver has_permission(perm, scope,
--                        id) — which honors scoped explicit grants,
--                        position defaults at a covering scope, and
--                        deny-wins — plus scope_covers/my_scopes.
--   UNCOVERED ROWS       entities with no covered scope row (incl.
--                        scope-less entities) are invisible to
--                        scoped callers — fail closed.
--
-- Every count remains a DERIVED aggregate over canonical tables. No
-- new tables, no counters, no second history model.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- A1. TENANT-WIDE AUTHORITY — may this caller see the WHOLE tenant?
-- ---------------------------------------------------------------------
-- TRUE only for tenant/platform admins or an explicit UNSCOPED grant
-- of the permission. Position-default holders are deliberately
-- excluded: their authority is geographic by definition (prompt §7:
-- "a scoped user must not obtain tenant-wide analytics").
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_tenant_wide(
  p_permission text
) RETURNS boolean AS $$
  SELECT politicore.is_tenant_admin()
     OR politicore.is_platform_admin()
     OR (EXISTS (
           SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.permission = p_permission
              AND g.granted = true AND g.scope_type IS NULL
              AND (g.tenant_id = politicore.current_tenant_id())
         )
         AND NOT EXISTS (
           SELECT 1 FROM politicore.permission_grants d
            WHERE d.user_id = auth.uid() AND d.permission = p_permission
              AND d.granted = false AND d.scope_type IS NULL
              AND (d.tenant_id = politicore.current_tenant_id())
         ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A2. ROW COVERAGE — may this caller see the slice (type, id)?
-- ---------------------------------------------------------------------
-- TRUE for tenant-wide callers (short-circuit), else the Core resolver
-- evaluated AT the target scope: explicit scoped grants, position
-- defaults at a covering scope, deny-wins — has_permission(perm,
-- scope, id) semantics, exactly as RLS uses them elsewhere.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_row_covers(
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
) RETURNS boolean AS $$
  SELECT politicore.governance_analytics_tenant_wide('view_governance')
     OR (p_scope_type IS NOT NULL AND p_scope_id IS NOT NULL
         AND politicore.has_permission('view_governance', p_scope_type, p_scope_id));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Typed-column form for the governance *_scopes child tables (whose
-- shape CHECK stores one id per scope_type across state_id/zone_id/
-- lga_id/ward_id/polling_unit_id — there is no scope_id column).
CREATE OR REPLACE FUNCTION politicore.governance_analytics_row_covers_typed(
  p_scope_type politicore.scope_type_enum,
  p_state_id text, p_zone_id text, p_lga_id text,
  p_ward_id text, p_polling_unit_id text
) RETURNS boolean AS $$
  SELECT politicore.governance_analytics_row_covers(
    p_scope_type,
    CASE p_scope_type
      WHEN 'state' THEN p_state_id
      WHEN 'senatorial_zone' THEN p_zone_id
      WHEN 'lga' THEN p_lga_id
      WHEN 'ward' THEN p_ward_id
      WHEN 'polling_unit' THEN p_polling_unit_id
    END);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- A3. GATE — shared analytics/memory authority test (hardened)
-- ---------------------------------------------------------------------
-- Supersedes the 0058 helper of the same name (which admitted
-- position-default holders at any scope via the bare has_permission).
-- TRUE for tenant-wide callers, holders of a SCOPED explicit grant of
-- the permission, and position-default holders whose active
-- assignments carry the permission AT their scope. Scoped callers are
-- then per-row restricted by governance_analytics_row_covers.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_analytics_authority(
  p_permission text
) RETURNS boolean AS $$
  SELECT politicore.governance_analytics_tenant_wide(p_permission)
     OR (EXISTS (
           SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.permission = p_permission
              AND g.granted = true AND g.scope_type IS NOT NULL
              AND (g.tenant_id = politicore.current_tenant_id())
         )
         AND NOT EXISTS (
           SELECT 1 FROM politicore.permission_grants d
            WHERE d.user_id = auth.uid() AND d.permission = p_permission
              AND d.granted = false AND d.scope_type IS NOT NULL
              AND (d.tenant_id = politicore.current_tenant_id())
         ))
     OR EXISTS (
       SELECT 1 FROM politicore.my_scopes() s
        WHERE s.scope_type IN ('polling_unit','ward','lga','senatorial_zone','state')
          AND politicore.has_permission(p_permission, s.scope_type, s.scope_id)
     );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Legacy 0058 name kept delegating (never used by the aggregates;
-- restated so no stale permissive predicate remains queryable).
CREATE OR REPLACE FUNCTION politicore.governance_analytics_covers(
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
) RETURNS boolean AS $$
  SELECT politicore.governance_analytics_row_covers(p_scope_type, p_scope_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- B1. REQUEST/CASE ANALYTICS — per-row geographic coverage
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
  v_wide   boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.governance_analytics_authority('view_governance') THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;
  v_wide := politicore.governance_analytics_tenant_wide('view_governance');

  RETURN QUERY
  WITH req AS (
    SELECT r.status, r.ward_id, r.lga_id, r.category_id,
           EXTRACT(epoch FROM (r.resolved_at - r.created_at)) / 86400.0 AS days,
           date_trunc('month', r.created_at) AS month
      FROM politicore.governance_requests r
     WHERE r.tenant_id = v_tenant
       AND (v_wide OR politicore.governance_analytics_row_covers(
              CASE WHEN r.ward_id IS NOT NULL THEN 'ward'::politicore.scope_type_enum
                   WHEN r.lga_id IS NOT NULL THEN 'lga'::politicore.scope_type_enum
                   END,
              COALESCE(r.ward_id, r.lga_id)))
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE req.status = 'submitted')::integer,
    count(*) FILTER (WHERE req.status = 'acknowledged')::integer,
    count(*) FILTER (WHERE req.status = 'assigned')::integer,
    count(*) FILTER (WHERE req.status = 'in_progress')::integer,
    count(*) FILTER (WHERE req.status = 'awaiting_information')::integer,
    count(*) FILTER (WHERE req.status = 'resolved')::integer,
    count(*) FILTER (WHERE req.status = 'closed')::integer,
    count(*) FILTER (WHERE req.status = 'rejected')::integer,
    (SELECT politicore.governance_privacy_bucket(count(*)::integer) FROM req WHERE req.status IN ('resolved','closed')),
    (SELECT politicore.governance_privacy_duration_bucket(
       (percentile_cont(0.5) WITHIN GROUP (ORDER BY req.days)
       FILTER (WHERE req.days IS NOT NULL))::numeric) FROM req),
    COALESCE((SELECT jsonb_object_agg(w.name, politicore.governance_privacy_bucket(c.n::integer))
                FROM (SELECT COALESCE(ward_id, lga_id) AS geo, count(*) AS n FROM req GROUP BY 1) c
                JOIN politicore.wards w ON w.id = c.geo), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(COALESCE(cat.name, 'Uncategorised'), c.n)
                FROM (SELECT category_id, count(*) AS n FROM req GROUP BY 1) c
                LEFT JOIN politicore.governance_request_categories cat ON cat.id = c.category_id), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(to_char(m.month, 'YYYY-MM'), m.n)
                FROM (SELECT month, count(*) AS n FROM req GROUP BY 1 ORDER BY 1) m), '{}'::jsonb)
  FROM req;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- B2. DELIVERY ANALYTICS — projects/commitments restricted to covered
--     scope rows; scope-less entities are invisible to scoped callers.
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
  v_wide   boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.governance_analytics_authority('view_governance') THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;
  v_wide := politicore.governance_analytics_tenant_wide('view_governance');

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_projects p
      WHERE p.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_projects p
      WHERE p.tenant_id = v_tenant AND p.status IN ('active','suspended')
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_projects p
      WHERE p.tenant_id = v_tenant AND p.status IN ('completed','cancelled')
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_projects p
      WHERE p.tenant_id = v_tenant AND p.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_project_milestones m
       JOIN politicore.governance_projects p ON p.id = m.project_id
      WHERE m.tenant_id = v_tenant AND m.status = 'done'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_project_milestones m
       JOIN politicore.governance_projects p ON p.id = m.project_id
      WHERE m.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_commitments c
      WHERE c.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                WHERE s.commitment_id = c.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_commitments c
      WHERE c.tenant_id = v_tenant AND c.status = 'delivered'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                WHERE s.commitment_id = c.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_commitments c
      WHERE c.tenant_id = v_tenant AND c.status IN ('in_progress','partially_delivered')
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                WHERE s.commitment_id = c.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_commitments c
      WHERE c.tenant_id = v_tenant AND c.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                WHERE s.commitment_id = c.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(DISTINCT cp.commitment_id)::integer
       FROM politicore.governance_commitment_projects cp
       JOIN politicore.governance_commitments c ON c.id = cp.commitment_id
      WHERE cp.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                WHERE s.commitment_id = c.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT (SELECT count(*)::integer FROM politicore.governance_commitments c
              WHERE c.tenant_id = v_tenant
                AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                        WHERE s.commitment_id = c.id
                                          AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id))))
          - (SELECT count(DISTINCT cp.commitment_id)::integer
               FROM politicore.governance_commitment_projects cp
               JOIN politicore.governance_commitments c ON c.id = cp.commitment_id
              WHERE cp.tenant_id = v_tenant
                AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                        WHERE s.commitment_id = c.id
                                          AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id))))),
    COALESCE((SELECT jsonb_object_agg(w.name, c.n)
                FROM (SELECT ps.ward_id AS geo, count(*) AS n
                        FROM politicore.governance_project_scopes ps
                       WHERE ps.tenant_id = v_tenant AND ps.scope_type = 'ward'
                         AND (v_wide OR politicore.governance_analytics_row_covers('ward'::politicore.scope_type_enum, ps.ward_id))
                       GROUP BY 1) c
                JOIN politicore.wards w ON w.id = c.geo), '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- B3. PARTICIPATION ANALYTICS — instruments restricted to covered scope
--     rows; response/vote/support aggregates restricted accordingly
--     (never per-respondent, never per-signer, never per-voter).
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
  v_wide   boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.governance_analytics_authority('view_governance') THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;
  v_wide := politicore.governance_analytics_tenant_wide('view_governance');

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_consultations k
      WHERE k.tenant_id = v_tenant AND k.kind = 'consultation'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                                WHERE s.consultation_id = k.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_consultations k
      WHERE k.tenant_id = v_tenant AND k.status = 'open'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                                WHERE s.consultation_id = k.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_consultations k
      WHERE k.tenant_id = v_tenant AND k.status = 'results_published'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                                WHERE s.consultation_id = k.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT politicore.governance_privacy_bucket(count(*)::integer)
       FROM politicore.governance_consultation_responses cr
       JOIN politicore.governance_consultations k ON k.id = cr.consultation_id
      WHERE cr.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                                WHERE s.consultation_id = k.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_consultations k
      WHERE k.tenant_id = v_tenant AND k.kind = 'survey'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                                WHERE s.consultation_id = k.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_petitions e
      WHERE e.tenant_id = v_tenant AND e.origin = 'petition'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_petition_scopes s
                                WHERE s.petition_id = e.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_petitions e
      WHERE e.tenant_id = v_tenant AND e.status = 'open'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_petition_scopes s
                                WHERE s.petition_id = e.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT politicore.governance_privacy_bucket(COALESCE(sum(e.verified_count), 0)::integer)
       FROM politicore.governance_petitions e
      WHERE e.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_petition_scopes s
                                WHERE s.petition_id = e.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_petitions e
      WHERE e.tenant_id = v_tenant AND e.origin = 'community_proposal'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_petition_scopes s
                                WHERE s.petition_id = e.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_polls q
      WHERE q.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_poll_scopes s
                                WHERE s.poll_id = q.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_polls q
      WHERE q.tenant_id = v_tenant AND q.status = 'open'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_poll_scopes s
                                WHERE s.poll_id = q.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_polls q
      WHERE q.tenant_id = v_tenant AND q.status = 'closed' AND q.results IS NOT NULL
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_poll_scopes s
                                WHERE s.poll_id = q.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT politicore.governance_privacy_bucket(count(*)::integer)
       FROM politicore.governance_poll_votes pv
       JOIN politicore.governance_polls q ON q.id = pv.poll_id
      WHERE pv.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_poll_scopes s
                                WHERE s.poll_id = q.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id))));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- B4. ENGAGEMENT ANALYTICS — counts only, restricted to covered scope
--     rows; attendance/issues/follow-ups inherit parent coverage.
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
  v_wide   boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.governance_analytics_authority('view_governance') THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;
  v_wide := politicore.governance_analytics_tenant_wide('view_governance');

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = v_tenant AND g.status = 'draft'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = v_tenant AND g.status = 'scheduled'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = v_tenant AND g.status = 'concluded'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = v_tenant AND g.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagement_attendance a
       JOIN politicore.governance_engagements g ON g.id = a.engagement_id
      WHERE a.tenant_id = v_tenant
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagement_issues i
       JOIN politicore.governance_engagements g ON g.id = i.engagement_id
      WHERE g.tenant_id = v_tenant AND i.status = 'open'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagement_issues i
       JOIN politicore.governance_engagements g ON g.id = i.engagement_id
      WHERE g.tenant_id = v_tenant AND i.status = 'addressed'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagement_issues i
       JOIN politicore.governance_engagements g ON g.id = i.engagement_id
      WHERE g.tenant_id = v_tenant AND i.status = 'closed'
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_updates u
       JOIN politicore.governance_engagements g ON g.id = u.engagement_id
      WHERE u.tenant_id = v_tenant AND u.engagement_id IS NOT NULL
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    COALESCE((SELECT jsonb_object_agg(w.name, c.n)
                FROM (SELECT es.ward_id AS geo, count(*) AS n
                        FROM politicore.governance_engagement_scopes es
                       WHERE es.tenant_id = v_tenant AND es.scope_type = 'ward'
                         AND (v_wide OR politicore.governance_analytics_row_covers('ward'::politicore.scope_type_enum, es.ward_id))
                       GROUP BY 1) c
                JOIN politicore.wards w ON w.id = c.geo), '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- B5. ACCOUNTABILITY ANALYTICS — published counts restricted to covered
--     scope rows.
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
  v_wide   boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.governance_analytics_authority('view_governance') THEN
    RAISE EXCEPTION 'governance: view_governance required for analytics';
  END IF;
  v_wide := politicore.governance_analytics_tenant_wide('view_governance');

  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_projects p
      WHERE p.tenant_id = v_tenant AND p.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                WHERE s.project_id = p.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_commitments c
      WHERE c.tenant_id = v_tenant AND c.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                WHERE s.commitment_id = c.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_consultations k
      WHERE k.tenant_id = v_tenant AND k.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                                WHERE s.consultation_id = k.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_petitions e
      WHERE e.tenant_id = v_tenant AND e.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_petition_scopes s
                                WHERE s.petition_id = e.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_polls q
      WHERE q.tenant_id = v_tenant AND q.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_poll_scopes s
                                WHERE s.poll_id = q.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = v_tenant AND g.is_public
        AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                WHERE s.engagement_id = g.id
                                  AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))),
    (SELECT count(*)::integer FROM politicore.governance_updates u
      WHERE u.tenant_id = v_tenant AND u.is_public
        AND (v_wide OR
             (u.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                                    WHERE s.project_id = u.project_id
                                                      AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
          OR (u.commitment_id IS NOT NULL AND EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                                       WHERE s.commitment_id = u.commitment_id
                                                         AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
          OR (u.engagement_id IS NOT NULL AND EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                                       WHERE s.engagement_id = u.engagement_id
                                                         AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id))))),
    EXISTS (SELECT 1 FROM politicore.governance_requests r
             WHERE r.tenant_id = v_tenant
               AND (v_wide OR politicore.governance_analytics_row_covers(
                      CASE WHEN r.ward_id IS NOT NULL THEN 'ward'::politicore.scope_type_enum
                           WHEN r.lga_id IS NOT NULL THEN 'lga'::politicore.scope_type_enum
                           END,
                      COALESCE(r.ward_id, r.lga_id))));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- C. INSTITUTIONAL MEMORY — timeline rows restricted to the caller's
--     covered geographic slices (updates inherit their parent's
--     coverage). Same bounded projection as 0058; no second history
--     model; no identity/contact columns.
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
  v_cap    integer;
  v_wide   boolean;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL OR NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.governance_analytics_authority('view_governance') THEN
    RAISE EXCEPTION 'governance: view_governance required for institutional memory';
  END IF;
  v_wide := politicore.governance_analytics_tenant_wide('view_governance');
  v_cap := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);

  RETURN QUERY
  SELECT * FROM (
    SELECT 'project'::text AS kind, p.reference_code AS reference_code, p.title AS title,
           p.status::text AS status, p.created_at AS occurred_at, p.is_public AS published
      FROM politicore.governance_projects p
     WHERE p.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'project')
       AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                               WHERE s.project_id = p.id
                                 AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
    UNION ALL
    SELECT 'commitment', c.reference_code, c.title,
           c.status::text, c.created_at, c.is_public
      FROM politicore.governance_commitments c
     WHERE c.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'commitment')
       AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                               WHERE s.commitment_id = c.id
                                 AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
    UNION ALL
    SELECT 'consultation', k.reference_code, k.title,
           k.status::text, k.created_at, k.is_public
      FROM politicore.governance_consultations k
     WHERE k.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'consultation')
       AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes s
                               WHERE s.consultation_id = k.id
                                 AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
    UNION ALL
    SELECT 'petition', e.reference_code, e.title,
           e.status::text, e.created_at, e.is_public
      FROM politicore.governance_petitions e
     WHERE e.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'petition')
       AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_petition_scopes s
                               WHERE s.petition_id = e.id
                                 AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
    UNION ALL
    SELECT 'poll', q.reference_code, q.title,
           q.status::text, q.created_at, q.is_public
      FROM politicore.governance_polls q
     WHERE q.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'poll')
       AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_poll_scopes s
                               WHERE s.poll_id = q.id
                                 AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
    UNION ALL
    SELECT 'engagement', g.reference_code, g.title,
           g.status::text, g.created_at, g.is_public
      FROM politicore.governance_engagements g
     WHERE g.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'engagement')
       AND (v_wide OR EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                               WHERE s.engagement_id = g.id
                                 AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
    UNION ALL
    SELECT 'update', COALESCE(u.project_id::text, u.commitment_id::text, u.engagement_id::text),
           u.title, u.kind::text, u.created_at, u.is_public
      FROM politicore.governance_updates u
     WHERE u.tenant_id = v_tenant
       AND (p_kind IS NULL OR p_kind = 'update')
       AND (v_wide
          OR (u.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM politicore.governance_project_scopes s
                                                    WHERE s.project_id = u.project_id
                                                      AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
          OR (u.commitment_id IS NOT NULL AND EXISTS (SELECT 1 FROM politicore.governance_commitment_scopes s
                                                       WHERE s.commitment_id = u.commitment_id
                                                         AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id)))
          OR (u.engagement_id IS NOT NULL AND EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes s
                                                       WHERE s.engagement_id = u.engagement_id
                                                         AND politicore.governance_analytics_row_covers_typed(s.scope_type, s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id))))
  ) mem
  ORDER BY mem.occurred_at DESC
  LIMIT v_cap OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- HYGIENE — same posture as 0058: no anon/PUBLIC surface, authenticated
-- re-gated in-body.
-- ---------------------------------------------------------------------
-- Internal authority helpers are definer-internal (nested calls run as the
-- owner; no top-level EXECUTE path exists). authenticated is revoked too:
-- an earlier hosted apply briefly granted it, and CREATE OR REPLACE
-- preserves ACLs — the revoke makes the posture convergent.
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_tenant_wide(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_row_covers(politicore.scope_type_enum, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_row_covers_typed(politicore.scope_type_enum, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_authority(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION politicore.governance_analytics_covers(politicore.scope_type_enum, text) FROM PUBLIC, anon, authenticated;
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

-- PUBLIC RPC WRAPPERS (text-overload convention from 0056; delegate verbatim,
-- SECURITY INVOKER — every authority decision stays inside the definer body).
CREATE OR REPLACE FUNCTION public.governance_analytics_requests()
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
  SELECT * FROM politicore.governance_analytics_requests();
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.governance_analytics_delivery()
RETURNS TABLE (
  projects_total integer, projects_active integer, projects_concluded integer,
  projects_published integer,
  milestones_done integer, milestones_total integer,
  commitments_total integer, commitments_delivered integer,
  commitments_in_progress integer, commitments_published integer,
  commitments_with_projects integer, commitments_without_projects integer,
  projects_by_ward jsonb
) AS $$
  SELECT * FROM politicore.governance_analytics_delivery();
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.governance_analytics_participation()
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
  SELECT * FROM politicore.governance_analytics_participation();
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.governance_analytics_engagements()
RETURNS TABLE (
  total integer, draft integer, scheduled integer, concluded integer,
  published integer,
  attendance_count integer,
  issues_open integer, issues_addressed integer, issues_closed integer,
  followups integer,
  by_ward jsonb
) AS $$
  SELECT * FROM politicore.governance_analytics_engagements();
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.governance_analytics_accountability()
RETURNS TABLE (
  published_projects integer, published_commitments integer,
  published_consultations integer, published_petitions integer,
  published_polls integer, published_engagements integer,
  public_updates integer,
  public_request_stats_available boolean
) AS $$
  SELECT * FROM politicore.governance_analytics_accountability();
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.governance_memory_timeline(
  p_kind text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  kind text, reference_code text, title text, status text,
  occurred_at timestamptz, published boolean
) AS $$
  SELECT * FROM politicore.governance_memory_timeline(p_kind, p_limit, p_offset);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

REVOKE ALL ON FUNCTION public.governance_analytics_requests() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.governance_analytics_delivery() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.governance_analytics_participation() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.governance_analytics_engagements() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.governance_analytics_accountability() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.governance_memory_timeline(text, integer, integer) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.governance_analytics_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.governance_analytics_delivery() TO authenticated;
GRANT EXECUTE ON FUNCTION public.governance_analytics_participation() TO authenticated;
GRANT EXECUTE ON FUNCTION public.governance_analytics_engagements() TO authenticated;
GRANT EXECUTE ON FUNCTION public.governance_analytics_accountability() TO authenticated;
GRANT EXECUTE ON FUNCTION public.governance_memory_timeline(text, integer, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- DOCUMENTATION
-- ---------------------------------------------------------------------
COMMENT ON FUNCTION politicore.governance_analytics_tenant_wide(text) IS
  'Phase 19 (0059) tenant-wide analytics authority: admins or an EXPLICIT unscoped grant (deny-wins: an unscoped deny suppresses the unscoped allow) — position defaults are inherently scoped and never confer tenant-wide analytics (prompt §7).';

COMMENT ON FUNCTION politicore.governance_analytics_row_covers(politicore.scope_type_enum, text) IS
  'Phase 19 (0059) per-row geographic coverage via the Core resolver has_permission(perm, scope, id) — scoped callers see only covered slices; scope-less rows fail closed.';

COMMENT ON FUNCTION politicore.governance_analytics_row_covers_typed(politicore.scope_type_enum, text, text, text, text, text) IS
  'Phase 19 (0059) typed-column coverage form for the governance *_scopes child tables (state/zone/lga/ward/polling_unit id columns per the shape CHECK).';

COMMENT ON FUNCTION politicore.governance_analytics_requests() IS
  'Phase 19 derived request/case analytics — staff-gated (view_governance), tenant-scoped, PER-ROW geo-restricted for scoped grantees (0059), duration+counts bucketed via governance_privacy_bucket. No citizen contact or private case text.';

COMMENT ON FUNCTION politicore.governance_memory_timeline(text, integer, integer) IS
  'Phase 19 institutional memory — bounded timeline over canonical records + governance_updates, geo-restricted per covered scope (0059). No second history model (gate §25).';
