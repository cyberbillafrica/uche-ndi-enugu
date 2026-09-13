import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";

import { db } from "./config";
import { CURRENT_TENANT_ID } from "./tenants";
import { getAllLGAs } from "@/lib/constants";
import { expandAssignmentToScopes } from "@/lib/organization";

import type {
  CampaignActivity,
  CampaignActivityStatus,
  CampaignActivityType,
  OrganizationalAssignment,
  LGA,
} from "@/types";

/*
 * ============================================================
 * TYPES
 * ============================================================
 *
 * tenant_id is NEVER supplied by callers.
 *
 * The data layer always assigns the canonical tenant.
 */

export interface CreateCampaignActivityInput {
  title: string;
  description?: string;

  activity_type: CampaignActivityType;
  status?: CampaignActivityStatus;

  date: string;
  start_time?: string;
  end_time?: string;

  venue?: string;

  /*
   * Organizational scope of the activity.
   *
   * Examples:
   *
   * campaign / ifeanyi-2027
   * state / enugu
   * lga / nkanu-west
   * ward / nkanu-west-ward-01
   */
  scope_type: OrganizationalAssignment["scope_type"];
  scope_id: string;

  /*
   * The authenticated user creating the activity.
   *
   * This is separate from organizer_id because the person
   * creating the activity may not be the organizer.
   */
  created_by: string;

  /*
   * Person responsible for organizing the activity.
   */
  organizer_id: string;
  organizer_name?: string;

  expected_attendance?: number;
}

/*
 * ============================================================
 * GET ACTIVITIES FOR ORGANIZATIONAL ASSIGNMENTS
 * ============================================================
 *
 * Returns activities belonging to the user's active
 * organizational assignments.
 *
 * IMPORTANT:
 *
 * This function intentionally queries the exact scopes present
 * in the user's assignments.
 *
 * It does NOT silently expand:
 *
 * ward -> LGA -> state -> campaign
 *
 * because organizational scope authorization should come from
 * the assignment system rather than being invented by the
 * activity data layer.
 */

export async function getAllCampaignActivities(): Promise<CampaignActivity[]> {
  const activityCollection = collection(db, "campaign_activities");

  const q = query(
    activityCollection,
    where("tenant_id", "==", CURRENT_TENANT_ID),
    orderBy("date", "asc"),
  );

  const snapshot = await getDocs(q);

  return snapshot.docs
    .map(
      (document) =>
        ({
          id: document.id,
          ...document.data(),
        }) as CampaignActivity,
    )
    .sort((a, b) => {
      const dateA = `${a.date} ${a.start_time ?? ""}`;
      const dateB = `${b.date} ${b.start_time ?? ""}`;

      return dateA.localeCompare(dateB);
    });
}

export async function getCampaignActivitiesForAssignments(
  assignments: OrganizationalAssignment[],
  lgasData?: LGA[],
): Promise<CampaignActivity[]> {
  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "active",
  );

  if (activeAssignments.length === 0) {
    return [];
  }

  const lgas = lgasData || (await getAllLGAs());
  const activityCollection = collection(db, "campaign_activities");
  const results = new Map<string, CampaignActivity>();

  // Expand each active assignment to its full set of descendant scopes
  const allScopesMap = new Map<string, { scope_type: string; scope_id: string }>();
  for (const a of activeAssignments) {
    const expanded = expandAssignmentToScopes(a, lgas);
    for (const item of expanded) {
      const key = `${item.scope_type}:${item.scope_id}`;
      if (!allScopesMap.has(key)) {
        allScopesMap.set(key, item);
      }
    }
  }

  const uniqueScopes = Array.from(allScopesMap.values());

  await Promise.all(
    uniqueScopes.map(async ({ scope_type, scope_id }) => {
      const q = query(
        activityCollection,
        where("tenant_id", "==", CURRENT_TENANT_ID),
        where("scope_type", "==", scope_type),
        where("scope_id", "==", scope_id),
        orderBy("date", "asc"),
      );

      const snapshot = await getDocs(q);

      snapshot.docs.forEach((document) => {
        results.set(document.id, {
          id: document.id,
          ...document.data(),
        } as CampaignActivity);
      });
    }),
  );

  return Array.from(results.values()).sort((a, b) => {
    const dateA = `${a.date} ${a.start_time ?? ""}`;
    const dateB = `${b.date} ${b.start_time ?? ""}`;

    return dateA.localeCompare(dateB);
  });
}

