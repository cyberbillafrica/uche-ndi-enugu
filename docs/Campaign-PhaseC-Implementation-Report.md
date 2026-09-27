# Campaign Phase C — Implementation Report (Assignments)

**Status:** COMPLETE — all acceptance criteria verified.
**Parent gate:** `docs/Campaign-Architecture.md` · **Previous:** `docs/Campaign-PhaseB-Implementation-Report.md`
**Scope:** Campaign Assignments UI + workflow + service cutover to Supabase/PostgreSQL. No dual-read, no dual-write, no Firebase fallback. Election untouched, no Phase D work started.

---

## 1. Files changed (this phase)

| File | Change |
|---|---|
| `supabase/migrations/0024_campaign_assignments_hardening.sql` | **New.** Public RPC wrappers, campaign-member eligibility + Gate §3.3 create-guard, delete terminal-state guard, view DELETE grant, `campaign_assignable_members` RPC |
| `src/app/portal/campaign/assignments/page.tsx` | **Rewritten** — Firebase → `src/lib/supabase/campaign.ts` (Supabase only) |
| `src/lib/supabase/campaign.ts` | Added `getAssignableMembers` (0024 RPC client) |
| `tests/security/phaseC-campaign-assignments.test.ts` | **New** — §28 matrix (43 tests) |
| `scripts/db/verify-hosted-smoke-campaign-c.ts` | **New** — §29–30 A–L hosted harness |
| `scripts/db/apply-hosted.ts` | 0024 signature entry (covering full 0024 content) |

## 2. Migration 0024 (single additive migration)

1. **Public `public.*` wrappers** (0015/0023 convention) for `create_campaign_assignment`, `campaign_assignment_transition`, `update_campaign_assignment_details`, `campaign_assignable_members`, `campaign_members_in_scope` — required because PostgREST executes only `public.*` RPCs; without them the application service layer itself 404s.
2. **Campaign-member eligibility** (Phase C §11): `create_campaign_assignment` and the reassign branch require the assignee to hold `campaign_member` membership. An authenticated account alone (social-only, election-domain, cross-tenant) cannot become the target of campaign operational work.
3. **Gate §3.3 create-guard** (gap closed): when the assignee has a registered location (LGA/ward/PU), it must be **covered** by the assignment scope per `scope_covers()`. Same predicate in the assignee picker so the UI offers only genuinely eligible members.
4. **Delete terminal-state guard** (Gate §3.3): completed assignments are part of the record — the DELETE policy gains `status <> 'completed'`.
5. **View DELETE grant**: 0021's public view was SELECT-only by grant, which orphaned the RLS-gated delete path (service `deleteAssignment`); DELETE grant added with RLS remaining the boundary. INSERT/UPDATE stay RPC-only.

## 3. RPCs added/modified

Modified (same signatures, tightened guards): `create_campaign_assignment`, `update_campaign_assignment_details`.
New: `campaign_assignable_members` (+ its `public.*` wrapper).
Wrapped into `public.*`: `create_campaign_assignment`, `campaign_assignment_transition`, `update_campaign_assignment_details`, `campaign_assignable_members`, `campaign_members_in_scope`.

## 4. UI surface migrated

`/portal/campaign/assignments` — listing (two RLS-scoped queries: area-visible + mine; **zero client-side scope fan-out**), creation via `create_campaign_assignment` (tenant/creator/status server-pinned), editing + reassignment via `update_campaign_assignment_details`, full workflow via `campaign_assignment_transition` (Start/Submit/Resubmit for assignees; Accept/Return for reviewers), deletion gated on non-terminal status, database-resolved module gate with explicit denied states. The legacy client-writable status dropdown is gone — status is never a form field.

## 5. Security model

Visibility/authority = module gate + tenant + `scope_covers(grantee, record)` polarity + permission (`view/create/review assignment`) + own-row branches — all server-side. Direct PostgREST: INSERT policy-pinned (assigned_by/status pinned), **UPDATE revoked at both table and view level**, DELETE policy-gated (supervisor-only, non-terminal), eligible-assignee resolution server-side. UI gating is convenience only; the RPCs are authoritative.

## 6. Tests

