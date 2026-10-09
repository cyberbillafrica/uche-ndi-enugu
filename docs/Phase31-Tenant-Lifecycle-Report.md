# Phase 31 — Tenant Lifecycle & Subscription Enforcement (SaaS Phase D) — Report

## 1. Status

**PASS.** Every gate green: focused suite 41/41, full regression 1264/1264 (48 suites;
4 files flaked under concurrent load or hit stale pins and were re-verified to pass
individually — see §10), hosted acceptance 20/20 with residue 0 and FORCE RLS restored,
tsc 0 errors, production build PASS, lint 0 errors for all Phase 31 files (2 warnings in
`portal/layout.tsx` are the pre-existing legacy baseline, present before Phase 31).

## 2. Files changed

**New (Phase 31):**
- `supabase/migrations/0069_tenant_lifecycle_enforcement.sql` (757 lines)
- `src/lib/supabase/tenantLifecycle.ts` (125 lines; service layer: `suspendTenant`,
  `restoreTenant`, `archiveTenant`, `getTenantLifecycleHistory`,
  `getTenantLifecycleStatus`, `runLifecycleTransitions` + labels/types)
- `src/app/portal/admin/lifecycle/page.tsx` (289 lines; platform lifecycle console)
- `tests/security/tenant-lifecycle-enforcement.test.ts` (801 lines, 41 tests A–J)
- `scripts/db/verify-hosted-smoke-tenant-lifecycle-enforcement.ts` (588 lines, L1–L18b)

**Modified:**
- `src/lib/supabase/index.ts` — barrel exports (tenantLifecycle)
- `src/app/portal/layout.tsx` — portal navigation wiring (`/portal/admin/lifecycle`)
- `scripts/db/apply-hosted.ts` — 0069 signature entry (now also pins the refreshed
  `public.tenants` view columns and the re-subscription revival literal)
- Migration pins updated to 70 migrations / `^0069_/` in three test suites
  (`subscriptions-billing-core` J4, `commercial-plans-entitlements` I5,
  `governance-phase11-architecture` D1) — plus the missed Phase 30 pin
  (`saas-self-service-onboarding` J6: 69/0068 → 70/0069)

## 3. Migrations added

`supabase/migrations/0069_tenant_lifecycle_enforcement.sql` — one migration, zero new
tables (lifecycle facts live on `tenants` + Core Audit, per the repository's migration
discipline). Applied to the pglite fresh-DB path (probe `.tmp-runs/probe-0069g.log`
PROBE_EXIT=0) and to the hosted project via signature-pinned `apply-hosted`
(`.tmp-runs/apply-hosted-0069d.log` — **HOSTED MIGRATIONS OK**, APPLY_EXIT=0). DDL is
idempotent (guarded `CREATE TYPE`, `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`
+ recreate) so signature drift is re-appliable without failing on existing objects.

Contents:
- **Enum + columns:** `politicore.tenant_lifecycle_enum` =
  `provisioning, active, past_due, restricted, suspended, cancellation_pending,
  cancelled, archived` (exactly 8 states; pinned by test). `tenants` gains
  `lifecycle_status` (DEFAULT 'active', backfilled from NULL), `lifecycle_reason`,
  `lifecycle_changed_at`, `lifecycle_changed_by`, index `tenants_lifecycle_idx`.
  The legacy `tenants.status` column is now DERIVED: a trigger keeps it in lockstep
  (`derive_tenants_status`) and rejects direct writes; its legacy CHECK and values
  are unchanged.
- **Transition matrix** (`tenant_lifecycle_allowed`, IMMUTABLE): the full legal-edge
  set — see §4.
- **Guard trigger** (`trg_guard_tenant_lifecycle`, BEFORE UPDATE ON tenants): enforces
  the matrix (raises `illegal tenant lifecycle transition X → Y`), requires a reason
  of ≥ 5 chars for every change, stamps actor + timestamp, keeps `status` derived.
  A transaction-local GUC (`politicore.lifecycle_writer` = 'apply', set by
  `apply_tenant_lifecycle` via `set_config(..., true)`) is the ONLY way a lifecycle
  change may occur without a direct actor — server-context triggers (the subscription
  coordinator) rely on it; the GUC is never settable by a client through PostgREST.
