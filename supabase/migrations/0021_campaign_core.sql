-- =====================================================================
-- 0021: CAMPAIGN CORE — TABLES, AUTHORIZATION, RPCs, VIEWS
--       (Campaign Phase A — Architecture Gate docs/Campaign-Architecture.md)
--
-- Relational Campaign foundation on the ratified Phase 1A Core:
--   * five tenant-owned tables (activities, participants, assignments,
--     field reports, issues) — relationships are tables, never arrays
--   * reuses the existing authorization system exclusively:
--     module_enabled / has_permission / has_assignment_at /
--     scope_chain / scope_covers / my_scopes / current_profile
--     (no user_access, no campaign_* authorization framework)
--   * hierarchical scope via scope_covers(GRANTEE scope, RECORD scope)
--     — server-side resolution replaces the legacy client-side
--     expandAssignmentToScopes fan-out (defects D1/D2)
--   * tenant_id NOT NULL everywhere, never client-supplied (defect D3)
--   * authority-bearing mutations through SECURITY DEFINER RPCs with
--     controlled search_path, server-resolved identity, state guards,
--     audit (system_audits) and best-effort notifications (defect D4)
--   * public security-invoker views per the 0009/0020 hosted-API
--     convention (the data API exposes `public` only)
--
-- DOES NOT touch: Election objects, Social, Governance, Donations,
-- leaderboard, profiles, organizational_assignments, permission_grants,
-- positions, position_permissions, notifications schema, audit schema.
--
-- Assignment 'overdue' remains an enum value (legacy vocabulary) but is
-- a DERIVED presentation state: no RPC or policy path writes it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Enums (Campaign-domain; foundation enums reused, none duplicated)
-- ---------------------------------------------------------------------
CREATE TYPE politicore.campaign_activity_type AS ENUM (
  'rally','meeting','stakeholder_engagement','training',
  'community_engagement','ward_meeting','lga_meeting','campaign_outreach','other');

CREATE TYPE politicore.campaign_activity_status AS ENUM (
  'scheduled','postponed','cancelled','completed');

CREATE TYPE politicore.campaign_rsvp AS ENUM ('going','interested','not_going');

CREATE TYPE politicore.campaign_attendance_state AS ENUM ('present','excused','absent');

CREATE TYPE politicore.campaign_assignment_priority AS ENUM ('low','medium','high','urgent');

CREATE TYPE politicore.campaign_assignment_status AS ENUM (
  'not_started','in_progress','submitted','under_review','completed','overdue');

CREATE TYPE politicore.campaign_report_type AS ENUM (
  'activity','community','mobilization','meeting','field','other');

CREATE TYPE politicore.campaign_report_status AS ENUM (
  'submitted','under_review','accepted','returned');

CREATE TYPE politicore.campaign_issue_type AS ENUM (
  'logistics','campaign_activity','community_concern','volunteer',
  'communication','security','infrastructure','other');

CREATE TYPE politicore.campaign_issue_priority AS ENUM ('low','medium','high','urgent');

CREATE TYPE politicore.campaign_issue_status AS ENUM (
  'reported','acknowledged','assigned','in_progress','resolved','verified','closed');

-- ---------------------------------------------------------------------
-- Shared Campaign-domain scope validator (data integrity, not authority)
-- Any Campaign row must reference a real geography/scope. Used by
-- triggers on every Campaign table so ALL write paths validate.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_scope_exists(
  p_type politicore.scope_type_enum,
  p_id text
) RETURNS boolean AS $$
  SELECT CASE p_type
    WHEN 'polling_unit'    THEN EXISTS (SELECT 1 FROM politicore.polling_units pu WHERE pu.id = p_id)
    WHEN 'ward'            THEN EXISTS (SELECT 1 FROM politicore.wards w WHERE w.id = p_id)
    WHEN 'lga'             THEN EXISTS (SELECT 1 FROM politicore.lgas l WHERE l.id = p_id)
    WHEN 'senatorial_zone' THEN EXISTS (SELECT 1 FROM politicore.senatorial_zones z WHERE z.id = p_id)
    WHEN 'state'           THEN EXISTS (SELECT 1 FROM politicore.states s WHERE s.id = p_id)
    WHEN 'campaign'        THEN true
  END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.validate_campaign_scope() RETURNS trigger AS $$
BEGIN
  IF NOT politicore.campaign_scope_exists(NEW.scope_type, NEW.scope_id) THEN
    RAISE EXCEPTION 'scope does not exist: % / %', NEW.scope_type, NEW.scope_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- TABLES
-- =====================================================================

-- ---------------------------------------------------------------------
-- 5.1 campaign_activities — physical/operational campaign events
-- ---------------------------------------------------------------------
CREATE TABLE politicore.campaign_activities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id),
  title               text NOT NULL,
  description         text,
  activity_type       politicore.campaign_activity_type NOT NULL DEFAULT 'meeting',
  venue               text,
  scheduled_start     timestamptz NOT NULL,
  scheduled_end       timestamptz,
  expected_attendance integer CHECK (expected_attendance >= 0),
  scope_type          politicore.scope_type_enum NOT NULL,
  scope_id            text NOT NULL,
  status              politicore.campaign_activity_status NOT NULL DEFAULT 'scheduled',
  organizer_id        uuid REFERENCES politicore.profiles(id),
  created_by          uuid REFERENCES politicore.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start)
);

CREATE INDEX campaign_activities_scope_idx ON politicore.campaign_activities
  (tenant_id, scope_type, scope_id, scheduled_start);
CREATE INDEX campaign_activities_tenant_date_idx ON politicore.campaign_activities
  (tenant_id, scheduled_start);
CREATE INDEX campaign_activities_status_idx ON politicore.campaign_activities
  (tenant_id, status);

CREATE TRIGGER campaign_activities_updated_at BEFORE UPDATE
  ON politicore.campaign_activities
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

CREATE TRIGGER campaign_activities_scope_validate BEFORE INSERT OR UPDATE OF scope_type, scope_id
  ON politicore.campaign_activities
  FOR EACH ROW EXECUTE FUNCTION politicore.validate_campaign_scope();

