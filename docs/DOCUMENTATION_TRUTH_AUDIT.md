# Politicore / Ifeanyi 2027 — Phase 1: Documentation Truth Audit Report

## 1. Executive Summary

- **Total Documents Inspected:** 14 documentation files across root and `docs/` directories (including architecture guides, remediation logs, feature specs, audit reports, rules documentation, and README/AGENTS guidelines).
- **Documents Containing Outdated / Incorrect / Invalid Assumptions:** 8 documents (`docs/electioneering.md`, `docs/features.md`, `docs/remediation-verification.md`, `docs/organization-implementation.md`, `docs/completion.md`, `docs/election-engine-audit.md`, `docs/remediation-state.md`, `docs/bug-fix.md`).
- **Major Categories of Contradiction & Discrepancy:**
  1. **Membership vs. Authorization Eligibility:** `docs/electioneering.md` claims that membership alone (`campaign_member`) automatically grants election result reporting/viewing access for registered PUs without requiring an `OrganizationalAssignment`. Product Decision #8 & #9 explicitly state that election access is scoped according to permissions/grants (`user_access` / `PermissionGrant` / scope), not flat membership type alone.
  2. **Election Result Visibility Scoping:** Older references (and code comments) described Election Results as Admin-only. Current Product Decision #7 explicitly mandates that authenticated users with valid organizational access may view election results according to their permitted scope.
  3. **Role vs. Organizational Position Conflation:** Multiple documentation tables in `docs/remediation-verification.md` and `docs/organization-implementation.md` mix system access roles (`admin`, `member`, `election_officer`) with organizational positions (`ward_coordinator`, `lga_coordinator`, `state_coordinator`). Product Decision #1 & #2 strictly prohibit collapsing system capability roles (`access_role`) and organizational positions (`OrganizationalAssignment`).
  4. **Flat Scope Matching vs. Scoped Inheritance:** Legacy rules documentation described authorization as exact flat ID matching. Product Decision #4 mandates hierarchical scope inheritance (State → Zone → LGA → Ward → Polling Unit).
  5. **Admin Assignment Independence:** Several documents implied admins must be assigned to specific scopes to view scoped resources. Product Decision #5 clarifies that Admin is a system-level administrative capability that does not require an ordinary campaign organizational assignment.
  6. **Candidate Donation Ledger Scope:** `docs/features.md` and `docs/completion.md` correctly identify the donation module as a private candidate ledger (Product Decision #14), but earlier audit descriptions in `docs/remediation-verification.md` loosely referred to "donation management", leading to potential misinterpretation as public payment collection.

---

## 2. Document Inventory

| Document | Purpose | Status |
| -------- | ------- | ------ |
| `docs/features.md` | Core operational feature specifications & operations manual. | PARTIALLY CORRECT |
| `docs/organization-implementation.md` | Organizational hierarchy, permission grants & scope inheritance guide. | PARTIALLY CORRECT |
| `docs/electioneering.md` | Electioneering & multi-contest election engine architecture guide. | OUTDATED |
| `docs/completion.md` | Final system completion & module status matrix. | PARTIALLY CORRECT |
| `docs/election-engine-audit.md` | Read-only line-by-line audit of election engine implementation. | CURRENT / VERIFIED |
| `docs/NEWS_MODULE.md` | Architecture and data flow specs for the News CMS module. | CURRENT / VERIFIED |
| `docs/backup-recovery.md` | Automated backup & disaster recovery guide for Firestore. | CURRENT / VERIFIED |
| `docs/new.rules` | Security rules specification and migration guide. | PARTIALLY CORRECT |
| `docs/remediation-state.md` | Audit remediation state log across 67 specification requirements. | PARTIALLY CORRECT |
| `docs/bug-fix.md` | Log of UI/UX and routing bug fixes. | PARTIALLY CORRECT |
| `docs/remediation-verification.md` | Detailed QA verification report for remediation items. | OUTDATED |
| `README.md` | Basic Next.js default project template instructions. | OUTDATED |
| `AGENTS.md` | Agent instructions for Next.js 16 breaking changes. | CURRENT / VERIFIED |
| `CLAUDE.md` | Pointer file to AGENTS.md. | CURRENT / VERIFIED |

---

## 3. Correction Matrix

| Document | Section | Current Claim | Repository Reality | Product Decision | Classification | Required Correction |
| -------- | ------- | ------------- | ------------------ | ---------------- | -------------- | ------------------- |
| `docs/electioneering.md` | Authoritative Business Principles §1 | `campaign_member` automatically receives ordinary Election access for registered PU; `OrganizationalAssignment` is NOT required. | Application checks `profile.ward_id`/`polling_unit_id` or explicit grants for election upload. | Campaign members get election access according to permission/scope (Decision #8 & #9). Authorization relies on `access_role`, `OrganizationalAssignment`, `PermissionGrant`, `user_access` (Decision #1). | OUTDATED | Clarify that election access is authorized via user permissions/grants and scoped organizational assignment, not flat membership type alone. |
| `docs/electioneering.md` | Authoritative Business Principles §5 | Security rules check `ward_id == callerProfile().ward_id` for campaign members. | Security rules allow authenticated members with tenant scoping to write pending results under open contests. | Hierarchical scope inheritance and granular permission grants govern access (Decision #4 & #8). | OUTDATED | Update security rules documentation to reflect full permission grant index checks and scope inheritance. |
| `docs/features.md` | Section 2.A (Donations) | Private Admin-only record-keeping ledger for candidate contributions. | Implemented under `/portal/admin/donations` with Firestore rules restricting `/donations` to `isAdmin()`. | Private ledger for record keeping, audit, and analytics (Decision #14). | CURRENT / VERIFIED | Maintain as authoritative specification for Donations. |
| `docs/organization-implementation.md` | Section 1 (Overview) | Explains distinction between `access_role` and `OrganizationalAssignment`. | Implemented in `src/types/index.ts` and `src/lib/permissions.ts`. | Four distinct concepts: `access_role`, `OrganizationalAssignment`, `PermissionGrant`, `user_access` (Decision #1 & #2). | CURRENT / VERIFIED | None required. |
| `docs/organization-implementation.md` | Section 2 (Hierarchy Resolution) | Hierarchy resolves State → Zone → LGA → Ward → PU via `assignmentCoversScope`. | Code in `src/lib/permissions.ts` dynamically resolves hierarchy across 17 LGAs. | Hierarchy includes State → Zone → LGA → Ward → Polling Unit with scope inheritance (Decision #4). | CURRENT / VERIFIED | None required. |
| `docs/organization-implementation.md` | Section 3 (Admin Access) | Admin bypasses assignment requirements across all campaign operational views. | `isAdminUser(profile)` returns `true` in `hasPermission()`. | Admin is a system-level administrative capability and does not require an ordinary assignment (Decision #5). | CURRENT / VERIFIED | None required. |
| `docs/organization-implementation.md` | Section 1 (Removed Modules) | Cleaned up stale links to removed modules (Communications, Documents, Calendar). | Code in `CampaignDashboard.tsx` links to `/portal/campaign/activities`. | Communications, Documents, and Calendar were deliberately removed (Decision #12). | CURRENT / VERIFIED | None required. |
| `docs/remediation-verification.md` | Section J-E1 / Election Visibility | Mentions legacy state where election results were Admin-only. | Dashboard allows authenticated users with organizational access to view scope results. | Authenticated users with valid organizational access may view results according to scope (Decision #7). | OUTDATED | Remove references claiming election results are Admin-only. |
| `docs/remediation-state.md` | §11 Electoral Data Requirement | Implemented Enugu State electoral hierarchy (17 LGAs, 260 Wards, 4,145 PUs). | `/lgas` folder and `scripts/seed-electoral-data.ts` populate Enugu State electoral data. | Enugu State electoral hierarchy has already been implemented (Decision #11). | CURRENT / VERIFIED | None required. |
| `docs/remediation-state.md` | §32 Correction Workflow | Admin correction sets status to `pending_review` and `verified: false`. | Implemented in `correctElectionResult()` in `src/lib/firebase/election.ts`. | Admin correction must revert result to `pending_review` for Election Officer verification (Decision #10). | CURRENT / VERIFIED | None required. |
| `docs/completion.md` | Section 2 (Election Engine) | Multi-contest election engine supports 17 LGAs, 260 Wards, 4,145 PUs across Presidential, Governorship, Senatorial, etc. | Supported in `src/app/portal/admin/election/page.tsx` and `src/lib/firebase/election.ts`. | Multi-contest support with active contest identification (Decision #6). | CURRENT / VERIFIED | None required. |
| `README.md` | Root README | Default Next.js boilerplate template text. | Repository contains standard Next.js bootstrap text. | Repository is a full campaign management platform. | OUTDATED | Update README to describe the Politicore Campaign Platform architecture. |

---

## 4. Cross-Document Contradictions

1. **Election Result Visibility: Admin-Only vs. Scoped Authenticated Access**
   - **Contradiction:** Older sections in `docs/remediation-verification.md` state that election results are restricted to Admins only. In contrast, `docs/electioneering.md` and `docs/completion.md` state that campaign members and election officers can view election results scoped to their registered PU or assigned scope.
   - **Authoritative Resolution:** Product Decision #7 strictly overrides older docs: Authenticated users with valid organizational access may view election results according to their permitted scope.

2. **Authorization Basis: Flat Membership vs. 4-Tier Permission Architecture**
   - **Contradiction:** `docs/electioneering.md` (§1) states that having `membership_types: ["campaign_member"]` automatically confers operational election upload/view rights for a user's registered PU without needing an `OrganizationalAssignment` or `PermissionGrant`. However, `docs/organization-implementation.md` states that operational authorization is strictly evaluated via `access_role`, `OrganizationalAssignment`, `PermissionGrant`, and `user_access`.
   - **Authoritative Resolution:** Product Decisions #1, #2, #8, and #9 govern: Authorization must NEVER be collapsed into flat membership checking. Access roles, organizational assignments, explicit permission grants, and user access indices work together to grant operational capabilities.

3. **Role & Position Terminology: System Roles vs. Organizational Titles**
   - **Contradiction:** Tables in `docs/remediation-verification.md` treat `Ward Coordinator` and `LGA Coordinator` as if they were values of `user.role` (system access role). Conversely, `docs/organization-implementation.md` and `src/types/index.ts` explicitly separate `Role` (`admin`, `member`, `election_officer`) from `OrganizationalPosition` (`ward_coordinator`, `lga_coordinator`, `state_coordinator`).
   - **Authoritative Resolution:** Product Decision #2 governs: `access_role` represents system capability; organizational titles belong strictly in `OrganizationalAssignment`.

---

## 5. Architecture Assumptions That Are No Longer Valid

1. **Obsolete Assumption: Authorization can be checked via flat string equality on user profile.**
   - *Reality:* Scopes must inherit downward (State → Zone → LGA → Ward → Polling Unit). Exact ID string comparisons fail to grant LGA coordinators access to subordinate Wards and Polling Units.
2. **Obsolete Assumption: Admin users must hold an `OrganizationalAssignment` document to access scoped views.**
   - *Reality:* Admins have global administrative authority across the tenant and do not require an ordinary organizational assignment to view campaign or election data.
3. **Obsolete Assumption: Election results are an Admin-only module.**
   - *Reality:* Authenticated campaign members and election officers require scoped access to view and monitor election results.
4. **Obsolete Assumption: Enugu State electoral data still needs to be built/populated.**
   - *Reality:* All 17 LGAs, 260 Wards, and 4,145 Polling Units in Enugu State are fully implemented and seedable.
5. **Obsolete Assumption: Campaign Communications, Documents, and Calendar are pending features.**
   - *Reality:* These modules were permanently removed from the application architecture.
6. **Obsolete Assumption: Donations is a public checkout payment system.**
   - *Reality:* Donations is strictly a private, candidate-facing contribution ledger for recording and auditing offline payments.

---

## 6. Product Decisions That Must Override Older Documentation

1. **Decision #1 & #2 (Authorization Model):** The 4-tier model (`access_role`, `OrganizationalAssignment`, `PermissionGrant`, `user_access`) is authoritative. System roles (`admin`, `member`, `election_officer`) must never be confused with organizational positions (`Ward Coordinator`, `LGA Coordinator`, etc.).
2. **Decision #4 (Organizational Hierarchy):** Scope inheritance (State → Zone → LGA → Ward → PU) is mandatory for resolving permissions across descendant levels.
3. **Decision #7 (Election Result Visibility):** Authenticated users with valid organizational access may view election results according to scope.
4. **Decision #8 & #9 (Election Operational & Reporting Access):** Social-only members have zero election access. Campaign members have scoped reporting/viewing access. Election Officers have desk operational review authority. Admins have system administrative authority.
5. **Decision #10 (Admin Result Correction Workflow):** Admin corrections MUST set status to `pending_review` and `verified: false`, forcing Election Officer re-verification.
6. **Decision #12 (Removed Modules):** Communications, Documents, and Calendar are removed.
7. **Decision #14 (Private Donation Ledger):** Donations module is private record-keeping only.
8. **Decision #15 (Application Priority):** Existing architecture stabilization is the priority. No Supabase migration, multi-tenancy redesign, or SaaS refactoring.

---

## 7. Questions Requiring Human Decision

*None.* All architectural and product boundaries have been explicitly defined in the 15 Authoritative Product Decisions provided for Phase 1.

---

## 8. Recommended Documentation Authority Order

When documentation sources conflict, precedence must strictly be applied in the following order:

```text
1. Current Explicit Product Decisions (Phase 1 Specifications)
       ↓
2. Current Repository Implementation (`src/` & `firestore.rules`)
       ↓
3. Authoritative Feature Specs & Architecture Guides (`docs/features.md`, `docs/organization-implementation.md`, `docs/backup-recovery.md`, `docs/NEWS_MODULE.md`)
       ↓
4. System Audit Reports (`docs/completion.md`, `docs/election-engine-audit.md`)
       ↓
5. Legacy Verification & Remediation Logs (`docs/remediation-verification.md`, `docs/remediation-state.md`, `docs/bug-fix.md`)
       ↓
6. Standard Project Files & Boilerplate (`README.md`)
```
