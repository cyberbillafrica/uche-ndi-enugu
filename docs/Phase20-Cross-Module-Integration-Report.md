# PolitiCore — Phase 20 Report

## Cross-Module Integration & Production Readiness Gate

**Status:** PHASE 20 — COMPLETE — **GATE: PASS**
**Type:** Verification & hardening gate — no product features added.
**Preceding:** Phase 19 — Governance Analytics & Institutional Memory — COMPLETE/PASS (913/913 · 24/24 hosted · residue 0)
**Scope:** Complete-application audit per the Phase 20 gate: authorization integration, tenant isolation, module activation, AuthContext contract, routing, public privacy, cross-module ownership, N+1, SECURITY DEFINER/ACL, Firebase boundary, legacy code, migration integrity, full regression, hosted acceptance.

---

## 1. Architecture integrity — PASS

ONE tenant model (`politicore.tenants`). ONE identity/auth system (Supabase GoTrue + `politicore.profiles`, trigger-provisioned). ONE authorization system (`0002` `has_permission` deny-wins + `permission_grants`). ONE geography system (`scope_covers`/`my_scopes` via Core Geography). ONE membership model (`profiles.membership_types`). ONE organizational-assignment model (`organizational_assignments`/`positions` with `grants_authority`). ONE notification / audit / media system (Core). ONE Events content model; Campaign activities and Governance engagements are separate domains (engagement→event reference only). ONE Governance Updates substrate. ONE Social Force / Campaign / Election model each. NO Firebase, NO duplicate history/analytics model, NO search infrastructure, NO warehouse. Verified statically (repo-wide greps) and pinned live in `tests/security/phase20-cross-module.test.ts` (20/20).

## 2. Authorization — PASS (1 defect found and repaired)

- No client-side role reconstruction; no hard-coded user/tenant IDs in `src/`; no client-supplied actor/tenant/scope anywhere (server-resolved via `auth.uid()`).
- Services delegate all mutations to SECURITY DEFINER authority RPCs; the single API route (`election evidence`) validates via GoTrue.
- `access_role_enum` = {member, election_officer, admin, tenant_super_admin, platform_super_admin} — coordinator/manager/chairman exist only as organizational positions, never access roles (§7 verified).
- **Defect found by the Phase 20 deny-wins probe:** `politicore.governance_analytics_tenant_wide()` checked `EXISTS(granted = true)` directly against `permission_grants`, bypassing Core deny-wins — a user holding both an allow and a deny unscoped grant could obtain tenant-wide analytics. **Fixed in `0059`** (authority check now routes through the Core deny-wins predicate), proven behaviorally (allow+deny ⇒ blocked; allow alone ⇒ works), propagated to hosted, Phase 19 suite re-verified 22/22.

## 3. Tenant isolation — PASS

Proven per-domain by the standing regression (every module suite carries cross-tenant read/mutate/infer journeys against role-impersonated sessions) and on hosted (isolation journeys in identity, social, campaign, election, content, governance harnesses — all passing). Analytics/memory cross-tenant zero-aggregate journey (J7) passes on hosted.

## 4. Module activation — PASS

Module activation is server-checked independently of authorization: disabled-module fail-closed is proven at the DB/RPC layer for Social Force (B5/B6), Governance (module-off journeys in every governance suite), Campaign and Election (final-lock harnesses). Navigation hiding is never the control.

## 5. AuthContext — PASS

Contract intact and unchanged: `user, profile, assignments, grants, loading, accessLoading, accessError, isSocialMember, isCampaignMember, isCampaignCouncilMember, hasPermission()`. Consumers audited: no stale Firebase assumptions, no duplicate permission loading, no route-level authority reconstruction; gating renders from complete access state.

## 6. Routing/navigation — PASS

