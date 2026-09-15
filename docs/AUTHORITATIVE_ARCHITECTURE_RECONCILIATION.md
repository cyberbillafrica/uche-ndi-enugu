# Politicore / Ifeanyi 2027 — Phase 2.2: Final Authoritative Architecture Reconciliation Specification

---

## A. Executive Architecture Summary

This document serves as the governing architecture reconciliation specification for the Politicore Campaign Management & Multi-Contest Electoral Platform (`ifeanyi-4-nkanu`). It synthesizes established product requirements, current Next.js/React application code, and Cloud Firestore Security Rules (`firestore.rules`).

### Key Architectural Findings & Discrepancies
1. **Leaderboard Query vs. Privacy Rule Lockout:** The client function `getLeaderboard()` queries `collection(db, "users")` directly with `orderBy("points", "desc")`. However, `firestore.rules` restricts `/users/{userId}` reads strictly to `isAdmin() || isOwner(userId)`. Consequently, non-admin users trigger permission errors when loading the leaderboard.
2. **Organizational Hierarchy vs. Flat Security Rules (`hasAccess` / `user_access`):** Client-side permissions helpers (`src/lib/permissions.ts`) dynamically expand organizational scopes (State → Zone → LGA → Ward → PU). In contrast, `firestore.rules` evaluates scoped permissions via an exact document lookup on `/user_access/${permission}__${scopeType}__${scopeId}`. Higher-level coordinators (e.g. Ward or LGA Coordinators) are rejected by security rules when attempting to access resources scoped to descendant Wards/PUs unless explicit `user_access` index records exist for those descendant scopes or rules evaluate hierarchy.
3. **Delete Rules `request.resource` Anti-Pattern:** Security rules for document deletions in collections such as `organizational_assignments`, `permission_grants`, `donations`, and `campaign_activities` evaluate `request.resource.data.tenant_id`. In Cloud Firestore Security Rules, `request.resource` is `null` during `delete` operations, causing permission evaluation errors.
4. **AuthContext Error Handling State Conflation:** When an error occurs during `getUserOrganizationalAssignments()` or `getUserPermissionGrants()`, `AuthContext.tsx` catches the exception and resets `assignments` and `grants` to empty arrays (`[]`). This conflates "permissions failed to load" with "no permissions assigned", leading downstream resolvers to lose organizational context.
5. **Tenant Filter Omissions in Read Services:** Client query functions `getUserOrganizationalAssignments()`, `getUserPermissionGrants()`, `getOrganizationalAssignmentsByUserId()`, `getPermissionGrantsByUserId()`, and `getAllCampaignMembersForTenant()` accept or possess tenant parameters but omit `where("tenant_id", "==", tenantId)` in their actual Firestore query constraints.

---

## B. Identity and Membership Model

```text
IDENTITY
└── Firebase Authentication / UID

PROFILE & MEMBERSHIP
├── User Profile
├── access_role (System Capabilities: admin, member, election_officer)
└── membership_types (social_member, campaign_member)

ORGANIZATIONAL CONTEXT
├── OrganizationalAssignment (State, Zone, LGA, Ward Coordinators, Campaign Manager, Council Chairman)
└── Registered Ward / Polling Unit Location

EXPLICIT AUTHORIZATION
└── PermissionGrant (Explicit grant or denial records)

SECURITY-RULE ENFORCEMENT REPRESENTATION
└── Materialized user_access Index Records (Lookup documents used by Firestore security rules)
```

1. **IDENTITY:** Established via Firebase Auth (`User.uid`). Profile documents are persisted in `/users/{userId}`.
2. **PROFILE & MEMBERSHIP:**
   - `access_role`: Represents system/application capability (`admin`, `member`, `election_officer`, `tenant_super_admin`, `platform_super_admin`).
   - `membership_types`:
     - `social_member`: Access to social media tasks, point earning, public campaign feed, and leaderboard.
     - `campaign_member`: Category for campaign council features (Area, Members, Activities, Assignments, Reports, Issues) and location-scoped election reporting.
     - **Dual Membership:** Users may possess both `social_member` and `campaign_member` types. In `src/app/portal/dashboard/page.tsx`, dual-membership users can toggle between Social and Campaign views.
3. **RELATIONSHIP TO AUTHORIZATION:** Membership type alone does NOT grant organizational authority, unrestricted election access, or administrative capability. Membership type is an eligible product category, not an unrestricted authorization bypass.

