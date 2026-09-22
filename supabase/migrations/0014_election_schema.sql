-- =====================================================================
-- 0014: ELECTION DOMAIN SCHEMA (Phase 1C-Implementation)
--
-- Implements the approved Phase 1C design (docs/Phase1C-Election-Design.md):
--   9 domain tables (cycles, contests, parties, candidates, results,
--   result history, PU reports, incidents, settings), new enums,
--   is_social_only(), two permission rows, and the Election Officer
--   resolver extension (verify_election_result, view_election_results).
--
-- Security architecture (mirrors the 0006 precedent):
--   * Every table RLS ENABLED; app roles (anon/authenticated) are fully
--     policy-governed, deny-by-default.
--   * election_results / election_result_history / notifications are
--     NO FORCE: the Phase 1C workflow RPCs (0015) are SECURITY DEFINER
--     and must write them regardless of the caller's own visibility;
--     all client access still flows through the SELECT-only policies.
--   * election_results has NO INSERT/UPDATE/DELETE policies and clients
--     get SELECT-only grants: direct mutation is impossible; the only
--     writer is the 0015 workflow RPCs.
--   * election_result_history is append-only: SELECT-only grants +
--     REVOKE + an RPC-context guard trigger (0015).
--
-- Legacy Firebase source of truth: src/lib/firebase/election.ts,
-- election-seed.ts, firestore.rules Election surface.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums (legacy vocabularies verbatim)
-- ---------------------------------------------------------------------
CREATE TYPE politicore.election_cycle_status AS ENUM
  ('DRAFT','SCHEDULED','ACTIVE','PAUSED','CLOSED','ARCHIVED');

CREATE TYPE politicore.contest_type AS ENUM
  ('presidential','governorship','senatorial','federal_house','state_house');

CREATE TYPE politicore.contest_scope_type AS ENUM
  ('national','state','senatorial_zone','federal_constituency','state_constituency');

CREATE TYPE politicore.contest_status AS ENUM ('DRAFT','OPEN','PAUSED','CLOSED');

CREATE TYPE politicore.collation_status AS ENUM ('NOT_STARTED','IN_PROGRESS','COMPLETED');

CREATE TYPE politicore.result_status AS ENUM
  ('submitted','pending_review','approved','rejected','clarification_required','reopened');

CREATE TYPE politicore.pu_report_type AS ENUM ('opening','turnout','conduct','closing','general');

CREATE TYPE politicore.pu_report_status AS ENUM ('submitted','under_review','acknowledged');

CREATE TYPE politicore.incident_type AS ENUM
  ('ballot_snatching','violence','bvas_malfunction','late_arrival','vote_buying','other');

CREATE TYPE politicore.incident_severity AS ENUM ('low','medium','high','critical');

CREATE TYPE politicore.incident_status AS ENUM ('reported','investigating','resolved','dismissed');