- **The single lifecycle writer** (`apply_tenant_lifecycle(uuid, tenant_lifecycle_enum,
  text, text, jsonb) RETURNS boolean`): validates the matrix, scopes coordination
  (see §5), writes tenant + Core Audit (`tenant_lifecycle_transitioned` with
  server-resolved actor, from/to, source, reason) and fires owner notifications for
  `past_due`/`restricted`/`suspended`/`cancelled` plus restore/cancellation-pending
  notices, via the existing `billing_notify` (targets tenant_super_admin profiles
  with lifecycle_status='active'). Idempotent: same-state writes are no-ops.
- **Subscription coordination** (`trg_coordinate_tenant_lifecycle`, AFTER UPDATE OF
  status ON subscriptions): one-directional — subscription → tenant ONLY
  (past_due/restricted/active/cancelled; trialing deliberately NO lifecycle change).
- **Centralized access enforcement** (`assert_tenant_operationally_active(module)`):
  the ONE authoritative check, in order: lifecycle eligibility (`active`, `past_due`
  only) → effective subscription status → module entitlement (Phase 28 map) → module
  activation (`tenant_modules`) → caller scope. Returns the tenant id; raises on
  refusal. Public website rendering NEVER calls it (public rules unchanged; F7 pins
  `get_published_site_config` anon-readable).
- **Platform operations** (§6): `suspend_tenant` / `restore_tenant` / `archive_tenant`
  / `tenant_lifecycle_history` — platform_super_admin ONLY, reason ≥ 5 chars,
  SECURITY DEFINER, server-attributed audit + owner notification. Archival is
  non-destructive and reversible; restore refuses a healthy tenant; double-suspend is
  an idempotent no-op.
- **Lifecycle processor** (`process_lifecycle_transitions()`): idempotent, bounded
  batch (200), retryable, audited; realigns drifted tenant state with the effective
  subscription state (missed-event backstop). There is NO scheduler — it is invoked
  through the platform console exactly like the Phase 29 processors.
- **PostgREST surface:** public INVOKER wrappers (`public.suspend_tenant`,
  `restore_tenant`, `archive_tenant`, `tenant_lifecycle_history`,
  `process_lifecycle_transitions`, `tenant_lifecycle_status`) — EXECUTE granted to
  authenticated, REVOKEd from anon/PUBLIC (the underlying politicore functions
  re-verify authority server-side). The `public.tenants` view (0009, `SELECT *` with
  `security_invoker`) is refreshed via `CREATE OR REPLACE` so the new lifecycle
  columns are exposed consistently; existing grants persist.
- **Provisioning integration (Phase 30):** new tenants start explicitly 'active'
  (already the column default); `onboarding_state` deliberately ignores lifecycle.

## 4. Lifecycle model and transition matrix

Architecture principle (§1 of the prompt) preserved: subscription status, tenant
lifecycle, module entitlement, module activation and user authorization remain
DISTINCT concepts, bridged only by the one-directional coordinator and the single
access check. Trialing is a subscription state, never a lifecycle state (C2).

Legal edges (`tenant_lifecycle_allowed`):
- provisioning → active | restricted | suspended | cancelled
- active → past_due | restricted | suspended | cancellation_pending | cancelled | archived
- past_due → active | restricted | suspended | cancelled
- restricted → active | suspended | cancelled   (no restricted → past_due)
- suspended → active   (platform-only lift; sticky against payments)
- cancellation_pending → active | cancelled | suspended
- cancelled → active (re-subscription revival) | archived
- archived → active   (platform-only reversal)

Every change requires a reason ≥ 5 chars, stamps `lifecycle_changed_at/_by`, and is
audited with from/to (I1; the hosted history RPC returns no row with NULL from/to).

## 5. Subscription integration

One-directional: subscription status changes coordinate the tenant lifecycle; the
lifecycle NEVER writes subscriptions (J5 pins this against the migration source).
Coordination is SCOPED, not blind:

- past_due/restricted/cancelled subscription events never lift or deepen an
  administrative suspension/archival (suspension wins; sticky — L11, C3).
- A subscription event on an `archived` tenant is swallowed (platform-controlled
  terminal state).
- A past_due/restricted subscription event on a `cancelled` tenant is swallowed
  (stale-fixture artefact, not a lifecycle instruction).
- `subscription active` recovers `past_due`/`restricted` (payment recovery) AND
  revives `cancelled` (re-subscription revival — a fresh live subscription
  reactivates a cancelled tenant via the matrix edge cancelled → active). It never
  lifts suspension/archival.

This integrates Phase 28 (entitlement map), Phase 29 (subscription state machine,
dunning, verified/manual payments) and Phase 30 (provisioning) without collapsing
any status (§1). The Phase 29 dunning/verification flows continue to work unchanged:
their subscription transitions now carry the tenant lifecycle with them
(C1/C4/D1/G1, hosted L9/L10).

## 6. Cancellation and archival behavior

- `cancellation_pending` (scheduled cancellation) keeps operational access;
  owner/platform may revoke the schedule (cancellation_pending → active).
- `cancelled` (subscription cancelled, records preserved): operational access ends;
  records (profiles, modules, settings, audits, invoices) are preserved; revival is
  ONLY through re-subscription (billing-driven) or the platform path.
- `archived`: non-destructive, applies to active or cancelled tenants only (an
  illegal archive-after-suspend is refused — hosted L3), reversible ONLY through
  the audited platform path (G3); archived tenants are refused by the access check
  (G2). Suspension preserves ALL tenant data exactly (E5, hosted L14).

## 7. Scheduled processing and its verified invocation mechanism

`process_lifecycle_transitions()` is idempotent (H1), bounded (200 rows per
invocation), retryable after partial failure, audited, and platform-only (E3,
hosted L8). **There is NO scheduler in this repository — nothing is claimed
automated.** Invocation is through the platform lifecycle console
(`/portal/admin/lifecycle`, "Run sweep" action), the same manual mechanism as the
Phase 29 processors. The sweep is a backstop: it realigns a drifted tenant with its
effective subscription state exactly once (H2, hosted L16: re-run reports no
actions).

## 8. Audit and notifications

Every transition writes a Core Audit row (`system_audits`, action
`tenant_lifecycle_transitioned`) with server-resolved actor (name + email), from/to
status, source (`platform` | `subscription` | `lifecycle_processor`), and reason —
no new tables (I1). Owner notifications (existing `billing_notify`): 'Payment due'
(past_due), 'Access restricted' (restricted), 'Tenant suspended' (suspended),
'Subscription cancelled' (cancelled), plus 'Tenant restored' and 'Cancellation
scheduled' notices. Notifications are idempotent per state entry — a retry on an
already-suspended tenant adds nothing (I3, hosted L15). The `tenant_lifecycle_history`
RPC is the read model over Core Audit.

## 9. Security model and hosted evidence

- No new roles, permissions, or modules (J1, hosted fixture map untouched).
- Platform operations require platform_super_admin, re-verified inside the DEFINER
  functions (owner + plain admin denied: E1/E2, hosted L7). Reason is mandatory.
- Direct lifecycle writes: platform sessions may only take legal edges with a
  reason (guard trigger); non-platform writers are refused by RLS (tenants is
  ENABLE + FORCE, J6) and the guard. `tenants.status` direct writes are refused
  (derived column — hosted L6).
- The internal writer GUC (`politicore.lifecycle_writer`) is transaction-local and
  never client-settable through PostgREST.
- Cross-tenant isolation: another tenant's owner cannot read tenant rows through
  the public view, suspend, or resolve the access context for the tenant (E4,
  hosted L13 — through a real GoTrue JWT).
- Hosted evidence (real PostgREST + GoTrue JWTs; `.tmp-runs/hosted-smoke-31h.log`,
  SMOKE_EXIT=0): 20/20 checks — authority denials (L7/L8), matrix refusals with
  exact messages (L3/L4b), reason enforcement (L5), derived-column guard (L6),
  dunning coordination (L9), payment recovery (L10), suspension stickiness (L11),
  centralized access check incl. grace and unentitled refusals (L12), cross-tenant
  isolation (L13), data preservation (L14), audit/notification integrity with
  idempotent retry (L15), sweep idempotence (L16), RLS ENABLE+FORCE unchanged
  (L17), residue 0 + FORCE RLS restored on all 12 touched tables (L18/L18b).
