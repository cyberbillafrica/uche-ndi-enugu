/**
 * POLITICORE — Homepage Builder: typed section registry (Phase 24).
 *
 * The application owns section DEFINITIONS (code, versioned with the app);
 * the database stores declarative section INSTANCES only (validated by
 * migration 0062 against the same allowlist). No component names, module
 * paths, HTML or executable content exist in configuration — the engine
 * resolves `section_type` to a React component HERE, never from JSONB.
 *
 * Registry contract (§6): a registry entry answers —
 *   is this section type known?        → HOMEPAGE_SECTION_TYPES / SECTIONS
 *   is its config valid?               → validateConfig (per-type schema)
 *   what are its defaults?             → defaultConfig
 *   what service does it depend on?    → serviceDependency
 *   how should it render?              → component (code-side mapping)
 *   is it content-backed?              → group
 */

export type ServiceDependency = "social" | "campaign" | "election" | "governance";

/** §7 content-backed section types (canonical data sources). */
export type ContentSectionType =
  | "news"
  | "events"
  | "biography"
  | "manifesto"
  | "gallery"
  | "governance_projects"
  | "governance_commitments"
  | "governance_updates"
  | "public_accountability"
  | "public_participation"
  | "election_countdown"
  | "contact_cta";

/** §7 presentation / marketing section types. */
export type PresentationSectionType =
  | "hero"
  | "rich_text"
  | "image_text"
  | "feature_cards"
  | "statistics"
  | "cta"
  | "quote"
  | "video"
  | "link_cards"
  | "divider";

export type SectionType = ContentSectionType | PresentationSectionType;

/** Controlled link target (§19): internal path or absolute http(s) only. */
export interface SafeLink {
  label: string;
  href: string;
}

export interface MediaRef {
  asset_id: string;
  alt?: string;
}

/** Per-type declarative configuration (validated; never executable). */
export interface SectionConfig {
  // Shared presentation knobs (subset per type).
  heading?: string;
  label?: string;
  description?: string;
  body?: string;
  quote?: string;
  attribution?: string;
  eyebrow?: string;
  title?: string;
  item_count?: number; // 1..12
  layout?: "grid" | "list" | "carousel" | "featured";
  show_excerpt?: boolean;
  alignment?: "left" | "center" | "right";
  image_side?: "left" | "right";
  background_variant?: "brand" | "dark" | "light" | "gradient" | "surface";
  style?: "space" | "line" | "dots";
  cta?: SafeLink;
  primary_cta?: SafeLink;
  secondary_cta?: SafeLink | null;
  image?: MediaRef;
  poster?: MediaRef;
  video_url?: string;
  cards?: CardItem[];
  items?: StatItem[];
}

export interface CardItem {
  title?: string;
  description?: string;
  icon?: string;
  image?: MediaRef;
  href?: string;
  value?: string;
  label?: string;
}

export interface StatItem {
  value: string;
  label: string;
}

/** A stored section instance (mirrors migration 0062's validator). */
export interface SectionInstance {
  stable_id: string;
  section_type: SectionType;
  display_order: number;
  enabled: boolean;
  config: SectionConfig;
  service_dependency?: ServiceDependency | null;
  presentation?: {
    background_variant?: "brand" | "dark" | "light" | "gradient" | "surface";
    padding?: "sm" | "md" | "lg";
    width?: "normal" | "wide" | "full";
    align?: "left" | "center" | "right";
  };
}

export type SectionGroup = "content" | "presentation";

export interface SectionDefinition {
  type: SectionType;
  label: string;
  /** Short UI description shown in the section library. */
  description: string;
  group: SectionGroup;
  serviceDependency: ServiceDependency | null;
  defaultConfig: SectionConfig;
  /** Bounded config schema used by the admin editor + validator. */
  schema: SectionField[];
}

export type SectionField =
  | { kind: "text"; key: keyof SectionConfig & string; label: string; max: number; multiline?: boolean }
  | { kind: "number"; key: keyof SectionConfig & string; label: string; min: number; max: number }
  | { kind: "boolean"; key: keyof SectionConfig & string; label: string }
  | { kind: "select"; key: keyof SectionConfig & string; label: string; options: string[] }
  | { kind: "link"; key: keyof SectionConfig & string; label: string }
  | { kind: "media"; key: keyof SectionConfig & string; label: string };

