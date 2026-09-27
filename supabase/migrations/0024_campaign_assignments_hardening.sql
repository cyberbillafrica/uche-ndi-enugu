-- =====================================================================
-- 0024: CAMPAIGN ASSIGNMENTS HARDENING (Phase C)
--       1. public.* PostgREST wrappers for the assignment workflow RPCs
--          (0015/0023 convention — the hosted data API executes only
--          public.* functions; without these the application service
--          layer itself 404s on /rest/v1/rpc/*).
--       2. Campaign-member eligibility on assignment create/reassign
--          (Architecture Gate §3.3 create-guard + Phase C prompt §11):
--          an assignee must be a campaign_member of the tenant, not
--          merely any authenticated profile in it.
-- No existing signature changes; authorization remains in politicore.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Eligibility: the assignee must hold 'campaign_member' membership.
--    Applied to create_campaign_assignment (initial assignee) and to
--    the reassign branch of update_campaign_assignment_details, so a
--    non-member profile (social-only, plain voter, cross-tenant user)
--    can never become the target of campaign operational work.
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
  -- Phase C §11: the assignee must be an in-tenant CAMPAIGN member —
  -- an authenticated account alone (social-only, election-domain, or
  -- another tenant's profile) is not eligible for campaign work.
  IF NOT EXISTS (
    SELECT 1 FROM politicore.profiles pr
    WHERE pr.id = p_assigned_to
      AND pr.tenant_id = v_tenant
      AND 'campaign_member' = ANY (pr.membership_types)
      -- Gate §3.3 create-guard: when the assignee has a registered
      -- location, their location must be COVERED by the assignment
      -- scope (scope_covers polarity). Members without a registered
      -- location remain tenant-assignable.
      AND (
        (pr.lga_id IS NULL AND pr.ward_id IS NULL AND pr.polling_unit_id IS NULL)
        OR politicore.scope_covers(p_scope_type, p_scope_id, 'polling_unit', pr.polling_unit_id)
        OR politicore.scope_covers(p_scope_type, p_scope_id, 'ward', pr.ward_id)
        OR politicore.scope_covers(p_scope_type, p_scope_id, 'lga', pr.lga_id)
      )
  ) THEN
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

-- Reassign branch: same eligibility for the NEW assignee (the original
-- was already validated at creation; edits never relax it).
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
                   WHERE pr.id = p_reassign_to
                     AND pr.tenant_id = v_tenant
                     AND 'campaign_member' = ANY (pr.membership_types)
                     -- Same §3.3 create-guard for the NEW assignee.
                     AND (
                       (pr.lga_id IS NULL AND pr.ward_id IS NULL AND pr.polling_unit_id IS NULL)
                       OR politicore.scope_covers(v_row.scope_type, v_row.scope_id, 'polling_unit', pr.polling_unit_id)
                       OR politicore.scope_covers(v_row.scope_type, v_row.scope_id, 'ward', pr.ward_id)
                       OR politicore.scope_covers(v_row.scope_type, v_row.scope_id, 'lga', pr.lga_id)
                     )) THEN
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
-- 2. Delete policy: add the Gate §3.3 terminal-state guard — completed
--    assignments are part of the record and are no longer deletable
--    (supervisor-only + non-terminal; unchanged otherwise).
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS campaign_assignments_delete ON politicore.campaign_assignments;
CREATE POLICY campaign_assignments_delete ON politicore.campaign_assignments
  FOR DELETE TO authenticated
  USING (
    politicore.module_enabled('campaign')
    AND tenant_id = politicore.current_tenant_id()
    AND status <> 'completed'
    AND (
      politicore.is_admin()
      OR politicore.has_permission('create_assignment', scope_type, scope_id)
    )
  );

-- The 0021 public view is SELECT-only by grant; deletion flows the
-- DELETE policy above, so the view needs the matching grant for the
-- service's delete path to reach it. INSERT/UPDATE remain RPC-only.
GRANT DELETE ON public.campaign_assignments TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. RPC: campaign_assignable_members — the assignment form's assignee
--    picker, resolved entirely server-side (D2 class: no tenant-wide
--    directory download, no client scope expansion). Returns the
--    campaign members eligible for work at a TARGET SCOPE: profiles of
--    the caller's tenant holding 'campaign_member' whose registered
--    location (ward/lga columns) is COVERED by the target scope per
--    scope_covers(). Access requires campaign module + create/review
--    assignment authority at that exact target scope (is_admin branch
--    included). Contact fields stay gated by view_member_contacts,
--    mirroring campaign_members_in_scope.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.campaign_assignable_members(
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
)
RETURNS TABLE (
  id        uuid,
  full_name text,
  email     text,
  phone     text,
  ward_id   text,
  lga_id    text
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
             OR politicore.has_permission('create_assignment', p_scope_type, p_scope_id)
             OR politicore.has_permission('review_assignment', p_scope_type, p_scope_id)) THEN
    RAISE EXCEPTION 'not authorized to resolve assignees at this scope'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    pr.id,
    pr.full_name,
    pr.email,
    CASE WHEN politicore.has_permission('view_member_contacts') THEN pr.phone END,
    pr.ward_id::text,
    pr.lga_id::text
  FROM politicore.profiles pr
  WHERE pr.tenant_id = politicore.current_tenant_id()
    AND 'campaign_member' = ANY (pr.membership_types)
    -- Same eligibility predicate as the create/reassign RPCs
    -- (registered location covered by the target scope; members
    -- without a registered location are tenant-assignable).
    AND (
      (pr.lga_id IS NULL AND pr.ward_id IS NULL AND pr.polling_unit_id IS NULL)
      OR politicore.scope_covers(p_scope_type, p_scope_id, 'polling_unit', pr.polling_unit_id)
      OR politicore.scope_covers(p_scope_type, p_scope_id, 'ward', pr.ward_id)
      OR politicore.scope_covers(p_scope_type, p_scope_id, 'lga', pr.lga_id)
    )
  ORDER BY pr.full_name;
END;
$$;

GRANT EXECUTE ON FUNCTION politicore.campaign_assignable_members(
  politicore.scope_type_enum, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.campaign_assignable_members(
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
)
RETURNS TABLE (
  id        uuid,
  full_name text,
  email     text,
  phone     text,
  ward_id   text,
  lga_id    text
)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.campaign_assignable_members(p_scope_type, p_scope_id);
$$;

GRANT EXECUTE ON FUNCTION public.campaign_assignable_members(
  politicore.scope_type_enum, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. public.* wrappers (thin SECURITY INVOKER delegators — zero
--    authorization here; the politicore originals are authoritative).
--    Required because PostgREST /rest/v1/rpc/* resolves public.* only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.campaign_assignment_transition(
  p_assignment uuid,
  p_action text
)
RETURNS politicore.campaign_assignment_status
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.campaign_assignment_transition(p_assignment, p_action);
$$;

CREATE OR REPLACE FUNCTION public.update_campaign_assignment_details(
  p_assignment uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_priority politicore.campaign_assignment_priority DEFAULT NULL,
  p_due_date date DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_reassign_to uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.update_campaign_assignment_details(p_assignment, p_title,
    p_description, p_priority, p_due_date, p_location, p_reassign_to);
$$;

CREATE OR REPLACE FUNCTION public.create_campaign_assignment(
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
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.create_campaign_assignment(p_title, p_description, p_assigned_to,
    p_scope_type, p_scope_id, p_priority, p_due_date, p_location);
$$;

GRANT EXECUTE ON FUNCTION public.create_campaign_assignment(text, text, uuid,
  politicore.scope_type_enum, text, politicore.campaign_assignment_priority, date, text)
  TO authenticated, service_role;

-- Directory RPC used by the assignment UI's assignee picker (D2-corrected
-- server-side scope filtering). Same wrapper convention.
CREATE OR REPLACE FUNCTION public.campaign_members_in_scope()
RETURNS TABLE (
  id            uuid,
  full_name     text,
  email         text,
  phone         text,
  position_name text,
  scope_type    politicore.scope_type_enum,
  scope_id      text
)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT * FROM politicore.campaign_members_in_scope();
$$;

GRANT EXECUTE ON FUNCTION public.campaign_assignment_transition(uuid, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_campaign_assignment_details(uuid, text, text,
  politicore.campaign_assignment_priority, date, text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.campaign_members_in_scope()
  TO authenticated, service_role;
