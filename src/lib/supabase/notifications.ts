/**
 * POLITICORE — Notifications vertical slice (Phase 1B).
 *
 * Per-user notifications through PostgreSQL/Supabase, replacing the
 * legacy tenant-wide collection download with client-side filtering
 * (the acknowledged Firestore privacy/performance defect).
 *
 * Semantics preserved from the existing product:
 *  - strictly per-user rows (RLS: user_id = auth.uid())
 *  - read/unread state, unread count
 *  - creation is an administrative act (tenant admins/platform admins);
 *    RLS denies ordinary members from creating notifications for others
 *
 * Optional Realtime: `watchNotifications` uses postgres_changes on the
 * notifications table (registered for realtime in migration 0009).
 * Enable selectively — spec §22 forbids enabling realtime indiscriminately.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "./config";

export type NotificationType =
  | "task"
  | "assignment"
  | "activity"
  | "election"
  | "system"
  | "announcement";

export interface PolitiCoreNotification {
  id: string;
  user_id: string;
  tenant_id: string;
  type: NotificationType;
  title: string;
  message: string;
  link_url: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * The current user's notifications, newest first.
 * RLS guarantees these are the caller's own rows regardless of filters.
 */
export async function listMyNotifications(
  options: { unreadOnly?: boolean; limit?: number } = {},
  supabase: SupabaseClient = getSupabaseClient()
): Promise<PolitiCoreNotification[]> {
  let q = supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false });
  if (options.unreadOnly) q = q.is("read_at", null);
  if (options.limit) q = q.limit(options.limit);
  const { data, error } = await q;
  if (error) throw new Error(`notifications: list failed: ${error.message}`);
  return (data ?? []) as PolitiCoreNotification[];
}

/** Server-side unread count (RPC; zero round-trip of rows). */
export async function myUnreadCount(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<number> {
  const { data, error } = await supabase.rpc("my_unread_count");
  if (error) throw new Error(`notifications: unread count failed: ${error.message}`);
  return Number(data ?? 0);
}

/** Mark specific notifications read (own rows only — enforced by the RPC). */
export async function markNotificationsRead(
  ids: string[],
  supabase: SupabaseClient = getSupabaseClient()
): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await supabase.rpc("mark_notifications_read", { p_ids: ids });
  if (error) throw new Error(`notifications: mark read failed: ${error.message}`);
  return Number(data ?? 0);
}

/** Mark every unread notification of the caller as read (two calls). */
export async function markAllRead(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<number> {
  const unread = await listMyNotifications({ unreadOnly: true }, supabase);
  return markNotificationsRead(unread.map((n) => n.id), supabase);
}

/**
 * Admin path: create a notification for a member of the same tenant.
 * RLS denies this for non-admins — surfaced as a thrown error.
 */
export async function adminNotifyMember(
  input: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    linkUrl?: string;
  },
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { data: me } = await supabase.rpc("my_tenant_id");
  const { error } = await supabase.from("notifications").insert({
    user_id: input.userId,
    tenant_id: me as string,
    type: input.type,
    title: input.title,
    message: input.message,
    link_url: input.linkUrl ?? null,
  });
  if (error) throw new Error(`notifications: admin insert denied or failed: ${error.message}`);
}

/**
 * Realtime updates for the current user's notifications (optional).
 * Returns an unsubscribe function. The channel is user-scoped; RLS
 * applies to realtime payloads exactly as to REST reads.
 */
export function watchNotifications(
  onEvent: () => void,
  supabase: SupabaseClient = getSupabaseClient()
): () => void {
  const channel: RealtimeChannel = supabase
    .channel("politicore-notifications")
    .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => onEvent())
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to the current user's notifications — the portal bell
 * contract. Combines an initial RLS-scoped fetch (newest first) with
 * postgres_changes realtime; every subsequent change re-fetches through
 * the same authorized path, so the rendered rows are always exactly the
 * RLS-permitted set (no client-side recipient filtering ever).
 *
 * Returns an unsubscribe function. Safe against post-unsubscribe
 * emissions (a local flag guards the callback).
 */
export function subscribeMyNotifications(
  onUpdate: (notifications: PolitiCoreNotification[]) => void,
  supabase: SupabaseClient = getSupabaseClient()
): () => void {
  let active = true;

  const refresh = async () => {
    try {
      const rows = await listMyNotifications({ limit: 50 }, supabase);
      if (active) onUpdate(rows);
    } catch (error) {
      console.error("notifications: subscribe refresh failed:", error);
      if (active) onUpdate([]);
    }
  };

  void refresh();

  const unsubscribeRealtime = watchNotifications(() => {
    void refresh();
  }, supabase);

  return () => {
    active = false;
    unsubscribeRealtime();
  };
}
