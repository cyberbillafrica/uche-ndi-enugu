-- =====================================================================
-- 0028: SOCIAL FORCE PHASE A — RELATIONAL TASKS / SUBMISSIONS / POINTS
--
-- Social Force as a first-class, independently activatable module
-- (module code 'social'). Authority model (Social Force Architecture
-- Gate §7–§18, §39–§46):
--
--   Identity/Tenancy/Membership/Permissions/Geography/Media/
--   Notifications/Audit  = Core (REUSED, not recreated)
--
--   social_tasks ──< social_task_submissions ──< social_point_awards
--                                             (unique per submission)
--   social_point_awards → social_profile_points() → social_leaderboard
--
-- Legacy Firebase behavior preserved (discovery over
-- src/lib/firebase/firestore.ts, portal/tasks, admin/tasks, leaderboard):
--   * task: title/description/platform/action_type/points/status/
--     target_url/proof_required/expiration_date
--     platforms facebook|x|instagram|tiktok; actions like|comment|share|make_post
--   * one submission per (task, member); proof URL required for
--     share/make_post (also honored via proof_required flag); resubmit
--     overwrites proof while pending
--   * admin verification is the ONLY award path; points come from the
--     task row (never the client); one award per submission (legacy
--     transaction invariant, now a DB UNIQUE + trigger invariant)
--   * leaderboard = reduced public projection (display name, points,
--     rank, ward/LGA/zone context — polling unit deliberately excluded,
--     matching the legacy projection contract)
--
-- Security model:
--   * RLS ENABLED + FORCED on every table; SECURITY INVOKER views
--   * tenant + module_enabled('social') + membership/permission on
--     every policy; submitter/recipient pinned to auth.uid()
--   * verification + awarding + task management = SECURITY DEFINER RPCs
--     (audit via system_audits; award pre-inserted BEFORE the status
--     transition so the verify trigger proves the award linkage — a
--     direct-table verification is impossible)
--   * profiles.points becomes a server-maintained projection of
--     social_point_awards (gate §16/§19); client mutation was already
--     blocked by guard_profile_self_update and stays blocked
--
-- DOES NOT touch: Campaign (locked), Election (locked), Governance,
-- Donations, Control Center, Core authorization semantics.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
CREATE TYPE politicore.social_task_platform AS ENUM
  ('facebook', 'x', 'instagram', 'tiktok');

CREATE TYPE politicore.social_task_action AS ENUM
  ('like', 'comment', 'share', 'make_post');

-- Legacy lifecycle: admin toggles active/inactive (no draft in the
-- legacy product; do not invent states — gate §11).
CREATE TYPE politicore.social_task_status AS ENUM ('active', 'inactive');

-- Legacy submission lifecycle: pending → verified (verify-only; the
-- legacy product has no rejection path — gate §15).
CREATE TYPE politicore.social_submission_status AS ENUM ('pending', 'verified');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
CREATE TABLE politicore.social_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id),
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description     text,
  platform        politicore.social_task_platform NOT NULL DEFAULT 'facebook',
  action          politicore.social_task_action   NOT NULL DEFAULT 'share',
  points          integer NOT NULL CHECK (points >= 0 AND points <= 1000000),
  status          politicore.social_task_status NOT NULL DEFAULT 'active',
  target_url      text CHECK (target_url IS NULL OR length(target_url) <= 2048),
  -- explicit flag wins over the action default so admins can relax/tighten
  proof_required  boolean NOT NULL DEFAULT true,
  expiration_date timestamptz,
  created_by      uuid REFERENCES politicore.profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX social_tasks_tenant_status_idx ON politicore.social_tasks (tenant_id, status);
CREATE INDEX social_tasks_tenant_created_idx ON politicore.social_tasks (tenant_id, created_at DESC);

CREATE TABLE politicore.social_task_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id),
  task_id      uuid NOT NULL REFERENCES politicore.social_tasks(id),
  submitter_id uuid NOT NULL REFERENCES politicore.profiles(id),
  proof_url    text CHECK (proof_url IS NULL OR length(proof_url) <= 2048),
  status       politicore.social_submission_status NOT NULL DEFAULT 'pending',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz,
  verified_by  uuid REFERENCES politicore.profiles(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Legacy deterministic {taskId}_{userId} dedup, as a real constraint
  -- (gate §39): one submission per member per task, ever.
  UNIQUE (task_id, submitter_id)
);

