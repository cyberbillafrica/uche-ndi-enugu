-- ============================================================================
-- POLITICORE — PHASE 28 — COMMERCIAL PLANS & ENTITLEMENTS (SaaS PHASE A)
-- ============================================================================
--
-- Implements the Phase 27 architecture gate
-- (docs/SaaS-Architecture-Product-Decision-Gate.md §B2) over the EXISTING
-- substrate:
--
--   plans              — product identity (code UNIQUE, is_active soft
--                        retirement; never destructively deleted)
--   plan_versions      — immutable commercial contracts:
--                        draft → active → retired, DB-enforced
--   plan_version_prices— normalized prices: (currency, billing_interval,
--                        amount_minor); monthly and annual are independent
--                        rows; money is integer minor units (kobo for NGN)
--
-- THE COMMERCIAL LAYER IS THE AUTHORITATIVE WRITER of the EXISTING
-- politicore.platform_settings.settings.service_entitlements map
-- (sync_tenant_entitlements). Readers — service_entitled(),
-- control_center_overview(), module guards, the permission resolver — are
-- UNCHANGED. No subscription/checkout/payment tables exist here (Phase 29).
--
-- Boundaries held (gate invariants 9/10/14):
--   * sync NEVER writes permission_grants, user_access, tenant_modules
--     or RLS; application authorization is untouched.
--   * module_code_enum is untouched — plan versions reference the four
--     EXISTING business modules only; no SaaS values enter the enum.
--   * no new roles, no new permissions (count stays 43), no new audit
--     subsystem — plan events land in politicore.system_audits.
--
-- Launch decisions (Phase 27 D2/D3/D5, seeded as DATA, never logic):
--   D2 currency = NGN (prices keyed per currency; no FX anywhere);
--   D3 trial_enabled = true, trial_days = 14 (subscription phase comes
--      later — this phase only stores the plan-level parameters);
--   D5 catalog = starter | professional | enterprise. SEED PRICES ARE
--      CONFIGURATION, easy to change, and documented in the phase report.
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. TABLES
-- ═══════════════════════════════════════════════════════════════════════

-- Product identity. Prices NEVER live here (§5: "Do not store mutable
-- pricing directly on plans").
CREATE TABLE politicore.plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE
              CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(code) BETWEEN 2 AND 60),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The version status vocabulary. draft = editable; active = immutable
-- commercial contract; retired = historical, immutable.
CREATE TYPE politicore.plan_version_status_enum AS ENUM ('draft', 'active', 'retired');

CREATE TABLE politicore.plan_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id             uuid NOT NULL REFERENCES politicore.plans(id) ON DELETE RESTRICT,
  version             integer NOT NULL CHECK (version >= 1),
  status              politicore.plan_version_status_enum NOT NULL DEFAULT 'draft',
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- effective windows are set at activation/retirement (never client-supplied)
  effective_from      timestamptz,
  effective_to        timestamptz,
  -- exactly the EXISTING business-module taxonomy (module_code_enum);
  -- at least one module per version.
  included_modules    politicore.module_code_enum[] NOT NULL
                      CHECK (array_length(included_modules, 1) >= 1),
  -- allowlisted JSONB structures — validated by the RPC layer below,
  -- never arbitrary configuration.
  feature_entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Phase 27 D3 launch defaults; trial LIFECYCLE is Phase 29+.
  trial_enabled       boolean NOT NULL DEFAULT true,
  trial_days          integer NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 1 AND 365),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

CREATE INDEX plan_versions_plan_idx ON politicore.plan_versions (plan_id, version DESC);

-- Normalized pricing (§8): one row per (version, currency, interval).
-- Monthly and annual are independent rows — annual is NEVER derived.
CREATE TABLE politicore.plan_version_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES politicore.plan_versions(id) ON DELETE CASCADE,
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'annual')),
  amount_minor     bigint NOT NULL CHECK (amount_minor >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_version_id, currency, billing_interval)
  -- currency must match the version's own denomination — enforced by the
  -- price guard trigger below (CHECK constraints cannot contain subqueries).
);

CREATE INDEX plan_version_prices_version_idx ON politicore.plan_version_prices (plan_version_id);

-- updated_at maintenance (existing 0001 trigger).
CREATE TRIGGER trg_plans_updated BEFORE UPDATE ON politicore.plans
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_plan_versions_updated BEFORE UPDATE ON politicore.plan_versions
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 2. IMMUTABILITY — enforced at the DATABASE layer (§7), so even a
--    future code defect or service_role session cannot rewrite history.
-- ═══════════════════════════════════════════════════════════════════════