-- ---------------------------------------------------------------------
-- is_social_only(): the Firestore-rules social-only exclusion, as SQL.
-- social membership AND no campaign membership AND no admin authority
-- AND no Election Officer authority. A Campaign Member is NEVER
-- social-only. Used by every Election policy (layer 4 of 4).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.is_social_only()
RETURNS boolean AS $$
  SELECT politicore.has_membership('social_member')
     AND NOT politicore.has_membership('campaign_member')
     AND NOT politicore.is_admin()
     AND NOT politicore.is_election_officer();
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- 1. political_parties — platform-level reference data (mirrors the
--    legacy world-readable `political_parties` collection; writes are
--    platform-admin only). Votes reference party IDs, never names.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.political_parties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acronym         text NOT NULL UNIQUE,
  name            text NOT NULL,
  logo_url        text,
  color           text,
  inec_registered boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2. election_cycles — one electoral event period (e.g. "2027 General
--    Election") containing many contests.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_cycles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES politicore.tenants(id),
  name        text NOT NULL,
  year        integer NOT NULL CHECK (year BETWEEN 1900 AND 2300),
  description text,
  status      politicore.election_cycle_status NOT NULL DEFAULT 'DRAFT',
  start_date  date,
  end_date    date,
  created_by  uuid REFERENCES politicore.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX election_cycles_tenant_status_idx ON politicore.election_cycles (tenant_id, status);

-- ---------------------------------------------------------------------
-- 3. election_contests — a race within a period; the unit result
--    submission is authorized against. Contest geography reuses the
--    existing hierarchy: state/senatorial_zone scopes are FK-validated
--    via helper columns; constituency scopes carry their LGA set
--    (validated by the 0015 helper) because constituencies are not
--    geography rows in the foundation hierarchy.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_contests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  election_cycle_id uuid NOT NULL REFERENCES politicore.election_cycles(id) ON DELETE RESTRICT,
  contest_type      politicore.contest_type NOT NULL,
  name              text NOT NULL,
  scope_type        politicore.contest_scope_type NOT NULL,
  scope_id          text,
  scope_lgas        text[] NOT NULL DEFAULT '{}',
  state_id          text REFERENCES politicore.states(id),
  zone_id           text REFERENCES politicore.senatorial_zones(id),
  election_date     date,
  status            politicore.contest_status NOT NULL DEFAULT 'DRAFT',
  collation_status  politicore.collation_status NOT NULL DEFAULT 'NOT_STARTED',
  tracked_parties   text[] NOT NULL DEFAULT '{}',
  focus_party_id    uuid REFERENCES politicore.political_parties(id),
  created_by        uuid REFERENCES politicore.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, election_cycle_id, contest_type, name),
  -- structural validity per scope type (shape-level; semantic validity
  -- is asserted by assert_valid_contest_scope() in the 0015 RPCs):
  CHECK (
    (scope_type = 'national' AND scope_id IS NULL AND scope_lgas = '{}')
    OR (scope_type = 'state' AND scope_id IS NOT NULL AND scope_lgas = '{}')
    OR (scope_type = 'senatorial_zone' AND scope_id IS NOT NULL AND scope_lgas = '{}')
    OR (scope_type IN ('federal_constituency','state_constituency')
        AND cardinality(scope_lgas) > 0)
  ),
  CHECK (state_id IS NULL OR zone_id IS NULL OR TRUE)  -- both optional; semantics validated in helper
);
CREATE INDEX election_contests_cycle_idx ON politicore.election_contests (election_cycle_id);
CREATE INDEX election_contests_tenant_status_idx ON politicore.election_contests (tenant_id, status);

-- ---------------------------------------------------------------------
-- 4. election_candidates — contest participation. Historical integrity:
--    deactivation is data (is_active), never row deletion.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_candidates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  contest_id        uuid NOT NULL REFERENCES politicore.election_contests(id) ON DELETE RESTRICT,
  party_id          uuid NOT NULL REFERENCES politicore.political_parties(id),
  candidate_name    text NOT NULL,
  running_mate_name text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contest_id, party_id)
);
CREATE INDEX election_candidates_tenant_idx ON politicore.election_candidates (tenant_id, contest_id);

