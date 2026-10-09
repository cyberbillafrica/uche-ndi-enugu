# PolitiCore — SaaS Architecture & Product Decision Gate (Phase 27)

**Status:** ARCHITECTURE-ONLY PHASE — no code, migrations, UI, routes, billing integrations, Cloudflare integrations or schema changes were made in this phase.
**Preceding:** Phases 1–26 complete — Core, Social Force, Campaign, Election, Governance (Phases 6–19), Cross-Module Gate (20), Control Center (21–26).
**Supersession:** Any earlier document describing SaaS commercialization, billing, self-service provisioning, domains or platform operations as *deferred* is superseded by this gate. PolitiCore is a full multi-tenant SaaS platform; this gate designs the remaining commercial/operational layer **around the existing architecture**.

---

## 0. Repository evidence (what this gate builds on)

Verified directly against the repository (migrations + source):

| Fact | Artifact |
| --- | --- |
| Tenants are first-class; slug-unique, regex-validated (`^[a-z0-9]+(-[a-z0-9]+)*$`) | `politicore.tenants` (0001) |
| A **partial lifecycle already exists**: `status CHECK IN ('active','suspended','cancelled')`, default `active` | `tenants.status` (0001); partially enforced (e.g. Social Force 0028 checks `t.status='active'`) |
| Tenant module activation is separate from authorization by design | `politicore.tenant_modules (tenant_id, module, enabled)` (0001); "A module being enabled ≠ users authorized" |
| Platform-level entitlement map already exists | `platform_settings.settings.service_entitlements` (singleton row; per-tenant module booleans) |
| Platform super-administrator exists | `access_role_enum = ('member','election_officer','admin','tenant_super_admin','platform_super_admin')`; `is_platform_admin()` (0002) |
| Provisioning exists and is **platform-admin-only** (bootstrap exception for the empty system; three-valued-logic guard fixed) | `provision_tenant(p_slug, p_name, p_admin_email, p_admin_full_name, p_modules)` (0007/0010/0011) |
| Audit already supports **platform-level events** (`tenant_id` nullable) and reason capture | `politicore.system_audits` (0001) |
| Tenant + platform settings stores exist | `tenant_settings`, `platform_settings` (0001) |
| Website configuration is tenant-scoped, draft/published/history, tenant-slug-keyed public RPCs | `public_site_settings` + `get_public_site_chrome(p_tenant_slug)` / `get_published_site_config(p_tenant_slug, p_area)` (0056–0063) |
| Control Center is the **tenant** administrative control plane (configures the platform; modules own domain operations) | Phases 21–26 (`/portal/control-center/*`) |
| Platform administration surface exists separately | `/portal/admin/*` (members, audit-logs, health, settings, …) |
| Public website currently resolves **one constant tenant slug** — there is **no Host-based tenant resolution** | `getPublicSiteChrome()` in `src/app/layout.tsx` → `websiteExperience.ts` (slug defaulted, not derived from request host) |
| **Zero commercial vocabulary anywhere** — no plans, subscriptions, billing, invoices, payments, providers, domains, trials, usage or quotas (all grep matches are comments or media-provider code) | full-repo grep |
| Firebase fully retired; Supabase/PostgreSQL canonical | Final-Firebase-Boundary-Report |

Conclusion: the SaaS **substrate is real but pre-commercial**. This gate designs the commercial layer to extend it, never duplicate it.

---

## A. Current SaaS capability matrix

