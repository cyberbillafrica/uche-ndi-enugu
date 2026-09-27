# Campaign Phase E — Implementation Report (Coordination + Member Directory)

**Status:** COMPLETE — all §41 acceptance criteria verified.
**Parent gate:** `docs/Campaign-Architecture.md` · **Previous:** `docs/Campaign-PhaseD-Implementation-Report.md`
**Scope:** Campaign Coordination + Campaign Member Directory/Area cutover to Supabase/PostgreSQL. No dual-read, no dual-write, no Firebase fallback. Social Force untouched. No realtime introduced.

---

## 1. Status

**COMPLETE.** Phase E acceptance gate (§41) passes in full. Hosted acceptance harness passes **39/39** with pristine cleanup. The Final Campaign Lock Gate has NOT started.

## 2. Files changed (this phase)

| File | Change |
|---|---|
| `supabase/migrations/0026_campaign_coordination_directory.sql` | **New** — coordination summary RPC + public wrapper; paged/searchable directory composition (2 RPCs + 2 wrappers); read-only org-assignment view (drop/recreate + grant tightening) |
| `src/app/portal/campaign/members/page.tsx` | Migrated to Supabase service (server-side search + scope-safe pagination) |
| `src/app/portal/campaign/coordination/page.tsx` | Migrated to a read-only organizational operational view |
| `src/app/portal/campaign/area/page.tsx` | Migrated to Core identity + live relational geography |
| `src/lib/supabase/campaign.ts` | Added `getCoordinationSummary` + `getMembersPaged` (+ `CampaignCoordinationSummary`, `CampaignDirectoryPageParams`; `CampaignDirectoryMember` gained registered-location fields) |
| `src/lib/supabase/geography.ts` | Added `getGeographyCounts` (tenant-neutral structural counts for the Area view) |
| `tests/security/phaseE-campaign-coordination-members.test.ts` | **New** — §33 security matrix, 44 tests |
| `scripts/db/verify-hosted-smoke-campaign-e.ts` | **New** — §35 hosted smoke, journeys A–N |
| `scripts/db/apply-hosted.ts` | 0026 added to the hosted migration list (signature covers the grant tightening) |

## 3. Migrations

**0026 only** — no new tables (§14: coordination is a composition, verified by a suite test asserting `politicore.campaign_coordination` does not exist), no RLS policy changes. The member directory's authority remains the ratified `campaign_members_in_scope` RPC (0021, wrapped 0024); Core organizational assignments remain the Core model (§12).

## 4. RPCs/views added or modified

- `politicore.campaign_coordination_summary()` — **new** SECURITY DEFINER aggregate over the already-migrated Campaign tables (members/activities/assignments/reports/issues), scoped by the caller's authority (admin/state/campaign tenant-wide; else `scope_covers`-covered organizational scopes); plain members refused; module-gated.
- `public.campaign_coordination_summary()` — thin SECURITY INVOKER wrapper (§27 convention).
- `politicore.campaign_members_page(p_search, p_lga_id, p_ward_id, p_limit, p_offset)` + `..._page_count(...)` — **new composition over the authoritative definer RPC**: server-side ILIKE search, registered-location narrowing filters (can only shrink the authorized set), stable `(full_name, id)` ordering, clamped pagination (1–200). Authorization is never re-implemented — unauthorized callers receive the identical underlying error.
- `public.campaign_members_page(...)` + `public.campaign_members_page_count(...)` — wrappers.
- `public.organizational_assignments` view — **read-only display surface** (§26/§28): security_invoker, SELECT grant only.

## 5. Member Directory migration

`/portal/campaign/members` — the legacy `useScopedCampaignMembers` client expansion (assignment → children → per-ward/per-PU queries → browser merge/filter — defect D2) and the static `getWardById` geography are gone. The page renders one server-scoped paged query; search submits to the RPC (server-side ILIKE); pagination controls page through the authorized set; contact fields render only what the database returned (phone stays gated behind `view_member_contacts` server-side). All §29 states present: loading / empty / unauthorized (distinct deny reasons incl. module_disabled and social_only) / errors — authorization failures are never folded into empty results.

## 6. Campaign Coordination migration

`/portal/campaign/coordination` — the legacy page (1190 lines) made direct Firestore reads of `users`, `organizational_assignments`, `permission_grants` and performed org-assignment CRUD + permission-grant CRUD with `user_access` index writes. The migrated page is an **organizational operational view** (§13): summary tiles from `campaign_coordination_summary` (aggregates only, zero duplication of Activities/Assignments/Reports/Issues modules) plus a read-only display of organizational assignments through the Core RLS view. Assignment/permission-grant management is intentionally absent — it remains a Core operation (§26); the `user_access` defect dies here.