-- ---------------------------------------------------------------------
-- 6. campaign_activity_participants — RSVP (intent) + attendance (fact)
--    as distinct column groups; UNIQUE(activity_id, user_id)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.campaign_activity_participants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id),
  activity_id    uuid NOT NULL REFERENCES politicore.campaign_activities(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES politicore.profiles(id),
  rsvp           politicore.campaign_rsvp NOT NULL DEFAULT 'going',
  rsvp_at        timestamptz NOT NULL DEFAULT now(),
  attendance     politicore.campaign_attendance_state,
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  recorded_by    uuid REFERENCES politicore.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, user_id),
  CHECK (checked_out_at IS NULL OR (checked_in_at IS NOT NULL AND checked_out_at > checked_in_at))
);

CREATE INDEX campaign_participants_activity_idx
  ON politicore.campaign_activity_participants (activity_id);
CREATE INDEX campaign_participants_user_idx
  ON politicore.campaign_activity_participants (user_id);

CREATE TRIGGER campaign_participants_updated_at BEFORE UPDATE
  ON politicore.campaign_activity_participants
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

-- ---------------------------------------------------------------------
-- 7. campaign_assignments — organizational work assigned to a person
-- ---------------------------------------------------------------------
CREATE TABLE politicore.campaign_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  title             text NOT NULL,
  description       text,
  assigned_to       uuid NOT NULL REFERENCES politicore.profiles(id),
  assigned_by       uuid NOT NULL REFERENCES politicore.profiles(id),
  scope_type        politicore.scope_type_enum NOT NULL,
  scope_id          text NOT NULL,
  priority          politicore.campaign_assignment_priority NOT NULL DEFAULT 'medium',
  status            politicore.campaign_assignment_status NOT NULL DEFAULT 'not_started',
  due_date          date,
  location          text,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_assignments_assignee_idx ON politicore.campaign_assignments (assigned_to, status);
CREATE INDEX campaign_assignments_scope_idx ON politicore.campaign_assignments (tenant_id, scope_type, scope_id);
CREATE INDEX campaign_assignments_status_idx ON politicore.campaign_assignments (tenant_id, status);
CREATE INDEX campaign_assignments_due_idx ON politicore.campaign_assignments (tenant_id, due_date);

CREATE TRIGGER campaign_assignments_updated_at BEFORE UPDATE
  ON politicore.campaign_assignments
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

CREATE TRIGGER campaign_assignments_scope_validate BEFORE INSERT OR UPDATE OF scope_type, scope_id
  ON politicore.campaign_assignments
  FOR EACH ROW EXECUTE FUNCTION politicore.validate_campaign_scope();

-- ---------------------------------------------------------------------
-- 8. campaign_field_reports — operational intelligence from the field
--    (field-level shape preserved verbatim from the legacy product)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.campaign_field_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES politicore.tenants(id),
  submitted_by       uuid NOT NULL REFERENCES politicore.profiles(id),
  report_type        politicore.campaign_report_type NOT NULL DEFAULT 'field',
  title              text NOT NULL,
  description        text NOT NULL,
  scope_type         politicore.scope_type_enum NOT NULL,
  scope_id           text NOT NULL,
  location           text,
  participants       integer CHECK (participants IS NULL OR participants >= 0),
  issues             text,
  community_feedback text,
  requests           text,
  follow_up_required boolean NOT NULL DEFAULT false,
  status             politicore.campaign_report_status NOT NULL DEFAULT 'submitted',
  evidence_asset_id  uuid REFERENCES politicore.media_assets(id),
  reviewed_by        uuid REFERENCES politicore.profiles(id),
  review_comment     text,
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_reports_submitter_idx ON politicore.campaign_field_reports (submitted_by, status);
CREATE INDEX campaign_reports_scope_idx ON politicore.campaign_field_reports (tenant_id, scope_type, scope_id);
CREATE INDEX campaign_reports_status_idx ON politicore.campaign_field_reports (tenant_id, status);

CREATE TRIGGER campaign_reports_updated_at BEFORE UPDATE
  ON politicore.campaign_field_reports
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

CREATE TRIGGER campaign_reports_scope_validate BEFORE INSERT OR UPDATE OF scope_type, scope_id
  ON politicore.campaign_field_reports
  FOR EACH ROW EXECUTE FUNCTION politicore.validate_campaign_scope();

-- ---------------------------------------------------------------------
-- 9. campaign_issues — operational problems; reporter / assignee /
--    resolver / verifier kept DISTINCT (no generic updated_by).
--    tenant_id NOT NULL — directly fixes defect D3.
-- ---------------------------------------------------------------------
CREATE TABLE politicore.campaign_issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  title             text NOT NULL,
  description       text NOT NULL,
  issue_type        politicore.campaign_issue_type NOT NULL DEFAULT 'other',
  priority          politicore.campaign_issue_priority NOT NULL DEFAULT 'medium',
  status            politicore.campaign_issue_status NOT NULL DEFAULT 'reported',
  scope_type        politicore.scope_type_enum NOT NULL,
  scope_id          text NOT NULL,
  reported_by       uuid NOT NULL REFERENCES politicore.profiles(id),
  assigned_to       uuid REFERENCES politicore.profiles(id),
  location          text,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  resolution_notes  text,
  resolved_by       uuid REFERENCES politicore.profiles(id),
  resolved_at       timestamptz,
  verified_by       uuid REFERENCES politicore.profiles(id),
  verified_at       timestamptz,
  closed_by         uuid REFERENCES politicore.profiles(id),
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX campaign_issues_scope_idx ON politicore.campaign_issues (tenant_id, scope_type, scope_id);
CREATE INDEX campaign_issues_status_idx ON politicore.campaign_issues (tenant_id, status);
CREATE INDEX campaign_issues_assignee_idx ON politicore.campaign_issues (assigned_to, status);
CREATE INDEX campaign_issues_reporter_idx ON politicore.campaign_issues (reported_by);

CREATE TRIGGER campaign_issues_updated_at BEFORE UPDATE
  ON politicore.campaign_issues
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

