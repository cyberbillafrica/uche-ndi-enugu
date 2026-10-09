# Phase 29 — Subscription & Billing Core (SaaS Phase B) — Report

## 1. Status

**PASS.** Every gate green: focused suite 50/50, full regression 1180/1180 (46 suites),
hosted acceptance 39/39 with residue 0 and FORCE RLS restored, tsc 0 errors, production
build PASS (83 static pages), lint clean for all Phase 29 files (repo-wide warnings are
the pre-existing legacy baseline).

## 2. Migrations added

- `supabase/migrations/0066_subscriptions_billing_core.sql` (§1–§15, ~3,337 lines),
  applied to pglite (fresh-DB test path) and to the hosted project via `apply-hosted`
  (signature-pinned; HOSTED MIGRATIONS OK). Hosted RLS totals after 0066+0067: 88
  tables enabled / 88 forced / 167 policies; all 10 Phase 29 tables are RLS ENABLE +
  FORCE (platform FOR ALL + tenant SELECT-only policies), re-verified by hosted K1 and
  K21.
- `supabase/migrations/0067_subscription_plans_owner_catalog.sql` (Phase 29 addendum):
  the owner-scoped `subscription_plans()` read model — ACTIVE plan versions WITH ids and
  committed prices, authority identical to `create_subscription` (tenant owner or
  platform_super_admin). Needed because the anonymous catalog (0065) deliberately omits
  version ids while the owner surface must be able to START a subscription.
- Pins updated to 68 migrations / `^0067_/`: `subscriptions-billing-core` J4,
  `commercial-plans-entitlements` I5, `governance-phase11-architecture` D1;
  `scripts/db/apply-hosted.ts` gained 0066 + 0067 signature entries.

## 3. Tables / types / functions added

**Tables** (`politicore`, all RLS ENABLE + FORCE): `subscriptions` (state machine,
trial timestamps, period window, `pending_plan_version_id`, dunning counters,
`cancel_at_period_end`, `ended_at`/`cancelled_at` immutability), `subscription_items`
(base_plan only, price snapshot), `invoices` (immutable after issue; CHECK
`total = subtotal − discount_credits + tax`, `refunded ≤ total`), `invoice_line_items`
(snapshots, DELETE only on refunded/void), `payments` (UNIQUE provider reference
idempotency), `payment_attempts` (UNIQUE `(invoice_id, attempt_number)`), `refunds`
(partial-capable, never exceed refundable), `credits` + `credit_applications`
(draft-only, remaining-balance enforced), `billing_events` (UNIQUE
`(provider, provider_event_id)`, write-once processing, immutable payload).

**Enums**: `subscription_status_enum` (trialing/active/past_due/restricted/cancelled),
`billing_interval_enum`, `invoice_status_enum`, `payment_status_enum`,
`payment_attempt_status_enum`, `refund_status_enum`, `credit_status_enum`,
`billing_event_status_enum`.

**Functions**: helpers `billing_audit`, `billing_notify`, `assert_subscription_authorized`,
`billing_config_read`; guards `guard_subscription_transition`, `guard_invoice_immutability`,
`guard_invoice_line_items`, `guard_subscription_item_freeze`, `guard_payment_state`,
`guard_billing_event_journal`; core `create_subscription`,
`schedule_subscription_cancellation`, `revoke_subscription_cancellation`,
`change_subscription_plan`, `apply_pending_plan_change`, `sync_subscription_entitlements`,
`record_verified_payment`, `record_payment_failure`, `record_verified_refund`,
`issue_credit`, `apply_credit_to_invoice`, `billing_create_draft_invoice`,
`billing_issue_invoice`, `journal_billing_event`, `process_billing_events`, processors
(`process_trial_expiries`, `process_dunning_transitions`, `process_period_renewals`),
read models (owner: `subscription_current`, `my_invoices`, `my_invoice`, `my_payments`;
platform: `platform_subscriptions`, `platform_invoices`, `platform_payments`,
`platform_billing_events`, `platform_billing_config`, `subscription_plans`), plus
`public.` PostgREST wrappers for all of them (SECURITY INVOKER,
`SET search_path = politicore, public, pg_temp`, grants to authenticated only,
REVOKE from anon/PUBLIC).

