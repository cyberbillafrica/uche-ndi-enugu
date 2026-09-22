-- =====================================================================
-- 0019: ELECTION WORKFLOW RPCs + VIEWS — RELATIONAL BALLOTS
--       (Architecture Amendment & Reconciliation Gate, part 2)
--
-- Updates the Phase 1C workflow surface for the relational vote model
-- created in 0018. RPC signatures are UNCHANGED (the application-layer
-- contract stays `p_votes jsonb`); only storage and enforcement change.
--
--   * submit_election_result
--       - validates the ballot against contest participants
--         (assert_valid_ballot: party must be a candidate of THIS
--         contest — procedural front line; the 0018 composite FKs are
--         the native backstop)
--       - STATE GUARD: resubmission is legal only from
--         submitted / rejected / clarification_required / reopened.
--         An APPROVED result can no longer be overwritten by
--         resubmission (reopen or admin correct first), and a result
--         under correction review (pending_review) cannot be clobbered
--         by the submitter — closing the ratified matrix's omission.
--       - writes election_result_votes rows (not JSONB)
--       - history: distinct 'create' vs 'resubmit' action, evidence
--         references (old/new), submitter references (old/new)
--   * review_election_result
--       - history rows carry the evidence references of the reviewed
--         state; self-review guard now considers the last data-changing
--         event ('correct' OR 'resubmit')
--   * correct_election_result
--       - refuses to re-correct a result already pending_review
--       - replaces relational ballots; history carries evidence refs
--   * get_results_aggregate
--       - party totals via ordinary SQL joins over election_result_votes
--   * election_results_current views (politicore + public) recreated:
--       vote_details now aggregates from the relational ballot table
-- =====================================================================

