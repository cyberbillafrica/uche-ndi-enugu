# PolitiCore — Governance / Control Center Phase 25 Report

## Header, Footer & Navigation Builder (Site Chrome)

**Status:** PHASE 25 — COMPLETE — **GATE: PASS**
**Architecture source:** `docs/Control-Center-Architecture-Gate.md` (Phase 21 gate — website-experience chrome sections) + the Phase 25 implementation prompt
**Preceding:** Phase 24 — Homepage Builder — COMPLETE/PASS (1020/1020 · 42 suites · hosted 18/18 · residue 0)
**Next planned phase:** Phase 26 — Administration Integration (**NOT implemented here** — boundary held)

---

## 1. Objective

Implement the Control Center website-experience editors for **Header, Footer and Navigation** over the existing `politicore.public_site_settings` configuration substrate — declarative configuration only, preserving the Phase 21 ownership boundary:

> CONTROL CENTER CONFIGURES THE PLATFORM; MODULES OWN THEIR DOMAIN OPERATIONS.

No new tables, roles, permissions, second renderers, second audit substrate, or second activation mechanism.

## 2. Storage & migration

**`supabase/migrations/0063_site_chrome.sql`** — pure `CREATE OR REPLACE FUNCTION` (zero DDL, zero new tables):

- `cc_validate_chrome_link` — one destination contract for nav items/children/footer links/CTAs: known fields only (`label`,`href`,`rel`), label 1..120, href via `cc_assert_safe_href` (reuse of the Phase 24 primitive), **external http(s) links must carry `rel="noopener noreferrer"` verbatim; internal/anchor links must NOT carry `rel`**.
- `cc_validate_chrome_item` — item vocabulary: `id` `[A-Za-z0-9_-]{1,64}`, `label` 1..120, `type` ∈ internal|external|anchor, `visibility` ∈ public|authenticated (presentation only — never authorization), `enabled` boolean, `service_dependency` ∈ social|campaign|election|governance, `presentation` ∈ {style: default|underline|pill, emphasis: boolean} — **no CSS/class strings**, exactly ONE bounded child level (≤ 8 children, §6).
- `cc_validate_chrome_header_cta` — bounded CTA: enabled→label 1..60 + safe href required.
- `cc_validate_navigation` — `{items[], header}`: ≤ 12 top-level items, **unique stable ids, unique labels**, header allowlist `show_logo|show_site_name|show_primary_nav|cta|mobile_menu|alignment` with `mobile_menu` ∈ accordion|drawer and `alignment` ∈ left|center|right.
- `cc_validate_footer` — `{columns[], legal, social, presentation}`: ≤ 4 columns × ≤ 8 links, column id/heading allowlists (heading 1..60), legal (copyright ≤ 160, ≤ 6 links), social (`show` boolean), presentation (`layout` ∈ columns-3|columns-4, `show_contact`, `show_cta`, `cta_heading` ≤ 120, `cta_label` ≤ 60, safe `cta_href`). Unknown keys rejected everywhere.
- `save_site_config_draft` / `publish_site_config` — area dispatch extended to `navigation` + `footer` with **merge-safe draft persistence** (draft save merges into the area column; `published`, `published_at`, `published_by`, `history` are never destroyed — the Phase 24 lesson encoded) and **re-validation at publish time**.
- `rollback_site_config` / `get_site_config_history` / `get_site_config_preview` — area coverage extended to navigation/footer; rollback still promotes a historical payload through the **normal validated draft-save path** (never writes history directly), bounded history ≤ 10 preserved.
- `get_public_site_chrome` — extended Phase 23 projection: `branding`, `seo`, `navigation` (**server-side eligibility filter** — disabled items and items whose `service_dependency` module is deactivated are suppressed; malformed stored payloads fail safe to `[]`; `header` presentation passthrough), `footer` (published only), plus the canonical `contact` + `social_links` published areas the footer binds (never duplicated). Draft, history, revision internals and publisher identity never leave the server.

## 3. Configuration contracts (typed)

