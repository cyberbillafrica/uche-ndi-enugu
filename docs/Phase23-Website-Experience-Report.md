# PolitiCore — Phase 23 Report

## Control Center — Website Experience: Branding, Theme & SEO

**Status:** PHASE 23 — COMPLETE — **GATE: PASS**
**Architecture source:** `docs/Control-Center-Architecture-Gate.md` (§15–§20) + Phase 22 configuration foundation (0060)
**Preceding:** Phase 22 — Control Center Core — PASS (958/958 · hosted 24/24 · residue 0)

---

## 1. Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/0061_website_experience_config.sql` | NEW — validators, validated save/publish restatement, public chrome + brand-asset projections, admin preview RPC, grants |
| `src/lib/branding/presets.ts` | NEW — preset registry (apc/pdp/ndc/custom token bundles), token resolution with fallback, CSS-var mapping |
| `src/lib/supabase/websiteExperience.ts` | NEW — public chrome fetch, admin preview, typed branding/SEO draft+publish helpers |
| `src/app/layout.tsx` | Published token injection on `<html>` + tenant SEO `generateMetadata` (fallback-safe) |
| `src/app/globals.css` | `--color-apc-*` hard-coded theme tokens → semantic `--color-brand-*` over runtime `--cc-*` (fallback bundle declared) |
| `src/components/layout/Header.tsx`, `Footer.tsx` | Hard-coded hexes → `var(--color-brand-primary/secondary)` (+ `color-mix` hover variants) |
| ~85 src files | Mechanical rename `apc-*` → `brand-*` utility classes (pixel parity preserved) |
| `src/app/portal/control-center/page.tsx` | Website Experience card now links Branding & Theme + SEO surfaces |
| `src/app/portal/control-center/website/branding/page.tsx` | NEW — theme editor (presets, controlled custom tokens, site name, typography/radius, logo/favicon, draft/preview/publish) |
| `src/app/portal/control-center/website/seo/page.tsx` | NEW — SEO editor (title, description, OG, keywords, canonical, robots, draft/publish) |
| `src/app/api/branding/upload/route.ts` | NEW — Media Service upload (tenant-admin gated, public visibility, returns canonical asset id) |
| `src/app/api/media/[assetId]/route.ts` | NEW — public render route for branding assets (slug+tenant+visibility checked server-side) |
| `tests/security/control-center-website-experience.test.ts` | NEW — 29 tests (§24) |
| `scripts/db/verify-hosted-smoke-control-center-website-experience.ts` | NEW — 15 hosted journeys (§25) |
| `scripts/db/apply-hosted.ts` | 0061 convergence signature registered |
| `tests/security/governance-phase11-architecture.test.ts`, `tests/security/control-center-core.test.ts` | Pin update (61→62 migrations) + validator-compliant payloads |

## 2. Migration

**0061_website_experience_config.sql** — zero new tables (§27 honored). Contains:

- `cc_validate_branding` / `cc_validate_seo` — strict allowlists: unknown keys rejected; tokens must be `#rrggbb`; typography ∈ (sans, serif, mono); radius ∈ fixed set; presets ∈ (apc, pdp, ndc, custom); SEO fields length-capped/URL-validated
- `cc_assert_brandable_media` — logo/favicon must reference a **public media_assets row of the same tenant** (cross-tenant/private/missing rejected at save AND publish)
- `save_site_config_draft` / `publish_site_config` — convergence restatement: identical Phase 22 bodies + validator gating for branding/seo
- `politicore.get_public_site_chrome(slug)` (definer) + `public.get_public_site_chrome` wrapper — published-only, draft/history/audit keys never leave the server, `{}` for unconfigured tenants
- `public.get_public_brand_asset(slug, asset_id)` — render authority for the media route
- `politicore.get_site_config_preview(area)` + wrapper — is_tenant_admin-gated draft read (branding/seo only)

## 3. Branding configuration contract

```jsonc
{ "site_name"?: string(1..120), "preset"?: "apc"|"pdp"|"ndc"|"custom",
  "tokens"?: { primary|secondary|accent|surface|background|text|muted|border: "#rrggbb" },
  "typography"?: { heading?|body?: "sans"|"serif"|"mono" },
  "radius"?: "none"|"sm"|"md"|"lg"|"xl"|"full",
  "logo"?: { asset_id: uuid /* public, own tenant */, alt?: string },
  "favicon"?: { asset_id: uuid } }
```

## 4. Semantic token contract

