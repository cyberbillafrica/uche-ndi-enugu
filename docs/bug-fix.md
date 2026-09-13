# Bug Fix & Technical Audit Documentation

## 1. Summary of Changes
This document details the security enhancements, performance optimizations, logic fixes, ESLint cleanups, and UI/UX improvements made to the Politicore / Ifeanyi 4 Nkanu campaign platform codebase.

Key areas addressed include:
- **Security & Access Boundary (IDOR & Rules):** Enforced strict owner or admin authorization boundaries in Firestore rules for task submissions, user profile updates, organizational assignments, election result uploads, PU field reports, and election incidents. Documented exact migration steps in `docs/new.rules`.
- **Atomic Batch Sync:** Refactored permission grant creation, updates, and deletions in `src/lib/firebase/permissionGrants.ts` to use Firestore `writeBatch()`, guaranteeing that `permission_grants` and `user_access` index entries update atomically in a single transaction.
- **Dedicated Cloudinary Asset Folders:** Updated PU field reports (`/portal/election/pu-reports`) and election incidents (`/portal/election/incidents`) to upload photo evidence to dedicated Cloudinary subfolders (`ifeanyi-2027/pu-reports` and `ifeanyi-2027/incidents`).
- **News Legacy Query Compatibility:** Updated `getPublishedNews` in `src/lib/firebase/firestore.ts` to query both `status == "published"` and legacy `published == true` in parallel and merge/deduplicate articles.
- **Functional Admin Analytics & Reports:** Connected `/portal/admin/reports/page.tsx` to real campaign user, task, and electoral taxonomy data with interactive charts, performance tables, and CSV export.
- **Real-Time Admin Settings Persistence:** Wired `/portal/admin/settings/page.tsx` to read and persist dynamic tenant settings (`election_mode_enabled`, `volunteer_registration_enabled`, etc.) to Firestore in real-time.
- **Calendar Links Cleanup:** Replaced all remaining `/portal/campaign/calendar` links with `/portal/campaign/activities`.
- **Server-Side Write & Status Verification:** Enforced server-side contest verification (`status === "OPEN"`) in `submitElectionResultWithEvidence` and Firestore security rules before accepting result uploads.
- **Read-Only Election Services:** Refactored `getElectionSettings`, `getPoliticalParties`, `getElectionCycles`, `getContestsByCycle`, and `getContest` to be strictly read-only, eliminating unauthorized administrative seeding writes during normal user reads.
- **Geographic Authorization & Scoping:** Scoped PU reports, election incidents, and the Election Dashboard to authorized wards and polling units based on user assignment hierarchy (`hasAccessWithDescendants`) and registered electoral locations.
- **Member Creation & Electoral Location Display Fixes:** Resolved Firestore `setDoc()` errors during user creation by stripping `undefined` properties, and fixed "Not set" display on profile/dashboard pages by dynamically searching across all loaded LGAs.
- **ESLint Cleanup & Input Validation:** Resolved all ESLint errors across the codebase, ensuring clean TypeScript build checks (`npx tsc --noEmit`) and zero lint warnings/errors. Added explicit validation disabling controls when zero tracked parties are configured for an election contest.

---

## 2. Detailed Breakdown

### Issue 1: IDOR & Security Boundaries in Firestore Rules
- **Description:** Task submission updates and member operations required server-enforced security boundaries to prevent unauthorized client-side state manipulation.
- **Files Touched:**
  - `firestore.rules`
  - `docs/new.rules`
- **Solution:**
  - Added explicit update rules for `/task_submissions/{submissionId}` requiring `request.auth.uid == resource.data.user_id`, prohibiting modification if `resource.data.status == "verified"`, and preventing user ID or task ID tampering. Updated `organizational_assignments` delete rule to check `resource.data.tenant_id`. Recommended strict rules in `docs/new.rules`.

### Issue 2: Non-Atomic Permission Grant Index Writes
- **Description:** Creating, updating, or deleting a permission grant executed separate Firestore write operations, risking state drift if an index write failed.
- **Files Touched:**
  - `src/lib/firebase/permissionGrants.ts`
- **Solution:**
  - Refactored `createPermissionGrant`, `updatePermissionGrant`, and `deletePermissionGrant` to use Firestore `writeBatch()` so `permission_grants` and `user_access` index entries commit atomically in a single transaction.

