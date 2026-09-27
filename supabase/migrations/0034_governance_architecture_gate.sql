-- POLITICORE — MIGRATION 0034: GOVERNANCE & CITIZEN ENGAGEMENT — ARCHITECTURE GATE (PHASE 6).
--
-- Establishes Governance as an independent first-class module and the
-- MINIMUM canonical model for the first vertical slice:
--
--   Citizen Request → Acknowledgement → Assignment → Progress
--                   → Resolution → Citizen Feedback
--
-- Governance is a PEER of Social Force / Campaign / Election — NOT a
-- Campaign extension, NOT Events/News/Announcements, NOT a generic
-- content feature. It asks a different question:
--
--   "How does the tenant engage with and respond to the people it
--    serves?" (vs Campaign: "how does it organize its people?")
--
-- ─────────────────────────────────────────────────────────────────────────
-- REUSE (no new primitives):
--   * module activation  — politicore.module_code_enum already contains
--                          'governance' (0001); tenant_modules rows +
--                          module_enabled() + provisioning defaults
--                          (governance=false) already exist. No second
--                          activation mechanism.
--   * authorization      — has_permission()/scope_covers()/permission_grants
--                          (0002/0014 resolver); domain permissions seeded
--                          below; NO organizational positions as access
--                          roles, NO citizen_* access roles.
--   * geography          — politicore.wards/lgas/polling_units FKs only;
--                          optional at every level (a statewide consultation
--                          has no ward; a local issue may carry a PU).
--   * audit              — canonical system_audits via the 0002 definer
--                          trigger. No governance_audit_logs.
--   * identity           — Supabase Auth + politicore.profiles ONLY. Staff
--                          are portal members; participants are a domain
--                          record, explicitly NOT an access role.
--   * notifications/media — Core-owned; not wired in this gate (§17/§18).
--
-- ─────────────────────────────────────────────────────────────────────────
-- MINIMUM FIRST-SLICE MODEL (§26 — no speculative tables):
--
--   politicore.governance_participants  — tenant-scoped person record for
--     external participants (distinct from auth identity; optional link
--     to profiles when the participant IS a portal member).
--   politicore.governance_request_categories — tenant-defined taxonomy.
--   politicore.governance_requests      — the request/case aggregate.
--   politicore.governance_request_events — append-only lifecycle trail
--     (acknowledgement, assignment, status, staff/participant responses,
--     resolution, feedback) — one event stream instead of six tables.
--   politicore.governance_assignments   — staff responsibility for a case
--     (authority surface for has_permission checks + scope resolution).
--
-- CASE STATUS LADDER (only states the workflow needs):
--   submitted → acknowledged → assigned → in_progress →
--   awaiting_information → resolved → closed   (+ rejected)
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- PERMISSION VOCABULARY (minimum for the first slice — §12)
-- ---------------------------------------------------------------------
-- Domain permissions, NOT positions. Grant paths remain the existing
-- ones (position_permissions matrix, permission_grants, admin bypass).
-- No position_defaults are changed by this migration; tenants assign
-- 'manage_cases'/'assign_cases' through the existing grant architecture.
-- ---------------------------------------------------------------------
INSERT INTO politicore.permissions (name, domain, description) VALUES
  ('view_governance',     'governance', 'View Governance surfaces within the holder''s scope'),
  ('view_cases',          'governance', 'View the governance request/case queue within the holder''s scope'),
  ('manage_cases',        'governance', 'Acknowledge, progress, respond, resolve and close governance cases'),
  ('assign_cases',        'governance', 'Assign governance cases to authorized staff within scope')
ON CONFLICT (name) DO NOTHING;
-- Submission is NOT a staff permission: any authenticated member of a
-- governance-enabled tenant may submit (participant identity is the
-- authorization for ownership; §11/§24).

-- ─────────────────────────────────────────────────────────────────────────
-- PARTICIPANTS — the tenant↔person engagement relationship
-- ---------------------------------------------------------------------
-- DISTINCT from authentication identity (§10/§11):
--   * a participant may exist with NO auth user (anonymous/public filer
--     identified by contact details only), or
--   * may link to a portal member (profiles.id) when they authenticate.
-- No new auth system; no citizen_* access roles; no profiles duplication.
-- display_label supports tenant-type wording (citizen/customer/member)
-- without forking the module (§29).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_participants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  profile_id     uuid UNIQUE REFERENCES politicore.profiles(id),
  full_name      text NOT NULL DEFAULT '',
  email          text,
  phone          text,
  display_label  text NOT NULL DEFAULT 'Citizen',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_participants_contact CHECK (
    profile_id IS NOT NULL OR (email IS NOT NULL OR phone IS NOT NULL)
  )
);

