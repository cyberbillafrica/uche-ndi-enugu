-- =====================================================================
-- POLITICORE — MIGRATION 0048: GOVERNANCE COMMITMENTS (P13)
-- ---------------------------------------------------------------------
-- Second Governance Delivery domain, implementing Phase 11 §4 exactly:
--
--   * governance_commitments          — structured standalone deliverables
--     (NOT a Manifesto mirror: source_type/source_ref lineage only; NO
--     FK into the locked manifestos module — gate §4 DECISION 1)
--   * governance_commitment_scopes    — Core Geography scope rows, the
--     same model as governance_project_scopes (no Governance geography)
--   * governance_commitment_projects  — OPTIONAL many-to-many join; no
--     hard coupling in either direction (gate §4 DECISION 3). Links are
--     data relationships, never authority (gate §11).
--   * governance_updates              — EXTENDED with commitment_id; the
--     single-subject constraint is REWRITTEN (same name) so later phases
--     extend it further. One update still targets exactly one subject.
--
-- Authorization: NO new permission, NO new role. manage_projects
-- (projects + commitments, Phase 11 §16) with the same tenant + module +
-- geographic semantics proven in Phase 12 (assert/has helpers mirrored).
--
-- Progress: explicitly reported (gate §4.4 — progress percent + updates;
-- outcome = the terminal update + status transition). Project linkage is
-- evidence, not computation — deriving progress from linked projects
-- would create a second, conflicting authority (prompt §9).
--
-- Lifecycle (gate §4): declared → in_progress → partially_delivered /
-- delivered, dropped. delivered and dropped are terminal (institutional
-- memory: completed commitments are retained, never deleted). Transitions
-- are server-enforced by trigger; terminal timestamps are server-stamped.
--
-- Visibility: is_public Private-by-default; publication is an explicit,
-- audited authority-RPC action gated by the identity guard's GUC license
-- (the Phase 12 pattern). Public discovery/console remains Phase 18.
--
-- Audit: Core system_audits via the canonical audit_authority_change
-- triggers plus explicit old→new audits in every authority RPC.
-- Notifications: one owner-assignment intent through Core notifications
-- (Phase 12 pattern); no Governance notification subsystem.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- ENUMS
-- ---------------------------------------------------------------------
CREATE TYPE politicore.governance_commitment_status AS ENUM (
  'declared', 'in_progress', 'partially_delivered', 'delivered', 'dropped'
);

-- Phase 11 §4 source vocabulary (exact six values; 'independent' covers
-- town halls, petitions, in-office and internally adopted objectives).
CREATE TYPE politicore.governance_commitment_source_type AS ENUM (
  'manifesto', 'engagement', 'consultation', 'petition', 'request', 'independent'
);

-- ─────────────────────────────────────────────────────────────────────────
-- COMMITMENTS — canonical standalone deliverable (gate §4 column set)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_commitments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  reference_code      text NOT NULL UNIQUE,               -- GC-<shortid> (identifier, not credential)
  title               text NOT NULL,
  details             text NOT NULL DEFAULT '',
  category_label      text NOT NULL DEFAULT '',           -- tenant-defined text label; NO taxonomy table in v1
  source_type         politicore.governance_commitment_source_type NOT NULL DEFAULT 'independent',
  source_ref          text,                               -- human-readable lineage anchor; NO manifesto FK (gate §4)
  owner_profile_id    uuid REFERENCES politicore.profiles(id),  -- accountable staff
  status              politicore.governance_commitment_status NOT NULL DEFAULT 'declared',
  target_description  text NOT NULL DEFAULT '',           -- WHAT delivery means (bounded text; no KPI platform)
  planned_start       date,
  target_date         date,                               -- target completion
  completed_at        date,                               -- actual completion — server-stamped on 'delivered'
  -- Explicitly reported progress (single authority: set_governance_
  -- commitment_progress; audit old→new on every change).
  progress_percent    smallint NOT NULL DEFAULT 0
                      CHECK (progress_percent BETWEEN 0 AND 100),
  is_public           boolean NOT NULL DEFAULT false,     -- Private by default (gate §4 DECISION 5)
  published_at        timestamptz,
  created_by          uuid REFERENCES politicore.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_commitments_tenant_idx
  ON politicore.governance_commitments (tenant_id, created_at DESC);
