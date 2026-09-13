import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  arrayUnion,
  onSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import type { NotificationItem, NotificationType, NotificationTargetType, UserProfile } from "@/types";

const TENANT_ID = "ifeanyi-4-nkanu";

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
 * Creates a targeted in-app notification in Firestore.
 */
export async function createNotification(params: {
  type: NotificationType;
  title: string;
  message: string;
  link_url?: string | null;
  target_type: NotificationTargetType;
  target_id?: string | null;
  created_by?: string | null;
}): Promise<string> {
  const notifRef = doc(collection(db, "notifications"));
  const notificationData: NotificationItem = {
    id: notifRef.id,
    tenant_id: TENANT_ID,
    type: params.type,
    title: params.title.trim(),
    message: params.message.trim(),
    link_url: params.link_url || null,
    target_type: params.target_type,
    target_id: params.target_id || null,
    read_by: [],
    created_by: params.created_by || null,
    created_at: serverTimestamp(),
  };

  await setDoc(notifRef, sanitizePayload(notificationData));
  return notifRef.id;
}

/**
 * Subscribes in real-time to notifications relevant to a user based on their profile.
 */
export function subscribeUserNotifications(
  userProfile: UserProfile,
  onUpdate: (notifications: NotificationItem[]) => void
) {
  const q = query(
    collection(db, "notifications"),
    where("tenant_id", "==", TENANT_ID)
  );

  return onSnapshot(q, (snapshot) => {
    const all = snapshot.docs.map((d) => d.data() as NotificationItem);

    // Filter relevant notifications for this user
    const relevant = all.filter((n) => {
      if (n.target_type === "all") return true;
      if (n.target_type === "user" && n.target_id === userProfile.id) return true;
      if (n.target_type === "role" && n.target_id === userProfile.access_role) return true;
      if (n.target_type === "scope" && (n.target_id === userProfile.ward_id || n.target_id === userProfile.lga_id)) {
        return true;
      }
      return false;
    });

    // Sort by created_at descending client-side
    relevant.sort((a, b) => {
      const tA = (a.created_at as any)?.seconds || Date.now();
      const tB = (b.created_at as any)?.seconds || Date.now();
      return tB - tA;
    });

    onUpdate(relevant);
  });
}

/**
 * Marks a notification as read for a specific user ID.
 */
export async function markNotificationAsRead(
  notificationId: string,
  userId: string
): Promise<void> {
  const notifRef = doc(db, "notifications", notificationId);
  await updateDoc(notifRef, {
    read_by: arrayUnion(userId),
  });
}

/**
 * Marks all given notifications as read for a specific user ID.
 */
export async function markAllNotificationsAsRead(
  notifications: NotificationItem[],
  userId: string
): Promise<void> {
  const unreadList = notifications.filter((n) => !n.read_by.includes(userId));
  await Promise.all(
    unreadList.map((n) => markNotificationAsRead(n.id, userId))
  );
}
