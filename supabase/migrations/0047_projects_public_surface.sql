-- =====================================================================
-- POLITICORE — MIGRATION 0047: PROJECTS PUBLIC DATA-API SURFACE (P12)
-- ---------------------------------------------------------------------
-- Hosted PostgREST exposes the public schema only (0009 constraint).
-- 0034 established the convention for governance tables: thin
-- security_invoker views (zero authorization of their own — base-table
-- FORCE RLS remains the only boundary), mirrored grants, explicit anon
-- revokes, and public RPC wrappers. This migration applies the same
-- contract to the four Phase 12 tables.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER VIEWS
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.governance_projects
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_projects;
CREATE OR REPLACE VIEW public.governance_project_milestones
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_project_milestones;
CREATE OR REPLACE VIEW public.governance_project_scopes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_project_scopes;
CREATE OR REPLACE VIEW public.governance_updates
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_updates;

-- Base-table grants (REQUIRED for security_invoker views: policy checks
-- run with the caller's role). No write policies exist on these tables —
-- mutations flow exclusively through the authority RPCs; these DML grants
-- simply mirror the 0034 posture where RLS is the real boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_projects           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_project_milestones TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_project_scopes     TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_updates            TO authenticated, service_role;

-- View grants mirror the base grants; RLS remains the real boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_projects           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_project_milestones TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_project_scopes     TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_updates            TO authenticated, service_role;

-- Anonymous holds NOTHING (gate §12/§31; mirrors 0034 hygiene). Hosted
-- default privileges auto-grant ALL on new public relations — explicit
-- revokes keep the grant surface on contract, including from PUBLIC
-- (owners hold grantable rights via PUBLIC regardless of per-role grants).
REVOKE ALL ON public.governance_projects           FROM anon;
REVOKE ALL ON public.governance_project_milestones FROM anon;
REVOKE ALL ON public.governance_project_scopes     FROM anon;
REVOKE ALL ON public.governance_updates            FROM anon;
REVOKE ALL ON public.governance_projects           FROM PUBLIC;
REVOKE ALL ON public.governance_project_milestones FROM PUBLIC;
REVOKE ALL ON public.governance_project_scopes     FROM PUBLIC;
REVOKE ALL ON public.governance_updates            FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC RPC WRAPPERS (0005/0034 convention: PostgREST-resolvable)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_governance_project(
  p_project uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_category_label text DEFAULT NULL,
  p_implementing_org text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_planned_end date DEFAULT NULL,
  p_planned_budget numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_funding_source text DEFAULT NULL,
  p_beneficiary_summary text DEFAULT NULL,
  p_beneficiaries_estimated integer DEFAULT NULL,
  p_clear_actual_dates boolean DEFAULT false
) RETURNS void AS $$
  SELECT politicore.update_governance_project(
    p_project, p_title, p_description, p_category_label, p_implementing_org,
    p_owner_profile_id, p_planned_start, p_planned_end, p_planned_budget,
    p_currency, p_funding_source, p_beneficiary_summary,
    p_beneficiaries_estimated, p_clear_actual_dates);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_governance_project_status(
  p_project uuid, p_status text
) RETURNS void AS $$
  SELECT politicore.set_governance_project_status(p_project, p_status);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.add_governance_project_scope(
  p_project uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.add_governance_project_scope(
    p_project, p_scope_type, p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.remove_governance_project_scope(
  p_scope uuid
) RETURNS void AS $$
  SELECT politicore.remove_governance_project_scope(p_scope);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.create_governance_project_milestone(
  p_project uuid, p_title text,
  p_description text DEFAULT '', p_sort_order integer DEFAULT 0,
  p_due_date date DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.create_governance_project_milestone(
    p_project, p_title, p_description, p_sort_order, p_due_date);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.update_governance_project_milestone(
  p_milestone uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_sort_order integer DEFAULT NULL,
  p_due_date date DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_evidence_asset_id uuid DEFAULT NULL
) RETURNS void AS $$
  SELECT politicore.update_governance_project_milestone(
    p_milestone, p_title, p_description, p_sort_order, p_due_date, p_status, p_evidence_asset_id);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_governance_project_progress(
  p_project uuid, p_progress smallint
) RETURNS void AS $$
  SELECT politicore.set_governance_project_progress(p_project, p_progress);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.create_governance_update(
  p_project uuid, p_title text, p_body text,
  p_kind text DEFAULT 'progress', p_is_public boolean DEFAULT false,
  p_evidence_asset_id uuid DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.create_governance_update(
    p_project, p_title, p_body, p_kind, p_is_public, p_evidence_asset_id);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_governance_update_visibility(
  p_update uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_update_visibility(p_update, p_is_public);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_governance_project_visibility(
  p_project uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_project_visibility(p_project, p_is_public);
$$ LANGUAGE sql;

-- Hygiene: authority RPCs are authenticated-only (0007 default grants
-- include anon on new public functions; revoke).
REVOKE EXECUTE ON FUNCTION public.update_governance_project(uuid,text,text,text,text,uuid,date,date,numeric,text,text,text,integer,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_project_status(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.add_governance_project_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.remove_governance_project_scope(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_project_milestone(uuid,text,text,integer,date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.update_governance_project_milestone(uuid,text,text,integer,date,text,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_project_progress(uuid,smallint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_update(uuid,text,text,text,boolean,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_update_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_project_visibility(uuid,boolean) FROM PUBLIC, anon;

COMMENT ON TABLE politicore.governance_projects IS
  'Governance Delivery — canonical project aggregate (Phase 12). Peer substrate with requests. Lifecycle: planned -> active -> suspended/active -> completed | cancelled (server-guarded; terminal states retained for institutional memory). Progress is milestone-derived; writes flow through authority RPCs.';
COMMENT ON TABLE politicore.governance_updates IS
  'Canonical Governance update substrate (Phase 11 §11) — typed nullable subject FKs with a single-subject CHECK. Phase 12 ships the project subject; later delivery/participation phases extend the subject set without redesign.';