CREATE INDEX governance_commitments_status_idx
  ON politicore.governance_commitments (tenant_id, status);
CREATE INDEX governance_commitments_source_idx
  ON politicore.governance_commitments (tenant_id, source_type);

-- Date sanity (server-enforced field validation).
ALTER TABLE politicore.governance_commitments
  ADD CONSTRAINT governance_commitments_dates CHECK (
    planned_start IS NULL OR target_date IS NULL OR planned_start <= target_date
  );

-- ─────────────────────────────────────────────────────────────────────────
-- COMMITMENT GEO SCOPES — mirror of governance_project_scopes (Core
-- Geography only; 'campaign' structurally impossible via the CHECK)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_commitment_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  commitment_id uuid NOT NULL REFERENCES politicore.governance_commitments(id) ON DELETE CASCADE,
  scope_type  politicore.scope_type_enum NOT NULL
              CHECK (scope_type IN ('polling_unit','ward','lga','senatorial_zone','state')),
  state_id    text REFERENCES politicore.states(id),
  zone_id     text REFERENCES politicore.senatorial_zones(id),
  lga_id      text REFERENCES politicore.lgas(id),
  ward_id     text REFERENCES politicore.wards(id),
  polling_unit_id text REFERENCES politicore.polling_units(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commitment_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id),
  CONSTRAINT governance_commitment_scopes_geography CHECK (
    (scope_type = 'state'           AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'lga'             AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'ward'            AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
 OR (scope_type = 'polling_unit'    AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
  )
);

CREATE INDEX governance_commitment_scopes_commitment_idx
  ON politicore.governance_commitment_scopes (commitment_id);

-- ─────────────────────────────────────────────────────────────────────────
-- COMMITMENT ↔ PROJECT JOIN — OPTIONAL many-to-many (gate §4 DECISION 3).
-- A commitment may exist with zero projects; a project with zero
-- commitments. Links carry no project metadata and grant NO authority.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_commitment_projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  commitment_id uuid NOT NULL REFERENCES politicore.governance_commitments(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL REFERENCES politicore.governance_projects(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES politicore.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commitment_id, project_id)
);

CREATE INDEX governance_commitment_projects_commitment_idx
  ON politicore.governance_commitment_projects (commitment_id);
CREATE INDEX governance_commitment_projects_project_idx
  ON politicore.governance_commitment_projects (project_id);

-- ─────────────────────────────────────────────────────────────────────────
-- CANONICAL UPDATES — extend the Phase 12 substrate (gate §9). Adds the
-- commitment subject; the single-subject constraint is REWRITTEN under
-- the SAME NAME so later phases (request/consultation/petition/engagement)
-- extend it again rather than replace it. Project updates are untouched.
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_updates
  ADD COLUMN commitment_id uuid REFERENCES politicore.governance_commitments(id) ON DELETE CASCADE;

ALTER TABLE politicore.governance_updates
  DROP CONSTRAINT governance_updates_single_subject;

ALTER TABLE politicore.governance_updates
  ADD CONSTRAINT governance_updates_single_subject CHECK (
    (COALESCE(project_id IS NOT NULL, false)::int
     + COALESCE(commitment_id IS NOT NULL, false)::int) = 1
  );

-- Per-subject queries remain indexable (gate §9 RATIONALE).
CREATE INDEX governance_updates_commitment_idx
  ON politicore.governance_updates (commitment_id)
  WHERE commitment_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- REFERENCE GENERATOR — GC- prefix + 8 uppercase hex (identifier only).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.make_governance_commitment_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'GC-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_commitments WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_commitment_reference
  BEFORE INSERT ON politicore.governance_commitments
  FOR EACH ROW EXECUTE FUNCTION politicore.make_governance_commitment_reference();

-- ─────────────────────────────────────────────────────────────────────────
-- LIFECYCLE GUARD — server-enforced transitions (prompt §8). delivered
-- and dropped are TERMINAL (institutional memory); timestamps are
-- server-stamped, never client-supplied.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_commitment_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'declared'            AND NEW.status IN ('in_progress','dropped'))
    OR (OLD.status = 'in_progress'         AND NEW.status IN ('partially_delivered','delivered','dropped'))
    OR (OLD.status = 'partially_delivered' AND NEW.status IN ('in_progress','delivered','dropped'))
  ) THEN
    RAISE EXCEPTION 'governance: illegal commitment transition % -> %', OLD.status, NEW.status;
  END IF;
  -- Terminal stamp is server-set.
  IF NEW.status = 'delivered' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, CURRENT_DATE);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_commitment_status_guard
  BEFORE UPDATE OF status ON politicore.governance_commitments
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_commitment_status();