CREATE INDEX governance_participants_tenant_idx
  ON politicore.governance_participants (tenant_id);

-- One participant row per portal member per tenant (UNIQUE above), and
-- deduplication of anonymous participants by contact within a tenant.
CREATE UNIQUE INDEX governance_participants_email_uniq
  ON politicore.governance_participants (tenant_id, lower(email))
  WHERE profile_id IS NULL AND email IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- REQUEST CATEGORIES — tenant-defined taxonomy (admin-managed, §24 Admin)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_request_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- ─────────────────────────────────────────────────────────────────────────
-- REQUESTS — the case aggregate (status ladder enforced by trigger)
-- ---------------------------------------------------------------------
CREATE TYPE politicore.governance_request_status AS ENUM (
  'submitted', 'acknowledged', 'assigned', 'in_progress',
  'awaiting_information', 'resolved', 'closed', 'rejected'
);

CREATE TYPE politicore.governance_event_kind AS ENUM (
  'submitted', 'acknowledged', 'assigned', 'status_changed',
  'staff_response', 'participant_response', 'resolved', 'closed',
  'rejected', 'reopened', 'feedback'
);

CREATE TABLE politicore.governance_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  reference_code   text NOT NULL,
  participant_id   uuid NOT NULL REFERENCES politicore.governance_participants(id),
  category_id      uuid REFERENCES politicore.governance_request_categories(id),
  title            text NOT NULL,
  details          text NOT NULL DEFAULT '',
  status           politicore.governance_request_status NOT NULL DEFAULT 'submitted',
  is_public        boolean NOT NULL DEFAULT false,
  -- Optional geography (§13): a statewide consultation carries none; a
  -- local service issue may carry ward and/or polling unit.
  ward_id          text REFERENCES politicore.wards(id),
  lga_id           text REFERENCES politicore.lgas(id),
  polling_unit_id  text REFERENCES politicore.polling_units(id),
  assigned_profile_id uuid REFERENCES politicore.profiles(id),
  resolved_at      timestamptz,
  closed_at        timestamptz,
  feedback_rating  smallint CHECK (feedback_rating BETWEEN 1 AND 5),
  feedback_comment text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference_code)
);

CREATE INDEX governance_requests_tenant_status_idx
  ON politicore.governance_requests (tenant_id, status);
CREATE INDEX governance_requests_participant_idx
  ON politicore.governance_requests (participant_id);
CREATE INDEX governance_requests_assignee_idx
  ON politicore.governance_requests (assigned_profile_id);
CREATE INDEX governance_requests_ward_idx
  ON politicore.governance_requests (tenant_id, ward_id);

-- Human-friendly per-tenant reference (e.g. GR-2026-000123) derived from
-- the row id — deterministic, collision-free, no counter table needed.
CREATE OR REPLACE FUNCTION politicore.governance_reference(t timestamptz, id uuid)
RETURNS text AS $$
  SELECT 'GR-' || to_char(t, 'YYYY') || '-' || upper(substr(replace(id::text, '-', ''), 1, 8));
$$ LANGUAGE sql IMMUTABLE;

-- Status-ladder guard: only forward/reasonable transitions (§9 states).
CREATE OR REPLACE FUNCTION politicore.guard_governance_request_status()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  -- Compare in text: a bare VALUES list of literals resolves to text and
  -- enum = text has no operator (explicit casts keep this deterministic).
  IF NOT (
    (OLD.status::text, NEW.status::text) IN (
      VALUES ('submitted','acknowledged'), ('submitted','rejected'),
             ('acknowledged','assigned'),  ('acknowledged','in_progress'),
             ('assigned','in_progress'),   ('assigned','awaiting_information'),
             ('in_progress','awaiting_information'), ('in_progress','resolved'),
             ('awaiting_information','in_progress'), ('awaiting_information','resolved'),
             ('resolved','closed')
    )
    OR NEW.status::text = 'closed'   -- any non-terminal state may be closed
    OR (OLD.status::text = 'resolved' AND NEW.status::text IN ('in_progress','awaiting_information'))
  ) THEN
    RAISE EXCEPTION 'governance: illegal status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_governance_request_status_guard
  BEFORE UPDATE OF status ON politicore.governance_requests
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_request_status();

