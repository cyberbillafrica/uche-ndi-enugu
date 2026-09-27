# Social Force Phase D — Implementation Report (Points + Leaderboard UI)

**Status:** COMPLETE — all §33 acceptance criteria verified.
**Parent gate:** Social Force Architecture Gate (§55 Phase D) · **Prerequisites:** Social Phase A, Phase B (`docs/Social-Force-PhaseB-Implementation-Report.md`), Phase C (`docs/Social-Force-PhaseC-Implementation-Report.md`)
**Scope:** Read-only points/leaderboard presentation layer over the authoritative award ledger and Phase A projection. No point calculation or awarding, no second points system, no Campaign/Election changes.

---

## 1. Status

**COMPLETE.**

## 2. Discovery

- **Legacy leaderboard:** `/portal/leaderboard` read Firebase `getLeaderboard(50)` from the `leaderboard_public` collection — tenant-wide, rank computed by list index, ward name resolved client-side via `getWardById`. Consumers: the page itself + `SocialMemberDashboard` (`getLeaderboard(100)`, Phase E scope). `syncLeaderboardProjection` writes remain in the legacy service (unused by migrated code).
- **Legacy points presentation:** `SocialMemberDashboard` displays `profile.points` and derives leaderboard position client-side (`findIndex` over the fetched list). Tasks page shows per-task point values (display only). No dedicated points/history surface existed.
- **Authoritative model (Phase A, unchanged):** `social_point_awards` (immutable, `UNIQUE(submission_id)`, `points > 0`, `awarded_at` timestamp) → `profiles.points` server projection → `social_leaderboard` security_invoker view (reduced fields, `ROW_NUMBER() ... AS position`, `points > 0`). Award RLS was already module-gated + recipient-or-admin; the leaderboard view was **not** module-gated (see Deviations).
- **Critical mechanic:** PostgreSQL RLS policies apply only to **tables**, not views — the §16 gate therefore had to be implemented in the view definition, not via a view policy.

## 3. Service

`src/lib/supabase/socialForce.ts` remains the single boundary. Phase D additions (all reads; zero `.insert()/.update()/.delete()` anywhere in the service):

- `getMySocialPoints(supabase)` — total from the authoritative projection (`politicore_profiles.points`); never a client-side award reduction.
- `getMySocialPointHistory(supabase, { limit })` — bounded (max 200, default 50), deterministic (`awarded_at DESC`) read of the caller's ledger rows; task titles resolved with **two batched queries** (awards → submissions → tasks), never per-row fanout. Exposes only schema-supported fields: points, source, awarded_at, task linkage.
- `getSocialLeaderboard(supabase, { limit })` — the projection's own rows, ordered by its own `position`, bounded (max 100). No client sort, no rank recomputation.
- Types: `SocialPointHistoryEntry`, `SocialLeaderboardEntry`.

## 4. Points total

