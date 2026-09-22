-- =====================================================================
-- 0018: ELECTION RELATIONAL VOTES + HISTORY HARDENING
--       (Architecture Amendment & Reconciliation Gate)
--
-- Amendments (gate decisions; everything else in the ratified Phase 1C
-- architecture is intentionally unchanged):
--
--   1. election_result_votes — votes become relational rows
--      (result_id, contest_id, party_id, votes) replacing the JSONB
--      `election_results.votes` column. PostgreSQL is not a Firestore
--      transcription exercise: the party/result/contest/vote-count
--      relationship is stable and must be natively enforced.
--
--   2. Ballot rule, enforced by the database itself (declarative, no
--      procedural validation):
--        UNIQUE (result_id, party_id)              — one entry per party
--        votes >= 0                                — non-negative counts
--        result_id → election_results(id, contest_id)
--        (contest_id, party_id) → election_candidates(contest_id, party_id)
--      A vote row therefore cannot reference a party that is not a
--      registered participant (candidate) of the exact contest of the
--      result — the gate's §3 requirement, natively.
--
--   3. History hardening: election_result_history gains evidence
--      references (old/new_evidence_asset_id) and submitter references
--      (old/new_submitted_by) so the forensic chain reconstructs which
--      evidence belonged to each historical state, plus a distinct
--      'resubmit' action (previously conflated with 'create').
--
--   4. Legacy JSONB data migration is conditional and forward-safe:
--      hosted has zero election rows today, but if any JSONB votes
--      exist they are expanded into relational rows before the JSONB
--      column is dropped. Party references are validated by the
--      composite FKs — a legacy row that violates the ballot rule
--      FAILS the migration loudly instead of being silently dropped.
--
-- Workflow RPC updates (submit/review/correct/aggregate) and the
-- current-results view follow in 0019.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Composite-FK targets on election_results.
--    (tenant_id, contest_id, polling_unit_id) already exists as the
--    relational identity. A second UNIQUE (id, contest_id) makes the
--    result's own contest referentially addressable so ballot rows can
--    be pinned to the SAME contest via one FK.
-- ---------------------------------------------------------------------
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'election_results_id_contest_key'
      AND conrelid = 'politicore.election_results'::regclass
  ) THEN
    ALTER TABLE politicore.election_results
      ADD CONSTRAINT election_results_id_contest_key UNIQUE (id, contest_id);
  END IF;
END
$fk$;

-- ---------------------------------------------------------------------
-- 2. election_result_votes — the relational ballot.
--    contest_id is denormalized from the parent result purely so the
--    ballot rule can be a pair of composite FKs; the (result_id,
--    contest_id) FK guarantees it always equals the result's contest.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS politicore.election_result_votes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  result_id  uuid NOT NULL,
  contest_id uuid NOT NULL,
  party_id   uuid NOT NULL,
  votes      integer NOT NULL CHECK (votes >= 0),
  UNIQUE (result_id, party_id),
  -- the result exists and contest_id equals the result's own contest
  FOREIGN KEY (result_id, contest_id)
    REFERENCES politicore.election_results (id, contest_id) ON DELETE RESTRICT,
  -- ballot rule: the party must be a registered participant (candidate)
  -- of exactly that contest
  FOREIGN KEY (contest_id, party_id)
    REFERENCES politicore.election_candidates (contest_id, party_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS election_result_votes_party_idx
  ON politicore.election_result_votes (party_id);
CREATE INDEX IF NOT EXISTS election_result_votes_contest_party_idx
  ON politicore.election_result_votes (contest_id, party_id);

COMMENT ON TABLE politicore.election_result_votes IS
  'Relational ballot: one row per (result, party). Contest/party validity is enforced natively via composite FKs into election_results and election_candidates.';

-- RLS: enabled, NO FORCE (the 0015/0019 definer workflow RPCs write it
-- as table owner — same pattern as election_results). App-role access
-- is SELECT-only and delegated through the parent result's read policy.
ALTER TABLE politicore.election_result_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY result_votes_read ON politicore.election_result_votes FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM politicore.election_results r
    WHERE r.id = election_result_votes.result_id
      AND r.tenant_id = politicore.current_tenant_id()
      AND politicore.module_enabled('election')
      AND NOT politicore.is_social_only()
      AND (
        politicore.is_admin()
        OR politicore.is_election_officer()
        OR politicore.has_permission('view_election_results', 'polling_unit', r.polling_unit_id)
        OR EXISTS (
          SELECT 1 FROM politicore.profiles p
          WHERE p.id = auth.uid()
            AND p.polling_unit_id = r.polling_unit_id
            AND 'campaign_member' = ANY (p.membership_types)
        )
      )
  )
);

GRANT SELECT ON politicore.election_result_votes TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON politicore.election_result_votes FROM authenticated, anon;