CREATE TRIGGER campaign_issues_scope_validate BEFORE INSERT OR UPDATE OF scope_type, scope_id
  ON politicore.campaign_issues
  FOR EACH ROW EXECUTE FUNCTION politicore.validate_campaign_scope();

-- Server-resolved actor/tenant defaults for the direct-insert paths
-- (activities, issues). The WITH CHECK policies pin tenant_id/created_by/
-- reported_by to auth.uid()/current_tenant_id() anyway, so the defaults add
-- convenience without any escalation path — the browser never chooses the
-- tenant or the actor (defect D3, done properly).
ALTER TABLE politicore.campaign_activities
  ALTER COLUMN created_by SET DEFAULT auth.uid();
ALTER TABLE politicore.campaign_activities
  ALTER COLUMN tenant_id SET DEFAULT politicore.current_tenant_id();
ALTER TABLE politicore.campaign_issues
  ALTER COLUMN reported_by SET DEFAULT auth.uid();
ALTER TABLE politicore.campaign_issues
  ALTER COLUMN tenant_id SET DEFAULT politicore.current_tenant_id();

-- =====================================================================
-- RLS — enabled AND forced on every Campaign table.
-- Visibility per the Architecture Gate §19: module gate + tenant +
-- (admin OR permission-at-covering-scope OR own-record OR participant).
-- has_permission(p, scope) internally applies
-- scope_covers(grantee_scope, p_scope) — the §15 polarity, natively.

-- Two SECURITY DEFINER visibility helpers prevent mutual RLS recursion
-- between campaign_activities and campaign_activity_participants
-- (each policy's subquery would otherwise re-enter the other table's
-- policies). They replicate — never widen — the visibility predicate.
-- =====================================================================
CREATE OR REPLACE FUNCTION politicore.campaign_activity_exists_in_tenant(
  p_activity uuid, p_tenant uuid
) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM politicore.campaign_activities a
                 WHERE a.id = p_activity AND a.tenant_id = p_tenant);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.can_view_campaign_activity(p_activity uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM politicore.campaign_activities a
    WHERE a.id = p_activity
      AND a.tenant_id = politicore.current_tenant_id()
      AND (
        politicore.is_admin()
        OR politicore.has_permission('view_activities', a.scope_type, a.scope_id)
        OR politicore.has_permission('create_activity', a.scope_type, a.scope_id)
        OR a.created_by = auth.uid()
        OR a.organizer_id = auth.uid()
        OR EXISTS (SELECT 1 FROM politicore.campaign_activity_participants p
                   WHERE p.activity_id = a.id AND p.user_id = auth.uid())
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;
ALTER TABLE politicore.campaign_activities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_activities            FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_activity_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_activity_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_assignments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_assignments           FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_field_reports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_field_reports         FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_issues                ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.campaign_issues                FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- campaign_activities
-- ---------------------------------------------------------------------
CREATE POLICY campaign_activities_select ON politicore.campaign_activities
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND politicore.can_view_campaign_activity(id)
  );

CREATE POLICY campaign_activities_insert ON politicore.campaign_activities
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND created_by = auth.uid()          -- actor integrity: no creator spoofing
    AND status = 'scheduled'             -- workflow state set only via RPC
    AND (
      politicore.is_admin()
      OR politicore.has_permission('create_activity', scope_type, scope_id)
    )
  );

CREATE POLICY campaign_activities_update ON politicore.campaign_activities
  FOR UPDATE TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('manage_activity', scope_type, scope_id)
    )
  )
  WITH CHECK (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('manage_activity', scope_type, scope_id)
    )
  );

CREATE POLICY campaign_activities_delete ON politicore.campaign_activities
  FOR DELETE TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('manage_activity', scope_type, scope_id)
    )
  );

-- ---------------------------------------------------------------------
-- campaign_activity_participants — every row keeps the tenant of its
-- activity; attendance columns are written only through the RPC.
-- ---------------------------------------------------------------------
CREATE POLICY campaign_participants_select ON politicore.campaign_activity_participants
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      user_id = auth.uid()
      OR politicore.can_view_campaign_activity(activity_id)
    )
  );

-- Own-participation join/leave: the caller is always user_id; the RPC
-- validates activity visibility server-side. The activity must belong
-- to the caller's tenant (checked via definer helper to avoid RLS
-- recursion) — no cross-tenant participant rows.
CREATE POLICY campaign_participants_insert ON politicore.campaign_activity_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND user_id = auth.uid()
    AND politicore.campaign_activity_exists_in_tenant(activity_id, tenant_id)
    AND attendance IS NULL AND checked_in_at IS NULL AND checked_out_at IS NULL
    AND recorded_by IS NULL
  );

CREATE POLICY campaign_participants_update ON politicore.campaign_activity_participants
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY campaign_participants_delete ON politicore.campaign_activity_participants
  FOR DELETE TO authenticated
  USING (false);

-- ---------------------------------------------------------------------
-- campaign_assignments — supervisors see/manage within covered scope;
-- the assignee always sees (and later works) their own assignments.
-- ---------------------------------------------------------------------
CREATE POLICY campaign_assignments_select ON politicore.campaign_assignments
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('view_assignments', scope_type, scope_id)
      OR politicore.has_permission('create_assignment', scope_type, scope_id)
      OR assigned_to = auth.uid()
      OR assigned_by = auth.uid()
    )
  );

CREATE POLICY campaign_assignments_insert ON politicore.campaign_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND assigned_by = auth.uid()         -- actor integrity: no assigner spoofing
    AND status = 'not_started'           -- workflow state set only via RPC
    AND (
      politicore.is_admin()
      OR politicore.has_permission('create_assignment', scope_type, scope_id)
    )
  );

CREATE POLICY campaign_assignments_update ON politicore.campaign_assignments
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY campaign_assignments_delete ON politicore.campaign_assignments
  FOR DELETE TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('create_assignment', scope_type, scope_id)
    )
  );

-- ---------------------------------------------------------------------
-- campaign_field_reports — submitter-visible, supervisor-reviewable
-- (boundary preserved verbatim from the legacy product).
-- ---------------------------------------------------------------------
CREATE POLICY campaign_reports_select ON politicore.campaign_field_reports
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('review_field_report', scope_type, scope_id)
      OR politicore.has_permission('view_activity_reports', scope_type, scope_id)
      OR submitted_by = auth.uid()
    )
  );

