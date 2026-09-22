# POLITICORE — SUPABASE + MULTI-TENANT MIGRATION BLUEPRINT

**Phase 0 deliverable — repository-grounded audit and migration architecture**

- **Audit date:** September 20, 2026
- **Source of truth:** the current repository as found on disk (`main` branch), every claim traced to specific files
- **Scope:** inspection, analysis, documentation and planning only. **No application code was modified.** No Supabase resources were created. No Firebase code was deleted or disabled. No Phase 1 work was started.
- **Strategic direction:** migrate from Firebase/Firestore to Supabase/PostgreSQL and establish true multi-tenancy, now, while the application is pre-launch with no real public user base.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture](#2-current-architecture)
3. [Complete Firebase Dependency Inventory](#3-complete-firebase-dependency-inventory)
4. [Current Data Model](#4-current-data-model)
5. [Current Authorization Model](#5-current-authorization-model)
6. [Current Tenant Assumptions](#6-current-tenant-assumptions)
7. [Module-by-Module Migration Analysis](#7-module-by-module-migration-analysis)
8. [Election Engine Analysis](#8-election-engine-analysis)
9. [Geography Analysis](#9-geography-analysis)
10. [Leaderboard Analysis](#10-leaderboard-analysis)
11. [Donation Ledger Analysis](#11-donation-ledger-analysis)
12. [Central Control Center Architecture](#12-central-control-center-architecture)
13. [Governance Architecture](#13-governance-architecture)
14. [Proposed Multi-Tenant Architecture](#14-proposed-multi-tenant-architecture)
15. [Proposed Supabase Architecture](#15-proposed-supabase-architecture)
16. [Proposed PostgreSQL Schema](#16-proposed-postgresql-schema)
17. [RLS Architecture](#17-rls-architecture)
18. [Firebase → Supabase Mapping](#18-firebase--supabase-mapping)
19. [Authentication Migration Strategy](#19-authentication-migration-strategy)
20. [Storage Strategy](#20-storage-strategy)
21. [Realtime Strategy](#21-realtime-strategy)
22. [Migration Sequence](#22-migration-sequence)
23. [Testing Strategy](#23-testing-strategy)
24. [Risk Register](#24-risk-register)
25. [Features to Preserve](#25-features-to-preserve)
26. [Features to Redesign](#26-features-to-redesign)
27. [Features to Build Only After Migration](#27-features-to-build-only-after-migration)
28. [Recommended Phase 1 Implementation Plan](#28-recommended-phase-1-implementation-plan)
29. [READY FOR PHASE 1?](#ready-for-phase-1)

---

## 1. Executive Summary

PolitiCore is a Next.js 16 (App Router) campaign-management and election-collation platform currently built entirely on **client-side Firebase**: Firebase Authentication, Cloud Firestore (29 collections), Cloudinary (all media), and a set of security rules that enforce a sophisticated four-layer authorization model. There are **no Next.js API routes and no Server Actions** — every read and write executes from the browser using the Firebase web SDK, with Firestore Security Rules as the only server-side enforcement boundary.

### What the audit verified

- **29 Firestore collections** in active use, fully inventoried in Section 4, including five election collections implementing a multi-contest Election Engine, three donation-ledger collections, and the materialized `user_access` authorization index.
- **26 Firebase service modules** in `src/lib/firebase/`, plus **3 pages that import the Firebase SDK directly** (`portal/admin/tasks`, `portal/admin/settings`, `portal/campaign/coordination`) — these bypass the service layer and must be normalized during migration.
- **34 files** import from `firebase/*`.
- **5 realtime `onSnapshot` listeners**: election results, PU reports, election incidents, election settings, and notifications.
- **2 `runTransaction` sites** (task verification + points award; nothing else) and **4 `writeBatch` sites** (permission-grant sync ×3, donation+audit+donor batch ×2 flows).
- **Cloudinary is the de-facto storage system** (7 folders; EC8 election evidence is *mandatory* and lives there). The bundled `firebase/storage` utility (`src/lib/firebase/storage.ts`) has **zero importers** — Firebase Storage is effectively unused.
- **`firebase-admin@14.3.0` is installed but never imported.** There is no server-side privileged Firebase code anywhere.
- **10 emulator-based security-rules test suites** exist under `tests/rules/` (identity/tenancy, election results lifecycle, election access, candidates, PU reports read, incidents read, role boundaries, operational modules, public/private, smoke) — an existing security-contract test corpus that is directly portable in spirit to Postgres RLS tests.
- The authorization model is a **deliberate, documented product architecture** (`docs/AUTHORITATIVE_ARCHITECTURE_RECONCILIATION.md`): `access_role` (system capability) is strictly separated from organizational positions; membership type never grants authority; Election Officer is election-domain authority; social-only members have zero Election access; election results are not Admin-only; geographic scope inherits down the hierarchy.

### The central Postgres opportunity

The `user_access` collection exists **only because Firestore cannot join or hierarchically resolve scopes inside security rules**. Rules perform exact string-match document lookups on composite IDs like `{uid}__{permission}__{scopeType}__{scopeId}`, and the application must write/delete these index documents in lockstep with assignments and grants (a known source of drift bugs — see `docs/AUTHORITATIVE_ARCHITECTURE_RECONCILIATION.md` §E, §Q). In PostgreSQL, a recursive scope query (or `ltree`) inside an RLS policy function replaces this entire materialized index, the three index-sync code paths, and the rules helper functions built on top of them. This is the single largest simplification the migration offers, and it is also the highest-risk item to get right (Section 17).

### Key discrepancies found (documented, not silently resolved)

| # | Discrepancy | Detail |
|---|-------------|--------|
| 1 | **Electoral-data scale unverifiable** | `scripts/seed-electoral-data.ts` reads a `/lgas/` directory that does not exist in the repository, so the claimed 17 LGAs / 260 wards / 4,145 polling units cannot be confirmed. The repo contains hard-coded **Nkanu West only: 14 wards, 205 polling units** (`src/data/electoral.ts`). See Section 9. |
| 2 | **Documentation conflict** | `docs/DOCUMENTATION_TRUTH_AUDIT.md` records Product Decision #15: *"Existing architecture stabilization is the priority. No Supabase migration, multi-tenancy redesign, or SaaS refactoring."* The current strategic decision (this phase) supersedes it. Recorded here per source-of-truth rules; no document was edited. |
| 3 | **Notification privacy defect** | The notifications system performs a tenant-wide collection read and filters targets client-side; `firestore.rules` deliberately permits tenant-wide notification reads for compatibility (rules file, `// NOTE:` block on `notifications`). Documented as a redesign item (Section 26), not fixed now. |
| 4 | **`system_audits` write path** | `logSystemAudit()` is called client-side, but `firestore.rules` sets `allow create: if false` for `system_audits`. Lifecycle audit writes (`USER_LIFECYCLE_*` from `auth.ts`) therefore fail at the rules layer and are swallowed by a try/catch. In Postgres, audit logging becomes a server-side concern (trigger or Edge Function) — this latent bug disappears by design. |
| 5 | **Two election-result submission paths** | The contest-aware engine (`submitElectionResultWithEvidence`) is the live path; a legacy `submitElectionResult()` remains in `src/lib/firebase/firestore.ts` (different doc-ID scheme `{ward}__{pu}`, no contest awareness, no evidence). It is dead code with no importers and must not be ported. |
| 6 | **Hard-coded election mode** | `src/app/portal/layout.tsx` sets `const electionMode = true` locally; the tenant flag `election_mode_enabled` (used by the rules) is not read by the UI. |
| 7 | **Rules vs client drift (historic)** | `docs/AUTHORITATIVE_ARCHITECTURE_RECONCILIATION.md` §Q documents confirmed defects: delete-rules evaluating `request.resource.data` (null on delete), activity-create rule lacking admin bypass, queries omitting tenant filters. Some were remediated after that report (the current rules and queries show fixes, e.g. tenant filters in `organization.ts` and `getAllCampaignMembersForTenant` now include `tenant_id`). The migration blueprint carries the *model*, not the defects. |
| 8 | **Legacy deprecated stubs** | `src/data/*.ts` files (`users`, `permissions`, `assignments`, `donations`) are empty `@deprecated` stubs; `src/data/campaign.ts` is empty. Not part of the live architecture; candidates for deletion in Phase 1 cleanup (not this phase). |

### Bottom line

Migration is feasible and substantially simplifying. The recommendation (Sections 14–17) is: **single shared-schema Postgres database with `tenant_id` on every tenant-owned row, Postgres RLS as the enforcement boundary, a recursive-scope authorization function replacing `user_access`, Supabase Auth with a structured JWT carrying tenant + role, Cloudinary retained for all media initially, and Supabase Realtime only for the election-day features that demonstrably need it.** The migration is sequenced foundation-first, feature-by-feature, with a dual-write/dual-read verification window and the existing rules test suites ported as the RLS acceptance gate.

---

## 2. Current Architecture

### 2.1 Stack

| Layer | Technology | Evidence |
|---|---|---|
| Framework | Next.js 16.3.0 (App Router), React 19.2.8, webpack dev mode | `package.json`, `AGENTS.md` (Next 16 breaking-changes banner) |
| Language | TypeScript 5 (strict) | `tsconfig.json` |
| UI | Tailwind 4, shadcn/radix components, lucide-react, recharts, react-hook-form + zod | `package.json`, `src/components/ui/*` |
| Auth | Firebase Authentication (email/password) | `src/lib/firebase/config.ts`, `src/lib/firebase/auth.ts` |
| Database | Cloud Firestore (29 collections) | `src/lib/firebase/*`, `firestore.rules` |
| Media | Cloudinary (unsigned client-side upload presets) | `src/lib/cloudinary.ts` |
| PDF generation | `@react-pdf/renderer` (client) | `package.json` |
| Tests | Vitest + `@firebase/rules-unit-testing` (emulator-based rules tests); tsx business-rules test | `vitest.config.ts`, `tests/` |
| Emulators | Auth :9099, Firestore :8080, `demo-politicore-test` project | `firebase.json`, `package.json` scripts |

### 2.2 Rendering model — a defining constraint

- **All 44 routes are client components or lightweight server components that fetch client-side.** Server components exist only for public pages (`/`, `/biography`, `/manifesto`, `/gallery`, `/news/[slug]`) which call the Firebase SDK during RSC render — meaning Firebase client config executes on the Node server too (emulator connection is correctly guarded by `typeof window !== "undefined"` in `config.ts`).
- **No API routes, no middleware, no Server Actions.** The browser holds a Firebase ID token and speaks to Firestore/Cloudinary directly.
- **Consequence for migration:** today the *only* trusted enforcement point is Firestore Security Rules. In the Supabase architecture the equivalent boundary is Postgres RLS, and the current client-side data layer maps naturally to Supabase client access governed by RLS. Server-side privileged operations (audit writes, leaderboard projection, aggregation) move to Edge Functions/database functions (Section 15).

### 2.3 Route inventory

**Public site (11):**
| Route | File | Rendering | Data |
|---|---|---|---|
| `/` | `src/app/page.tsx` | Server component (fetches in RSC) | news, tenant, portal_content events |
| `/news` | `src/app/news/page.tsx` | Client | news (published) |
| `/news/[slug]` | `src/app/news/[slug]/page.tsx` | Server component | news by slug (published) |
| `/biography` | `src/app/biography/page.tsx` | Server component | biographies/{tenant} |
| `/manifesto` | `src/app/manifesto/page.tsx` | Server component | manifestos/{tenant} |
| `/gallery` | `src/app/gallery/page.tsx` | Server component | galleries/{tenant} |
| `/contact` | `src/app/contact/page.tsx` | Client (writes) | contact_messages |
| `/login` | `src/app/login/page.tsx` | Client | Firebase Auth sign-in |
| `/volunteer` | `src/app/volunteer/page.tsx` | Client | Firebase Auth signup + users |
| `/documentation` | `src/app/documentation/page.tsx` | Static | — |
| root layout/providers | `src/app/layout.tsx` | Server | AuthProvider + ToastProvider |

**Portal — shared shell (1):** `/portal/*` layout (`src/app/portal/layout.tsx`) — client; enforces auth (redirect `/login`), renders role-scoped navigation, notification center (`onSnapshot` on `notifications`), announcements filter, contextual help, global search.

**Portal — member area (10):** dashboard, profile, tasks, leaderboard; campaign group: dashboard, area, members (+ `[id]`), assignments, activities, reports, issues, coordination (admin-facing but under campaign path); election group: election dashboard, operations, pu-reports, incidents, upload, export.

**Portal — admin area (14):** admin home, members (+ add), tasks, donations, news, manifesto, gallery, announcements/broadcast, reports, audit-logs, health, contact-messages, election config, settings.

**Protected-route mechanics today:** `portal/layout.tsx` redirects unauthenticated users; every page re-checks role/permission client-side via `useAuth().hasPermission()` / `isAdminUser()`; the *real* enforcement is `firestore.rules`. Navigation visibility and page guards are UX only.

### 2.4 Client-side / server-side / shared classification

| Class | Items |
|---|---|
| **Browser-only** | All portal pages, all client writes (tasks, submissions, donations, coordination, results, incidents, PU reports), Cloudinary uploads, exports (CSV/Excel/PDF via DOM), notifications bell |
| **Runs in RSC + browser** | Public pages and their data functions (`getBiography`, `getManifesto`, `getGallery`, `getPublishedNews`, `getCurrentTenant`); Firebase config singleton |
| **Shared (isomorphic logic, no Firebase)** | `src/lib/permissions.ts` (resolver + scope hierarchy), `src/lib/organization.ts`, `src/lib/constants.ts`, `src/lib/export.ts`, `src/lib/electionExport.ts`, `src/lib/help-content.ts`, `src/lib/errors.ts`, `src/lib/utils.ts`, `src/types/index.ts` |
| **Server-only privileged** | **None today.** (No Firebase Admin usage; `system_audits` creation is rules-blocked — see discrepancy #4) |

### 2.5 Modules inventory

| Module | Files | Status |
|---|---|---|
| Firebase core | `src/lib/firebase/config.ts` | app/auth/db/storage singletons + emulator switch |
| Auth | `src/lib/firebase/auth.ts` | signUpVolunteer, createMemberByAdmin (secondary app trick), signIn, logOut, onAuthStateChange, updateUserLifecycleStatus |
| Firestore core | `src/lib/firebase/firestore.ts` | users, tasks, task_submissions, leaderboard projection, news, announcements filter, events, contact messages, legacy election result |
| Organization | `organization.ts`, `organizationalAssignments.ts`, `permissionGrants.ts` | assignments + grants CRUD and `user_access` index sync |
| Campaign | `campaignActivities.ts`, `campaignAssignments.ts`, `campaignReports.ts`, `campaignIssues.ts`, `campaignMembers.ts` | full CRUD, scope-expanded reads |
| Election | `election.ts`, `election-seed.ts` | cycles, contests, parties, candidates, results + review + correction, PU reports, incidents, settings, realtime subscribers |
| Electoral geography | `electoral.ts` | read/write single denormalized `electoral_data/enugu-state` doc |
| CMS | `biography.ts`, `manifesto.ts`, `gallery.ts`, `portal-content.ts` | tenant-keyed singleton docs (`{tenantId}` as doc ID) |
| Donations | `donations.ts` | batch: donation + donor stats + audit |
| Audit | `audit.ts` | logSystemAudit (rules-blocked, see #4), getSystemAuditLogs |
| Notifications | `notifications.ts` | createNotification, subscribeUserNotifications (tenant-wide + client filter), mark read |
| Tenants | `tenants.ts` | CURRENT_TENANT_ID constant, getCurrentTenant, getTenantBySubdomain (placeholder) |
| Jobs | `jobs.ts` | runActivityRemindersJob, runPeriodicAggregationJob (manual, from admin health page) |
| Dev seed | `devseed.ts` | hard-coded test assignments |
| Unused | `storage.ts` | **zero importers** |
| Contexts | `src/contexts/AuthContext.tsx` | single source of auth truth |
| Hooks | `useOrganizationalAssignments.ts`, `useScopedCampaignMembers.ts` | client data hooks |
| Scripts | `scripts/seed-electoral-data.ts` | parses `/lgas/*.ts` (directory missing) into `electoral_data` |
| Tests | `tests/business-rules.test.ts` (tsx), `tests/rules/*.test.ts` (10 suites) | rules security contract |

---

## 3. Complete Firebase Dependency Inventory

### 3.1 Firebase Authentication

All in `src/lib/firebase/auth.ts` unless noted:

| Capability | Function | Callers | Notes |
|---|---|---|---|
| Registration (public) | `signUpVolunteer()` | `/volunteer` page | creates Auth user + `users/{uid}` doc (`access_role: "member"`, `tenant_id: CURRENT_TENANT_ID`, points 0, rank "Volunteer") + leaderboard projection sync |
| Registration (admin-created) | `createMemberByAdmin()` | `/portal/admin/members/add` | **temporary secondary Firebase App** to avoid replacing the admin's session; destroys app after; rules require `isAdmin()` for that create path |
| Sign-in | `signIn()` | `/login` | email/password only — no SSO, no phone, no magic link |
| Sign-out | `logOut()` | `portal/layout.tsx`, `Header.tsx` | |
| Session/current user | `onAuthStateChange()` → `AuthContext` | `src/contexts/AuthContext.tsx` | single listener; loads profile + assignments + grants after auth resolves; **no token refresh/claims logic; no session cookie; no server session at all** |
| Password reset | **None implemented** | — | help content says users contact an admin; no `sendPasswordResetEmail` anywhere |
| Profile retrieval | `getUserProfile()` (`firestore.ts`) | AuthContext, search modal | Firestore read, not an Auth call |
| Profile update | `updateUserProfile()`, `updateCampaignMemberProfile()` | profile pages | Firestore writes; auth fields protected by rules |
| Lifecycle | `updateUserLifecycleStatus()` | admin members page | writes `lifecycle_status` + attempts (rules-blocked) audit log |
| Protected routes | client-side redirect in `portal/layout.tsx` + per-page guards | all portal | no middleware |

**Auth listeners:** exactly one (`onAuthStateChanged` in AuthContext).

**Authorization context dependencies:** AuthContext composes `profile` + `assignments` + `grants` and exposes `hasPermission(permission, scope?)` which fails closed on access-load error (unless admin). This is the model to preserve.

**Migration-relevant facts:** no custom claims are used today; role/membership live in the Firestore profile doc. The Supabase design (Section 19) moves tenant/role into the JWT via Auth Hooks so RLS can read `auth.jwt()` without a per-request profile fetch — an important latency *and* correctness improvement.

### 3.2 Firestore — complete collection inventory

29 collections. For each: purpose, key fields, relationships, tenant/ownership fields, readers, writers, queries.

#### Identity & tenancy

**1. `users/{uid}`** — user profile. Fields: `tenant_id`, `full_name`, `email`, `phone`, `gender`, `lga_id`, `ward_id`, `polling_unit_id` (registered location), social handles (`facebook_name/url`, `x_*`, `instagram_*`, `tiktok_*`), `access_role` (`admin|member|election_officer|tenant_super_admin|platform_super_admin`), `membership_types` (array: `campaign_member`, `social_member`), `lifecycle_status` (`active|suspended|deactivated`), `onboarding_status`, `status_reason`, `points` (number), `rank` (string), timestamps. Relations: 1:N assignments, grants, submissions; geo refs. Readers: self (owner), admin same-tenant; campaign-member directory reads via `array-contains` queries; leaderboard projection reads (never raw users for members). Writers: self-create (public signup, constrained by rules), admin create/update/delete. Queries: `tenant_id ==`, `membership_types array-contains campaign_member`, `ward_id ==`, `lga_id ==`, `polling_unit_id ==`, `ward_id in [...]` (chunked ×30), `__name__ in [...]` (chunked ×30 in `getSubmissionsForTaskWithUsers`). Client-side sorting everywhere (composite-index avoidance is a recurring pattern — Postgres makes server-side ORDER BY trivial).

**2. `tenants/{tenantId}`** — tenant record. Fields: `name`, plus settings flags `election_mode_enabled`, `volunteer_registration_enabled`, `new_member_alerts`, `task_verification_alerts`, `candidate_name`, `state_id`, `campaign_active`, timestamps. Readers: signed-in users of the tenant (rules allow own-tenant read); **writes: none permitted by rules, yet `/portal/admin/settings` attempts client `setDoc`** (discrepancy: latent permission-denied bug). Queried by direct doc ID only.

**3. `organizational_assignments/{id}`** — org position at a scope. Fields: `tenant_id`, `user_id`, `position` (7 values), `scope_type` (6 values), `scope_id`, `status` (`active|inactive|suspended|expired`), `assigned_by`, `assigned_at`, `starts_at`, `ends_at`, timestamps. Readers: owner, admin. Writers: admin (coordination page, member detail page). Queries: `user_id ==` (+`status ==`), `tenant_id ==` + `user_id ==`, `position ==`, `scope_type/scope_id ==`. **Side effect:** creating/updating/deleting an assignment synchronously writes/deletes `user_access` index docs for every permission in `POSITION_DEFAULT_PERMISSIONS[position]` (`organizationalAssignments.ts writeAssignmentIndex/removeAssignmentIndex`) — the Firestore-forced denormalization that Postgres eliminates.

**4. `permission_grants/{id}`** — explicit grant/deny. Fields: `tenant_id`, `user_id`, `permission`, `granted` (bool; `false` = explicit denial), `scope_type?`, `scope_id?`, `granted_by`, timestamps. Readers: owner, admin. Writers: admin. **Side effect:** identical `user_access` sync (`permissionGrants.ts writeUserAccessIndex/removeUserAccessIndex`) in `writeBatch` flows.

**5. `user_access/{compositeId}`** — materialized authorization index. Doc ID: `{uid}__{permission}__global` or `{uid}__{permission}__{scopeType}__{scopeId}`. Fields: `user_id`, `tenant_id`, `permission`, `allowed`, `scope_type`, `scope_id`, `updated_at`. **Read by clients: never** (rules `allow read: if false`). Exists purely for rules `exists()`/`get()` checks. **→ Replaced wholesale by RLS scope-resolution (Section 17). Not migrated as data.**

#### Social / tasks / leaderboard

**6. `tasks/{taskId}`** — social tasks. Fields: title/description/action/guidelines (task UI), `points` (number), `status` (`active|inactive`), `proof_required` (implied by UI), timestamps. Readers: admin; social members (only `status == "active"`). Writers: admin. Queries: `status == "active"` + orderBy created_at.

**7. `task_submissions/{taskId}_{uid}`** — deterministic doc ID enforced by rules (one submission per task+user; resubmission allowed until verified). Fields: `task_id`, `user_id`, `proof_url`, `status` (`pending|verified`…), `submitted_at`, `verified_at`, `verified_by`. Readers: admin, owning social member. Writers: member (create/update own, rules-constrained), admin (verify). **Transaction:** `verifyTaskSubmission()` uses `runTransaction` to (a) prevent double-verify, (b) atomically `increment(points)` on the user doc — the only transaction in the app besides none; Postgres maps this to a single-statement `UPDATE ... WHERE status <> 'verified'` + trigger or a DB function in one transaction.

**8. `leaderboard_public/{uid}`** — **protected projection.** Fields exactly: `user_id`, `display_name` (or `full_name`), `points`, `rank`, `tenant_id`, `state_id`, `zone_id`, `lga_id`, `ward_id`. **Polling unit deliberately excluded.** Readers: any signed-in same-tenant user. Writers: admin only. Point mutation sources (complete list): task verification transaction (`firestore.ts`), volunteer signup (`auth.ts`), admin member creation (`auth.ts`), profile updates (`updateUserProfile`), campaign member profile updates (`campaignMembers.ts`). Synchronization: **best-effort client-side post-write `syncLeaderboardProjection()` calls** with `setDoc merge` — no triggers; known drift risk if a write path forgets to sync. Read pattern: `tenant_id ==` + orderBy `points desc` + limit(50) — a query the current rules/query model made impossible against `users` (the reason the projection exists; see reconciliation doc §L). Migration note: in Postgres this becomes a view over `profiles` (or a materialized view refreshed on write) — projection logic moves server-side; the "protected area" semantics (non-sensitive fields only, PU excluded) must be preserved in the view definition.

#### CMS / public site (tenant-keyed singleton docs)

**9. `biographies/{tenantId}`** — doc ID = tenant ID. Fields: `tenant_id`, `full_name`, `title`, `about`, `image_url`, `stats {years_experience, communities_served, volunteers}`, `social_links {facebook,x,instagram,tiktok}`, `status` (`draft|published`), timestamps. Public read; admin write (own tenant).
**10. `manifestos/{tenantId}`** — sections array (`title`, `icon`, `description`, `points[]`), intro, closing, CTAs, `pdf_url` (Cloudinary), `status`. Public read only when `published` (or admin); delete: rules `false`.
**11. `galleries/{tenantId}`** — `images[]` array (`id`, `url` (Cloudinary), `title`, `description`, `uploaded_at`). Public read; admin write. Array-item CRUD is read-modify-write of the whole doc (concurrency hazard noted for redesign).
**12. `portal_content/{tenantId}`** — combined array doc of `Announcement` (scope: general|campaign_members|social_members|election_officers|admins) and `EventData` (date, time, venue, ward, status draft/published) items. Public read (rules) — but announcements are *internal* content living in a publicly-readable doc; their filtering is client-side by scope. Legacy `events` collection (#13) also exists with `allow read: if true` and is read by the homepage.
**13. `events/{eventId}`** — legacy per-doc events; read by home page (`getUpcomingEvents`: `date >= today` orderBy asc limit 5).
**14. `news/{newsId}`** — articles. Fields: `title`, `slug`, `excerpt`, `content`, `featured_image` (Cloudinary), `category`, `status` (`draft|published|scheduled|archived`), legacy `published` boolean (dual-field compat — `normalizeNewsArticle` handles both), `published_at`, `scheduled_at`, `author`, `created_by`, `updated_by`, timestamps. Public read: `status == "published"` **or legacy `published == true`** (note: the rules do NOT constrain news reads by tenant — published news is globally public). Queries: slug+status, status, orderBy created_at.

#### Campaign operations

**15. `campaign_activities/{id}`** — fields: `tenant_id`, `title`, `description`, `activity_type` (7), `status` (4), `date`, `start_time`, `end_time`, `venue`, `scope_type`, `scope_id`, `organizer_id`, `organizer_name`, `expected_attendance`, `participants[]` (RSVP + check-in/out arrays), `created_by`, timestamps. Readers: admin; users with `view_activities` access at the doc's scope. Writers: admin; `create_activity` holders (`created_by == uid` enforced). Queries: tenant+orderBy date; **per-scope fan-out queries** — `getCampaignActivitiesForAssignments` expands each active assignment to ALL descendant scopes (`expandAssignmentToScopes`) and issues one query per scope (up to hundreds for state-level coordinators; N+1 pattern that Postgres replaces with a single scope-join query).

**16. `campaign_assignments/{id}`** — ground-work assignments. Fields: `tenant_id`, `title`, `description`, `assigned_to`, `assigned_by`, `scope_type`, `scope_id`, `priority` (4), `status` (6: not_started → completed/overdue), `due_date`, `location`, `evidence_url`, timestamps. Readers: admin, assignee (`assigned_to == uid`, matched by UID *or email*), scoped `view_assignments` holders. Writers: admin only (per rules). Queries: assigned_to, tenant+scope pairs (fan-out per descendant scope), tenant-wide.

**17. `campaign_field_reports/{id}`** — fields: `tenant_id`, `submitted_by`, `report_type` (6), `title`, `description`, `scope_type`, `scope_id`, `location`, `participants`, `issues`, `community_feedback`, `requests`, `follow_up_required`, `evidence_url`, `status` (`submitted|under_review|accepted|returned`), `reviewed_by`, `review_comment`, timestamps. Readers: admin, author, `review_field_report` scoped holders. Writers: author-create (status forced `submitted`), admin, scoped reviewers. Queries: by author; tenant+scope fan-out; tenant-wide.

**18. `issues/{id}`** — campaign issues. Fields: `tenant_id` (⚠️ `createCampaignIssue` writes `data.tenant_id ?? null` — nullability tolerated by rules `newDataSameTenant()` would deny; in practice callers pass tenant or the write fails — flag for schema NOT NULL in Postgres), `title`, `description`, `issue_type` (8), `priority` (4), `status` (6: reported→closed), `scope_type`, `scope_id`, `reported_by`, `assigned_to`, `location`, `evidence_url`, `resolution_notes`, timestamps. Readers: admin, reporter, `manage_issue` scoped holders. Writers: reporter-create, admin, scoped managers.

**19. `users` as campaign directory** — covered in #1; `getScopedCampaignMembers` implements hierarchy by query shape (PU/ward direct fields; LGA via `lga_id` + chunked ward `in` queries; state/zone/campaign → whole tenant) — another fan-out pattern Postgres collapses.

#### Election engine

**20. `election_settings/{tenantId}`** — doc ID = tenant. Fields: `active_election_cycle_id`, `active_contest_id`, `updated_by`, timestamps. Readers: all signed-in non-social-only users of tenant; social-only blocked. Writers: admin. **Fallback behavior:** if the doc is missing/permission-denied, `getElectionSettings()` returns seeded defaults (2027 cycle + first contest) without writing. Has a realtime listener (`subscribeToElectionSettings`).

**21. `election_cycles/{id}`** — fields: `tenant_id`, `name`, `year`, `description`, `status` (`DRAFT|SCHEDULED|ACTIVE|PAUSED|CLOSED|ARCHIVED`), `start_date`, `end_date`, `created_by`, timestamps. Readers: signed-in non-social-only same-tenant. Writers: admin. Seed fallback: `DEFAULT_ELECTION_CYCLE_2027` returned when empty.

**22. `election_contests/{id}`** — fields: `tenant_id`, `election_cycle_id`, `contest_type` (`presidential|governorship|senatorial|federal_house|state_house`), `name`, `scope_type` (`national|state|senatorial_zone|federal_constituency|state_constituency`), `scope_id`, `state_id`, `senatorial_zone_id`, `lga_ids[]`, `election_date`, `status` (`DRAFT|OPEN|PAUSED|CLOSED`), `collation_status` (`NOT_STARTED|IN_PROGRESS|COMPLETED|PAUSED`), `tracked_parties[]`, `participating_parties?`, `focus_party_id`, `created_by`, timestamps. Readers: non-social-only. Writers: admin. **Central invariant:** results may only be created against `status == "OPEN"` contests of the caller's tenant (rules `validElectionResultCreate`). Seed fallback for the 2027 contests exists client-side.

**23. `political_parties/{id}`** — INEC party master (18 seeded parties). Fields: `acronym`, `name`, `logo_url?`, `inec_registered`, `status`, `color?`, timestamps. **Public read** (rules `allow read: if true` — not tenant-scoped). Writers: admin. Auto-seed on first read if empty (`getPoliticalParties`).

**24. `election_candidates/{id}`** — fields: `tenant_id`, `contest_id`, `party_id`, `candidate_name`, `running_mate_name`, `status` (`active|disqualified|withdrawn`), timestamps. Readers: non-social-only. Writers: admin. Query: `contest_id ==`.

**25. `election_results/{contestId}__{pollingUnitId}`** — the heart of the engine. Deterministic doc ID. Fields: `tenant_id`, `election_cycle_id`, `contest_id`, `contest_type`, `contest_scope {scope_type, scope_id}`, `state_id`, `senatorial_zone_id`, `lga_id`, `ward_id`, `polling_unit_id`, `results[]` (`{party, votes}`), `submitted_by`, `status` (`submitted|pending_review|approved|rejected|clarification_required|reopened`), `review_notes`, `reviewed_by`, `reviewed_at`, `verified` (bool, true iff approved), `cloudinary_url` (**mandatory**), `cloudinary_public_id`, `history[]` (append-only audit: `edited_by`, `edited_at`, `action` (create|correct|review_approve|review_reject|review_clarify|reopen), old/new results, old/new status, notes, reason), timestamps. Readers: per `canReadElectionResult` — admin/officer tenant-wide; registered-PU members; scoped `view_election_results` grants at state/zone/lga/ward/PU. Writers: create per `validElectionResultCreate` (election-mode on, OPEN contest, deterministic ID, status=submitted, verified=false, EC8 evidence, submitter authorized); officer review per `officerReviewUpdate` (transition machine, immutable geo/contest/submitter keys, `verified == (status=='approved')`, votes immutable, allowed-keys allowlist); admin correction per `adminCorrectionUpdate` (votes changeable, forced `pending_review` + `verified=false`, allowed-keys allowlist); **delete: never**. Realtime: `subscribeToElectionResults` with role-based scope constraints (contest-only for admin/officer; ward+PU+contest for members).

**26. `pu_reports/{id}`** — fields: `tenant_id`, `ward_id`, `polling_unit_id`, `submitted_by`, `report_type` (`opening|turnout|conduct|closing|general`), `title`, `content`, `cloudinary_url?`, `status` (`submitted|under_review|acknowledged`), `created_at`. Readers: admin/officer tenant-wide; registered-PU; scoped `view_pu_reports` (ward/PU/global). Writers: submit per geo authorization; admin update/delete. Realtime listener with scope constraints.

**27. `election_incidents/{id}`** — fields: `tenant_id`, `ward_id`, `polling_unit_id?`, `incident_type` (6), `severity` (4), `description`, `reported_by`, `cloudinary_url?`, `status` (`reported|investigating|resolved|dismissed`), `created_at`. Same read/write authorization family as PU reports (with `view_election_incidents`/`report_election_incident` grants; PU-scoped checks conditional on field presence). Realtime listener with scope constraints.

#### Finance (private ledger)

**28. `donations/{id}`** — fields per DonationRecord type: `tenant_id`, `donor_id`, `donor_name`, `donor_phone/email/reference`, `amount`, `currency` (NGN default), `date_received` (YYYY-MM-DD), `payment_method` (`cash|bank_transfer|pos|cheque|other`), `category` (campaign_fund, event_sponsorship, logistics, …), `status` (`received|pledged|cancelled`), `external_reference`, `notes`, `lga_id`, `ward_id`, `created_by`, `created_by_name`, `updated_by`, timestamps. **Admin-only** read/write; update locks `tenant_id`, `donor_id`, `created_by` (immutability of financial identity); **delete: rules `false`** (no physical deletion of financial records). Created via `writeBatch` with donor-stats update + audit entry.

**29. `donors/{donorKey}`** — deterministic ID `donor_{normalized phone or name}`. Fields: denormalized stats `total_received_amount`, `contribution_count`, `latest_contribution_date` + identity fields + geo. Admin-only; delete: `false`. Updated inside the same batch as donations.

**30. `donation_audits/{id}`** — immutable audit per donation action (`created|updated|status_changed|cancelled`) with `changes {before, after}`. Admin-readable; create permitted (batch workflow); **update/delete: `false`**.

#### Platform

**31. `system_audits/{id}`** — fields per SystemAuditLog type: `tenant_id`, `actor_id/name/email`, `action`, `affected_resource` (10 enum values), `resource_id`, `old_value`, `new_value`, `reason_notes`, `organizational_scope`, `timestamp`. Admin-read-only; **create/update/delete: `false`** (intended server-side creation; client attempts fail silently — see discrepancy #4). Writers today: none effective.

**32. `notifications/{id}`** — fields: `tenant_id`, `type` (6), `title`, `message`, `link_url`, `target_type` (`user|role|scope|all`), `target_id`, `read_by[]` (array of UIDs), `created_by`, `created_at`. Reads: any signed-in same-tenant user (rules deliberately allow tenant-wide for compatibility; **client downloads all and filters** by target_type/target_id match against the user's id/role/ward/lga). Create: admin (`created_by == uid`). Update: only `read_by` may change, only-additive for self (rules `diff().affectedKeys().hasOnly(["read_by"])` + `hasAll` old + `hasAny` self). Delete: admin. Creator: `createNotification` from `jobs.ts` (activity reminders). Realtime listener on the whole tenant collection.

**33. `contact_messages/{id}`** — fields: `name`, `email`, `phone`, `message`, `tenant_id`, `status` (`unread|read`), `read_at`, timestamps. Create: **public** (no auth required; rules validate field types + status=unread; note create does not enforce tenant match — tenant is assigned client-side from `getCurrentTenant()`). Read/update/delete: admin. Queries: `tenant_id ==` + orderBy (with fallback query without orderBy when index missing).

**34. `electoral_data/enugu-state`** — single denormalized document: `{state: "Enugu", lgas: LGA[] (each with wards[] each with pollingUnits[]), updated_at}`. Public read; **write: `false`** (seeded only via script with service privileges or direct console access). All geographic lookups (`getAllLGAs`, `getWardByIdAsync`, etc.) fetch this entire document and traverse in memory (multi-MB reads on every lookup; a primary scalability driver for relational geography — Section 9).

**Not collections but related:** composite-index avoidance patterns (client-side sorts), seed fallbacks for `election_cycles`/`contests`/`parties` (client-side defaults when collections are empty — to be replaced by real migrations/seed SQL).

### 3.3 Firestore realtime (`onSnapshot`) inventory

| # | Listener | File | Scope | Verdict |
|---|---|---|---|---|
| 1 | Election results | `election.ts subscribeToElectionResults` ← election dashboard, operations desk, export page, admin health, global search | tenant (+contest/ward/PU constraints by role) | **Keep realtime** — live collation is a product feature |
| 2 | PU reports | `subscribeToPUReports` ← pu-reports page | tenant or ward+PU | **Keep realtime** — election-day ops |
| 3 | Election incidents | `subscribeToElectionIncidents` ← incidents page | tenant or ward+PU | **Keep realtime** — election-day ops |
| 4 | Election settings | `subscribeToElectionSettings` ← (available; settings doc) | tenant doc | **Drop** — single admin-managed doc; refetch on change is sufficient |
| 5 | Notifications | `subscribeUserNotifications` ← portal layout | **entire tenant collection, client-filtered** | **Redesign** — per-user rows (see Sections 21, 26); realtime optional afterward |

No realtime on leaderboard (polled on page load), no realtime on campaign modules (fetch-on-mount).

### 3.4 Firebase Storage

`src/lib/firebase/storage.ts` defines `uploadFile`/`getFileURL`; **zero importers**. No `storage.rules` file exists; `firebase.json` configures no storage emulator. **Verdict: remove — no migration required.** All actual media flows through Cloudinary.

### 3.5 Firebase Admin / Server SDK

`firebase-admin@14.3.0` in `package.json` dependencies; **never imported**. `firebase.json` declares a functions emulator port but there is **no `functions/` directory**. **Verdict: remove dependency; no code migration.** Its *intended* roles (trusted audit writes, scheduled jobs) become Supabase Edge Functions / pg_cron / triggers (Section 15).

### 3.6 Cloudinary (adjacent, not Firebase)

`src/lib/cloudinary.ts` — unsigned client-side uploads. Folders: `ifeanyi-2027/news`, `/gallery`, `/candidate`, `/election-results`, `/pu-reports`, `/incidents` (+ manifesto PDFs under candidate). Consumers: admin news/gallery/biography/manifesto editors; election upload (EC8 evidence — **mandatory** per rules and `submitElectionResultWithEvidence`), PU reports, incidents. **Verdict: retain** (Section 20).

---

## 4. Current Data Model

### 4.1 Entity-relationship summary (as implemented)

```text
tenants ──┬── users (tenant_id) ──┬── organizational_assignments (user_id, scope)
          │                       ├── permission_grants (user_id, permission, scope?)
          │                       ├── task_submissions (user_id) ── tasks
          │                       ├── leaderboard_public (user_id, non-sensitive projection)
          │                       └── notifications (target user/role/scope/all)
          │
          ├── tenants settings flags (same doc)
          │
          ├── biographies / manifestos / galleries / portal_content (doc ID = tenantId)
          ├── election_settings (doc ID = tenantId) → active cycle/contest
          │
          ├── election_cycles ── election_contests ──┬── election_candidates (contest_id, party_id)
          │                                          └── election_results (contest_id + polling_unit_id,
          │                                                geo denorm: state/zone/lga/ward/PU, history[])
          │
          ├── campaign_activities (scope) / campaign_assignments (assigned_to, scope)
          │   / campaign_field_reports (submitted_by, scope) / issues (reported_by, scope)
          │
          ├── donations ──┬── donors (denormalized stats, deterministic key)
          │               └── donation_audits (donation_id, immutable)
          │
          ├── system_audits (actor, resource)   [intended server-write]
          └── contact_messages (public create, admin read)

electoral_data/enugu-state (singleton denormalized geo tree; referenced by ID everywhere)
political_parties (global reference data, public read)
user_access (materialized index; exists only for rules; not app data)
```

### 4.2 Modeling observations that shape the Postgres design

1. **Tenant field conventions vary:** most collections carry `tenant_id`; CMS singletons encode tenant in the **document ID**; `political_parties` and `news` have **no tenant scoping at all** (globally shared/global public). The Postgres schema normalizes all of this to a `tenant_id` column with a deliberate exception list (party master data, platform reference data).
2. **Geographic identity is denormalized into operational docs** (election results carry the full chain `state_id → senatorial_zone_id → lga_id → ward_id → polling_unit_id`; profiles carry ward+PU; leaderboard projection carries state/zone/lga/ward). This denormalization exists to let rules do per-document checks — in Postgres it is **redundant** (joins resolve it), but *keeping* denormalized columns on high-volume tables (election_results) is still worthwhile for index locality and audit stability; the difference is that consistency becomes enforceable by FK constraints instead of being aspirational.
3. **Arrays that are really relations:** `results[]` (party/votes), `history[]` (audit), `participants[]` (RSVP/check-ins), `read_by[]`, `membership_types[]`, `lga_ids[]`, `tracked_parties[]`, `images[]`, `items[]` (portal_content). Postgres: proper child tables for results/history/participants/notifications-read; genuinely list-valued attributes (tracked_parties, membership_types, lga_ids) may remain Postgres arrays where no per-row authorization depends on them.
4. **Deterministic document IDs encode invariants:** `task_submissions/{taskId}_{uid}` (one submission per task per user), `election_results/{contestId}__{pollingUnitId}` (one result per PU per contest), `donors/donor_{key}` (donor identity). In Postgres these become **unique constraints** — strictly stronger, because the DB refuses violations rather than rules rejecting writes.
5. **Status machines are implicit** in rules transitions (election results, reports, issues, submissions). Postgres: CHECK constraints + transition-enforcing update functions (Section 16/17).
6. **Singleton tenant docs** (biographies, manifestos, galleries, portal_content, election_settings) become one-row-per-tenant tables with unique tenant_id.
7. **Client-side seed fallbacks** (2027 cycle/contests/parties hardcoded in `election-seed.ts`) become idempotent seed SQL.

---

## 5. Current Authorization Model

### 5.1 The chain (as the brief states it — verified in code)

```text
User (Firebase Auth uid)
  ↓ owns
Profile in tenants  →  users/{uid} with tenant_id
  ↓ declares
access_role  →  admin | member | election_officer | tenant_super_admin | platform_super_admin
  ↓ declares
membership_types  →  campaign_member, social_member (array; both possible)
  ↓ granted explicitly
PermissionGrant  →  permission_grants (permission, granted true/false, optional scope)
  ↓ materialized for rules
user_access  →  composite-ID index docs (authorization enforcement representation)
  ↓ positions user in the organization
OrganizationalAssignment  →  position × scope (status active)
  ↓ anchored to
Geographic scope  →  campaign | state | senatorial_zone | lga | ward | polling_unit
```

### 5.2 Resolved semantics (all preserved as product decisions)

1. **`access_role` is system capability.** `admin`/`tenant_super_admin`/`platform_super_admin` = tenant-wide application authority; `election_officer` = fixed election-domain permission set (`view_dashboard`, `submit_election_pu_report`, `submit_election_incident`, `upload_election_result`, `view_election_dashboard` per `permissions.ts`); `member` = ordinary. Organizational positions are **never** stored in `access_role`.
2. **Membership ≠ authority.** `membership_types` gates *eligibility surfaces* (social tasks/leaderboard for social; campaign council + election reporting eligibility for campaign). It never by itself grants scoped data access.
3. **Social-only members have zero Election access** — enforced in rules (`isSocialOnly()` guard on every election collection), in portal navigation (group hidden), and by page-level redirects.
4. **Campaign members may access Election** only through: registered location (`ward_id`+`polling_unit_id` on profile → `registeredAt()`), valid `user_access` grants (global or scoped), or by being admin/officer.
5. **Election results are not Admin-only.** Visibility: admin/officer tenant-wide; campaign members at registered PU; any holder of scoped `view_election_results` at state/zone/lga/ward/PU granularity.
6. **Separation of duties in the result workflow:** officers review/approve/reject/clarify/reopen but **cannot change votes**; admins can correct votes but **cannot approve** — correction forces `pending_review`/`verified=false` for officer re-verification. The operations desk is officer-only (admin is redirected); the election dashboard hosts admin corrections.
7. **Permission grants and materialized access are distinct concepts** (grant = administrative record with grant/deny semantics including explicit denial; `user_access` = enforcement index). The distinction is Firestore-era implementation, not product semantics: in Postgres, grants are the single table and the "index" is a query (Section 17). The **explicit-denial semantics** (a `granted:false` grant overriding position defaults) must be preserved in the resolver.
8. **Position defaults are a permission matrix in code** (`POSITION_DEFAULT_PERMISSIONS`, `permissions.ts`): member positions carry view/create/submit rights at their scope; coordinators add review/manage/assign rights; `campaign_manager`/`council_chairman` intentionally carry **zero** position permissions — administrative authority flows from `access_role`, never from the title. In Postgres this matrix becomes reference data (`position_permissions`) so it is data, not code.
9. **Geographic hierarchy with inherited scope:** State/Campaign covers everything; Zone covers zone+descendants; LGA covers lga+wards+PUs; Ward covers ward+PUs; PU covers itself. Client resolution: `isScopeDescendant()`/`assignmentCoversScope()`; rules resolution: exact `user_access` lookups *at the resource's own scope* (hierarchy expansion is achieved by writing descendant index entries — `expandAssignmentToScopes` fan-out — not by rule logic). Ward→PU implication ("ward scope can imply access to its PUs where product rules permit") is exactly this expansion behavior, preserved.
10. **Registered location is its own authorization path** (`registeredAt`), distinct from assignments, and also drives the member-directory default scope (PU/ward) for unassigned members.
11. **Election mode gate:** result creation requires `tenants/{tenant}.election_mode_enabled == true` (rules). UI does not read this flag today (hardcoded `true` — discrepancy #6).

### 5.3 Where enforcement lives

| Layer | What it checks |
|---|---|
| Firestore rules | the only server boundary: tenant match, role, membership, ownership, `user_access` lookups, election invariants, immutable-key allowlists, delete prohibitions |
| `AuthContext.hasPermission` | client UX gating (nav, buttons, page guards); fails closed on load error |
| Page-level checks | role redirects (operations desk officer-only; admin election config admin-only; social-only redirects) |

**Rules that exist purely because of Firestore's model** (candidates to *disappear* in Postgres rather than be copied):
- The entire `user_access` collection + `globalAccessId`/`hasGlobalAccess`/`hasScopedAccess`/`hasAccess` rule functions.
- Deterministic-ID enforcement in rules (`resultId == contest_id + "__" + polling_unit_id`; `submissionId == task_id + "_" + uid`) — replaced by unique constraints.
- Per-document denormalized geo-chain checks (`canReadElectionResult`'s five scoped branches; `registeredAt()` compare against denormalized fields) — replaced by join-based scope functions.
- Immutable-key `diff().affectedKeys().hasOnly([...])` allowlists — replaced by column-level grants/trigger guards.
- `electionModeEnabled()` `get()` into tenants from within every result create — replaceable by a join or a settings read in a SECURITY DEFINER function.
- Public-read workarounds for the CMS singletons (`allow read: if true` on galleries/portal_content/events, which over-exposes announcements) — replaced by row-level visibility (draft/published + audience scoping).
- The notifications tenant-wide read compatibility rule — replaced by per-user rows.

**Rules that DO encode product semantics to keep (as RLS):** tenant isolation everywhere; admin/officer/member role gates; social-only election block; ownership rules (own submissions, own profile auth-fields lock); election result state machine; donation delete prohibition; audit immutability.

---

## 6. Current Tenant Assumptions

- **Single hardcoded tenant:** `CURRENT_TENANT_ID = "ifeanyi-2027"` (`tenants.ts`), duplicated in `devseed.ts`, donation/audit/notifications modules (`TENANT_ID` constants), and seed fallbacks. Multi-tenant resolution exists only as a placeholder (`getTenantBySubdomain` — a doc-ID lookup, marked "for future").
- **Tenant identity is written client-side** into every create (`getCurrentTenant()` or the constant). Rules then require `request.resource.data.tenant_id == callerTenantId()` — so a user can only ever write their own tenant's ID, which is what makes client-side assignment safe *today*. In Postgres, tenant resolution must move server-side (JWT claim → RLS), never trusting client input (Section 17).
- **Tenant scoping is uneven** (Section 4.2): CMS singletons via doc-ID; `political_parties` global; `news` public-read without tenant check; `contact_messages` create without tenant validation; `events` legacy without tenant fields.
- **`users` are tenant members**, not global identities — a future platform user could exist in multiple tenants; current model assumes exactly one tenant per profile.
- **Test infrastructure already models two tenants** (`TENANT_A`/`TENANT_B` in `tests/rules/helpers/test-env.ts`) — the cross-tenant denial contract exists as executable tests and carries over directly to RLS tests.

---

## 7. Module-by-Module Migration Analysis

Legend: **Migrate** = direct port; **Redesign** = port with structural change; **Retain** = keep external service as-is; **Remove** = drop.

### 7.1 Public site

| Feature | Current | Analysis | Verdict |
|---|---|---|---|
| Home | Server component reading news + tenant + portal events | RSC reads move to Supabase client/SSR fetches; published-only visibility via RLS | Migrate |
| News list/detail | slug queries with legacy `published` boolean compat | normalize to single `status`/`published_at` in Postgres; drop legacy field during backfill | Migrate |
| Biography / Manifesto / Gallery | tenant singleton docs, draft/published | one-row-per-tenant tables; RLS: public sees published only | Migrate |
| Contact | public anonymous create; admin inbox | RLS: anon insert policy (validated), admin read | Migrate |
| Events (legacy `events` + portal_content events) | two event sources | consolidate to one `events` table (portal_content array split) | Redesign |
| Public electoral info | `electoral_data` singleton | relational geography tables (Section 9) | Redesign |
| Site config | none (hardcoded strings: candidate name, countdown, SEO defaults in components) | becomes Control Center public-site settings (Section 12) | Build-after |

### 7.2 Identity / portal

| Feature | Analysis | Verdict |
|---|---|---|
| Auth (sign-in/out, signup, admin-create) | Supabase Auth replaces Firebase Auth; admin-created users via service-role Edge Function (replaces the secondary-app trick); password reset becomes standard Supabase flow (an improvement) | Migrate |
| Profiles | `profiles` table keyed to `auth.users.id`; auth-fields lock via trigger | Migrate |
| Social member surface | tasks + submissions + leaderboard (below) | Migrate |
| Campaign member surface | Section 7.3 | Migrate |
| Admin surface | Section 7.5 | Migrate |
| Election officer surface | Section 8 | Migrate |
| Notifications | redesign to per-user rows; realtime optional | Redesign |
| Portal guidance (help) | static content (`help-content.ts`) — no data dependency | Migrate (unchanged) |

### 7.3 Organization

| Feature | Analysis | Verdict |
|---|---|---|
| Geography (states/zones/LGAs/wards/PUs) | relational tables; the client fan-out reads disappear | Redesign (Section 9) |
| Organizational assignments | table + status; `user_access` sync code paths deleted | Migrate |
| Permission grants | table; explicit-deny semantics preserved; grant evaluation moves server-side (RPC) | Migrate |
| Position permission matrix | code constant → `position_permissions` reference table | Redesign |
| Coordination page | admin UI over assignments+grants; its **direct SDK queries** normalized into service layer | Migrate |

### 7.4 Campaign

| Feature | Analysis | Verdict |
|---|---|---|
| Activities | table + `activity_participants` child table; scope-filtered reads become single join queries | Migrate |
| Assignments | table; assignee identity normalizes to user UUID only (drop email-matching fallback) | Migrate |
| Field reports | table; status transitions in update function | Migrate |
| Issues | table; `tenant_id NOT NULL`; status machine | Migrate |
| Task submissions / verification | unique(task,user); atomic verification as DB function replacing `runTransaction` | Migrate |
| Leaderboard | Section 10 | Redesign |
| Scope-expanded reads (fan-out queries) | replaced by scope-join RPC/views | Redesign |

### 7.5 Administration

| Feature | Analysis | Verdict |
|---|---|---|
| Member management | profiles CRUD via admin RLS; lifecycle audit finally works (server-side trigger writes audit) | Migrate |
| Audit logs | `system_audits` becomes server-written (trigger or Edge Function on privileged actions); admin read-only | Redesign |
| Donations | Section 11 | Migrate |
| Contact inbox | straightforward | Migrate |
| Reports/analytics page | client-side aggregation over full-collection fetches → SQL aggregates (fast, cheap) | Redesign |
| System health | calls jobs + reads settings; jobs become pg_cron/Edge Functions | Redesign |
| Tenant settings | `/portal/admin/settings` currently rules-blocked; becomes real `tenant_settings` writes via admin RLS | Redesign |
| Direct-SDK pages (tasks, settings, coordination) | normalize into data services during migration | Migrate |

---

## 8. Election Engine Analysis

### 8.1 Domain model (verified)

```text
ElectionCycle (tenant, year, status DRAFT→SCHEDULED→ACTIVE→PAUSED→CLOSED→ARCHIVED)
   └── ElectionContest (type: presidential|governorship|senatorial|federal_house|state_house
                        scope: national|state|senatorial_zone|federal_constituency|state_constituency
                        status: DRAFT|OPEN|PAUSED|CLOSED, collation_status, tracked_parties[], focus_party)
          ├── ElectionCandidate (party_id → political_parties, status active|disqualified|withdrawn)
          └── ElectionResult (one per contest × polling unit; deterministic identity
                results[] {party, votes}, status machine, verified flag,
                cloudinary evidence (mandatory), history[] append-only)
PUReport (ward × PU; type opening|turnout|conduct|closing|general; evidence optional)
ElectionIncident (ward × PU?; type × severity; evidence optional)
ElectionSettings (tenant singleton: active cycle + active contest)
```

**Multiple simultaneous contests is already the architecture** — the data model, dashboard contest selector, per-contest tracked parties, per-contest scope validation, and deterministic result identity all assume many contests per cycle across the five contest types. The Postgres schema must preserve this (contest-scoped results, no "the election" singular assumption).

### 8.2 Lifecycle rules (as enforced today by rules + service code)

- **Create:** election mode on; contest exists, same tenant, `OPEN`; doc ID = `contest__PU`; `status: submitted`, `verified: false`; `submitted_by == auth.uid`; results is a list; **EC8 `cloudinary_url` mandatory non-empty**; submitter is admin/officer OR registered at that ward+PU OR holds scoped `submit_election_result`. Client additionally validates PU within contest scope (upload page, J-E2-2) and the service re-fetches the contest to verify `OPEN` before writing.
- **Officer review (transitions, `validOfficerTransition`):** `submitted|pending_review → approved|rejected|clarification_required`; `clarification_required → submitted|pending_review` (resubmission path); `approved → reopened`; `reopened → approved|rejected|clarification_required`; `rejected → submitted|pending_review`. Constraints: officer-only; immutable geographic/contest/submitter keys; `reviewed_by == auth.uid`; `verified == (status == approved)`; votes immutable; only `status, verified, review_notes, reviewed_by, reviewed_at, history, updated_at` may change.
- **Admin correction:** admin-only; may change `results` votes; forced to `pending_review` + `verified: false`; immutable identity keys; only `results, status, verified, history, updated_at` may change. **Admin cannot self-approve** — the correction path and officer path are mutually exclusive by rule design.
- **Delete:** prohibited for everyone, always.
- **History:** every mutation appends an entry (actor, action, timestamps, before/after votes, status changes, notes/reason) — an embedded audit trail that Postgres models as `election_result_history` rows written in the same transaction.

### 8.3 Firestore queries/listeners used by the Election module (complete)

| Operation | Pattern |
|---|---|
| Settings read | doc get by tenant ID (+ onSnapshot listener) |
| Cycles list | `where tenant_id ==` (empty → client seed fallback) |
| Contests by cycle | `tenant_id ==` + `election_cycle_id ==` (empty → seed fallback) |
| Parties | full-collection get (public; auto-seed if empty) |
| Candidates | `contest_id ==` |
| Results read | `onSnapshot` with role-based constraint combos: tenant+contest+ward+PU / tenant+contest / tenant+ward+PU / tenant-only |
| Results write | deterministic-ID `setDoc` (create); `updateDoc` (review/correction) |
| PU reports | `addDoc` create; `onSnapshot` tenant or ward+PU |
| Incidents | `addDoc` create; `onSnapshot` tenant or ward+PU |
| Aggregations | **client-side in-memory** over fetched result docs (party totals, coverage %, leading party/margin, ward chart data) — only `approved` results count officially |

### 8.4 Migration notes

- All five contest types and contest scopes map to reference enums + FK constraints; `lga_ids[]` (federal/state constituency membership) stays an array with a note that a constituency→LGA join table is the cleaner long-term form (decide in Phase 1).
- The result state machine becomes a DB-enforced transition function; the immutable-key allowlists become column-level protections (officer role may update only its columns; admin correction function is the only writer of vote columns, and it always emits history).
- Approved-only aggregation moves into SQL views (`election_result_totals`) — official numbers come from one definition, not per-page JS.
- Realtime: keep Supabase Realtime on results/PU reports/incidents for election-day; scope channels per tenant + contest.
- Seed fallbacks (2027 defaults) become seed SQL migrations — the client never fabricates data again.
- Officer/admin separation is preserved exactly (product decision, not implementation detail).

---

## 9. Geography Analysis

### 9.1 What the repository actually contains (verified)

- **Implemented data:** `src/data/electoral.ts` hard-codes **Nkanu West LGA only — 14 wards, 205 polling units** (each ward 7–30 PUs; IDs like `nkanu-west-ward-01-pu-014`). This is the fallback used by `permissions.ts`, `constants.ts`, dashboards, and the permission resolver when Firestore data is absent.
- **The full-state dataset is NOT in the repository.** `scripts/seed-electoral-data.ts` parses a `/lgas/` directory of per-LGA TS files (`Nkanu_West_PUs.ts` pattern) that **does not exist on disk** — the script throws "Directory not found" as the repo stands. The claimed **17 LGAs / 260 wards / 4,145 PUs** therefore *cannot be verified from this repository* and likely lives in a non-committed local folder or is aspirational. Documentation (`docs/remediation-state.md` via the truth audit) asserts it was implemented; the artifact is absent.
- **Runtime shape:** `electoral_data/enugu-state` single document `{state, lgas: [{id, code, name, wards: [{id, code, name, pollingUnits: [{id, code, name}]}]}]}`. Public read, never client-writable.
- **Consumption patterns:** entire-document fetch + in-memory traversal on nearly every page that needs a ward/PU name (profiles, dashboards, campaign pages, election pages); permission hierarchy expansion (`expandAssignmentToScopes`) walks this tree client-side; campaign member scoping queries wards by ID chunks derived from the tree; election upload validates PU-in-contest-scope against it.
- **Hierarchy in the scope system:** `ScopeType = polling_unit | ward | lga | senatorial_zone | state | campaign`. Zones exist only as a scope label — **no senatorial-zone entities exist in the data** (no zone IDs/names anywhere; contest seeds reference `enugu-east` as a zone ID but the geography tree has no zones). **The relational model must introduce `senatorial_zones` as first-class entities.**

### 9.2 Implications for the Postgres model

1. **Tables:** `states`, `senatorial_zones`, `lgas`, `wards`, `polling_units` with strict FK chain and `(parent_id, code)` uniqueness. INEC PU codes are only unique within a ward; ward codes only within an LGA — encode via composite unique keys.
2. **Denormalized convenience columns** (e.g. `polling_units.lga_id`, `wards.lga_id`) for cheap RLS scope checks — allowed to be *derived* (enforced by triggers or generated through joins in views) rather than trusted input.
3. **Seeding as SQL migration** — the geography is reference data, not user content: public read (anon), no client writes, version-controlled seed files. The missing `/lgas/` source must be recovered from the previous machine/backup or re-exported from INEC lists **before** Phase 1 data migration; this is a hard prerequisite (Section 29, Risk R1).
4. **Authorization dependency:** scope resolution in RLS joins `organizational_assignments → scope → geography chain` (recursive or ltree) instead of client-side tree walks. The client keeps only presentational lookups.
5. **Profile registration** (`ward_id`, `polling_unit_id`) becomes FK-enforced — impossible to register a member at a nonexistent PU (currently only UI-validated).
6. The home page's "17 LGAs" figure is display copy, not data — unaffected.

---

## 10. Leaderboard Analysis

*(Protected area — documented as-is; only the port is described, no redesign of semantics.)*

- **`leaderboard_public`** is a per-user projection document with exactly: `user_id`, `display_name`, `points`, `rank`, `tenant_id`, `state_id`, `zone_id`, `lga_id`, `ward_id` — **polling unit deliberately excluded** (tested in `business-rules.test.ts`: "Leaderboard projection explicitly EXCLUDES Polling Unit ID").
- **Point mutation sources (complete):** task verification transaction (sole authorized points `increment`); the projection is additionally (re)written on: volunteer signup, admin member creation, profile update, campaign-member profile update.
- **Projection behavior:** `syncLeaderboardProjection()` `setDoc(..., {merge: true})` — idempotent upsert of the full non-sensitive field set.
- **Synchronization:** entirely client-side, best-effort (try/catch with warnings), immediately after each qualifying write. **No trigger, no queue** — a missed sync call leaves the projection stale until the next qualifying write. This is the current architecture's accepted weakness; document, don't fix now.
- **Read access:** any signed-in same-tenant user; `tenant_id ==` + `orderBy points desc` + `limit(topN=50)`.
- **Write access:** rules allow admin-only writes; **in practice the client performs the writes** under admin sessions (projection syncs run on admin actions) or at signup (where the creator is the owner — the rules permit admin-only writes, so signup-time sync by a fresh member is likely denied silently and backfilled later by admin actions; another known oddity of the projection approach).
- **Security boundaries:** the projection is the privacy boundary — private profile data (email, phone, PU, handles) never enters it; raw `users` are never readable for leaderboard purposes.

**What must change when moving to PostgreSQL (port, not redesign):**
1. `leaderboard_public` → a **view** (or materialized view) over `profiles` selecting exactly the same non-sensitive columns — the projection's privacy guarantee becomes structural (columns absent = leak impossible) instead of sync-discipline.
2. Point mutation → single atomic `UPDATE profiles SET points = points + N` inside the verification DB function (transaction replaces `runTransaction`).
3. Sync-at-write code paths (5 call sites) are deleted; the view is always correct.
4. RLS: tenant-scoped read for authenticated members; no client writes at all.
5. Keep `zone_id/lga_id/ward_id` columns in the view (used for scope-scoped rankings) minus PU — preserving the deliberate exclusion.
6. If materialized: refresh on write via trigger (pg_cron not needed; volume is small). Choose view vs matview in Phase 1 after load testing; semantics identical.

---

## 11. Donation Ledger Analysis

**Product decision preserved:** this is **NOT public donation collection**. It is a private, Admin-only audit/analytics ledger for donations already received by the candidate/campaign offline. No member or public user can create or view donations; nothing here charges money.

- **Donors (`donors`)** — identity: `full_name`, `phone`, `email`, `reference_identifier`, geo (`lga_id`, `ward_id`); denormalized stats: `total_received_amount`, `contribution_count`, `latest_contribution_date`. Deterministic key `donor_{normalized(phone|name)}` provides fuzzy dedupe (no auth identity involved — donors are not users).
- **Donations (`donations`)** — `amount` (≥0 per rules), `currency` (NGN), `date_received` (YYYY-MM-DD string), `payment_method` (cash | bank_transfer | pos | cheque | other), `category` (campaign_fund | event_sponsorship | logistics | … free-form), `status` (received | pledged | cancelled), `external_reference` (receipt/reference), `notes`, `lga_id`, `ward_id`, attribution (`created_by`, `created_by_name`, `updated_by`). Updates lock `tenant_id`, `donor_id`, `created_by` (financial identity immutable). **Delete prohibited** (rules `false`) — corrections happen through updates + audit.
- **Donation audits (`donation_audits`)** — immutable log: `action` (created | updated | status_changed | cancelled), `performed_by(_name)`, `details`, `changes {before, after}` for amount/status/method. Update/delete prohibited.
- **Atomicity:** donor upsert + donation insert + audit insert in one `writeBatch` (create); donor-stat recalculation + donation update + audit in one batch (update). Status/amount changes recalculate donor totals arithmetically (received-vs-pledged logic: only `received` amounts count).
- **Dashboard summaries:** admin page aggregates client-side (totals by status/category/method/geo) over full-collection fetch → becomes SQL aggregate views.
- **Authorization:** admin-only read/write; `view_private_donations`/`manage_private_donations` permissions exist in the permission vocabulary but the rules rely on `isAdmin()` — keep both aligned in RLS (admin bypass + grant-based access if product later wants finance officers).
- **Postgres port:** three tables with FKs (`donations.donor_id → donors`), CHECK constraints (amount ≥ 0, enum statuses/methods), a `create_or_update_donation` DB function reproducing the batch atomically (donor upsert + stats recompute from an aggregate query instead of arithmetic drift-prone increments + audit insert), and `REVOKE DELETE` (or trigger-blocked delete + immutable audit rows). Retain donor natural-key dedupe as a unique constraint on `(tenant_id, donor_key)`.

---

## 12. Central Control Center Architecture

*(Identified only — implementation is out of scope until after migration.)*

### 12.1 Where settings live today (complete inventory)

| Setting | Current location | Consumer(s) |
|---|---|---|
| Tenant name | `tenants/{id}.name` | tenant display |
| `election_mode_enabled` | `tenants/{id}` | **firestore.rules** (result-creation gate); UI hardcodes `true` (discrepancy #6) |
| `volunteer_registration_enabled` | `tenants/{id}` | settings page only (not enforced elsewhere) |
| `new_member_alerts`, `task_verification_alerts` | `tenants/{id}` | settings page only (no consumer wired) |
| Active cycle / active contest | `election_settings/{tenantId}` | election dashboard/upload/operations defaults; admin configurator |
| Countdown target | hardcoded in `ElectionCountdown.tsx` | home page |
| Candidate identity (name, party, image, hero copy) | hardcoded in `page.tsx` / `layout.tsx` metadata / Footer/Header | public site |
| Manifesto/biography/gallery publication status | their own docs | public visibility |
| `CURRENT_TENANT_ID` | code constant (`tenants.ts`) | everything |
| Emulator switch | `NEXT_PUBLIC_USE_FIREBASE_EMULATORS` | config |
| Announcement scopes / portal content | `portal_content/{tenantId}` | portal bell |
| Help content | `help-content.ts` (static) | ContextualHelp |

### 12.2 Proposed Control Center configuration map

```text
platform_settings            (singleton — platform operator only)
  platform_identity          (platform name, support contact)
  system_behavior            (maintenance_mode, registration_global_toggle)
  feature_flags              (governance_module, multi_tenant_onboarding, ...)
  maintenance                (banner text, enabled)

tenant_settings              (one row per tenant — Tenant Admin authority)
  platform
    tenant_identity          (name, slug, state_id, candidate_name, election_mode_enabled)
    system_behavior          (volunteer_registration_enabled, lifecycle defaults)
    feature_flags            (election_module, leaderboard, donations_module, ...)
  maintenance                (tenant-level banner)
  portal
    dashboard_behavior       (default landing per role, guidance visibility)
    notifications            (new_member_alerts, task_verification_alerts, reminder_window_hours)
    module_visibility        (campaign council, election ops, leaderboard, donations)
  campaign
    activity_config          (types enabled, RSVP/check-in toggles)
    task_config              (proof-url rules, point defaults, verification workflow)
    leaderboard_config       (topN, scope views enabled, rank thresholds)   ← respects protected semantics
  integrations
    cloudinary (folder prefix), future keys

public_site_settings         (one row per tenant — Tenant Admin / CMS authority)
  branding                   (logo_url, colors, fonts)
  homepage                   (hero copy, stats, countdown_target, featured sections)
  navigation                 (menu items, order, visibility)
  footer                     (text, links)
  contact_information        (email, phone, address, map)
  social_links               (facebook, x, instagram, tiktok)
  seo                        (titles, descriptions, og image, site_url)

election_settings            (one row per tenant — ELECTION-DOMAIN, stays domain-specific;
                              NOT folded into Control Center beyond a launcher link)
  active_election_cycle_id, active_contest_id, collation behavior flags
```

**Principles:** (1) one `*_settings` table per authority domain, each with a typed JSONB `value` + zod-validated writer, or explicit columns for stable fields — decide per table in Phase 1; (2) domain engines (Election) keep their own settings; Control Center surfaces them read-only/launch links; (3) every settings write lands in `system_audits`; (4) all settings read server-side via RLS-guarded selects, replacing hardcoded constants (candidate identity, countdown, election mode).

---

## 13. Governance Architecture

*(Planned post-election domain. Outline of integration relationships only — no workflows invented.)*

### 13.1 What the current architecture must be capable of supporting

The multi-tenant core (tenants, members, geographic hierarchy, RLS scope model, notification engine, audit trail, CMS/public-site settings) is exactly the substrate Governance needs. Required capabilities mapped to what exists:

| Governance area (expected) | Existing substrate it builds on |
|---|---|
| Citizen engagement / requests / constituency issues | issues pattern (scoped, typed, prioritized, statused, geo-anchored) + public identity model |
| Official responses | report-review pattern (author + reviewer roles, status machine, audit) |
| Projects / project monitoring | activity pattern (scope, dates, participants, status) + media evidence |
| Manifesto commitments + progress | manifestos (structured sections/points) + a progress-tracking child entity |
| Public updates | news/announcements pattern with published/draft + audience scopes |
| Consultations / surveys / petitions / town halls | none existing — new domain tables, tenant-scoped, geo-scoped, RLS from day one |
| Accountability/transparency info | public_site_settings + published-status pattern |
| Notifications | redesigned per-user notification rows (Section 21) |

### 13.2 Relationships the schema must be able to support (non-prescriptive)

```text
tenants 1─* governance_requests (citizen, geo scope, category, status)
governance_requests 1─* governance_responses (official author, body, published flag)
tenants 1─* governance_projects (geo scope, status, timeframe)
governance_projects 1─* governance_project_updates (monitoring entries, evidence)
manifesto_sections/points 1─? governance_commitments (link commitment → progress entries)
governance_events (consultations, town halls) — schedule + geo scope + audience
governance_feedback (survey/petition submissions — citizen-identity model TBD)
notifications (per-user) ← generated by all of the above
system_audits ← all state transitions
```

**Constraints to honor:** everything tenant-scoped with `tenant_id` + RLS from the first table; geography FK-linked (reuse `wards`/`polling_units`/`lgas`); citizens are a new identity class (distinct from campaign members — the users/membership model must not be contorted to fit citizens; design a `citizens`/public-identity concept in the Governance design phase); publication/visibility uses the same published/audience machinery as the CMS. **No Governance tables are created in Phase 1** — the schema above is a capability checklist for the future design.

---

## 14. Proposed Multi-Tenant Architecture

### 14.1 Target model

```text
Platform (operator, platform_settings, platform_super_admin)
   ↓
Tenant (campaign/governance organization; tenant_settings, public_site_settings)
   ↓
Users (auth identities; profiles)
   ↓
Membership / Roles / Permissions
   (tenant_memberships: membership_types; access_role on profile;
    permission_grants; position_permissions reference data)
   ↓
Organizational Assignments (position × geographic scope, active status)
   ↓
Geography (states → senatorial_zones → lgas → wards → polling_units; FK chain)
   ↓
Domain Data (campaign, election, donations, CMS, governance-later — every row tenant_id)
```

### 14.2 Isolation strategy decision

| Option | Assessment for PolitiCore |
|---|---|
| **Shared schema + `tenant_id` + RLS** ✅ | One database; every tenant-owned table carries `tenant_id`; RLS policies enforce isolation at the engine level; cross-tenant platform administration (platform_super_admin) is a simple policy bypass; analytics across tenants are plain SQL; onboarding a new political organization = one `tenants` row + settings defaults; migrations apply once; dev simplicity (one schema to evolve); Supabase-native (Auth + Realtime + Storage all key on a single DB). |
| Separate schemas per tenant | Isolation is stronger but everything above becomes painful: cross-schema migrations (N×), no easy platform-wide views, connection-pool/search_path complexity, Supabase tooling assumes one schema. Justified only for hard compliance boundaries — none exist here. |
| Separate databases/projects per tenant | Maximum isolation, maximum operational cost: N projects to deploy/migrate/monitor, no cross-tenant analytics, auth/keys per tenant. Unjustifiable for a pre-launch platform expecting tens—not thousands—of tenants. |

**Recommendation: shared schema + `tenant_id`, with RLS as the non-negotiable enforcement layer.** Reasoning specific to PolitiCore:

- **Security:** RLS in Postgres is evaluated by the database itself on every query — strictly stronger than Firestore rules (which also run per-access) *and* vastly easier to test (SQL-level, no expression limits — the current rules already brush against Firestore's expression-limit issues, per regression tests in `tests/rules/election-results.test.ts`). Cross-tenant leakage becomes structurally impossible for any query not deliberately run with elevated privileges.
- **Maintainability:** deletes `user_access`, the index-sync code, per-scope fan-out queries, and client-side seed fallbacks; replaces four sync paths with one resolver function; single migration stream.
- **Scalability:** row-level scoping with proper indexes (`(tenant_id, ...)` composites) matches the query shapes; election-day write bursts (results/PU reports) are narrow hot rows — Postgres handles this trivially at PolitiCore scale (4,145 PUs × a handful of writes each).
- **Development simplicity:** the current app is already "tenant_id on everything + central resolver" — the mental model transfers 1:1.
- **RLS fit:** the entire authorization model (role, membership, assignment scope, registered location, grants) is row-level predicate logic — exactly RLS's shape.
- **Analytics:** admin reports, donations dashboards, election aggregation become SQL; cross-tenant platform analytics (future) are simple admin-role queries.
- **Cross-tenant platform administration:** `platform_super_admin` bypass policy per table; today this role exists in the vocabulary with no real capability — the new model gives it a precise meaning.
- **Future onboarding:** a new tenant is a row plus seed defaults (geography is national reference data shared read-only; per-tenant campaign/governance data is isolated by policy). No schema changes to onboard.

**Residual risks of shared-schema (mitigated in Sections 17/23):** a single missing `tenant_id` predicate would expose rows — mitigated by (a) RLS on *every* tenant table with default-deny, (b) mandatory `tenant_id NOT NULL` FK to `tenants`, (c) automated RLS coverage tests, (d) no client-issued tenant IDs (JWT claim only).

---

## 15. Proposed Supabase Architecture

### 15.1 Components

| Concern | Design |
|---|---|
| **Supabase Auth** | Replaces Firebase Auth. Email/password first (feature parity). Structured JWT via **Auth Hook (Custom Access Token Hook)**: `tenant_id`, `access_role`, `membership_types` embedded in claims at token issuance → RLS reads `auth.jwt()->>'tenant_id'` with zero extra reads. Password reset via Supabase's built-in flow (new capability, replaces "contact an admin"). Admin-created users: service-role Edge Function `invite-member` (creates auth user + profile atomically — replaces the secondary-app workaround). |
| **PostgreSQL** | Single database (Section 14). Schema in migrations (versioned SQL). All enums as Postgres enums or CHECK-constrained varchars matching today's vocabularies. |
| **RLS** | Enabled on every table. Default deny (`FORCE ROW LEVEL SECURITY`, no permissive-by-default). Policies per role family (Section 17). |
| **Database functions** | `SECURITY DEFINER` functions for the operations that were Firestore transactions/batches and rules-enforced state machines: `verify_task_submission`, `submit_election_result`, `review_election_result`, `correct_election_result`, `create_donation`, `resolve_my_scopes` (authorization RPC). These concentrate invariants server-side and are callable by authenticated clients via RPC. |
| **Triggers** | Audit-log generation (`system_audits`) on privileged mutations; profile-update guards (auth-field immutability for self-updates); `updated_at` maintenance; (optional) leaderboard matview refresh. |
| **Supabase Storage** | **Not used initially** — Cloudinary retained (Section 20). Buckets reserved for future needs (e.g., governance attachments) with per-tenant path policies when adopted. |
| **Supabase Realtime** | `postgres_changes` on `election_results`, `pu_reports`, `election_incidents` filtered per tenant (+contest where applicable). Replaces the three election-day `onSnapshot` listeners. Notifications realtime optional after redesign. |
| **Edge Functions** | Server-side privileged operations: `invite-member`, audit-critical flows if not trigger-expressible, `activity-reminders` (scheduled via pg_cron → function, replacing `jobs.ts`), webhook surface for future integrations. All use service-role DB access internally, exposed only via authenticated, authorized endpoints. |
| **Client access** | `@supabase/supabase-js` with anon key + user JWT (RLS enforces everything). Data layer (`src/lib/firebase/*`) replaced by `src/lib/supabase/*` modules of equivalent shape to minimize page-level churn. |
| **Indexes** | Every table: leading `tenant_id` composite indexes matching the documented query shapes (Section 4); FK indexes; partial indexes for hot predicates (`election_results (tenant_id, contest_id) WHERE status = 'approved'`; `tasks (tenant_id) WHERE status = 'active'`). |
| **Constraints** | Unique keys encoding today's deterministic IDs (Section 16); CHECK constraints for enums/ranges; FK chain for geography; `tenant_id NOT NULL REFERENCES tenants` everywhere tenant-owned. |

### 15.2 Trust model shift (explicit)

```text
Today:   Browser ──(client SDK)──► Firestore ──► Security Rules (only boundary)
Target:  Browser ──(supabase-js + JWT)──► Postgres ──► RLS + functions (enforced boundary)
         Browser ──(HTTPS)──► Edge Functions ──► service-role Postgres (privileged ops only)
         Browser ──(HTTPS)──► Cloudinary (retained, unsigned preset, folder-scoped)
```

The browser never receives service keys; tenant identity never comes from request payloads (JWT only); privileged writes never happen client-side.

---

## 16. Proposed PostgreSQL Schema

*(Conceptual DDL sketch — authoritative DDL is written in Phase 1. Naming: snake_case; all timestamps `timestamptz`; all tenant-owned tables: `tenant_id uuid NOT NULL REFERENCES tenants(id)`; omitted standard columns: `created_at`, `updated_at` on every table.)*

```sql
-- ── Platform & tenancy ─────────────────────────────────────────
tenants              (id pk, slug unique, name, state_id fk→states, campaign_active bool,
                      election_mode_enabled bool, created_by)
platform_settings    (id pk singleton, settings jsonb)
tenant_settings      (tenant_id pk fk→tenants, settings jsonb)   -- platform/portal/campaign/integrations
public_site_settings (tenant_id pk fk→tenants, branding jsonb, homepage jsonb, navigation jsonb,
                      footer jsonb, contact jsonb, social_links jsonb, seo jsonb)

-- ── Identity & authorization ───────────────────────────────────
profiles             (id pk = auth.users.id, tenant_id fk, email, full_name, phone, gender,
                      access_role role_enum, membership_types membership_enum[],
                      lifecycle_status lifecycle_enum default 'active', onboarding_status,
                      status_reason text,
                      lga_id fk→lgas, ward_id fk→wards, polling_unit_id fk→polling_units,
                      social facebook_name/…, x_…, instagram_…, tiktok_… (urls+names),
                      points int default 0, rank text default 'Volunteer',
                      unique (tenant_id, email))
positions            (id pk, name)                                -- reference data (7 positions)
permissions          (id pk, name)                                -- reference data (full Permission vocabulary)
position_permissions (position_id fk, permission_id fk, pk(position_id, permission_id))
                     -- from POSITION_DEFAULT_PERMISSIONS — now data, not code
organizational_assignments (id pk, tenant_id fk, user_id fk→profiles, position fk→positions,
                      scope_type scope_enum, scope_id uuid,   -- fk resolved per type via CHECK + trigger
                      status assignment_status_enum, assigned_by fk→profiles,
                      starts_at, ends_at, assigned_at)
permission_grants    (id pk, tenant_id fk, user_id fk→profiles, permission fk→permissions,
                      granted bool,                 -- false = explicit denial (semantics preserved)
                      scope_type scope_enum null, scope_id uuid null, granted_by fk→profiles,
                      unique (tenant_id, user_id, permission, scope_type, scope_id))

-- ── Geography (reference data; anon-readable, admin-writable) ──
states               (id pk, name, code)
senatorial_zones     (id pk, state_id fk→states, name, code)      -- NEW: first-class (didn't exist before)
lgas                 (id pk, state_id fk, zone_id fk→senatorial_zones, name, code,
                      unique (state_id, code))
wards                (id pk, lga_id fk→lgas, name, code, unique (lga_id, code))
polling_units        (id pk, ward_id fk→wards, lga_id fk→lgas,    -- lga_id denormalized for RLS locality
                      name, code, unique (ward_id, code), is_new bool)

-- ── Social / tasks / leaderboard ───────────────────────────────
tasks                (id pk, tenant_id fk, title, description, action_type, guidelines,
                      proof_required bool, points int check (points > 0),
                      status task_status_enum)
task_submissions     (task_id fk, user_id fk→profiles, proof_url, status submission_status_enum,
                      submitted_at, verified_at, verified_by fk→profiles,
                      pk (task_id, user_id))                       -- deterministic ID → PK constraint
leaderboard_public   VIEW over profiles: user_id, display_name, points, rank, tenant_id,
                     state_id, zone_id, lga_id, ward_id            -- PU deliberately excluded (§10)

-- ── Campaign operations ────────────────────────────────────────
campaign_activities  (id pk, tenant_id fk, title, description, activity_type, status,
                      date date, start_time, end_time, venue,
                      scope_type, scope_id, organizer_id fk→profiles, organizer_name,
                      expected_attendance int, created_by fk→profiles)
activity_participants(activity_id fk, user_id fk, rsvp, checked_in bool, checked_in_at,
                      checked_out bool, checked_out_at, verified_by, pk (activity_id, user_id))
campaign_assignments (id pk, tenant_id fk, title, description, assigned_to fk→profiles,
                      assigned_by fk→profiles, scope_type, scope_id, priority, status,
                      due_date, location, evidence_url)
campaign_field_reports (id pk, tenant_id fk, submitted_by fk→profiles, report_type, title,
                      description, scope_type, scope_id, location, participants int,
                      issues text, community_feedback, requests, follow_up_required bool,
                      evidence_url, status report_status_enum, reviewed_by, review_comment)
issues               (id pk, tenant_id fk not null, title, description, issue_type, priority,
                      status issue_status_enum, scope_type, scope_id, reported_by fk→profiles,
                      assigned_to fk, location, evidence_url, resolution_notes)

-- ── Election engine ────────────────────────────────────────────
election_cycles      (id pk, tenant_id fk, name, year int, description,
                      status cycle_status_enum, start_date, end_date, created_by fk→profiles)
election_contests    (id pk, tenant_id fk, election_cycle_id fk, contest_type contest_enum,
                      name, scope_type contest_scope_enum, scope_id,
                      state_id fk→states, senatorial_zone_id fk→senatorial_zones,
                      lga_ids uuid[] ,             -- constituency→LGA membership (join table candidate)
                      election_date, status contest_status_enum,
                      collation_status collation_enum, tracked_parties text[], focus_party_id fk)
political_parties    (id pk, acronym, name, logo_url, inec_registered bool, status, color)
                     -- platform-level reference data (no tenant_id; public read — preserved)
election_candidates  (id pk, tenant_id fk, contest_id fk, party_id fk→political_parties,
                      candidate_name, running_mate_name, status candidate_status_enum)
-- NOTE (Phase 1C as built): the sketches below are the Phase 0 blueprint.
-- election_results as built differs: identity UNIQUE (tenant_id, contest_id,
-- polling_unit_id); evidence_asset_id fk→media_assets (Media Service/R2) replaces
-- cloudinary_url; ballot in election_result_votes; see
-- docs/Phase1C-Final-Architecture-Specification.md as the authoritative record.
election_results     (contest_id fk, polling_unit_id fk,
                      tenant_id fk, election_cycle_id fk, contest_type, contest_scope_type,
                      contest_scope_id, state_id fk, senatorial_zone_id fk, lga_id fk, ward_id fk,
                      submitted_by fk→profiles, status result_status_enum, review_notes,
                      reviewed_by fk, reviewed_at, verified bool,
                      cloudinary_url text not null, cloudinary_public_id,
                      pk (contest_id, polling_unit_id))            -- deterministic ID → PK
-- Phase 1C as built (0018): relational ballots with native ballot-rule
-- enforcement — party_id FKs through (contest_id, party_id) into
-- election_candidates, so a vote for a non-candidate party of the contest
-- is uninsertable. party_acronym identity was rejected by the
-- architecture amendment gate.
election_result_votes(id identity pk, result_id fk→election_results(id, contest_id),
                      contest_id (pinned = result's own contest, same composite FK),
                      party_id fk→political_parties via election_candidates,
                      votes int check (votes >= 0),
                      unique (result_id, party_id))
election_result_history (id pk, result fk, actor_id fk, action history_action_enum,
                      old_votes jsonb, new_votes jsonb, old_status, new_status,
                      old_evidence_asset_id fk, new_evidence_asset_id fk,   -- 0018 amendment
                      old_submitted_by fk, new_submitted_by fk, notes, reason,
                      created_at)                                   -- history[] → child table
pu_reports           (id pk, tenant_id fk, contest_id fk null, ward_id fk, polling_unit_id fk,
                      submitted_by fk, report_type pu_report_enum, title, content,
                      cloudinary_url, status pu_report_status_enum)
election_incidents   (id pk, tenant_id fk, contest_id fk null, ward_id fk, polling_unit_id fk null,
                      incident_type incident_enum, severity severity_enum, description,
                      reported_by fk, cloudinary_url, status incident_status_enum)
election_settings    (tenant_id pk fk, active_election_cycle_id fk, active_contest_id fk,
                      updated_by fk)

-- ── Donation ledger (private) ──────────────────────────────────
donors               (id pk, tenant_id fk, full_name, phone, email, reference_identifier,
                      lga_id fk null, ward_id fk null, donor_key text,
                      unique (tenant_id, donor_key))               -- deterministic key → unique
donations            (id pk, tenant_id fk, donor_id fk→donors, donor_name, donor_phone/email/reference,
                      amount numeric check (amount >= 0), currency default 'NGN',
                      date_received date, payment_method payment_enum, category text,
                      status donation_status_enum, external_reference, notes,
                      lga_id fk null, ward_id fk null,
                      created_by fk→profiles, created_by_name, updated_by)
                     -- UPDATE locks tenant_id/donor_id/created_by via trigger; DELETE blocked
donation_audits      (id pk, tenant_id fk, donation_id fk, action audit_action_enum,
                      performed_by fk, performed_by_name, details, changes jsonb)
                     -- UPDATE/DELETE blocked (immutable)

-- ── CMS / public site ──────────────────────────────────────────
news                 (id pk, tenant_id fk, title, slug, excerpt, content, featured_image,
                      category, status news_status_enum, published_at, scheduled_at,
                      author, created_by fk, updated_by, unique (tenant_id, slug))
biographies          (tenant_id pk fk, full_name, title, about, image_url, stats jsonb,
                      social_links jsonb, status publish_status_enum)
manifestos           (tenant_id pk fk, title, subtitle, introduction, candidate_name,
                      candidate_title, closing, call_to_action, call_to_action_link,
                      pdf_url, status publish_status_enum)
manifesto_sections   (id pk, manifesto_id fk, title, icon, description, points text[], ordinal)
galleries            (tenant_id pk fk)                             -- header only
gallery_images       (id pk, gallery_id fk→galleries, url, title, description, uploaded_at)
events               (id pk, tenant_id fk, title, description, date, time, venue, ward,
                      status publish_status_enum)                   -- legacy events + portal events merged
announcements        (id pk, tenant_id fk, title, content, scope audience_enum, created_by fk)
contact_messages     (id pk, tenant_id fk, name, email, phone, message,
                      status read_status_enum default 'unread', read_at)   -- anon INSERT policy

-- ── Platform operations ────────────────────────────────────────
notifications        (id pk, tenant_id fk, type notif_enum, title, message, link_url,
                      target_type target_enum, target_id,
                      created_by fk, created_at)
notification_reads   (notification_id fk, user_id fk, read_at, pk (notification_id, user_id))
                     -- replaces read_by[]; per-user rows enable correct RLS
system_audits        (id pk, tenant_id fk, actor_id fk, actor_name/email, action text,
                      affected_resource audit_resource_enum, resource_id,
                      old_value jsonb, new_value jsonb, reason_notes, organizational_scope,
                      occurred_at)
                     -- INSERT by triggers/functions only; SELECT admin; UPDATE/DELETE revoked
```

**Key constraint translations from Firestore invariants:** deterministic doc IDs → PK/unique constraints (`task_submissions`, `election_results`, `donors`); status machines → enum CHECKs + transition functions; "admin cannot approve own correction" → `correct_election_result` only emits `pending_review` and officer path is the sole approver; donation immutability → triggers; leaderboard privacy → view column list.

**Deliberately NOT migrated:** `user_access` (replaced by RLS resolution — Section 17); client seed-fallback constants (`election-seed.ts` → seed SQL); `events` legacy dual-source (merged); deprecated `src/data/*` stubs.

---

## 17. RLS Architecture

### 17.1 Identity context

Every request carries the Supabase JWT containing (via Custom Access Token Hook): `tenant_id`, `access_role`, `membership_types`. Helper functions:

```sql
create function auth_tenant_id() returns uuid language sql stable
  as $$ select nullif(auth.jwt()->>'tenant_id','')::uuid $$;

create function auth_role() returns text ...      -- access_role claim
create function auth_is_admin() returns boolean   -- role in ('admin','tenant_super_admin','platform_super_admin')
create function auth_is_officer() returns boolean -- role = 'election_officer'
create function auth_membership(p text) returns boolean -- p = any(membership_types claim)
```

Profile-derived context (registered ward/PU, assignments, grants) is read by RLS from the tables themselves via `(select ...)` single-scan patterns to avoid per-row evaluation.

### 17.2 The `user_access` replacement — scope resolution

One SECURITY DEFINER function replaces the entire materialized index:

```sql
-- Returns true if the caller's active organizational assignments (plus
-- explicit grants, plus admin/officer roles, plus registered location
-- where the permission family allows it) authorize `p_permission` at
-- the resource scope (p_scope_type, p_scope_id).
create function can_access(p_permission text, p_scope_type text, p_scope_id uuid)
returns boolean
security definer stable language sql as $$
  with my_scopes as (
    select a.scope_type, a.scope_id
    from organizational_assignments a
    where a.user_id = auth.uid() and a.status = 'active'
    union
    select g.scope_type, g.scope_id
    from permission_grants g
    where g.user_id = auth.uid() and g.granted        -- explicit grants
  )
  select exists (
    select 1
    from my_scopes s
    where scope_covers(s.scope_type, s.scope_id, p_scope_type, p_scope_id)
  );
$$;
```

`scope_covers()` implements the exact hierarchy semantics of `isScopeDescendant()`: campaign/state cover all; senatorial_zone covers zone+below; lga covers lga/ward/PU (join through `wards`/`polling_units`); ward covers ward/PU; PU equals PU. Because it's SQL, the LGA-coordinator-covers-ward case works **without** any pre-written descendant records — the historic gap that forced `expandAssignmentToScopes` fan-out writes.

**Explicit denial semantics preserved:** the client resolver denies when any matching grant has `granted = false`. Port: the function additionally checks `exists (select 1 from permission_grants g where g.user_id = auth.uid() and g.granted = false and g.permission = p_permission and grant_scope_matches …)` → deny. Keep identical precedence (explicit denial > explicit grant > position default) — encode in `can_access` and unit-test against the current resolver's behavior table.

**Position defaults:** join through `position_permissions` (reference table ported from `POSITION_DEFAULT_PERMISSIONS`) so RLS evaluates position → permission at scope.

### 17.3 Policy families (per table)

| Family | Tables | Policy shape |
|---|---|---|
| Owner-or-admin | profiles (self-update limited), task_submissions | `user_id = auth.uid() or auth_is_admin()` with tenant match |
| Tenant-member read | leaderboard view, parties, election cycles/contests/candidates/settings, news(published) | `tenant_id = auth_tenant_id()` (+ `not social_only` equivalent for election family; social-only = no campaign membership and no elevated role — encode `not (auth_role()='member' and not auth_membership('campaign_member'))`) |
| Scoped access | campaign_activities, campaign_assignments, campaign_field_reports, issues | read/write via `can_access(permission, scope_type, scope_id)` + tenant + ownership alternatives (assignee/author) |
| Election results family | election_results, pu_reports, election_incidents | read: admin/officer (tenant) `or` registered-location `or can_access('view_election_results', res.scope…)`; create: via `submit_election_result()` function (election-mode, OPEN contest, deterministic identity, evidence, submitter authorization all inside); update: only via `review_election_result()`/`correct_election_result()` functions — **no direct table UPDATE grants**; delete: no policy at all |
| Admin-only | donations, donors, donation_audits, tenants(write), settings, assignments/grants (write), system_audits (read) | `auth_is_admin() and tenant_id = auth_tenant_id()` |
| Public read | geography tables, political_parties, news (published), events (published), biographies/manifestos/galleries (published), announcements (audience-scoped: `scope='general' or matches my membership/role`) — **fixes today's over-exposed announcements** | anon select policies |
| Public create | contact_messages | anon insert with column whitelist; no select |
| Server-only write | system_audits, notification generation | no client grants; triggers/Edge Functions only |

### 17.4 What disappears (verified against current rules)

- `user_access` collection, its three sync code paths, and its rules functions.
- Deterministic-ID rule checks (PKs enforce).
- Geo-chain per-document checks (joins enforce).
- `diff().affectedKeys()` allowlists (column grants + functions enforce).
- Election-mode `get()` per result create (function reads settings once).
- Tenant-wide notification read compat rule (per-user rows).
- Expression-limit workarounds (Postgres has no such limit).

### 17.5 What RLS must NOT lose (acceptance checklist)

Explicit-denial override; officer/vote immutability; admin-correction-forces-pending-review; delete prohibitions (election results, donations, donors, audits); social-only election block; tenant isolation on every path including functions; announcements audience scoping; contest-OPEN write gate; evidence-mandatory gate.

---

## 18. Firebase → Supabase Mapping

| Firebase dependency | → Target | Verdict | Why |
|---|---|---|---|
| Firebase Auth (email/password, custom claims none) | Supabase Auth + Custom Access Token Hook | **Migrate** | parity + gains (password reset, JWT claims for RLS, admin invite without session-swap hack) |
| `onAuthStateChanged` + AuthContext | supabase auth state listener; same context shape (user/profile/assignments/grants/hasPermission) | **Migrate** | preserve the contract; assignments/grants can remain client-fetched for UX while RLS enforces truth |
| `users` collection | `profiles` table (FK to auth.users) | **Migrate** | |
| `tenants` collection | `tenants` + `tenant_settings` tables | **Migrate** | settings writes finally become rules-compliant (they currently aren't) |
| `user_access` index | RLS scope-resolution function + grants table | **Remove / redesign** | Firestore-only artifact (§17.2) |
| `organizational_assignments` | table (index-sync code deleted) | **Migrate** | |
| `permission_grants` | table + explicit-deny semantics in resolver | **Migrate** | |
| `POSITION_DEFAULT_PERMISSIONS` (code) | `position_permissions` reference table | **Redesign** | data not code; must stay in lockstep with RLS resolver |
| `tasks`, `task_submissions` (deterministic ID, runTransaction verify) | tables, PK(task,user), `verify_task_submission()` DB function | **Migrate** | transaction → DB function in single transaction |
| `leaderboard_public` projection | view over profiles (same columns; PU excluded) | **Redesign** | privacy becomes structural (§10) |
| `news` (+ legacy `published` bool) | `news` table, single status model | **Migrate** | backfill drops legacy flag |
| `biographies`/`manifestos`/`galleries`/`portal_content` (tenant-ID docs, arrays) | tables + child tables (manifesto_sections, gallery_images), announcements/events split | **Redesign** | array-in-doc → relations; fixes announcements public-read exposure |
| `events` (legacy) | merged into `events` table | **Redesign** | two sources → one |
| `campaign_activities` (+participants arrays) | table + `activity_participants` | **Migrate** | scope fan-out reads → scope-join RPC |
| `campaign_assignments` | table (drop email-as-assignee fallback) | **Migrate** | |
| `campaign_field_reports` | table | **Migrate** | |
| `issues` | table (`tenant_id NOT NULL`) | **Migrate** | |
| `election_settings` (+listener) | table, one row/tenant | **Migrate** (listener dropped) | |
| `election_cycles` / `election_contests` / `political_parties` / `election_candidates` (+client seed fallbacks) | tables + seed SQL | **Migrate** | client fabrication of data ends |
| `election_results` (deterministic ID, embedded results[]/history[], 3 write paths, realtime) | `election_results` (PK contest+PU) + `election_result_votes` + `election_result_history`; state machines in DB functions; Realtime channel | **Migrate + redesign** | invariants move from rules to constraints+functions; history rows replace embedded array |
| `pu_reports`, `election_incidents` (+realtime, geo auth) | tables + RLS + realtime | **Migrate** | |
| `donations` / `donors` / `donation_audits` (writeBatch) | 3 tables + `create_or_update_donation()` function; delete/immutable triggers | **Migrate** | batch → function; drift-prone stat arithmetic → recompute from aggregate |
| `system_audits` (rules-blocked client writes) | table written by triggers/Edge Functions only | **Redesign** | the intended design finally becomes possible |
| `notifications` (tenant-wide + client filter) | `notifications` + `notification_reads` per-user rows | **Redesign** | fixes privacy/perf defect (§26) |
| `contact_messages` (anon create) | table + anon insert policy | **Migrate** | |
| `electoral_data` singleton | `states/senatorial_zones/lgas/wards/polling_units` + seed SQL | **Redesign** | relational geography (§9) |
| `onSnapshot` (results/PU reports/incidents) | Supabase Realtime `postgres_changes` | **Migrate** | feature parity, election-day justified |
| `onSnapshot` (election settings) | none (refetch) | **Remove** | no realtime value |
| `onSnapshot` (notifications tenant-wide) | optional realtime on per-user rows | **Redesign** | |
| Firestore transactions/batches (verify-task, grants sync, donation batch) | DB functions in single transactions | **Migrate** | grants sync deleted entirely |
| Firebase Storage (`storage.ts`) | — | **Remove** | zero importers |
| `firebase-admin` dependency | Edge Functions (service role) | **Remove** (dependency), **Redesign** (capability) | installed-but-unused; its intended roles move server-side |
| Cloudinary (all media incl. EC8 evidence) | Cloudinary (unchanged) | **Retain** | §20 |
| `firestore.rules` (1,552 lines) | RLS policies + DB functions (§17) | **Redesign** | product semantics preserved; Firestore-mechanics dropped |
| Emulator-based rules tests (`tests/rules/*`) | Postgres RLS test suites (pgTAP or vitest+pg) | **Migrate** | contract carries over (§23) |
| `devseed.ts` | seed SQL / staging fixtures | **Remove** | dev-only artifact |

---

## 19. Authentication Migration Strategy

1. **Parity map:** email/password sign-in, sign-out, session persistence, public volunteer signup, admin-created members, lifecycle gating. No social/phone/SSO exists today → none required day one.
2. **Account provisioning paths:** (a) public signup — client-side `signUp` + profile row insert (RLS-validated, same constraints as today's rules); (b) admin-created — Edge Function with service role: create auth user, insert profile, (optionally) send password-set email — replaces the secondary-app session-swap workaround and finally supports password reset.
3. **JWT claims:** Custom Access Token Hook reads `profiles` and embeds `tenant_id`, `access_role`, `membership_types`. Token refresh (1h default) picks up role changes with bounded delay; sensitive revocations (lifecycle_status → suspended) additionally checked by a profile-status predicate in RLS so suspension takes effect without waiting for token expiry.
4. **Profile-doc compatibility:** `profiles.id = auth.users.id` (uid-keyed, like today).
5. **Migration of users:** one-time import via Admin API — create Supabase auth users (email + imported password hash where feasible, else forced reset), insert profiles with mapped IDs. Pre-launch user base makes this small; sequence in Phase 3 cutover (§22).
6. **Client swap:** `AuthContext` keeps its public interface (`user`, `profile`, `assignments`, `grants`, `hasPermission`, membership flags) so the ~25 consuming pages change imports only.
7. **Fail-closed:** preserve current semantics — access-load error ⇒ `hasPermission` false (non-admin), redirect to login when unauthenticated.

---

## 20. Storage Strategy

**Decision: retain Cloudinary initially.** Evidence:

- Cloudinary is the **only** functioning media pipeline (7 folders, all CMS + all election evidence). Firebase Storage code exists but is unused — there is no second pipeline to preserve.
- EC8 result-sheet evidence is **mandatory** and lives in Cloudinary; election integrity depends on those URLs remaining stable. Any storage move must guarantee URL stability or perform a full re-upload/migration of evidence — risk with zero current benefit.
- Uploads are unsigned-preset client-side uploads — service-independent of Firebase; **no migration coupling exists** (keeping Cloudinary does not keep Firebase).
- `next.config.ts` already allows arbitrary image hosts.

**Recommendations:** (1) keep folders and naming; namespace by tenant slug (`{tenant}-2027/...`) when onboarding tenant #2; (2) do not adopt Supabase Storage for existing media; evaluate it only for future Governance attachments, and decide then (per-tenant bucket-path policies are mature when needed); (3) record Cloudinary public IDs for election evidence in Postgres (already modeled: `cloudinary_url` + `cloudinary_public_id` columns) so a future move has a complete inventory; (4) lock down the upload preset's allowed formats/sizes (already client-enforced: images ≤5MB jpg/png/webp; PDFs ≤10MB) at the Cloudinary preset level when convenient.

---

## 21. Realtime Strategy

| Feature | Today | Target | Rationale |
|---|---|---|---|
| Election results | `onSnapshot` (role-scoped query) | Supabase Realtime on `election_results` per tenant+contest; aggregation via SQL view + client re-render | realtime is a product feature during collation |
| PU reports | `onSnapshot` | Realtime per tenant (+ward/PU filter client-side) | election-day ops |
| Incidents | `onSnapshot` | Realtime per tenant | election-day ops |
| Election settings | `onSnapshot` single doc | **Poll/refetch on page load; invalidate on admin save** | admin-managed singleton; realtime adds nothing |
| Notifications | `onSnapshot` tenant-wide + client filter | Per-user rows; **Realtime optional** (channel per user) after redesign | fixes the tenant-download defect first; realtime second |
| Everything else | fetch-on-mount | fetch-on-mount (TanStack Query optional later) | parity |

Realtime authorization note: Supabase Realtime enforces RLS on `postgres_changes` — subscribers only receive rows they can read; per-contest channels keep election-day payloads bounded.

---

## 22. Migration Sequence

**Principle: foundation before features; features before new development; cutover last. No new product features are built on Firebase.**

### Stage F — Foundation (Firebase still live, zero user impact)
1. Provision Supabase project; migrations: enums, tenancy, geography, profiles, authorization tables; seed reference data (parties, permissions, positions, geography — geography source recovery is a hard prerequisite, R1).
2. RLS policies + authorization functions (`can_access`, `scope_covers`) + **RLS test suite ported from `tests/rules/*`** (tenant isolation, role boundaries, election lifecycle, public/private — the existing suites are the acceptance spec).
3. Auth foundation: hook (JWT claims), invite-member Edge Function. **Deliverable: an empty-but-complete platform where every rule test passes.**

### Stage M1 — Existing feature migration (dual-write/dual-read per module, smallest blast radius first)
4. Identity: auth + profiles + members admin. Verify: login, admin create, lifecycle.
5. CMS/public: news, biography, manifesto, gallery, announcements/events, contact. Verify: public pages byte-comparable, admin CRUD.
6. Organization: geography lookups, assignments, grants (delete sync code), coordination page.
7. Campaign: activities/participants, assignments, reports, issues, tasks/submissions/verification, leaderboard view.
8. Election: settings, cycles, contests, parties, candidates, results (+votes+history), review/correction functions, PU reports, incidents, realtime channels, export paths.
9. Donations + audit trails (server-written system_audits live from here).
Each module: dual-write (Firebase + Postgres) or read-shadow, row-count/checksum verification, then flip reads.

### Stage N — New feature development (Postgres-only)
10. Control Center (settings tables + UI), notification redesign, analytics views — built **only** on Postgres.

### Stage C — Cutover
11. Data backfill of final deltas; auth user import; verification suite (§23) green; freeze Firebase writes; flip environment; keep Firebase project intact (read-only archive) through election cycle + rollback window; remove Firebase SDK/dependencies only after the window closes.

**Rollback at every stage:** Firebase remains authoritative until Stage C's freeze; any failed module flips reads back with zero data loss (dual-write keeps both current).

---

## 23. Testing Strategy

| Layer | Tooling | What it proves |
|---|---|---|
| Unit (authorization resolver) | vitest | `can_access`/`scope_covers` behavior table equals `permissions.ts` semantics (hierarchy, explicit denial, position defaults, registered location) — port `business-rules.test.ts` cases 1:1 |
| **RLS policy tests** | pgTAP or vitest + ephemeral Postgres | port **all 10 `tests/rules/*` suites**: unauthenticated denial, cross-tenant denial (TENANT_A/TENANT_B pattern), identity-forgery (can't write others' submissions/results/profiles), role boundaries (officer can't touch non-election; social-only zero election; member can't elevate self), election lifecycle (create gates, transitions, vote immutability, admin-correction-forces-pending-review, no delete), operational modules, public/private visibility |
| **Tenant isolation** | automated scan + tests | every tenant-owned table: RLS enabled, `tenant_id NOT NULL FK`, policies present; platform bypass only via explicit role; CI fails on any new table lacking RLS |
| Authorization matrix | generated cases | role × permission × scope table (admin/officer/social/campaign/dual/zone/LGA/ward/PU/registered) asserted in SQL |
| Election integrity | SQL + API tests | state-machine transitions legal/illegal sets; votes immutable by officer; one result per contest+PU; official totals = approved-only; history completeness per mutation |
| Data integrity | constraints + property tests | FK geography chain; unique donor keys; amount ≥ 0; enum validity; deterministic PKs |
| Migration verification | dual-run scripts | row counts, checksums (canonical JSON of mapped rows), spot diffs per module during M1 |
| Regression | public-site + portal smoke | published-only visibility, draft hiding, portal guards, contact inbox, leaderboard shape (incl. PU exclusion) |
| Realtime | integration | RLS-filtered channels: user receives only authorized rows |

**Cross-tenant prevention is the prime directive:** every suite runs a cross-tenant negative case; CI gates merge on the full RLS suite; a `rls_coverage` test introspects `pg_catalog` to assert no tenant table lacks RLS.

---

## 24. Risk Register

| # | Risk | Severity | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | **Geography source missing** (17/260/4,145 dataset not in repo; seed script unrunnable) | High | High | Blocks full election scope; permissions fallback only knows Nkanu West | Recover `/lgas/` folder from prior machine/backup or re-export from INEC lists **before Stage F seed**; until then seed Nkanu West + stub LGA rows so nothing silently falls back |
| R2 | Authorization mistranslation (scope/explicit-deny/position-default semantics drift) | Critical | Medium | Privilege escalation or lockout | Semantics table ported as tests; resolver equivalence suite (old vs new) run in parallel during M1 |
| R3 | **Cross-tenant leakage** via missed RLS predicate | Critical | Low–Med | Catastrophic | Default-deny everywhere; RLS-coverage introspection test; JWT-only tenant source; no client tenant input; cross-tenant negative in every suite |
| R4 | Election-result integrity (state machine, vote immutability, evidence gate) | Critical | Medium | Election data invalid | DB functions as sole writers; transition table tests; delete physically revoked; evidence NOT NULL; officer/admin separation tests |
| R5 | Auth migration (account takeover/lockout during import) | High | Medium | Users locked out / wrong tenant | Imported users mapped by verified table; forced-reset fallback; staged rollout; lifecycle predicate independent of token age |
| R6 | Realtime gaps on election day | High | Medium | Stale collation dashboards | Realtime channel tests; fallback polling on channel error (current code already has listener-error banner pattern) |
| R7 | Leaderboard projection regression (privacy or staleness) | Medium | Low | PII exposure / wrong rankings | View column list == exact protected field set; PU-exclusion test carried over; no write path to leak |
| R8 | Audit-trail gaps (system_audits was effectively dead) | Medium | High | Compliance/completeness | Server-side triggers from Stage M1; write-path test: every privileged mutation emits audit |
| R9 | Dual-write drift during M1 | Medium | Medium | Divergent data | Single-direction authoritative source per module; checksum verification; flip-back plan |
| R10 | Cloudinary URL breakage (if storage moved hastily) | High | Low | Evidence loss | **Retain Cloudinary** (§20); public IDs recorded in Postgres |
| R11 | Environment/deploy misconfig (anon key exposure, service key in client) | High | Medium | Full DB compromise | Service role only in Edge Functions; key-scoping lint in CI; env template + deploy checklist |
| R12 | Rollback impossibility after Firebase freeze | High | Low | Stuck on broken Postgres | Freeze only after full verification suite green; Firebase kept intact through rollback window (§22 Stage C) |
| R13 | Composite-index/perf regressions on hot election queries | Medium | Medium | Slow dashboards on election day | Index plan per documented query shape; load test with 4,145-PU-scale fixtures |
| R14 | Team unfamiliarity (RLS/functions vs rules) | Medium | Medium | Slow/drifted implementation | ADRs per policy family; RLS test suite as executable documentation; Phase 1 pairing |

---

## 25. Features to Preserve

(Unchanged product behavior — the migration must be invisible to users.)

- Full portal IA and role-scoped navigation; dashboards per role (admin, campaign, election officer, social member; dual-membership toggle).
- The four-layer authorization model and every settled boundary (§5.2), including Election Officer ≠ Admin, social-only election block, results-not-admin-only, geographic inheritance, ward→PU implication.
- Election Engine semantics: five contest types; cycle→contest→candidate→result; deterministic one-result-per-contest-PU; mandatory EC8 evidence; officer review transition machine; admin correction forcing re-review; append-only history; official = approved-only; no deletion.
- Leaderboard protected projection (exact field set, PU excluded, top-N tenant ranking).
- Private donation ledger (admin-only, immutable financial identity, delete prohibition, full audit history, dashboard summaries).
- Tasks/points integrity (one submission per task+user; single award; verified-only points).
- Campaign operations surfaces (area, members directory scoping, assignments, activities with RSVP/check-in, reports, issues lifecycle).
- CMS/public site behavior (draft/published, slugs, legacy news compat during read-migration, contact inbox).
- Notifications UX (bell, mark-read, announcements-by-scope).
- Contextual help, global search, exports (CSV/Excel/PDF), election export package.
- **Removed modules stay removed:** Campaign Communications, Campaign Documents, Campaign Calendar.

## 26. Features to Redesign

- `user_access` + sync machinery → SQL scope resolution (deletion, not port).
- Notifications → per-user rows + audience-scoped public read for announcements (fixes tenant-wide download defect).
- Scope-expanded reads (per-scope fan-out queries in activities/assignments/reports/issues/members) → single scope-join queries/RPCs.
- Leaderboard projection → structural view (semantics preserved).
- `system_audits` → server-written via triggers/Edge Functions (fixes the rules-blocked write path).
- Tenant settings writes → real admin RLS writes (fixes the silently-failing settings page).
- Embedded arrays → child tables (results, history, participants, read_by, gallery images, portal content).
- Client-side seed fallbacks → SQL seeds (client never fabricates data).
- CMS singletons → one-row-per-tenant tables; legacy events merged; news legacy flag dropped after backfill.
- Direct-SDK usage in 3 pages → normalized data services.
- Client-side aggregations (reports page, election dashboard totals, donation summaries) → SQL views.
- Campaign-manager/council-chairman zero-permission-by-title → enforced as data (`position_permissions`), unchanged in behavior.

## 27. Features to Build Only After Migration

- **Central Control Center** (platform/tenant/public-site/portal/campaign settings UI per §12 — foundations land as `*_settings` tables in Stage F, UI after migration).
- **Governance platform** (§13 — needs citizen identity design; Post-MVP).
- Multi-tenant onboarding UI (tenant provisioning, subdomain resolution replacing the placeholder `getTenantBySubdomain`).
- Platform-level cross-tenant administration views (the `platform_super_admin` capability made real).
- Password reset / invites UX (technically arrives with Supabase Auth; productize after cutover).
- Scheduled jobs as products (activity reminders, periodic aggregation — pg_cron/Edge Functions replacing `jobs.ts`).
- Analytics expansions the relational model unlocks (donation dashboards, election coverage analytics, engagement metrics).

---

## 28. Recommended Phase 1 Implementation Plan

**Phase 1 goal: the foundation from §22 Stage F, complete and tested — application still running on Firebase, untouched.**

1. **Decisions to approve (gate):** multi-tenancy model = shared schema + `tenant_id` (§14); Cloudinary retained (§20); realtime scope (§21); governance/citizen identity deferred (§13); `lga_ids` array vs join table; leaderboard view vs matview.
2. **Recover geography source** (R1) — blocking prerequisite for seed SQL.
3. **Supabase project + migrations 0001–000N:** enums, tenants, settings tables (structure only), geography + seed, profiles, positions/permissions/position_permissions, organizational_assignments, permission_grants, tasks/task_submissions, campaign tables, election tables, donations, CMS tables, notifications(+reads), system_audits, contact_messages. Indexes per §4 query shapes.
4. **Authorization core:** auth helpers, `scope_covers`, `can_access` (with explicit-deny), policy families for every table; **no client grants on privileged paths**; DB functions for verify-task, election result write/review/correct, donation create/update.
5. **Auth hook:** JWT claims (`tenant_id`, `access_role`, `membership_types`); invite-member Edge Function.
6. **RLS test suite:** port the 10 rules suites + tenant-coverage introspection + resolver-equivalence table (§23). **Gate: 100% green.**
7. **Seed:** reference data (parties, permissions, positions, geography); 2027 cycle/contests as seed SQL (replacing client fallbacks); dev fixtures replacing `devseed.ts`.
8. **Deliverable & exit criteria:** a deployed-to-staging Supabase foundation where every security-contract test passes, zero application code changed, Firebase untouched; Phase 2 begins module migration (M1) starting with identity.

**Explicitly not in Phase 1:** no page migration, no Firebase code deletion, no dual-write, no Control Center UI, no Governance tables.

---

## READY FOR PHASE 1?

### Verified
- **Complete Firebase dependency inventory** — every auth function and caller; all 29 collections with fields, relations, readers/writers, queries and side effects; all 5 realtime listeners; all transactions/batches; Storage unused; Admin SDK unused; Cloudinary footprint mapped. (§3)
- **Authorization model** — four layers plus materialized index, all semantics documented from `permissions.ts` + `firestore.rules` + the authoritative reconciliation doc; the Firestore-forced artifacts are identified precisely. (§5, §17)
- **Election Engine** — full lifecycle, state machine, five contest types, multi-contest support confirmed in the data model, every query/listener enumerated. (§8)
- **Geography implementation reality** — Nkanu West (14 wards / 205 PUs) verified; full-state dataset confirmed absent; zone entities confirmed absent from data (scope-label only). (§9)
- **Leaderboard, donation ledger** — protected semantics, mutation sources, sync behavior, immutability rules documented as-is. (§10, §11)
- **Test corpus** — 10 rules suites + business-rules suite inventoried as the portable security contract. (§23)
- **Settings scattered across the app** — full inventory and proposed Control Center map. (§12)
- **Multi-tenant readiness** — current single-tenant assumptions and every uneven tenant-scoping spot documented. (§6)

### Remains uncertain
1. **The full Enugu geography dataset** (17 LGAs / 260 wards / 4,145 PUs) — not in the repository; must be recovered or re-exported before seeds. Until recovered, Phase 1 seeds Nkanu West.
2. **Production data shape** — this audit is code-grounded; actual Firestore document variance (legacy news flags, null tenant_ids in issues, orphaned projections) is only knowable from a live export, which requires a decision to grant data access (Phase 2 concern).
3. **Senatorial-zone reference data** — zones exist as scope labels but have no entity data anywhere; names/codes for the three Enugu zones must be supplied when geography is recovered.
4. **Constestation→LGA modeling** — array vs join table (recommend join table; needs product sign-off).
5. Whether any undocumented client-side integrations exist outside this repo (deploy hooks, scripts on other machines — `export-project.ps1` hints at local-only workflows).

### Architectural decisions needing approval
| # | Decision | Recommendation |
|---|---|---|
| D1 | Isolation model | Shared schema + `tenant_id` + RLS (§14) |
| D2 | `user_access` elimination | Approve deletion; grants + SQL resolution replace it (§17) |
| D3 | Media | Retain Cloudinary; Supabase Storage deferred (§20) |
| D4 | Realtime scope | Election-day trio only; settings listener dropped; notifications redesigned first (§21) |
| D5 | Election settings ownership | Remains Election-domain, surfaced (read-only) in Control Center (§12) |
| D6 | Governance/citizen identity | Deferred; no tables in Phase 1 (§13) |
| D7 | Auth claims strategy | Custom Access Token Hook with tenant/role/memberships (§19) |
| D8 | `docs/DOCUMENTATION_TRUTH_AUDIT.md` Decision #15 conflict | Ratify that the Supabase/multi-tenant decision supersedes it (§1 discrepancy #2) |

### What Phase 1 should implement
Exactly §28: Supabase project, full relational schema with seeds, RLS + authorization functions, auth hook + invite function, and the ported RLS test suite — **gated on the D1–D8 approvals and geography recovery**. Application code remains on Firebase and untouched; the exit criterion is a staging Supabase foundation that passes 100% of the ported security contract.

**Phase 1 is not started in this phase, per the brief.**