-- ---------------------------------------------------------------------
-- RPC 1 — submit_election_result
-- ---------------------------------------------------------------------
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
  v_existing politicore.election_results;
  v_result uuid;
  v_old_votes jsonb;
  v_new_votes jsonb;
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

  -- 12-13. ballot structure + contest-participant integrity
  -- (party must be a candidate of THIS contest; the 0018 composite FKs
  -- into election_candidates enforce the same rule natively on any
  -- write path)
  PERFORM politicore.assert_valid_ballot(p_contest, p_votes);

  -- 14. relational identity (tenant, contest, PU) — fetch existing row
  SELECT * INTO v_existing FROM politicore.election_results r
  WHERE r.tenant_id = v_tenant AND r.contest_id = p_contest
    AND r.polling_unit_id = v_pu.id
  FOR UPDATE;

  -- 14a. STATE GUARD (reconciliation gate): resubmission is legal only
  -- from submitted / rejected / clarification_required / reopened.
  --   * approved  — immutable by submission; reopen (verifier) or
  --                 correct (admin) first. This closes the ratified
  --                 matrix's approved→submitted omission.
  --   * pending_review — an admin correction is under independent
  --                 review; a resubmission must not silently clear the
  --                 re-verification requirement.
  IF v_existing.id IS NOT NULL
     AND v_existing.status NOT IN ('submitted','rejected','clarification_required','reopened') THEN
    RAISE EXCEPTION 'resubmission blocked: result is % — %',
      v_existing.status,
      CASE v_existing.status
        WHEN 'approved' THEN 'an authorized verifier must reopen it or an administrator must correct it first'
        WHEN 'pending_review' THEN 'an administrative correction is under independent review'
        ELSE 'not resubmittable in this state'
      END;
  END IF;

  -- snapshot the pre-transition ballot (forensic old_votes) BEFORE the
  -- relational ballot is replaced
  v_old_votes := CASE WHEN v_existing.id IS NULL THEN NULL
    ELSE (
      SELECT COALESCE(
               jsonb_agg(jsonb_build_object('party_id', rv.party_id, 'votes', rv.votes)
                         ORDER BY rv.party_id),
               '[]'::jsonb)
      FROM politicore.election_result_votes rv
      WHERE rv.result_id = v_existing.id
    ) END;

  -- 15-17. upsert (relational identity tenant+contest+PU); a resubmit
  -- preserves legacy semantics: status resets to submitted, verified
  -- false, fresh review attribution, submitter = current actor.
  INSERT INTO politicore.election_results
    (tenant_id, election_cycle_id, contest_id, polling_unit_id, ward_id, lga_id,
     status, verified, evidence_asset_id, submitted_by)
  VALUES
    (v_tenant, v_contest.election_cycle_id, p_contest, v_pu.id, v_pu.ward_id, v_pu.lga_id,
     'submitted', false, p_evidence, v_uid)
  ON CONFLICT (tenant_id, contest_id, polling_unit_id) DO UPDATE SET
    status            = 'submitted',
    verified          = false,
    reviewed_by       = NULL,
    review_notes      = NULL,
    reviewed_at       = NULL,
    evidence_asset_id = EXCLUDED.evidence_asset_id,
    submitted_by      = EXCLUDED.submitted_by,
    updated_at        = now()
  RETURNING id INTO v_result;

  -- replace the relational ballot (validated party references; UNIQUE
  -- (result_id, party_id) and the composite FKs are the backstop).
  -- ev alias: bare result_id would collide with the OUT parameter.
  DELETE FROM politicore.election_result_votes ev WHERE ev.result_id = v_result;
  INSERT INTO politicore.election_result_votes (result_id, contest_id, party_id, votes)
  SELECT v_result, p_contest, (v->>'party_id')::uuid, (v->>'votes')::int
  FROM jsonb_array_elements(p_votes) v;

  -- snapshot the post-transition ballot (forensic new_votes)
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('party_id', rv.party_id, 'votes', rv.votes)
                     ORDER BY rv.party_id),
           '[]'::jsonb)
  INTO v_new_votes
  FROM politicore.election_result_votes rv
  WHERE rv.result_id = v_result;

  -- 18. append-only history — distinct 'create' vs 'resubmit', with
  -- evidence + submitter references for the forensic chain
  INSERT INTO politicore.election_result_history
    (tenant_id, result_id, action, actor_id,
     old_status, new_status, old_votes, new_votes,
     old_evidence_asset_id, new_evidence_asset_id,
     old_submitted_by, new_submitted_by, notes)
  VALUES
    (v_tenant, v_result,
     CASE WHEN v_existing.id IS NULL THEN 'create' ELSE 'resubmit' END,
     v_uid,
     v_existing.status, 'submitted',
     v_old_votes, v_new_votes,
     v_existing.evidence_asset_id, p_evidence,
     v_existing.submitted_by, v_uid,
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

-- ---------------------------------------------------------------------
-- RPC 2 — review_election_result
-- ---------------------------------------------------------------------
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
  v_last_data_changer uuid;
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

  -- Separation of duties (approved design §11.2(a)): whoever performed
  -- the last data-changing event (a CORRECTION or, after a rejection,
  -- the RESUBMISSION that re-keyed corrected data) can never approve
  -- that result — independent re-verification is mandatory. Enforcement
  -- lives HERE, not in a weakened global resolver. (An officer may
  -- legitimately re-approve after their own reject/reopen: those are
  -- review actions, not data changes.)
  IF p_action = 'approve' THEN
    SELECT actor_id INTO v_last_data_changer
    FROM politicore.election_result_history h
    WHERE h.result_id = v_result.id AND h.action IN ('correct','resubmit')
    ORDER BY h.created_at DESC
    LIMIT 1;
    IF v_last_data_changer IS NOT NULL AND v_last_data_changer = v_uid THEN
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

  -- officer review: immutable identity/geo/submitter; attribution
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
    (tenant_id, result_id, action, actor_id, old_status, new_status, notes,
     old_evidence_asset_id, new_evidence_asset_id, new_submitted_by)
  VALUES
    (v_tenant, v_result.id, v_hist_action, v_uid, v_result.status, v_new_status,
     COALESCE(p_notes, 'Result marked as ' || v_new_status),
     v_result.evidence_asset_id, v_result.evidence_asset_id, v_result.submitted_by);

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

-- ---------------------------------------------------------------------
-- RPC 3 — correct_election_result (admin-only)
-- ---------------------------------------------------------------------
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
  v_old_votes jsonb;
  v_new_votes jsonb;
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

  -- a result already pending re-verification must not be re-corrected
  -- on top of the pending correction
  IF v_result.status = 'pending_review' THEN
    RAISE EXCEPTION 'result is already pending_review — an administrative correction is under independent review';
  END IF;

  -- validate the replacement ballot against contest participants
  PERFORM politicore.assert_valid_ballot(v_result.contest_id, p_votes);

  -- snapshot the pre-correction ballot BEFORE the relational replace
  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('party_id', rv.party_id, 'votes', rv.votes)
                     ORDER BY rv.party_id),
           '[]'::jsonb)
  INTO v_old_votes
  FROM politicore.election_result_votes rv
  WHERE rv.result_id = v_result.id;

  -- preserve identity, geography, submitter, evidence; force
  -- re-verification; clear previous review attribution; verified=false
  -- (CHECK holds)
  UPDATE politicore.election_results SET
    status      = 'pending_review',
    verified    = false,
    reviewed_by = NULL,
    reviewed_at = NULL,
    updated_at  = now()
  WHERE id = v_result.id;

  DELETE FROM politicore.election_result_votes ev WHERE ev.result_id = v_result.id;
  INSERT INTO politicore.election_result_votes (result_id, contest_id, party_id, votes)
  SELECT v_result.id, v_result.contest_id, (v->>'party_id')::uuid, (v->>'votes')::int
  FROM jsonb_array_elements(p_votes) v;

  SELECT COALESCE(
           jsonb_agg(jsonb_build_object('party_id', rv.party_id, 'votes', rv.votes)
                     ORDER BY rv.party_id),
           '[]'::jsonb)
  INTO v_new_votes
  FROM politicore.election_result_votes rv
  WHERE rv.result_id = v_result.id;

  INSERT INTO politicore.election_result_history
    (tenant_id, result_id, action, actor_id,
     old_status, new_status, old_votes, new_votes,
     old_evidence_asset_id, new_evidence_asset_id,
     new_submitted_by, notes)
  VALUES
    (v_tenant, v_result.id, 'correct', v_uid,
     v_result.status, 'pending_review',
     v_old_votes, v_new_votes,
     v_result.evidence_asset_id, v_result.evidence_asset_id,
     v_result.submitted_by,
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

-- ---------------------------------------------------------------------
-- RPC 5 — get_results_aggregate: party totals now via ordinary SQL
-- joins over the relational ballot (no JSON extraction). Scope,
-- visibility (RLS invoker), and the output contract are unchanged.
-- ---------------------------------------------------------------------
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
  -- officialApprovedResults semantics) — RELATIONAL: join through the
  -- ballot table; labels resolved from IDs; no JSON extraction.
  SELECT COALESCE(jsonb_agg(p ORDER BY p.acronym), '[]'::jsonb)
  INTO v_parties
  FROM (
    SELECT pp.id AS party_id, pp.acronym, pp.name, sum(rv.votes) AS total_votes
    FROM politicore.election_results r
    JOIN politicore.election_result_votes rv ON rv.result_id = r.id
    JOIN politicore.political_parties pp ON pp.id = rv.party_id
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
-- Current-results views: recreated against the relational ballot.
-- (Column shape is preserved except `votes` — the raw JSONB — is gone;
-- consumers use vote_details, now aggregated from election_result_votes
-- via a plain join.)
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS public.election_results_current;
DROP VIEW IF EXISTS politicore.election_results_current;

CREATE OR REPLACE VIEW politicore.election_results_current
  WITH (security_invoker = true) AS
SELECT
  r.id                    AS result_id,
  r.tenant_id,
  r.election_cycle_id,
  c.election_cycle_id     AS cycle_ref,
  cy.name                 AS cycle_name,
  cy.year                 AS cycle_year,
  r.contest_id,
  c.name                  AS contest_name,
  c.contest_type,
  c.scope_type            AS contest_scope_type,
  c.scope_id              AS contest_scope_id,
  r.polling_unit_id,
  r.ward_id,
  r.lga_id,
  r.status,
  r.verified,
  r.reviewed_by,
  r.review_notes,
  r.reviewed_at,
  r.evidence_asset_id,
  r.submitted_by,
  r.created_at,
  r.updated_at,
  (
    SELECT jsonb_agg(
             jsonb_build_object(
               'party_id',  pp.id,
               'acronym',   pp.acronym,
               'name',      pp.name,
               'color',     pp.color,
               'votes',     rv.votes
             ) ORDER BY rv.votes DESC
           )
    FROM politicore.election_result_votes rv
    JOIN politicore.political_parties pp ON pp.id = rv.party_id
    WHERE rv.result_id = r.id
  ) AS vote_details
FROM politicore.election_results r
JOIN politicore.election_contests c ON c.id = r.contest_id
JOIN politicore.election_cycles  cy ON cy.id = r.election_cycle_id;

CREATE OR REPLACE VIEW public.election_results_current
  WITH (security_invoker = true) AS
  SELECT * FROM politicore.election_results_current;

GRANT SELECT ON public.election_results_current TO authenticated, service_role;
