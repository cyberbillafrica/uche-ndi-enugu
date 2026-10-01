-- POLITICORE — MIGRATION 0055: GOVERNANCE POLLS (PHASE 16).
--
-- Implements the Phase 11 §8 Poll architecture exactly:
--
--   governance_polls + governance_poll_votes: single question, fixed
--   options, one vote per participant (UNIQUE(poll_id, participant_id)),
--   instant aggregate. Lightweight: no documents, no thresholds, no
--   verification workflow. Lifecycle: draft → open → closed (gate §8/§130).
--
-- ANONYMOUS PARTICIPATION — NOT IMPLEMENTED. Phase 11 §29 OPEN DECISION 1
-- ("whether polls admit unauthenticated votes and, if so, the
-- privacy-preserving dedup mechanism (no fingerprinting surface)") is
-- explicitly unresolved and required to be threat-modeled before
-- implementation. This migration ships the authenticated slice only and
-- proves anon holds nothing; no dedup mechanism is invented. A later,
-- separately authorized gate must resolve the decision before any
-- anonymous surface exists.
--
-- Reuses, unchanged: Core Identity (profiles), governance_participants,
-- Core Geography (scope_covers/my_scopes semantics), Core Notifications,
-- Core Audit (system_audits), permission catalog (seven; zero new
-- permissions, zero new roles), governance_updates (poll NOT a subject —
-- the Phase 11 ERD names project|commitment|request|consultation|petition|
-- engagement; a poll question is not a delivery narrative).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- ENUMS
-- --------------------------------------------------------------------- */
CREATE TYPE politicore.governance_poll_status AS ENUM ('draft', 'open', 'closed');

-- ─────────────────────────────────────────────────────────────────────────
-- CANONICAL POLLS — single question, fixed options (jsonb definitions,
-- server-validated; frozen once open — prompt §8/§9).
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_polls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  reference_code text NOT NULL UNIQUE,
  title          text NOT NULL,
  question       text NOT NULL,
  description    text NOT NULL DEFAULT '',
  options        jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) >= 2 AND jsonb_array_length(options) <= 20),
  status         politicore.governance_poll_status NOT NULL DEFAULT 'draft',
  closes_at      timestamptz,
  results        jsonb CHECK (results IS NULL OR jsonb_typeof(results) = 'object'),
  results_summary text NOT NULL DEFAULT '',
  is_public      boolean NOT NULL DEFAULT false,
  published_at   timestamptz,
  created_by     uuid REFERENCES politicore.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- results aggregates can only exist on a closed-and-published poll
  CONSTRAINT governance_polls_results_require_closed CHECK (
    results IS NULL OR status = 'closed'
  )
);

CREATE INDEX governance_polls_tenant_idx
  ON politicore.governance_polls (tenant_id, created_at DESC);
CREATE INDEX governance_polls_status_idx
  ON politicore.governance_polls (tenant_id, status);

-- OPTIONS GUARD — plain non-empty strings, unique, length-capped
-- (PostgreSQL forbids set-returning functions in CHECK constraints, so
-- the shape runs as a trigger on every write path, direct or RPC).
CREATE OR REPLACE FUNCTION politicore.guard_governance_poll_options()
RETURNS trigger AS $$
DECLARE
  v_n int;
BEGIN
  IF NEW.options IS NULL OR jsonb_typeof(NEW.options) <> 'array' THEN
    RAISE EXCEPTION 'governance: poll options must be an array';
  END IF;
  v_n := jsonb_array_length(NEW.options);
  IF v_n < 2 OR v_n > 20 THEN
    RAISE EXCEPTION 'governance: a poll requires 2-20 options';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.options) o
     WHERE jsonb_typeof(o) <> 'string'
        OR length(o #>> '{}') = 0
        OR length(o #>> '{}') > 200
  ) THEN
    RAISE EXCEPTION 'governance: poll options must be non-empty strings of at most 200 characters';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements_text(NEW.options))
     <> (SELECT count(DISTINCT o) FROM jsonb_array_elements_text(NEW.options) o) THEN
    RAISE EXCEPTION 'governance: poll options must be unique';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_poll_options
  BEFORE INSERT OR UPDATE OF options ON politicore.governance_polls
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_poll_options();

