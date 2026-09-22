# POLITICORE — PHASE 1A IMPLEMENTATION REPORT

**Supabase + Multi-Tenant Foundation**

- **Date:** September 20, 2026
- **Phase:** 1A — foundation only (no application migration, no product modules)
- **Status of key in this report:** **Implemented** = built and verified · **Tested** = covered by automated tests · **Planned** = designed, not built · **Unresolved** = needs a decision or external input

---

## 1. What Was Implemented

### 1.1 Summary

The complete multi-tenant Supabase/PostgreSQL core foundation now exists **alongside** the running Firebase application, exactly as scoped:

| Deliverable (spec §37) | Status |
|---|---|
| A. Supabase project configuration | **Implemented** (local pglite runner; hosted-Supabase path documented) |
| B. PostgreSQL core schema | **Implemented** — migrations 0000–0005 |
| C. RLS on every core table | **Implemented + Tested** — 19 tables, 41 policies, default-deny |
| D. Authorization functions | **Implemented + Tested** — 14 database functions |
| E. Supabase Auth foundation | **Implemented** (client + compat layer; UI untouched) |
| F. Media Service foundation (R2) | **Implemented** (provider-agnostic; R2 provider with SigV4) |
| G. Geography validation | **Implemented — PASSED** (17 / 260 / 4,145, 0 errors) |
| H. Automated security tests | **Implemented + passing** — 37 tests, 3 suites |
| I. Architecture documentation | **Implemented** (this report + blueprint cross-refs) |

**Not** implemented (by design, per spec): portal migration, the four product modules, Governance, Control Center UI, dual-write (explicitly forbidden by §2), any change to Firebase behavior.

### 1.2 Key architectural facts

- **Shared schema + `tenant_id` + RLS** — as approved. No per-tenant schemas/databases.
- **Module subscriptions are tenant-level rows** (`tenant_modules`), never roles. All four modules (`social`, `campaign`, `election`, `governance`) are independently activatable; the dev tenant seeds with governance `false` to prove the off-state.
- **Tenant identity comes only from the authenticated identity** (`auth.uid()` → `politicore.profiles.tenant_id` via SECURITY DEFINER helpers) — never from client payloads.
- **`user_access` is gone by design**: hierarchical scope is resolved database-side by `scope_chain()`/`scope_covers()`; nothing is materialized, no index-sync code paths exist.

---

## 2. Files Created / Modified

### Created

