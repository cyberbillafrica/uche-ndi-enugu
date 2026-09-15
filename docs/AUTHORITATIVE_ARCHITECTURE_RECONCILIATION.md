# Politicore / Ifeanyi 2027 — Phase 2: Authoritative Architecture Reconciliation

## 1. Executive Summary

This report performs a comprehensive reconciliation of product requirements, documentation claims, current Next.js/TypeScript application code, and Cloud Firestore Security Rules (`firestore.rules`).

---

# PHASE 2.1 CORRECTIONS

## 1. Distinction Framework

To avoid conflating desired architecture with current implementation, every key section evaluates features across five distinct categories:

1. **PRODUCT REQUIREMENT:** Authoritative specification or product rule.
2. **CURRENT DOCUMENTATION:** What `.md` files claim.
3. **CURRENT SOURCE CODE:** What TypeScript files in `src/` actually execute.
4. **CURRENT FIRESTORE RULE:** What rules in `firestore.rules` enforce.
5. **INTENDED CORRECT IMPLEMENTATION:** Target architecture required after Phase 3.

---

## 2. AuthContext Cascading Authorization Failure

### Analysis of Current Implementation (`src/contexts/AuthContext.tsx`)

In `AuthContext.tsx`, lines 250–290 wrap the organizational access fetch in a `try/catch` block:

```tsx
try {
  const [organizationalAssignments, permissionGrants] = await Promise.all([
    getUserOrganizationalAssignments(firebaseUser.uid),
    getUserPermissionGrants(firebaseUser.uid),
  ]);
  setAssignments(getActiveAssignments(organizationalAssignments));
  setGrants(permissionGrants);
} catch (accessError) {
  console.error("Failed to load organizational access:", accessError);
  if (!cancelled) {
    setAssignments([]);
    setGrants([]);
  }
}
```

### Impact & Cascading Failure Path
- **PRODUCT REQUIREMENT:** Failure to fetch organizational assignments/grants should be handled gracefully or retried without silently stripping an active coordinator's authority.
- **CURRENT SOURCE CODE:** If an index or network error occurs during `getUserOrganizationalAssignments()` or `getUserPermissionGrants()`, the catch block executes and resets `assignments` and `grants` to empty arrays `[]`.
- **CURRENT FIRESTORE RULE:** Security rules for scoped collections evaluate `hasAccess()` against `/user_access`.
- **CASCADING IMPACT:**
  1. Access query fails or throws an error.
  2. `AuthContext` silently sets `assignments = []` and `grants = []`.
  3. `resolvePermission()` returns `false` for all scoped checks.
  4. Scoped UI components (e.g. Campaign Area, Members, Activities, Reports, Issues) render access blocker banners ("No organizational scope assigned").
  5. User is locked out of valid operational capabilities despite holding valid Firestore assignment records.

---

## 3. Tenant Query Mismatches in Organizational Services

### Source Verification

- `src/lib/firebase/organization.ts`:
  - `getUserOrganizationalAssignments(userId)` queries `collection(db, "organizational_assignments")` filtering ONLY by `where("user_id", "==", userId)`.
  - `getUserPermissionGrants(userId)` queries `collection(db, "permission_grants")` filtering ONLY by `where("user_id", "==", userId)`.
- `src/lib/firebase/organizationalAssignments.ts`:
  - `getOrganizationalAssignmentsByUserId(userId)` queries `where("user_id", "==", userId)` without `where("tenant_id", "==", tenantId)`.
- `src/lib/firebase/permissionGrants.ts`:
  - `getPermissionGrantsByUserId(userId)` queries `where("user_id", "==", userId)` without `where("tenant_id", "==", tenantId)`.

