# Social Force Phase E — Implementation Report (Dashboard + Navigation + Final Firebase Social Cleanup)

**Status:** COMPLETE — all §24 acceptance criteria verified.
**Parent gate:** Social Force Architecture Gate · **Previous:** `docs/Social-Force-PhaseD-Implementation-Report.md`
**Scope:** Social Member dashboard cutover, Social navigation completion, removal of the legacy Social Firebase service layer, absence proof. No Campaign changes. No Election changes. No dashboard redesign. No dual-read, no dual-write, no Firebase fallback anywhere in the Social Force path.

---

## 1. Status

**COMPLETE.** Phase E closed the last active Firebase consumer of Social Force data. Every Social surface now reads exclusively through `src/lib/supabase/socialForce.ts` over the Phase A substrate (RLS views + authority RPCs + projections). The obsolete Social-owned Firebase service functions were deleted from the shared Firebase file; the shared file itself survives intact for its non-Social consumers.

## 2. Discovery

Full consumer inventory performed before any edit (gate §3). Remaining references to the legacy Social paths at Phase E start:

| Legacy symbol | File:line | Classification |
|---|---|---|
| `getLeaderboard(100)` | `SocialMemberDashboard.tsx:158` | **A** — migrated |
| `getUserTaskSubmissions(profileId)` | `SocialMemberDashboard.tsx:159` | **A** — migrated |
| `getActiveTasks()` | `SocialMemberDashboard.tsx:160` | **A** — migrated |
| `getAllTasks()` | `admin/health/page.tsx:37` (task count) | **A** — migrated |
| `getAllTasks()` | `admin/reports/page.tsx:37` (task stats) | **A** — migrated |
| `syncLeaderboardProjection(...)` | `lib/firebase/auth.ts:97,224` (signup seed writes) | **A** — removed |
| `getAllUsers()` | `admin/members`, `admin/reports`, `GlobalSearchModal` | **B** — shared Core admin directory; preserved |
| `getUserProfile()` | `AuthContext.tsx` | **B** — shared Core identity bridge; preserved (its cutover is a later application phase) |
| `getPublishedNews` / news family | `news/*`, `admin/news`, `GlobalSearchModal` | **E** — unrelated content module; preserved |
| `submitContactMessage` family | `contact`, `admin/contact-messages` | **E** — unrelated; preserved |
| `getUserAnnouncements` | `portal/layout.tsx` | **B** — shared Core portal notifications; preserved |

The portal layout already carried the `socialOnly` nav flag (from Phase B/D) filtering on `isSocialMember`; Campaign Council and Election Operations group rules were untouched.

## 3. Remaining Social Firebase consumers found

Exactly the six classified **A** above — all eliminated this phase. After migration the repository-wide sweep (`getLeaderboard(`, `getUserTaskSubmissions(`, `leaderboard_public`, `users.points`, `syncLeaderboardProjection(`, `submitTaskCompletion(`, `verifyTaskSubmission(`) returns **zero hits in live code**; the only remaining occurrences are (a) the historical removal banner comment in `lib/firebase/firestore.ts`, (b) the Phase A–E implementation reports, and (c) the security suites themselves asserting absence. None are active consumers.

## 4. Dashboard migration

`SocialMemberDashboard.tsx` fully rewritten onto the canonical service — same UX, authoritative sources:

- **Tasks** — `getSocialTasks(supabase, { status: "active" })` (was `getActiveTasks()`). RLS decides visibility; the `deadline` field mapped to the relational `expiration_date`.
- **Submissions** — `getMySubmissions(supabase)` (was `getUserTaskSubmissions(userId)` with a client-supplied id). RLS pins rows to the caller; pending/verified counts and Recent Activity derive from this single bounded read (no N+1).
- **Points** — `getMySocialPoints(supabase)` from the server-maintained projection (was the Firebase `users.points` document riding on the AuthContext profile). Falls back to the profile snapshot only on load failure; never a client-side award reduction.
- **Leaderboard** — `getSocialLeaderboard(supabase, { limit: 100 })` (was the Firebase `leaderboard_public` tenant query). Position renders the projection's own `position` column; the legacy `findIndex() + 1` client ranking is deleted. Ward label uses the projection's `ward_name` instead of the legacy client geography lookup.
- **Gate** — the dashboard now runs `ensureSupabaseSession()` + `resolveSocialAccess(supabase)` and fails closed with the standard module/authorization message, matching Tasks/Points/Leaderboard.

## 5. Navigation changes

- Added the **My Points** leaf (`/portal/points`, `socialOnly: true`) to the member navigation, completing the Social surface set: Tasks · My Points · Leaderboard.
- Navigation gating remains the established `socialOnly && !isSocialMember` filter — presentation only; every Social page independently enforces `resolveSocialAccess` server-side, so direct routes stay fail-closed (§9).
- No Campaign, Election, or admin navigation rule was modified (verified by the Phase E suite and diff scope: 8 added lines in `layout.tsx`).

## 6. Global Search verification