---

## C. Access Roles vs. OrganizationalAssignment

| Concept | Purpose | Example Values | Storage Location |
| ------- | ------- | -------------- | ---------------- |
| `access_role` | Application/System capability | `admin`, `member`, `election_officer`, `tenant_super_admin` | `users/{userId}.access_role` |
| `OrganizationalAssignment` | Appointed leadership position in campaign hierarchy | `ward_coordinator`, `lga_coordinator`, `zone_coordinator`, `state_coordinator`, `campaign_manager`, `council_chairman` | `/organizational_assignments/{id}` |

- **CURRENT IMPLEMENTATION:** `src/types/index.ts` and `src/lib/permissions.ts` maintain `Role` separate from `OrganizationalPosition`.
- **PRODUCT REQUIREMENT:** Organizational positions (e.g. Ward Coordinator, LGA Coordinator, Campaign Manager) must NEVER be saved into `access_role`.
- **ADMIN INDEPENDENCE:** Admins possess system-wide administrative capabilities and do NOT require an `OrganizationalAssignment` to perform administrative operations across the tenant.

---

## D. PermissionGrant vs. Materialized `user_access`

- **PermissionGrant:** Administrative document stored in `/permission_grants/{grantId}` defining explicit grants or denials (`granted: true | false`).
- **Materialized `user_access` Index:** `user_access` is NOT an independent authorization source equivalent to `PermissionGrant`. It is a security-rule enforcement lookup representation created atomically in `/user_access/${permission}__${scopeType}__${scopeId}` via Firestore `writeBatch` when a `PermissionGrant` is created or updated. Enables single-document `exists()` checks in `firestore.rules`.

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

- **PRODUCT REQUIREMENT:** A user's authorized organizational scope must be capable of covering appropriate descendant locations where permission policy allows (State → Zone/LGA/Ward/PU; Zone → LGA/Ward/PU; LGA → Ward/PU; Ward → PU).
- **CURRENT IMPLEMENTATION:**
  - Client-side resolver (`src/lib/permissions.ts`) implements scope expansion via `assignmentCoversScope()` and `isScopeDescendant()`.
  - Security rules (`firestore.rules`) perform exact string match checks on `/user_access/${permission}__${scopeType}__${scopeId}` without expanding parent scopes.
- **ARCHITECTURAL GAP:** Higher-level coordinators (e.g. Ward or LGA Coordinators) are rejected by security rules when accessing descendant resources unless explicit `/user_access` index records exist for those descendant scopes.
- **PHASE 3 REQUIREMENT:** Phase 3 must select the **least-invasive, secure mechanism compatible with the existing architecture** (e.g. writing descendant index entries or rule helpers). Do not create a parallel authorization framework or redesign the core abstractions.

---

## F. Registered Location Model

- **PRODUCT REQUIREMENT & CONCEPT:**
  - Captured on `user.profile` as `ward_id` and `polling_unit_id`.
  - Identifies where a campaign member is registered to vote.
  - Provides self-service election result uploads, field report submissions, and incident reporting for that specific registered location.
  - Registered Ward/PU location remains strictly distinct from an `OrganizationalAssignment` and does NOT grant leadership or coordinator authority over other members.
- **CURRENT IMPLEMENTATION:** `src/lib/permissions.ts` and `firestore.rules` (`registeredAt()`) evaluate registered PU for field result uploads.

---

## G. Election Authorization Matrix & Distinct Paths

### Five Independent Authorization Paths
The platform enforces five distinct, non-interchangeable Election authorization paths:
1. **Registered-location authorization:** Registered Ward/PU (`profile.ward_id`, `profile.polling_unit_id`).
2. **Organizational authorization:** `OrganizationalAssignment` scope plus permitted descendants according to hierarchy policy.
3. **Explicit authorization:** `PermissionGrant` / corresponding `user_access` enforcement representation.
4. **Election Officer:** Tenant-wide global authority **within the Election domain** (submission management, review, verification, approval across all PUs). Does NOT grant access to Social Member, Campaign Member, or other application domains.
5. **Admin:** Global administrative capability across the tenant.