-- Denormalized timestamps stay consistent with status.
CREATE OR REPLACE FUNCTION politicore.touch_governance_request_lifecycle()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'resolved' AND OLD.status <> 'resolved' THEN
    NEW.resolved_at := now();
  END IF;
  IF NEW.status = 'closed' THEN
    NEW.closed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_governance_request_lifecycle
  BEFORE UPDATE ON politicore.governance_requests
  FOR EACH ROW EXECUTE FUNCTION politicore.touch_governance_request_lifecycle();

-- ─────────────────────────────────────────────────────────────────────────
-- REQUEST EVENTS — append-only lifecycle + response trail
-- ---------------------------------------------------------------------
-- One event stream for acknowledgement/assignment/status/staff response/
-- participant response/resolution/closure/feedback. Append-only: no
-- UPDATE/DELETE policy will exist (tamper-evident trail).
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_request_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES politicore.governance_requests(id) ON DELETE CASCADE,
  kind         politicore.governance_event_kind NOT NULL,
  actor_profile_id uuid REFERENCES politicore.profiles(id),   -- staff/member actor
  actor_participant_id uuid REFERENCES politicore.governance_participants(id), -- participant actor
  body         text NOT NULL DEFAULT '',
  status_to    politicore.governance_request_status,           -- status-change events
  is_public    boolean NOT NULL DEFAULT false,                 -- staff response visibility
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_request_events_request_idx
  ON politicore.governance_request_events (request_id, created_at);

-- Actor pinning: exactly one actor column per event.
CREATE OR REPLACE FUNCTION politicore.guard_governance_event_actor()
RETURNS trigger AS $$
BEGIN
  IF (NEW.actor_profile_id IS NULL) = (NEW.actor_participant_id IS NULL) THEN
    RAISE EXCEPTION 'governance: event must carry exactly one actor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_governance_event_actor_guard
  BEFORE INSERT ON politicore.governance_request_events
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_governance_event_actor();

-- Append-only enforcement (belt-and-braces beside RLS).
CREATE OR REPLACE FUNCTION politicore.forbid_governance_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'governance: request events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_governance_events_no_update
  BEFORE UPDATE OR DELETE ON politicore.governance_request_events
  FOR EACH ROW EXECUTE FUNCTION politicore.forbid_governance_event_mutation();

-- ─────────────────────────────────────────────────────────────────────────
-- ASSIGNMENTS — staff responsibility surface
-- ---------------------------------------------------------------------
CREATE TABLE politicore.governance_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES politicore.governance_requests(id) ON DELETE CASCADE,
  assigned_to  uuid NOT NULL REFERENCES politicore.profiles(id),
  assigned_by  uuid REFERENCES politicore.profiles(id),
  scope_type   politicore.scope_type_enum,
  scope_id     text,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, assigned_to)
);

CREATE INDEX governance_assignments_assignee_idx
  ON politicore.governance_assignments (assigned_to);

-- ---------------------------------------------------------------------
-- Canonical audit (0002 trigger — actor, old/new, resource id).
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_audit_governance_requests
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_requests
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_assignments
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_assignments
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_governance_categories
  AFTER INSERT OR UPDATE OR DELETE ON politicore.governance_request_categories
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — table-by-table strategy (§15) — all FORCEd
-- ---------------------------------------------------------------------

-- participants: staff view tenant participants; members see only their
-- own linked row; anonymous sees nothing.
ALTER TABLE politicore.governance_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_participants FORCE  ROW LEVEL SECURITY;
CREATE POLICY governance_participants_read ON politicore.governance_participants
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_cases')
      OR profile_id = auth.uid()
    )
  );
CREATE POLICY governance_participants_admin ON politicore.governance_participants
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- Self-registration of the caller's own participant row (a portal member
-- becoming a participant of their tenant) — tenant derived server-side.
CREATE POLICY governance_participants_self_insert ON politicore.governance_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = politicore.current_tenant_id()
    AND profile_id = auth.uid()
  );