### Reconciliation
- **PRODUCT REQUIREMENT:** All database reads for tenant-scoped collections must include `tenant_id` filtering for strict tenant isolation.
- **CURRENT DOCUMENTATION:** Claimed all queries were tenant-scoped.
- **CURRENT SOURCE CODE:** Queries filter by `user_id` only, omitting `tenant_id` constraints.
- **CURRENT FIRESTORE RULE:** Rules require `resource.data.tenant_id == callerTenantId()`.
- **INTENDED CORRECT IMPLEMENTATION:** Client queries must pass `tenantId` and include `where("tenant_id", "==", tenantId)`.

---

## 4. Admin Authorization & Rule Mismatches

### Feature-by-Feature Admin Access Reconciliation

1. **Campaign Activities (`/campaign_activities`):**
   - **PRODUCT REQUIREMENT:** Admin can create, read, update, and delete activities globally without requiring an organizational assignment.
   - **CURRENT SOURCE CODE:** `isAdminUser(profile)` bypasses permission checks in `src/lib/permissions.ts`.
   - **CURRENT FIRESTORE RULE:** Rule line 875 requires `hasAccess("create_activity", request.resource.data.scope_type, request.resource.data.scope_id)` for activity creation, with **NO Admin bypass** in the creation check.
   - **MISMATCH:** Firestore rules reject activity creation by Admins who lack explicit `/user_access` index records.

2. **Field Reports (`/campaign_field_reports`):**
   - **PRODUCT REQUIREMENT:** Admin has global read/update/delete authority.
   - **CURRENT SOURCE CODE:** Admin accesses globally without scope checks.
   - **CURRENT FIRESTORE RULE:** Rule line 950 permits Admin read/update/delete (`isAdmin()`).
   - **STATUS:** Matched for read/update/delete.

3. **Issues (`/issues`):**
   - **PRODUCT REQUIREMENT:** Admin has global access.
   - **CURRENT SOURCE CODE:** Admin accesses globally.
   - **CURRENT FIRESTORE RULE:** Rule line 1005 permits Admin read/update/delete (`isAdmin()`).
   - **STATUS:** Matched for read/update/delete.

---

## 5. Election Authorization Capability Matrix

| Capability | Current App Mechanism | Current Rule Mechanism | Product Requirement | Correct Final Mechanism |
| ---------- | --------------------- | ---------------------- | ------------------- | ----------------------- |
| **1. Access Election Route (`/portal/election`)** | Checks `membership_types.includes("campaign_member")` or `isAdmin()` | Navigation sidebar hides link from Social-only members | Scoped to permitted region or registered PU | Authenticated Campaign Member, Election Officer, or Admin |
| **2. View Election Results** | Aggregates results; non-admin members scoped to `profile.ward_id`/`polling_unit_id` | Scoped queries; rules check tenant & status | Authenticated users with valid organizational access view scope | Scoped organizational assignment + registered PU fallback |
| **3. Upload PU Result (`/portal/election/upload`)** | Requires uploader to select open contest & upload Form EC8 image | Rules check `status == "OPEN"` & uploader scope | Scoped upload for registered PU or officer | Registered PU (Campaign Member) or Election Officer/Admin grant |
| **4. Submit Incident (`/portal/election/incidents`)** | Checks uploader `polling_unit_id` | Rules check `polling_unit_id` matching uploader | Scoped incident reporting for registered PU | Registered PU (Campaign Member) or Election Officer/Admin grant |
| **5. Submit PU Report (`/portal/election/pu-reports`)** | Checks uploader `polling_unit_id` | Rules check `polling_unit_id` matching uploader | Scoped report submission for registered PU | Registered PU (Campaign Member) or Election Officer/Admin grant |
| **6. Election Officer Review (`/portal/election/operations`)** | Restricted to `role === "election_officer"` or `admin` | Rules check `isElectionOfficer()` (`role == 'election_officer' \|\| role == 'admin'`) | Broad operational authority | `access_role` (`election_officer` or `admin`) |
| **7. Result Verification** | Operations desk performs review decision (`approved`, `rejected`, etc.) | Rules enforce history logging & officer role | Broad operational authority | `access_role` (`election_officer` or `admin`) |
| **8. Admin Correction (`correctElectionResult`)** | Admin modifies vote counts; forces status to `pending_review` | Rules verify `isAdmin()` & force `verified = false` | Admin administrative correction | `access_role` (`admin`) forcing `pending_review` |

