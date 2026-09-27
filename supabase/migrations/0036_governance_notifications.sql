-- POLITICORE — MIGRATION 0036: GOVERNANCE → CORE NOTIFICATIONS INTEGRATION (PHASE 8).
--
-- Wires the Governance workflow transitions into the EXISTING Core
-- Notifications module (politicore.notifications, 0001/0002) using the
-- established Campaign precedent (0021 campaign_notify): a best-effort
-- SECURITY DEFINER notify helper invoked INSIDE the authority RPCs, so
-- the notification is part of the same authoritative transaction as the
-- workflow mutation (§6/§7) and inherits its authorization (§11).
--
-- NO new notification table, queue, service or delivery mechanism (§2):
--   * recipient  = governance_participants.profile_id (1:1 → profiles;
--                  anonymous participants have no identity → skipped)
--   * type       = 'system' (platform-operational Core enum value; no
--                  Governance value is added to the CHECK constraint)
--   * routing    = link_url (/portal/governance/requests/[id] for
--                  participants, /portal/governance/cases/[id] for staff)
--   * payload    = title/message carry the reference code (§8 metadata
--                  mapping — the schema has no generic metadata column and
--                  §8 forbids adding one)
--
-- IDEMPOTENCY (§12): acknowledge/update_status early-return when the
-- operation would not change state (silent retry → no event, no
-- notification); assignee notification fires only for a NEW
-- (request, assignee) pair. Previously a same-status retry inserted a
-- duplicate event; no legitimate path is removed (the ladder guard
-- already rejected every other non-submitted acknowledge).
--
-- NOTIFIED (§4/§5/§16 — exactly five transitions, no noise):
--   acknowledged            → participant
--   assigned                → participant + newly-assigned staff member
--   awaiting_information    → participant
--   resolved                → participant
--   closed                  → participant
-- Not notified: responses (internal or public), feedback, category or
-- administrative changes, event-stream entries (§16).
--
-- DOES NOT: alter the status ladder, event visibility, RLS, permission
-- model, participant model, or any other module's objects.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Best-effort notify helpers (campaign_notify 0021 precedent: NEVER fail
-- the business action; SECURITY DEFINER + pinned search_path).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.governance_notify(
  p_tenant uuid,
  p_user uuid,
  p_title text,
  p_message text,
  p_link text,
  p_actor uuid
) RETURNS void AS $$
BEGIN
  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  VALUES (p_tenant, p_user, 'system', p_title, p_message, p_link, p_actor);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Participant notification: resolves the request's linked participant
-- profile server-side (§10 — never client-supplied); anonymous
-- participants are skipped (no identity to address).
CREATE OR REPLACE FUNCTION politicore.governance_notify_participant(
  p_request uuid,
  p_title text,
  p_message text,
  p_link text,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_user uuid;
BEGIN
  SELECT r.tenant_id, gp.profile_id
    INTO v_tenant, v_user
    FROM politicore.governance_requests r
    JOIN politicore.governance_participants gp ON gp.id = r.participant_id
   WHERE r.id = p_request;
  IF v_user IS NULL THEN
    RETURN; -- anonymous participant: no portal identity to notify
  END IF;
  PERFORM politicore.governance_notify(v_tenant, v_user, p_title, p_message, p_link, p_actor);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance participant notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- acknowledge_governance_request — body of 0034 verbatim + idempotent
-- retry guard + participant notification.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.acknowledge_governance_request(
  p_request_id uuid,
  p_note text DEFAULT ''
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_status politicore.governance_request_status;
  v_ref text;
BEGIN
  SELECT tenant_id, status, reference_code INTO v_tenant, v_status, v_ref
    FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('manage_cases')) THEN
    RAISE EXCEPTION 'governance: manage_cases required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  -- Idempotent retry (§12): a request that is no longer 'submitted' gains
  -- nothing from acknowledgement — no event, no notification. (Every other
  -- non-submitted state was already rejected by the status-ladder guard.)
  IF v_status <> 'submitted' THEN
    RETURN p_request_id;
  END IF;

  UPDATE politicore.governance_requests SET status = 'acknowledged' WHERE id = p_request_id;
  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_profile_id, body, is_public)
  VALUES (v_tenant, p_request_id, 'acknowledged', auth.uid(), p_note, true);

  PERFORM politicore.governance_notify_participant(
    p_request_id,
    'Request acknowledged',
    format('Your request %s has been acknowledged.', v_ref),
    '/portal/governance/requests/' || p_request_id::text,
    auth.uid());
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- assign_governance_request — body of 0034 verbatim + participant and
-- assignee notifications (assignee only for a NEW (request, assignee)
-- pair — reassignment notifies the new assignee, retry does not).
-- ---------------------------------------------------------------------
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
  v_ref text;
  v_pair_exists boolean;