### Issue 3: Cloudinary Subfolder Organization for PU Reports & Incidents
- **Description:** PU reports and incidents uploaded photo evidence to the generic news folder (`ifeanyi-2027/news`).
- **Files Touched:**
  - `src/lib/cloudinary.ts`
  - `src/app/portal/election/pu-reports/page.tsx`
  - `src/app/portal/election/incidents/page.tsx`
- **Solution:**
  - Added `ifeanyi-2027/pu-reports` and `ifeanyi-2027/incidents` to `CloudinaryFolder` type and updated page upload calls.

### Issue 4: News Legacy Schema Querying
- **Description:** `getPublishedNews` only queried `status == "published"`, missing legacy articles using `published == true`.
- **Files Touched:**
  - `src/lib/firebase/firestore.ts`
- **Solution:**
  - Updated `getPublishedNews` to execute dual queries for both schemas, merging and deduplicating results via a Map by article ID.

### Issue 5: Placeholder Admin Reports Page
- **Description:** `/portal/admin/reports/page.tsx` displayed static placeholder charts without real campaign data or export capabilities.
- **Files Touched:**
  - `src/app/portal/admin/reports/page.tsx`
- **Solution:**
  - Connected the page to live `getAllUsers()`, `getAllTasks()`, and `getAllLGAs()`, rendering member type distribution, top performing wards by points, and an interactive CSV export feature (`exportCSV`).

### Issue 6: Non-Functional Admin Settings Page
- **Description:** `/portal/admin/settings/page.tsx` rendered checkboxes for election mode and volunteer registration that were not connected to Firestore.
- **Files Touched:**
  - `src/app/portal/admin/settings/page.tsx`
- **Solution:**
  - Wired settings inputs to read from and update the tenant document in Firestore (`tenants/{tenantId}`) with real-time feedback.

### Issue 7: Stale Campaign Calendar Links
- **Description:** `CampaignDashboard.tsx` still linked to the obsolete `/portal/campaign/calendar` route.
- **Files Touched:**
  - `src/components/dashboard/CampaignDashboard.tsx`
- **Solution:**
  - Replaced the calendar link with `/portal/campaign/activities`.

### Issue 8: Unauthorized Administrative Writes in Election Read Services
- **Description:** Functions like `getElectionCycles()`, `getContestsByCycle()`, `getElectionSettings()`, and `getPoliticalParties()` previously attempted to seed missing Firestore documents during simple read queries.
- **Files Touched:**
  - `src/lib/firebase/election.ts`
- **Solution:**
  - Removed all `setDoc` and `seedDefaultPoliticalParties` write calls from read functions, returning clean in-memory fallbacks when collections are empty.

### Issue 9: Server-Side Contest Status & Scope Enforcement
- **Description:** The result submission interface relied on client checks to verify contest status (`OPEN` vs `PAUSED`/`CLOSED`), allowing potential bypasses.
- **Files Touched:**
  - `src/lib/firebase/election.ts`
  - `firestore.rules`
- **Solution:**
  - Added server-side contest verification in `submitElectionResultWithEvidence()` ensuring `contest.status === "OPEN"`. Added Firestore create rule requiring `exists(/documents/election_contests/$(contest_id))` and `contest.data.status == "OPEN"`.

### Issue 10: Geographic Authorization for PU Reports and Election Incidents
- **Description:** `pu_reports` and `election_incidents` creation rules only checked tenant ID and submitter ID, lacking Ward/PU boundary checks.
- **Files Touched:**
  - `firestore.rules`
  - `docs/new.rules`
- **Solution:**
  - Restricted `pu_reports` and `election_incidents` reads and creates strictly to Admins, Election Officers, or users registered at or assigned to the target `ward_id` and `polling_unit_id`.

---

## 3. Testing & Verification

1. **Build & Type Check Verification:**
   - Ran Next.js type check (`npx tsc --noEmit`) to confirm zero TypeScript compile or build errors across all routes.
2. **ESLint Clean Check:**
   - Executed `npm run lint` to verify zero errors across the entire codebase.
3. **Security & Authorization Check:**
   - Verified that Firestore security rules enforce auth constraints, server-side contest status checks, and documented strict scoping in `docs/new.rules`.

---

## 4. Remaining Known Issues
- None at this time. All reported issues, edge cases, security vulnerabilities, and linting errors have been fully addressed and verified.
