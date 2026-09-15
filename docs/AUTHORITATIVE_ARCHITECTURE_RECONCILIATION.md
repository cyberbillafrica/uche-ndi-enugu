# Politicore / Ifeanyi 2027 — Phase 2.2: Final Authoritative Architecture Reconciliation Specification

---

## A. Executive Architecture Summary

This document serves as the governing architecture reconciliation specification for the Politicore Campaign Management & Multi-Contest Electoral Platform (`ifeanyi-4-nkanu`). It synthesizes product intent, current Next.js/React application code, and Cloud Firestore Security Rules (`firestore.rules`).

### Key Findings & Architectural Gaps
1. **Leaderboard Query vs. Privacy Rule Lockout:** The client function `getLeaderboard()` queries `collection(db, "users")` directly with `orderBy("points", "desc")`. However, `firestore.rules` restricts `/users/{userId}` reads strictly to `isAdmin() || isOwner(userId)`. Consequently, non-admin users trigger permission errors when loading the leaderboard.
2. **Organizational Hierarchy vs. Flat Security Rules (`hasAccess` / `user_access`):** Client-side permissions helpers (`src/lib/permissions.ts`) dynamically expand organizational scopes (State → Zone → LGA → Ward → PU). In contrast, `firestore.rules` evaluates scoped permissions via an exact document lookup on `/user_access/${permission}__${scopeType}__${scopeId}`. Higher-level coordinators (e.g. LGA Coordinators) are rejected by security rules when attempting to create or access resources scoped to descendant Wards/PUs unless explicit `user_access` index records exist for those descendant scopes or rules evaluate hierarchy.
3. **Delete Rules `request.resource` Anti-Pattern:** Security rules for document deletions in collections such as `organizational_assignments`, `permission_grants`, `donations`, and `campaign_activities` evaluate `request.resource.data.tenant_id`. In Cloud Firestore Security Rules, `request.resource` is `null` during `delete` operations, causing permission evaluation errors.
4. **AuthContext Cascading Failure Pathway:** When an error occurs during `getUserOrganizationalAssignments()` or `getUserPermissionGrants()`, `AuthContext.tsx` catches the exception and resets `assignments` and `grants` to empty arrays (`[]`). This causes downstream permission resolvers to lose organizational context and display access blocker UI elements.
5. **Tenant Filter Omissions in Read Services:** Client query functions `getUserOrganizationalAssignments()`, `getUserPermissionGrants()`, `getOrganizationalAssignmentsByUserId()`, `getPermissionGrantsByUserId()`, and `getAllCampaignMembersForTenant()` accept or possess tenant scope parameters but omit `where("tenant_id", "==", tenantId)` in their actual Firestore query constraints.

---

## B. Identity and Membership Model

1. **Authentication Identity:** Handled via Firebase Auth (`User.uid`). Profile documents are stored in `/users/{userId}`.
2. **Membership Types:**
   - `social_member`: Access to social media tasks, point earning, public campaign feed, and leaderboard.
   - `campaign_member`: Category for campaign council features (Area, Members, Activities, Assignments, Reports, Issues) and location-scoped election reporting.
   - **Dual Membership:** Users may possess both `social_member` and `campaign_member` types. In `src/app/portal/dashboard/page.tsx`, dual-membership users can toggle between Social and Campaign views.
3. **Relationship to Authorization:** Membership type alone does NOT grant organizational authority, unrestricted election access, or administrative capability. Membership type is an eligible product category, not an unrestricted authorization bypass.

---

## C. Access Roles vs. OrganizationalAssignment

| Concept | Purpose | Example Values | Storage Location |
| ------- | ------- | -------------- | ---------------- |
| `access_role` | Application/System capability | `admin`, `member`, `election_officer`, `tenant_super_admin` | `users/{userId}.access_role` |
| `OrganizationalAssignment` | Appointed leadership position in campaign hierarchy | `ward_coordinator`, `lga_coordinator`, `zone_coordinator`, `state_coordinator` | `/organizational_assignments/{id}` |

