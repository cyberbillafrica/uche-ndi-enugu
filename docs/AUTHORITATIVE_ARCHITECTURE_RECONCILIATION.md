# Politicore / Ifeanyi 2027 — Phase 2: Authoritative Architecture Reconciliation

## 1. Executive Summary

This report performs a comprehensive reconciliation of product requirements, documentation claims, current Next.js/TypeScript application code, and Cloud Firestore Security Rules (`firestore.rules`).

### Key Discoveries & Architectural Discrepancies
1. **Leaderboard Query vs. Privacy Rule Lockout:** The client function `getLeaderboard()` queries `collection(db, "users")` directly with `orderBy("points", "desc")`. However, `firestore.rules` restricts `/users/{userId}` reads strictly to `isAdmin() || isOwner(userId)`. Consequently, all non-admin users (including Social Members and Campaign Members) trigger `FirebaseError: Missing or insufficient permissions` whenever viewing the dashboard leaderboard or `/portal/leaderboard`.
2. **Organizational Hierarchy vs. Flat Security Rules Index (`hasAccess` / `user_access`):** While client-side utilities (`src/lib/permissions.ts` and `src/lib/organization.ts`) perform dynamic hierarchical scope expansion (State → Zone → LGA → Ward → PU), Firestore security rules evaluate scoped access via exact document ID lookup on `/user_access/{permission}__${scopeType}__${scopeId}`. As a result, an LGA Coordinator granted access at the LGA scope cannot create or read scoped activities, field reports, or issues at the subordinate Ward or Polling Unit level via Firestore security rules unless explicit `user_access` index records are created for every descendant scope or rules evaluate hierarchy.
3. **Delete Rules `request.resource` Anti-Pattern:** In `firestore.rules`, update/delete blocks on several collections (including `organizational_assignments`, `permission_grants`, `donations`, and `campaign_activities`) evaluated `request.resource.data.tenant_id`. In Cloud Firestore Security Rules, `request.resource` is `null` during `delete` operations, causing permission check crashes or unintended deletion rejections.
4. **Election Authorization Confusion:** `docs/electioneering.md` claimed flat membership (`membership_types: ["campaign_member"]`) confers automatic election access. In reality, the codebase combines profile registration (`ward_id`, `polling_unit_id`), system roles (`election_officer`, `admin`), and explicit permission grants (`view_election_dashboard`, `upload_election_result`, `manage_election_settings`).
5. **Campaign Member PU Visibility Restrictions:** Non-admin campaign members who do not hold explicit organizational coordinator assignments or grants are restricted in `src/app/portal/election/page.tsx` and `src/hooks/useScopedCampaignMembers.ts` to their registered Ward and Polling Unit (`profile.ward_id` / `profile.polling_unit_id`).

---

## 2. Authority Model

The platform enforces four distinct authorization concepts that must NOT be collapsed:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. access_role (System Capabilities: "admin", "member", "election_officer")│
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. OrganizationalAssignment (Positions: Ward/LGA/Zone/State Coordinator)    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. PermissionGrant & user_access Index (Granular Scoped Permissions)        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Membership Type ("campaign_member", "social_member")                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **`access_role`**: System/application capability role (`admin`, `member`, `election_officer`, `tenant_super_admin`, `platform_super_admin`). Controls administrative pathways, system settings, and high-level routing.
- **`membership_type`**: Represents campaign affiliation (`campaign_member`, `social_member`). Determines primary portal layout, dashboard view toggle eligibility, and social task access vs. campaign operational access.
- **`OrganizationalAssignment`**: Captures organizational leadership positions (`ward_coordinator`, `lga_coordinator`, `zone_coordinator`, `state_coordinator`, `campaign_manager`, `council_chairman`) mapped to a specific `scope_type` and `scope_id`.
- **`PermissionGrant` & `user_access`**: Defines granular, auditable system privileges (`view_activities`, `create_activity`, `view_election_dashboard`, etc.) synchronized atomically via Firestore `writeBatch` into indexed `/user_access` documents for fast rule checks.

