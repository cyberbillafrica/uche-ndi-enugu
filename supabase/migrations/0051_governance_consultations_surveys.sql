-- =====================================================================
-- POLITICORE — MIGRATION 0051: GOVERNANCE CONSULTATIONS & SURVEYS (P14)
-- =====================================================================
-- First Participation instrument, per the Phase 11 architecture gate
-- (docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md):
--
--   * politicore.governance_consultations      ONE canonical instrument
--                                              table, kind discriminator
--                                              consultation | survey (§5)
--   * politicore.governance_consultation_scopes   Core Geography scope rows
--                                                 (Phase 12 pattern; NO new
--                                                 geography, campaign
--                                                 structurally forbidden)
--   * politicore.governance_consultation_responses
--                                              one response per participant
--                                              per instrument —
--                                              UNIQUE (consultation_id,
--                                              participant_id) (§6)
--   * politicore.governance_updates            EXTENDED with
--                                              consultation_id; the
--                                              single-subject invariant is
--                                              restated (project |
--                                              commitment | consultation)
--   * permissions 'manage_participation' + 'publish_accountability'
--                                              (Phase 11 §16 — exactly the
--                                              two remaining authorized
--                                              governance permissions; no
--                                              new roles)
--
-- Security posture (identical to Phases 12/13):
--   * FORCE RLS, zero anonymous policies, server-resolved tenant/actor
--   * mutations only via SECURITY DEFINER authority RPCs
--     (manage_participation + geo-scope authority per row)
--   * participation needs NO permission — participant identity is the
--     authorization (0034 principle); eligibility = authenticated member
--     of the tenant (external contact-verified participation stays
--     deferred: Phase 11 §29 open decision 2 gates it)
--   * anonymous participation NOT implemented (Phase 11 §29 open decision
--     1 is bounded to Polls — prompt §7)
--   * lifecycle draft → open → closed → results_published enforced by
--     RPC + trigger; results_published additionally requires
--     publish_accountability; terminal records retained (no app DELETE)
--   * closes_at honored server-side; question definitions immutable once
--     open; answers validated server-side against the stored question set
--   * responses private: staff-only reads plus the participant's own row;
--     aggregates are published explicitly via publish_accountability
--     (never individual responses)
--   * Core notifications via best-effort 0036-pattern intents
--     (instrument-open invitation fanout; submission notice to staff)
--   * Core audit via the 0002 trigger + explicit RPC audit rows
--   * Media: nothing new — no attachments in the Phase 14 model
--   * Manifesto: NEVER queried; consultations are independent instruments
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- PERMISSION VOCABULARY (+2 — Phase 11 §16 authorized exactly these two)
-- ---------------------------------------------------------------------
-- The governance catalog becomes seven: assign_cases, manage_cases,
-- manage_projects, view_cases, view_governance + the two below. Grant
-- paths are the existing ones (permission_grants, position matrix, admin
-- bypass). No new roles.
-- ---------------------------------------------------------------------
INSERT INTO politicore.permissions (name, domain, description) VALUES
  ('manage_participation', 'governance', 'Create, run and close Governance consultations and surveys within the holder''s scope'),
  ('publish_accountability', 'governance', 'Publish Governance results/visibility to wider audiences (accountability publication)')
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- ENUMS — instrument kind + lifecycle (gate §5 exact states)
-- ---------------------------------------------------------------------
CREATE TYPE politicore.governance_consultation_kind AS ENUM (
  'consultation', 'survey'
);

-- draft → open → closed → results_published (consultations/surveys).
-- results_published is reached ONLY through publish_consultation_results.
CREATE TYPE politicore.governance_consultation_status AS ENUM (
  'draft', 'open', 'closed', 'results_published'
);

-- ─────────────────────────────────────────────────────────────────────────
-- INSTRUMENTS — one canonical table, kind discriminator (gate §5)
-- ---------------------------------------------------------------------
-- Questions are a bounded jsonb set (single_choice | multi_choice |
-- likert | short_text) validated server-side at write time; they are the
-- instrument's definition and become immutable once open (prompt §11).
-- References reuse the server-minted identifier doctrine (GP-/GC-
-- precedent) with a participation prefix.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_consultations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  kind           politicore.governance_consultation_kind NOT NULL DEFAULT 'consultation',
  reference_code text NOT NULL UNIQUE,
  title          text NOT NULL,
  description    text NOT NULL DEFAULT '',
  instructions   text NOT NULL DEFAULT '',
  questions      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(questions) = 'array'),
  status         politicore.governance_consultation_status NOT NULL DEFAULT 'draft',
  closes_at      timestamptz,
  results        jsonb CHECK (results IS NULL OR jsonb_typeof(results) = 'object'),
  results_summary text NOT NULL DEFAULT '',
  is_public      boolean NOT NULL DEFAULT false,
  published_at   timestamptz,
  created_by     uuid REFERENCES politicore.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- results aggregates can only exist on a closed-and-published instrument
  CONSTRAINT governance_consultations_results_require_closed CHECK (
    results IS NULL OR status = 'results_published'
  )
);

