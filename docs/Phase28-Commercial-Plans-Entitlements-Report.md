# Phase 28 — Commercial Plans & Entitlements (SaaS Phase A) — Report

## 1. Status

**PASS.** Every gate green: focused suite 50/50, full regression 1130/1130 (45 suites),
hosted acceptance 26/26 with residue 0, tsc 0 errors, production build PASS (81 pages),
lint clean for all Phase 28 files.

## 2. Migrations added

- `supabase/migrations/0065_commercial_plans_entitlements.sql` (§1–§9), applied locally
  (66 migrations total, RLS 78 tables / 148 policies) and to the hosted project
  (`apply-hosted` preflight + signature pins; HOSTED MIGRATIONS OK).
- Pins updated: `tests/security/governance-phase11-architecture.test.ts` D1 (count 66 +
  `/^0065_/`), `tests/security/control-center-administration.test.ts` F1 (0064 by name),
  `scripts/db/apply-hosted.ts` 0065 signature entry.

## 3. Tables / types / functions added

**Tables** (`politicore`): `plans` (UNIQUE code, regex `^[a-z0-9]+(-[a-z0-9]+)*$`),
`plan_versions` (type `plan_version_status_enum('draft','active','retired')`,
UNIQUE(plan_id,version), `included_modules module_code_enum[]` CHECK ≥1, denormalized
`currency`), `plan_version_prices` (UNIQUE(version,currency,interval), `amount_minor
bigint`).

**Triggers**: `guard_plan_version_immutability` (only edges draft→active,
active→retired; commercial fields frozen once active/retired — `effective_to` stampable
only on the active→retired closing edge), `guard_plan_version_price_immutability`
(active/retired prices immutable; price currency must equal version currency),
`guard_plan_version_single_active`.

**Functions** (`politicore.*`, SECURITY DEFINER): `plan_feature_catalog()`,
`plan_validate_limits(jsonb)`, `plan_validate_features(jsonb)`,
`apply_plan_version_entitlements(uuid,uuid,text)`, `sync_tenant_entitlements(uuid,text,text)`,
`create_plan`, `create_plan_version`, `update_plan_version_draft`,
`activate_plan_version`, `retire_plan_version`, `plan_catalog_admin()`,
`plan_catalog_public()`.

**Public wrappers** (SECURITY INVOKER one-liners, 0007/0034 convention):
`create_plan`, `create_plan_version`, `update_plan_version_draft`,
`activate_plan_version`, `retire_plan_version`, `sync_tenant_entitlements`,
`apply_plan_version_entitlements`, `plan_catalog_admin()`, `plan_catalog_public()`.

**UI/service**: `src/lib/supabase/commercialPlans.ts` (typed RPC wrappers),
`src/app/portal/admin/plans/page.tsx` (minimal platform-admin catalog view with
activate/retire actions), "Plans" entry in `adminNavigation`
(`src/app/portal/layout.tsx`). No tenant Control Center plan surface (F6 forbids).

## 4. Plan catalog seeded (§9 DO block — DATA, not logic)

| Plan | Modules | Notes |
|---|---|---|
| `starter` ("Starter") | social, campaign | "Essential services for small organizations getting started on PolitiCore." |
| `professional` ("Professional") | social, campaign, election, governance | "The full service suite for growing organizations." |
| `enterprise` ("Enterprise") | social, campaign, election, governance | "Every service with the highest limits for large organizations." |

All versions active, currency NGN, `trial_enabled = true`, `trial_days = 14`.

## 5. Exact pricing seeded (integer minor units — kobo; ₦1 = 100 kobo)

| Plan | Monthly | Annual |
|---|---|---|
| starter | 1,500,000 (₦15,000) | 15,000,000 (₦150,000) |
| professional | 5,000,000 (₦50,000) | 50,000,000 (₦500,000) |
| enterprise | 15,000,000 (₦150,000) | 150,000,000 (₦1,500,000) |

Monthly and annual are independent rows; annual is never derived. **These are clearly
marked launch seed values** — no repository pricing spec exists (only NGN currency
defaults in donations/projects); easy to change as configuration, documented here.

## 6. Exact limits seeded (JSON null = unlimited, ≠ 0)

| Key | starter | professional | enterprise |
|---|---|---|---|
| max_members | 25 | 200 | 100,000 |
| max_storage_bytes | 5,368,709,120 (5 GiB) | 53,687,091,200 (50 GiB) | 1,099,511,627,776 (1 TiB) |
| max_custom_domains | 0 | 1 | 10 |
| max_governance_requests | 0 | 5,000 | 1,000,000 |
| max_social_tasks | 100 | 2,000 | 1,000,000 |
| max_campaign_activities | 50 | 2,000 | 1,000,000 |
| max_election_records | 0 | 10,000 | 1,000,000 |
| max_notifications | 1,000 | 50,000 | 1,000,000 |

Feature entitlements (allowlist: governance_projects, governance_participation,
governance_accountability, custom_domains, advanced_analytics): starter all false;
professional gov_* + advanced_analytics true, custom_domains false; enterprise all true.

## 7. Entitlement synchronization mechanism

