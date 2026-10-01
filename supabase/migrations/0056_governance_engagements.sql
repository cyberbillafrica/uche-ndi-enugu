-- POLITICORE — MIGRATION 0056: GOVERNANCE ENGAGEMENTS (PHASE 17).
--
-- Implements the Phase 11 §10 Engagement architecture exactly:
--
--   governance_engagements is a first-class PROCESS record; the Events
--   module remains CONTENT. Linkage is OPTIONAL (event_id NULL REFERENCES
--   politicore.events): an engagement with an event gets a public calendar
--   presence; an internal stakeholder meeting needs none. The Engagement
--   owns agenda, stakeholders, attendance (staff-recorded roster, no
--   public PII), issues raised (optional staff-created request links),
--   and follow-ups — which ARE updates (gate §10/§11): the canonical
--   governance_updates substrate gains engagement as its FIFTH subject.
--
-- Lifecycle: draft → scheduled → concluded (simple process lifecycle;
-- no voting/verification/moderation states — gate §10). Agenda is frozen
-- at conclusion. Attendance is recorded by staff (gate §25: no
-- self-service in v1). Geographic accountability via the scope pattern.
--
-- Reuses, unchanged: Core Identity, governance_participants, Core
-- Geography, Core Notifications, Core Audit, the seven-permission
-- catalog (zero new permissions, zero new roles), politicore.events
-- (read-only reference — never mutated, never owned).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- ENUMS
-- --------------------------------------------------------------------- */
CREATE TYPE politicore.governance_engagement_status AS ENUM ('draft', 'scheduled', 'concluded');
CREATE TYPE politicore.governance_engagement_issue_status AS ENUM ('open', 'addressed', 'closed');

-- ─────────────────────────────────────────────────────────────────────────
-- CANONICAL ENGAGEMENTS — the process record. Optional Event reference
-- (one-way; same-tenant enforced at the authority RPC; the Event is never
-- mutated and never grants authority).
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_engagements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  reference_code text NOT NULL UNIQUE,
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  -- OPTIONAL one-way link to the Events content module (gate §10).
  event_id       uuid REFERENCES politicore.events(id) ON DELETE SET NULL,
  status         politicore.governance_engagement_status NOT NULL DEFAULT 'draft',
  scheduled_at   timestamptz,
  location       text NOT NULL DEFAULT '',
  agenda         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(agenda) = 'array'),
  outcomes       text NOT NULL DEFAULT '',
  held_at        timestamptz,
  is_public      boolean NOT NULL DEFAULT false,
  published_at   timestamptz,
  created_by     uuid REFERENCES politicore.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- outcomes are a concluded-process artifact (gate §10: responses,
  -- follow-ups, outcomes belong to the process record)
  CONSTRAINT governance_engagements_outcomes_require_concluded CHECK (
    outcomes = '' OR status = 'concluded'
  ),
  -- held_at is stamped exactly by the conclusion act
  CONSTRAINT governance_engagements_held_snapshot CHECK (
    (held_at IS NULL) = (status <> 'concluded')
  )
);

CREATE INDEX governance_engagements_tenant_idx
  ON politicore.governance_engagements (tenant_id, created_at DESC);
CREATE INDEX governance_engagements_status_idx
  ON politicore.governance_engagements (tenant_id, status);