BEGIN
  SELECT tenant_id, reference_code INTO v_tenant, v_ref
    FROM politicore.governance_requests WHERE id = p_request_id;
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

  -- Duplicate protection (§12): the 0034 UNIQUE (request_id, assigned_to)
  -- constraint already forbids assigning the same person twice; surface it
  -- as a domain error BEFORE the insert so a retry is a controlled failure
  -- (no partial state, no duplicate notifications). Every successful
  -- assignment is therefore a NEW pair → both parties are notified.
  SELECT EXISTS (
    SELECT 1 FROM politicore.governance_assignments
     WHERE request_id = p_request_id AND assigned_to = p_assignee_profile_id
  ) INTO v_pair_exists;
  IF v_pair_exists THEN
    RAISE EXCEPTION 'governance: assignee already assigned to this request';
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

  PERFORM politicore.governance_notify_participant(
    p_request_id,
    'Request assigned',
    format('Your request %s has been assigned for handling.', v_ref),
    '/portal/governance/requests/' || p_request_id::text,
    auth.uid());

  PERFORM politicore.governance_notify(
    v_tenant, p_assignee_profile_id,
    'Governance case assigned to you',
    format('Case %s has been assigned to you.', v_ref),
    '/portal/governance/cases/' || p_request_id::text,
    auth.uid());
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- update_governance_request_status — body of 0034 verbatim + unchanged-
-- state early return + participant notifications on exactly the three
-- participant-relevant transitions (awaiting_information, resolved,
-- closed). in_progress/rejected are operational states with no
-- participant value (§16 — no notification noise).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.update_governance_request_status(
  p_request_id uuid,
  p_status politicore.governance_request_status,
  p_note text DEFAULT '',
  p_is_public boolean DEFAULT false
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_kind politicore.governance_event_kind;
  v_ref text;
  v_prev politicore.governance_request_status;
BEGIN
  SELECT tenant_id, reference_code, status INTO v_tenant, v_ref, v_prev
    FROM politicore.governance_requests WHERE id = p_request_id;
  IF v_tenant IS NULL OR v_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: request not found';
  END IF;
  IF NOT (politicore.is_tenant_admin() OR politicore.has_permission('manage_cases')) THEN
    RAISE EXCEPTION 'governance: manage_cases required';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  -- Idempotent retry (§12): a same-status update changes no state →
  -- no event, no notification.
  IF v_prev = p_status THEN
    RETURN p_request_id;
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

  IF p_status = 'awaiting_information' THEN
    PERFORM politicore.governance_notify_participant(
      p_request_id,
      'Information requested',
      format('Additional information is required for request %s.', v_ref),
      '/portal/governance/requests/' || p_request_id::text,
      auth.uid());
  ELSIF p_status = 'resolved' THEN
    PERFORM politicore.governance_notify_participant(
      p_request_id,
      'Request resolved',
      format('Your request %s has been resolved.', v_ref),
      '/portal/governance/requests/' || p_request_id::text,
      auth.uid());
  ELSIF p_status = 'closed' THEN
    PERFORM politicore.governance_notify_participant(
      p_request_id,
      'Request closed',
      format('Your request %s has been closed.', v_ref),
      '/portal/governance/requests/' || p_request_id::text,
      auth.uid());
  END IF;
  RETURN p_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;
