# Politicore — Firebase Security Rules & Test-Harness Assessment (Phase 1)
**Project:** Politicore / Ifeanyi 2027 (`ifeanyi-4-nkanu`)  
**Assessment Date:** September 19, 2026  
**Environment:** Windows 11 / PowerShell 7+ / Node v24.15.0 / Java OpenJDK 21 LTS  
**Target Emulator Project ID:** `demo-politicore-test` (100% offline, zero-cost, zero cloud quota)

---

## 1. Repository Findings

A comprehensive inspection of the repository was conducted. The following files and configurations were verified against disk:

### Project Configuration & Core Files
| File Path | Status | Details & Observations |
| :--- | :--- | :--- |
| `package.json` | **Present** | Next.js 16.3.0, React 19.2.8, Firebase v12.17.1, Firebase Admin v14.3.0. Standalone `tsx` script `"test": "tsx tests/business-rules.test.ts"`. No test framework or `@firebase/rules-unit-testing`. |
| `tsconfig.json` | **Present** | Path alias `@/*` -> `./src/*`. Strict type checking enabled. Includes `.ts`, `.tsx`, `.mts`. |
| `.firebaserc` | **Present** | Configured with default project: `"ifeanyi-4-nkanu"`. |
| `firebase.json` | **Present** | Configures Auth (port 9099), Functions (port 5001), Firestore (port 8080), Emulator UI (enabled), `singleProjectMode: true`, and `"rules": "firestore.rules"`. |
| `firestore.rules` | **Present** | 1,552 lines of rules. Contains complete rules definitions for 18 domain collections, custom authorization functions, and `match /{document=**} { allow read, write: if false; }`. |

### Client-Side Firebase Configuration & Runtime Assessment
| File Path | Findings |
| :--- | :--- |
| `src/lib/firebase/config.ts` | Configures client Firebase app. Connects to Auth Emulator (`http://127.0.0.1:9099`) and Firestore Emulator (`127.0.0.1:8080`) if `NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true"` and `typeof window !== "undefined"`. |
| `src/lib/firebase/auth.ts` | Implements `signUpVolunteer`, `createMemberByAdmin` (isolated secondary app instance), `signIn`, `logOut`, and `updateUserLifecycleStatus`. |
| `src/contexts/AuthContext.tsx` | Central authentication and authorization context. Derives `isSocialMember`, `isCampaignMember`, `isCampaignCouncilMember`, and provides `hasPermission()`. |
| `src/lib/firebase/organization.ts` | Loads user organizational assignments and permission grants constrained by `tenant_id` and `user_id`. |
| `src/lib/firebase/organizationalAssignments.ts` | Manages assignments and synchronizes index entries in `/user_access` using composite IDs: `${userId}__${permission}__${scopeType}__${scopeId}`. |
| `src/lib/firebase/permissionGrants.ts` | Manages explicit permission grants and synchronizes index entries in `/user_access`. |
| `src/lib/firebase/election.ts` | Implements contest-aware election result submission, Form EC8 Cloudinary evidence verification, Officer reviews, and Admin corrections with audit trail. |
| `src/lib/firebase/donations.ts` | Implements atomic batch write creating donation record, donor statistic update, and donation audit log. |
| `src/lib/permissions.ts` | Authoritative permission matrix (`POSITION_DEFAULT_PERMISSIONS`), scope hierarchy resolver (`isScopeDescendant`, `assignmentCoversScope`), and membership predicates. |

### Client Emulator Configuration Assessment: SSR, HMR, and Isolation Concerns
1. **SSR / Server Component Isolation:**  
   In `src/lib/firebase/config.ts`, emulator connection is guarded by `typeof window !== "undefined"`. In Next.js server components or SSR API routes, the emulators are skipped unless environment variables `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST` are set in the Node process.
2. **Next.js Fast Refresh (HMR) Duplicate Connection Risk:**  
   Calling `connectFirestoreEmulator()` or `connectAuthEmulator()` more than once on the same instance throws a fatal runtime exception (`FirebaseError: Host has already been set...`). In development, module reload can trigger this unless guarded by an idempotent check or global variable (e.g. `(globalThis as any)._firebaseEmulatorsConnected`).