Portal layout client-gates with `useAuth` and fails closed; 51/64 portal pages gate directly (the rest are nested under gated layouts). Direct-URL/refresh/nested-route access cannot exceed what the DB authorizes — RPC/RLS is the enforcement point (proven by the suites' direct-API journeys).

## 7. Public privacy — PASS

Public content flows only through the Phase 4 public surfaces; Governance public data only through Phase 18's `public_governance_*` RPCs with server-side `is_public` narrowing; analytics expose buckets/bands only (no identities, contacts, case text, answers, votes). No raw `tenant_id`/`created_by`/participant identifiers on any public surface.

## 8. Cross-module ownership — PASS

Governance has no FKs into Campaign/Election/Social tables (Phase 11 suite §A, still pinned). Events remain content; Campaign activities remain Campaign; Governance engagements reference but never mutate Events. Notifications, audit, media, geography all remain Core-owned. Institutional Memory derives from canonical records only (no second audit system).

## 9. Performance / N+1 — PASS

No per-row permission/geography RPC loops from the browser; analytics page batches all five surfaces in one `Promise.all`; RPCs are set-based SQL with bounded limits (memory timeline limit ≤200); no client-side aggregation of large sets.

## 10. SECURITY DEFINER / ACL — PASS

Audited live and statically. The `0002` broad table grants are the locked Core bootstrap pattern (FORCE RLS + zero anon policies makes them impotent; per-migration REVOKEs narrow sensitive RPCs — proven by anon-denial journeys in every suite). Analytics helpers are definer-internal with no role grants. Phase 19's stale-ACL hardening stands. The one authority defect (deny-wins, §2) is fixed.

## 11. Firebase boundary — PASS

Zero Firebase packages, imports, entry points, or executable references in `src/scripts/tests/supabase`. `errors.ts` mentions are the suite-allow-listed historical error-code mapping. **Repair:** the dead `NEXT_PUBLIC_FIREBASE_*` environment variables were removed from `.env.local` (zero code readers verified first) — §14 explicitly lists env configuration; the Phase 5 suite pins every other category.

## 12. Legacy / dead code — PASS

No obsolete service files or duplicate Supabase services remain (Firebase deletion completed in Phase 5). Untracked governance artifacts (migrations 0043–0059, suites, hosted harnesses, governance routes, phase reports) are active, validated prior-phase work — not dead code — and remain uncommitted pending the user's commit decision.

## 13. Migration / schema integrity — PASS

Migrations 0000–0059 (60 files) apply sequentially; the 0058→0059 convergence restatements follow the established pattern; no duplicate object creation, no broken references, no unexpected roles/tables; no migration reopens locked architecture. The Phase 20 deny-wins fix is additive within 0059.

## 14. Full regression — PASS

**933/933 — 39 suites — 0 skipped — 0 failed** (913 prior + 20 new Phase 20 gate tests). TypeScript: **0 errors**. Production build: **PASS** (71/71 static pages). Lint: **0 errors** (2 pre-existing warnings at untouched lines in `portal/layout.tsx`).

## 15. Hosted acceptance — PASS

Real hosted Supabase, real PostgREST + GoTrue, across all modules:

| Harness | Result |
|---|---|
| Identity (Core auth lifecycle) | **18/19** — A1 is the documented pre-existing hosted GoTrue limitation (`.test` signup HTTP 400); fallback still verifies the real provisioning trigger + real sign-in |
| Election | **39/39** |
| Campaign final lock | **73/73** |
| Social Force final lock | **27/27** |
| Public content | **32/32** |
| Governance analytics/memory (Ph. 19) | **24/24** |
| Members | **15/15** |
| Notifications | **17/17** |

Total: **245/246 checks** — the single non-pass is the documented external limitation, unchanged since Core Identity Phase 1.

**Hosted residue: 0** — after purging 26 orphaned harness profiles (`govsl-*`/`govnt-*`, pre-Phase-19-cleanup residue; child tables already absent; the one human account untouched).

## 16. Repairs performed (all minimal, tested, disclosed)

1. **Deny-wins fix** in `0059` `governance_analytics_tenant_wide()` (§2) — smallest root cause; behaviorally proven; hosted converged; Phase 19 suites re-verified.
2. **Firebase env removal** from `.env.local` (§11).
3. **Orphan purge** on hosted (26 profiles) — one-off TEMP script, deleted after run.
4. Test-suite corrections in the new Phase 20 suite (`planned` enum value, `ANY($1)` param counts) — test-only.

## 17. Deviations (disclosed)

1. Identity hosted acceptance stands at 18/19 (documented external GoTrue `.test`-domain limitation; fallback design unchanged since its commit at `e53075e`).
2. The deny-wins repair modifies a Phase 19 migration file (0059) rather than adding 0060 — consistent with the repository's convergence-restatement convention and avoids a migration solely to restate one function.
3. New test file `tests/security/phase20-cross-module.test.ts` (20 tests) added as this gate's required verification deliverable — no product surface.
4. Hosted purge used `session_replication_role = replica` (established harness convention) with explicit child-first deletes.

## 18. Final architecture status

All §21 invariants hold. Stop conditions: **none triggered** (no new tables, roles, permissions, systems, or redesigns were needed). Locked modules untouched this phase: the tracked working-tree modifications to `portal/layout.tsx`, `Header.tsx`, and `0016_election_seed.sql` predate Phase 20 (prior-phase Governance work, verified unmodified by this gate).

```text
POLITICORE — PHASE 20 — CROSS-MODULE INTEGRATION & PRODUCTION READINESS GATE: PASS
```
