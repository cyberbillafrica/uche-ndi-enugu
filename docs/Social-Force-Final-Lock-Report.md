# PolitiCore — Social Force Final Lock Report

**Status:** SOCIAL FORCE — LOCKED
**Gate:** Social Force Final Lock Gate (§27–§28) · **Previous:** `docs/Social-Force-PhaseE-Implementation-Report.md`
**Verification date:** September 24, 2026 · **Environment:** local + real hosted Supabase project

---

## 1. Final status

**PASS.** Every gate criterion verified across five completed phases plus this gate's independent review. No unresolved Social Force defect exists. Social Force is declared a **completed, first-class, LOCKED PolitiCore module**.

```
Phase A  Core + Authorization          31/31   COMPLETE
Phase B  Tasks UI + Service Cutover    23/23   COMPLETE
Phase C  Submissions + Verification    24/24   COMPLETE
Phase D  Points + Leaderboard UI       21/21   COMPLETE
Phase E  Dashboard + Nav + FB Cleanup  20/20   COMPLETE
Phase F  Final Lock (this gate)        18/18   COMPLETE
```

## 2. Locked scope

Tasks (create/edit/active↔inactive lifecycle/expiration/permissions) · Submissions (submit, proof URL, pending proof update, history, ownership protection) · Verification (admin, server-resolved points, immutable, audit + notification side effects) · Points (immutable `social_point_awards`, server projection, history, award uniqueness) · Leaderboard (`social_leaderboard`, DB position, reduced public projection) · Social Member dashboard (task/submission summaries, points, position) · Navigation (Tasks, My Points, Leaderboard — module-gated, direct-route protected).

No Phase G exists. No further Social Force work is authorized by this gate.

## 3. Ownership confirmation

**Social Force owns:** Social Tasks · Social Task Submissions · Submission Verification · Point Awards · Point History · Social Leaderboard · Social Member Social dashboard. Nothing else was added or moved during any phase, including this gate.

**Social Force does NOT own:** Identity · Tenancy · Authentication · Organizational Assignments/Positions · Geography · Core Authorization · Campaign · Election · Governance · Donations · Core Media · Core Notifications · Core Audit · Control Center. All consumption of Core services goes through the established Core surfaces (module flag, `current_tenant_id()`, `is_admin()`, notifications, `system_audits`).

## 4. Database objects

Verified against the hosted project catalog **and** the identical local PGlite DDL (final lock suite):

| Object | Kind | Notes |
|---|---|---|
| `politicore.social_tasks` | table | RLS **enabled + FORCED**; member/admin SELECT; admin-only INSERT/UPDATE policies |
| `politicore.social_task_submissions` | table | RLS **enabled + FORCED**; own-rows SELECT; INSERT pinned to own behalf + active/unexpired/scoreable task + proof rule; self-UPDATE only while pending; admin-verify WITH CHECK pins `status='verified'` |
| `politicore.social_point_awards` | table | RLS **enabled + FORCED**; SELECT own/all-admin; INSERT policy exists solely for the verify-RPC path; `UNIQUE(submission_id)` enforced |
| `public.social_tasks` / `social_task_submissions` / `social_point_awards` | views | `security_invoker=true`; REVOKE ALL from anon+authenticated; SELECT-only grants to authenticated |
| `public.social_leaderboard` | view | `security_invoker=true`; 0029 re-asserts it with `module_enabled('social')` + Social authority in the view definition; SELECT granted to anon+authenticated (reduced fields only) |
| `politicore.create_social_task / update_social_task / set_social_task_status / submit_social_task / verify_social_submission` | RPC cores | `SECURITY DEFINER`, `search_path = politicore, auth, pg_temp`, all authority checks inside |
| `public.*` wrappers of the five RPCs + `social_admin_award_history` | RPC wrappers | plain SQL invoker delegation — verified **not** definer; `social_admin_award_history` REVOKE PUBLIC, GRANT authenticated, 200-row cap, admin + module gated |
| `politicore.guard_social_submission` | trigger fn | SECDEF server-side re-validation of the direct-INSERT policy path |

Migrations: **0028** (substrate) and **0029** (leaderboard module gate + bounded admin history RPC) — both applied and verified on hosted. No anonymous DML grant exists; no duplicate accounting or leaderboard model exists.

## 5. Authorization model

```
authenticated identity → tenant resolution (server)
  → module_enabled('social') (DB) → Social authority (admin | social_member)
  → RLS (tables, FORCE) / SECURITY DEFINER RPC (mutations) → Social data
```

