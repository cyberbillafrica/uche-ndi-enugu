# PolitiCore — Platform Core Identity / Auth Cutover Architecture Gate

**Status:** GO
**Type:** Platform-level architecture gate (not a module phase)
**Scope:** Discovery, verification, classification, boundary definition. **No application code modified.**
**Preceding state:** Social Force LOCKED · Campaign LOCKED · Election LOCKED (553/553 regression at gate open)

---

## A. Firebase Consumer Inventory

Repository-wide static inventory: **45 files** carry Firebase imports (`@/lib/firebase/*` or direct `firebase/*` SDK). 21 are `src/lib/firebase/*` service modules; 24 are consumer files (pages/components/contexts). Full classification:

### A — Core Identity/Auth (the cutover target)

| Consumer | File | Firebase dependency | Responsibility | Migration status |
|---|---|---|---|---|
| `AuthContext` | `src/contexts/AuthContext.tsx` | `firebase/auth` (`User`, `onAuthStateChanged`), `lib/firebase/auth` (`onAuthStateChange`), `lib/firebase/firestore` (`getUserProfile`), `lib/firebase/organization` (`getUserOrganizationalAssignments`, `getUserPermissionGrants`) | auth state, profile, assignments, grants, membership flags, `hasPermission` | **Not migrated — this gate's target** |
| Login page | `src/app/login/page.tsx` | `lib/firebase/auth` (`signIn`) | password sign-in | Not migrated (implementation phase 1) |
| Volunteer signup | `src/app/volunteer/page.tsx` | `lib/firebase/auth` (`signUpVolunteer`) | public signup → users doc | Not migrated (implementation phase 1) |
| Admin member creation | `src/app/portal/admin/members/add/page.tsx` | `lib/firebase/auth` (`createMemberByAdmin`) | admin creates member account | Not migrated (implementation phase 1) |
| Header (logout) | `src/components/layout/Header.tsx` | `lib/firebase/auth` (`logOut`) | session end | Not migrated (implementation phase 1) |
| Portal layout logout | `src/app/portal/layout.tsx` | `lib/firebase/auth` (`logOut`) | session end | Not migrated (implementation phase 1) |
| Session bridge (transitional) | `src/lib/supabase/session-bridge.ts` | `firebase/auth` + `lib/firebase/config` | exchanges Firebase ID token → Supabase session (`signInWithIdToken`) | **Removed by** the cutover (native sessions make the exchange obsolete) |

### B — Shared Core Infrastructure

| Consumer | File | Firebase dependency | Responsibility | Migration status |
|---|---|---|---|---|
| Portal notifications | `src/app/portal/layout.tsx` | `lib/firebase/notifications` (subscribe/mark read) | notification bell | Supabase equivalent already exists (`supabase/notifications.ts` + 0008 RPC + realtime) — separate phase |
| Tenant constant | `src/app/portal/admin/health`, `admin/reports`, `admin/settings`, `lib/firebase/jobs`, `lib/firebase/donations`, `lib/firebase/notifications`, `lib/firebase/organizationalAssignments`, `lib/firebase/permissionGrants`, `lib/firebase/audit`, public pages | `lib/firebase/tenants` (`CURRENT_TENANT_ID`, `getCurrentTenant`) | static tenant slug `ifeanyi-2027` | Superseded by `politicore.current_tenant_id()` / `tenants` view — retires with each module's migration |
| Admin audit logs | `src/app/portal/admin/audit-logs/page.tsx` | `lib/firebase/audit` | audit log display | Supabase `system_audits` is authoritative — separate phase |
| Admin directory | `admin/members`, `admin/reports`, `GlobalSearchModal` | `lib/firebase/firestore` (`getAllUsers`) | member directory reads | Supabase `politicore_profiles` view is authoritative — separate phase |
| Media service | `src/app/api/election/evidence/*` | none (R2 via `lib/media`) | evidence storage | already non-Firebase (classification note: `lib/firebase/storage.ts` has **zero** consumers) |

### C — Module-owned

| Consumer | File | Firebase dependency | Responsibility | Migration status |
|---|---|---|---|---|
| Election legacy service | `src/lib/firebase/election.ts` (836 lines) | `firebase/firestore` | **zero live importers** — only a comment reference in `types/index.ts` calling it a rollback reference | Legacy rollback doc; retire at final Firebase removal |
| Campaign legacy services | `lib/firebase/campaign*.ts` — **already deleted** in the locked Campaign phases | — | — | done |

