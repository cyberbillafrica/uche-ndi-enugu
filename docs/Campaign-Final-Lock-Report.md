# Campaign Final Lock Report — Security, Cutover & Cleanup Review

**Status:** CAMPAIGN LOCKED
**Gate:** Final Campaign Lock Gate — Full Campaign Security, Cutover and Cleanup Review
**Previous gates:** Campaign Phase A → B → C → D → E (all COMPLETE with hosted acceptance)
**Scope of this gate:** verification, narrow remediation (one hygiene migration), and cleanup of Campaign-specific legacy dependencies. No feature work, no redesign of any domain.

---

## 1. Final status

**CAMPAIGN MIGRATION COMPLETE. CAMPAIGN SECURITY VERIFIED. CAMPAIGN CUTOVER COMPLETE. LEGACY CAMPAIGN FIREBASE PATHS REMOVED OR EXPLICITLY ISOLATED. CAMPAIGN LOCKED.**

Every §34 lock criterion verified. Zero §35 stop conditions triggered.

## 2. Scope

Reviewed: all Campaign routes, the Campaign service boundary, all Campaign migrations/RLS/RPCs (0000–0027), Phase A–E reports, hosted effective privileges, and the full Campaign-specific legacy dependency graph.

Changed in this gate (new files first):

| File | Change |
|---|---|
| `supabase/migrations/0027_campaign_lock_grant_hygiene.sql` | **New.** §21 remediation (below) |
| `tests/security/final-campaign-lock.test.ts` | **New.** 27-test final security suite (§27 matrix) |
| `scripts/db/verify-hosted-smoke-campaign-final.ts` | **New.** Hosted acceptance harness, 73 checks (§29 A–Y) |
| `docs/Campaign-Final-Lock-Report.md` | **New.** This report |
| `src/app/portal/campaign/members/[id]/page.tsx` | **Deleted.** Member-detail gate (§8) |
| `src/hooks/useScopedCampaignMembers.ts` | **Deleted.** Client scope-fan-out hook (dead) |
| `src/hooks/useOrganizationalAssignments.ts` | **Deleted.** Firestore org-assignment hook (dead) |
| `src/lib/firebase/campaignActivities.ts` | **Deleted.** Legacy Campaign Firebase service |
| `src/lib/firebase/campaignAssignments.ts` | **Deleted.** Legacy Campaign Firebase service |
| `src/lib/firebase/campaignMembers.ts` | **Deleted.** Legacy Campaign Firebase service |
| `src/lib/firebase/campaignReports.ts` | **Deleted.** Legacy Campaign Firebase service |
| `src/lib/firebase/campaignIssues.ts` | **Deleted.** Legacy Campaign Firebase service |
| `src/components/search/GlobalSearchModal.tsx` | Campaign activity search source: Firebase tenant-wide read → Supabase RLS `getActivities()`; member results now route to the Core admin surface |
| `src/app/portal/campaign/assignments/page.tsx` | Member-detail links now point to the Core admin member surface |
| `scripts/db/apply-hosted.ts` | 0027 registered with signature |
| `docs/Campaign-PhaseE-Implementation-Report.md` | §28 regression-enumeration correction |

## 3. Routes audited (§5)

`/portal/campaign`, `activities`, `assignments`, `reports`, `issues`, `coordination`, `members`, `area` — every route verified:

- **Data source:** Supabase/PostgreSQL only. Zero Firestore reads/writes, zero Firebase listeners, zero direct Cloudinary/R2, zero `user_access`, zero client-side authorization reconstruction. (Grep evidence: the only remaining `firebase`/`user_access`/`expandAssignmentToScopes` strings in active Campaign code are documentation comments and the established `no_firebase_session` session-bridge reason constant.)
- **Authorization:** every route fails closed via `resolveCampaignAccess()` — module disabled, unauthenticated, missing/invalid tenant, wrong tenant, no Campaign authority, Social-only, and Election-Officer-without-Campaign-authority all produce explicit non-empty states. Per-scope resources are re-authorized server-side per request.
- **UI behavior:** unauthorized ≠ empty; module-disabled ≠ empty; loading states distinct; workflow errors surfaced; no legacy actions reachable by direct route.

## 4. Services audited

`src/lib/supabase/campaign.ts` remains the single canonical Campaign service boundary. Reads flow through RLS-gated public views; every authority-bearing mutation flows through a `politicore` SECURITY DEFINER RPC via a thin `public` wrapper (0023/0024/0025/0026 pattern). No parallel service abstractions exist. `resolveCampaignAccess()` (access.ts) and `identity.ts`/`session-bridge.ts` are Core infrastructure.