Hosted proof (F harness): the client cannot substitute `tenant_id`, `actor_id`, `recipient_id`, verification actor, point amount, award recipient, or leaderboard position — every authority mutation derives them from `auth.uid()` inside the SECDEF boundary, and direct-table probes fail (B2, C8, D3–D5, E4). The six-member identity matrix establishes every session class with real sign-ins.

## 6. Module activation

`module_enabled('social') = true` → authorized users receive Tasks/Submissions/Points/Leaderboard functionality. `= false` → tasks view empty (B5), submission RPC refuses (B6), leaderboard view returns zero rows (E5, 0029), history RPC refuses (Phase D G3), while Campaign/Election/Core identity remain untouched and Social data is not deleted. The flag controls activation, never ownership.

## 7. Membership boundaries

Hosted + suite proof: **Social member** — full participation per permissions. **Campaign-only** — zero Social rows, zero authority (B4). **Election Officer** — cannot create, submit, or verify; no leaderboard rows (Phase E E2–E4; Phase D). **Admin** — established Social administrative authority only (no manual point/rank editing anywhere). **Unauthenticated/anon** — no grants; in-function guards fail closed with `unauthenticated`. The inverse boundary also holds: social-only members are denied Campaign/Election (`is_social_only` + `resolveElectionAccess`), unchanged.

## 8. Points invariant

```
verified submission → exactly one award (UNIQUE submission_id)
  → points = server-resolved social_tasks.points (40 in F harness)
  → social_point_awards immutable (INSERT/UPDATE/DELETE probes 403)
  → profiles.points projection (direct mutation 403)
  → social_leaderboard projection
```

No client code can choose a point value, edit/delete an award, or mutate a profile balance. No manual point-correction interface exists. No React-side aggregation is authoritative (`getMySocialPoints` reads the projection).

## 9. Leaderboard invariant

`social_leaderboard` is the sole leaderboard model. Database-supplied `position`; no client ranking (`findIndex` absent from every Social surface); tenant-isolated (E3); module-gated (E5); non-writable even by admin (E4); reduced projection verified free of `email`, `phone`, `polling_unit_id` across every row (E2). Geographic fields remain exactly as the projection supplies: ward/LGA/zone context, no Polling Unit.

## 10. Submission invariant

Lifecycle remains `pending → verified`, verified immutable. Hosted proof: own-submission works (C1), second member independent row (C3/C4), re-verification refused (C5), cross-tenant verification refused (C6), members see only own rows (C7), direct mutation of a verified row denied (C8). No unverify path exists in the service (suite §14) and no rejection lifecycle was introduced. One submission per member/task preserved via the Phase A unique constraint and upsert RPC contract.

## 11. Proof model

**URL-based proof text** with the established length constraint — unchanged. No file upload, Cloudinary, R2, or Media Service integration was introduced. This absence is **intentional architecture, not unfinished work** (Phase C §11 disposition, reaffirmed).

## 12. Audit/notification boundary

Verification continues to write `system_audits` and submitter notifications through the Core infrastructure inside the SECDEF verify RPC — actor and tenant server-resolved. No Social-specific notification or audit system exists; Social writes no notification rows from React. (Cleanup paths across D/E/F harnesses account for and remove notification rows, proving the integration point.)

## 13. Firebase final boundary

> **Social Force is Firebase-free; the wider application is not yet globally Firebase-free.**

Live-code sweep (comment-stripped) across all Social surfaces, the service, search, layout, and the shared Firebase files: **zero** live references to `getActiveTasks(`, `getAllTasks(`, `createTask(`, `submitTaskCompletion(`, `updateTaskSubmission(`, `getSubmissionsForTaskWithUsers(`, `getUserTaskSubmissions(`, `verifyTaskSubmission(`, `getLeaderboard(`, `syncLeaderboardProjection(`, `leaderboard_public`, `users.points` (§14 list — all twelve symbols). Remaining matches are historical reports, suites asserting absence, and the removal banner in `lib/firebase/firestore.ts`.

Remaining Firebase usage outside this lock (explicit, not Social): AuthContext identity bridge (`getUserProfile`), Core portal notifications (`getUserAnnouncements`), Members directory (`getAllUsers`), News, Contact messages, `firebase/tenants` constant + `firebase/jobs` stub on System Health diagnostics, and unrelated content modules. The lock suite's `NON_SOCIAL_FIREBASE_CONSUMERS` classification enforces this boundary mechanically.

