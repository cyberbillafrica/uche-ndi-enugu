/**
 * POLITICORE — Website Experience: branding presets & design tokens (Phase 23).
 *
 * Presets are VISUAL design-token bundles ONLY (Control Center gate §8/§15/§16):
 * selecting `apc`, `pdp`, `ndc` or `custom` changes no authorization, routing,
 * module-activation or business behavior anywhere in the application. There is
 * deliberately no `if (preset === "apc")` code path outside this registry —
 * the UI consumes the resolved tokens; components consume semantic
 * `--color-brand-*` variables that the public layout injects from published
 * branding (fallback: these same defaults, gate §15).
 */

/** §7 semantic token vocabulary (validated server-side in migration 0061). */
export interface BrandTokens {
  primary: string;
  secondary: string;
  accent: string;
  surface: string;
  background: string;
  text: string;
  muted: string;
  border: string;
}

export type BrandPresetId = "apc" | "pdp" | "ndc" | "custom";

export interface BrandPreset {
  id: BrandPresetId;
  /** UI label only — explains the visual palette; carries no behavior. */
  label: string;
  tokens: BrandTokens;
}

/**
 * The four architecture-approved presets. APC carries the platform's current
 * fallback palette (the pre-existing `--color-apc-*` values), so a tenant with
 * NO branding configuration renders exactly the established visual language.
 */
export const BRAND_PRESETS: Record<Exclude<BrandPresetId, "custom">, BrandPreset> = {
  apc: {
    id: "apc",
    label: "APC preset",
    tokens: {
      primary: "#00843d",
      secondary: "#d92d20",
      accent: "#0d3b66",
      surface: "#ffffff",
      background: "#f9fafb",
      text: "#111827",
      muted: "#6b7280",
      border: "#e5e7eb",
    },
  },
  pdp: {
    id: "pdp",
    label: "PDP preset",
    tokens: {
      primary: "#0a6b3d",
      secondary: "#d71920",
      accent: "#b91c1c",
      surface: "#ffffff",
      background: "#f9fafb",
      text: "#111827",
      muted: "#6b7280",
      border: "#e5e7eb",
    },
  },
  ndc: {
    id: "ndc",
    label: "NDC preset",
    tokens: {
      primary: "#006b3f",
      secondary: "#fcd116",
      accent: "#ce1126",
      surface: "#ffffff",
      background: "#f9fafb",
      text: "#111827",
      muted: "#6b7280",
      border: "#e5e7eb",
    },
  },
};

/** Fallback bundle = the APC preset (the platform's established palette). */
export const DEFAULT_BRAND_TOKENS: BrandTokens = BRAND_PRESETS.apc.tokens;

export const SUPPORTED_TYPOGRAPHY = ["sans", "serif", "mono"] as const;
export type TypographyPreference = (typeof SUPPORTED_TYPOGRAPHY)[number];

export const SUPPORTED_RADII = ["none", "sm", "md", "lg", "xl", "full"] as const;
export type RadiusPreference = (typeof SUPPORTED_RADII)[number];

/** CSS var name → (published) branding value; injected by the public layout. */
export const BRAND_TOKEN_VARS: Record<keyof BrandTokens, string> = {
  primary: "--cc-primary",
  secondary: "--cc-secondary",
  accent: "--cc-accent",
  surface: "--cc-surface",
  background: "--cc-background",
  text: "--cc-text",
  muted: "--cc-muted",
  border: "--cc-border",
};

/** Server-validated shape of the published `branding` draft/payload. */
export interface BrandingConfig {
  site_name?: string;
  preset?: BrandPresetId;
  tokens?: Partial<BrandTokens>;
  typography?: { heading?: TypographyPreference; body?: TypographyPreference };
  radius?: RadiusPreference;
  logo?: { asset_id: string; alt?: string };
  favicon?: { asset_id: string };
}

function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * Resolve a (possibly absent/malformed) published branding payload to the
 * concrete token bundle for rendering. Fallback safety (gate §15): unknown
 * preset ids, missing or invalid token values fall back to the platform
 * default per-value — a malformed configuration can never blank the site.
 */
export function resolveBrandTokens(branding: BrandingConfig | null | undefined): BrandTokens {
  const out: BrandTokens = { ...DEFAULT_BRAND_TOKENS };
  if (!branding || typeof branding !== "object") return out;

  const presetTokens =
    branding.preset && branding.preset !== "custom" && branding.preset in BRAND_PRESETS
      ? BRAND_PRESETS[branding.preset as Exclude<BrandPresetId, "custom">].tokens
      : DEFAULT_BRAND_TOKENS;
  Object.assign(out, presetTokens);

  // Custom/overlay tokens apply only where individually valid (§9 whitelist;
  // the server rejects unknown keys — here invalid *values* just fall back).
  if (branding.tokens && typeof branding.tokens === "object") {
    for (const key of Object.keys(DEFAULT_BRAND_TOKENS) as (keyof BrandTokens)[]) {
      const v = branding.tokens[key];
      if (isHex(v)) out[key] = v;
    }
  }
  return out;
}

/** CSS custom-property declarations for a resolved bundle (public layout). */
export function brandTokenStyle(tokens: BrandTokens): Record<string, string> {
  const style: Record<string, string> = {};
  for (const key of Object.keys(tokens) as (keyof BrandTokens)[]) {
    style[BRAND_TOKEN_VARS[key]] = tokens[key];
  }
  return style;
}