CREATE INDEX social_submissions_tenant_status_idx ON politicore.social_task_submissions (tenant_id, status);
CREATE INDEX social_submissions_submitter_idx ON politicore.social_task_submissions (submitter_id, submitted_at DESC);
CREATE INDEX social_submissions_task_idx ON politicore.social_task_submissions (task_id, submitted_at DESC);

-- The authoritative point ledger (gate §16/§19). Append-only via RPC;
-- profiles.points is a maintained projection, not the source of truth.
CREATE TABLE politicore.social_point_awards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id),
  recipient_id  uuid NOT NULL REFERENCES politicore.profiles(id),
  submission_id uuid NOT NULL REFERENCES politicore.social_task_submissions(id),
  points        integer NOT NULL CHECK (points > 0),
  source        text NOT NULL DEFAULT 'task_verification',
  awarded_by    uuid NOT NULL REFERENCES politicore.profiles(id),
  awarded_at    timestamptz NOT NULL DEFAULT now(),
  -- Gate §17: one award per qualifying submission. Permanent.
  UNIQUE (submission_id)
);

CREATE INDEX social_awards_recipient_idx ON politicore.social_point_awards (recipient_id, awarded_at DESC);
CREATE INDEX social_awards_tenant_idx ON politicore.social_point_awards (tenant_id, awarded_at DESC);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
ALTER TABLE politicore.social_tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.social_tasks            FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.social_task_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.social_task_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.social_point_awards     ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.social_point_awards     FORCE ROW LEVEL SECURITY;

-- Tasks: readable by tenant admins (management) and by Social Members
-- when the task is currently participable. Campaign-only members get
-- nothing (gate §8). Inactive/expired tasks disappear for members.
CREATE POLICY social_tasks_select ON politicore.social_tasks
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND (
      politicore.is_admin()
      OR (
        politicore.has_membership('social_member')
        AND status = 'active'
        AND (expiration_date IS NULL OR expiration_date > now())
      )
    )
  );

-- Task mutations happen through authority RPCs only; these policies
-- authorize the RPC path under FORCE RLS while direct PostgREST table
-- mutation stays impossible (public view exposes SELECT only).
CREATE POLICY social_tasks_admin_insert ON politicore.social_tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND politicore.is_admin()
    AND created_by = auth.uid()
  );

CREATE POLICY social_tasks_admin_update ON politicore.social_tasks
  FOR UPDATE TO authenticated
  USING (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND politicore.is_admin()
  )
  WITH CHECK (
    tenant_id = politicore.current_tenant_id()
  );

-- Submissions: a member sees only their own; admins see all in tenant.
CREATE POLICY social_submissions_select ON politicore.social_task_submissions
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND (submitter_id = auth.uid() OR politicore.is_admin())
  );

-- Direct member INSERT (PostgREST path): own behalf only, into an
-- active, unexpired, scoreable task of their tenant, honoring the
-- proof rule. Everything is re-validated server-side by the trigger
-- guard below and by the RPC path.
CREATE POLICY social_submissions_insert ON politicore.social_task_submissions
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND submitter_id = auth.uid()
    AND status = 'pending'
    AND EXISTS (
      SELECT 1 FROM politicore.social_tasks t
      WHERE t.id = task_id
        AND t.tenant_id = politicore.current_tenant_id()
        AND t.status = 'active'
        AND t.points > 0
        AND (t.expiration_date IS NULL OR t.expiration_date > now())
        AND (t.proof_required = false OR proof_url IS NOT NULL)
    )
  );

-- Resubmission (proof overwrite) while pending; ownership stays pinned.
CREATE POLICY social_submissions_self_update ON politicore.social_task_submissions
  FOR UPDATE TO authenticated
  USING (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND submitter_id = auth.uid()
    AND status = 'pending'
  )
  WITH CHECK (
    submitter_id = auth.uid()
    AND status = 'pending'
    AND tenant_id = politicore.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM politicore.social_tasks t
      WHERE t.id = task_id
        AND t.tenant_id = politicore.current_tenant_id()
        AND t.status = 'active'
        AND t.points > 0
        AND (t.expiration_date IS NULL OR t.expiration_date > now())
        AND (t.proof_required = false OR proof_url IS NOT NULL)
    )
  );