`--color-brand-primary|secondary|accent|surface|background|text|muted|border` (Tailwind theme utilities) resolve through runtime `--cc-*` variables injected on `<html>` from the **published** branding. Fallback bundle (APC palette = the pre-existing visual language) is declared statically in `globals.css`, so SSR, portal chrome and unconfigured/malformed tenants render correctly (§15). Public components consume only semantic tokens — zero `apc-*` names remain in source (§7).

## 5. Preset implementation

Pure data registry (`src/lib/branding/presets.ts`): four `BrandPreset` objects mapping preset ids to token bundles. Suite F2 statically proves the registry contains no authorization/routing/module/permission references. No `if (preset === "APC")` code path exists anywhere.

## 6. Custom-theme validation

`custom` accepts exactly the token whitelist via the same server validators — unknown keys and non-`#rrggbb` values are rejected at save and at publish. No CSS strings, `<style>`, JS, event handlers, HTML, iframes, or arbitrary CSS variable names can enter (proven B5/J6).

## 7. SEO implementation

Tenant-level metadata only: title, description, og_title, og_description, keywords (≤20), canonical_url (absolute http(s)), robots (4 supported directives). Consumed by root `generateMetadata` (title/description/keywords/canonical/robots/OpenGraph) from the published projection. No per-page SEO infrastructure; content-module ownership untouched.

## 8. Media integration

Logo/favicon use canonical Core Media `media_assets.id` end-to-end: upload route → Media Service (`getMediaService`, provider R2/local) → registry; branding config stores only the asset id; validators enforce existence + tenancy + public visibility at save and publish; `/api/media/[assetId]` resolves the URL server-side via the Media Service (`accessUrl`). No provider URLs as architectural truth; no duplicated resolution logic.

## 9. Audit behavior

All draft saves and publishes flow through the Phase 22 audit inserts (`site_config:<area>:draft_saved` / `:published`) into Core Audit `system_audits` with server-resolved tenant + actor. No Control Center audit table. No per-keystroke noise (coarse draft-save granularity per existing convention).

## 10–14. Verification results

| Gate | Result |
| --- | --- |
| Focused security suite (§24) | **29/29** — authority, allowlists, media binding, draft safety, concurrency, public projection, audit, regression guards |
| Full regression | **987/987 — 41 suites — 0 failed — 0 skipped** |
| TypeScript | **0 errors** |
| Production build | **PASS — 75/75 pages** |
| Lint (all phase files) | **0 errors / 0 warnings** |
| Hosted acceptance (§25) | **15/15** — all journeys incl. draft-privacy, publish propagation, preset change, validator rejections, cross-tenant media rejection, slug-seam isolation, stale-revision conflict, audit evidence, fallback |
| Hosted residue | **0** (`tenants|profiles|orphan-settings|brand-assets = 0|0|0|0`; FORCE-RLS state restored) |

## 15. Deviations / repairs

1. **`get_public_site_chrome` recursion (found by the suite):** the real function was briefly defined in `public` with its wrapper calling itself → `ERRORDATA_STACK_SIZE`. Fixed: real function in `politicore`, wrapper delegates.
2. **Zero-row `SELECT … INTO` NULL-poisoning (found by D4):** same PL/pgSQL pattern Phase 22 hit; fixed with scalar-subquery COALESCE forms so unconfigured tenants receive `{}`.
3. **Phase 22 suite payload update:** its concurrency tests used generic `{"v":1}` branding drafts; the 0061 validator (correctly) rejects unknown keys. Payloads updated to valid branding configs; assertions unchanged in strength.
4. **PostgREST status convention:** PL/pgSQL authority exceptions surface as 400 (not 403); harness aligned with the established `>= 400` convention of every prior hosted harness.

All disclosed; none architectural.

## 16. Phase 24/25 boundary confirmation

Not implemented: Homepage Builder, section registry/engine, homepage composition editor, homepage preview/publish UI, header builder, footer builder, navigation builder, homepage replacement of `src/app/page.tsx`, any new CMS. The homepage remains the existing page; only its design tokens are now configurable. People & Access, Organization, and all module configuration surfaces untouched.

## 17. Locked-module confirmation

Social Force, Campaign, Election, Governance, Core Identity/Auth, Core Geography, Core Notifications, Core Media (consumed only), Core Audit (consumed only), News, Events, Biography, Manifesto, Gallery, Contact — no ownership or behavior change. The token rename is presentation-only; every public surface renders identically under the fallback bundle (full regression proves behavioral parity).

## 18. Stop conditions

None triggered. No new table, role, or permission; no second authorization/configuration/CMS subsystem; party identifiers remain data-only; service activation fully decoupled from website experience (§21).

---

## FINAL GATE

**POLITICORE — PHASE 23 — WEBSITE EXPERIENCE: BRANDING, THEME & SEO — PASS**