-- ---------------------------------------------------------------------
-- 5. election_results — the PU-level result. Relational identity:
--    (tenant_id, contest_id, polling_unit_id). Geography columns are
--    denormalized for RLS locality (wards/polling_units precedent) and
--    are DERIVED from the polling unit by the submit RPC — clients
--    cannot supply them. verified = (status='approved') is a database
--    invariant. Evidence is mandatory (media_assets, purpose-gated in
--    the submit RPC). No DELETE policy and no client write grants.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_results (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  election_cycle_id uuid NOT NULL REFERENCES politicore.election_cycles(id) ON DELETE RESTRICT,
  contest_id        uuid NOT NULL REFERENCES politicore.election_contests(id) ON DELETE RESTRICT,
  polling_unit_id   text NOT NULL REFERENCES politicore.polling_units(id),
  ward_id           text NOT NULL REFERENCES politicore.wards(id),
  lga_id            text NOT NULL REFERENCES politicore.lgas(id),
  votes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            politicore.result_status NOT NULL DEFAULT 'submitted',
  verified          boolean NOT NULL DEFAULT false,
  reviewed_by       uuid REFERENCES politicore.profiles(id),
  review_notes      text,
  reviewed_at       timestamptz,
  evidence_asset_id uuid NOT NULL REFERENCES politicore.media_assets(id),
  submitted_by      uuid NOT NULL REFERENCES politicore.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contest_id, polling_unit_id),
  CHECK (verified = (status = 'approved')),
  -- vote template: [{party_id uuid, votes int>=0}] — party existence is
  -- validated by the 0015 RPC choke point (no FK into jsonb).
  CHECK (jsonb_typeof(votes) = 'array')
);
CREATE INDEX election_results_tenant_contest_status_idx ON politicore.election_results (tenant_id, contest_id, status);
CREATE INDEX election_results_tenant_ward_idx ON politicore.election_results (tenant_id, ward_id);
CREATE INDEX election_results_submitter_idx ON politicore.election_results (submitted_by);

-- ---------------------------------------------------------------------
-- 6. election_result_history — the legacy in-document history[] array,
--    promoted to an INSERT-only table. Only the 0015 workflow RPCs
--    write it (RPC-context guard trigger in 0015; SELECT-only grants).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_result_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES politicore.tenants(id),
  result_id  uuid NOT NULL REFERENCES politicore.election_results(id) ON DELETE RESTRICT,
  action     text NOT NULL CHECK (action IN
             ('create','correct','review_approve','review_reject','review_clarify','reopen')),
  actor_id   uuid NOT NULL REFERENCES politicore.profiles(id),
  old_status politicore.result_status,
  new_status politicore.result_status,
  old_votes  jsonb,
  new_votes  jsonb,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX election_result_history_result_idx ON politicore.election_result_history (result_id, created_at DESC);
CREATE INDEX election_result_history_tenant_idx ON politicore.election_result_history (tenant_id);

