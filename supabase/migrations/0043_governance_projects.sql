-- =====================================================================
-- POLITICORE — MIGRATION 0043: GOVERNANCE DELIVERY — PROJECTS (PHASE 12)
-- =====================================================================
-- First implementation slice of the Phase 11 Delivery cluster
-- (docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md
-- §3 Projects, §11 Updates, §12 Accountability, §15 Geography, §16
-- Permissions, §19 Audit, §23 Portal).
--
-- Creates:
--   politicore.governance_projects             canonical delivery entity
--   politicore.governance_project_milestones   child records (progress source)
--   politicore.governance_project_scopes       Core Geography scope rows
--   politicore.governance_updates              ONE canonical update substrate
--                                              (single-subject invariant;
--                                              Phase 12 ships the Project
--                                              subject only)
--   permission 'manage_projects'               (no new roles — §16)
--
-- Security posture (all FORCE RLS, server-resolved tenant/actor):
--   * zero anonymous policies on every new table
--   * writes only via SECURITY DEFINER authority RPCs (manage_projects
--     + geo-scope authority per row)
--   * campaign scope FORBIDDEN to Governance (CHECK, §15)
--   * lifecycle transitions server-enforced; no app-role DELETE
--     (institutional memory — §24 of the gate)
--   * progress is derived from milestones (authoritative trigger); a
--     manual override only when the project has NO milestones, so the
--     stored value can never contradict milestone state (§8 of prompt)
--   * Core audit via the 0002 audit_authority_change trigger + explicit
--     RPC audit rows. No governance audit tables (§19).
--   * Media: relations only — projects/milestones/updates reference
--     politicore.media_assets. No storage here (§18).
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- PERMISSION VOCABULARY (+1 — Phase 11 §16 authorized exactly this)
-- ---------------------------------------------------------------------
-- Grant paths remain the existing ones (position_permissions matrix,
-- permission_grants, admin bypass). No new roles. No position_defaults
-- changes; tenants assign 'manage_projects' through the existing
-- grant architecture.
-- ---------------------------------------------------------------------
INSERT INTO politicore.permissions (name, domain, description) VALUES
  ('manage_projects', 'governance', 'Create, progress and complete Governance projects (and later commitments) within the holder''s scope')
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- PROJECT STATUS LIFECYCLE (gate §3 — five-value enum, server-guarded)
-- ---------------------------------------------------------------------
--   planned → active → suspended → active (resume) → completed | cancelled
--   Terminal states: completed, cancelled (institutional memory — no
--   DELETE). suspended is entered only from active and can only resume.
-- ---------------------------------------------------------------------
CREATE TYPE politicore.governance_project_status AS ENUM (
  'planned', 'active', 'suspended', 'completed', 'cancelled'
);

CREATE TYPE politicore.governance_update_kind AS ENUM (
  'progress', 'milestone', 'outcome', 'announcement'
);

-- ─────────────────────────────────────────────────────────────────────────
-- PROJECTS — canonical delivery entity (gate §3 canonical columns)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  reference_code      text NOT NULL UNIQUE,               -- GP-<shortid> (identifier, not credential)
  title               text NOT NULL,
  description         text NOT NULL DEFAULT '',
  category_label      text NOT NULL DEFAULT '',           -- tenant-defined text label; NO taxonomy table in v1
  owner_profile_id    uuid REFERENCES politicore.profiles(id),  -- accountable staff
  implementing_org    text NOT NULL DEFAULT '',           -- text field, NOT an organizations entity (gate §27)
  status              politicore.governance_project_status NOT NULL DEFAULT 'planned',
  planned_start       date,
  planned_end         date,
  actual_start        date,
  actual_end          date,
  planned_budget      numeric(16,2) CHECK (planned_budget IS NULL OR planned_budget >= 0),
  currency            text NOT NULL DEFAULT 'NGN',
  funding_source      text NOT NULL DEFAULT '',
  -- Derived-first progress: maintained ONLY by the milestone trigger or
  -- the manual-progress RPC (which refuses when milestones exist).
  progress_percent    smallint NOT NULL DEFAULT 0
                      CHECK (progress_percent BETWEEN 0 AND 100),
  beneficiary_summary text NOT NULL DEFAULT '',           -- AGGREGATE only — no person-level PII (gate §3)
  beneficiaries_estimated integer CHECK (beneficiaries_estimated IS NULL OR beneficiaries_estimated >= 0),
  is_public           boolean NOT NULL DEFAULT false,     -- Private by default (gate §12)
  published_at        timestamptz,
  created_by          uuid REFERENCES politicore.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_projects_tenant_idx
  ON politicore.governance_projects (tenant_id, created_at DESC);
