# PolitiCore — Governance First Vertical Slice Report (Phase 7)

**Status:** PHASE 7 — COMPLETE
**Parent gate:** `docs/Governance-Architecture-Gate.md` (Phase 6) · **Previous:** `docs/Governance-Phase6-Report.md`
**Scope:** The first usable Governance operational loop — participant submit/track, staff case management, admin categories — as a thin application layer over the approved 0034/0035 database contract. **No schema changes. No RPC changes. No locked-module changes.**

---

## 1. Implementation

### Routes created

| Route | Surface | Authority |
| --- | --- | --- |
| `/portal/governance` | Participant landing: intro, recent requests, quick actions | module ∧ `view_governance` ∧ participant |
| `/portal/governance/requests/new` | Submit request → reference-code confirmation | module ∧ `view_governance` ∧ participant |
| `/portal/governance/requests` | My Requests list (reference, status, category, updated) | module ∧ `view_governance` ∧ participant |
| `/portal/governance/requests/[id]` | Participant detail: RLS-visible event trail, response form, one-shot feedback | module ∧ `view_governance` ∧ participant |
| `/portal/governance/cases` | Staff queue: status/category/assigned-to-me/search — all server-side | module ∧ `view_governance` ∧ staff |
| `/portal/governance/cases/[id]` | Case detail: acknowledge, assign dialog, progress, request-info, respond (public/internal), resolve, close, reopen | module ∧ `view_governance` ∧ staff |
| `/portal/governance/categories` | Category administration: create/edit/activate/deactivate | module ∧ `view_governance` ∧ admin |

### Components / services

* **`src/lib/supabase/governance.ts`** — the canonical Governance service (barrel-exported from `src/lib/supabase/index.ts`). Thin over the database: `resolveGovernanceAccess`, `getMyParticipant`, `listMyRequests`, `getMyRequest`, `getRequestEvents`, `submitRequest`, `addParticipantResponse`, `submitFeedback`, `listCases`, `getCase`, `acknowledgeCase`, `assignCase`, `changeCaseStatus`, `addStaffResponse`, `listCategories`, `createCategory`, `updateCategory`, `setCategoryActive`.
* **RPCs consumed (Phase 6 authority surface, verbatim):** `public.submit_governance_request`, `acknowledge_governance_request`, `assign_governance_request`, `update_governance_request_status`, `respond_governance_request`, `rate_governance_request`; permissions via `politicore_has_permission`. The event trail, requests, assignments and categories are read through the RLS-governed security_invoker views. Category CRUD goes through the view policies (`is_tenant_admin`).
* **Navigation (`src/app/portal/layout.tsx`):** a Governance nav group rendered only when `module_enabled('governance')` **AND** `canViewGovernance`; staff children require `isStaff`, participant children `isParticipant`, Categories `isAdmin`. The group is decoupled from Campaign/Election state.
* **Notifications:** deferred (see §5). The workflow is fully operational without it.

### Security posture (UI layer)

* Every route guard **fails closed**: unauthenticated, module-disabled, missing `view_governance`, or insufficient participant/staff/admin authority → redirect to the portal dashboard. Sidebar hiding is never the authorization.
* Participant detail renders exactly what RLS returns — no client-side event filtering or widening; the internal/public response distinction exists only on the staff surface and maps 1:1 to `respond_governance_request`'s `p_is_public`.
* The client never sends `tenant_id`/actor identity; the service never mutates the append-only event table; lifecycle legality is left entirely to the status-ladder guard.
* Discovery correction folded in: `view_governance` is the **navigation/surface permission** per gate §E/§13 — the access resolver computes `canViewGovernance` (grant-based, deny-rows honored), and members without it never see or reach Governance surfaces. A `view_governance` deny row fails the nav closed (proven hosted, S3).

## 2. Testing

```text
Focused suites          governance-slice 8/8 (DB contract of the slice)
                        governance-slice-surface 7/7 (UI access contracts)
Full regression         659/659 — 26 suites — 0 skipped — 0 failed  (644 + 15, exact)
Hosted slice acceptance 13/13 (verify-hosted-smoke-governance-slice.ts)
TypeScript              0 errors
Build                   PASS
Lint                    0 errors (2 pre-existing layout warnings, present at HEAD, untouched)
Hosted pristine         0 fixture residue (tenants/requests/participants/grants/users)
```

Hosted journeys (S1–S12): access resolution for admin/staff/member (incl. the deny-row contract), my-requests embedded-join read, request detail, participant event trail, server-side queue filters (status/ilike/assigned-to-me), the full lifecycle **including the illegal `acknowledged → awaiting_information` rejection by the ladder guard** and the legal reopen path (S8 walks `in_progress ⇄ awaiting_information`), staff response visibilities, one-shot feedback, category admin through the view (201-create, 403-member, deactivate-hides).

## 3. Boundary proof

```text
Social Force     — untouched (no file in its surface modified by Phase 7)
Campaign         — untouched
Election         — untouched
Notifications    — reused, not duplicated (integration deferred, no new table)
Events           — untouched
Announcements    — untouched
Firebase         — zero usage in every Phase 7 file; fully retired platform-wide
Core Identity / Geography / Audit / Media — consumed, never forked
```

No new auth/role/permission/geography/notification/audit system exists. Governance-specific parallel structures (`case_comments`, `case_audit_logs`, `governance_notifications`, …) are absent by test pin.

## 4. Deviations

1. **`canViewGovernance` added to the access resolver** — the Phase 6 DB has no `view_governance` SELECT policy (deliberate: submission is ownership-based, not privilege-based), so the gate document's "navigation requires `view_governance`" contract needed an explicit application-side resolver flag. This is presentation-layer gating only; the database remains authoritative for every operation.
2. **S8 harness fix** — the hosted lifecycle walk initially used `acknowledged → awaiting_information` (not a ladder edge; the guard correctly rejected it). The harness now walks the approved ladder and pins the illegal-edge rejection as an assertion.
3. Two harness details (PostgREST 201 on category insert; effective-denial G14 assertions from Phase 6) carried over as-is.

## 5. Deferred (separately gated)

* Notifications wiring (request acknowledged/assigned/needs-info/resolved) — Core Notifications integration, no Governance-owned delivery.
* Public/anonymous intake, public case lookup by reference code.
* Projects, consultations, surveys/polls, petitions, engagement sessions, accountability analytics.
* `display_label` tenant-wording configuration surface (field exists end-to-end).

**Phase 7 stops here per the implementation rule:** the Phase 6 architecture is proven as a complete, usable operational workflow. The recommended next step is the Governance notifications integration phase or the hosted-decision on public intake.