-- ---------------------------------------------------------------------
-- 7. pu_reports — election-day operational reports (distinct from
--    results and incidents).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.pu_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  ward_id           text NOT NULL REFERENCES politicore.wards(id),
  polling_unit_id   text NOT NULL REFERENCES politicore.polling_units(id),
  report_type       politicore.pu_report_type NOT NULL,
  title             text NOT NULL,
  content           text NOT NULL,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  status            politicore.pu_report_status NOT NULL DEFAULT 'submitted',
  submitted_by      uuid NOT NULL REFERENCES politicore.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pu_reports_tenant_ward_idx ON politicore.pu_reports (tenant_id, ward_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 8. election_incidents — election-day incidents with severity and a
--    status workflow. Distinct from results and PU reports.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  ward_id           text NOT NULL REFERENCES politicore.wards(id),
  polling_unit_id   text REFERENCES politicore.polling_units(id),
  incident_type     politicore.incident_type NOT NULL,
  severity          politicore.incident_severity NOT NULL,
  description       text NOT NULL,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  status            politicore.incident_status NOT NULL DEFAULT 'reported',
  reported_by       uuid NOT NULL REFERENCES politicore.profiles(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX election_incidents_tenant_status_idx ON politicore.election_incidents (tenant_id, status, created_at DESC);
CREATE INDEX election_incidents_reporter_idx ON politicore.election_incidents (reported_by);

-- ---------------------------------------------------------------------
-- 9. election_settings — the admin-controlled active election+contest
--    combination (one row per tenant). Election-specific operational
--    configuration; deliberately NOT generic tenant_settings.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.election_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES politicore.tenants(id),
  active_cycle_id  uuid REFERENCES politicore.election_cycles(id) ON DELETE SET NULL,
  active_contest_id uuid REFERENCES politicore.election_contests(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES politicore.profiles(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_touch_political_parties  BEFORE UPDATE ON politicore.political_parties
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_touch_election_cycles    BEFORE UPDATE ON politicore.election_cycles
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_touch_election_contests  BEFORE UPDATE ON politicore.election_contests
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_touch_election_candidates BEFORE UPDATE ON politicore.election_candidates
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_touch_election_results   BEFORE UPDATE ON politicore.election_results
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

-- ---------------------------------------------------------------------
-- tracked_parties integrity: acronyms must exist in political_parties.
-- (Config-table guard; votes integrity lives in the 0015 RPC choke
-- points because Postgres cannot FK into jsonb.)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_tracked_parties()
RETURNS trigger AS $$
BEGIN
  IF NEW.tracked_parties IS NOT NULL AND NEW.tracked_parties <> '{}' THEN
    IF EXISTS (
      SELECT 1 FROM unnest(NEW.tracked_parties) AS a
      WHERE NOT EXISTS (SELECT 1 FROM politicore.political_parties p WHERE p.acronym = a)
    ) THEN
      RAISE EXCEPTION 'tracked_parties contains an unknown party acronym';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_guard_tracked_parties
  BEFORE INSERT OR UPDATE OF tracked_parties ON politicore.election_contests
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_tracked_parties();

-- ---------------------------------------------------------------------
-- RLS: enable on every Election table. FORCE everywhere except the
-- three tables the SECURITY DEFINER workflow layer must write as the
-- table owner (0006 precedent: NO FORCE = owner write path; app roles
-- remain fully policy-governed).
-- ---------------------------------------------------------------------
ALTER TABLE politicore.political_parties      ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.political_parties      FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_cycles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_cycles        FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_contests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_contests      FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_candidates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_candidates    FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_results       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_result_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_result_history NO FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.pu_reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.pu_reports             FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_incidents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_incidents     FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.election_settings      FORCE ROW LEVEL SECURITY;

-- Foundation dependency (same class of fix as 0006): the 0015 SECURITY
-- DEFINER notification helper writes politicore.notifications on behalf
-- of non-admin actors (e.g. a campaign member's submission notifying
-- officers). FORCE would subject the owner to the admin-only INSERT
-- policy and break that server-side path. NO FORCE restores the owner
-- write path; policy enforcement for anon/authenticated/service_role is
-- UNCHANGED.
ALTER TABLE politicore.notifications NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------

-- political_parties: world-readable (legacy parity); platform-admin writes
CREATE POLICY parties_read ON politicore.political_parties FOR SELECT USING (true);
CREATE POLICY parties_admin ON politicore.political_parties FOR ALL USING (politicore.is_platform_admin());

-- Election config (cycles/contests/candidates): tenant members read
-- (module-gated, social-only excluded); tenant admin manages.
CREATE POLICY cycles_read ON politicore.election_cycles FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
);
CREATE POLICY cycles_admin ON politicore.election_cycles FOR ALL USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);

CREATE POLICY contests_read ON politicore.election_contests FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
);
CREATE POLICY contests_admin ON politicore.election_contests FOR ALL USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);

CREATE POLICY candidates_read ON politicore.election_candidates FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
);
CREATE POLICY candidates_admin ON politicore.election_candidates FOR ALL USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);

-- election_results: SELECT-only for clients, scoped per the approved
-- matrix — admin/officer tenant-wide; scoped view_election_results via
-- the resolver (hierarchical inheritance); registered-PU campaign
-- members see their own registered PU. No INSERT/UPDATE/DELETE policies
-- (workflow RPCs are the only mutation path; delete never).
CREATE POLICY results_read ON politicore.election_results FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
  AND (
    politicore.is_admin()
    OR politicore.is_election_officer()
    OR politicore.has_permission('view_election_results', 'polling_unit', polling_unit_id)
    OR (
      EXISTS (
        SELECT 1 FROM politicore.profiles p
        WHERE p.id = auth.uid()
          AND p.polling_unit_id = election_results.polling_unit_id
          AND 'campaign_member' = ANY (p.membership_types)
      )
    )
  )
);

