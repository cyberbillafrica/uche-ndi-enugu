# PolitiCore — Phase 1B Implementation Report

**Scope:** Supabase foundation hardening · Real Supabase Auth · Media verification (R2) · Member ≠ public participant seam · First vertical slice (Identity, Notifications, Geography reads)

**Status:** Complete. All Phase 1B success criteria verified. Final hard stop respected — no module work was begun.

---

## 1. Executive summary

The Phase 1A local foundation was reviewed migration-by-migration, hardened against the **real hosted Supabase project** (PostgreSQL 17.6), and extended with the Custom Access Token Hook, PostgREST-accessible surface, tenant provisioning, and the signup backfill that enforces the member ≠ public-participant boundary. Real Supabase Auth (GoTrue) was verified end-to-end on the hosted project. The provider-agnostic Media Service was verified end-to-end against the real Cloudflare R2 bucket, which surfaced and fixed a genuine presign bug. The vertical slice (identity, notifications, geography) runs entirely on PostgreSQL through the hosted data API.

**Test evidence (exact counts):**

| Suite | Result |
|---|---|
| Local security suite (Phase 1A files) | 37/37 pass |
| Local Phase 1B suite (`tests/security/phase1b.test.ts`) | 16/16 pass |
| **Full local suite** (`npm test`, 4 files) | **53/53 pass** |
| Hosted acceptance suite (`scripts/db/verify-hosted-auth.ts`) | **28/28 checks pass** |
| Hosted R2 end-to-end (`scripts/db/verify-r2-e2e.ts`) | **14/14 checks pass** |
| `npx tsc --noEmit` | 0 errors |
| ESLint — all new Phase 1B code | 0 errors (6 documented warnings) |
| ESLint — pre-existing legacy code | 93 pre-existing errors, all in untouched Firebase-era files (see §40.10) |

No Phase 1B stop condition was triggered (analysis in §5).

---

## 2. Phase 1A migration review (required pre-work)

Every existing migration was inspected before modification. Assessment:

| Migration | Assessment |
|---|---|
| `0000_auth_shim.sql` | Defect for hosted: unconditionally created `auth.users` and granted privileges on `auth.*` — fails on real Supabase where `supabase_auth_admin` owns the schema. **Fixed by structural self-guard** (see §40.1). |
| `0001_core_schema.sql` | Sound. Shared-schema multi-tenancy, generic tenants, independent `tenant_modules`, provider-independent `media_assets`, per-user `notifications`, server-controlled `system_audits`. Unchanged. |
| `0002_rls_authorization.sql` | Sound. Hierarchical scope resolution, explicit-deny-wins, Election Officer boundary, registered location ≠ authority. One hosted defect: `FORCE ROW LEVEL SECURITY` (fixed in 0006, below). |
| `0003_geography_data.sql` | Sound. Generated from `lgas/` by `scripts/db/generate-geography-sql.ts`; totals verified on hosted (§40.9). Unchanged. |
| `0004_reference_seed.sql` | Sound. Unchanged. |
| `0005_rpc_wrappers.sql` | Sound. Unchanged. |

---

## 3. Phase 1B stop-condition analysis — none triggered

| Stop | Evaluated | Outcome |
|---|---|---|
| 1 — hosted schema differs materially | Three environment defects found (FORCE RLS, auth shim, PostgREST surface) | **Not triggered:** all were *hardening*, applied as new migrations/edits in the canonical migration chain; local and hosted run the identical migration set and both suites pass |
| 2 — Auth requires structural identity change | GoTrue accepted the existing `profiles` model unchanged | Not triggered |
| 3 — RLS cannot reproduce guarantees | All 41 policies reproduce locally **and** on hosted (verified by acceptance suite) | Not triggered |
| 4 — public participants need new identity architecture | Reviewed: `profiles` stays membership-only; a non-member signup receives **no profile** unless explicitly provisioned into a tenant; nothing in the schema forecloses a future public-participant relation | Not triggered — seam preserved (§40.5) |
| 5 — R2 requires bypassing Media Service | All R2 access went through `MediaService`; no domain code touches R2 | Not triggered |
| 6 — Firebase rewrite needed for slice | Slice built additively in `src/lib/supabase/`; zero existing files edited (git footprint in §40.10) | Not triggered |
| 7 — module migration necessary | None begun | Not triggered |
| 8 — data model ambiguity | One documented ambiguity: **public asset delivery on R2** — `R2_PUBLIC_BASE_URL` is not configured, so unsigned public reads cannot be demonstrated; the service falls back to presigned GET. Options (r2.dev / custom domain / future proxy) listed in §40.6. Does not block later modules | Documented |