-- ─────────────────────────────────────────────────────────────────────────
-- GEO SCOPES — Core Geography child, Phase 12–15 shape verbatim.
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_poll_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  poll_id         uuid NOT NULL REFERENCES politicore.governance_polls(id) ON DELETE CASCADE,
  scope_type      politicore.scope_type_enum NOT NULL
                    CHECK (scope_type <> 'campaign'),
  state_id        text,
  zone_id         text,
  lga_id          text,
  ward_id         text,
  polling_unit_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES politicore.profiles(id),
  CONSTRAINT governance_poll_scope_shape CHECK (
    (scope_type = 'state' AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'lga' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'ward' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'polling_unit' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
  ),
  UNIQUE (poll_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
);

CREATE INDEX governance_poll_scopes_poll_idx
  ON politicore.governance_poll_scopes (poll_id);

-- ─────────────────────────────────────────────────────────────────────────
-- VOTES — append-only by policy architecture: no UPDATE/DELETE policy,
-- no UPDATE/DELETE grant path in any RPC. One vote per participant.
-- --------------------------------------------------------------------- */
CREATE TABLE politicore.governance_poll_votes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  poll_id        uuid NOT NULL REFERENCES politicore.governance_polls(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES politicore.governance_participants(id) ON DELETE CASCADE,
  choice         text NOT NULL,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (poll_id, participant_id)
);

CREATE INDEX governance_poll_votes_poll_idx
  ON politicore.governance_poll_votes (poll_id, choice);
CREATE INDEX governance_poll_votes_participant_idx
  ON politicore.governance_poll_votes (participant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- REFERENCE MINTER — PL- prefix (polls; consultations use PT-, petitions
-- PP-). Tables are separate, so uniqueness domains never collide.
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.make_governance_poll_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'PL-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_polls WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_poll_reference
  BEFORE INSERT ON politicore.governance_polls
  FOR EACH ROW EXECUTE FUNCTION politicore.make_governance_poll_reference();

-- ─────────────────────────────────────────────────────────────────────────
-- IDENTITY GUARD — reference immutable; visibility flips only through the
-- authority RPC (GUC-gated, 0043/0045/0048/0051/0052 precedent).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.guard_governance_poll_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: poll reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: poll visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_poll_identity
  BEFORE UPDATE ON politicore.governance_polls
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_poll_identity();

-- ─────────────────────────────────────────────────────────────────────────
-- LIFECYCLE GUARD — server-enforced transitions (trigger mirrors the RPC
-- map; belt-and-braces). draft → open → closed. No reopen, no skipping,
-- no results_published state for polls (gate §130).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.guard_governance_poll_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'draft' AND NEW.status = 'open')
    OR (OLD.status = 'open'  AND NEW.status = 'closed')
  ) THEN
    RAISE EXCEPTION 'governance: illegal poll status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_poll_status
  BEFORE UPDATE OF status ON politicore.governance_polls
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_poll_status();

-- VOTE CHOICE GUARD — the choice must be one of the poll's own options
-- (belt-and-braces behind the RPC check; PostgreSQL forbids subqueries
-- in CHECK constraints, so this runs as a trigger on the direct path).
CREATE OR REPLACE FUNCTION politicore.guard_governance_poll_vote_choice()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        (SELECT options FROM politicore.governance_polls WHERE id = NEW.poll_id)) o
     WHERE o #>> '{}' = NEW.choice
  ) THEN
    RAISE EXCEPTION 'governance: vote choice is not a valid option for this poll';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_poll_vote_choice
  BEFORE INSERT ON politicore.governance_poll_votes
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_poll_vote_choice();