-- election_result_history: participants only (submitter sees the trail
-- of their result; officers/admins tenant-wide). No client writes.
CREATE POLICY history_read ON politicore.election_result_history FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
  AND (
    politicore.is_admin()
    OR politicore.is_election_officer()
    OR EXISTS (
      SELECT 1 FROM politicore.election_results r
      WHERE r.id = election_result_history.result_id
        AND r.submitted_by = auth.uid()
    )
  )
);

-- pu_reports: submitter + admin/officer tenant-wide + registered-PU
-- campaign members; creation geo-restricted via the existing
-- submit_election_pu_report permission (hierarchical) or registered PU.
CREATE POLICY pu_reports_read ON politicore.pu_reports FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
  AND (
    submitted_by = auth.uid()
    OR politicore.is_admin()
    OR politicore.is_election_officer()
    OR EXISTS (
      SELECT 1 FROM politicore.profiles p
      WHERE p.id = auth.uid()
        AND (p.polling_unit_id = pu_reports.polling_unit_id OR p.ward_id = pu_reports.ward_id)
        AND 'campaign_member' = ANY (p.membership_types)
    )
  )
);
CREATE POLICY pu_reports_insert ON politicore.pu_reports FOR INSERT WITH CHECK (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
  AND submitted_by = auth.uid()
  AND (
    politicore.has_permission('submit_election_pu_report', 'polling_unit', polling_unit_id)
    OR EXISTS (
      SELECT 1 FROM politicore.profiles p
      WHERE p.id = auth.uid()
        AND p.polling_unit_id = pu_reports.polling_unit_id
        AND 'campaign_member' = ANY (p.membership_types)
    )
  )
);
CREATE POLICY pu_reports_admin ON politicore.pu_reports FOR UPDATE USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);
CREATE POLICY pu_reports_delete ON politicore.pu_reports FOR DELETE USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);

-- election_incidents: reporter + admin/officer + registered-geo members;
-- creation via submit_election_incident (ward/PU-scoped) or registered geo.
CREATE POLICY incidents_read ON politicore.election_incidents FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
  AND (
    reported_by = auth.uid()
    OR politicore.is_admin()
    OR politicore.is_election_officer()
    OR EXISTS (
      SELECT 1 FROM politicore.profiles p
      WHERE p.id = auth.uid()
        AND (p.ward_id = election_incidents.ward_id
             OR (election_incidents.polling_unit_id IS NOT NULL
                 AND p.polling_unit_id = election_incidents.polling_unit_id))
        AND 'campaign_member' = ANY (p.membership_types)
    )
  )
);
CREATE POLICY incidents_insert ON politicore.election_incidents FOR INSERT WITH CHECK (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
  AND reported_by = auth.uid()
  AND (
    (polling_unit_id IS NOT NULL
       AND politicore.has_permission('submit_election_incident', 'polling_unit', polling_unit_id))
    OR (polling_unit_id IS NULL
       AND politicore.has_permission('submit_election_incident', 'ward', ward_id))
    OR EXISTS (
      SELECT 1 FROM politicore.profiles p
      WHERE p.id = auth.uid()
        AND (p.ward_id = election_incidents.ward_id
             OR (election_incidents.polling_unit_id IS NOT NULL
                 AND p.polling_unit_id = election_incidents.polling_unit_id))
        AND 'campaign_member' = ANY (p.membership_types)
    )
  )
);
CREATE POLICY incidents_admin ON politicore.election_incidents FOR UPDATE USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);
CREATE POLICY incidents_delete ON politicore.election_incidents FOR DELETE USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);

-- election_settings: non-social members read; tenant admin writes; no delete.
CREATE POLICY settings_read ON politicore.election_settings FOR SELECT USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND NOT politicore.is_social_only()
);
CREATE POLICY settings_insert_admin ON politicore.election_settings FOR INSERT WITH CHECK (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);
CREATE POLICY settings_update_admin ON politicore.election_settings FOR UPDATE USING (
  tenant_id = politicore.current_tenant_id()
  AND politicore.module_enabled('election')
  AND politicore.is_tenant_admin()
);

