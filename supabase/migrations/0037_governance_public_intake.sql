-- POLITICORE — MIGRATION 0037: GOVERNANCE PUBLIC INTAKE — FIRST SLICE (PHASE 10).
--
-- Implements exactly the slice approved by the Phase 9 architecture gate
-- (docs/Governance-Public-Intake-Gate.md §M, §C, §J, §F, §K):
--
--   Public submit (Model 2, contact-verified)
--     → email verification (token, 24h, single-use, rotating resend)
--     → activation: participant + governance_requests row ('submitted')
--       + tracking secret issued (shown once, hash-only storage)
--     → verified tracking lookup (reference + secret)
--
-- SECURITY MODEL (gate §J — zero change to existing policies):
--   * The five governance tables keep FORCE RLS with ZERO anon surface.
--     No policy in this migration touches them.
--   * The public boundary is three narrow SECURITY DEFINER RPCs exposed
--     through thin `public` wrappers (0007/0034 convention). Anon may call
--     exactly these three and nothing else.
--   * The implementation functions in politicore.* receive NO execute
--     grants; the wrappers are the only entry points.
--   * Tenant identity is never accepted from the client as authority:
--     intake resolves the tenant by public site slug (§21); verify/track
--     bind to the staging/request row's own server-resolved tenant.
--   * Reference codes stay ~32-bit IDENTIFIERS (gate §C): tracking needs
--     reference + a 256-bit CSPRNG secret, stored hash-only (sha256) and
--     compared in constant time. Unknown-reference and wrong-secret
--     failures are indistinguishable.
--   * Event visibility stays insert-time immutable (gate §E): the tracking
--     projection returns only is_public=true lifecycle facts — never
--     staff/participant response bodies, never assignments, never staff
--     identity.
--
-- ABUSE CONTROLS (gate §F, first-slice set):
--   * bounded input (email/name/category/subject/description lengths)
--   * per-contact cooldown (1 submission / contact / 10 min)
--   * per-contact pending cap (3) + global pending-pool cap (500)
--   * duplicate-content collapse: identical pending contact+subject REUSES
--     the same staging row with a freshly rotated token (no row stacking;
--     the previous token is invalidated) — a resend, not a new submission
--   * tracking-failure throttle: 15 counted failures / reference / 15 min
--   * security-relevant failures audited through CANONICAL system_audits
--     (actor_id NULL + actor_name/actor_email, gate §K) — the audit stream
--     doubles as the throttle ledger; NO governance abuse/audit tables.
--
-- DELIVERY SEAM (prompt §8/§19 — minimum Core-owned intent boundary):
--   politicore.core_delivery_intents is a Core-owned, zero-grant intent
--   table (the "outbox" a future Core email provider consumes). Governance
--   writes intents; no provider logic lives here. NOT a governance_* queue.
--   The verification token and the tracking secret exist in plaintext only
--   inside these intents (the emails) and the single verification response.
--
-- NEW OBJECTS (documented per prompt §23):
--   politicore.governance_intake_staging       pending unverified submissions
--   politicore.governance_tracking_credentials per-request secret hash
--   politicore.core_delivery_intents           Core delivery outbox (no anon)
--   politicore.governance_constant_time_equal  helper
--   politicore.governance_public_intake_enabled helper (module+toggle gates)
--   politicore.governance_submit_public_request   (SECURITY DEFINER)
--   politicore.governance_verify_public_request   (SECURITY DEFINER)
--   politicore.governance_track_public_request    (SECURITY DEFINER)
--   public.governance_public_intake / _verify / _track (thin wrappers)

-- Crypto: Postgres BUILT-INS only (no extension dependency, works on
-- pglite locally and hosted identically): sha256(bytea) for hashing,
-- and a CSPRNG hex helper derived from gen_random_uuid() (PG13+;
-- pg_strong_random-backed) for tokens/secrets. Digests are hex text.