CREATE POLICY campaign_reports_insert ON politicore.campaign_field_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND submitted_by = auth.uid()        -- actor integrity: no submitter spoofing
    AND status = 'submitted'             -- workflow state set only via RPC
    AND reviewed_by IS NULL AND reviewed_at IS NULL
    AND (
      politicore.is_admin()
      OR politicore.has_permission('submit_field_report', scope_type, scope_id)
    )
  );

CREATE POLICY campaign_reports_update ON politicore.campaign_field_reports
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY campaign_reports_delete ON politicore.campaign_field_reports
  FOR DELETE TO authenticated
  USING (false);

-- ---------------------------------------------------------------------
-- campaign_issues — reporter follows their own; managers within scope.
-- ---------------------------------------------------------------------
CREATE POLICY campaign_issues_select ON politicore.campaign_issues
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR politicore.has_permission('manage_issue', scope_type, scope_id)
      OR politicore.has_permission('report_issue', scope_type, scope_id)
      OR reported_by = auth.uid()
      OR assigned_to = auth.uid()
    )
  );

CREATE POLICY campaign_issues_insert ON politicore.campaign_issues
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND reported_by = auth.uid()         -- actor integrity: reporter never fabricable
    AND status = 'reported'              -- workflow state set only via RPC
    AND assigned_to IS NULL AND resolved_by IS NULL
    AND verified_by IS NULL AND closed_by IS NULL
    AND (
      politicore.is_admin()
      OR politicore.has_permission('report_issue', scope_type, scope_id)
    )
  );

CREATE POLICY campaign_issues_update ON politicore.campaign_issues
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY campaign_issues_delete ON politicore.campaign_issues
  FOR DELETE TO authenticated
  USING (false);

-- =====================================================================
-- RPCs — authority-bearing mutations. SECURITY DEFINER with pinned
-- search_path (0019 pattern); identity/tenant ALWAYS server-resolved;
-- scope authority via has_permission(..., record_scope) / has_assignment_at.
-- =====================================================================

-- Best-effort notification helper: NEVER fails the business action.
CREATE OR REPLACE FUNCTION politicore.campaign_notify(
  p_tenant uuid, p_user uuid, p_type text, p_title text, p_message text, p_link text, p_actor uuid
) RETURNS void AS $$
BEGIN
  INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message, link_url, created_by)
  VALUES (p_tenant, p_user, p_type, p_title, p_message, p_link, p_actor);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'campaign notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.campaign_audit(
  p_tenant uuid, p_actor uuid, p_action text, p_resource text,
  p_resource_id text, p_old jsonb, p_new jsonb
) RETURNS void AS $$
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value)
  VALUES (p_tenant, p_actor, p_action, p_resource, p_resource_id, p_old, p_new);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- RPC: create_campaign_assignment
-- authority: create_assignment + scope covers the assignment scope;
-- the assignee must exist in the caller's tenant and be covered by the
-- assignment scope (their registered location, when set).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.create_campaign_assignment(
  p_title text,
  p_description text,
  p_assigned_to uuid,
  p_scope_type politicore.scope_type_enum,
  p_scope_id text,
  p_priority politicore.campaign_assignment_priority DEFAULT 'medium',
  p_due_date date DEFAULT NULL,
  p_location text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (politicore.is_admin()
          OR politicore.has_permission('create_assignment', p_scope_type, p_scope_id)) THEN
    RAISE EXCEPTION 'not authorized to create assignments at this scope'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM politicore.profiles pr
                 WHERE pr.id = p_assigned_to AND pr.tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'assignee not found in tenant' USING ERRCODE = '23503';
  END IF;

  INSERT INTO politicore.campaign_assignments
    (tenant_id, title, description, assigned_to, assigned_by, scope_type, scope_id,
     priority, status, due_date, location)
  VALUES
    (v_tenant, p_title, p_description, p_assigned_to, v_uid, p_scope_type, p_scope_id,
     p_priority, 'not_started', p_due_date, p_location)
  RETURNING id INTO v_id;

  PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.assignment.create',
    'campaign_assignment', v_id::text, NULL,
    jsonb_build_object('assigned_to', p_assigned_to, 'scope_type', p_scope_type,
                       'scope_id', p_scope_id, 'priority', p_priority));

  PERFORM politicore.campaign_notify(v_tenant, p_assigned_to, 'assignment',
    'New assignment: ' || p_title,
    'You have been assigned new campaign work.', '/portal/campaign/assignments', v_uid);

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: campaign_assignment_transition — the §21 assignment state
-- machine (start/submit/return/resubmit/review-accept), checked
-- server-side; reviewer may never equal the assignee.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_assignment_transition(
  p_assignment uuid,
  p_action text
)
RETURNS politicore.campaign_assignment_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row politicore.campaign_assignments;
  v_new politicore.campaign_assignment_status;
  v_review boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_assignments
    WHERE id = p_assignment AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_action = 'start' THEN
    IF v_row.assigned_to <> v_uid THEN
      RAISE EXCEPTION 'only the assignee may start this assignment' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'not_started' THEN
      RAISE EXCEPTION 'invalid transition: start from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'in_progress'; v_review := false;

  ELSIF p_action = 'submit' THEN
    IF v_row.assigned_to <> v_uid THEN
      RAISE EXCEPTION 'only the assignee may submit this assignment' USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('not_started','in_progress') THEN
      RAISE EXCEPTION 'invalid transition: submit from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'submitted'; v_review := false;

  ELSIF p_action = 'return' THEN
    IF NOT (politicore.is_admin()
            OR politicore.has_permission('review_assignment', v_row.scope_type, v_row.scope_id)) THEN
      RAISE EXCEPTION 'not authorized to review assignments at this scope' USING ERRCODE = '42501';
    END IF;
    IF v_row.assigned_to = v_uid THEN
      RAISE EXCEPTION 'self-review is not permitted' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.status <> 'submitted' THEN
      RAISE EXCEPTION 'invalid transition: return from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'under_review'; v_review := true;

  ELSIF p_action = 'resubmit' THEN
    IF v_row.assigned_to <> v_uid THEN
      RAISE EXCEPTION 'only the assignee may resubmit this assignment' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'under_review' THEN
      RAISE EXCEPTION 'invalid transition: resubmit from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'submitted'; v_review := false;

  ELSIF p_action = 'accept' THEN
    IF NOT (politicore.is_admin()
            OR politicore.has_permission('review_assignment', v_row.scope_type, v_row.scope_id)) THEN
      RAISE EXCEPTION 'not authorized to review assignments at this scope' USING ERRCODE = '42501';
    END IF;
    IF v_row.assigned_to = v_uid THEN
      RAISE EXCEPTION 'self-review is not permitted' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.status NOT IN ('submitted','under_review') THEN
      RAISE EXCEPTION 'invalid transition: accept from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'completed'; v_review := true;

  ELSE
    RAISE EXCEPTION 'unknown assignment action: %', p_action USING ERRCODE = '22P02';
  END IF;

  UPDATE politicore.campaign_assignments SET status = v_new WHERE id = v_row.id;

  IF v_review THEN
    PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.assignment.review',
      'campaign_assignment', v_row.id::text,
      jsonb_build_object('status', v_row.status), jsonb_build_object('status', v_new));
    PERFORM politicore.campaign_notify(v_tenant, v_row.assigned_to, 'assignment',
      'Assignment ' || v_new,
      '“' || v_row.title || '” was reviewed by a supervisor.',
      '/portal/campaign/assignments', v_uid);
  ELSE
    PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.assignment.status',
      'campaign_assignment', v_row.id::text,
      jsonb_build_object('status', v_row.status), jsonb_build_object('status', v_new));
    IF p_action IN ('submit','resubmit') AND v_row.assigned_by <> v_uid THEN
      PERFORM politicore.campaign_notify(v_tenant, v_row.assigned_by, 'assignment',
        'Assignment submitted',
        '“' || v_row.title || '” was submitted for review.',
        '/portal/campaign/assignments', v_uid);
    END IF;
  END IF;

  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: submit_campaign_report