const GRID: SectionConfig["layout"] = "grid";

/**
 * The architecture-approved initial catalog (§7). Defaults reproduce the
 * migrated hard-coded homepage's behavior so composition parity holds.
 */
export const SECTIONS: Record<SectionType, SectionDefinition> = {
  // ── Content-backed ──────────────────────────────────────────────────
  news: {
    type: "news",
    label: "Latest News",
    description: "Published news articles from the News module.",
    group: "content",
    serviceDependency: null,
    defaultConfig: { heading: "Latest News", item_count: 3, layout: GRID, show_excerpt: true, cta: { label: "View All", href: "/news" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "number", key: "item_count", label: "Items", min: 1, max: 12 },
      { kind: "select", key: "layout", label: "Layout", options: ["grid", "list", "featured"] },
      { kind: "boolean", key: "show_excerpt", label: "Show excerpt" },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  events: {
    type: "events",
    label: "Upcoming Events",
    description: "Upcoming published events from the Events module.",
    group: "content",
    serviceDependency: null,
    defaultConfig: { heading: "Upcoming Events", item_count: 3, layout: GRID, cta: { label: "All Events", href: "/events" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "number", key: "item_count", label: "Items", min: 1, max: 12 },
      { kind: "select", key: "layout", label: "Layout", options: ["grid", "list"] },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  biography: {
    type: "biography",
    label: "Biography",
    description: "Candidate introduction linking to the full biography.",
    group: "content",
    serviceDependency: null,
    defaultConfig: { heading: "Meet the Candidate", body: "Read more about the candidate's background and vision.", cta: { label: "Read Full Biography", href: "/biography" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "body", label: "Body", max: 2000, multiline: true },
      { kind: "media", key: "image", label: "Image" },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  manifesto: {
    type: "manifesto",
    label: "Manifesto",
    description: "Manifesto highlights linking to the full manifesto.",
    group: "content",
    serviceDependency: null,
    defaultConfig: { heading: "Our Vision", cta: { label: "Read the Manifesto", href: "/manifesto" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "body", label: "Body", max: 2000, multiline: true },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  gallery: {
    type: "gallery",
    label: "Gallery",
    description: "Gallery media highlights from the Gallery module.",
    group: "content",
    serviceDependency: null,
    defaultConfig: { heading: "Gallery", item_count: 6, layout: GRID },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "number", key: "item_count", label: "Items", min: 1, max: 12 },
      { kind: "select", key: "layout", label: "Layout", options: ["grid", "carousel"] },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  governance_projects: {
    type: "governance_projects",
    label: "Governance Projects",
    description: "Public governance projects (Phase 18 public projections).",
    group: "content",
    serviceDependency: "governance",
    defaultConfig: { heading: "Projects in Progress", item_count: 3, layout: GRID, cta: { label: "All Projects", href: "/governance" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "number", key: "item_count", label: "Items", min: 1, max: 12 },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  governance_commitments: {
    type: "governance_commitments",
    label: "Governance Commitments",
    description: "Public governance commitments (Phase 18 public projections).",
    group: "content",
    serviceDependency: "governance",
    defaultConfig: { heading: "Our Commitments", item_count: 3, layout: GRID, cta: { label: "All Commitments", href: "/governance" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "number", key: "item_count", label: "Items", min: 1, max: 12 },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  governance_updates: {
    type: "governance_updates",
    label: "Governance Updates",
    description: "Canonical governance updates (public projection).",
    group: "content",
    serviceDependency: "governance",
    defaultConfig: { heading: "Latest Governance Updates", item_count: 3, layout: "list" },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "number", key: "item_count", label: "Items", min: 1, max: 12 },
    ],
  },
  public_accountability: {
    type: "public_accountability",
    label: "Public Accountability",
    description: "Request statistics from the Governance public projections.",
    group: "content",
    serviceDependency: "governance",
    defaultConfig: { heading: "Open & Accountable", cta: { label: "View Statistics", href: "/governance/statistics" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  public_participation: {
    type: "public_participation",
    label: "Public Participation",
    description: "Open consultations, petitions and polls (public projections).",
    group: "content",
    serviceDependency: "governance",
    defaultConfig: { heading: "Participate Now", cta: { label: "See Open Items", href: "/governance/participate" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  election_countdown: {
    type: "election_countdown",
    label: "Election Countdown",
    description: "Countdown to the active election cycle (Election module).",
    group: "content",
    serviceDependency: "election",
    defaultConfig: { label: "Election Day" },
    schema: [
      { kind: "text", key: "label", label: "Label", max: 160 },
    ],
  },
  contact_cta: {
    type: "contact_cta",
    label: "Contact CTA",
    description: "Contact call-to-action linking to the contact page.",
    group: "content",
    serviceDependency: null,
    defaultConfig: { heading: "Get in Touch", cta: { label: "Contact Us", href: "/contact" } },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "description", label: "Description", max: 2000, multiline: true },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },

  // ── Presentation / marketing ────────────────────────────────────────
  hero: {
    type: "hero",
    label: "Hero",
    description: "Full-width hero banner with eyebrow, title and CTAs.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { title: "A New Direction", eyebrow: "", description: "", primary_cta: { label: "Join the Movement", href: "/volunteer" }, secondary_cta: { label: "Our Agenda", href: "/manifesto" }, background_variant: "brand", alignment: "left" },
    schema: [
      { kind: "text", key: "eyebrow", label: "Eyebrow", max: 120 },
      { kind: "text", key: "title", label: "Title", max: 200 },
      { kind: "text", key: "description", label: "Description", max: 2000, multiline: true },
      { kind: "link", key: "primary_cta", label: "Primary CTA" },
      { kind: "link", key: "secondary_cta", label: "Secondary CTA" },
      { kind: "select", key: "background_variant", label: "Background", options: ["brand", "dark", "gradient", "surface"] },
      { kind: "select", key: "alignment", label: "Alignment", options: ["left", "center"] },
    ],
  },
  rich_text: {
    type: "rich_text",
    label: "Rich Text",
    description: "Heading and controlled plain-text body.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { heading: "About This Campaign", body: "" },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "body", label: "Body", max: 2000, multiline: true },
      { kind: "select", key: "alignment", label: "Alignment", options: ["left", "center", "right"] },
    ],
  },
  image_text: {
    type: "image_text",
    label: "Image + Text",
    description: "Split image and text block.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { heading: "", body: "", image_side: "left" },
    schema: [
      { kind: "media", key: "image", label: "Image" },
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "body", label: "Body", max: 2000, multiline: true },
      { kind: "select", key: "image_side", label: "Image side", options: ["left", "right"] },
      { kind: "link", key: "cta", label: "CTA link" },
    ],
  },
  feature_cards: {
    type: "feature_cards",
    label: "Feature Cards",
    description: "Grid of up to 12 feature cards.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { heading: "Our Priorities", cards: [] },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
    ],
  },
  statistics: {
    type: "statistics",
    label: "Statistics",
    description: "Row of headline statistics.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { items: [] },
    schema: [],
  },
  cta: {
    type: "cta",
    label: "CTA Banner",
    description: "Full-width call-to-action banner.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { heading: "Join the Movement", description: "", primary_cta: { label: "Volunteer", href: "/volunteer" }, background_variant: "brand" },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "description", label: "Description", max: 2000, multiline: true },
      { kind: "link", key: "primary_cta", label: "Primary CTA" },
      { kind: "link", key: "secondary_cta", label: "Secondary CTA" },
      { kind: "select", key: "background_variant", label: "Background", options: ["brand", "dark", "gradient", "surface"] },
    ],
  },
  quote: {
    type: "quote",
    label: "Quote",
    description: "Featured quotation with attribution.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { quote: "", attribution: "" },
    schema: [
      { kind: "text", key: "quote", label: "Quote", max: 2000, multiline: true },
      { kind: "text", key: "attribution", label: "Attribution", max: 200 },
    ],
  },
  video: {
    type: "video",
    label: "Video",
    description: "Embedded video from a controlled allowlist of providers.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { video_url: "" },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
      { kind: "text", key: "video_url", label: "Video URL (YouTube/Vimeo)", max: 500 },
      { kind: "media", key: "poster", label: "Poster image" },
    ],
  },
  link_cards: {
    type: "link_cards",
    label: "Link Cards",
    description: "Grid of link cards for quick navigation.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { cards: [] },
    schema: [
      { kind: "text", key: "heading", label: "Heading", max: 160 },
    ],
  },
  divider: {
    type: "divider",
    label: "Divider",
    description: "Visual separator between sections.",
    group: "presentation",
    serviceDependency: null,
    defaultConfig: { style: "line" },
    schema: [
      { kind: "select", key: "style", label: "Style", options: ["space", "line", "dots"] },
    ],
  },
};

/** ALL approved section types — the registry allowlist (§9). */
export const HOMEPAGE_SECTION_TYPES = Object.keys(SECTIONS) as SectionType[];

/** Migration 0062 mirrors this list in SQL; keep them in lock-step. */
export const SQL_SECTION_TYPES: readonly string[] = HOMEPAGE_SECTION_TYPES;

export function isKnownSectionType(t: string): t is SectionType {
  return t in SECTIONS;
}

export function sectionDefinition(t: string): SectionDefinition | null {
  return isKnownSectionType(t) ? SECTIONS[t] : null;
}

/** Safe href check (§19) — mirrors migration 0062's cc_assert_safe_href. */
export function isSafeHref(href: string): boolean {
  if (!href || href.length > 2000) return false;
  if (/^\s*(javascript|data|vbscript|file|about):/i.test(href)) return false;
  return href.startsWith("/") || href.startsWith("#") || /^https?:\/\/[^\s]+$/i.test(href);
}

/**
 * Registry-side config validation for a known section type. Returns a list
 * of human-readable problems; empty = valid. Storage-side validation is
 * duplicated in 0062 (defense in depth); this is the editor/engine guard.
 */
export function validateSectionConfig(type: SectionType, config: SectionConfig): string[] {
  const problems: string[] = [];
  const def = SECTIONS[type];
  const allowed = new Set(def.schema.map((f) => f.key as string));
  // Defaults may include fields hidden from the editor schema; validate only
  // the union of schema keys + default keys.
  for (const k of Object.keys(def.defaultConfig)) allowed.add(k);

  for (const k of Object.keys(config ?? {})) {
    if (!allowed.has(k)) problems.push(`Unknown config key "${k}" for ${type}`);
  }
  for (const f of def.schema) {
    const v = (config as Record<string, unknown>)[f.key];
    if (v === undefined) continue;
    if (f.kind === "text" && typeof v === "string" && v.length > f.max) {
      problems.push(`"${f.key}" exceeds ${f.max} characters`);
    }
    if (f.kind === "number" && (typeof v !== "number" || v < f.min || v > f.max)) {
      problems.push(`"${f.key}" must be between ${f.min} and ${f.max}`);
    }
    if (f.kind === "link") {
      const href = (v as SafeLink | undefined)?.href;
      if (href && !isSafeHref(href)) problems.push(`"${f.key}.href" is not a safe link`);
    }
  }
  if (type === "statistics" && config.items) {
    if (!Array.isArray(config.items) || config.items.length > 12) {
      problems.push("statistics items must be an array of at most 12");
    }
  }
  if ((type === "feature_cards" || type === "link_cards") && config.cards) {
    if (!Array.isArray(config.cards) || config.cards.length > 12) {
      problems.push("cards must be an array of at most 12");
    }
  }
  return problems;
}

/** Full composition validation (draft + publish path, editor side). */
export function validateComposition(sections: SectionInstance[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(sections)) return ["composition must be an array"];
  if (sections.length > 30) return ["composition exceeds 30 sections"];
  const ids = new Set<string>();
  sections.forEach((s, i) => {
    if (!s.stable_id || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.stable_id)) {
      problems.push(`section ${i + 1}: invalid stable_id`);
    }
    if (ids.has(s.stable_id)) problems.push(`duplicate stable_id "${s.stable_id}"`);
    ids.add(s.stable_id);
    if (!isKnownSectionType(s.section_type)) {
      problems.push(`section "${s.stable_id}": unknown section_type "${s.section_type}"`);
      return;
    }
    if (typeof s.display_order !== "number") {
      problems.push(`section "${s.stable_id}": display_order must be a number`);
    }
    if (typeof s.enabled !== "boolean") {
      problems.push(`section "${s.stable_id}": enabled must be a boolean`);
    }
    const dep = s.service_dependency ?? null;
    if (dep !== null && !["social", "campaign", "election", "governance"].includes(dep)) {
      problems.push(`section "${s.stable_id}": unsupported service_dependency "${dep}"`);
    }
    if (isKnownSectionType(s.section_type)) {
      problems.push(...validateSectionConfig(s.section_type, s.config ?? {}));
    }
  });
  return problems;
}
