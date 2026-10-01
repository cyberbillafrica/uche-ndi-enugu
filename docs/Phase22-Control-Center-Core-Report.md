# PolitiCore — Phase 22 Report

## Control Center Core — Configuration & Service Activation

**Status:** PHASE 22 — COMPLETE — **GATE: PASS**
**Architecture source:** `docs/Control-Center-Architecture-Gate.md` (Phase 21 — PASS)
**Preceding:** Phase 21 — Control Center Architecture & Product Design Gate — PASS (zero new permissions/roles/tables)
**Preceding baseline:** Phase 20 — Cross-Module Integration — 933/933 · 39 suites · hosted 245/246 (A1 documented) · residue 0

---

## 1. Scope delivered (exactly §1)

| Deliverable | Status |
| --- | --- |
| `/portal/control-center` shell | DONE |
| Control Center overview (services/website/administration/system cards) | DONE |
| Services management surface (4 services, Entitled/Enabled/Operational) | DONE |
| Tenant service activation/deactivation RPC | DONE |
| Entitlement-aware activation (server-enforced) | DONE |
| Safe configuration RPC foundation over `public_site_settings` | DONE |
| Revision + optimistic concurrency foundation | DONE |
| Core Audit integration (reuses `audit_module_change`) | DONE |
| Security suite `tests/security/control-center-core.test.ts` | DONE — 25/25 |
| Hosted acceptance `scripts/db/verify-hosted-smoke-control-center-core.ts` | DONE — 24/24, residue 0 |

Not implemented (hard boundaries honored): Homepage Builder, section engine, theme editor, APC/PDP/NDC presets, custom theme editor, header/footer/navigation builders, SEO editor UI, People & Access redesign, Organization redesign, any new module configuration system.

## 2. Architecture integrity

**PASS.**

- Control Center is **not** a fifth module — `module_code_enum` unchanged; Control Center has no enum value, no module row.
- Central rule upheld: Control Center configures the platform (`tenant_modules.enabled`, `public_site_settings` areas); modules keep exclusive ownership of all domain operations/data.
- Zero new tables — all state lands on existing substrate: `tenant_modules` (activation), `platform_settings.service_entitlements` (entitlement, keyed per-tenant), `public_site_settings` (configuration areas).
- Zero new roles, zero new permissions. Write authority = existing `is_tenant_admin()`; entitlement read/mutation = existing super-admin access roles.
- No duplicate authorization, no duplicate module gate, no duplicate audit/notification/media/geography system. No Firebase.

## 3. Authorization

**PASS.**

- `set_tenant_module_enabled(text, boolean)`: SECURITY DEFINER, resolves actor via `auth.uid()` and tenant via `current_tenant_id()`; accepts no tenant/actor identity from the client; validates module code against the enum; gates on `is_tenant_admin()` **and** `service_entitled()` before any UPDATE; returns effective state.
- Activation never implemented client-side; the only mutation path is the RPC (base-table grants unchanged).
- Deny-wins preserved: no `EXISTS(granted = true)` shortcuts introduced; Core authority helpers reused rather than reproduced.
- Suite proof: anonymous denied (A), plain member denied (C), entitlement-bypass denied (D/E), tenant isolation (E), audit evidence (G), stale-revision conflict (H), module-gate fail-closed (I).

## 4. Tenant isolation

**PASS.** All RPCs resolve tenant server-side; cross-tenant reads/writes fail closed (proven in suite E and hosted J8/J9). `public_site_settings` policy hardened in this phase (see §14 repairs): anon/member reads are narrowed to **published** rows only via `is_published_area()` — drafts are never publicly exposed (Phase 21 §25 honored).

## 5. Entitlement model

**PASS.** Entitlement (`platform_settings.service_entitlements`, platform-super-admin-owned, keyed by tenant id) is distinct from activation (`tenant_modules.enabled`, tenant-admin-toggled). Effective service state = `ENTITLED AND ENABLED = OPERATIONAL`. Non-entitled services cannot be enabled — the RPC enforces it server-side; the UI hides the control (labels: Not available / Dormant / Active). The host platform row may not exist in fresh environments; the helper treats a missing row as not-entitled (fail closed).