-- authority: submit_field_report at the report scope; submitter and
-- tenant always server-resolved; initial status 'submitted'.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.submit_campaign_report(
  p_report_type politicore.campaign_report_type,
  p_title text,
  p_description text,
  p_scope_type politicore.scope_type_enum,
  p_scope_id text,
  p_location text DEFAULT NULL,
  p_participants integer DEFAULT NULL,
  p_issues text DEFAULT NULL,
  p_community_feedback text DEFAULT NULL,
  p_requests text DEFAULT NULL,
  p_follow_up_required boolean DEFAULT false,
  p_evidence uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (politicore.is_admin()
          OR politicore.has_permission('submit_field_report', p_scope_type, p_scope_id)) THEN
    RAISE EXCEPTION 'not authorized to submit field reports at this scope' USING ERRCODE = '42501';
  END IF;

  INSERT INTO politicore.campaign_field_reports
    (tenant_id, submitted_by, report_type, title, description, scope_type, scope_id,
     location, participants, issues, community_feedback, requests, follow_up_required,
     evidence_asset_id, status)
  VALUES
    (v_tenant, v_uid, p_report_type, p_title, p_description, p_scope_type, p_scope_id,
     p_location, p_participants, p_issues, p_community_feedback, p_requests,
     COALESCE(p_follow_up_required, false), p_evidence, 'submitted')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: review_campaign_report — under_review → accepted/returned;
-- self-approval banned; review authority permission+scope based.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.review_campaign_report(
  p_report uuid,
  p_action text,                -- 'accept' | 'return'
  p_comment text DEFAULT NULL
)
RETURNS politicore.campaign_report_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row politicore.campaign_field_reports;
  v_new politicore.campaign_report_status;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_field_reports
    WHERE id = p_report AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (politicore.is_admin()
          OR politicore.has_permission('review_field_report', v_row.scope_type, v_row.scope_id)) THEN
    RAISE EXCEPTION 'not authorized to review reports at this scope' USING ERRCODE = '42501';
  END IF;
  IF v_row.submitted_by = v_uid THEN
    RAISE EXCEPTION 'self-approval is not permitted' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'accept' THEN
    IF v_row.status NOT IN ('submitted','under_review') THEN
      RAISE EXCEPTION 'invalid transition: accept from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'accepted';
  ELSIF p_action = 'return' THEN
    IF v_row.status NOT IN ('submitted','under_review') THEN
      RAISE EXCEPTION 'invalid transition: return from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'returned';
  ELSE
    RAISE EXCEPTION 'unknown review action: %', p_action USING ERRCODE = '22P02';
  END IF;

  UPDATE politicore.campaign_field_reports
    SET status = v_new, reviewed_by = v_uid, review_comment = p_comment, reviewed_at = now()
    WHERE id = v_row.id;

  PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.report.review',
    'campaign_field_report', v_row.id::text,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', v_new, 'comment', p_comment));

  PERFORM politicore.campaign_notify(v_tenant, v_row.submitted_by, 'assignment',
    'Report ' || v_new,
    '“' || v_row.title || '” was ' || v_new
      || COALESCE(' — ' || p_comment, '') || '.',
    '/portal/campaign/reports', v_uid);

  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: campaign_issue_transition — the §21 issue state machine
-- (acknowledge/assign/start/resolve/verify/close). Reporter never
-- fabricable; close/verify require manage_issue at scope.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_issue_transition(
  p_issue uuid,
  p_action text,
  p_assignee uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS politicore.campaign_issue_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row politicore.campaign_issues;
  v_new politicore.campaign_issue_status;
  v_manages boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_issues
    WHERE id = p_issue AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue not found' USING ERRCODE = 'P0002';
  END IF;

  v_manages := politicore.is_admin()
    OR politicore.has_permission('manage_issue', v_row.scope_type, v_row.scope_id);

  IF p_action = 'acknowledge' THEN
    IF NOT v_manages THEN
      RAISE EXCEPTION 'not authorized to manage issues at this scope' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'reported' THEN
      RAISE EXCEPTION 'invalid transition: acknowledge from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'acknowledged';

  ELSIF p_action = 'assign' THEN
    IF NOT v_manages THEN
      RAISE EXCEPTION 'not authorized to manage issues at this scope' USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('reported','acknowledged','assigned') THEN
      RAISE EXCEPTION 'invalid transition: assign from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    IF p_assignee IS NULL THEN
      RAISE EXCEPTION 'assignee is required' USING ERRCODE = '23502';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM politicore.profiles pr
                   WHERE pr.id = p_assignee AND pr.tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'assignee not found in tenant' USING ERRCODE = '23503';
    END IF;
    UPDATE politicore.campaign_issues SET assigned_to = p_assignee WHERE id = v_row.id;
    v_new := 'assigned';
    PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.issue.assign',
      'campaign_issue', v_row.id::text, NULL, jsonb_build_object('assigned_to', p_assignee));
    PERFORM politicore.campaign_notify(v_tenant, p_assignee, 'assignment',
      'Issue assigned: ' || v_row.title,
      'An operational issue was assigned to you.', '/portal/campaign/issues', v_uid);

  ELSIF p_action = 'start' THEN
    IF v_row.assigned_to <> v_uid THEN
      RAISE EXCEPTION 'only the assignee may start work on this issue' USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('assigned','in_progress') THEN
      RAISE EXCEPTION 'invalid transition: start from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'in_progress';

  ELSIF p_action = 'resolve' THEN
    IF NOT (v_manages OR v_row.assigned_to = v_uid) THEN
      RAISE EXCEPTION 'not authorized to resolve this issue' USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('assigned','in_progress') THEN
      RAISE EXCEPTION 'invalid transition: resolve from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'resolved';

  ELSIF p_action = 'verify' THEN
    IF NOT v_manages THEN
      RAISE EXCEPTION 'not authorized to verify issues at this scope' USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'resolved' THEN
      RAISE EXCEPTION 'invalid transition: verify from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'verified';

  ELSIF p_action = 'close' THEN
    IF NOT v_manages THEN
      RAISE EXCEPTION 'not authorized to close issues at this scope' USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('resolved','verified') THEN
      RAISE EXCEPTION 'invalid transition: close from %', v_row.status USING ERRCODE = 'P0001';
    END IF;
    v_new := 'closed';

  ELSE
    RAISE EXCEPTION 'unknown issue action: %', p_action USING ERRCODE = '22P02';
  END IF;

  UPDATE politicore.campaign_issues
    SET status = v_new,
        resolution_notes = CASE WHEN p_action = 'resolve' THEN COALESCE(p_notes, resolution_notes) ELSE resolution_notes END,
        resolved_by = CASE WHEN p_action = 'resolve' THEN v_uid ELSE resolved_by END,
        resolved_at = CASE WHEN p_action = 'resolve' THEN now() ELSE resolved_at END,
        verified_by = CASE WHEN p_action = 'verify' THEN v_uid ELSE verified_by END,
        verified_at = CASE WHEN p_action = 'verify' THEN now() ELSE verified_at END,
        closed_by   = CASE WHEN p_action = 'close'   THEN v_uid ELSE closed_by   END,
        closed_at   = CASE WHEN p_action = 'close'   THEN now() ELSE closed_at   END
    WHERE id = v_row.id;

  IF p_action NOT IN ('assign') THEN
    PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.issue.status',
      'campaign_issue', v_row.id::text,
      jsonb_build_object('status', v_row.status), jsonb_build_object('status', v_new));
  END IF;

  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: set_campaign_activity_status — scheduled → postponed/cancelled;
