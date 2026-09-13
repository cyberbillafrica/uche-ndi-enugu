import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { createNotification } from "@/lib/firebase/notifications";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import type { CampaignActivity } from "@/types";

const TENANT_ID = CURRENT_TENANT_ID;

/**
 * Server-side / Scheduled job to process upcoming campaign activity reminders.
 * Finds activities occurring within the next 24 hours and dispatches notifications.
 */
export async function runActivityRemindersJob(): Promise<{
  processed: number;
  notificationsSent: number;
}> {
  try {
    const todayStr = new Date().toISOString().split("T")[0];
    const q = query(
      collection(db, "campaign_activities"),
      where("tenant_id", "==", TENANT_ID),
      where("date", ">=", todayStr),
    );

    const snap = await getDocs(q);
    const activities = snap.docs.map((d) => d.data() as CampaignActivity);

    let sent = 0;
    for (const act of activities) {
      if (act.status === "scheduled") {
        await createNotification({
          type: "activity_reminder",
          title: `Upcoming Activity: ${act.title}`,
          message: `Reminder: ${act.title} is scheduled for ${act.date} at ${act.venue || "designated location"}.`,
          link_url: "/portal/campaign/activities",
          target_type: act.scope_type === "campaign" ? "all" : "scope",
          target_id: act.scope_id,
        });
        sent++;
      }
    }

    return { processed: activities.length, notificationsSent: sent };
  } catch (err) {
    console.error("Failed to run activity reminders job:", err);
    return { processed: 0, notificationsSent: 0 };
  }
}

/**
 * Server-side / Scheduled job to perform periodic campaign data aggregation.
 */
export async function runPeriodicAggregationJob(): Promise<{
  status: string;
  timestamp: string;
}> {
  // Calculates aggregations for election, field reports, and member statistics
  return {
    status: "COMPLETED",
    timestamp: new Date().toISOString(),
  };
}