| Area | Already exists | Partially exists | Missing | Existing artifact | Recommended action |
| --- | --- | --- | --- | --- | --- |
| Tenant provisioning | ✔ | | | `provision_tenant` (0007/0010/0011), platform-admin-only | Extend for self-service signup (Phase C); keep platform path intact |
| Platform administration | ✔ | | | `platform_super_admin`, `is_platform_admin()`, `/portal/admin/*` | Add SaaS operations section (Phase H); do not duplicate module consoles |
| Plans | | | ✔ | — | Build plan + plan-version model (Phase A) |
| Subscriptions | | | ✔ | — | Build subscription model that *writes* `service_entitlements` (Phase A/B) |
| Billing | | | ✔ | — | Build provider-independent billing core (Phase B) |
| Payments | | | ✔ | — | Build payment adapter seam + webhook ingestion (Phase B); provider OPEN |
| Trials | | | ✔ | — | Model as subscription phase (Phase A); parameters OPEN |
| Usage | | ✔ | | Source tables exist (members, media, module records); no metering | Bounded read-only usage resolvers (Phase G); no counters warehouse |
| Quotas | | ✔ | | Activation/entitlement gating exists; commercial limits absent | Server-side limit enforcement at RPC boundary (Phase G) |
| Onboarding | | ✔ | | Provisioning + owner bootstrap exist; no self-service journey | Self-service flow with trial/payment gates (Phase C) |
| Tenant lifecycle | | ✔ | | `tenants.status` ('active','suspended','cancelled'), partial enforcement | Deterministic lifecycle extension + global enforcement (Phase D) |
| Domains | | ✔ | | Slug uniqueness; public site keyed by slug (constant today) | Host-based resolution + platform-provided domain (Phase E) |
| Cloudflare | | | ✔ | — | Provider abstraction only; implementation behind it (Phases E/F) |
| Customer-owned domains | | | ✔ | — | `tenant_domains` + verification state machine (Phase F) |
| Support | | ✔ | | `system_audits.reason_notes`; platform admins exist | Explicit support-session model, audited (Phase H); silent impersonation prohibited |
| Platform health | | ✔ | | `/portal/admin/health` seam | Extend with SaaS dependency checks (Phase H); no monitoring subsystem |
| Data export | | | ✔ | — | Export pipeline (Phase I) |
| Offboarding | | ✔ | | `cancelled` status exists; no retention/policy/automation | Lifecycle-driven offboarding policy (Phases D/I) |

---

## B. Authoritative SaaS architecture

### B1. The four distinctions (mapped to real artifacts)

```text
Plan (plan_versions)
  ↓  commercial package, immutable per version
Subscription
  ↓  tenant's agreement; status + interval + currency
Entitlements  → politicore.platform_settings.service_entitlements  (EXISTING)
  ↓  whether PolitiCore allows the capability — written by subscriptions
Tenant activation  → politicore.tenant_modules.enabled  (EXISTING)
  ↓  whether the tenant turned it on (Control Center RPC, unchanged)
Application authorization  → permission resolver + RLS  (EXISTING, UNTOUCHED)
  ↓  whether a specific user may perform an operation
Usage / limits
     plan_versions limits vs measured usage — server-side check at RPC boundary
```

A subscription NEVER becomes a permission grant. Commercial state feeds `service_entitlements`; everything downstream of entitlements is the existing, proven architecture.

**Reconciliation rule (no duplicate entitlement system):** the commercial layer is the authoritative *writer* of `service_entitlements` (synced on subscription activation/change/expiry); the existing activation RPC, module guards and permission resolver remain the *readers* — unchanged. If the commercial layer is removed, the platform degrades to today's behavior.

### B2. Plans & plan versioning

Conceptual model (schema belongs to Phase A):

- `plans` — identity (`code`, name, description, active/inactive, sort). A plan is a *product*, never mutated destructively.
- `plan_versions` — immutable rows: `plan_id`, semantic `version`, effective_from/effective_to, `currency`-denominated price rows per interval, included modules, feature entitlements (JSONB allowlist), limits (members, storage, custom domains, module meters), status (draft/active/retired).
- **Immutability rule:** a subscription references a `plan_version` forever. Plan changes create new versions; historical invoices keep their `plan_version` reference. No migration of historical facts, ever.
- Module mapping: plan versions reference the four existing `module_code_enum` values only. **No SaaS enum values are added to `module_code_enum`.** Bundles = versions including several modules; add-ons = separately subscribable capability rows that also resolve into `service_entitlements`.

