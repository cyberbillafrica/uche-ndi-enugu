# PolitiCore — Governance Phase 13 Report

## Governance Commitments

**Status: PHASE 13 — COMPLETE — GATE: PASS**

**Architecture source:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md` (§4)
**Preceding:** Phase 12 Projects — PASS

---

## 1. Phase status

```text
PASS
```

All §40 gate conditions verified: migrations apply cleanly on both environments, RLS/security suite green, hosted acceptance 31/31, regression green, tenant isolation proven, Governance module gating proven, geographic authorization proven, `manage_projects` works for Commitments, Commitments independent of Manifesto, Commitment ↔ Project relationships correct, canonical `governance_updates` preserved, Core Media and Core Audit reused, no duplicate systems, locked modules untouched, Firebase fully retired, no later Governance domain implemented.

## 2. Migration(s)

| Migration | Purpose |
|---|---|
| `0048_governance_commitments.sql` | Core phase migration: 3 tables, 2 enums, `governance_updates` commitment-subject extension (single-subject constraint rewritten under the same name), 14 authority functions, FORCE RLS, lifecycle/identity guards, canonical audit triggers, 0047-convention public surface (views + grants + revokes + `public.*` wrappers) |
| `0049_commitment_authority_convergence.sql` | Restates `create_governance_commitment` mirroring the Phase 12 (0045) create semantics — scope-scoped grantees may create when all initial scopes lie within their authority; scoped grantee with no authorized scope aborts atomically |
| `0050_commitment_reference_trigger_fix.sql` | Restates the reference trigger: assignment moved **after** the uniqueness loop (0048's body assigned inside the loop and returned NEW with the column still NULL, failing the NOT NULL constraint on every insert) |

No historical migration modified; convergence is additive. `0048`'s recorded in-repository text was corrected to match 0049/0050's final bodies.

## 3. Database objects

**Tables (all tenant-scoped, FORCE RLS, fail-closed, zero anon policies, zero write policies):**
- `politicore.governance_commitments` — the Phase 11 §4 column set exactly: `reference_code` (GC-XXXXXXXX, server-minted), title, details, category label, `source_type` (6-value enum), `source_ref`, owner, 5-state lifecycle, `target_description`, planned start/target date, `completed_at` (server-stamped), explicitly reported `progress_percent`, `is_public`/`published_at`
- `politicore.governance_commitment_scopes` — mirror of `governance_project_scopes` over Core Geography; `campaign` structurally impossible via CHECK
- `politicore.governance_commitment_projects` — optional many-to-many join; no project metadata; UNIQUE (commitment, project)
- `governance_updates` — **extended** with `commitment_id` + partial index; `governance_updates_single_subject` CHECK rewritten under the same name (exactly one subject); project rows untouched

**Enums:** `governance_commitment_status` (declared, in_progress, partially_delivered, delivered, dropped), `governance_commitment_source_type` (manifesto, engagement, consultation, petition, request, independent — the Phase 11 vocabulary).

**Authority RPCs (politicore):** `create_governance_commitment`, `update_governance_commitment`, `set_governance_commitment_status`, `set_governance_commitment_progress`, `set_governance_commitment_visibility` (GUC-gated), `add_governance_commitment_scope` (bootstrap-correct per-scope authority), `remove_governance_commitment_scope`, `link_governance_project`, `unlink_governance_project`, `create_governance_commitment_update`, `set_governance_update_visibility` (restated: authority resolves by the update's **subject**), plus `assert_commitment_authority`, `has_commitment_geo_authority`, `guard_governance_commitment_status`, `guard_governance_commitment_identity`, `make_governance_commitment_reference`, `governance_notify_commitment_owner`.

**Public surface:** `security_invoker` views for the 3 new tables + re-expanded `public.governance_updates` (the 0047 view had frozen its column list before `commitment_id` existed); mirrored grants; explicit anon+PUBLIC revokes; `public.*` wrappers for the 10 mutating RPCs. Anonymous holds NOTHING (401).

**Audit:** canonical `system_audits` via `audit_authority_change` triggers on all 3 tables + explicit old→new audits in every RPC (create/status/progress/visibility/scopes/links). **Notifications:** one owner-assignment intent through Core notifications; no fanout.

**Permissions:** none added. The governance catalog remains exactly `assign_cases, manage_cases, manage_projects, view_cases, view_governance` (pinned live by C5).

## 4. Project relationship

`governance_commitment_projects` is an explicit optional join — one commitment ↔ many projects, zero required links in either direction. `link_governance_project`/`unlink_governance_project` require `assert_commitment_authority` (tenant + module + `manage_projects` + geo over the commitment) and verify the project is same-tenant (cross-tenant/forged ids fail closed). Re-linking is an idempotent no-op. **Links never grant authority** — proven both by C8 (a ward manager holding a linked project still cannot mutate or unlink the LGA-scoped commitment) and J8c on hosted.

## 5. Manifesto boundary

No `manifesto_id`/`manifesto_item_id`, no FK into the locked Manifesto module (C7 queries `pg_constraint` for governance→manifesto FKs: zero). `source_type='manifesto'` + `source_ref` are stored as display lineage without resolving or validating any Manifesto row — proven by C7 and J2c: a commitment with `source_ref='Manifesto §Health, item 2'` is created on a tenant holding **zero** `manifestos` rows. Manifesto tables untouched (git status: no manifesto file modified).

## 6. Update substrate

`governance_updates` remains the **only** Governance update system. Phase 13 added the `commitment_id` subject column and rewrote the same-name single-subject CHECK; `governance_commitment_updates` does not exist (C12 pins `to_regclass` = NULL). Project updates continue to work unchanged (C12 + J6c), and update visibility resolves authority by the update's subject (project → `assert_project_authority`; commitment → `assert_commitment_authority`).

## 7. Service layer

`src/lib/supabase/governance.ts` — extended with the Commitments section: types (`GovernanceCommitment`, `GovernanceCommitmentScope`, `GovernanceCommitmentProjectLink`, status/source unions + label maps), `listCommitments` (status/source/geo/`!inner`-embed filters), `getCommitment`, `listCommitmentScopes`, `listCommitmentProjects`, `listCommitmentUpdates`, `createCommitment`, `updateCommitment`, `setCommitmentStatus`, `setCommitmentProgress`, `setCommitmentVisibility`, `addCommitmentScope`, `removeCommitmentScope`, `linkProjectToCommitment`, `unlinkProjectFromCommitment`, `createCommitmentUpdate`. No parallel service file.

## 8. UI

- `src/app/portal/governance/projects/page.tsx` — Projects/Commitments tab bar (§24: Commitments as a tab under Projects, no new top-level module)
- `src/app/portal/governance/projects/commitments/page.tsx` — commitment list (status/source filters, progress, lineage display)
- `src/app/portal/governance/projects/commitments/new/page.tsx` — create with source-lineage fields and geo scope drafting
- `src/app/portal/governance/projects/commitments/[id]/page.tsx` — detail: lifecycle actions (legal transitions only), **reported-progress** panel (explicitly labeled as the single authority), scopes, link/unlink projects, lineage reference editor, updates with publish toggles

No placeholder routes; no public commitment directory.

## 9. Authorization

- **`manage_projects`** reused end-to-end (no `manage_commitments`, no new role). Tenant-wide holders and admins create tenant-wide; scope-scoped grantees create only at scopes within their authority and are refused tenant-wide creates (C1, J10b).
- **Tenant enforcement** — server-resolved tenant; cross-tenant reads return nothing, mutations raise `commitment not found` (C3, J9).
- **Geographic enforcement** — `has_commitment_geo_authority` evaluates the commitment's scope collection against the actor's grants via Core `scope_covers` (state grant covers zone/ward descendants — C6); per-scope attachment checks the scope **being attached** (bootstrap-correct); `campaign` rejected at table CHECK + RPC.
- **Module gating** — every RPC verifies `module_enabled('governance')`; Campaign/Election state is irrelevant (C4).

## 10. Security

`tests/security/governance-commitments.test.ts` — **17/17**: C1 create authority, C2 anon zero surface, C3 tenant isolation, C4 module isolation, C5 permission (catalog pinned at 5, no commitment permission), C6 geography (descendant coverage, unrelated-scope rejection, campaign rejection, unknown-geo fail-closed), C7 Manifesto boundary, C8 relationships + no authority through links, C9 cross-tenant relationship protection, C10 lifecycle, C11 progress authority + audit old→new, C12 canonical updates + single-subject invariant + project updates intact, C13 visibility (default private, RPC-only publication, guard raises on bypass writes, anon nothing), C14 media (same-tenant `media_assets` only), C15 canonical audit attribution, C16 no DELETE path, C17 schema pins (FORCE RLS, zero anon/write policies, grant hygiene, GC- references).

## 11. Regression

| Check | Result |
|---|---|
| Focused suite | **17/17** |
| Full regression | **761/761 — 32 suites — 0 skipped — 0 failed** (744 baseline + 17) |
| TypeScript | **0 errors** |
| Build | **PASS** (`✓ Compiled successfully`) |
| Lint (touched files) | **0 errors** |

## 12. Hosted acceptance

`scripts/db/verify-hosted-smoke-governance-commitments.ts` — **31/31** on the real hosted Supabase: anon zero surface (401), create with manifesto lineage (GC- ref minted, zero manifesto rows), RLS reads (staff vs plain member), lifecycle guard (illegal rejected, `completed_at` stamped, delivered terminal), progress authority (range enforced, persisted), canonical updates (single-subject row, project updates intact), subject-resolving update visibility, relationship lifecycle (link/no-op/unlink, links grant no authority, cross-tenant link rejected), tenant isolation, scope authority (ward-scoped create, tenant-wide refusal, unrelated ward, campaign forbidden), audit attribution (real hosted `auth.uid()`).

**Hosted flaw found and fixed:** 0049/0050 were initially **skipped** on hosted — my signature checks matched 0048's own bodies (non-discriminating), so the applier recorded them as applied without running them, leaving hosted on the broken bodies (J2 failed with the NOT NULL error exactly as the local pre-0050 suite had). The signatures were replaced with genuinely discriminating checks (`jsonb_typeof(p_scopes::jsonb)`; `end loop` position < `new.reference_code := v_ref` position) and both migrations were actually applied. Hosted local-vs-hosted function bodies were then verified identical via a live probe.

**Cleanup: hosted pristine.** Residue probes returned 0 on all twelve dimensions (tenants, commitments, scopes, links, updates, grants, profiles, auth users, all five geo tiers). The run's own cleanup handled the geo rows and FORCE-RLS restoration; the accumulated tenant/profile leak pattern (the Phase 12 lesson — tenants never deleted by the run cleanup, profiles shielded by FORCE RLS from the cascade) was purged in a one-off admin script with FORCE state restored. All temp scripts deleted.

## 13. Boundary verification

```text
Social Force       unchanged
Campaign           unchanged
Election           unchanged
Notifications      reused, not redesigned
Events             unchanged
News               unchanged
Announcements      unchanged
Manifesto          unchanged (zero FKs, zero schema changes)
Core Identity      unchanged
Core Geography     reused (existing tables + scope_covers/my_scopes)
Core Audit         reused (system_audits)
Core Media         reused (media_assets FK; no provider SDK)
Firebase           fully retired (zero imports)
```

Also verified: no Consultations, no Surveys, no Polls, no Petitions, no Engagements, no Accountability dashboard, no Governance Analytics, no new roles, no new identity system, no Commitment-specific notification/audit/media system, **no Commitment-specific update table**, no public Commitment directory.

## 14. Deviations

Disclosed in full:

1. **0049 convergence** — 0048's original create body required the tenant-wide `has_permission` result, wrongly rejecting scope-scoped `manage_projects` holders (a stricter-but-wrong variant of the Phase 12 create rule). Mirrors 0045 exactly.
2. **0050 reference-trigger fix** — 0048's `make_governance_commitment_reference` assigned `NEW.reference_code` inside the uniqueness loop before the `EXIT`, so the column stayed NULL and every insert failed the NOT NULL constraint. Restated with 0043's correct shape. (Caught by the local suite before any hosted apply of the broken shape; the hosted run then exposed the skip problem in item 3.)
3. **Hosted applier signature defect (process, not product)** — the first 0049/0050 signature checks were satisfied by 0048's own bodies, so the signature-based applier skipped-and-recorded them on hosted. Fixed with genuinely discriminating checks; both migrations applied for real; hosted bodies verified by direct probe; the harness then passed 31/31.
4. **Phase 11 suite D1 pin updated** (48→51 migrations, ending `0050_`) — legitimately superseded by this authorized phase; all other Phase 11 boundary properties re-verified green.

## 15. Deferred items

Explicitly deferred and **not implemented** (no tables, RPCs, services, routes, or placeholders): Participation (Consultations/Surveys — Phase 14), Petitions (Phase 15), Polls (Phase 16), Engagements (Phase 17), Accountability public surface (Phase 18 — `is_public`/`published_at` state exists per the Phase 11 model; no console, hub, or directory), Analytics (Phase 19).

## 16. Architecture integrity

```text
Phase 11 Architecture
        ↓
Phase 12 Projects          (complete)
        ↓
Phase 13 Commitments       ← this phase (complete)
        ↓
Phase 14 Consultations & Surveys   (next, not started)
```

The implementation applies the Phase 11 §4 decisions verbatim: standalone structured deliverables with (source_type, source_ref) lineage only, optional one-to-many project linkage, explicitly reported progress as the single audited authority, Core Geography/Media/Audit/Notifications reused, exactly zero new permissions and zero new roles, and the canonical update substrate extended — not paralleled.

---

```text
════════════════════════════════════════════════════
 GOVERNANCE COMMITMENTS — PHASE 13: PASS
 3 TABLES · 16 RPCs · 0 NEW PERMISSIONS · 0 NEW ROLES
 SUITE 17/17 · REGRESSION 761/761 · HOSTED 31/31
 TSC 0 · BUILD PASS · LINT 0 · HOSTED PRISTINE
════════════════════════════════════════════════════
```