| Path | Purpose |
|---|---|
| `supabase/migrations/0000_auth_shim.sql` | Local `auth` schema shim (users table, `auth.uid()`, Supabase roles `anon`/`authenticated`/`service_role` + grants). Skipped in spirit on hosted Supabase (real schema exists). |
| `supabase/migrations/0001_core_schema.sql` | Core schema: enums, tenants, tenant_modules, settings (platform/tenant/public-site), geography, profiles, positions/permissions/position_permissions, assignments, grants, media_assets, system_audits, notifications, triggers. |
| `supabase/migrations/0002_rls_authorization.sql` | Authorization functions + RLS enablement (FORCE) + 41 policies + profile self-update guard + server-side audit triggers. |
| `supabase/migrations/0003_geography_data.sql` | **Generated** seed (do not hand-edit): 1 state, 3 zones, 17 LGAs, 260 wards, 4,145 PUs. |
| `supabase/migrations/0004_reference_seed.sql` | Permission vocabulary (34), positions (7), position-permission matrix (96 rows, verbatim port of `POSITION_DEFAULT_PERMISSIONS`), dev tenant `ifeanyi-2027` + module rows + settings. |
| `supabase/migrations/0005_rpc_wrappers.sql` | Client-callable RPC surface (`politicore_has_permission`, `my_tenant_id`, `my_access_role`, `my_module_enabled`, `my_scopes_rpc`). |
| `src/lib/supabase/config.ts` | Supabase client factory + `isSupabaseConfigured()` (no app wiring yet). |
| `src/lib/supabase/auth-compat.ts` | Identity compatibility layer: Supabase Auth user → PolitiCore profile; RPC-based permission check (fails closed). |
| `src/lib/media/types.ts` | Provider-agnostic Media Service interface (`MediaProvider`, `MediaService`, visibility model). |
| `src/lib/media/r2-provider.ts` | Cloudflare R2 provider (SigV4 header auth + presigned URLs, put/publicUrl/signedUrl/remove/exists/head). |
| `src/lib/media/index.ts` | `mediaService()` factory: tenant-aware paths `tenants/{tenantId}/{purpose}/{yyyy}/{mm}/{uuid}`, `media_assets` registry writes, visibility-based access URLs, local-FS dev provider. |
| `scripts/validate-geography.ts` | Re-runnable geography validator (duplicate/orphan/malformed detection, totals). |
| `scripts/db/generate-geography-sql.ts` | Deterministic geography SQL generator (embeds approved Udi=UDI fix + zone membership). |
| `scripts/db/apply-migrations.ts` | Migration runner + integrity echo. |
| `scripts/db/test-db.ts` | Test-fixture helper (fresh migrated db). |
| `tests/security/helpers.ts` | Role-impersonation harness (`as(db, role, userId, sql)`) + fixtures. |
| `tests/security/tenant-isolation.test.ts` | 12 tenant-isolation tests. |
| `tests/security/authorization.test.ts` | 17 authorization tests. |
| `tests/security/geography.test.ts` | 8 geography integrity tests. |
| `vitest.security.config.ts` | Security test suite config. |

### Modified

| Path | Change |
|---|---|
| `package.json` | Added `@supabase/supabase-js` (dep) and `@electric-sql/pglite` (dev); added scripts: `db:apply`, `db:seed-geography`*, `db:seed-core`*, `db:reset`*, `test` (now security suite), `test:security`. (*reserved runner names) |
| `package-lock.json` | Lockfile from the installs above. |

