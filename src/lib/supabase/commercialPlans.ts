/**
 * POLITICORE — Commercial Plans & Entitlements service (Phase 28, SaaS A).
 *
 * Typed browser surface over the Phase 28 RPCs. This service owns NO
 * security: every operation delegates authority to the SECURITY DEFINER
 * RPCs (platform-admin-only, server-resolved identity, Core-Audit-logged).
 * The client never sends tenant or actor identity into an authority
 * position, never mutates plans/plan_versions/plan_version_prices or
 * platform_settings directly, and never widens a query beyond what the
 * RPC returns.
 *
 * Scope guard (Phase 28): plans, versions, prices, entitlement SYNC.
 * Subscriptions/checkout/payments belong to Phase 29+ and are deliberately
 * absent here.
 */
import { getSupabaseClient } from "./config";

/** The four first-class business modules — exactly `module_code_enum`. */
export type PlanModule = "social" | "campaign" | "election" | "governance";

export const PLAN_MODULE_LABELS: Record<PlanModule, string> = {
  social: "Social Force",
  campaign: "Campaign",
  election: "Election",
  governance: "Governance",
};

export type PlanVersionStatus = "draft" | "active" | "retired";

/** Allowlisted feature entitlements (§10) — mirrors plan_feature_catalog(). */
export type PlanFeatureKey =
  | "governance_projects"
  | "governance_participation"
  | "governance_accountability"
  | "custom_domains"
  | "advanced_analytics";

/** Allowlisted limit keys (§11) — JSON null means unlimited (never 0). */
export type PlanLimitKey =
  | "max_members"
  | "max_storage_bytes"
  | "max_custom_domains"
  | "max_governance_requests"
  | "max_social_tasks"
  | "max_campaign_activities"
  | "max_election_records"
  | "max_notifications";

/** Prices are independent integer minor-unit rows keyed by interval (§8). */
export interface PlanPrices {
  monthly?: number;
  annual?: number;
}

export interface PlanCatalogVersionRow {
  plan_id: string;
  plan_code: string;
  plan_name: string;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  version_id: string;
  version: number;
  status: PlanVersionStatus;
  currency: string;
  included_modules: PlanModule[];
  feature_entitlements: Partial<Record<PlanFeatureKey, boolean>>;
  limits: Partial<Record<PlanLimitKey, number | null>>;
  trial_enabled: boolean;
  trial_days: number;
  effective_from: string | null;
  effective_to: string | null;
  prices: PlanPrices;
}

export interface PlanCatalogPublicRow {
  plan_code: string;
  plan_name: string;
  description: string | null;
  sort_order: number;
  version: number;
  currency: string;
  included_modules: PlanModule[];
  feature_entitlements: Partial<Record<PlanFeatureKey, boolean>>;
  trial_enabled: boolean;
  trial_days: number;
  prices: PlanPrices;
}

export interface EntitlementSyncRow {
  module: PlanModule;
  entitled: boolean;
}

function toPlanCatalogVersionRow(r: Record<string, unknown>): PlanCatalogVersionRow {
  return {
    plan_id: String(r.plan_id),
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    description: (r.description as string | null) ?? null,
    is_active: Boolean(r.is_active),
    sort_order: Number(r.sort_order ?? 0),
    version_id: String(r.version_id),
    version: Number(r.version ?? 0),
    status: r.status as PlanVersionStatus,
    currency: String(r.currency),
    included_modules: (r.included_modules as PlanModule[]) ?? [],
    feature_entitlements: (r.feature_entitlements as PlanCatalogVersionRow["feature_entitlements"]) ?? {},
    limits: (r.limits as PlanCatalogVersionRow["limits"]) ?? {},
    trial_enabled: Boolean(r.trial_enabled),
    trial_days: Number(r.trial_days ?? 0),
    effective_from: (r.effective_from as string | null) ?? null,
    effective_to: (r.effective_to as string | null) ?? null,
    prices: (r.prices as PlanPrices) ?? {},
  };
}