CREATE INDEX governance_consultations_tenant_idx
  ON politicore.governance_consultations (tenant_id, created_at DESC);
CREATE INDEX governance_consultations_status_idx
  ON politicore.governance_consultations (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────
-- GEOGRAPHIC SCOPES — Core Geography reuse, Phase 12 column-for-column
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_consultation_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  consultation_id uuid NOT NULL REFERENCES politicore.governance_consultations(id) ON DELETE CASCADE,
  scope_type      politicore.scope_type_enum NOT NULL
                    CHECK (scope_type <> 'campaign'),
  state_id        text,
  zone_id         text,
  lga_id          text,
  ward_id         text,
  polling_unit_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES politicore.profiles(id),
  CONSTRAINT governance_consultation_scope_shape CHECK (
    (scope_type = 'state' AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'lga' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'ward' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'polling_unit' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
  ),
  UNIQUE (consultation_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
);

CREATE INDEX governance_consultation_scopes_consultation_idx
  ON politicore.governance_consultation_scopes (consultation_id);

-- ─────────────────────────────────────────────────────────────────────────
-- RESPONSES — participant identity IS the authorization (0034 principle)
-- ---------------------------------------------------------------------
-- One response per participant per instrument (gate §6: UNIQUE
-- (consultation_id, participant_id)). Answers are a jsonb OBJECT keyed by
-- question id, validated server-side at submission against the stored
-- question set. No edit/update path in this slice (the architecture
-- defines submission, not response editing — deferred; the UNIQUE rule
-- makes re-submission impossible by construction).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_consultation_responses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  consultation_id uuid NOT NULL REFERENCES politicore.governance_consultations(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES politicore.governance_participants(id) ON DELETE CASCADE,
  answers         jsonb NOT NULL DEFAULT '{}' CHECK (answers IS NULL OR jsonb_typeof(answers) = 'object'),
  free_text       text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consultation_id, participant_id)
);

CREATE INDEX governance_consultation_responses_consultation_idx
  ON politicore.governance_consultation_responses (consultation_id, submitted_at);
CREATE INDEX governance_consultation_responses_participant_idx
  ON politicore.governance_consultation_responses (participant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- CANONICAL UPDATE SUBSTRATE — consultation subject extension (gate §11)
-- ---------------------------------------------------------------------
-- governance_updates gains its third subject FK. The single-subject
-- CHECK is restated (project | commitment | consultation = exactly one);
-- project + commitment behavior is untouched. No consultation update RPC
-- ships in this slice — no Phase 14 workflow emits delivery-narrative
-- updates; the substrate is ready for a later gate that justifies one.
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_updates
  ADD COLUMN consultation_id uuid REFERENCES politicore.governance_consultations(id) ON DELETE CASCADE;

ALTER TABLE politicore.governance_updates
  DROP CONSTRAINT governance_updates_single_subject;

ALTER TABLE politicore.governance_updates
  ADD CONSTRAINT governance_updates_single_subject CHECK (
    (COALESCE(project_id IS NOT NULL, false)::int
     + COALESCE(commitment_id IS NOT NULL, false)::int
     + COALESCE(consultation_id IS NOT NULL, false)::int) = 1
  );

CREATE INDEX governance_updates_consultation_idx
  ON politicore.governance_updates (consultation_id)
  WHERE consultation_id IS NOT NULL;

-- The 0048 public.governance_updates view expanded SELECT * before this
-- column existed — re-expand so the data API tracks the canonical table.
CREATE OR REPLACE VIEW public.governance_updates
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_updates;

-- ─────────────────────────────────────────────────────────────────────────
-- REFERENCE GENERATOR — PT- prefix + 8 uppercase hex (0050-correct shape:
-- assign AFTER the uniqueness loop, never inside it).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.make_governance_consultation_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'PT-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_consultations WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_consultation_reference
  BEFORE INSERT ON politicore.governance_consultations
  FOR EACH ROW EXECUTE FUNCTION politicore.make_governance_consultation_reference();

-- ─────────────────────────────────────────────────────────────────────────
-- IDENTITY GUARD — reference immutable; visibility flips only through the
-- authority RPC (GUC-gated, 0043/0045/0048 precedent).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_consultation_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: consultation reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: consultation visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_consultation_identity
  BEFORE UPDATE ON politicore.governance_consultations
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_consultation_identity();

-- ─────────────────────────────────────────────────────────────────────────
-- LIFECYCLE GUARD — server-enforced transitions (trigger mirrors the RPC
-- map; belt-and-braces against any future direct path).
--   draft → open; open → closed; closed → results_published.
-- No reopen, no draft→closed, no skipping states (institutional memory:
-- terminal records retained — gate §5/§24).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_consultation_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'draft'  AND NEW.status = 'open')
    OR (OLD.status = 'open'   AND NEW.status = 'closed')
    OR (OLD.status = 'closed' AND NEW.status = 'results_published')
  ) THEN
    RAISE EXCEPTION 'governance: illegal consultation status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_consultation_status
  BEFORE UPDATE OF status ON politicore.governance_consultations
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_consultation_status();

