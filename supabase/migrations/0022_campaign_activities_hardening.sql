-- =====================================================================
-- 0022: CAMPAIGN ACTIVITIES HARDENING (Campaign Phase B)
--
-- Closes the direct-mutation loophole the Phase B gate mandates
-- verifying (§4/§16): the Phase A UPDATE policy on campaign_activities
-- authorized by manage_activity, but a direct UPDATE could still mutate
-- the AUTHORITY-BEARING fields (status, scope_type/scope_id, created_by,
-- tenant_id) outside the approved paths:
--   * status must only change through set_campaign_activity_status
--   * scope changes must be explicitly re-authorized server-side
--   * creator/tenant identity is never client-writable
--
-- Direct UPDATE is therefore revoked from `authenticated`; ordinary
-- detail edits flow through the new update_campaign_activity RPC whose
-- field whitelist and per-field authorization are the boundary. INSERT
-- remains policy-guarded (WITH CHECK pins tenant/creator/status and
-- requires create_activity at the activity scope); DELETE keeps its
-- manage_activity policy. No Election/Core object is touched.
-- =====================================================================

-- 1. Close the direct UPDATE path (table + any inheriting view grant).
--    The public view is auto-updatable: PostgREST checks the UPDATE
--    privilege against the VIEW, so revoking only the base table would
--    leave PATCH /rest/v1/campaign_activities open — and the view-level
--    path is column-unconstrained (status/scope/creator could be
--    mutated outside the RPC workflows).
REVOKE UPDATE ON politicore.campaign_activities FROM authenticated;
REVOKE UPDATE ON public.campaign_activities FROM authenticated;

