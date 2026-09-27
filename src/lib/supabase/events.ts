/**
 * POLITICORE — Canonical Events service (Phase 4).
 *
 * Events are PUBLIC website content with their own table
 * (politicore.events), lifecycle (draft/published/cancelled), and RLS:
 * anonymous visitors read published rows only; tenant admins manage their
 * tenant's events server-side (current_tenant_id() + is_tenant_admin()
 * inside the policies — no client-supplied tenant boundary).
 *
 * Events are NOT Campaign Activities (locked Campaign domain) and are not
 * part of any combined content model.
 */

import { getSupabaseClient } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

export type EventStatus = "draft" | "published" | "cancelled";

export interface SiteEvent {
  id: string;
  tenant_id: string;
  title: string;
  description: string;
  event_date: string; // YYYY-MM-DD
  event_time: string; // HH:MM
  venue: string;
  ward_id: string | null;
  status: EventStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventInput {
  title: string;
  description: string;
  eventDate: string; // YYYY-MM-DD
  eventTime: string; // HH:MM
  venue: string;
  wardId: string | null;
  status: EventStatus;
}

/**
 * Published events (public + admin reads). Upcoming-only: today or future
 * by event_date, ascending — preserving the legacy homepage contract.
 * RLS guarantees non-admins see published rows only.
 */
export async function listPublishedEvents(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<SiteEvent[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("status", "published")
    .gte("event_date", today.toISOString().split("T")[0])
    .order("event_date", { ascending: true });
  if (error) throw new Error(`events: listPublishedEvents failed: ${error.message}`);
  return (data ?? []) as SiteEvent[];
}

/** All tenant events for management (RLS: tenant admins see every status). */
export async function listEvents(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<SiteEvent[]> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .order("event_date", { ascending: false });
  if (error) throw new Error(`events: listEvents failed: ${error.message}`);
  return (data ?? []) as SiteEvent[];
}

export async function createEvent(
  input: EventInput,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<SiteEvent> {
  const { data, error } = await supabase
    .from("events")
    .insert({
      title: input.title,
      description: input.description,
      event_date: input.eventDate,
      event_time: input.eventTime,
      venue: input.venue,
      ward_id: input.wardId,
      status: input.status,
    })
    .select()
    .single();
  if (error) throw new Error(`events: createEvent failed: ${error.message}`);
  return data as SiteEvent;
}

export async function updateEvent(
  id: string,
  patch: Partial<EventInput>,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.description !== undefined) update.description = patch.description;
  if (patch.eventDate !== undefined) update.event_date = patch.eventDate;
  if (patch.eventTime !== undefined) update.event_time = patch.eventTime;
  if (patch.venue !== undefined) update.venue = patch.venue;
  if (patch.wardId !== undefined) update.ward_id = patch.wardId;
  if (patch.status !== undefined) update.status = patch.status;
  const { error } = await supabase.from("events").update(update).eq("id", id);
  if (error) throw new Error(`events: updateEvent failed: ${error.message}`);
}

export async function deleteEvent(
  id: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<void> {
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) throw new Error(`events: deleteEvent failed: ${error.message}`);
}