-- ─────────────────────────────────────────────────────────────────────────
-- QUESTION DEFINITION VALIDATION (server-side; shared by create/update).
-- Bounded vocabulary — NOT a generalized survey engine (prompt §9):
--   single_choice: options[] non-empty; answer is one option
--   multi_choice : options[] non-empty; answer is a subset (array)
--   likert       : scale int 2..7; answer is an int within 1..scale
--   short_text   : free string (length-capped at submission)
-- Question ids must be unique (answers are keyed by id).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.validate_consultation_questions(
  p_questions jsonb
) RETURNS void AS $$
DECLARE
  v_q jsonb;
  v_kind text;
  v_prompt text;
  v_id text;
  v_scale int;
  v_opts jsonb;
  v_seen text[] := ARRAY[]::text[];
BEGIN
  IF p_questions IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_questions) <> 'array' THEN
    RAISE EXCEPTION 'governance: questions must be an array';
  END IF;
  FOR v_q IN SELECT * FROM jsonb_array_elements(p_questions) LOOP
    v_kind := v_q->>'kind';
    v_prompt := v_q->>'prompt';
    v_id := v_q->>'id';
    IF v_id IS NULL OR length(btrim(v_id)) = 0 THEN
      RAISE EXCEPTION 'governance: every question requires an id';
    END IF;
    IF v_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'governance: duplicate question id %', v_id;
    END IF;
    v_seen := v_seen || v_id;
    IF v_kind NOT IN ('single_choice', 'multi_choice', 'likert', 'short_text') THEN
      RAISE EXCEPTION 'governance: unsupported question kind %', v_kind;
    END IF;
    IF v_prompt IS NULL OR length(btrim(v_prompt)) = 0 THEN
      RAISE EXCEPTION 'governance: every question requires a prompt';
    END IF;
    IF v_kind IN ('single_choice', 'multi_choice') THEN
      v_opts := v_q->'options';
      IF v_opts IS NULL OR jsonb_typeof(v_opts) <> 'array'
         OR jsonb_array_length(v_opts) < 2 THEN
        RAISE EXCEPTION 'governance: choice questions require at least two options';
      END IF;
    END IF;
    IF v_kind = 'likert' THEN
      v_scale := (v_q->>'scale')::int;
      IF v_scale IS NULL OR v_scale < 2 OR v_scale > 7 THEN
        RAISE EXCEPTION 'governance: likert scale must be between 2 and 7';
      END IF;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY (mirrors assert_commitment_authority / has_commitment_geo_
-- authority with manage_participation; Phase 12/13 pattern verbatim).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.has_consultation_geo_authority(
  p_consultation uuid
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politicore.governance_consultation_scopes cs
     WHERE cs.consultation_id = p_consultation
       AND politicore.has_permission('manage_participation', cs.scope_type,
             COALESCE(cs.polling_unit_id, cs.ward_id, cs.lga_id, cs.zone_id, cs.state_id))
  )
  OR ( -- a tenant-wide grant covers any scope
    politicore.has_permission('manage_participation')
    AND EXISTS (SELECT 1 FROM politicore.governance_consultations
                 WHERE id = p_consultation AND tenant_id = politicore.current_tenant_id())
  );