---

## 6. Registered Location vs. Organizational Assignment

### Explicit Separation

- **Registered Location (`profile.ward_id`, `profile.polling_unit_id`):**
  - Represents where a campaign member lives/votes.
  - Used strictly for self-service field operations: uploading Form EC8 election results for their own PU, reporting local incidents, and submitting local PU field reports.
  - Does **NOT** confer leadership or coordinator privileges over other members.
- **OrganizationalAssignment (`position`, `scope_type`, `scope_id`):**
  - Represents an appointed leadership role (e.g. Ward Coordinator, LGA Coordinator, State Coordinator).
  - Confers supervisory and operational authority over subordinate scopes and campaign council features.
  - Grants explicit permissions materialized into `/user_access`.

---

## 7. Hierarchy Reconciliation Across Architecture Layers

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Application Hierarchy Resolution (src/lib/permissions.ts)       │
│ - Uses assignmentCoversScope() & isScopeDescendant()                     │
│ - Dynamically expands State → Zone → LGA → Ward → Polling Unit            │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 2: user_access Document Index (src/lib/firebase/permissionGrants) │
│ - Writes exact keys: ${permission}__${scopeType}__${scopeId}             │
│ - Does NOT automatically write rows for subordinate descendant scopes    │
├─────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Firestore Security Rules (firestore.rules)                      │
│ - hasAccess() performs single doc exists() check on exact key            │
│ - Does NOT perform dynamic parent scope expansion or wildcard resolution │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hierarchy Breakdown Gaps
- **State Assignment:** App code grants authority over all 17 LGAs. Firestore rules check exact key `/user_access/view_activities__state__enugu-state`, failing checks for activities scoped to LGA or Ward IDs.
- **LGA Assignment:** App code grants authority over subordinate Wards & PUs. Firestore rules fail because no `/user_access/view_activities__lga__nkanu-west` index exists for Ward scope requests.

---

## 8. Leaderboard Architectural Options (Proposals vs. Facts)

### Problem
`getLeaderboard()` queries `collection(db, "users")`, which is blocked by `firestore.rules` (`allow read: if isAdmin() || isOwner(userId)`).

### Evaluated Proposals (No Code Implemented Yet)

1. **Proposal A: Public Leaderboard Collection (`/leaderboard_public`)**
   - Cloud Function or batch trigger syncs top users' non-sensitive fields (`user_id`, `display_name`, `avatar_url`, `points`, `rank`, `tenant_id`) into `/leaderboard_public`.
   - Security rule allows public read for signed-in users.
   - **Pros:** Maximum security; zero exposure of user emails/phone numbers.
2. **Proposal B: Field-Masked Rules or Sanitized User Queries**
   - Firestore security rules do not natively support column-level read masking.
   - **Cons:** Not natively supported in Firestore rules without subcollection projections.
3. **Proposal C: Secondary Projection Subcollection (`/users/{id}/public/profile`)**
   - Maintain a public subcollection under each user document.

**Decision:** Proposal A (`/leaderboard_public`) is the recommended architectural proposal for Phase 3.

---

## 9. Rebuilt Query/Rule Compatibility Matrix