## 14. Privacy

Members see: own submissions (C7), own points/history (Phase D), permitted task info, reduced leaderboard. Members do not receive: another member's submissions, contact details, or organizational metadata. Admin visibility is bounded by tenant + Social authority — the only broad admin read is `social_admin_award_history`, capped at 200 rows and module-gated; it is not an export facility. Leaderboard remains reduced (§9).

## 15. Tenant isolation

Server-resolved tenant throughout. Verified separately for tasks (B4, G-series Phase E), submissions (C7 + Phase E G2), awards/history (Phase D F2), points projection (Core profiles view, tenant-scoped), leaderboard (E3), and admin history (tenant-pinned RPC). Cross-tenant verification is refused (C6). Tenant identity is never client-supplied.

## 16. Campaign protection

Zero Campaign changes in the Social phases (diff review §25). All six Campaign suites green: 68 + 80 + 43 + 47 + 44 + 27. The final lock suite structurally asserts that no Campaign/Election migration file contains Social DDL. Campaign remains **LOCKED and unchanged**.

## 17. Election protection

Zero Election changes. All Election suites green: 16 + 40 + 14. Election Officers gain no Social authority (hosted-proven). Election remains **LOCKED and unchanged**.

## 18. N+1/fanout review

Service reads are bounded and batched: dashboard = 3 parallel reads + 1 points read; point history = 1 bounded ledger read (≤200) + two batched `in()` lookups; admin review = 1 grouped count query or 1 submissions query + 1 batched profile lookup; leaderboard = 1 bounded ordered read (≤100). No per-row task/submission/profile loops exist in any Social surface (`for…await`/`map(async)` sweep clean). No tenant-wide download-and-filter pattern exists.

## 19. Route/UI review

`/portal/tasks`, `/portal/points`, `/portal/leaderboard`, the Social Member dashboard, and `/portal/admin/tasks` all run `ensureSupabaseSession` + `resolveSocialAccess` with distinct denied / loading / empty / error states; module-disabled renders the standard denial. Navigation exposes exactly Tasks · My Points · Leaderboard via the `socialOnly` filter. GlobalSearchModal's Tasks source is the RLS-scoped service. No stale Firebase loading path, duplicate Social UI, dead Social link, or hidden legacy route was found. No visual redesign occurred in this gate.

## 20. Migration hygiene

0028 + 0029 applied to hosted (verified via `apply-hosted.ts` ledger and live catalog). Intended objects all present. No temporary fixture objects, test-only schema, or obsolete duplicate Social schema exists; harnesses clean their fixtures and the hosted DB finished pristine. No destructive change outside Social occurred. Historical migrations were not rewritten.

## 21. Final lock tests

`tests/security/final-social-force-lock.test.ts` — **18/18**, architectural only:

1. Social tables/views/RPCs exist (§4 set, incl. `guard_social_submission`) ✓
2. Service is canonical: five RPC wrappers invoked, zero client `.insert/.update/.delete/.upsert`, reads via views ✓
3. Social UI Firebase-free (shared-Core diagnostics imports classified) ✓
4. Ten legacy functions: zero live consumers repo-wide ✓
5. Points server-authoritative: no `awardPoints`/`updatePoints`/points-assignment in any Social surface ✓
6. Awards immutable + unique: catalog UNIQUE(submission_id) ✓
7. Leaderboard projection-only + reduced (position contract, no PII fields) ✓
8. 0029 module gate present in the view definition ✓
9. Gate consults DB module flag; social-only election block intact ✓
10. Admin history bounded (200) ✓
11. No unverify path ✓
12. Campaign/Election migrations contain no Social DDL ✓

## 22. Full regression

```
authorization                         18
geography                              8
phase1b (election)                    16
phase1c-election                      40
phase2-election-app                   14
tenant-isolation                      11
phaseA-campaign-core                  68
phaseB-campaign-activities            80
phaseC-campaign-assignments           43
phaseD-campaign-reports-issues        47
phaseE-campaign-coordination-members  44
final-campaign-lock                   27
phaseA-social-force                   31
phaseB-social-force                   23
phaseC-social-force                   24
phaseD-social-force                   21
phaseE-social-force                   20
final-social-force-lock (new)         18
─────────────────────────────────────────
18 suites · 0 skipped · 0 failed     553
```

Arithmetic exact: **535 (Phase E baseline) + 18 (final lock suite) = 553.**

