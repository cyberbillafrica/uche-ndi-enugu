/**
 * POLITICORE — Canonical system audit-log service (Phase 4).
 *
 * The admin audit-log page previously read Firestore system_audits; the
 * server-side audit trail has lived in politicore.system_audits since the
 * Campaign gate (0002 audit trigger). This service exposes the tenant-
 * scoped read through the public.system_audit_logs security_invoker view
 * (0033): RLS (audits_read) returns the caller's tenant rows only.
 */

import { getSupabaseClient } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditResource =
  | "profiles"
  | "permission_grants"
  | "organizational_assignments"
  | "tenants"
  | "tenant_modules"
  | "elections"
  | "social"
  | "campaign"
  | string;

export interface SystemAuditLog {
  id: number;
  tenant_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  affected_resource: string;
  resource_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason_notes: string | null;
  organizational_scope: string | null;
  occurred_at: string;
}

/** Tenant-scoped audit trail (RLS: audits_read — same tenant or platform). */
export async function getSystemAuditLogs(
  resourceFilter?: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<SystemAuditLog[]> {
  let q = supabase
    .from("system_audit_logs")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(500);
  if (resourceFilter) q = q.eq("affected_resource", resourceFilter);
  const { data, error } = await q;
  if (error) throw new Error(`audit: getSystemAuditLogs failed: ${error.message}`);
  return (data ?? []) as SystemAuditLog[];
}