-- Admin verification transition (RPC path). WITH CHECK pins the target
-- state so this policy cannot be abused for anything but verifying.
CREATE POLICY social_submissions_admin_verify ON politicore.social_task_submissions
  FOR UPDATE TO authenticated
  USING (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND politicore.is_admin()
  )
  WITH CHECK (
    tenant_id = politicore.current_tenant_id()
    AND status = 'verified'
  );

-- Awards: read own (members) / all (admins). Mutation policies exist
-- solely to authorize the verify-RPC path under FORCE RLS; no view
-- grants expose them to PostgREST.
CREATE POLICY social_awards_select ON politicore.social_point_awards
  FOR SELECT TO authenticated
  USING (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND (recipient_id = auth.uid() OR politicore.is_admin())
  );

CREATE POLICY social_awards_rpc_insert ON politicore.social_point_awards
  FOR INSERT TO authenticated
  WITH CHECK (
    politicore.module_enabled('social')
    AND tenant_id = politicore.current_tenant_id()
    AND politicore.is_admin()
    AND awarded_by = auth.uid()
    AND points > 0
    AND EXISTS (
      SELECT 1 FROM politicore.social_task_submissions s
      WHERE s.id = submission_id
        AND s.tenant_id = politicore.current_tenant_id()
    )
  );