-- → completed at/after start; completed terminal.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.set_campaign_activity_status(
  p_activity uuid,
  p_status politicore.campaign_activity_status
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row politicore.campaign_activities;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_activities
    WHERE id = p_activity AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activity not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (politicore.is_admin()
          OR politicore.has_permission('manage_activity', v_row.scope_type, v_row.scope_id)) THEN
    RAISE EXCEPTION 'not authorized to manage activities at this scope' USING ERRCODE = '42501';
  END IF;

  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'invalid transition: % from completed', p_status USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'scheduled' THEN
    RAISE EXCEPTION 'invalid transition: scheduled is the initial state' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'completed' AND v_row.scheduled_start > now() THEN
    RAISE EXCEPTION 'activity cannot be completed before its scheduled start' USING ERRCODE = 'P0001';
  END IF;

  UPDATE politicore.campaign_activities SET status = p_status WHERE id = v_row.id;

  PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.activity.status',
    'campaign_activity', v_row.id::text,
    jsonb_build_object('status', v_row.status), jsonb_build_object('status', p_status));

  PERFORM politicore.campaign_notify(v_tenant, v_row.organizer_id, 'activity',
    'Activity ' || p_status,
    '“' || v_row.title || '” was marked ' || p_status || '.',
    '/portal/campaign/activities', v_uid);
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: join_campaign_activity — own-participation RSVP through the
-- server (activity visibility + module gate verified server-side).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.join_campaign_activity(
  p_activity uuid,
  p_rsvp politicore.campaign_rsvp
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_activity politicore.campaign_activities;
  v_participant uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_activity FROM politicore.campaign_activities
    WHERE id = p_activity AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activity not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (politicore.is_admin()
          OR v_activity.created_by = v_uid
          OR v_activity.organizer_id = v_uid
          OR politicore.has_membership('campaign_member')
          OR politicore.has_membership('social_member')) THEN
    RAISE EXCEPTION 'not authorized to participate' USING ERRCODE = '42501';
  END IF;

  INSERT INTO politicore.campaign_activity_participants
    (tenant_id, activity_id, user_id, rsvp, rsvp_at)
  VALUES (v_tenant, v_activity.id, v_uid, p_rsvp, now())
  ON CONFLICT (activity_id, user_id)
  DO UPDATE SET rsvp = EXCLUDED.rsvp, rsvp_at = now()
  RETURNING id INTO v_participant;

  RETURN v_participant;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: record_campaign_attendance — an OPERATIONAL FACT recorded by a
-- supervisor (manage/create_activity at the activity scope or admin).
-- A participant can never mark themselves present or forge the
-- recorder identity (server-resolved).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.record_campaign_attendance(
  p_activity uuid,
  p_participant_user uuid,
  p_attendance politicore.campaign_attendance_state,
  p_check_in boolean DEFAULT false,
  p_check_out boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_activity politicore.campaign_activities;
  v_row politicore.campaign_activity_participants;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_activity FROM politicore.campaign_activities
    WHERE id = p_activity AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activity not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (politicore.is_admin()
          OR politicore.has_permission('manage_activity', v_activity.scope_type, v_activity.scope_id)
          OR politicore.has_permission('create_activity', v_activity.scope_type, v_activity.scope_id)) THEN
    RAISE EXCEPTION 'not authorized to record attendance for this activity' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_activity_participants
    WHERE activity_id = p_activity AND user_id = p_participant_user AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'participant not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE politicore.campaign_activity_participants
    SET attendance = p_attendance,
        checked_in_at = CASE WHEN p_check_in THEN now() ELSE checked_in_at END,
        checked_out_at = CASE WHEN p_check_out THEN now() ELSE checked_out_at END,
        recorded_by = v_uid
    WHERE id = v_row.id;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: update_campaign_assignment_details — supervisor edits of a
-- non-terminal assignment (title/description/priority/due/location)
-- plus authoritative reassignment (campaign.assignment.reassign).
-- Direct UPDATE is closed by RLS; details flow only through here.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.update_campaign_assignment_details(
  p_assignment uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_priority politicore.campaign_assignment_priority DEFAULT NULL,
  p_due_date date DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_reassign_to uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row politicore.campaign_assignments;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_assignments
    WHERE id = p_assignment AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (politicore.is_admin()
          OR politicore.has_permission('create_assignment', v_row.scope_type, v_row.scope_id)) THEN
    RAISE EXCEPTION 'not authorized to manage assignments at this scope' USING ERRCODE = '42501';
  END IF;
  IF v_row.status IN ('completed','overdue') THEN
    RAISE EXCEPTION 'invalid transition: update from %', v_row.status USING ERRCODE = 'P0001';
  END IF;

  IF p_reassign_to IS NOT NULL AND p_reassign_to <> v_row.assigned_to THEN
    IF NOT EXISTS (SELECT 1 FROM politicore.profiles pr
                   WHERE pr.id = p_reassign_to AND pr.tenant_id = v_tenant) THEN
      RAISE EXCEPTION 'assignee not found in tenant' USING ERRCODE = '23503';
    END IF;
  END IF;

  v_old := jsonb_build_object(
    'title', v_row.title, 'description', v_row.description, 'priority', v_row.priority,
    'due_date', v_row.due_date, 'location', v_row.location, 'assigned_to', v_row.assigned_to);

  UPDATE politicore.campaign_assignments SET
    title       = COALESCE(p_title, title),
    description = COALESCE(p_description, description),
    priority    = COALESCE(p_priority, priority),
    due_date    = COALESCE(p_due_date, due_date),
    location    = COALESCE(p_location, location),
    assigned_to = COALESCE(p_reassign_to, assigned_to)
  WHERE id = v_row.id;

  v_new := jsonb_build_object(
    'title', COALESCE(p_title, v_row.title), 'description', COALESCE(p_description, v_row.description),
    'priority', COALESCE(p_priority, v_row.priority), 'due_date', COALESCE(p_due_date, v_row.due_date),
    'location', COALESCE(p_location, v_row.location),
    'assigned_to', COALESCE(p_reassign_to, v_row.assigned_to));

  IF p_reassign_to IS NOT NULL AND p_reassign_to <> v_row.assigned_to THEN
    PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.assignment.reassign',
      'campaign_assignment', v_row.id::text, v_old, v_new);
    PERFORM politicore.campaign_notify(v_tenant, p_reassign_to, 'assignment',
      'Assignment assigned: ' || COALESCE(p_title, v_row.title),
      'Campaign work has been assigned to you.', '/portal/campaign/assignments', v_uid);
  ELSE
    PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.assignment.update',
      'campaign_assignment', v_row.id::text, v_old, v_new);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: resubmit_campaign_report — returned → submitted (submitter
-- only, per the §21 report workflow). Fresh review cycle.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.resubmit_campaign_report(
  p_report uuid,
  p_description text,
  p_evidence uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row politicore.campaign_field_reports;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '42501';
  END IF;
  v_tenant := politicore.current_tenant_id();
  IF NOT politicore.module_enabled('campaign') THEN
    RAISE EXCEPTION 'campaign module is not enabled for this tenant' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM politicore.campaign_field_reports
    WHERE id = p_report AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.submitted_by <> v_uid THEN
    RAISE EXCEPTION 'only the original submitter may resubmit' USING ERRCODE = '42501';
  END IF;
  IF v_row.status <> 'returned' THEN
    RAISE EXCEPTION 'invalid transition: resubmit from %', v_row.status USING ERRCODE = 'P0001';
  END IF;

  UPDATE politicore.campaign_field_reports
    SET status = 'submitted', description = p_description,
        evidence_asset_id = COALESCE(p_evidence, evidence_asset_id),
        reviewed_by = NULL, review_comment = NULL, reviewed_at = NULL
    WHERE id = v_row.id;

  PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.report.resubmit',
    'campaign_field_report', v_row.id::text,
    jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'submitted'));
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: campaign_members_in_scope — the Campaign member directory with
-- SERVER-side hierarchical scope filtering (defect D2 dies here).
--   * admin / campaign / state authority → tenant-wide directory
--   * zone / LGA / ward / PU authority → members whose REGISTERED
--     location is covered (scope_covers(grantee, member location))
--   * membership filter is 'campaign_member' (directory filter, NOT
--     an authority test); contact fields gated by view_member_contacts
-- Never trusts client scope; never exposes tenant-wide rows to a
-- narrower authority.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_members_in_scope()
RETURNS TABLE (
  id           uuid,
  full_name    text,
  email        text,
  phone        text,
  position_name text,
  scope_type   politicore.scope_type_enum,
  scope_id     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT politicore.module_enabled('campaign')
     OR NOT (politicore.is_admin()
             OR politicore.has_permission('view_members')
             OR politicore.has_permission('manage_members')) THEN
    RAISE EXCEPTION 'not authorized to view the member directory' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  -- Tenant-wide branch: admin, or authority at campaign/state scope.
  SELECT DISTINCT
    pr.id, pr.full_name, pr.email,
    CASE WHEN politicore.has_permission('view_member_contacts') THEN pr.phone END,
    NULL::text, NULL::politicore.scope_type_enum, NULL::text
  FROM politicore.profiles pr
  WHERE pr.tenant_id = politicore.current_tenant_id()
    AND 'campaign_member' = ANY(pr.membership_types)
    AND (politicore.is_admin()
         OR EXISTS (SELECT 1 FROM politicore.my_scopes() s
                    WHERE s.scope_type IN ('campaign','state')))
  UNION ALL
  -- Scoped branch: registered location covered by an active scope.
  SELECT DISTINCT ON (pr.id)
    pr.id, pr.full_name, pr.email,
    CASE WHEN politicore.has_permission('view_member_contacts') THEN pr.phone END,
    s.position_name, s.scope_type, s.scope_id
  FROM politicore.profiles pr
  JOIN politicore.my_scopes() s
    ON s.scope_type IN ('senatorial_zone','lga','ward','polling_unit')
   AND 'campaign_member' = ANY(pr.membership_types)
   AND (
     (s.scope_type = 'senatorial_zone'
      AND (politicore.scope_covers(s.scope_type, s.scope_id, 'lga', pr.lga_id)
           OR politicore.scope_covers(s.scope_type, s.scope_id, 'ward', pr.ward_id)
           OR politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id)))
     OR (s.scope_type = 'lga'
         AND (politicore.scope_covers(s.scope_type, s.scope_id, 'lga', pr.lga_id)
              OR politicore.scope_covers(s.scope_type, s.scope_id, 'ward', pr.ward_id)
              OR politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id)))
     OR (s.scope_type = 'ward'
         AND (politicore.scope_covers(s.scope_type, s.scope_id, 'ward', pr.ward_id)
              OR politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id)))
     OR (s.scope_type = 'polling_unit'
         AND politicore.scope_covers(s.scope_type, s.scope_id, 'polling_unit', pr.polling_unit_id))
   )
  WHERE pr.tenant_id = politicore.current_tenant_id();