-- Version lifecycle + field immutability:
--   * transitions limited to draft→active and active→retired (no reverse,
--     no skipping);
--   * once active/retired, no commercial field may change (price lives in
--     plan_version_prices and has its own guard below).
CREATE OR REPLACE FUNCTION politicore.guard_plan_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Status transitions: only the two authorized edges.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ( (OLD.status = 'draft'  AND NEW.status = 'active')
            OR (OLD.status = 'active' AND NEW.status = 'retired') ) THEN
        RAISE EXCEPTION 'illegal plan version status transition % -> % (draft -> active -> retired only)',
          OLD.status, NEW.status;
      END IF;
    END IF;

    -- Commercial meaning is frozen once active (and stays frozen retired).
    -- effective_to is stampable ONLY as part of the active->retired close
    -- (retirement itself must set the window end); effective_from is frozen
    -- outright once active.
    IF OLD.status IN ('active', 'retired') THEN
      IF NEW.plan_id              IS DISTINCT FROM OLD.plan_id
      OR NEW.version              IS DISTINCT FROM OLD.version
      OR NEW.currency             IS DISTINCT FROM OLD.currency
      OR NEW.included_modules     IS DISTINCT FROM OLD.included_modules
      OR NEW.feature_entitlements IS DISTINCT FROM OLD.feature_entitlements
      OR NEW.limits               IS DISTINCT FROM OLD.limits
      OR NEW.trial_enabled        IS DISTINCT FROM OLD.trial_enabled
      OR NEW.trial_days           IS DISTINCT FROM OLD.trial_days
      OR NEW.effective_from       IS DISTINCT FROM OLD.effective_from
      OR (NOT (OLD.status = 'active' AND NEW.status = 'retired')
          AND NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
        RAISE EXCEPTION 'plan version % is %: commercial fields are immutable — create a new version instead',
          OLD.id, OLD.status;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_plan_version_immutability
  BEFORE UPDATE ON politicore.plan_versions
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_plan_version_immutability();

-- Price immutability: rows of an active/retired version can be neither
-- changed, removed, nor ADDED to (adding a price changes the contract).
CREATE OR REPLACE FUNCTION politicore.guard_plan_version_price_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_status   politicore.plan_version_status_enum;
  v_currency text;
BEGIN
  SELECT status, currency INTO v_status, v_currency
    FROM politicore.plan_versions
   WHERE id = COALESCE(NEW.plan_version_id, OLD.plan_version_id);
  IF v_status IN ('active', 'retired') THEN
    RAISE EXCEPTION 'prices of a % plan version are immutable — create a new version instead', v_status;
  END IF;
  -- A price row must be denominated in its version's own currency (§8).
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.currency IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION 'price currency % does not match the plan version currency %',
      NEW.currency, v_currency;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_plan_version_prices
  BEFORE INSERT OR UPDATE OR DELETE ON politicore.plan_version_prices
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_plan_version_price_immutability();

-- At most ONE active version per plan (the current commercial contract);
-- enforced by trigger (partial unique indexes cannot express the
-- transition-time invariant safely across concurrent activations).
CREATE OR REPLACE FUNCTION politicore.guard_plan_version_single_active()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_other uuid;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT id INTO v_other
      FROM politicore.plan_versions
     WHERE plan_id = NEW.plan_id AND status = 'active' AND id <> NEW.id
     LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'plan % already has an active version (%) — retire it first',
        NEW.plan_id, v_other;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_plan_version_single_active
  BEFORE INSERT OR UPDATE ON politicore.plan_versions
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_plan_version_single_active();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. RLS — platform-owned catalog data (§17). Plans/versions/prices are
--    NOT tenant-scoped rows; the read surface for tenant users is the
--    bounded public RPC projection (§5), never the base tables.
--    0000 grants blanket table privileges; these policies are the
--    boundary, and writes flow exclusively through the SECURITY DEFINER
--    RPCs (§4) — authenticated holds NO mutation policy.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE politicore.plans               ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.plans               FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.plan_versions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.plan_versions       FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.plan_version_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.plan_version_prices FORCE ROW LEVEL SECURITY;

-- Platform admin manages the catalog (the RPCs are the mutation path; this
-- policy keeps the platform admin's direct surface consistent).
CREATE POLICY plans_platform_admin ON politicore.plans
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY plan_versions_platform_admin ON politicore.plan_versions
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY plan_version_prices_platform_admin ON politicore.plan_version_prices
  FOR ALL USING (politicore.is_platform_admin());

-- Minimum safe read surface for AUTHENTICATED tenant users (§16/§17):
-- catalog shape for plan selection/status — drafts excluded, prices of
-- drafts excluded, retired history excluded. Direct-table SELECT never
-- exposes platform drafting state or unconfirmed pricing.
CREATE POLICY plans_read_active ON politicore.plans
  FOR SELECT USING (is_active = true);
CREATE POLICY plan_versions_read_active ON politicore.plan_versions
  FOR SELECT USING (status = 'active');
CREATE POLICY plan_version_prices_read_active ON politicore.plan_version_prices
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM politicore.plan_versions v
             WHERE v.id = plan_version_id AND v.status = 'active'));

-- anon: NO table grants survive the policy posture (no policy was granted
-- to anon); explicit for clarity and defense in depth:
REVOKE ALL ON politicore.plans FROM anon;
REVOKE ALL ON politicore.plan_versions FROM anon;
REVOKE ALL ON politicore.plan_version_prices FROM anon;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. VALIDATORS — allowlisted structures only (§10/§11). The RPC layer and
--    the seed path both funnel through these helpers; arbitrary JSONB is
--    never accepted.
-- ═══════════════════════════════════════════════════════════════════════

-- Feature entitlements (§10): a minimal allowlisted catalog — capability
-- flags, NOT permission equivalents, never application authorization.
CREATE OR REPLACE FUNCTION politicore.plan_feature_catalog()
RETURNS text[]
LANGUAGE sql STABLE
SET search_path = politicore, pg_temp
AS $$
  SELECT ARRAY[
    'governance_projects', 'governance_participation', 'governance_accountability',
    'custom_domains', 'advanced_analytics'
  ]::text[];
$$;

