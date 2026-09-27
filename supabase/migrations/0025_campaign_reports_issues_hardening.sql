-- =====================================================================
-- 0025: CAMPAIGN REPORTS + ISSUES HARDENING (Phase D)
--       1. public.* PostgREST wrappers for the report/issue workflow
--          RPCs (0015/0023/0024 convention) — the hosted data API
--          executes only public.* functions; without these the
--          application service layer itself 404s on /rest/v1/rpc/*.
--       2. Issue-assignee eligibility (Phase D §15): an issue assignee
--          must be an in-tenant campaign_member whose registered
--          location is covered by the issue scope — matching the
--          assignment create-guard ratified in 0024.
--       3. Submission audit (Phase D §29): report submission now writes
--          campaign.report.submit with the server-resolved reporter.
-- No existing signature changes; authorization remains in politicore.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. submit_campaign_report — re-issued with the §29 submission audit
--    (authority: submit_field_report at the report scope; submitter and
--    tenant always server-resolved; initial status pinned 'submitted').
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

  -- Phase D §29: submission is an authority-bearing act and is audited.
  PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.report.submit',
    'campaign_field_report', v_id::text, NULL,
    jsonb_build_object('report_type', p_report_type, 'scope_type', p_scope_type,
                       'scope_id', p_scope_id, 'title', p_title));

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------
-- 2. campaign_issue_transition — re-issued with the §15 assignee
--    eligibility guard on the 'assign' action (in-tenant campaign_member
--    whose registered location is covered by the issue scope; members
--    without a registered location remain tenant-assignable). All other
--    actions, actor distinctions (resolver/verifier/closer) and audit
--    behavior are preserved verbatim from 0021.
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
    -- Phase D §15: the assignee must be an in-tenant CAMPAIGN member
    -- whose registered location is covered by the issue scope.
    IF NOT EXISTS (SELECT 1 FROM politicore.profiles pr
                   WHERE pr.id = p_assignee
                     AND pr.tenant_id = v_tenant
                     AND 'campaign_member' = ANY (pr.membership_types)
                     AND (
                       (pr.lga_id IS NULL AND pr.ward_id IS NULL AND pr.polling_unit_id IS NULL)
                       OR politicore.scope_covers(v_row.scope_type, v_row.scope_id, 'polling_unit', pr.polling_unit_id)
                       OR politicore.scope_covers(v_row.scope_type, v_row.scope_id, 'ward', pr.ward_id)
                       OR politicore.scope_covers(v_row.scope_type, v_row.scope_id, 'lga', pr.lga_id)
                     )) THEN
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
-- 3. public.* wrappers (thin SECURITY INVOKER delegators — zero
--    authorization here; the politicore originals are authoritative).
--    Required because PostgREST /rest/v1/rpc/* resolves public.* only.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_campaign_report(
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
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.submit_campaign_report(p_report_type, p_title, p_description,
    p_scope_type, p_scope_id, p_location, p_participants, p_issues,
    p_community_feedback, p_requests, p_follow_up_required, p_evidence);
$$;

CREATE OR REPLACE FUNCTION public.review_campaign_report(
  p_report uuid,
  p_action text,
  p_comment text DEFAULT NULL
)
RETURNS politicore.campaign_report_status
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.review_campaign_report(p_report, p_action, p_comment);
$$;

CREATE OR REPLACE FUNCTION public.resubmit_campaign_report(
  p_report uuid,
  p_description text,
  p_evidence uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.resubmit_campaign_report(p_report, p_description, p_evidence);
$$;

CREATE OR REPLACE FUNCTION public.campaign_issue_transition(
  p_issue uuid,
  p_action text,
  p_assignee uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS politicore.campaign_issue_status
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT politicore.campaign_issue_transition(p_issue, p_action, p_assignee, p_notes);
$$;

GRANT EXECUTE ON FUNCTION public.submit_campaign_report(politicore.campaign_report_type,
  text, text, politicore.scope_type_enum, text, text, integer, text, text, text, boolean, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_campaign_report(uuid, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resubmit_campaign_report(uuid, text, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.campaign_issue_transition(uuid, text, uuid, text)
  TO authenticated, service_role;