Source of truth: the server-maintained `profiles.points` projection (Phase A's verified-submission aggregate), read through the tenant-isolated `politicore_profiles` view. Hosted-verified: a 25-point task verification produced exactly `points = 25`.

## 5. Points history

Source: `social_point_awards` via RLS (`recipient_id = auth.uid()` — members see only their own; admins via the bounded `social_admin_award_history` RPC). Fields displayed: task title (when the award links through a submission), points, award date, source. No invented fields; no tenant-wide download; no private contact fields (the ledger has none — verified by test).

## 6. Leaderboard

Reads exclusively from `social_leaderboard`. Rank is the projection's `position` column rendered directly (medal styling is presentation). Points/names are the projection's values. No second leaderboard model, no client ranking algorithm (asserted statically in the suite).

## 7. Geographic scope

Exactly what the Phase A projection supports: `ward_name`, `lga_id`, `zone_id` per row (Core geography joined inside the view). **No geographic filters were added** — the projection is tenant-wide with per-row geography context, matching both the legacy product (which showed ward names only) and the gate's instruction not to invent filters. Polling unit remains excluded by design.

## 8. Authorization

`resolveSocialAccess` gates both new/changed routes (UX layer). Database boundaries (all hosted-verified): awards readable by recipient-or-admin within tenant, module-gated; leaderboard view now additionally requires `module_enabled('social')` AND (admin OR social member) in its definition — module off or non-Social membership → zero rows for everyone, anon included. Admin point history RPC: unauthenticated/admin-authority/module checks mirror the verify RPC, tenant-pinned, bounded (1–200 rows).

## 9. Firebase cutover

`/portal/leaderboard` now reads the RLS-scoped projection — the Firebase tenant-wide `getLeaderboard` read is gone from the page; `getWardById` (client geography) replaced by the projection's own `ward_name`. Static scan (suite + hosted harness) proves the three migrated surfaces (`socialForce.ts`, leaderboard page, points page) have zero Firebase/Firestore imports, zero `getLeaderboard`, zero `onSnapshot`. Remaining legacy consumers (documented, out of Phase D scope): `SocialMemberDashboard` (`getLeaderboard`, `getUserTaskSubmissions` — Phase E), plus non-Social Firebase consumers elsewhere.

## 10. Write protection

The service offers no `awardPoints/setPoints/updatePoints/setRank/updateLeaderboard` (static test). Database-verified (local suite + hosted): award INSERT/UPDATE/DELETE denied; `profiles.points` mutation denied for member and admin; leaderboard INSERT/UPDATE/DELETE denied (projection is read-only over the invoker's rights); points unchanged after all probes. No admin point/rank editing UI exists.

## 11. Testing

`tests/security/phaseD-social-force.test.ts` — **21/21**: award/projection consistency · member own-points read · direct points mutation denied (member AND admin) · award INSERT/UPDATE/DELETE denied · no point-write API in the service · history privacy (own-only, cross-tenant silent, admin RPC tenant-pinned at exactly the fixture count, no private fields) · admin RPC admin-only + module-gated · leaderboard reads/rank/points/positions contiguous · tenant isolation · reduced-projection field assertions (no email/phone/PU/access_role/membership_types; has name/points/position/ward_name) · **0029 module gate (disabled → empty for member and admin)** · membership gate (campaign-only/officer) · anon fail-closed · projection immutability · ranking contract (UI consumes `position`; no client sort/rank) · error classification · Firebase static boundary.

## 12. Full regression

**515/515 across 16 suites**, arithmetic exact:

authorization 18 · geography 8 · phase1b 16 · phase1c-election 40 · phase2-election-app 14 · phaseA-campaign-core 68 · phaseB-campaign-activities 80 · phaseC-campaign-assignments 43 · phaseD-campaign-reports-issues 47 · phaseE-campaign-coordination-members 44 · final-campaign-lock 27 · phaseA-social-force 31 · phaseB-social-force 23 · phaseC-social-force 24 · **phaseD-social-force 21** · tenant-isolation 11 = **515**. Zero skipped.

## 13. Hosted acceptance

`scripts/db/verify-hosted-smoke-social-d.ts` — **26/26** against the real hosted project (real GoTrue JWTs, PostgREST, RLS, views): A points total (fixture verify → 25) · B history · C privacy · D leaderboard entry/points/rank/name/geography · E no email/phone/PU · F tenant isolation · G module gate off/restore (leaderboard, history, admin RPC) · H mutation abuse (7 probes + unchanged-points confirmation) · I Firebase static · J pristine cleanup (0 tasks, 0 subs, 0 awards, 0 tenants, 0 users, 0 module rows; FORCE-RLS restored). 0029 was applied to hosted via the registered applier with its self-verification before the harness ran.

## 14. Campaign protection

Phase D footprint: `socialForce.ts` (read additions), two pages (`/portal/leaderboard` rewrite, `/portal/points` new), one navigation link on the Tasks page, migration 0029 (Social-only view + function), the Phase D suite/harness/report, and the applier registration. No Campaign file, migration, route, or authorization touched; Campaign suites green; the lock suite's no-Campaign-points/leaderboard invariant passes.

## 15. Election protection

No Election file touched; election suites green (40 + 14). Election Officer gains no Social authority (suite + §8 boundaries).

## 16. Deviations

1. **Migration 0029 required (gate-expected hardening, documented here per §32.16).** The Phase A leaderboard view was not module-gated: its `security_invoker` exposure over `politicore.profiles` inherited the Core tenant-wide `profiles_read` policy, so a tenant with Social disabled could still read its leaderboard. Gate §16 requires fail-closed. Because PostgreSQL RLS does not apply to views, 0029 re-asserts the projection verbatim with `module_enabled('social') AND (is_admin() OR has_membership('social_member'))` in the view definition — anon grant retained (it still returns zero rows), Core `profiles` policy untouched, ranking and field contract unchanged. Verified locally and hosted (G1/G4).
2. **Bounded admin award-history RPC added (`social_admin_award_history`)** — per §10 this is not a new accounting module: the product has no admin points view; the RPC exists to give admins a *bounded, tenant-pinned, authority-checked* read path equivalent to what the award RLS already grants, so no broad award-download surface (e.g., PostgREST embed abuse) is ever needed. Default 50, max 200 rows.
3. **`getMySocialPoints` uses `maybeSingle()`** on the profiles view — the projection row for the caller; if no row exists the service returns 0 rather than erroring (a session always has a profile row; defensive only).

## 17. Deferred work

- **Phase E — Social Dashboard + Navigation + final Firebase Social cleanup:** `SocialMemberDashboard` cutover (points card, leaderboard link, `getUserTaskSubmissions`, `getLeaderboard`), remaining portal Firebase consumers, legacy Social service deletion, broader navigation.
- **Phase F — Social Force Lock Gate.**

## 18. Conclusion

Phase D is complete: points totals, history, rank, and leaderboard are presented exclusively from the authoritative ledger and projections, with the leaderboard now module-gated (0029), zero client point/rank authority, write protection proven locally and hosted, Firebase reads removed from the migrated surfaces, full regression 515/515, TypeScript 0 errors, build passed, touched-file lint clean, and the hosted project returned to pristine state.

**STOPPING before Phase E per gate §34.**
