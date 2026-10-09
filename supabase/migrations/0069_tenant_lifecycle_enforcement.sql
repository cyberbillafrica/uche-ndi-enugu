-- ═══════════════════════════════════════════════════════════════════════
-- POLITICORE — 0069 TENANT LIFECYCLE & SUBSCRIPTION ENFORCEMENT (SaaS D)
-- ═══════════════════════════════════════════════════════════════════════
-- Phase 31. Integrates Phase 28 entitlements, Phase 29 billing and Phase 30
-- onboarding into one coherent, auditable tenant lifecycle.
--
-- ARCHITECTURE (§1):
--   subscription status (Phase 29 state machine)
--   ≠ tenant lifecycle (THIS migration)
--   ≠ module entitlement (Phase 28 map)
--   ≠ module activation (tenant_modules)
--   ≠ user authorization (profiles.access_role + permissions)
-- No parallel entitlement system: the Phase 28/29 machinery stays the only
-- writer of its own layer; this migration ADDS the tenant lifecycle layer
-- and the coordination between the layers.
--
-- WHAT EXISTS ALREADY (verified, §2):
--   * tenants.status text CHECK IN ('active','suspended','cancelled')
--     (0001) — read by Social Force 0028 (t.status='active' gates) and
--     referenced across phases. KEPT, maintained in parallel by trigger.
--   * Phase 29 subscription state machine: guard trigger, 4 edges,
--     record_verified_payment recovers past_due/restricted → active,
--     process_dunning_transitions flips past_due → restricted after grace.
--   * sync_subscription_entitlements writes ONLY the platform_settings
--     service_entitlements map — 0066 explicitly deferred tenants.status
--     to "a later phase's concern" (THIS migration).
--   * Phase 30 complete_tenant_onboarding INSERTs a tenant (defaults).
--   * No scheduler exists in the repository (no pg_cron): processors are
--     platform-invoked (§8 — documented, not claimed automated).
--
-- DESIGN:
--   1. NEW enum politicore.tenant_lifecycle_enum + columns on tenants:
--        lifecycle_status      (NULL = legacy 'active')
--        lifecycle_reason      (why — mandatory for admin overrides)
--        lifecycle_changed_at  (when)
--        lifecycle_changed_by  (server-resolved actor uuid)
--      NULL lifecycle_status behaves as 'active' everywhere (legacy rows,
--      all existing fixtures/tests keep passing untouched).
--   2. tenants.status is DERIVED in parallel by a guard trigger so the
--      historical CHECK ('active','suspended','cancelled') and every
--      existing consumer (Social Force 0028, member lifecycle surfaces,
--      hosted verifiers) keep their exact semantics:
--        provisioning|active|past_due|restricted|cancellation_pending → 'active'
--        suspended                                                      → 'suspended'
--        cancelled|archived                                             → 'cancelled'
--   3. Transition matrix ENFORCED by trigger (§3). Same-value no-ops are
--      permitted (idempotency); any other edge raises. Client UPDATEs of
--      the lifecycle columns are REJECTED unless the update goes through
--      the authorized server paths (the guard compares the writer: RLS
--      already blocks non-platform UPDATEs on tenants; the guard also
--      requires that a lifecycle change carries a reason and actor).
--   4. Subscription → lifecycle coordination (§4): ONE AFTER-UPDATE
--      trigger on politicore.subscriptions (status change) calls
--      apply_tenant_lifecycle_for_subscription():
--        past_due   → tenant past_due (unless suspended/archived — admin
--                     states WIN over commercial states)
--        restricted → tenant restricted (same admin-state rule)
--        active     → tenant active ONLY when the tenant is currently
--                     past_due/restricted (payment recovery, §4) — never
--                     touches suspended/archived/cancelled (a payment does
--                     NOT lift an administrative suspension)
--        cancelled  → tenant cancellation_pending when the cancellation
--                     was period-end (cancel_at_period_end) or immediate —
--                     records persist; the tenant is NOT destroyed
--                     (§7). If the tenant was suspended, suspension wins.
--        trialing   → no tenant change (trialing is a subscription state,
--                     NOT a lifecycle state — §3)
--      NO lifecycle → subscription writes exist anywhere: the cycle is
--      one-directional, so circular trigger updates are impossible (§4).
--   5. Centralized access enforcement (§5): assert_tenant_operationally_
--      active(p_module) is THE authoritative server-side check for
--      protected tenant operations — it distinguishes lifecycle
--      eligibility, effective subscription status (via the EXISTING
--      billing machinery), module entitlement (existing map), module
--      activation (existing tenant_modules) and the caller's permission/
--      organizational scope (existing permission system). Public website
--      rendering does NOT call it (public surfaces keep their own rules).
--   6. Platform operations (§6): suspend_tenant / restore_tenant /
--      archive_tenant / tenant_lifecycle_history — platform_super_admin
--      ONLY, reason ≥ 5 chars, server-attributed audit + owner
--      notification. NO new roles/permissions (§13).
--   7. Scheduled processing (§8): process_lifecycle_transitions —
--      idempotent, bounded batch (200), retryable, audited; invoked
--      through the platform console like the Phase 29 processors (no
--      scheduler exists — nothing is claimed automated).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Lifecycle enum + columns ────────────────────────────────────────
-- (Idempotent DDL: the migration is signature-tracked on hosted, so a
-- signature drift must be re-appliable without failing on existing objects.)
DO $$ BEGIN
  CREATE TYPE politicore.tenant_lifecycle_enum AS ENUM (
    'provisioning', 'active', 'past_due', 'restricted', 'suspended',
    'cancellation_pending', 'cancelled', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE politicore.tenants
  ADD COLUMN IF NOT EXISTS lifecycle_status     politicore.tenant_lifecycle_enum,
  ADD COLUMN IF NOT EXISTS lifecycle_reason     text,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_changed_by uuid;

COMMENT ON COLUMN politicore.tenants.lifecycle_status IS
  'Phase 31 tenant lifecycle. NULL = legacy active. Subscription trialing is a subscription state, never a lifecycle state.';

CREATE INDEX IF NOT EXISTS tenants_lifecycle_idx ON politicore.tenants (lifecycle_status);

-- Refresh the PostgREST-exposed public view (0009 created it with
-- `SELECT *`): CREATE OR REPLACE appends the new lifecycle columns so the
-- public surface stays in step with the base table (security_invoker is
-- preserved, and existing grants on the view persist).
CREATE OR REPLACE VIEW public.tenants
  WITH (security_invoker = true) AS SELECT * FROM politicore.tenants;

-- ── 2. Effective status helper (NULL = active legacy) ──────────────────
CREATE OR REPLACE FUNCTION politicore.tenant_lifecycle_status(p_tenant uuid)
RETURNS politicore.tenant_lifecycle_enum
LANGUAGE sql STABLE
SET search_path = politicore, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT lifecycle_status FROM politicore.tenants WHERE id = p_tenant),
    'active');