-- Commercial limits (§11): the known vocabulary. `null` = unlimited
-- (distinct from 0 — §11 forbids ambiguous magic numbers); numbers are
-- >= 0. Module limits are keyed by the four EXISTING module codes.
CREATE OR REPLACE FUNCTION politicore.plan_validate_limits(p_limits jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  k text;
  v numeric;
  module_limit_keys text[] := ARRAY[
    'max_governance_requests', 'max_social_tasks', 'max_campaign_activities',
    'max_election_records', 'max_notifications'];
BEGIN
  IF p_limits IS NULL OR jsonb_typeof(p_limits) <> 'object' THEN
    RAISE EXCEPTION 'limits must be a JSON object';
  END IF;
  FOR k, v IN
    SELECT j.key, j.value::text::numeric
      FROM jsonb_each_text(p_limits) j
  LOOP
    IF k NOT IN ('max_members','max_storage_bytes','max_custom_domains')
       AND k <> ALL (module_limit_keys) THEN
      RAISE EXCEPTION 'unknown limit key %', k;
    END IF;
    IF v IS DISTINCT FROM NULL AND (v <> floor(v) OR v < 0) THEN
      RAISE EXCEPTION 'limit % must be a non-negative integer or null (unlimited)', k;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.plan_validate_features(p_features jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  k text;
  allowed text[] := politicore.plan_feature_catalog();
BEGIN
  IF p_features IS NULL OR jsonb_typeof(p_features) <> 'object' THEN
    RAISE EXCEPTION 'feature_entitlements must be a JSON object';
  END IF;
  FOR k IN SELECT j.k FROM jsonb_object_keys(p_features) j(k)
  LOOP
    IF k <> ALL (allowed) THEN
      RAISE EXCEPTION 'unknown feature entitlement % (allowlist: %)',
        k, array_to_string(allowed, ', ');
    END IF;
    IF jsonb_typeof(p_features -> k) <> 'boolean' THEN
      RAISE EXCEPTION 'feature entitlement % must be boolean', k;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ENTITLEMENT SYNCHRONIZATION (§12/§13) — the commercial→entitlement
--    boundary. The EXISTING platform_settings.settings.service_entitlements
--    map is written ONLY here (server-side, platform authority, audited).
--    The client NEVER writes entitlement state; no client-supplied
--    authority fields exist in these signatures.
--
--    Two server-side entry points, one resolver:
--      apply_plan_version_entitlements(tenant, plan_version_id, reason)
--          — version-addressed primitive; Phase 29 subscriptions call
--            exactly this on activation/change/expiry.
--      sync_tenant_entitlements(tenant, plan_code, reason)
--          — Phase 28 convenience: resolves the plan's ACTIVE version.
--
--    Without subscriptions (§14), the platform administrator drives sync
--    explicitly — the safest pre-subscription mechanism. It is NOT a
--    tenant→plan binding: Phase 29 adds that as the subscription object.
--
--    The sync writes the FULL four-module map (authoritative writer):
--    modules absent from the plan are set false, so a plan change cleanly
--    revokes commercial availability. tenant_modules.enabled,
--    permission_grants, RLS and the permission resolver are NEVER touched.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.apply_plan_version_entitlements(
  p_tenant          uuid,
  p_plan_version_id uuid,
  p_reason          text DEFAULT NULL
)
RETURNS TABLE (module politicore.module_code_enum, entitled boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_version   politicore.plan_versions;
  v_prev      jsonb;
  v_map       jsonb;
  v_plan_code text;
BEGIN
  -- Platform authority ONLY (§13). Explicit IS TRUE: no JWT subject must
  -- never bypass the guard (the 0010 lesson).
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'entitlement synchronization requires platform_super_admin authority';
  END IF;

  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'unknown tenant %', p_tenant;
  END IF;

  -- The commercial source of truth: an ACTIVE plan version.
  SELECT * INTO v_version
    FROM politicore.plan_versions v
   WHERE v.id = p_plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version %', p_plan_version_id;
  END IF;
  IF v_version.status <> 'active' THEN
    RAISE EXCEPTION 'plan version % is % — only ACTIVE versions may be synchronized',
      p_plan_version_id, v_version.status;
  END IF;

  -- Resolve the full four-module entitlement map from the plan version.
  v_map := jsonb_build_object(
    'social',     ('social'     = ANY (v_version.included_modules)),
    'campaign',   ('campaign'   = ANY (v_version.included_modules)),
    'election',   ('election'   = ANY (v_version.included_modules)),
    'governance', ('governance' = ANY (v_version.included_modules)));

  -- Previous state for the audit record.
  v_prev := (SELECT ps.settings -> 'service_entitlements' -> p_tenant::text
               FROM politicore.platform_settings ps WHERE ps.id = 1);

  -- THE authoritative write into the EXISTING entitlement substrate.
  UPDATE politicore.platform_settings
     SET settings   = jsonb_set(
              -- Nested jsonb_set: guarantees the container exists even where
              -- jsonb_set will not create intermediate path levels (pglite).
              jsonb_set(COALESCE(settings, '{}'::jsonb), '{service_entitlements}', '{}'::jsonb, true),
              ARRAY['service_entitlements', p_tenant::text], v_map, true),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = 1;

  -- Core Audit (reuse, never a parallel system). Deterministic single-row
  -- insert; actor fields are server-resolved, never client-supplied.
  v_plan_code := (SELECT code FROM politicore.plans WHERE id = v_version.plan_id);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (p_tenant, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'entitlements_synchronized', 'platform_settings', p_tenant::text,
     v_prev,
     jsonb_build_object('plan_code', v_plan_code,
                        'plan_version', v_version.version,
                        'plan_version_id', v_version.id,
                        'modules', v_map),
     p_reason);

  RETURN QUERY
  SELECT mod::politicore.module_code_enum,
         (mod = ANY (v_version.included_modules))
    FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) AS mod;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.sync_tenant_entitlements(
  p_tenant   uuid,
  p_plan_code text,
  p_reason   text DEFAULT NULL
)
RETURNS TABLE (module politicore.module_code_enum, entitled boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_version_id uuid;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'entitlement synchronization requires platform_super_admin authority';
  END IF;
  IF p_plan_code IS NULL THEN
    RAISE EXCEPTION 'plan code is required';
  END IF;

  SELECT v.id INTO v_version_id
    FROM politicore.plan_versions v
    JOIN politicore.plans p ON p.id = v.plan_id
   WHERE p.code = p_plan_code AND v.status = 'active'
   ORDER BY v.version DESC
   LIMIT 1;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'plan % has no active version', p_plan_code;
  END IF;

  RETURN QUERY
  SELECT * FROM politicore.apply_plan_version_entitlements(p_tenant, v_version_id, p_reason);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. PLAN LIFECYCLE RPCs (§5–§8, §15) — SECURITY DEFINER, platform-admin
--    only, every mutation Core-Audit-logged with server-resolved actor.
--    Guard posture mirrors 0010/0060: explicit `IS TRUE` platform checks.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.create_plan(
  p_code        text,
  p_name        text,
  p_description text DEFAULT NULL,
  p_sort_order  integer DEFAULT 0,
  p_reason      text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_plan politicore.plans;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'plan administration requires platform_super_admin authority';
  END IF;
  IF p_code !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p_code) NOT BETWEEN 2 AND 60 THEN
    RAISE EXCEPTION 'invalid plan code: %', p_code;
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'invalid plan name';
  END IF;

  INSERT INTO politicore.plans (code, name, description, sort_order)
  VALUES (p_code, p_name, p_description, p_sort_order)
  RETURNING * INTO v_plan;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, new_value, reason_notes)
  VALUES
    (NULL, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'plan_created', 'plans', v_plan.id::text,
     jsonb_build_object('code', v_plan.code, 'name', v_plan.name,
                        'sort_order', v_plan.sort_order),
     p_reason);

  RETURN v_plan.id;
END;
$$;

-- Every draft field arrives through ONE validated entry point. Prices are
-- set at the same moment (only a draft may carry prices).
CREATE OR REPLACE FUNCTION politicore.create_plan_version(
  p_plan_id             uuid,
  p_included_modules    text[],
  p_feature_entitlements jsonb DEFAULT '{}'::jsonb,
  p_limits              jsonb DEFAULT '{}'::jsonb,
  p_currency            text DEFAULT 'NGN',
  p_trial_enabled       boolean DEFAULT true,
  p_trial_days          integer DEFAULT 14,
  p_prices              jsonb DEFAULT '{"monthly": null, "annual": null}'::jsonb,
  p_reason              text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_plan     politicore.plans;
  v_modules  politicore.module_code_enum[];
  v_next     integer;
  v_version  politicore.plan_versions;
  v_interval text;
  v_amount   numeric;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'plan administration requires platform_super_admin authority';
  END IF;

  SELECT * INTO v_plan FROM politicore.plans WHERE id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan %', p_plan_id;
  END IF;

  -- Modules: ONLY the existing business-module taxonomy (§9/§C).
  IF p_included_modules IS NULL OR array_length(p_included_modules, 1) IS NULL THEN
    RAISE EXCEPTION 'a plan version must include at least one module';
  END IF;
  -- Invalid taxonomy text raises `invalid input value for enum` here —
  -- a SaaS value can never enter the module dimension (test-proven).
  SELECT array_agg(DISTINCT e::politicore.module_code_enum ORDER BY e::politicore.module_code_enum)
    INTO v_modules
    FROM unnest(p_included_modules) e;

  -- Currency: launch D2 = NGN (multi-currency capable; no FX logic).
  IF p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invalid currency code %', p_currency;
  END IF;
  IF NOT (p_trial_days BETWEEN 1 AND 365) THEN
    RAISE EXCEPTION 'invalid trial_days';
  END IF;

  -- Allowlisted structures only (§10/§11).
  PERFORM politicore.plan_validate_features(p_feature_entitlements);
  PERFORM politicore.plan_validate_limits(p_limits);

  -- Prices: object keyed by billing_interval with non-negative integer
  -- minor units (money is integer minor units — kobo for NGN, §8).
  IF p_prices IS NULL OR jsonb_typeof(p_prices) <> 'object' THEN
    RAISE EXCEPTION 'prices must be a JSON object keyed by billing_interval';
  END IF;
  FOR v_interval, v_amount IN
    SELECT j.key, j.value::text::numeric
      FROM jsonb_each_text(p_prices) j
  LOOP
    IF v_interval NOT IN ('monthly', 'annual') THEN
      RAISE EXCEPTION 'unknown billing interval %', v_interval;
    END IF;
    IF v_amount IS DISTINCT FROM NULL
       AND jsonb_typeof(p_prices -> v_interval) <> 'number' THEN
      RAISE EXCEPTION 'price % must be a JSON number of minor units (never a string)', v_interval;
    END IF;
    IF v_amount IS DISTINCT FROM NULL
       AND (v_amount <> floor(v_amount) OR v_amount < 0
            OR v_amount > 9223372036854775807) THEN
      RAISE EXCEPTION 'price % must be a non-negative integer of minor units', v_interval;
    END IF;
  END LOOP;

  -- Next immutable version number for this plan.
  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next
    FROM politicore.plan_versions WHERE plan_id = p_plan_id;

  INSERT INTO politicore.plan_versions
    (plan_id, version, status, currency, included_modules,
     feature_entitlements, limits, trial_enabled, trial_days)
  VALUES
    (p_plan_id, v_next, 'draft', p_currency, v_modules,
     p_feature_entitlements, p_limits, p_trial_enabled, p_trial_days)
  RETURNING * INTO v_version;

  INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
  SELECT v_version.id, p_currency, j.key,
         (j.value #>> '{}')::bigint
    FROM jsonb_each(p_prices) j
   WHERE jsonb_typeof(j.value) = 'number';

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, new_value, reason_notes)
  VALUES
    (NULL, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'plan_version_created', 'plan_versions', v_version.id::text,
     jsonb_build_object('plan_code', v_plan.code, 'version', v_version.version,
                        'currency', p_currency, 'modules', to_jsonb(v_modules),
                        'feature_entitlements', p_feature_entitlements,
                        'limits', p_limits,
                        'trial_enabled', p_trial_enabled, 'trial_days', p_trial_days,
                        'prices', p_prices),
     p_reason);

  RETURN v_version.id;
END;
$$;

-- Draft versions are the ONLY editable state; every edit is audited
-- (§18 plan_version_updated). Draft-only — the immutability trigger would
-- reject the same statement against an active/retired version anyway.
CREATE OR REPLACE FUNCTION politicore.update_plan_version_draft(
  p_plan_version_id    uuid,
  p_included_modules   text[] DEFAULT NULL,
  p_feature_entitlements jsonb DEFAULT NULL,
  p_limits             jsonb DEFAULT NULL,
  p_trial_enabled      boolean DEFAULT NULL,
  p_trial_days         integer DEFAULT NULL,
  p_prices             jsonb DEFAULT NULL,
  p_reason             text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_version  politicore.plan_versions;
  v_old      jsonb;
  v_interval text;
  v_amount   numeric;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'plan administration requires platform_super_admin authority';
  END IF;

  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = p_plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version %', p_plan_version_id;
  END IF;
  IF v_version.status <> 'draft' THEN
    RAISE EXCEPTION 'only DRAFT plan versions may be edited (status is %) — create a new version instead', v_version.status;
  END IF;

  v_old := to_jsonb(v_version);

  IF p_included_modules IS NOT NULL THEN
    IF array_length(p_included_modules, 1) IS NULL THEN
      RAISE EXCEPTION 'a plan version must include at least one module';
    END IF;
    UPDATE politicore.plan_versions
       SET included_modules = (SELECT array_agg(DISTINCT e::politicore.module_code_enum ORDER BY e::politicore.module_code_enum)
                                 FROM unnest(p_included_modules) e)
     WHERE id = v_version.id;
  END IF;
  IF p_feature_entitlements IS NOT NULL THEN
    PERFORM politicore.plan_validate_features(p_feature_entitlements);
    UPDATE politicore.plan_versions SET feature_entitlements = p_feature_entitlements WHERE id = v_version.id;
  END IF;
  IF p_limits IS NOT NULL THEN
    PERFORM politicore.plan_validate_limits(p_limits);
    UPDATE politicore.plan_versions SET limits = p_limits WHERE id = v_version.id;
  END IF;
  IF p_trial_enabled IS NOT NULL THEN
    UPDATE politicore.plan_versions SET trial_enabled = p_trial_enabled WHERE id = v_version.id;
  END IF;
  IF p_trial_days IS NOT NULL THEN
    IF NOT (p_trial_days BETWEEN 1 AND 365) THEN
      RAISE EXCEPTION 'invalid trial_days';
    END IF;
    UPDATE politicore.plan_versions SET trial_days = p_trial_days WHERE id = v_version.id;
  END IF;

  IF p_prices IS NOT NULL THEN
    IF jsonb_typeof(p_prices) <> 'object' THEN
      RAISE EXCEPTION 'prices must be a JSON object keyed by billing_interval';
    END IF;
    FOR v_interval, v_amount IN
      SELECT j.key, j.value::text::numeric FROM jsonb_each_text(p_prices) j
    LOOP
      IF v_interval NOT IN ('monthly', 'annual') THEN
        RAISE EXCEPTION 'unknown billing interval %', v_interval;
      END IF;
      IF v_amount IS DISTINCT FROM NULL
         AND jsonb_typeof(p_prices -> v_interval) <> 'number' THEN
        RAISE EXCEPTION 'price % must be a JSON number of minor units (never a string)', v_interval;
      END IF;
      IF v_amount IS DISTINCT FROM NULL
         AND (v_amount <> floor(v_amount) OR v_amount < 0
              OR v_amount > 9223372036854775807) THEN
        RAISE EXCEPTION 'price % must be a non-negative integer of minor units', v_interval;
      END IF;
    END LOOP;
    -- Reprice a draft: existing rows removed, new rows written (drafts only).
    DELETE FROM politicore.plan_version_prices WHERE plan_version_id = v_version.id;
    INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
    SELECT v_version.id, v_version.currency, j.key, (j.value #>> '{}')::bigint
      FROM jsonb_each(p_prices) j
     WHERE jsonb_typeof(j.value) = 'number';
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (NULL, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'plan_version_updated', 'plan_versions', v_version.id::text,
     v_old,
     (SELECT to_jsonb(v) FROM politicore.plan_versions v WHERE v.id = v_version.id),
     p_reason);

  RETURN v_version.id;
END;
$$;

-- draft → active. Stamps the effective window (server time, never client
-- supplied) and closes any previously active version's window first —
-- only one active version per plan may exist.
CREATE OR REPLACE FUNCTION politicore.activate_plan_version(p_plan_version_id uuid, p_reason text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_version politicore.plan_versions;
  v_prices  integer;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'plan administration requires platform_super_admin authority';
  END IF;

  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = p_plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version %', p_plan_version_id;
  END IF;
  IF v_version.status <> 'draft' THEN
    RAISE EXCEPTION 'only DRAFT plan versions may be activated (status is %)', v_version.status;
  END IF;
  -- A commercial contract without at least one price is not saleable.
  SELECT count(*) INTO v_prices
    FROM politicore.plan_version_prices WHERE plan_version_id = v_version.id;
  IF v_prices < 1 THEN
    RAISE EXCEPTION 'plan version has no prices — set at least one (currency, billing_interval, amount_minor)';
  END IF;

  -- Close the previous active contract's window, if any.
  UPDATE politicore.plan_versions
     SET effective_to = now()
   WHERE plan_id = v_version.plan_id AND status = 'active';

  UPDATE politicore.plan_versions
     SET status = 'active', effective_from = now(), effective_to = NULL
   WHERE id = v_version.id
   RETURNING * INTO v_version;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (NULL, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'plan_version_activated', 'plan_versions', v_version.id::text,
     jsonb_build_object('status', 'draft'),
     jsonb_build_object('status', 'active', 'effective_from', to_jsonb(v_version.effective_from)),
     p_reason);

  RETURN v_version.id;
END;
$$;

-- active → retired (historical, immutable, still referenceable by future
-- subscriptions/invoices — never deleted).
CREATE OR REPLACE FUNCTION politicore.retire_plan_version(p_plan_version_id uuid, p_reason text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_version politicore.plan_versions;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'plan administration requires platform_super_admin authority';
  END IF;

  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = p_plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version %', p_plan_version_id;
  END IF;
  IF v_version.status <> 'active' THEN
    RAISE EXCEPTION 'only ACTIVE plan versions may be retired (status is %)', v_version.status;
  END IF;

  UPDATE politicore.plan_versions
     SET status = 'retired', effective_to = now()
   WHERE id = v_version.id
   RETURNING * INTO v_version;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (NULL, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'plan_version_retired', 'plan_versions', v_version.id::text,
     jsonb_build_object('status', 'active'),
     jsonb_build_object('status', 'retired', 'effective_to', to_jsonb(v_version.effective_to)),
     p_reason);

  RETURN v_version.id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. READ MODEL (§15/§16) — platform management + the minimum safe tenant
--    surface (§16: tenant users must not modify plan definitions; no
--    platform-wide management through tenant Control Center).
-- ═══════════════════════════════════════════════════════════════════════

-- Platform administration read model (is_platform_admin only).
CREATE OR REPLACE FUNCTION politicore.plan_catalog_admin()
RETURNS TABLE (
  plan_id       uuid,
  plan_code     text,
  plan_name     text,
  description   text,
  is_active     boolean,
  sort_order    integer,
  version_id    uuid,
  version       integer,
  status        politicore.plan_version_status_enum,
  currency      text,
  included_modules politicore.module_code_enum[],
  feature_entitlements jsonb,
  limits        jsonb,
  trial_enabled boolean,
  trial_days    integer,
  effective_from timestamptz,
  effective_to  timestamptz,
  prices        jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  -- Fail closed (0064 convention): a member probing the platform read model
  -- gets an explicit authority error, never an empty-but-successful result.
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'plan administration requires platform_super_admin authority';
  END IF;
  RETURN QUERY
  SELECT p.id, p.code, p.name, p.description, p.is_active, p.sort_order,
         v.id, v.version, v.status, v.currency, v.included_modules,
         v.feature_entitlements, v.limits, v.trial_enabled, v.trial_days,
         v.effective_from, v.effective_to,
         COALESCE((SELECT jsonb_object_agg(pr.billing_interval, pr.amount_minor)
                     FROM politicore.plan_version_prices pr
                    WHERE pr.plan_version_id = v.id), '{}'::jsonb)
    FROM politicore.plans p
    LEFT JOIN politicore.plan_versions v ON v.plan_id = p.id
   ORDER BY p.sort_order, p.code, v.version DESC NULLS LAST;
END;
$$;

-- Tenant-safe projection (§16/§17): ACTIVE plans only — identity, shape,
-- pricing and trial parameters. No drafts, no retired history, no platform
-- internals. Tenant users can read this safely; they can never WRITE it.
CREATE OR REPLACE FUNCTION politicore.plan_catalog_public()
RETURNS TABLE (
  plan_code     text,
  plan_name     text,
  description   text,
  sort_order    integer,
  version       integer,
  currency      text,
  included_modules politicore.module_code_enum[],
  feature_entitlements jsonb,
  trial_enabled boolean,
  trial_days    integer,
  prices        jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
  SELECT p.code, p.name, p.description, p.sort_order,
         v.version, v.currency, v.included_modules,
         v.feature_entitlements, v.trial_enabled, v.trial_days,
         COALESCE((SELECT jsonb_object_agg(pr.billing_interval, pr.amount_minor)
                     FROM politicore.plan_version_prices pr
                    WHERE pr.plan_version_id = v.id), '{}'::jsonb)
    FROM politicore.plans p
    JOIN politicore.plan_versions v ON v.plan_id = p.id
   WHERE p.is_active AND v.status = 'active'
   ORDER BY p.sort_order, p.code;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. PUBLIC WRAPPERS + GRANT POSTURE (0007/0060 convention) — hosted
--    Supabase exposes only the public schema through the data API; thin
--    SECURITY INVOKER delegates keep all authority inside the DEFINER
--    bodies. anon is revoked everywhere (§17: no anonymous access).
-- ═════════════════════════════════════════════ catalogs ──

CREATE OR REPLACE FUNCTION public.create_plan(
  p_code text, p_name text, p_description text, p_sort_order integer, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.create_plan($1, $2, $3, $4, $5);
$$;

CREATE OR REPLACE FUNCTION public.create_plan_version(
  p_plan_id uuid, p_included_modules text[], p_feature_entitlements jsonb,
  p_limits jsonb, p_currency text, p_trial_enabled boolean, p_trial_days integer,
  p_prices jsonb, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.create_plan_version($1, $2, $3, $4, $5, $6, $7, $8, $9);
$$;

CREATE OR REPLACE FUNCTION public.update_plan_version_draft(
  p_plan_version_id uuid, p_included_modules text[], p_feature_entitlements jsonb,
  p_limits jsonb, p_trial_enabled boolean, p_trial_days integer,
  p_prices jsonb, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.update_plan_version_draft($1, $2, $3, $4, $5, $6, $7, $8);
$$;

CREATE OR REPLACE FUNCTION public.activate_plan_version(p_plan_version_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.activate_plan_version($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.retire_plan_version(p_plan_version_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.retire_plan_version($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.sync_tenant_entitlements(
  p_tenant uuid, p_plan_code text, p_reason text)
RETURNS TABLE (module politicore.module_code_enum, entitled boolean)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.sync_tenant_entitlements($1, $2, $3);
$$;

CREATE OR REPLACE FUNCTION public.apply_plan_version_entitlements(
  p_tenant uuid, p_plan_version_id uuid, p_reason text)
RETURNS TABLE (module politicore.module_code_enum, entitled boolean)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.apply_plan_version_entitlements($1, $2, $3);
$$;

CREATE OR REPLACE FUNCTION public.plan_catalog_admin()
RETURNS TABLE (
  plan_id uuid, plan_code text, plan_name text, description text,
  is_active boolean, sort_order integer,
  version_id uuid, version integer, status politicore.plan_version_status_enum,
  currency text, included_modules politicore.module_code_enum[],
  feature_entitlements jsonb, limits jsonb,
  trial_enabled boolean, trial_days integer,
  effective_from timestamptz, effective_to timestamptz, prices jsonb)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.plan_catalog_admin();
$$;

CREATE OR REPLACE FUNCTION public.plan_catalog_public()
RETURNS TABLE (
  plan_code text, plan_name text, description text, sort_order integer,
  version integer, currency text, included_modules politicore.module_code_enum[],
  feature_entitlements jsonb, trial_enabled boolean, trial_days integer,
  prices jsonb)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.plan_catalog_public();
$$;

-- ═══════════════════════════════════════════════════════ grants ──

GRANT EXECUTE ON FUNCTION public.plan_catalog_public() TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_plan(text, text, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_plan_version(uuid, text[], jsonb, jsonb, text, boolean, integer, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_plan_version_draft(uuid, text[], jsonb, jsonb, boolean, integer, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_plan_version(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retire_plan_version(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_tenant_entitlements(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_plan_version_entitlements(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plan_catalog_admin() TO authenticated;

REVOKE ALL ON FUNCTION public.create_plan(text, text, text, integer, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.create_plan_version(uuid, text[], jsonb, jsonb, text, boolean, integer, jsonb, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.update_plan_version_draft(uuid, text[], jsonb, jsonb, boolean, integer, jsonb, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.activate_plan_version(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.retire_plan_version(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.sync_tenant_entitlements(uuid, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.apply_plan_version_entitlements(uuid, uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.plan_catalog_admin() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.plan_catalog_public() FROM PUBLIC;

REVOKE ALL ON FUNCTION politicore.create_plan(text, text, text, integer, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.create_plan_version(uuid, text[], jsonb, jsonb, text, boolean, integer, jsonb, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.update_plan_version_draft(uuid, text[], jsonb, jsonb, boolean, integer, jsonb, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.activate_plan_version(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.retire_plan_version(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.sync_tenant_entitlements(uuid, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.apply_plan_version_entitlements(uuid, uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.plan_catalog_admin() FROM anon, PUBLIC;
-- 0007/0037 precedent: the anon-intended catalog underlying stays
-- executable — the invoker wrapper delegates to it, so anon needs EXECUTE.
-- (Admin/management underlyings below stay fully revoked.)
GRANT EXECUTE ON FUNCTION politicore.plan_catalog_public() TO anon, authenticated;
REVOKE ALL ON FUNCTION politicore.plan_feature_catalog() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.plan_validate_limits(jsonb) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.plan_validate_features(jsonb) FROM anon, PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. SEED CATALOG (D5) — DATA, not logic. Clearly marked launch seeds;
--    prices are configuration the product can change (the phase report
--    documents these exact values). Money = integer minor units: NGN
--    amounts below are in KOBO (₦1 = 100 kobo). Monthly and annual are
--    independent rows (annual is never derived — §8). Trial D3 =
--    enabled, 14 days, on every launch plan. Custom domains are NOT
--    included during trial (trial parameter set at Phase 29 — noted).
-- ═══════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  v_starter      uuid;
  v_professional uuid;
  v_enterprise   uuid;
  v_version      politicore.plan_versions;
  v_actor        uuid := NULL;  -- seed context: platform event, no actor
BEGIN
  INSERT INTO politicore.plans (code, name, description, sort_order)
  VALUES
    ('starter',      'Starter',      'Essential services for small organizations getting started on PolitiCore.', 1),
    ('professional', 'Professional', 'The full service suite for growing organizations.', 2),
    ('enterprise',   'Enterprise',   'Every service with the highest limits for large organizations.', 3)
  ON CONFLICT (code) DO NOTHING;

  SELECT id INTO v_starter      FROM politicore.plans WHERE code = 'starter';
  SELECT id INTO v_professional FROM politicore.plans WHERE code = 'professional';
  SELECT id INTO v_enterprise   FROM politicore.plans WHERE code = 'enterprise';

  -- STARTER — social + campaign only.
  INSERT INTO politicore.plan_versions
    (plan_id, version, status, currency, included_modules,
     feature_entitlements, limits, trial_enabled, trial_days)
  VALUES
    (v_starter, 1, 'draft', 'NGN',
     ARRAY['social','campaign']::politicore.module_code_enum[],
     '{"governance_projects": false, "governance_participation": false, "governance_accountability": false, "custom_domains": false, "advanced_analytics": false}'::jsonb,
     '{"max_members": 25, "max_storage_bytes": 5368709120, "max_custom_domains": 0, "max_governance_requests": 0, "max_social_tasks": 100, "max_campaign_activities": 50, "max_election_records": 0, "max_notifications": 1000}'::jsonb,
     true, 14)
  RETURNING * INTO v_version;

  INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
  VALUES
    (v_version.id, 'NGN', 'monthly', 1500000),   -- ₦15,000.00 / month
    (v_version.id, 'NGN', 'annual', 15000000);   -- ₦150,000.00 / year

  -- PROFESSIONAL — all four modules.
  INSERT INTO politicore.plan_versions
    (plan_id, version, status, currency, included_modules,
     feature_entitlements, limits, trial_enabled, trial_days)
  VALUES
    (v_professional, 1, 'draft', 'NGN',
     ARRAY['social','campaign','election','governance']::politicore.module_code_enum[],
     '{"governance_projects": true, "governance_participation": true, "governance_accountability": true, "custom_domains": false, "advanced_analytics": true}'::jsonb,
     '{"max_members": 200, "max_storage_bytes": 53687091200, "max_custom_domains": 1, "max_governance_requests": 5000, "max_social_tasks": 2000, "max_campaign_activities": 2000, "max_election_records": 10000, "max_notifications": 50000}'::jsonb,
     true, 14)
  RETURNING * INTO v_version;

  INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
  VALUES
    (v_version.id, 'NGN', 'monthly', 5000000),   -- ₦50,000.00 / month
    (v_version.id, 'NGN', 'annual', 50000000);   -- ₦500,000.00 / year

  -- ENTERPRISE — all four modules; near-unlimited members/storage
  -- (limit nulls = unlimited arrive with Phase 29 consumption needs; the
  -- seed uses explicit large values so every limit is a concrete number).
  INSERT INTO politicore.plan_versions
    (plan_id, version, status, currency, included_modules,
     feature_entitlements, limits, trial_enabled, trial_days)
  VALUES
    (v_enterprise, 1, 'draft', 'NGN',
     ARRAY['social','campaign','election','governance']::politicore.module_code_enum[],
     '{"governance_projects": true, "governance_participation": true, "governance_accountability": true, "custom_domains": true, "advanced_analytics": true}'::jsonb,
     '{"max_members": 100000, "max_storage_bytes": 1099511627776, "max_custom_domains": 10, "max_governance_requests": 1000000, "max_social_tasks": 1000000, "max_campaign_activities": 1000000, "max_election_records": 1000000, "max_notifications": 1000000}'::jsonb,
     true, 14)
  RETURNING * INTO v_version;

  INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
  VALUES
    (v_version.id, 'NGN', 'monthly', 15000000),  -- ₦150,000.00 / month
    (v_version.id, 'NGN', 'annual', 150000000);  -- ₦1,500,000.00 / year

  -- Activate v1 of every launch plan so the catalog is live and the
  -- seed exercises the full lifecycle. The migration session has no JWT
  -- subject, so activation is a direct state transition (the SAME
  -- transition the RPC performs); the database immutability triggers
  -- enforce draft → active and one-active-per-plan exactly as for RPC
  -- callers. Audit rows carry a NULL actor — a platform seed event.
  FOR v_starter IN SELECT id FROM politicore.plans WHERE code IN ('starter','professional','enterprise') ORDER BY sort_order
  LOOP
    UPDATE politicore.plan_versions
       SET status = 'active', effective_from = now(), effective_to = NULL
     WHERE plan_id = v_starter AND version = 1 AND status = 'draft';

    INSERT INTO politicore.system_audits
      (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value, reason_notes)
    SELECT NULL, NULL, 'plan_version_activated', 'plan_versions', v.id::text,
           jsonb_build_object('status', 'draft'),
           jsonb_build_object('status', 'active', 'effective_from', to_jsonb(v.effective_from)),
           'launch catalog seed'
      FROM politicore.plan_versions v
     WHERE v.plan_id = v_starter AND v.version = 1;
  END LOOP;
END
$seed$;