| Collection | Actual Current Query (`src/`) | Actual Current Rule (`firestore.rules`) | Compatible? | Root Cause / Required Change |
| ---------- | ----------------------------- | --------------------------------------- | ----------- | ---------------------------- |
| `/users` (Leaderboard) | `query(collection(db, "users"), orderBy("points", "desc"), limit(50))` | `allow read: if isAdmin() \|\| isOwner(userId)` | ❌ No | Fails for non-admins; query public projection collection instead |
| `/organizational_assignments` | `query(collection(db, "organizational_assignments"), where("user_id", "==", userId))` | `allow read: if isAdmin() \|\| (resource.data.tenant_id == callerTenantId() && resource.data.user_id == request.auth.uid)` | ⚠️ Partial | Missing `tenant_id` filter in client query |
| `/permission_grants` | `query(collection(db, "permission_grants"), where("user_id", "==", userId))` | `allow read: if isAdmin() \|\| (resource.data.tenant_id == callerTenantId() && resource.data.user_id == request.auth.uid)` | ⚠️ Partial | Missing `tenant_id` filter in client query |
| `/campaign_activities` | `query(collection(db, "campaign_activities"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin() \|\| hasAccess("view_activities", scope_type, scope_id)` | ❌ No | Non-admin users fail when missing exact `user_access` index |
| `/campaign_activities` (Create) | `addDoc(collection(db, "campaign_activities"), data)` | `allow create: if hasAccess("create_activity", scope_type, scope_id)` | ❌ No | Admin lacks `isAdmin()` bypass in activity create rule |
| `/campaign_assignments` | `query(collection(db, "campaign_assignments"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin() \|\| hasAccess("view_assignments", scope_type, scope_id)` | ❌ No | Fails for coordinators assigned at higher hierarchy levels |
| `/campaign_field_reports` | `query(collection(db, "campaign_field_reports"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin() \|\| hasAccess("review_field_report", scope_type, scope_id)` | ❌ No | Scoped read fails without exact `user_access` index |
| `/issues` | `query(collection(db, "issues"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin() \|\| hasAccess("manage_issue", scope_type, scope_id)` | ❌ No | Scoped read fails without exact `user_access` index |
| `/tasks` | `query(collection(db, "tasks"), where("tenant_id", "==", tenantId), where("status", "==", "active"))` | `allow read: if isAdmin() \|\| (isSocialMember() && resource.data.status == "active")` | ✅ Yes | Matches |
| `/task_submissions` | `query(collection(db, "task_submissions"), where("tenant_id", "==", tenantId), where("user_id", "==", userId))` | `allow read: if isAdmin() \|\| (isSignedIn() && resource.data.user_id == request.auth.uid)` | ✅ Yes | Matches |
| `/donations` | `query(collection(db, "donations"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin()` | ✅ Yes | Private Admin ledger |
| `/election_results` | `query(collection(db, "election_results"), where("tenant_id", "==", tenantId), where("contest_id", "==", contestId))` | `allow read: if isSignedIn() && sameTenant(resource.data)` | ✅ Yes | Authenticated tenant users view contest results |

---

## 10. Functional Error Root Causes Matrix

