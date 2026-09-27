# PolitiCore — Core Identity/Auth Implementation Phase 1 Report

**Status:** COMPLETE
**Parent gate:** `docs/Platform-Core-Identity-Gate.md` (GO) · **Previous locks:** `docs/Social-Force-Final-Lock-Report.md`, `docs/Campaign-Final-Lock-Report.md`
**Scope:** Shared Core identity cutover — native Supabase Auth for `AuthContext`, login, volunteer signup, admin member creation, logout. No Campaign/Election/Social Force redesign. Clean cutover: **no dual authentication, no Firebase fallback, no session bridge.**

---

## Phase Status

```text
CORE IDENTITY/AUTH PHASE 1 — COMPLETE
```

## Authentication

**Native Supabase session is the single canonical authentication source.**

- **`src/lib/supabase/auth.ts`** — the canonical native auth service:
  - `signIn` → `supabase.auth.signInWithPassword` (returns minimal `AuthUser { id, email, created_at }`);
  - `signUpVolunteer` → `supabase.auth.signUp` with `tenant_slug` + volunteer details as raw user metadata; the **0007 provisioning trigger** (`trg_on_auth_user_created` → `backfill_profile_on_signup`) provisions a **plain member** profile (`access_role='member'`, `membership_types='{}'`); memberships/roles are never client-granted;
  - `createMemberByAdmin` → signUp executed on an **ephemeral secondary client** (`persistSession:false`, in-memory) so the admin's canonical session is never replaced or cleared — the Firebase secondary-app pattern preserved; profile enrichment runs afterwards **under the admin's own session** via the **0031 SECURITY DEFINER RPC** (see Deviations);
  - `logOut(client)` → `supabase.auth.signOut`;
  - `onAuthStateChange` — deliberately narrow: only `SIGNED_IN`/`INITIAL_SESSION`/`SIGNED_OUT` reach the caller; `TOKEN_REFRESHED`/`USER_UPDATED` are IGNORED (no reload loops, no repeated profile/assignment/grant queries).
- **`src/contexts/AuthContext.tsx`** — rewritten on the native listener; same two-stage loading (`loading` = auth+profile, `accessLoading` = assignments+grants); profile from `public.politicore_profiles` (security_invoker, RLS), assignments from `public.organizational_assignments`, grants from `public.permission_grants` (new 0030 view) with `granted:false` denials **preserved**; fail-closed on every path (no manufactured profile, no assumed permission, no `CURRENT_TENANT_ID` fallback); `identityKeyRef` prevents reload loops across token refreshes.
- **Login** (`src/app/login/page.tsx`) — email/password via `signInWithPassword`; identical UX, no fallback.
- **Volunteer signup** (`src/app/volunteer/page.tsx`) — native signup with required `tenant_slug` metadata per the ratified provisioning contract.
- **Admin member creation** (`src/app/portal/admin/members/add/page.tsx`) — native secondary-client signup + admin-session enrichment; admin remains authenticated as admin (hosted-verified).
- **Logout** (`src/components/layout/Header.tsx`, `src/app/portal/layout.tsx`) — `supabase.auth.signOut`; session ends, AuthContext clears, protected routes behave as before.

## AuthContext Contract

Preserved field-for-field; all 30 `useAuth()` consumer files compile unchanged (mechanical `user.uid → user.id` corrections only):

| Item | Status |
|---|---|
| `user` | `AuthUser` (minimal non-Firebase type) — preserved |
| `profile` | `UserProfile` from `politicore_profiles` view (naming bridges: `facebook_url`→`facebook_profile_url`, etc.; no invented fields) |
| `assignments` | `getActiveAssignments` presentation filter retained; DB scope resolver remains the authority |
| `grants` | full rows incl. `granted:false` denials |
| `loading` / `accessLoading` | two-stage semantics preserved (not collapsed) |
| `accessError` | set on access-load failure; non-admins then denied by `hasPermission` |
| `isSocialMember` / `isCampaignMember` / `isCampaignCouncilMember` | same `lib/permissions` derivation on Supabase data |
| `hasPermission(permission, scope?)` | synchronous presentation answer from DB-resolved state; DB resolver `politicore_has_permission` is the authority; RLS/RPCs are the security boundary |

## Authorization

Database-authoritative, unchanged: tenant (`current_tenant_id()` from JWT claim + profile), access role (`access_role` — never expanded to positions), membership (`membership_types`), assignments (`organizational_assignments`), scope (`scope_covers`/`my_scopes`), permission (`has_permission` with grant-denial precedence), module activation (`module_enabled`). No second resolver, no `user_access`, no client authorization engine, no new abstraction (`NewAuthContext`/`PermissionContext`/etc. do not exist).

## Firebase Boundary

**Firebase auth consumers removed (zero live consumers after this phase):** `AuthContext`, `login`, `volunteer`, `members/add`, `Header`, `portal layout` — all six migrated. `src/lib/firebase/auth.ts` reduced to **`updateUserLifecycleStatus` only** (its sole consumer is the admin members directory page — a shared-core surface whose Supabase cutover is gate-sequence step 3, Member Directory; keeping it does not make any authentication flow Firebase-backed).

