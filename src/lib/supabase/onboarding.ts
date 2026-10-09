/**
 * POLITICORE — Self-Service Tenant Onboarding service (Phase 30, SaaS C).
 *
 * Typed browser surface over the Phase 30 RPCs. This service owns NO
 * security and NO authority: every operation delegates to the SECURITY
 * DEFINER RPCs (identity/tenant/ownership resolved server-side; slug
 * authority is the database). The browser supplies only wishes — the
 * server resolves the facts:
 *
 *   * plan selection = a plan CODE; the RPC resolves the ACTIVE version,
 *     the price for the interval, the currency and the trial config
 *   * tenant identity = the session's own (bare) auth identity; the RPC
 *     writes the owner profile — never a client-suggested role
 *   * resume state = onboarding_state(), resolved from the session and
 *     the database — NEVER from localStorage, query params or client
 *     flags (§11)
 *
 * The public pricing surface uses Phase 28's identity-free catalog
 * (plan_catalog_public — no version ids); the owner-only subscribe
 * catalog (subscription_plans) stays the owner surface as in Phase 29.
 */
import { getSupabaseClient } from "./config";
import type { BillingInterval } from "./billing"; // single canonical definition (barrel rule)

/* ── enumerations (mirror the DB enums) ─────────────────────────────── */

export type OnboardingStage =
  | "signin"
  | "create_tenant"
  | "enter_app"
  | "existing_tenant";

/* ── slug availability (§6 — server-authoritative) ──────────────────── */

export interface SlugAvailability {
  slug: string;
  available: boolean;
  /** reserved | taken | available | invalid: <message> */
  reason: string;
}

/**
 * Server-side availability check. Client-side mirrors are UX only — the
 * provisioning RPC re-validates and the 0001 UNIQUE constraint is the
 * concurrency backstop.
 */
export async function checkTenantSlugAvailability(rawSlug: string): Promise<SlugAvailability> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("tenant_slug_available", { p_slug: rawSlug });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Record<string, unknown>[]);
  if (rows.length === 0) throw new Error("slug availability check returned no result");
  return {
    slug: String(rows[0].slug),
    available: Boolean(rows[0].available),
    reason: String(rows[0].reason),
  };
}

/* ── provisioning (§5 — one server-side transaction) ────────────────── */

export interface CompleteOnboardingInput {
  tenantSlug: string;
  tenantName: string;
  ownerName?: string;
  /** PUBLIC plan code from the pricing page (never a version id). */
  planCode: string;
  billingInterval: BillingInterval;
}

export interface OnboardingResult {
  tenantId: string;
  tenantSlug: string;
  subscriptionId: string;
  subscriptionStatus: "trialing" | "active" | "past_due" | "restricted" | "cancelled";
  trialEnd: string | null;
  nextStep: string;
}

/**
 * Complete the self-service journey in ONE authoritative server-side
 * operation: tenant + module defaults + default configuration + owner
 * profile (tenant_super_admin) + subscription/trial + entitlement sync +
 * audit. Failure at any step rolls back the whole journey.
 */
export async function completeTenantOnboarding(input: CompleteOnboardingInput): Promise<OnboardingResult> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("complete_tenant_onboarding", {
    p_tenant_slug: input.tenantSlug,
    p_tenant_name: input.tenantName,
    p_owner_name: input.ownerName ?? null,
    p_plan_code: input.planCode,
    p_billing_interval: input.billingInterval,
  });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Record<string, unknown>[]);
  if (rows.length === 0) throw new Error("onboarding returned no result");
  const r = rows[0];
  return {
    tenantId: String(r.tenant_id),
    tenantSlug: String(r.tenant_slug),
    subscriptionId: String(r.subscription_id),
    subscriptionStatus: r.subscription_status as OnboardingResult["subscriptionStatus"],
    trialEnd: (r.trial_end as string | null) ?? null,
    nextStep: String(r.next_step),
  };
}

/* ── resume state (§11 — server-resolved, never client flags) ───────── */

export interface OnboardingStateRow {
  stage: OnboardingStage;
  tenantId: string | null;
  tenantSlug: string | null;
  tenantName: string | null;
  accessRole: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  planCode: string | null;
  billingInterval: string | null;
  trialEnd: string | null;
  nextStep: string;
}

/** Resolve the user's actual journey position from session + database. */
export async function getOnboardingState(): Promise<OnboardingStateRow | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("onboarding_state");
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Record<string, unknown>[]);
  if (rows.length === 0) return null; // no session client-side
  const r = rows[0];
  return {
    stage: r.stage as OnboardingStage,
    tenantId: r.tenant_id ? String(r.tenant_id) : null,
    tenantSlug: r.tenant_slug ? String(r.tenant_slug) : null,
    tenantName: r.tenant_name ? String(r.tenant_name) : null,
    accessRole: r.access_role ? String(r.access_role) : null,
    subscriptionId: r.subscription_id ? String(r.subscription_id) : null,
    subscriptionStatus: r.subscription_status ? String(r.subscription_status) : null,
    planCode: r.plan_code ? String(r.plan_code) : null,
    billingInterval: r.billing_interval ? String(r.billing_interval) : null,
    trialEnd: (r.trial_end as string | null) ?? null,
    nextStep: String(r.next_step ?? ""),
  };
}