---

## 40. Required report content

### 40.1 Database changes

**Changed (1):** `supabase/migrations/0000_auth_shim.sql` — restructured to be **structurally self-guarding**: at run time it detects whether a real `auth` schema (with `auth.users`) exists. On hosted Supabase (including via `supabase db push`) every shim element no-ops and Supabase-owned objects are never touched; on local pglite the full shim is created. All `auth.*` DDL/grants now live inside the guard. No history rewrite — the migration remains first in the chain and is idempotent in both environments.

**Added (7 new migrations, all applied locally and to hosted):**

| Migration | Content |
|---|---|
| `0006_hosted_hardening_and_auth_hook.sql` | (a) `NO FORCE ROW LEVEL SECURITY` on the two tables SECURITY DEFINER code touches — `profiles` and `system_audits`. On hosted, `postgres` is not a superuser, so FORCE would have subjected the definer helpers to the very policies that consult them (infinite recursion on `profiles`) and denied the audit trigger's inserts into `system_audits` (no INSERT policy), breaking all authority-table writes. **RLS stays enabled and fully enforced for anon/authenticated/service_role** — only the table-owner bypass needed by definer code returns. (b) Explicit hosted privilege replication (grants for `anon`/`authenticated`/`service_role`). (c) `politicore.custom_access_token_hook` (§40.3). |
| `0007_postgrest_surface_and_provisioning.sql` | Thin `public.*` RPC wrappers over the `politicore.*` identity/authorization functions (PostgREST on hosted exposes only `public` by default). `provision_tenant(p_slug, p_name, p_owner_email)` — platform-super-admin-only bootstrap that creates tenant + settings + four module rows. Signup backfill trigger on `auth.users` (§40.5). Server-side audit trigger on `tenant_modules` activation changes. |
| `0008_notification_rpc_surface.sql` | Public-schema wrappers for the notification RPCs (`my_notifications`, `mark_notifications_read`, `my_unread_count`, notification insert path). |
| `0009_postgrest_views_and_realtime.sql` | Ten `public.*` **security-invoker views** (`politicore_profiles`, `tenants`, `tenant_modules`, `public_site_settings`, `notifications`, `states`, `senatorial_zones`, `lgas`, `wards`, `polling_units`) so REST reads reach the data through RLS — `security_invoker` guarantees the underlying policies still apply, default-deny included. Notifications views/RPCs registered in the `supabase_realtime` publication. |
| `0010_provision_guard_null_fix.sql` | **Security fix found by hosted acceptance testing:** `is_platform_admin()` returns NULL (not false) for a caller with no platform role, and plpgsql `IF NOT <NULL> THEN reject` silently passes. A bare authenticated user could provision tenants. The guard now rejects NULL explicitly (`IS NOT TRUE`). Supersedes the 0007 function. |
| `0011_provision_module_defaults.sql` | `provision_tenant` creates all four module rows **disabled** — module activation is a deliberate, audited subscription act, never a side effect of provisioning. Supersedes 0007/0010 function (chain preserves the 0010 NULL guard). |
| `0012_auth_hook_app_metadata.sql` | Hook robustness: `jsonb_set` cannot create the intermediate `app_metadata` object when absent (GoTrue normally includes it, but the function no longer depends on that). Supersedes the 0006 function. |
| `0013_senatorial_zone_correction.sql` | Geography data correction (post-review, user-reported): the third senatorial zone was seeded as "Enugu South" (`enugu-south-zone`, ES) — factually wrong, as Enugu South is an LGA of Enugu East. 0003's source was corrected to the canonical **Enugu West** (`enugu-west-zone`, EW; 5 LGAs: Aninri, Awgu, Ezeagu, Oji River, Udi — LGA memberships were always correct), and 0013 repairs already-seeded databases. Totals unchanged (1/3/17/260/4,145). Verified on hosted: three zones EE(6)/EN(6)/EW(5), zero bogus-zone rows, all counts exact. |

