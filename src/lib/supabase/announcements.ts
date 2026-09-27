/**
 * POLITICORE — Canonical Announcements service (Phase 4).
 *
 * Announcements are AUTHENTICATED tenant communications with their own
 * table (politicore.announcements) and RLS: anonymous users receive no
 * data (no anon grant); authenticated members read published rows in
 * their membership scope within their own tenant; tenant admins manage.
 * A published announcement is still private — never public website
 * content, never on the public homepage, never a Notification.
 */

import { getSupabaseClient } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AnnouncementScope =
  | "general"
  | "campaign_members"
  | "social_members"
  | "election_officers"
  | "admins";

export type AnnouncementStatus = "draft" | "published" | "archived";

export interface PortalAnnouncement {
  id: string;
  tenant_id: string;
  title: string;
  content: string;
  scope: AnnouncementScope;
  status: AnnouncementStatus;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementInput {
  title: string;
  content: string;
  scope: AnnouncementScope;
  status: AnnouncementStatus;
}

/** Published announcements visible to the current session (RLS-scoped). */
export async function listAnnouncements(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<PortalAnnouncement[]> {
  const { data, error } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`announcements: listAnnouncements failed: ${error.message}`);
  return (data ?? []) as PortalAnnouncement[];
}

/** Full tenant list for management (drafts + archives included for admins). */
export async function listAllAnnouncements(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<PortalAnnouncement[]> {
  return listAnnouncements(supabase);
}

export async function createAnnouncement(
  input: AnnouncementInput,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<PortalAnnouncement> {
  const { data, error } = await supabase
    .from("announcements")
    .insert({
      title: input.title,
      content: input.content,
      scope: input.scope,
      status: input.status,
      published_at: input.status === "published" ? new Date().toISOString() : null,
    })
    .select()
    .single();
  if (error) throw new Error(`announcements: createAnnouncement failed: ${error.message}`);
  return data as PortalAnnouncement;
}

export async function updateAnnouncement(
  id: string,
  patch: Partial<AnnouncementInput>,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.content !== undefined) update.content = patch.content;
  if (patch.scope !== undefined) update.scope = patch.scope;
  if (patch.status !== undefined) {
    update.status = patch.status;
    update.published_at =
      patch.status === "published"
        ? new Date().toISOString()
        : patch.status === "draft"
          ? null
          : undefined;
  }
  const { error } = await supabase.from("announcements").update(update).eq("id", id);
  if (error) throw new Error(`announcements: updateAnnouncement failed: ${error.message}`);
}

export async function deleteAnnouncement(
  id: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase.from("announcements").delete().eq("id", id);
  if (error) throw new Error(`announcements: deleteAnnouncement failed: ${error.message}`);
}