-- categories: published taxonomy readable by staff + participants of the
-- tenant; admin-managed writes.
ALTER TABLE politicore.governance_request_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_request_categories FORCE  ROW LEVEL SECURITY;
CREATE POLICY governance_categories_read ON politicore.governance_request_categories
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_cases')
      OR is_active
    )
  );
CREATE POLICY governance_categories_admin ON politicore.governance_request_categories
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- requests: the heart of the privacy model (§14).
--   anonymous: nothing (submission flows through the submit RPC below).
--   participant-owner: own requests.
--   staff: view_cases OR manage_cases holders + admins within the tenant
--     (a case manager must read what they manage — UPDATE also requires
--     passing the SELECT policy via the implicit read, so manage-only
--     holders MUST appear here or their writes silently no-op).
--   is_public rows: NOT exposed to anon here — public accountability
--     publishing is a later gated phase; default-closed now.
ALTER TABLE politicore.governance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_requests FORCE  ROW LEVEL SECURITY;
CREATE POLICY governance_requests_read ON politicore.governance_requests
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_cases')
      OR politicore.has_permission('manage_cases')
      OR EXISTS (
        SELECT 1 FROM politicore.governance_participants p
        WHERE p.id = participant_id AND p.profile_id = auth.uid()
      )
    )
  );
CREATE POLICY governance_requests_staff_insert ON politicore.governance_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('manage_cases')
      -- participant self-filing also flows through the submit RPC below;
      -- this policy branch covers RPC-owned inserts (definer path skips
      -- RLS, but the policy documents the surface and keeps direct-table
      -- filing staff-gated).
    )
  );
CREATE POLICY governance_requests_staff_update ON politicore.governance_requests
  FOR UPDATE TO authenticated
  USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin() OR politicore.has_permission('manage_cases'))
  )
  WITH CHECK (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin() OR politicore.has_permission('manage_cases'))
  );
-- No DELETE policy: case records are never deleted by application roles.

-- events: staff see the full trail of their tenant; the owning
-- participant sees only PUBLIC events plus the events they authored —
-- internal staff responses never leak to the participant (§14).
-- Writes happen through RPCs (below); no INSERT/UPDATE/DELETE policy
-- exists for application roles => direct writes are denied by default.
ALTER TABLE politicore.governance_request_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_request_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY governance_events_read ON politicore.governance_request_events
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_cases')
      OR politicore.has_permission('manage_cases')
      OR EXISTS (
        SELECT 1
        FROM politicore.governance_requests r
        JOIN politicore.governance_participants p ON p.id = r.participant_id
        WHERE r.id = request_id
          AND p.profile_id = auth.uid()
          AND (
            governance_request_events.is_public
            OR governance_request_events.actor_participant_id = p.id
          )
      )
    )
  );

-- assignments: staff with case visibility; assignee sees own rows.
ALTER TABLE politicore.governance_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_assignments FORCE  ROW LEVEL SECURITY;
CREATE POLICY governance_assignments_read ON politicore.governance_assignments
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_tenant_admin()
      OR politicore.has_permission('view_cases')
      OR politicore.has_permission('manage_cases')
      OR assigned_to = auth.uid()
    )
  );
CREATE POLICY governance_assignments_write ON politicore.governance_assignments
  FOR ALL USING (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin() OR politicore.has_permission('assign_cases'))
  )
  WITH CHECK (
    tenant_id = politicore.current_tenant_id()
    AND (politicore.is_tenant_admin() OR politicore.has_permission('assign_cases'))
  );

-- ─────────────────────────────────────────────────────────────────────────
-- AUTHORITY RPCs — the only write paths for lifecycle actions
-- (server-resolved actor + tenant + reference; fail closed; audited)
-- ---------------------------------------------------------------------

