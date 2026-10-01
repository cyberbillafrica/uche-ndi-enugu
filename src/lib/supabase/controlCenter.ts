/**
 * POLITICORE — Control Center Core service (Phase 22).
 *
 * The administrative control plane for a tenant and its activated services,
 * per docs/Control-Center-Architecture-Gate.md:
 *
 *   CONTROL CENTER CONFIGURES THE PLATFORM; MODULES OWN THEIR DOMAIN OPERATIONS.
 *
 * This service owns NO security: every operation delegates authority to the
 * SECURITY DEFINER RPCs, the FORCE RLS policies and the server-resolved
 * identity. The client never sends tenant_id or actor identity, never
 * widens a query beyond what the RPC returns, and never mutates the
 * substrate tables directly.
 *
 * Phase 22 scope only: overview, service activation (entitlement-aware),
 * and the safe configuration foundation (draft/published + revision +
 * optimistic concurrency). Website-experience editors belong to later phases.
 */
import { getSupabaseClient } from "./config";

/** The four first-class tenant services — exactly `module_code_enum`. */
export type ServiceCode = "social" | "campaign" | "election" | "governance";

export const SERVICE_LABELS: Record<ServiceCode, string> = {
  social: "Social Force",
  campaign: "Campaign",
  election: "Election",
  governance: "Governance",
};

export interface ServiceStatus {
  module: ServiceCode;
  label: string;
  entitled: boolean;
  enabled: boolean;
  operational: boolean;
  enabled_at: string | null;
  config_revision: number;
}

/** Deterministic §24 status labels. */
export type ServiceStateLabel = "Active" | "Dormant" | "Not available";

export function serviceStateLabel(s: Pick<ServiceStatus, "entitled" | "enabled">): ServiceStateLabel {
  if (!s.entitled) return "Not available";
  return s.enabled ? "Active" : "Dormant";
}

export interface ControlCenterOverview {
  services: ServiceStatus[];
}

/** Control Center overview — server-resolved tenant; nothing browser-supplied. */
export async function getControlCenterOverview(): Promise<ControlCenterOverview> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("control_center_overview");
  if (error) throw new Error(error.message);
  const services = (data ?? []).map((r: Record<string, unknown>) => ({
    module: r.module as ServiceCode,
    label: (r.label as string) ?? SERVICE_LABELS[r.module as ServiceCode],
    entitled: Boolean(r.entitled),
    enabled: Boolean(r.enabled),
    operational: Boolean(r.operational),
    enabled_at: (r.enabled_at as string | null) ?? null,
    config_revision: Number(r.config_revision ?? 0),
  }));
  return { services };
}

export interface ActivationResult {
  module: ServiceCode;
  entitled: boolean;
  enabled: boolean;
  operational: boolean;
}

/**
 * Activate/deactivate a tenant service. Entitlement is enforced
 * server-side; the UI mirrors — never decides — authority.
 */
export async function setServiceEnabled(
  module: ServiceCode,
  enabled: boolean
): Promise<ActivationResult> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("set_tenant_module_enabled", {
    p_module: module,
    p_enabled: enabled,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return {
    module: (row?.module as ServiceCode) ?? module,
    entitled: Boolean(row?.entitled),
    enabled: Boolean(row?.enabled),
    operational: Boolean(row?.operational),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Configuration foundation (§13/§14) — primitives over the EXISTING
// public_site_settings columns. No editors in Phase 22.
// ─────────────────────────────────────────────────────────────────────────

export type SiteConfigArea =
  | "branding"
  | "navigation"
  | "footer"
  | "homepage"
  | "contact"
  | "social_links"
  | "seo";

export interface SiteConfigRecord {
  area: SiteConfigArea;
  revision: number;
  draft: Record<string, unknown> | null;
  published: Record<string, unknown> | null;
  published_at: string | null;
  published_by: string | null;
}

/** Admin read: draft + published state for one configuration area. */
export async function getSiteConfig(area: SiteConfigArea): Promise<SiteConfigRecord | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("get_site_config", { p_area: area });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    area: row.area as SiteConfigArea,
    revision: Number(row.revision ?? 0),
    draft: (row.draft as Record<string, unknown> | null) ?? null,
    published: (row.published as Record<string, unknown> | null) ?? null,
    published_at: (row.published_at as string | null) ?? null,
    published_by: (row.published_by as string | null) ?? null,
  };
}

/**
 * Roll back to a bounded previous published revision. Restores the
 * historical payload as the DRAFT through the normal validated path —
 * publish afterwards to make it live. History is never mutated.
 */
export async function rollbackSiteConfig(
  area: SiteConfigArea,
  historyRevision: number
): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("rollback_site_config", {
    p_area: area,
    p_history_revision: historyRevision,
  });
  if (error) throw new Error(error.message);
  return Number(Array.isArray(data) ? data[0] : data ?? 0);
}

/**
 * Save a draft against a known revision. Throws on revision conflict —
 * the caller re-reads and re-applies (last-writer-wins is prevented
 * server-side).
 */
export async function saveSiteConfigDraft(
  area: SiteConfigArea,
  draft: Record<string, unknown>,
  baseRevision: number
): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("save_site_config_draft", {
    p_area: area,
    p_draft: draft,
    p_base_revision: baseRevision,
  });
  if (error) throw new Error(error.message);
  return Number((Array.isArray(data) ? data[0] : data) ?? 0);
}

/** Publish the saved draft (draft → published), revision-checked. */
export async function publishSiteConfig(
  area: SiteConfigArea,
  baseRevision: number
): Promise<{ revision: number; published_at: string | null }> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("publish_site_config", {
    p_area: area,
    p_base_revision: baseRevision,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  return {
    revision: Number(row?.revision ?? 0),
    published_at: (row?.published_at as string | null) ?? null,
  };
}
