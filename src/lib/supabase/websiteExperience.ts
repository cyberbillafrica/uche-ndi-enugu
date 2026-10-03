/**
 * POLITICORE — Website Experience client service (Phase 23).
 *
 * Extends the Phase 22 Control Center configuration service with the
 * Branding/Theme and SEO surfaces. All authority stays server-side: reads
 * and writes go through the established RPCs (migration 0061), which gate
 * on `is_tenant_admin()` and enforce revision semantics; the client sends
 * configuration payloads only — never tenant or actor identity.
 *
 * Public rendering consumes ONLY the published projection
 * (`get_public_site_chrome(p_tenant_slug)`) — drafts never reach anon.
 */
import { getSupabaseClient } from "./config";
import type { BrandingConfig } from "@/lib/branding/presets";
import type {
  FooterConfig as ChromeFooterConfig,
  NavigationConfig as ChromeNavigationConfig,
} from "@/lib/chrome/types";
import {
  DEFAULT_FOOTER_CONFIG,
  DEFAULT_NAVIGATION_CONFIG,
  isValidFooterConfig,
  isValidNavigationConfig,
} from "@/lib/chrome/types";

/**
 * Public site slug (established tenant-resolution seam, gate §J/§21) —
 * the same convention every public page uses; never a client tenant id.
 */
export function siteSlug(): string {
  return process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
}

/** Published-only chrome projection for public rendering (gate §12/§19). */
export interface PublicSiteChrome {
  branding: BrandingConfig;
  seo: SeoConfig;
  /** Phase 25 — eligible published navigation (server-side filtered) + header presentation. */
  navigation: ChromeNavigationConfig;
  footer: ChromeFooterConfig;
  /** Canonical contact / social payloads the footer binds (never duplicated). */
  contact: Record<string, unknown>;
  social_links: Record<string, unknown>;
}

export async function getPublicSiteChrome(
  slug: string = siteSlug()
): Promise<PublicSiteChrome> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("get_public_site_chrome", {
    p_tenant_slug: slug,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Record<string, unknown>;
  // §17/§20: malformed published chrome fails safe to the parity defaults —
  // never a broken public shell. (The SQL projection already suppresses
  // disabled/module-dependent items; validity is re-checked here because the
  // renderer must never trust stored JSONB shape.)
  const navRaw = row.navigation as Record<string, unknown> | undefined;
  const footRaw = row.footer as Record<string, unknown> | undefined;
  return {
    branding: (row.branding ?? {}) as BrandingConfig,
    seo: (row.seo ?? {}) as SeoConfig,
    navigation:
      navRaw && isValidNavigationConfig(navRaw)
        ? navRaw
        : DEFAULT_NAVIGATION_CONFIG,
    footer: footRaw && isValidFooterConfig(footRaw) ? footRaw : DEFAULT_FOOTER_CONFIG,
    contact: (row.contact ?? {}) as Record<string, unknown>,
    social_links: (row.social_links ?? {}) as Record<string, unknown>,
  };
}

/** Published homepage composition for public rendering (gate §26). */
export interface PublishedHomepage {
  revision: number;
  sections: unknown[];
  published_at: string | null;
}

export async function getPublishedHomepage(
  slug: string = siteSlug()
): Promise<PublishedHomepage | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("get_published_homepage", {
    p_tenant_slug: slug,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { revision: number; sections: unknown[]; published_at: string | null }
    | undefined;
  if (!row) return null;
  return {
    revision: Number(row.revision ?? 0),
    sections: row.sections ?? [],
    published_at: row.published_at ?? null,
  };
}

/** ── SEO configuration (tenant-level website metadata, gate §11) ────────── */

export interface SeoConfig {
  title?: string;
  description?: string;
  og_title?: string;
  og_description?: string;
  keywords?: string[];
  canonical_url?: string;
  robots?: "index,follow" | "noindex,nofollow" | "index,nofollow" | "noindex,follow";
}

/** Admin preview read: the tenant's own draft (preview requires authority). */
export async function getSiteConfigPreview(
  area: "branding" | "seo" | "homepage" | "navigation" | "footer"
): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("get_site_config_preview", {
    p_area: area,
  });
  if (error) throw new Error(error.message);
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Bounded published-revision history for the Builder's rollback UI
 * (migration 0062; admin-gated server-side).
 */
export async function getSiteConfigHistory(
  area: "branding" | "seo" | "homepage" | "navigation" | "footer"
): Promise<{ revision: number; published_at: string | null }[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("get_site_config_history", {
    p_area: area,
  });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data : []) as {
    revision: number | string;
    published_at: string | null;
  }[]).map((r) => ({
    revision: Number(r.revision ?? 0),
    published_at: r.published_at ?? null,
  }));
}

/** Typed draft helpers over the Phase 22 primitives (revision-checked). */
export async function saveBrandingDraft(
  draft: BrandingConfig,
  baseRevision: number
): Promise<number> {
  const { saveSiteConfigDraft } = await import("./controlCenter");
  return saveSiteConfigDraft("branding", draft as Record<string, unknown>, baseRevision);
}

export async function publishBranding(
  baseRevision: number
): Promise<{ revision: number; published_at: string | null }> {
  const { publishSiteConfig } = await import("./controlCenter");
  return publishSiteConfig("branding", baseRevision);
}

export async function saveSeoDraft(
  draft: SeoConfig,
  baseRevision: number
): Promise<number> {
  const { saveSiteConfigDraft } = await import("./controlCenter");
  return saveSiteConfigDraft("seo", draft as Record<string, unknown>, baseRevision);
}

export async function publishSeo(
  baseRevision: number
): Promise<{ revision: number; published_at: string | null }> {
  const { publishSiteConfig } = await import("./controlCenter");
  return publishSiteConfig("seo", baseRevision);
}

// ── Phase 25: site chrome (navigation / footer) admin surface ─────────────
// Same authority model as branding/seo: the client sends configuration
// payloads only; migration 0063's RPCs resolve tenant + actor server-side,
// enforce revision conflicts, and audit every mutation (prompt §25–§27).

export async function saveNavigationDraft(
  draft: ChromeNavigationConfig,
  baseRevision: number
): Promise<number> {
  const { saveSiteConfigDraft } = await import("./controlCenter");
  return saveSiteConfigDraft("navigation", draft as Record<string, unknown>, baseRevision);
}

export async function publishNavigation(
  baseRevision: number
): Promise<{ revision: number; published_at: string | null }> {
  const { publishSiteConfig } = await import("./controlCenter");
  return publishSiteConfig("navigation", baseRevision);
}

export async function saveFooterDraft(
  draft: ChromeFooterConfig,
  baseRevision: number
): Promise<number> {
  const { saveSiteConfigDraft } = await import("./controlCenter");
  return saveSiteConfigDraft("footer", draft as Record<string, unknown>, baseRevision);
}

export async function publishFooter(
  baseRevision: number
): Promise<{ revision: number; published_at: string | null }> {
  const { publishSiteConfig } = await import("./controlCenter");
  return publishSiteConfig("footer", baseRevision);
}
