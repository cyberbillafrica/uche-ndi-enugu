# Social Force Phase B — Implementation Report (Tasks UI + Service Cutover)

**Status:** COMPLETE — all §28 acceptance criteria verified.
**Parent gate:** Social Force Architecture Gate (§55 Phase B) · **Prerequisite:** `docs/Social-PhaseA-Implementation-Report.md`
**Scope:** Canonical Social Force service boundary + Tasks UI cutover to Supabase/PostgreSQL. No dual-read, no dual-write, no Firebase fallback in the migrated Tasks path. Campaign and Election untouched.

---

## 1. Status

**COMPLETE.**

## 2. Discovery

Verified before editing (Phase A findings re-checked against current source):

- **Routes:** `/portal/tasks` (member) and `/portal/admin/tasks` (admin) — the entire Tasks surface. No other task routes or task hooks exist.
- **Member page (legacy):** Firestore `getActiveTasks()` listing + per-user submission history + inline submission workflow (proof URL for Share/Make Post; "Mark Completed"; pending/verified status chips).
- **Admin page (legacy):** Firestore `getAllTasks()`; create via `createTask`, **edit via direct `updateDoc` on the `tasks` document**, toggle via direct `updateDoc`; review modal via `getSubmissionsForTaskWithUsers`; verify via direct `updateDoc` on `task_submissions` (including an "unverify" path).
- **Shared surface:** `GlobalSearchModal` (portal layout) searched Tasks via the Firebase tenant-wide `getAllTasks()` read.
- **Legacy UI drift beyond the Phase A enums:** platform `other`, actions `post`/`follow`, status `expired` existed as form options only. The Phase A substrate enums are authoritative; the UI was constrained to the ratified enums.
- **Lifecycle confirmed:** `active ↔ inactive` only; no draft state anywhere. The admin page's "expired" presentation is computed client-side from `expiration_date`, not a stored state — preserved as presentation.

## 3. Files changed

| File | Change |
| --- | --- |
| `src/lib/supabase/socialForce.ts` | **NEW** — canonical Social Force service boundary (types, error machinery, reads over security_invoker views, mutations via Phase A RPCs) |
| `src/lib/supabase/access.ts` | Added `resolveSocialAccess` gate (admin → tenant-wide; `social_member` → member authority; else denied; module-gated fail-closed) |
| `src/lib/supabase/index.ts` | Barrel export for `socialForce` |
| `src/app/portal/admin/tasks/page.tsx` | Full cutover: Supabase reads + RPC mutations, fail-closed Social gate, enum-constrained form, review modal onto `verify_social_submission` |
| `src/app/portal/tasks/page.tsx` | Full cutover: Supabase reads, submission workflow bridged to `submit_social_task` RPC, fail-closed Social gate |
| `src/components/search/GlobalSearchModal.tsx` | Tasks search source swapped: Firebase `getAllTasks()` → RLS-scoped `getSocialTasks()` |
| `tests/security/phaseB-social-force.test.ts` | **NEW** — Phase B security suite (23 tests) |
| `scripts/db/verify-hosted-smoke-social-b.ts` | **NEW** — hosted acceptance harness (§19 A–I, 36 checks) |

No file was deleted: the legacy Firebase service functions (`getAllTasks`, `createTask`, `getActiveTasks`, `submitTaskCompletion`, `getUserTaskSubmissions`, `getSubmissionsForTaskWithUsers`, `verifyTaskSubmission`) are now consumed only by not-yet-migrated surfaces (dashboards, admin health/reports) — see §7.

## 4. Service migration

`socialForce.ts` is the single Tasks boundary:

- **Reads** (`getSocialTasks`, `getSocialTask`, `getMySubmission`, `getMySubmissions`, `getSubmissionsForTask`) hit the `public.social_tasks` / `public.social_task_submissions` security_invoker views — visibility is decided by RLS (tenant + module + membership/authority), never by the client. `getSubmissionsForTask` uses two queries (submissions + one batched profile lookup), never per-row fanout.
- **Mutations** are exclusively the Phase A authority RPCs through their public wrappers: `create_social_task`, `update_social_task`, `set_social_task_status`, `submit_social_task`, `verify_social_submission`. The service contains **no** `.insert()`, `.update()`, or `.delete()` — actor/tenant are server-resolved from `auth.uid()` (gate §41).
- **Errors** mirror the Campaign service: `SocialForceError` with `kind` (`unauthenticated` / `module_disabled` / `forbidden` / `invalid_transition` / `not_found` / `validation` / `conflict` / `infra`), classified from raw Postgres messages; query failures are never folded into empty lists.
- The `update_social_task` clearable-field mapping (`null` → empty string → server `nullif(btrim())` → NULL) is a tested contract.

## 5. UI migration

