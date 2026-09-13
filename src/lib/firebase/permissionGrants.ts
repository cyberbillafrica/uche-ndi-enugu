"use client";

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";

import { db } from "./config";

import type { Permission, PermissionGrant, ScopeType } from "@/types";

const COLLECTION = "permission_grants";

/*
 * ============================================================
 * USER_ACCESS INDEX SYNC
 * ============================================================
 *
 * Every explicit permission grant writes one small document into
 * the user_access collection.
 *
 * Firestore Security Rules read from user_access via the
 * hasGlobalAccess / hasScopedAccess helpers. Without these
 * documents, non-admin users are silently denied on every rule
 * that calls hasAccess().
 *
 * Document ID formats (must match firestore.rules character for
 * character):
 *
 *   user_access/{uid}__{permission}__global
 *   user_access/{uid}__{permission}__{scopeType}__{scopeId}
 *
 * A grant with granted: false still produces a user_access
 * document, but with allowed: false. The rules treat the mere
 * presence of a document with allowed == false as "no access",
 * which is what we want for explicit denials.
 */

function userAccessDocId(
  userId: string,
  permission: Permission,
  scopeType: ScopeType | null | undefined,
  scopeId: string | null | undefined,
): string {
  if (!scopeType || !scopeId) {
    return `${userId}__${permission}__global`;
  }
  return `${userId}__${permission}__${scopeType}__${scopeId}`;
}

async function writeUserAccessIndex(data: {
  tenant_id: string;
  user_id: string;
  permission: Permission;
  granted: boolean;
  scope_type?: ScopeType | null;
  scope_id?: string | null;
}): Promise<void> {
  if (!data.tenant_id || !data.user_id || !data.permission) {
    // Defensive: never write a malformed index entry.
    return;
  }

  const docId = userAccessDocId(
    data.user_id,
    data.permission,
    data.scope_type,
    data.scope_id,
  );

  await setDoc(
    doc(db, "user_access", docId),
    {
      user_id: data.user_id,
      tenant_id: data.tenant_id,
      permission: data.permission,
      allowed: data.granted,
      scope_type: data.scope_type ?? null,
      scope_id: data.scope_id ?? null,
      updated_at: serverTimestamp(),
    },
    { merge: true },
  );
}

async function removeUserAccessIndex(
  userId: string,
  permission: Permission,
  scopeType: ScopeType | null | undefined,
  scopeId: string | null | undefined,
): Promise<void> {
  if (!userId || !permission) {
    return;
  }

  const docId = userAccessDocId(userId, permission, scopeType, scopeId);

  await deleteDoc(doc(db, "user_access", docId));
}

/*
 * ============================================================
 * GET USER GRANTS
 * ============================================================
 */

export async function getUserPermissionGrants(
  userId: string,
): Promise<PermissionGrant[]> {
  const q = query(collection(db, COLLECTION), where("user_id", "==", userId));

  const snap = await getDocs(q);

  return snap.docs.map((item) => ({
    id: item.id,
    ...item.data(),
  })) as PermissionGrant[];
}

/*
 * ============================================================
 * GET ALL GRANTS (ADMIN)
 * ============================================================
 */

export async function getAllPermissionGrants(): Promise<PermissionGrant[]> {
  const q = query(collection(db, COLLECTION));

  const snap = await getDocs(q);

  return snap.docs.map((item) => ({
    id: item.id,
    ...item.data(),
  })) as PermissionGrant[];
}

/*
 * ============================================================
 * GET GRANTS BY USER ID (ADMIN)
 * ============================================================
 */

export async function getPermissionGrantsByUserId(
  userId: string,
): Promise<PermissionGrant[]> {
  const q = query(collection(db, COLLECTION), where("user_id", "==", userId));

  const snap = await getDocs(q);

  return snap.docs.map((item) => ({
    id: item.id,
    ...item.data(),
  })) as PermissionGrant[];
}