- **Phase C suite: 43/43** (`phaseC-campaign-assignments.test.ts`) — tenant isolation, module gate, creation authority/spoofing/eligibility, hierarchical scope visibility with polarity (ward sees descendants but not ancestor-scope rows), full state machine, reassignment audit/notification, direct view abuse, social-only/Election-Officer boundaries, audit actor, leaderboard probe, typed-error regression.
- **Full security regression: 298/298** across 9 suites (Phase A 68, Phase B 80, Phase 1A/1B/1C, Election all green).
- `tsc --noEmit`: **0 errors** · `npm run build`: **passes** · touched-file ESLint: **0 errors, 0 warnings**.
- Dependency scan: the new path contains no Firebase, Cloudinary, `user_access`, leaderboard-write, or client-scope-expansion references (comment mentions of eliminated legacy patterns only).

## 7. Hosted smoke (§29–30) — `verify-hosted-smoke-campaign-c.ts`

**48/48 checks passed** on the real hosted project (real GoTrue accounts, real JWTs, real PostgREST, real RLS, real RPC wrappers; FORCE-RLS-aware cleanup; pristine verified: 0 assignments / 0 notifications / 0 users / 0 tenants / 0 organizational assignments).
A — creation + server-pinned identity ✓ · B — hierarchical visibility incl. cross-tenant silence ✓ · C — full workflow start→submit→return→resubmit→accept, illegal/unauthorized/cross-tenant denials ✓ · D — reassignment, authority denial, eligibility refusal ✓ · E — §3.3 create-guard (out-of-area assignee refused), scoped assignee picker, picker authority ✓ · F — view PATCH non-mutating, assignee DELETE zero-rows, **completed-assignment delete blocked**, supervisor delete of open work, anonymous silence ✓ · G/H — social-only & Election-Officer boundaries ✓ · I — module-disabled refusals, no leakage ✓ · J — 8 audit events with server-resolved actors, assignee notifications, forged-audit insert denied ✓ · K — cross-tenant PATCH/DELETE no-ops ✓ · L — pristine ✓

## 8. Direct PostgREST mutation results (§13/§15)

View INSERT: policy-pinned (creator/tenant/status spoofs 403). View PATCH: **zero-rows-affected for every caller** (privilege revoked at table and view level; state verified unchanged). View DELETE: policy-gated — assignee/member zero-rows; supervisor succeeds only on non-terminal rows; **completed rows survive supervisor delete**. RPC-only authority: status/creator/tenant/assignee structurally unreachable outside the workflow RPCs.

## 9. Defects found and fixed (narrow, none architectural)

1. **Gate §3.3 create-guard was not enforced** — Phase A's create RPC validated assignee tenant membership only; a member registered outside the assignment scope could be assigned. Closed in 0024 (create + reassign + picker share one predicate); regression-tested locally and hosted (E1/E2).
2. **Assignment RPCs were unreachable over PostgREST** — no `public.*` wrappers (the Phase B finding recurring for the assignments surface); fixed in 0024 for all five functions.
3. **Non-campaign-member assignability** — the create/reassign path accepted any in-tenant profile; eligibility now requires `campaign_member` (§11).
4. **Delete terminal-state guard missing** — the Phase A delete policy lacked the gate's "never in a terminal state" rule; added in 0024.
5. **View DELETE grant orphaned the delete path** — the 0021 view was SELECT-only by grant, so the RLS-gated delete (service `deleteAssignment`) could never reach the table; narrow grant added, RLS unchanged.

## 10. Deviations from the prompt

- **`campaign_assignable_members` RPC added** (not pre-listed): required by §11/§22 without violating D2 — the picker resolves eligibility server-side per target scope instead of downloading the tenant directory.
- **Scope edits locked rather than invented** (§13): the details RPC intentionally has no scope parameters; scope changes route through create-new-assignment (noted in the UI). Avoids creating unsafe scope-move semantics the architecture does not define.

## 11. Unresolved issues

None.

## 12. Phase D confirmation

**Phase D (Field Reports + Issues) has NOT started.** No Reports/Issues/Coordination/Member-Directory work, no realtime, no Firebase deletions, no Election changes. Hard stop respected.
