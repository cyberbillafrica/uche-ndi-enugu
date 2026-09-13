import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import type {
  DonationRecord,
  DonorRecord,
  DonationAuditLog,
  DonationStatus,
  DonationSourceMethod,
} from "@/types";

const TENANT_ID = CURRENT_TENANT_ID;

// Helper to remove undefined properties for Firestore payloads
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
 * Creates a new donation/contribution record and updates donor statistics and audit log atomically.
 */
export async function createDonation(params: {
  donor_name: string;
  donor_phone?: string | null;
  donor_email?: string | null;
  donor_reference?: string | null;
  amount: number;
  currency?: string;
  date_received: string;
  payment_method: DonationSourceMethod;
  category: string;
  status: DonationStatus;
  external_reference?: string | null;
  notes?: string | null;
  lga_id?: string | null;
  ward_id?: string | null;
  created_by: string;
  created_by_name?: string | null;
}): Promise<string> {
  const batch = writeBatch(db);
  const donationRef = doc(collection(db, "donations"));
  const donationId = donationRef.id;

  // Search or normalize donor ID based on name/phone
  const donorKey = (params.donor_phone || params.donor_name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const donorRef = doc(db, "donors", `donor_${donorKey}`);
  const donorSnap = await getDoc(donorRef);

  let donorId = donorRef.id;
  const isReceived = params.status === "received";
  const addAmount = isReceived ? Number(params.amount) : 0;

  if (donorSnap.exists()) {
    const existingDonor = donorSnap.data() as DonorRecord;
    batch.update(
      donorRef,
      sanitizePayload({
        total_received_amount:
          (existingDonor.total_received_amount || 0) + addAmount,
        contribution_count: (existingDonor.contribution_count || 0) + 1,
        latest_contribution_date: params.date_received,
        updated_at: serverTimestamp(),
      }),
    );
  } else {
    batch.set(
      donorRef,
      sanitizePayload({
        id: donorId,
        tenant_id: TENANT_ID,
        full_name: params.donor_name.trim(),
        phone: params.donor_phone || null,
        email: params.donor_email || null,
        reference_identifier: params.donor_reference || null,
        lga_id: params.lga_id || null,
        ward_id: params.ward_id || null,
        total_received_amount: addAmount,
        contribution_count: 1,
        latest_contribution_date: params.date_received,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      }),
    );
  }

  const donationData: DonationRecord = {
    id: donationId,
    tenant_id: TENANT_ID,
    donor_id: donorId,
    donor_name: params.donor_name.trim(),
    donor_phone: params.donor_phone || null,
    donor_email: params.donor_email || null,
    donor_reference: params.donor_reference || null,
    amount: Number(params.amount),
    currency: params.currency || "NGN",
    date_received: params.date_received,
    payment_method: params.payment_method,
    category: params.category,
    status: params.status,
    external_reference: params.external_reference || null,
    notes: params.notes || null,
    lga_id: params.lga_id || null,
    ward_id: params.ward_id || null,
    created_by: params.created_by,
    created_by_name: params.created_by_name || null,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  };

  batch.set(donationRef, sanitizePayload(donationData));

  // Audit Log Entry
  const auditRef = doc(collection(db, "donation_audits"));
  const auditData: DonationAuditLog = {
    id: auditRef.id,
    tenant_id: TENANT_ID,
    donation_id: donationId,
    action: "created",
    performed_by: params.created_by,
    performed_by_name: params.created_by_name || null,
    performed_at: serverTimestamp(),
    details: `Created donation of ₦${params.amount.toLocaleString()} (${params.status}) from ${params.donor_name}`,
  };

  batch.set(auditRef, sanitizePayload(auditData));

  await batch.commit();
  return donationId;
}

/**
 * Updates an existing donation record with audit log tracking and donor stat recalculation.
 */
export async function updateDonation(
  donationId: string,
  updates: Partial<DonationRecord>,
  updatedBy: string,
  updatedByName?: string,
): Promise<void> {
  const donationRef = doc(db, "donations", donationId);
  const snap = await getDoc(donationRef);
  if (!snap.exists()) {
    throw new Error("Donation record not found.");
  }

  const existing = snap.data() as DonationRecord;
  const batch = writeBatch(db);

  // Recalculate donor stats if amount or status changed
  if (
    existing.donor_id &&
    (updates.status !== undefined || updates.amount !== undefined)
  ) {
    const donorRef = doc(db, "donors", existing.donor_id);
    const donorSnap = await getDoc(donorRef);
    if (donorSnap.exists()) {
      const donor = donorSnap.data() as DonorRecord;

      const oldAmount =
        existing.status === "received" ? Number(existing.amount) : 0;
      const newStatus = updates.status ?? existing.status;
      const newAmountVal = updates.amount ?? existing.amount;
      const newAmount = newStatus === "received" ? Number(newAmountVal) : 0;

      const diff = newAmount - oldAmount;
      batch.update(
        donorRef,
        sanitizePayload({
          total_received_amount: (donor.total_received_amount || 0) + diff,
          updated_at: serverTimestamp(),
        }),
      );
    }
  }

  const cleanUpdates = sanitizePayload({
    ...updates,
    updated_by: updatedBy,
    updated_at: serverTimestamp(),
  });

  batch.update(donationRef, cleanUpdates);

  // Audit Log Entry
  const auditRef = doc(collection(db, "donation_audits"));
  const actionType =
    updates.status && updates.status !== existing.status
      ? updates.status === "cancelled"
        ? "cancelled"
        : "status_changed"
      : "updated";

  const auditData: DonationAuditLog = {
    id: auditRef.id,
    tenant_id: TENANT_ID,
    donation_id: donationId,
    action: actionType,
    performed_by: updatedBy,
    performed_by_name: updatedByName || null,
    performed_at: serverTimestamp(),
    details: `Updated donation record for ${existing.donor_name}`,
    changes: {
      before: {
        amount: existing.amount,
        status: existing.status,
        payment_method: existing.payment_method,
      },
      after: {
        amount: updates.amount ?? existing.amount,
        status: updates.status ?? existing.status,
        payment_method: updates.payment_method ?? existing.payment_method,
      },
    },
  };

  batch.set(auditRef, sanitizePayload(auditData));

  await batch.commit();
}

/**
 * Fetches all donation records for the campaign ledger.
 */
export async function getAllDonations(): Promise<DonationRecord[]> {
  try {
    const q = query(
      collection(db, "donations"),
      where("tenant_id", "==", TENANT_ID),
    );
    const snap = await getDocs(q);
    const list = snap.docs.map((d) => d.data() as DonationRecord);

    // Sort client-side by date_received descending
    return list.sort((a, b) => (b.date_received > a.date_received ? 1 : -1));
  } catch (err) {
    console.error("Failed to fetch donations:", err);
    return [];
  }
}

/**
 * Fetches all donor records.
 */
export async function getAllDonors(): Promise<DonorRecord[]> {
  try {
    const q = query(
      collection(db, "donors"),
      where("tenant_id", "==", TENANT_ID),
    );
    const snap = await getDocs(q);
    const list = snap.docs.map((d) => d.data() as DonorRecord);
    return list.sort(
      (a, b) => b.total_received_amount - a.total_received_amount,
    );
  } catch (err) {
    console.error("Failed to fetch donors:", err);
    return [];
  }
}

/**
 * Fetches audit log entries for a specific donation record.
 */
export async function getDonationAuditLogs(
  donationId: string,
): Promise<DonationAuditLog[]> {
  try {
    const q = query(
      collection(db, "donation_audits"),
      where("donation_id", "==", donationId),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as DonationAuditLog);
  } catch (err) {
    console.error("Failed to fetch donation audit logs:", err);
    return [];
  }
}