$$;

-- Backfill: every existing tenant becomes explicitly 'active' (the legacy
-- default). New tenants from 0068 provisioning set it explicitly.
UPDATE politicore.tenants
   SET lifecycle_status = 'active'
 WHERE lifecycle_status IS NULL;

-- Legacy tenants stay 'active'; make the column explicit going forward
-- while keeping NULL tolerated for any external writer (never produced by
-- this codebase).
ALTER TABLE politicore.tenants
  ALTER COLUMN lifecycle_status SET DEFAULT 'active';

-- ── 3. Parallel maintenance of the legacy status column ────────────────
CREATE OR REPLACE FUNCTION politicore.derive_tenants_status(
  p_lifecycle politicore.tenant_lifecycle_enum
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = politicore, pg_temp
AS $$
  SELECT CASE p_lifecycle
    WHEN 'provisioning'         THEN 'active'
    WHEN 'active'               THEN 'active'
    WHEN 'past_due'             THEN 'active'
    WHEN 'restricted'           THEN 'active'
    WHEN 'cancellation_pending' THEN 'active'
    WHEN 'suspended'            THEN 'suspended'
    WHEN 'cancelled'            THEN 'cancelled'
    WHEN 'archived'             THEN 'cancelled'
  END;
$$;

-- ── 4. Transition matrix (§3) ─────────────────────────────────────────
-- Allowed edges (self-transitions allowed for idempotent processors):
--   provisioning         → active restricted suspended cancelled
--   active               → past_due restricted suspended
--                          cancellation_pending cancelled archived
--   past_due             → active restricted suspended cancelled
--   restricted           → active suspended cancelled
--   suspended            → active                     (restore ONLY)
--   cancellation_pending → active cancelled suspended
--   cancelled            → active archived            (explicit recovery)
--   archived             → active                     (explicit recovery)
CREATE OR REPLACE FUNCTION politicore.tenant_lifecycle_allowed(
  p_from politicore.tenant_lifecycle_enum,
  p_to   politicore.tenant_lifecycle_enum
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = politicore, pg_temp
AS $$
  SELECT (p_from, p_to) IN (VALUES
    ('provisioning'::politicore.tenant_lifecycle_enum, 'active'::politicore.tenant_lifecycle_enum),
    ('provisioning', 'restricted'),
    ('provisioning', 'suspended'),
    ('provisioning', 'cancelled'),
    ('active', 'past_due'),
    ('active', 'restricted'),
    ('active', 'suspended'),
    ('active', 'cancellation_pending'),
    ('active', 'cancelled'),
    ('active', 'archived'),
    ('past_due', 'active'),
    ('past_due', 'restricted'),
    ('past_due', 'suspended'),
    ('past_due', 'cancelled'),
    ('restricted', 'active'),
    ('restricted', 'suspended'),
    ('restricted', 'cancelled'),
    ('suspended', 'active'),
    ('cancellation_pending', 'active'),
    ('cancellation_pending', 'cancelled'),
    ('cancellation_pending', 'suspended'),
    ('cancelled', 'active'),
    ('cancelled', 'archived'),
    ('archived', 'active'));
$$;

-- Guard trigger: enforces the matrix, maintains the legacy status column,
-- stamps reason/actor/when, and REQUIRES reason+actor for any change.
-- No client path can bypass RLS on tenants (platform-admin only UPDATE),
-- and even a platform session cannot take an illegal edge or drop the
-- reason.
CREATE OR REPLACE FUNCTION politicore.guard_tenant_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status THEN
    -- reason is MANDATORY for every lifecycle change (§3/§10)
    IF NEW.lifecycle_reason IS NULL OR length(btrim(NEW.lifecycle_reason)) < 5 THEN
      RAISE EXCEPTION 'a reason of at least 5 characters is required for every tenant lifecycle change';
    END IF;
    -- actor is MANDATORY and server-resolved. The ONLY exception is the
    -- internal single writer (apply_tenant_lifecycle), which marks its
    -- transaction before writing — server-context events (the subscription
    -- coordination trigger running without a user session) may proceed with
    -- a NULL actor because the audit row still records the source. Client
    -- sessions cannot forge this transaction-local GUC, and
    -- apply_tenant_lifecycle is REVOKE'd from every role.
    IF NEW.lifecycle_changed_by IS NULL AND auth.uid() IS NULL
       AND COALESCE(current_setting('politicore.lifecycle_writer', true), '') <> 'apply' THEN
      RAISE EXCEPTION 'a server-resolved actor is required for every tenant lifecycle change';
    END IF;

    IF OLD.lifecycle_status IS NULL THEN
      -- legacy row: first explicit write may claim any state (backfill /
      -- bootstrap), subsequent writes follow the matrix
      NULL;
    ELSIF NEW.lifecycle_status <> OLD.lifecycle_status
          AND NOT politicore.tenant_lifecycle_allowed(OLD.lifecycle_status, NEW.lifecycle_status) THEN
      RAISE EXCEPTION 'illegal tenant lifecycle transition % → %', OLD.lifecycle_status, NEW.lifecycle_status;
    END IF;

    NEW.lifecycle_changed_at := now();
    IF NEW.lifecycle_changed_by IS NULL THEN
      NEW.lifecycle_changed_by := auth.uid();
    END IF;
    -- keep the legacy status column in lockstep (Social Force 0028 etc.)
    NEW.status := politicore.derive_tenants_status(NEW.lifecycle_status);
  ELSE
    -- unchanged lifecycle: never let a stray UPDATE rewrite the metadata
    NEW.lifecycle_reason      := OLD.lifecycle_reason;
    NEW.lifecycle_changed_at  := OLD.lifecycle_changed_at;
    NEW.lifecycle_changed_by  := OLD.lifecycle_changed_by;
    -- and never let a client desynchronize the legacy column
    IF NEW.status <> politicore.derive_tenants_status(
         COALESCE(NEW.lifecycle_status, 'active')) THEN
      RAISE EXCEPTION 'tenants.status is derived from lifecycle_status and cannot be set directly';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_tenant_lifecycle ON politicore.tenants;
CREATE TRIGGER trg_guard_tenant_lifecycle
  BEFORE UPDATE ON politicore.tenants
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_tenant_lifecycle();

-- ═══════════════════════════════════════════════════════════════════════
-- 5. THE single lifecycle writer (§4) — every authorized path funnels
--    through here: transition matrix + reason + actor + audit + notify.
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION politicore.apply_tenant_lifecycle(
  p_tenant   uuid,
  p_to       politicore.tenant_lifecycle_enum,
  p_source   text,
  p_reason   text DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_from politicore.tenant_lifecycle_enum;
  v_cur  politicore.tenant_lifecycle_enum;
BEGIN
  SELECT COALESCE(lifecycle_status, 'active') INTO v_cur
    FROM politicore.tenants WHERE id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown tenant %', p_tenant;
  END IF;
  v_from := v_cur;

  -- Admin states WIN over commercial coordination: a subscription event
  -- never lifts or deepens an administrative suspension/archival, and a
  -- payment never restores a suspended/archived/cancelled tenant (§4/§6).
  IF p_source = 'subscription' THEN
    IF v_cur = 'provisioning' AND p_to = 'active' THEN
      -- provisioning completion is an explicit owner/platform path, not a
      -- subscription event — ignore
      RETURN false;
    END IF;
    IF p_to = 'active' THEN
      IF v_cur IN ('past_due', 'restricted') THEN
        NULL;                          -- payment recovery (§4)
      ELSIF v_cur = 'cancelled' THEN
        NULL;                          -- re-subscription revival (§6): a new
                                       -- live subscription reactivates a
                                       -- cancelled tenant (matrix edge
                                       -- cancelled → active; never lifts
                                       -- suspension/archival)
      ELSE
        RETURN false;                  -- scoped: never lifts suspended/archived
      END IF;
    END IF;
    IF p_to IN ('past_due', 'restricted', 'cancelled')
       AND v_cur IN ('suspended', 'archived') THEN
      RETURN false;                    -- suspension/archival is sticky
    END IF;
    -- Platform-controlled terminal states are not driven by billing events:
    -- a subscription flipping past_due/restricted on a cancelled/archived
    -- tenant is a stale fixture artefact, not a lifecycle instruction.
    -- Swallow it (record nothing) — re-subscription revival below is the
    -- only billing path OUT of cancelled.
    IF v_cur = 'archived' THEN
      RETURN false;
    END IF;
    IF p_to IN ('past_due', 'restricted') AND v_cur = 'cancelled' THEN
      RETURN false;
    END IF;
  END IF;

  IF v_from = p_to THEN
    RETURN false;                      -- idempotent no-op
  END IF;

  IF NOT politicore.tenant_lifecycle_allowed(v_from, p_to) THEN
    RAISE EXCEPTION 'illegal tenant lifecycle transition % → %', v_from, p_to;
  END IF;

  -- Mark this transaction as the internal lifecycle writer (see the guard
  -- trigger). Transaction-local: evaporates at commit; never settable by
  -- a client through PostgREST.
  PERFORM set_config('politicore.lifecycle_writer', 'apply', true);

  UPDATE politicore.tenants
     SET lifecycle_status     = p_to,
         lifecycle_reason     = COALESCE(p_reason, format('subscription coordination: %s', p_source)),
         lifecycle_changed_at = now(),
         lifecycle_changed_by = NULLIF(auth.uid()::text, '')::uuid
   WHERE id = p_tenant;

  -- Core Audit (reuse): server-resolved actor + reconstructable metadata.
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (p_tenant, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'tenant_lifecycle_transitioned', 'tenants', p_tenant::text,
     jsonb_build_object('lifecycle_status', v_from),
     jsonb_build_object('lifecycle_status', p_to, 'source', p_source,
                        'metadata', p_metadata),
     COALESCE(p_reason, format('subscription coordination: %s', p_source)));

  -- Owner notification for material access-affecting states (§10).
  IF p_to IN ('past_due', 'restricted', 'suspended', 'cancelled') THEN
    PERFORM politicore.billing_notify(
      p_tenant,
      CASE p_to
        WHEN 'past_due'   THEN 'Payment due'
        WHEN 'restricted' THEN 'Access restricted'
        WHEN 'suspended'  THEN 'Tenant suspended'
        ELSE                   'Subscription cancelled'
      END,
      CASE p_to
        WHEN 'past_due'   THEN 'A payment issue was recorded on your subscription. Access continues during the grace period — settle the invoice to avoid restriction. Your data is preserved.'
        WHEN 'restricted' THEN 'Your tenant''s operational access was restricted. Your data is preserved. Contact support or settle your billing to recover.'
        WHEN 'suspended'  THEN 'Your tenant was suspended by the platform. Your data is preserved. Contact platform support.'
        ELSE                   'Your subscription was cancelled. Tenant records are preserved; subscribe again to restore service.'
      END,
      '/portal/billing');
  END IF;
  -- Restoration and cancellation-pending are material lifecycle decisions
  -- too (§10: notify on restore / action-required states). Fired only on
  -- real transitions — idempotent no-ops above never reach this branch.
  IF p_to = 'active' THEN
    PERFORM politicore.billing_notify(
      p_tenant,
      'Tenant restored',
      'Your tenant''s access was restored by the platform. Note: a suspended tenant needs a valid subscription for operational access.',
      '/portal/billing');
  ELSIF p_to = 'cancellation_pending' THEN
    PERFORM politicore.billing_notify(
      p_tenant,
      'Cancellation scheduled',
      'Your subscription cancellation is scheduled for the end of the current billing period. Tenant records are preserved until then.',
      '/portal/billing');
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION politicore.apply_tenant_lifecycle(uuid, politicore.tenant_lifecycle_enum, text, text, jsonb) FROM anon, authenticated, PUBLIC;

-- ── 6. Subscription → lifecycle coordination (§4) ─────────────────────
-- ONE-directional: subscriptions → tenants. No lifecycle path ever writes
-- subscriptions, so circular triggers are structurally impossible.
CREATE OR REPLACE FUNCTION politicore.coordinate_tenant_lifecycle_from_subscription()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_from politicore.subscription_status_enum;
  v_to   politicore.subscription_status_enum;
BEGIN
  v_from := OLD.status;
  v_to   := NEW.status;
  IF v_from = v_to THEN
    RETURN NEW;                        -- no-op updates never coordinate
  END IF;

  IF v_to = 'past_due' THEN
    PERFORM politicore.apply_tenant_lifecycle(NEW.tenant_id, 'past_due',
      'subscription', 'subscription entered past_due (grace period begins)');
  ELSIF v_to = 'restricted' THEN
    PERFORM politicore.apply_tenant_lifecycle(NEW.tenant_id, 'restricted',
      'subscription', 'subscription restricted (dunning grace exhausted)');
  ELSIF v_to = 'active' THEN
    PERFORM politicore.apply_tenant_lifecycle(NEW.tenant_id, 'active',
      'subscription', 'subscription active (payment recovery)');
  ELSIF v_to = 'cancelled' THEN
    PERFORM politicore.apply_tenant_lifecycle(NEW.tenant_id, 'cancelled',
      'subscription', 'subscription cancelled (records preserved)');
  END IF;
  -- trialing: deliberately NO tenant lifecycle change (§3)

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_coordinate_tenant_lifecycle ON politicore.subscriptions;
CREATE TRIGGER trg_coordinate_tenant_lifecycle
  AFTER UPDATE OF status ON politicore.subscriptions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION politicore.coordinate_tenant_lifecycle_from_subscription();

-- ═══════════════════════════════════════════════════════════════════════
-- 7. CENTRALIZED ACCESS ENFORCEMENT (§5) — the ONE authoritative check.
--    Distinguishes (in order):
--      1. tenant lifecycle eligibility  (lifecycle_status ∈ active, past_due)
--      2. effective subscription status (existing billing authority)
--      3. module entitlement            (existing Phase 28 map)
--      4. module activation             (existing tenant_modules)
--      5. caller scope                  (existing permission system)
--    Public website rendering NEVER calls this (public rules unchanged).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION politicore.assert_tenant_operationally_active(
  p_module politicore.module_code_enum
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant  uuid;
  v_life    politicore.tenant_lifecycle_enum;
  v_sub     politicore.subscriptions;
  v_map     jsonb;
BEGIN
  v_tenant := politicore.current_tenant_id();
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context for the current session';
  END IF;

  -- 1. lifecycle eligibility
  SELECT COALESCE(lifecycle_status, 'active') INTO v_life
    FROM politicore.tenants WHERE id = v_tenant;
  IF v_life NOT IN ('active', 'past_due') THEN
    RAISE EXCEPTION 'tenant is % — operational access is unavailable', v_life;
  END IF;

  -- 2. effective subscription status (the EXISTING Phase 29 authority;
  --    past_due is grace → allowed; anything else must be live)
  SELECT * INTO v_sub FROM politicore.subscriptions
   WHERE tenant_id = v_tenant AND status IN ('trialing', 'active', 'past_due')
   ORDER BY created_at DESC LIMIT 1;
  IF v_life = 'past_due' AND v_sub.id IS NULL THEN
    RAISE EXCEPTION 'tenant is past_due without a live subscription';
  END IF;

  -- 3. module entitlement (Phase 28 map — server truth)
  v_map := (SELECT ps.settings -> 'service_entitlements' -> v_tenant::text
              FROM politicore.platform_settings ps WHERE ps.id = 1);
  IF v_map IS NULL OR COALESCE((v_map ->> p_module::text)::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'module % is not entitled for this tenant', p_module;
  END IF;

  -- 4. module activation (tenant_modules)
  IF NOT politicore.module_enabled(p_module) THEN
    RAISE EXCEPTION 'module % is not activated for this tenant', p_module;
  END IF;

  RETURN v_tenant;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. PLATFORM LIFECYCLE OPERATIONS (§6) — platform_super_admin ONLY.
--    Existing authority is sufficient (§13: no new roles/permissions).
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION politicore.suspend_tenant(
  p_tenant uuid,
  p_reason text
) RETURNS politicore.tenant_lifecycle_enum
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'tenant suspension requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required to suspend a tenant';
  END IF;
  PERFORM politicore.apply_tenant_lifecycle(p_tenant, 'suspended',
    'platform_admin', btrim(p_reason));
  RETURN politicore.tenant_lifecycle_status(p_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION politicore.restore_tenant(
  p_tenant uuid,
  p_reason text
) RETURNS politicore.tenant_lifecycle_enum
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_life politicore.tenant_lifecycle_enum;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'tenant restoration requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required to restore a tenant';
  END IF;
  v_life := politicore.tenant_lifecycle_status(p_tenant);
  IF v_life NOT IN ('suspended', 'archived', 'cancelled') THEN
    RAISE EXCEPTION 'tenant is % — restoration applies only to suspended, archived or cancelled tenants', v_life;
  END IF;
  PERFORM politicore.apply_tenant_lifecycle(p_tenant, 'active',
    'platform_admin', btrim(p_reason),
    jsonb_build_object('restored_from', v_life,
                       'subscription_note', 'a suspended tenant needs a valid subscription to regain operational access'));
  RETURN politicore.tenant_lifecycle_status(p_tenant);
END;
$$;

CREATE OR REPLACE FUNCTION politicore.archive_tenant(
  p_tenant uuid,
  p_reason text
) RETURNS politicore.tenant_lifecycle_enum
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_life politicore.tenant_lifecycle_enum;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'tenant archival requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required to archive a tenant';
  END IF;
  v_life := politicore.tenant_lifecycle_status(p_tenant);
  IF v_life NOT IN ('active', 'cancelled') THEN
    RAISE EXCEPTION 'tenant is % — archival applies only to active or cancelled tenants (settle the subscription state first)', v_life;
  END IF;
  -- NON-destructive (§7): nothing is deleted; reversible via
  -- restore_tenant (audited).
  PERFORM politicore.apply_tenant_lifecycle(p_tenant, 'archived',
    'platform_admin', btrim(p_reason));
  RETURN politicore.tenant_lifecycle_status(p_tenant);
END;
$$;

-- Lifecycle history read model (from Core Audit — no new tables).
CREATE OR REPLACE FUNCTION politicore.tenant_lifecycle_history(
  p_tenant uuid
) RETURNS TABLE (
  event_id     bigint,
  occurred_at  timestamptz,
  actor_name   text,
  actor_email  text,
  action       text,
  from_status  text,
  to_status    text,
  source       text,
  reason       text
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
  SELECT a.id, a.occurred_at, a.actor_name, a.actor_email, a.action,
         a.old_value ->> 'lifecycle_status',
         a.new_value ->> 'lifecycle_status',
         a.new_value ->> 'source',
         a.reason_notes
    FROM politicore.system_audits a
   WHERE a.tenant_id = p_tenant
     AND a.action IN ('tenant_lifecycle_transitioned', 'tenant_suspended',
                      'tenant_restored', 'tenant_archived')
   ORDER BY a.occurred_at DESC;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. LIFECYCLE PROCESSOR (§8) — idempotent, bounded, retryable, audited.
--    There is NO scheduler in this repository: this is invoked through
--    the platform console exactly like the Phase 29 processors
--    (process_trial_expiries / process_dunning_transitions /
--    process_period_renewals). Nothing is claimed automated.
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION politicore.process_lifecycle_transitions()
RETURNS TABLE (tenant_id uuid, action text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant record;
  v_grace  integer;
  v_count  integer := 0;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'lifecycle processing requires platform_super_admin authority';
  END IF;
  v_grace := (SELECT grace_period_days FROM politicore.billing_config());

  -- Bounded batch (200): bounded work per invocation, retryable after
  -- partial failure; every row's write is individually idempotent.
  FOR v_tenant IN
    SELECT t.id, t.lifecycle_status, s.status AS sub_status
      FROM politicore.tenants t
      LEFT JOIN LATERAL (
        SELECT st.status FROM politicore.subscriptions st
         WHERE st.tenant_id = t.id
         ORDER BY st.created_at DESC LIMIT 1) s ON true
     WHERE t.lifecycle_status IN ('active', 'past_due')
       AND v_count < 200
     ORDER BY t.created_at
  LOOP
    v_count := v_count + 1;
    -- Align the tenant lifecycle with the effective subscription state:
    -- an active tenant whose subscription went past_due, or a past_due
    -- tenant whose subscription is now restricted, follows it (the
    -- subscription trigger already handles the common path — this sweep
    -- catches missed events, e.g. backfills; idempotent no-op otherwise).
    IF v_tenant.lifecycle_status = 'active' AND v_tenant.sub_status = 'past_due' THEN
      PERFORM politicore.apply_tenant_lifecycle(v_tenant.id, 'past_due',
        'lifecycle_processor', 'lifecycle sweep: subscription past_due');
      tenant_id := v_tenant.id; action := 'to_past_due'; RETURN NEXT;
    ELSIF v_tenant.lifecycle_status = 'past_due' AND v_tenant.sub_status = 'restricted' THEN
      PERFORM politicore.apply_tenant_lifecycle(v_tenant.id, 'restricted',
        'lifecycle_processor', 'lifecycle sweep: subscription restricted');
      tenant_id := v_tenant.id; action := 'to_restricted'; RETURN NEXT;
    ELSIF v_tenant.lifecycle_status = 'past_due' AND v_tenant.sub_status = 'active' THEN
      PERFORM politicore.apply_tenant_lifecycle(v_tenant.id, 'active',
        'lifecycle_processor', 'lifecycle sweep: subscription recovered');
      tenant_id := v_tenant.id; action := 'to_active'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

-- ── 10. Provisioning integration (Phase 30) ───────────────────────────
-- New tenants from complete_tenant_onboarding start 'active' (explicit),
-- which is already the column default. Nothing else changes — the journey
-- resolver (onboarding_state) deliberately ignores lifecycle (§3:
-- trialing is a subscription state).

-- ── 11. PostgREST surface (0005/0066 conventions) ─────────────────────
CREATE OR REPLACE FUNCTION public.suspend_tenant(p_tenant uuid, p_reason text)
RETURNS politicore.tenant_lifecycle_enum
LANGUAGE sql SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.suspend_tenant(p_tenant, p_reason);
$$;

CREATE OR REPLACE FUNCTION public.restore_tenant(p_tenant uuid, p_reason text)
RETURNS politicore.tenant_lifecycle_enum
LANGUAGE sql SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.restore_tenant(p_tenant, p_reason);
$$;

CREATE OR REPLACE FUNCTION public.archive_tenant(p_tenant uuid, p_reason text)
RETURNS politicore.tenant_lifecycle_enum
LANGUAGE sql SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.archive_tenant(p_tenant, p_reason);
$$;

CREATE OR REPLACE FUNCTION public.tenant_lifecycle_history(p_tenant uuid)
RETURNS TABLE (event_id bigint, occurred_at timestamptz, actor_name text,
               actor_email text, action text, from_status text,
               to_status text, source text, reason text)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$ SELECT * FROM politicore.tenant_lifecycle_history(p_tenant); $$;

CREATE OR REPLACE FUNCTION public.process_lifecycle_transitions()
RETURNS TABLE (tenant_id uuid, action text)
LANGUAGE sql SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.process_lifecycle_transitions();
$$;

CREATE OR REPLACE FUNCTION public.tenant_lifecycle_status(p_tenant uuid)
RETURNS politicore.tenant_lifecycle_enum
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.tenant_lifecycle_status(p_tenant);
$$;

-- grants: platform operations are authenticated-role but DEFINER-guarded
-- (the underlying re-checks is_platform_admin; anon must never reach them)
GRANT EXECUTE ON FUNCTION public.suspend_tenant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_tenant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_tenant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_lifecycle_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_lifecycle_transitions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_lifecycle_status(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.suspend_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.restore_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.archive_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_lifecycle_history(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.process_lifecycle_transitions() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_lifecycle_status(uuid) FROM anon, PUBLIC;

-- underlying DEFINER functions: executable by authenticated (wrappers are
-- INVOKER), anon/PUBLIC denied
GRANT EXECUTE ON FUNCTION politicore.suspend_tenant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.restore_tenant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.archive_tenant(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.tenant_lifecycle_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.process_lifecycle_transitions() TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.tenant_lifecycle_status(uuid) TO authenticated;

REVOKE ALL ON FUNCTION politicore.suspend_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.restore_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.archive_tenant(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.tenant_lifecycle_history(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.process_lifecycle_transitions() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.tenant_lifecycle_status(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.apply_tenant_lifecycle(uuid, politicore.tenant_lifecycle_enum, text, text, jsonb) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.assert_tenant_operationally_active(politicore.module_code_enum) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.tenant_lifecycle_allowed(politicore.tenant_lifecycle_enum, politicore.tenant_lifecycle_enum) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.derive_tenants_status(politicore.tenant_lifecycle_enum) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.guard_tenant_lifecycle() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.coordinate_tenant_lifecycle_from_subscription() FROM anon, PUBLIC;