CREATE INDEX governance_engagements_event_idx
  ON politicore.governance_engagements (event_id)
  WHERE event_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- GEO SCOPES — Core Geography child, Phase 12–16 shape verbatim.
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_engagement_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  engagement_id   uuid NOT NULL REFERENCES politicore.governance_engagements(id) ON DELETE CASCADE,
  scope_type      politicore.scope_type_enum NOT NULL
                    CHECK (scope_type <> 'campaign'),
  state_id        text,
  zone_id         text,
  lga_id          text,
  ward_id         text,
  polling_unit_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES politicore.profiles(id),
  CONSTRAINT governance_engagement_scope_shape CHECK (
    (scope_type = 'state' AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'lga' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'ward' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'polling_unit' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
  ),
  UNIQUE (engagement_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
);

CREATE INDEX governance_engagement_scopes_engagement_idx
  ON politicore.governance_engagement_scopes (engagement_id);

-- ─────────────────────────────────────────────────────────────────────────
-- STAKEHOLDERS — existing Governance participants only (gate §10/§25: no
-- new identity, no stakeholder roles). role_label is a free-text process
-- descriptor (≤100 chars), never a permission or app role.
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_engagement_stakeholders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  engagement_id  uuid NOT NULL REFERENCES politicore.governance_engagements(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES politicore.governance_participants(id) ON DELETE CASCADE,
  role_label     text NOT NULL DEFAULT '' CHECK (length(role_label) <= 100),
  note           text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES politicore.profiles(id),
  UNIQUE (engagement_id, participant_id)
);

CREATE INDEX governance_engagement_stakeholders_engagement_idx
  ON politicore.governance_engagement_stakeholders (engagement_id);
CREATE INDEX governance_engagement_stakeholders_participant_idx
  ON politicore.governance_engagement_stakeholders (participant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- ATTENDANCE — a staff-recorded roster of participants (gate §10/§25:
-- attendance is a count/roster; no self-service in v1). Append-only by
-- policy architecture: no UPDATE policy; corrections flow through staff
-- authority only via delete+re-add (no UPDATE RPC ships).
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_engagement_attendance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  engagement_id  uuid NOT NULL REFERENCES politicore.governance_engagements(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES politicore.governance_participants(id) ON DELETE CASCADE,
  note           text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  recorded_by    uuid REFERENCES politicore.profiles(id),
  UNIQUE (engagement_id, participant_id)
);

CREATE INDEX governance_engagement_attendance_engagement_idx
  ON politicore.governance_engagement_attendance (engagement_id);

-- ─────────────────────────────────────────────────────────────────────────
-- ISSUES RAISED — process records; the optional staff-created request link
-- (gate §10 "issues raised map to optional request links"; §234) grants no
-- authority and is never automatic.
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_engagement_issues (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  engagement_id  uuid NOT NULL REFERENCES politicore.governance_engagements(id) ON DELETE CASCADE,
  title          text NOT NULL,
  detail         text NOT NULL DEFAULT '' CHECK (length(detail) <= 4000),
  -- who raised it, server-validated against this tenant's participants
  raised_by_participant_id uuid REFERENCES politicore.governance_participants(id),
  -- optional staff-created link to the case system (no authority transfer)
  request_id     uuid REFERENCES politicore.governance_requests(id) ON DELETE SET NULL,
  status         politicore.governance_engagement_issue_status NOT NULL DEFAULT 'open',
  created_by     uuid REFERENCES politicore.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_engagement_issues_engagement_idx
  ON politicore.governance_engagement_issues (engagement_id, created_at);
CREATE INDEX governance_engagement_issues_request_idx
  ON politicore.governance_engagement_issues (request_id)
  WHERE request_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- CANONICAL UPDATES — engagement becomes the FIFTH update subject (gate
-- §10 "follow-ups are updates"; §11 ERD names engagement). The
-- single-subject invariant is restated over the five implemented subjects;
-- project/commitment/consultation/petition behavior is untouched. Poll
-- remains excluded (Phase 16 decision).
-- --------------------------------------------------------------------- */
ALTER TABLE politicore.governance_updates
  ADD COLUMN engagement_id uuid REFERENCES politicore.governance_engagements(id) ON DELETE CASCADE;

ALTER TABLE politicore.governance_updates
  DROP CONSTRAINT governance_updates_single_subject;

ALTER TABLE politicore.governance_updates
  ADD CONSTRAINT governance_updates_single_subject CHECK (
    (COALESCE(project_id IS NOT NULL, false)::int
     + COALESCE(commitment_id IS NOT NULL, false)::int
     + COALESCE(consultation_id IS NOT NULL, false)::int
     + COALESCE(petition_id IS NOT NULL, false)::int
     + COALESCE(engagement_id IS NOT NULL, false)::int) = 1
  );

CREATE INDEX governance_updates_engagement_idx
  ON politicore.governance_updates (engagement_id)
  WHERE engagement_id IS NOT NULL;

-- Re-expand the 0048 public.governance_updates view so the data API
-- tracks the canonical table (0052 precedent).
CREATE OR REPLACE VIEW public.governance_updates
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_updates;

-- ─────────────────────────────────────────────────────────────────────────
-- REFERENCE MINTER — EN- prefix + 8 uppercase hex (0050-correct shape).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.make_governance_engagement_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'EN-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_engagements WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_engagement_reference
  BEFORE INSERT ON politicore.governance_engagements
  FOR EACH ROW EXECUTE FUNCTION politicore.make_governance_engagement_reference();

-- ─────────────────────────────────────────────────────────────────────────
-- IDENTITY GUARD — reference immutable; visibility flips only through the
-- authority RPC (GUC-gated precedent).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.guard_governance_engagement_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: engagement reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: engagement visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_engagement_identity
  BEFORE UPDATE ON politicore.governance_engagements
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_engagement_identity();

-- ─────────────────────────────────────────────────────────────────────────
-- LIFECYCLE GUARD — server-enforced simple process lifecycle (gate §10):
--   draft → scheduled → concluded. No reopen, no cancel state, no
--   skipping, terminal records retained.
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.guard_governance_engagement_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'draft'     AND NEW.status = 'scheduled')
    OR (OLD.status = 'scheduled' AND NEW.status = 'concluded')
  ) THEN
    RAISE EXCEPTION 'governance: illegal engagement status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_engagement_status
  BEFORE UPDATE OF status ON politicore.governance_engagements
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_engagement_status();

-- CONTENT GUARD — agenda/title/description/location/scheduling frozen once
-- concluded (the process record is sealed; attendance, issues and
-- follow-ups remain legitimate post-conclusion records).
CREATE OR REPLACE FUNCTION politicore.guard_governance_engagement_content()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'concluded' AND (
       NEW.agenda       IS DISTINCT FROM OLD.agenda
    OR NEW.title        IS DISTINCT FROM OLD.title
    OR NEW.description  IS DISTINCT FROM OLD.description
    OR NEW.location     IS DISTINCT FROM OLD.location
    OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
    OR NEW.event_id     IS DISTINCT FROM OLD.event_id
  ) THEN
    RAISE EXCEPTION 'governance: engagement content is sealed once concluded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_engagement_content
  BEFORE UPDATE ON politicore.governance_engagements
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_engagement_content();

-- ─────────────────────────────────────────────────────────────────────────
-- AGENDA VALIDATION (server-side; bounded vocabulary — NOT a scheduler).
-- Items: {id, title, detail?}; ids unique; lengths capped.
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.validate_engagement_agenda(
  p_agenda jsonb
) RETURNS boolean AS $$
DECLARE
  v_item jsonb;
  v_id text;
  v_n int := 0;
BEGIN
  IF p_agenda IS NULL OR jsonb_typeof(p_agenda) <> 'array' THEN
    RAISE EXCEPTION 'governance: agenda must be an array';
  END IF;
  IF jsonb_array_length(p_agenda) > 50 THEN
    RAISE EXCEPTION 'governance: agenda exceeds the maximum item count';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_agenda) LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'governance: agenda item % must be an object', v_n;
    END IF;
    v_id := v_item->>'id';
    IF v_id IS NULL OR length(btrim(v_id)) = 0 OR length(v_id) > 64 THEN
      RAISE EXCEPTION 'governance: agenda item % requires an id', v_n;
    END IF;
    IF v_item->>'title' IS NULL OR length(btrim(v_item->>'title')) = 0
       OR length(v_item->>'title') > 200 THEN
      RAISE EXCEPTION 'governance: agenda item % requires a title', v_n;
    END IF;
    IF v_item->>'detail' IS NOT NULL AND length(v_item->>'detail') > 1000 THEN
      RAISE EXCEPTION 'governance: agenda item % detail exceeds the maximum length', v_n;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT a->>'id') FROM jsonb_array_elements(p_agenda) a) <> v_n THEN
    RAISE EXCEPTION 'governance: agenda item ids must be unique';
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = politicore, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- GEO AUTHORITY + ASSERT (Phase 14–16 pattern verbatim).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.has_engagement_geo_authority(
  p_engagement uuid
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politicore.governance_engagement_scopes cs
     WHERE cs.engagement_id = p_engagement
       AND politicore.has_permission('manage_participation', cs.scope_type,
             COALESCE(cs.polling_unit_id, cs.ward_id, cs.lga_id, cs.zone_id, cs.state_id))
  )
  OR ( -- a tenant-wide grant covers any scope
    politicore.has_permission('manage_participation')
    AND EXISTS (SELECT 1 FROM politicore.governance_engagements
                 WHERE id = p_engagement AND tenant_id = politicore.current_tenant_id())
  );