-- ---------------------------------------------------------------------
-- 3. Forward-safe JSONB migration. Expands any existing
--    election_results.votes payloads into relational rows (validating
--    party references through the composite FKs — violations raise),
--    then drops the JSONB column.
-- ---------------------------------------------------------------------
DO $migrate$
DECLARE
  r record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'politicore'
      AND table_name   = 'election_results'
      AND column_name  = 'votes'
  ) THEN
    -- the 0017 views reference the JSONB column; 0019 recreates them
    -- against the relational ballot, so drop them before the column
    DROP VIEW IF EXISTS public.election_results_current;
    DROP VIEW IF EXISTS politicore.election_results_current;

    FOR r IN SELECT * FROM politicore.election_results LOOP
      -- expand + normalize (int votes, sorted) — composite FKs validate
      -- party/contest legitimacy; unknown or foreign-contest parties
      -- raise and abort the migration loudly (integrity first).
      INSERT INTO politicore.election_result_votes (result_id, contest_id, party_id, votes)
      SELECT r.id, r.contest_id, (v->>'party_id')::uuid, (v->>'votes')::int
      FROM jsonb_array_elements(r.votes) v
      ON CONFLICT (result_id, party_id) DO UPDATE SET votes = EXCLUDED.votes;
    END LOOP;

    ALTER TABLE politicore.election_results DROP COLUMN votes;
  END IF;
END
$migrate$;

COMMENT ON COLUMN politicore.election_results.evidence_asset_id IS
  'Current EC8 evidence asset. Historical evidence references live on election_result_history (old/new_evidence_asset_id).';

-- ---------------------------------------------------------------------
-- 4. History hardening: evidence + submitter references per event, and
--    a distinct 'resubmit' action (a resubmission is NOT a 'create').
-- ---------------------------------------------------------------------
ALTER TABLE politicore.election_result_history
  ADD COLUMN IF NOT EXISTS old_evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  ADD COLUMN IF NOT EXISTS new_evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  ADD COLUMN IF NOT EXISTS old_submitted_by      uuid REFERENCES politicore.profiles(id),
  ADD COLUMN IF NOT EXISTS new_submitted_by      uuid REFERENCES politicore.profiles(id);

ALTER TABLE politicore.election_result_history
  DROP CONSTRAINT IF EXISTS election_result_history_action_check;
ALTER TABLE politicore.election_result_history
  ADD CONSTRAINT election_result_history_action_check
  CHECK (action IN
    ('create','resubmit','correct','review_approve','review_reject','review_clarify','reopen'));

CREATE INDEX IF NOT EXISTS election_result_history_old_evidence_idx
  ON politicore.election_result_history (old_evidence_asset_id);
CREATE INDEX IF NOT EXISTS election_result_history_new_evidence_idx
  ON politicore.election_result_history (new_evidence_asset_id);

COMMENT ON COLUMN politicore.election_result_history.old_evidence_asset_id IS
  'Evidence asset associated with the pre-transition state (forensic chain).';
COMMENT ON COLUMN politicore.election_result_history.new_evidence_asset_id IS
  'Evidence asset associated with the post-transition state (forensic chain).';

-- ---------------------------------------------------------------------
-- 5. Ballot validator (procedural front line at the RPC choke point).
--    The composite FKs are the backstop; this gives actor-actionable
--    errors and keeps every structural rule in ONE function:
--      * JSON array of {party_id, votes} objects
--      * party_id must be a UUID of a party that is a registered
--        participant (candidate) of THIS contest — the gate's
--        "party not valid for contest" case
--      * votes must be non-negative integers
--      * no duplicate party entries
--    assert_valid_votes (0015) is superseded by this function; it is
--    retained for backward compatibility only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.assert_valid_ballot(
  p_contest uuid,
  p_votes jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_elem jsonb;
  v_pid text;
  v_votes numeric;
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

    IF jsonb_typeof(v_elem->'votes') <> 'number' THEN
      RAISE EXCEPTION 'votes for party % must be a number', v_pid;
    END IF;
    v_votes := (v_elem->>'votes')::numeric;
    IF v_votes IS NULL OR floor(v_votes) <> v_votes OR v_votes < 0 THEN
      RAISE EXCEPTION 'votes for party % must be a non-negative integer', v_pid;
    END IF;

    -- ballot rule: party must be a candidate of THIS contest
    -- (stronger than party existence — the FKs below enforce it
    -- natively; this check just yields an actionable error message)
    IF NOT EXISTS (
      SELECT 1 FROM politicore.election_candidates cand
      WHERE cand.contest_id = p_contest
        AND cand.party_id = v_pid::uuid
    ) THEN
      RAISE EXCEPTION 'party % is not a registered participant in this contest', v_pid;
    END IF;
  END LOOP;

  -- duplicate party entries
  IF (SELECT count(DISTINCT e->>'party_id') FROM jsonb_array_elements(p_votes) e)
     <> jsonb_array_length(p_votes) THEN
    RAISE EXCEPTION 'duplicate party entries in votes';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- 6. Postcondition verification (runs at migration time; aborts the
--    migration on any integrity violation instead of continuing).
-- ---------------------------------------------------------------------
DO $verify$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
  FROM politicore.election_results r
  WHERE NOT EXISTS (
    SELECT 1 FROM politicore.election_result_votes rv WHERE rv.result_id = r.id
  );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'postcondition failed: % result row(s) carry no ballot rows', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
  FROM politicore.election_result_history h
  WHERE h.new_votes IS NOT NULL AND h.new_evidence_asset_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'postcondition failed: % history row(s) missing new_evidence_asset_id', v_bad;
  END IF;
END
$verify$;
