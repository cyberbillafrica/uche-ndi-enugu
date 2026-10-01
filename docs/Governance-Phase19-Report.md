# PolitiCore — Governance Phase 19 Report

## Analytics & Institutional Memory

**Status:** PHASE 19 — COMPLETE — **GATE: PASS**
**Architecture source:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md` (Phase 11 Analytics & Institutional Memory architecture)
**Preceding:** Phase 18 — Governance Accountability — COMPLETE/PASS
**Locked modules untouched:** Social Force, Campaign, Election, Core Identity/Auth, Core Geography, Core Notifications, Core Media, Core Audit, Events, News, Announcements, Manifesto, Governance Requests/Cases, Public Intake, Projects, Commitments, Consultations/Surveys, Petitions/Community Proposals, Polls, Engagements, Accountability.

---

## 1. What was built

**Migrations (no new tables, types, sequences, or schemas — analytics are 100 % derived):**

* `supabase/migrations/0058_governance_analytics_memory.sql` — five SECURITY DEFINER aggregate RPCs (`governance_analytics_requests/delivery/participation/engagements/accountability`) plus the Institutional Memory timeline RPC (`governance_memory_timeline(text, integer, integer)`). Every metric is computed from canonical records at query time.
* `supabase/migrations/0059_governance_analytics_scope_hardening.sql` — §7 scope hardening (see §3) + runtime bug fixes to the 0058 bodies + PostgREST reachability wrappers under `public.*` (the 0056 text-overload convention; SECURITY INVOKER, verbatim delegation, authority re-gated in-body).

**Service layer:** `src/lib/supabase/governance.ts` — Phase 19 section: typed wrappers for the five analytics RPCs and the memory timeline. The client never sends tenant, actor, or scope identity; everything is server-resolved.

**Portal:** `src/app/portal/governance/analytics/page.tsx` — staff analytics dashboard (delivery, participation, engagement, requests, accountability cards + institutional-memory timeline with kind filter and pagination). Navigation entries added in `src/app/portal/layout.tsx` (`governanceStaff`-gated; analytics requires `view_governance`).

**Security suite:** `tests/security/governance-analytics.test.ts` — 22 tests, role-impersonated sessions (`helpers.as`), same acceptance standard as Phases 6–18.

**Hosted acceptance:** `scripts/db/verify-hosted-smoke-governance-analytics.ts` — 24 journeys against the real hosted Supabase project through real PostgREST + real GoTrue identities.

---

## 2. Analytics domains

| Domain | RPC | Derived metrics |
| --- | --- | --- |
| Requests | `governance_analytics_requests()` | status buckets, per-ward distribution, per-category distribution, monthly trend, median/p90 resolution duration (derived from canonical `governance_requests`) |
| Delivery | `governance_analytics_delivery()` | projects total/active/concluded/published, milestone completion, commitments total/by status/linked-to-project, published commitments |
| Participation | `governance_analytics_participation()` | consultation/survey buckets + response bands, petition/proposal status + verified-support totals, poll counts + open/closed/published + aggregate option distribution |
| Engagement | `governance_analytics_engagements()` | lifecycle buckets, scheduled vs concluded, by-geo counts, attendance totals, issue totals + addressed/closed, follow-up update counts, published count |
| Accountability | `governance_analytics_accountability()` | published-project flags, published-participation flags, published-engagement flags, total governance updates published |

**Institutional Memory:** `governance_memory_timeline(p_kind, p_limit, p_offset)` — a single derived UNION over the canonical substrates (projects, commitments, consultations, petitions, polls, engagements, governance_updates), each surfaced as `{kind, ref, title, occurred_at, status}`. No second history model; retrieval is the existing PostgreSQL substrate (no search infrastructure).

---

## 3. §7 scope hardening (0059)

The Phase 11 gate positions analytics as staff-operational; prompt §7 requires that a geographically scoped user must not obtain tenant-wide analytics. 0058 as first drafted failed this in two ways and 0059 fixes both:

1. **Bare `has_permission('view_governance')` passes for position-default holders at any geographic scope** — a ward-scoped staffer would have received tenant-wide aggregates. `governance_analytics_tenant_wide(perm)` now returns TRUE only for tenant/platform admins or an *explicit unscoped grant*; position defaults are inherently scoped and never confer tenant-wide analytics.
2. **Per-row geographic coverage** — every aggregate and the timeline thread `governance_analytics_row_covers(_typed)` through each row: TRUE for tenant-wide callers, else the Core resolver `has_permission(perm, scope_type, scope_id)` evaluated at the row's scope (explicit scoped grants, position defaults at covering scopes, deny-wins). Scope-less rows fail closed. Uses only Core Geography semantics — no new geography logic.

---

## 4. Privacy model

* Buckets/bands, never identities: response counts as bands (1–5, 6–20, …), duration as median/p90, attendance/issues as counts.
* No citizen contacts, no case text, no answers, no votes, no signer/attendee/respondent identity in any payload.
* Public surface unchanged: analytics are staff-only; public accountability remains the Phase 18 layer.

## 5. Permissions & authorization

* **Zero new permissions** — analytics gate on the existing `view_governance` only (verified: `governance_analytics_authority('view_governance')` is the sole authority call).
* Tenant resolved server-side (`current_tenant_id()`), module gate (`module_enabled('governance')`) re-checked inside every RPC.
* ACL posture: six surfaces authenticated-only; five internal helpers carry no top-level role grants (definer-internal).

## 6. Verification

| Check | Result |
| --- | --- |
| Focused security (`tests/security/governance-analytics.test.ts`) | **22/22** |
| Full regression | **913/913 — 38 suites — 0 skipped — 0 failed** |
| Hosted acceptance (`verify-hosted-smoke-governance-analytics.ts`) | **24/24 journeys** |
| Hosted residue | **0** (after one-off purge; harness cleanup hardened: profiles + tenants now explicit deletes) |
| TypeScript (`tsc --noEmit`) | **0 errors** |
| Build (`next build`) | **PASS** |
| Lint (touched files) | **0 errors / 2 pre-existing warnings** (`portal/layout.tsx:467,1307` — untouched lines) |
| New tables/types/sequences | **0** |
| Firebase references | **0** |
| New permissions / roles | **0 / 0** |

### Security-suite coverage (22)
A. authority (anon zero surface; module-off fails closed; member without `view_governance` denied) · B. tenant isolation (cross-tenant zero) · C. §7 scope (ward-scoped staffer sees only covered slices across all five RPCs + timeline; explicit unscoped grant remains tenant-wide; uncovered-ward rows never appear) · D. privacy (no contacts/case text/answers/votes/identities in any payload) · E. memory timeline (kinds, filters, bounds) · F. ACL posture (helpers carry no role grants).

### Hosted journeys (24)
J1 anon: zero surface (6×401 + helper 404) · J2 member denied on every surface · J3a–e aggregate correctness from canonical rows · J4a–c timeline kinds/filter/limit-200 · J5a–e ward-scoped §7 proof on hosted · J6 payload privacy sweep · J7 second-tenant all-zero isolation · J8 ACL posture.

---

## 7. Deviations (explicitly disclosed)

1. **Migration count pin provenance** — `tests/security/governance-phase11-architecture.test.ts` D1 pin updated `59 → 60` (files `0000`–`0059`); documentation-only, test-file change permitted by §33 ("derived reporting/retrieval integrations").
2. **Public RPC wrappers added under `public.*`** — required for hosted PostgREST reachability; follows the established 0056 convention (SECURITY INVOKER, verbatim delegation, authority re-gated in-body, anon revoked). Not a deviation from the architecture — an application of the existing pattern.
3. **Hosted residue purge** — the analytics harness's initial cleanup left 10 tenants + 20 profiles (replica mode disables FK cascades; profiles outlive `auth.users` deletes). Purged via one-off script; harness cleanup hardened; final residue verified 0.
4. **0059 restates 0058 function bodies** — convergence pattern; 0058 was already applied to both environments when the runtime bugs surfaced. The five helper functions from 0058 (`governance_analytics_tenant_wide/_row_covers/_row_covers_typed/_authority/_covers`) are restated, not removed.

## 8. Deferred items

None. No stop conditions triggered: no new operational table, no duplicated canonical records, no second history/audit system, no new permission or role, Core Geography enforced throughout, no search infrastructure, no warehouse, no locked module redesigned, tenant isolation proven, N+1 avoided (each surface is a single RPC round-trip).

## 9. Architecture integrity — end state

```text
ONE Governance operational data model          ✓ (zero tables added)
ONE participant system                         ✓ (governance_participants untouched)
ONE authorization system                       ✓ (Core has_permission / scope_covers reused)
ONE geography system                           ✓ (no new geography logic)
ONE notification system                        ✓ (Core Notifications untouched)
ONE audit system                               ✓ (Core Audit untouched)
ONE media system                               ✓ (Core Media untouched)
ONE canonical Updates substrate                ✓ (governance_updates read, never duplicated)
ONE accountability/publication layer           ✓ (Phase 18 surface unchanged; Phase 19 derives flags only)
DERIVED analytics                              ✓ (all metrics computed at query time)
DERIVED institutional memory                   ✓ (UNION over canonical substrates)
NO duplicate history model                     ✓
NO analytics warehouse                         ✓
NO parallel search system                      ✓
```

---

**GOVERNANCE ANALYTICS & INSTITUTIONAL MEMORY — PHASE 19: PASS**