-- Participant submits a request (authenticated member path). Anonymous
-- public submission is intentionally NOT enabled in this gate; the
-- public intake surface is a separately gated decision (§11 documented).
CREATE OR REPLACE FUNCTION politicore.submit_governance_request(
  p_title text,
  p_details text,
  p_category_id uuid DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_profile politicore.profiles%ROWTYPE;
  v_participant uuid;
  v_request uuid;
  v_id uuid;
BEGIN
  SELECT * INTO v_profile FROM politicore.profiles WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance: authenticated participant required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  -- Participant upsert (linked to the caller's profile; UNIQUE enforces 1:1).
  INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name, email)
  VALUES (v_profile.tenant_id, v_profile.id, v_profile.full_name, v_profile.email)
  ON CONFLICT (profile_id) DO UPDATE SET full_name = EXCLUDED.full_name
  RETURNING id INTO v_participant;

  v_id := gen_random_uuid();
  INSERT INTO politicore.governance_requests
    (id, tenant_id, participant_id, category_id, title, details, status,
     ward_id, lga_id, polling_unit_id, reference_code)
  VALUES (
    v_id, v_profile.tenant_id, v_participant, p_category_id, p_title, p_details,
    'submitted', p_ward_id, p_lga_id, p_polling_unit_id,
    politicore.governance_reference(now(), v_id)
  )
  RETURNING id INTO v_request;

  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_participant_id, body, is_public)
  VALUES
    (v_profile.tenant_id, v_request, 'submitted', v_participant, p_details, false);

  RETURN v_request;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Staff acknowledgement → 'acknowledged' (+ event).
CREATE OR REPLACE FUNCTION politicore.acknowledge_governance_request(
  p_request_id uuid,
  p_note text DEFAULT ''
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('manage_cases')) THEN
    RAISE EXCEPTION 'governance: manage_cases required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  UPDATE politicore.governance_requests SET status = 'acknowledged' WHERE id = p_request_id;
  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_profile_id, body, is_public)
  VALUES (v_tenant, p_request_id, 'acknowledged', auth.uid(), p_note, true);
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Assignment → 'assigned' (+ assignment row + event). Assignee must be a
-- same-tenant profile; scope recorded for later scope-aware queues.
CREATE OR REPLACE FUNCTION politicore.assign_governance_request(
  p_request_id uuid,
  p_assignee_profile_id uuid,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL,
  p_note text DEFAULT ''
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_assignee_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('assign_cases')) THEN
    RAISE EXCEPTION 'governance: assign_cases required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  SELECT tenant_id INTO v_assignee_tenant FROM politicore.profiles WHERE id = p_assignee_profile_id;
  IF v_assignee_tenant IS NULL OR v_assignee_tenant <> v_tenant THEN
    RAISE EXCEPTION 'governance: assignee must belong to the same tenant';
  END IF;

  INSERT INTO politicore.governance_assignments
    (tenant_id, request_id, assigned_to, assigned_by, scope_type, scope_id, note)
  VALUES (v_tenant, p_request_id, p_assignee_profile_id, auth.uid(), p_scope_type, p_scope_id, p_note);

  UPDATE politicore.governance_requests
    SET status = 'assigned', assigned_profile_id = p_assignee_profile_id
    WHERE id = p_request_id;

  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_profile_id, body, is_public)
  VALUES (v_tenant, p_request_id, 'assigned', auth.uid(), p_note, true);
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Status change by case-management staff (+ event). The status guard
-- trigger validates the transition; the event records who/when/why.
CREATE OR REPLACE FUNCTION politicore.update_governance_request_status(
  p_request_id uuid,
  p_status politicore.governance_request_status,
  p_note text DEFAULT '',
  p_is_public boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_kind politicore.governance_event_kind;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('manage_cases')) THEN
    RAISE EXCEPTION 'governance: manage_cases required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  UPDATE politicore.governance_requests SET status = p_status WHERE id = p_request_id;

  -- Explicit enum casts: a CASE over enum comparands with bare literals
  -- resolves to text, and text does not implicitly cast to enum on INSERT.
  v_kind := (CASE p_status::text
    WHEN 'in_progress' THEN 'status_changed'
    WHEN 'awaiting_information' THEN 'status_changed'
    WHEN 'resolved' THEN 'resolved'
    WHEN 'closed' THEN 'closed'
    WHEN 'rejected' THEN 'rejected'
    ELSE 'status_changed' END)::politicore.governance_event_kind;

  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_profile_id, body, status_to, is_public)
  VALUES (v_tenant, p_request_id, v_kind, auth.uid(), p_note, p_status, p_is_public);
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Staff or participant response (+ event). Staff = manage_cases holder;
-- participant = owner of the request's participant row.
CREATE OR REPLACE FUNCTION politicore.respond_governance_request(
  p_request_id uuid,
  p_body text,
  p_is_public boolean DEFAULT NULL
) RETURNS bigint AS $$
DECLARE
  v_tenant uuid;
  v_staff boolean;
  v_participant uuid;
  v_is_public boolean;
  v_event bigint;