## 7. Area/organizational-view migration

`/portal/campaign/area` — reads no route parameters at all (§15): registered location and active organizational assignments come from `resolveIdentity` (Core), labels from live relational geography (`resolveScopeLabels`), structural counts from `getGeographyCounts` (head-count queries). Registered location and organizational assignment are rendered as the distinct concepts they are (§16).

## 8. Service changes

`src/lib/supabase/campaign.ts` remains the single canonical Campaign boundary (no `campaignMembers.ts`/directory-service parallel files). Two additions: `getCoordinationSummary` and `getMembersPaged`. No Firebase reads, no `user_access`, no client permission reconstruction, no client scope expansion, no leaderboard/Social-Task references.

## 9. Authorization model

Unchanged and database-enforced: module gate (`module_enabled('campaign')` inside both RPCs) → server-resolved tenant → server-resolved actor → directory/coordination authority (admin, or `view_members`/`manage_members`, or covered organizational scope) → `scope_covers` polarity. Membership ≠ directory access (a plain campaign member is refused); membership ≠ position; position ≠ access role (§5 preserved end-to-end).

## 10. RLS behavior

No RLS policy changes. The org-assignment display view is security_invoker — the Core policies (own rows + tenant admins + platform admin) are the exact boundary, now proven over PostgREST: ward coord sees only own rows, admin sees tenant rows (5), INSERT/PATCH/DELETE all refused (403).

## 11. Scope behavior

State → Zone → LGA → Ward → PU descendant coverage verified at every level on hosted: ward sees own ward (not sibling), LGA covers both wards, zone covers the LGA, state = admin = tenant-wide; ancestor-only rows never exposed to lower scopes; cross-tenant always silent.

## 12. Social boundary verification (§19/§38)

- Social-only accounts: directory 403 (`not authorized to view the member directory`), coordination 403.
- Campaign-only members: **no** Social Task/Leaderboard authority path exists — the hosted database contains **zero** `politicore` functions matching leaderboard/social_task/task_submission (I2), RPC probes for `leaderboard_submit`/`social_task_submit` return 404 (I1), and `profiles.points` is untouched by Campaign paths. No Campaign leaderboard, points, tasks, or Social navigation exist; no Social services are imported into Campaign. The Social module remains legacy Firebase and was not modified.

## 13. Election boundary verification (§20)

Election Officer without Campaign authority: directory 403, coordination 403. Election untouched and green.

## 14. Audit behavior

Phase E adds no new authority-bearing mutations (read-oriented surfaces; §26), so no new audit events were introduced. Core assignment administration (outside Campaign) retains its own audit path. Forged-audit INSERT denial was proven in earlier suites and remains enforced.

## 15. Notification behavior

No new notifications (read-oriented phase; §25): the established per-user Notifications infrastructure is untouched and reused; no Campaign-specific notification storage exists.

## 16. Security test results

`tests/security/phaseE-campaign-coordination-members.test.ts` — **44/44 passed** on the local PGlite harness (migrations 0000–0026), covering §33: tenant isolation (directory + coordination), module gate (all authority levels, both surfaces), membership boundaries (social-only excluded and denied; non-member denied; plain member denied — membership ≠ access), hierarchical scope over the real Enugu geography with polarity (ward→PU, sibling-ward denial, LGA/zone/state descendant coverage, ancestor polarity), directory hardening (stable pagination, server search, unauthorized ward/LGA filters yield EMPTY pages — never leaks, identical underlying authority error for plain members), coordination authorization (admin tenant-wide 6, LGA covered, ward covered, plain member/EO refused, no coordination table), org-assignment view (own/admin visibility per Core RLS, zero mutation path), Social boundary (§38 structurally: no Social authority surface exists), Election Officer boundary, Admin tenant boundary.

## 17. Full regression results

