# Phase 30 — Self-Service Tenant Onboarding & Subscription Journey (SaaS Phase C) — Report

## 1. Status

**PASS.** Every gate green: focused suite 49/49, full regression 1180/1180 (46 suites),
hosted acceptance 22/22 with residue 0 and FORCE RLS restored, tsc 0 errors, production
build PASS, lint clean for all Phase 30 files (repo-wide errors/warnings are the
pre-existing legacy baseline).

## 2. Files changed

**New (Phase 30):**
- `supabase/migrations/0068_self_service_tenant_onboarding.sql` (479 lines)
- `src/lib/supabase/onboarding.ts` (service layer: `checkTenantSlugAvailability`,
  `completeTenantOnboarding`, `getOnboardingState`)
- `src/lib/supabase/checkout.ts` (provider-independent checkout seam +
  `manualCheckoutProvider` default adapter)
- `src/app/pricing/page.tsx` — public SaaS pricing/catalog entry
- `src/app/onboarding/page.tsx` — bare-identity signup
- `src/app/onboarding/complete/page.tsx` — tenant creation + provisioning + trial panel
- `src/app/onboarding/resume/page.tsx` — server-driven journey recovery
- `tests/security/saas-self-service-onboarding.test.ts` (637 lines, 49 tests)
- `scripts/db/verify-hosted-smoke-self-service-onboarding.ts` (564 lines, M1–M18c)

**Modified:**
- `src/lib/supabase/auth.ts` — added `signUpBareIdentity` (signUp with
  `data: { onboarding_intent: "tenant_owner" }` only — NO `tenant_slug` metadata, so no
  profile trigger fires; the C2 test pins the function body free of the literal)
- `src/lib/supabase/index.ts` — barrel exports (onboarding + checkout)
- `scripts/db/apply-hosted.ts` — 0068 signature entry
- `src/app/portal/layout.tsx` — portal navigation wiring
- Migration pins updated to 69 migrations / `^0068_/` in three test suites
  (`subscriptions-billing-core` J4, `commercial-plans-entitlements` I5,
  `governance-phase11-architecture` D1)

## 3. Migrations added

`supabase/migrations/0068_self_service_tenant_onboarding.sql` — **functions + grants
ONLY; zero CREATE TABLE** (existing schema fully supports the journey, per §26
migration discipline). Applied to pglite fresh-DB path (probe `.tmp-runs/probe-0068.log`
PROBE OK) and to the hosted project via signature-pinned `apply-hosted`
(**HOSTED MIGRATIONS OK**; hosted totals after 0068: RLS 88/88 enabled/forced,
167 policies, 43 permissions).

Functions (politicore schema + public PostgREST wrappers):
- `reserved_tenant_slugs()` — 62-entry reserved list, IMMUTABLE (www, api, admin,
  app, auth, billing, blog, dashboard, docs, help, mail, smtp, ftp, ns1, ns2, cdn,
  static, assets, media, status, support, platform, politicore, root, sys, system,
  null, undefined, admin-* pattern members, etc.)
- `canonical_tenant_slug(text)` — normalize + REJECT reserved slugs (raises)
- `normalize_tenant_slug(text)` — normalization only (no reserved raise) for
  comparison paths that must not throw
- `tenant_slug_available(p_slug text)` RETURNS TABLE(slug, available, reason) —
  anon-executable availability oracle (server-side authority; DB unique constraint
  remains the final arbiter)
- `complete_tenant_onboarding(p_tenant_slug, p_tenant_name, p_owner_name,
  p_plan_code, p_billing_interval)` — **NO parameter defaults**; SECURITY DEFINER;
  the single atomic provisioning RPC (§4)
- `onboarding_state()` — 4-stage journey-position resolver (§9)

Public wrappers are SECURITY INVOKER with
`SET search_path = politicore, public, pg_temp`. Grants: read surfaces
(`tenant_slug_available`, `onboarding_state`) to anon + authenticated; provisioning
(`complete_tenant_onboarding`) to **authenticated only**, REVOKE from anon/PUBLIC.