The commercial layer is the **authoritative writer** of the EXISTING
`politicore.platform_settings.settings.service_entitlements` — the only writer is
`apply_plan_version_entitlements(tenant, version_id, reason)` (Phase 29's primitive);
`sync_tenant_entitlements(tenant, plan_code, reason)` resolves the plan's ACTIVE version
and delegates. Each sync writes the FULL four-module map (`jsonb_set` with a nested
container-ensuring call) — modules absent from the plan are set false, so a plan change
cleanly revokes availability. `tenant_modules.enabled`, `permission_grants`,
`has_permission()`, `scope_covers()`, RLS and `user_access` are never touched. All
authority (`is_platform_admin() IS TRUE`) and actor identity are server-resolved.

## 8. RLS / security model

- FORCE RLS on plans, plan_versions, plan_version_prices; policies: platform_admin FOR
  ALL, `read_active` (active rows only) SELECT; anon REVOKEd on all three tables.
- politicore.* underlyings REVOKEd from anon, PUBLIC (internal helpers from
  authenticated too); exception per 0007/0037 anon-surface precedent:
  `politicore.plan_catalog_public()` explicitly granted to anon, authenticated (the
  invoker wrapper delegates to it).
- All lifecycle/sync functions: SECURITY DEFINER, explicit `IS TRUE` platform guard
  (0010 lesson), server-resolved actor fields, `SET search_path` pinned.
- Hosted PostgREST surface: anon can execute ONLY `plan_catalog_public` (proven by
  hosted J3/J4).

## 9. Audit events

`plan_created`, `plan_version_created`, `plan_version_updated`,
`plan_version_activated`, `plan_version_retired`, `entitlements_synchronized` — written
to the existing `system_audits`; platform events carry NULL `tenant_id`; actor id/name/
email resolved server-side from the JWT subject (seed uses NULL actor with reason_notes
'launch catalog seed').

## 10. Focused test count

`tests/security/commercial-plans-entitlements.test.ts` — **50/50 PASS** (A plan
integrity 8, B pricing 7, C modules 4, D entitlement sync 8, E tenant isolation 3,
F platform authority 6, G audit 4, H grant/RLS posture 5, I architecture gate 5).

## 11. Full regression count

**1130/1130 PASS across 45 suites** (`vitest run --config vitest.security.config.ts`).
Baseline 1080/1080 · 44 suites preserved; +1 suite (50 tests) = 1130. No locked module
weakened (pinned suites assert prior baselines byte-for-byte where pinned).

## 12. Hosted count

`scripts/db/verify-hosted-smoke-commercial-plans-entitlements.ts` — **26/26 PASS**
(J1 seed catalog, J2 anonymous public catalog, J3/J4 anonymous+tenant-admin denials,
J5 plan+version creation, J6 activation, J7 active immutability, J8 retirement edges,
J9–J12 sync semantics + isolation, J13 active-only public surface, J14 audit evidence,
J15 module enum integrity, J16 residue 0, J17 FORCE RLS restored 8/8). Hosted note: the
session pooler (5432) was unreachable from this network (ECONNRESET); apply + smoke ran
over the transaction pooler (6543) via the new `process.env.DATABASE_URL` override in
`apply-hosted.ts`.

## 13. TSC / build / lint

- `tsc --noEmit`: **0 errors** (TSC_EXIT=0).
- `npm run build`: **PASS** — compiled successfully, 81 static pages (80 baseline + new
  `/portal/admin/plans`).
- Lint: Phase 28 files (`commercialPlans.ts`, `plans/page.tsx`, `index.ts`) **0 errors,
  0 warnings**; `layout.tsx` carries 2 pre-existing unused-var warnings on lines Phase 28
  did not touch. Repo-wide `eslint` reports 39 errors + 88 warnings, all inside
  pre-existing legacy test scripts (phase1b/phase1c-election/authorization etc.) that
  Phase 28 does not modify — this is the pre-existing repo baseline, not a Phase 28
  regression.

## 14. Deviations from the prompt

1. **Seed prices/limits are marked launch values** (no repo pricing spec exists;
   documented in §5/§6 as configuration, not logic).
2. **Currency is denormalized on plan_versions** with a trigger-enforced invariant that
   every price row's currency equals the version currency; normalized prices live in
   `plan_version_prices` (monthly/annual independent) per §8.
3. **Trial custom-domain exclusion** is modeled at the plan level
   (`max_custom_domains=0`, feature false) but enforced exclusion during trial lifecycle
   is deferred to Phase 29 (subscriptions do not exist yet).
4. **`provision_tenant` is untouched** — tenants without plans remain valid; Phase 29
   subscriptions will call `apply_plan_version_entitlements` on activation/change.
5. **Plan UI is minimal and platform-admin only** (catalog view + activate/retire);
   plan creation/editing remains an RPC surface (audited) — no editorial UI this phase.

## 15. Deferred (Phase 29+)

Subscriptions, checkout, payments, invoices, webhooks, dunning, trials-as-lifecycle,
tenant self-service signup, custom domains/Cloudflare, usage counters, quota
enforcement, support impersonation, data exports, offboarding, FX.

## 16. Locked modules untouched

Full regression 45/45 suites green, including every locked module suite (Social Force,
Campaign, Election, Governance architecture gates) and the Phase 26/27 pins. Phase 28
changed no file under those modules; `git status` shows only the migration, the new
service/UI files, the two pin updates, and the new smoke script.

## 17. No SaaS values in module_code_enum

`module_code_enum` remains exactly `social | campaign | election | governance` — proven
by focused C2/C3, hosted J15, and repo searches (no `billing`/`saas`/`plans` values
anywhere in enum definitions or plan validators). Control Center remains outside the
enum.

SAAS PHASE 28: PASS