## 5. Firebase dependencies removed / legacy cleanup manifest (§6/§7/§23/§24)

**Deleted (Campaign-specific, verified unimported after removal):**

- `src/lib/firebase/campaignActivities.ts`, `campaignAssignments.ts`, `campaignMembers.ts`, `campaignReports.ts`, `campaignIssues.ts` — legacy Firestore services; zero active importers after the two fixes below.
- `src/hooks/useScopedCampaignMembers.ts` — the client scope-expansion hook (`expandAssignmentToScopes` pattern); Phase E already removed its last active consumer.
- `src/hooks/useOrganizationalAssignments.ts` — Firestore organizational-assignment hook; Core data is exposed through the 0026 read-only view.
- `src/app/portal/campaign/members/[id]/page.tsx` — the legacy 1,400-line Firebase member-detail page (see §8).

**Fixed before deletion (last active Campaign Firebase reads):**

- `GlobalSearchModal` (mounted on every portal page) searched Campaign activities via a Firebase **tenant-wide** read — a pre-existing authority leak on top of being a cutover defect. Now uses the Supabase RLS-scoped `getActivities()`; results can only ever include what the caller's RLS context permits. Campaign member results now navigate to the Core admin member surface.

**Verified after cleanup:** zero `firebase`/`firestore`/`onSnapshot`/`getDocs`/`addDoc`/`setDoc`/`updateDoc`/`deleteDoc`/`user_access`/`expandAssignmentToScopes`/`getScopedCampaignMembers` imports anywhere in active Campaign code; full regression green after deletion; `tsc` and build pass.