### D — Public Content

| Consumer | File | Firebase dependency | Responsibility | Migration status |
|---|---|---|---|---|
| Homepage | `src/app/page.tsx` | `firestore` (news), `tenants`, `portal-content` | public landing content | separate content phase |
| News | `src/app/news/page.tsx`, `news/[slug]`, `admin/news`, `GlobalSearchModal` | `firestore` news family | news content | separate content phase |
| Contact | `src/app/contact/page.tsx`, `admin/contact-messages` | `firestore` contact family | contact messages | separate content phase |
| Biography / Gallery / Manifesto | public + admin pages | `lib/firebase/{biography,gallery,manifesto}` + `tenants` | site content | separate content phase |
| Announcements | `admin/announcements` | `portal-content` + `tenants` | announcement admin | separate content phase |
| Site settings | `admin/settings` | direct `firebase/firestore` + `config` + `tenants` | site settings admin | separate content phase |
| Donations | `admin/donations` | `lib/firebase/donations` | donation records | separate content phase (Donations module itself is out of scope platform-wide) |

### E — Legacy / Diagnostic / Stub (zero live consumers — safe to delete at final cleanup, NOT now)

| File | Lines | External consumers |
|---|---|---|
| `lib/firebase/devseed.ts` | 53 | 0 |
| `lib/firebase/election-seed.ts` | 231 | 0 |
| `lib/firebase/organizationalAssignments.ts` | 505 | 0 (AuthContext uses `organization.ts`) |
| `lib/firebase/permissionGrants.ts` | 336 | 0 (AuthContext uses `organization.ts`) |
| `lib/firebase/storage.ts` | 12 | 0 |
| `lib/firebase/jobs.ts` | 62 | 1 (admin/health — stub aggregation + reminder job) |

**Totals: 7 Core-identity consumer files · 6 shared-core surfaces · 1 module-owned legacy file · 10 content surfaces · 6 zero-consumer legacy files.**

## B. Core Identity Boundary

**Current (Firebase-first, bridged):**

```
Firebase Auth (email/password) → onAuthStateChanged
  → Firestore users/{uid} doc (profile, points, membership)
  → Firestore organizational_assignments + permission_grants queries
  → AuthContext (client resolver: lib/permissions.ts over profile+assignments+grants)
  → session-bridge: Firebase ID token → Supabase signInWithIdToken (per migrated page)
```

**Proposed (Supabase-canonical):**

```
Supabase Auth (native session: signInWithPassword / signUp)
  → auth.users.id (canonical identity; Firebase UID not required)
  → trg_on_auth_user_created → backfill_profile_on_signup (already deployed, 0007)
  → politicore.profiles via public.politicore_profiles view (RLS, 0009)
  → politicore.current_tenant_id() RPC (server-resolved tenant)
  → public.organizational_assignments view (RLS: own + admin, 0026)
  → politicore.permission_grants (RLS: own + admin, 0002)
  → AuthContext (identity/access context only; authorization answers remain
    the database resolvers: politicore_has_permission, my_scopes_rpc,
    module_enabled — 0002/0005/0014, all verified present)
  → existing consumers unchanged
  → session-bridge DELETED (no dual-read, no fallback)
```

Every ingredient already exists and is exercised on hosted: the token hook (0006, claims `app_metadata.tenant_id` + `app_metadata.access_role` only), signup provisioning (0007), the profile guard trigger (0002 `trg_profiles_guard_update` — self-update of authority fields blocked), the authority audit triggers, and the RLS on profiles/assignments/grants.

## C. AuthContext Contract