| Capability | Social-only Member | Campaign Member | Election Officer | Admin |
| ---------- | ------------------ | --------------- | ---------------- | ----- |
| **Election Module Access** | ⛔ Denied | Eligible only when the applicable Election permission and scope conditions are satisfied. | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **View Election Results** | ⛔ Denied | Eligible only when the applicable Election permission and scope conditions are satisfied. | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **Upload PU Election Result** | ⛔ Denied | Eligible only when the applicable Election permission and scope conditions are satisfied (Registered PU or grant). | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **Submit Election Incident** | ⛔ Denied | Eligible only when the applicable Election permission and scope conditions are satisfied (Registered PU or grant). | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **Submit PU Field Report** | ⛔ Denied | Eligible only when the applicable Election permission and scope conditions are satisfied (Registered PU or grant). | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **Election Operations Desk Review** | ⛔ Denied | ⛔ Denied | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **Result Verification & Approval** | ⛔ Denied | ⛔ Denied | ✅ Allowed (Tenant-Wide Election Domain) | ✅ Allowed (Global Admin) |
| **Admin Result Correction** | ⛔ Denied | ⛔ Denied | ⛔ Denied | ✅ Allowed (Global Admin; forces `status = "pending_review"`) |

---

## H. Election Result Visibility Matrix

| User Category | Viewing Authority | Scope Boundaries |
| ------------- | ----------------- | ---------------- |
| **Social-only Member** | ⛔ Denied | None (Blocked at routing and database boundaries) |
| **Campaign Member (Registered Location)** | ✅ Allowed | Restricted to results matching registered Ward/PU (`profile.ward_id`, `profile.polling_unit_id`) |
| **Campaign Member (With Assignment)** | ✅ Allowed | Scoped to assigned geographic area and subordinate descendants per hierarchy policy |
| **Election Officer** | ✅ Allowed | Tenant-wide global result visibility within Election domain |
| **Admin** | ✅ Allowed | Tenant-wide global administrative result visibility |
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

- **CURRENT IMPLEMENTATION:**
  - `correctElectionResult()` in `src/lib/firebase/election.ts` updates votes and explicitly sets `status = "pending_review"` and `verified = false`.
  - `adminCorrectionUpdate()` helper in `firestore.rules` enforces immutable identity keys and allowed fields.
- **PRODUCT REQUIREMENT:** Any Admin correction MUST force the result back to `status = "pending_review"` and `verified = false`, requiring subsequent independent Election Officer review/verification.
- **REQUIRED IMPLEMENTATION:** Verify in Phase 3 that `adminCorrectionUpdate()` in `firestore.rules` explicitly validates `request.resource.data.status == "pending_review" && request.resource.data.verified == false` across all update paths.

---

## J. Tenant Isolation & Query Reconciliation

### Refined Tenant-Query Principle
**Tenant-scoped collection queries must explicitly constrain the tenant where the collection/schema requires it, and query shape must remain compatible with the corresponding Firestore security rules.**

| Query Function | File Path | Current Source Query | Includes `tenant_id` Filter? | Firestore Rule Expectation | Defect / Compatibility Status |
| -------------- | --------- | -------------------- | ---------------------------- | -------------------------- | ----------------------------- |
| `getUserOrganizationalAssignments` | `src/lib/firebase/organization.ts` | `where("user_id", "==", userId)` | ❌ No | `resource.data.tenant_id == callerTenantId()` | Source query defect (omits required tenant filter) |
| `getUserPermissionGrants` | `src/lib/firebase/organization.ts` | `where("user_id", "==", userId)` | ❌ No | `resource.data.tenant_id == callerTenantId()` | Source query defect (omits required tenant filter) |
| `getOrganizationalAssignmentsByUserId` | `src/lib/firebase/organizationalAssignments.ts` | `where("user_id", "==", userId)` | ❌ No | `resource.data.tenant_id == callerTenantId()` | Source query defect (omits required tenant filter) |
| `getPermissionGrantsByUserId` | `src/lib/firebase/permissionGrants.ts` | `where("user_id", "==", userId)` | ❌ No | `resource.data.tenant_id == callerTenantId()` | Source query defect (omits required tenant filter) |
| `getAllCampaignMembersForTenant` | `src/lib/firebase/campaignMembers.ts` | `where("membership_types", "array-contains", "campaign_member")` | ❌ No | `resource.data.tenant_id == callerTenantId()` | Source query defect (function accepts `tenantId` parameter but query omits `where("tenant_id", "==", tenantId)`) |

---

## K. AuthContext Authorization Flow