function toPlanCatalogPublicRow(r: Record<string, unknown>): PlanCatalogPublicRow {
  return {
    plan_code: String(r.plan_code),
    plan_name: String(r.plan_name),
    description: (r.description as string | null) ?? null,
    sort_order: Number(r.sort_order ?? 0),
    version: Number(r.version ?? 0),
    currency: String(r.currency),
    included_modules: (r.included_modules as PlanModule[]) ?? [],
    feature_entitlements:
      (r.feature_entitlements as PlanCatalogPublicRow["feature_entitlements"]) ?? {},
    trial_enabled: Boolean(r.trial_enabled),
    trial_days: Number(r.trial_days ?? 0),
    prices: (r.prices as PlanPrices) ?? {},
  };
}

/** Platform-admin catalog: every plan and every version, any status. */
export async function getPlanCatalogAdmin(): Promise<PlanCatalogVersionRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("plan_catalog_admin");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => toPlanCatalogVersionRow(r));
}

/** Public catalog: ACTIVE versions only — the anonymous commercial surface. */
export async function getPlanCatalogPublic(): Promise<PlanCatalogPublicRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("plan_catalog_public");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => toPlanCatalogPublicRow(r));
}

/** Create a plan identity. Returns the new plan id. */
export async function createPlan(input: {
  code: string;
  name: string;
  description?: string | null;
  sortOrder?: number;
  reason?: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("create_plan", {
    p_code: input.code,
    p_name: input.name,
    p_description: input.description ?? null,
    p_sort_order: input.sortOrder ?? 0,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/** Create a DRAFT plan version. Returns the new version id. */
export async function createPlanVersion(input: {
  planId: string;
  includedModules: PlanModule[];
  featureEntitlements: Partial<Record<PlanFeatureKey, boolean>>;
  limits: Partial<Record<PlanLimitKey, number | null>>;
  currency: string;
  trialEnabled: boolean;
  trialDays: number;
  prices: PlanPrices;
  reason?: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("create_plan_version", {
    p_plan_id: input.planId,
    p_included_modules: input.includedModules,
    p_feature_entitlements: input.featureEntitlements,
    p_limits: input.limits,
    p_currency: input.currency,
    p_trial_enabled: input.trialEnabled,
    p_trial_days: input.trialDays,
    p_prices: input.prices,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/**
 * Edit a DRAFT version (null fields are left unchanged server-side).
 * Returns the version id. Active/retired versions reject edits.
 */
export async function updatePlanVersionDraft(input: {
  planVersionId: string;
  includedModules?: PlanModule[] | null;
  featureEntitlements?: Partial<Record<PlanFeatureKey, boolean>> | null;
  limits?: Partial<Record<PlanLimitKey, number | null>> | null;
  trialEnabled?: boolean | null;
  trialDays?: number | null;
  prices?: PlanPrices | null;
  reason?: string | null;
}): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("update_plan_version_draft", {
    p_plan_version_id: input.planVersionId,
    p_included_modules: input.includedModules ?? null,
    p_feature_entitlements: input.featureEntitlements ?? null,
    p_limits: input.limits ?? null,
    p_trial_enabled: input.trialEnabled ?? null,
    p_trial_days: input.trialDays ?? null,
    p_prices: input.prices ?? null,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/** draft → active (requires ≥1 price; closes any previous active window). */
export async function activatePlanVersion(planVersionId: string, reason?: string | null): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("activate_plan_version", {
    p_plan_version_id: planVersionId,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/** active → retired (window end stamped server-side; immutable after). */
export async function retirePlanVersion(planVersionId: string, reason?: string | null): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("retire_plan_version", {
    p_plan_version_id: planVersionId,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

/**
 * Synchronize a tenant's commercial entitlements from a plan's ACTIVE
 * version into the EXISTING platform_settings.service_entitlements map
 * (the authoritative writer). Tenant is the only argument the caller
 * supplies — plan resolution, authority and audit are all server-side.
 */
export async function syncTenantEntitlements(
  tenantId: string,
  planCode: string,
  reason?: string | null
): Promise<EntitlementSyncRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("sync_tenant_entitlements", {
    p_tenant: tenantId,
    p_plan_code: planCode,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    module: r.module as PlanModule,
    entitled: Boolean(r.entitled),
  }));
}