### B3. Tenant lifecycle (deterministic state machine)

Evaluated against the prompt's candidate list. **Adopted states** (extending the existing CHECK, never rewriting history):

| State | Meaning | Entered by | Left by | Tenant users | Public website | Data readable | Billing | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `provisioning` | Machine-driven creation window (Phase C) | System on signup/provision | System when provisioning completes | None (not yet usable) | No | n/a | Not started | — |
| `active` | Fully operational | Provisioning completion; restore | Platform admin; cancellation flow | Full, per permissions | Yes | Yes | Active | — |
| `past_due` | Payment failed; grace running (Phase B dunning) | Billing automation | Successful payment; automation after grace | Full, per permissions | Yes | Yes | Retry active | Automatic on payment |
| `restricted` | Allowance/dunning limit reached; writes gated (Phase G/D) | Dunning automation; quota policy | Payment; plan upgrade; platform admin | Read-mostly; module writes rejected with explicit reason | Yes | Yes | Active (collectible) | Automatic or admin |
| `suspended` | Platform action or terminal dunning | Platform admin; dunning policy | Platform admin only | Auth blocked; owner notified | **No** (unpublished) | Yes (admin-side) | Paused | Admin restore |
| `cancellation_pending` | Cancel at period end | Owner/platform admin | Period end → `cancelled`; owner revives before end | Full, per permissions | Yes until period end | Yes | Through period end | Self-serve revive |
| `cancelled` | Subscription ended; data retained | Period end; immediate cancel | Resubscribe; archival policy | Owner read-only + export | **No** (unpublished) | Yes | Invoices retained | Resubscribe within retention |
| `archived` | Retention elapsed; dormant | Retention automation | Platform admin (legal hold) | No auth | No | Backup-only | Historical only | Admin restore (manual) |

**Rejected candidates:** `trial` is a *subscription phase*, not a tenant state (a tenant may trial one plan then subscribe to another without lifecycle churn). `onboarding` is a `tenant_settings` flag, not a state (it must not gate data access). `restricted` ≠ `suspended`: restricted is commercial/automated and reversible; suspended is a human platform decision.

Enforcement rule: lifecycle gating happens server-side — public projection RPCs refuse non-public states; portal RPCs gate writes for `restricted`; auth hook / middleware refuses `suspended`/`archived`. Existing per-module checks (e.g. `t.status='active'` in Social) remain valid and are subsumed.

### B4. Tenant ownership

- **One owner per tenant**: the existing `tenant_super_admin` access role is the owner. (Today `admin` and `tenant_super_admin` coexist; the owner is the `tenant_super_admin`.)
- Ownership **transfer** = platform-admin operation (audited) or owner-initiated invite-accept handover (Phase C); always exactly one owner.
- Tenant administrators (`admin`) manage operations, **not** the subscription. Subscription changes are owner-only in V1.
- Ordinary members never see billing data.
- Billing administrator as a distinct role: **OPEN decision D8** — V1 keeps the owner as billing contact; no new application role is added now.

### B5. Billing model (provider-independent)

Conceptual objects: `subscription` (+ items per capability), `billing_interval` (monthly/annual), `invoice` (immutable, line items snapshotting plan_version prices), `payment`, `payment_attempt`, `refund`, `credit`, `billing_event` (provider webhook journal, raw payload + signature verification result).

```text
PolitiCore Billing (provider-independent core)
       │
       ├── PaymentProviderAdapter (interface)
       │     initCheckout · verifyWebhook · captureStatus · refund
       ├── Adapter: Nigerian provider   (candidate — OPEN D1)
       ├── Adapter: International card  (candidate — OPEN D1)
       └── Adapter: Manual/offline      (platform-admin confirms payment)
```

Rules: provider identifiers stored only as data (no business logic branches on provider); webhook payloads journaled raw in `billing_event` before processing; state transitions derived by the core, never by client reports; payment-provider secrets server-side only (env/Supabase secrets), never in the browser.

### B6. Currency