**Tooling:** `scripts/db/apply-hosted.ts` — hosted migration runner (direct `DATABASE_URL` connection, signature-based idempotence, tolerant of the quoted/encoded connection string in `.env.local`); npm script `db:apply:hosted`. Supporting: `scripts/db/verify-hosted-auth.ts`, `scripts/db/verify-r2-e2e.ts`, `scripts/db/purge-dev-tenants.ts`.

### 40.2 Auth — how Supabase Auth connects to profiles / membership / authorization

- **profiles ↔ auth.users:** 1:1, `profiles.id = auth.users.id`. On hosted, a trigger on `auth.users` backfills a profile **only** when signup metadata carries a valid `tenant_slug` (§40.5).
- **Tenant membership:** explicit — a profile gets `tenant_id` via provisioning/invitation, never implicitly from authentication. `membership_types` starts empty for backfilled members.
- **Authorization:** unchanged from Phase 1A — database-authoritative via `has_permission` / scope resolution / explicit-deny, resolved through SECURITY DEFINER helpers (`current_profile`, `current_tenant_id`) which now work on hosted thanks to the 0006 NO FORCE correction.
- **Real GoTrue verified on hosted:** 28/28 acceptance checks include real password-grant sign-ins for two members, refusal of provisioning for non-platform-admins (including the NULL-bypass case), RLS denials through the REST surface, and the audit trail from module activation.
- **Operational knowledge captured:** seeding `auth.users` directly (used by acceptance tooling for deterministic users) requires the canonical GoTrue-compatible recipe: `instance_id` = the project instance UUID (zero-UUID for a fresh project), `aud` + `role` = `'authenticated'`, `is_super_admin = false`, `confirmed_at` omitted (generated column), **empty-string** token columns, `phone` **non-NULL** (NULL breaks GoTrue's Go scanner; unique synthetic values used), bcrypt **cost ≥ 10** (pgcrypto's default cost 6 is rejected at login), plus a matching `auth.identities` row. REST signup via the publishable key works but is subject to the free-tier built-in-SMTP rate limit.

### 40.3 JWT / Auth Hook — exact claims and rationale

`politicore.custom_access_token_hook` adds exactly two claims under `claims.app_metadata.politicore`:

- **`tenant_id`** (uuid, nullable) — the caller's resolved tenant, from `current_tenant_id()`.
- **`access_role`** (text) — the stable profile role.

**Why only these:** they are stable identity context. Everything else — permissions, positions, organizational assignments, scope, module capability — stays **database-authoritative**: the DB resolver (`has_permission` etc.) decides every authorization question at query time, so permission changes take effect immediately without re-issuing tokens, and a stolen stale token grants nothing the database no longer allows. `0012` makes the hook robust to a missing `app_metadata` object.

### 40.4 RLS — policies added/changed and why

- **Changed (enabling, not weakening):** `NO FORCE ROW LEVEL SECURITY` on `politicore.profiles` and `politicore.system_audits` (0006). Reason in 40.1. No policy text was weakened; default-deny for application roles is intact and was verified on hosted (anon sees zero rows; members cannot self-promote; notifications are per-user; registry assets are tenant-isolated).
- **All other policies unchanged** from Phase 1A: 19 RLS tables / 41 policies confirmed on hosted.
- **New access paths (0008/0009) preserve RLS:** public RPC wrappers are `SECURITY DEFINER` only where Phase 1A already established that pattern; the ten public views are `security_invoker`, so every policy applies to view reads exactly as to base-table reads.