| Field/Function | Survives? | Implementation change |
|---|---|---|
| `user` | Yes | Type changes `firebase/auth User` → a minimal `AuthUser` (`id`, `email`, aud metadata) from `supabase.auth.getUser()`. 17 files touch `user`; only 4 use `uid`/`displayName` directly (campaign pages use `profile?.id ?? user.uid` — profile stays primary, fallback narrows to `user.id`). |
| `profile` | Yes | Source changes: Firestore `users/{uid}` doc → `politicore_profiles` view. `UserProfile` shape extended (not replaced): `membership_types`, `lifecycle_status`, `points`, `rank` already exist on the view; UI-only fields (facebook/x handles) need a column mapping decision in the implementation phase. |
| `assignments` | Yes | Source changes: Firestore query → `public.organizational_assignments` view (RLS returns own rows; the client-side `getActiveAssignments` filter remains a presentation filter, not authorization). |
| `grants` | Yes | Source changes: Firestore query → `politicore.permission_grants` (RLS own-rows). Granted-false denials preserved — read the rows, do not filter. |
| `loading` / `accessLoading` | Yes | Same two-stage semantics, driven by `onAuthStateChange` (Supabase) → profile → access data. |
| `accessError` | Yes | Same fail-closed semantics. |
| `isSocialMember` / `isCampaignMember` / `isCampaignCouncilMember` | Yes | Same `lib/permissions.ts` derivations over the new sources. |
| `hasPermission()` | Yes, **re-timed** | Today: client resolver over loaded state. Target: keep the synchronous signature for UI presentation, but its authority answer is the DB (`politicore_has_permission`). The implementation phase must decide per-call: cached DB answer (recommended — resolve once per session/scope, cache in context) vs. pure client resolution (retained for render-only convenience, never authoritative). **No second resolver is created** — the database resolver is the only authority; `lib/permissions.ts` survives only as a UI-presentation mirror, explicitly non-authoritative. |

Not added: module datasets, scope trees, positions as roles, JWT permissions.

## D. Authorization Boundary (where each is resolved)

| Concern | Resolved by | Location |
|---|---|---|
| tenant | `current_tenant_id()` (JWT `app_metadata.tenant_id` + profile row) | database |
| access role | `profiles.access_role` (+ JWT claim, stable pair) | database |
| membership | `profiles.membership_types` | database |
| assignment | `politicore.organizational_assignments` rows | database |
| position | assignment's position reference — never an access role | database |
| permission | `politicore.has_permission` (0002/0014) | database |
| scope | `scope_covers()` + `my_scopes_rpc()` (hierarchical) | database |
| module activation | `module_enabled()` per module code | database |

## E. Locked Module Verification

**Social Force — PASS.** No Social file touched by this gate (zero edits; suites green: 31+23+24+21+20+18). Its `resolveSocialAccess` consumes `resolveIdentity`/`isModuleEnabled`, whose contract the cutover preserves.
**Campaign — PASS.** No Campaign file touched (68+80+43+47+44+27 green). Campaign pages consume `profile?.id ?? user.uid` — the contract note in §C covers the `user` fallback narrowing.
**Election — PASS.** No Election file touched (16+40+14 green). `resolveElectionAccess` rides the same `resolveIdentity`.

## F. Migration Sequence (proposed — smallest safe sequence)

