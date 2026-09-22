-- =====================================================================
-- 0015: ELECTION WORKFLOW RPCs (Phase 1C-Implementation)
--
-- The authoritative mutation path for election results (approved design
-- §7): submit / review / correct / set_active_election / aggregate.
--
-- Security architecture:
--   * submit/review/correct/set_active_election are SECURITY DEFINER
--     (0006/0007 precedent) so they can write election_results and
--     election_result_history on behalf of callers whose own RLS does
--     not grant direct writes. EVERY authorization question is answered
--     explicitly inside (tenant from identity, module gate, permission,
--     registered-PU, evidence ownership) — the definer context changes
--     nothing about who may do what; it only centralizes the checks the
--     RLS policies would otherwise have to duplicate for a write path
--     that does not exist for clients.
--   * get_results_aggregate is SECURITY INVOKER: it computes strictly
--     over rows visible to the caller under RLS (brief §31: never a
--     privileged data leak).
--   * election_result_history is guarded by a trigger that accepts
--     writes only from inside these RPCs (transaction GUC) — no direct
--     client or ad-hoc server path.
--   * Separation of duties: the correcting admin can never approve the
--     corrected result (approved design §11.2(a)) — enforced here, not
--     by weakening the global resolver.
-- =====================================================================

-- ---------------------------------------------------------------------
-- History write guard: election_result_history is written ONLY by the
-- workflow RPCs, which set a transaction-local context marker.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_election_history_writer()
RETURNS trigger AS $$
BEGIN
  IF COALESCE(current_setting('politicore.election_rpc', true), '') <> 'workflow' THEN
    RAISE EXCEPTION 'election_result_history is append-only and writable only by election workflow RPCs';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE TRIGGER trg_guard_election_history_writer
  BEFORE INSERT ON politicore.election_result_history
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_election_history_writer();

-- ---------------------------------------------------------------------
-- Validation helper 1: vote structure + party integrity (brief §12).
-- Rejects: non-array, empty array, malformed objects, missing/invalid
-- party_id, negative or non-integer votes, duplicate parties, unknown
-- party IDs. Returns canonicalized votes [{party_id, votes}].
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.assert_valid_votes(p_votes jsonb)
RETURNS jsonb AS $$
DECLARE
  v_elem jsonb;
  v_pid text;
  v_votes numeric;
  v_seen uuid[];
  v_norm jsonb;