BEGIN
  SELECT tenant_id INTO v_tenant FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;

  v_staff := politicore.is_tenant_admin() OR politicore.has_permission('manage_cases');
  SELECT id INTO v_participant
    FROM politicore.governance_participants
    WHERE profile_id = auth.uid();
  IF NOT v_staff AND (v_participant IS NULL OR NOT EXISTS (
    SELECT 1 FROM politicore.governance_requests
    WHERE id = p_request_id AND participant_id = v_participant
  )) THEN
    RAISE EXCEPTION 'governance: staff or owning participant required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  v_is_public := COALESCE(p_is_public, v_staff);
  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_profile_id, actor_participant_id, body, is_public)
  VALUES (
    v_tenant, p_request_id,
    (CASE WHEN v_staff THEN 'staff_response' ELSE 'participant_response' END)::politicore.governance_event_kind,
    CASE WHEN v_staff THEN auth.uid() END,
    CASE WHEN v_staff THEN NULL ELSE v_participant END,
    p_body, v_is_public
  )
  RETURNING id INTO v_event;
  RETURN v_event;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Participant feedback after resolution (1..5 + comment; once).
-- rating is integer (0028 convention): smallint signatures cannot be
-- matched by integer literals over the PostgREST/SQL resolution path.
CREATE OR REPLACE FUNCTION politicore.rate_governance_request(
  p_request_id uuid,
  p_rating integer,
  p_comment text DEFAULT ''
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_participant uuid;
BEGIN
  IF p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'governance: rating must be 1..5';
  END IF;
  SELECT tenant_id INTO v_tenant FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  SELECT id INTO v_participant FROM politicore.governance_participants WHERE profile_id = auth.uid();
  IF v_participant IS NULL OR NOT EXISTS (
    SELECT 1 FROM politicore.governance_requests
    WHERE id = p_request_id AND participant_id = v_participant
      AND status IN ('resolved','closed')
  ) THEN
    RAISE EXCEPTION 'governance: only the owning participant may rate a resolved request';
  END IF;

  UPDATE politicore.governance_requests
    SET feedback_rating = p_rating, feedback_comment = p_comment
    WHERE id = p_request_id AND feedback_rating IS NULL
    AND participant_id = v_participant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance: feedback already recorded';
  END IF;

  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_participant_id, body, is_public)
  VALUES (v_tenant, p_request_id, 'feedback', v_participant, p_comment, false);
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

