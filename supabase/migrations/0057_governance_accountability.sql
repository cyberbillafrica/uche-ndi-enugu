-- =====================================================================
-- POLITICORE — MIGRATION 0057: GOVERNANCE ACCOUNTABILITY (PHASE 18)
-- =====================================================================
-- Visibility, publication and safe public projections for Governance
-- (docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md
-- §12 Accountability, §22 public IA, §28 open decision 4).
--
-- Architecture:
--   canonical tables (FORCE RLS, zero anon surface — UNCHANGED)
--     → explicit audited publication (existing is_public/published_at
--       columns + authority RPCs; NO duplicate public tables — prompt §4)
--     → narrow SECURITY DEFINER read projections (explicit columns only)
--     → public.* SECURITY INVOKER wrappers (0007 anon-executable)
--
-- Contents:
--   A. Hardened publication authority — the Phase 12/13 visibility RPCs
--      (projects, commitments, updates) predate the publish_accountability
--      gate that Phases 14–16 added to every later publication RPC. This
--      migration restates them with the SAME gate so ONE publication
--      authority (publish_accountability) governs ALL governance
--      publication, per prompt §6/§7. Public one-line wrappers follow the
--      0047/0048 convention (PostgREST-resolvable), anon-revoked.
--   B. Public projection layer — SECURITY DEFINER read RPCs keyed by the
--      PUBLIC site slug (never a client tenant id; 0037 seam) + the
--      reference_code public handle (never a raw uuid). Explicit column
--      lists only — never SELECT *. Engagements expose summary/agenda/
--      outcomes/attendance COUNT/published updates — never rosters, never
--      internal issues, never staff identifiers (gate §12 row).
--   C. Request statistics — aggregate-only, privacy-bucketed resolution
--      of Phase 11 §29 OPEN DECISION 4 (anti-re-identification). Buckets
--      0 | 1–5 | 6–20 | 21–50 | 51+: the 1–5 band deliberately merges the
--      reidentification-risk tail (a ward showing "1" isolates a citizen);
--      ≥6 groups carry real accountability signal while no individual
--      case is distinguishable. No category×geo cross-slices. Durations
--      bucket as — | ≤7 | 8–30 | 31–90 | 90+ days.
--
-- Security posture:
--   * zero anon policies/grants on any canonical table (unchanged)
--   * projections resolve tenant server-side by public slug
--   * projections filter is_public AND per-domain lifecycle eligibility
--   * projection RPCs keep the 0007 default anon EXECUTE (required for
--     the wrapper chain — 0037 convention); they are read-only and
--     self-scoping. Internal helpers are revoked from everything (0037).
--   * publication stays audited in Core Audit (existing RPC bodies).
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- A. HARDENED PUBLICATION AUTHORITY (one gate: publish_accountability)
-- ---------------------------------------------------------------------
-- Restatement pattern (0007/0044/0048/0053): same signatures, provenance
-- comments. The assert_*_authority check (geo-scoped manage authority +
-- tenant + module gate) is deliberately RETAINED — publication still
-- requires operational authority OVER the record AND the publication
-- permission. What changes: a manager WITHOUT publish_accountability can
-- no longer flip visibility (Phase 18 closes the pre-§16 gap).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION politicore.set_governance_project_visibility(
  p_project uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_old boolean;
BEGIN
  v_tenant := politicore.assert_project_authority(p_project);
  -- PHASE 18: publication authority unified on publish_accountability
  -- (gate §12; prompt §6). Previously manage-projects-only (0043/0044).
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;
  SELECT is_public INTO v_old FROM politicore.governance_projects WHERE id = p_project;

  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);

  UPDATE politicore.governance_projects
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN now() ELSE NULL END
   WHERE id = p_project;
  PERFORM set_config('politicore.governance_authority', '', true);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_project:visibility',
          'governance_projects', p_project::text,
          jsonb_build_object('is_public', v_old),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.set_governance_commitment_visibility(
  p_commitment uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old boolean;
BEGIN
  v_tenant := politicore.assert_commitment_authority(p_commitment);
  -- PHASE 18: publish_accountability gate unified (was manage-projects-only).
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;
  SELECT is_public INTO v_old FROM politicore.governance_commitments WHERE id = p_commitment;

  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);

  UPDATE politicore.governance_commitments
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN COALESCE(published_at, now()) ELSE NULL END
   WHERE id = p_commitment;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:visibility',
          'governance_commitments', p_commitment::text,
          jsonb_build_object('is_public', v_old),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.set_governance_update_visibility(
  p_update uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_project uuid; v_commitment uuid; v_old boolean;
BEGIN
  SELECT tenant_id, project_id, commitment_id, is_public
    INTO v_tenant, v_project, v_commitment, v_old
    FROM politicore.governance_updates WHERE id = p_update;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: update not found';
  END IF;
  IF v_project IS NOT NULL THEN
    PERFORM politicore.assert_project_authority(v_project);
  ELSIF v_commitment IS NOT NULL THEN
    PERFORM politicore.assert_commitment_authority(v_commitment);
  ELSE
    RAISE EXCEPTION 'governance: update has no subject';
  END IF;
  -- PHASE 18: a public update is a public projection payload — the
  -- publication gate applies to update visibility exactly as it does to
  -- its subject (prompt §8 Governance Updates).
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;

  UPDATE politicore.governance_updates
     SET is_public = p_is_public WHERE id = p_update;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_update:visibility',
          'governance_updates', p_update::text,
          jsonb_build_object('is_public', v_old),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- PostgREST-resolvable one-line wrappers (0047/0048 convention), authenticated-only.
CREATE OR REPLACE FUNCTION public.set_governance_project_visibility(
  p_project uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_project_visibility(p_project, p_is_public);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_governance_commitment_visibility(
  p_commitment uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_commitment_visibility(p_commitment, p_is_public);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_governance_update_visibility(
  p_update uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_update_visibility(p_update, p_is_public);
$$ LANGUAGE sql;

REVOKE EXECUTE ON FUNCTION public.set_governance_project_visibility(uuid,boolean)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_commitment_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_update_visibility(uuid,boolean)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_project_visibility(uuid,boolean)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_commitment_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_update_visibility(uuid,boolean)     FROM PUBLIC, anon;

-- ─────────────────────────────────────────────────────────────────────────
-- B. PRIVACY BUCKETS (Phase 11 §29 OPEN DECISION 4 — resolved here)
-- ---------------------------------------------------------------------
-- Nonzero counts under 6 are the reidentification band: "ward X: 1
-- request" can identify the citizen AND the circumstances. Buckets merge
-- that tail; 6–20 / 21–50 / 51+ carry real accountability signal. The
-- thresholds match the accountability prompt's endorsed ladder. No
-- differential-privacy machinery — a practical k-merge appropriate for
-- the current product (prompt §18).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_privacy_bucket(p_count integer)
RETURNS text AS $$
  SELECT CASE
    WHEN p_count IS NULL OR p_count <= 0 THEN '0'
    WHEN p_count <= 5  THEN '1-5'
    WHEN p_count <= 20 THEN '6-20'
    WHEN p_count <= 50 THEN '21-50'
    ELSE '51+'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION politicore.governance_privacy_duration_bucket(p_days numeric)
RETURNS text AS $$
  SELECT CASE
    WHEN p_days IS NULL THEN '-'
    WHEN p_days <= 7  THEN '<=7'
    WHEN p_days <= 30 THEN '8-30'
    WHEN p_days <= 90 THEN '31-90'
    ELSE '90+'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Internal helpers — no direct execution surface (0037 hygiene).
REVOKE EXECUTE ON FUNCTION politicore.governance_privacy_bucket(integer)          FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION politicore.governance_privacy_duration_bucket(numeric) FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- C. PUBLIC PROJECTION LAYER
-- ---------------------------------------------------------------------
-- SECURITY DEFINER read RPCs. Tenant is resolved from the PUBLIC site
-- slug (0037 seam — the browser never supplies a tenant id). Every
-- function selects explicit columns (never *) and filters is_public plus
-- the per-domain eligibility below:
--
--   projects      is_public
--   commitments   is_public
--   consultations is_public (results appear only in results_published)
--   petitions     is_public (aggregate support only; signatures NEVER)
--   polls         is_public AND closed AND results IS NOT NULL
--                 (Phase 16 aggregate publication — no vote rows exist
--                 in the projection, ever)
--   engagements   is_public (summary/agenda/outcomes/attendance COUNT/
--                 public updates — never rosters, never internal issues)
--
-- anon EXECUTE is intentionally retained (0007 default + explicit grant):
-- the public.* wrappers call these, and each function is read-only and
-- fully self-scoping.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION politicore.public_governance_tenant(p_tenant_slug text)
RETURNS uuid AS $$
  SELECT id FROM politicore.tenants WHERE slug = p_tenant_slug;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

REVOKE EXECUTE ON FUNCTION politicore.public_governance_tenant(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION politicore.public_governance_hub(p_tenant_slug text)
RETURNS TABLE (
  published_projects       integer,
  published_commitments    integer,
  open_consultations       integer,
  published_petitions      integer,
  published_engagements    integer,
  published_poll_results   integer,
  stats_available          boolean
) AS $$
  SELECT
    (SELECT count(*)::integer FROM politicore.governance_projects p
      WHERE p.tenant_id = t.id AND p.is_public),
    (SELECT count(*)::integer FROM politicore.governance_commitments c
      WHERE c.tenant_id = t.id AND c.is_public),
    (SELECT count(*)::integer FROM politicore.governance_consultations k
      WHERE k.tenant_id = t.id AND k.is_public AND k.status = 'open'),
    (SELECT count(*)::integer FROM politicore.governance_petitions e
      WHERE e.tenant_id = t.id AND e.is_public),
    (SELECT count(*)::integer FROM politicore.governance_engagements g
      WHERE g.tenant_id = t.id AND g.is_public),
    (SELECT count(*)::integer FROM politicore.governance_polls q
      WHERE q.tenant_id = t.id AND q.is_public AND q.status = 'closed'
        AND q.results IS NOT NULL),
    (SELECT count(*) > 0 FROM politicore.governance_requests r WHERE r.tenant_id = t.id)
  FROM (SELECT politicore.public_governance_tenant(p_tenant_slug) AS id) t
  WHERE t.id IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_projects(p_tenant_slug text)
RETURNS TABLE (
  reference_code text, title text, description text, category_label text,
  status text, progress_percent smallint,
  planned_start date, planned_end date, actual_start date, actual_end date
) AS $$
  SELECT p.reference_code, p.title, p.description, p.category_label,
         p.status::text, p.progress_percent,
         p.planned_start, p.planned_end, p.actual_start, p.actual_end
    FROM politicore.governance_projects p
   WHERE p.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND p.is_public
   ORDER BY p.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_project(p_tenant_slug text, p_reference text)
RETURNS TABLE (
  reference_code text, title text, description text, category_label text,
  status text, progress_percent smallint,
  planned_start date, planned_end date, actual_start date, actual_end date,
  implementing_org text, funding_source text,
  beneficiary_summary text, beneficiaries_estimated integer,
  published_at timestamptz
) AS $$
  SELECT p.reference_code, p.title, p.description, p.category_label,
         p.status::text, p.progress_percent,
         p.planned_start, p.planned_end, p.actual_start, p.actual_end,
         p.implementing_org, p.funding_source,
         p.beneficiary_summary, p.beneficiaries_estimated,
         p.published_at
    FROM politicore.governance_projects p
   WHERE p.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND p.is_public AND p.reference_code = p_reference;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_project_milestones(p_tenant_slug text, p_reference text)
RETURNS TABLE (title text, description text, status text, due_date date, sort_order integer) AS $$
  SELECT m.title, m.description, m.status::text, m.due_date, m.sort_order
    FROM politicore.governance_project_milestones m
    JOIN politicore.governance_projects p ON p.id = m.project_id
   WHERE p.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND p.is_public AND p.reference_code = p_reference
   ORDER BY m.sort_order, m.created_at;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_commitments(p_tenant_slug text)
RETURNS TABLE (
  reference_code text, title text, details text, category_label text,
  status text, source_type text, source_ref text,
  progress_percent smallint, target_date date, completed_at date
) AS $$
  SELECT c.reference_code, c.title, c.details, c.category_label,
         c.status::text, c.source_type::text, c.source_ref,
         c.progress_percent, c.target_date, c.completed_at
    FROM politicore.governance_commitments c
   WHERE c.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND c.is_public
   ORDER BY c.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_commitment(p_tenant_slug text, p_reference text)
RETURNS TABLE (
  reference_code text, title text, details text, category_label text,
  status text, source_type text, source_ref text,
  progress_percent smallint, target_description text,
  planned_start date, target_date date, completed_at date,
  published_at timestamptz
) AS $$
  SELECT c.reference_code, c.title, c.details, c.category_label,
         c.status::text, c.source_type::text, c.source_ref,
         c.progress_percent, c.target_description,
         c.planned_start, c.target_date, c.completed_at,
         c.published_at
    FROM politicore.governance_commitments c
   WHERE c.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND c.is_public AND c.reference_code = p_reference;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- Delivery links: published projects carrying this commitment's context.
CREATE OR REPLACE FUNCTION politicore.public_governance_commitment_projects(p_tenant_slug text, p_reference text)
RETURNS TABLE (reference_code text, title text, status text, progress_percent smallint) AS $$
  SELECT p.reference_code, p.title, p.status::text, p.progress_percent
    FROM politicore.governance_commitment_projects cp
    JOIN politicore.governance_commitments c ON c.id = cp.commitment_id
    JOIN politicore.governance_projects p    ON p.id = cp.project_id
   WHERE c.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND c.is_public AND c.reference_code = p_reference
     AND p.is_public
   ORDER BY p.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- Public participation listing: open consultations/surveys, open
-- published petitions, closed polls with published aggregate results.
CREATE OR REPLACE FUNCTION politicore.public_governance_participate(p_tenant_slug text)
RETURNS TABLE (
  kind text, reference_code text, title text, description text,
  status text, closes_at timestamptz
) AS $$
  SELECT 'consultation', k.reference_code, k.title, k.description,
         k.status::text, k.closes_at
    FROM politicore.governance_consultations k
   WHERE k.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND k.is_public AND k.status = 'open'
  UNION ALL
  SELECT 'petition', e.reference_code, e.title, left(e.demand, 240),
         e.status::text, e.closes_at
    FROM politicore.governance_petitions e
   WHERE e.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND e.is_public AND e.status = 'open'
  UNION ALL
  SELECT 'poll', q.reference_code, q.title, q.description,
         q.status::text, q.closes_at
    FROM politicore.governance_polls q
   WHERE q.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND q.is_public AND q.status = 'closed' AND q.results IS NOT NULL
   ORDER BY closes_at NULLS LAST;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_consultation(p_tenant_slug text, p_reference text)
RETURNS TABLE (
  kind text, reference_code text, title text, description text,
  instructions text, questions jsonb, status text, closes_at timestamptz,
  results jsonb, results_summary text, published_at timestamptz
) AS $$
  SELECT k.kind::text, k.reference_code, k.title, k.description,
         k.instructions, k.questions, k.status::text, k.closes_at,
         k.results, k.results_summary, k.published_at
    FROM politicore.governance_consultations k
   WHERE k.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND k.is_public AND k.reference_code = p_reference;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_petition(p_tenant_slug text, p_reference text)
RETURNS TABLE (
  origin text, reference_code text, title text, demand text, status text,
  target_signatures integer, verified_count integer,
  results jsonb, results_summary text, published_at timestamptz
) AS $$
  SELECT e.origin::text, e.reference_code, e.title, e.demand,
         e.status::text, e.target_signatures, e.verified_count,
         e.results, e.results_summary, e.published_at
    FROM politicore.governance_petitions e
   WHERE e.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND e.is_public AND e.reference_code = p_reference;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- Aggregate poll results for a CLOSED, PUBLISHED poll. Reads the
-- server-published aggregate jsonb ONLY — no vote rows exist here.
CREATE OR REPLACE FUNCTION politicore.public_governance_poll(p_tenant_slug text, p_reference text)
RETURNS TABLE (
  reference_code text, title text, question text, description text,
  options jsonb, results jsonb, results_summary text, published_at timestamptz
) AS $$
  SELECT q.reference_code, q.title, q.question, q.description,
         q.options, q.results, q.results_summary, q.published_at
    FROM politicore.governance_polls q
   WHERE q.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND q.is_public AND q.status = 'closed' AND q.results IS NOT NULL
     AND q.reference_code = p_reference;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_engagements(p_tenant_slug text)
RETURNS TABLE (
  reference_code text, title text, description text, status text,
  scheduled_at timestamptz, held_at timestamptz, location text,
  attendance_count bigint
) AS $$
  SELECT g.reference_code, g.title, g.description, g.status::text,
         g.scheduled_at, g.held_at, g.location,
         (SELECT count(*) FROM politicore.governance_engagement_attendance a
           WHERE a.engagement_id = g.id)
    FROM politicore.governance_engagements g
   WHERE g.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND g.is_public
   ORDER BY COALESCE(g.held_at, g.scheduled_at) DESC NULLS LAST;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_engagement(p_tenant_slug text, p_reference text)
RETURNS TABLE (
  reference_code text, title text, description text, status text,
  scheduled_at timestamptz, held_at timestamptz, location text,
  agenda jsonb, outcomes text, attendance_count bigint,
  event_title text, event_date date, event_venue text,
  published_at timestamptz
) AS $$
  SELECT g.reference_code, g.title, g.description, g.status::text,
         g.scheduled_at, g.held_at, g.location,
         g.agenda, g.outcomes,
         (SELECT count(*) FROM politicore.governance_engagement_attendance a
           WHERE a.engagement_id = g.id),
         v.title, v.event_date, v.venue,
         g.published_at
    FROM politicore.governance_engagements g
    LEFT JOIN politicore.events v
           ON v.id = g.event_id AND v.status = 'published'
   WHERE g.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND g.is_public AND g.reference_code = p_reference;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- Public engagement record: agenda + PUBLIC updates only (gate §12:
-- summary, agenda, outcomes, follow-ups; attendance is a count).
CREATE OR REPLACE FUNCTION politicore.public_governance_engagement_updates(p_tenant_slug text, p_reference text)
RETURNS TABLE (title text, body text, kind text, created_at timestamptz) AS $$
  SELECT u.title, u.body, u.kind::text, u.created_at
    FROM politicore.governance_updates u
    JOIN politicore.governance_engagements g ON g.id = u.engagement_id
   WHERE g.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND g.is_public AND g.reference_code = p_reference
     AND u.is_public
   ORDER BY u.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION politicore.public_governance_updates(p_tenant_slug text, p_reference text)
RETURNS TABLE (title text, body text, kind text, created_at timestamptz) AS $$
  SELECT u.title, u.body, u.kind::text, u.created_at
    FROM politicore.governance_updates u
    JOIN politicore.governance_projects p ON p.id = u.project_id
   WHERE p.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
     AND p.is_public AND p.reference_code = p_reference
     AND u.is_public
   ORDER BY u.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- D. PUBLIC REQUEST STATISTICS (aggregate-only, privacy-bucketed)
-- ---------------------------------------------------------------------
-- Phase 11 §12/§28: resolved-request surface is STATISTICS ONLY — counts,
-- durations, distributions; never case contents. Open Decision 4 buckets
-- (section B) are applied to every count; individual requests are
-- unreachable (no references, no titles, no contact fields, no
-- category×geo cross-slices that could isolate one case).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION politicore.public_governance_request_stats(p_tenant_slug text)
RETURNS TABLE (
  scope_level text, scope_name text,
  total_bucket text, open_bucket text, resolved_bucket text,
  resolution_days_bucket text
) AS $$
  WITH req AS (
    SELECT r.ward_id, r.lga_id, r.status, r.resolved_at, r.created_at
      FROM politicore.governance_requests r
     WHERE r.tenant_id = politicore.public_governance_tenant(p_tenant_slug)
  ),
  ward_rows AS (
    SELECT 'ward' AS scope_level, w.name AS scope_name,
           count(*) AS total, count(*) FILTER (WHERE req.status NOT IN ('resolved','closed','rejected')) AS open_count,
           count(*) FILTER (WHERE req.status IN ('resolved','closed')) AS resolved_count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (req.resolved_at - req.created_at)) / 86400.0)
             FILTER (WHERE req.status IN ('resolved','closed') AND req.resolved_at IS NOT NULL) AS median_days
      FROM req JOIN politicore.wards w ON w.id = req.ward_id
     GROUP BY w.name
  ),
  lga_rows AS (
    SELECT 'lga' AS scope_level, l.name AS scope_name,
           count(*) AS total, count(*) FILTER (WHERE req.status NOT IN ('resolved','closed','rejected')) AS open_count,
           count(*) FILTER (WHERE req.status IN ('resolved','closed')) AS resolved_count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (req.resolved_at - req.created_at)) / 86400.0)
             FILTER (WHERE req.status IN ('resolved','closed') AND req.resolved_at IS NOT NULL) AS median_days
      FROM req JOIN politicore.lgas l ON l.id = req.lga_id
     GROUP BY l.name
  ),
  state_rows AS (
    SELECT 'state' AS scope_level, s.name AS scope_name,
           count(*) AS total, count(*) FILTER (WHERE req.status NOT IN ('resolved','closed','rejected')) AS open_count,
           count(*) FILTER (WHERE req.status IN ('resolved','closed')) AS resolved_count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM (req.resolved_at - req.created_at)) / 86400.0)
             FILTER (WHERE req.status IN ('resolved','closed') AND req.resolved_at IS NOT NULL) AS median_days
      FROM req JOIN politicore.lgas l ON l.id = req.lga_id
               JOIN politicore.states s ON s.id = l.state_id
     GROUP BY s.name
  )
  SELECT scope_level, scope_name,
           politicore.governance_privacy_bucket(total::integer),
           politicore.governance_privacy_bucket(open_count::integer),
           politicore.governance_privacy_bucket(resolved_count::integer),
           politicore.governance_privacy_duration_bucket(median_days::numeric)
    FROM (
      SELECT * FROM ward_rows
      UNION ALL SELECT * FROM lga_rows
      UNION ALL SELECT * FROM state_rows
    ) all_rows
   ORDER BY scope_level, scope_name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- Explicit anon executability for the wrapper chain (0007 convention;
-- deterministic rather than default-privilege-dependent).
GRANT EXECUTE ON FUNCTION
  politicore.public_governance_hub(text),
  politicore.public_governance_projects(text),
  politicore.public_governance_project(text,text),
  politicore.public_governance_project_milestones(text,text),
  politicore.public_governance_commitments(text),
  politicore.public_governance_commitment(text,text),
  politicore.public_governance_commitment_projects(text,text),
  politicore.public_governance_participate(text),
  politicore.public_governance_consultation(text,text),
  politicore.public_governance_petition(text,text),
  politicore.public_governance_poll(text,text),
  politicore.public_governance_engagements(text),
  politicore.public_governance_engagement(text,text),
  politicore.public_governance_engagement_updates(text,text),
  politicore.public_governance_updates(text,text),
  politicore.public_governance_request_stats(text)
TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- E. PUBLIC WRAPPERS (PostgREST-resolvable; 0037/0047 convention)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_governance_hub(p_tenant_slug text)
RETURNS TABLE (published_projects integer, published_commitments integer,
  open_consultations integer, published_petitions integer,
  published_engagements integer, published_poll_results integer,
  stats_available boolean) AS $$
  SELECT * FROM politicore.public_governance_hub(p_tenant_slug);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_projects(p_tenant_slug text)
RETURNS TABLE (reference_code text, title text, description text, category_label text,
  status text, progress_percent smallint, planned_start date, planned_end date,
  actual_start date, actual_end date) AS $$
  SELECT * FROM politicore.public_governance_projects(p_tenant_slug);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_project(p_tenant_slug text, p_reference text)
RETURNS TABLE (reference_code text, title text, description text, category_label text,
  status text, progress_percent smallint, planned_start date, planned_end date,
  actual_start date, actual_end date, implementing_org text, funding_source text,
  beneficiary_summary text, beneficiaries_estimated integer, published_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_project(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_project_milestones(p_tenant_slug text, p_reference text)
RETURNS TABLE (title text, description text, status text, due_date date, sort_order integer) AS $$
  SELECT * FROM politicore.public_governance_project_milestones(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_commitments(p_tenant_slug text)
RETURNS TABLE (reference_code text, title text, details text, category_label text,
  status text, source_type text, source_ref text, progress_percent smallint,
  target_date date, completed_at date) AS $$
  SELECT * FROM politicore.public_governance_commitments(p_tenant_slug);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_commitment(p_tenant_slug text, p_reference text)
RETURNS TABLE (reference_code text, title text, details text, category_label text,
  status text, source_type text, source_ref text, progress_percent smallint,
  target_description text, planned_start date, target_date date, completed_at date,
  published_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_commitment(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_commitment_projects(p_tenant_slug text, p_reference text)
RETURNS TABLE (reference_code text, title text, status text, progress_percent smallint) AS $$
  SELECT * FROM politicore.public_governance_commitment_projects(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_participate(p_tenant_slug text)
RETURNS TABLE (kind text, reference_code text, title text, description text,
  status text, closes_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_participate(p_tenant_slug);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_consultation(p_tenant_slug text, p_reference text)
RETURNS TABLE (kind text, reference_code text, title text, description text,
  instructions text, questions jsonb, status text, closes_at timestamptz,
  results jsonb, results_summary text, published_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_consultation(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_petition(p_tenant_slug text, p_reference text)
RETURNS TABLE (origin text, reference_code text, title text, demand text, status text,
  target_signatures integer, verified_count integer, results jsonb,
  results_summary text, published_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_petition(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_poll(p_tenant_slug text, p_reference text)
RETURNS TABLE (reference_code text, title text, question text, description text,
  options jsonb, results jsonb, results_summary text, published_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_poll(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_engagements(p_tenant_slug text)
RETURNS TABLE (reference_code text, title text, description text, status text,
  scheduled_at timestamptz, held_at timestamptz, location text,
  attendance_count bigint) AS $$
  SELECT * FROM politicore.public_governance_engagements(p_tenant_slug);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_engagement(p_tenant_slug text, p_reference text)
RETURNS TABLE (reference_code text, title text, description text, status text,
  scheduled_at timestamptz, held_at timestamptz, location text, agenda jsonb,
  outcomes text, attendance_count bigint, event_title text, event_date date,
  event_venue text, published_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_engagement(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_engagement_updates(p_tenant_slug text, p_reference text)
RETURNS TABLE (title text, body text, kind text, created_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_engagement_updates(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_updates(p_tenant_slug text, p_reference text)
RETURNS TABLE (title text, body text, kind text, created_at timestamptz) AS $$
  SELECT * FROM politicore.public_governance_updates(p_tenant_slug, p_reference);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.public_governance_request_stats(p_tenant_slug text)
RETURNS TABLE (scope_level text, scope_name text, total_bucket text,
  open_bucket text, resolved_bucket text, resolution_days_bucket text) AS $$
  SELECT * FROM politicore.public_governance_request_stats(p_tenant_slug);
$$ LANGUAGE sql;

-- ─────────────────────────────────────────────────────────────────────────
-- DOCUMENTATION
-- ---------------------------------------------------------------------
COMMENT ON FUNCTION politicore.public_governance_request_stats(text) IS
  'Phase 18 public request statistics — aggregate-only, privacy-bucketed (0 | 1-5 | 6-20 | 21-50 | 51+; durations — | <=7 | 8-30 | 31-90 | 90+). Resolves Phase 11 §29 Open Decision 4: the 1-5 band merges the reidentification tail; no case contents, no category×geo slices.';

COMMENT ON FUNCTION politicore.set_governance_project_visibility(uuid,boolean) IS
  'Phase 18 restatement: publication authority unified on publish_accountability (retains assert_project_authority). Audited.';

COMMENT ON FUNCTION politicore.set_governance_commitment_visibility(uuid,boolean) IS
  'Phase 18 restatement: publication authority unified on publish_accountability (retains assert_commitment_authority). Audited.';

COMMENT ON FUNCTION politicore.set_governance_update_visibility(uuid,boolean) IS
  'Phase 18 restatement: a public update is a public payload — publish_accountability required (retains subject authority). Audited.';