3. **Test Harness Independence:**  
   The rules test harness must **never** import `src/lib/firebase/config.ts`. Security rules unit testing with `@firebase/rules-unit-testing` operates via isolated `TestEnvironment` contexts (`initializeTestEnvironment`), completely separating rule assertions from application client singletons.

---

## 2. Existing Test Infrastructure

### A. Existing Test Files
The project contains exactly **one** test file:
- `tests/business-rules.test.ts` (114 lines):
  - Pure TypeScript unit script executed directly via `tsx`.
  - Tests pure in-memory functions:
    1. `isAdminUser` role recognition.
    2. Registered Polling Unit matching logic (`canMemberSubmitPUResult`).
    3. Organizational hierarchy scope covering (`assignmentCoversScope`).
    4. Text formatting utilities (`formatOrganizationalPosition`, `formatScopeType`).
    5. Leaderboard projection document shape (`createLeaderboardProjectionDoc`).
  - **Does not connect to any emulator, does not use Firebase SDK, and does not test `firestore.rules`.**

### B. Existing Test Framework
- **None.** There is no Vitest, Jest, Mocha, Playwright, Cypress, or Node Test Runner configured.
- Tests are executed via a custom handwritten `assert(condition, testName)` runner running in `tsx`.

### C. Existing Firebase Rules Testing
- `@firebase/rules-unit-testing` is **not installed**.
- No rules-testing suites, mock tokens, or emulator fixture scripts exist.

### D. Existing npm Scripts
Current scripts in `package.json`:
```json
"scripts": {
  "dev": "next dev --webpack --hostname 0.0.0.0",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "seed:electoral": "tsx scripts/seed-electoral-data.ts",
  "test": "tsx tests/business-rules.test.ts"
}
```
None of these scripts are intended or configured to run Firebase emulator rules tests.

---

## 3. Firebase Emulator Readiness

The local environment was checked using live command inspection:
- **Node.js Version:** `v24.15.0` (Supported)
- **Firebase CLI Version:** `15.30.2` (Supported)
- **Java Runtime Environment (JRE):** `OpenJDK 21.0.12.1 LTS` (Temurin-21.0.12.1+1) — **Installed and operational**. Firestore emulator requires Java and will run without issue.
- **Port Availability & Alignment:**
  - Auth: `9099` (Declared in `firebase.json`)
  - Firestore: `8080` (Declared in `firebase.json`)
  - Emulator UI: `4000` (Default)
- **Functions Emulator Note:** `firebase.json` declares port 5001 for Functions, but there is no `functions/` directory or Cloud Functions code in the repository. The emulator suite can be launched with `--only auth,firestore`, ignoring Functions.
- **Automated Lifecycle Readiness:**  
  `firebase emulators:exec --project demo-politicore-test --only auth,firestore "<test-command>"` is fully supported and will start Auth + Firestore, run the test runner, and terminate the emulators cleanly upon completion.

---

## 4. Missing Dependencies (Do Not Install Yet)

To establish the agreed security-rules test harness, the following packages must be added as `devDependencies` in Phase 2:

1. **`@firebase/rules-unit-testing` (`^4.1.1` or latest compatible):**
   - Official library for mocking Auth contexts, loading `firestore.rules`, and asserting allowed/denied operations (`assertFails`, `assertSucceeds`).
2. **`vitest` (`^3.0.0` or latest compatible):**
   - Modern, high-performance, ESM-native TypeScript test framework. Integrates seamlessly with Next.js 16 and Vite/TS tooling, supports watch mode, snapshot testing, and setup files.
3. **`cross-env` (`^7.0.3`):**
   - Essential for cross-platform Windows / PowerShell / Linux compatibility. Ensures environment variables (e.g. `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`) are set consistently without failing on Windows syntax.

*No packages have been installed during Phase 1.*

---

## 5. Missing Files / Configuration (Do Not Create Yet)

The following files are missing and should be created in Phase 2:

1. **`vitest.config.ts` (Root):**
   - Configures Vitest with TypeScript path alias resolution (`@/*` -> `./src/*`), test inclusion patterns (`tests/rules/**/*.test.ts`), and global test timeout for emulator operations.
2. **`tests/rules/helpers/test-env.ts`:**
   - Singleton manager for `@firebase/rules-unit-testing` `initializeTestEnvironment()`.
   - Loads `firestore.rules` directly from disk.
   - Points to project `demo-politicore-test`.
   - Exports helpers: `setupRulesTestEnv()`, `teardownRulesTestEnv()`, `clearFirestore()`, `getAuthenticatedContext(uid, role, tenantId, membershipTypes, customClaims)`.
3. **`tests/rules/helpers/fixtures.ts`:**
   - Pre-seeds essential prerequisite data before individual tests:
     - Tenant document `/tenants/ifeanyi-2027` with `election_mode_enabled: true`.
     - User profile `/users/{uid}` with `tenant_id`, `access_role`, `membership_types`.
     - Contest document `/election_contests/{contestId}` with `status: "OPEN"`, `tenant_id: "ifeanyi-2027"`.
     - `user_access` index entries where testing scoped access.
4. **Rules Test Suites in `tests/rules/`:**
   - `identity-tenancy.test.ts`
   - `roles-election-boundary.test.ts`
   - `election-results.test.ts`
   - `operational-modules.test.ts` (Tasks, Submissions, Activities, Reports, Issues, Donations, Audits, Notifications, Public Content).
5. **Script Additions to `package.json`:**
   - `"test:rules"`: `firebase emulators:exec --project demo-politicore-test --only auth,firestore "cross-env CI=true vitest run tests/rules"`
   - `"test:rules:watch"`: `cross-env FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 vitest tests/rules` (for iterative development with running emulators).

*No files or configurations have been created during Phase 1.*

---

## 6. Recommended Test Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           TEST RUNNER EXECUTION FLOW                            │
│                                                                                 │
│   npm run test:rules                                                            │
│          │                                                                      │
│          ▼                                                                      │
│   firebase emulators:exec --project demo-politicore-test --only auth,firestore  │
│          │                                                                      │
│          ├── 1. Spawns Auth Emulator (127.0.0.1:9099)                           │
│          ├── 2. Spawns Firestore Emulator (127.0.0.1:8080)                      │
│          ├── 3. Compiles & Loads firestore.rules into Emulator Engine           │
│          │                                                                      │
│          ▼                                                                      │
│   vitest run tests/rules                                                        │
│          │                                                                      │
│          ├──> Test Suite: @firebase/rules-unit-testing                          │
│          │       │                                                              │
│          │       ├── Admin Context (bypass rules to seed /tenants, /users)      │
│          │       │                                                              │
│          │       ├── Authenticated Contexts (Admin, Member, Officer, Foreign)   │
│          │       │                                                              │
│          │       └── Unauthenticated Context                                    │
│          │                                                                      │
│          ├──> Assertions: assertSucceeds(...) & assertFails(...)                │
│          │                                                                      │
│          └──> After Each: clearFirestore()                                      │
│                                                                                 │
│          ▼                                                                      │
│   Tear Down & Exit (Emulator processes killed automatically)                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Why Vitest over Jest or Node Test Runner
1. **ESM & TypeScript Native:** Next.js 16 and modern `@firebase/rules-unit-testing` use ECMAScript Modules (ESM). Vitest handles TypeScript and ESM out-of-the-box via Vite without complex Babel/ts-jest transformations.
2. **Speed & Watch Mode:** Instant start-up, in-memory compilation, and lightning-fast execution during security rule development.
3. **Ergonomics & Compatibility:** Shares Jest-compatible `describe`, `it`, `expect`, `beforeAll`, `beforeEach` syntax, requiring zero cognitive overhead.

---

## 7. Windows / PowerShell Compatibility

The development environment is Windows with PowerShell. POSIX commands (e.g. `GCLOUD_PROJECT=xyz npm test`) fail on PowerShell.

### Standardized Cross-Platform Strategy:
1. **`cross-env` in package scripts:**  
   Using `cross-env` abstracts environment variable assignment across PowerShell, CMD, and Bash.
