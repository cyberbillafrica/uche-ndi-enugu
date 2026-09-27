/**
 * POLITICORE — Canonical Member Directory service (Core Identity).
 *
 * The single Supabase data source for the Member Directory. Reads flow
 * through public.politicore_profiles (the 0009 security_invoker view over
 * politicore.profiles) so the database — not the service layer — decides
 * visibility: 0002 profiles_read grants self + same-tenant members
 * (tenant admins get the tenant-wide directory, members see their tenant
 * directory per the same canonical policy that backs AuthContext).
 *
 * The lifecycle write is a server-side authority operation
 * (politicore.admin_set_member_lifecycle, 0032) mirroring the 0031
 * enrichment contract: actor and tenant are server-resolved, non-admins
 * fail closed, and the write lands in system_audits through the 0002
 * audit trigger. The 0027-narrowed view stays SELECT-only; no client
 * profile writes exist.
 *
 * No Firebase. No dual read. No parallel member model.
 */

import { getSupabaseClient } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Directory row shape — the canonical profile surface consumers need. */
export interface DirectoryMember {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
  access_role: string;
  membership_types: string[];
  lifecycle_status: "active" | "suspended" | "deactivated";
  status_reason: string | null;
  points: number;
  rank: string;
  created_at: string;
}

/** Options for admin lifecycle changes (reason notes travel to the audit). */
export interface MemberLifecycleUpdate {
  memberId: string;
  lifecycleStatus: "active" | "suspended" | "deactivated";
  statusReason?: string | null;
}

/**
 * List the directory visible to the current session.
 *
 * RLS (0002 profiles_read) is the authority: self + same-tenant members.
 * The service never filters by client-supplied tenant ids and never
 * widens the result beyond what the database returns.
 */
export async function listMembers(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<DirectoryMember[]> {
  const { data, error } = await supabase
    .from("politicore_profiles")
    .select(
      "id, email, full_name, phone, lga_id, ward_id, polling_unit_id, access_role, membership_types, lifecycle_status, status_reason, points, rank, created_at"
    )
    .order("full_name", { ascending: true });

  if (error) throw new Error(`members: listMembers failed: ${error.message}`);
  return (data ?? []) as DirectoryMember[];
}

/**
 * Admin lifecycle change (suspend / deactivate / reactivate) through the
 * 0032 authority RPC. Returns the updated member's profile id; rejects
 * with the server's fail-closed error for non-admin or cross-tenant
 * targets. The write is audited server-side (0002 trg_audit_profiles).
 */
export async function setMemberLifecycle(
  update: MemberLifecycleUpdate,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<string> {
  const { data, error } = await supabase.rpc("admin_set_member_lifecycle", {
    p_profile_id: update.memberId,
    p_lifecycle_status: update.lifecycleStatus,
    p_status_reason: update.statusReason ?? null,
  });

  if (error) throw new Error(`members: setMemberLifecycle failed: ${error.message}`);
  return data as string;
}
