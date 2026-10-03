/**
 * POLITICORE — Site chrome configuration contracts (Phase 25).
 *
 * Typed shape of the `public_site_settings.navigation` / `.footer` areas
 * (Phase 21 gate §12/§13/§14/§20; prompt §4–§11). The database (migration
 * 0063) enforces the same allowlists server-side — these helpers mirror the
 * rules for editor-side defense in depth only; the server always re-derives
 * authority.
 *
 * Declarative configuration only: no executable fields, no CSS/class
 * strings, no component names. Destinations are bounded to internal paths,
 * #fragments and http(s) URLs (never javascript:/data:/vbscript:/file:/
 * about:). Navigation visibility (`public`/`authenticated`) is presentation
 * state — NEVER authorization (prompt §9); protected routes stay
 * server/DB-authoritative.
 */

export const CHROME_SERVICE_DEPENDENCIES = [
  "social",
  "campaign",
  "election",
  "governance",
] as const;
export type ChromeServiceDependency = (typeof CHROME_SERVICE_DEPENDENCIES)[number];

export const CHROME_ITEM_TYPES = ["internal", "external", "anchor"] as const;
export type ChromeItemType = (typeof CHROME_ITEM_TYPES)[number];

export const CHROME_VISIBILITIES = ["public", "authenticated"] as const;
export type ChromeVisibility = (typeof CHROME_VISIBILITIES)[number];

/** Bounded presentation vocabularies — never arbitrary CSS (prompt §21). */
export const CHROME_ITEM_STYLES = ["default", "underline", "pill"] as const;
export type ChromeItemStyle = (typeof CHROME_ITEM_STYLES)[number];
export const HEADER_MOBILE_MENUS = ["accordion", "drawer"] as const;
export type HeaderMobileMenu = (typeof HEADER_MOBILE_MENUS)[number];
export const HEADER_ALIGNMENTS = ["left", "center", "right"] as const;
export type HeaderAlignment = (typeof HEADER_ALIGNMENTS)[number];
export const FOOTER_LAYOUTS = ["columns-3", "columns-4"] as const;
export type FooterLayout = (typeof FOOTER_LAYOUTS)[number];

export interface ChromeLink {
  label: string;
  /** Internal path (/…), fragment (#…) or http(s) URL — validated. */
  href: string;
  /** REQUIRED verbatim on external (http(s)) links; forbidden internally. */
  rel?: "noopener noreferrer";
}

export interface ChromeNavItem {
  /** Stable identity — never array position (prompt §4). */
  id: string;
  label: string;
  href: string;
  type: ChromeItemType;
  visibility: ChromeVisibility;
  /** Elapsed flag: a disabled item is suppressed server-side at projection. */
  enabled?: boolean;
  /** Module code — a deactivated module hides the item server-side. */
  service_dependency?: ChromeServiceDependency | "";
  presentation?: { style?: ChromeItemStyle; emphasis?: boolean };
  /** Exactly one bounded child level (dropdown groups, ≤ 8 children). */
  children?: ChromeNavItem[];
}

export interface HeaderCta {
  enabled: boolean;
  label?: string;
  href?: string;
}

export interface HeaderConfig {
  show_logo?: boolean;
  show_site_name?: boolean;
  show_primary_nav?: boolean;
  cta?: HeaderCta;
  mobile_menu?: HeaderMobileMenu;
  alignment?: HeaderAlignment;
}

export interface NavigationConfig {
  items?: ChromeNavItem[];
  header?: HeaderConfig;
}

export interface FooterColumn {
  id: string;
  heading: string;
  links?: ChromeLink[];
}

export interface FooterConfig {
  columns?: FooterColumn[];
  legal?: {
    /** Literal text; `{year}` is substituted at render time. */
    copyright?: string;
    links?: ChromeLink[];
  };
  /** Placement only — link data stays canonical in `social_links`. */
  social?: { show?: boolean };
  presentation?: {
    layout?: FooterLayout;
    show_contact?: boolean;
    show_cta?: boolean;
    cta_heading?: string;
    cta_label?: string;
    cta_href?: string;
  };
}

// ── Defaults: behavioral parity with the pre-Phase-25 hard-coded chrome ────