```text
Firebase Auth State Change
       │
       ▼
Fetch User Profile (`getUserProfile`)
       │
       ▼
Fetch Organizational Access (`getUserOrganizationalAssignments` & `getUserPermissionGrants`)
       │
       ├─► SUCCESS: Set active assignments & permission grants; accessLoading = false.
       │
       └─► CATCH ERROR: Log error; set assignments = [], grants = []; accessLoading = false.
                               │
                               ▼
            [Conflation & Cascading Failure Pathway]
            - AuthContext converts "permissions failed to load" into "no permissions assigned" ([]).
            - resolvePermission() loses organizational context.
            - Scoped UI components fail to load or render blocker banners.
```

- **CURRENT IMPLEMENTATION:** `AuthContext.tsx` catches organizational-access loading failures and falls back to empty arrays (`assignments = []`, `grants = []`), silently converting an access-loading failure into an empty authorization state.
- **PRODUCT REQUIREMENT:** "No permissions" and "permissions failed to load" are distinct states. AuthContext must fail closed but explicitly distinguish:
  1. `loading`
  2. `successfully loaded authorization state`
  3. `authorization-loading error`
- **REQUIRED IMPLEMENTATION:** Expose authorization-loading error/state explicitly to the application rather than silently setting empty authorization arrays or fabricating access. Protected operations must fail closed without retaining stale authorization credentials.

---

## L. Leaderboard Authorization / Visibility

- **CURRENT IMPLEMENTATION:** `getLeaderboard()` queries `collection(db, "users")` directly with `orderBy("points", "desc")`. `firestore.rules` restricts `/users/{userId}` to `isAdmin() || isOwner(userId)`. Non-admin users trigger permission errors.
- **PRODUCT REQUIREMENT:** Ordinary Social Members must be able to view leaderboard rankings without exposing private user profile data (emails, phone numbers).
- **RECOMMENDED PHASE 3 PROPOSAL:** Maintain a lightweight public projection collection (`/leaderboard_public`), updated via background triggers or write batches, containing non-sensitive user fields (`user_id`, `display_name`, `avatar_url`, `points`, `rank`, `tenant_id`), with security rule `allow read: if isSignedIn()`. Do not implement or alter data during Phase 2.

---

## M. Campaign Activities Authorization

- **PRODUCT REQUIREMENT:** Admins have global administrative authority to manage and create campaign activities across the tenant.
- **CURRENT FIRESTORE RULE:** Line 875 of `firestore.rules` evaluates `hasAccess("create_activity", scope_type, scope_id)` on `allow create`, lacking an `isAdmin()` bypass.
- **GAP:** Admins without explicit `/user_access` index records are rejected when creating activities in Firestore.

---

## N. Campaign Member Directory Authorization

- **Admin Users:** Access tenant-wide member directory globally via `getAllCampaignMembersForTenant(tenantId)`.
- **Campaign Coordinators:** Access member list scoped to their assigned geographic area and subordinate locations per hierarchy policy.

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

## R. Confirmed Defects vs. Runtime Symptom Classifications

| Observed Symptom | Confirmed Defect Type | Confirmed Query / Rule Incompatibility | Likely Contributor / Cascading Factor | Isolated Runtime Root Cause |
| ---------------- | --------------------- | --------------------------------------- | ------------------------------------- | --------------------------- |
| **Unable to load leaderboard** | Service query defect | ✅ Confirmed (`/users` read blocked by rules) | None | Querying `/users` rejected by rules |
| **Unable to delete assignment** | Security rule defect | ✅ Confirmed (`request.resource` is null on delete) | None | Delete rule evaluates `request.resource.data` |
| **Admin cannot create activity** | Security rule defect | ✅ Confirmed (Admin lacks `create_activity` `/user_access` index) | None | Activity rule lacks `isAdmin()` bypass |
| **Failed to load organizational access** | Source query defect | ✅ Confirmed (Query omits `tenant_id` filter required by rules) | `AuthContext` catch converting error to `[]` | Query/rule tenant mismatch or index issue |
| **Scoped module access failures** | Architectural rule gap | ✅ Confirmed (Rule checks flat `/user_access` without hierarchy expansion) | `AuthContext` error conversion to `[]` | Combination of flat rule checks & AuthContext error state |

---

## S. Phase 3 Implementation Requirements