-- CONTENT FREEZE — options/question/title frozen once the poll leaves
-- draft (prompt §8 "fixed options" + §9 "content mutation after opening
-- must be frozen"). closes_at remains movable while open (the Phase 14/15
-- open-window precedent).
CREATE OR REPLACE FUNCTION politicore.guard_governance_poll_content()
RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.options IS DISTINCT FROM OLD.options
    OR NEW.question IS DISTINCT FROM OLD.question
    OR NEW.title    IS DISTINCT FROM OLD.title
  ) THEN
    RAISE EXCEPTION 'governance: poll content is only editable while draft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_poll_content
  BEFORE UPDATE ON politicore.governance_polls
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_poll_content();

-- ─────────────────────────────────────────────────────────────────────────
-- GEO AUTHORITY + ASSERT (Phase 14/15 pattern verbatim).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.has_poll_geo_authority(
  p_poll uuid
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politicore.governance_poll_scopes cs
     WHERE cs.poll_id = p_poll
       AND politicore.has_permission('manage_participation', cs.scope_type,
             COALESCE(cs.polling_unit_id, cs.ward_id, cs.lga_id, cs.zone_id, cs.state_id))
  )
  OR ( -- a tenant-wide grant covers any scope
    politicore.has_permission('manage_participation')
    AND EXISTS (SELECT 1 FROM politicore.governance_polls
                 WHERE id = p_poll AND tenant_id = politicore.current_tenant_id())
  );
