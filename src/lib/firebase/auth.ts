import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";

import { initializeApp, deleteApp } from "firebase/app";
import { getAuth } from "firebase/auth";

import { doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { logSystemAudit } from "@/lib/firebase/audit";
import type { UserLifecycleStatus, OnboardingStatus } from "@/types";

import { auth, db, firebaseConfig } from "./config";

import { CURRENT_TENANT_ID } from "./tenants";

import type { MembershipType, Role } from "@/types";

/**
 * Creates a new volunteer account through the public
 * registration form.
 *
 * Public registrations always belong to the current campaign
 * tenant and start with the normal "member" access role.
 */
export async function signUpVolunteer(
  email: string,
  password: string,
  userData: {
    full_name: string;
    phone: string;
    gender: string;

    membership_types: MembershipType[];

    lga_id?: string;
    ward_id: string;
    polling_unit_id: string;

    facebook_username?: string;
    x_username?: string;
    instagram_username?: string;
    tiktok_username?: string;
    facebook_name?: string;
    x_name?: string;
    instagram_name?: string;
    tiktok_name?: string;
  },
) {
  try {
    const userCredential = await createUserWithEmailAndPassword(
      auth,
      email,
      password,
    );

    const user = userCredential.user;

    // Filter out undefined fields to prevent Firestore setDoc error
    const cleanedUserData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(userData)) {
      if (value !== undefined) {
        cleanedUserData[key] = value;
      }
    }

    await setDoc(doc(db, "users", user.uid), {
      ...cleanedUserData,

      email,

      /**
       * All users belong to the current campaign tenant.
       */
      tenant_id: CURRENT_TENANT_ID,

      /**
       * Everyone registering through the public
       * registration form starts as a normal member.
       */
      access_role: "member",

      /**
       * Social ranking starts at zero.
       */
      points: 0,
      rank: "Volunteer",

      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    try {
      const { syncLeaderboardProjection } = await import("./firestore");
      await syncLeaderboardProjection(user.uid, {
        display_name: payload.full_name,
        full_name: payload.full_name,
        points: 0,
        rank: "Volunteer",
        tenant_id: payload.tenant_id || CURRENT_TENANT_ID,
        state_id: payload.state_id || "enugu-state",
        zone_id: payload.zone_id,
        lga_id: payload.lga_id,
        ward_id: payload.ward_id,
      });
    } catch (syncErr) {
      console.warn("Leaderboard projection sync warning on volunteer signup:", syncErr);
    }

    return {
      user,
      error: null,
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      user: null,
      error: err.message,
    };
  }
}

/**
 * Creates a new member account on behalf of an admin.
 *
 * IMPORTANT:
 *
 * createUserWithEmailAndPassword on the primary Firebase Auth
 * instance would replace the currently authenticated admin
 * session with the newly created user.
 *
 * Therefore this function creates the new account through a
 * temporary secondary Firebase App instance.
 *
 * The admin's primary authentication session is never replaced.
 *
 * NOTE:
 *
 * Authorization must still be enforced by Firestore Security
 * Rules / trusted backend logic. Client-side role checks alone
 * are not sufficient security.
 */
export async function createMemberByAdmin(
  email: string,
  password: string,
  userData: {
    full_name: string;
    phone: string;
    gender?: string;

    membership_types: MembershipType[];
    access_role: Role;

    lga_id?: string;
    ward_id: string;
    polling_unit_id: string;

    facebook_username?: string;
    x_username?: string;
    instagram_username?: string;
    tiktok_username?: string;
    facebook_name?: string;
    x_name?: string;
    instagram_name?: string;
    tiktok_name?: string;
  },
) {
  const secondaryAppName = `admin-create-member-${Date.now()}`;

  const secondaryApp = initializeApp(firebaseConfig, secondaryAppName);

  const secondaryAuth = getAuth(secondaryApp);

  try {
    /**
     * Create the Firebase Authentication account
     * using the isolated secondary Auth instance.
     */
    const userCredential = await createUserWithEmailAndPassword(
      secondaryAuth,
      email,
      password,
    );

    const newUser = userCredential.user;

    // Filter out undefined fields to prevent Firestore setDoc error
    const cleanedUserData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(userData)) {
      if (value !== undefined) {
        cleanedUserData[key] = value;
      }
    }

    /**
     * Create the Firestore user profile through the
     * primary Firestore connection.
     *
     * tenant_id is explicitly assigned from the canonical
     * tenant constant rather than relying on the currently
     * logged-in admin's profile.
     */
    await setDoc(doc(db, "users", newUser.uid), {
      ...cleanedUserData,

      email,

      /**
       * Canonical campaign tenant.
       */
      tenant_id: CURRENT_TENANT_ID,

      points: 0,
      rank: "Volunteer",

      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    try {
      const { syncLeaderboardProjection } = await import("./firestore");
      await syncLeaderboardProjection(newUser.uid, {
        display_name: (cleanedUserData.full_name || cleanedUserData.display_name) as string,
        full_name: cleanedUserData.full_name as string,
        points: 0,
        rank: "Volunteer",
        tenant_id: CURRENT_TENANT_ID,
        state_id: cleanedUserData.state_id as string || "enugu-state",
        zone_id: cleanedUserData.zone_id as string,
        lga_id: cleanedUserData.lga_id as string,
        ward_id: cleanedUserData.ward_id as string,
      });
    } catch (syncErr) {
      console.warn("Leaderboard projection sync warning on admin member creation:", syncErr);
    }

    /**
     * Sign out of the secondary Auth instance so the
     * newly created account does not remain authenticated
     * on the temporary instance.
     */
    await secondaryAuth.signOut();

    return {
      user: newUser,
      error: null,
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      user: null,
      error: err.message,
    };
  } finally {
    /**
     * Always destroy the temporary Firebase App instance.
     */
    await deleteApp(secondaryApp).catch(() => {});
  }
}

/**
 * Signs an existing user in.
 */
export async function signIn(email: string, password: string) {
  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      email,
      password,
    );

    return {
      user: userCredential.user,
      error: null,
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      user: null,
      error: err.message,
    };
  }
}

/**
 * Signs the current user out.
 */
export async function logOut() {
  try {
    await signOut(auth);

    return {
      error: null,
    };
  } catch (error: unknown) {
    const err = error as Error;
    return {
      error: err.message,
    };
  }
}

/**
 * Subscribes to Firebase authentication state changes.
 */
export function onAuthStateChange(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Administrative user lifecycle status update (activate, suspend, deactivate, restore).
 */
export async function updateUserLifecycleStatus(
  userId: string,
  newStatus: UserLifecycleStatus,
  adminUserId: string,
  adminUserName?: string,
  reasonNotes?: string
) {
  try {
    const userRef = doc(db, "users", userId);
    await updateDoc(userRef, {
      lifecycle_status: newStatus,
      status_reason: reasonNotes || null,
      updated_at: serverTimestamp(),
    });

    await logSystemAudit({
      actor_id: adminUserId,
      actor_name: adminUserName,
      action: `USER_LIFECYCLE_${newStatus.toUpperCase()}`,
      affected_resource: "user",
      resource_id: userId,
      new_value: { lifecycle_status: newStatus, status_reason: reasonNotes || null },
      reason_notes: reasonNotes || `User lifecycle updated to ${newStatus}`,
    });

    return { error: null };
  } catch (error: unknown) {
    const err = error as Error;
    return { error: err.message };
  }
}