CREATE INDEX governance_projects_status_idx
  ON politicore.governance_projects (tenant_id, status);

-- Date sanity (server-enforced field validation).
ALTER TABLE politicore.governance_projects
  ADD CONSTRAINT governance_projects_dates CHECK (
    planned_start IS NULL OR planned_end IS NULL OR planned_start <= planned_end
  );

-- ─────────────────────────────────────────────────────────────────────────
-- MILESTONES — child records; progress derives from them (gate §3)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_project_milestones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES politicore.governance_projects(id) ON DELETE CASCADE,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  sort_order        integer NOT NULL DEFAULT 0,
  due_date          date,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','done','cancelled')),
  completed_at      timestamptz,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_project_milestones_project_idx
  ON politicore.governance_project_milestones (project_id, sort_order, created_at);

-- Deterministic completion metadata (server-stamped, not client-supplied).
CREATE OR REPLACE FUNCTION politicore.guard_project_milestone_completion()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    NEW.completed_at := now();
  ELSIF NEW.status <> 'done' THEN
    NEW.completed_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_project_milestone_completion
  BEFORE UPDATE OF status ON politicore.governance_project_milestones
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_project_milestone_completion();

-- AUTHORITATIVE PROGRESS DERIVATION (gate §3 "derived-first").
-- Maintains progress_percent as the fraction of non-cancelled milestones
-- that are done. The manual override RPC refuses to run when milestones
-- exist, so the stored value can never contradict milestone state.
CREATE OR REPLACE FUNCTION politicore.recompute_project_progress()
RETURNS trigger AS $$
DECLARE
  v_project uuid;
  v_total integer; v_done integer;
BEGIN
  v_project := COALESCE(NEW.project_id, OLD.project_id);
  SELECT count(*), count(*) FILTER (WHERE status = 'done')
    INTO v_total, v_done
    FROM politicore.governance_project_milestones
   WHERE project_id = v_project AND status <> 'cancelled';
  UPDATE politicore.governance_projects
     SET progress_percent = CASE WHEN v_total = 0 THEN 0
                                 ELSE (v_done * 100 / v_total)::smallint END
   WHERE id = v_project;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_project_progress_recompute
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_project_milestones
  FOR EACH ROW EXECUTE FUNCTION politicore.recompute_project_progress();

-- ─────────────────────────────────────────────────────────────────────────
-- PROJECT GEOGRAPHIC SCOPES — Core Geography reuse (gate §15)
-- ---------------------------------------------------------------------
-- Per-object scope rows; five geographic values only; 'campaign' is
-- FORBIDDEN to Governance (CHECK). Multi-scope first-class. Exactly one
-- geography column per row (polymorphic integrity). Higher scope covers
-- descendants via existing scope_covers() — nothing materialized.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_project_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES politicore.governance_projects(id) ON DELETE CASCADE,
  scope_type  politicore.scope_type_enum NOT NULL
              CHECK (scope_type IN ('polling_unit','ward','lga','senatorial_zone','state')),
  state_id    text REFERENCES politicore.states(id),
  zone_id     text REFERENCES politicore.senatorial_zones(id),
  lga_id      text REFERENCES politicore.lgas(id),
  ward_id     text REFERENCES politicore.wards(id),
  polling_unit_id text REFERENCES politicore.polling_units(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id),
  CONSTRAINT governance_project_scopes_geography CHECK (
    (scope_type = 'state'           AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'lga'             AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'ward'            AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'polling_unit'    AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
  )
);

