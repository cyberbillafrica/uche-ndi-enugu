# PolitiCore — Phase 26 Report

## Control Center — Administration Integration

**Status:** PHASE 26 — COMPLETE — **GATE: PASS**
**Architecture sources:** `docs/Control-Center-Architecture-Gate.md` (Phase 21), Phase 22–25 implementation baselines
**Preceding:** Phase 25 — Header / Footer / Navigation — COMPLETE/PASS (1055/1055 · 43 suites · hosted 21/21 · residue 0)
**Type:** Integration phase. One bounded read-only RPC added; zero business tables, zero roles, zero permissions, zero module-enum changes.

---

## 1. Fundamental boundary held

```text
CONTROL CENTER CONFIGURES THE PLATFORM; MODULES OWN THEIR DOMAIN OPERATIONS.
```

- `politicore.module_code_enum` remains exactly `social, campaign, election, governance` — Control Center stays **outside** the business-module enum (asserted by the security suite).
- No duplicate business console was created. Every module/Core entry point in Control Center is a **link-out** to the authoritative existing console through one typed code-side registry.
- No new role, no new permission, no new activation mechanism, no new audit/notification/media/geography subsystem, no analytics warehouse.

## 2. Migration

**`supabase/migrations/0064_control_center_administration.sql`** — pure `CREATE OR REPLACE FUNCTION`:

- `politicore.control_center_site_config_status()` — read-only, `SECURITY DEFINER`, tenant-resolved server-side. Returns a bounded 5-row SETOF (one per configuration area: `branding, seo, homepage, navigation, footer`) with **status facets only**: `area, has_config, published, published_at`. Draft payloads, history, revisions and publisher identities are structurally excluded (proven by test + hosted journey).
- Grant: `authenticated` execution only (tenant admin enforcement inside the function via the established `is_tenant_admin()` path).

## 3. Files changed

| File | Purpose |
| --- | --- |
| `supabase/migrations/0064_control_center_administration.sql` | Configuration-status RPC (above) |
| `src/lib/control-center/admin-registry.ts` | Single canonical module → console / Core → surface link-out registry (typed, code-side; every route verified to exist on disk) |
| `src/lib/supabase/controlCenter.ts` | `getSiteConfigStatus()` — one bounded RPC call (no N+1) |
| `src/app/portal/control-center/administration/page.tsx` | Administration landing surface |
| `src/app/portal/control-center/page.tsx` | Overview: canonical registry links, Administration entry point, health link, website card refresh |
| `tests/security/control-center-administration.test.ts` | Focused security suite (25 tests) |
| `scripts/db/verify-hosted-smoke-control-center-administration.ts` | Hosted acceptance harness (26 checks) |
| `scripts/db/apply-hosted.ts` | 0064 hosted signature pin |
| `tests/security/governance-phase11-architecture.test.ts` | Migration-count pin 64 → 65 |

## 4. Administration IA

`/portal/control-center/administration` — a navigational control plane, five sections:

- **Platform** — tenant config/status, service entitlements, module activation (`/control-center/services`), website configuration, system health.
- **Core** — Members, Access, Assignments, Geography, Notifications, Media, Audit — links only.
- **Services** — Social Force, Campaign, Election, Governance — status + authoritative console links.
- **Website** — Branding, SEO, Homepage, Navigation, Header, Footer — the existing Phase 22–25 editors, unduplicated.
- **System** — Health, configuration status.

## 5. Module status integration (§10)

Overview service cards present the distinction explicitly: **Entitled** (badge; "Not entitled" otherwise), **Activated** (enable state), and CTAs per state — `Open Administration →` (operational), `Enable Service →` (entitled, disabled), `Activation unavailable` (unentitled). Copy states enabling/disabling never creates or destroys data. Activation flows exclusively through the existing Phase 22 entitlement-checked RPC.

## 6. Link-out integrity (§11/§12)

Canonical registry (all routes verified on disk, tested + hosted-checked):

- Social Force → `/portal/admin/tasks` · Campaign → `/portal/campaign/coordination` · Election → `/portal/election` · Governance → `/portal/governance`
- Core → Members `/portal/admin/members`, Settings `/portal/admin/settings`, Audit `/portal/admin/audit-logs`, Health `/portal/admin/health`, Control Center `/portal/control-center`
- **Documented gaps (not invented):** no dedicated Notifications, Media, Geography, or organizational-Assignment console routes exist in the repository. The registry marks these as unavailable rather than fabricating duplicate screens (§12 explicitly authorizes this disclosure).

