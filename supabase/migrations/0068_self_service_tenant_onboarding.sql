-- ============================================================================
-- POLITICORE — PHASE 30 — SELF-SERVICE TENANT ONBOARDING (SaaS PHASE C)
-- ============================================================================
--
-- The first complete self-service SaaS onboarding journey:
--
--   Visitor → choose plan (public catalog) → create account (native
--   Supabase Auth) → ONE server-side provisioning transaction → enter
--   tenant application → manage subscription.
--
-- Architecture (ratified for this phase):
--   * Signup creates a BARE auth identity (no `tenant_slug` metadata —
--     0007 note 3 anticipated exactly this identity class: "an
--     unprivileged auth user"). The provisioning RPC below then creates
--     tenant + configuration + OWNER + subscription atomically, so the
--     chicken-and-egg problem (the 0007 signup trigger needs the tenant
--     to exist before the user row) never arises and an interrupted
--     journey leaves at most a bare identity — never a half-provisioned
--     tenant.
--   * Provisioning is ONE SECURITY DEFINER RPC = ONE atomic transaction.
--     Any failure rolls the whole journey back (failure-safe per §5).
--   * The subscription is created by the EXISTING Phase 29 authority
--     (`politicore.create_subscription`) — after the owner profile is
--     written, its own owner guard passes with the CALLER's real JWT
--     identity. No parallel subscription writer, no duplicated
--     trial/invoice/entitlement logic, no browser-supplied plan version.
--   * Duplicate prevention is DB-authoritative, never timing: the caller
--     may hold NO profile (one profile per identity — also blocks
--     members/admins of existing tenants from self-elevating), the slug
--     is UNIQUE (0001 constraint + explicit pre-check), and the tenant
--     has at most one live subscription (0066 partial unique index).
--   * Roles, modules, permissions and the plan/billing substrate are
--     UNTOUCHED. The owner is the EXISTING tenant_super_admin; the
--     modules are the EXISTING four; the entitlement substrate is the
--     EXISTING platform_settings.service_entitlements map.
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. SLUG RULES — normalization, reserved names, public availability.
--    The DATABASE is authoritative (§6): these helpers are the single
--    source the availability check and the provisioning RPC both use;
--    any client-side mirror is UX only.
-- ═══════════════════════════════════════════════════════════════════════

-- Reserved/system slugs: platform routes, auth surfaces, the flagship
-- tenant slug and common infrastructure names. Self-service tenants can
-- never take these (platform provisioning is not restricted by this
-- list — it predates it).
CREATE OR REPLACE FUNCTION politicore.reserved_tenant_slugs()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_temp
AS $$
  SELECT ARRAY[
    'admin','administrator','api','app','assets','auth','billing','biography',
    'callback','campaign','cdn','contact','control-center','create','dashboard',
    'demo','docs','documentation','election','events','ftp','gallery','governance',
    'help','ifeanyi-2027','login','logout','mail','manifesto','new','news','null',
    'oauth','onboarding','payment','payments','platform','politicore','portal',
    'pricing','private','profile','public','register','request','root','settings',
    'signup','social','staging','static','support','system','tenant','tenants',
    'test','undefined','volunteer','volunteers','webhook','webhooks','www'
  ]::text[];
$$;

-- Normalize a client-supplied slug: lowercase, trim, collapse every
-- non-alphanumeric run into a single hyphen, trim hyphens. The RESULT is
-- validated against the 0001 shape/length contract only. Raises (never
-- silently rewrites) on unusable values.
CREATE OR REPLACE FUNCTION politicore.canonical_tenant_slug(p_slug text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
  v text;
BEGIN
  IF p_slug IS NULL THEN
    RAISE EXCEPTION 'tenant slug is required';
  END IF;
  v := btrim(lower(p_slug));
  v := regexp_replace(v, '[^a-z0-9]+', '-', 'g');
  v := btrim(v, '-');
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'tenant slug could not be normalized from the supplied value';
  END IF;
  IF v !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'invalid tenant slug: %', v;
  END IF;
  IF length(v) < 2 OR length(v) > 63 THEN
    RAISE EXCEPTION 'tenant slug must be between 2 and 63 characters';
  END IF;
  RETURN v;
END;
$$;

-- Full normalization for PROVISIONING: canonical form + the reserved
-- list. The availability check deliberately uses only the canonical form
-- so a reserved slug reports the precise `reserved` reason.
CREATE OR REPLACE FUNCTION politicore.normalize_tenant_slug(p_slug text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
  v text;
BEGIN
  v := politicore.canonical_tenant_slug(p_slug);
  IF v = ANY (politicore.reserved_tenant_slugs()) THEN
    RAISE EXCEPTION 'tenant slug % is reserved', v;
  END IF;
  RETURN v;
END;
$$;

-- Server-side availability check (§6: never client-authoritative).
-- SECURITY DEFINER so it can see all tenants without exposing any tenant
-- row; returns ONLY the verdict. Callable by anon (the pricing/signup UX).
CREATE OR REPLACE FUNCTION politicore.tenant_slug_available(p_slug text)
RETURNS TABLE (slug text, available boolean, reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    v := politicore.canonical_tenant_slug(p_slug);
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT btrim(lower(COALESCE(p_slug, ''))), false,
                 'invalid: ' || SQLERRM::text;
    RETURN;
  END;

  IF v = ANY (politicore.reserved_tenant_slugs()) THEN
    RETURN QUERY SELECT v, false, 'reserved'::text;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.slug = v) THEN
    RETURN QUERY SELECT v, false, 'taken'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT v, true, 'available'::text;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE PROVISIONING TRANSACTION (§5). One SECURITY DEFINER RPC = one
--    atomic server-side operation creating, IN ORDER, with the caller's
--    REAL JWT identity preserved throughout (auth.uid() never changes):
--
--      1. authenticated caller with NO existing profile (new owner only)
--      2. tenant (normalized, unique, unreserved slug)
--      3. tenant_modules defaults — all four materialized, enabled
--         exactly as the SERVER-RESOLVED plan version includes them
--         (initial configuration; enablement follows the subscription,
--         never a client flag)
--      4. default tenant + public site configuration (0007 convention)
--      5. owner profile (tenant_super_admin — the EXISTING role)
--      6. subscription/trial through the EXISTING Phase 29 authority
--         (create_subscription resolves plan version, price, trial,
--         items, audit and notification itself)
--      7. entitlement state — written by create_subscription's own sync
--         into the EXISTING service_entitlements map
--      8. onboarding audit + (non-trial) welcome notification
--
--    Failure at ANY step rolls back the WHOLE journey — a partially
--    provisioned tenant that looks active without its subscription can
--    never exist. Retries are rejected by DB constraints, not timing.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.complete_tenant_onboarding(
  p_tenant_slug      text,
  p_tenant_name      text,
  p_owner_name       text,
  p_plan_code        text,
  p_billing_interval politicore.billing_interval_enum
)
RETURNS TABLE (tenant_id uuid, tenant_slug text, subscription_id uuid,
               subscription_status text, trial_end timestamptz, next_step text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_slug     text;
  v_tenant   uuid;
  v_version  politicore.plan_versions;
  v_price    bigint;
  v_sub_id   uuid;
  v_sub      politicore.subscriptions;
  v_email    text;
  v_name     text;
  m          text;
BEGIN
  -- (1) Identity: explicit IS NULL — the 0010 convention. A NULL subject
  -- must never pass a guard by three-valued-logic accident.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'self-service onboarding requires an authenticated session';
  END IF;

  -- Duplicate-owner prevention (§12): one profile per identity. This is
  -- ALSO the privilege boundary — a member/admin of an existing tenant
  -- can never use onboarding to self-elevate or spawn a second authority.
  IF EXISTS (SELECT 1 FROM politicore.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'this account already belongs to a tenant — self-service onboarding is only for new tenant owners';
  END IF;

  -- (2) Slug: normalized and validated server-side (reserved, shape,
  -- length). The 0001 UNIQUE constraint is the concurrency backstop.
  v_slug := politicore.normalize_tenant_slug(p_tenant_slug);
  IF EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.slug = v_slug) THEN
    RAISE EXCEPTION 'tenant slug % is already taken', v_slug;
  END IF;
  IF p_tenant_name IS NULL OR length(btrim(p_tenant_name)) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'tenant name must be between 2 and 120 characters';
  END IF;

  -- (§7) Plan: resolved from the public plan CODE — never a browser
  -- plan_version_id. Only the plan's ACTIVE version, with an ACTIVE
  -- price for the requested interval, in the launch currency, is
  -- subscribable. Trial configuration comes from the version (Phase 28
  -- D3 data); onboarding never overrides it.
  SELECT v.* INTO v_version
    FROM politicore.plan_versions v
    JOIN politicore.plans p ON p.id = v.plan_id
   WHERE p.code = p_plan_code AND p.is_active AND v.status = 'active'
   ORDER BY v.version DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'plan % has no active version — select a plan from the public catalog', COALESCE(p_plan_code, '');
  END IF;
  IF v_version.currency <> 'NGN' THEN
    RAISE EXCEPTION 'self-service onboarding currently supports NGN plans only (launch currency — no FX)';
  END IF;
  SELECT amount_minor INTO v_price
    FROM politicore.plan_version_prices
   WHERE plan_version_id = v_version.id
     AND currency = v_version.currency
     AND billing_interval = p_billing_interval::text;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'plan % has no % price in % — select an available interval',
      p_plan_code, p_billing_interval, v_version.currency;
  END IF;
  IF v_version.trial_enabled AND NOT (v_version.trial_days BETWEEN 1 AND 365) THEN
    RAISE EXCEPTION 'plan % has an invalid trial configuration', p_plan_code;
  END IF;

  -- (2)–(4) Tenant + module defaults + default configuration.
  INSERT INTO politicore.tenants (slug, name)
  VALUES (v_slug, btrim(p_tenant_name))
  RETURNING id INTO v_tenant;

  FOREACH m IN ARRAY ARRAY['social','campaign','election','governance']::text[]
  LOOP
    INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
    VALUES (v_tenant, m::politicore.module_code_enum,
            (m::politicore.module_code_enum) = ANY (v_version.included_modules));
  END LOOP;

  INSERT INTO politicore.tenant_settings (tenant_id) VALUES (v_tenant);
  INSERT INTO politicore.public_site_settings (tenant_id) VALUES (v_tenant);

  -- (5) Owner profile. Identity fields come from the SERVER (auth.users
  -- is the identity source of truth), never from the browser payload.
  SELECT email, COALESCE(raw_user_meta_data ->> 'full_name', '')
    INTO v_email, v_name
    FROM auth.users WHERE id = v_uid;
  IF v_email IS NULL OR btrim(v_email) = '' THEN
    RAISE EXCEPTION 'the authenticated identity has no email — self-service onboarding requires email authentication';
  END IF;

  INSERT INTO politicore.profiles
    (id, tenant_id, email, full_name, access_role, membership_types)
  VALUES
    (v_uid, v_tenant, btrim(v_email),
     COALESCE(NULLIF(btrim(p_owner_name), ''), NULLIF(v_name, ''), split_part(v_email, '@', 1)),
     'tenant_super_admin', '{}');

  -- (6)+(7) Subscription + trial + items + audit + notification +
  -- entitlement synchronization — ALL via the EXISTING Phase 29
  -- authority. The owner profile written above makes its owner guard
  -- pass with this caller's own identity; nothing about the journey
  -- bypasses or duplicates that authority.
  v_sub_id := politicore.create_subscription(v_version.id, p_billing_interval);
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = v_sub_id;

  -- (8) Onboarding audit (Core Audit — same subsystem as everything
  -- else) and, for non-trial starts, a welcome notification (trial
  -- starts already notify via create_subscription).
  PERFORM politicore.billing_audit(
    v_tenant, 'tenant:onboarding_completed', 'tenants', v_tenant::text,
    NULL,
    jsonb_build_object('slug', v_slug, 'name', btrim(p_tenant_name),
                       'owner', v_uid, 'plan_code', p_plan_code,
                       'plan_version', v_version.version,
                       'plan_version_id', v_version.id,
                       'billing_interval', p_billing_interval,
                       'currency', v_version.currency,
                       'subscription_id', v_sub_id,
                       'subscription_status', v_sub.status,
                       'modules', to_jsonb(v_version.included_modules)),
    'self-service tenant onboarding');

  IF v_sub.status <> 'trialing' THEN
    PERFORM politicore.billing_notify(
      v_tenant, 'Welcome to PolitiCore',
      'Your subscription is active. Manage invoices and payments from billing.',
      '/portal/billing');
  END IF;

  RETURN QUERY SELECT
    v_tenant,
    v_slug,
    v_sub_id,
    v_sub.status::text,
    v_sub.trial_end,
    (CASE WHEN v_sub.status = 'trialing'
          THEN 'enter the application — your trial is active; nothing is charged automatically and no payment method is on file'
          ELSE 'enter the application — your subscription is active' END)::text;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. SERVER-RESOLVED RESUME STATE (§11). The ONLY state the onboarding
--    UI may act on: resolved from the session's real identity and the
--    database — never from localStorage, query parameters or client
--    flags. Covers every interrupted-journey shape:
--
--      signin           — not authenticated (resume after login)
--      create_tenant    — bare auth identity: account exists, journey
--                         never completed → show the provisioning form
--      enter_app        — profile + live subscription → enter application
--                         (trial status/plan/interval ride along so the
--                         UI can communicate trial terms truthfully)
--      existing_tenant  — profile without a live subscription (e.g. a
--                         platform-provisioned tenant): owners resume the
--                         subscription journey from billing; everyone
--                         else already belongs somewhere
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.onboarding_state()
RETURNS TABLE (stage text, tenant_id uuid, tenant_slug text, tenant_name text,
               access_role text, subscription_id uuid, subscription_status text,
               plan_code text, billing_interval text, trial_end timestamptz,
               next_step text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_profile politicore.profiles;
  v_tenant  politicore.tenants;
  v_sub     politicore.subscriptions;
BEGIN
  IF v_uid IS NULL THEN
    stage := 'signin';
    next_step := 'authenticate to resume onboarding';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_profile FROM politicore.profiles WHERE id = v_uid;
  IF NOT FOUND THEN
    stage := 'create_tenant';
    next_step := 'create your organization: choose a plan, name your tenant and start the subscription/trial';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_tenant FROM politicore.tenants WHERE id = v_profile.tenant_id;
  SELECT * INTO v_sub
    FROM politicore.subscriptions s
   WHERE s.tenant_id = v_profile.tenant_id AND s.ended_at IS NULL
   ORDER BY s.created_at DESC
   LIMIT 1;

  tenant_id          := v_profile.tenant_id;
  tenant_slug        := v_tenant.slug;
  tenant_name        := v_tenant.name;
  access_role        := v_profile.access_role::text;
  subscription_id    := v_sub.id;
  subscription_status := v_sub.status::text;
  billing_interval   := v_sub.billing_interval::text;
  trial_end          := v_sub.trial_end;
  plan_code := (SELECT p.code
                  FROM politicore.plans p
                  JOIN politicore.plan_versions v ON v.id = v_sub.plan_version_id
                 WHERE p.id = v.plan_id);

  IF v_sub.id IS NOT NULL THEN
    stage := 'enter_app';
    next_step := CASE WHEN v_sub.status = 'trialing'
      THEN 'trial active — enter the application; nothing is charged automatically and no payment method is on file'
      ELSE 'enter the application' END::text;
  ELSE
    stage := 'existing_tenant';
    next_step := CASE WHEN v_profile.access_role = 'tenant_super_admin'
      THEN 'your tenant has no live subscription — start one from billing'
      ELSE 'you already belong to a tenant' END::text;
  END IF;
  RETURN NEXT;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. PUBLIC WRAPPERS + GRANT POSTURE (0007/0065 convention). Thin
--    SECURITY INVOKER delegates; all authority lives in the DEFINER
--    bodies. The availability check and resume state are ANONYMOUS
--    surfaces (the pricing/signup journey starts unauthenticated);
--    provisioning itself is authenticated-only — anon is revoked
--    explicitly (defense in depth: the RPC also fails closed on a NULL
--    subject).
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tenant_slug_available(p_slug text)
RETURNS TABLE (slug text, available boolean, reason text)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.tenant_slug_available($1);
$$;

CREATE OR REPLACE FUNCTION public.complete_tenant_onboarding(
  p_tenant_slug text, p_tenant_name text, p_owner_name text,
  p_plan_code text, p_billing_interval politicore.billing_interval_enum)
RETURNS TABLE (tenant_id uuid, tenant_slug text, subscription_id uuid,
               subscription_status text, trial_end timestamptz, next_step text)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.complete_tenant_onboarding($1, $2, $3, $4, $5);
$$;

CREATE OR REPLACE FUNCTION public.onboarding_state()
RETURNS TABLE (stage text, tenant_id uuid, tenant_slug text, tenant_name text,
               access_role text, subscription_id uuid, subscription_status text,
               plan_code text, billing_interval text, trial_end timestamptz,
               next_step text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.onboarding_state();
$$;

-- grants (PostgREST wrapper surface) ─────────────────────────────────
GRANT EXECUTE ON FUNCTION public.tenant_slug_available(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_state() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_tenant_onboarding(text, text, text, text, politicore.billing_interval_enum)
  TO authenticated;

REVOKE ALL ON FUNCTION public.tenant_slug_available(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tenant_onboarding(text, text, text, text, politicore.billing_interval_enum)
  FROM anon, PUBLIC;

-- politicore underlyings: the wrappers run as INVOKER, so the roles
-- intended to reach a surface need EXECUTE on its underlying too (0007/
-- 0037/0065 precedent). The two read-only journey surfaces are anonymous
-- (the journey starts unauthenticated) — fail-closed on a NULL subject is
-- enforced INSIDE onboarding_state's DEFINER body, never by grants alone.
-- Provisioning stays authenticated-only.
GRANT EXECUTE ON FUNCTION politicore.tenant_slug_available(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION politicore.onboarding_state() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION politicore.complete_tenant_onboarding(text, text, text, text, politicore.billing_interval_enum)
  TO authenticated;

REVOKE ALL ON FUNCTION politicore.tenant_slug_available(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION politicore.onboarding_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION politicore.complete_tenant_onboarding(text, text, text, text, politicore.billing_interval_enum)
  FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.normalize_tenant_slug(text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.reserved_tenant_slugs() FROM anon, PUBLIC;