## 4. Subscription state machine

DB-enforced by `guard_subscription_transition` — the ONLY edges:
`trialing → active | restricted | cancelled`; `active → past_due | cancelled`;
`past_due → active | restricted | cancelled`; `restricted → active | cancelled`.
No `cancelled → anything` (restoration = NEW subscription; ended subscriptions are
historical facts — any UPDATE fails). Direct `active → restricted` is deliberately NOT
an edge: restriction is reachable only through the recorded-failure dunning path.
`plan_version_id` is immutable except the guard-verified pattern
`pending_plan_version_id → plan_version_id` (applied at renewal/conversion).

## 5. Trials

14 days from `plan_versions.trial_days` (launch seed: 14). No payment method captured;
trialing applies the plan map. `billing_create_draft_invoice` on a trialing subscription
starts the invoice at `now()` — NO retroactive charging. `process_trial_expiries` sends a
single 3-day reminder (`trial_reminder_sent_at` fires once), then on expiry flips the
subscription to `restricted`, clears the commercial map, and preserves data + tenant
lifecycle (`tenants.status` stays `active`; recovery = subscribe again). `trial_end` is
frozen by guard trigger (test/smoke backdating uses `session_replication_role = replica`).

## 6. Invoice model

Immutable after issue (trigger-frozen: total, line items, snapshots). Lifecycle
draft → issued → paid | past_due → refunded | void. `due_at` = issued + 14 days.
Line-item DELETE allowed only for invoices in `refunded`/`void`. `INV-YYYYMMDD-<8hex>`
numbers. Invoice creation from a trialing subscription starts the period at `now()`.
`process_period_renewals` is idempotent: an open invoice (draft/issued/past_due)
short-circuits with action `renewal_open_invoice_exists`.

## 7. Payment model

ONE state machine — `record_verified_payment` — used by the manual/offline adapter and
any future PSP: only `issued`/`past_due` invoices accept payment; a successful payment
marks the invoice `paid`, activates the subscription (trial→active, past_due→active,
restricted→active recovery edge), sets `current_period_*` (half-open, monthly/annual
from `billing_interval`), applies any `pending_plan_version_id`, and re-syncs
entitlements. Provider reference is UNIQUE per provider — a replay can never create a
second payment. Failures (`record_payment_failure`) flip issued → past_due, increment
`failed_payment_count`, stamp `past_due_since`, and RETAIN entitlements.

## 8. Manual/offline adapter (the only functional adapter)

Provider identity is DATA (text, 2–60 chars). The manual adapter (service layer
`manualAdapter`) journals the webhook payload (`journal_billing_event` with
`signature_verified`), then processes it (`process_billing_events`) — the SAME journal →
process → state-machine path a real PSP integration would take. Owner can view billing;
only platform_super_admin records verified payments, refunds, and failures. Verified by
focused E-section and hosted K10–K16 (payments, idempotency, refunds, credits, dunning,
journal).

## 9. Webhook / billing-event architecture

`billing_events` is a write-once journal: raw payload stored BEFORE processing,
immutable payload (trigger), idempotent by `(provider, provider_event_id)` — a replay
returns `duplicate = true` and writes nothing. `process_billing_events` is write-once:
`received → processed | rejected` (unknown types → `rejected`, evidence preserved;
re-run processes nothing). Known types: payment.succeeded / payment.failed /
payment.refunded, invoice.issued / invoice.paid / invoice.void,
subscription.activated / subscription.cancelled. Platform-only (anon gets 401
permission-denied at the function grant).

## 10. Entitlement synchronization

`sync_subscription_entitlements` is THE boundary between billing state and the Phase 28
map: trialing/active → apply the plan version's module map; past_due → RETAIN (grace);
restricted/cancelled → all false. Writes ONLY the existing
`platform_settings.settings.service_entitlements` map (UPDATE, never insert) and audits
the same action `entitlements_synchronized` with `affected_resource = 'platform_settings'`.
`assert_subscription_authorized` is the second boundary: module surfaces can require a
live subscription server-side.