Every price is **explicitly denominated in a currency**; a subscription stores its agreed commercial currency; **historical invoices never change because exchange rates change**. No FX conversion exists or is implemented. Multi-currency-capable by design; the launch currency set is **OPEN decision D2** (NGN-first recommended).

### B7. Billing intervals

Monthly and annual are both supported. **Annual pricing is independently configured** per plan version — never computed from monthly. Custom/enterprise contracts map to an annual version with negotiated prices recorded as data.

### B8. Trials

Trials exist as a subscription phase (`trialing`) with: fixed duration (**OPEN D3**; 14 days recommended), **no payment method required**, plan-included modules and limits, **custom domains excluded** during trial, and expiry → `trial_expired` → subscription ends unless converted; tenant falls to `restricted` (data readable, export available, recovery by subscribing). Trial-to-paid conversion = normal checkout; no auto-charge exists because no payment method was captured.

### B9. Failed payments (deterministic dunning)

```text
payment failure → past_due (grace) → restricted → suspended (platform/policy)
```

- Grace period and retry schedule: **OPEN D4** (7-day grace, 3 retries recommended; constants stored in `platform_settings` so product can tune without migration).
- `past_due`: everything works; owner + platform admins notified via Core Notifications.
- `restricted`: module write RPCs rejected with an explicit commercial reason; public website **remains available**; data readable.
- `suspended`: only after grace exhausted (automation) or platform action; public site unpublished; auth blocked.
- **Data is never deleted because of billing failure.** Successful payment automatically restores the prior state.

### B10. Cancellation

Default: **cancellation at period end** (`cancellation_pending` → `cancelled`), data fully preserved. Immediate cancellation is an explicit owner/platform choice. Restoration window = retention period (**OPEN D10**; 90 days recommended). Public site is unpublished at cancellation and restored on resubscription within retention. Cancellation is never coupled to destructive deletion; permanent deletion is a separate, explicit, audited platform action (§ B11).

### B11. Data retention / offboarding

- `cancelled`: retention window with owner export available (Phase I).
- `archived`: auth disabled; data preserved in backup policy; billing/audit records retained indefinitely (financial/legal).
- Permanently deleted tenants: explicit platform action with confirmation + audit; audit records are **never** deleted; media deleted via Core Media; backups follow the platform backup policy.
- Export model (Phase I): `Tenant Data Export` → JSON (records) + CSV (tabular) + media metadata (provider URLs) + website configuration + complete archive bundle.

### B12. Domain architecture — two distinct products

**A. PolitiCore-provided tenant domain** — `tenant-slug.<politicore-domain>`

