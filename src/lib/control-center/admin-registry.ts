/**
 * POLITICORE — Control Center administration link-out registry (Phase 26).
 *
 * The SINGLE canonical mapping from administrative area → authoritative
 * console (prompt §11/§12). Control Center links; it never re-implements:
 *
 *   CONTROL CENTER CONFIGURES THE PLATFORM; MODULES OWN THEIR DOMAIN
 *   OPERATIONS.
 *
 * A link is NOT authorization (§16): every destination is guarded by its own
 * route guards / RPC authority / RLS, exactly as before Phase 26. This
 * registry is typed, code-side and static — no database-driven routes, no
 * dynamic component names (§34 stop conditions 16/17).
 *
 * Deliberately ABSENT (documented gaps, not invented surfaces — §12):
 *   - Notifications administration (Core Notifications is managed through
 *     automatic delivery; no dedicated console route exists).
 *   - Media library administration (Core Media is exercised through the
 *     editors that reference it, e.g. the Branding editor).
 *   - Geography administration (Core Geography is provisioned per tenant
 *     during onboarding; no dedicated console route exists).
 *   - Organizational assignments (managed within the member consoles).
 * Inventing replacement screens for these would duplicate Core; the gap is
 * disclosed instead.
 */

/** The four business modules — exactly `module_code_enum`. */
export type AdminModule = "social" | "campaign" | "election" | "governance";

export interface AdminLink {
  /** Human label for the card/link. */
  label: string;
  /** Canonical destination route (verified to exist in src/app). */
  href: string;
  /** One-line description of what the console owns. */
  description: string;
}

/**
 * Module → authoritative administration console (§3/§4). Control Center may
 * show status for these; the console owns every domain operation.
 */
export const MODULE_ADMIN_LINKS: Record<AdminModule, AdminLink> = {
  social: {
    label: "Social Force Task Manager",
    href: "/portal/admin/tasks",
    description: "Task creation, submissions, review and point awards.",
  },
  campaign: {
    label: "Campaign operations",
    href: "/portal/campaign/coordination",
    description: "Assignments, activities, field reports and coordination.",
  },
  election: {
    label: "Election Control Center",
    href: "/portal/election",
    description: "Cycles, results submission, review workflow and evidence.",
  },
  governance: {
    label: "Governance administration",
    href: "/portal/governance",
    description: "Cases, projects, commitments, participation and analytics.",
  },
};

/**
 * Core → authoritative administration surfaces (§5/§12). Core owns these;
 * the Control Center only provides entry points.
 */
export const CORE_ADMIN_LINKS: AdminLink[] = [
  {
    label: "Members",
    href: "/portal/admin/members",
    description: "Member directory, onboarding and access roles.",
  },
  {
    label: "Tenant settings",
    href: "/portal/admin/settings",
    description: "Canonical tenant configuration.",
  },
  {
    label: "Audit logs",
    href: "/portal/admin/audit-logs",
    description: "Core Audit evidence trail.",
  },
  {
    label: "System health",
    href: "/portal/admin/health",
    description: "Database, service and diagnostics status.",
  },
];

/**
 * Website configuration editors (Phase 22–25). Link-outs only — the editors
 * are the sole configuration surfaces (§14).
 */
export const WEBSITE_ADMIN_LINKS: AdminLink[] = [
  {
    label: "Branding & Theme",
    href: "/portal/control-center/website/branding",
    description: "Presets, design tokens, logo and favicon.",
  },
  {
    label: "SEO & metadata",
    href: "/portal/control-center/website/seo",
    description: "Public metadata and search presentation.",
  },
  {
    label: "Homepage builder",
    href: "/portal/control-center/website/homepage",
    description: "Section composition and publication lifecycle.",
  },
  {
    label: "Navigation",
    href: "/portal/control-center/website/navigation",
    description: "Navigation items, destinations and visibility.",
  },
  {
    label: "Header",
    href: "/portal/control-center/website/header",
    description: "Header presentation and call-to-action.",
  },
  {
    label: "Footer",
    href: "/portal/control-center/website/footer",
    description: "Footer columns, legal and social presentation.",
  },
];

/** Configuration-area → editor link, keyed by the status RPC's area values. */
export const AREA_EDITOR_LINKS: Record<string, string> = {
  branding: WEBSITE_ADMIN_LINKS[0].href,
  seo: WEBSITE_ADMIN_LINKS[1].href,
  homepage: WEBSITE_ADMIN_LINKS[2].href,
  navigation: WEBSITE_ADMIN_LINKS[3].href,
  footer: WEBSITE_ADMIN_LINKS[4].href,
};
