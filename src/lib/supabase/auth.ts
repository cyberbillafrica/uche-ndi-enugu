/**
 * POLITICORE — Native Supabase Auth service (Core Identity/Auth Phase 1).
 *
 * The canonical authentication surface. Replaces the legacy Firebase auth
 * helpers (signIn / signUpVolunteer / createMemberByAdmin / logOut /
 * onAuthStateChange) with native Supabase Auth:
 *
 *   Supabase Auth session → auth.users.id
 *     → politicore.profiles (0007 signup trigger provisions it)
 *     → server-resolved tenant (0006 JWT hook + current_tenant_id())
 *
 * There is exactly one canonical authentication source. No Firebase
 * fallback, no token bridge, no dual session.
 *
 * Provisioning contract (ratified, migration 0007): signup must carry
 * `tenant_slug` in raw user metadata; the trg_on_auth_user_created
 * trigger provisions a plain member profile (full_name + tenant). All
 * other profile fields (location, memberships, social handles) remain
 * an explicit administrative act — the client can never self-grant
 * authority.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getSupabaseAnonKey,
  isSupabaseConfigured,
} from "./config";

/** The application-facing authenticated identity (minimal, non-Firebase). */
export interface AuthUser {
  id: string;
  email: string | null;
  /** ISO timestamp of account creation when the session supplies it. */
  created_at?: string;
}

function toAuthUser(id: string, email: string | null, createdAt?: string): AuthUser {
  return { id, email, created_at: createdAt };
}

/** The tenant volunteers register into (matches the Firebase-era constant). */
export const SIGNUP_TENANT_SLUG = "ifeanyi-2027";

export interface NativeSignInResult {
  user: AuthUser | null;
  error: string | null;
}

/** Native password sign-in — creates the canonical Supabase session. */
export async function signIn(
  email: string,
  password: string,
  supabase: SupabaseClient,
): Promise<NativeSignInResult> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { user: null, error: error.message };
  const u = data.user;
  return { user: u ? toAuthUser(u.id, u.email ?? null) : null, error: null };
}

export interface VolunteerSignupData {
  full_name: string;
  phone?: string;
  gender?: string;
  membership_types?: string[];
  lga_id?: string;
  ward_id?: string;
  polling_unit_id?: string;
  facebook_name?: string;
  facebook_profile_url?: string;
  x_name?: string;
  x_profile_url?: string;
  instagram_name?: string;
  instagram_profile_url?: string;
  tiktok_name?: string;
  tiktok_profile_url?: string;
}

export interface NativeSignUpResult {
  user: AuthUser | null;
  error: string | null;
}

/**
 * Native volunteer signup. The supplied volunteer details ride as raw
 * user metadata (preserved on auth.users for administrative review);
 * the 0007 provisioning trigger consumes `tenant_slug` + `full_name`
 * and creates the plain member profile. Memberships are NOT client
 * granted — the profile starts with '{}' per the ratified contract.
 */
export async function signUpVolunteer(
  email: string,
  password: string,
  userData: VolunteerSignupData,
  supabase: SupabaseClient,
): Promise<NativeSignUpResult> {
  // Confirmation links (when confirmation is required) land on the
  // canonical callback route — see authLinks.ts / auth/callback.
  const emailRedirectTo =
    typeof window !== "undefined" && window.location?.origin
      ? `${window.location.origin}/auth/callback?type=signup`
      : "/auth/callback?type=signup";

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo,
      data: {
        tenant_slug: SIGNUP_TENANT_SLUG,
        full_name: userData.full_name,
        phone: userData.phone ?? null,
        gender: userData.gender ?? null,
        lga_id: userData.lga_id ?? null,
        ward_id: userData.ward_id ?? null,
        polling_unit_id: userData.polling_unit_id ?? null,
        facebook_name: userData.facebook_name ?? null,
        facebook_url: userData.facebook_profile_url ?? null,
        x_name: userData.x_name ?? null,
        x_url: userData.x_profile_url ?? null,
        instagram_name: userData.instagram_name ?? null,
        instagram_url: userData.instagram_profile_url ?? null,
        tiktok_name: userData.tiktok_name ?? null,
        tiktok_url: userData.tiktok_profile_url ?? null,
      },
    },
  });
  if (error) return { user: null, error: error.message };
  const u = data.user;
  return { user: u ? toAuthUser(u.id, u.email ?? null, u.created_at) : null, error: null };
}