-- ---------------------------------------------------------------------
-- Privilege surface (mirrors 0006; hosted default privileges would
-- otherwise grant ALL — results/history are deliberately read-only for
-- clients, append-only history is REVOKE-hardened).
-- ---------------------------------------------------------------------
GRANT SELECT ON politicore.political_parties TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON politicore.political_parties TO service_role;

GRANT SELECT ON politicore.election_cycles, politicore.election_contests,
  politicore.election_candidates, politicore.election_results,
  politicore.election_result_history, politicore.pu_reports,
  politicore.election_incidents, politicore.election_settings
  TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON politicore.election_cycles,
  politicore.election_contests, politicore.election_candidates,
  politicore.election_settings TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON politicore.pu_reports,
  politicore.election_incidents TO authenticated, service_role;

-- results: no client mutation path at all (RPC-only writes)
REVOKE INSERT, UPDATE, DELETE ON politicore.election_results FROM authenticated, anon;
-- history: append-only (RPC-only writes; no UPDATE/DELETE for anyone but owner)
REVOKE INSERT, UPDATE, DELETE ON politicore.election_result_history FROM authenticated, anon;

-- ---------------------------------------------------------------------
-- Permission vocabulary: the two design-identified gaps (idempotent).
-- ---------------------------------------------------------------------
INSERT INTO politicore.permissions (name, domain, description) VALUES
  ('view_election_results','election','View election results within the holder''s geographic scope'),
  ('verify_election_result','election','Review, approve, reject, request clarification for, or reopen election results')
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------
-- Election Officer resolver extension: the officer fixed set gains the
-- two permissions above (additive; nothing removed). Admins keep the
-- existing bypass; separation of duties for admin-corrected results is
-- enforced inside review_election_result() (0015) per the approved
-- design decision §11.2(a) — no global resolver semantics change.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.has_permission(
  p_permission text,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
) RETURNS boolean AS $$
  WITH ctx AS (SELECT * FROM politicore.current_profile())
  SELECT
    CASE
      WHEN (SELECT access_role FROM ctx) IN ('admin','tenant_super_admin','platform_super_admin')
        THEN true
      WHEN (SELECT access_role FROM ctx) = 'election_officer'
        THEN p_permission IN ('view_dashboard','submit_election_pu_report',
             'submit_election_incident','upload_election_result','view_election_dashboard',
             'verify_election_result','view_election_results')
      ELSE
        CASE
          WHEN EXISTS (
            SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.permission = p_permission
              AND g.granted = false
              AND (g.scope_type IS NULL OR
                   (p_scope_type IS NOT NULL AND politicore.scope_covers(g.scope_type, g.scope_id, p_scope_type, p_scope_id)))
          ) THEN false
          WHEN EXISTS (
            SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.permission = p_permission
              AND g.granted = true
              AND (g.scope_type IS NULL OR
                   (p_scope_type IS NOT NULL AND politicore.scope_covers(g.scope_type, g.scope_id, p_scope_type, p_scope_id)))
          ) THEN true
          ELSE
            EXISTS (
              SELECT 1 FROM politicore.my_scopes() s
              JOIN politicore.position_permissions pp ON pp.position = s.position_name
              WHERE pp.permission = p_permission
                AND (p_scope_type IS NULL OR politicore.scope_covers(s.scope_type, s.scope_id, p_scope_type, p_scope_id))
            )
        END
    END;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- Configuration audit: reuse the existing system_audits definer trigger
-- (0002 pattern) — no parallel audit system.
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_audit_election_cycles
  AFTER INSERT OR UPDATE OR DELETE ON politicore.election_cycles
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_election_contests
  AFTER INSERT OR UPDATE OR DELETE ON politicore.election_contests
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_election_candidates
  AFTER INSERT OR UPDATE OR DELETE ON politicore.election_candidates
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_election_settings
  AFTER INSERT OR UPDATE OR DELETE ON politicore.election_settings
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_political_parties
  AFTER INSERT OR UPDATE OR DELETE ON politicore.political_parties
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