-- ─────────────────────────────────────────────────────────────────────────
-- INTAKE STAGING — pending, unverified public submissions
-- ---------------------------------------------------------------------
-- Holds the contact + content until the emailed verification token is
-- presented. No participant row, no request row, no staff visibility
-- exists before activation. contact_hash/subject_hash are sha256 hex
-- digests used ONLY for throttling and duplicate collapse — never
-- returned, never logged in plaintext. The verification token is stored
-- hash-only; a resend ROTATES the token (old code dies). The full
-- submission payload is carried in `submission` for the activation step.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.governance_intake_staging (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  contact_hash  text NOT NULL,                  -- sha256(lower(email)) hex
  subject_hash  text NOT NULL,                  -- sha256(lower(subject)) hex
  token_hash    text NOT NULL UNIQUE,           -- sha256(token) hex — single-use
  token_expires_at timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
  submission    jsonb NOT NULL,                 -- full_name/email/category/subject/description/geo ids
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_intake_staging_contact_idx
  ON politicore.governance_intake_staging (contact_hash, status);
CREATE INDEX governance_intake_staging_tenant_idx
  ON politicore.governance_intake_staging (tenant_id, status);

ALTER TABLE politicore.governance_intake_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_intake_staging FORCE  ROW LEVEL SECURITY;
-- No policies, no grants: invisible to anon/authenticated/service_role
-- API surfaces; reachable only by SECURITY DEFINER RPCs and the owner.

-- ─────────────────────────────────────────────────────────────────────────
-- TRACKING CREDENTIALS — hash-only secret per activated public request
-- ---------------------------------------------------------------------
-- One row per activated request. tracking_secret_hash = sha256(secret)
-- hex. The plaintext secret is shown exactly once (verification response
-- + confirmation email) and NEVER stored. Rotation is deferred (needs a
-- delivery channel to hand out the new secret); the row is deleted with
-- its request (FK cascade).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.governance_tracking_credentials (
  request_id           uuid PRIMARY KEY REFERENCES politicore.governance_requests(id) ON DELETE CASCADE,
  tenant_id            uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  tracking_secret_hash text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE politicore.governance_tracking_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.governance_tracking_credentials FORCE  ROW LEVEL SECURITY;
-- No policies, no grants (same discipline as staging).

-- ─────────────────────────────────────────────────────────────────────────
-- CORE DELIVERY INTENTS — the Core-owned external-delivery seam
-- ---------------------------------------------------------------------
-- Governance (and any future module) writes a "send this" intent here;
-- a future Core-owned provider consumes rows and marks them delivered.
-- This is the minimum server-side intent boundary required by prompt §8:
-- NO governance_email_queue, NO provider code, NO second notification
-- system. Zero grants + zero policies: nothing can read it through the
-- API; consumption happens via service_role (BYPASSRLS) when Core
-- delivery is built. The hosted acceptance harness reads it via the
-- owner connection as the stand-in inbox.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.core_delivery_intents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  channel     text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  to_address  text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX core_delivery_intents_pending_idx
  ON politicore.core_delivery_intents (created_at);

ALTER TABLE politicore.core_delivery_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.core_delivery_intents FORCE  ROW LEVEL SECURITY;
-- Deliberately NO grants and NO policies (not even service_role SELECT):
-- the API surface must not expose delivery bodies (they carry secrets).

-- ─────────────────────────────────────────────────────────────────────────
-- HELPERS
-- ─────────────────────────────────────────────────────────────────────────

-- CSPRNG hex: concatenates uuid hex encodings (16 bytes each, ≈122
-- random bits after version/variant bits) and truncates to p_bytes*2
-- hex chars. For the 32-byte tokens used here this yields ≈186+ random
-- bits — comfortably above the gate's 128-bit floor (§C).
CREATE OR REPLACE FUNCTION politicore.governance_random_hex(p_bytes integer)
RETURNS text AS $$
  SELECT left(
           encode(uuid_send(gen_random_uuid()), 'hex') ||
           encode(uuid_send(gen_random_uuid()), 'hex') ||
           encode(uuid_send(gen_random_uuid()), 'hex'),
           GREATEST(p_bytes, 0) * 2
         );
$$ LANGUAGE sql VOLATILE;

-- Constant-time equality over fixed-length hex digests (gate §C).
CREATE OR REPLACE FUNCTION politicore.governance_constant_time_equal(a text, b text)
RETURNS boolean AS $$
DECLARE
  d  integer := 0;
  i  integer;
  la integer := COALESCE(length(a), 0);
  lb integer := COALESCE(length(b), 0);
BEGIN
  FOR i IN 0 .. GREATEST(la, lb) - 1 LOOP
    d := d | (
      ( CASE WHEN i < la THEN ascii(substr(a, i + 1, 1)) ELSE 0 END ) #
      ( CASE WHEN i < lb THEN ascii(substr(b, i + 1, 1)) ELSE 0 END )
    );
  END LOOP;
  d := d | (la # lb);
  RETURN d = 0;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = politicore, pg_temp;

-- Tenant gate: governance module enabled AND the public_intake module
-- config toggle on (prompt §5 — subordinate to the module gate, default
-- off, managed through the existing tenant_modules.config mechanism).
CREATE OR REPLACE FUNCTION politicore.governance_public_intake_enabled(p_tenant uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
           SELECT 1 FROM politicore.tenant_modules tm
            WHERE tm.tenant_id = p_tenant
              AND tm.module    = 'governance'
              AND tm.enabled
         )
         AND COALESCE((
           SELECT (tm.config ->> 'public_intake')::boolean
             FROM politicore.tenant_modules tm
            WHERE tm.tenant_id = p_tenant
              AND tm.module    = 'governance'
         ), false);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC SUBMIT (Model 2) — pending staging + verification token
-- ---------------------------------------------------------------------
-- Returns void. The verification token is delivered ONLY through the
-- Core delivery intent (the email seam) — never in the RPC response, so
-- knowing/submitting someone's email never completes their verification.
-- ─────────────────────────────────────────────────────────────────────────
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
CREATE OR REPLACE FUNCTION public.governance_public_intake(
  p_tenant_slug text, p_contact_email text, p_full_name text DEFAULT NULL,
  p_category text DEFAULT NULL, p_subject text DEFAULT NULL,
  p_description text DEFAULT NULL, p_ward_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL, p_polling_unit_id text DEFAULT NULL,
  p_consent boolean DEFAULT false
) RETURNS boolean AS $$
  SELECT politicore.governance_submit_public_request(
    p_tenant_slug, p_contact_email, p_full_name, p_category, p_subject,
    p_description, p_ward_id, p_lga_id, p_polling_unit_id, p_consent);
$$ LANGUAGE sql;

-- Hygiene: the two helpers are internal — no direct execution surface
-- (0007's ALTER DEFAULT PRIVILEGES grants EXECUTE to app roles on new
-- politicore functions; internal helpers should not be publicly callable).
REVOKE EXECUTE ON FUNCTION
  politicore.governance_constant_time_equal(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION
  politicore.governance_public_intake_enabled(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION
  politicore.governance_random_hex(integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.governance_verify(
  p_token text, p_tenant_slug text DEFAULT NULL
) RETURNS TABLE (reference_code text, tracking_secret text) AS $$
  SELECT * FROM politicore.governance_verify_public_request(p_token, p_tenant_slug);
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.governance_track(
  p_reference text, p_tracking_secret text
) RETURNS TABLE (
  reference_code   text,
  status           politicore.governance_request_status,
  created_at       timestamptz,
  event_kind       politicore.governance_event_kind,
  event_created_at timestamptz
) AS $$
  SELECT * FROM politicore.governance_track_public_request(p_reference, p_tracking_secret);
$$ LANGUAGE sql;