### Requirement 1: Security Rules Delete Anti-Pattern Fix
- **CURRENT IMPLEMENTATION:** Rules evaluate `request.resource.data.tenant_id` on delete.
- **PRODUCT REQUIREMENT:** Delete rules must accurately evaluate existing document tenant ID.
- **REQUIRED IMPLEMENTATION:** Evaluate `resource.data.tenant_id` on delete.
- **AFFECTED FILES:** `firestore.rules`.
- **SECURITY IMPLICATION:** Prevents deletion crashes while maintaining tenant isolation.
- **TEST REQUIREMENT:** Unit test deleting an assignment as Admin.

### Requirement 2: Admin Activity Creation Rule Bypass
- **CURRENT IMPLEMENTATION:** Activity creation requires `hasAccess("create_activity", ...)`.
- **PRODUCT REQUIREMENT:** Admins have global activity creation authority.
- **REQUIRED IMPLEMENTATION:** Allow creation if `isAdmin() || hasAccess("create_activity", ...)`.
- **AFFECTED FILES:** `firestore.rules`.
- **SECURITY IMPLICATION:** Restores intended Admin administrative capability.
- **TEST REQUIREMENT:** Verify Admin activity creation succeeds.

### Requirement 3: Tenant Query Filter Alignment
- **CURRENT IMPLEMENTATION:** Organizational access and campaign member directory queries omit `tenant_id` filters.
- **PRODUCT REQUIREMENT:** All tenant-scoped collection queries must explicitly constrain the tenant where the schema requires it.
- **REQUIRED IMPLEMENTATION:** Include `where("tenant_id", "==", tenantId)` in queries.
- **AFFECTED FILES:** `src/lib/firebase/organization.ts`, `organizationalAssignments.ts`, `permissionGrants.ts`, `campaignMembers.ts`.
- **SECURITY IMPLICATION:** Strictly enforces multi-tenant boundary.
- **TEST REQUIREMENT:** Verify queries pass tenant ID parameter.

### Requirement 4: AuthContext Error Handling Resilience
- **CURRENT IMPLEMENTATION:** Access fetch failure silently resets state to `assignments = []` and `grants = []`.
- **PRODUCT REQUIREMENT:** AuthContext must fail closed but explicitly distinguish `loading`, `successfully loaded authorization`, and `authorization-loading error`.
- **REQUIRED IMPLEMENTATION:** Expose authorization-loading error/state explicitly without fabricating permissions or retaining stale credentials.
- **AFFECTED FILES:** `src/contexts/AuthContext.tsx`.
- **SECURITY IMPLICATION:** Ensures accurate, explicit authorization state reporting without silent failure pathways.
- **TEST REQUIREMENT:** Test AuthContext error boundaries.

### Requirement 5: Leaderboard Projection Collection
- **CURRENT IMPLEMENTATION:** Leaderboard queries `/users` directly.
- **PRODUCT REQUIREMENT:** Social members view leaderboard without accessing private profile fields.
- **REQUIRED IMPLEMENTATION:** Query `/leaderboard_public` projection collection.
- **AFFECTED FILES:** `src/lib/firebase/firestore.ts`, `firestore.rules`.
- **SECURITY IMPLICATION:** Protects user PII (emails, phone numbers).
- **TEST REQUIREMENT:** Verify non-admin user can fetch leaderboard.

---

## T. Items That MUST NOT Be Redesigned

1. **Settled Role Boundaries:** `access_role` is not an organizational position. Positions (Ward Coordinator, LGA Coordinator, Zone Coordinator, State Coordinator, Campaign Manager, Council Chairman) remain in `OrganizationalAssignment`.
2. **Settled Membership Boundaries:** Membership type (`campaign_member`, `social_member`) does not itself grant unrestricted authority. Social-only members have NO Election module access.
3. **Settled Election Officer Boundaries:** Election Officer has tenant-wide global authority **within the Election domain** (submissions, review, verification, approval across all PUs), but does NOT have global application authority or access to Social/Campaign Member domains.
4. **Settled Registered Location Boundaries:** Registered Ward/PU is strictly distinct from `OrganizationalAssignment`.
5. **Multi-Contest Election Structure:** Tenant → Cycle → Contest → Result schema must remain intact.
6. **Admin Correction Workflow:** Corrections must set `status = "pending_review"` and `verified = false`.
7. **Private Candidate Donation Ledger:** Must remain a private, offline contribution record system.
8. **Permanently Removed Modules:** Campaign Communications, Campaign Documents, and Campaign Calendar must NOT be restored.
9. **No Parallel Frameworks:** No second parallel authorization framework or new abstractions are to be introduced.
