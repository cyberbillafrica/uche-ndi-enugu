-- POLITICORE — MIGRATION 0042: PUBLIC INTAKE TRACK RPC RESTATEMENT (PHASE 10).
--
-- Restates politicore.governance_track_public_request with the final
-- Phase 10 body (rejections return empty results; projection whitelist).
-- Body is identical to migration 0037; idempotent CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION politicore.governance_track_public_request(
  p_reference       text,
  p_tracking_secret text
) RETURNS TABLE (
  reference_code   text,
  status           politicore.governance_request_status,
  created_at       timestamptz,
  event_kind       politicore.governance_event_kind,
  event_created_at timestamptz
) AS $$
DECLARE
  v_ref         text;
  v_hash        text;
  v_rec         record;
  v_ok          boolean := false;
  v_request_id  uuid;
  v_fail        integer;
BEGIN
  v_ref  := upper(trim(COALESCE(p_reference, '')));
  v_hash := encode(sha256(convert_to(lower(trim(COALESCE(p_tracking_secret, ''))), 'UTF8')), 'hex');
  IF v_ref = '' OR trim(COALESCE(p_tracking_secret, '')) = '' THEN
    RAISE EXCEPTION 'governance: reference and tracking secret are required';
  END IF;

  -- A reference is unique per TENANT, so candidates may exist across
  -- tenants; only a constant-time hash match reveals one (and a match
  -- never discloses the tenant — the projection is reference-scoped).
  FOR v_rec IN
    SELECT r.id AS rid, c.tracking_secret_hash AS cred
      FROM politicore.governance_requests r
      JOIN politicore.governance_tracking_credentials c ON c.request_id = r.id
     WHERE r.reference_code = v_ref
  LOOP
    IF politicore.governance_constant_time_equal(v_hash, v_rec.cred) THEN
      v_ok := true;
      v_request_id := v_rec.rid;
      EXIT;
    END IF;
  END LOOP;

  IF NOT v_ok THEN
    -- SECURITY rejections RETURN (do not RAISE): the rejection audit must
    -- COMMIT — the audit stream is both the evidence trail and the
    -- throttle ledger (an RAISE would roll the INSERT back). Unknown
    -- reference and wrong secret are indistinguishable: same audit shape,
    -- same empty result; the application maps emptiness to the typed
    -- "invalid" error, never to an existence oracle.
    SELECT count(*) INTO v_fail
      FROM politicore.system_audits
     WHERE action = 'governance_tracking_rejected'
       AND new_value ->> 'ref' = v_ref
       AND occurred_at > now() - interval '15 minutes';
    INSERT INTO politicore.system_audits
      (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
    VALUES (NULL, NULL,
            'governance_tracking_rejected', 'governance_tracking', v_ref,
            jsonb_build_object('ref', v_ref,
                               'reason', 'reference_or_secret_mismatch',
                               'window_attempts', v_fail + 1));
    IF v_fail >= 15 THEN
      RETURN; -- throttled: empty result (rate-limited, audited)
    END IF;
    RETURN; -- rejected: empty result (no existence oracle)
  END IF;

  RETURN QUERY
  SELECT r.reference_code, r.status, r.created_at,
         e.kind, e.created_at
    FROM politicore.governance_requests r
    LEFT JOIN politicore.governance_request_events e
           ON e.request_id = r.id AND e.is_public
           AND e.kind IN ('submitted','acknowledged','assigned',
                          'status_changed','resolved','closed')
   WHERE r.id = v_request_id
   ORDER BY e.created_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, public, extensions, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- THIN PUBLIC WRAPPERS (0007/0034 convention — SECURITY INVOKER one-liners;
-- anon executability arrives via 0007's blanket public-schema grant)
-- ─────────────────────────────────────────────────────────────────────────
