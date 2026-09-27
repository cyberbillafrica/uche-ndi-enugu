-- =====================================================================
-- 0023: CAMPAIGN PUBLIC RPC WRAPPERS (Phase B hosted acceptance finding)
--
-- The ratified hosted data-API convention (0007/0015): PostgREST
-- executes only public.* RPCs, so every Campaign workflow function
-- gets a thin SECURITY INVOKER wrapper delegating to the politicore
-- SECURITY DEFINER original — which remains the sole authorization
-- boundary (module gate + tenant + permission + scope + audit).
-- Without these, /rest/v1/rpc/<fn> 404s for the application service
-- layer (campaignService.transitionActivity / setRsvp /
-- recordAttendance / updateActivity) exactly as the hosted smoke run
-- demonstrated.
-- No Election/Core object is touched.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.set_campaign_activity_status(
  p_activity uuid,
  p_status politicore.campaign_activity_status
) RETURNS void AS $$
  SELECT politicore.set_campaign_activity_status(p_activity, p_status);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.update_campaign_activity(
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
) RETURNS void AS $$
  SELECT politicore.update_campaign_activity(p_activity, p_title, p_description,
    p_activity_type, p_venue, p_scheduled_start, p_scheduled_end,
    p_expected_attendance, p_organizer_id, p_scope_type, p_scope_id);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.join_campaign_activity(
  p_activity uuid,
  p_rsvp politicore.campaign_rsvp
) RETURNS uuid AS $$
  SELECT politicore.join_campaign_activity(p_activity, p_rsvp);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.record_campaign_attendance(
  p_activity uuid,
  p_participant_user uuid,
  p_attendance politicore.campaign_attendance_state,
  p_check_in boolean DEFAULT false,
  p_check_out boolean DEFAULT false
) RETURNS void AS $$
  SELECT politicore.record_campaign_attendance(p_activity, p_participant_user,
    p_attendance, p_check_in, p_check_out);
$$ LANGUAGE sql;

GRANT EXECUTE ON FUNCTION public.set_campaign_activity_status(uuid, politicore.campaign_activity_status)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_campaign_activity(uuid, text, text,
  politicore.campaign_activity_type, text, timestamptz, timestamptz, integer,
  uuid, politicore.scope_type_enum, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_campaign_activity(uuid, politicore.campaign_rsvp)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_campaign_attendance(uuid, uuid,
  politicore.campaign_attendance_state, boolean, boolean)
  TO authenticated;
