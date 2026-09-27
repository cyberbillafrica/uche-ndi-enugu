-- POLITICORE — MIGRATION 0040: PUBLIC INTAKE VERIFY RPC RESTATEMENT (PHASE 10).
--
-- Restates politicore.governance_verify_public_request with the final
-- Phase 10 body (RETURNS TABLE rows emitted via RETURN QUERY — a bare
-- RETURN in a SETOF function returns zero rows). Body is identical to
-- migration 0037 (single source of truth); idempotent CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION politicore.governance_verify_public_request(
  p_token        text,
  p_tenant_slug  text DEFAULT NULL
) RETURNS TABLE (reference_code text, tracking_secret text) AS $$
DECLARE
  v_row        politicore.governance_intake_staging%ROWTYPE;
  v_tenant_id  uuid;
  v_hash       text;
  v_email      text;
  v_name       text;
  v_subject    text;
  v_desc       text;
  v_category   text;
  v_ward       text;
  v_lga        text;
  v_pu         text;
  v_cat_id     uuid;
  v_participant uuid;
  v_request    uuid;
  v_ref        text;
  v_secret     text;
BEGIN
  v_hash := encode(sha256(convert_to(trim(COALESCE(p_token, '')), 'UTF8')), 'hex');
  IF trim(COALESCE(p_token, '')) = '' THEN
    RAISE EXCEPTION 'governance: verification code is invalid or has expired';
  END IF;

  SELECT * INTO v_row FROM politicore.governance_intake_staging
   WHERE token_hash = v_hash AND status = 'pending'
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND OR v_row.token_expires_at < now() THEN
    INSERT INTO politicore.system_audits
      (actor_id, action, affected_resource, new_value)
    VALUES (NULL, 'governance_public_intake_verify_rejected',
            'governance_public_intake',
            jsonb_build_object('reason', CASE
              WHEN FOUND THEN 'expired_token' ELSE 'invalid_token' END));
    RAISE EXCEPTION 'governance: verification code is invalid or has expired';
  END IF;
  v_tenant_id := v_row.tenant_id;

  -- Tenant binding: an optional site slug must match the staging row's
  -- own tenant (server-resolved; guards cross-site replay of a token).
  IF p_tenant_slug IS NOT NULL AND lower(trim(p_tenant_slug)) <> (
       SELECT t.slug FROM politicore.tenants t WHERE t.id = v_tenant_id) THEN
    INSERT INTO politicore.system_audits
      (tenant_id, actor_id, action, affected_resource, new_value)
    VALUES (v_tenant_id, NULL, 'governance_public_intake_verify_rejected',
            'governance_public_intake',
            jsonb_build_object('reason', 'tenant_mismatch'));
    RAISE EXCEPTION 'governance: verification code is invalid or has expired';
  END IF;

  -- Gates re-checked at activation (module/toggle may have flipped).
  IF NOT politicore.governance_public_intake_enabled(v_tenant_id) THEN
    RAISE EXCEPTION 'governance: public intake is not available';
  END IF;

  -- Extract the staged payload.
  v_email    := lower(trim(v_row.submission ->> 'email'));
  v_name     := left(trim(COALESCE(v_row.submission ->> 'full_name', '')), 120);
  v_subject  := trim(COALESCE(v_row.submission ->> 'subject', ''));
  v_desc     := trim(COALESCE(v_row.submission ->> 'description', ''));
  v_category := trim(COALESCE(v_row.submission ->> 'category', ''));
  v_ward     := NULLIF(trim(v_row.submission ->> 'ward_id'), '');
  v_lga      := NULLIF(trim(v_row.submission ->> 'lga_id'), '');
  v_pu       := NULLIF(trim(v_row.submission ->> 'polling_unit_id'), '');

  -- The category must STILL be active at activation time (prompt §7).
  SELECT c.id INTO v_cat_id
    FROM politicore.governance_request_categories c
   WHERE c.tenant_id = v_tenant_id
     AND lower(c.name) = lower(v_category)
     AND c.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance: request category is no longer available — please submit again';
  END IF;

  -- External participant: contact-only (profile_id NULL), per-tenant
  -- case-insensitive dedup (gate §A; Phase 6 partial unique index).
  SELECT p.id INTO v_participant
    FROM politicore.governance_participants p
   WHERE p.tenant_id = v_tenant_id
     AND p.profile_id IS NULL
     AND lower(p.email) = v_email
   LIMIT 1;
  IF FOUND THEN
    UPDATE politicore.governance_participants
       SET full_name = COALESCE(NULLIF(v_name, ''), full_name),
           updated_at = now()
     WHERE id = v_participant;
  ELSE
    BEGIN
      INSERT INTO politicore.governance_participants
        (tenant_id, profile_id, full_name, email, display_label)
      VALUES (v_tenant_id, NULL, v_name, v_email, 'Citizen')
      RETURNING id INTO v_participant;
    EXCEPTION WHEN unique_violation THEN
      SELECT p.id INTO v_participant
        FROM politicore.governance_participants p
       WHERE p.tenant_id = v_tenant_id
         AND p.profile_id IS NULL
         AND lower(p.email) = v_email
       LIMIT 1;
      IF NOT FOUND THEN RAISE; END IF;
    END;
  END IF;

  -- The request enters the CANONICAL Phase 7 lifecycle at 'submitted'
  -- (same model as authenticated members — no second workflow, §18).
  -- The reference is computed before the insert (an unqualified
  -- `RETURNING reference_code` would collide with the OUT parameter).
  v_request := gen_random_uuid();
  v_ref     := politicore.governance_reference(now(), v_request);
  INSERT INTO politicore.governance_requests
    (id, tenant_id, participant_id, category_id, title, details, status,
     ward_id, lga_id, polling_unit_id, reference_code)
  VALUES (
    v_request, v_tenant_id, v_participant, v_cat_id, v_subject, v_desc,
    'submitted', v_ward, v_lga, v_pu, v_ref
  );

  -- Submitted event, PUBLIC so the tracking projection can show it
  -- (visibility is insert-time immutable — set here, never client-set).
  INSERT INTO politicore.governance_request_events
    (tenant_id, request_id, kind, actor_participant_id, body, is_public)
  VALUES (v_tenant_id, v_request, 'submitted', v_participant, v_desc, true);

  -- Tracking secret: 256-bit CSPRNG, hash-only storage (gate §C).
  v_secret := politicore.governance_random_hex(32);
  INSERT INTO politicore.governance_tracking_credentials
    (request_id, tenant_id, tracking_secret_hash)
  VALUES (v_request, v_tenant_id,
          encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'));

  -- Consume the staging row (single-use token).
  UPDATE politicore.governance_intake_staging
     SET status = 'consumed'
   WHERE id = v_row.id;

  -- Confirmation email: reference (identifier) + secret (credential) —
  -- the second and last plaintext exposure of the secret.
  INSERT INTO politicore.core_delivery_intents
    (tenant_id, channel, to_address, subject, body)
  VALUES (v_tenant_id, 'email', v_email,
          'Your Governance request ' || v_ref,
          'Your request has been filed. Reference: ' || v_ref
          || E'\nTracking secret (keep this — shown only once): ' || v_secret
          || E'\n\nTrack your request any time with the reference and this secret.');

  -- Audit: external attribution (actor_id NULL + name/email, gate §K).
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, new_value)
  VALUES (v_tenant_id, NULL, v_name, v_email,
          'governance_public_request_activated', 'governance_requests',
          v_request::text, jsonb_build_object('reference_code', v_ref));

  -- RETURNS TABLE is a SETOF function: rows are emitted by RETURN QUERY
  -- (a bare RETURN would return ZERO rows).
  RETURN QUERY SELECT v_ref, v_secret;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, public, extensions, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- TRACKING LOOKUP — reference (identifier) + secret (credential)
-- ---------------------------------------------------------------------
-- Narrow SECURITY DEFINER projection (gate §C/§E): reference, status,
-- timestamps, and PUBLIC lifecycle events only. Never response bodies,
-- assignments, staff identity, contact data, or internal events.
-- Wrong secret and unknown reference are indistinguishable; failures are
-- throttled per reference and audited (prompt §14).
-- ─────────────────────────────────────────────────────────────────────────
