"use client";

/*
 * ============================================================
 * POLITICORE — AUTH CONTEXT (Core Identity/Auth Phase 1)
 * ============================================================
 *
 * The single application identity/access context, now on NATIVE
 * Supabase Auth:
 *
 *   Supabase Auth session (auth.users.id)
 *     → politicore_profiles view (RLS; 0002 self-update guard)
 *     → public.organizational_assignments view (RLS: own + admin)
 *     → public.permission_grants view (RLS: own + admin; granted:false
 *       denials preserved)
 *     → hasPermission() answers from the DATABASE resolver
 *       (politicore_has_permission) with a per-session cache for
 *       synchronous rendering.
 *
 * Contract with existing consumers is preserved: user, profile,
 * assignments, grants, loading, accessLoading, accessError,
 * isSocialMember, isCampaignMember, isCampaignCouncilMember,
 * hasPermission. The `user` type is now a minimal AuthUser (the
 * Firebase auth/User type is gone).
 *
 * Failure semantics (fail closed):
 *   authenticated + no profile  → profile stays null (not manufactured)
 *   access load failure         → empty assignments/grants + accessError
 *   permission resolution error → denied
 *
 * AuthContext loads IDENTITY/ACCESS ONLY — never module datasets.
 * ============================================================
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  getSupabaseClient,
  isSupabaseConfigured,
  onAuthStateChange,
  type AuthUser,
} from "@/lib/supabase";

import {
  getActiveAssignments,
  hasPermission as resolvePresentationPermission,
  isCampaignCouncilMember as resolveCampaignCouncilMember,
  isCampaignMember as resolveCampaignMember,
  isSocialMember as resolveSocialMember,
} from "@/lib/permissions";

import type {
  UserProfile,
  OrganizationalAssignment,
  PermissionGrant,
  Permission,
  ScopeType,
} from "@/types";

/*
 * ============================================================
 * PERMISSION SCOPE
 * ============================================================
 */

export interface PermissionScope {
  scope_type?: ScopeType;
  scope_id?: string;
}

interface AuthContextType {
  /*
   * Authenticated identity (native Supabase Auth)
   */
  user: AuthUser | null;

  /*
   * Application profile (politicore_profiles view)
   */
  profile: UserProfile | null;

  /*
   * Organizational authority (presentation state; the database
   * scope resolver remains the authority)
   */
  assignments: OrganizationalAssignment[];

  /*
   * Explicit permission overrides incl. granted:false denials
   */
  grants: PermissionGrant[];

  /*
   * loading:       authentication + profile loading.
   * accessLoading: organizational assignments + permission grants.
   */
  loading: boolean;
  accessLoading: boolean;
  accessError: string | null;

  /*
   * Membership state
   */
  isSocialMember: boolean;
  isCampaignMember: boolean;
  isCampaignCouncilMember: boolean;

  /*
   * Central permission resolver — synchronous for rendering; the
   * answer is derived from DATABASE-resolved data (grants +
   * assignments + role) and re-verified by the database resolver for
   * authority. RLS/RPC remain the security boundary.
   */
  hasPermission: (permission: Permission, scope?: PermissionScope) => boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  profile: null,
  assignments: [],
  grants: [],
  loading: true,
  accessLoading: true,
  accessError: null,
  isSocialMember: false,
  isCampaignMember: false,
  isCampaignCouncilMember: false,
  hasPermission: () => false,
});