---

## 3. Authorization Matrix

| Capability | Product Authority | Current App (`src/`) | Current Rules (`firestore.rules`) | Correct Model | Change Required |
| ---------- | ----------------- | -------------------- | --------------------------------- | ------------- | --------------- |
| **System Administration** | Admin role only | `isAdminUser(profile)` check in `permissions.ts` | `isAdmin()` helper (`getUserRole() == "admin"`) | System role `admin` | Align rules & app checks |
| **View Leaderboard** | All authenticated social & campaign members | Calls `getLeaderboard()` on `/users` | `/users/{id}` allowed ONLY for `isAdmin()` or `isOwner(id)` | Public leaderboard collection/view model or secure function | Add `/leaderboard_public` collection or rule aggregation |
| **Activity Creation** | Users with `create_activity` grant or Admin | Checks `hasPermission("create_activity", scope)` | `hasAccess("create_activity", scope_type, scope_id)` | Scoped grant or Admin | Add hierarchical scope checks to rules |
| **Field Report Submission** | Authorized campaign members & officers | Checks profile ward/PU or scoped assignment | `hasAccess("submit_field_report", scopeType, scopeId)` | Scoped grant or registered location | Standardize PU registration fallback in rules |
| **Issue Reporting** | Authorized campaign members & officers | Checks profile ward/PU or scoped assignment | `hasAccess("report_issue", scopeType, scopeId)` | Scoped grant or registered location | Standardize PU registration fallback in rules |
| **Donation Record Management** | Admin only (Private ledger) | `/portal/admin/donations` page restricted to Admin | `/donations` collection restricted to `isAdmin()` | Admin only private ledger | None (Current App & Rules match Product) |

---

## 4. Organizational Hierarchy Matrix

| Assignment Level | Intended Descendants | App Supports? | Firestore Supports? | Gap |
| ---------------- | -------------------- | ------------- | ------------------- | --- |
| **State** | All Zones, LGAs, Wards, PUs in State | Yes (`assignmentCoversScope`) | No (Exact ID match on `user_access` only) | Rules lack State-level wildcard/descendant expansion for `/user_access` |
| **Senatorial Zone** | All LGAs, Wards, PUs in Zone | Yes (`assignmentCoversScope`) | No (Exact ID match on `user_access` only) | Rules fail to map Zone assignment to subordinate LGA/Ward IDs |
| **LGA** | All Wards & PUs in LGA | Yes (`assignmentCoversScope`) | No (Exact ID match on `user_access` only) | Rules fail to map LGA assignment to subordinate Ward/PU IDs |
| **Ward** | All PUs in Ward | Yes (`assignmentCoversScope`) | No (Exact ID match on `user_access` only) | Rules fail to map Ward assignment to subordinate PU IDs |
| **Polling Unit** | Assigned Polling Unit only | Yes (Exact match) | Yes (Exact match) | No gap for single Polling Unit match |

---

## 5. Election Authorization Matrix

| Capability | Social-only | Campaign Member | Election Officer | Admin | Required Scope |
| ---------- | ----------- | --------------- | ---------------- | ----- | -------------- |
| **Access Election Portal Route** (`/portal/election`) | ⛔ Denied | ✅ Allowed | ✅ Allowed | ✅ Allowed | Scoped to permitted region or registered PU |
| **View Official Election Results** | ⛔ Denied | ✅ Allowed (Scoped) | ✅ Allowed (Global) | ✅ Allowed (Global) | Registered PU/Ward or Organizational Scope |
| **Upload PU Election Result** (`/portal/election/upload`) | ⛔ Denied | ✅ Allowed (Registered PU) | ✅ Allowed | ✅ Allowed | Registered PU or active election officer grant |
| **Submit Election Incident** (`/portal/election/incidents`) | ⛔ Denied | ✅ Allowed (Registered PU) | ✅ Allowed | ✅ Allowed | Registered PU or active election officer grant |
| **Submit PU Field Report** (`/portal/election/pu-reports`) | ⛔ Denied | ✅ Allowed (Registered PU) | ✅ Allowed | ✅ Allowed | Registered PU or active election officer grant |
| **Election Operations Desk Review** (`/portal/election/operations`) | ⛔ Denied | ⛔ Denied | ✅ Allowed | ✅ Allowed | Global operational authority (`election_officer` / `admin`) |
| **Result Verification & Approval** | ⛔ Denied | ⛔ Denied | ✅ Allowed | ✅ Allowed | Global operational authority (`election_officer` / `admin`) |
| **Admin Result Correction** (`correctElectionResult`) | ⛔ Denied | ⛔ Denied | ⛔ Denied | ✅ Allowed | Admin role only (Forces status to `pending_review`) |