**Retained (not Campaign's to remove):** all non-Campaign Firebase code — Social Force (legacy, unmigrated by explicit gate boundary), public-site functionality, and any remaining non-Campaign legacy paths. Social Force was not modified in any way (§25 verified below).

## 6. Member-detail disposition (§8)

The obsolete Campaign-specific implementation is **removed**, not rebuilt. `/portal/campaign/members/[id]` was the legacy Firebase profile-management page; profile/membership/access-role/organizational-assignment management is **Core-owned** (architecture §3.6; Final Gate §8). Core member-service management lives at `/portal/admin/members`; Campaign member-detail links now route there. No Campaign navigation references the deleted route. No parallel Campaign member-management system was created.

**Disposition statement:** *Campaign migration is complete.* Member-detail *profile management* is future **Core member-service** work, tracked separately; its absence does not affect Campaign's data/security cutover.

## 7. Authorization verification (§9)

The model is intact and unchanged: identity (GoTrue/session-bridge) → tenant (server-resolved JWT claim) → Campaign membership → access role (`admin`/`member`/`election_officer` — organizational positions never encoded as access roles) → organizational assignment (position + scope via Core `organizational_assignments`) → registered location (`ward_id`/`polling_unit_id`, distinct from assignments, rendered and tested distinctly in Phase E) → permission (`position_permissions` defaults + explicit `permission_grants`) → scope (`scope_covers` polarity: ancestor→descendant allowed when authorized; descendant→ancestor denied; sibling denied; cross-tenant denied). All database-enforced; no client fan-out anywhere.

## 8. RLS / RPC verification (§20)

- All five Campaign operational tables: RLS **ENABLE + FORCE** (verified in the pristine check of the hosted harness).
- Mutation boundaries structurally enforced: reports UPDATE/DELETE `USING(false)`; issues UPDATE/DELETE `USING(false)`; assignments UPDATE revoked at table+view level; direct PostgREST abuse tests all fail-closed (§12 below).
- All 15 public RPC wrappers delegate to `politicore` authority RPCs; wrappers contain zero authorization logic; all DEFINER functions pin `search_path = politicore, auth, pg_temp`.
- No SECURITY INVOKER view exposes data beyond base-table RLS (`security_invoker` confirmed on every Campaign view).

## 9. §21 Hosted privilege audit — defects found and fixed (0027)

The audit of **effective** (not intended) hosted grants found a systemic defect: the **0007 provisioning era granted blanket `ALL` (incl. `TRUNCATE`) on public views to `anon` and `authenticated`**, and because grants are additive, the later migrations' explicit grants never narrowed them. This affected **every public Campaign view** plus `politicore_profiles`. All exposures were inert behind FORCE RLS — the harness proved every direct DML path refused — but writable surface is a standing hazard (any future RLS relaxation silently becomes client-writable), and TRUNCATE-class grants on application roles are never intended.

`0027_campaign_lock_grant_hygiene.sql` restores the exact ratified matrix:

| Relation | anon | authenticated |
|---|---|---|
| `campaign_activities` (view) | SELECT | SELECT, INSERT, UPDATE, DELETE (base-table manage path, by 0021 design) |
| `campaign_activity_participants` (view) | SELECT | SELECT |
| `campaign_assignments` (view) | — | SELECT, DELETE (0024's ratified service delete path; base-table DELETE policy — module gate, tenant, `create_assignment`, non-terminal — remains the boundary) |
| `campaign_field_reports` (view) | SELECT | SELECT |
| `campaign_issues` (view) | SELECT | SELECT, INSERT (permission-gated INSERT policy; lifecycle RPC-only) |
| `politicore_profiles` (view) | SELECT | SELECT (identity writes are Core operations) |
| `organizational_assignments` (view, 0026) | — | SELECT |

TRUNCATE: revoked from all application roles on all of the above. `service_role` retains full access for server-side ops. The migration self-verifies (raises on violation) and the hosted applier signature encodes the same invariants. Post-0027 effective grants were re-audited on hosted and match the table exactly. This closes the recurring "stale grants survive CREATE OR REPLACE VIEW" defect class (previously hit on `organizational_assignments` in Phase E) at the database level.

No stale grant remains. No anonymous write surface exists on any Campaign or Core view.

## 10. Scope / tenant / module-gate verification (§10/§14/§15)

Proven in the final suite and again on hosted (real JWTs): State/Zone/LGA/Ward descendant coverage; sibling ward and PU denial; ancestor polarity (a PU-registered member cannot read ancestor-ward data until a relationship — e.g. participation — exists); unauthorized directory filters yield **empty pages**, never leaks; pagination and search operate strictly inside the pre-authorized set; cross-tenant silence on every surface including filtered queries; module-disabled tenants are refused on directory, coordination, and all workflow RPCs (403/P0001 — no bypass through routes, RPCs, PostgREST, views, or any legacy path).

## 11. Workflow verification (§12)

- **Activities:** create (RLS INSERT policy), edit/update via RPC, status transitions via `set_campaign_activity_status` (guard set: initial-state, terminal-state, scheduled-start guards), participation/RSVP via `join_campaign_activity` (membership-gated), attendance via `record_campaign_attendance` (supervisor authority), organizer notifications from the server path.
- **Assignments:** create via `create_campaign_assignment` (tenant/creator/status server-pinned; assignee eligibility — campaign member + registered-location scope coverage — enforced), reassignment via `update_campaign_assignment_details`, workflow via `campaign_assignment_transition`, **terminal-state delete protection** (completed rows survive even supervisors), delete path policy-gated and grant-restored per §9.
- **Reports:** submission (reporter/status server-pinned, permission-gated), review/return via `review_campaign_report` (self-approval forbidden, reviewer permission + scope verified), resubmission via `resubmit_campaign_report` (owner + returned-state guards), audit + notifications server-side.
- **Issues:** INSERT-policy creation with full actor pinning, lifecycle (`acknowledge`/`assign`/`start`/`resolve`/`verify`/`close`) via `campaign_issue_transition` with per-action authority (manage permission at scope; `start`/`resolve` assignee-only; verifier independence: assignee cannot self-verify), assignee eligibility re-verified on assignment.

No workflow depends on any client-supplied actor, tenant, or authorization claim. Status fields are unreachable outside the RPCs.

## 12. Direct PostgREST abuse results (§19/§29-V)

All fail-closed, on hosted with real JWTs: anonymous directory/coordination/RPC calls return no data; report direct PATCH cannot move status (state asserted unchanged); issue direct PATCH cannot change status or assignee; direct activity UPDATE cannot forge `created_by` nor bypass status guards; organizational-assignment view INSERT/PATCH/DELETE cannot mutate Core rows; forged-actor and forged-tenant payloads have no effect; unauthorized filters return empty pages; module-disabled callers are refused. Cross-check: the local suite proves assignee-level DELETE zero-rows and completed-row delete survival.

## 13. Coordination / Directory / Area final review (§13/§14/§15)

- **Coordination:** composition-only — no `campaign_coordination` table exists (asserted by test); summary aggregates derive from authoritative tables inside one server RPC; plain members without organizational scope are refused; no CRUD returned to the page; org-assignment/permission-grant management remains Core.
- **Directory:** server-side search/filter/pagination (`campaign_members_page`/`_page_count`) composed **over** the authoritative `campaign_members_in_scope` definer RPC — outer filters can only narrow; membership ≠ directory authority (plain members denied); contact fields flow only through the permission-gated assignable path; Social-only denied.
- **Area:** derived exclusively from Core identity + live relational geography; no route parameter grants authority; registered location and organizational assignment rendered as distinct concepts; zero static geography lookups remain on migrated paths.

## 14. Media/evidence disposition (§16)

Campaign evidence remains the legacy unscoped URL string on `campaign_field_reports.evidence_*` — documented in Phase D and unchanged here; the Media Service migration is a separate pre-existing workstream. No direct Cloudinary/R2 call exists in any Campaign path; no fake Media Assets were fabricated.

## 15. Audit & notification verification (§17/§18)

All authority-bearing mutations (assignment create/review/status, activity status, report submit/review/resubmit, issue assign/verify) write `system_audits` with server-resolved actor + tenant; ordinary clients cannot INSERT, UPDATE, or DELETE audit rows (tested). Notifications are emitted from the server authority paths into the existing Core `notifications` infrastructure — no Campaign-specific table, no Firebase path, no client-supplied actors. Read-only Phase E surfaces introduced no audit noise.

## 16. Social boundary verification (§25) — Social Force untouched

- Social Force code, schema, permissions, and RLS: **zero modifications in this gate** (git status confirms no Social file touched).
- Database-level: zero Social Task/Leaderboard/points authority functions exist in Postgres (Social remains a legacy Firebase module); a Campaign-only member has literally no Social authority path to call, and Campaign code imports no Social service.
- Probe evidence: `leaderboard_submit`/`social_task_submit` RPC calls fail as nonexistent; member `points` value unchanged across workflow exercise; no Campaign navigation contains Tasks/Leaderboard/points; no Campaign leaderboard/points/tasks exist anywhere (tested).

## 17. Election boundary verification (§26)

Election untouched: no Election migration, RLS, workflow, or UI modified by this gate. Election Officer without Campaign authority is denied the Campaign directory and coordination (hosted-verified). Election suites remain green in the full regression (40 + 14 tests).

## 18. Static dependency scan (§30)

Within active Campaign code: `firebase`/`firestore`/`user_access`/`expandAssignmentToScopes`/`getScopedCampaignMembers`/`leaderboard`/`social_task`/`task_submission` — **zero** (only documentation comments and the `no_firebase_session` session-bridge reason constant). No Campaign code recreates Communications/Documents/Calendar. No realtime was introduced anywhere in this gate.

## 19. Performance / data-model review (§31/§32)

No N+1 geography queries, no client fan-out, no tenant-wide downloads, no per-member permission loops on any Campaign path; directory is one paged server-scoped query. Data model: no duplicate tables for users/profiles/memberships/org-assignments/permissions/geography/notifications/audits/media; Campaign tables remain exactly the legitimate operational domains (activities, participants, assignments, field reports, issues). Coordination has no table.

## 20. Final security suite (§27)

`tests/security/final-campaign-lock.test.ts` — **27/27** against the local PGlite database (migrations 0000–0027): tenant isolation, module gate, identity, membership shapes (none/social-only/campaign-only/dual), access roles (admin/member/election officer), full scope hierarchy with polarity, Activities/Assignments/Reports/Issues workflow authority, coordination composition (incl. no-table assertion), directory search/filter/pagination, Core assignment-view read-only behavior, direct PostgREST abuse, and the legacy-boundary checks (no active Campaign Firebase path, no `user_access`, no client scope expansion, no Social/Leaderboard dependency).

## 21. Full regression + §28 reconciliation

**416/416 passed, 0 failed, 0 skipped, across 12 suites** (local `vitest.security.config.ts`, post-cleanup and post-0027 run):

| Suite | Tests |
|---|---|
| authorization | 18 |
| geography | 8 |
| phase1b | 16 |
| phase1c-election | 40 |
| phase2-election-app | 14 |
| phaseA-campaign-core | 68 |
| phaseB-campaign-activities | 80 |
| phaseC-campaign-assignments | 43 |
| phaseD-campaign-reports-issues | 47 |
| phaseE-campaign-coordination-members | 44 |
| tenant-isolation | 11 |
| **final-campaign-lock** | **27** |
| **Total** | **416** |

18+8+16+40+14+68+80+43+47+44+11+27 = **416** — exact.

**§28 reconciliation, stated precisely:** the Phase E report claimed "389/389 across 11 suites" while enumerating 12 suites whose counts summed to 397, listing a `phase1a 8` suite. **There is no phase1a suite on disk** — the enumeration erroneously double-listed geography's 8 tests under a nonexistent name, making the listed sum (397) wrong while the actual 389 total was right. The true Phase E inventory was the 11 suites now re-listed with the corrected enumeration in `docs/Campaign-PhaseE-Implementation-Report.md`. No historical count was manufactured; the correction explains the discrepancy and the file inventory behind it.

## 22. Hosted acceptance harness (§29)

`scripts/db/verify-hosted-smoke-campaign-final.ts` — **73/73 checks pass** against the real hosted Supabase project with real GoTrue accounts, real JWTs, real PostgREST, real RLS, and the real public RPC wrappers. Coverage: module enabled/disabled (A/B), admin tenant-wide (C), State/Zone/LGA/Ward/PU hierarchy (D–H), sibling denial + ancestor polarity (I/J), cross-tenant denial (K), social-only (L), plain-member denial (M), Election Officer (N), Activities/Assignments/Reports/Issues live workflow probes including negative authority probes (O–R), coordination + composition assertions (S), directory paging/filter scope-safety (T), Core org-assignment view (U), direct PostgREST abuse incl. anonymous and forged-actor (V), effective-grant/stale-privilege checks (W), legacy dependency checks incl. nonexistent Social authority and untouched points (X), pristine cleanup (Y).

**Cleanup/pristine results (§29 end-state):** 0 temporary tenants; 0 temporary users; 0 temporary organizational assignments; 0 temporary campaign operational/permission/audit rows; FORCE-RLS restored on every table the harness touches (verified by query); no stale grants.

## 23. Build / type / lint (§30)

- `npx tsc --noEmit`: **0 errors** (re-run after every change in this gate).
- `npm run build`: **passes** (compiled successfully).
- Touched-file ESLint (campaign routes, campaign.ts, geography.ts, GlobalSearchModal, final suite): **0 errors, 0 warnings**.

## 24. Deviations from the gate prompt

1. **0027 grants `DELETE` on the assignments view to `authenticated`.** The prompt's §7 list implies views are SELECT-only unless stated; the Phase C report documents the delete path as ratified with the base-table policy as boundary. 0027 first revoked too far (to SELECT-only), which broke the accepted, UI-exercised, policy-gated delete path and its Phase C suite; the grant was restored to exactly the 0024-ratified shape (`authenticated` only — anon nothing; INSERT/UPDATE stay revoked; RLS policy remains the boundary). Documented rather than silently chosen.
2. No other deviations. No blockers were hidden; all §21 findings were fixed in-gate.

## 25. Deferred work / known non-blocking issues

- **Core member-service gate:** full profile/membership/access-role management surface (member-detail beyond Campaign views). Campaign dependency resolved by routing to `/portal/admin/members` (§6 above).
- **Media Service migration for Campaign evidence** (legacy URL strings) — pre-existing deferral from Phase D, unchanged.
- **Global Firebase cleanup** — explicitly out of scope; non-Campaign Firebase code (Social Force legacy, public site) remains untouched.
- **Legacy reference-only remnants** (e.g. `getAllCampaignActivities`-style Firebase helpers outside Campaign, if any) remain classified as non-Campaign and are not Campaign's cutover debt.

## 26. Cleanup manifest (§37-D)

- **Files deleted:** 8 (five legacy Firebase Campaign services, two legacy hooks, the legacy member-detail page) — all verified unimported post-removal by tsc/build/tests.
- **Files retained:** all non-Campaign Firebase/shared legacy code (retained reason: other modules' property; global cleanup forbidden by §24).
- **Active imports of legacy Campaign services:** zero.
- **Follow-up Core work:** member-service gate (above).

## 27. Final Campaign Lock decision (§37-E)

**CAMPAIGN LOCKED.**

All §34 criteria verified; zero §35 stop conditions. The Campaign module is a first-class, independently activatable module running exclusively on Supabase/PostgreSQL, with Core (identity/tenancy/membership/authorization/geography/org-assignments/notifications/audit/media) preserved as shared infrastructure, Social Force and Election untouched, and hosted effective privileges matching the ratified model exactly.

**STOP.** Awaiting the next explicit architectural gate (Social Force migration, Governance, Donations, Control Center, or otherwise).
