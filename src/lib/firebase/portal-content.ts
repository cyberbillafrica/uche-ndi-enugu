// src/lib/firebase/portal-content.ts

import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./config";
import type {
  PortalContent,
  PortalContentData,
  Announcement,
  EventData,
} from "@/types";

const COLLECTION = "portal_content";

export async function getPortalContent(
  tenantId: string,
): Promise<PortalContent[]> {
  try {
    const ref = doc(db, COLLECTION, tenantId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return [];
    const data = snap.data() as PortalContentData;
    return data.items || [];
  } catch (error) {
    console.error("Error fetching portal content:", error);
    return [];
  }
}

export async function savePortalContent(
  tenantId: string,
  items: PortalContent[],
): Promise<void> {
  const ref = doc(db, COLLECTION, tenantId);
  await setDoc(
    ref,
    {
      tenant_id: tenantId,
      items,
      updated_at: serverTimestamp(),
    },
    { merge: true },
  );
}

// ─── ANNOUNCEMENTS ───

export async function getAnnouncements(
  tenantId: string,
): Promise<Announcement[]> {
  const items = await getPortalContent(tenantId);
  return items.filter(
    (item): item is Announcement => item.type === "announcement",
  );
}

export async function addAnnouncement(
  tenantId: string,
  announcement: Omit<Announcement, "id" | "created_at" | "updated_at">,
): Promise<void> {
  const items = await getPortalContent(tenantId);
  const newItem: Announcement = {
    ...announcement,
    id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "announcement",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await savePortalContent(tenantId, [newItem, ...items]);
}

export async function updateAnnouncement(
  tenantId: string,
  announcementId: string,
  updates: Partial<Omit<Announcement, "id" | "type" | "created_at">>,
): Promise<void> {
  const items = await getPortalContent(tenantId);
  const updated = items.map((item) =>
    item.id === announcementId && item.type === "announcement"
      ? { ...item, ...updates, updated_at: new Date().toISOString() }
      : item,
  );
  await savePortalContent(tenantId, updated);
}

export async function deleteAnnouncement(
  tenantId: string,
  announcementId: string,
): Promise<void> {
  const items = await getPortalContent(tenantId);
  await savePortalContent(
    tenantId,
    items.filter((item) => item.id !== announcementId),
  );
}

// ─── EVENT ───

export async function getPublishedEvents(
  tenantId: string,
): Promise<EventData[]> {
  const items = await getPortalContent(tenantId);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  return items
    .filter(
      (item): item is EventData =>
        item.type === "event" && item.status === "published",
    )
    .filter((event) => {
      // Keep events happening today or in the future. Events without a
      // parseable date are kept so malformed data never hides content.
      const eventMs = new Date(event.date).getTime();
      return Number.isNaN(eventMs) || eventMs >= todayMs;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export async function addEvent(
  tenantId: string,
  event: Omit<EventData, "id" | "type" | "created_at" | "updated_at">,
): Promise<void> {
  const items = await getPortalContent(tenantId);
  const newItem: EventData = {
    ...event,
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "event",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await savePortalContent(tenantId, [newItem, ...items]);
}

export async function updateEvent(
  tenantId: string,
  eventId: string,
  updates: Partial<Omit<EventData, "id" | "type" | "created_at">>,
): Promise<void> {
  const items = await getPortalContent(tenantId);
  const updated = items.map((item) =>
    item.id === eventId && item.type === "event"
      ? { ...item, ...updates, updated_at: new Date().toISOString() }
      : item,
  );
  await savePortalContent(tenantId, updated);
}

export async function deleteEvent(
  tenantId: string,
  eventId: string,
): Promise<void> {
  const items = await getPortalContent(tenantId);
  await savePortalContent(
    tenantId,
    items.filter((item) => item.id !== eventId),
  );
}