export const DEFAULT_NAVIGATION_CONFIG: NavigationConfig = {
  items: [
    { id: "home", label: "Home", href: "/", type: "internal", visibility: "public" },
    { id: "biography", label: "Biography", href: "/biography", type: "internal", visibility: "public" },
    { id: "agenda", label: "Our Agenda", href: "/manifesto", type: "internal", visibility: "public" },
    { id: "news", label: "News", href: "/news", type: "internal", visibility: "public" },
    { id: "gallery", label: "Gallery", href: "/gallery", type: "internal", visibility: "public" },
    { id: "contact", label: "Contact", href: "/contact", type: "internal", visibility: "public" },
    { id: "governance", label: "Governance", href: "/governance", type: "internal", visibility: "public" },
  ],
  header: {
    show_logo: true,
    show_site_name: true,
    show_primary_nav: true,
    cta: { enabled: true, label: "Get Involved", href: "/volunteer" },
    mobile_menu: "accordion",
    alignment: "right",
  },
};

export const DEFAULT_FOOTER_CONFIG: FooterConfig = {
  columns: [
    {
      id: "explore",
      heading: "Explore",
      links: [
        { label: "Biography", href: "/biography" },
        { label: "Our Agenda", href: "/manifesto" },
        { label: "News", href: "/news" },
        { label: "Gallery", href: "/gallery" },
        { label: "Events", href: "/#events" },
      ],
    },
    {
      id: "involved",
      heading: "Get Involved",
      links: [
        { label: "Join the Movement", href: "/volunteer" },
        { label: "Member Portal", href: "/portal/dashboard" },
        { label: "User Guide & Manual", href: "/documentation" },
        { label: "Contact Us", href: "/contact" },
      ],
    },
  ],
  legal: {
    copyright: "© {year} Uche Nnaji Campaign. All rights reserved.",
    links: [
      { label: "CyberBill Africa", href: "https://cyberbillafrica.com", rel: "noopener noreferrer" },
    ],
  },
  social: { show: true },
  presentation: {
    layout: "columns-4",
    show_contact: true,
    show_cta: true,
    cta_heading: "Enugu, our future is in our hands.",
    cta_label: "Get Involved",
    cta_href: "/volunteer",
  },
};

// ── Client-side validation (defense in depth; SQL 0063 is authoritative) ──

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_SCHEME_RE = /^\s*(javascript|data|vbscript|file|about):/i;

export function isSafeChromeHref(href: unknown): href is string {
  if (typeof href !== "string") return false;
  const v = href.trim();
  if (v.length === 0 || v.length > 2000) return false;
  if (FORBIDDEN_SCHEME_RE.test(v)) return false;
  return v.startsWith("/") || v.startsWith("#") || /^https?:\/\/\S+$/i.test(v);
}

function isChromeLink(v: unknown): v is ChromeLink {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.label !== "string" || o.label.trim().length === 0 || o.label.length > 120)
    return false;
  if (!isSafeChromeHref(o.href)) return false;
  if (/^https?:\/\//i.test(o.href)) {
    if (o.rel !== "noopener noreferrer") return false;
  } else if (o.rel !== undefined) {
    return false;
  }
  return Object.keys(o).every((k) => ["label", "href", "rel"].includes(k));
}

function isChromeNavItem(v: unknown, depth: number): v is ChromeNavItem {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return false;
  if (typeof o.label !== "string" || o.label.trim().length === 0 || o.label.length > 120)
    return false;
  if (!CHROME_ITEM_TYPES.includes(o.type as ChromeItemType)) return false;
  if (!CHROME_VISIBILITIES.includes(o.visibility as ChromeVisibility)) return false;
  if (
    o.service_dependency !== undefined &&
    o.service_dependency !== "" &&
    !CHROME_SERVICE_DEPENDENCIES.includes(o.service_dependency as ChromeServiceDependency)
  )
    return false;
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") return false;
  if (!isSafeChromeHref(o.href)) return false;
  if (o.presentation !== undefined) {
    const p = o.presentation as Record<string, unknown>;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
    if (p.style !== undefined && !CHROME_ITEM_STYLES.includes(p.style as ChromeItemStyle))
      return false;
    if (p.emphasis !== undefined && typeof p.emphasis !== "boolean") return false;
    if (!Object.keys(p).every((k) => ["style", "emphasis"].includes(k))) return false;
  }
  if (o.children !== undefined) {
    if (depth > 0) return false;
    if (!Array.isArray(o.children) || o.children.length > 8) return false;
    if (!o.children.every((c) => isChromeNavItem(c, depth + 1))) return false;
  }
  return Object.keys(o).every((k) =>
    ["id", "label", "href", "type", "visibility", "enabled", "service_dependency", "presentation", "children"].includes(k)
  );
}