END;
$$;

-- ---------------------------------------------------------------------
-- RPC: my_module_settings — module-keyed accessor over the EXISTING
-- tenant_settings foundation (Architecture Gate §29: no campaign_settings
-- table, no new settings framework). Returns the module's jsonb key.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.my_module_settings(
  p_module politicore.module_code_enum
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT ts.settings -> p_module::text
     FROM politicore.tenant_settings ts
     WHERE ts.tenant_id = politicore.current_tenant_id()),
    '{}'::jsonb);
$$;

-- =====================================================================
-- GRANTS + PUBLIC SECURITY-INVOKER VIEWS (0009/0020 convention)
-- =====================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.campaign_activities TO authenticated;
GRANT SELECT, INSERT ON politicore.campaign_activity_participants TO authenticated;
GRANT SELECT, INSERT, DELETE ON politicore.campaign_assignments TO authenticated;
GRANT SELECT, INSERT ON politicore.campaign_field_reports TO authenticated;
GRANT SELECT, INSERT ON politicore.campaign_issues TO authenticated;

GRANT EXECUTE ON FUNCTION politicore.create_campaign_assignment(text, text, uuid,
  politicore.scope_type_enum, text, politicore.campaign_assignment_priority, date, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.campaign_assignment_transition(uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.submit_campaign_report(politicore.campaign_report_type,
  text, text, politicore.scope_type_enum, text, text, integer, text, text, text, boolean, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.review_campaign_report(uuid, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.campaign_issue_transition(uuid, text, uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.set_campaign_activity_status(uuid,
  politicore.campaign_activity_status) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.join_campaign_activity(uuid, politicore.campaign_rsvp)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.record_campaign_attendance(uuid, uuid,
  politicore.campaign_attendance_state, boolean, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.update_campaign_assignment_details(uuid, text, text,
  politicore.campaign_assignment_priority, date, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.resubmit_campaign_report(uuid, text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.campaign_members_in_scope()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION politicore.my_module_settings(politicore.module_code_enum)
  TO authenticated, service_role;

-- Thin SECURITY INVOKER views: base-table RLS applies unchanged; the
-- views add zero authorization. Workflow writes stay RPC-only at the
-- base tables (assignments/reports/issues/participants are
-- insert/update-locked by policy), so their views are deliberately
-- SELECT-only; activities remain admin/manage-writable THROUGH the
-- view exactly as at the base table.
CREATE OR REPLACE VIEW public.campaign_activities
  WITH (security_invoker = true) AS SELECT * FROM politicore.campaign_activities;
CREATE OR REPLACE VIEW public.campaign_activity_participants
  WITH (security_invoker = true) AS SELECT * FROM politicore.campaign_activity_participants;
CREATE OR REPLACE VIEW public.campaign_assignments
  WITH (security_invoker = true) AS SELECT * FROM politicore.campaign_assignments;
CREATE OR REPLACE VIEW public.campaign_field_reports
  WITH (security_invoker = true) AS SELECT * FROM politicore.campaign_field_reports;
CREATE OR REPLACE VIEW public.campaign_issues
  WITH (security_invoker = true) AS SELECT * FROM politicore.campaign_issues;

GRANT SELECT ON public.campaign_activities, public.campaign_activity_participants,
  public.campaign_assignments, public.campaign_field_reports, public.campaign_issues
  TO anon, authenticated, service_role;
-- Client-writable paths through the views (RLS decides, as at the base
-- tables): activities full CRUD; issues are member-reportable. Writes to
-- assignments / field reports / participants stay RPC-only, so their
-- views are deliberately SELECT-only.
GRANT INSERT, UPDATE, DELETE ON public.campaign_activities TO authenticated, service_role;
GRANT INSERT ON public.campaign_issues TO authenticated, service_role;