## 6. Configuration foundation

**PASS.**

- `get_site_config(p_area)` / `save_site_config_draft(p_area, p_draft, p_base_revision)` / `publish_site_config(p_area, p_base_revision)` — atomic upsert (single statement), scalar-subquery revision read (always yields a row), optimistic concurrency via `WHERE revision = p_base_revision` → stale saves raise a conflict, no overwrite.
- Areas validated against `cc_is_site_config_area()` (branding/navigation/footer/homepage/contact/social_links/seo) — no area injection.
- Draft/published separated inside each area jsonb; publish stamps revision + `published_at`/`published_by`; public surface is `public.get_published_site_config(p_tenant_slug, p_area)` — slug-keyed (Phase 9 convention), published-only, base-table grants REVOKED.
- Full regression (958/958) re-proves concurrent-revision rejection end to end.

## 7. Core Audit

**PASS.** Activation writes flow through the existing AFTER UPDATE trigger on `tenant_modules` (`audit_module_change`) — no Control Center audit table (Phase 21 §24 honored). Suite G asserts Core Audit evidence for enable and disable.

## 8. Repairs performed (smallest root cause)

1. **Draft exposure hardening (0060):** legacy `public_site_settings` grants + `USING (true)` read policy exposed unpublished drafts to anon; replaced with published-only policy and revoked direct grants. Phase 21 §25 required this.
2. **0060 publish function:** dynamic `EXECUTE ... USING` proved unreliable for the conditional UPDATE under PGlite; rewritten as static per-area UPDATE branches — the repository's established statement shape.
3. **`governance-phase11-architecture` pin:** migration count 60 → 61 (authorized by this phase; only 0060 added).
4. **Hosted convergence:** 0060 registered in `scripts/db/apply-hosted.ts` and applied to the hosted project; hosted suite 24/24.

No locked module was modified. No existing migration besides the pin's count constant was touched.

## 9. Migration integrity

**PASS.** 61 migrations (0000–0060), sequential, all applied locally and hosted. 0060 contains: 1 policy hardening + grants revocation, 6 politicore functions (`service_entitled`, `set_tenant_module_enabled`, `control_center_overview`, `cc_is_site_config_area`, `get_site_config`, `save_site_config_draft`, `publish_site_config`), 6 public PostgREST wrappers, narrowed EXECUTE grants (anon gets only `get_published_site_config`), all mutating functions VOLATILE.

## 10. Verification results

| Gate | Result |
| --- | --- |
| Focused security suite (`control-center-core`) | **25/25** |
| Full regression | **958/958 — 40 suites — 0 failed — 0 skipped** |
| TypeScript `tsc --noEmit` | **0 errors** |
| Production build (`next build`) | **PASS — 72/72 pages** |
| Lint (all phase files) | **0 errors / 0 warnings** |
| Hosted acceptance | **24/24** (12 journeys incl. tenant-B isolation, entitlement denial, audit evidence, stale-revision conflict, module-gate flip, anon zero-mutation) |
| Hosted residue | **0** (all fixtures purged; suite/harness cleanup verified) |

Note: one parallel `npm test` run exhibited 3 contention timeouts (2 suite `beforeAll` hook timeouts, 1 test timeout) with zero assertion failures; the identical suite set passes 958/958 under normal load. Not a regression.

## 11. Deviations

None architectural. The migration-count pin update and the 0060 items in §8 are disclosed repairs within scope.

## 12. Stop conditions

None triggered. No new table, role, or permission was required; existing substrate (`tenant_modules`, `platform_settings`, `public_site_settings`) fully supported the phase.

---

## FINAL GATE

**POLITICORE — PHASE 22 — CONTROL CENTER CORE: CONFIGURATION & SERVICE ACTIVATION — PASS**