## 7. Configuration status (§20)

The overview/administration surfaces call `control_center_site_config_status()` once (no per-area fan-out): per-area `has_config` / `published` / `published_at` facets. Drafts never appear as published; no private payload is carried.

## 8. Authorization & isolation behavior (§16/§17)

- Control Center pages are presentation-only; every data read flows through server-resolved, tenant-admin RPCs. No client-supplied `tenant_id` anywhere.
- Module activation remains gated by platform entitlement server-side; a tenant admin cannot self-entitle.
- **Authorization separation proven:** the Control Center administrator holds **zero** `permission_grants` rows; module authority flows only from the pre-existing Core permission resolver. Control Center entry confers nothing.
- Cross-tenant status leakage: tenant B's admin cannot see tenant A's overview/status; public chrome/public config wrappers expose no administration surface.

## 9. Audit behavior (§23)

No new audit subsystem. Ordinary page views write nothing. The only mutations in this phase's journeys are the existing activation and site-config paths, which audit through Core Audit with server-resolved actor/tenant (verified hosted: `module:*` / `site_config:*` actions carry the correct actor).

## 10. Verification results

| Gate | Result |
| --- | --- |
| Focused security suite (`control-center-administration.test.ts`) | **25/25** |
| Full regression | **1080/1080 — 44 suites — 0 skipped — 0 failed** |
| Hosted acceptance | **26/26 checks** (18 §29 journey areas) — exit 0 |
| Hosted residue (independent probe) | tenants 0 · profiles 0 · settings 0 |
| FORCE RLS after cleanup | restored 8/8 · RLS-enabled-but-unforced tables: **0** |
| TypeScript | 0 errors |
| Production build | PASS — 80/80 pages (new administration route included) |
| Lint (all Phase 26 files) | 0 errors / 0 warnings |

## 11. Disclosed repairs / deviations

1. **Hosted harness scalar-JSON unwrap** — hosted PostgREST returns `save_site_config_draft`'s revision as a bare number; the harness initially read it through an array wrapper and published with a stale base revision (400). Fixed to accept scalar/object/array envelopes (same defect class disclosed in Phase 25 J2).
2. **J1 residue assertion refined** — provisioning fixtures legitimately write 1–2 audit rows (`tenant_modules` / platform-entitlement upserts, this-run-attributable by fresh tenant ids). The residue check targets `public_site_settings` rows and `site_config:*` audits, the actual prior-run signals.
3. **J15 corrected to real contracts** — public wrappers take `p_tenant_slug` (chrome) / `(p_tenant_slug, p_area)` (published config); the check was strengthened to assert no `"draft"`/`"history"` leakage in the public body.
4. **Security-suite premise corrected** — the pre-existing Core resolver (migration 0002 rule 1) grants tenant admins all permissions *by design*; the suite originally mis-assumed Control Center must suppress that. Now asserts the real boundary: authority flows only from Core's resolver and Control Center introduces zero grants.
5. **Hosted convergence replay** — apply-hosted re-applied 0011/0012 (pre-existing missing signature pins; idempotent — permission count stayed 43) and the pure `CREATE OR REPLACE` migrations (0059/0061/0062/0063/0064) to converge hosted content. No hosted schema drift.
6. **Core administration gaps documented** (§12-authorized): Notifications, Media, Geography and Assignments have no dedicated console routes today; disclosed as gaps, not recreated.

## 12. Explicit confirmations

- **No business module was duplicated** — Control Center contains status, configuration, health and link-outs only.
- **Control Center remains outside `module_code_enum`** — enum unchanged: `social, campaign, election, governance` (suite-pinned).
- **No new roles or permissions** — permission count stays 43 (suite-pinned).
- **Firebase remains fully retired** — zero references introduced.
- **Permanently removed modules remain absent** — Campaign Communications / Documents / Calendar appear nowhere in Control Center, navigation or configuration.
- **Stop conditions: none encountered.**
- **Phase 26 is the final planned Control Center implementation phase; no further phases were started.**

```text
POLITICORE — PHASE 26 — CONTROL CENTER ADMINISTRATION INTEGRATION — COMPLETE / PASS
```
