/**
 * POLITICORE — Supabase Auth → PolitiCore identity compatibility layer.
 *
 * Preserves the existing application identity model:
 *   Supabase Auth user → politicore.profiles row → tenant/roles/permissions.
 *
 * Native Supabase Auth is the canonical identity surface (Core Identity
 * Phase 1); this compatibility layer serves profile-shaped reads for
 * access/identity resolution.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface PolitiCoreProfile {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  access_role: "member" | "election_officer" | "admin" | "tenant_super_admin" | "platform_super_admin";
  membership_types: ("campaign_member" | "social_member")[];
  lifecycle_status: "active" | "suspended" | "deactivated";
  points: number;
  rank: string;
  ward_id: string | null;
  lga_id: string | null;
  polling_unit_id: string | null;
}

/** Load the PolitiCore profile for the current Supabase session user. */
export async function fetchProfile(
  supabase: SupabaseClient
): Promise<PolitiCoreProfile | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return null;

  // public.politicore_profiles is the security_invoker view over
  // politicore.profiles (migration 0009): the hosted data API exposes
  // the public schema only, and the view applies the same RLS.
  const { data, error } = await supabase
    .from("politicore_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;
  return data as PolitiCoreProfile;
}

/** Permission check that delegates entirely to the database resolver (RPC). */
export async function checkPermission(
  supabase: SupabaseClient,
  permission: string,
  scope?: { scope_type: string; scope_id: string }
): Promise<boolean> {
  const { data, error } = await supabase.rpc("politicore_has_permission", {
    p_permission: permission,
    p_scope_type: scope?.scope_type ?? null,
    p_scope_id: scope?.scope_id ?? null,
  });
  if (error) return false; // fail closed
  return Boolean(data);
}