2. **Double Quotes in `firebase emulators:exec`:**  
   On Windows PowerShell, the command passed to `--exec` must be wrapped in double quotes:
   ```json
   "test:rules": "firebase emulators:exec --project demo-politicore-test --only auth,firestore \"cross-env CI=true vitest run tests/rules\""
   ```
3. **Explicit Project ID:**  
   Always pass `--project demo-politicore-test` in the CLI command. This overrides `.firebaserc` without modifying it, forcing offline execution.
4. **Port Configuration:**  
   Ports 9099 (Auth) and 8080 (Firestore) are standard Windows-safe non-privileged ports.

---

## 8. Security Test Coverage Plan

The eventual test harness will cover the full security matrix across all domains defined in `firestore.rules`:

### Domain 1: Identity, Tenancy & Core Boundaries
- **Unauthenticated Access:** Deny all reads and writes across private collections (`users`, `election_results`, `tasks`, `campaign_activities`, `donations`, etc.).
- **Cross-Tenant Denial:** A user authenticated in tenant `other-tenant` cannot read or write any document in tenant `ifeanyi-2027`.
- **Identity Forgery Protection:**
  - An authenticated user cannot create or update profile documents for another `uid` (`isOwner(userId)`).
  - An authenticated user cannot submit task completions for another user (`task_submissions/{taskId}_{userId}`).
  - An authenticated user cannot submit results with a `submitted_by` UID different from their `request.auth.uid`.

### Domain 2: Roles & Separation of Duties
- **Global Admin (`admin`, `tenant_super_admin`):**
  - Full read/write authority across the tenant for users, assignments, grants, activities, announcements, donations, etc.
  - Can correct election results (reverting status to `pending_review`).
  - Cannot approve their own correction directly as an officer.
- **Election Officer (`election_officer`):**
  - Tenant-wide read and review access **within the Election domain** (`election_results`, `pu_reports`, `election_incidents`).
  - Allowed status transitions: `submitted` -> `approved` / `rejected` / `clarification_required`.
  - Allowed status transitions: `approved` -> `reopened`.
  - **Forbidden outside Election:** Zero administrative access to user profiles, tasks, donations, permission grants, or organizational assignments.
  - Cannot alter vote values (`request.resource.data.results == resource.data.results`).
- **Social Member (`social_member`):**
  - Can read active tasks (`tasks`).
  - Can create and update own pending task submissions (`task_submissions`).
  - Can read public leaderboard projection (`leaderboard_public`).
  - **Zero Election Access:** Completely blocked from reading or writing `election_results`, `election_contests`, `pu_reports`, `election_incidents`.
- **Campaign Member (`campaign_member`):**
  - Eligible for location-scoped activities, field reports, and election submissions.
  - Registered PU Result Upload: Allowed to submit election results only for their registered Ward and Polling Unit (`profile.ward_id`, `profile.polling_unit_id`).
  - Submitting result for an unregistered PU is denied unless covered by explicit `user_access` record.

### Domain 3: Election Lifecycle & Result Rules
- **Result Creation Validation:**
  - Contest must exist, belong to tenant, and have `status == "OPEN"`.
  - Document ID must match deterministic format: `${contest_id}__${polling_unit_id}`.
  - Initial status must be `submitted`, `verified: false`.
  - Mandatory Form EC8 photo evidence (`cloudinary_url.size() > 0`).
  - Submitter must be authenticated and authorized (Admin, Election Officer, Registered PU member, or scoped grant).
- **Result Modification Constraints:**
  - Officer review update must keep geographic keys (`state_id`, `lga_id`, `ward_id`, `polling_unit_id`, `contest_id`) and submitter UID immutable.
  - Admin correction allows updating `results` votes but **strictly requires** `status == "pending_review"` and `verified == false`.
- **Permanent Deletion Ban:**
  - Deletion of election results is prohibited (`allow delete: if false;`).

### Domain 4: Operational Collections & Administrative Ledgers
- **User Profiles (`/users`):**
  - Non-admin cannot elevate own `access_role`, `membership_types`, `points`, or `rank`.