$$ LANGUAGE sql STABLE SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.assert_poll_authority(
  p_poll uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_polls WHERE id = p_poll;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: poll not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_poll_geo_authority(p_poll)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;
  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- NOTIFICATION INTENTS (0036 best-effort pattern — NEVER fail the
-- business action; recipients resolved from the RECIPIENT dataset, not a
-- caller-relative predicate — the Phase 15 §24 lesson).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION politicore.governance_notify_poll_open(
  p_poll uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_ref text;
  v_scoped boolean;
BEGIN
  SELECT tenant_id, title, reference_code,
         EXISTS (SELECT 1 FROM politicore.governance_poll_scopes cs
                  WHERE cs.poll_id = p_poll
                    AND cs.scope_type IN ('lga', 'ward', 'polling_unit'))
    INTO v_tenant, v_title, v_ref, v_scoped
    FROM politicore.governance_polls WHERE id = p_poll;

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT v_tenant, p.id,
         'system',
         'A poll is open for your vote',
         v_title || ' (ref ' || v_ref || ') is open — cast your vote before it closes.',
         '/governance/participate',
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (NOT v_scoped OR EXISTS (
       SELECT 1 FROM politicore.governance_poll_scopes cs
        WHERE cs.poll_id = p_poll
          AND cs.scope_type IN ('lga', 'ward', 'polling_unit')
          AND (cs.lga_id = p.lga_id OR cs.ward_id = p.ward_id
               OR cs.polling_unit_id = p.polling_unit_id)));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance poll open notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs (SECURITY DEFINER; resolve caller+tenant+permission
-- server-side; audit in Core; never trust client authority fields).
-- ---------------------------------------------------------------------

-- CREATE. Server mints reference/tenant/created_by; options validated;
-- initial scopes validated against Core Geography and the CALLER's
-- authority for the scope being attached (Phase 12 bootstrap-correct
-- rule). Scope-scoped grantees must deliver ≥1 authorized scope (0049
-- rule).
CREATE OR REPLACE FUNCTION politicore.create_governance_poll(
  p_title text,
  p_question text,
  p_options jsonb,
  p_description text DEFAULT '',
  p_closes_at timestamptz DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_poll uuid;
  v_s jsonb;
  v_unscoped boolean;
  v_scope_count integer;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: title is required';
  END IF;
  IF p_question IS NULL OR length(btrim(p_question)) = 0 THEN
    RAISE EXCEPTION 'governance: question is required';
  END IF;
  IF p_options IS NULL OR jsonb_typeof(p_options) <> 'array'
     OR jsonb_array_length(p_options) < 2 OR jsonb_array_length(p_options) > 20 THEN
    RAISE EXCEPTION 'governance: a poll requires 2-20 options';
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

  INSERT INTO politicore.governance_polls
    (tenant_id, title, question, description, options, closes_at, created_by)
  VALUES
    (v_tenant, btrim(p_title), btrim(p_question), COALESCE(p_description,''),
     p_options, p_closes_at, v_caller)
  RETURNING id INTO v_poll;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes::jsonb) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_poll_scope(v_poll,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  IF NOT v_unscoped THEN
    SELECT count(*) INTO v_scope_count
      FROM politicore.governance_poll_scopes WHERE poll_id = v_poll;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'governance: manage_participation with a scope within your authority is required';
    END IF;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_poll:create',
          'governance_polls', v_poll::text,
          jsonb_build_object('title', p_title, 'status', 'draft',
                             'options', jsonb_array_length(p_options)));
  RETURN v_poll;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE (draft-only content; the open-window lever closes_at may move
-- while open). Option definitions are immutable once open (content
-- freeze trigger enforces belt-and-braces).
CREATE OR REPLACE FUNCTION politicore.update_governance_poll(
  p_poll uuid,
  p_title text DEFAULT NULL,
  p_question text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_options jsonb DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_clear_closes_at boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_poll_status;
BEGIN
  v_tenant := politicore.assert_poll_authority(p_poll);
  SELECT status INTO v_status FROM politicore.governance_polls WHERE id = p_poll;

  IF v_status <> 'draft'
     AND (p_title IS NOT NULL OR p_question IS NOT NULL
          OR p_options IS NOT NULL OR p_description IS NOT NULL) THEN
    RAISE EXCEPTION 'governance: poll content is only editable while draft';
  END IF;

  UPDATE politicore.governance_polls
     SET title        = COALESCE(p_title, title),
         question     = COALESCE(p_question, question),
         description  = COALESCE(p_description, description),
         options      = COALESCE(p_options, options),
         closes_at    = CASE WHEN p_clear_closes_at THEN NULL
                             ELSE COALESCE(p_closes_at, closes_at) END,
         updated_at   = now()
   WHERE id = p_poll;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_poll:update',
          'governance_polls', p_poll::text,
          jsonb_build_object('title', p_title, 'closes_at', p_closes_at));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STATUS — draft → open (fires the invitation intent) → closed. The
-- guard trigger is the second line of defense.
CREATE OR REPLACE FUNCTION politicore.set_governance_poll_status(
  p_poll uuid,
  p_status text
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old politicore.governance_poll_status;
BEGIN
  v_tenant := politicore.assert_poll_authority(p_poll);
  IF p_status::politicore.governance_poll_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'governance: status must be open or closed';
  END IF;
  SELECT status INTO v_old FROM politicore.governance_polls WHERE id = p_poll;

  UPDATE politicore.governance_polls
     SET status = p_status::politicore.governance_poll_status,
         updated_at = now()
   WHERE id = p_poll;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_poll:status',
          'governance_polls', p_poll::text,
          jsonb_build_object('status', v_old::text),
          jsonb_build_object('status', p_status));

  IF p_status = 'open' THEN
    PERFORM politicore.governance_notify_poll_open(p_poll, auth.uid());
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- RESULTS PUBLICATION — the audited publish_accountability act (gate §11
-- "results after close"; publication is explicit). The payload is
-- assembled by authorized staff from staff-only vote reads; the RPC
-- verifies authority + closed state. Polls have no results_published
-- status (gate §130) — publication records aggregates on a closed poll.
CREATE OR REPLACE FUNCTION politicore.publish_poll_results(
  p_poll uuid,
  p_summary text DEFAULT '',
  p_results jsonb DEFAULT '{}'::jsonb
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_poll_status;
BEGIN
  v_tenant := politicore.assert_poll_authority(p_poll);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to publish results';
  END IF;
  SELECT status INTO v_status FROM politicore.governance_polls WHERE id = p_poll;
  IF v_status <> 'closed' THEN
    RAISE EXCEPTION 'governance: results can only be published after closure';
  END IF;

  UPDATE politicore.governance_polls
     SET results = COALESCE(p_results, '{}'::jsonb),
         results_summary = COALESCE(p_summary, ''),
         updated_at = now()
   WHERE id = p_poll;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_poll:results_published',
          'governance_polls', p_poll::text,
          jsonb_build_object('status', v_status::text,
                             'summary_len', length(COALESCE(p_summary, ''))));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VISIBILITY — the Phase 11 taxonomy lever (opt-in Public gated by
-- publish_accountability; the public projection surface itself is Phase
-- 18 and is not built here).
CREATE OR REPLACE FUNCTION politicore.set_governance_poll_visibility(
  p_poll uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := politicore.assert_poll_authority(p_poll);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;

  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);
  UPDATE politicore.governance_polls
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN now() ELSE NULL END,
         updated_at = now()
   WHERE id = p_poll;
  PERFORM set_config('politicore.governance_authority', '', true);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_poll:visibility',
          'governance_polls', p_poll::text,
          jsonb_build_object('is_public', NOT p_is_public),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- SCOPE ATTACH — Core Geography validation + caller authority on the
-- scope BEING attached (bootstrap-correct). Draft-only (prompt §8:
-- options are fixed once open; scopes define the eligible audience —
-- same freeze discipline).
CREATE OR REPLACE FUNCTION politicore.add_governance_poll_scope(
  p_poll uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_poll_tenant uuid;
  v_status politicore.governance_poll_status;
  v_exists boolean;
  v_scope uuid;
  v_scope_id text;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance polls';
  END IF;

  SELECT tenant_id, status INTO v_poll_tenant, v_status
    FROM politicore.governance_polls WHERE id = p_poll;
  IF v_poll_tenant IS NULL OR v_poll_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: poll not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'governance: poll scopes are only editable while draft';
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

  INSERT INTO politicore.governance_poll_scopes
    (tenant_id, poll_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id, created_by)
  VALUES (v_poll_tenant, p_poll, p_scope_type,
          p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id, auth.uid())
  ON CONFLICT (poll_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  DO UPDATE SET polling_unit_id = EXCLUDED.polling_unit_id
  RETURNING id INTO v_scope;

  RETURN v_scope;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_poll_scope(
  p_scope uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_poll uuid;
  v_status politicore.governance_poll_status;
BEGIN
  SELECT ps.tenant_id, ps.poll_id INTO v_tenant, v_poll
    FROM politicore.governance_poll_scopes ps WHERE ps.id = p_scope;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: poll scope not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_poll_geo_authority(v_poll)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;
  SELECT status INTO v_status FROM politicore.governance_polls WHERE id = v_poll;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'governance: poll scopes are only editable while draft';
  END IF;

  DELETE FROM politicore.governance_poll_scopes WHERE id = p_scope
    RETURNING poll_id INTO v_poll;
  RETURN v_poll;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VOTE. Server resolves participant from Core Identity (on-demand
-- participant row, 0034 precedent); validates poll ownership, open
-- window (status + closes_at server-side), option membership (the
-- choice must be one of the POLL's own options); one vote per
-- participant via UNIQUE(poll_id, participant_id). Append-only — no
-- edit/withdraw path exists anywhere.
CREATE OR REPLACE FUNCTION politicore.vote_governance_poll(
  p_poll uuid,
  p_choice text
) RETURNS uuid AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_tenant uuid;
  v_id uuid;
  v_status politicore.governance_poll_status;
  v_closes_at timestamptz;
BEGIN
  IF p_choice IS NULL OR length(btrim(p_choice)) = 0 THEN
    RAISE EXCEPTION 'governance: a choice is required';
  END IF;
  IF length(p_choice) > 200 THEN
    RAISE EXCEPTION 'governance: choice exceeds the maximum length';
  END IF;

  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  SELECT status, closes_at INTO v_status, v_closes_at
    FROM politicore.governance_polls
   WHERE id = p_poll AND tenant_id = v_tenant;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'governance: poll not found';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'governance: poll is not open for participation';
  END IF;
  IF v_closes_at IS NOT NULL AND now() > v_closes_at THEN
    RAISE EXCEPTION 'governance: poll is not open for participation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements((SELECT options FROM politicore.governance_polls WHERE id = p_poll)) o
     WHERE o #>> '{}' = p_choice
  ) THEN
    RAISE EXCEPTION 'governance: choice is not a valid option for this poll';
  END IF;

  -- Participant resolution: the caller's tenant participant row, created
  -- on demand from Core Identity; never client-supplied.
  INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name, email)
  SELECT v_tenant, v_caller, p.full_name, p.email
    FROM politicore.profiles p
   WHERE p.id = v_caller
  ON CONFLICT DO NOTHING;

  BEGIN
    INSERT INTO politicore.governance_poll_votes
      (tenant_id, poll_id, participant_id, choice)
    SELECT v_tenant, p_poll, gp.id, btrim(p_choice)
      FROM politicore.governance_participants gp
     WHERE gp.profile_id = v_caller
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'governance: you have already voted in this poll';
  END;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_poll:vote',
          'governance_poll_votes', v_id::text,
          jsonb_build_object('poll', p_poll, 'choice', p_choice));

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- FORCE RLS + POLICIES — read surfaces only; every mutation flows through
-- the authority RPCs (no INSERT/UPDATE/DELETE policies = writes fail
-- closed by RLS, institutional memory holds).
-- --------------------------------------------------------------------- */
ALTER TABLE politicore.governance_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_polls FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_poll_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_poll_scopes FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_poll_votes FORCE  ROW LEVEL SECURITY;

-- Polls: staff-wide within the tenant; OPEN polls are discoverable by
-- any member (participation requires discovery; prompt §13 — eligible
-- participants must be able to see the poll).
CREATE POLICY governance_polls_read ON politicore.governance_polls
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance')
         OR status = 'open')
  );

-- Scopes: staff-only (management/reporting surface).
CREATE POLICY governance_poll_scopes_read ON politicore.governance_poll_scopes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Votes: staff-wide within the tenant PLUS the voter's own row. Ballot
-- secrecy within the tenant: an ordinary member (no view_governance) can
-- never read another member's vote — only their own (prompt §10: results
-- must distinguish collected responses from published aggregates; §11:
-- no individual respondent exposure). Aggregate publication is explicit.
CREATE POLICY governance_poll_votes_read ON politicore.governance_poll_votes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_governance')
      OR EXISTS (SELECT 1 FROM politicore.governance_participants gp
                  WHERE gp.id = governance_poll_votes.participant_id
                    AND gp.profile_id = auth.uid())
    )
  );