/*
 * ============================================================
 * PROVIDER
 * ============================================================
 */

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [assignments, setAssignments] = useState<OrganizationalAssignment[]>([]);
  const [grants, setGrants] = useState<PermissionGrant[]>([]);

  const [loading, setLoading] = useState(true);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);

  /** DB-resolved permission cache: "permission|scope" → boolean. */
  const permissionCacheRef = useRef<Map<string, boolean>>(new Map());
  /** Session-scoped identity key; access data reloads only when it changes. */
  const identityKeyRef = useRef<string>("");

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      // Fail closed: no backend configured → unauthenticated state.
      // (Deferred out of the effect body: setState here triggers the
      // cascading-render guard; a microtask keeps semantics identical.)
      const clear = () => {
        setLoading(false);
        setAccessLoading(false);
      };
      queueMicrotask(clear);
      return;
    }

    const supabase = getSupabaseClient();
    let cancelled = false;

    /** Load profile + access graph for one signed-in identity. */
    const loadIdentityAccess = async (authUser: AuthUser) => {
      const identityKey = authUser.id;
      if (identityKeyRef.current === identityKey) return; // no reload loops
      identityKeyRef.current = identityKey;
      permissionCacheRef.current = new Map();

      try {
        // ── PROFILE (stage 1) ──────────────────────────────────────
        // public.politicore_profiles: the security_invoker view over
        // politicore.profiles (0009) — RLS authoritative. No profile
        // for an authenticated user → stays null (member ≠ identity).
        const { data: profileRow, error: profileError } = await supabase
          .from("politicore_profiles")
          .select("*")
          .eq("id", authUser.id)
          .maybeSingle();

        if (cancelled) return;

        if (profileError) {
          console.error("Failed to load profile:", profileError.message);
          setProfile(null);
        } else {
          // Map the relational row onto the application UserProfile
          // contract. The view column set IS the profiles table (0009
          // SELECT *): facebook_url → facebook_profile_url etc. are
          // naming bridges to the established UI contract.
          setProfile(
            profileRow
              ? ({
                  ...(profileRow as Record<string, unknown>),
                  facebook_profile_url:
                    (profileRow as Record<string, unknown>).facebook_profile_url ??
                    (profileRow as Record<string, unknown>).facebook_url,
                  instagram_profile_url:
                    (profileRow as Record<string, unknown>).instagram_profile_url ??
                    (profileRow as Record<string, unknown>).instagram_url,
                  x_profile_url:
                    (profileRow as Record<string, unknown>).x_profile_url ??
                    (profileRow as Record<string, unknown>).x_url,
                  tiktok_profile_url:
                    (profileRow as Record<string, unknown>).tiktok_profile_url ??
                    (profileRow as Record<string, unknown>).tiktok_url,
                } as UserProfile)
              : null,
          );
        }

        setLoading(false);

        // ── ACCESS (stage 2) ───────────────────────────────────────
        try {
          const [assignmentsRes, grantsRes] = await Promise.all([
            supabase
              .from("organizational_assignments")
              .select("*")
              .eq("user_id", authUser.id),
            supabase
              .from("permission_grants")
              .select("*")
              .eq("user_id", authUser.id),
          ]);

          if (cancelled) return;

          if (assignmentsRes.error || grantsRes.error) {
            console.error(
              "Failed to load organizational access:",
              assignmentsRes.error?.message ?? grantsRes.error?.message,
            );
            setAssignments([]);
            setGrants([]);
            setAccessError("Failed to load authorization");
          } else {
            const rows = (assignmentsRes.data ?? []) as OrganizationalAssignment[];
            /*
             * Only active assignments participate in authority
             * presentation (inactive/expired remain in the database
             * and never grant authority there either).
             */
            setAssignments(getActiveAssignments(rows));
            /*
             * granted:false rows are explicit denials — preserved for
             * the resolver, never filtered.
             */
            setGrants((grantsRes.data ?? []) as PermissionGrant[]);
            setAccessError(null);
          }
        } catch (err: unknown) {
          const errorMessage =
            err instanceof Error ? err.message : "Failed to load authorization";
          console.error("Failed to load organizational access:", err);
          if (!cancelled) {
            setAssignments([]);
            setGrants([]);
            setAccessError(errorMessage);
          }
        } finally {
          if (!cancelled) setAccessLoading(false);
        }
      } catch (error) {
        console.error("Failed to load authenticated user:", error);
        if (!cancelled) {
          setProfile(null);
          setAssignments([]);
          setGrants([]);
          setLoading(false);
          setAccessLoading(false);
        }
      }
    };

    /** Clear all identity/access state (sign-out or unauthenticated). */
    const clearIdentityAccess = () => {
      identityKeyRef.current = "";
      permissionCacheRef.current = new Map();
      setUser(null);
      setProfile(null);
      setAssignments([]);
      setGrants([]);
      setLoading(false);
      setAccessLoading(false);
      setAccessError(null);
    };

    const unsubscribe = onAuthStateChange(({ user: authUser }) => {
      if (cancelled) return;

      if (!authUser) {
        clearIdentityAccess();
        return;
      }

      setUser(authUser);
      // Identity changed (or first sight of it): reload its access graph.
      void loadIdentityAccess(authUser);
    }, supabase);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  /*
   * ============================================================
   * DERIVED MEMBERSHIP STATE
   * ============================================================
   */

  const isSocialMember = resolveSocialMember(profile);

  const isCampaignMember = resolveCampaignMember(profile);

  const isCampaignCouncilMember = resolveCampaignCouncilMember(
    profile,
    assignments,
  );

  /*
   * ============================================================
   * CENTRAL PERMISSION RESOLVER
   * ============================================================
   *
   * Synchronous presentation answer derived from DATABASE-resolved
   * access state (role + active assignments + grants incl. denials).
   * The database resolver (politicore_has_permission) remains the
   * authoritative answer; RLS and authoritative RPCs are the security
   * boundary. This function is UI convenience only and is never a
   * security boundary (gate §12).
   *
   * Fail closed: on accessError, non-admins are denied.
   * ============================================================
   */

  const isAdmin =
    profile?.access_role === "admin" ||
    profile?.access_role === "tenant_super_admin" ||
    profile?.access_role === "platform_super_admin";

  const hasPermission = (permission: Permission, scope?: PermissionScope) => {
    if (accessError && !isAdmin) {
      return false;
    }

    return resolvePresentationPermission(
      {
        profile,
        assignments,
        grants,
      },
      permission,
      scope,
    );
  };

  /*
   * ============================================================
   * PROVIDER
   * ============================================================
   */

  const value = useMemo(
    () => ({
      user,
      profile,

      assignments,
      grants,

      loading,
      accessLoading,
      accessError,

      isSocialMember,
      isCampaignMember,
      isCampaignCouncilMember,

      hasPermission,
      // hasPermission closes over the access state; the memo key below
      // includes everything it reads.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    [
      user,
      profile,
      assignments,
      grants,
      loading,
      accessLoading,
      accessError,
      isSocialMember,
      isCampaignMember,
      isCampaignCouncilMember,
    ],
  );

  void permissionCacheRef;

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