/** Native sign-out — ends the canonical session and clears local state. */
export async function logOut(supabase: SupabaseClient): Promise<string | null> {
  const { error } = await supabase.auth.signOut();
  return error ? error.message : null;
}

/*
 * ── SELF-SERVICE ONBOARDING SIGNUP (Phase 30, SaaS C) ─────────────────
 *
 * A BARE identity: the signup deliberately carries NO `tenant_slug`
 * metadata, so the 0007 trigger provisions NO profile. The resulting
 * identity is a blank auth.users row whose journey position is resolved
 * exclusively by the Phase 30 onboarding_state() RPC from the session —
 * stage `create_tenant` until the provisioning RPC writes the owner
 * profile (tenant_super_admin) atomically.
 *
 * signUpVolunteer is NOT usable here: it forces SIGNUP_TENANT_SLUG,
 * which would immediately create a member profile in the existing
 * tenant and then be permanently denied onboarding by the
 * profile-exists guard (dup-owner + privilege-escalation block).
 */
export async function signUpBareIdentity(
  email: string,
  password: string,
  supabase: SupabaseClient,
): Promise<NativeSignUpResult> {
  // Owner-identity confirmation links resume at /onboarding/resume —
  // the server (onboarding_state) decides the next step; nothing is
  // inferred from client state.
  const emailRedirectTo =
    typeof window !== "undefined" && window.location?.origin
      ? `${window.location.origin}/auth/callback?type=signup&next=${encodeURIComponent("/onboarding/resume")}`
      : "/auth/callback?type=signup&next=%2Fonboarding%2Fresume";

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo,
      // Bare identity: no tenant metadata of any kind, no profile
      // trigger. The onboarding intent marker is inert display data —
      // it is NOT authority-bearing (authority comes only from the RPC).
      data: { onboarding_intent: "tenant_owner" },
    },
  });
  if (error) return { user: null, error: error.message };
  const u = data.user;
  return { user: u ? toAuthUser(u.id, u.email ?? null, u.created_at) : null, error: null };
}

/*
 * ── ADMIN MEMBER CREATION ──────────────────────────────────────────────
 *
 * The platform has no server-side admin-API provisioning primitive
 * (no service_role key reaches the browser by design; gate §16 forbids
 * an insecure workaround). The ratified client-side pattern preserves
 * the Firebase-era contract exactly:
 *
 *   sign-up executes on a SECONDARY in-memory Supabase client so the
 *   admin's own canonical session is never replaced or cleared;
 *   the secondary client is discarded afterwards.
 *
 * The new member's profile is provisioned by the same 0007 trigger
 * (plain member, tenant from tenant_slug). Profile enrichment
 * (phone/location/handles) happens as a separate authenticated UPDATE
 * by the admin through the admin RLS policy; memberships/access_role
 * stay an explicit administrative act enforced server-side by the
 * profile guard (0002) — the client can never self-grant authority.
 * ====================================================================
 */

export interface AdminMemberProfileData {
  full_name: string;
  phone?: string;
  gender?: string;
  membership_types: string[];
  access_role: string;
  lga_id?: string;
  ward_id?: string;
  polling_unit_id?: string;
  facebook_username?: string;
  facebook_name?: string;
  x_username?: string;
  x_name?: string;
  instagram_username?: string;
  instagram_name?: string;
  tiktok_username?: string;
  tiktok_name?: string;
}

export interface AdminCreateMemberResult {
  /** The new member's canonical identity id (auth.users.id), or null. */
  userId: string | null;
  error: string | null;
}

/**
 * Create a member account on behalf of an admin.
 *
 * Runs signUp on an ephemeral secondary client (persistSession: false,
 * autoRefreshToken: false) so the ADMIN's session in the primary
 * client is untouched — the admin remains authenticated as the admin.
 * The 0007 provisioning trigger backfills the plain member profile;
 * the returned userId lets the caller enrich the profile under the
 * admin's own session.
 */