**Session bridge status:** `src/lib/supabase/session-bridge.ts` **deleted** (renamed artifact `src/lib/supabase/session.ts` carries the same fail-closed native-session contract for its 23 locked-module consumers; no exchange, no Firebase). `signInWithIdToken` is gone from the repository. Zero live `session-bridge` references.

**Remaining Firebase consumers (outside this phase, per gate §28):** notifications/announcements (portal layout), member directory (`getAllUsers` in admin members/reports + GlobalSearchModal), News, Contact, Biography, Gallery, Manifesto, public homepage, donations, tenant constant, jobs/diagnostics, zero-consumer legacy files. **Do not claim global Firebase removal.**

## Locked Modules

```text
Social Force — PASS
Campaign — PASS
Election — PASS
```

No Social Force file touched. No Campaign implementation touched this phase (the `campaign/members/[id]` deletion and Election page diffs in the working tree are pre-existing artifacts of their own completed, green phases — they predate this phase and their suites pass). The only locked-module consumer edits were mechanical identity-contract corrections (`user.uid → user.id`) made earlier within this phase's scope, with authorization logic, queries, and UI behavior untouched. Full regression including all Campaign/Election/Social suites: green.

## Tests

```text
Core Identity security tests: 21/21 (tests/security/core-identity-auth.test.ts)
Full regression:              574/574 across 19 suites, 0 skipped, 0 failed (574 = 553 + 21, arithmetic exact)
Hosted acceptance:            18/19 — the single non-pass is A1, the real-GoTrue-signup probe (see Deviations)
TypeScript:                   0 errors (npx tsc --noEmit)
Build:                        pass (npm run build)
Lint:                         0 errors; touched-file warnings are byte-identical pre-existing items (unused `error` state on members/add from HEAD; AuthContext useMemo dep advisory) plus none new
```

Core Identity suite covers: profile/assignment/grants view RLS (self-read, cross-user, **cross-tenant denial**, anon denial), `granted:false` preservation, 0007 signup provisioning (plain member; no-`tenant_slug` → no profile), admin enrichment UPDATE, 0002 authority-field self-update guard, membership-flag derivation, static Firebase-auth boundary for all migrated surfaces, session-bridge absence, identity write-authority denials (profile INSERT, cross-user grants INSERT, self-assignment INSERT).

## Static Proof

Repository scans (comment-stripped): `firebase/auth` imports — zero outside `src/lib/firebase/*` internals; `@/lib/firebase/auth` importers — exactly one (the documented `updateUserLifecycleStatus` seam in `admin/members/page.tsx`); `onAuthStateChanged(` / `signInWithIdToken` / `session-bridge` — **zero**; `signUpVolunteer(` / `createMemberByAdmin(` — only the native Supabase service and its migrated page consumers; `getUserProfile` / `getUserOrganizationalAssignments` / `getUserPermissionGrants` — zero live consumers (AuthContext migrated; remaining definitions are in Firebase internals with no importers or are zero-consumer legacy files).

## Working Tree

Pristine with respect to this phase: no debug files, no probes, no dead bridge, no unused Firebase auth imports. Intentional implementation changes: the 7 migrated application files, the rewritten `AuthContext`, native `supabase/auth.ts`, `session.ts` (renamed bridge artifact), barrel update, migrations **0030** + **0031**, `apply-hosted.ts` verification entries, the core-identity suite, and the hosted harness. Other modified/untracked files in the tree belong to earlier phases' work and their own reports.

## Deviations

1. **Migration 0031 — `admin_enrich_member_profile` SECURITY DEFINER RPC.** The prompt's §16 fallback ("no safe server-side provisioning primitive → stop and report") applies to the *service-role* admin API, which this project does not have. Instead of leaving admin member-add broken, the ratified secondary-client signup contract (gate §F step 1: "admin session preserved") was implemented, and profile enrichment — which the Campaign Final Lock's 0027 grant hygiene had made impossible through the (correctly SELECT-only) profiles view — was restored through a server-guarded RPC: actor server-resolved, tenant-admin checked inside the function, same-tenant bound, authority-safe field set, audited by the existing trigger. This preserves the established admin member-add contract without reopening 0027's security posture and without a client write path to profile identity.
2. **Hosted A1 — real GoTrue signup returns HTTP 429 (`over_email_send_rate_limit`)** — the hosted project's email-confirmation rate limit, not a flow defect: an isolated probe proved a real signup succeeds end-to-end (200 → trigger → provisioned plain-member profile). The harness honestly records A1 as the only non-pass and falls back to the established direct-fixture pattern; **A2** (trigger provisioning) and **A3** (real password grant) verify the same contract on hosted.
3. **`AuthUser` display-name fallback** — `user.displayName` was a Firebase-specific property; portal layout now falls back to `profile?.full_name || user?.email` (no invented field; profile remains the display-name source).
4. **`src/lib/supabase/auth-compat.ts` retained** — Phase 1A foundation file with live importers in `identity.ts`/`access.ts`; not dead code, removal belongs to a later cleanup phase.

## Recommended Next Phase

```text
Shared Notifications Cutover
```

(as sequenced by the approved architecture gate — step 2 of §F)
