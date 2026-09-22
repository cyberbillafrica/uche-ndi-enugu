/**
 * POLITICORE — Identity vertical slice (Phase 1B).
 *
 * The application-level identity context, built over Supabase Auth:
 *
 *   Supabase Auth user
 *     ↓ (profiles.id = auth.uid())
 *   PolitiCore profile
 *     ↓ (SECURITY DEFINER helpers + RLS)
 *   tenant · access_role · memberships · scopes · permissions
 *
 * Consumers ask for APPLICATION concepts (profile, tenant, permissions,
 * module access, loading) — never for Supabase- or Firebase-specific
 * objects. When the existing AuthContext adopts Supabase Auth (later
 * cutover phase), it should delegate here rather than scattering
 * supabase.auth.* calls through components.
 *
 * Authorization stays database-centric: every permission question is
 * answered by the database resolver via RPC (explicit deny wins,
 * hierarchical scope, module gating). The JWT carries only stable
 * identity context (tenant_id, access_role) per Phase 1B §9.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "./config";
import type { PolitiCoreProfile } from "./auth-compat";

export type AccessRole =
  | "member"
  | "election_officer"
  | "admin"
  | "tenant_super_admin"
  | "platform_super_admin";

export type MembershipType = "campaign_member" | "social_member";

export type ModuleCode = "social" | "campaign" | "election" | "governance";

export interface ScopeRef {
  position_name: string;
  scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state" | "campaign";
  scope_id: string;
}

export interface PolitiCoreIdentity {
  userId: string;
  email: string | null;
  profile: PolitiCoreProfile | null;
  tenantId: string | null;
  accessRole: AccessRole | null;
  memberships: MembershipType[];
  scopes: ScopeRef[];
  /** A profile exists — i.e. this identity is a tenant member. */
  isTenantMember: boolean;
}

/**
 * Resolve the full application identity for the current session.
 * Returns null for anonymous sessions. A Supabase Auth user WITHOUT a
 * profile (e.g. a future public participant) resolves with
 * profile=null / isTenantMember=false — authenticated but not a member,
 * per the member ≠ public-participant boundary.
 */
export async function resolveIdentity(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<PolitiCoreIdentity | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return null;

  // public.politicore_profiles is the security_invoker view over
  // politicore.profiles (0009) — the hosted data API exposes public only.
  const { data: profile, error } = await supabase
    .from("politicore_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (error) throw new Error(`identity: profile lookup failed: ${error.message}`);

  if (!profile) {
    return {
      userId: user.id,
      email: user.email ?? null,
      profile: null,
      tenantId: null,
      accessRole: null,
      memberships: [],
      scopes: [],
      isTenantMember: false,
    };
  }

  const p = profile as PolitiCoreProfile & { membership_types: MembershipType[] };
  const [{ data: tenantId }, { data: scopes }] = await Promise.all([
    supabase.rpc("my_tenant_id"),
    supabase.rpc("my_scopes_rpc"),
  ]);

  return {
    userId: user.id,
    email: p.email,
    profile: p,
    tenantId: (tenantId as string) ?? p.tenant_id,
    accessRole: p.access_role,
    memberships: p.membership_types ?? [],
    scopes: (scopes as ScopeRef[]) ?? [],
    isTenantMember: true,
  };
}

/** Permission question answered by the database resolver (fails closed). */
export async function hasPermission(
  permission: string,
  scope?: { scopeType: string; scopeId: string },
  supabase: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  const { data, error } = await supabase.rpc("politicore_has_permission", {
    p_permission: permission,
    p_scope_type: (scope?.scopeType as never) ?? null,
    p_scope_id: scope?.scopeId ?? null,
  });
  if (error) return false;
  return Boolean(data);
}

/** Tenant-level module activation check (NOT an authorization answer). */
export async function isModuleEnabled(
  module: ModuleCode,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_module_enabled", { m: module });
  if (error) return false; // fail closed
  return Boolean(data);
}

/**
 * Sign out of Supabase Auth. (The existing Firebase AuthContext keeps
 * running its own session until the cutover phase.)
 */
export async function signOutSupabase(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  await supabase.auth.signOut();
}

export { isSupabaseConfigured };
