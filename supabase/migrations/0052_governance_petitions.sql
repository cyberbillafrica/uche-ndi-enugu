-- =====================================================================
-- POLITICORE — MIGRATION 0052: GOVERNANCE PETITIONS & COMMUNITY PROPOSALS (P15)
-- =====================================================================
-- Second Participation instrument, per the Phase 11 architecture gate
-- (docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md §9):
--
--   * politicore.governance_petitions          ONE canonical table, origin
--                                              discriminator petition |
--                                              community_proposal (§9)
--   * politicore.governance_petition_supports  one signature per participant
--                                              per petition — UNIQUE
--                                              (petition_id, participant_id)
--                                              (§9: "One signature per
--                                              participant per petition")
--   * lifecycle draft|pending → open → closed → verified →
--     results_published (§4/§9 — signature verification BEFORE results;
--     participant-originated intake enters pending → open moderation)
--   * politicore.governance_updates gains petition_id; the single-subject
--     invariant is RESTATED (project | commitment | consultation | petition)
--   * petitions have a reference code with the PP- prefix
--   * NO new permissions, NO new roles: Phase 11 §16 already places
--     petitions under 'manage_participation' ("create/run consultations,
--     surveys, polls, petitions, engagements")
--
-- Security posture (identical to Phases 12–14):
--   * FORCE RLS, zero anonymous policies, server-resolved tenant/actor
--   * mutations only via SECURITY DEFINER authority RPCs
--   * participation needs NO permission — participant identity is the
--     authorization (0034 principle)
--   * verification-before-results enforced server-side (RPC + trigger):
--     results_published is reachable ONLY through publish_petition_results,
--     which requires the verified status; raw support counts are never an
--     authoritative result (§10 of prompt)
--   * no OTP/email/external verification mechanics — verification is the
--     existing staff authority act; Phase 11 §9 delegates sampling/volume
--     mechanics to the implementation gate, and the smallest complete model
--     records per-signature verification state without inventing providers
--   * external contact-verified participation stays deferred (Phase 11 §29
--     open decision 2); anonymous participation NOT implemented (open
--     decision 1 is bounded to Polls)
--   * no withdrawal/edit of signatures (not documented in Phase 11 §9)
--   * the petition→request link is deferred (moderation + verification
--     first; a future gate authorizes it with its own authority rules)
--   * support counts are staff-visible; opt-in public projection (title,
--     demand, support count, status) rides is_public — the public
--     projection SURFACE itself is Phase 18 and is not built here
-- ---------------------------------------------------------------------

-- ─────────────────────────────────────────────────────────────────────────
-- ENUMS — origin + lifecycle (gate §4/§9 exact states + pending intake)
-- ---------------------------------------------------------------------
CREATE TYPE politicore.governance_petition_origin AS ENUM (
  'petition', 'community_proposal'
);

CREATE TYPE politicore.governance_petition_status AS ENUM (
  'draft',      -- staff-created, pre-publication
  'pending',    -- participant-originated, awaiting staff moderation (§4)
  'open',       -- published for signature
  'closed',     -- signature collection ended (manual or closes_at)
  'verified',   -- staff verification completed (verification-before-results)
  'results_published'
);

-- ─────────────────────────────────────────────────────────────────────────
-- PETITIONS — one canonical table, origin discriminator (gate §9 columns:
-- title, demand text, origin, proposer, target/threshold, lifecycle)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_petitions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  origin         politicore.governance_petition_origin NOT NULL DEFAULT 'petition',
  reference_code text NOT NULL UNIQUE,
  title          text NOT NULL,
  demand         text NOT NULL DEFAULT '',
  -- participant-originated intake: the proposer is a Governance participant
  -- (server-resolved; NULL for staff-created instruments)
  proposer_participant_id uuid REFERENCES politicore.governance_participants(id),
  created_by     uuid REFERENCES politicore.profiles(id),
  target_signatures integer CHECK (target_signatures IS NULL OR target_signatures > 0),
  status         politicore.governance_petition_status NOT NULL DEFAULT 'draft',
  closes_at      timestamptz,
  verified_count integer CHECK (verified_count IS NULL OR verified_count >= 0),
  verified_at    timestamptz,
  results        jsonb CHECK (results IS NULL OR jsonb_typeof(results) = 'object'),
  results_summary text NOT NULL DEFAULT '',
  is_public      boolean NOT NULL DEFAULT false,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- verification-before-results (gate §9/§10): the authoritative result
  -- requires BOTH the verified state and an explicit publication act;
  -- the verified snapshot is immutable once written (no UPDATE policy).
  CONSTRAINT governance_petitions_results_require_verified CHECK (
    results IS NULL OR (status = 'results_published' AND verified_at IS NOT NULL)
  ),
  CONSTRAINT governance_petitions_verified_snapshot CHECK (
    (verified_at IS NULL) = (verified_count IS NULL)
  ),
  -- moderation intake invariant: a participant-originated instrument has a
  -- proposer; staff-created instruments have a staff creator
  CONSTRAINT governance_petitions_origin_proposer CHECK (
    (origin = 'community_proposal') = (proposer_participant_id IS NOT NULL)
  )
);

CREATE INDEX governance_petitions_tenant_idx
  ON politicore.governance_petitions (tenant_id, created_at DESC);
CREATE INDEX governance_petitions_status_idx
  ON politicore.governance_petitions (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────
-- SUPPORTS — one signature per participant per petition (gate §9 UNIQUE).
-- Append-only: no UPDATE policy exists, and verification state rides the
-- row (verified_at set only by the authority RPC inside its own transaction
-- with the petition's verified snapshot).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_petition_supports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  petition_id   uuid NOT NULL REFERENCES politicore.governance_petitions(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES politicore.governance_participants(id),
  comment       text NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (petition_id, participant_id)
);

CREATE INDEX governance_petition_supports_petition_idx
  ON politicore.governance_petition_supports (petition_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- GEOGRAPHIC SCOPES — Phase 12/14 scope pattern verbatim (Core Geography;
-- campaign structurally forbidden; shape-checked per level).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_petition_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  petition_id     uuid NOT NULL REFERENCES politicore.governance_petitions(id) ON DELETE CASCADE,
  scope_type      politicore.scope_type_enum NOT NULL
                    CHECK (scope_type <> 'campaign'),
  state_id        text,
  zone_id         text,
  lga_id          text,
  ward_id         text,
  polling_unit_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES politicore.profiles(id),
  CONSTRAINT governance_petition_scope_shape CHECK (
    (scope_type = 'state' AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'lga' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'ward' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
    OR (scope_type = 'polling_unit' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
  ),
  UNIQUE (petition_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
);

CREATE INDEX governance_petition_scopes_petition_idx
  ON politicore.governance_petition_scopes (petition_id);

-- ─────────────────────────────────────────────────────────────────────────
-- CANONICAL UPDATES — petition becomes the FOURTH update subject (gate §11
-- ERD: governance_updates ──< exactly one of {project, commitment, request,
-- consultation, petition, engagement}). The single-subject invariant is
-- restated over the four implemented subjects; project/commitment/
-- consultation behavior is untouched. No petition update RPC ships in this
-- slice — no Phase 15 workflow emits delivery-narrative updates; the
-- substrate is ready for a later gate that justifies one.
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_updates
  ADD COLUMN petition_id uuid REFERENCES politicore.governance_petitions(id) ON DELETE CASCADE;

ALTER TABLE politicore.governance_updates
  DROP CONSTRAINT governance_updates_single_subject;

ALTER TABLE politicore.governance_updates
  ADD CONSTRAINT governance_updates_single_subject CHECK (
    (COALESCE(project_id IS NOT NULL, false)::int
     + COALESCE(commitment_id IS NOT NULL, false)::int
     + COALESCE(consultation_id IS NOT NULL, false)::int
     + COALESCE(petition_id IS NOT NULL, false)::int) = 1
  );

CREATE INDEX governance_updates_petition_idx
  ON politicore.governance_updates (petition_id)
  WHERE petition_id IS NOT NULL;

-- The 0048 public.governance_updates view expanded SELECT * before this
-- column existed — re-expand so the data API tracks the canonical table.
CREATE OR REPLACE VIEW public.governance_updates
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_updates;

-- ─────────────────────────────────────────────────────────────────────────
-- REFERENCE GENERATOR — PP- prefix + 8 uppercase hex (0050-correct shape:
-- assign AFTER the uniqueness loop, never inside it).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.make_governance_petition_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'PP-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_petitions WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_petition_reference
  BEFORE INSERT ON politicore.governance_petitions
  FOR EACH ROW EXECUTE FUNCTION politicore.make_governance_petition_reference();

-- ─────────────────────────────────────────────────────────────────────────
-- IDENTITY GUARD — reference immutable; visibility flips only through the
-- authority RPC (GUC-gated, 0043/0045/0048/0051 precedent).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_petition_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: petition reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: petition visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_petition_identity
  BEFORE UPDATE ON politicore.governance_petitions
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_petition_identity();

-- ─────────────────────────────────────────────────────────────────────────
-- STATUS TRANSITION GUARD — the documented state machine (gate §9), belt
-- and braces behind the RPC map; terminal records retained (no DELETE).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_governance_petition_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'draft'    AND NEW.status = 'open')
    OR (OLD.status = 'pending'  AND NEW.status = 'open')    -- moderation approval (§4)
    OR (OLD.status = 'open'     AND NEW.status = 'closed')
    OR (OLD.status = 'closed'   AND NEW.status = 'verified')
    OR (OLD.status = 'verified' AND NEW.status = 'results_published')
  ) THEN
    RAISE EXCEPTION 'governance: illegal petition status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_governance_petition_status
  BEFORE UPDATE ON politicore.governance_petitions
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_petition_status();

-- ─────────────────────────────────────────────────────────────────────────
-- QUESTION-FREE INSTRUMENT — no question validation needed; petitions carry
-- demand text only. Authority helpers mirror 0051 exactly.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.has_petition_geo_authority(
  p_petition uuid
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM politicore.governance_petition_scopes ps
     WHERE ps.petition_id = p_petition
       AND politicore.has_permission('manage_participation', ps.scope_type,
             COALESCE(ps.polling_unit_id, ps.ward_id, ps.lga_id, ps.zone_id, ps.state_id))
  )
  OR ( -- a tenant-wide grant covers any scope
    politicore.has_permission('manage_participation')
    AND EXISTS (SELECT 1 FROM politicore.governance_petitions
                 WHERE id = p_petition AND tenant_id = politicore.current_tenant_id())
  );
$$ LANGUAGE sql STABLE SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.assert_petition_authority(
  p_petition uuid
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_petitions WHERE id = p_petition;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: petition not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_petition_geo_authority(p_petition)) THEN
    RAISE EXCEPTION 'governance: manage_participation with geographic authority required';
  END IF;
  RETURN v_tenant;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- NOTIFICATION INTENTS (0036/0051 best-effort pattern — NEVER fail the
-- business action; recipients resolved server-side).
-- ---------------------------------------------------------------------
-- Open fanout: same shape as 0051 — tenant-wide for unscoped instruments,
-- ward/LGA/PU members for geo-targeted ones.
CREATE OR REPLACE FUNCTION politicore.governance_notify_petition_open(
  p_petition uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_ref text;
  v_scoped boolean;
BEGIN
  SELECT tenant_id, title, reference_code,
         EXISTS (SELECT 1 FROM politicore.governance_petition_scopes ps
                  WHERE ps.petition_id = p_petition
                    AND ps.scope_type IN ('lga', 'ward', 'polling_unit'))
    INTO v_tenant, v_title, v_ref, v_scoped
    FROM politicore.governance_petitions WHERE id = p_petition;

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT v_tenant, p.id, 'system',
         'A petition is open for signatures',
         v_title || ' (ref ' || v_ref || ') is open — add your signature before it closes.',
         '/governance/participate',
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (NOT v_scoped OR EXISTS (
       SELECT 1 FROM politicore.governance_petition_scopes ps
        WHERE ps.petition_id = p_petition
          AND ps.scope_type IN ('lga', 'ward', 'polling_unit')
          AND (ps.lga_id = p.lga_id OR ps.ward_id = p.ward_id
               OR ps.polling_unit_id = p.polling_unit_id)));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance petition open notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Moderation notice to staff when a participant-originated proposal lands.
CREATE OR REPLACE FUNCTION politicore.governance_notify_petition_submitted(
  p_petition uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_ref text;
BEGIN
  SELECT tenant_id, title, reference_code
    INTO v_tenant, v_title, v_ref
    FROM politicore.governance_petitions WHERE id = p_petition;

  -- Recipients are DATA-DRIVEN (tenant admins + manage_participation
  -- grantees): a caller-relative has_permission() predicate would evaluate
  -- the SUBMITTER's authority (usually none, by design) and drop every
  -- notice. Converged in 0054.
  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT DISTINCT v_tenant, p.id, 'system',
         'Community proposal awaiting review',
         '"' || v_title || '" (ref ' || v_ref || ') was submitted and awaits moderation.',
         '/portal/governance/participation/' || p_petition::text,
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (
       p.access_role = 'admin'
       OR EXISTS (
         SELECT 1 FROM politicore.permission_grants g
          WHERE g.user_id = p.id
            AND g.permission = 'manage_participation'
            AND g.granted = true
       )
     );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance petition moderation notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs (SECURITY DEFINER; resolve caller+tenant+permission
-- server-side; audit in Core; never trust client authority fields).
-- ---------------------------------------------------------------------

-- CREATE — staff-created (draft) or participant-originated (pending).
-- Permission posture mirrors 0051: tenant-wide holders OR any
-- manage_participation grantee; scope-scoped grantees must deliver ≥ 1
-- scope within their authority (bootstrap rule, 0049/0051).
CREATE OR REPLACE FUNCTION politicore.create_governance_petition(
  p_origin text,
  p_title text,
  p_demand text DEFAULT '',
  p_target_signatures integer DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_petition uuid;
  v_s jsonb;
  v_origin politicore.governance_petition_origin;
  v_participant uuid;
  v_unscoped boolean;
  v_scope_count integer;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: title is required';
  END IF;
  v_origin := p_origin::politicore.governance_petition_origin;

  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  -- Participant-originated intake (community proposal): ANY member may
  -- propose — the moderation state (pending) is the control, not a
  -- permission (gate §4: participant-originated enters pending → open).
  -- Staff-created petitions require manage_participation (tenant-wide OR
  -- any grantee; scope-scoped grantees constrained below).
  IF v_origin = 'community_proposal' THEN
    -- Participant resolution: the caller's tenant participant row, created
    -- on demand from Core Identity (0034 self-registration precedent;
    -- never client-supplied).
    INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name, email)
    SELECT v_tenant, v_caller, p.full_name, p.email
      FROM politicore.profiles p
     WHERE p.id = v_caller
    ON CONFLICT DO NOTHING;
    SELECT gp.id INTO v_participant
      FROM politicore.governance_participants gp
     WHERE gp.profile_id = v_caller;
  ELSE
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
  END IF;

  INSERT INTO politicore.governance_petitions
    (tenant_id, origin, title, demand, proposer_participant_id, created_by,
     target_signatures, closes_at, status)
  VALUES
    (v_tenant, v_origin, btrim(p_title), COALESCE(p_demand,''),
     v_participant, v_caller, p_target_signatures, p_closes_at,
     CASE WHEN v_origin = 'community_proposal' THEN 'pending'::politicore.governance_petition_status
          ELSE 'draft'::politicore.governance_petition_status END)
  RETURNING id INTO v_petition;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes::jsonb) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_petition_scope(v_petition,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  -- A scope-scoped grantee MUST deliver at least one scope within their
  -- authority (otherwise they would mint a tenant-wide petition). The
  -- RAISE aborts the transaction: no orphan petition survives.
  IF v_origin = 'petition' AND NOT v_unscoped THEN
    SELECT count(*) INTO v_scope_count
      FROM politicore.governance_petition_scopes WHERE petition_id = v_petition;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'governance: manage_participation with a scope within your authority is required';
    END IF;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_petition:create',
          'governance_petitions', v_petition::text,
          jsonb_build_object('title', p_title, 'origin', v_origin::text));

  IF v_origin = 'community_proposal' THEN
    PERFORM politicore.governance_notify_petition_submitted(v_petition, v_caller);
  END IF;

  RETURN v_petition;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- UPDATE — content is editable while draft OR pending (moderation may
-- correct a proposal before opening); closes_at stays adjustable until
-- closed (0051 semantics).
CREATE OR REPLACE FUNCTION politicore.update_governance_petition(
  p_petition uuid,
  p_title text DEFAULT NULL,
  p_demand text DEFAULT NULL,
  p_target_signatures integer DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL,
  p_clear_closes_at boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_petition_status;
BEGIN
  v_tenant := politicore.assert_petition_authority(p_petition);
  SELECT status INTO v_status FROM politicore.governance_petitions WHERE id = p_petition;

  IF v_status NOT IN ('draft', 'pending') THEN
    IF (p_title IS NOT NULL OR p_demand IS NOT NULL OR p_target_signatures IS NOT NULL) THEN
      RAISE EXCEPTION 'governance: petition content is only editable before opening';
    END IF;
  END IF;

  UPDATE politicore.governance_petitions
     SET title              = COALESCE(p_title, title),
         demand             = COALESCE(p_demand, demand),
         target_signatures  = COALESCE(p_target_signatures, target_signatures),
         closes_at          = CASE WHEN p_clear_closes_at THEN NULL
                                    ELSE COALESCE(p_closes_at, closes_at) END,
         updated_at         = now()
   WHERE id = p_petition;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_petition:update',
          'governance_petitions', p_petition::text,
          jsonb_build_object('title', p_title, 'closes_at', p_closes_at));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- STATUS — draft|pending → open (fires the invitation intent) → closed.
-- verified is NOT reachable here and results_published is NOT reachable
-- here: verification and publication are separate, gated acts (below).
CREATE OR REPLACE FUNCTION politicore.set_governance_petition_status(
  p_petition uuid,
  p_status text
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old politicore.governance_petition_status;
BEGIN
  v_tenant := politicore.assert_petition_authority(p_petition);
  IF p_status::politicore.governance_petition_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'governance: status must be open or closed';
  END IF;
  SELECT status INTO v_old FROM politicore.governance_petitions WHERE id = p_petition;

  UPDATE politicore.governance_petitions
     SET status = p_status::politicore.governance_petition_status,
         updated_at = now()
   WHERE id = p_petition;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_petition:status',
          'governance_petitions', p_petition::text,
          jsonb_build_object('status', v_old::text),
          jsonb_build_object('status', p_status));

  IF p_status = 'open' THEN
    PERFORM politicore.governance_notify_petition_open(p_petition, auth.uid());
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VERIFY — the Phase 15 verification act (verification-before-results):
-- staff re-affirm signatures; the petition snapshots the verified count
-- and moves closed → verified. Threshold semantics stay advisory: the
-- architecture makes threshold optional and delegates volume rules here;
-- the smallest complete model requires NO minimum (staff judgment is the
-- authority) but records what was verified. Requires the petition to be
-- closed first (the transition map forbids open → verified).
CREATE OR REPLACE FUNCTION politicore.verify_governance_petition(
  p_petition uuid,
  p_note text DEFAULT ''
) RETURNS integer AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_petition_status;
  v_verified integer;
BEGIN
  v_tenant := politicore.assert_petition_authority(p_petition);
  SELECT status INTO v_status FROM politicore.governance_petitions WHERE id = p_petition;
  IF v_status <> 'closed' THEN
    RAISE EXCEPTION 'governance: petitions can only be verified after closure';
  END IF;

  -- Per-signature verification: signatures verified in this transaction
  -- are stamped; the petition snapshots the count (immutable afterwards —
  -- no UPDATE policy touches supports rows except this stamp).
  UPDATE politicore.governance_petition_supports
     SET verified_at = now()
   WHERE petition_id = p_petition AND verified_at IS NULL;

  SELECT count(*) INTO v_verified
    FROM politicore.governance_petition_supports
   WHERE petition_id = p_petition AND verified_at IS NOT NULL;

  UPDATE politicore.governance_petitions
     SET status = 'verified',
         verified_count = v_verified,
         verified_at = now(),
         updated_at = now()
   WHERE id = p_petition;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_petition:verified',
          'governance_petitions', p_petition::text,
          jsonb_build_object('status', v_status::text),
          jsonb_build_object('status', 'verified',
                             'verified_count', v_verified,
                             'note', p_note));
  RETURN v_verified;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- RESULTS — the audited publish_accountability act, gated on VERIFIED
-- (verification-before-results is structural: the state machine forbids
-- closed → results_published, and this RPC additionally checks the
-- verified snapshot exists).
CREATE OR REPLACE FUNCTION politicore.publish_petition_results(
  p_petition uuid,
  p_summary text DEFAULT '',
  p_results jsonb DEFAULT '{}'::jsonb
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_petition_status;
  v_verified_at timestamptz;
BEGIN
  v_tenant := politicore.assert_petition_authority(p_petition);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to publish results';
  END IF;
  SELECT status, verified_at INTO v_status, v_verified_at
    FROM politicore.governance_petitions WHERE id = p_petition;
  IF v_status <> 'verified' OR v_verified_at IS NULL THEN
    RAISE EXCEPTION 'governance: results can only be published after verification';
  END IF;

  UPDATE politicore.governance_petitions
     SET results = COALESCE(p_results, '{}'::jsonb),
         results_summary = COALESCE(p_summary, ''),
         status = 'results_published',
         updated_at = now()
   WHERE id = p_petition;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_petition:results_published',
          'governance_petitions', p_petition::text,
          jsonb_build_object('status', v_status::text),
          jsonb_build_object('status', 'results_published',
                             'summary_len', length(COALESCE(p_summary, ''))));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- VISIBILITY — the Phase 11 taxonomy lever (opt-in Public gated by
-- publish_accountability across ALL governance objects; the public
-- projection surface itself is Phase 18 and is not built here).
CREATE OR REPLACE FUNCTION politicore.set_governance_petition_visibility(
  p_petition uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_old boolean;
BEGIN
  v_tenant := politicore.assert_petition_authority(p_petition);
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('publish_accountability')) THEN
    RAISE EXCEPTION 'governance: publish_accountability required to change visibility';
  END IF;
  SELECT is_public INTO v_old FROM politicore.governance_petitions WHERE id = p_petition;

  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);

  UPDATE politicore.governance_petitions
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN COALESCE(published_at, now()) ELSE NULL END
   WHERE id = p_petition;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_petition:visibility',
          'governance_petitions', p_petition::text,
          jsonb_build_object('is_public', v_old),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- GEOGRAPHIC SCOPES (validated against Core Geography + caller authority
-- for THE SCOPE BEING ATTACHED — the Phase 12 bootstrap-correct rule).
CREATE OR REPLACE FUNCTION politicore.add_governance_petition_scope(
  p_petition uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_petition_tenant uuid;
  v_exists boolean;
  v_scope uuid;
  v_scope_id text;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance petitions';
  END IF;

  SELECT tenant_id INTO v_petition_tenant
    FROM politicore.governance_petitions WHERE id = p_petition;
  IF v_petition_tenant IS NULL OR v_petition_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: petition not found';
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

  INSERT INTO politicore.governance_petition_scopes
    (tenant_id, petition_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id, created_by)
  VALUES (v_petition_tenant, p_petition, p_scope_type,
          p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id, auth.uid())
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_scope;

  RETURN v_scope;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.remove_governance_petition_scope(
  p_scope uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_petition uuid;
  v_scope_type politicore.scope_type_enum;
  v_scope_id text;
BEGIN
  SELECT ps.petition_id, ps.scope_type,
         COALESCE(ps.polling_unit_id, ps.ward_id, ps.lga_id, ps.zone_id, ps.state_id)
    INTO v_petition, v_scope_type, v_scope_id
    FROM politicore.governance_petition_scopes ps
   WHERE ps.id = p_scope
     AND ps.tenant_id = politicore.current_tenant_id();
  IF v_petition IS NULL THEN
    RAISE EXCEPTION 'governance: scope not found';
  END IF;
  v_tenant := politicore.assert_petition_authority(v_petition);
  IF NOT (politicore.is_tenant_admin()
          OR politicore.has_permission('manage_participation', v_scope_type, v_scope_id)) THEN
    RAISE EXCEPTION 'governance: caller may not remove a scope outside their authority';
  END IF;

  DELETE FROM politicore.governance_petition_scopes WHERE id = p_scope;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value)
  VALUES (v_tenant, auth.uid(), 'governance_petition:scope_removed',
          'governance_petition_scopes', p_scope::text,
          jsonb_build_object('petition', v_petition, 'scope_type', v_scope_type::text,
                             'scope_id', v_scope_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- SIGN — participant identity IS the authorization (0034 principle).
-- Server-side eligibility: open instrument, closes_at honored, duplicate
-- prevented by UNIQUE + explicit message.
CREATE OR REPLACE FUNCTION politicore.sign_governance_petition(
  p_petition uuid,
  p_comment text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_tenant uuid;
  v_id uuid;
  v_status politicore.governance_petition_status;
  v_closes_at timestamptz;
BEGIN
  IF p_comment IS NOT NULL AND length(p_comment) > 2000 THEN
    RAISE EXCEPTION 'governance: comment exceeds the maximum length';
  END IF;

  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  SELECT status, closes_at INTO v_status, v_closes_at
    FROM politicore.governance_petitions
   WHERE id = p_petition AND tenant_id = v_tenant;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'governance: petition not found';
  END IF;
  IF v_status <> 'open' THEN
    RAISE EXCEPTION 'governance: petition is not open for signatures';
  END IF;
  IF v_closes_at IS NOT NULL AND now() > v_closes_at THEN
    RAISE EXCEPTION 'governance: petition is not open for signatures';
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
    INSERT INTO politicore.governance_petition_supports
      (tenant_id, petition_id, participant_id, comment)
    SELECT v_tenant, p_petition, gp.id, COALESCE(p_comment, '')
      FROM politicore.governance_participants gp
     WHERE gp.profile_id = v_caller
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'governance: you have already signed this petition';
  END;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_petition:sign',
          'governance_petition_supports', v_id::text,
          jsonb_build_object('petition', p_petition));

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- FORCE RLS + POLICIES — read surfaces only; every mutation flows through
-- the authority RPCs (no INSERT/UPDATE/DELETE policies = writes fail
-- closed by RLS, institutional memory holds).
-- ---------------------------------------------------------------------
ALTER TABLE politicore.governance_petitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_petitions FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_petition_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_petition_scopes FORCE  ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_petition_supports ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_petition_supports FORCE  ROW LEVEL SECURITY;

-- Petitions: staff-wide within the tenant; OPEN (and, for their own
-- proposal, PENDING-originating participants) instruments are discoverable
-- by members.
CREATE POLICY governance_petitions_read ON politicore.governance_petitions
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_governance')
      OR status = 'open'
      OR EXISTS (SELECT 1 FROM politicore.governance_participants gp
                  WHERE gp.id = governance_petitions.proposer_participant_id
                    AND gp.profile_id = auth.uid())
    )
  );

-- Scopes: staff-only (management/reporting surface).
CREATE POLICY governance_petition_scopes_read ON politicore.governance_petition_scopes
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin()
         OR politicore.has_permission('view_governance'))
  );

-- Supports: staff-wide within the tenant PLUS the participant's own row
-- (C10/C14 boundary: signatures are never public; a participant can never
-- read another participant's signature row).
CREATE POLICY governance_petition_supports_read ON politicore.governance_petition_supports
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_governance')
      OR EXISTS (SELECT 1 FROM politicore.governance_participants gp
                  WHERE gp.id = governance_petition_supports.participant_id
                    AND gp.profile_id = auth.uid())
    )
  );