`src/lib/chrome/types.ts` — `ChromeLink`, `ChromeNavItem` (stable `id`; no array-position identity), `HeaderCta`, `HeaderConfig`, `NavigationConfig`, `FooterColumn`, `FooterConfig`; bounded vocabularies as `const` tuples (`CHROME_ITEM_TYPES`, `CHROME_VISIBILITIES`, `CHROME_ITEM_STYLES`, `HEADER_MOBILE_MENUS`, `HEADER_ALIGNMENTS`, `FOOTER_LAYOUTS`); `isSafeChromeHref` (client-side defense-in-depth mirror of the SQL validator); `isValidNavigationConfig` / `isValidFooterConfig` type guards; **parity defaults** `DEFAULT_NAVIGATION_CONFIG` / `DEFAULT_FOOTER_CONFIG` reproducing the pre-existing hard-coded chrome (Home/News/Events/Governance + Member Portal, Explore/Party columns, legal + social display).

## 4. Public rendering — exactly one implementation

- `src/components/layout/Header.tsx` — the SINGLE production header (§18): consumes published navigation (items, children, header presentation, CTA) through `usePublicChrome()`; external links get `rel="noopener noreferrer" target="_blank"` statically ( administrators cannot express rel — the SQL validator enforces the same contract); semantic `<nav aria-label>`, keyboard-accessible mobile menu (accordion | drawer variants), skip-link preserved.
- `src/components/layout/Footer.tsx` — the SINGLE production footer: published columns/legal/social/presentation + canonical contact/social passthrough from the chrome projection; inline-SVG social icons (lucide 1.x has no brand icons); footer landmark semantics.
- `src/components/layout/PublicChromeProvider.tsx` — root-layout-fed context: SSR resolves `get_public_site_chrome` once; any projection failure degrades to parity defaults (the public shell can never go blank, gate §15). Admin preview supplies a draft chrome through the SAME provider — **no second renderer exists**.
- No legacy/competing header, footer or navigation path: 23 pages render `<Header />`/`<Footer />`; the builder UI is configuration-only.

## 5. Control Center UI

- `/portal/control-center/website/navigation` — item library (add/edit/delete/reorder via ↑↓, enable/disable, visibility, service dependency, bounded one-level child editor, destination editor with live href-safety feedback), header presentation controls, preview, save/publish, revision-conflict handling, history, rollback.
- `/portal/control-center/website/header` — focused header presentation editor (same `navigation` area, header sub-object only).
- `/portal/control-center/website/footer` — column management, bounded link editing, legal/social/contact placement toggles, presentation variants, preview, save/publish, history, rollback.
- `src/lib/chrome/useChromeArea.ts` — shared draft/publish/history/rollback lifecycle hook (typed editors from schema metadata; no arbitrary JSON editor).
- All three editors: tenant/actor resolved server-side; the client sends configuration payloads only.

## 6. Preview, lifecycle, audit

- **Preview** — admin-only (`get_site_config_preview` extended to both areas); renders the production components via the provider; drafts never public.
- **Lifecycle** — draft → preview → publish: publish re-validates the promoted payload, enforces tenant/actor authority, atomically promotes draft→published, stamps publisher/time, increments revision, archives bounded history (≤ 10), writes Core Audit.
- **Optimistic concurrency** — stale base revision rejected on save AND publish (`Configuration conflict`).
- **Audit** — Core Audit only: `site_config:navigation|footer:draft_saved|published|rollback` with server-resolved actor (`auth.uid()`) and tenant. No chrome-specific audit substrate.

## 7. Security posture

`is_tenant_admin()` gates every write/read-admin surface; no new role, permission, or per-section authorization; FORCE RLS and the 0060 grant discipline untouched; no direct browser writes to `public_site_settings`; anon holds zero surface (401 on all five RPCs, no base-table grants); public projection is published-only with server-side eligibility.

## 8. Test & gate results