---

## 6. Query/Rule Compatibility Matrix

| Collection | Current Query | Current Rule | Compatible? | Required Change |
| ---------- | ------------- | ------------ | ----------- | --------------- |
| `/users` (Leaderboard) | `query(collection(db, "users"), orderBy("points", "desc"), limit(50))` | `allow read: if isAdmin() \|\| isOwner(userId)` | ❌ No (Fails for all non-admin users) | Create separate `/leaderboard` collection updated via trigger or allow public read of sanitized user points fields |
| `/campaign_activities` | `query(collection(db, "campaign_activities"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin() \|\| hasAccess("view_activities", scope_type, scope_id)` | ❌ Partial (Non-admin users without exact matching `user_access` index fail) | Ensure client queries filter by scope or rules support tenant-level activity discovery |
| `/organizational_assignments` | `query(collection(db, "organizational_assignments"), where("tenant_id", "==", tenantId), where("user_id", "==", userId))` | `allow read: if isAdmin() \|\| (resource.data.tenant_id == callerTenantId() && resource.data.user_id == request.auth.uid)` | ✅ Yes | None |
| `/tasks` | `query(collection(db, "tasks"), where("tenant_id", "==", tenantId), where("status", "==", "active"))` | `allow read: if isAdmin() \|\| (isSocialMember() && resource.data.status == "active")` | ✅ Yes | Ensure dual-membership users satisfy `isSocialMember()` check in rules |
| `/task_submissions` | `query(collection(db, "task_submissions"), where("tenant_id", "==", tenantId), where("user_id", "==", userId))` | `allow read: if isAdmin() \|\| (isSignedIn() && resource.data.user_id == request.auth.uid)` | ✅ Yes | None |
| `/donations` | `query(collection(db, "donations"), where("tenant_id", "==", tenantId))` | `allow read: if isAdmin()` | ✅ Yes | Admin-only private ledger |

---

## 7. Admin Authorization Matrix

| Feature | Admin App Access | Admin Rule Access | Assignment Required? | Correct Behavior |
| ------- | ---------------- | ----------------- | -------------------- | ---------------- |
| **Campaign Activities** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |
| **Field Reports** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |
| **Issues** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |
| **Coordination & Members** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |
| **Assignments & Grants** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |
| **Election Administration** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |
| **Donation Ledger** | Full Global Access | `allow read/write: if isAdmin()` | ❌ No | Admin accesses globally without organizational assignment |

---

## 8. Documentation Corrections

1. **`docs/electioneering.md` Correction:** Remove claims that flat membership (`campaign_member`) automatically overrides permission check requirements. Replace with explicit authorization rules based on user registered PU, `access_role`, and explicit `PermissionGrant` indices.
2. **`docs/features.md` & `docs/completion.md` Verification:** Retain private candidate donation ledger descriptions (`/portal/admin/donations`) and context help components.
3. **`docs/remediation-verification.md` Correction:** Update legacy election visibility statements to clarify that authenticated users with valid organizational access may view results according to permitted geographic scope.

---

## 9. Code Changes Required (Without Modifying Code in Phase 2)