### 40.5 Member ≠ public participant distinction

- `profiles` remains **membership-only**. The signup backfill trigger fires only when metadata contains a valid `tenant_slug`; it creates a profile with `access_role='member'` and **empty** `membership_types` — no authority, no role, no permissions. Signups with an unknown `tenant_slug` are **rejected**; signups without one get **no profile at all**. Verified on hosted (acceptance checks 3–7) and locally (Phase 1B suite).
- Nothing grants organizational authority for merely being authenticated: authority requires an explicit membership + position/assignment/grant chain (Phase 1A model, unchanged).
- The schema does not foreclose future public participants: a future `public_participants` relation can key off `auth.users.id` without touching `profiles`; no member-only field was made nullable "for public use", and no public-participant capability was prematurely added to the member model.

### 40.6 Media — R2 test results (14/14)

All access through `MediaService` (provider-agnostic; R2 only behind `R2Provider`). Real bucket, real registry rows, full cleanup:

- Upload (public + private) to R2 + registry row ✓; `head()` metadata ✓; `stat()` registry metadata ✓; `exists()` true/false ✓
- **Public asset retrievable via presigned GET (HTTP 200)** — with the documented ambiguity: `R2_PUBLIC_BASE_URL` is not configured, so *unsigned* public delivery (r2.dev / custom domain) is **unresolved**. Options: configure `R2_PUBLIC_BASE_URL` (r2.dev or domain), or keep presigned fallback. Does not affect later modules' write paths.
- Private asset fetchable **with** signature (HTTP 200) ✓; **denied without signature** (HTTP 400, R2 `InvalidArgument`) ✓; **denied with tampered signature** (HTTP 403) ✓
- Registry tenant isolation: authenticated non-member sees **0** of tenant A's assets ✓; delete removes object + registry rows ✓