## 4. Provisioning architecture

ONE atomic SECURITY DEFINER transaction:
`public.complete_tenant_onboarding(p_tenant_slug, p_tenant_name, p_owner_name,
p_plan_code, p_billing_interval)` — all five parameters required, no defaults, so the
browser cannot partially invoke it. Inside one transaction:

1. canonicalizes the slug (reserved slugs raise);
2. creates the tenant;
3. creates `tenant_modules` from the selected plan's `included_modules`;
4. creates `tenant_settings`;
5. creates `public_site_settings`;
6. creates the owner profile (`tenant_super_admin`) bound to the new tenant;
7. resolves the plan server-side by CODE → ACTIVE `plan_versions` →
   `plan_version_prices` for the requested interval and currency (NGN) — the browser
   never supplies a `plan_version_id`;
8. calls the EXISTING Phase 29 `politicore.create_subscription` (trial via the plan's
   `trial_days`, no payment method required);
9. writes `billing_audit` event `tenant:onboarding_completed`;
10. for non-trial plans, writes the welcome `billing_notify` owner notification.

Returns `(tenant_id, tenant_slug, subscription_id, subscription_status, trial_end,
next_step)`. Failure at any step aborts the whole transaction — no partially
provisioned tenant can appear active. Retries after a committed success surface the
duplicate-slug constraint (duplicate prevention is DB-constraint based, never timing
based). The browser never creates tenant/tenant_modules/tenant_settings/profile rows
individually.

## 5. Signup / onboarding flow

> /pricing → /onboarding → Supabase Auth bare signup → /onboarding/complete →
> provisioning RPC → /onboarding/resume (or direct) → /portal/dashboard

- **/pricing** (public, identity-free): renders `plan_catalog_public` — plan CODE,
  name, description, monthly/annual prices, trial badge, included modules
  (check/cross against the locked 4-module enum) and feature entitlements. No version
  ids, no platform-admin metadata, no limits section (the anon catalog deliberately
  omits them). "Continue" carries ONLY the plan code + interval as query params into
  /onboarding; the server re-resolves everything at provisioning time.
- **/onboarding**: bare signup via `signUpBareIdentity` — email + password + owner
  name; NO tenant_slug metadata, so the existing signup trigger provisions no profile
  and the identity lands in stage `create_tenant`.
- **/onboarding/complete**: organization name + slug UX with debounced
  server-verified availability check (`tenant_slug_available`), then ONE
  `complete_tenant_onboarding` call; success panel communicates trial status, trial
  end date, selected plan, billing interval, and that NO payment method exists and no
  automatic charge will occur.

## 6. Subscription integration

`complete_tenant_onboarding` delegates subscription creation to the EXISTING Phase 29
`politicore.create_subscription` — the same authority used by the owner billing
surface. Plan/version resolution is server-side (code → active version → active price
for the requested interval, NGN-only). Trial initialization, entitlement map,
`subscription_items` base_plan snapshot, and all Phase 29 state-machine guards apply
unchanged. No parallel subscription path exists.

## 7. Checkout / provider abstraction

`src/lib/supabase/checkout.ts` defines the provider-independent seam:

```ts
interface CheckoutProvider {
  initializeCheckout(...): Promise<...>
  verifyPayment(...): Promise<...>
}
```

with `manualCheckoutProvider` (the existing Phase 29 manual/offline adapter) as the
default implementation. No PSP SDK (Paystack/Flutterwave/Stripe) is imported anywhere
in onboarding business logic; provider identity remains DATA. Onboarding depends only
on the abstraction, so a future PSP is an adapter addition, not a journey rewrite.

## 8. Trial behavior

