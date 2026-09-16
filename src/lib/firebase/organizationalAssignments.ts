"use client";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "firebase/firestore";

import { db } from "@/lib/firebase/config";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import { POSITION_DEFAULT_PERMISSIONS } from "@/lib/permissions";

import type {
  OrganizationalAssignment,
  OrganizationalPosition,
  OrganizationalAssignmentStatus,
  Permission,
  ScopeType,
} from "@/types";

/*
 * ============================================================
 * FIRESTORE COLLECTION
 * ============================================================
 */

const COLLECTION = "organizational_assignments";

/*
 * ============================================================
 * FIRESTORE → APPLICATION MAPPER
 * ============================================================
 */

function mapAssignment(
  id: string,
  data: Record<string, unknown>,
): OrganizationalAssignment {
  return {
    id,
    tenant_id: String(data.tenant_id ?? ""),
    user_id: String(data.user_id ?? ""),
    position: data.position as OrganizationalPosition,
    scope_type: data.scope_type as ScopeType,
    scope_id: String(data.scope_id ?? ""),
    status: data.status as OrganizationalAssignment["status"],
    assigned_by: String(data.assigned_by ?? ""),
    assigned_at: data.assigned_at,
    starts_at: data.starts_at,
    ends_at: data.ends_at,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

/*
 * ============================================================
 * USER_ACCESS INDEX SYNC
 * ============================================================
 *
 * Every active assignment writes one small document per permission
 * granted by that position, into the user_access collection.
 *
 * Firestore Security Rules read from user_access to authorize
 * scoped operations. Without these documents, non-admin users are
 * silently denied on any rule that calls hasAccess().
 *
 * Document ID format (must match firestore.rules character for
 * character):
 *
 *   user_access/{uid}__{permission}__{scopeType}__{scopeId}
 *
 * A "global" variant exists for permissions granted with no scope,
 * but organizational assignments always carry a scope, so we do
 * not use it here.
 */

function userAccessDocId(
  userId: string,
  permission: Permission,
  scopeType: ScopeType,
  scopeId: string,
): string {
  return `${userId}__${permission}__${scopeType}__${scopeId}`;
}

async function writeAssignmentIndex(
  tenantId: string,
  userId: string,
  position: OrganizationalPosition,
  scopeType: ScopeType,
  scopeId: string,
): Promise<void> {
  const permissions = POSITION_DEFAULT_PERMISSIONS[position] ?? [];

  if (permissions.length === 0) {
    // Positions like campaign_manager / council_chairman intentionally
    // carry no default permissions here. Those roles are expected to
    // use access_role: "admin" on the user profile instead.
    return;
  }

  if (!tenantId || !userId || !scopeType || !scopeId) {
    // Defensive: never write a malformed index entry.
    return;
  }

  const writes = permissions.map((permission) =>
    setDoc(
      doc(
        db,
        "user_access",
        userAccessDocId(userId, permission, scopeType, scopeId),
      ),
      {
        user_id: userId,
        tenant_id: tenantId,
        permission,
        allowed: true,
        scope_type: scopeType,
        scope_id: scopeId,
        updated_at: serverTimestamp(),
      },
      { merge: true },
    ),
  );

  await Promise.all(writes);
}

async function removeAssignmentIndex(
  userId: string,
  position: OrganizationalPosition,
  scopeType: ScopeType,
  scopeId: string,
): Promise<void> {
  const permissions = POSITION_DEFAULT_PERMISSIONS[position] ?? [];

  if (permissions.length === 0) {
    return;
  }

  if (!userId || !scopeType || !scopeId) {
    return;
  }

  const deletes = permissions.map((permission) =>
    deleteDoc(
      doc(
        db,
        "user_access",
        userAccessDocId(userId, permission, scopeType, scopeId),
      ),
    ),
  );

  await Promise.all(deletes);
}

/*
 * ============================================================
 * GET ALL ASSIGNMENTS FOR A USER
 * ============================================================
 */

export async function getUserOrganizationalAssignments(
  userId: string,
): Promise<OrganizationalAssignment[]> {
  if (!userId) {
    return [];
  }

  const assignmentsRef = collection(db, COLLECTION);

  const q = query(
    assignmentsRef,
    where("user_id", "==", userId),
    orderBy("created_at", "desc"),
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((assignmentDoc) =>
    mapAssignment(assignmentDoc.id, assignmentDoc.data()),
  );
}

/*
 * ============================================================
 * GET ACTIVE ASSIGNMENTS ONLY
 * ============================================================
 */

export async function getActiveOrganizationalAssignments(
  userId: string,
): Promise<OrganizationalAssignment[]> {
  if (!userId) {
    return [];
  }

  const assignmentsRef = collection(db, COLLECTION);

  const q = query(
    assignmentsRef,
    where("user_id", "==", userId),
    where("status", "==", "active"),
    orderBy("created_at", "desc"),
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((assignmentDoc) =>
    mapAssignment(assignmentDoc.id, assignmentDoc.data()),
  );
}

/*
 * ============================================================
 * GET ALL ASSIGNMENTS (ADMIN)
 * ============================================================
 */

export async function getAllOrganizationalAssignments(): Promise<
  OrganizationalAssignment[]
> {
  const assignmentsRef = collection(db, COLLECTION);

  const q = query(assignmentsRef, orderBy("created_at", "desc"));

  const snapshot = await getDocs(q);

  return snapshot.docs.map((assignmentDoc) =>
    mapAssignment(assignmentDoc.id, assignmentDoc.data()),
  );
}

/*
 * ============================================================
 * GET ASSIGNMENTS BY USER ID (ADMIN)
 * ============================================================
 */

export async function getOrganizationalAssignmentsByUserId(
  userId: string,
  tenantId: string = CURRENT_TENANT_ID,
): Promise<OrganizationalAssignment[]> {
  if (!userId) {
    return [];
  }

  const assignmentsRef = collection(db, COLLECTION);

  const q = query(
    assignmentsRef,
    where("tenant_id", "==", tenantId),
    where("user_id", "==", userId),
    orderBy("created_at", "desc"),
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((assignmentDoc) =>
    mapAssignment(assignmentDoc.id, assignmentDoc.data()),
  );
}

/*
 * ============================================================
 * GET A SINGLE ASSIGNMENT
 * ============================================================
 */

export async function getOrganizationalAssignment(
  assignmentId: string,
): Promise<OrganizationalAssignment | null> {
  if (!assignmentId) {
    return null;
  }

  const assignmentRef = doc(db, COLLECTION, assignmentId);

  const snapshot = await getDoc(assignmentRef);

  if (!snapshot.exists()) {
    return null;
  }

  return mapAssignment(snapshot.id, snapshot.data());
}

/*
 * ============================================================
 * CREATE ASSIGNMENT
 * ============================================================
 *
 * Writes the assignment document, then writes the corresponding
 * user_access index documents so that Firestore Security Rules
 * can authorize the user's subsequent reads and writes.
 */

export async function createOrganizationalAssignment(data: {
  tenant_id: string;
  user_id: string;
  position: OrganizationalPosition;
  scope_type: ScopeType;
  scope_id: string;
  status: OrganizationalAssignmentStatus;
  assigned_by: string;
  starts_at?: Timestamp | null;
  ends_at?: Timestamp | null;
}): Promise<string> {
  const ref = await addDoc(collection(db, COLLECTION), {
    ...data,
    assigned_at: serverTimestamp(),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  if (data.status === "active") {
    await writeAssignmentIndex(
      data.tenant_id,
      data.user_id,
      data.position,
      data.scope_type,
      data.scope_id,
    );
  }

  return ref.id;
}

/*
 * ============================================================
 * UPDATE ASSIGNMENT
 * ============================================================
 *
 * Reads the previous state first so that we can remove stale
 * index entries before writing new ones.
 *
 * If the previous scope differs from the new scope, or the
 * position changes, the old index entries must be deleted;
 * otherwise the user retains access at a scope they no longer
 * own.
 *
 * If the new status is not "active", the index is removed and
 * not rewritten. An inactive / suspended / expired assignment
 * confers no authority.
 */

export async function updateOrganizationalAssignment(
  assignmentId: string,
  data: Partial<{
    position: OrganizationalPosition;
    scope_type: ScopeType;
    scope_id: string;
    status: OrganizationalAssignmentStatus;
    starts_at: Timestamp | null;
    ends_at: Timestamp | null;
  }>,
): Promise<void> {
  const assignmentRef = doc(db, COLLECTION, assignmentId);
  const beforeSnap = await getDoc(assignmentRef);

  if (!beforeSnap.exists()) {
    return;
  }

  const previous = mapAssignment(beforeSnap.id, beforeSnap.data());

  // Remove the old index entries unconditionally.
  // If nothing changes, we simply rewrite them below.
  await removeAssignmentIndex(
    previous.user_id,
    previous.position,
    previous.scope_type,
    previous.scope_id,
  );

  await updateDoc(assignmentRef, {
    ...data,
    updated_at: serverTimestamp(),
  });

  // Compute the effective new state.
  const nextTenantId = previous.tenant_id;
  const nextUserId = previous.user_id;
  const nextPosition = data.position ?? previous.position;
  const nextScopeType = data.scope_type ?? previous.scope_type;
  const nextScopeId = data.scope_id ?? previous.scope_id;
  const nextStatus = data.status ?? previous.status;

  if (nextStatus === "active") {
    await writeAssignmentIndex(
      nextTenantId,
      nextUserId,
      nextPosition,
      nextScopeType,
      nextScopeId,
    );
  }
}

/*
 * ============================================================
 * DELETE ASSIGNMENT
 * ============================================================
 *
 * Removes the user_access index entries first, then deletes the
 * assignment document.
 */

export async function deleteOrganizationalAssignment(
  assignmentId: string,
): Promise<void> {
  const assignmentRef = doc(db, COLLECTION, assignmentId);
  const beforeSnap = await getDoc(assignmentRef);

  if (!beforeSnap.exists()) {
    return;
  }

  const previous = mapAssignment(beforeSnap.id, beforeSnap.data());

  await removeAssignmentIndex(
    previous.user_id,
    previous.position,
    previous.scope_type,
    previous.scope_id,
  );

  await deleteDoc(assignmentRef);
}

/*
 * ============================================================
 * FIND ASSIGNMENTS BY POSITION
 * ============================================================
 */

export async function getUserAssignmentsByPosition(
  userId: string,
  position: OrganizationalPosition,
): Promise<OrganizationalAssignment[]> {
  if (!userId) {
    return [];
  }

  const assignmentsRef = collection(db, COLLECTION);

  const q = query(
    assignmentsRef,
    where("user_id", "==", userId),
    where("position", "==", position),
    where("status", "==", "active"),
    orderBy("created_at", "desc"),
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((assignmentDoc) =>
    mapAssignment(assignmentDoc.id, assignmentDoc.data()),
  );
}

/*
 * ============================================================
 * FIND ASSIGNMENTS BY SCOPE
 * ============================================================
 */

export async function getUserAssignmentsByScope(
  userId: string,
  scopeType: ScopeType,
  scopeId: string,
): Promise<OrganizationalAssignment[]> {
  if (!userId || !scopeId) {
    return [];
  }

  const assignmentsRef = collection(db, COLLECTION);

  const q = query(
    assignmentsRef,
    where("user_id", "==", userId),
    where("scope_type", "==", scopeType),
    where("scope_id", "==", scopeId),
    where("status", "==", "active"),
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((assignmentDoc) =>
    mapAssignment(assignmentDoc.id, assignmentDoc.data()),
  );
}