- Public surfaces untouched: `get_published_site_config` stays anon-readable (F7);
  public site rendering never calls the access check.

## 10. Focused/full-regression/hosted test counts

- **Focused:** `tenant-lifecycle-enforcement` — **41/41 PASS**
  (`.tmp-runs/focused31i.log`, FOCUSED_EXIT=0; groups A matrix, B guard, C
  coordination, D payment recovery, E authority, F access check, G archival, H
  sweep, I audit/notify, J architecture).
- **Full regression:** 48 files / **1264 tests, all PASS.** The sequential per-file
  run reported 44/48 with 4 file-level failures; all 4 were re-verified green:
  - `core-identity-auth` (21) and `final-campaign-lock` (27): beforeAll hook
    timeout / flake under concurrent load (tsc + build + hosted smoke + vitest on
    one machine); both PASS on quiet re-run.
  - `saas-self-service-onboarding` (49): stale J6 migration pin (69/0068) — pin
    corrected to 70/0069; PASS.
  - `subscriptions-billing-core` (50): 7 real failures from the Phase 31
    coordination trigger interacting with the suite's subscription fixtures
    (cancel-then-resubscribe left the tenant `cancelled`, so later dunning events
    raised `illegal tenant lifecycle transition cancelled → past_due`). Root cause
    was a missing revival path in the coordination scoping; fixed in 0069
    (re-subscription revival, §5) — all 50 PASS
    (`.tmp-runs/reg31-retry2.log`, 99/99 together with onboarding).
- **Hosted acceptance:** **20/20 PASS** (`.tmp-runs/hosted-smoke-31h.log`,
  SMOKE_EXIT=0; L1–L16 checks + L17 RLS + L18 residue + L18b FORCE-RLS restore).

## 11. TypeScript, build, and lint results

- `npx tsc --noEmit` — **0 errors** (`.tmp-runs/tsc31c.log`, TSC_EXIT=0).
- `npm run build` — **PASS** (`.tmp-runs/build31.log`, BUILD_EXIT=0).
- `npx eslint` over all Phase 31 TS files — **0 errors, 2 warnings**, both
  pre-existing legacy in `src/app/portal/layout.tsx`
  (`canViewElectionDashboard`, `profile` unused — present before Phase 31;
  `.tmp-runs/lint31c.log`, LINT_EXIT=0). Repo-wide legacy baseline (38 errors /
  92 warnings) unchanged and out of scope per the phase baseline.

## 12. Deviations and deferred work

- **No scheduler** (by design): the lifecycle sweep is invoked manually from the
  platform console, matching the Phase 29 processor pattern. Deferring any cron
  wiring to a future operations phase.
- **`public.tenants` view refresh inside 0069:** the 0009 view was created with
  `SELECT *` and does not auto-extend; 0069 re-runs the `CREATE OR REPLACE` so the
  public surface exposes the new columns. Chosen over a new migration to keep the
  phase self-contained; signature-pinned on hosted.
- **Idempotent DDL in 0069:** added so hosted signature drift re-applies cleanly
  (the hosted DB had the pre-amendment objects). No behavior change on fresh
  installs.
- **Deferred:** rich lifecycle analytics/reporting in the platform console
  (current UI lists tenants, statuses, reason, history and the four operations +
  sweep); bulk operations; tenant-facing suspension-notice page (the API refusal
  message is already user-actionable).

## 13. Locked modules and the four-module enum

**Unchanged.** The module enum is exactly `social, campaign, election, governance`
(J2); no module, role, or permission was added or removed (J1; hosted entitlement
keys and plans residue 0). Phase 31 adds lifecycle enforcement AROUND the modules —
it never changes module identity, activation data, or entitlement maps (hosted L14:
profiles/modules/settings byte-identical across suspension).

SAAS PHASE 31: PASS