GRANT EXECUTE ON FUNCTION politicore.submit_governance_request(text, text, uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.acknowledge_governance_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.assign_governance_request(uuid, uuid, politicore.scope_type_enum, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.update_governance_request_status(uuid, politicore.governance_request_status, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.respond_governance_request(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.rate_governance_request(uuid, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC RPC WRAPPERS (0028 convention — thin SECURITY INVOKER one-liners)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_governance_request(
  p_title text, p_details text, p_category_id uuid DEFAULT NULL,
  p_ward_id text DEFAULT NULL, p_lga_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.submit_governance_request(p_title, p_details, p_category_id, p_ward_id, p_lga_id, p_polling_unit_id);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.acknowledge_governance_request(
  p_request_id uuid, p_note text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.acknowledge_governance_request(p_request_id, COALESCE(p_note, ''));
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.assign_governance_request(
  p_request_id uuid, p_assignee_profile_id uuid,
  p_scope_type politicore.scope_type_enum DEFAULT NULL, p_scope_id text DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.assign_governance_request(p_request_id, p_assignee_profile_id, p_scope_type, p_scope_id, COALESCE(p_note, ''));
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.update_governance_request_status(
  p_request_id uuid, p_status politicore.governance_request_status,
  p_note text DEFAULT NULL, p_is_public boolean DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.update_governance_request_status(p_request_id, p_status, COALESCE(p_note, ''), COALESCE(p_is_public, false));
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.respond_governance_request(
  p_request_id uuid, p_body text, p_is_public boolean DEFAULT NULL
) RETURNS bigint AS $$
  SELECT politicore.respond_governance_request(p_request_id, p_body, p_is_public);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.rate_governance_request(
  p_request_id uuid, p_rating integer, p_comment text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.rate_governance_request(p_request_id, p_rating, COALESCE(p_comment, ''));
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION public.submit_governance_request(text, text, uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_governance_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_governance_request(uuid, uuid, politicore.scope_type_enum, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_governance_request_status(uuid, politicore.governance_request_status, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_governance_request(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rate_governance_request(uuid, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API VIEWS + GRANTS (0009/0033 conventions; security_invoker)
-- Governance is authenticated-only — NO anon grants (§14 privacy model).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.governance_participants
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_participants;
CREATE OR REPLACE VIEW public.governance_request_categories
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_request_categories;
CREATE OR REPLACE VIEW public.governance_requests
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_requests;
CREATE OR REPLACE VIEW public.governance_request_events
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_request_events;
CREATE OR REPLACE VIEW public.governance_assignments
  WITH (security_invoker = true) AS SELECT * FROM politicore.governance_assignments;

-- Base-table grants per 0009/0033 conventions (REQUIRED for the
-- security_invoker views: policy checks run with the caller's role).
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_participants       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_request_categories TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_requests           TO authenticated, service_role;
GRANT SELECT, INSERT              ON politicore.governance_request_events        TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.governance_assignments        TO authenticated, service_role;

-- View grants mirror the base grants; RLS remains the real boundary.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_participants       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_request_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_requests           TO authenticated;
GRANT SELECT, INSERT              ON public.governance_request_events        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_assignments        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_participants       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_request_categories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_requests           TO service_role;
GRANT SELECT, INSERT              ON public.governance_request_events        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_assignments        TO service_role;

-- Anonymous holds NOTHING on the governance surface (§14). Explicitly
-- revoked: hosted Supabase ALTER DEFAULT PRIVILEGES auto-grants ALL to
-- anon on every new public relation — this keeps the grant surface on
-- contract at creation time (mirrors 0035 hygiene).
REVOKE ALL ON public.governance_participants       FROM anon;
REVOKE ALL ON public.governance_request_categories FROM anon;
REVOKE ALL ON public.governance_requests           FROM anon;
REVOKE ALL ON public.governance_request_events     FROM anon;
REVOKE ALL ON public.governance_assignments        FROM anon;
-- The event trail is append-only AT THE GRANT LAYER TOO: hosted default
-- privileges also auto-grant UPDATE/DELETE to authenticated. No UPDATE/DELETE
-- policy exists, so RLS already denies every row — this removes even the
-- grant-level surface (the tamper trigger remains as belt-and-braces).
-- REVOKE from PUBLIC is required: table owners hold grantable rights via
-- PUBLIC regardless of per-role revokes.
REVOKE ALL ON public.governance_request_events     FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.governance_request_events TO authenticated, service_role;
REVOKE ALL ON public.governance_requests           FROM PUBLIC;
REVOKE ALL ON public.governance_request_events     FROM PUBLIC;
REVOKE ALL ON public.governance_assignments        FROM PUBLIC;
REVOKE ALL ON public.governance_participants       FROM PUBLIC;
REVOKE ALL ON public.governance_request_categories FROM PUBLIC;
-- Owner grant normalization: Postgres cannot revoke an owner's implicit
-- rights, but the auto-granted privilege rows are removable — keeping the
-- catalog exactly on contract (SELECT+INSERT only on the events view).
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.governance_request_events FROM postgres;

-- Append-only enforcement at the grant layer too (no UPDATE/DELETE grants
-- exist for governance_request_events anywhere).
COMMENT ON TABLE politicore.governance_requests IS
  'Governance & Citizen Engagement — citizen request/case aggregate. Peer module to Social Force/Campaign/Election. Lifecycle: submitted -> acknowledged -> assigned -> in_progress -> awaiting_information -> resolved -> closed (+ rejected). Writes flow through authority RPCs.';
COMMENT ON TABLE politicore.governance_participants IS
  'Governance participant/constituent relationship — domain record, NOT an access role; distinct from auth identity. Optional link to profiles when the participant is a portal member.';
COMMENT ON TABLE politicore.governance_request_events IS
  'Append-only governance case lifecycle/response trail (acknowledgement, assignment, status, staff/participant responses, resolution, feedback). No UPDATE/DELETE path exists.';