$$ LANGUAGE sql STABLE SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.assert_consultation_authority(
  p_consultation uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_consultations WHERE id = p_consultation;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: consultation not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_consultation_geo_authority(p_consultation)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;
  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- NOTIFICATION INTENTS (0036 best-effort pattern — NEVER fail the
-- business action; recipients resolved server-side).
-- ---------------------------------------------------------------------
-- Invitation fanout on open: unscoped instruments address every tenant
-- member; geo-scoped instruments address members whose ward/LGA/PU falls
-- within the instrument's scopes (state/zone scopes are tenant-wide by
-- nature — profiles carry no state/zone columns).
CREATE OR REPLACE FUNCTION politicore.governance_notify_consultation_open(
  p_consultation uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_kind text;
  v_ref text;
  v_scoped boolean;
BEGIN
  SELECT tenant_id, title, kind::text, reference_code,
         EXISTS (SELECT 1 FROM politicore.governance_consultation_scopes cs
                  WHERE cs.consultation_id = p_consultation
                    AND cs.scope_type IN ('lga', 'ward', 'polling_unit'))
    INTO v_tenant, v_title, v_kind, v_ref, v_scoped
    FROM politicore.governance_consultations WHERE id = p_consultation;

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT v_tenant, p.id,
         CASE WHEN v_kind = 'survey' THEN 'announcement' ELSE 'system' END,
         CASE WHEN v_kind = 'survey' THEN 'A survey is open for your input'
              ELSE 'A consultation is open for your input' END,
         v_title || ' (ref ' || v_ref || ') is open — share your view before it closes.',
         '/governance/participate',
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (NOT v_scoped OR EXISTS (
       SELECT 1 FROM politicore.governance_consultation_scopes cs
        WHERE cs.consultation_id = p_consultation
          AND cs.scope_type IN ('lga', 'ward', 'polling_unit')
          AND (cs.lga_id = p.lga_id OR cs.ward_id = p.ward_id
               OR cs.polling_unit_id = p.polling_unit_id)));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance consultation open notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Submission notice to staff: the instrument creator + tenant admins.
CREATE OR REPLACE FUNCTION politicore.governance_notify_consultation_submission(
  p_consultation uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_ref text;
  v_creator uuid;
BEGIN
  SELECT tenant_id, title, reference_code, created_by
    INTO v_tenant, v_title, v_ref, v_creator
    FROM politicore.governance_consultations WHERE id = p_consultation;

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT v_tenant, p.id, 'system',
         'New participation response',
         'A response was submitted to "' || v_title || '" (ref ' || v_ref || ').',
         '/portal/governance/participation/' || p_consultation::text,
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (p.id = v_creator
          OR (p.id <> COALESCE(v_creator, p.id) AND false))
     OR (p.tenant_id = v_tenant AND p.id = v_creator);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance consultation submission notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs (SECURITY DEFINER; resolve caller+tenant+permission
-- server-side; audit in Core; never trust client authority fields).
-- ---------------------------------------------------------------------

-- CREATE. Server mints reference/tenant/created_by; questions validated;
-- initial scopes validated against Core Geography and the CALLER's
-- authority for the scope being attached (Phase 12 bootstrap-correct
-- rule). Scope-scoped grantees must deliver ≥1 authorized scope (0049
-- rule). Staff-created only (gate §5) — participant-originated
-- instruments are a Petitions concern, not this table.
CREATE OR REPLACE FUNCTION politicore.create_governance_consultation(
  p_kind text,
  p_title text,
  p_description text DEFAULT '',
  p_instructions text DEFAULT '',
  p_questions jsonb DEFAULT '[]',
  p_closes_at timestamptz DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_consultation uuid;
  v_s jsonb;
  v_kind politicore.governance_consultation_kind;
  v_unscoped boolean;
  v_scope_count integer;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: title is required';
  END IF;
  v_kind := p_kind::politicore.governance_consultation_kind;

  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  -- Tenant-wide holders (incl. admins via bypass) OR any
  -- manage_participation grantee; scope-scoped grantees are further
  -- constrained below (per-scope authority is enforced by
  -- add_governance_consultation_scope).
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

  PERFORM politicore.validate_consultation_questions(p_questions);

  INSERT INTO politicore.governance_consultations
    (tenant_id, kind, title, description, instructions, questions, closes_at, created_by)
  VALUES
    (v_tenant, v_kind, btrim(p_title), COALESCE(p_description,''),
     COALESCE(p_instructions,''), COALESCE(p_questions,'[]'::jsonb),
     p_closes_at, v_caller)
  RETURNING id INTO v_consultation;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes::jsonb) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_consultation_scope(v_consultation,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  -- A scope-scoped grantee MUST deliver at least one scope within their
  -- authority (otherwise they would mint a tenant-wide instrument). The
  -- RAISE aborts the transaction: no orphan instrument survives.
  IF NOT v_unscoped THEN
    SELECT count(*) INTO v_scope_count
      FROM politicore.governance_consultation_scopes WHERE consultation_id = v_consultation;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'governance: manage_participation with a scope within your authority is required';
    END IF;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_consultation:create',
          'governance_consultations', v_consultation::text,
          jsonb_build_object('title', p_title, 'kind', v_kind::text,
                             'status', 'draft'));
  RETURN v_consultation;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE (draft-only content; the open-window lever closes_at may move
-- while open — gate §5 "closes_at honored server-side"). Question
-- definitions are immutable once open (prompt §11).
CREATE OR REPLACE FUNCTION politicore.update_governance_consultation(
  p_consultation uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_instructions text DEFAULT NULL,
  p_questions jsonb DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_clear_closes_at boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_consultation_status;
BEGIN
  v_tenant := politicore.assert_consultation_authority(p_consultation);
  SELECT status INTO v_status FROM politicore.governance_consultations WHERE id = p_consultation;

  IF v_status <> 'draft' THEN
    IF (p_title IS NOT NULL OR p_description IS NOT NULL
        OR p_instructions IS NOT NULL OR p_questions IS NOT NULL) THEN
      RAISE EXCEPTION 'governance: instrument content is only editable while in draft';
    END IF;
  END IF;

  IF p_questions IS NOT NULL THEN
    PERFORM politicore.validate_consultation_questions(p_questions);
  END IF;

  UPDATE politicore.governance_consultations
     SET title        = COALESCE(p_title, title),
         description  = COALESCE(p_description, description),
         instructions = COALESCE(p_instructions, instructions),
         questions    = COALESCE(p_questions, questions),
         closes_at    = CASE WHEN p_clear_closes_at THEN NULL
                             ELSE COALESCE(p_closes_at, closes_at) END,
         updated_at   = now()
   WHERE id = p_consultation;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_consultation:update',
          'governance_consultations', p_consultation::text,
          jsonb_build_object('title', p_title, 'closes_at', p_closes_at));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STATUS — draft → open (fires the invitation intent) → closed.
-- results_published is NOT reachable here: publication is a separate,
-- publish_accountability-gated act with a payload (below).
CREATE OR REPLACE FUNCTION politicore.set_governance_consultation_status(
  p_consultation uuid,
  p_status text
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old politicore.governance_consultation_status;
BEGIN
  v_tenant := politicore.assert_consultation_authority(p_consultation);
  IF p_status::politicore.governance_consultation_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'governance: status must be open or closed';
  END IF;
  SELECT status INTO v_old FROM politicore.governance_consultations WHERE id = p_consultation;

  UPDATE politicore.governance_consultations
     SET status = p_status::politicore.governance_consultation_status,
         updated_at = now()
   WHERE id = p_consultation;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_consultation:status',
          'governance_consultations', p_consultation::text,
          jsonb_build_object('status', v_old::text),
          jsonb_build_object('status', p_status));

  IF p_status = 'open' THEN
    PERFORM politicore.governance_notify_consultation_open(p_consultation, auth.uid());
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- RESULTS PUBLICATION — the audited publish_accountability act (gate §5:
-- "aggregates only — never individual responses"; publication is
-- explicit). The payload is assembled by authorized staff from staff-only
-- response reads; the RPC verifies only its authority + closed state.
CREATE OR REPLACE FUNCTION politicore.publish_consultation_results(
  p_consultation uuid,
  p_summary text DEFAULT '',
  p_results jsonb DEFAULT '{}'::jsonb
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_consultation_status;
BEGIN
  v_tenant := politicore.assert_consultation_authority(p_consultation);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to publish results';
  END IF;
  SELECT status INTO v_status FROM politicore.governance_consultations WHERE id = p_consultation;
  IF v_status <> 'closed' THEN
    RAISE EXCEPTION 'governance: results can only be published after closure';
  END IF;

  UPDATE politicore.governance_consultations
     SET results = COALESCE(p_results, '{}'::jsonb),
         results_summary = COALESCE(p_summary, ''),
         status = 'results_published',
         updated_at = now()
   WHERE id = p_consultation;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_consultation:results_published',
          'governance_consultations', p_consultation::text,
          jsonb_build_object('status', v_status::text),
          jsonb_build_object('status', 'results_published',
                             'summary_len', length(COALESCE(p_summary, ''))));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VISIBILITY — the Phase 11 taxonomy lever (opt-in Public is gated by
-- publish_accountability across ALL governance objects; the public
-- projection surface itself is Phase 18 and is not built here).
CREATE OR REPLACE FUNCTION politicore.set_governance_consultation_visibility(
  p_consultation uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old boolean;
BEGIN
  v_tenant := politicore.assert_consultation_authority(p_consultation);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;
  SELECT is_public INTO v_old FROM politicore.governance_consultations WHERE id = p_consultation;

  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);

  UPDATE politicore.governance_consultations
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN COALESCE(published_at, now()) ELSE NULL END
   WHERE id = p_consultation;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_consultation:visibility',
          'governance_consultations', p_consultation::text,
          jsonb_build_object('is_public', v_old),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- GEOGRAPHIC SCOPES (validated against Core Geography + caller authority
-- for THE SCOPE BEING ATTACHED — the Phase 12 bootstrap-correct rule).
CREATE OR REPLACE FUNCTION politicore.add_governance_consultation_scope(
  p_consultation uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_consultation_tenant uuid;
  v_exists boolean;
  v_scope uuid;
  v_scope_id text;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance consultations';
  END IF;

  SELECT tenant_id INTO v_consultation_tenant
    FROM politicore.governance_consultations WHERE id = p_consultation;
  IF v_consultation_tenant IS NULL OR v_consultation_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: consultation not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  v_scope_id := COALESCE(p_polling_unit_id, p_ward_id, p_lga_id, p_zone_id, p_state_id);

  -- Authority for THIS scope (bootstrap-correct: evaluated on the scope
  -- being attached, never on previously attached rows).
  IF NOT (politicore.is_tenant_admin()
          OR politicore.has_permission('manage_participation', p_scope_type, v_scope_id)) THEN
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
                       WHERE id = p_polling_unit_id AND ward_id = p_ward_id));
  IF NOT v_exists THEN
    RAISE EXCEPTION 'governance: scope does not exist in Core Geography';
  END IF;

  INSERT INTO politicore.governance_consultation_scopes
    (tenant_id, consultation_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id, created_by)
  VALUES (v_consultation_tenant, p_consultation, p_scope_type,
          p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id, auth.uid())
  ON CONFLICT (consultation_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  DO UPDATE SET polling_unit_id = EXCLUDED.polling_unit_id
  RETURNING id INTO v_scope;

  RETURN v_scope;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_consultation_scope(
  p_scope uuid
) RETURNS void AS $$
DECLARE
  v_consultation uuid;
  v_tenant uuid;
BEGIN
  SELECT consultation_id INTO v_consultation
    FROM politicore.governance_consultation_scopes WHERE id = p_scope;
  IF v_consultation IS NULL THEN
    RAISE EXCEPTION 'governance: consultation scope not found';
  END IF;
  v_tenant := politicore.assert_consultation_authority(v_consultation);

  DELETE FROM politicore.governance_consultation_scopes WHERE id = p_scope;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id)
  VALUES (v_tenant, auth.uid(), 'governance_consultation:scope_removed',
          'governance_consultation_scopes', p_scope::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- PARTICIPATION — submit a response (participant identity is the
-- authorization; NO permission check, NO client identity, NO client
-- status decisions).
-- ---------------------------------------------------------------------
-- Server-authoritative, in order: caller tenant → module on → instrument
-- exists in tenant → status open → closes_at honored → answers validated
-- against the STORED question set → participant row resolved/created
-- server-side → UNIQUE duplicate rule enforced → audit.
CREATE OR REPLACE FUNCTION politicore.submit_governance_consultation_response(
  p_consultation uuid,
  p_answers jsonb DEFAULT '{}'::jsonb,
  p_free_text text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_tenant uuid;
  v_id uuid;
  v_status politicore.governance_consultation_status;
  v_closes_at timestamptz;
  v_questions jsonb;
  v_q jsonb;
  v_qid text;
  v_kind text;
  v_required boolean;
  v_ans jsonb;
  v_opt jsonb;
  v_cand jsonb;
  v_opt_ok boolean;
  v_scale int;
  v_n int;
BEGIN
  IF p_answers IS NOT NULL AND jsonb_typeof(p_answers) <> 'object' THEN
    RAISE EXCEPTION 'governance: answers must be an object keyed by question id';
  END IF;
  IF p_free_text IS NOT NULL AND length(p_free_text) > 8000 THEN
    RAISE EXCEPTION 'governance: free text exceeds the maximum length';
  END IF;

  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  SELECT status, closes_at, questions INTO v_status, v_closes_at, v_questions
    FROM politicore.governance_consultations
   WHERE id = p_consultation AND tenant_id = v_tenant;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'governance: consultation not found';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'governance: instrument is not open for participation';
  END IF;
  IF v_closes_at IS NOT NULL AND now() > v_closes_at THEN
    RAISE EXCEPTION 'governance: instrument is not open for participation';
  END IF;

  -- Validate every stored question's answer (required enforcement, kind
  -- conformance, option membership, scale bounds) and reject answers for
  -- questions that do not exist.
  IF p_answers IS NOT NULL THEN
    FOR v_q IN SELECT * FROM jsonb_array_elements(COALESCE(v_questions, '[]'::jsonb)) LOOP
      v_qid := v_q->>'id';
      v_kind := v_q->>'kind';
      v_required := COALESCE((v_q->>'required')::boolean, false);
      v_ans := p_answers -> v_qid;
      IF v_ans IS NULL OR v_ans = 'null'::jsonb THEN
        IF v_required THEN
          RAISE EXCEPTION 'governance: question % requires an answer', v_qid;
        END IF;
        CONTINUE;
      END IF;
      IF v_kind = 'single_choice' THEN
        IF jsonb_typeof(v_ans) <> 'string' THEN
          RAISE EXCEPTION 'governance: question % expects a single choice', v_qid;
        END IF;
        v_opt_ok := false;
        FOR v_opt IN SELECT * FROM jsonb_array_elements(v_q->'options') LOOP
          IF v_opt = v_ans THEN v_opt_ok := true; END IF;
        END LOOP;
        IF NOT v_opt_ok THEN
          RAISE EXCEPTION 'governance: answer to question % is not a valid option', v_qid;
        END IF;
      ELSIF v_kind = 'multi_choice' THEN
        IF jsonb_typeof(v_ans) <> 'array' OR jsonb_array_length(v_ans) = 0 THEN
          RAISE EXCEPTION 'governance: question % expects a non-empty set of choices', v_qid;
        END IF;
        v_n := 0;
        FOR v_opt IN SELECT * FROM jsonb_array_elements(v_ans) LOOP
          v_opt_ok := false;
          FOR v_cand IN SELECT * FROM jsonb_array_elements(v_q->'options') LOOP
            IF v_cand = v_opt THEN v_opt_ok := true; END IF;
          END LOOP;
          IF NOT v_opt_ok THEN
            RAISE EXCEPTION 'governance: answer to question % is not a valid option', v_qid;
          END IF;
          v_n := v_n + 1;
        END LOOP;
        -- duplicates would inflate counts silently — reject them
        IF (SELECT count(DISTINCT o) FROM jsonb_array_elements_text(v_ans) o) <> v_n THEN
          RAISE EXCEPTION 'governance: answer to question % contains duplicates', v_qid;
        END IF;
      ELSIF v_kind = 'likert' THEN
        v_scale := (v_q->>'scale')::int;
        IF jsonb_typeof(v_ans) <> 'number'
           OR (v_ans #>> '{}') !~ '^\d+$'
           OR (v_ans #>> '{}')::int < 1
           OR (v_ans #>> '{}')::int > v_scale THEN
          RAISE EXCEPTION 'governance: answer to question % is outside the scale', v_qid;
        END IF;
      ELSIF v_kind = 'short_text' THEN
        IF jsonb_typeof(v_ans) <> 'string' OR length(v_ans #>> '{}') > 2000 THEN
          RAISE EXCEPTION 'governance: answer to question % must be a short text', v_qid;
        END IF;
      END IF;
    END LOOP;
    -- unknown question ids in the payload cannot ride along
    FOR v_qid IN SELECT jsonb_object_keys(p_answers) LOOP
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_questions, '[]'::jsonb)) qq
         WHERE qq->>'id' = v_qid
      ) THEN
        RAISE EXCEPTION 'governance: answer references unknown question %', v_qid;
      END IF;
    END LOOP;
  END IF;

  -- Participant resolution: the caller's tenant participant row, created
  -- on demand from Core Identity (0034 self-registration precedent;
  -- never client-supplied).
  INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name, email)
  SELECT v_tenant, v_caller, p.full_name, p.email
    FROM politicore.profiles p
   WHERE p.id = v_caller
  ON CONFLICT DO NOTHING;

  BEGIN
    INSERT INTO politicore.governance_consultation_responses
      (tenant_id, consultation_id, participant_id, answers, free_text)
    SELECT v_tenant, p_consultation, gp.id,
           COALESCE(p_answers, '{}'::jsonb), p_free_text
      FROM politicore.governance_participants gp
     WHERE gp.profile_id = v_caller
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'governance: you have already responded to this instrument';
  END;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_consultation:response',
          'governance_consultation_responses', v_id::text,
          jsonb_build_object('consultation', p_consultation));

  -- Staff submission notice (Core intent, best-effort).
  PERFORM politicore.governance_notify_consultation_submission(p_consultation, v_caller);

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- FORCE RLS + POLICIES — read surfaces only; every mutation flows through
-- the authority RPCs (no INSERT/UPDATE/DELETE policies = writes fail
-- closed by RLS, institutional memory holds).
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_consultations FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_consultation_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_consultation_scopes FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_consultation_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_consultation_responses FORCE  ROW LEVEL SECURITY;

-- Instruments: staff-wide within the tenant; OPEN instruments are
-- discoverable by any member (participation requires discovery; §16 of
-- prompt — eligible participants must be able to see the instrument).
CREATE POLICY governance_consultations_read ON politicore.governance_consultations
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance')
         OR status = 'open')
  );