-- ---------------------------------------------------------------------
-- Submission integrity trigger
-- ---------------------------------------------------------------------
-- Enforces the invariants policies cannot express:
--   * ownership immutable (submitter/task/tenant can never change)
--   * a verified submission is immutable
--   * pending → verified REQUIRES an existing authoritative award and
--     resolves verified_by server-side (client cannot forge the
--     verifier — gate §14/§18/§41)
CREATE OR REPLACE FUNCTION politicore.guard_social_submission() RETURNS trigger AS $$
BEGIN
  IF NEW.submitter_id <> OLD.submitter_id
     OR NEW.task_id      <> OLD.task_id
     OR NEW.tenant_id    <> OLD.tenant_id THEN
    RAISE EXCEPTION 'submission ownership is immutable';
  END IF;

  IF OLD.status = 'verified' THEN
    IF NEW.status <> 'verified'
       OR NEW.proof_url   IS DISTINCT FROM OLD.proof_url
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verified_by IS DISTINCT FROM OLD.verified_by THEN
      RAISE EXCEPTION 'verified submissions are immutable';
    END IF;
  END IF;

  IF NEW.status = 'verified' AND OLD.status <> 'verified' THEN
    IF NOT EXISTS (
      SELECT 1 FROM politicore.social_point_awards a
      WHERE a.submission_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'verification requires an authoritative point award';
    END IF;
    NEW.proof_url   := OLD.proof_url;
    NEW.verified_by := auth.uid();
    IF NEW.verified_by IS NULL THEN
      RAISE EXCEPTION 'verifier identity is required';
    END IF;
    NEW.verified_at := COALESCE(NEW.verified_at, now());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE TRIGGER trg_social_submissions_guard
  BEFORE UPDATE ON politicore.social_task_submissions
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_social_submission();

CREATE TRIGGER social_task_submissions_updated_at BEFORE UPDATE
  ON politicore.social_task_submissions
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

CREATE TRIGGER social_tasks_updated_at BEFORE UPDATE
  ON politicore.social_tasks
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

-- ---------------------------------------------------------------------
-- Authority RPCs (SECURITY DEFINER; sole authorization boundary)
-- ---------------------------------------------------------------------

-- Authoritative points total derived from the award ledger (gate §19).
CREATE OR REPLACE FUNCTION politicore.social_profile_points(p_user uuid)
RETURNS integer AS $$
  SELECT COALESCE(SUM(a.points), 0)::integer
  FROM politicore.social_point_awards a
  WHERE a.recipient_id = p_user;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.create_social_task(
  p_title          text,
  p_description    text DEFAULT NULL,
  p_platform       politicore.social_task_platform DEFAULT 'facebook',
  p_action         politicore.social_task_action DEFAULT 'share',
  p_points         integer DEFAULT 0,
  p_status         politicore.social_task_status DEFAULT 'active',
  p_target_url     text DEFAULT NULL,
  p_proof_required boolean DEFAULT true,
  p_expiration_date timestamptz DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_id     uuid;
  v_url    text := nullif(btrim(coalesce(p_target_url, '')), '');
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  IF NOT politicore.module_enabled('social') THEN
    RAISE EXCEPTION 'social module is not enabled';
  END IF;
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'task management requires admin authority';
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'task title is required';
  END IF;
  IF p_points IS NULL OR p_points < 0 OR p_points > 1000000 THEN
    RAISE EXCEPTION 'invalid points value';
  END IF;
  IF p_expiration_date IS NOT NULL AND p_expiration_date <= now() THEN
    RAISE EXCEPTION 'expiration date must be in the future';
  END IF;

  INSERT INTO politicore.social_tasks
    (tenant_id, title, description, platform, action, points, status,
     target_url, proof_required, expiration_date, created_by)
  VALUES
    (v_tenant, btrim(p_title), p_description, p_platform, p_action,
     p_points, p_status, v_url, p_proof_required, p_expiration_date, auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(), 'social_task:insert', 'social_tasks', v_id::text,
     jsonb_build_object('title', btrim(p_title), 'points', p_points,
                        'status', p_status, 'action', p_action));

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.update_social_task(
  p_task           uuid,
  p_title          text DEFAULT NULL,
  p_description    text DEFAULT NULL,
  p_platform       politicore.social_task_platform DEFAULT NULL,
  p_action         politicore.social_task_action DEFAULT NULL,
  p_points         integer DEFAULT NULL,
  p_status         politicore.social_task_status DEFAULT NULL,
  p_target_url     text DEFAULT NULL,
  p_proof_required boolean DEFAULT NULL,
  p_expiration_date timestamptz DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_old    politicore.social_tasks;
  v_new    politicore.social_tasks;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  IF NOT politicore.module_enabled('social') THEN
    RAISE EXCEPTION 'social module is not enabled';
  END IF;
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'task management requires admin authority';
  END IF;
  IF p_points IS NOT NULL AND (p_points < 0 OR p_points > 1000000) THEN
    RAISE EXCEPTION 'invalid points value';
  END IF;

  SELECT * INTO v_old FROM politicore.social_tasks
    WHERE id = p_task AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task not found';
  END IF;

  UPDATE politicore.social_tasks SET
    title           = COALESCE(nullif(btrim(coalesce(p_title, '')), ''), title),
    description     = COALESCE(p_description, description),
    platform        = COALESCE(p_platform, platform),
    action          = COALESCE(p_action, action),
    points          = COALESCE(p_points, points),
    status          = COALESCE(p_status, status),
    target_url      = CASE WHEN p_target_url IS NULL THEN target_url
                           ELSE nullif(btrim(p_target_url), '') END,
    proof_required  = COALESCE(p_proof_required, proof_required),
    expiration_date = COALESCE(p_expiration_date, expiration_date)
  WHERE id = p_task
  RETURNING * INTO v_new;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value)
  VALUES
    (v_tenant, auth.uid(), 'social_task:update', 'social_tasks', p_task::text,
     to_jsonb(v_old), to_jsonb(v_new));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.set_social_task_status(
  p_task   uuid,
  p_status politicore.social_task_status
) RETURNS void AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  IF NOT politicore.module_enabled('social') THEN
    RAISE EXCEPTION 'social module is not enabled';
  END IF;
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'task management requires admin authority';
  END IF;

  UPDATE politicore.social_tasks SET status = p_status
    WHERE id = p_task AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task not found';
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(), 'social_task:status', 'social_tasks', p_task::text,
     jsonb_build_object('status', p_status));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Member submission: own behalf only (actor server-resolved). One row
-- per (task, member); resubmission overwrites the proof while pending.
CREATE OR REPLACE FUNCTION politicore.submit_social_task(
  p_task      uuid,
  p_proof_url text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant  uuid := politicore.current_tenant_id();
  v_task    politicore.social_tasks;
  v_proof   text := nullif(btrim(coalesce(p_proof_url, '')), '');
  v_id      uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  IF NOT politicore.module_enabled('social') THEN
    RAISE EXCEPTION 'social module is not enabled';
  END IF;
  IF NOT politicore.has_membership('social_member') THEN
    RAISE EXCEPTION 'social membership is required to submit tasks';
  END IF;

  SELECT * INTO v_task FROM politicore.social_tasks
    WHERE id = p_task AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task not found';
  END IF;
  IF v_task.status <> 'active' THEN
    RAISE EXCEPTION 'task is not active';
  END IF;
  IF v_task.expiration_date IS NOT NULL AND v_task.expiration_date <= now() THEN
    RAISE EXCEPTION 'task has expired';
  END IF;
  IF v_task.points <= 0 THEN
    RAISE EXCEPTION 'task is not scoreable';
  END IF;
  IF v_task.proof_required AND v_proof IS NULL THEN
    RAISE EXCEPTION 'proof URL is required for this task';
  END IF;

  INSERT INTO politicore.social_task_submissions
    (tenant_id, task_id, submitter_id, proof_url, status)
  VALUES
    (v_tenant, p_task, auth.uid(), v_proof, 'pending')
  ON CONFLICT (task_id, submitter_id) DO UPDATE
    SET proof_url = EXCLUDED.proof_url
    WHERE politicore.social_task_submissions.status = 'pending';

  SELECT id INTO v_id FROM politicore.social_task_submissions
    WHERE task_id = p_task AND submitter_id = auth.uid();
  IF (SELECT status FROM politicore.social_task_submissions WHERE id = v_id) = 'verified' THEN
    RAISE EXCEPTION 'submission has already been verified';
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Admin verification + one-time award. The award row is inserted
-- BEFORE the status transition so the guard trigger proves the
-- authoritative linkage; the UNIQUE(submission_id) + NOT EXISTS guard
-- make duplicate awards impossible even under concurrency.
CREATE OR REPLACE FUNCTION politicore.verify_social_submission(
  p_submission uuid
) RETURNS void AS $$
DECLARE
  v_tenant  uuid := politicore.current_tenant_id();
  v_sub     politicore.social_task_submissions;
  v_task    politicore.social_tasks;
  v_points  integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  IF NOT politicore.module_enabled('social') THEN
    RAISE EXCEPTION 'social module is not enabled';
  END IF;
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'submission verification requires admin authority';
  END IF;

  SELECT * INTO v_sub FROM politicore.social_task_submissions
    WHERE id = p_submission AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found';
  END IF;
  IF v_sub.status = 'verified' THEN
    RAISE EXCEPTION 'submission has already been verified';
  END IF;

  SELECT * INTO v_task FROM politicore.social_tasks
    WHERE id = v_sub.task_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task not found';
  END IF;
  v_points := v_task.points;
  IF v_points IS NULL OR v_points <= 0 THEN
    RAISE EXCEPTION 'this task does not have valid points assigned';
  END IF;

  -- 1. Authoritative ledger append (guarded against duplicates).
  INSERT INTO politicore.social_point_awards
    (tenant_id, recipient_id, submission_id, points, source, awarded_by)
  SELECT v_tenant, v_sub.submitter_id, p_submission, v_points,
         'task_verification', auth.uid()
  WHERE NOT EXISTS (
    SELECT 1 FROM politicore.social_point_awards
    WHERE submission_id = p_submission
  );

  -- 2. Transition (guard trigger validates the award linkage and
  --    resolves verified_by/verified_at server-side).
  UPDATE politicore.social_task_submissions
    SET status = 'verified'
    WHERE id = p_submission AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission has already been verified';
  END IF;

  -- 3. Maintain the profiles.points projection from the ledger.
  UPDATE politicore.profiles pr
     SET points = politicore.social_profile_points(pr.id)
   WHERE pr.id = v_sub.submitter_id
     AND pr.points <> politicore.social_profile_points(pr.id);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(), 'social_submission:verify', 'social_task_submissions',
     p_submission::text,
     jsonb_build_object('task_id', v_sub.task_id,
                        'recipient_id', v_sub.submitter_id,
                        'points', v_points));

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  VALUES
    (v_tenant, v_sub.submitter_id, 'task', 'Task verified',
     format('Your submission for "%s" was verified — %s points awarded.',
            v_task.title, v_points),
     '/portal/tasks', auth.uid());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- Public data-API surface (security_invoker views + public wrappers)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.social_tasks
  WITH (security_invoker = true) AS SELECT * FROM politicore.social_tasks;

CREATE OR REPLACE VIEW public.social_task_submissions
  WITH (security_invoker = true) AS SELECT * FROM politicore.social_task_submissions;

CREATE OR REPLACE VIEW public.social_point_awards
  WITH (security_invoker = true) AS SELECT * FROM politicore.social_point_awards;

-- Reduced public projection for the leaderboard (gate §22): display
-- name, points, rank, tenant + ward/LGA/zone context. Polling unit is
-- deliberately excluded, matching the legacy projection contract.
CREATE OR REPLACE VIEW public.social_leaderboard
  WITH (security_invoker = true) AS
SELECT
  p.id,
  p.tenant_id,
  p.full_name,
  p.points,
  p.rank,
  p.ward_id,
  w.name  AS ward_name,
  w.lga_id,
  l.zone_id,
  ROW_NUMBER() OVER (
    PARTITION BY p.tenant_id
    ORDER BY p.points DESC, p.full_name ASC, p.id ASC
  ) AS position
FROM politicore.profiles p
LEFT JOIN politicore.wards w ON w.id = p.ward_id
LEFT JOIN politicore.lgas  l ON l.id = w.lga_id
WHERE p.points > 0;

CREATE OR REPLACE FUNCTION public.create_social_task(
  p_title text, p_description text DEFAULT NULL,
  p_platform politicore.social_task_platform DEFAULT 'facebook',
  p_action politicore.social_task_action DEFAULT 'share',
  p_points integer DEFAULT 0,
  p_status politicore.social_task_status DEFAULT 'active',
  p_target_url text DEFAULT NULL,
  p_proof_required boolean DEFAULT true,
  p_expiration_date timestamptz DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.create_social_task(p_title, p_description, p_platform,
    p_action, p_points, p_status, p_target_url, p_proof_required, p_expiration_date);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.update_social_task(
  p_task uuid, p_title text DEFAULT NULL, p_description text DEFAULT NULL,
  p_platform politicore.social_task_platform DEFAULT NULL,
  p_action politicore.social_task_action DEFAULT NULL,
  p_points integer DEFAULT NULL,
  p_status politicore.social_task_status DEFAULT NULL,
  p_target_url text DEFAULT NULL,
  p_proof_required boolean DEFAULT NULL,
  p_expiration_date timestamptz DEFAULT NULL
) RETURNS void AS $$
  SELECT politicore.update_social_task(p_task, p_title, p_description,
    p_platform, p_action, p_points, p_status, p_target_url,
    p_proof_required, p_expiration_date);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.set_social_task_status(
  p_task uuid, p_status politicore.social_task_status
) RETURNS void AS $$
  SELECT politicore.set_social_task_status(p_task, p_status);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.submit_social_task(
  p_task uuid, p_proof_url text DEFAULT NULL
) RETURNS uuid AS $$
  SELECT politicore.submit_social_task(p_task, p_proof_url);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.verify_social_submission(
  p_submission uuid
) RETURNS void AS $$
  SELECT politicore.verify_social_submission(p_submission);
$$ LANGUAGE sql;

-- ---------------------------------------------------------------------
-- Grants (explicit; revoke-then-grant per 0027 hygiene standard)
-- ---------------------------------------------------------------------
REVOKE ALL ON public.social_tasks            FROM anon, authenticated;
REVOKE ALL ON public.social_task_submissions FROM anon, authenticated;
REVOKE ALL ON public.social_point_awards     FROM anon, authenticated;
REVOKE ALL ON public.social_leaderboard      FROM anon, authenticated;

GRANT SELECT ON public.social_tasks            TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.social_task_submissions TO authenticated;
GRANT SELECT ON public.social_point_awards     TO authenticated;
GRANT SELECT ON public.social_leaderboard      TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_social_task(text, text,
  politicore.social_task_platform, politicore.social_task_action,
  integer, politicore.social_task_status, text, boolean, timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_social_task(uuid, text, text,
  politicore.social_task_platform, politicore.social_task_action,
  integer, politicore.social_task_status, text, boolean, timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_social_task_status(uuid, politicore.social_task_status)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_social_task(uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_social_submission(uuid)
  TO authenticated;