- Wildcard DNS + wildcard routing on the platform's apex domain: **one DNS record serves all tenants**; no per-tenant DNS operations, no per-tenant certificates (wildcard cert).
- Hostname format: exactly the tenant `slug` (existing regex `^[a-z0-9]+(-[a-z0-9]+)*$`) + platform domain → hostname uniqueness **inherited from the existing slug UNIQUE constraint**; no new uniqueness domain.
- Tenant resolution: server-side **Host-header lookup** `host → slug → tenant` (replaces today's constant slug — Phase E). Unknown/invalid host → neutral public response, never an error page leaking tenant existence; malformed hosts never reach tenant logic.
- SSL: wildcard certificate on the platform domain. Canonical URL: the tenant's primary domain (see B13). `www.` / apex variants of the platform domain redirect to the canonical tenant host.

**B. Customer-owned domain** — `www.customer.com`

```text
Customer submits domain → persisted as pending
  → DNS instructions issued (unique verification token per claim)
  → ownership verified (TXT/CNAME) → Cloudflare Custom Hostname created
  → SSL validation (HTTP/TXT per Cloudflare capability) → ACTIVE
  → (removal / expiry / re-verification lifecycle, all persisted + audited)
```

- A domain is attached to a tenant **only after authoritative verification** — typing a hostname into a form never associates it (§23).
- Verification tokens are unique, expiring, and single-claim; a hostname globally unique across the platform (partial UNIQUE on verified hostnames) — prevents duplicate claims, cross-tenant reuse and takeover-by-reclaim.
- Stale records: periodic re-check; deverified → `action_required` → grace → detached.
- Orphaned domains (tenant cancelled/archived): detached at cancellation; re-attachable within retention.
- Certificate lifecycle failures block activation and alert both owner and platform admins.
- **Cloudflare distinction kept explicit:** `*.politicore.app` wildcard routing ≠ customer-owned custom hostnames (Cloudflare for SaaS). Both live behind one **DomainProvider abstraction** (provisionHostname · createCustomHostname · verifySsl · detach), so the platform code never imports a Cloudflare SDK; credentials server-side only, never exposed to the browser.

### B13. Custom domain types, limits, primary domain

- V1 supports **subdomains only** (`www.customer.com`, `portal.customer.com`, `app.customer.com`). Apex/root (`customer.com`) is **explicitly out of V1 scope** unless Cloudflare account/plan capabilities prove apex custom-hostname support — documented as **OPEN decision D6** with that dependency recorded. (Customers may CNAME `www` → platform if their DNS allows.)
- Plans may impose `custom_domains_limit` (plan-version limit field; numbers are a product decision, not chosen here — **OPEN D7**).
- Primary/secondary/redirect model: exactly one **primary (canonical)** domain per tenant; others are secondaries that 301 to primary; SEO (canonical URLs, sitemap, `metadataBase`) always emits the primary; removing the primary requires designating another primary first; removal of any domain is audited and re-verifiable.

### B14. Platform support & impersonation

**Allowed, but never silent.** A platform support session is an explicit, persisted object: reason required, tenant-specific, time-limited (hard expiry), revocable at any moment, strongly audited at start/end/every privileged action, and **visibly marked** in the product UI while active (persistent banner + audit entries carry the support-session id). Support sessions confer only what a tenant administrator holds — they never bypass module permissions or RLS; the authorization chain (§16 of the Control Center gate) applies unchanged. No silent impersonation exists.

### B15. Usage metering & quota enforcement

- Meters (provider-independent, derived — no counters warehouse): active members, media/storage, custom domains, per-module record counts (governance requests, social tasks, campaign activities, election records), notifications sent. Which meters are billable is a product decision per plan; the architecture measures independently of billing.
- Separation preserved: **usage measurement** (read-only resolvers) ≠ **billing calculation** (Phase B core) ≠ **application authorization** (permission resolver — untouched).
- Enforcement chain: `plan_version limits → entitlement resolver → usage resolver → server-side limit check inside the governing RPC → allowed/rejected (explicit commercial reason code)`. Enforcement lives in the database layer alongside existing permission checks — never client-side; a client cannot bypass it, and RLS/RPC authorization is composed with (not replaced by) quota checks.

### B16. Platform health

- **Tenant health** = lifecycle + subscription + activation + configuration status (already surfaced in Control Center; extended by Phases D/H).
- **Platform health** = infrastructure dependencies: Supabase/Postgres, Supabase Auth, Realtime, Media provider, Cloudflare, payment provider(s), email provider, scheduled jobs, external APIs. Presented through the **existing** `/portal/admin/health` seam (extended, not replaced). **No monitoring subsystem, metrics warehouse, or telemetry database is created** (same seam discipline as the Control Center gate).

### B17. Platform audit (SaaS events)

Reuse **Core Audit** (`system_audits`, nullable `tenant_id` for platform events, `reason_notes`, old/new values). No new audit subsystem. Platform-event action vocabulary (registered in Phase A/H): `tenant_created, plan_assigned, subscription_created, subscription_changed, payment_received, payment_failed, refund_issued, tenant_past_due, tenant_restricted, tenant_suspended, tenant_restored, tenant_cancellation_pending, tenant_cancelled, tenant_archived, domain_attached, domain_verified, domain_removed, support_session_started, support_session_ended, data_exported, tenant_deleted`. All platform actions by platform admins are audited with actor + reason.

### B18. Self-service onboarding (future journey — not implemented)

```text
Create account → Create organization (slug+name) → Select plan → Trial OR payment
  → provisioning (provision_tenant, system-driven) → owner established
  → choose/activate services → configure website → invite team → production
```

Before payment: account, organization, plan selection, trial start (no payment method). During trial: activation, website configuration, team invites, usage within trial limits. After payment: the plan's entitlements sync to `service_entitlements`; checkout gates the plan above trial limits. Automatic: slug reservation, provisioning, owner bootstrap (owner = the creator), welcome notifications. With platform approval: non-standard entitlements, manual/offline payments, ownership transfers, apex-domain exceptions (if ever supported).

### B19. Customer / tenant types

The existing `tenants` model is deliberately generic (0001 comment: "PolitiCore is NOT campaign-only"; no political hard-coding in core tables). The billing engine stays organization-type-agnostic. A `customer_type` taxonomy is **not introduced now** — it is a documented future extension (pricing/display only; never authorization) if/when product requires it.

### B20. Platform SaaS administration surface

The platform operator's control plane extends `/portal/admin/*` (platform_super_admin only) with SaaS operations: Tenants (search, lifecycle control), Plans, Subscriptions, Billing, Domains, Usage, Support, Platform Health, Platform Audit. **Control Center remains the tenant-side control plane; module administration is never duplicated** (Control Center gate § boundary held).

### B21. Security requirements (SaaS layer)

Protected by architecture, verified by per-phase security suites: tenant isolation (RLS unchanged; every commercial table tenant-scoped); subscription isolation (owner-only reads/mutations); billing data owner-visibility only; payment-provider and Cloudflare secrets server-side only; webhook authenticity (signature verification before processing, raw journaling); domain ownership verification before any association; platform administration via `platform_super_admin` + audited; support access only via explicit sessions; exports audited + owner/platform-initiated only; deletion explicit, confirmed, audited; usage counters derived server-side; entitlement state server-resolved.

**Never trusted from the client:** tenant IDs, subscription IDs, entitlement state, payment state, domain verification, usage counters. Server/database state is authoritative.

---

## C. Open product decisions

Only genuinely unresolved decisions are listed. Each must be decided **before** the implementation phase that depends on it; none blocks this architecture gate.

| # | Decision | Options | Architectural consequence | Recommendation | Must be decided before |
| --- | --- | --- | --- | --- | --- |
| D1 | Payment provider(s) at launch | Nigerian PSP; international PSP; manual/offline only; combination | Adapter interface is fixed regardless; only adapter implementations differ | Start manual/offline adapter (no external dependency), add a Nigerian PSP adapter second — **provider choice remains OPEN** | Phase B |
| D2 | Currency set at launch | NGN only; USD only; both | Price rows denominated per currency; plan UX | NGN-first with the B6 principle (no FX) | Phase A |
| D3 | Trial parameters | Duration; modules included; limits; domains excluded (fixed) | Subscription phase constants stored in `platform_settings` | 14 days, no payment method — parameter values OPEN | Phase A (schema constant), Phase C (journey) |
| D4 | Dunning parameters | Grace length; retry count/schedule | Deterministic automation; constants in `platform_settings` | 7-day grace, 3 retries — values OPEN | Phase B/D |
| D5 | Plan catalog at launch | Which plans, bundle composition, pricing | Seeds `plans`/`plan_versions`; no schema impact | Product decision | Phase A |
| D6 | Apex-domain support V1 | Subdomains only; apex if Cloudflare capability allows | Phase F scope; verification/cert flow differs at apex | Subdomains-only V1; revisit on capability evidence | Phase F |
| D7 | `custom_domains_limit` per plan | 0/1/3/10/custom per plan | Plan-version limit field consumed by Phase G checks | Numbers are a product decision — **not chosen here** | Phase A (field), Phase F (enforcement) |
| D8 | Distinct billing-administrator role | Owner-only (V1); new role later | New role would touch `access_role_enum` — avoided in V1 | Owner-only V1; revisit if product demands delegation | Phase B (if delegated) |
| D9 | Support-session ceiling | Max concurrent sessions; max duration | Support-session object constraints | Duration 4h/session, revocable — exact values OPEN | Phase H |
| D10 | Data-retention windows | Cancellation→archive→delete durations | Offboarding automation constants | 90-day restoration window — values OPEN | Phase I |

---

## D. SaaS phase plan (gated implementation sequence)

Dependency-ordered against the real substrate: entitlements → subscriptions → signup → lifecycle → platform domain → customer domains → quotas → operations → offboarding → production gate.

| Phase | Objective | Dependencies | Schema impact | UI impact | External integrations | Security concerns | Acceptance criteria (headline) | Explicitly out of scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A — Commercial Plans & Entitlements** | Plan/version model; entitlement sync to existing `service_entitlements` | None (substrate exists) | `plans`, `plan_versions` (immutable, limits + feature entitlements, currency/interval prices) | Platform plan management; owner plan view | None | No client-supplied entitlement; sync one-directional (commercial→entitlements); module enum untouched | Suite proves: versions immutable, sync writes only `service_entitlements`, no permission grants, RLS + FORCE RLS | Billing, checkout, trials, UI editors beyond plan viewing |
| **B — Subscription & Billing** | Subscriptions, invoices, payments, provider-independent adapter core, dunning states | A | `subscriptions`, `subscription_items`, `invoices`, `payments`, `payment_attempts`, `refunds`, `credits`, `billing_events` | Owner billing surface; checkout redirect | Payment adapter (provider per D1/D2); webhook endpoint | Webhook signature verification before processing; raw journaling; secrets server-side; owner-only billing visibility | Suite proves: webhook forgery rejected, invoice immutability, dunning transitions deterministic, no client payment trust | Payment-provider choice (OPEN D1); UI polish beyond owner surface |
| **C — Self-Service Tenant Onboarding** | Public signup → tenant creation → trial/payment → owner bootstrap | A (plan selection), B (paid path) | Signup RPC + `tenant_settings` onboarding flag | Public signup, plan picker, tenant setup wizard | Payment adapter (if paid at signup) | Provisioning stays server-authoritative; slug collision/abuse; email verification; rate limiting | Suite proves: anon cannot provision arbitrarily, provisioning writes entitlements, owner = creator, no tenant_id from client | Marketing site, email templates beyond transactional |
| **D — Tenant Lifecycle** | Deterministic lifecycle: extend `tenants.status`, global enforcement, dunning wiring | A/B (past_due source), existing substrate | `status` CHECK extension + transition RPCs (platform-admin gated) | Platform tenant management; owner notices | Payment adapter (dunning triggers) | Transition authority; public-projection gating; auth-block correctness; never destructive | Suite proves: only authorized transitions, public site hidden when suspended, restore audited, module RLS subsumed | Trials-as-state (rejected), deletion automation |
| **E — PolitiCore Domains** | Host-based tenant resolution + platform-provided domain | Existing slug uniqueness | Tenant resolution service; host allowlist settings | Public site served per-host | None (wildcard DNS + cert are ops config) | Host-header parsing hardening; unknown-host neutral response; no cross-tenant leakage | Suite proves: host→tenant resolution server-side only, unknown/malformed hosts safe, chrome/config per correct tenant | Cloudflare API integration; custom domains (F) |
| **F — Customer-Owned Domains / Cloudflare** | Domain attach/verify/SSL/active lifecycle behind DomainProvider abstraction | E; D7 | `tenant_domains` + verification lifecycle | Domain management (owner); platform domain admin | Cloudflare for SaaS (behind abstraction); DNS instructions to customer | Verification-before-association; global hostname uniqueness; token expiry; credential isolation | Suite proves: unverified domain never serves, cross-tenant claim rejected, tokens expire, removal audited | Apex support unless D6 resolved; registrar services |
| **G — Usage & Quotas** | Read-only usage resolvers; server-side limit enforcement at RPC boundary | A (limits), D (restricted state) | None new (derived) — possibly limit-check helper RPC | Usage display in Control Center | None | Enforcement in DB layer; explicit rejection reason codes; no client-side counters; composed with permissions | Suite proves: limits enforced server-side, RLS/permissions unchanged, usage not manipulable by client | Billable-meter selection; analytics warehouse |
| **H — Platform SaaS Operations & Support** | Platform Tenants/Plans/Subscriptions/Billing/Domains/Usage/Support/Health/Audit surfaces; support sessions | A–G | `support_sessions` (if approved) | Platform `/portal/admin` SaaS section; support-mode banner | Payment/Domain adapters (status only) | Support-session auditability; platform-admin gating; no module-console duplication | Suite proves: support sessions audited + time-limited + visible; platform surfaces can't mutate module domain data | New monitoring subsystem; business consoles |
| **I — Data Export / Offboarding** | Owner/platform export pipeline; retention automation | D (lifecycle), B (retention constants) | `data_exports` (status/artifact registry) | Owner export UI; platform offboarding console | Storage provider (existing Core Media seam) | Export authorization; PII minimization; audit `data_exported`; deletion explicit+confirmed | Suite proves: cancelled tenant can export, exports audited, deletion requires confirmation + audit, audit rows never deleted | Backup tooling itself; migration to other platforms |
| **J — Final SaaS Production Gate** | Cross-cutting integration/security/regression gate over A–I (pattern: Phase 20/26) | All above | None | None | All adapters live | Full §30 surface re-verified end-to-end on hosted | 100% regression + hosted acceptance + residue 0 + all invariants pinned by static + live probes | Any new feature work |

---

## E. Architectural invariants (non-negotiable)

1. **Tenant isolation** — RLS + tenant-scoped every commercial table; no cross-tenant reads ever.
2. **Server-authoritative entitlement** — entitlements resolve only from server state (`service_entitlements`), written only by the commercial sync.
3. **Server-authoritative subscription state** — subscription transitions derive from database state + verified provider events, never client claims.
4. **Provider-independent billing** — no business logic branches on a payment provider; adapters only.
5. **Provider-independent domain abstraction** — Cloudflare (or any DNS/CDN vendor) lives only behind the DomainProvider interface.
6. **Domain ownership verification** — authoritative verification precedes any tenant-domain association; forms never attach domains.
7. **No client-side billing trust** — payment/subscription state is never accepted from the browser.
8. **No client-side tenant identity** — tenant resolution is server-side (session or Host), never a client-supplied authority input.
9. **No subscription-to-permission shortcut** — a subscription never writes `permission_grants`; commercial state and application authorization remain disjoint layers.
10. **No duplicate entitlement system** — `service_entitlements` stays the single entitlement substrate; the commercial layer is its writer, not a rival.
11. **No destructive cancellation by default** — cancellation preserves data; deletion is separate, explicit, confirmed, audited.
12. **Complete auditability of platform actions** — every platform/SaaS mutation audited in Core Audit with actor + reason.
13. **No silent support impersonation** — support access is explicit, reason-bound, time-limited, revocable, audited, and visibly marked.
14. **Locked business modules remain untouched** — Social Force, Campaign, Election, Governance ownership and behavior unchanged; no SaaS values in `module_code_enum`.
15. **Control Center remains the platform control plane** — tenant-side; platform SaaS operations extend `/portal/admin/*` without duplicating module administration.

---

## F. Verification of the no-implementation constraint

This phase added/changed **no code, migrations, UI, routes, or configuration** — see the git-status receipt captured at the end of this gate.

---

# FINAL GATE

All architectural distinctions resolve cleanly against the existing substrate; no open decision prevents the architecture from being safely defined (every open decision is phase-gated, with defaults recorded and constants designed to live in `platform_settings`).

```text
SAAS ARCHITECTURE GATE: PASS
```