## 23. Hosted acceptance

`scripts/db/verify-hosted-smoke-social-f.ts` — **27/27** on the real hosted project (real GoTrue sessions for all six identity classes): authority RPC task creation, member denial, member read, campaign-only denial, module gate off/on across tasks + submissions + leaderboard, own submission, verification with server-resolved actor/points (40), re-verification refusal, cross-tenant refusal, own-rows-only reads, direct verified-row mutation denial, projection equality (40), award uniqueness, award INSERT/DELETE denial (403 incl. admin), profiles.points denial (403), leaderboard position/points/privacy/isolation/mutation-denial/gate, static Firebase-free proof, and pristine cleanup (`tasks=0 subs=0 awards=0 tenants=0 users=0 mods=0 notifs=0`, FORCE-RLS restored on 5 tables).

## 24. TypeScript / build / lint

`npx tsc --noEmit`: **0 errors** · `npm run build`: **passed** · touched-file ESLint: **clean** (remaining project warnings are pre-existing baseline lines, byte-identical to `HEAD`).

## 25. Git / diff review

The working tree contains the accumulated, uncommitted phases A–E work (the repository's last commit predates the campaign/social programs). Classification of every changed file:

- **Social Force (expected):** `socialForce.ts`, `access.ts`, `SocialMemberDashboard.tsx`, `portal/tasks`, `portal/points`, `portal/leaderboard`, `admin/tasks`, Social migrations 0028–0029, Social suites/harnesses/reports.
- **Shared Core (established by preceding phases, required by Social Force):** `lib/firebase/firestore.ts` (Social sections removed; shared exports preserved), `lib/firebase/auth.ts` (leaderboard-seed removal), `portal/layout.tsx` (Social nav leaf), `admin/health` + `admin/reports` (Social reads migrated), `GlobalSearchModal` (Tasks source), `lib/supabase/*` shared infrastructure (config, identity, session-bridge).
- **Campaign (expected zero changes):** none made by Social phases. The modified Campaign/Election application pages and deleted `lib/firebase/campaign*.ts` files in the working tree predate Social Force (Campaign Phases A–E application-layer migration, already locked and covered by their own suites) — verified: all Campaign and Election suites pass against the current tree.
- **Election (expected zero changes):** none made by Social phases.
- **Unrelated:** none introduced by Social Force.

No unexplained file changes were found; nothing required reversion.

## 26. Deviations

None in this gate. (Phase-level deviations remain as documented in their reports; the Phase E report's four documented deviations carry forward unchanged.)

## 27. Deferred / non-Social work

Explicitly outside this lock and requiring their own future authorization: the application-wide AuthContext/identity cutover to Supabase; the remaining non-Social Firebase modules (News, Contact, Members directory search, portal notifications, tenants/jobs diagnostics); Governance; Donations; Control Center. **No global Firebase migration is authorized by this gate.**

## 28. Final lock declaration

Social Force is architecture-complete, implementation-complete, authorization-verified, database-security-verified, hosted-acceptance-verified, Firebase-cutover-complete, with Campaign and Election protected, regression green (553/553), build green, and no known unresolved Social Force defect.

> ## **SOCIAL FORCE — LOCKED**

This is a claim about the **Social Force module**, not about the PolitiCore application as a whole:

- ✅ **Social Force complete** — the module is an independent, Supabase-native first-class PolitiCore subsystem: activatable without Campaign, coexistent with Campaign and Election, authoritative in PostgreSQL, Firebase-free, database-enforced.
- ⏳ **PolitiCore application complete** — **not** claimed. Identity/auth cutover and the remaining non-Social Firebase surfaces remain future platform-level work.

Per gate §30/§32: **STOP ALL SOCIAL FORCE IMPLEMENTATION.** No Phase G. No further Social features. No reopening of the Social Force architecture gate. The next product decision belongs to the **PolitiCore platform level**.

```text
════════════════════════════════════════════════════════════
 SOCIAL FORCE — LOCKED
 553/553 REGRESSION · 0 SKIPPED · 0 FAILED
 FINAL LOCK SUITE 18/18 · HOSTED FINAL SMOKE 27/27 · PRISTINE
 TSC 0 ERRORS · BUILD PASS · LINT CLEAN
 ZERO ACTIVE SOCIAL FIREBASE CONSUMERS
 CAMPAIGN LOCKED AND UNCHANGED · ELECTION LOCKED AND UNCHANGED
════════════════════════════════════════════════════════════
```