-- Scopes: staff-only (management/reporting surface).
CREATE POLICY governance_consultation_scopes_read ON politicore.governance_consultation_scopes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Responses: staff-wide within the tenant PLUS the participant's own row
-- (C10 boundary: a participant can never read another participant's
-- response; aggregate publication is explicit, never row-level public).
CREATE POLICY governance_consultation_responses_read ON politicore.governance_consultation_responses
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_governance')
      OR EXISTS (SELECT 1 FROM politicore.governance_participants gp
                  WHERE gp.id = governance_consultation_responses.participant_id
                    AND gp.profile_id = auth.uid())
    )
  );

-- Canonical audit triggers on every new table (Core system_audits).
CREATE TRIGGER trg_audit_governance_consultations
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_consultations
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_consultation_scopes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_consultation_scopes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_consultation_responses
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_consultation_responses
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API SURFACE — the 0047/0048 convention: thin
-- security_invoker views (zero authorization of their own — base-table
-- FORCE RLS remains the only boundary), mirrored grants, explicit
-- anon/PUBLIC revokes, and public RPC wrappers for the mutating RPCs
-- (text-overload convention, PostgREST-safe). NO public participation
-- surface: anonymous holds NOTHING (external verified participation is
-- Phase 11 §29 open decision 2 — deferred).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.governance_consultations
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_consultations;
CREATE OR REPLACE VIEW public.governance_consultation_scopes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_consultation_scopes;
CREATE OR REPLACE VIEW public.governance_consultation_responses
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_consultation_responses;

GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_consultations          TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_consultation_scopes    TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_consultation_responses TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_consultations          TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_consultation_scopes    TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_consultation_responses TO authenticated, service_role;

REVOKE ALL ON public.governance_consultations          FROM anon;
REVOKE ALL ON public.governance_consultation_scopes    FROM anon;
REVOKE ALL ON public.governance_consultation_responses FROM anon;
REVOKE ALL ON public.governance_consultations          FROM PUBLIC;
REVOKE ALL ON public.governance_consultation_scopes    FROM PUBLIC;
REVOKE ALL ON public.governance_consultation_responses FROM PUBLIC;

-- PUBLIC RPC WRAPPERS (text-overload convention; delegate verbatim).
CREATE OR REPLACE FUNCTION public.create_governance_consultation(
  p_kind text,
  p_title text,
  p_description text DEFAULT '',
  p_instructions text DEFAULT '',
  p_questions jsonb DEFAULT '[]',
  p_closes_at timestamptz DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
  SELECT politicore.create_governance_consultation(
    p_kind, p_title, p_description, p_instructions, p_questions, p_closes_at, p_scopes);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_governance_consultation(
  p_consultation uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_instructions text DEFAULT NULL,
  p_questions jsonb DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_clear_closes_at boolean DEFAULT false
) RETURNS void AS $$
  SELECT politicore.update_governance_consultation(
    p_consultation, p_title, p_description, p_instructions, p_questions, p_closes_at, p_clear_closes_at);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_consultation_status(
  p_consultation uuid,
  p_status text
) RETURNS void AS $$
  SELECT politicore.set_governance_consultation_status(p_consultation, p_status);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.publish_consultation_results(
  p_consultation uuid,
  p_summary text DEFAULT '',
  p_results jsonb DEFAULT '{}'::jsonb
) RETURNS void AS $$
  SELECT politicore.publish_consultation_results(p_consultation, p_summary, p_results);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_consultation_visibility(
  p_consultation uuid,
  p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_consultation_visibility(p_consultation, p_is_public);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.add_governance_consultation_scope(
  p_consultation uuid,
  p_scope_type text,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.add_governance_consultation_scope(
    p_consultation, p_scope_type::politicore.scope_type_enum,
    p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.remove_governance_consultation_scope(
  p_scope uuid
) RETURNS void AS $$
  SELECT politicore.remove_governance_consultation_scope(p_scope);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.submit_governance_consultation_response(
  p_consultation uuid,
  p_answers jsonb DEFAULT '{}'::jsonb,
  p_free_text text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.submit_governance_consultation_response(p_consultation, p_answers, p_free_text);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

-- EXECUTE hygiene (Phase 12/13 pattern): politicore.* reachable only by
-- authenticated (+ service_role via BYPASSRLS); anon holds nothing.
GRANT EXECUTE ON FUNCTION politicore.create_governance_consultation(text,text,text,text,jsonb,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.update_governance_consultation(uuid,text,text,text,jsonb,timestamptz,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.set_governance_consultation_status(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.publish_consultation_results(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.set_governance_consultation_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.add_governance_consultation_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.remove_governance_consultation_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.submit_governance_consultation_response(uuid,jsonb,text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_governance_consultation(text,text,text,text,jsonb,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_governance_consultation(uuid,text,text,text,jsonb,timestamptz,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_consultation_status(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_consultation_results(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_consultation_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_governance_consultation_scope(uuid,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_governance_consultation_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_governance_consultation_response(uuid,jsonb,text) TO authenticated;

REVOKE EXECUTE ON FUNCTION politicore.create_governance_consultation(text,text,text,text,jsonb,timestamptz,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.update_governance_consultation(uuid,text,text,text,jsonb,timestamptz,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_consultation_status(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.publish_consultation_results(uuid,text,jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_consultation_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.add_governance_consultation_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.remove_governance_consultation_scope(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.submit_governance_consultation_response(uuid,jsonb,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_consultation(text,text,text,text,jsonb,timestamptz,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_governance_consultation(uuid,text,text,text,jsonb,timestamptz,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_consultation_status(uuid,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.publish_consultation_results(uuid,text,jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_consultation_visibility(uuid,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.add_governance_consultation_scope(uuid,text,text,text,text,text,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_governance_consultation_scope(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.submit_governance_consultation_response(uuid,jsonb,text) FROM anon;