Unchanged Phase 29 trial machinery: 14 days from the plan's `trial_days` (launch
seed), no payment method captured, trialing applies the full plan entitlement map.
The /onboarding/complete success panel states the trial status, trial end date,
selected plan, billing interval, and explicitly that no payment method is on file and
the tenant will NOT be auto-charged at expiry. Expiry behavior (restrict + clear map
+ preserve data) remains the Phase 29 state machine's job — not redesigned.

## 9. Recovery / resume behavior

`politicore.onboarding_state()` resolves the journey position EXCLUSIVELY from the
session + database — never from localStorage, query params, or client flags:

- `signin` — no auth session → /onboarding
- `create_tenant` — bare identity with no profile (subscription journey not
  finished) → /onboarding/complete
- `enter_app` — tenant + live subscription → /portal/dashboard
- `existing_tenant` — profile in an existing tenant → /portal/dashboard

/onboarding/resume calls it and routes; interrupted sessions (browser closed after
signup, before or after provisioning) resume at the correct step. A billing surface
interruption (invoice issued, payment pending) resumes into the owner billing page,
which reflects actual invoice/payment state from Phase 29 read models.

## 10. Security model

- Provisioning RPC: SECURITY DEFINER, authenticated-only grant, REVOKE anon/PUBLIC;
  identity resolved from the JWT server-side, never from client input.
- Plan/version/price resolution is server-authoritative — the browser supplies only a
  plan CODE and interval; there is no `browser → arbitrary plan_version_id →
  subscription` path.
- Slug: server-side canonicalization + reserved rejection + DB unique constraint;
  the client availability check is UX only.
- Read surfaces are anon-executable but expose only catalog/state facts
  (slug availability, journey stage) — no ids beyond the caller's own, no
  platform metadata.
- No new roles, permissions, tables, or RLS policies; tenant isolation continues to
  ride the existing RLS (88/88 tables ENABLE+FORCE, 167 policies).
- `signUpBareIdentity` deliberately carries no tenant metadata (pinned by test C2).

## 11. Audit events

New event via the EXISTING `billing_audit` authority (server-resolved actor):
`tenant:onboarding_completed`. The subscription/trial/entitlement events
(`subscription_created`, `subscription_trial_started`, `entitlements_synchronized`)
are emitted by the existing `create_subscription`/sync machinery. Hosted M18 verified
the exact set: `[subscription_created, subscription_trial_started,
entitlements_synchronized, tenant:onboarding_completed]`.

## 12. Notifications

Existing `billing_notify` path; hosted M18 verified the onboarding notification
(notifications=1). No new notification machinery.

## 13. Focused test count

`tests/security/saas-self-service-onboarding.test.ts`: **49/49 PASS**
(`.tmp-runs/focused30.log`). Sections A–J: A catalog, B slug (normalization,
reserved rejection, availability), C bare identity (incl. C2 no-tenant_slug-metadata
pin), D provisioning (single RPC, owner role, module map), E trial, F entitlements,
G duplicates, H resume, I isolation/denials, J audit/architecture.

## 14. Full regression count

