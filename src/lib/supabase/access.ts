/**
 * POLITICORE — Campaign access gate (Campaign Phase B, Architecture Gate §15).
 *
 * Same fail-closed pattern as the Election gate below: the route-level
 * check is UX/defense-in-depth; the RPCs, view RLS, and policies remain
 * the authoritative boundary. Campaign-specifics:
 *   - module = 'campaign';
 *   - admin/tenant-super-admin → tenant-wide authority;
 *   - otherwise any DATABASE-resolved campaign permission (view/create/
 *     manage activity, view/create assignment, submit/review field report,
 *     report/manage issue) grants scoped authority;
 *   - plain campaign members (no permission) are admitted at authority
 *     "member" (they see their own records and may RSVP/join), while
 *     social-only accounts are denied absolutely.
 */
export type CampaignAuthority = "admin" | "scoped" | "member" | "none";

export interface CampaignAccess {
  allowed: boolean;
  reason:
    | "unauthenticated"
    | "not_a_member"
    | "module_disabled"
    | "social_only"
    | "no_campaign_authority"
    | null;
  authority: CampaignAuthority;
  /** True when the caller holds tenant-wide authority (admin). */
  tenantWide: boolean;
}

export async function resolveCampaignAccess(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<CampaignAccess> {
  const identity = await resolveIdentity(supabase);
  const denied = (
    reason: Exclude<CampaignAccess["reason"], null>,
    authority: CampaignAuthority = "none"
  ): CampaignAccess => ({ allowed: false, reason, authority, tenantWide: false });

  if (!identity) return denied("unauthenticated");
  if (!identity.isTenantMember) return denied("not_a_member");

  const { isModuleEnabled } = await import("./identity");
  const moduleEnabled = await isModuleEnabled("campaign", supabase);
  if (!moduleEnabled) return denied("module_disabled");

  if (isSocialOnlyFrom(identity)) return denied("social_only");

  const adminRoles = ["admin", "tenant_super_admin", "platform_super_admin"];
  if (adminRoles.includes(identity.accessRole ?? "")) {
    return { allowed: true, reason: null, authority: "admin", tenantWide: true };
  }

  const { hasPermission } = await import("./identity");
  const flags = await Promise.all([
    hasPermission("view_activities", undefined, supabase),
    hasPermission("create_activity", undefined, supabase),
    hasPermission("manage_activity", undefined, supabase),
  ]);
  if (flags.some(Boolean)) {
    return { allowed: true, reason: null, authority: "scoped", tenantWide: false };
  }

  if (identity.memberships.includes("campaign_member")) {
    return { allowed: true, reason: null, authority: "member", tenantWide: false };
  }
  return denied("no_campaign_authority");
}

/**
 * POLITICORE — Election access gate (Phase 2 cutover, brief §14/§15/§16/§32).
 *
 * Single gate used by every migrated Election page. Unlike the legacy
 * client-side role checks, this resolves authorization from the
 * DATABASE (identity.ts helpers → the Postgres resolver), so a stale or
 * hand-edited profile in the UI can never widen access:
 *
 *   1. tenant member?         (profiles row exists)
 *   2. module enabled?        (module_enabled('election') — fail closed)
 *   3. social-only?           (zero access regardless of anything else)
 *   4. authority + scope      (from the database resolver question set)
 *
 * The route-level gate is a UX/defense-in-depth layer; the RPCs, view
 * RLS, and policies remain the authoritative boundary.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "./config";
// re-exported below via the existing barrel; Campaign gate lives beside the
// Election gate so both share the identity/module resolution helpers
import { resolveIdentity } from "./identity";
import type { PolitiCoreProfile } from "./auth-compat";

// ── Social Force gate (Social Phase B, gate §8) ─────────────────────────
//
// Social Force is the inverse audience of the Campaign/Election gates:
// social-only members are its primary legitimate audience, so the
// "social_only" denial below does not apply. Fail-closed ordering is
// identical: identity → module_enabled('social') → authority. Route
// gating is UX/defense-in-depth; RLS + authority RPCs stay authoritative.

export type SocialAuthority = "admin" | "member" | "none";

export interface SocialAccess {
  allowed: boolean;
  reason:
    | "unauthenticated"
    | "not_a_member"
    | "module_disabled"
    | "no_social_authority"
    | null;
  authority: SocialAuthority;
}

export async function resolveSocialAccess(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<SocialAccess> {
  const identity = await resolveIdentity(supabase);
  const denied = (
    reason: Exclude<SocialAccess["reason"], null>,
    authority: SocialAuthority = "none"
  ): SocialAccess => ({ allowed: false, reason, authority });

  if (!identity) return denied("unauthenticated");
  if (!identity.isTenantMember) return denied("not_a_member");

  const { isModuleEnabled } = await import("./identity");
  const moduleEnabled = await isModuleEnabled("social", supabase);
  if (!moduleEnabled) return denied("module_disabled");

  const adminRoles = ["admin", "tenant_super_admin", "platform_super_admin"];
  if (adminRoles.includes(identity.accessRole ?? "")) {
    return { allowed: true, reason: null, authority: "admin" };
  }

  if (identity.memberships.includes("social_member")) {
    // authority: "member" — participation authority per 0028 RLS
    return { allowed: true, reason: null, authority: "member" };
  }
  return denied("no_social_authority");
}

export type ElectionAuthority = "admin" | "election_officer" | "scoped" | "member" | "none";

export interface ElectionAccess {
  /** false → render the access-denied state (never redirect silently). */
  allowed: boolean;
  /** Set when a rule other than "unauthenticated" denied access. */
  reason: "unauthenticated" | "not_a_member" | "module_disabled" | "social_only" | "no_election_authority" | null;
  authority: ElectionAuthority;
  /** True when the caller holds tenant-wide authority (admin / officer). */
  tenantWide: boolean;
  profile: PolitiCoreProfile | null;
  /** Registered geography (used to prefill / constrain member forms). */
  wardId: string | null;
  pollingUnitId: string | null;
}