/*
 * ============================================================
 * CREATE CAMPAIGN ACTIVITY
 * ============================================================
 *
 * Callers NEVER provide tenant_id.
 *
 * The data layer owns tenant assignment:
 *
 * tenant_id: CURRENT_TENANT_ID
 *
 * This prevents the previous Firestore error:
 *
 * Unsupported field value: undefined
 * (found in field tenant_id)
 */

export async function updateCampaignActivity(
  activityId: string,
  input: Partial<CreateCampaignActivityInput>,
): Promise<void> {
  const activityRef = doc(db, "campaign_activities", activityId);

  const updates: Record<string, unknown> = {
    updated_at: serverTimestamp(),
  };

  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.activity_type !== undefined)
    updates.activity_type = input.activity_type;
  if (input.status !== undefined) updates.status = input.status;
  if (input.date !== undefined) updates.date = input.date;
  if (input.start_time !== undefined) updates.start_time = input.start_time;
  if (input.end_time !== undefined) updates.end_time = input.end_time;
  if (input.venue !== undefined) updates.venue = input.venue;
  if (input.scope_type !== undefined) updates.scope_type = input.scope_type;
  if (input.scope_id !== undefined) updates.scope_id = input.scope_id;
  if (input.organizer_id !== undefined)
    updates.organizer_id = input.organizer_id;
  if (input.organizer_name !== undefined)
    updates.organizer_name = input.organizer_name;
  if (input.expected_attendance !== undefined)
    updates.expected_attendance = input.expected_attendance;

  await updateDoc(activityRef, updates);
}

export async function deleteCampaignActivity(
  activityId: string,
): Promise<void> {
  await deleteDoc(doc(db, "campaign_activities", activityId));
}

export async function createCampaignActivity(
  input: CreateCampaignActivityInput,
): Promise<string> {
  /*
   * Do not spread undefined optional values into Firestore.
   *
   * Build the document explicitly so the Firestore payload
   * remains predictable.
   */

  const activityData: Record<string, unknown> = {
    title: input.title,

    activity_type: input.activity_type,

    date: input.date,

    scope_type: input.scope_type,
    scope_id: input.scope_id,

    created_by: input.created_by,

    organizer_id: input.organizer_id,

    /*
     * Tenant is always controlled here.
     */
    tenant_id: CURRENT_TENANT_ID,

    /*
     * Default status.
     */
    status: input.status ?? "scheduled",

    /*
     * Firestore timestamps.
     */
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  };

  /*
   * Optional fields are only added when actually supplied.
   *
   * This avoids Firestore rejecting undefined values.
   */

  if (input.description !== undefined) {
    activityData.description = input.description;
  }

  if (input.start_time !== undefined) {
    activityData.start_time = input.start_time;
  }

  if (input.end_time !== undefined) {
    activityData.end_time = input.end_time;
  }

  if (input.venue !== undefined) {
    activityData.venue = input.venue;
  }

  if (input.organizer_name !== undefined) {
    activityData.organizer_name = input.organizer_name;
  }

  if (input.expected_attendance !== undefined) {
    activityData.expected_attendance = input.expected_attendance;
  }

  /*
   * Write the activity.
   */

  const activityRef = await addDoc(
    collection(db, "campaign_activities"),
    activityData,
  );

  return activityRef.id;
}