## 11. Dunning

Config in the EXISTING `platform_settings.settings.billing` singleton
(`{grace_period_days: 7, max_payment_retries: 3}` defaults; `set_billing_config`
validates 0–90 days / 1–12 retries, requires a reason, audits `billing_config_updated`
at platform scope with nullable tenant). `process_dunning_transitions`: grace exhausted
(`past_due_since` older than grace) → `restricted` + map cleared + owner notified;
payment during past_due/restricted → `active` + map restored (K14 exercised the full
past_due → restricted → recovery cycle on hosted).

## 12. Cancellation

Owner schedules (`cancel_at_period_end = true` — non-destructive, period honored) and
revokes; period-end cancel happens in `process_period_renewals` (audits
`subscription_cancelled`, preserves data, notifies). Platform `correct_subscription_state`
performs immediate cancel (reason ≥5 chars required) → `ended_at`/`cancelled_at` set,
map cleared, data + profiles preserved, subscription immutable thereafter (K18: schedule
+ revoke + immediate cancel + immutability + profile counts verified).

## 13. Ownership / security model

Owner = `tenant_super_admin` ONLY (members and plain `admin` get 400 on every billing
RPC — server-resolved identity via `current_tenant_id()`/JWT claims, never client
input). Platform operations require `platform_super_admin` + reason ≥5 chars.
All 10 tables RLS ENABLE + FORCE: platform FOR ALL policies + tenant SELECT-only
policies; REVOKE from anon. Hosted K1 verified RLS+FORCE on all 10, K21 verified FORCE
restored after cleanup; K2/K3/K7/K10/K16 verified the anonymous/plain-admin/cross-tenant
denials over real PostgREST.

## 14. Audit events

All lifecycle mutations Core-Audit-logged via `billing_audit` (server-resolved actor):
`subscription_created`, `subscription_trial_started`, `subscription_activated`,
`subscription_started`, `subscription_cancellation_scheduled`,
`subscription_cancellation_revoked`, `subscription_changed`, `subscription_cancelled`,
`subscription_trial_expired`, `subscription_restricted`, `invoice_issued`,
`invoice_paid`, `payment_received`, `payment_failed`, `payment_refunded`,
`credit_issued`, `credit_applied`, `entitlements_synchronized`, `billing_config_updated`
(platform scope). Focused J1 pins the full set + actor resolution; hosted K19 re-proved
it (missing=[], `payment_received.actor_email` = acting platform admin).

## 15. Notifications

`billing_notify` targets tenant owners (`access_role = 'tenant_super_admin' AND
lifecycle_status = 'active'`) with typed messages + link_url: trial started, trial
reminder, trial expired, payment received, subscription ended, restriction warning.
Focused E5 verifies the owner notification ledger; hosted K17 verifies the reminder
fires exactly once.

## 16. Focused test count

`tests/security/subscriptions-billing-core.test.ts`: **50/50 PASS** (49 original + new
B7 `subscription_plans` authority matrix). Sections: A isolation, B owner authority,
C platform authority, D invoice integrity, E payment integrity, F refunds & credits,
G entitlement sync, H dunning & trials, I webhook journal, J audit & architecture
(incl. J3 no new roles/modules/permissions, J4 migration count 68, J5 FORCE RLS on all
10 tables, J6 provider is DATA — no provider-literal branching).

## 17. Full regression count

**46/46 files, 1180/1180 tests PASS** (`.tmp-runs/regression3.log`) — includes Phase 28
suites with updated pins (68 migrations / `^0067_/`), governance-phase11 D1, and every
prior phase suite. Phase 28 remained green throughout.

## 18. Hosted count