-- Canonical audit triggers on every new table (Core system_audits).
CREATE TRIGGER trg_audit_governance_polls
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_polls
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_poll_scopes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_poll_scopes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_poll_votes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_poll_votes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API SURFACE — the 0047/0048/0051/0052 convention: thin
-- security_invoker views (zero authorization of their own — base-table
-- FORCE RLS remains the only boundary), mirrored grants, explicit
-- anon/PUBLIC revokes, and public RPC wrappers for the mutating RPCs
-- (text-overload convention, PostgREST-safe). NO anonymous surface:
-- anon holds NOTHING on polls (Phase 11 §29 open decision 1 is
-- unresolved and this migration invents no dedup mechanism).
-- --------------------------------------------------------------------- */
CREATE OR REPLACE VIEW public.governance_polls
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_polls;
CREATE OR REPLACE VIEW public.governance_poll_scopes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_poll_scopes;
CREATE OR REPLACE VIEW public.governance_poll_votes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_poll_votes;

GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_polls       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_poll_scopes TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_poll_votes  TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_polls       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_poll_scopes TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_poll_votes  TO authenticated, service_role;

REVOKE ALL ON public.governance_polls       FROM anon;
REVOKE ALL ON public.governance_poll_scopes FROM anon;
REVOKE ALL ON public.governance_poll_votes  FROM anon;
REVOKE ALL ON public.governance_polls       FROM PUBLIC;
REVOKE ALL ON public.governance_poll_scopes FROM PUBLIC;
REVOKE ALL ON public.governance_poll_votes  FROM PUBLIC;