- **Strict Boundary:** Organizational positions (e.g. Ward Coordinator) must NEVER be saved into `access_role`.
- **Admin Independence:** Admins possess system-wide administrative capabilities and do NOT require an `OrganizationalAssignment` to perform administrative tasks.

---

## D. PermissionGrant vs. Materialized `user_access`

- `PermissionGrant`: Administrative document stored in `/permission_grants/{grantId}` defining explicit grants or denials (`granted: true | false`).
- `user_access` Index: Materialized lookup document created atomically in `/user_access/${permission}__${scopeType}__${scopeId}` via Firestore `writeBatch` when a `PermissionGrant` is created or updated. Enables single-document `exists()` checks in `firestore.rules`.

---

## E. Organizational Hierarchy

The campaign organizational structure operates across five geographic levels:

```text
State (enugu-state)
  ↓
Senatorial Zone (e.g. enugu-east)
  ↓
LGA (e.g. nkanu-west)
  ↓
Ward (e.g. ward-01)
  ↓
Polling Unit (e.g. pu-001)
```

- **PRODUCT REQUIREMENT:** Higher-level organizational scope may authorize descendant scopes according to the permission policy.
- **CURRENT APPLICATION STATE:** Implemented in `src/lib/permissions.ts` via `assignmentCoversScope()` and `isScopeDescendant()`.
- **CURRENT FIRESTORE RULE STATE:** Security rules perform exact string match checks on `/user_access/${permission}__${scopeType}__${scopeId}` without expanding parent scopes.
- **PHASE 3 IMPLEMENTATION DIRECTION:** Phase 3 must select the least disruptive mechanism compatible with the existing architecture and Firestore constraints (e.g. writing parent/child index entries or rule helpers) without introducing a second parallel authorization framework.

---

## F. Registered Location Model

- **Definition:** Captured on `user.profile` as `ward_id` and `polling_unit_id`.
- **Purpose:** Identifies where a campaign member is registered to vote.
- **Operational Scope:** Provides self-service election result uploads, field report submissions, and incident reporting for that specific registered location.
- **Separation:** Registered location is distinct from an `OrganizationalAssignment` and does NOT grant leadership or coordinator authority over other members.

---

## G. Election Authorization Matrix

| Capability | Social-only Member | Campaign Member | Election Officer | Admin | Required Scope / Condition |
| ---------- | ------------------ | --------------- | ---------------- | ----- | -------------------------- |
| **Election Module Access** | ⛔ Denied | ✅ Eligible | ✅ Allowed | ✅ Allowed | Navigation & portal route access subject to permission |
| **View Election Results** | ⛔ Denied | ✅ Eligible (Scoped) | ✅ Allowed (Global) | ✅ Allowed (Global) | Registered PU/Ward or Organizational Scope |
| **Upload PU Election Result** | ⛔ Denied | ✅ Eligible (Registered PU) | ✅ Allowed | ✅ Allowed | Open contest; registered PU or officer grant |
| **Submit Election Incident** | ⛔ Denied | ✅ Eligible (Registered PU) | ✅ Allowed | ✅ Allowed | Registered PU or active officer grant |
| **Submit PU Field Report** | ⛔ Denied | ✅ Eligible (Registered PU) | ✅ Allowed | ✅ Allowed | Registered PU or active officer grant |
| **Election Operations Desk Review** | ⛔ Denied | ⛔ Denied | ✅ Allowed | ✅ Allowed | `role == 'election_officer'` or `admin` |
| **Result Verification & Approval** | ⛔ Denied | ⛔ Denied | ✅ Allowed | ✅ Allowed | `role == 'election_officer'` or `admin` |
| **Admin Result Correction** | ⛔ Denied | ⛔ Denied | ⛔ Denied | ✅ Allowed | `role == 'admin'`; sets status to `pending_review` |