-- 1c. INSERT … RETURNING defect fix (found by the Phase B suite).
--     The Phase A SELECT policy called can_view_campaign_activity(id), a
--     STABLE definer helper that RE-READS campaign_activities. STABLE
--     functions cannot see rows inserted by the current command, so the
--     WITH CHECK re-check of every INSERT … RETURNING (the exact path
--     PostgREST and campaignService.createActivity use) failed for ALL
--     authorized creators. Same visibility terms, now evaluated from the
--     bound row values instead of a self-read:
CREATE OR REPLACE FUNCTION politicore.can_view_campaign_activity_row(
  p_id uuid,
  p_tenant uuid,
  p_created_by uuid,
  p_organizer_id uuid,
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
) RETURNS boolean AS $$
  SELECT p_tenant = politicore.current_tenant_id()
    AND politicore.module_enabled('campaign')
    AND (
      politicore.is_admin()
      OR politicore.has_permission('view_activities', p_scope_type, p_scope_id)
      OR politicore.has_permission('create_activity', p_scope_type, p_scope_id)
      OR p_created_by = auth.uid()
      OR p_organizer_id = auth.uid()
      OR EXISTS (SELECT 1 FROM politicore.campaign_activity_participants p
                 WHERE p.activity_id = p_id AND p.user_id = auth.uid())
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- The id-based variant keeps its signature (participants SELECT policy
-- and the join RPC use it): look the row up definer-side, delegate to
-- the row variant. Reading activities here is safe — the participants
-- policies never re-check activities rows inserted in the same command.
CREATE OR REPLACE FUNCTION politicore.can_view_campaign_activity(p_activity uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM politicore.campaign_activities a
    WHERE a.id = p_activity
      AND politicore.can_view_campaign_activity_row(
            a.id, a.tenant_id, a.created_by, a.organizer_id, a.scope_type, a.scope_id));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Rebind the activities SELECT policy to the row variant.
DROP POLICY IF EXISTS campaign_activities_select ON politicore.campaign_activities;
CREATE POLICY campaign_activities_select ON politicore.campaign_activities
  FOR SELECT TO authenticated
  USING (
    politicore.can_view_campaign_activity_row(
      id, tenant_id, created_by, organizer_id, scope_type, scope_id)
  );

-- 1b. Organizer defaults to the creator server-side (the UI never needs
--     to supply an actor identity; explicit organizer set remains possible
--     through the update RPC where authorized).
ALTER TABLE politicore.campaign_activities
  ALTER COLUMN organizer_id SET DEFAULT auth.uid();

-- 2. update_campaign_activity — ordinary detail editing with per-field
--    authorization. Authority-bearing fields (tenant_id, created_by,
--    status) are NOT parameters. Scope change IS supported but must be
--    explicitly authorized for the NEW scope (create_activity at it) —
--    the §6 "explicitly authorized server-side and tested" path.
CREATE OR REPLACE FUNCTION politicore.update_campaign_activity(
  p_activity uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_activity_type politicore.campaign_activity_type DEFAULT NULL,
  p_venue text DEFAULT NULL,
  p_scheduled_start timestamptz DEFAULT NULL,
  p_scheduled_end timestamptz DEFAULT NULL,
  p_expected_attendance integer DEFAULT NULL,
  p_organizer_id uuid DEFAULT NULL,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
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
  v_old jsonb;
  v_new jsonb;
  v_scope_changed boolean;
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

  v_scope_changed := p_scope_type IS NOT NULL AND p_scope_id IS NOT NULL
    AND (p_scope_type <> v_row.scope_type OR p_scope_id <> v_row.scope_id);

  IF v_scope_changed THEN
    IF NOT (politicore.is_admin()
            OR politicore.has_permission('create_activity', p_scope_type, p_scope_id)) THEN
      RAISE EXCEPTION 'not authorized to move an activity to the requested scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_old := jsonb_build_object(
    'title', v_row.title, 'description', v_row.description,
    'activity_type', v_row.activity_type, 'venue', v_row.venue,
    'scheduled_start', v_row.scheduled_start, 'scheduled_end', v_row.scheduled_end,
    'expected_attendance', v_row.expected_attendance,
    'organizer_id', v_row.organizer_id,
    'scope_type', v_row.scope_type, 'scope_id', v_row.scope_id);

  UPDATE politicore.campaign_activities SET
    title               = COALESCE(p_title, title),
    description         = COALESCE(p_description, description),
    activity_type       = COALESCE(p_activity_type, activity_type),
    venue               = COALESCE(p_venue, venue),
    scheduled_start     = COALESCE(p_scheduled_start, scheduled_start),
    scheduled_end       = COALESCE(p_scheduled_end, scheduled_end),
    expected_attendance = COALESCE(p_expected_attendance, expected_attendance),
    organizer_id        = COALESCE(p_organizer_id, organizer_id),
    scope_type          = COALESCE(p_scope_type, scope_type),
    scope_id            = COALESCE(p_scope_id, scope_id)
  WHERE id = v_row.id;

  v_new := jsonb_build_object(
    'title', COALESCE(p_title, v_row.title),
    'description', COALESCE(p_description, v_row.description),
    'activity_type', COALESCE(p_activity_type, v_row.activity_type),
    'venue', COALESCE(p_venue, v_row.venue),
    'scheduled_start', COALESCE(p_scheduled_start, v_row.scheduled_start),
    'scheduled_end', COALESCE(p_scheduled_end, v_row.scheduled_end),
    'expected_attendance', COALESCE(p_expected_attendance, v_row.expected_attendance),
    'organizer_id', COALESCE(p_organizer_id, v_row.organizer_id),
    'scope_type', COALESCE(p_scope_type, v_row.scope_type),
    'scope_id', COALESCE(p_scope_id, v_row.scope_id));

  PERFORM politicore.campaign_audit(v_tenant, v_uid, 'campaign.activity.update',
    'campaign_activity', v_row.id::text, v_old, v_new);
END;
$$;

GRANT EXECUTE ON FUNCTION politicore.update_campaign_activity(uuid, text, text,
  politicore.campaign_activity_type, text, timestamptz, timestamptz, integer,
  uuid, politicore.scope_type_enum, text)
  TO authenticated, service_role;