| Gate | Result |
|---|---|
| Focused security suite (`tests/security/control-center-site-chrome.test.ts`) | **35/35** — authority, validation allowlists, safe destinations (javascript:/data:/vbscript:/file: rejected; internal/https/anchor accepted), module-dependency OFF-hide/ON-restore with config retention, merge-safe draft saves (published + history preserved), stale-revision rejection, rollback-through-save-path with bounded history, tenant + slug isolation, single-renderer architecture, no new tables/roles/permissions, no Cloudinary/R2, no style/class injection surface |
| Full regression | **1055/1055 — 43 suites — 0 skipped — 0 failed** (1020 baseline + 35) |
| TypeScript | **0 errors** |
| Production build | **PASS — 79/79 pages** (3 new editor routes) |
| Lint (all Phase 25 files) | **0 errors / 0 warnings** |
| Hosted acceptance (`verify-hosted-smoke-control-center-site-chrome.ts`) | **21/21** — provisioning, admin access, member + anon denial, draft/save/publish propagation, nav/footer/header rendering, dependency OFF→hidden / ON→restored, stale conflicts (save + publish), rollback, history retention, tenant + slug isolation, draft/history privacy, audit actor correctness, residue 0, FORCE RLS restored 8/8 |
| Hosted residue | **0** (tenants / profiles / audits / settings = 0/0/0/0) |

## 9. Disclosed repairs & deviations

1. **Nav-item `rel` field** — the draft contract initially admitted a per-item `rel`; the final SQL allowlist rejects it and the renderer derives `rel="noopener noreferrer"` statically for external hrefs (single enforcement point, no admin-expressed rel). Suite and harness aligned to that contract.
2. **Phase 24 suite pin J2** — asserted "Phase 25 not yet built" (`cc_validate_navigation` must not exist). Superseded by 0063: the guard now pins Phase 25 as implemented **and** holds the next boundary (`cc_validate_contact` must not exist).
3. **Phase 11 suite pin D3** — the git-integrity check expected the disclosed `0016_election_seed.sql` modification to still be uncommitted; that disclosure was committed in `a2cac79`. Updated to expect a clean tracked-migration tree (the property the test protects).
4. **Phase 11 pin D1** — migration count 63 → 64, last file `0063_*` (Phase 25's authorized increment).
5. **Hosted convergence** — `apply-hosted` re-applied 0059/0061/0062/0063 (pure `CREATE OR REPLACE` idempotent convergence to final content) plus the pre-existing idempotent 0011/0012 signature gap; verified row counts unchanged (permissions 43).
6. **Hosted J2 unwrap** — first hosted run 20/21: the harness assumed PostgREST's array envelope for `get_site_config`; hosted returns scalar-JSON. Fixed to the production unwrap. Also restored the Phase 24 hosted-fixture convention (provisioning `public_site_settings` rows with the tenant) since `get_site_config` returns zero rows for a pristine tenant.
7. **Editor hook effect** — restructured initial load to the established Phase 23/24 async-inside-effect pattern to satisfy `react-hooks/set-state-in-effect`.

## 10. Stop conditions — none encountered

No new table, role, permission, second configuration store, second navigation system, second header/footer renderer, arbitrary HTML/CSS/JS configuration, executable configuration, dynamic imports/routes from DB values, direct Cloudinary/R2 usage, anonymous draft access, public draft/history exposure, new audit subsystem, duplicated domain content, locked-module ownership changes, second activation mechanism, N+1 fanout, or Phase 26 implementation.

## 11. Explicit confirmations

- **Phase 26 (Administration Integration) was NOT implemented** — no cross-module admin dashboards, no new administration permissions/roles, no management consoles.
- **All locked modules remain untouched** — Social Force, Campaign, Election, Governance, Core Identity/Auth, Geography, Notifications, Media, Audit, News, Events, Biography, Manifesto, Gallery, Contact: consumed via existing canonical contracts only; ownership unchanged.
- **Permanently removed modules were not recreated** — no Campaign Communications/Documents/Calendar anywhere in navigation or configuration.
- Firebase remains fully retired; zero Firebase references introduced.