*Note on Membership vs Authorization:* Campaign Membership is a necessary product category for ordinary campaign participation, but alone does NOT constitute unrestricted authorization. Actual operational authorization requires a valid registered location, organizational scope, or explicit permission grant.

---

## H. Election Result Visibility Matrix

| User Category | Viewing Authority | Scope Boundaries |
| ------------- | ----------------- | ---------------- |
| **Social-only Member** | ⛔ Denied | None (Blocked at routing and database boundaries) |
| **Campaign Member (Registered PU)** | ✅ Allowed | Restricted to registered Ward/PU results (`profile.ward_id`, `profile.polling_unit_id`) |
| **Campaign Member (With Assignment)** | ✅ Allowed | Scoped to assigned geographic area and subordinate descendants per hierarchy policy |
| **Election Officer** | ✅ Allowed | Tenant-wide global result visibility |
| **Admin** | ✅ Allowed | Tenant-wide global result visibility |
| **Explicit Permission Grant** | ✅ Allowed | Scoped according to explicit `view_election_dashboard` grant scope |

---

## I. Election Submission / Review / Correction Workflow

```text
[Field Agent / Campaign Member]
       │
       ├─► Upload Form EC8 Photo ──► Cloudinary ("ifeanyi-2027/election-results")
       │
       └─► Form EC8 Data + Vote Counts ──► Firestore (`election_results/{contestId}__{puId}`)
                                                    │ (Status: "submitted", verified: false)
                                                    ▼
                                    [Election Operations Desk]
                                    (`/portal/election/operations`)
                                                    │
                                   ┌────────────────┴────────────────┐
                                   ▼                                 ▼
                         [Approve Result]                  [Reject / Clarify]
                                   │                                 │
                         (Status: "approved",                        ▼
                          verified: true)                (Status: "rejected" /
                                   │                       "clarification_required")
                                   ▼
                       [Admin Correction]
                   (`correctElectionResult`)
                                   │
                                   ▼
                        (Status: "pending_review",
                         verified: false)
                                   │
                                   ▼
                     [Election Officer Re-Review]
```

- **CURRENT STATE:** `adminCorrectionUpdate()` in `firestore.rules` enforces immutable identity fields and restricts allowed update keys.
- **INTENDED STATE / GAP:** Any Admin correction MUST result in `status = "pending_review"` and `verified = false`, requiring subsequent Election Officer re-review before becoming official again.

---

## J. Tenant Isolation Matrix

| Query Function | File Path | Current Query Constraints | Includes `tenant_id` Filter? | Rule Requires `tenant_id`? | Status / Gap |
| -------------- | --------- | ------------------------- | ---------------------------- | -------------------------- | ------------ |
| `getUserOrganizationalAssignments` | `src/lib/firebase/organization.ts` | `where("user_id", "==", userId)` | ❌ No | ✅ Yes (`callerTenantId()`) | CURRENT STATE: Source defect (omits tenant filter) |
| `getUserPermissionGrants` | `src/lib/firebase/organization.ts` | `where("user_id", "==", userId)` | ❌ No | ✅ Yes (`callerTenantId()`) | CURRENT STATE: Source defect (omits tenant filter) |
| `getOrganizationalAssignmentsByUserId` | `src/lib/firebase/organizationalAssignments.ts` | `where("user_id", "==", userId)` | ❌ No | ✅ Yes (`callerTenantId()`) | CURRENT STATE: Source defect (omits tenant filter) |
| `getPermissionGrantsByUserId` | `src/lib/firebase/permissionGrants.ts` | `where("user_id", "==", userId)` | ❌ No | ✅ Yes (`callerTenantId()`) | CURRENT STATE: Source defect (omits tenant filter) |
| `getAllCampaignMembersForTenant` | `src/lib/firebase/campaignMembers.ts` | `where("membership_types", "array-contains", "campaign_member")` | ❌ No | ✅ Yes (`callerTenantId()`) | CURRENT STATE: Source defect (function accepts `tenantId` parameter but current query omits `where("tenant_id", "==", tenantId)`) |