/** Full navigation-area check mirroring cc_validate_navigation. */
export function isValidNavigationConfig(v: unknown): v is NavigationConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Object.keys(o).every((k) => ["items", "header"].includes(k))) return false;
  if (o.items !== undefined) {
    if (!Array.isArray(o.items) || o.items.length > 12) return false;
    if (!o.items.every((i) => isChromeNavItem(i, 0))) return false;
    const ids = new Set(o.items.map((i) => (i as ChromeNavItem).id));
    const labels = new Set(o.items.map((i) => (i as ChromeNavItem).label.toLowerCase()));
    if (ids.size !== o.items.length || labels.size !== o.items.length) return false;
  }
  if (o.header !== undefined) {
    const h = o.header as Record<string, unknown>;
    if (typeof h !== "object" || h === null || Array.isArray(h)) return false;
    if (!Object.keys(h).every((k) =>
      ["show_logo", "show_site_name", "show_primary_nav", "cta", "mobile_menu", "alignment"].includes(k)
    ))
      return false;
    for (const b of ["show_logo", "show_site_name", "show_primary_nav"] as const) {
      if (h[b] !== undefined && typeof h[b] !== "boolean") return false;
    }
    if (h.mobile_menu !== undefined && !HEADER_MOBILE_MENUS.includes(h.mobile_menu as HeaderMobileMenu))
      return false;
    if (h.alignment !== undefined && !HEADER_ALIGNMENTS.includes(h.alignment as HeaderAlignment))
      return false;
    if (h.cta !== undefined) {
      const c = h.cta as Record<string, unknown>;
      if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
      if (!Object.keys(c).every((k) => ["enabled", "label", "href"].includes(k))) return false;
      if (c.enabled === true) {
        if (typeof c.label !== "string" || c.label.trim().length === 0 || c.label.length > 60)
          return false;
        if (!isSafeChromeHref(c.href)) return false;
      }
    }
  }
  return true;
}

/** Full footer-area check mirroring cc_validate_footer. */
export function isValidFooterConfig(v: unknown): v is FooterConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Object.keys(o).every((k) => ["columns", "legal", "social", "presentation"].includes(k)))
    return false;
  if (o.columns !== undefined) {
    if (!Array.isArray(o.columns) || o.columns.length > 4) return false;
    const ids = new Set<string>();
    for (const raw of o.columns) {
      const c = raw as Record<string, unknown>;
      if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
      if (!Object.keys(c).every((k) => ["id", "heading", "links"].includes(k))) return false;
      if (typeof c.id !== "string" || !ID_RE.test(c.id)) return false;
      ids.add(c.id);
      if (typeof c.heading !== "string" || c.heading.trim().length === 0 || c.heading.length > 60)
        return false;
      if (c.links !== undefined) {
        if (!Array.isArray(c.links) || c.links.length > 8) return false;
        if (!c.links.every((l) => isChromeLink(l))) return false;
      }
    }
    if (ids.size !== o.columns.length) return false;
  }
  if (o.legal !== undefined) {
    const l = o.legal as Record<string, unknown>;
    if (typeof l !== "object" || l === null || Array.isArray(l)) return false;
    if (!Object.keys(l).every((k) => ["copyright", "links"].includes(k))) return false;
    if (l.copyright !== undefined) {
      if (typeof l.copyright !== "string" || l.copyright.length > 160) return false;
    }
    if (l.links !== undefined) {
      if (!Array.isArray(l.links) || l.links.length > 6) return false;
      if (!l.links.every((x) => isChromeLink(x))) return false;
    }
  }
  if (o.social !== undefined) {
    const s = o.social as Record<string, unknown>;
    if (typeof s !== "object" || s === null || Array.isArray(s)) return false;
    if (!Object.keys(s).every((k) => k === "show")) return false;
    if (s.show !== undefined && typeof s.show !== "boolean") return false;
  }
  if (o.presentation !== undefined) {
    const p = o.presentation as Record<string, unknown>;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
    if (!Object.keys(p).every((k) =>
      ["layout", "show_contact", "show_cta", "cta_heading", "cta_label", "cta_href"].includes(k)
    ))
      return false;
    if (p.layout !== undefined && !FOOTER_LAYOUTS.includes(p.layout as FooterLayout)) return false;
    for (const b of ["show_contact", "show_cta"] as const) {
      if (p[b] !== undefined && typeof p[b] !== "boolean") return false;
    }
    if (p.cta_label !== undefined) {
      if (typeof p.cta_label !== "string" || p.cta_label.trim().length === 0 || p.cta_label.length > 60)
        return false;
    }
    if (p.cta_heading !== undefined) {
      if (typeof p.cta_heading !== "string" || p.cta_heading.trim().length === 0 || p.cta_heading.length > 120)
        return false;
    }
    if (p.cta_href !== undefined && !isSafeChromeHref(p.cta_href)) return false;
  }
  return true;
}