/*
 * ============================================================
 * CREATE GRANT
 * ============================================================
 *
 * Writes the grant document, then writes the corresponding
 * user_access index document so that Firestore Security Rules
 * can authorize the user's subsequent operations.
 */

export async function createPermissionGrant(data: {
  tenant_id: string;
  user_id: string;
  permission: Permission;
  granted: boolean;
  scope_type?: ScopeType | null;
  scope_id?: string | null;
  granted_by: string;
}): Promise<string> {
  const batch = writeBatch(db);

  const grantRef = doc(collection(db, COLLECTION));
  batch.set(grantRef, {
    ...data,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  const accessDocId = userAccessDocId(
    data.user_id,
    data.permission,
    data.scope_type,
    data.scope_id,
  );
  const accessRef = doc(db, "user_access", accessDocId);
  batch.set(
    accessRef,
    {
      user_id: data.user_id,
      tenant_id: data.tenant_id,
      permission: data.permission,
      allowed: data.granted,
      scope_type: data.scope_type ?? null,
      scope_id: data.scope_id ?? null,
      updated_at: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
  return grantRef.id;
}

/*
 * ============================================================
 * UPDATE GRANT
 * ============================================================
 *
 * Reads the previous state first, removes the old index entry,
 * updates the grant document, then writes the new index entry.
 *
 * If a grant's scope or permission changes, this ensures the
 * user does not retain access at the old scope.
 */

export async function updatePermissionGrant(
  grantId: string,
  data: Partial<{
    permission: Permission;
    granted: boolean;
    scope_type: ScopeType | null;
    scope_id: string | null;
  }>,
): Promise<void> {
  const grantRef = doc(db, COLLECTION, grantId);
  const beforeSnap = await getDoc(grantRef);

  if (!beforeSnap.exists()) {
    return;
  }

  const previous = {
    id: beforeSnap.id,
    ...beforeSnap.data(),
  } as PermissionGrant;

  const batch = writeBatch(db);

  // Remove old access index doc if permission or scope changed
  const oldAccessDocId = userAccessDocId(
    previous.user_id,
    previous.permission,
    previous.scope_type,
    previous.scope_id,
  );
  batch.delete(doc(db, "user_access", oldAccessDocId));

  // Update grant document
  batch.update(grantRef, {
    ...data,
    updated_at: serverTimestamp(),
  });

  // Write new access index doc
  const nextPermission = data.permission ?? previous.permission;
  const nextScopeType = data.scope_type !== undefined ? data.scope_type : previous.scope_type;
  const nextScopeId = data.scope_id !== undefined ? data.scope_id : previous.scope_id;
  const nextGranted = data.granted ?? previous.granted;

  const newAccessDocId = userAccessDocId(
    previous.user_id,
    nextPermission,
    nextScopeType,
    nextScopeId,
  );
  batch.set(
    doc(db, "user_access", newAccessDocId),
    {
      user_id: previous.user_id,
      tenant_id: previous.tenant_id,
      permission: nextPermission,
      allowed: nextGranted,
      scope_type: nextScopeType ?? null,
      scope_id: nextScopeId ?? null,
      updated_at: serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();
}

/*
 * ============================================================
 * DELETE GRANT
 * ============================================================
 *
 * Reads the grant, removes the user_access index entry, then
 * deletes the grant document.
 */

export async function deletePermissionGrant(grantId: string): Promise<void> {
  const grantRef = doc(db, COLLECTION, grantId);
  const beforeSnap = await getDoc(grantRef);

  if (!beforeSnap.exists()) {
    return;
  }

  const previous = {
    id: beforeSnap.id,
    ...beforeSnap.data(),
  } as PermissionGrant;

  const batch = writeBatch(db);

  const oldAccessDocId = userAccessDocId(
    previous.user_id,
    previous.permission,
    previous.scope_type,
    previous.scope_id,
  );
  batch.delete(doc(db, "user_access", oldAccessDocId));
  batch.delete(grantRef);

  await batch.commit();
}