**Untracked/local:** `lgas/` (source geography, kept out of git by the user's setup — only the generated SQL is committed) and `tsconfig.tsbuildinfo` (build artifact).

### Not modified (verified via git)

`src/**` (all Firebase application code), `firestore.rules`, `firebase.json`, `src/data/electoral.ts` (still imported by live code — left as the legacy fallback), all existing pages/components/contexts, `.env.local`.

---

## 3. Supabase Schema (as built)

```text
politicore
├── PLATFORM & TENANCY
│   ├── tenants (slug UNIQUE, generic — NOT campaign-shaped; primary_state_id FK)
│   ├── tenant_modules (tenant_id, module ∈ {social|campaign|election|governance}, enabled, config)
│   ├── platform_settings (singleton row 1)
│   ├── tenant_settings (jsonb; election_mode_enabled seeded false — was hardcoded-true defect)
│   └── public_site_settings (branding/homepage/navigation/footer/contact/social/seo
│                             + public_participation config — §9 configurable-public model)
├── GEOGRAPHY (reference; world-readable, platform-admin-writable)
│   ├── states → senatorial_zones → lgas → wards → polling_units (FK chain,
│   │   composite-unique codes per parent; polling_units.lga_id denormalized for scope locality)
├── IDENTITY & AUTHORIZATION
│   ├── profiles (id = auth.users.id; access_role; membership_types[]; registered location
│   │   lga/ward/PU FKs; lifecycle; social handles; points/rank for Social Force)
│   ├── positions (grants_authority=false for campaign_manager/council_chairman)
│   ├── permissions (34-row vocabulary) · position_permissions (96-row matrix, data not code)
│   ├── organizational_assignments (position × scope_type/scope_id, status, window)
│   └── permission_grants (granted true/false — explicit-deny preserved; optional scope)
├── MEDIA
│   └── media_assets (tenant_id, provider, bucket, object_key, visibility, purpose; UNIQUE key)
├── AUDIT & NOTIFICATIONS
│   ├── system_audits (server-written via triggers; no INSERT policy = client default-deny)
│   └── notifications (PER-USER rows: user_id NOT NULL; replaces tenant-wide-scan defect)
└── auth (shim locally; real Supabase schema in production)
```

**Distinct products preserved (§11–§15):** access_role ≠ positions ≠ membership ≠ grants; position matrix is reference data; grants keep explicit-deny; registered location is its own non-assignment path; profiles are tenant members (a future citizen-identity class will be separate, per Phase 0 §13).

## 4. Tenant Architecture

- `tenants` rows are organization-generic (`slug`, `name`, `primary_state_id`, status) — no political fields (spec §7).
- Every tenant-owned table carries `tenant_id uuid NOT NULL REFERENCES tenants` and RLS.
- Isolation enforced database-level (tested below); client-side filtering is never trusted.
- Platform-level authority (`platform_super_admin`) is distinct from tenant admin (`admin`/`tenant_super_admin`) — separate policies, tested separation (§5 of tests).

## 5. Module Subscription Architecture

- `tenant_modules` = tenant subscribes to a capability; enabled/disabled per module with a `config` jsonb for future Control Center module settings.
- `module_enabled()` reads the caller's own tenant's rows (SECURITY DEFINER); RPC `my_module_enabled('governance')` verified returning `false` for a tenant with governance off even for admins — gating data is correct for app-layer use.
- **Implemented + Tested** that module state is data, not roles: no role can flip a module on; tenant admins can manage only their own tenant's rows.

## 6. Authentication Foundation

- `src/lib/supabase/config.ts`: browser client factory (env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
- `auth-compat.ts`: session → profile fetch, RPC permission check. **Deliberately not wired into AuthContext/pages** (spec §21/§33). The existing Firebase `AuthContext` runs exactly as before.
- Planned (Phase 1B, documented in blueprint §19): Custom Access Token Hook embedding `tenant_id`/`access_role` claims; `invite-member` Edge Function replacing the secondary-app admin-create trick; password reset via Supabase's built-in flow.

## 7. RLS Architecture

- `ENABLE` + `FORCE` RLS on all 19 tables; no permissive-by-default policies; TRUNCATE not granted to app roles.
- Policy families: platform-admin full; tenant-scoped read/manage; self-row policies (profiles, notifications); world-readable reference/geography + public_site_settings; **system_audits has no write policy at all** (trigger-only writes); media follows tenant ownership.
- Trigger guards: profile self-updates cannot touch `tenant_id`, `access_role`, `membership_types`, `lifecycle_status`, `points`, `rank` (tested); assignment/grant/role changes auto-audit server-side (tested).

## 8. Authorization Functions (database-side)

`auth.uid()` (shim 0000) · `current_profile` / `current_tenant_id` / `current_access_role` (SECURITY DEFINER — the standard Supabase pattern to avoid policy recursion) · `is_platform_admin` / `is_tenant_admin` / `is_admin` / `is_election_officer` · `has_membership` · `module_enabled` · `scope_chain` (PU→ward→LGA→zone→state + campaign) · `scope_covers` (source covers target, direction verified by tests) · `my_scopes` (active, time-windowed assignments) · `has_permission` (central resolver: admin → officer fixed set → explicit deny → explicit allow → position defaults at covering scope) · `has_assignment_at` · RPC wrappers (0005).

This replaces the Firestore `user_access` index, its three client-side sync code paths, and the rules helper functions — the Phase 0 blueprint's central simplification.

## 9. Geography Validation Results

Re-runnable validator: `npx tsx scripts/validate-geography.ts` — **PASSED, 0 errors**:

| Check | Result |
|---|---|
| LGA files | 17/17 ✓ (all parse, kebab-case IDs) |
| Wards | **260/260** ✓ |
| Polling units | **4,145/4,145** ✓ (user updated source files mid-phase; re-verified) |
| Duplicates / orphans / malformed | 0 / 0 / 0 |
| PU-ID convention (`{ward}-pu-{NNN}`) | 100% consistent |
| Zone membership | every LGA in exactly one of 3 zones (canonical Enugu mapping) |
| LGA code collision | resolved by decision: **Udi=UDI, Udenu=UD** (embedded in generator) |

Database-side integrity is also **Tested** (geography suite): exact totals, FK-chain orphans = 0, `polling_units.lga_id` consistency = 100%, anon can read geography but zero profiles, tenant admins cannot insert states.

The earlier Phase 0 uncertainty ("dataset not in repository") is **resolved**: the restored `/lgas` source is complete and matches the official count after the user's update.

## 10. Media Service Architecture

- Modules consume **only** `src/lib/media` (`getMediaService()`); providers: `r2` (default, env-configured) and `local` (dev/tests).
- Operations: `upload` (tenant-aware key + registry row), `accessUrl` (public base URL vs presigned), `signedUrl`, `remove`, `exists`, `head`, `stat` (registry lookup).
- Visibility model: `public` vs `private` per object (election evidence private by default; CMS assets public) — spec §19.
- Registry: every upload writes `politicore.media_assets` (provider/bucket/key/visibility/purpose) for ownership tracking and future lifecycle/GDPR-style deletion.
- Cloudinary: **untouched and still serving the live app** (spec §20); migration path = point module code at the Media Service; no module ever calls R2/Cloudinary directly.

## 11. Cloudflare R2 Integration Status

**Implemented (code), not yet connected to live infrastructure.** Provider implements S3-compatible SigV4 (header auth for operations, presigned GET for private access) against `${bucket}.${accountId}.r2.cloudflarestorage.com`.

**Planned / requires inputs (Unresolved → needs credentials):** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL` (optional custom domain), `MEDIA_BUCKET`. A live end-to-end upload test against a real bucket was **not** run (no credentials in this environment) — the provider is unit-shaped and typechecked but unverified against the network. Listed in §14.

## 12. Security Tests

`npm test` → `vitest run --config vitest.security.config.ts` (fresh migrated pglite per file; queries run as `anon`/`authenticated`/`service_role` with per-request JWT claims, mirroring PostgREST).

| Suite | Tests | Covers (spec §32) |
|---|---|---|
| tenant-isolation | 12 | cross-tenant read/update/delete on profiles, assignments, grants, notifications, settings, tenants, tenant_modules; cross-tenant INSERT denied |
| authorization | 17 | role separation (admin/officer/platform), membership ≠ authority, module gating, hierarchical scope (ward→PU yes, lateral no, upward no), LGA coordinator coverage, scope_chain correctness, explicit deny-wins, scoped grants, self-promotion blocked, points tamper blocked, self-rename allowed, audit trigger, client audit-write denied |
| geography | 8 | exact totals, orphan/consistency/unique checks, zone membership, anon read / denied write |

## 13. Test Results (evidence)

```text
npx tsc --noEmit                → 0 errors
npx tsx scripts/db/apply-migrations.ts
  Applied 5 migrations (0000–0005)
  Row counts: states 1, zones 3, lgas 17, wards 260, polling_units 4145,
              permissions 34, position_permissions 96, tenant_modules 4
  Tables with RLS enabled: 19 · RLS policies: 41
npx vitest run --config vitest.security.config.ts
  Test Files  3 passed (3)
  Tests       37 passed (37)
npx eslint src/lib/supabase src/lib/media tests/security
  → 0 errors (2 benign unused-var warnings)
```

**Not re-run here (still exist, unchanged):** the Firebase rules suites (`npm run test:rules`) — they need the Firestore emulator; Firebase side untouched.

## 14. Known Issues / Unresolved

| # | Item | Severity | Note |
|---|---|---|---|
| 1 | R2 unverified against a live bucket | Medium | Needs credentials (§11). Provider logic is self-contained; first real upload should be a Phase 1B acceptance test. |
| 2 | JWT-claims auth not yet end-to-end | Medium | Locally, `auth.uid()` is driven by a claims GUC (faithful PostgREST emulation). Real Supabase Auth token flow lands with the Phase 1B Auth Hook. |
| 3 | `scope_id` is text (not polymorphic FK) | Low | Deliberate: scope can reference ward/LGA/PU/zone. Integrity enforced by convention + tests; a per-type FK+trigger design is a Phase 1B candidate. |
| 4 | Legacy election seed fallbacks still client-side | Low | `election-seed.ts` defaults remain in the running Firebase app until the Election module migrates. |
| 5 | `lgas/` kept untracked | Low | Per current repo setup; generated SQL is committed, so reproducibility is preserved. If you want `lgas/` committed, say so and I'll add it. |
| 6 | `tsconfig.tsbuildinfo` modified by builds | Info | Build artifact; consider gitignoring. |

## 15. Decisions Requiring Approval

1. **Phase 1B scope** — approve the recommended plan (§17), especially: real Supabase project creation + `db push`, and the Auth Hook claims design.
2. **R2 credentials** — provide account ID/keys (or a scoped token process) so Media Service can be verified end-to-end.
3. **Tenant provisioning flow** — who creates tenants (platform admin UI vs manual SQL) before the Control Center exists.
4. **`scope_id` integrity** — keep text convention (recommended for now) vs polymorphic-FK rigor.
5. **Commit `lgas/`?** — optional; recommended yes for full source-of-truth reproducibility.

## 16. What Was Deliberately NOT Changed

- **All Firebase application code, Firestore rules, emulators, and configuration** — the existing app runs exactly as before (verified: zero diffs under `src/`, rules, firebase.json).
- `src/data/electoral.ts` (legacy Nkanu-West fallback is still imported by live code).
- Cloudinary (still serving all existing media flows).
- No product modules (Social Force / Campaign / Election / Governance) built.
- No Governance tables, no Control Center UI, no dual-write/dual-read infrastructure (explicitly forbidden by spec §2).
- `docs/Migration.md` (Phase 0 blueprint) — untouched; this report is the addendum.

## 17. Recommended Phase 1B

**Foundation completion (small, fast):**
1. Create the hosted Supabase project; `supabase db push` the same migrations; configure the Custom Access Token Hook (tenant/role claims); connect the test harness to the hosted DB for one CI run.
2. Verify R2 end-to-end (upload/public/signed/delete) and lock the Media Service API.
3. Decide + implement `invite-member` Edge Function (replaces the secondary-app admin-create trick) and password reset.

**First migration vertical slice (proves the pattern end-to-end):**
4. Migrate **Identity + Notifications** to Supabase (profiles, per-user notifications, `AuthContext` becomes a compatibility layer over Supabase Auth) — smallest slice that exercises auth + RLS + UI together.
5. Migrate **Geography reads** to the relational tables (delete the multi-MB singleton fetch pattern).

**Then, per module (each gated by its own approval):** Election engine (state-machine DB functions, realtime trio, Cloudinary→Media Service for EC8 evidence), Campaign, Social Force (as the first non-campaign-native module), Leaderboard port (view with PU-exclusion preserved), Donation Ledger (DB-function atomicity + delete prohibition).

**Do not start** module work before Phase 1B's foundation items land — per spec, modules must be built on the new foundation, not in parallel with Firebase.

---

## Verification Snapshot (for reviewers)

```bash
npx tsx scripts/validate-geography.ts            # ✓ PASSED 17/260/4145, 0 errors
npx tsx scripts/db/apply-migrations.ts           # ✓ 5 migrations, counts above
npm test                                         # ✓ 37/37 security tests
npx tsc --noEmit                                 # ✓ clean
git diff --stat HEAD -- src/ firestore.rules     # ✓ empty — Firebase app untouched
```