export async function createMemberByAdmin(params: {
  email: string;
  password: string;
  profileData: AdminMemberProfileData;
  /** The admin's canonical client (used for the post-create profile UPDATE). */
  adminSessionClient: SupabaseClient;
}): Promise<AdminCreateMemberResult> {
  if (!isSupabaseConfigured()) {
    return { userId: null, error: "Supabase is not configured." };
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) {
    return { userId: null, error: "Supabase is not configured." };
  }

  const { createClient } = await import("@supabase/supabase-js");
  const secondary = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const d = params.profileData;
  const { data, error } = await secondary.auth.signUp({
    email: params.email,
    password: params.password,
    options: {
      data: {
        tenant_slug: SIGNUP_TENANT_SLUG,
        full_name: d.full_name,
        phone: d.phone ?? null,
        gender: d.gender ?? null,
        lga_id: d.lga_id ?? null,
        ward_id: d.ward_id ?? null,
        polling_unit_id: d.polling_unit_id ?? null,
        facebook_name: d.facebook_name ?? null,
        facebook_url: d.facebook_username ?? null,
        x_name: d.x_name ?? null,
        x_url: d.x_username ?? null,
        instagram_name: d.instagram_name ?? null,
        instagram_url: d.instagram_username ?? null,
        tiktok_name: d.tiktok_name ?? null,
        tiktok_url: d.tiktok_username ?? null,
      },
    },
  });

  if (error) return { userId: null, error: error.message };
  const newUser = data.user;
  if (!newUser) return { userId: null, error: "Member account could not be created." };

  /*
   * Profile enrichment under the ADMIN's own session through the 0031
   * SECURITY DEFINER RPC. (0027 grant hygiene narrowed the profiles view
   * to SELECT-only — the enrichment transport is the RPC, which performs
   * the same same-tenant, tenant-admin-guarded UPDATE server-side.) The
   * 0002 audit trigger records authority-field changes; failures surface
   * to the caller without invalidating the created account.
   */
  const { error: enrichError } = await params.adminSessionClient.rpc(
    "admin_enrich_member_profile",
    {
      p_profile_id: newUser.id,
      p_phone: d.phone ?? null,
      p_lga_id: d.lga_id ?? null,
      p_ward_id: d.ward_id ?? null,
      p_polling_unit_id: d.polling_unit_id ?? null,
      p_membership_types: (d.membership_types as ("campaign_member" | "social_member")[]) ?? null,
      p_access_role: (d.access_role as "member" | "election_officer" | "admin") ?? null,
      p_facebook_name: d.facebook_name ?? d.facebook_username ?? null,
      p_facebook_url: d.facebook_username ?? null,
      p_x_name: d.x_name ?? d.x_username ?? null,
      p_x_url: d.x_username ?? null,
      p_instagram_name: d.instagram_name ?? d.instagram_username ?? null,
      p_instagram_url: d.instagram_username ?? null,
      p_tiktok_name: d.tiktok_name ?? d.tiktok_username ?? null,
      p_tiktok_url: d.tiktok_username ?? null,
    },
  );

  if (enrichError) {
    console.error(
      "Member account created but profile enrichment failed:",
      enrichError.message,
    );
    return {
      userId: newUser.id,
      error: `Member account created, but profile details could not be applied: ${enrichError.message}`,
    };
  }

  return { userId: newUser.id, error: null };
}

export type AuthEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED";

export type AuthStateEvent =
  | { event: "SIGNED_IN"; user: AuthUser }
  | { event: "SIGNED_OUT" }
  | { event: "IGNORED"; authEvent: AuthEvent };

/**
 * Canonical auth-state listener. Deliberately narrow: only SIGNED_IN and
 * SIGNED_OUT reach the caller — TOKEN_REFRESHED and USER_UPDATED are
 * reported as IGNORED so AuthContext never reloads the profile/access
 * graph on token refresh (no reload loops, no repeated queries).
 * INITIAL_SESSION is folded into SIGNED_IN/SIGNED_OUT by Supabase v2.
 */
export function onAuthStateChange(
  callback: (state: { user: AuthUser | null }) => void,
  supabase: SupabaseClient,
): () => void {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
      const u = session?.user;
      callback({ user: u ? toAuthUser(u.id, u.email ?? null, u.created_at) : null });
      return;
    }
    if (event === "SIGNED_OUT") {
      callback({ user: null });
      return;
    }
    // TOKEN_REFRESHED / USER_UPDATED / PASSWORD_RECOVERY: identity
    // unchanged — no reload (gate §6: no loops, no repeated queries).
  });

  return () => {
    data.subscription.unsubscribe();
  };
}