- **Leaderboard (`/leaderboard_public`):**
  - Signed-in same-tenant users can read; Admin only can create/update/delete.
- **Campaign Activities (`/campaign_activities`):**
  - Admin can create/update/delete; members require `view_activities`, `create_activity`, or `manage_activity` via `user_access`.
- **Field Reports & Issues (`/campaign_field_reports`, `/issues`):**
  - Author can read own submissions; supervisors require scoped access index; status management restricted.
- **Donations & Donors (`/donations`, `/donors`, `/donation_audits`):**
  - Private Admin-only ledger; client reads/writes by non-admin are denied.
  - Physical deletion blocked (`allow delete: if false;`).
- **System Audits (`/system_audits`):**
  - Admin read-only; client creation blocked (`allow create: if false;`).
- **Notifications (`/notifications`):**
  - Read permitted for same-tenant signed-in users; create/delete Admin-only; user can only modify `read_by` by adding their own UID.
- **Contact Messages & Electoral Data:**
  - Contact messages: Public creation permitted with `status == "unread"`; read/update Admin-only.
  - Electoral data: Public read; write prohibited (`allow write: if false;`).
- **Default Deny:** Any unmapped collection denies all reads and writes.

---

## 9. Risks or Blockers Discovered

### A. Non-Existent `/tenants` Collection Match Rule in `firestore.rules`
- **Finding:** `firestore.rules` checks `electionModeEnabled()` by evaluating:
  ```firestore
  exists(/databases/$(database)/documents/tenants/$(callerTenantId())) &&
  get(/databases/$(database)/documents/tenants/$(callerTenantId())).data.election_mode_enabled == true;
  ```
  However, there is no explicit `match /tenants/{tenantId}` rule in `firestore.rules`.
- **Risk Assessment:** While `exists()` and `get()` in rules bypass security checks, client SDK queries against `/tenants/{tenantId}` will fall into `match /{document=**} { allow read, write: if false; }`. In the test harness, tenant documents must be seeded using `testEnv.withSecurityRulesDisabled()` (Admin context). This is standard for security test harnesses.

### B. Java Requirement for Local Execution
- **Finding:** The Firestore emulator binary requires Java Runtime Environment (JRE).
- **Status:** **Resolved.** OpenJDK 21 LTS is already installed on the machine.

### C. Flat `user_access` Matching vs. Hierarchical Scopes
- **Finding:** In `firestore.rules`, `hasScopedAccess()` checks exact document existence on `user_access/${uid}__${permission}__${scopeType}__${scopeId}`. If an LGA Coordinator attempts an action on a Ward, the security rule will deny it unless an index record exists for that Ward.
- **Test Implication:** Tests verifying hierarchical delegation must seed the specific `user_access` documents that the application's synchronization service (`writeAssignmentIndex`) generates.

---

## 10. Phase 2 Plan

Upon user review and authorization of this assessment, Phase 2 will execute strictly within cost and safety controls:

1. **Package Installation (devDependencies only):**
   - Install `@firebase/rules-unit-testing`, `vitest`, and `cross-env`.
2. **Configuration Setup:**
   - Create `vitest.config.ts` configured for TypeScript and path aliases.
   - Add `"test:rules"` and `"test:rules:watch"` scripts to `package.json`.
3. **Test Infrastructure Harness:**
   - Create `tests/rules/helpers/test-env.ts` with `initializeTestEnvironment`, connecting to project `demo-politicore-test` on ports 9099 and 8080.
   - Create `tests/rules/helpers/fixtures.ts` with seeding utilities.
4. **Execute First Smoke Test:**
   - Run a minimal smoke test (e.g. verifying unauthenticated read denial on `/users` and `/donations`) via `npm run test:rules` to confirm automated emulator spin-up, test execution, and teardown on Windows.
5. **Cost & Safety Guardrail:**
   - Maintain `demo-politicore-test` throughout. Limit rule verification iterations to maximum 3 attempts. Zero deployment, zero live GCP endpoints.

---
*Report compiled and verified against physical repository state.*
