-- POLITICORE — MIGRATION 0039: PUBLIC INTAKE SUBMIT RPC RESTATEMENT (PHASE 10).
--
-- Restates politicore.governance_submit_public_request with the final
-- Phase 10 body (duplicate-content collapse runs BEFORE the per-contact
-- cooldown; security rejections RETURN false so the rejection audit
-- commits). Body is identical to migration 0037 (single source of
-- truth); the function is DROPped and re-created because the return
-- type changed void -> boolean.

DROP FUNCTION IF EXISTS politicore.governance_submit_public_request(text,text,text,text,text,text,text,text,text,boolean);

CREATE OR REPLACE FUNCTION politicore.governance_submit_public_request(
  p_tenant_slug      text,
  p_contact_email    text,
  p_full_name        text DEFAULT NULL,
  p_category         text DEFAULT NULL,
  p_subject          text DEFAULT NULL,
  p_description      text DEFAULT NULL,
  p_ward_id          text DEFAULT NULL,
  p_lga_id           text DEFAULT NULL,
  p_polling_unit_id  text DEFAULT NULL,
  p_consent          boolean DEFAULT false
) RETURNS boolean AS $$
DECLARE
  v_tenant       politicore.tenants%ROWTYPE;
  v_email        text;
  v_name         text;
  v_subject      text;
  v_description  text;
  v_category     text;
  v_ch           text;
  v_sh           text;
  v_cat_id       uuid;
  v_pending      integer;
  v_pool         integer;
  v_existing     politicore.governance_intake_staging%ROWTYPE;
  v_token        text;
  v_resend       boolean;
