# Electioneering and Election Management Engine

## Overview

The **Election Management Engine** provides an end-to-end electioneering infrastructure for the **Ifeanyi 2027 Campaign Application** in Enugu State. It supports real-time field result reporting, physical Form EC8 evidence inspection, multi-tier officer approval workflows, scope-based hierarchical view restrictions, and real-time dashboard aggregation.

---

## Authoritative Business & Security Principles

1. **Membership Model**:
   - There are only two membership types: `campaign_member` and `social_member`.
   - A `campaign_member` automatically receives ordinary Election access for their registered Polling Unit (`profile.ward_id` and `profile.polling_unit_id`). An `OrganizationalAssignment` is **NOT required** for ordinary PU access.
   - Social-only members are strictly blocked from all Election routes and collections.

2. **Official Aggregation Requirement**:
   - **ONLY results with `status === "approved"` are official.**
   - Unapproved (`submitted`, `pending_review`, `rejected`, `clarification_required`, `reopened`) results are strictly excluded from official totals, party counts, leading margins, and real-time alerts.

3. **Approval Workflow & Admin Corrections**:
   - **Admin correction is NOT a substitute for Election Officer approval.**
   - If an Admin modifies an unapproved or approved result, its status moves to `pending_review` and requires independent Election Officer review before becoming official again.

4. **Form EC8 Mandatory Evidence**:
   - Every result submission requires typed party vote counts and a mandatory photo of the signed Form EC8 uploaded to Cloudinary (`ifeanyi-2027/election-results`).

5. **Server-Side Security**:
   - Firestore Security Rules enforce PU registration checks (`ward_id == callerProfile().ward_id && polling_unit_id == callerProfile().polling_unit_id`) for campaign members and block Social-only members at the database boundary.

---

## Architecture & Data Flow

```
[Field Agent / Campaign Member]
       │
       ├─► Upload Form EC8 Photo ──► Cloudinary ("ifeanyi-2027/election-results")
       │
       └─► Form EC8 Data + Vote Counts ──► Firestore (`election_results/{wardId}__{puId}`)
                                                    │ (Initial status: "submitted")
                                                    ▼
                                    [Election Operations Desk]
                                    (`/portal/election/operations`)
                                                    │
                                   ┌────────────────┴────────────────┐
                                   ▼                                 ▼
                          [Approve Result]                  [Reject / Clarify]
                                   │                                 │
                                   ▼                                 ▼
                         (Status: "approved")             (Status: "rejected" /
                                   │                       "clarification_required")
                                   ▼
                    [Official Election Dashboard]
                       (`/portal/election`)
                 (Live Real-Time Aggregation)
```

---

## Result Lifecycle & Statuses

Each election result document (`/election_results/{wardId}__{puId}`) transitions through a defined lifecycle:

| Status | Description | Included in Aggregates? |
|---|---|---|
| `submitted` | Fresh result submitted by authorized agent with Form EC8 evidence. | ❌ No |
| `pending_review` | Queued for Election Officer inspection. | ❌ No |
| `approved` | Verified against Form EC8 evidence by Election Officer. | ✅ **YES** |
| `rejected` | Rejected due to discrepancies, invalid evidence, or tampering. | ❌ No |
| `clarification_required` | Returned to agent with officer notes for verification. | ❌ No |
| `reopened` | Approved/rejected result reopened by authorized officer for re-inspection. | ❌ No |

---

## Access & Role Matrix

| Portal Route / Resource | Admin / Super Admin | Election Officer | Campaign Member | Social Member |
|---|---|---|---|---|
| `/portal/election` | Global View & Correction | Global View | Scoped View (Registered PU / Scope) | ⛔ Blocked |
| `/portal/election/operations` | Full Inspection & Action | Full Inspection & Action | ⛔ Blocked | ⛔ Blocked |
| `/portal/election/upload` | Authorized Upload | Authorized Upload | Registered PU Only | ⛔ Blocked |
| `/portal/election/pu-reports` | Full View & Management | Full View | Authorized PU | ⛔ Blocked |
| `/portal/election/incidents` | Full View & Management | Full View | Authorized PU | ⛔ Blocked |
| Firestore `/election_results/{id}` | Read/Create/Update | Read/Create/Update | Scoped Read/Create | ⛔ Blocked |

---

## Key Files & Modules

- **Data Layer & Services**:
  - `src/lib/firebase/election.ts`: Firestore models (`ElectionResultDoc`, `ElectionPartyResult`, `ElectionResultHistory`), status types, real-time `subscribeToElectionResults()` with query scoping, `submitElectionResultWithEvidence()`, `reviewElectionResult()`, and `correctElectionResult()`.
  - `src/lib/firebase/electoral.ts`: Enugu State 17 LGA electoral taxonomy resolver.
  - `src/lib/cloudinary.ts`: Cloudinary photo uploader enforcing `"ifeanyi-2027/election-results"`.

- **User Interfaces & Operations**:
  - `src/app/portal/election/operations/page.tsx`: Election Officer Form EC8 Inspection & Audit Desk.
  - `src/app/portal/election/page.tsx`: Official Election Dashboard filtering aggregates to approved results.
  - `src/app/portal/election/upload/page.tsx`: Polling Unit election result & EC8 photo evidence submitter.
  - `src/app/portal/layout.tsx`: Portal navigation sidebar hiding election features from Social-only members.

- **Security & Rules**:
  - `firestore.rules`: Server-side authorization rules for `/election_results/{resultId}`, blocking social-only members, enforcing registered PU checks for campaign members, and preventing unauthorized overwrites.

---

## Audit Trail & Compliance

Every state transition or administrative correction appends an immutable entry to the result's `history` array:

```ts
export interface ElectionResultHistory {
  edited_by: string;
  edited_at: unknown;
  action: "create" | "correct" | "review_approve" | "review_reject" | "review_clarify" | "reopen";
  old_results?: ElectionPartyResult[];
  new_results?: ElectionPartyResult[];
  old_status?: ElectionResultStatus;
  new_status?: ElectionResultStatus;
  notes?: string;
  reason?: string;
}
```

This guarantees full traceability of officer decisions against physical Form EC8 evidence.