BEGIN
  IF p_votes IS NULL OR jsonb_typeof(p_votes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'votes must be a JSON array of {party_id, votes} objects';
  END IF;
  IF jsonb_array_length(p_votes) = 0 THEN
    RAISE EXCEPTION 'votes must contain at least one party entry';
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_votes) LOOP
    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object'
       OR NOT (v_elem ? 'party_id') OR NOT (v_elem ? 'votes') THEN
      RAISE EXCEPTION 'malformed vote entry: each element must be an object with party_id and votes';
    END IF;

    v_pid := v_elem->>'party_id';
    IF v_pid IS NULL OR v_pid !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'invalid party_id in votes: %', COALESCE(v_pid, '<null>');
    END IF;
    IF (v_pid::uuid) = ANY (v_seen) THEN
      RAISE EXCEPTION 'duplicate party entry in votes: %', v_pid;
    END IF;
    v_seen := v_seen || v_pid::uuid;

    IF jsonb_typeof(v_elem->'votes') <> 'number' THEN
      RAISE EXCEPTION 'votes for party % must be a number', v_pid;
    END IF;
    v_votes := (v_elem->>'votes')::numeric;
    IF v_votes IS NULL OR floor(v_votes) <> v_votes OR v_votes < 0 THEN
      RAISE EXCEPTION 'votes for party % must be a non-negative integer', v_pid;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM politicore.political_parties pp WHERE pp.id = v_pid::uuid) THEN
      RAISE EXCEPTION 'unknown party in votes: %', v_pid;
    END IF;

    -- COALESCE: NULL || jsonb is NULL (strict concat) — without it every
    -- submission silently stored empty votes (found by the security suite).
    v_norm := COALESCE(v_norm, '[]'::jsonb) || jsonb_build_object('party_id', v_pid, 'votes', v_votes::int);
  END LOOP;

  RETURN COALESCE(v_norm, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- Validation helper 2: contest geography (brief §8 — "the validation
-- helpers must reject invalid contest scope"). Wired as a BEFORE
-- trigger on election_contests so invalid geography is impossible from
-- ANY write path (config writes are direct admin writes; there is no
-- contest-creation RPC in the approved surface). Canonicalizes
-- state_id/zone_id from the scope.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.validate_contest_geography()
RETURNS trigger AS $$
DECLARE
  v_lga record;
BEGIN
  IF NEW.scope_type = 'national' THEN
    NEW.state_id := NULL;
    NEW.zone_id  := NULL;
  ELSIF NEW.scope_type = 'state' THEN
    IF NEW.scope_id IS NULL OR NOT EXISTS
       (SELECT 1 FROM politicore.states s WHERE s.id = NEW.scope_id) THEN
      RAISE EXCEPTION 'contest scope: unknown state %', NEW.scope_id;
    END IF;
    NEW.state_id := NEW.scope_id;
    NEW.zone_id  := NULL;
  ELSIF NEW.scope_type = 'senatorial_zone' THEN
    IF NEW.scope_id IS NULL OR NOT EXISTS
       (SELECT 1 FROM politicore.senatorial_zones z WHERE z.id = NEW.scope_id) THEN
      RAISE EXCEPTION 'contest scope: unknown senatorial zone %', NEW.scope_id;
    END IF;
    NEW.zone_id  := NEW.scope_id;
    NEW.state_id := (SELECT z.state_id FROM politicore.senatorial_zones z WHERE z.id = NEW.scope_id);
  ELSE -- federal_constituency | state_constituency
    IF cardinality(NEW.scope_lgas) = 0 THEN
      RAISE EXCEPTION 'contest scope: constituency contests require at least one LGA';
    END IF;
    IF NEW.state_id IS NULL THEN
      NEW.state_id := (SELECT l.state_id FROM politicore.lgas l WHERE l.id = NEW.scope_lgas[1]);
    END IF;
    IF NEW.state_id IS NULL OR NOT EXISTS
       (SELECT 1 FROM politicore.states s WHERE s.id = NEW.state_id) THEN
      RAISE EXCEPTION 'contest scope: unknown state %', NEW.state_id;
    END IF;
    FOR v_lga IN SELECT unnest(NEW.scope_lgas) AS id LOOP
      IF NOT EXISTS (
        SELECT 1 FROM politicore.lgas l
        WHERE l.id = v_lga.id AND l.state_id = NEW.state_id
      ) THEN
        RAISE EXCEPTION 'contest scope: LGA % is not part of state %', v_lga.id, NEW.state_id;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE TRIGGER trg_validate_contest_geography
  BEFORE INSERT OR UPDATE OF scope_type, scope_id, scope_lgas, state_id ON politicore.election_contests
  FOR EACH ROW EXECUTE FUNCTION politicore.validate_contest_geography();

-- ---------------------------------------------------------------------
-- Notification helper: tenant election authorities (admins + officers),
-- excluding the acting user. Existing notifications infrastructure; the
-- definer context is what allows a non-admin workflow actor to raise a
-- review-queue notification (notifications INSERT policy is admin-only
-- to clients — unchanged).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.notify_election_roles(
  p_tenant uuid, p_actor uuid, p_title text, p_message text, p_link text
) RETURNS void AS $$
BEGIN
  INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT p_tenant, p.id, 'election', p_title, p_message, p_link, p_actor
  FROM politicore.profiles p
  WHERE p.tenant_id = p_tenant
    AND p.access_role IN ('admin','tenant_super_admin','election_officer')
    AND p.lifecycle_status = 'active'
    AND p.id IS DISTINCT FROM p_actor;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- =====================================================================
-- RPC 1 — submit_election_result (brief §27)
-- =====================================================================
CREATE OR REPLACE FUNCTION politicore.submit_election_result(
  p_contest uuid,
  p_polling_unit text,
  p_votes jsonb,
  p_evidence uuid
)
RETURNS TABLE (result_id uuid, status politicore.result_status, verified boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_profile politicore.profiles;
  v_contest politicore.election_contests;
  v_lga politicore.lgas;
  v_pu politicore.polling_units;
  v_votes jsonb;
  v_existing politicore.election_results;
  v_result uuid;
BEGIN
  PERFORM set_config('politicore.election_rpc', 'workflow', true);

  -- 1. authenticate + 2. trusted tenant from identity (never payload)
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT * INTO v_profile FROM politicore.profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found for authenticated user';
  END IF;
  v_tenant := v_profile.tenant_id;

  -- 3. module gate (module activation ≠ user authorization, but both apply)
  IF NOT politicore.module_enabled('election') THEN
    RAISE EXCEPTION 'election module is not enabled for this tenant';
  END IF;

  -- social-only members: zero election access (all layers)
  IF politicore.is_social_only() THEN
    RAISE EXCEPTION 'social members do not have election access';
  END IF;

  -- 4. contest must exist in the caller's tenant (tenant isolation)
  SELECT * INTO v_contest FROM politicore.election_contests c
  WHERE c.id = p_contest AND c.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contest not found in your tenant';
  END IF;

  -- 5. contest must be OPEN (legacy invariant)
  IF v_contest.status <> 'OPEN' THEN
    RAISE EXCEPTION 'cannot submit result: contest % is %, not OPEN', v_contest.name, v_contest.status;
  END IF;

  -- 7. polling unit exists; geography is DERIVED from it (never client-supplied)
  SELECT * INTO v_pu FROM politicore.polling_units WHERE id = p_polling_unit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'polling unit not found: %', p_polling_unit;
  END IF;
  SELECT * INTO v_lga FROM politicore.lgas WHERE id = v_pu.lga_id;

  -- PU must lie within the contest's applicable geography
  IF v_contest.scope_type = 'state' AND v_lga.state_id <> v_contest.state_id THEN
    RAISE EXCEPTION 'polling unit is outside the contest scope';
  ELSIF v_contest.scope_type = 'senatorial_zone' AND v_lga.zone_id <> v_contest.zone_id THEN
    RAISE EXCEPTION 'polling unit is outside the contest scope';
  ELSIF v_contest.scope_type IN ('federal_constituency','state_constituency')
        AND NOT (v_pu.lga_id = ANY (v_contest.scope_lgas)) THEN
    RAISE EXCEPTION 'polling unit is outside the contest scope';
  END IF; -- 'national' covers every PU

  -- 8. caller authorized at this polling unit: admin/officer tenant-wide,
  --    scoped upload_election_result (hierarchical), or registered-PU
  --    campaign member (registered geography ≠ organizational authority;
  --    both are accepted submission paths per brief §25)
  --
  -- FAIL-CLOSED: each condition is forced boolean via COALESCE/IS TRUE —
  -- a NULL registered-PU comparison must never poison the OR chain into
  -- IF NOT (NULL) = false (the three-valued-logic bypass found by the
  -- security suite: a NULL-pu user could submit for ANY polling unit).
  IF NOT (
    politicore.is_admin()
    OR politicore.is_election_officer()
    OR politicore.has_permission('upload_election_result', 'polling_unit', v_pu.id)
    OR (
      v_profile.polling_unit_id IS NOT NULL
      AND v_profile.polling_unit_id = v_pu.id
      AND v_profile.membership_types @> ARRAY['campaign_member']::politicore.membership_type_enum[]
    )
  ) THEN
    RAISE EXCEPTION 'not authorized to submit results for polling unit %', v_pu.id;
  END IF;

  -- 9-11. evidence asset: exists, same tenant, election purpose
  IF p_evidence IS NULL THEN
    RAISE EXCEPTION 'Form EC8 photo evidence is mandatory for result submission';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM politicore.media_assets m
    WHERE m.id = p_evidence
      AND m.tenant_id = v_tenant
      AND m.purpose = 'election_evidence'
  ) THEN
    RAISE EXCEPTION 'evidence asset not found in your tenant or not election evidence';
  END IF;

  -- 12-13. vote structure + party integrity
  v_votes := politicore.assert_valid_votes(p_votes);

  -- 14-17. upsert (relational identity tenant+contest+PU); a resubmit
  -- preserves legacy semantics: status resets to submitted, verified
  -- false, fresh review attribution, submitter = current actor.
  SELECT * INTO v_existing FROM politicore.election_results r
  WHERE r.tenant_id = v_tenant AND r.contest_id = p_contest
    AND r.polling_unit_id = v_pu.id
  FOR UPDATE;

  INSERT INTO politicore.election_results
    (tenant_id, election_cycle_id, contest_id, polling_unit_id, ward_id, lga_id,
     votes, status, verified, evidence_asset_id, submitted_by)
  VALUES
    (v_tenant, v_contest.election_cycle_id, p_contest, v_pu.id, v_pu.ward_id, v_pu.lga_id,
     v_votes, 'submitted', false, p_evidence, v_uid)
  ON CONFLICT (tenant_id, contest_id, polling_unit_id) DO UPDATE SET
    votes             = EXCLUDED.votes,
    status            = 'submitted',
    verified          = false,
    reviewed_by       = NULL,
    review_notes      = NULL,
    reviewed_at       = NULL,
    evidence_asset_id = EXCLUDED.evidence_asset_id,
    submitted_by      = EXCLUDED.submitted_by,
    updated_at        = now()
  RETURNING id INTO v_result;

  -- 18. append-only history (legacy: every submission logs action 'create')
  INSERT INTO politicore.election_result_history
    (tenant_id, result_id, action, actor_id, old_status, new_status, old_votes, new_votes, notes)
  VALUES
    (v_tenant, v_result, 'create', v_uid,
     v_existing.status, 'submitted',
     v_existing.votes, v_votes,
     CASE WHEN v_existing.id IS NULL
          THEN 'Initial result submission with Form EC8 evidence'
          ELSE 'Result resubmitted with Form EC8 evidence' END);

  -- 19. review-queue notification to election authorities
  PERFORM politicore.notify_election_roles(
    v_tenant, v_uid,
    'Election result submitted',
    'A result was submitted for contest ' || v_contest.name ||
      ' at polling unit ' || v_pu.id || ' and awaits review.',
    '/portal/election/operations');

  -- 20. return the resulting row
  RETURN QUERY SELECT v_result, 'submitted'::politicore.result_status, false;
END;
$$;

-- =====================================================================
-- RPC 2 — review_election_result (brief §28)
-- =====================================================================
CREATE OR REPLACE FUNCTION politicore.review_election_result(
  p_result uuid,
  p_action text,
  p_notes text DEFAULT NULL
)
RETURNS TABLE (result_id uuid, status politicore.result_status, verified boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_result politicore.election_results;
  v_new_status politicore.result_status;
  v_hist_action text;
  v_last_corrector uuid;
BEGIN
  PERFORM set_config('politicore.election_rpc', 'workflow', true);

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_uid;
  IF NOT FOUND OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'profile not found for authenticated user';
  END IF;
  IF NOT politicore.module_enabled('election') THEN
    RAISE EXCEPTION 'election module is not enabled for this tenant';
  END IF;

  IF p_action NOT IN ('approve','reject','clarify','reopen') THEN
    RAISE EXCEPTION 'invalid review action: %', p_action;
  END IF;

  -- verification authority: verify_election_result through the resolver
  -- (officer fixed set / explicit grant / admin bypass)
  SELECT * INTO v_result FROM politicore.election_results r
  WHERE r.id = p_result AND r.tenant_id = v_tenant
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'result not found in your tenant';
  END IF;

  IF NOT politicore.has_permission('verify_election_result', 'polling_unit', v_result.polling_unit_id) THEN
    RAISE EXCEPTION 'not authorized to verify election results';
  END IF;

  -- Separation of duties (approved design §11.2(a)): the administrator
  -- who performed the latest CORRECTION can never approve that result —
  -- independent re-verification is mandatory. Enforcement lives HERE,
  -- not in a weakened global resolver. (Only 'correct' events count: an
  -- officer may legitimately re-approve after their own reject/reopen.)
  IF p_action = 'approve' THEN
    SELECT actor_id INTO v_last_corrector
    FROM politicore.election_result_history h
    WHERE h.result_id = v_result.id AND h.action = 'correct'
    ORDER BY h.created_at DESC
    LIMIT 1;
    IF v_last_corrector IS NOT NULL AND v_last_corrector = v_uid THEN
      RAISE EXCEPTION 'independent verification required: you cannot approve a result you corrected';
    END IF;
  END IF;

  -- legal transitions (approved design §6 machine)
  IF p_action = 'approve' THEN
    IF v_result.status NOT IN ('submitted','pending_review','reopened') THEN
      RAISE EXCEPTION 'illegal transition: cannot approve from %', v_result.status;
    END IF;
    v_new_status := 'approved';
    v_hist_action := 'review_approve';
  ELSIF p_action = 'reject' THEN
    IF v_result.status NOT IN ('submitted','pending_review','reopened') THEN
      RAISE EXCEPTION 'illegal transition: cannot reject from %', v_result.status;
    END IF;
    v_new_status := 'rejected';
    v_hist_action := 'review_reject';
  ELSIF p_action = 'clarify' THEN
    IF v_result.status NOT IN ('submitted','pending_review','reopened') THEN
      RAISE EXCEPTION 'illegal transition: cannot request clarification from %', v_result.status;
    END IF;
    v_new_status := 'clarification_required';
    v_hist_action := 'review_clarify';
  ELSE -- reopen
    IF v_result.status <> 'approved' THEN
      RAISE EXCEPTION 'illegal transition: can only reopen an approved result';
    END IF;
    v_new_status := 'reopened';
    v_hist_action := 'reopen';
  END IF;

  -- officer review: immutable identity/geo/submitter/votes; attribution
  -- = authenticated reviewer; verified ⇔ approved (DB CHECK holds)
  UPDATE politicore.election_results SET
    status       = v_new_status,
    verified     = (p_action = 'approve'),
    reviewed_by  = v_uid,
    review_notes = p_notes,
    reviewed_at  = now(),
    updated_at   = now()
  WHERE id = v_result.id;

  INSERT INTO politicore.election_result_history
    (tenant_id, result_id, action, actor_id, old_status, new_status, notes)
  VALUES
    (v_tenant, v_result.id, v_hist_action, v_uid, v_result.status, v_new_status,
     COALESCE(p_notes, 'Result marked as ' || v_new_status));

  -- notify the submitting user of the decision
  INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message, link_url, created_by)
  VALUES (
    v_tenant, v_result.submitted_by, 'election',
    'Result ' || v_new_status,
    'Your result for polling unit ' || v_result.polling_unit_id || ' was marked '
      || v_new_status || COALESCE(' — ' || p_notes, '') ,
    '/portal/election', v_uid);

  RETURN QUERY SELECT v_result.id, v_new_status, (p_action = 'approve');
END;
$$;

-- =====================================================================
-- RPC 3 — correct_election_result (brief §29; admin-only)
-- =====================================================================
CREATE OR REPLACE FUNCTION politicore.correct_election_result(
  p_result uuid,
  p_votes jsonb,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (result_id uuid, status politicore.result_status, verified boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_result politicore.election_results;
  v_votes jsonb;
BEGIN
  PERFORM set_config('politicore.election_rpc', 'workflow', true);

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_uid;
  IF NOT FOUND OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'profile not found for authenticated user';
  END IF;
  IF NOT politicore.module_enabled('election') THEN
    RAISE EXCEPTION 'election module is not enabled for this tenant';
  END IF;

  -- Admin authority only — officers correct nothing (§22)
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'only tenant administrators can correct election results';
  END IF;

  SELECT * INTO v_result FROM politicore.election_results r
  WHERE r.id = p_result AND r.tenant_id = v_tenant
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'result not found in your tenant';
  END IF;

  v_votes := politicore.assert_valid_votes(p_votes);

  -- preserve identity, geography, submitter; force re-verification;
  -- clear previous review attribution; verified=false (CHECK holds)
  UPDATE politicore.election_results SET
    votes       = v_votes,
    status      = 'pending_review',
    verified    = false,
    reviewed_by = NULL,
    reviewed_at = NULL,
    updated_at  = now()
  WHERE id = v_result.id;

  INSERT INTO politicore.election_result_history
    (tenant_id, result_id, action, actor_id, old_status, new_status, old_votes, new_votes, notes)
  VALUES
    (v_tenant, v_result.id, 'correct', v_uid, v_result.status, 'pending_review',
     v_result.votes, v_votes,
     COALESCE(p_reason, 'Administrative correction against submitted EC8 evidence'));

  -- re-verification required: notify authorities AND the submitter
  PERFORM politicore.notify_election_roles(
    v_tenant, v_uid,
    'Result corrected — re-verification required',
    'An administrator corrected the result for polling unit ' || v_result.polling_unit_id ||
      '. Independent re-verification is required.',
    '/portal/election/operations');

  RETURN QUERY SELECT v_result.id, 'pending_review'::politicore.result_status, false;
END;
$$;

-- =====================================================================
-- RPC 4 — set_active_election (brief §30; admin-only)
-- =====================================================================
CREATE OR REPLACE FUNCTION politicore.set_active_election(
  p_cycle uuid,
  p_contest uuid
)
RETURNS politicore.election_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_cycle politicore.election_cycles;
  v_contest politicore.election_contests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_uid;
  IF NOT FOUND OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'profile not found for authenticated user';
  END IF;
  IF NOT politicore.module_enabled('election') THEN
    RAISE EXCEPTION 'election module is not enabled for this tenant';
  END IF;
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'only tenant administrators can configure the active election';
  END IF;

  -- both records must belong to the caller's tenant (no cross-tenant IDs)
  SELECT * INTO v_cycle FROM politicore.election_cycles c
  WHERE c.id = p_cycle AND c.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'election cycle not found in your tenant';
  END IF;

  SELECT * INTO v_contest FROM politicore.election_contests c
  WHERE c.id = p_contest AND c.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contest not found in your tenant';
  END IF;

  -- contest belongs to the cycle
  IF v_contest.election_cycle_id <> p_cycle THEN
    RAISE EXCEPTION 'contest does not belong to the given election cycle';
  END IF;

  -- contest must be appropriate for activation (a CLOSED contest can
  -- no longer be the reporting target)
  IF v_contest.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a CLOSED contest cannot be set as the active contest';
  END IF;

  INSERT INTO politicore.election_settings
    (tenant_id, active_cycle_id, active_contest_id, updated_by, updated_at)
  VALUES
    (v_tenant, p_cycle, p_contest, v_uid, now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    active_cycle_id   = EXCLUDED.active_cycle_id,
    active_contest_id = EXCLUDED.active_contest_id,
    updated_by        = EXCLUDED.updated_by,
    updated_at        = now();

  RETURN (
    SELECT s FROM politicore.election_settings s WHERE s.tenant_id = v_tenant
  );
END;
$$;

-- =====================================================================
-- RPC 5 — get_results_aggregate (brief §31)
-- SECURITY INVOKER: computes strictly over rows the caller can already
-- see under RLS. Scope may be narrowed beyond the contest's own
-- geography; totals are computed from the geography tables (reporting
-- % = approved PUs / total PUs in scope).
-- =====================================================================
CREATE OR REPLACE FUNCTION politicore.get_results_aggregate(
  p_cycle uuid,
  p_contest uuid,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_contest politicore.election_contests;
  v_total_pus bigint;
  v_approved_pus bigint;
  v_pending_pus bigint;
  v_parties jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- INVOKER + RLS: a contest outside the caller's tenant (or a
  -- module-disabled / social-only context) yields no rows here.
  SELECT * INTO v_contest FROM politicore.election_contests c
  WHERE c.id = p_contest AND c.election_cycle_id = p_cycle AND c.tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contest not found in your tenant';
  END IF;

  -- Total PUs within the requested reporting scope (geography-derived).
  v_total_pus :=
    CASE
      WHEN p_scope_type = 'polling_unit' THEN
        (SELECT count(*) FROM politicore.polling_units pu WHERE pu.id = p_scope_id)
      WHEN p_scope_type = 'ward' THEN
        (SELECT count(*) FROM politicore.polling_units pu WHERE pu.ward_id = p_scope_id)
      WHEN p_scope_type = 'lga' THEN
        (SELECT count(*) FROM politicore.polling_units pu WHERE pu.lga_id = p_scope_id)
      WHEN p_scope_type = 'senatorial_zone' THEN
        (SELECT count(*) FROM politicore.polling_units pu
         JOIN politicore.lgas l ON l.id = pu.lga_id WHERE l.zone_id = p_scope_id)
      WHEN p_scope_type = 'state' THEN
        (SELECT count(*) FROM politicore.polling_units pu
         JOIN politicore.lgas l ON l.id = pu.lga_id WHERE l.state_id = p_scope_id)
      WHEN p_scope_type = 'campaign' OR p_scope_type IS NULL THEN
        CASE v_contest.scope_type
          WHEN 'national' THEN
            (SELECT count(*) FROM politicore.polling_units)
          WHEN 'state' THEN
            (SELECT count(*) FROM politicore.polling_units pu
             JOIN politicore.lgas l ON l.id = pu.lga_id WHERE l.state_id = v_contest.state_id)
          WHEN 'senatorial_zone' THEN
            (SELECT count(*) FROM politicore.polling_units pu
             JOIN politicore.lgas l ON l.id = pu.lga_id WHERE l.zone_id = v_contest.zone_id)
          ELSE -- constituencies: PUs of the contest's LGA set
            (SELECT count(*) FROM politicore.polling_units pu
             WHERE pu.lga_id = ANY (v_contest.scope_lgas))
        END
    END;

  -- Approved / pending PU counts over VISIBLE results (RLS applies).
  SELECT
    count(*) FILTER (WHERE r.status = 'approved'),
    count(*) FILTER (WHERE r.status <> 'approved')
  INTO v_approved_pus, v_pending_pus
  FROM politicore.election_results r
  WHERE r.tenant_id = v_tenant
    AND r.election_cycle_id = p_cycle
    AND r.contest_id = p_contest
    AND (p_scope_type IS NULL OR p_scope_type = 'campaign'
         OR (p_scope_type = 'polling_unit' AND r.polling_unit_id = p_scope_id)
         OR (p_scope_type = 'ward' AND r.ward_id = p_scope_id)
         OR (p_scope_type = 'lga' AND r.lga_id = p_scope_id)
         OR (p_scope_type = 'senatorial_zone' AND r.lga_id IN
             (SELECT id FROM politicore.lgas WHERE zone_id = p_scope_id))
         OR (p_scope_type = 'state' AND r.lga_id IN
             (SELECT id FROM politicore.lgas WHERE state_id = p_scope_id)));

  -- Official party totals over VISIBLE APPROVED rows only (legacy
  -- officialApprovedResults semantics), labels resolved from IDs.
  SELECT COALESCE(jsonb_agg(p ORDER BY p.acronym), '[]'::jsonb)
  INTO v_parties
  FROM (
    SELECT pp.id AS party_id, pp.acronym, pp.name, sum((v->>'votes')::bigint) AS total_votes
    FROM politicore.election_results r
    CROSS JOIN LATERAL jsonb_array_elements(r.votes) v
    JOIN politicore.political_parties pp ON pp.id = (v->>'party_id')::uuid
    WHERE r.tenant_id = v_tenant
      AND r.election_cycle_id = p_cycle
      AND r.contest_id = p_contest
      AND r.status = 'approved'
      AND (p_scope_type IS NULL OR p_scope_type = 'campaign'
           OR (p_scope_type = 'polling_unit' AND r.polling_unit_id = p_scope_id)
           OR (p_scope_type = 'ward' AND r.ward_id = p_scope_id)
           OR (p_scope_type = 'lga' AND r.lga_id = p_scope_id)
           OR (p_scope_type = 'senatorial_zone' AND r.lga_id IN
               (SELECT id FROM politicore.lgas WHERE zone_id = p_scope_id))
           OR (p_scope_type = 'state' AND r.lga_id IN
               (SELECT id FROM politicore.lgas WHERE state_id = p_scope_id)))
    GROUP BY pp.id, pp.acronym, pp.name
  ) p;

  RETURN jsonb_build_object(
    'cycle_id', p_cycle,
    'contest_id', p_contest,
    -- ::text cast: COALESCE cannot mix scope_type_enum with text.
    'scope_type', COALESCE(p_scope_type::text, v_contest.scope_type::text),
    'party_totals', v_parties,
    'approved_pus', COALESCE(v_approved_pus, 0),
    'pending_pus', COALESCE(v_pending_pus, 0),
    'total_pus_in_scope', COALESCE(v_total_pus, 0),
    'reporting_pct', CASE
      WHEN COALESCE(v_total_pus, 0) = 0 THEN 0
      ELSE round(COALESCE(v_approved_pus, 0)::numeric * 100 / v_total_pus, 1)
    END
  );
END;
$$;

-- ---------------------------------------------------------------------
-- PostgREST surface (0007/0008 precedent: hosted data API exposes
-- public.* only). Thin INVOKER wrappers — all authorization happens in
-- the politicore originals.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_election_result(
  p_contest uuid, p_polling_unit text, p_votes jsonb, p_evidence uuid
) RETURNS TABLE (result_id uuid, status politicore.result_status, verified boolean) AS $$
  SELECT * FROM politicore.submit_election_result(p_contest, p_polling_unit, p_votes, p_evidence);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.review_election_result(
  p_result uuid, p_action text, p_notes text DEFAULT NULL
) RETURNS TABLE (result_id uuid, status politicore.result_status, verified boolean) AS $$
  SELECT * FROM politicore.review_election_result(p_result, p_action, p_notes);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.correct_election_result(
  p_result uuid, p_votes jsonb, p_reason text DEFAULT NULL
) RETURNS TABLE (result_id uuid, status politicore.result_status, verified boolean) AS $$
  SELECT * FROM politicore.correct_election_result(p_result, p_votes, p_reason);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_active_election(
  p_cycle uuid, p_contest uuid
) RETURNS politicore.election_settings AS $$
  SELECT politicore.set_active_election(p_cycle, p_contest);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.get_results_aggregate(
  p_cycle uuid, p_contest uuid,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
) RETURNS jsonb AS $$
  SELECT politicore.get_results_aggregate(p_cycle, p_contest, p_scope_type, p_scope_id);
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION public.submit_election_result(uuid, text, jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_election_result(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_election_result(uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_active_election(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_results_aggregate(uuid, uuid, politicore.scope_type_enum, text) TO authenticated, service_role;

-- politicore originals: same surface (mirrors 0006 blanket grant, explicit here)
GRANT EXECUTE ON FUNCTION politicore.submit_election_result(uuid, text, jsonb, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.review_election_result(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.correct_election_result(uuid, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.set_active_election(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.get_results_aggregate(uuid, uuid, politicore.scope_type_enum, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.assert_valid_votes(jsonb) TO authenticated, service_role;