`scripts/db/verify-hosted-smoke-subscriptions-billing-core.ts`: **39/39 PASS**
(K1–K21 + K5b). K1 RLS+FORCE on 10 tables; K2 anonymous holds nothing; K3 plain admin
holds nothing; K4 fixtures; K5 trial/14-day/item/price snapshot; **K5b owner catalog
(active versions with ids + committed prices; plain admin empty — 0067)**; K6 owner B
independent; K7 cross-tenant denials; K8 platform invoice create+issue (reason rule,
INV number, snapshot); K9 issued-invoice immutability; K10 verified payment state
machine + trial→active + entitlement map (starter = social+campaign true, election/
governance false); K11 provider-reference idempotency; K12 partial/full refunds +
over-refund refusal; K13 credits draft-only + remaining-balance + issued-refusal;
K14 failure → past_due (map RETAINED) → restricted (map cleared) → recovery by payment;
K15 next-period plan change (pending reference intact); K16 journal idempotency +
write-once processing + payload immutability + platform-only; K17 trial reminder once +
expiry (data + tenant preserved); K18 cancellation (schedule/revoke/immediate,
ended immutable, data preserved); K19 audit set + server-resolved actors;
K20 permissions 43 + enums unchanged; K21 residue 0 + FORCE RLS restored 10/10.
0067 applied to hosted via `apply-hosted` (HOSTED MIGRATIONS OK; catalog = 3 rows).

## 19. TSC / build / lint

- `tsc --noEmit`: **0 errors** (TSC_EXIT=0).
- `npm run build`: **PASS** — verified twice on the final code: compiled successfully
  (52s), 83/83 static pages (81 baseline + `/portal/billing` + `/portal/admin/billing`;
  the plans console landed in Phase 28).
- Lint: Phase 29 files (`billing.ts`, `billing/page.tsx`, `admin/billing/page.tsx`,
  `subscriptions-billing-core.test.ts`, smoke script) **0 errors, 0 warnings** after
  cleanup. Repo-wide `eslint` reports 38 errors + 92 warnings, all inside pre-existing
  legacy files (phase1b/phase1c-election/authorization etc.) that Phase 29 does not
  modify — the pre-existing repo baseline, not a Phase 29 regression.

## 20. Deviations from the prompt

1. **0067 addendum**: the prompt's owner-surface requirement (subscribe from the billing
   page) needs plan-version ids, which the 0065 anonymous catalog deliberately withholds.
   Rather than widen the anon surface, 0067 adds an owner-scoped catalog with authority
   identical to `create_subscription`. No tables, roles, or permissions added.
2. **K10 expected map corrected**: starter includes social + campaign (0065 seed) — the
   smoke initially asserted `campaign === false`; fixed to match the seeded catalog.
3. **Hosted enum values**: `access_role_enum` on hosted = 0001 canonical
   (`admin, election_officer, member, platform_super_admin, tenant_super_admin`); the
   smoke's K20 expectation was corrected to the canonical list (no `viewer` /
   `tenant_super_admin_readonly` values exist anywhere in the migration chain).

## 21. Deferred (Phase C / later phases)

- Real PSP adapters (Paystack/Flutterwave) — the `PaymentProviderAdapter` seam and
  journal are ready; only the manual/offline adapter is functional this phase.
- Checkout UI with PSP redirect flows (Phase C journey), proration (explicitly
  rejected: next-period changes only), usage/limit enforcement against
  `subscription_items` (Phase C+), `archived` tenant state + retention automation
  (Phase 31 tenant lifecycle), invoice PDFs/receipts, currency expansion beyond NGN
  (D2 stays NGN-first; no FX by design).

## 22. Locked modules untouched

Election, Campaign, Social, Governance module logic, schemas, and RLS are untouched —
the diff adds only `0066`/`0067` SQL, the billing service (`src/lib/supabase/billing.ts`
+ barrel entry), the two billing pages, the admin nav entry, and Phase 29 tests/smoke.
Pins updated in three suites are architecture counters only. `module_code_enum` remains
`social, campaign, election, governance`; Control Center remains outside the enum;
`permissions` remains 43; `access_role_enum` unchanged.

## 23. No new roles / permissions / modules

No new `access_role_enum` values (no `billing_admin` — owner-only V1 per gate D8/B8),
no new `module_code_enum` values, no new permissions rows (43 pinned), no new tenant
lifecycle states (Phase 31 owns `suspended`/`archived`). Billing authority rides the
EXISTING `tenant_super_admin` / `platform_super_admin` roles only.

SAAS PHASE 29: PASS