**46/46 files, 1180/1180 tests PASS** — per-file vitest runs with
`--config vitest.security.config.ts`, aggregated by node from `.tmp-runs/reg-per-*.log`
into `.tmp-runs/regression30-summary.txt` (all 46 files exit 0; the three files whose
logs contain the substring "FAIL" match only test NAMES such as "a failed payment
drives active → past_due"). Exactly matches the Phase 29 baseline. All 46 security
files were run individually (never one process — 46 pglite DBs in one process causes
worker IPC timeouts).

## 15. Hosted acceptance count

`scripts/db/verify-hosted-smoke-self-service-onboarding.ts`: **22/22 PASS**
(`.tmp-runs/smoke30.log`), M1–M18c: anonymous catalog read; bare signup identity;
stage resolution; single-RPC provisioning; owner `tenant_super_admin` authority;
subscription (trialing, 14-day, base_plan, NGN price snapshot); entitlement map;
billing visibility; duplicate-slug prevention; interrupted/resumed onboarding;
cross-tenant denial; plain-admin denial; audit events + trial notification; platform
authority; RLS/tenant isolation; migration pin/signature integrity; residue 0 after
cleanup (tenants/profiles/subs/audits/notifs/modules/users/entKeys = 0) and FORCE RLS
restored 9/9 onboarding-adjacent tables (platform-wide FORCE state re-verified as part
of cleanup: 18 tables restored). 0068 applied to hosted before the run
(HOSTED MIGRATIONS OK).

## 16. TSC

`npx tsc --noEmit`: **0 errors** (TSC_EXIT=0, `.tmp-runs/tsc30-final3.log`) after a
type-narrowing fix in the smoke script (`tenantA !== ""` instead of truthy `&&` on a
`string | boolean` union — no runtime change).

## 17. Build

`npx next build`: **PASS** (`.tmp-runs/build30-final.log`, BUILD_EXIT=0) — compiled
successfully in 2.6min, **87/87 static pages** (83 Phase 29 baseline + `/pricing`,
`/onboarding`, `/onboarding/complete`, `/onboarding/resume`), 0 errors.

## 18. Lint

Phase 30 files (`pricing/page.tsx`, `onboarding/page.tsx`,
`onboarding/complete/page.tsx`, `onboarding/resume/page.tsx`,
`onboarding.ts`, `checkout.ts`, `auth.ts`,
`saas-self-service-onboarding.test.ts`): **0 errors, 0 warnings**
(`.tmp-runs/lint30b.log`, ESLINT_EXIT=0) after removing unused imports from the
resume page and replacing `window.location.href` navigation with `router.push` in the
pricing page. Repo-wide eslint remains the pre-existing legacy baseline
(38 errors + 92 warnings in untouched legacy files) — not modified per §25.

## 19. Deviations from the prompt

1. **No limits section on /pricing**: the Phase 28 anon catalog
   (`PlanCatalogPublicRow`) deliberately has no `limits` field, and widening the anon
   surface was rejected; the pricing page renders modules + feature entitlements
   instead of numeric limits.
2. **Welcome notification only for non-trial plans**: the welcome `billing_notify`
   fires at onboarding completion; trial tenants receive the existing Phase 29 trial
   notifications (started/reminder/expiry) instead — avoids duplicate messaging.
3. **Smoke-script type fix**: one tsc error in the hosted smoke
   (`string | boolean` not assignable to `boolean`) fixed by explicit `!== ""`
   comparisons — test-logic-neutral.

## 20. Deferred items

- Real PSP checkout (Paystack/Flutterwave) — the `CheckoutProvider` seam and Phase 29
  journal are ready; the manual/offline adapter remains the only functional path.
- Invoice/payment mid-journey recovery UI beyond the billing page surface
  (Phase 29 read models already expose the state).
- Usage/limit enforcement against `subscription_items` (Phase C+).
- Custom domains (later SaaS phase).
- Currency expansion beyond NGN (no FX by design).

## 21. Locked modules untouched

Election, Campaign, Social, Governance module logic, schemas, and RLS are untouched —
the diff adds only migration 0068 SQL (functions/grants), the onboarding/checkout
service layer, the four journey pages, `signUpBareIdentity`, barrel exports, and
Phase 30 tests/smoke. `module_code_enum` remains exactly
`social, campaign, election, governance`; no onboarding module was created; Control
Center remains an administrative control plane outside the enum; `permissions` remains
43.

## 22. No new roles / permissions / modules

No new `access_role_enum` values (no `billing_admin`, `subscription_manager`,
`owner_admin`, `onboarding_admin` — tenant subscription ownership remains
`tenant_super_admin` exclusively; platform authority remains `platform_super_admin`).
No new `module_code_enum` values. No new permissions rows (43 pinned). No new tables.
No new RLS policies. All onboarding authority rides the EXISTING roles and the
EXISTING Phase 28/29 functions (`create_subscription`, `billing_audit`,
`billing_notify`, `plan_catalog_public`).

SAAS PHASE 30: PASS
