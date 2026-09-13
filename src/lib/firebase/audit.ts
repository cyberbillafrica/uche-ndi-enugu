import {
  collection,
  doc,
  getDocs,
  setDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  limit,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import type { SystemAuditLog, AuditResource } from "@/types";

const TENANT_ID = CURRENT_TENANT_ID;

function sanitizePayload<T extends Record<string, any>>(obj: T): T {
  const result = { ...obj };
  Object.keys(result).forEach((key) => {
    if (result[key] === undefined) {
      delete result[key];
    }
  });
  return result;
}

/**
 * Creates an immutable system audit log entry in Firestore.
 */
export async function logSystemAudit(params: {
  actor_id: string;
  actor_name?: string | null;
  actor_email?: string | null;
  action: string;
  affected_resource: AuditResource;
  resource_id: string;
  old_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
  reason_notes?: string | null;
  organizational_scope?: string | null;
}): Promise<string> {
  try {
    const auditRef = doc(collection(db, "system_audits"));
    const auditData: SystemAuditLog = {
      id: auditRef.id,
      tenant_id: TENANT_ID,
      actor_id: params.actor_id,
      actor_name: params.actor_name || null,
      actor_email: params.actor_email || null,
      action: params.action,
      affected_resource: params.affected_resource,
      resource_id: params.resource_id,
      old_value: params.old_value || null,
      new_value: params.new_value || null,
      reason_notes: params.reason_notes || null,
      organizational_scope: params.organizational_scope || null,
      timestamp: serverTimestamp(),
    };

    await setDoc(auditRef, sanitizePayload(auditData));
    return auditRef.id;
  } catch (err) {
    console.error("Failed to write system audit log:", err);
    return "";
  }
}

/**
 * Fetches platform-wide system audit logs for administrative review.
 */
export async function getSystemAuditLogs(
  resourceFilter?: AuditResource,
): Promise<SystemAuditLog[]> {
  try {
    const q = resourceFilter
      ? query(
          collection(db, "system_audits"),
          where("tenant_id", "==", TENANT_ID),
          where("affected_resource", "==", resourceFilter),
        )
      : query(
          collection(db, "system_audits"),
          where("tenant_id", "==", TENANT_ID),
        );

    const snap = await getDocs(q);
    const list = snap.docs.map((d) => d.data() as SystemAuditLog);

    // Client-side sort by timestamp descending
    return list.sort((a, b) => {
      const tA = (a.timestamp as any)?.seconds || Date.now();
      const tB = (b.timestamp as any)?.seconds || Date.now();
      return tB - tA;
    });
  } catch (err) {
    console.error("Failed to fetch system audit logs:", err);
    return [];
  }
}