-- ─────────────────────────────────────────────────────────────────────────
-- IDENTITY GUARD — reference immutable; visibility changes require the
-- authority RPC (transaction-scoped GUC license — the Phase 12 pattern).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_commitment_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: commitment reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: commitment visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_commitment_identity
  BEFORE UPDATE ON politicore.governance_commitments
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_commitment_identity();

-- ─────────────────────────────────────────────────────────────────────────
-- GEO AUTHORITY — mirrored from has_project_geo_authority (Phase 12),
-- reading commitment scopes. The caller's manage_projects grant must
-- cover ANY ONE of the commitment's scope rows (or be tenant-wide).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.has_commitment_geo_authority(
  p_commitment uuid
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politicore.governance_commitment_scopes cs
     WHERE cs.commitment_id = p_commitment
       AND politicore.has_permission('manage_projects', cs.scope_type,
             COALESCE(cs.polling_unit_id, cs.ward_id, cs.lga_id, cs.zone_id, cs.state_id))
  )
  OR ( -- a tenant-wide grant covers any scope
    politicore.has_permission('manage_projects')
    AND EXISTS (SELECT 1 FROM politicore.governance_commitments
                 WHERE id = p_commitment AND tenant_id = politicore.current_tenant_id())
  );
$$ LANGUAGE sql STABLE SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs (SECURITY DEFINER; resolve caller+tenant+permission
-- server-side; audit in Core; never trust client authority fields)
-- ---------------------------------------------------------------------

-- Shared guard: commitment must exist in the caller's tenant, module on,
-- manage_projects held, geographic authority over the commitment's scopes.
CREATE OR REPLACE FUNCTION politicore.assert_commitment_authority(
  p_commitment uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_commitments WHERE id = p_commitment;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: commitment not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_commitment_geo_authority(p_commitment)) THEN
    RAISE EXCEPTION 'governance: manage_projects with geographic authority required';
  END IF;
  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- CREATE. Server mints reference, tenant, created_by. Lineage is
