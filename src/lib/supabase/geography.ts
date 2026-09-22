/**
 * POLITICORE — Geography vertical slice (Phase 1B).
 *
 * Relational geography reads from PostgreSQL (states → senatorial_zones →
 * lgas → wards → polling_units) through the hosted data API. Replaces the
 * legacy multi-megabyte singleton geography fetch pattern for NEW code.
 * The legacy `src/data/electoral.ts` fallback remains untouched for the
 * existing Firebase app (controlled replacement, not premature deletion).
 *
 * World-readable reference data per Phase 1A policy — reads work for
 * anon (public site) and authenticated (portal) callers alike. Writes
 * are platform-admin-only and happen via migrations, not this module.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "./config";

export interface GeoState {
  id: string;
  name: string;
  code: string;
}
export interface GeoZone extends GeoState {
  state_id: string;
}
export interface GeoLga extends GeoZone {
  zone_id: string;
}
export interface GeoWard {
  id: string;
  lga_id: string;
  name: string;
  code: string;
}
export interface GeoPollingUnit {
  id: string;
  ward_id: string;
  lga_id: string;
  name: string;
  code: string;
  is_new: boolean;
}

/** All states (Enugu deployment: exactly one). */
export async function listStates(
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GeoState[]> {
  const { data, error } = await supabase.from("states").select("*").order("name");
  if (error) throw new Error(`geography: listStates failed: ${error.message}`);
  return (data ?? []) as GeoState[];
}

/** Senatorial zones, optionally filtered by state. */
export async function listZones(
  stateId?: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GeoZone[]> {
  let q = supabase.from("senatorial_zones").select("*").order("name");
  if (stateId) q = q.eq("state_id", stateId);
  const { data, error } = await q;
  if (error) throw new Error(`geography: listZones failed: ${error.message}`);
  return (data ?? []) as GeoZone[];
}

/** LGAs, optionally filtered by state or zone (sorted by name). */
export async function listLgas(
  filter: { stateId?: string; zoneId?: string } = {},
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GeoLga[]> {
  let q = supabase.from("lgas").select("*").order("name");
  if (filter.stateId) q = q.eq("state_id", filter.stateId);
  if (filter.zoneId) q = q.eq("zone_id", filter.zoneId);
  const { data, error } = await q;
  if (error) throw new Error(`geography: listLgas failed: ${error.message}`);
  return (data ?? []) as GeoLga[];
}

/** Wards of an LGA (paged — 260 total across 17 LGAs). */
export async function listWards(
  lgaId: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GeoWard[]> {
  const { data, error } = await supabase
    .from("wards")
    .select("*")
    .eq("lga_id", lgaId)
    .order("code");
  if (error) throw new Error(`geography: listWards failed: ${error.message}`);
  return (data ?? []) as GeoWard[];
}

/** Polling units of a ward (paged — callers should never fetch all 4,145). */
export async function listPollingUnits(
  wardId: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GeoPollingUnit[]> {
  const { data, error } = await supabase
    .from("polling_units")
    .select("*")
    .eq("ward_id", wardId)
    .order("code");
  if (error) throw new Error(`geography: listPollingUnits failed: ${error.message}`);
  return (data ?? []) as GeoPollingUnit[];
}

/** Polling units of an entire LGA (the PU's lga_id column makes this a
 *  single indexed lookup rather than a ward-join). */
export async function listLgaPollingUnits(
  lgaId: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<GeoPollingUnit[]> {
  const { data, error } = await supabase
    .from("polling_units")
    .select("*")
    .eq("lga_id", lgaId)
    .order("code");
  if (error) throw new Error(`geography: listLgaPollingUnits failed: ${error.message}`);
  return (data ?? []) as GeoPollingUnit[];
}

/** Resolved label chain for a scope id, e.g. "Enugu → Nkanu West → Agbani". */
export async function resolveScopeLabels(
  kind: "state" | "senatorial_zone" | "lga" | "ward" | "polling_unit",
  id: string,
  supabase: SupabaseClient = getSupabaseClient()
): Promise<string[]> {
  const table =
    kind === "state"
      ? "states"
      : kind === "senatorial_zone"
        ? "senatorial_zones"
        : kind === "lga"
          ? "lgas"
          : kind === "ward"
            ? "wards"
            : "polling_units";
  const { data, error } = await supabase.from(table).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`geography: resolveScopeLabels failed: ${error.message}`);
  if (!data) return [];

  switch (kind) {
    case "state":
      return [data.name];
    case "senatorial_zone": {
      const state = await resolveScopeLabels("state", data.state_id, supabase);
      return [...state, data.name];
    }
    case "lga": {
      const zone = await resolveScopeLabels("senatorial_zone", data.zone_id, supabase);
      return [...zone, data.name];
    }
    case "ward": {
      const lga = await resolveScopeLabels("lga", data.lga_id, supabase);
      return [...lga, data.name];
    }
    case "polling_unit": {
      const ward = await resolveScopeLabels("ward", data.ward_id, supabase);
      return [...ward, data.name];
    }
  }
}