**Hardening found and fixed during verification:** the R2 presigned-URL signer included `x-amz-content-sha256`/`x-amz-date` in the canonical request while declaring `SignedHeaders=host` — R2 correctly rejected every presigned URL with `SignatureDoesNotMatch`. Fixed (canonical request now contains exactly the signed headers; proven against R2's own reported StringToSign). Also: `put()` now fails loudly on non-2xx instead of silently "succeeding", and `getMediaService()` honors `R2_BUCKET_NAME` and accepts an optional registry DB handle.

### 40.7 Identity migration (vertical slice)

`src/lib/supabase/identity.ts` + `auth-compat.ts` provide the application-level identity surface for new code: sign-in state from real Supabase Auth, identity resolution (tenant, role, memberships, module capabilities) through the public views, and the seam where the existing `AuthContext` can later delegate — without touching any Firebase file. Legacy `src/data/electoral.ts` and all Firebase code remain untouched and operational.

### 40.8 Notifications migration (vertical slice)

Per-user notifications through PostgreSQL: list via `my_notifications` (own rows only), `mark_notifications_read` (own rows only, returns count), `my_unread_count`, and admin-only inserts — all verified on hosted through the REST surface, including cross-user denial. This replaces the legacy tenant-wide collection download + client-side filter pattern for new code (the acknowledged Firestore privacy/performance defect). Realtime publication registered in 0009.

### 40.9 Geography — proof of 1 / 3 / 17 / 260 / 4,145

Hosted, via the anonymous data API through the `public.*` views: **1 state · 3 senatorial zones · 17 LGAs · 260 wards · 4,145 polling units** — exact match with the Phase 1A local results and the validated `lgas/` source dataset. Reference data readable anon (by design); hierarchical reads (zone → LGA → ward → PU) verified in the acceptance suite.

### 40.10 Regression — Firebase application intact

- `git status`: **zero modifications to tracked `src/` files** — all Phase 1B work is new files in `src/lib/supabase/`, `src/lib/media/`, `supabase/migrations/`, `scripts/db/`, `tests/security/`, plus the additive 0000 shim restructure. The only tracked-file changes are `package.json`/lockfile (dev deps: `pg`, `@types/pg`; scripts) and `tsconfig.tsbuildinfo`.
- Full local suite: **53/53** (4 files) — all pre-existing Phase 1A suites pass unmodified in behavior.
- `tsc --noEmit`: 0 errors project-wide.
- ESLint: all new Phase 1B code — **0 errors** (6 warnings: unused imports/fixtures in test/verify scripts, documented). Project-wide `npm run lint` reports 93 pre-existing errors across legacy Firebase-era files (`src/app/portal/**`, `src/lib/firebase/**`, `src/components/**`); these predate Phase 1B, are outside the phase's mandate (no unrelated refactoring), and are enumerated here as required documentation rather than "clean".

### 40.11 Tests — exact counts

| Suite | Count | Result |
|---|---|---|
| Phase 1A local suites (3 files) | 37 | 37 pass, 0 fail |
| Phase 1B local (`phase1b.test.ts`) | 16 | 16 pass, 0 fail |
| **Total local** | **53** | **53 pass** |
| Hosted acceptance (`verify-hosted-auth.ts`) | 28 checks | 28 pass, 0 fail |
| Hosted R2 e2e (`verify-r2-e2e.ts`) | 14 checks | 14 pass, 0 fail |

Notable coverage: provisioning bootstrap + post-bootstrap refusal (incl. the 0010 NULL-bypass regression), duplicate/invalid slug refusal, all-false module defaults (0011), signup backfill + unknown-slug rejection + no-slug → no profile, hook claims shape, module-activation audit row, notifications isolation matrix, anon default-deny through views, geography totals, real GoTrue sign-in, module activation flip false→true via the audited path, and registry cross-tenant isolation. Dev tenants/users are purged after each hosted run (`purge-dev-tenants.ts`).

---

## 4. Success criteria checklist

```text
[x] Existing Phase 1A migrations reviewed          [x] Member ≠ public participant preserved
[x] Hosted Supabase configured                     [x] Election Officer boundary preserved
[x] Phase 1A schema successfully established       [x] Registered location ≠ organizational authority
[x] Hosted RLS verified                            [x] Hierarchical scope authorization preserved
[x] Real Supabase Auth working                     [x] Explicit deny wins
[x] Auth context/compatibility boundary working    [x] R2 tested end-to-end (14/14)
[x] JWT/Auth Hook implemented                      [x] Media Service remains provider-agnostic
[x] Tenant identity securely resolved              [x] Identity vertical slice working
[x] Module activation separate from authorization  [x] Notifications vertical slice working
[x] Geography reads working from PostgreSQL        [x] 1/3/17/260/4145 verified (hosted)
[x] Existing Firebase application still works      [x] Existing Phase 1A security tests still pass (37/37)
[x] New Phase 1B tests pass (16/16)                [x] TypeScript clean (0 errors)
[x] Lint clean in new code; legacy warnings documented
[x] Phase1B-Implementation-Report.md created
```

## 5. Environment & security notes

- Hosted project: Supabase (PostgreSQL 17.6); migrations applied via `npm run db:apply:hosted` (source of truth remains `supabase/migrations/`).
- **Recommendation:** rotate the Supabase database password — the connection string was briefly visible in a local terminal error transcript during setup. `DATABASE_URL` lives in `.env.local` (untracked).
- R2 credentials are bucket-scoped (ListBuckets 403 by design); `R2_PUBLIC_BASE_URL` unset — see §40.6.

## 6. Final hard stop

Phase 1B is complete. Per the phase mandate, work **stops here**. Election, Campaign, Social Force, Governance, Donation Ledger, Leaderboard, and Control Center UI are **not started** and await the next separately reviewed and approved phase.