`GlobalSearchModal` Tasks search was already cut over to `getSocialTasks` in Phase B; re-verified — its remaining Firebase imports (`getAllUsers`, `getPublishedNews`) are the non-Social Members/News sources (classification B/E, documented in the Phase B report). No Social-owned search path touches Firebase. No change required.

## 7. Firebase cleanup

Removed from `src/lib/firebase/firestore.ts` (§12 — each proved zero legitimate consumers):

`getActiveTasks`, `getAllTasks`, `createTask`, `submitTaskCompletion`, `updateTaskSubmission`, `getSubmissionsForTaskWithUsers`, `getUserTaskSubmissions`, `verifyTaskSubmission`, `getLeaderboard`, `syncLeaderboardProjection` — the entire Tasks / Task-submissions / Leaderboard sections — plus the leaderboard-projection sync side-blocks inside `updateUserProfile` and the two signup-time seed calls in `lib/firebase/auth.ts` (`signUpVolunteer`, `createMemberByAdmin`), whose only purpose was seeding the legacy `leaderboard_public` collection that now has zero readers. Firestore import list slimmed accordingly (`increment`, `runTransaction` no longer used).

**Preserved deliberately (not Social-owned):** `getAllUsers` (admin directory), `getUserProfile` (AuthContext identity bridge), the news family, announcements, contact messages, election results, portal content. The shared file was **not** deleted — it still serves those consumers (§12).

## 8. Authorization verification

- `resolveSocialAccess` unchanged and now applied on **every** Social surface including the dashboard: identity → tenant member → `module_enabled('social')` → admin or `social_member` authority; everyone else denied.
- Dashboard submission data: RLS-restricted to the submitter; no tenant-wide submission query was introduced for dashboard convenience (§8).
- Campaign-only members and Election Officers gain no Social authority; social-only members remain without Campaign/Election authority (0028 RLS + `resolveElectionAccess` social-only block, untouched).

## 9. Points/leaderboard verification

Hosted (real JWTs, §26 D): after a real verification of a 25-point task, `politicore_profiles.points = 25` for the recipient with exactly one backing `social_point_awards` row; `social_leaderboard` returns the entry with database-supplied `position`, correct points/name, and the reduced field set (no `email`, no `phone`, no `polling_unit_id` — asserted against every returned row). Leaderboard remains non-writable by any actor (0029 view + no INSERT/UPDATE/DELETE policy on the underlying projection path).

## 10. Submission-history verification

Member receives only their own submission rows (hosted D1: second member sees 0 rows; tenant-B member sees 0 rows cross-tenant). The dashboard summary composes from the same Phase C read the Tasks page uses — one query, no per-task fanout.

## 11. Campaign protection

No Campaign file, migration, route, or authorization touched. `git diff` scope for this phase: `SocialMemberDashboard.tsx`, `portal/layout.tsx` (8 lines), `portal/tasks/page.tsx` (Phase C/D leftovers only), `admin/health` + `admin/reports` (Social reads only), `lib/firebase/firestore.ts` + `lib/firebase/auth.ts` (Social-owned deletions), Phase E suite/harness/report. Campaign suites green: `phaseA-campaign-core` 68, `phaseB-campaign-activities` 80, `phaseC-campaign-assignments` 43, `phaseD-campaign-reports-issues` 47, `phaseE-campaign-coordination-members` 44, `final-campaign-lock` 27. The lock suite's no-Campaign-points/leaderboard invariant passes.

## 12. Election protection

No Election file, migration, route, or authorization touched. Election suites green: `phase1b` 16, `phase1c-election` 40, `phase2-election-app` 14. Election Officer gains no Social authority — hosted probe E2–E4 denies officer task creation, submission, and leaderboard reads.

## 13. Security tests

`tests/security/phaseE-social-force.test.ts` — **20/20**, covering:

- **Service boundary:** canonical service intact, zero client `.insert()/.update()/.delete()` (comment-stripped scan), leaderboard reduced-field contract, access gate shape.
- **Dashboard cutover:** Firebase-free imports; points from the projection (no `reduce`, no `users.points`); position from `mine.position`/`member.position` (no `findIndex`); submissions via `getMySubmissions` (no `getUserTaskSubmissions`, no tenant-wide query).
- **Navigation:** Tasks/Points/Leaderboard present with `socialOnly` gating; Campaign/Election nav rules untouched.
- **Absence proof (§16):** every migrated surface Firebase-free after comment stripping; all ten legacy functions deleted (no live export, no consumer); repo-wide `leaderboard_public`/`users.points` absence; GlobalSearchModal remaining Firebase imports provably non-Social; admin health/reports reading through the canonical service.

One pre-existing Phase C suite assertion was updated to the new reality (its "last legacy consumer" expectation flipped to absence) — the Phase C Firebase-boundary invariant itself is unchanged and stricter.

## 14. Full regression