1. **Phase 1 — Core Identity/Auth cutover (the GO'd next phase).** `AuthContext` onto native Supabase Auth (sign-in/sign-up/sign-out incl. login, volunteer, member-add, Header), profile/assignments/grants from the Supabase views, `hasPermission` authority via `politicore_has_permission` (cached), session-bridge retained **only** as a transitional shim for already-open Supabase sessions, then deleted when no page calls `ensureSupabaseSession` without a native session. Route guards untouched; locked-module page code untouched (their `resolve*Access` paths keep working because the session now exists natively).
2. **Phase 2 — Shared Notifications cutover.** Swap `lib/firebase/notifications` in `portal/layout.tsx` for the existing `supabase/notifications.ts` (read + mark-read + realtime already built).
3. **Phase 3 — Member Directory.** `getAllUsers` consumers (admin/members, admin/reports, GlobalSearchModal Members source) onto `politicore_profiles` view reads with tenant-scoped admin policies.
4. **Phase 4 — Public/Content modules.** News, Contact, Biography, Gallery, Manifesto, Announcements, Site settings, Donations, homepage — one gate each or one batched gate; they are independent of identity.
5. **Phase 5 — Tenant/settings + Jobs/diagnostics.** Retire `CURRENT_TENANT_ID` (last consumer), `firebase/jobs` (stub + reminder), admin audit-logs view onto `system_audits`.
6. **Phase 6 — Final Firebase removal.** Delete `src/lib/firebase/*` (incl. the zero-consumer legacy files inventoried in §A-E), remove the SDK dependency, update `types/index.ts` comment. Only after 1–5.

## G. Risks

- **Stale Firebase identity assumptions:** `user.uid` usages (4 files) must map to the Supabase `user.id`; both already share the subject by design of the bridge, so risk is low but each call site needs verification in the implementation phase.
- **Profile shape mismatch:** `UserProfile` carries UI fields (social handles, `points`, `rank`) — the profiles view has authority fields; the implementation phase must define the field mapping and where UI-only profile edits go (the 0002 guard already blocks authority-field self-updates).
- **Session lifecycle:** Firebase sessions persist independently; after cutover there is exactly one session. The bridge's fail-closed behavior is preserved by making native sign-in the only path; no fallback (§11).
- **Auth listener differences:** Supabase `onAuthStateChange` fires on `TOKEN_REFRESHED`/`SIGNED_IN` repeatedly — the context must debounce/ignore redundant events to avoid reload loops.
- **Signup provisioning dependency:** `backfill_profile_on_signup` provisions **only when `tenant_slug` is in raw user metadata**. The current Firebase volunteer flow does not write `tenant_slug`; native signup must add it (the hosted fixtures already prove the trigger path works).
- **Tenant resolution risk:** none new — JWT claims + profile row already server-side; client continues to never supply tenant.
- **Route guard risk:** none if `loading`/`accessLoading` semantics are preserved exactly; the two-stage pattern must not collapse into one (admin pages branch on `accessLoading`).
- **RLS mismatch risk:** assignments/grants RLS return own-rows only — identical to the Firestore rules' effective behavior for these queries.
- **Server/client boundary:** `hasPermission` re-timing (§C) is the main risk; mitigated by keeping the DB answer authoritative and the client derivation presentation-only.
- **Locked-module accidents:** mitigation is the contract-preservation rule (§C) plus running the full 553-test regression after every implementation step; any locked-module diff is a stop-condition.

## H. Explicit GO/NO-GO

No blocker found: the Supabase identity substrate is complete, hosted, and exercised; the AuthContext contract is fully mappable; consumers are inventoried; the migration sequence is separable without touching locked modules.

```text
CORE IDENTITY CUTOVER — GO
```

---

## Gate Validation (§13)

```text
POLITICORE PLATFORM CORE IDENTITY / AUTH ARCHITECTURE GATE

Status:
GO

Current Firebase Consumers:
[45 files (24 consumer files + 21 lib/firebase service modules)]

Core Identity Consumers:
[7 (AuthContext, login, volunteer, members/add, Header, portal layout, session-bridge)]

Shared Core Consumers:
[6 surfaces (portal notifications, tenant constant, audit logs, admin directory ×3, media—non-Firebase)]

Module Consumers:
[1 legacy file (firebase/election.ts — zero live importers, rollback reference only)]

Public Content Consumers:
[10 surfaces (news ×4, contact ×2, biography, gallery, manifesto, announcements, settings, donations, homepage)]

Legacy/Diagnostic Consumers:
[6 zero-consumer files (devseed, election-seed, organizationalAssignments, permissionGrants, storage, jobs-stub)]

Canonical Supabase Identity:
[Native Supabase Auth session → auth.users.id → profiles view (0007 signup trigger, 0002 guard) → server-resolved tenant via current_tenant_id()/JWT claims (0006) → assignments view (0026) + grants (RLS) → AuthContext. Firebase UID not required. One canonical source; no bridge, no fallback.]

Canonical Authorization:
[Database-only: politicore_has_permission + scope_covers + my_scopes_rpc + module_enabled + current_tenant_id (0002/0005/0014). No second resolver; lib/permissions.ts demoted to presentation-only mirror. JWT carries stable tenant_id + access_role only.]

AuthContext Contract:
[Preserved: user, profile, assignments, grants, loading, accessLoading, accessError, isSocialMember, isCampaignMember, isCampaignCouncilMember, hasPermission. Implementation sources swap to Supabase; hasPermission becomes DB-authoritative with client presentation retained. AuthContext loads identity/access only — never module datasets.]

Locked Modules Verified:
Social Force — PASS
Campaign — PASS
Election — PASS

TypeScript:
[0 errors]

Build:
[passed]

Regression:
[553/553 across 18 suites, 0 skipped — identical to Phase F lock baseline]

Working Tree:
[pristine — this gate modified zero source files; only this gate report was added]

Recommended Next Phase:
[Core Identity/Auth Implementation Phase 1 — migrate AuthContext + the four auth-surface flows (login, volunteer signup, admin member creation, logout) to native Supabase sessions per §F sequence; delete session-bridge on completion]

Blockers:
[none]
```