---

## K. AuthContext Authorization Flow

```text
Firebase Auth Change
       │
       ▼
Fetch User Profile (`getUserProfile`)
       │
       ▼
Fetch Organizational Access (`getUserOrganizationalAssignments` & `getUserPermissionGrants`)
       │
       ├─► SUCCESS: Set active assignments & permission grants; set accessLoading = false.
       │
       └─► CATCH ERROR: Log error; set assignments = [], grants = []; set accessLoading = false.
                               │
                               ▼
            [Cascading Authorization Failure Pathway]
            - AuthContext converts loading failure into an empty [] authorization state.
            - resolvePermission() loses organizational context.
            - Scoped UI components fail to load or render blocker banners.
```

- **CURRENT STATE:** AuthContext catches organizational-access loading failures and falls back to empty assignments/grants, converting access-loading failures into an empty authorization state.
- **REQUIRED STATE:** AuthContext must explicitly distinguish `loading`, `successfully loaded authorization`, and `authorization-loading error`, exposing the error state explicitly rather than silently converting failures into `[]` or retaining stale credentials.

---

## L. Leaderboard Authorization / Visibility

- **CURRENT STATE:** `getLeaderboard()` queries `collection(db, "users")` directly with `orderBy("points", "desc")`. Security rules restrict `/users/{userId}` to `isAdmin() || isOwner(userId)`, causing permission errors for non-admins.
- **RECOMMENDED PHASE 3 PROPOSAL:** Create a lightweight public projection collection (`/leaderboard_public`), updated via background triggers or write batches, containing non-sensitive user fields (`user_id`, `display_name`, `avatar_url`, `points`, `rank`, `tenant_id`), with security rule `allow read: if isSignedIn()`.

---

## M. Campaign Activities Authorization

- **PRODUCT REQUIREMENT:** Admins have global administrative authority to create and manage activities.
- **CURRENT RULE STATE:** Line 875 of `firestore.rules` evaluates `hasAccess("create_activity", scope_type, scope_id)` on `allow create`, lacking an `isAdmin()` bypass.
- **GAP:** Admins without explicit `/user_access` index records are rejected when creating activities in Firestore.

---

## N. Campaign Member Directory Authorization

- Admin users access member directory globally via `getAllCampaignMembersForTenant(tenantId)`.
- Campaign Coordinators access member list scoped to their assigned geographic area and subordinate locations.

---

## O. Field Reports and Issues Authorization

- Field reports and issues support submission by authorized campaign members for their registered location or assigned scope.
- Review and status management are restricted to users with assigned supervisory permissions or Admin roles.

---

## P. Tasks and Leaderboard Behavior

- Tasks are visible to social members (`status == "active"`).
- Member submissions are private to the submitter and Admin reviewers (`/task_submissions`).

---

## Q. Known Source / Rule / Query Mismatches

1. **Delete Rules:** Delete rules across multiple collections evaluate `request.resource.data.tenant_id` (`null` on delete).
2. **Activity Create Rule:** `campaign_activities` create rule lacks `isAdmin()` bypass.
3. **Tenant Query Filters:** Organizational assignment, permission grant, and campaign member directory queries omit `tenant_id` constraints.
4. **Leaderboard Service:** Service queries private `/users` collection directly.

---

## R. Confirmed vs. Suspected Runtime Causes

| Observed Symptom | Source / Rule Defect | Confirmed Runtime Cause | Suspected / Contributing Factor |
| ---------------- | -------------------- | ----------------------- | ------------------------------- |
| **Unable to load leaderboard** | Service queries `/users` directly | ✅ Confirmed (Query on `/users` rejected by rule) | None |
| **Unable to delete assignment** | Rule evaluates `request.resource.data` | ✅ Confirmed (`request.resource` is null on delete) | None |
| **Admin cannot create activity** | Rule lacks `isAdmin()` bypass | ✅ Confirmed (Admin lacks `/user_access` index) | None |
| **Failed to load organizational access** | Query omits `tenant_id` | ✅ Confirmed (Query/rule tenant mismatch or index issue) | `AuthContext` catch converting error to `[]` |