CREATE INDEX governance_project_scopes_project_idx
  ON politicore.governance_project_scopes (project_id);
CREATE INDEX governance_project_scopes_geo_idx
  ON politicore.governance_project_scopes (tenant_id, scope_type, lga_id, ward_id);

-- ─────────────────────────────────────────────────────────────────────────
-- UPDATES — ONE canonical substrate (gate §11 verbatim design)
-- ---------------------------------------------------------------------
-- Typed nullable subject FKs + single-subject CHECK. Phase 12 ships the
-- Project subject; Commitments/Consultations/Petitions/Engagements
-- subjects arrive with their own phases WITHOUT redesigning this table
-- (a later migration adds the FK columns — the invariant never changes).
-- Requests keep governance_request_events (gate §11).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_updates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  project_id        uuid REFERENCES politicore.governance_projects(id) ON DELETE CASCADE,
  -- Future subjects (Phase 11 §11). Columns do NOT exist yet; the
  -- single-subject constraint below is written so later phases EXTEND it
  -- rather than replace it. v1 subjects: project only.
  author_profile_id uuid REFERENCES politicore.profiles(id),  -- staff-authored (gate §11)
  title             text NOT NULL DEFAULT '',
  body              text NOT NULL,
  kind              politicore.governance_update_kind NOT NULL DEFAULT 'progress',
  is_public         boolean NOT NULL DEFAULT false,
  published_at      timestamptz,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- SINGLE-SUBJECT INVARIANT (gate §11): exactly one subject FK.
  CONSTRAINT governance_updates_single_subject CHECK (
    (project_id IS NOT NULL)::int = 1
  )
);

CREATE INDEX governance_updates_project_idx
  ON politicore.governance_updates (project_id, created_at DESC);
CREATE INDEX governance_updates_tenant_idx
  ON politicore.governance_updates (tenant_id, created_at DESC);

-- Publication semantics: is_public rows carry the publication stamp;
-- retraction clears it (audited, not erased — gate §24).
CREATE OR REPLACE FUNCTION politicore.touch_governance_update_publication()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_public AND (TG_OP = 'INSERT' OR NOT OLD.is_public) THEN
    NEW.published_at := now();
  ELSIF NOT NEW.is_public THEN
    NEW.published_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_update_publication
  BEFORE INSERT OR UPDATE OF is_public ON politicore.governance_updates
  FOR EACH ROW EXECUTE FUNCTION politicore.touch_governance_update_publication();

-- ─────────────────────────────────────────────────────────────────────────
-- LIFECYCLE GUARDS — server-enforced transitions (prompt §7)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_project_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'planned'   AND NEW.status IN ('active','cancelled'))
    OR (OLD.status = 'active'    AND NEW.status IN ('suspended','completed','cancelled'))
    OR (OLD.status = 'suspended' AND NEW.status IN ('active','cancelled'))
  ) THEN
    RAISE EXCEPTION 'governance: illegal project transition % -> %', OLD.status, NEW.status;
  END IF;
  -- Terminal timestamps are server-stamped, never client-supplied.
  IF NEW.status = 'completed' THEN
    NEW.actual_end := COALESCE(NEW.actual_end, CURRENT_DATE);
  END IF;
  IF OLD.status = 'planned' AND NEW.status = 'active' THEN
    NEW.actual_start := COALESCE(NEW.actual_start, CURRENT_DATE);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_project_status_guard
  BEFORE UPDATE OF status ON politicore.governance_projects
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_project_status();

-- Frozen-field guard: reference_code is minted once; publication stamp
-- and progress are server-managed (publication through the RPC; progress
-- through the derivation trigger / manual RPC).
CREATE OR REPLACE FUNCTION politicore.guard_governance_project_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: project reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: project visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_project_identity
  BEFORE UPDATE ON politicore.governance_projects
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_project_identity();

