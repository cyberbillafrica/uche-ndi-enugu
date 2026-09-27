# PolitiCore — Governance Notifications Integration Report (Phase 8)

**Status:** PHASE 8 — COMPLETE
**Parent gate:** `docs/Governance-Architecture-Gate.md` · **Previous:** `docs/Governance-Phase7-Report.md`
**Scope:** Governance workflow events → the **existing Core Notifications** module. One integration migration; no new notification table, queue, service, delivery mechanism, or UI. The Core Notifications schema and service (`src/lib/supabase/notifications.ts`) are **consumed, not modified**.

---

## 1. Implementation

### Integration points (migration `0036_governance_notifications.sql`)

The Campaign precedent (0021 `campaign_notify`) is the established server-side pattern and was followed exactly: best-effort SECURITY DEFINER notify helpers invoked **inside** the Governance authority RPCs, so each notification is created in the **same transaction** as its authorized workflow mutation (§6/§7) and inherits that authorization (§11).

| RPC | Transition | Notifications |
| --- | --- | --- |
| `acknowledge_governance_request` | `submitted → acknowledged` | participant: *Request acknowledged* |
| `assign_governance_request` | assignment | participant: *Request assigned* + assignee: *Governance case assigned to you* |
| `update_governance_request_status` | `→ awaiting_information` | participant: *Information requested* |
| `update_governance_request_status` | `→ resolved` | participant: *Request resolved* |
| `update_governance_request_status` | `→ closed` | participant: *Request closed* |

* Helpers: `politicore.governance_notify` (direct) and `governance_notify_participant` (server-side recipient resolution through `governance_participants.profile_id`; anonymous participants are skipped — no identity to address). Both swallow and warn (`RAISE WARNING`) on failure: a notification fault can never fail the business action.
* Not notified (§16 — no noise): responses (internal or public), feedback, category/administrative changes, event-stream entries, page views.
* **Staff fanout on submission: deferred** (§5) — the existing architecture has no safe server-side recipient-resolution mechanism for "staff responsible for scope," and tenant-wide browser fanout is forbidden. Documented as a future gated decision; participant + assignee paths are complete.

### Content mapping (§8)

The Core schema has no generic metadata column and §8 forbids adding one, so the payload rides the existing columns: `type='system'` (the platform-operational Core enum value — no Governance value added to the CHECK), reference code embedded in `title`/`message`, and deep-link routing in `link_url`: `/portal/governance/requests/[id]` for participants, `/portal/governance/cases/[id]` for the assignee.

### Consistency model (§7)

**Single-transaction authoritative dispatch.** The notify helpers run inside the SECURITY DEFINER RPC, after the mutation and event insert, on the same connection and transaction. There is no async queue to drift. A mid-operation failure rolls back mutation + event + notification together; a notification-only failure is degraded to a warning by the helper contract (the business action survives), matching the shipped Campaign behavior. No retry produces a duplicate (below).

### Duplicate protection (§12)

* `acknowledge` and `update_status` early-return when the operation would not change state (`status` already at target) — a silent retry inserts **no event and no notification** (previously a duplicate event; no legitimate path removed).
* Assignment duplicates are prevented by the Phase 6 `UNIQUE (request_id, assigned_to)` constraint, now surfaced as a controlled domain error (`governance: assignee already assigned to this request`) raised **before** the insert — no partial state, no duplicate notifications. Every successful assignment is a new pair → exactly one notification to each party.
* Reassignment to a new assignee notifies the new pair; the previous assignee is not re-notified.

## 2. Security

* **Tenant isolation** — recipients resolve server-side from the request/participant/assignment rows; no client-supplied `tenant_id`/`user_id`/`actor_id` is ever honored; cross-tenant RPC calls fail before any notification exists (proven N11/M-hosted).
* **Recipient isolation** — Core notifications RLS (`user_id = auth.uid()`) is unchanged; Governance notifications are ordinary per-user rows readable only by their recipient (proven N8/N9, M8).
* **Privacy** — only reference codes and lifecycle facts are sent; responses (internal or public) never notify, so internal staff commentary cannot leak through any notification path (proven N10, M9).
* **Module gating** — `module_enabled('governance')` fails closed inside every RPC before mutation, therefore before notification (proven N11, M10).
* **Authorization** — notifications are consequences of authorized operations; no policy, permission, or RPC contract was weakened. Core Notifications RLS/architecture untouched.

## 3. Testing

```text
Focused suite        governance-notifications 10/10 (N1–N13; N14 via boundary suite in regression)
Full regression      669/669 — 27 suites — 0 skipped — 0 failed  (659 + 10, exact)
Hosted acceptance    10/10 (verify-hosted-smoke-governance-notifications.ts)
TypeScript           0 errors
Build                PASS
Lint                 0 errors
Hosted pristine      0 residue (tenants/requests/participants/notifications/grants/users)
```

Hosted journeys (M1–M10): the full §18 loop — acknowledge → assign (both parties) → information request → resolve → member opens request → feedback → close — with the Center contract verified through the real 0008 RPC surface (`my_unread_count` 5 → 4 after `mark_notifications_read`), strict per-recipient visibility, the internal-response non-leak, same-status retry silence, and the module-disabled fail-closed.

## 4. Boundary proof

```text
No Governance notification table (governance_notifications / case_notifications /
  citizen_notifications / participant_notifications — asserted absent by test N13)
No second notification system, queue, service or inbox — the existing
  Notification Center is the only surface (its unread/mark-read verified live)
No new auth, roles, permissions, geography
Core Notifications — reused, not redesigned (schema and service unchanged;
  inserts via the 0021 campaign_notify precedent only)
Social Force / Campaign / Election / Events / Announcements — untouched
Firebase — still fully retired; zero references in every Phase 8 file
```

## 5. Deviations

1. **Idempotent-retry early returns** in `acknowledge`/`update_status` (0036): a same-state retry previously inserted a duplicate event; it now changes nothing. This tightens §12 without removing any legitimate path (the ladder guard already rejected every other non-submitted acknowledge).
2. **Assignment duplicate → domain error**: the pre-existing UNIQUE constraint now surfaces as `governance: assignee already assigned to this request` instead of a raw constraint violation, and is checked before the insert so failed attempts leave no partial state.
3. **Harness signature fix (discovery, not product)**: the apply-hosted 0034 signature entry tested for a permission named `submit_governance_request`, which never existed (0034 deliberately makes submission not-a-permission). The clause could never pass and was only reachable now that a later migration needed signature evaluation; corrected to the seeded `view_governance` permission.
4. `type='system'` mapping as described in §1 (no schema change).

## 6. Deferred (separately gated)

Staff fanout for new submissions (needs a server-side scope-recipient resolution mechanism); notification preferences; SMS/WhatsApp/email/push delivery; public intake and case lookup; Projects, consultations, surveys, petitions, engagements, analytics.

**Phase 8 stops here per the final directive** — the operational communication loop around the proven Phase 7 workflow is complete on the existing Core Notifications infrastructure.