---

## S. Phase 3 Implementation Requirements

### Requirement 1: Security Rules Delete Anti-Pattern Fix
- **CURRENT STATE:** Rules evaluate `request.resource.data.tenant_id` on delete.
- **REQUIRED STATE:** Evaluate `resource.data.tenant_id` on delete.
- **WHY:** `request.resource` is null during deletion operations.
- **AFFECTED FILES:** `firestore.rules`.
- **SECURITY IMPLICATION:** Prevents deletion crashes while maintaining tenant isolation.
- **TEST REQUIREMENT:** Unit test deleting an assignment as Admin.

### Requirement 2: Admin Activity Creation Rule Bypass
- **CURRENT STATE:** Activity creation requires `hasAccess("create_activity", ...)`.
- **REQUIRED STATE:** Allow creation if `isAdmin() || hasAccess("create_activity", ...)`.
- **WHY:** Admins must have global operational access without explicit assignment documents.
- **AFFECTED FILES:** `firestore.rules`.
- **SECURITY IMPLICATION:** Restores intended Admin administrative capability.
- **TEST REQUIREMENT:** Verify Admin activity creation succeeds.

### Requirement 3: Tenant Query Filter Alignment
- **CURRENT STATE:** Organizational access and campaign member directory queries omit `tenant_id` filters.
- **REQUIRED STATE:** Include `where("tenant_id", "==", tenantId)` in queries.
- **WHY:** Ensures query alignment with tenant-scoped security rules.
- **AFFECTED FILES:** `src/lib/firebase/organization.ts`, `organizationalAssignments.ts`, `permissionGrants.ts`, `campaignMembers.ts`.
- **SECURITY IMPLICATION:** Strictly enforces multi-tenant boundary.
- **TEST REQUIREMENT:** Verify queries pass tenant ID parameter.

### Requirement 4: AuthContext Error Handling Resilience
- **CURRENT STATE:** Access fetch failure silently resets state to `assignments = []` and `grants = []`.
- **REQUIRED STATE:** AuthContext must explicitly distinguish `loading`, `successfully loaded authorization`, and `authorization-loading error`, exposing error state explicitly without fabricating authorization or retaining stale credentials.
- **WHY:** Prevents silent conversion of access-loading failures into empty authorization states.
- **AFFECTED FILES:** `src/contexts/AuthContext.tsx`.
- **SECURITY IMPLICATION:** Ensures accurate, explicit authorization state reporting.
- **TEST REQUIREMENT:** Test AuthContext error boundaries.

### Requirement 5: Leaderboard Projection Collection
- **CURRENT STATE:** Leaderboard queries `/users` directly.
- **REQUIRED STATE:** Query `/leaderboard_public` projection collection.
- **WHY:** Exposes point rankings without leaking private user profile fields.
- **AFFECTED FILES:** `src/lib/firebase/firestore.ts`, `firestore.rules`.
- **SECURITY IMPLICATION:** Protects user PII (emails, phone numbers).
- **TEST REQUIREMENT:** Verify non-admin user can fetch leaderboard.

---

## T. Items That MUST NOT Be Redesigned

1. **Five Authorization Layers:** `access_role`, `membership_type`, `OrganizationalAssignment`, `PermissionGrant`, and `user_access` must remain distinct layers.
2. **Multi-Contest Election Structure:** Tenant → Cycle → Contest → Result schema must remain intact.
3. **Admin Correction Workflow:** Corrections must set `status = "pending_review"` and `verified = false`.
4. **Private Candidate Donation Ledger:** Must remain a private, offline contribution record system.
5. **Permanently Removed Modules:** Campaign Communications, Campaign Documents, and Campaign Calendar must NOT be restored.