-- Project reference: GP- prefix + 8 uppercase hex chars (identifier only,
-- ~32-bit space per the gate's reference doctrine; uniqueness enforced).
CREATE OR REPLACE FUNCTION politicore.make_governance_project_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'GP-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_projects WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_project_reference
  BEFORE INSERT ON politicore.governance_projects
  FOR EACH ROW EXECUTE FUNCTION politicore.make_governance_project_reference();

-- ─────────────────────────────────────────────────────────────────────────
-- GEOGRAPHIC AUTHORITY (server-side — the §10 multi-scope rule)
-- ---------------------------------------------------------------------
-- A caller may manage a project when the caller's assignments/grants
-- cover AT LEAST ONE of the project's scope rows (any-of semantics),
-- evaluated with the Core scope_covers() hierarchy. Admins and
-- state-scoped authority cover everything.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.has_project_geo_authority(
  p_project uuid
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politicore.governance_project_scopes ps
     WHERE ps.project_id = p_project
       AND politicore.has_permission('manage_projects', ps.scope_type,
             COALESCE(ps.polling_unit_id, ps.ward_id, ps.lga_id, ps.zone_id, ps.state_id))
  )
  OR ( -- a tenant-wide grant covers any scope
    politicore.has_permission('manage_projects')
    AND EXISTS (SELECT 1 FROM politicore.governance_projects
                 WHERE id = p_project AND tenant_id = politicore.current_tenant_id())
  );
$$ LANGUAGE sql STABLE SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs (SECURITY DEFINER; resolve caller+tenant+permission
-- server-side; audit in Core; never trust client authority fields)
-- ---------------------------------------------------------------------

-- Shared guard: project must exist in the caller's tenant, module on,
-- manage_projects held, geographic authority over the project's scopes.
CREATE OR REPLACE FUNCTION politicore.assert_project_authority(
  p_project uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_projects WHERE id = p_project;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: project not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_project_geo_authority(p_project)) THEN
    RAISE EXCEPTION 'governance: manage_projects with geographic authority required';
  END IF;
  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- CREATE. Server mints reference, tenant, created_by. Initial scopes are
-- validated against Core Geography and against the CALLER's authority
-- (you cannot create a project at a scope you do not manage — §28).
CREATE OR REPLACE FUNCTION politicore.create_governance_project(
  p_title text,
  p_description text DEFAULT '',
  p_category_label text DEFAULT '',
  p_implementing_org text DEFAULT '',
  p_owner_profile_id uuid DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_planned_end date DEFAULT NULL,
  p_planned_budget numeric DEFAULT NULL,
  p_currency text DEFAULT 'NGN',
  p_funding_source text DEFAULT '',
  p_beneficiary_summary text DEFAULT '',
  p_beneficiaries_estimated integer DEFAULT NULL,
  p_scopes jsonb DEFAULT '[]'::jsonb   -- [{scope_type, state_id, zone_id?, lga_id?, ward_id?, polling_unit_id?}]
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_project uuid;
  v_s jsonb;
  v_owner_tenant uuid;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: title is required';
  END IF;
  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.has_permission('manage_projects') THEN
    RAISE EXCEPTION 'governance: manage_projects required';
  END IF;

  IF p_owner_profile_id IS NOT NULL THEN
    SELECT tenant_id INTO v_owner_tenant FROM politicore.profiles WHERE id = p_owner_profile_id;
    IF v_owner_tenant IS NULL OR v_owner_tenant <> v_tenant THEN
      RAISE EXCEPTION 'governance: owner must belong to the same tenant';
    END IF;
  END IF;

  INSERT INTO politicore.governance_projects
    (tenant_id, title, description, category_label, owner_profile_id,
     implementing_org, planned_start, planned_end, planned_budget,
     currency, funding_source, beneficiary_summary, beneficiaries_estimated,
     created_by)
  VALUES
    (v_tenant, btrim(p_title), p_description, p_category_label,
     p_owner_profile_id, p_implementing_org, p_planned_start, p_planned_end,
     p_planned_budget, p_currency, p_funding_source,
     p_beneficiary_summary, p_beneficiaries_estimated, v_caller)
  RETURNING id INTO v_project;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes) LOOP
      PERFORM politicore.add_governance_project_scope(v_project,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_project:create',
          'governance_projects', v_project::text,
          jsonb_build_object('title', p_title, 'status', 'planned'));
  RETURN v_project;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE (non-authoritative presentation fields only).
CREATE OR REPLACE FUNCTION politicore.update_governance_project(
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
DECLARE
  v_tenant uuid;
  v_owner_tenant uuid;
  v_old_owner uuid;
BEGIN
  v_tenant := politicore.assert_project_authority(p_project);

  IF p_owner_profile_id IS NOT NULL THEN
    SELECT tenant_id INTO v_owner_tenant FROM politicore.profiles WHERE id = p_owner_profile_id;
    IF v_owner_tenant IS NULL OR v_owner_tenant <> v_tenant THEN
      RAISE EXCEPTION 'governance: owner must belong to the same tenant';
    END IF;
  END IF;

  -- Owner change? Resolve the PREVIOUS owner first for the notification.
  IF p_owner_profile_id IS NOT NULL THEN
    SELECT owner_profile_id INTO v_old_owner
      FROM politicore.governance_projects WHERE id = p_project;
  END IF;

  UPDATE politicore.governance_projects SET
    title                   = COALESCE(p_title, title),
    description             = COALESCE(p_description, description),
    category_label          = COALESCE(p_category_label, category_label),
    implementing_org        = COALESCE(p_implementing_org, implementing_org),
    owner_profile_id        = COALESCE(p_owner_profile_id, owner_profile_id),
    planned_start           = COALESCE(p_planned_start, planned_start),
    planned_end             = COALESCE(p_planned_end, planned_end),
    planned_budget          = COALESCE(p_planned_budget, planned_budget),
    currency                = COALESCE(p_currency, currency),
    funding_source          = COALESCE(p_funding_source, funding_source),
    beneficiary_summary     = COALESCE(p_beneficiary_summary, beneficiary_summary),
    beneficiaries_estimated = COALESCE(p_beneficiaries_estimated, beneficiaries_estimated),
    actual_start = CASE WHEN p_clear_actual_dates THEN NULL ELSE actual_start END,
    actual_end   = CASE WHEN p_clear_actual_dates THEN NULL ELSE actual_end END
  WHERE id = p_project;

  -- §22 notification intent: the one implemented workflow that warrants a
  -- notification — a staff member becomes accountable for a project.
  -- Best-effort (0036 precedent): never fails the business action.
  IF p_owner_profile_id IS NOT NULL AND v_old_owner IS DISTINCT FROM p_owner_profile_id THEN
    PERFORM politicore.governance_notify_project_owner(p_project, p_owner_profile_id, auth.uid());
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id)
  VALUES (v_tenant, auth.uid(), 'governance_project:update',
          'governance_projects', p_project::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STATUS TRANSITION (guard trigger enforces the ladder; here we audit).
CREATE OR REPLACE FUNCTION politicore.set_governance_project_status(
  p_project uuid,
  p_status text
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old politicore.governance_project_status;
BEGIN
  v_tenant := politicore.assert_project_authority(p_project);
  SELECT status INTO v_old FROM politicore.governance_projects WHERE id = p_project;

  UPDATE politicore.governance_projects
     SET status = p_status::politicore.governance_project_status
   WHERE id = p_project;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_project:status',
          'governance_projects', p_project::text,
          jsonb_build_object('status', v_old::text),
          jsonb_build_object('status', p_status));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- GEOGRAPHIC SCOPES (validated against Core Geography + caller authority;
-- scope_type='campaign' is rejected here as defense-in-depth beside the
-- table CHECK).
CREATE OR REPLACE FUNCTION politicore.add_governance_project_scope(
  p_project uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_exists boolean;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance projects';
  END IF;
  v_tenant := politicore.assert_project_authority(p_project);

  -- A non-admin caller cannot attach a scope they do not manage (§28).
  IF NOT (politicore.is_tenant_admin()
          OR politicore.has_permission('manage_projects', p_scope_type,
               COALESCE(p_polling_unit_id, p_ward_id, p_lga_id, p_zone_id, p_state_id))) THEN
    RAISE EXCEPTION 'governance: caller may not attach a scope outside their authority';
  END IF;

  -- Core Geography validation (fail closed on unknown ids).
  v_exists :=
       (p_scope_type = 'state'           AND p_state_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.states WHERE id = p_state_id))
    OR (p_scope_type = 'senatorial_zone' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.senatorial_zones
                       WHERE id = p_zone_id AND state_id = p_state_id))
    OR (p_scope_type = 'lga' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL AND p_lga_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.lgas
                       WHERE id = p_lga_id AND zone_id = p_zone_id AND state_id = p_state_id))
    OR (p_scope_type = 'ward' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL AND p_lga_id IS NOT NULL AND p_ward_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.wards
                       WHERE id = p_ward_id AND lga_id = p_lga_id))
    OR (p_scope_type = 'polling_unit' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL AND p_lga_id IS NOT NULL AND p_ward_id IS NOT NULL AND p_polling_unit_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.polling_units
                       WHERE id = p_polling_unit_id AND ward_id = p_ward_id AND lga_id = p_lga_id));
  IF NOT v_exists THEN
    RAISE EXCEPTION 'governance: scope does not match Core Geography';
  END IF;

  DECLARE
    v_scope uuid;
  BEGIN
    INSERT INTO politicore.governance_project_scopes
      (tenant_id, project_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
    VALUES (v_tenant, p_project, p_scope_type, p_state_id, p_zone_id,
            p_lga_id, p_ward_id, p_polling_unit_id)
    ON CONFLICT (project_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
    DO NOTHING
    RETURNING id INTO v_scope;

    IF v_scope IS NOT NULL THEN
      INSERT INTO politicore.system_audits
        (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
      VALUES (v_tenant, auth.uid(), 'governance_project:scope_add',
              'governance_project_scopes', v_scope::text,
              jsonb_build_object('project', p_project, 'scope_type', p_scope_type::text,
                                 'scope_id', COALESCE(p_polling_unit_id, p_ward_id, p_lga_id, p_zone_id, p_state_id)));
    END IF;
    RETURN v_scope;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_project_scope(
  p_scope uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_project uuid;
BEGIN
  SELECT project_id INTO v_project FROM politicore.governance_project_scopes WHERE id = p_scope;
  IF v_project IS NULL THEN
    RAISE EXCEPTION 'governance: scope not found';
  END IF;
  v_tenant := politicore.assert_project_authority(v_project);

  DELETE FROM politicore.governance_project_scopes WHERE id = p_scope;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value)
  VALUES (v_tenant, auth.uid(), 'governance_project:scope_remove',
          'governance_project_scopes', p_scope::text,
          jsonb_build_object('project', v_project));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- MILESTONES (progress derives automatically via the trigger).
CREATE OR REPLACE FUNCTION politicore.create_governance_project_milestone(
  p_project uuid,
  p_title text,
  p_description text DEFAULT '',
  p_sort_order integer DEFAULT 0,
  p_due_date date DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid; v_id uuid;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: milestone title is required';
  END IF;
  v_tenant := politicore.assert_project_authority(p_project);

  INSERT INTO politicore.governance_project_milestones
    (tenant_id, project_id, title, description, sort_order, due_date)
  VALUES (v_tenant, p_project, btrim(p_title), p_description, p_sort_order, p_due_date)
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_project_milestone:create',
          'governance_project_milestones', v_id::text,
          jsonb_build_object('project', p_project, 'title', p_title));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.update_governance_project_milestone(
  p_milestone uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_sort_order integer DEFAULT NULL,
  p_due_date date DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_evidence_asset_id uuid DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_project uuid;
  v_old_status text; v_new_status text;
BEGIN
  SELECT tenant_id, project_id, status::text
    INTO v_tenant, v_project, v_old_status
    FROM politicore.governance_project_milestones WHERE id = p_milestone;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: milestone not found';
  END IF;
  PERFORM politicore.assert_project_authority(v_project);

  IF p_evidence_asset_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = p_evidence_asset_id
                      AND tenant_id = politicore.current_tenant_id()) THEN
      RAISE EXCEPTION 'governance: evidence asset not found in this tenant';
    END IF;
  END IF;

  v_new_status := COALESCE(p_status, v_old_status);
  IF v_new_status NOT IN ('pending','in_progress','done','cancelled') THEN
    RAISE EXCEPTION 'governance: invalid milestone status';
  END IF;

  UPDATE politicore.governance_project_milestones SET
    title             = COALESCE(p_title, title),
    description       = COALESCE(p_description, description),
    sort_order        = COALESCE(p_sort_order, sort_order),
    due_date          = COALESCE(p_due_date, due_date),
    status            = v_new_status::text,
    evidence_asset_id = COALESCE(p_evidence_asset_id, evidence_asset_id)
  WHERE id = p_milestone;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_project_milestone:update',
          'governance_project_milestones', p_milestone::text,
          jsonb_build_object('status', v_old_status),
          jsonb_build_object('status', v_new_status));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- MANUAL PROGRESS OVERRIDE — only lawful when the project has NO
-- milestones (otherwise the derived value is authoritative and this RPC
-- refuses, so stored progress can never contradict milestone state).
CREATE OR REPLACE FUNCTION politicore.set_governance_project_progress(
  p_project uuid,
  p_progress smallint
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_milestones integer;
BEGIN
  IF p_progress < 0 OR p_progress > 100 THEN
    RAISE EXCEPTION 'governance: progress must be 0-100';
  END IF;
  v_tenant := politicore.assert_project_authority(p_project);
  SELECT count(*) INTO v_milestones
    FROM politicore.governance_project_milestones
   WHERE project_id = p_project AND status <> 'cancelled';
  IF v_milestones > 0 THEN
    RAISE EXCEPTION 'governance: progress is derived from milestones';
  END IF;
  UPDATE politicore.governance_projects
     SET progress_percent = p_progress WHERE id = p_project;
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_project:progress',
          'governance_projects', p_project::text,
          jsonb_build_object('progress', p_progress, 'mode', 'manual'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATES (canonical substrate — Project subject only in Phase 12).
CREATE OR REPLACE FUNCTION politicore.create_governance_update(
  p_project uuid,
  p_title text,
  p_body text,
  p_kind text DEFAULT 'progress',
  p_is_public boolean DEFAULT false,
  p_evidence_asset_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid; v_id uuid;
  v_kind politicore.governance_update_kind;
BEGIN
  IF p_body IS NULL OR length(btrim(p_body)) = 0 THEN
    RAISE EXCEPTION 'governance: update body is required';
  END IF;
  v_tenant := politicore.assert_project_authority(p_project);
  v_kind := p_kind::politicore.governance_update_kind;

  IF p_evidence_asset_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = p_evidence_asset_id
                      AND tenant_id = politicore.current_tenant_id()) THEN
      RAISE EXCEPTION 'governance: evidence asset not found in this tenant';
    END IF;
  END IF;

  INSERT INTO politicore.governance_updates
    (tenant_id, project_id, author_profile_id, title, body, kind,
     is_public, evidence_asset_id)
  VALUES (v_tenant, p_project, auth.uid(), COALESCE(p_title,''), btrim(p_body),
          v_kind, p_is_public, p_evidence_asset_id)
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_update:create',
          'governance_updates', v_id::text,
          jsonb_build_object('project', p_project, 'kind', v_kind::text,
                             'is_public', p_is_public));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE VISIBILITY — the publication/retraction lever (audited; the
-- direct-table path is blocked by the identity guard for projects and
-- by RLS writes for updates).
CREATE OR REPLACE FUNCTION politicore.set_governance_update_visibility(
  p_update uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_project uuid; v_old boolean;
BEGIN
  SELECT tenant_id, project_id, is_public INTO v_tenant, v_project, v_old
    FROM politicore.governance_updates WHERE id = p_update;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: update not found';
  END IF;
  PERFORM politicore.assert_project_authority(v_project);

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

-- PROJECT VISIBILITY (Publication is an explicit, audited accountability
-- action — gate §12. The public projections/console remain the future
-- Accountability phase; this only maintains the underlying state.)
CREATE OR REPLACE FUNCTION politicore.set_governance_project_visibility(
  p_project uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_old boolean;
BEGIN
  v_tenant := politicore.assert_project_authority(p_project);
  SELECT is_public INTO v_old FROM politicore.governance_projects WHERE id = p_project;

  -- License the identity guard for this transaction-scoped, RPC-only
  -- visibility mutation (session GUCs cannot be set through PostgREST).
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

-- NOTIFICATION INTENT (Phase 12's single implemented workflow: an owner
-- is assigned responsibility for a project — §22 requires an intent only
-- where a workflow warrants one; best-effort, 0036 precedent).
CREATE OR REPLACE FUNCTION politicore.governance_notify_project_owner(
  p_project uuid,
  p_owner uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_title text;
BEGIN
  SELECT title INTO v_title FROM politicore.governance_projects WHERE id = p_project;
  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  VALUES (
    politicore.current_tenant_id(), p_owner, 'system',
    'You are accountable for a Governance project',
    'Project "' || v_title || '" has been placed under your responsibility.',
    '/portal/governance/projects/' || p_project::text,
    p_actor
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance project owner notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — FORCE, tenant-scoped, zero anonymous surface (prompt §30/§31)
-- ---------------------------------------------------------------------
-- READS (direct table SELECT) are staff-visible within the tenant:
--   view_governance holders (scope-filtered by has_permission's own
--   semantics when a scope is passed) + admins. Ordinary members and
--   anon get nothing from base tables; public projections are a future
--   Accountability-phase RPC concern. WRITES: NO INSERT/UPDATE/DELETE
--   policies — every mutation flows through the authority RPCs above
--   (the 0034 precedent for events; fail closed by absence).
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_projects            ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_projects            FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_project_milestones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_project_milestones  FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_project_scopes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_project_scopes      FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_updates             ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_updates             FORCE  ROW LEVEL SECURITY;

CREATE POLICY governance_projects_read ON politicore.governance_projects
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

CREATE POLICY governance_project_milestones_read ON politicore.governance_project_milestones
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

CREATE POLICY governance_project_scopes_read ON politicore.governance_project_scopes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Updates: is_public rows are readable by any tenant MEMBER (the
-- authenticated-level rung of the visibility taxonomy, gate §12);
-- private ones need staff visibility.
CREATE POLICY governance_updates_read ON politicore.governance_updates
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (is_public
         OR politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- ─────────────────────────────────────────────────────────────────────────
-- CORE AUDIT TRIGGERS (canonical stream — 0002 definer; §21)
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_audit_governance_projects
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_projects
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_project_milestones
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_project_milestones
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_project_scopes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_project_scopes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_updates
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_updates
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- HYGIENE — no EXECUTE on authority RPCs except authenticated (the 0007
-- blanket default grants EXECUTE to anon+authenticated+service_role;
-- anon must not even call these).
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION politicore.create_governance_project(text,text,text,text,uuid,date,date,numeric,text,text,text,integer,jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.update_governance_project(uuid,text,text,text,text,uuid,date,date,numeric,text,text,text,integer,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_project_status(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.add_governance_project_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.remove_governance_project_scope(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.create_governance_project_milestone(uuid,text,text,integer,date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.update_governance_project_milestone(uuid,text,text,integer,date,text,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_project_progress(uuid,smallint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.create_governance_update(uuid,text,text,text,boolean,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_update_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_project_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_notify_project_owner(uuid,uuid,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.assert_project_authority(uuid) FROM PUBLIC, anon;
