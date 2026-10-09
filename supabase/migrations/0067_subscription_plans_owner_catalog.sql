-- ═══════════════════════════════════════════════════════════════════════
-- 0067 — SUBSCRIPTION PLANS OWNER CATALOG (Phase 29 addendum)
-- ═══════════════════════════════════════════════════════════════════════
-- The owner billing surface (§26) must be able to START a subscription, and
-- create_subscription takes a plan_version_id. The anonymous catalog
-- (plan_catalog_public, 0065) deliberately omits version ids; this
-- owner-scoped read model closes that gap WITHOUT widening the anon
-- surface: identical authority to create_subscription itself (tenant owner
-- or platform_super_admin), ACTIVE versions only, committed prices only.
--
-- Read-only. No tables are touched by writes; no new roles, modules,
-- permissions, or enum values. Direct-table SELECT grants are unchanged.

CREATE OR REPLACE FUNCTION politicore.subscription_plans()
RETURNS TABLE (
  plan_version_id      uuid,
  plan_code            text,
  plan_name            text,
  description          text,
  sort_order           integer,
  version              integer,
  currency             text,
  included_modules     politicore.module_code_enum[],
  feature_entitlements jsonb,
  limits               jsonb,
  trial_enabled        boolean,
  trial_days           integer,
  prices               jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
  SELECT v.id, p.code, p.name, p.description, p.sort_order,
         v.version, v.currency, v.included_modules,
         v.feature_entitlements, v.limits, v.trial_enabled, v.trial_days,
         COALESCE((SELECT jsonb_object_agg(pr.billing_interval, pr.amount_minor)
                     FROM politicore.plan_version_prices pr
                    WHERE pr.plan_version_id = v.id), '{}'::jsonb)
    FROM politicore.plan_versions v
    JOIN politicore.plans p ON p.id = v.plan_id
   WHERE p.is_active AND v.status = 'active'
   ORDER BY p.sort_order, p.code, v.version DESC;
$$;

-- Public wrapper (0065/0066 PostgREST convention): SECURITY INVOKER so the
-- caller's own authority applies; rows are filtered to the SAME authority
-- that may create subscriptions — owners and platform admins. Everyone
-- else (anon, member, admin, election_officer) gets an empty map.
CREATE OR REPLACE FUNCTION public.subscription_plans()
RETURNS TABLE (
  plan_version_id      uuid,
  plan_code            text,
  plan_name            text,
  description          text,
  sort_order           integer,
  version              integer,
  currency             text,
  included_modules     politicore.module_code_enum[],
  feature_entitlements jsonb,
  limits               jsonb,
  trial_enabled        boolean,
  trial_days           integer,
  prices               jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.subscription_plans()
   WHERE politicore.current_access_role() IN ('tenant_super_admin', 'platform_super_admin')
      OR politicore.is_platform_admin() IS TRUE;
$$;

GRANT EXECUTE ON FUNCTION politicore.subscription_plans() TO authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_plans() TO authenticated;
REVOKE ALL ON FUNCTION public.subscription_plans() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.subscription_plans() FROM anon, PUBLIC;