/** Database-resolved social-only test — the is_social_only() definition, server-side. */
function isSocialOnlyFrom(identity: {
  memberships: Array<"campaign_member" | "social_member">;
  accessRole: string | null;
}): boolean {
  return (
    identity.memberships.includes("social_member") &&
    !identity.memberships.includes("campaign_member") &&
    !["admin", "tenant_super_admin", "platform_super_admin", "election_officer"].includes(
      identity.accessRole ?? ""
    )
  );
}

/**
 * Resolve Election access for the current session.
 *
 * `requireAuthority` narrows the gate for operational pages: when true,
 * plain members (no election permission/registration) are denied, not
 * merely scoped — used by upload/operations/export/settings surfaces.
 */
export async function resolveElectionAccess(
  supabase: SupabaseClient = getSupabaseClient(),
  options: { requireAuthority?: boolean } = {}
): Promise<ElectionAccess> {
  const identity = await resolveIdentity(supabase);
  const denied = (
    reason: Exclude<ElectionAccess["reason"], null>,
    authority: ElectionAuthority = "none"
  ): ElectionAccess => ({
    allowed: false,
    reason,
    authority,
    tenantWide: false,
    profile: identity?.profile ?? null,
    wardId: identity?.profile?.ward_id ?? null,
    pollingUnitId: identity?.profile?.polling_unit_id ?? null,
  });

  if (!identity) return denied("unauthenticated");
  if (!identity.isTenantMember || !identity.profile) return denied("not_a_member");

  // Module gate — database answer, fail closed (§16).
  const { isModuleEnabled } = await import("./identity");
  const moduleEnabled = await isModuleEnabled("election", supabase);
  if (!moduleEnabled) return denied("module_disabled");

  // Social-only: absolute (§14).
  if (isSocialOnlyFrom(identity)) return denied("social_only");

  const adminRoles = ["admin", "tenant_super_admin", "platform_super_admin"];
  const isOfficer = identity.accessRole === "election_officer";
  const isAdmin = adminRoles.includes(identity.accessRole ?? "");

  if (isAdmin) {
    return ok(identity, "admin", true);
  }
  if (isOfficer) {
    return ok(identity, "election_officer", true);
  }

  // Scoped authority: ask the DATABASE resolver (hierarchical scope,
  // explicit-deny semantics) rather than pattern-matching profile fields.
  const { hasPermission } = await import("./identity");
  const [canView, canSubmit] = await Promise.all([
    hasPermission("view_election_results", undefined, supabase),
    hasPermission("upload_election_result", undefined, supabase),
  ]);
  const registeredMember =
    identity.memberships.includes("campaign_member") &&
    Boolean(identity.profile.ward_id) &&
    Boolean(identity.profile.polling_unit_id);

  if (canView || canSubmit) {
    return ok(identity, "scoped", false);
  }
  if (registeredMember) {
    return ok(identity, "member", false);
  }
  if (options.requireAuthority) {
    return denied("no_election_authority");
  }
  // A member with neither permission nor registration gets no Election UI.
  return denied("no_election_authority");

  function ok(
    id: NonNullable<typeof identity>,
    authority: ElectionAuthority,
    tenantWide: boolean
  ): ElectionAccess {
    return {
      allowed: true,
      reason: null,
      authority,
      tenantWide,
      profile: id.profile,
      wardId: id.profile?.ward_id ?? null,
      pollingUnitId: id.profile?.polling_unit_id ?? null,
    };
  }
}