- **Admin Tasks:** database-resolved `resolveSocialAccess` gate (deny reasons rendered, never silent); create/edit through the service; status toggle through `set_social_task_status`; review modal reads via `getSubmissionsForTask` and verifies via the RPC. The legacy **direct-Firestore `updateDoc` edit/toggle/verify paths are gone**.
- **Member Tasks:** same gate; active tasks via RLS; per-task submission state comes from **one** `getMySubmissions()` query (legacy fetched the user's submissions once too — N+1 preserved-against); "Mark Completed" submits through the RPC with proof-URL rules enforced server-side.
- **GlobalSearchModal:** Tasks results now RLS-scoped; the Firebase tenant-wide tasks read is removed.
- UX preserved: same cards, badges, forms, statuses, deadline presentation, admin workflow, member workflow.

## 6. Authorization

`resolveSocialAccess` (new, in `access.ts` beside the Campaign/Election gates): identity → tenant membership → `module_enabled('social')` → authority (`admin` access role → tenant-wide; `social_member` → member; otherwise denied with `no_social_authority`). Campaign-only members and election officers are denied Social; social-only members are denied Campaign/Election by their existing gates. Route gating is defense-in-depth; RLS + SECURITY DEFINER RPCs remain the authoritative boundary.

## 7. Firebase cutover

Removed from the active Tasks path:

- `getActiveTasks` / `getAllTasks` / `createTask` / `submitTaskCompletion` / `getUserTaskSubmissions` / `getSubmissionsForTaskWithUsers` / `verifyTaskSubmission` calls in Tasks UI
- direct `doc(db, "tasks", …)` / `doc(db, "task_submissions", …)` `updateDoc` writes
- `GlobalSearchModal`'s Firebase tasks read

Static scan of the migrated path (`socialForce.ts`, both Tasks pages, `access.ts`): **zero** firebase/firestore imports or Firestore calls. `GlobalSearchModal` retains Firebase **only** for its Members/News sources (not-yet-migrated surfaces, documented in the Campaign lock report) — its Tasks source is Supabase-only, asserted by a dedicated test.

Legacy services remain in `src/lib/firebase/firestore.ts` temporarily because un-migrated surfaces still import them (per §14); no Firebase Tasks-only file was safely deletable in Phase B.

## 8. Testing

`tests/security/phaseB-social-force.test.ts` — **23/23**:

- module gating: every authority RPC + member read fail closed when social disabled, restore verified
- tenant isolation: cross-tenant update/transition refused (`task not found`), cross-tenant reads silent
- membership/authority: member cannot create/update/transition; campaign-only and election-officer denied; direct member UPDATE changes nothing
- lifecycle: active ↔ inactive via RPC; member visibility follows status; inactive/expired refuse submission; invalid data rejected (negative points, blank title); zero-point task legal but unscoreable; enum admits no draft state
- service contract: clearable-field mapping; typed error classification (§16) incl. `SocialForceError` message safety
- cross-module: no Campaign-owned task/points/leaderboard objects; social enablement grants no Campaign rows
- Firebase boundary: static scan of the migrated path + GlobalSearchModal Tasks source + RPC-only mutation proof

## 9. Full regression

**470/470 across 14 suites**, arithmetic exact:

authorization 18 · geography 8 · phase1b 16 · phase1c-election 40 · phase2-election-app 14 · phaseA-campaign-core 68 · phaseB-campaign-activities 80 · phaseC-campaign-assignments 43 · phaseD-campaign-reports-issues 47 · phaseE-campaign-coordination-members 44 · final-campaign-lock 27 · phaseA-social-force 31 · **phaseB-social-force 23** · tenant-isolation 11 = **470**. Zero skipped.

## 10. Hosted acceptance

`scripts/db/verify-hosted-smoke-social-b.ts` — **36/36** against the real hosted project (real GoTrue accounts, JWTs, PostgREST, RLS, public RPC wrappers):

- A Visibility (4) · B Module gate disable/restore (4) · C Admin create/read/update/status/audits (6) · D Social-member boundaries (4) · E Cross-membership (4) · F Tenant isolation (5) · G Direct PostgREST abuse (6) · H Firebase boundary static (2) · I Pristine cleanup (1: 0 tasks, 0 subs, 0 awards, 0 tenants, 0 users, 0 module rows)
- FORCE-RLS state restored on all touched tables during cleanup.

## 11. Campaign protection

`git status` shows no Campaign route/service/migration modification in this phase. Campaign suites green in full regression (final-campaign-lock 27/27, phaseA–E all green). The only Campaign-adjacent artifact is the pre-existing boundary-test wording in the lock suite, unchanged since the Phase A correction.

## 12. Election protection

No Election file touched; election suites green (phase1c 40/40, phase2 14/14). Election Officer continues to hold no Social authority (E3/E4 hosted, suite and harness).

## 13. Deviations

1. **Legacy "unverify" removed.** The admin page previously toggled verified→pending via direct Firestore writes. The Phase A substrate makes verified submissions immutable (award-linkage guard), so the review modal offers only "Approve & Award". This is the substrate behaving as ratified (gate §15: verification is authority-bearing and one-way); noted here per §27.13.
2. **Legacy enum drift constrained.** Form options `other` (platform), `post`/`follow` (actions), `expired` (status select) were UI-only and are not expressible in the ratified DB enums; the form now offers exactly the database's enums. `expired` remains as a computed *presentation* state from `expiration_date`.
3. **Submission workflow migrated as a bridge, not a feature.** §13 of the gate says Phase B must not implement submissions; the submission UI *already existed* in the member page and its removal would have broken a live product flow. It is wired to the Phase A `submit_social_task` RPC verbatim — no new capability. Phase C will own its full rework (history, resubmission UX, evidence handling).

## 14. Deferred work

- **Phase C — Submissions + Verification:** submission history UI, admin review desk rework, evidence handling, resubmission UX.
- **Phase D — Points + Leaderboard UI:** point history, totals, leaderboard surfaces.
- **Phase E — Dashboard/navigation/final Social cutover:** social dashboard, remaining Firebase imports (GlobalSearchModal Members/News, dashboards, admin health/reports), legacy service deletion.
- **Phase F — Social Force lock gate.**

## 15. Conclusion

Phase B is complete: the Tasks surface reads and writes exclusively through Supabase/PostgreSQL with the Phase A substrate authoritative, module gating and tenant isolation verified locally (23/23) and hosted (36/36), full regression 470/470, TypeScript 0 errors, build passed, touched-file lint clean, hosted project returned to pristine state.

**STOPPING before Phase C per gate §29.**
