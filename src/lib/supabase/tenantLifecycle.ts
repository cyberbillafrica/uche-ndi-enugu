/**
 * POLITICORE — Tenant Lifecycle service (Phase 31, SaaS D).
 *
 * Typed browser surface over the Phase 31 lifecycle RPCs. This service
 * owns NO security and NO authority: every operation delegates to the
 * SECURITY DEFINER RPCs, which re-verify platform_super_admin authority
 * server-side and resolve the actor/tenant/reason server-side.
 *
 * Architecture principle (§1): subscription status, tenant lifecycle,
 * module entitlement, module activation and user authorization are
 * DISTINCT concepts. This surface only exposes lifecycle facts and
 * platform operations — it never mutates subscriptions, entitlements or
 * roles.
 */
import { getSupabaseClient } from "./config";

/* ── enumerations (mirror the DB enums) ─────────────────────────────── */

export type TenantLifecycleStatus =
  | "provisioning"
  | "active"
  | "past_due"
  | "restricted"
  | "suspended"
  | "cancellation_pending"
  | "cancelled"
  | "archived";

export const TENANT_LIFECYCLE_LABELS: Record<TenantLifecycleStatus, string> = {
  provisioning: "Provisioning",
  active: "Active",
  past_due: "Payment due (grace)",
  restricted: "Restricted",
  suspended: "Suspended",
  cancellation_pending: "Cancellation pending",
  cancelled: "Cancelled",
  archived: "Archived",
};

/** Lifecycle states in which protected tenant operations are permitted. */
export const OPERATIONAL_LIFECYCLE_STATES: TenantLifecycleStatus[] = [
  "active",
  "past_due",
];

export interface LifecycleHistoryRow {
  event_id: number;
  occurred_at: string;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  from_status: string | null;
  to_status: string | null;
  source: string | null;
  reason: string | null;
}

export interface LifecycleStatusRow {
  lifecycle_status: TenantLifecycleStatus;
}

/* ── platform operations (platform_super_admin authority server-side) ── */

/** Suspend a tenant (administrative — NOT lifted by payment). */
export async function suspendTenant(tenantId: string, reason: string): Promise<TenantLifecycleStatus> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("suspend_tenant", {
    p_tenant: tenantId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data as TenantLifecycleStatus;
}

/** Restore a suspended/archived/cancelled tenant (explicit, audited). */
export async function restoreTenant(tenantId: string, reason: string): Promise<TenantLifecycleStatus> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("restore_tenant", {
    p_tenant: tenantId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data as TenantLifecycleStatus;
}

/** Archive a tenant (non-destructive, reversible — §7). */
export async function archiveTenant(tenantId: string, reason: string): Promise<TenantLifecycleStatus> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("archive_tenant", {
    p_tenant: tenantId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
  return data as TenantLifecycleStatus;
}

/* ── read models ────────────────────────────────────────────────────── */

/** Lifecycle history for a tenant (Core Audit–backed, no new tables). */
export async function getTenantLifecycleHistory(tenantId: string): Promise<LifecycleHistoryRow[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("tenant_lifecycle_history", { p_tenant: tenantId });
  if (error) throw new Error(error.message);
  return (data ?? []) as LifecycleHistoryRow[];
}

/** Current lifecycle status of a tenant. */
export async function getTenantLifecycleStatus(tenantId: string): Promise<TenantLifecycleStatus> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("tenant_lifecycle_status", { p_tenant: tenantId });
  if (error) throw new Error(error.message);
  return data as TenantLifecycleStatus;
}

/**
 * Lifecycle processor sweep (§8). The repository has NO scheduler — this
 * is invoked from the platform console exactly like the Phase 29
 * processors. Idempotent; bounded batch (200) per invocation.
 */
export async function runLifecycleTransitions(): Promise<{ tenant_id: string; action: string }[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("process_lifecycle_transitions");
  if (error) throw new Error(error.message);
  return (data ?? []) as { tenant_id: string; action: string }[];
}