```
phase1b                              16
phase1c-election                     40
phase2-election-app                  14
authorization                        18
tenant-isolation                     11
geography                             8
phaseA-campaign-core                 68
phaseB-campaign-activities           80
phaseC-campaign-assignments          43
phaseD-campaign-reports-issues       47
phaseE-campaign-coordination-members 44
final-campaign-lock                  27
phaseA-social-force                  31
phaseB-social-force                  23
phaseC-social-force                  24
phaseD-social-force                  21
phaseE-social-force                  20
────────────────────────────────────────
17 suites, 0 skipped, 0 failed      535
```

Arithmetic exact: **515 (post-Phase D) + 20 (new Phase E) = 535**.

## 15. Hosted acceptance

`scripts/db/verify-hosted-smoke-social-e.ts` — **27/27** against the real hosted project (real GoTrue accounts, real JWTs, PostgREST, RLS, views), including:

- A0 fixture journey (task → submission → verification, 25 pts) · A1–A4 the four dashboard reads · B1–B2 projection equality · C1–C3 projection-supplied rank and reduced fields · D1 own-submissions-only · E1–E4 campaign-only and officer denials · F1–F5 module gate off/restore across tasks, submissions, leaderboard · G1–G3 cross-tenant invisibility · H1 static Firebase-free proof over all migrated surfaces · I1 pristine cleanup (`tasks=0 subs=0 awards=0 tenants=0 users=0 mods=0`, FORCE-RLS restored).

Two initial harness assertions were corrected to match ratified contracts (F4: `politicore_profiles` is Core-owned and stays readable when social is off — the Social gate, not the view, is the fail-closed boundary for the UI; H1: shared-Core `getAllUsers` import is classification B, not a Social consumer). Both documented here; no security behavior changed.

## 16. TypeScript / build / lint

- `npx tsc --noEmit`: **0 errors**.
- `npm run build`: **passed** (re-run after final touch).
- Touched-file ESLint: **clean** — no error on any Phase E line. The only remaining reports/layout errors (`useState<any[]>`, two `any` props) are byte-identical pre-existing lines verified against the `HEAD` baseline.

## 17. Remaining legacy Firebase references (classification)

**Social Force has zero active Firebase consumers; remaining Firebase references belong to explicitly identified non-Social surfaces:**

- **B (shared Core, preserve):** `AuthContext.getUserProfile` (identity bridge; its cutover is a future application phase), `portal/layout.getUserAnnouncements`, `getAllUsers` (admin members directory + GlobalSearchModal Members source).
- **E (unrelated modules, preserve):** news family (`/news`, `/admin/news`, homepage), contact messages, biography/gallery/manifesto/donations/election Firebase services, `firebase/jobs` (activity reminders + stub aggregation job on System Health), `firebase/tenants` (`CURRENT_TENANT_ID` used by shared admin surfaces), `firebase/notifications` (portal notification center — Core Notifications, not Social).
- **Documentation/tests:** removal banner in `lib/firebase/firestore.ts`, Phase A–E reports, security suites asserting absence.

## 18. Deviations

1. **`admin/health` and `admin/reports` migrated in Phase E.** Their task counts/stats were Social-owned reads (classification A per §3 — "legacy Social task reads"). Migrating them was required to complete the Firebase cutover rather than scope expansion; they now use `getSocialTasks` behind `resolveSocialAccess`.
2. **Signup leaderboard-seed writes removed** (`lib/firebase/auth.ts`). They existed solely to seed the legacy `leaderboard_public` collection, which after the read cutover has zero readers and zero writers. Points now originate only from verified Social verification in the point-award ledger — strictly closer to the architectural invariant, never looser.
3. **Phase C suite assertion updated** (see §13) — expectation flipped from "dashboard still consumes legacy path" to "no consumer remains," preserving that suite's Firebase-boundary intent.
4. Harness F4/H1 assertions aligned to the ratified contracts described in §15 (documentation of correct expectations, not behavioral change).

None of these weaken security, create dual-read/write, or modify Campaign/Election behavior.

## 19. Deferred work

- **Phase F — Social Force Final Lock Gate:** full cross-module security/cutover/cleanup review and lock report.
- (Beyond the gate, noted for planning only: the application-wide AuthContext/identity cutover and the remaining non-Social Firebase modules are separate future efforts, each behind its own authorization.)

## 20. Conclusion

**Phase E is COMPLETE.** The Social Force application layer is fully on Supabase: dashboard, Tasks, Points, Leaderboard, and admin review all consume the canonical service over the authoritative Phase A substrate. Social Force has zero active Firebase consumers; obsolete Social Firebase code is removed; shared Firebase infrastructure remains intact for non-Social owners; hosted verification is green with a pristine environment; Campaign and Election remain locked and green.

Per gate §25: **STOP** — awaiting the **Social Force Phase F — Final Lock Gate** authorization.

```text
SOCIAL FORCE PHASE E COMPLETE · DASHBOARD + NAVIGATION ON SUPABASE
ZERO ACTIVE SOCIAL FIREBASE CONSUMERS · 535/535 REGRESSION · 27/27 HOSTED · HOSTED PRISTINE
STOPPING BEFORE PHASE F (FINAL LOCK GATE) PER GATE §25
```