-- PUBLIC RPC WRAPPERS (text-overload convention; delegate verbatim).
CREATE OR REPLACE FUNCTION public.create_governance_poll(
  p_title text,
  p_question text,
  p_options jsonb,
  p_description text DEFAULT '',
  p_closes_at timestamptz DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
  SELECT politicore.create_governance_poll(
    p_title, p_question, p_options, p_description, p_closes_at, p_scopes);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_governance_poll(
  p_poll uuid,
  p_title text DEFAULT NULL,
  p_question text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_options jsonb DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_clear_closes_at boolean DEFAULT false
) RETURNS void AS $$
  SELECT politicore.update_governance_poll(
    p_poll, p_title, p_question, p_description, p_options, p_closes_at, p_clear_closes_at);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_poll_status(
  p_poll uuid,
  p_status text
) RETURNS void AS $$
  SELECT politicore.set_governance_poll_status(p_poll, p_status);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.publish_poll_results(
  p_poll uuid,
  p_summary text DEFAULT '',
  p_results jsonb DEFAULT '{}'::jsonb
) RETURNS void AS $$
  SELECT politicore.publish_poll_results(p_poll, p_summary, p_results);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_poll_visibility(
  p_poll uuid,
  p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_poll_visibility(p_poll, p_is_public);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.add_governance_poll_scope(
  p_poll uuid,
  p_scope_type text,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.add_governance_poll_scope(
    p_poll, p_scope_type::politicore.scope_type_enum,
    p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.remove_governance_poll_scope(
  p_scope uuid
) RETURNS void AS $$
  SELECT politicore.remove_governance_poll_scope(p_scope);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.vote_governance_poll(
  p_poll uuid,
  p_choice text
) RETURNS uuid AS $$
  SELECT politicore.vote_governance_poll(p_poll, p_choice);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

-- EXECUTE hygiene (Phase 12–15 pattern): politicore.* reachable only by
-- authenticated (+ service_role via BYPASSRLS); anon holds nothing.
GRANT EXECUTE ON FUNCTION politicore.create_governance_poll(text,text,jsonb,text,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.update_governance_poll(uuid,text,text,text,jsonb,timestamptz,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.set_governance_poll_status(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.publish_poll_results(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.set_governance_poll_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.add_governance_poll_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.remove_governance_poll_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.vote_governance_poll(uuid,text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_governance_poll(text,text,jsonb,text,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_governance_poll(uuid,text,text,text,jsonb,timestamptz,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_poll_status(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_poll_results(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_poll_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_governance_poll_scope(uuid,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_governance_poll_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.vote_governance_poll(uuid,text) TO authenticated;

REVOKE ALL ON FUNCTION politicore.create_governance_poll(text,text,jsonb,text,timestamptz,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.update_governance_poll(uuid,text,text,text,jsonb,timestamptz,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.set_governance_poll_status(uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.publish_poll_results(uuid,text,jsonb) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.set_governance_poll_visibility(uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.add_governance_poll_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.remove_governance_poll_scope(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.vote_governance_poll(uuid,text) FROM anon, PUBLIC;

REVOKE ALL ON FUNCTION public.create_governance_poll(text,text,jsonb,text,timestamptz,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.update_governance_poll(uuid,text,text,text,jsonb,timestamptz,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.set_governance_poll_status(uuid,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.publish_poll_results(uuid,text,jsonb) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.set_governance_poll_visibility(uuid,boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.add_governance_poll_scope(uuid,text,text,text,text,text,text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.remove_governance_poll_scope(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.vote_governance_poll(uuid,text) FROM anon, PUBLIC;

COMMIT;