1. **Leaderboard Data Fetching (`src/lib/firebase/firestore.ts`):** Modify `getLeaderboard()` to fetch from a dedicated public leaderboard collection (`leaderboard_public`) or aggregated rank collection to prevent rule permission errors on the main `/users` collection.
2. **Activity Creation Scope Fallback (`src/app/portal/campaign/activities/page.tsx`):** Ensure activity creation populates valid `scope_type` and `scope_id` matching user permissions so Firestore rules evaluate `hasAccess("create_activity", scope_type, scope_id)` successfully.
3. **Task Submission Query Scope (`src/app/portal/tasks/page.tsx`):** Ensure user task submission queries pass `tenant_id` and filter explicitly by `user_id == auth.uid`.

---

## 10. Firestore Rule Changes Required (Without Modifying Rules in Phase 2)

1. **Fix Delete Rules `request.resource` Anti-Pattern (`firestore.rules`):** Replace `request.resource.data.tenant_id` with `resource.data.tenant_id` in all `allow delete` blocks across `organizational_assignments`, `permission_grants`, `campaign_activities`, `campaign_assignments`, and `donations`.
2. **Leaderboard Read Access Rule (`firestore.rules`):** Add rules for `match /leaderboard_public/{docId} { allow read: if isSignedIn(); }` or allow reading public user point summary fields.
3. **Hierarchical Scope Rule Helpers (`firestore.rules`):** Enhance `hasAccess` helper to check parent scope permission documents in `/user_access` for inherited scopes (State → Zone → LGA → Ward → PU).

---

## 11. Data/Schema Changes Required

1. **`/leaderboard_public` Collection Creation:** Create a lightweight `/leaderboard_public` collection populated automatically when user points are updated (via Cloud Function or batch operation), containing only non-sensitive fields (`user_id`, `display_name`, `avatar_url`, `points`, `rank`, `tenant_id`).

---

## 12. Security Risks Identified

1. **Unrestricted Profile Field Exposure (If `/users` were opened):** Exposing `/users` for leaderboard reads without field masking would leak private phone numbers, email addresses, and security metadata to all authenticated users.
2. **Delete Operation Failures in Security Rules:** Relying on `request.resource.data` during delete operations can result in rule evaluation errors or bypasses.

---

## 13. Functional Failures Explained

* **Organizational Access Failure:** Caused by `hasAccess` checking exact string match on `/user_access/{permission}__${scopeType}__${scopeId}` without expanding descendant scopes in Firestore Security Rules.
* **Task/Submission Failures:** Occurs when dual-membership users lack `social_member` tag in `membership_types` or when queries omit required tenant filters.
* **Campaign Member PU Failure:** Non-admin campaign members without explicit organizational assignments default strictly to `profile.ward_id` / `profile.polling_unit_id`.
* **Activity Creation Failure:** Triggered when `request.resource.data.scope_type` or `scope_id` does not match an explicit `/user_access` record for the user.
* **Leaderboard Failure:** Caused by `getLeaderboard()` attempting a `getDocs()` query on `collection(db, "users")`, which is rejected by `allow read: if isAdmin() || isOwner(userId)`.
* **Reports & Issues Failures:** Scoped read queries rejected when user permissions exist for parent LGA/Zone but lack exact PU/Ward index entries in `/user_access`.
* **Coordination & Assignment Update/Delete Failure:** Caused by delete rules attempting to evaluate `request.resource.data.tenant_id` (which is `null` on deletion).

---

## 14. Unresolved Architectural Decisions

*None.* All authorization boundaries, system access roles, organizational hierarchy levels, and security rule behaviors are reconciled with the 15 Authoritative Product Decisions.

---

## 15. Implementation Sequence for Phase 3

```text
Step 1: Fix Firestore Security Rules Delete Anti-Patterns (`request.resource` -> `resource`)
   ↓
Step 2: Add Public Leaderboard Collection & Update Client Leaderboard Service
   ↓
Step 3: Update Firestore Security Rules for Scoped Hierarchy & Registered PU Fallbacks
   ↓
Step 4: Update Application Scoped Queries for Activities, Reports, Issues, & Tasks
   ↓
Step 5: Run Automated Test Suite (`npm run test`) and Verify Zero Regressions
```