BEGIN
  -- Consent is required (gate §D): no consent, no submission.
  -- (Validation and gate failures RAISE — they have nothing to persist.
  -- SECURITY rejections below return FALSE so the rejection audit commits:
  -- the audit stream IS the throttle ledger and RAISE would roll it back.)
  IF p_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'governance: consent is required to submit a public request';
  END IF;

  -- Tenant by public site slug — never a client-supplied tenant id (§21).
  SELECT * INTO v_tenant FROM politicore.tenants
   WHERE slug = lower(trim(COALESCE(p_tenant_slug, '')));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance: unknown public site';
  END IF;

  -- Module + public_intake gates (prompt §5/§16).
  IF NOT politicore.governance_public_intake_enabled(v_tenant.id) THEN
    RAISE EXCEPTION 'governance: public intake is not available';
  END IF;

  -- Bounded, normalized input (prompt §14).
  v_email       := lower(trim(COALESCE(p_contact_email, '')));
  v_name        := left(trim(COALESCE(p_full_name, '')), 120);
  v_subject     := trim(COALESCE(p_subject, ''));
  v_description := trim(COALESCE(p_description, ''));
  v_category    := trim(COALESCE(p_category, ''));

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'governance: submission rejected: a valid email address is required';
  END IF;
  IF char_length(v_name) = 0 THEN
    RAISE EXCEPTION 'governance: submission rejected: your name is required';
  END IF;
  IF char_length(v_category) = 0 OR char_length(v_category) > 120 THEN
    RAISE EXCEPTION 'governance: submission rejected: choose a request category';
  END IF;
  IF char_length(v_subject) < 5 OR char_length(v_subject) > 200 THEN
    RAISE EXCEPTION 'governance: submission rejected: subject must be 5-200 characters';
  END IF;
  IF char_length(v_description) < 20 OR char_length(v_description) > 10000 THEN
    RAISE EXCEPTION 'governance: submission rejected: description must be 20-10000 characters';
  END IF;

  -- Geography is optional per level; provided ids must exist in Core
  -- Geography (gate §D — no forced Ward/PU, no Governance geography).
  IF p_ward_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM politicore.wards w WHERE w.id = p_ward_id) THEN
    RAISE EXCEPTION 'governance: submission rejected: unknown ward';
  END IF;
  IF p_lga_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM politicore.lgas l WHERE l.id = p_lga_id) THEN
    RAISE EXCEPTION 'governance: submission rejected: unknown LGA';
  END IF;
  IF p_polling_unit_id IS NOT NULL AND NOT EXISTS
       (SELECT 1 FROM politicore.polling_units pu WHERE pu.id = p_polling_unit_id) THEN
    RAISE EXCEPTION 'governance: submission rejected: unknown polling unit';
  END IF;

  -- Category must exist and be ACTIVE for the tenant (prompt §7).
  SELECT c.id INTO v_cat_id
    FROM politicore.governance_request_categories c
   WHERE c.tenant_id = v_tenant.id
     AND lower(c.name) = lower(v_category)
     AND c.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance: submission rejected: category is not available';
  END IF;

  -- Contact + content digests (abuse-ledger keys; never returned).
  v_ch := encode(sha256(convert_to(v_email, 'UTF8')), 'hex');
  v_sh := encode(sha256(convert_to(lower(v_subject), 'UTF8')), 'hex');

  -- Housekeeping: drop long-expired staging rows so the pending pool
  -- bound stays meaningful.
  DELETE FROM politicore.governance_intake_staging
   WHERE token_expires_at < now() - interval '7 days';

  v_token := politicore.governance_random_hex(32);

  -- Duplicate-content collapse (gate §F): identical pending contact +
  -- subject REUSES the staging row with a freshly rotated token (the
  -- previous code is invalidated). A resend — never a new pending row.
  -- Runs BEFORE the throttle checks so a retry of the SAME filing is a
  -- resend, not a throttled rejection.
  SELECT * INTO v_existing
    FROM politicore.governance_intake_staging
   WHERE contact_hash = v_ch AND subject_hash = v_sh AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;
  -- Capture BEFORE the DML below (DML overwrites FOUND).
  v_resend := FOUND;
  IF NOT FOUND THEN
    -- Per-contact cooldown (gate §F): 1 NEW submission / contact / 10 min.
    IF EXISTS (
         SELECT 1 FROM politicore.system_audits
          WHERE action = 'governance_public_intake'
            AND new_value ->> 'ch' = v_ch
            AND occurred_at > now() - interval '10 minutes'
       ) THEN
      INSERT INTO politicore.system_audits
        (tenant_id, actor_id, actor_name, actor_email, action,
         affected_resource, new_value)
      VALUES (v_tenant.id, NULL, v_name, v_email,
              'governance_public_intake_rejected', 'governance_public_intake',
              jsonb_build_object('reason', 'cooldown', 'ch', v_ch));
      RETURN false;
    END IF;

    -- Per-contact pending cap (gate §F): ≤ 3 pending per contact.
    SELECT count(*) INTO v_pending
      FROM politicore.governance_intake_staging
     WHERE contact_hash = v_ch AND status = 'pending';
    IF v_pending >= 3 THEN
      INSERT INTO politicore.system_audits
        (tenant_id, actor_id, actor_name, actor_email, action,
         affected_resource, new_value)
      VALUES (v_tenant.id, NULL, v_name, v_email,
              'governance_public_intake_rejected', 'governance_public_intake',
              jsonb_build_object('reason', 'contact_pending_cap', 'ch', v_ch));
      RETURN false;
    END IF;

    -- Global pending-pool cap (gate §F): the unverified pool MUST be bounded.
    SELECT count(*) INTO v_pool FROM politicore.governance_intake_staging;
    IF v_pool >= 500 THEN
      INSERT INTO politicore.system_audits
        (tenant_id, actor_id, actor_name, actor_email, action,
         affected_resource, new_value)
      VALUES (v_tenant.id, NULL, v_name, v_email,
              'governance_public_intake_rejected', 'governance_public_intake',
              jsonb_build_object('reason', 'pool_cap', 'ch', v_ch));
      RETURN false;
    END IF;

    INSERT INTO politicore.governance_intake_staging
      (tenant_id, contact_hash, subject_hash, token_hash, token_expires_at,
       status, submission)
    VALUES (
      v_tenant.id, v_ch, v_sh,
      encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
      now() + interval '24 hours',
      'pending',
      jsonb_build_object(
        'full_name', v_name,
        'email', v_email,
        'category', v_category,
        'subject', v_subject,
        'description', v_description,
        'ward_id', COALESCE(p_ward_id, ''),
        'lga_id', COALESCE(p_lga_id, ''),
        'polling_unit_id', COALESCE(p_polling_unit_id, '')
      )
    );
  ELSE
    UPDATE politicore.governance_intake_staging
       SET token_hash       = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
           token_expires_at = now() + interval '24 hours',
           submission       = jsonb_build_object(
                                'full_name', v_name,
                                'email', v_email,
                                'category', v_category,
                                'subject', v_subject,
                                'description', v_description,
                                'ward_id', COALESCE(p_ward_id, ''),
                                'lga_id', COALESCE(p_lga_id, ''),
                                'polling_unit_id', COALESCE(p_polling_unit_id, '')
                              )
     WHERE id = v_existing.id;
  END IF;

  -- The ONLY delivery of the token: a Core-owned intent (the email seam).
  INSERT INTO politicore.core_delivery_intents
    (tenant_id, channel, to_address, subject, body)
  VALUES (v_tenant.id, 'email', v_email,
          'Verify your Governance request',
          'Your verification code (valid for 24 hours): ' || v_token
          || E'\n\nEnter this code to verify your email and file your request: '
          || v_subject);

  -- Throttle ledger (gate §F) — also the audit trail of the attempt.
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, new_value)
  VALUES (v_tenant.id, NULL, v_name, v_email,
          'governance_public_intake', 'governance_public_intake',
          jsonb_build_object('ch', v_ch, 'sh', v_sh,
                             'kind', CASE WHEN v_resend THEN 'resent' ELSE 'created' END));
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, public, extensions, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- VERIFICATION — single-use token → activation + tracking secret
-- ---------------------------------------------------------------------
-- Activates the staged submission: creates the external participant
-- (contact-only, deduped), the governance_requests row ('submitted', the
-- canonical Phase 7 queue), the public submitted event, and the tracking
-- credential. Returns the reference + the ONE-TIME tracking secret.
-- All failure modes produce the same generic message (no enumeration).
-- ─────────────────────────────────────────────────────────────────────────
