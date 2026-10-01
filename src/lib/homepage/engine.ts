/**
 * POLITICORE — Homepage section engine (Phase 24).
 *
 * The SINGLE rendering pipeline for the configurable homepage (public page
 * AND admin preview — §21: never two renderers). Responsibilities:
 *
 *   1. ELIGIBILITY (§12): section.enabled AND service dependency enabled
 *      AND content-publication conditions. Service disablement never
 *      mutates configuration — it only suppresses rendering.
 *   2. DATA (§14/§33): bounded fetches from EXISTING canonical public
 *      services — never duplicate/shadow queries, never private tables.
 *   3. ISOLATION (§20): every section's data resolution is try/catch'd;
 *      one failing section renders its fallback state and cannot blank
 *      the page.
 */
import {
  sectionDefinition,
  type SectionInstance,
  type SectionConfig,
} from "./registry";
import { siteSlug } from "@/lib/supabase/websiteExperience";
import {
  listPublishedNews,
  type NewsArticle,
} from "@/lib/supabase/news";
import {
  listPublishedEvents,
  type SiteEvent,
} from "@/lib/supabase/events";
import { getGallery } from "@/lib/supabase/content";
import {
  listPublicGovernanceProjects,
  listPublicGovernanceCommitments,
  listPublicGovernanceParticipate,
  listPublicGovernanceRequestStats,
  listPublicGovernanceHub,
  type PublicGovernanceProjectSummary,
  type PublicGovernanceCommitmentSummary,
  type PublicGovernanceParticipateItem,
  type PublicGovernanceRequestStat,
  type PublicGovernanceHub,
} from "@/lib/supabase/governance";

export type ModuleKey = "social" | "campaign" | "election" | "governance";

export interface HomepageModuleState {
  modules: Record<ModuleKey, boolean>;
}

/**
 * Resolve each service's enabled state for eligibility evaluation. Reads
 * the caller's own tenant_modules via the existing SECURITY DEFINER
 * overview RPC (activation authority stays server-side; no new module
 * gate). Anonymous contexts get all-false — public rendering receives
 * eligibility from the server component instead.
 */
export async function loadModuleState(
  supabase: import("@supabase/supabase-js").SupabaseClient
): Promise<HomepageModuleState> {
  const { data, error } = await supabase.rpc("control_center_overview");
  const modules: Record<ModuleKey, boolean> = {
    social: false, campaign: false, election: false, governance: false,
  };
  if (!error && Array.isArray(data)) {
    for (const row of data as { module: string; enabled: boolean }[]) {
      if (row.module in modules) modules[row.module as ModuleKey] = Boolean(row.enabled);
    }
  }
  return { modules };
}

export type SectionData =
  | { status: "ok"; news?: NewsArticle[]; events?: SiteEvent[] }
  | { status: "error" };

export interface ResolvedSection {
  section: SectionInstance;
  /** Eligible = enabled AND service dependency satisfied (§12). */
  eligible: boolean;
  /** Why the section was suppressed (admin diagnostics only). */
  reason?: "disabled" | "service_off" | "unknown_type";
  data: SectionData;
}

async function tryLoad<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error("[homepage] section data failed:", err);
    return null;
  }
}

/**
 * Resolve data for one section with strict failure isolation (§20): any
 * error degrades to `status: "error"` and the renderer draws the section's
 * safe empty/fallback state.
 */
export async function resolveSectionData(
  section: SectionInstance
): Promise<SectionData> {
  const def = sectionDefinition(section.section_type);
  if (!def) return { status: "error" }; // unknown type → engine-level skip
  const cfg = (section.config ?? {}) as SectionConfig;
  const limit = Math.min(Math.max(cfg.item_count ?? 3, 1), 12);
  const slug = siteSlug();

  switch (section.section_type) {
    case "news": {
      const news = await tryLoad(() => listPublishedNews(limit));
      return news === null ? { status: "error" } : { status: "ok", news };
    }
    case "events": {
      const events = await tryLoad(() => listPublishedEvents());
      const trimmed = events === null ? null : events.slice(0, limit);
      return trimmed === null ? { status: "error" } : { status: "ok", events: trimmed };
    }
    case "governance_projects": {
      const items = await tryLoad(() => listPublicGovernanceProjects(slug));
      return items === null
        ? { status: "error" }
        : { status: "ok", data: items.slice(0, limit) } as SectionData;
    }
    case "governance_commitments": {
      const items = await tryLoad(() => listPublicGovernanceCommitments(slug));
      return items === null
        ? { status: "error" }
        : { status: "ok", data: items.slice(0, limit) } as SectionData;
    }
    case "public_participation": {
      const items = await tryLoad(() => listPublicGovernanceParticipate(slug));
      return items === null
        ? { status: "error" }
        : { status: "ok", data: items.slice(0, limit) } as SectionData;
    }
    case "public_accountability": {
      const items = await tryLoad(() => listPublicGovernanceRequestStats(slug));
      return items === null
        ? { status: "error" }
        : { status: "ok", data: items.slice(0, 8) } as SectionData;
    }
    case "governance_updates": {
      const items = await tryLoad(() => listPublicGovernanceHub(slug));
      return items === null
        ? { status: "error" }
        : { status: "ok", data: items.slice(0, limit) } as SectionData;
    }
    case "gallery": {
      const g = await tryLoad(() => getGallery());
      return g === null ? { status: "error" } : { status: "ok", data: g } as SectionData;
    }
    default:
      // Presentation sections and content sections without list data
      // (biography/manifesto/election_countdown/contact_cta) need no fetch.
      return { status: "ok" };
  }
}

/**
 * Section-level eligibility (§12). Content publication conditions for
 * content-backed sections are additionally enforced at render time from
 * the resolved data (empty/error → safe empty state), never by bypassing
 * module visibility rules.
 */
export function isSectionEligible(
  section: SectionInstance,
  modules: Record<ModuleKey, boolean> | null
): { eligible: boolean; reason?: "disabled" | "service_off" | "unknown_type" } {
  if (!sectionDefinition(section.section_type)) {
    return { eligible: false, reason: "unknown_type" };
  }
  if (section.enabled === false) return { eligible: false, reason: "disabled" };
  const dep = section.service_dependency ?? null;
  if (dep && modules && modules[dep] === false) {
    return { eligible: false, reason: "service_off" };
  }
  return { eligible: true };
}

/**
 * Resolve a whole composition — bounded, isolated, ordered by
 * display_order. Used by BOTH the public homepage and the admin preview
 * (same engine, §21/§31).
 */
export async function resolveComposition(
  sections: SectionInstance[],
  modules: Record<ModuleKey, boolean> | null
): Promise<ResolvedSection[]> {
  const ordered = [...sections].sort((a, b) => a.display_order - b.display_order);
  const out: ResolvedSection[] = [];
  for (const section of ordered) {
    const { eligible, reason } = isSectionEligible(section, modules);
    if (!eligible) {
      out.push({ section, eligible: false, reason, data: { status: "ok" } });
      continue;
    }
    const data = await resolveSectionData(section);
    out.push({ section, eligible: true, data });
  }
  return out;
}

// Re-exported for renderer typing convenience.
export type {
  PublicGovernanceProjectSummary,
  PublicGovernanceCommitmentSummary,
  PublicGovernanceParticipateItem,
  PublicGovernanceRequestStat,
  PublicGovernanceHub,
};