$$ LANGUAGE sql STABLE SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.assert_engagement_authority(
  p_engagement uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_engagements WHERE id = p_engagement;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: engagement not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_engagement_geo_authority(p_engagement)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;
  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- NOTIFICATION INTENT (0036 best-effort pattern; recipients resolved from
-- the RECIPIENT dataset — never a caller-relative predicate — the Phase
-- 15 §24 lesson). Scheduling an engagement fans out invitations to the
-- tenant, scope-filtered for lga/ward/PU scopes.
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.governance_notify_engagement_scheduled(
  p_engagement uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_ref text;
  v_when timestamptz;
  v_scoped boolean;
BEGIN
  SELECT tenant_id, title, reference_code, scheduled_at,
         EXISTS (SELECT 1 FROM politicore.governance_engagement_scopes cs
                  WHERE cs.engagement_id = p_engagement
                    AND cs.scope_type IN ('lga', 'ward', 'polling_unit'))
    INTO v_tenant, v_title, v_ref, v_when, v_scoped
    FROM politicore.governance_engagements WHERE id = p_engagement;

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT v_tenant, p.id,
         'system',
         'An engagement has been scheduled',
         v_title || ' (ref ' || v_ref || ')'
           || CASE WHEN v_when IS NOT NULL
                   THEN ' is scheduled for ' || to_char(v_when, 'YYYY-MM-DD HH24:MI') || '.'
                   ELSE ' has been scheduled.' END,
         '/governance/engagements',
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (NOT v_scoped OR EXISTS (
       SELECT 1 FROM politicore.governance_engagement_scopes cs
        WHERE cs.engagement_id = p_engagement
          AND cs.scope_type IN ('lga', 'ward', 'polling_unit')
          AND (cs.lga_id = p.lga_id OR cs.ward_id = p.ward_id
               OR cs.polling_unit_id = p.polling_unit_id)));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance engagement scheduled notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs (SECURITY DEFINER; resolve caller+tenant+permission
-- server-side; audit in Core; never trust client authority fields).
-- ---------------------------------------------------------------------

-- CREATE. Server mints reference/tenant/created_by; agenda validated;
-- optional Event link validated same-tenant WITHOUT mutating the Event;
-- initial scopes validated against Core Geography and the CALLER's
-- authority for the scope being attached (Phase 12 bootstrap-correct rule).
CREATE OR REPLACE FUNCTION politicore.create_governance_engagement(
  p_title text,
  p_description text DEFAULT '',
  p_scheduled_at timestamptz DEFAULT NULL,
  p_location text DEFAULT '',
  p_agenda jsonb DEFAULT '[]',
  p_event_id uuid DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_engagement uuid;
  v_s jsonb;
  v_unscoped boolean;
  v_scope_count integer;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: title is required';
  END IF;
  IF p_location IS NOT NULL AND length(p_location) > 300 THEN
    RAISE EXCEPTION 'governance: location exceeds the maximum length';
  END IF;

  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  v_unscoped := politicore.has_permission('manage_participation');
  IF NOT v_unscoped
     AND NOT EXISTS (
       SELECT 1 FROM politicore.permission_grants g
        WHERE g.user_id = v_caller
          AND g.permission = 'manage_participation'
          AND g.granted = true
     ) THEN
    RAISE EXCEPTION 'governance: manage_participation required';
  END IF;

  -- Optional Event link: same-tenant existence only; the Event is read,
  -- never written (gate §10 — Events remain content, one-way linkage).
  IF p_event_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM politicore.events
       WHERE id = p_event_id AND tenant_id = v_tenant
    ) THEN
      RAISE EXCEPTION 'governance: event not found in this tenant';
    END IF;
  END IF;

  PERFORM politicore.validate_engagement_agenda(COALESCE(p_agenda, '[]'::jsonb));

  INSERT INTO politicore.governance_engagements
    (tenant_id, title, description, scheduled_at, location, agenda, event_id, created_by)
  VALUES
    (v_tenant, btrim(p_title), COALESCE(p_description,''), p_scheduled_at,
     COALESCE(p_location,''), COALESCE(p_agenda, '[]'::jsonb), p_event_id, v_caller)
  RETURNING id INTO v_engagement;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes::jsonb) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_engagement_scope(v_engagement,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  IF NOT v_unscoped THEN
    SELECT count(*) INTO v_scope_count
      FROM politicore.governance_engagement_scopes WHERE engagement_id = v_engagement;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'governance: manage_participation with a scope within your authority is required';
    END IF;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_engagement:create',
          'governance_engagements', v_engagement::text,
          jsonb_build_object('title', p_title, 'status', 'draft',
                             'event', p_event_id,
                             'agenda_items', jsonb_array_length(COALESCE(p_agenda, '[]'::jsonb))));
  RETURN v_engagement;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE (draft/scheduled content; the process record seals at
-- conclusion — the content guard trigger is belt-and-braces).
CREATE OR REPLACE FUNCTION politicore.update_governance_engagement(
  p_engagement uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_clear_scheduled_at boolean DEFAULT false,
  p_location text DEFAULT NULL,
  p_agenda jsonb DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_engagement_status;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  SELECT status INTO v_status FROM politicore.governance_engagements WHERE id = p_engagement;
  IF v_status = 'concluded' THEN
    RAISE EXCEPTION 'governance: engagement content is sealed once concluded';
  END IF;

  IF p_agenda IS NOT NULL THEN
    PERFORM politicore.validate_engagement_agenda(p_agenda);
  END IF;

  UPDATE politicore.governance_engagements
     SET title         = COALESCE(p_title, title),
         description   = COALESCE(p_description, description),
         scheduled_at  = CASE WHEN p_clear_scheduled_at THEN NULL
                              ELSE COALESCE(p_scheduled_at, scheduled_at) END,
         location      = COALESCE(p_location, location),
         agenda        = COALESCE(p_agenda, agenda),
         updated_at    = now()
   WHERE id = p_engagement;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement:update',
          'governance_engagements', p_engagement::text,
          jsonb_build_object('title', p_title, 'scheduled_at', p_scheduled_at));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- EVENT LINKAGE — explicit one-way link/unlink. Same-tenant existence is
-- re-verified; the Event is never mutated and grants no authority.
CREATE OR REPLACE FUNCTION politicore.link_governance_engagement_event(
  p_engagement uuid,
  p_event_id uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_engagement_status;
  v_event_tenant uuid;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  SELECT status INTO v_status FROM politicore.governance_engagements WHERE id = p_engagement;
  IF v_status = 'concluded' THEN
    RAISE EXCEPTION 'governance: engagement content is sealed once concluded';
  END IF;

  SELECT tenant_id INTO v_event_tenant FROM politicore.events WHERE id = p_event_id;
  IF v_event_tenant IS NULL OR v_event_tenant <> v_tenant THEN
    RAISE EXCEPTION 'governance: event not found in this tenant';
  END IF;

  UPDATE politicore.governance_engagements
     SET event_id = p_event_id, updated_at = now()
   WHERE id = p_engagement;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement:event_linked',
          'governance_engagements', p_engagement::text,
          jsonb_build_object('event', p_event_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.unlink_governance_engagement_event(
  p_engagement uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_engagement_status;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  SELECT status INTO v_status FROM politicore.governance_engagements WHERE id = p_engagement;
  IF v_status = 'concluded' THEN
    RAISE EXCEPTION 'governance: engagement content is sealed once concluded';
  END IF;

  UPDATE politicore.governance_engagements
     SET event_id = NULL, updated_at = now()
   WHERE id = p_engagement;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement:event_unlinked',
          'governance_engagements', p_engagement::text,
          jsonb_build_object('event', NULL::text),
          jsonb_build_object('event', NULL::text));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STATUS — draft → scheduled (stamps the schedule, fires the invitation
-- intent) → concluded (stamps held_at + outcomes). The guard trigger is
-- the second line of defense.
CREATE OR REPLACE FUNCTION politicore.set_governance_engagement_status(
  p_engagement uuid,
  p_status text,
  p_outcomes text DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old politicore.governance_engagement_status;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  IF p_status::politicore.governance_engagement_status NOT IN ('scheduled', 'concluded') THEN
    RAISE EXCEPTION 'governance: status must be scheduled or concluded';
  END IF;
  SELECT status INTO v_old FROM politicore.governance_engagements WHERE id = p_engagement;

  UPDATE politicore.governance_engagements
     SET status = p_status::politicore.governance_engagement_status,
         held_at = CASE WHEN p_status = 'concluded' THEN now() ELSE held_at END,
         outcomes = CASE WHEN p_status = 'concluded' AND p_outcomes IS NOT NULL
                         THEN p_outcomes ELSE outcomes END,
         updated_at = now()
   WHERE id = p_engagement;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement:status',
          'governance_engagements', p_engagement::text,
          jsonb_build_object('status', v_old::text),
          jsonb_build_object('status', p_status));

  IF p_status = 'scheduled' THEN
    PERFORM politicore.governance_notify_engagement_scheduled(p_engagement, auth.uid());
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VISIBILITY — the Phase 11 taxonomy lever (opt-in Public gated by
-- publish_accountability; the public projection surface itself is Phase
-- 18 and is not built here).
CREATE OR REPLACE FUNCTION politicore.set_governance_engagement_visibility(
  p_engagement uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;

  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);
  UPDATE politicore.governance_engagements
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_engagement;
  PERFORM set_config('politicore.governance_authority', '', true);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement:visibility',
          'governance_engagements', p_engagement::text,
          jsonb_build_object('is_public', NOT p_is_public),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- SCOPE ATTACH — Core Geography validation + caller authority on the
-- scope BEING attached (bootstrap-correct). Sealed at conclusion.
CREATE OR REPLACE FUNCTION politicore.add_governance_engagement_scope(
  p_engagement uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_engagement_tenant uuid;
  v_status politicore.governance_engagement_status;
  v_exists boolean;
  v_scope uuid;
  v_scope_id text;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance engagements';
  END IF;

  SELECT tenant_id, status INTO v_engagement_tenant, v_status
    FROM politicore.governance_engagements WHERE id = p_engagement;
  IF v_engagement_tenant IS NULL OR v_engagement_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: engagement not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF v_status = 'concluded' THEN
    RAISE EXCEPTION 'governance: engagement content is sealed once concluded';
  END IF;

  v_scope_id := COALESCE(p_polling_unit_id, p_ward_id, p_lga_id, p_zone_id, p_state_id);

  IF NOT (politicore.is_tenant_admin()
          OR politicore.has_permission('manage_participation', p_scope_type, v_scope_id)) THEN
    RAISE EXCEPTION 'governance: caller may not attach a scope outside their authority';
  END IF;

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
                       WHERE id = p_polling_unit_id AND ward_id = p_ward_id));
  IF NOT v_exists THEN
    RAISE EXCEPTION 'governance: scope does not exist in Core Geography';
  END IF;

  INSERT INTO politicore.governance_engagement_scopes
    (tenant_id, engagement_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id, created_by)
  VALUES (v_engagement_tenant, p_engagement, p_scope_type,
          p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id, auth.uid())
  ON CONFLICT (engagement_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  DO UPDATE SET polling_unit_id = EXCLUDED.polling_unit_id
  RETURNING id INTO v_scope;

  RETURN v_scope;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_engagement_scope(
  p_scope uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_engagement uuid;
  v_status politicore.governance_engagement_status;
BEGIN
  SELECT ps.tenant_id, ps.engagement_id INTO v_tenant, v_engagement
    FROM politicore.governance_engagement_scopes ps WHERE ps.id = p_scope;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: engagement scope not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_engagement_geo_authority(v_engagement)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;
  SELECT status INTO v_status FROM politicore.governance_engagements WHERE id = v_engagement;
  IF v_status = 'concluded' THEN
    RAISE EXCEPTION 'governance: engagement content is sealed once concluded';
  END IF;

  DELETE FROM politicore.governance_engagement_scopes WHERE id = p_scope
    RETURNING engagement_id INTO v_engagement;
  RETURN v_engagement;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STAKEHOLDERS — existing participants only; the participant row is
-- validated against the engagement's tenant server-side (never trusted
-- from the browser beyond naming an existing row).
CREATE OR REPLACE FUNCTION politicore.add_governance_engagement_stakeholder(
  p_engagement uuid,
  p_participant_id uuid,
  p_role_label text DEFAULT '',
  p_note text DEFAULT ''
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_id uuid;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  IF p_role_label IS NOT NULL AND length(p_role_label) > 100 THEN
    RAISE EXCEPTION 'governance: stakeholder role label exceeds the maximum length';
  END IF;
  IF p_note IS NOT NULL AND length(p_note) > 1000 THEN
    RAISE EXCEPTION 'governance: stakeholder note exceeds the maximum length';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM politicore.governance_participants gp
     WHERE gp.id = p_participant_id AND gp.tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'governance: participant not found in this tenant';
  END IF;

  INSERT INTO politicore.governance_engagement_stakeholders
    (tenant_id, engagement_id, participant_id, role_label, note, created_by)
  VALUES (v_tenant, p_engagement, p_participant_id,
          COALESCE(p_role_label, ''), COALESCE(p_note, ''), auth.uid())
  ON CONFLICT (engagement_id, participant_id)
  DO UPDATE SET role_label = EXCLUDED.role_label, note = EXCLUDED.note
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement_stakeholder:set',
          'governance_engagement_stakeholders', v_id::text,
          jsonb_build_object('engagement', p_engagement, 'participant', p_participant_id));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_engagement_stakeholder(
  p_stakeholder uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_engagement uuid;
BEGIN
  SELECT s.tenant_id, s.engagement_id INTO v_tenant, v_engagement
    FROM politicore.governance_engagement_stakeholders s WHERE s.id = p_stakeholder;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: engagement stakeholder not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_engagement_geo_authority(v_engagement)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;

  DELETE FROM politicore.governance_engagement_stakeholders WHERE id = p_stakeholder
    RETURNING engagement_id INTO v_engagement;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement_stakeholder:remove',
          'governance_engagement_stakeholders', p_stakeholder::text,
          jsonb_build_object('engagement', v_engagement),
          jsonb_build_object('removed', true));
  RETURN v_engagement;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ATTENDANCE — staff-recorded roster (gate §25: no self-service in v1);
-- one row per participant; the participant row is tenant-validated.
CREATE OR REPLACE FUNCTION politicore.record_governance_engagement_attendance(
  p_engagement uuid,
  p_participant_id uuid,
  p_note text DEFAULT ''
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_id uuid;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  IF p_note IS NOT NULL AND length(p_note) > 500 THEN
    RAISE EXCEPTION 'governance: attendance note exceeds the maximum length';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM politicore.governance_participants gp
     WHERE gp.id = p_participant_id AND gp.tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'governance: participant not found in this tenant';
  END IF;

  BEGIN
    INSERT INTO politicore.governance_engagement_attendance
      (tenant_id, engagement_id, participant_id, note, recorded_by)
    VALUES (v_tenant, p_engagement, p_participant_id, COALESCE(p_note, ''), auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'governance: attendance is already recorded for this participant';
  END;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement_attendance:record',
          'governance_engagement_attendance', v_id::text,
          jsonb_build_object('engagement', p_engagement, 'participant', p_participant_id));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ISSUES — process records with an optional staff-created request link
-- (same-tenant validated; never automatic; grants no authority).
CREATE OR REPLACE FUNCTION politicore.create_governance_engagement_issue(
  p_engagement uuid,
  p_title text,
  p_detail text DEFAULT '',
  p_raised_by_participant_id uuid DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_id uuid;
BEGIN
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: issue title is required';
  END IF;
  IF length(p_title) > 300 THEN
    RAISE EXCEPTION 'governance: issue title exceeds the maximum length';
  END IF;
  IF p_detail IS NOT NULL AND length(p_detail) > 4000 THEN
    RAISE EXCEPTION 'governance: issue detail exceeds the maximum length';
  END IF;

  IF p_raised_by_participant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM politicore.governance_participants gp
     WHERE gp.id = p_raised_by_participant_id AND gp.tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'governance: participant not found in this tenant';
  END IF;

  IF p_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM politicore.governance_requests r
     WHERE r.id = p_request_id AND r.tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'governance: request not found in this tenant';
  END IF;

  INSERT INTO politicore.governance_engagement_issues
    (tenant_id, engagement_id, title, detail, raised_by_participant_id, request_id, created_by)
  VALUES (v_tenant, p_engagement, btrim(p_title), COALESCE(p_detail, ''),
          p_raised_by_participant_id, p_request_id, auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement_issue:create',
          'governance_engagement_issues', v_id::text,
          jsonb_build_object('engagement', p_engagement, 'request', p_request_id));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ISSUE RESOLUTION — bounded status vocabulary + optional staff request
-- link (explicit, audited, same-tenant; never automatic).
CREATE OR REPLACE FUNCTION politicore.update_governance_engagement_issue(
  p_issue uuid,
  p_status text DEFAULT NULL,
  p_detail text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL,
  p_link_request boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_engagement uuid;
BEGIN
  SELECT i.tenant_id, i.engagement_id INTO v_tenant, v_engagement
    FROM politicore.governance_engagement_issues i WHERE i.id = p_issue;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: engagement issue not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_engagement_geo_authority(v_engagement)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;

  IF p_status IS NOT NULL
     AND p_status::politicore.governance_engagement_issue_status NOT IN ('open','addressed','closed') THEN
    RAISE EXCEPTION 'governance: issue status must be open, addressed or closed';
  END IF;
  IF p_detail IS NOT NULL AND length(p_detail) > 4000 THEN
    RAISE EXCEPTION 'governance: issue detail exceeds the maximum length';
  END IF;

  IF p_link_request THEN
    IF p_request_id IS NULL THEN
      RAISE EXCEPTION 'governance: a request id is required to link';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM politicore.governance_requests r
       WHERE r.id = p_request_id AND r.tenant_id = v_tenant
    ) THEN
      RAISE EXCEPTION 'governance: request not found in this tenant';
    END IF;
  END IF;

  UPDATE politicore.governance_engagement_issues
     SET status = COALESCE(p_status::politicore.governance_engagement_issue_status, status),
         detail = COALESCE(p_detail, detail),
         request_id = CASE WHEN p_link_request THEN p_request_id ELSE request_id END,
         updated_at = now()
   WHERE id = p_issue;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement_issue:update',
          'governance_engagement_issues', p_issue::text,
          jsonb_build_object('status', p_status, 'request', p_request_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- FOLLOW-UPS ARE UPDATES (gate §10) — the canonical governance_updates
-- substrate with engagement as the subject (mirrors the Phase 13
-- commitment-update RPC verbatim).
CREATE OR REPLACE FUNCTION politicore.create_governance_engagement_update(
  p_engagement uuid,
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
  v_tenant := politicore.assert_engagement_authority(p_engagement);
  v_kind := p_kind::politicore.governance_update_kind;

  IF p_evidence_asset_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = p_evidence_asset_id
                      AND tenant_id = politicore.current_tenant_id()) THEN
      RAISE EXCEPTION 'governance: evidence asset not found in this tenant';
    END IF;
  END IF;

  INSERT INTO politicore.governance_updates
    (tenant_id, engagement_id, author_profile_id, title, body, kind,
     is_public, evidence_asset_id)
  VALUES (v_tenant, p_engagement, auth.uid(), COALESCE(p_title,''), btrim(p_body),
          v_kind, p_is_public, p_evidence_asset_id)
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_engagement_update:create',
          'governance_updates', v_id::text,
          jsonb_build_object('engagement', p_engagement, 'kind', v_kind::text,
                             'is_public', p_is_public));
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- FORCE RLS + POLICIES — read surfaces only; every mutation flows through
-- the authority RPCs (no INSERT/UPDATE/DELETE policies = writes fail
-- closed by RLS, institutional memory holds).
-- --------------------------------------------------------------------- */
ALTER TABLE politicore.governance_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagements FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_scopes FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_stakeholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_stakeholders FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_attendance FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_engagement_issues FORCE  ROW LEVEL SECURITY;

-- Engagements: staff-wide within the tenant; opt-in public (is_public)
-- records are additionally readable by any authenticated tenant member —
-- the "Authenticated" visibility level. Anonymous access does not exist
-- (the public projection surface is Phase 18).
CREATE POLICY governance_engagements_read ON politicore.governance_engagements
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance')
         OR is_public)
  );

-- Scopes: staff-only (management/reporting surface).
CREATE POLICY governance_engagement_scopes_read ON politicore.governance_engagement_scopes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Stakeholders: staff-only (gate §419 — rosters are never public PII).
CREATE POLICY governance_engagement_stakeholders_read ON politicore.governance_engagement_stakeholders
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Attendance: staff-only (gate §419 — counts/rosters staff-only).
CREATE POLICY governance_engagement_attendance_read ON politicore.governance_engagement_attendance
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Issues: staff-wide within the tenant PLUS the raising participant's own
-- row (a participant may re-read the issue they raised; never another's).
CREATE POLICY governance_engagement_issues_read ON politicore.governance_engagement_issues
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_governance')
      OR EXISTS (SELECT 1 FROM politicore.governance_participants gp
                  WHERE gp.id = governance_engagement_issues.raised_by_participant_id
                    AND gp.profile_id = auth.uid())
    )
  );

-- Canonical audit triggers on every new table (Core system_audits).
CREATE TRIGGER trg_audit_governance_engagements
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_engagements
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_engagement_scopes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_engagement_scopes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_engagement_stakeholders
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_engagement_stakeholders
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_engagement_attendance
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_engagement_attendance
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_engagement_issues
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_engagement_issues
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API SURFACE — the 0047/0048/0051/0052/0055 convention: thin
-- security_invoker views (zero authorization of their own — base-table
-- FORCE RLS remains the only boundary), mirrored grants, explicit
-- anon/PUBLIC revokes, and public RPC wrappers for the mutating RPCs
-- (text-overload convention, PostgREST-safe). NO anonymous surface.
-- --------------------------------------------------------------------- */
CREATE OR REPLACE VIEW public.governance_engagements
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_engagements;
CREATE OR REPLACE VIEW public.governance_engagement_scopes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_engagement_scopes;
CREATE OR REPLACE VIEW public.governance_engagement_stakeholders
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_engagement_stakeholders;
CREATE OR REPLACE VIEW public.governance_engagement_attendance
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_engagement_attendance;
CREATE OR REPLACE VIEW public.governance_engagement_issues
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_engagement_issues;

GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_engagements           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_engagement_scopes     TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_engagement_stakeholders TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_engagement_attendance TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_engagement_issues     TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_engagements           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_engagement_scopes     TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_engagement_stakeholders TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_engagement_attendance TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_engagement_issues     TO authenticated, service_role;

REVOKE ALL ON public.governance_engagements           FROM anon;
REVOKE ALL ON public.governance_engagement_scopes     FROM anon;
REVOKE ALL ON public.governance_engagement_stakeholders FROM anon;
REVOKE ALL ON public.governance_engagement_attendance FROM anon;
REVOKE ALL ON public.governance_engagement_issues     FROM anon;
REVOKE ALL ON public.governance_engagements           FROM PUBLIC;
REVOKE ALL ON public.governance_engagement_scopes     FROM PUBLIC;
REVOKE ALL ON public.governance_engagement_stakeholders FROM PUBLIC;
REVOKE ALL ON public.governance_engagement_attendance FROM PUBLIC;
REVOKE ALL ON public.governance_engagement_issues     FROM PUBLIC;

-- PUBLIC RPC WRAPPERS (text-overload convention; delegate verbatim).
CREATE OR REPLACE FUNCTION public.create_governance_engagement(
  p_title text,
  p_description text DEFAULT '',
  p_scheduled_at timestamptz DEFAULT NULL,
  p_location text DEFAULT '',
  p_agenda jsonb DEFAULT '[]',
  p_event_id uuid DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
  SELECT politicore.create_governance_engagement(
    p_title, p_description, p_scheduled_at, p_location, p_agenda, p_event_id, p_scopes);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_governance_engagement(
  p_engagement uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_scheduled_at timestamptz DEFAULT NULL,
  p_clear_scheduled_at boolean DEFAULT false,
  p_location text DEFAULT NULL,
  p_agenda jsonb DEFAULT NULL
) RETURNS void AS $$
  SELECT politicore.update_governance_engagement(
    p_engagement, p_title, p_description, p_scheduled_at, p_clear_scheduled_at, p_location, p_agenda);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.link_governance_engagement_event(
  p_engagement uuid,
  p_event_id uuid
) RETURNS void AS $$
  SELECT politicore.link_governance_engagement_event(p_engagement, p_event_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.unlink_governance_engagement_event(
  p_engagement uuid
) RETURNS void AS $$
  SELECT politicore.unlink_governance_engagement_event(p_engagement);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_engagement_status(
  p_engagement uuid,
  p_status text,
  p_outcomes text DEFAULT NULL
) RETURNS void AS $$
  SELECT politicore.set_governance_engagement_status(p_engagement, p_status, p_outcomes);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_engagement_visibility(
  p_engagement uuid,
  p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_engagement_visibility(p_engagement, p_is_public);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.add_governance_engagement_scope(
  p_engagement uuid,
  p_scope_type text,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.add_governance_engagement_scope(
    p_engagement, p_scope_type::politicore.scope_type_enum,
    p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.remove_governance_engagement_scope(
  p_scope uuid
) RETURNS void AS $$
  SELECT politicore.remove_governance_engagement_scope(p_scope);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.add_governance_engagement_stakeholder(
  p_engagement uuid,
  p_participant_id uuid,
  p_role_label text DEFAULT '',
  p_note text DEFAULT ''
) RETURNS uuid AS $$
  SELECT politicore.add_governance_engagement_stakeholder(p_engagement, p_participant_id, p_role_label, p_note);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.remove_governance_engagement_stakeholder(
  p_stakeholder uuid
) RETURNS uuid AS $$
  SELECT politicore.remove_governance_engagement_stakeholder(p_stakeholder);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.record_governance_engagement_attendance(
  p_engagement uuid,
  p_participant_id uuid,
  p_note text DEFAULT ''
) RETURNS uuid AS $$
  SELECT politicore.record_governance_engagement_attendance(p_engagement, p_participant_id, p_note);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.create_governance_engagement_issue(
  p_engagement uuid,
  p_title text,
  p_detail text DEFAULT '',
  p_raised_by_participant_id uuid DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.create_governance_engagement_issue(
    p_engagement, p_title, p_detail, p_raised_by_participant_id, p_request_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_governance_engagement_issue(
  p_issue uuid,
  p_status text DEFAULT NULL,
  p_detail text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL,
  p_link_request boolean DEFAULT false
) RETURNS void AS $$
  SELECT politicore.update_governance_engagement_issue(p_issue, p_status, p_detail, p_request_id, p_link_request);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.create_governance_engagement_update(
  p_engagement uuid,
  p_title text,
  p_body text,
  p_kind text DEFAULT 'progress',
  p_is_public boolean DEFAULT false,
  p_evidence_asset_id uuid DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.create_governance_engagement_update(
    p_engagement, p_title, p_body, p_kind, p_is_public, p_evidence_asset_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

-- EXECUTE hygiene (Phase 12–16 pattern): politicore.* reachable only by
-- authenticated (+ service_role via BYPASSRLS); anon holds nothing.
GRANT EXECUTE ON FUNCTION politicore.create_governance_engagement(text,text,timestamptz,text,jsonb,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.update_governance_engagement(uuid,text,text,timestamptz,boolean,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.link_governance_engagement_event(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.unlink_governance_engagement_event(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.set_governance_engagement_status(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.set_governance_engagement_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.add_governance_engagement_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.remove_governance_engagement_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.add_governance_engagement_stakeholder(uuid,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.remove_governance_engagement_stakeholder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.record_governance_engagement_attendance(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.create_governance_engagement_issue(uuid,text,text,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.update_governance_engagement_issue(uuid,text,text,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.create_governance_engagement_update(uuid,text,text,text,boolean,uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_governance_engagement(text,text,timestamptz,text,jsonb,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_governance_engagement(uuid,text,text,timestamptz,boolean,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.link_governance_engagement_event(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_governance_engagement_event(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_engagement_status(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_engagement_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_governance_engagement_scope(uuid,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_governance_engagement_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_governance_engagement_stakeholder(uuid,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_governance_engagement_stakeholder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_governance_engagement_attendance(uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_governance_engagement_issue(uuid,text,text,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_governance_engagement_issue(uuid,text,text,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_governance_engagement_update(uuid,text,text,text,boolean,uuid) TO authenticated;

REVOKE ALL ON FUNCTION politicore.create_governance_engagement(text,text,timestamptz,text,jsonb,uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.update_governance_engagement(uuid,text,text,timestamptz,boolean,text,jsonb) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.link_governance_engagement_event(uuid,uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.unlink_governance_engagement_event(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.set_governance_engagement_status(uuid,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.set_governance_engagement_visibility(uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.add_governance_engagement_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.remove_governance_engagement_scope(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.add_governance_engagement_stakeholder(uuid,uuid,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.remove_governance_engagement_stakeholder(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.record_governance_engagement_attendance(uuid,uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.create_governance_engagement_issue(uuid,text,text,uuid,uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.update_governance_engagement_issue(uuid,text,text,uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.create_governance_engagement_update(uuid,text,text,text,boolean,uuid) FROM anon, PUBLIC;

REVOKE ALL ON FUNCTION public.create_governance_engagement(text,text,timestamptz,text,jsonb,uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.update_governance_engagement(uuid,text,text,timestamptz,boolean,text,jsonb) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.link_governance_engagement_event(uuid,uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.unlink_governance_engagement_event(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.set_governance_engagement_status(uuid,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.set_governance_engagement_visibility(uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.add_governance_engagement_scope(uuid,text,text,text,text,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.remove_governance_engagement_scope(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.add_governance_engagement_stakeholder(uuid,uuid,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.remove_governance_engagement_stakeholder(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.record_governance_engagement_attendance(uuid,uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.create_governance_engagement_issue(uuid,text,text,uuid,uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.update_governance_engagement_issue(uuid,text,text,uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.create_governance_engagement_update(uuid,text,text,text,boolean,uuid) FROM anon, PUBLIC;

COMMIT;