-- recorded as (source_type, source_ref) — NO Manifesto resolution, NO
-- Manifesto FK, NO query of the locked module (gate §4 DECISION 1).
-- Initial scopes are validated against Core Geography and the CALLER's
-- authority (you cannot create a commitment at a scope you do not
-- manage — prompt §22, mirroring the Phase 12 create rule).
CREATE OR REPLACE FUNCTION politicore.create_governance_commitment(
  p_title text,
  p_details text DEFAULT '',
  p_category_label text DEFAULT '',
  p_source_type text DEFAULT 'independent',
  p_source_ref text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_target_description text DEFAULT '',
  p_planned_start date DEFAULT NULL,
  p_target_date date DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_commitment uuid;
  v_s jsonb;
  v_owner_tenant uuid;
  v_source politicore.governance_commitment_source_type;
  v_scope_count integer := 0;
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

  v_source := p_source_type::politicore.governance_commitment_source_type;

  INSERT INTO politicore.governance_commitments
    (tenant_id, title, details, category_label, source_type, source_ref,
     owner_profile_id, target_description, planned_start, target_date,
     created_by)
  VALUES
    (v_tenant, btrim(p_title), COALESCE(p_details,''), COALESCE(p_category_label,''),
     v_source, p_source_ref, p_owner_profile_id, COALESCE(p_target_description,''),
     p_planned_start, p_target_date, v_caller)
  RETURNING id INTO v_commitment;

  IF p_scopes IS NOT NULL AND length(btrim(p_scopes)) > 1 THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_commitment_scope(v_commitment,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
      v_scope_count := v_scope_count + 1;
    END LOOP;
  END IF;

  -- Non-admin callers must attach at least one scope within their
  -- authority (the Phase 12 create rule — a bare tenant grant alone is
  -- not delivery authority).
  IF NOT politicore.is_tenant_admin() AND v_scope_count = 0 THEN
    RAISE EXCEPTION 'governance: manage_projects with a scope within your authority is required';
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_commitment:create',
          'governance_commitments', v_commitment::text,
          jsonb_build_object('title', p_title, 'status', 'declared',
                             'source_type', v_source::text));

  -- §19 intent: owner assignment (best-effort, Core pattern).
  IF p_owner_profile_id IS NOT NULL THEN
    PERFORM politicore.governance_notify_commitment_owner(v_commitment, p_owner_profile_id, v_caller);
  END IF;

  RETURN v_commitment;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE (partial). Lineage: source_type is immutable after creation
-- (origin does not change); source_ref is corrigible as a display anchor.
-- Owner change re-fires the owner notification (Phase 12 pattern).
CREATE OR REPLACE FUNCTION politicore.update_governance_commitment(
  p_commitment uuid,
  p_title text DEFAULT NULL,
  p_details text DEFAULT NULL,
  p_category_label text DEFAULT NULL,
  p_source_ref text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_target_description text DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_target_date date DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_owner_tenant uuid;
  v_old_owner uuid;
BEGIN
  v_tenant := politicore.assert_commitment_authority(p_commitment);

  IF p_owner_profile_id IS NOT NULL THEN
    SELECT tenant_id INTO v_owner_tenant FROM politicore.profiles WHERE id = p_owner_profile_id;
    IF v_owner_tenant IS NULL OR v_owner_tenant <> v_tenant THEN
      RAISE EXCEPTION 'governance: owner must belong to the same tenant';
    END IF;
    SELECT owner_profile_id INTO v_old_owner
      FROM politicore.governance_commitments WHERE id = p_commitment;
  END IF;

  UPDATE politicore.governance_commitments SET
    title               = COALESCE(p_title, title),
    details             = COALESCE(p_details, details),
    category_label      = COALESCE(p_category_label, category_label),
    source_ref          = COALESCE(p_source_ref, source_ref),
    owner_profile_id    = COALESCE(p_owner_profile_id, owner_profile_id),
    target_description  = COALESCE(p_target_description, target_description),
    planned_start       = COALESCE(p_planned_start, planned_start),
    target_date         = COALESCE(p_target_date, target_date),
    updated_at          = now()
  WHERE id = p_commitment;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:update',
          'governance_commitments', p_commitment::text,
          jsonb_build_object('patched',
            COALESCE(p_title IS NOT NULL, false)
            OR COALESCE(p_details IS NOT NULL, false)
            OR COALESCE(p_category_label IS NOT NULL, false)
            OR COALESCE(p_source_ref IS NOT NULL, false)
            OR COALESCE(p_owner_profile_id IS NOT NULL, false)
            OR COALESCE(p_target_description IS NOT NULL, false)
            OR COALESCE(p_planned_start IS NOT NULL, false)
            OR COALESCE(p_target_date IS NOT NULL, false)));

  IF p_owner_profile_id IS NOT NULL AND p_owner_profile_id <> v_old_owner THEN
    PERFORM politicore.governance_notify_commitment_owner(p_commitment, p_owner_profile_id, auth.uid());
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STATUS — transitions are enforced by the guard trigger; this RPC
-- contributes tenant/module/geo authorization + the canonical audit.
CREATE OR REPLACE FUNCTION politicore.set_governance_commitment_status(
  p_commitment uuid,
  p_status text
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old politicore.governance_commitment_status;
BEGIN
  v_tenant := politicore.assert_commitment_authority(p_commitment);
  SELECT status INTO v_old FROM politicore.governance_commitments WHERE id = p_commitment;

  UPDATE politicore.governance_commitments
     SET status = p_status::politicore.governance_commitment_status
   WHERE id = p_commitment;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:status',
          'governance_commitments', p_commitment::text,
          jsonb_build_object('status', v_old::text),
          jsonb_build_object('status', p_status));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- PROGRESS — the single, explicitly reported progress authority (prompt
-- §9). Every change is audited old→new; range enforced by the column
-- CHECK. (Commitments carry no milestone derivation — linkage to
-- projects is evidence, never a computation input.)
CREATE OR REPLACE FUNCTION politicore.set_governance_commitment_progress(
  p_commitment uuid,
  p_progress smallint
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old smallint;
BEGIN
  IF p_progress IS NULL OR p_progress < 0 OR p_progress > 100 THEN
    RAISE EXCEPTION 'governance: progress must be between 0 and 100';
  END IF;
  v_tenant := politicore.assert_commitment_authority(p_commitment);
  SELECT progress_percent INTO v_old FROM politicore.governance_commitments WHERE id = p_commitment;

  UPDATE politicore.governance_commitments
     SET progress_percent = p_progress, updated_at = now()
   WHERE id = p_commitment;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:progress',
          'governance_commitments', p_commitment::text,
          jsonb_build_object('progress', v_old),
          jsonb_build_object('progress', p_progress));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VISIBILITY — publication is an explicit, audited accountability act
-- (gate §4 DECISION 5). The GUC license admits the change past the
-- identity guard for exactly this transaction (Phase 12 pattern).
CREATE OR REPLACE FUNCTION politicore.set_governance_commitment_visibility(
  p_commitment uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old boolean;
BEGIN
  v_tenant := politicore.assert_commitment_authority(p_commitment);
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

-- GEOGRAPHIC SCOPES (validated against Core Geography + caller authority
-- for THE SCOPE BEING ATTACHED — the Phase 12 bootstrap-correct rule).
CREATE OR REPLACE FUNCTION politicore.add_governance_commitment_scope(
  p_commitment uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_commitment_tenant uuid;
  v_exists boolean;
  v_scope uuid;
  v_scope_id text;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance commitments';
  END IF;

  SELECT tenant_id INTO v_commitment_tenant
    FROM politicore.governance_commitments WHERE id = p_commitment;
  IF v_commitment_tenant IS NULL OR v_commitment_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: commitment not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  v_scope_id := COALESCE(p_polling_unit_id, p_ward_id, p_lga_id, p_zone_id, p_state_id);

  -- Authority for THIS scope (bootstrap-correct: evaluated on the scope
  -- being attached, never on previously attached rows).
  IF NOT (politicore.is_tenant_admin()
          OR politicore.has_permission('manage_projects', p_scope_type, v_scope_id)) THEN
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

  INSERT INTO politicore.governance_commitment_scopes
    (tenant_id, commitment_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  VALUES (v_commitment_tenant, p_commitment, p_scope_type, p_state_id, p_zone_id,
          p_lga_id, p_ward_id, p_polling_unit_id)
  ON CONFLICT (commitment_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  DO NOTHING
  RETURNING id INTO v_scope;

  IF v_scope IS NOT NULL THEN
    INSERT INTO politicore.system_audits
      (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
    VALUES (v_commitment_tenant, auth.uid(), 'governance_commitment:scope_add',
            'governance_commitment_scopes', v_scope::text,
            jsonb_build_object('commitment', p_commitment, 'scope_type', p_scope_type::text,
                               'scope_id', v_scope_id));
  END IF;
  RETURN v_scope;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_commitment_scope(
  p_scope uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_commitment uuid;
BEGIN
  SELECT commitment_id INTO v_commitment FROM politicore.governance_commitment_scopes WHERE id = p_scope;
  IF v_commitment IS NULL THEN
    RAISE EXCEPTION 'governance: scope not found';
  END IF;
  v_tenant := politicore.assert_commitment_authority(v_commitment);

  DELETE FROM politicore.governance_commitment_scopes WHERE id = p_scope;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:scope_remove',
          'governance_commitment_scopes', p_scope::text,
          jsonb_build_object('commitment', v_commitment));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- PROJECT LINK — one commitment ↔ many projects, NO hard coupling. The
-- project must exist in the SAME tenant (forged/cross-tenant ids fail
-- closed). Linking grants no authority to anyone (prompt §14).
CREATE OR REPLACE FUNCTION politicore.link_governance_project(
  p_commitment uuid,
  p_project uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_project_tenant uuid;
  v_link uuid;
BEGIN
  v_tenant := politicore.assert_commitment_authority(p_commitment);

  SELECT tenant_id INTO v_project_tenant
    FROM politicore.governance_projects WHERE id = p_project;
  IF v_project_tenant IS NULL OR v_project_tenant <> v_tenant THEN
    RAISE EXCEPTION 'governance: project not found in this tenant';
  END IF;

  INSERT INTO politicore.governance_commitment_projects
    (tenant_id, commitment_id, project_id, created_by)
  VALUES (v_tenant, p_commitment, p_project, auth.uid())
  ON CONFLICT (commitment_id, project_id) DO NOTHING
  RETURNING id INTO v_link;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:project_link',
          'governance_commitment_projects', COALESCE(v_link::text, 'existing'),
          jsonb_build_object('commitment', p_commitment, 'project', p_project));
  RETURN v_link;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.unlink_governance_project(
  p_commitment uuid,
  p_project uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.assert_commitment_authority(p_commitment);

  DELETE FROM politicore.governance_commitment_projects
   WHERE commitment_id = p_commitment AND project_id = p_project;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment:project_unlink',
          'governance_commitment_projects', p_commitment::text,
          jsonb_build_object('commitment', p_commitment, 'project', p_project));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- COMMITMENT UPDATES — first consumer of the extended canonical
-- substrate. Single-subject invariant applies (project_id NULL,
-- commitment_id set). Evidence rides Core media_assets (Phase 12 rule).
CREATE OR REPLACE FUNCTION politicore.create_governance_commitment_update(
  p_commitment uuid,
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
  v_tenant := politicore.assert_commitment_authority(p_commitment);
  v_kind := p_kind::politicore.governance_update_kind;

  IF p_evidence_asset_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = p_evidence_asset_id
                      AND tenant_id = politicore.current_tenant_id()) THEN
      RAISE EXCEPTION 'governance: evidence asset not found in this tenant';
    END IF;
  END IF;

  INSERT INTO politicore.governance_updates
    (tenant_id, commitment_id, author_profile_id, title, body, kind,
     is_public, evidence_asset_id)
  VALUES (v_tenant, p_commitment, auth.uid(), COALESCE(p_title,''), btrim(p_body),
          v_kind, p_is_public, p_evidence_asset_id)
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_commitment_update:create',
          'governance_updates', v_id::text,
          jsonb_build_object('commitment', p_commitment, 'kind', v_kind::text,
                             'is_public', p_is_public));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE VISIBILITY (RESTATED) — extends the Phase 12 body to resolve
-- authority by the update's SUBJECT: project updates assert project
-- authority exactly as before; commitment updates assert commitment
-- authority. Signature unchanged (the 0047 public wrapper follows
-- automatically); project-update behavior is preserved verbatim.
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

-- §19 NOTIFICATION INTENT — owner assignment, Core pattern (best-effort;
-- a notification failure never fails the authority transaction).
CREATE OR REPLACE FUNCTION politicore.governance_notify_commitment_owner(
  p_commitment uuid,
  p_owner uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_title text;
BEGIN
  SELECT title INTO v_title FROM politicore.governance_commitments WHERE id = p_commitment;
  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  VALUES (
    politicore.current_tenant_id(), p_owner, 'system',
    'You are accountable for a Governance commitment',
    'Commitment "' || v_title || '" has been placed under your responsibility.',
    '/portal/governance/projects/commitments/' || p_commitment::text,
    p_actor
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance commitment owner notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — FORCE, tenant-scoped, zero anonymous surface (Phase 12 posture)
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_commitments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_commitment_scopes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_commitment_projects ENABLE ROW LEVEL SECURITY;

ALTER TABLE politicore.governance_commitments        FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_commitment_scopes  FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_commitment_projects FORCE ROW LEVEL SECURITY;

CREATE POLICY governance_commitments_read ON politicore.governance_commitments
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

CREATE POLICY governance_commitment_scopes_read ON politicore.governance_commitment_scopes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

CREATE POLICY governance_commitment_projects_read ON politicore.governance_commitment_projects
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- No INSERT/UPDATE/DELETE policies: mutations flow exclusively through
-- the authority RPCs; retention (no application delete) holds by RLS.

-- Canonical audit triggers on every new table (Core system_audits).
CREATE TRIGGER trg_audit_governance_commitments
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_commitments
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_commitment_scopes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_commitment_scopes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_commitment_projects
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_commitment_projects
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API SURFACE — the 0047 convention: thin security_invoker
-- views (zero authorization of their own — base-table FORCE RLS remains
-- the only boundary), mirrored grants, explicit anon/PUBLIC revokes, and
-- public RPC wrappers for the mutating authority RPCs (text-overload
-- convention, PostgREST-safe). No public discovery surface is built —
-- anonymous holds NOTHING; publication remains Phase 18.
-- ---------------------------------------------------------------------
-- The 0047 public.governance_updates view expanded SELECT * before the
-- commitment_id column existed — re-expand so the canonical substrate's
-- new subject is exposed on the data API too (same security_invoker
-- posture; grants/revokes from 0047 are unchanged).
CREATE OR REPLACE VIEW public.governance_updates
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_updates;

CREATE OR REPLACE VIEW public.governance_commitments
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_commitments;
CREATE OR REPLACE VIEW public.governance_commitment_scopes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_commitment_scopes;
CREATE OR REPLACE VIEW public.governance_commitment_projects
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_commitment_projects;

GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_commitments         TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_commitment_scopes   TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_commitment_projects TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_commitments         TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_commitment_scopes   TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_commitment_projects TO authenticated, service_role;

REVOKE ALL ON public.governance_commitments         FROM anon;
REVOKE ALL ON public.governance_commitment_scopes   FROM anon;
REVOKE ALL ON public.governance_commitment_projects FROM anon;
REVOKE ALL ON public.governance_commitments         FROM PUBLIC;
REVOKE ALL ON public.governance_commitment_scopes   FROM PUBLIC;
REVOKE ALL ON public.governance_commitment_projects FROM PUBLIC;

-- Public RPC wrappers (thin pass-through to the politicore authority).
CREATE OR REPLACE FUNCTION public.create_governance_commitment(
  p_title text,
  p_details text DEFAULT '',
  p_category_label text DEFAULT '',
  p_source_type text DEFAULT 'independent',
  p_source_ref text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_target_description text DEFAULT '',
  p_planned_start date DEFAULT NULL,
  p_target_date date DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
  SELECT politicore.create_governance_commitment(
    p_title, p_details, p_category_label, p_source_type, p_source_ref,
    p_owner_profile_id, p_target_description, p_planned_start, p_target_date, p_scopes);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.update_governance_commitment(
  p_commitment uuid,
  p_title text DEFAULT NULL,
  p_details text DEFAULT NULL,
  p_category_label text DEFAULT NULL,
  p_source_ref text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_target_description text DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_target_date date DEFAULT NULL
) RETURNS void AS $$
  SELECT politicore.update_governance_commitment(
    p_commitment, p_title, p_details, p_category_label, p_source_ref,
    p_owner_profile_id, p_target_description, p_planned_start, p_target_date);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.set_governance_commitment_status(
  p_commitment uuid, p_status text
) RETURNS void AS $$
  SELECT politicore.set_governance_commitment_status(p_commitment, p_status);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.set_governance_commitment_progress(
  p_commitment uuid, p_progress smallint
) RETURNS void AS $$
  SELECT politicore.set_governance_commitment_progress(p_commitment, p_progress);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.set_governance_commitment_visibility(
  p_commitment uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_commitment_visibility(p_commitment, p_is_public);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.add_governance_commitment_scope(
  p_commitment uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.add_governance_commitment_scope(
    p_commitment, p_scope_type, p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.remove_governance_commitment_scope(
  p_scope uuid
) RETURNS void AS $$
  SELECT politicore.remove_governance_commitment_scope(p_scope);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.link_governance_project(
  p_commitment uuid, p_project uuid
) RETURNS uuid AS $$
  SELECT politicore.link_governance_project(p_commitment, p_project);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.unlink_governance_project(
  p_commitment uuid, p_project uuid
) RETURNS void AS $$
  SELECT politicore.unlink_governance_project(p_commitment, p_project);
$$ LANGUAGE sql SECURITY INVOKER;

CREATE OR REPLACE FUNCTION public.create_governance_commitment_update(
  p_commitment uuid,
  p_title text,
  p_body text,
  p_kind text DEFAULT 'progress',
  p_is_public boolean DEFAULT false,
  p_evidence_asset_id uuid DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.create_governance_commitment_update(
    p_commitment, p_title, p_body, p_kind, p_is_public, p_evidence_asset_id);
$$ LANGUAGE sql SECURITY INVOKER;

-- HYGIENE — no EXECUTE on authority RPCs except authenticated (0007
-- blanket default grants EXECUTE to anon+authenticated+service_role;
-- anon must not even call these).
REVOKE EXECUTE ON FUNCTION politicore.create_governance_commitment(text,text,text,text,text,uuid,text,date,date,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.update_governance_commitment(uuid,text,text,text,text,uuid,text,date,date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_commitment_status(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_commitment_progress(uuid,smallint) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_commitment_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.add_governance_commitment_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.remove_governance_commitment_scope(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.link_governance_project(uuid,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.unlink_governance_project(uuid,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.create_governance_commitment_update(uuid,text,text,text,boolean,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.governance_notify_commitment_owner(uuid,uuid,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_commitment(text,text,text,text,text,uuid,text,date,date,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_governance_commitment(uuid,text,text,text,text,uuid,text,date,date) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_commitment_status(uuid,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_commitment_progress(uuid,smallint) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_commitment_visibility(uuid,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.add_governance_commitment_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_governance_commitment_scope(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.link_governance_project(uuid,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.unlink_governance_project(uuid,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_commitment_update(uuid,text,text,text,boolean,uuid) FROM anon;