**389/389 passed across 11 suites** (local `vitest.security.config.ts`; zero skipped):
authorization 18 · geography 8 · phase1b 16 · phase1c-election 40 · phase2-election-app 14 · phaseA 68 · phaseB 80 · phaseC 43 · phaseD 47 · **phaseE 44** · tenant-isolation 11 = 389 — all green, Election untouched.
> Correction (Final Lock Gate §28): this line originally listed a nonexistent `phase1a 8` suite and the arithmetic was mis-summed as 11 suites. There is no phase1a suite on disk; the true inventory is the 11 suites above (the earlier "389 across 11 suites" total was correct; the enumeration double-counted geography's 8).

TypeScript: `npx tsc --noEmit` — **0 errors**. Build: `npm run build` — **passes** (exit 0, BUILD_ID written). Touched-file ESLint: **0 errors, 0 warnings**. Dependency scans: no Firebase imports in migrated pages (session-bridge reason string only), no `user_access`, no `expandAssignmentToScopes`/`getScopedCampaignMembers`, no leaderboard/task references in Campaign code.

## 18. Hosted smoke results

`scripts/db/verify-hosted-smoke-campaign-e.ts` — **39/39 passed** against the real hosted project with real GoTrue accounts, real JWTs, real PostgREST, real RLS, real public RPC wrappers (§35):

- **A** directory population (admin tenant-wide; members-only filter; admin excluded) + count RPC parity · **B** hierarchy (ward/LGA/zone/state descendants; sibling-ward denial incl. filtered; cross-tenant denied-or-empty — never data) · **C** filters (valid ward filter narrows to 1; unauthorized ward filter → EMPTY page; unknown LGA → empty) · **D** pagination (disjoint ordered pages; filtered count scope-safe) · **E** coordination (admin tenant-wide aggregates with fixture counts; LGA covered; member-without-scope denied; social-only denied; EO denied) · **F** org-assignment view (own-rows vs admin; INSERT refused with state unchanged) · **G** module disabled (coordination 403 for tenant B admin) · **H** social-only directory denial · **I** Campaign-only Social boundary (no authority surface exists; points untouched) · **J** Election Officer denial · **K** admin boundary · **L** direct PostgREST abuse (anonymous denied; view PATCH/DELETE refused — state unchanged; anonymous view access denied) · **M** cross-tenant filter silence · **N** pristine cleanup (**0 temporary tenants, org assignments, operational rows, users**; FORCE-RLS state restored on all touched tables).

Harness corrections during the run (not product defects): named `p_*` POST args required by PostgREST for the paged RPCs (query-string params 404), a misplaced `::text` cast in the pristine query, and cross-tenant module-disabled expectations accepting the 403 refusal (stronger than an empty page).

## 19. Defects found and fixed

1. **Pre-existing writable `public.organizational_assignments` view on hosted (real security defect, found by L2/L3):** the hosted project carried a legacy-provisioned public view over Core organizational assignments with FULL DML grants to anon+authenticated — live INSERT/PATCH/DELETE succeeded before the fix. Because `CREATE OR REPLACE VIEW` preserves existing grants, 0026 now **drops and recreates** the view and explicitly revokes all mutation privileges (verified on hosted: only server-side `postgres`/`service_role` retain them; anon/authenticated hold SELECT only). The hosted applier signature now fails the migration check if mutation grants ever reappear.
2. **Cleanup ordering:** `system_audits` carries both tenant_id and actor_id FKs; cleanup now sweeps audits around every stage with a bounded retry loop (first-run leftovers were manually removed and the hosted project verified pristine before the accepted run).
3. Hosted PostgREST semantics: scalar-returning RPCs require explicit named arguments — harness fixed; no product change.

## 20. Deviations from this prompt

- The member **detail** page (`members/[id]`, 1444 lines) was intentionally **not** migrated: the authoritative architecture maps its profile/membership/access-role writes to the **Core member service** (§3.6), not Campaign (§26 boundary). It remains a legacy reference surface pending the Core member-service migration gate.
- `getMembers()` (the Phase A directory method) was preserved as the canonical established name; `getMembersPaged` was added alongside rather than renamed (§9 "use and harden... preserve the existing established name").
- Coordination displays org assignments read-only instead of offering management: management is a Core operation (§26), and the legacy page's assignment/grant CRUD was the defect being eliminated, not a behavior to preserve.

## 21. Deferred items

- Campaign member-detail surface migration (routes through the Core member service — separate gate).
- Legacy `useScopedCampaignMembers` hook and `getScopedCampaignMembers` service remain on disk as legacy reference (no migrated path imports them) pending the Final Campaign Lock Gate cleanup.

## 22. Unresolved issues

None blocking Phase E acceptance. All findings were fixed within 0026 or documented above.

## 23. Final Campaign Lock Gate confirmation

**The Final Campaign Lock Gate has NOT started.** No Firebase Campaign deletion, no legacy service removal, no Social migration, no Election changes, no Governance/Donations/Control Center work, no realtime, no Communications/Documents/Calendar recreation.

---

```text
PHASE E COMPLETE — HOSTED ACCEPTANCE GATE PASSED (39/39) — HARD STOP
Awaiting explicit authorization for:
FINAL CAMPAIGN LOCK GATE — FULL CAMPAIGN SECURITY, CUTOVER AND CLEANUP REVIEW
```
