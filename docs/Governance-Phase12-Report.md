# PolitiCore — Governance Phase 12 Report

## Governance Delivery: Projects

**Status: PHASE 12 — COMPLETE — GATE: PASS**

**Architecture source:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md`
**Preceding:** Phase 11 Architecture Gate — PASS · Phase 10 Public Intake — COMPLETE

---

## 1. Phase status

```text
PASS
```

All §39 gate conditions verified: migration applies cleanly, RLS/security suite green, hosted acceptance 24/24, regression green, tenant isolation proven, Governance module gating proven, geographic authorization proven, `manage_projects` correct, canonical `governance_updates` correct, Core Media and Core Audit reused, no duplicate systems, locked modules untouched, Firebase fully retired, no later Governance domain implemented.

## 2. Migration

Five migrations (applied locally and to hosted; registered in `scripts/db/apply-hosted.ts`):

| Migration | Content |
|---|---|
| `0043_governance_projects.sql` | Core phase migration: 4 tables, `manage_projects` permission, 18 authority functions, FORCE RLS policies, status/identity/progress guards, audit, owner-assignment notification intent |
| `0044_project_rpc_restatement.sql` | Restated mutating RPCs from jsonb to explicit text-arg signatures (hosted/local convergence; jsonb overloads dropped) |
| `0045_project_authority_convergence.sql` | Scoped-grant authority fix in `create_governance_project` (creation with initial scopes correctly evaluated) + transaction-scoped GUC exemption so `set_governance_project_visibility` can pass its own identity guard |
| `0046_project_scope_attach_guard.sql` | `add_governance_project_scope` guard corrected to authorize the scope **being attached** (not merely other held scopes); also unblocks first-scope attachment on new projects |
| `0047_projects_public_surface.sql` | Public surface per the established 0034 convention: `security_invoker` views + `public.*` RPC wrappers + grants (hosted PostgREST exposes the `public` schema only) |

No historical migration was modified on hosted; convergence was achieved via additive restatements.

## 3. Database objects

**Tables (all tenant-scoped, FORCE RLS, fail-closed):**
- `politicore.governance_projects` — canonical project: lifecycle, planned/actual dates, budget fields (no ledger), aggregate beneficiary fields, milestone-derived progress, `is_public` visibility
- `politicore.governance_project_milestones` — ordered child records; completion metadata; progress derivation source
- `politicore.governance_project_scopes` — per-scope typed rows over Core Geography (state/senatorial zone/LGA/ward/polling unit); **`campaign` scope structurally impossible**
- `politicore.governance_updates` — the canonical Phase 11 update substrate; `evidence_asset_id → politicore.media_assets` (Core Media); **single-subject invariant enforced by CHECK constraint** (v1: project only; constraint written to be extended, not replaced, by later phases)

**Authority functions (politicore schema):** `create_governance_project`, `update_governance_project`, `set_governance_project_status`, `set_governance_project_progress`, `set_governance_project_visibility`, `create_governance_project_milestone`, `update_governance_project_milestone`, `add_governance_project_scope`, `remove_governance_project_scope`, `create_governance_update`, `set_governance_update_visibility`, plus guards/helpers: `assert_project_authority`, `has_project_geo_authority`, `guard_governance_project_identity`, `guard_governance_project_status`, `guard_project_milestone_completion`, `recompute_project_progress`, `make_governance_project_reference`, `governance_notify_project_owner`.

**Public surface (0047):** `security_invoker` views `public.governance_projects`, `public.governance_project_milestones`, `public.governance_project_scopes`, `public.governance_updates` (zero anon grants — anon receives 401, a stronger no-access proof than empty-200); `public.*` wrappers for the 10 mutating RPCs.

**Policies/permissions:** FORCE RLS + tenant-scoped policies on all 4 tables; no anonymous base-table policy; no DELETE policy for application roles (retention by RLS, enforced additionally by the identity guard against bypass-role deletes); `manage_projects` added to the canonical permission catalog (5th permission, zero new roles).

**Audit:** all significant mutations (create, update, status, visibility, scope changes, milestone operations) write to Core `system_audits` with server-resolved actor and tenant. No `governance_*_audits` table exists.

**Notifications:** one intent — `governance_notify_project_owner` on owner assignment via the status path — through Core Notifications. No fanout, no Governance notification subsystem.

## 4. Service layer

`src/lib/supabase/governance.ts` — extended with the Projects operations (list with status/geo filters via `!inner` scope embed, detail with milestones/scopes/updates, create, lifecycle transitions, milestone CRUD, scope management, updates, visibility). No new parallel service file. Every operation delegates authority to RPCs/RLS; the client never supplies tenant or actor.

## 5. UI

- `src/app/portal/governance/projects/page.tsx` — list (status filter, progress, management actions per permission)
- `src/app/portal/governance/projects/new/page.tsx` — create with lifecycle fields and geo scope drafting
- `src/app/portal/governance/projects/[id]/page.tsx` — detail: milestones workflow (add/edit/complete, derived progress), scopes, updates, evidence, visibility action
- `src/app/portal/layout.tsx` — Governance → Projects navigation entry, gated on Governance module + Governance visibility

No placeholder routes for future domains.

## 6. Authorization

- **`manage_projects`** — introduced through the canonical permission/grant architecture. Supports tenant-wide and geo-scope-scoped grants. No new role; tenant admins retain existing administrative authority.
- **Tenant enforcement** — server-resolved tenant (`current_tenant_id()`), FORCE RLS, all RPCs re-verify tenancy; cross-tenant access rejected (tested).
- **Geographic enforcement** — `assert_project_authority` / `has_project_geo_authority` evaluate the project's scope **collection** against the actor's `my_scopes()`; Core `scope_covers()` semantics give higher-scope coverage of descendants; attaching a scope requires authority over that scope; `campaign` scope rejected.
- **Module enforcement** — every RPC verifies Governance module activation; `view` and `manage` are separated (`view_governance` never implies `manage_projects`).

## 7. Security

`tests/security/governance-projects.test.ts` — **17/17**, covering: tenant isolation (read/mutate), module gating (Governance OFF blocks; Campaign/Election state irrelevant), permission (manage vs. view, scoped grants), geography (descendant coverage, unrelated-scope rejection, campaign-scope rejection, first-scope attach guard), milestones (ownership, unauthorized mutation, progress cannot contradict milestone-derived state), updates (canonical table only, single-subject invariant, no `project_updates` exists), visibility (private not public, RPC-only publication, anon zero-access), media (Core `media_assets` relationship only, no provider leakage), audit (canonical records, server-resolved actor), deletion (no application-role delete; institutional memory intact).

Additionally the Phase 11 architecture suite (`governance-phase11-architecture.test.ts`, 20/20) pins the authorized superseded state: 5-permission catalog, 48 migrations ending `0047_`, Projects route authorized, all earlier boundary properties still enforced.

## 8. Regression

| Check | Result |
|---|---|
| Full regression | **744/744 — 31 suites — 0 skipped — 0 failed** (727 baseline + 17 new) |
| TypeScript | **0 errors** |
| Build | **PASS** (`✓ Compiled successfully`) |
| Lint (touched files) | **0 errors** |

Run on the exact final file state, after the 0047 pin update.

## 9. Hosted acceptance

`scripts/db/verify-hosted-smoke-governance-projects.ts` — **24/24** on the real hosted Supabase (real GoTrue accounts, real JWTs, real PostgREST + RLS): project creation, listing, detail, milestone operations, geographic authorization (including unrelated-scope rejection), permission enforcement, tenant isolation, Governance module gating, update creation, visibility publication, audit attribution, media/evidence authorization, anon-surface behavior.

Hosted conventions surfaced and handled: PostgREST exposes `public` schema only (→ 0047 views/wrappers); zero-grant views yield **401** for anon; void RPCs return **204**.

**Cleanup: hosted pristine.** Residue probes returned 0 on every dimension (tenants, geo fixture rows, profiles, auth users, modules, projects, updates). Cleanup handled the `profiles` FORCE-RLS cascade no-op (temporarily disabled for the admin purge) and child-first geo deletion. Temp probe/cleanup scripts deleted.

## 10. Boundary verification

```text
Social Force          unchanged
Campaign              unchanged
Election              unchanged
Notifications         unchanged (reused)
Events                unchanged
News                  unchanged
Announcements         unchanged
Core Identity         unchanged
Core Geography        unchanged (reused: existing tables + scope_covers/my_scopes)
Core Audit            reused, not modified (system_audits)
Core Media            reused, not replaced (media_assets FK; no provider SDK)
Firebase              fully retired (zero imports)
```

Also verified: no Commitments, no Consultations, no Surveys, no Polls, no Petitions, no Engagements, no Accountability dashboard, no Governance Analytics, no new identity system, no new roles, no Governance notification/audit/media system, **no project-specific update table**.

## 11. Deviations

Disclosed in full:

1. **Convergence migrations 0044–0047** were created during the phase rather than landing 0043 perfectly first. Each fixes a real defect discovered by the security suite or hosted acceptance: 0044 (RPC arg-shape parity), 0045 (scoped-grant authority at creation; GUC exemption so the visibility RPC passes its own identity guard), 0046 (scope-attach guard must evaluate the attached scope), 0047 (public surface required by the hosted PostgREST `public`-only convention). All are additive restatements; no hosted migration was rewritten.
2. **Phase 11 architecture-suite pins updated** (permission count 4→5; migration count 43→48 ending `0047_`). These pins encoded "Phase 11 did not implement" and were legitimately superseded by this authorized phase; all other Phase 11 boundary properties remain enforced and were re-verified.
3. **`0043` was corrected locally after its first local apply** (identity-guard GUC exemption) — never applied to hosted in the divergent form; both environments were proven converged via the 0045/0046/0047 applies.

No other deviations.

## 12. Deferred items

Explicitly deferred and **not implemented** (no tables, RPCs, services, routes, or placeholders): Commitments (Phase 13), Participation (Consultations/Surveys Phase 14, Petitions Phase 15, Polls Phase 16), Engagements (Phase 17), Accountability public surface (Phase 18 — the project visibility *field* exists per Phase 11, but no publication console, `/governance` hub, or public directory), Analytics (Phase 19), Manifesto linkage, anonymous participation, public budgeting.

## 13. Architecture integrity

```text
Phase 11 Architecture Gate
        ↓
Phase 12 Projects          ← this phase (complete)
        ↓
Phase 13 Commitments       ← next, not started
```

The implementation is a thin application of the Phase 11 decisions: canonical tables only, milestones-first progress derivation (recomputed server-side, never a second source of truth), aggregate-only beneficiaries, budget as fields, Core Geography/Core Media/Core Audit/Notifications reused, one canonical update substrate with the single-subject constraint written to extend (Commitments etc. will add subject columns, not a new model), exactly one new permission and zero new roles.

---

```text
════════════════════════════════════════════════════
 GOVERNANCE PROJECTS — PHASE 12: PASS
 4 TABLES · 18 RPCs · 1 PERMISSION · 0 NEW ROLES
 SUITE 17/17 · REGRESSION 744/744 · HOSTED 24/24
 TSC 0 · BUILD PASS · LINT 0 · HOSTED PRISTINE
════════════════════════════════════════════════════
```
