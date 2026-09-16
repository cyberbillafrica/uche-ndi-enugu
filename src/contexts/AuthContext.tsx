"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { User } from "firebase/auth";

import { onAuthStateChange } from "@/lib/firebase/auth";
import { getUserProfile } from "@/lib/firebase/firestore";

import {
  getUserOrganizationalAssignments,
  getUserPermissionGrants,
} from "@/lib/firebase/organization";

import {
  getActiveAssignments,
  hasPermission as resolvePermission,
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

/*
 * ============================================================
 * AUTH CONTEXT TYPE
 * ============================================================
 *
 * AuthContext is the single source of truth for:
 *
 *   1. Firebase authentication
 *   2. User profile
 *   3. Organizational access
 *   4. Permission grants
 *
 * It does NOT load campaign datasets such as:
 *
 *   - Members
 *   - Activities
 *   - Reports
 *   - Issues
 *
 * Those modules query their own Firestore collections
 * using the access information supplied here.
 *
 * ============================================================
 */

interface AuthContextType {
  /*
   * Firebase identity
   */
  user: User | null;

  /*
   * Application profile
   */
  profile: UserProfile | null;

  /*
   * Organizational authority
   */
  assignments: OrganizationalAssignment[];

  /*
   * Explicit permission overrides
   */
  grants: PermissionGrant[];

  /*
   * Loading states
   *
   * loading:
   *   Authentication + profile loading.
   *
   * accessLoading:
   *   Organizational assignments + permission grants loading.
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
   * Central permission resolver
   */
  hasPermission: (permission: Permission, scope?: PermissionScope) => boolean;
}

/*
 * ============================================================
 * DEFAULT CONTEXT
 * ============================================================
 */

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
 * AUTH PROVIDER
 * ============================================================
 */

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  const [profile, setProfile] = useState<UserProfile | null>(null);

  const [assignments, setAssignments] = useState<OrganizationalAssignment[]>(
    [],
  );

  const [grants, setGrants] = useState<PermissionGrant[]>([]);

  const [loading, setLoading] = useState(true);

  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);

  /*
   * ------------------------------------------------------------
   * AUTH STATE
   * ------------------------------------------------------------
   */

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = onAuthStateChange(async (firebaseUser) => {
      /*
       * Start a fresh loading cycle whenever Firebase auth
       * changes.
       */
      setLoading(true);
      setAccessLoading(true);
      setAccessError(null);

      /*
       * Clear previous access immediately.
       *
       * This prevents the previous user's organizational
       * assignments from briefly appearing for a new user.
       */
      setAssignments([]);
      setGrants([]);

      try {
        /*
         * ------------------------------------------------------
         * SIGNED OUT
         * ------------------------------------------------------
         */

        if (!firebaseUser) {
          if (cancelled) return;

          setUser(null);
          setProfile(null);

          setLoading(false);
          setAccessLoading(false);

          return;
        }

        /*
         * ------------------------------------------------------
         * FIREBASE USER
         * ------------------------------------------------------
         */

        if (!cancelled) {
          setUser(firebaseUser);
        }

        /*
         * ------------------------------------------------------
         * PROFILE
         * ------------------------------------------------------
         */

        const data = await getUserProfile(firebaseUser.uid);

        if (cancelled) return;

        const userProfile = data
          ? ({
              ...data,
              id: firebaseUser.uid,
            } as UserProfile)
          : null;

        setProfile(userProfile);

        /*
         * Profile loading is now complete.
         *
         * We deliberately separate this from organizational
         * access loading.
         */
        setLoading(false);

        /*
         * ------------------------------------------------------
         * ORGANIZATIONAL ACCESS
         * ------------------------------------------------------
         *
         * These are separate from the user's profile.
         *
         * They determine:
         *
         *   Where the user operates
         *   What organizational position they hold
         *   What explicit permissions they have
         *
         * ------------------------------------------------------
         */

        try {
          const [organizationalAssignments, permissionGrants] =
            await Promise.all([
              getUserOrganizationalAssignments(firebaseUser.uid),

              getUserPermissionGrants(firebaseUser.uid),
            ]);

          if (cancelled) return;

          /*
           * Only active organizational assignments participate
           * in campaign authority.
           *
           * Inactive / suspended / expired assignments remain
           * in Firestore but do not grant active authority.
           */
          setAssignments(getActiveAssignments(organizationalAssignments));

          /*
           * Permission grants are intentionally not filtered
           * by "granted === true".
           *
           * A granted:false record represents an explicit
           * denial and must remain available to the permission
           * resolver.
           */
          setGrants(permissionGrants);
          setAccessError(null);
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
          if (!cancelled) {
            setAccessLoading(false);
          }
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
    });

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
   * Every dashboard/module can ask:
   *
   *   hasPermission("view_members")
   *
   * or:
   *
   *   hasPermission("view_members", {
   *     scope_type: "ward",
   *     scope_id: "nkanu-west-ward-01",
   *   })
   *
   * The actual authorization logic remains in
   * src/lib/permissions.ts.
   *
   * Firestore Security Rules remain the ultimate security
   * boundary.
   * ============================================================
   */

  const hasPermission = (permission: Permission, scope?: PermissionScope) => {
    // Fail closed if there was an error loading authorization state,
    // unless the user is an admin.
    if (accessError && profile?.access_role !== "admin") {
      return false;
    }

    return resolvePermission(
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

  return (
    <AuthContext.Provider
      value={{
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/*
 * ============================================================
 * USE AUTH
 * ============================================================
 */

export function useAuth() {
  return useContext(AuthContext);
}