-- Canonical audit triggers on every new table (Core system_audits).
CREATE TRIGGER trg_audit_governance_petitions
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_petitions
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_petition_scopes
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_petition_scopes
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_petition_supports
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_petition_supports
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API SURFACE — the 0047/0048/0051 convention: thin
-- security_invoker views (zero authorization of their own — base-table
-- FORCE RLS remains the only boundary), mirrored grants, explicit
-- anon/PUBLIC revokes, and public RPC wrappers for the mutating RPCs.
-- No anonymous base-table access, no existence oracle for anon.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.governance_petitions
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_petitions;
CREATE OR REPLACE VIEW public.governance_petition_scopes
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_petition_scopes;
CREATE OR REPLACE VIEW public.governance_petition_supports
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_petition_supports;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_petitions          TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_petition_scopes    TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_petition_supports  TO authenticated, service_role;

REVOKE ALL ON public.governance_petitions          FROM anon;
REVOKE ALL ON public.governance_petition_scopes    FROM anon;
REVOKE ALL ON public.governance_petition_supports  FROM anon;
REVOKE ALL ON public.governance_petitions          FROM PUBLIC;
REVOKE ALL ON public.governance_petition_scopes    FROM PUBLIC;
REVOKE ALL ON public.governance_petition_supports  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.create_governance_petition(
  p_origin text, p_title text, p_demand text DEFAULT '',
  p_target_signatures integer DEFAULT NULL, p_closes_at timestamptz DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
  SELECT politicore.create_governance_petition(p_origin, p_title, p_demand,
    p_target_signatures, p_closes_at, p_scopes);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.update_governance_petition(
  p_petition uuid, p_title text DEFAULT NULL, p_demand text DEFAULT NULL,
  p_target_signatures integer DEFAULT NULL, p_closes_at timestamptz DEFAULT NULL,
  p_clear_closes_at boolean DEFAULT false
) RETURNS void AS $$
  SELECT politicore.update_governance_petition(p_petition, p_title, p_demand,
    p_target_signatures, p_closes_at, p_clear_closes_at);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_petition_status(
  p_petition uuid, p_status text
) RETURNS void AS $$
  SELECT politicore.set_governance_petition_status(p_petition, p_status);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.verify_governance_petition(
  p_petition uuid, p_note text DEFAULT ''
) RETURNS integer AS $$
  SELECT politicore.verify_governance_petition(p_petition, p_note);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.publish_petition_results(
  p_petition uuid, p_summary text DEFAULT '', p_results jsonb DEFAULT '{}'::jsonb
) RETURNS void AS $$
  SELECT politicore.publish_petition_results(p_petition, p_summary, p_results);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.set_governance_petition_visibility(
  p_petition uuid, p_is_public boolean
) RETURNS void AS $$
  SELECT politicore.set_governance_petition_visibility(p_petition, p_is_public);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.add_governance_petition_scope(
  p_petition uuid, p_scope_type text,
  p_state_id text DEFAULT NULL, p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL, p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.add_governance_petition_scope(
    p_petition, p_scope_type::politicore.scope_type_enum,
    p_state_id, p_zone_id, p_lga_id, p_ward_id, p_polling_unit_id);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.remove_governance_petition_scope(
  p_scope uuid
) RETURNS void AS $$
  SELECT politicore.remove_governance_petition_scope(p_scope);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

CREATE OR REPLACE FUNCTION public.sign_governance_petition(
  p_petition uuid, p_comment text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.sign_governance_petition(p_petition, p_comment);
$$ LANGUAGE sql SECURITY INVOKER SET search_path = politicore, public, pg_temp;

GRANT EXECUTE ON FUNCTION public.create_governance_petition(text,text,text,integer,timestamptz,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_governance_petition(uuid,text,text,integer,timestamptz,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_petition_status(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_governance_petition(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_petition_results(uuid,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_governance_petition_visibility(uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_governance_petition_scope(uuid,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_governance_petition_scope(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sign_governance_petition(uuid,text) TO authenticated;

REVOKE EXECUTE ON FUNCTION politicore.create_governance_petition(text,text,text,integer,timestamptz,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.update_governance_petition(uuid,text,text,integer,timestamptz,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_petition_status(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.verify_governance_petition(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.publish_petition_results(uuid,text,jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_petition_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.add_governance_petition_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.remove_governance_petition_scope(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.sign_governance_petition(uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_petition(text,text,text,integer,timestamptz,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_governance_petition(uuid,text,text,integer,timestamptz,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_petition_status(uuid,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_governance_petition(uuid,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.publish_petition_results(uuid,text,jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_governance_petition_visibility(uuid,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.add_governance_petition_scope(uuid,text,text,text,text,text,text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.remove_governance_petition_scope(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.sign_governance_petition(uuid,text) FROM anon;