| Observed Symptom | Immediate Failing Query/Action | Current Rule | Root Cause | Secondary / Cascading Cause | Required Implementation Area |
| ---------------- | ------------------------------ | ------------ | ---------- | --------------------------- | ---------------------------- |
| **Failed to load organizational access** | `getUserOrganizationalAssignments(uid)` | Requires tenant match | Query omits `tenant_id` constraint | `AuthContext` catches error and resets assignments to `[]` | Client query update (`organization.ts`) |
| **Failed to load your submissions** | `query(task_submissions)` | `resource.data.user_id == request.auth.uid` | Missing tenant filter or uid mismatch | UI displays fallback error | Client query update (`tasks/page.tsx`) |
| **Failed to load tasks** | `query(tasks)` | Requires `isSocialMember()` | User profile missing `social_member` tag | UI fails task load | Profile registration / rules update |
| **Failed to load PU scoped campaign members** | `getScopedCampaignMembers()` | Scoped user query | User collection read restricted to owner/admin | Hook cannot query member list across Wards | Scoped directory fetch service |
| **Failed to load organizational assignments** | `getOrganizationalAssignmentsByUserId()` | Tenant rule check | Client query omits `tenant_id` filter | UI shows empty assignment table | Service query update (`organizationalAssignments.ts`) |
| **Failed to load campaign assignments** | `query(campaign_assignments)` | `hasAccess("view_assignments", ...)` | Rules check exact `/user_access` key without hierarchy | Higher-level coordinator blocked | Security rules `hasAccess` update |
| **Failed to load campaign reports** | `query(campaign_field_reports)` | `hasAccess("review_field_report", ...)` | Rules check exact `/user_access` key without hierarchy | Higher-level coordinator blocked | Security rules `hasAccess` update |
| **Unable to load issues** | `query(issues)` | `hasAccess("manage_issue", ...)` | Rules check exact `/user_access` key without hierarchy | Higher-level coordinator blocked | Security rules `hasAccess` update |
| **Unable to load campaign coordination data** | `query(users)` / scoped query | Restricted `/users` read | Non-admin user cannot read user list | UI coordination view fails | Scoped member query utility |
| **Unable to update assignment** | `updateDoc(organizational_assignments)` | `isAdmin() && sameTenant()` | Admin missing tenant context in request payload | Update rejected | Update payload & rules validation |
| **Unable to delete assignment** | `deleteDoc(organizational_assignments)` | `allow delete: if isAdmin() && sameTenant(resource.data)` | Rule evaluated `request.resource.data` (`null` on delete) | Delete operation crashes rule engine | Firestore rules fix (`resource.data`) |
| **Unable to load leaderboard** | `query(users, orderBy("points"))` | `allow read: if isAdmin() \|\| isOwner(userId)` | Non-admin querying `/users` blocked by security rules | Unhandled permission error | Create `/leaderboard_public` collection & update service |
| **Admin cannot create activity** | `addDoc(campaign_activities)` | `allow create: if hasAccess("create_activity", ...)` | Activity create rule lacks `isAdmin()` bypass | Admin lacks explicit `/user_access` row | Add `isAdmin()` bypass to activity create rule |

---

## 11. Dependency-Checked Implementation Sequence for Phase 3

```text
Step 1: AuthContext / Organizational Access Foundation
  - Fix AuthContext error handling to prevent silent [] fallback.
  - Fix getUserOrganizationalAssignments() & getUserPermissionGrants() to include tenant_id.

Step 2: Security Rules Delete Anti-Pattern Fix
  - Replace request.resource.data.tenant_id with resource.data.tenant_id in all allow delete blocks.

Step 3: Security Rules Admin Bypass & Hierarchical Rule Helpers
  - Add explicit isAdmin() bypass to campaign_activities create rule.
  - Enhance hasAccess() helper in firestore.rules to support scope inheritance.

Step 4: Public Leaderboard Infrastructure
  - Create /leaderboard_public collection sync and update getLeaderboard() service.

Step 5: Scoped Feature Query & Rule Alignment
  - Update queries for campaign_activities, campaign_assignments, field_reports, issues, and tasks.

Step 6: Campaign Members & Coordination Scoped Directory Services
  - Implement tenant-aware scoped member directory queries.

Step 7: Election Operations & Operations Desk Verification
  - Validate role-based election officer and uploader scope boundaries.

Step 8: Automated Rules & End-to-End Verification
  - Execute npm run test and verify zero build/lint regressions.
```

---

# PHASE 2.1 FINAL STATUS

- **Current implementation accurately distinguished from intended architecture:** YES
- **AuthContext cascading failure identified:** YES
- **Tenant query mismatches accurately identified:** YES
- **Admin rule mismatches accurately identified:** YES
- **Election authorization separated by capability:** YES
- **Registered location separated from OrganizationalAssignment:** YES
- **Hierarchy layers accurately distinguished:** YES
- **Leaderboard solution treated as proposal rather than fact:** YES
- **Functional error root causes verified:** YES
- **Implementation sequence dependency-checked:** YES
