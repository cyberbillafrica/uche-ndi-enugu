# Social Force Phase C — Implementation Report (Submissions + Verification)

**Status:** COMPLETE — all §33 acceptance criteria verified.
**Parent gate:** Social Force Architecture Gate (§55 Phase C) · **Prerequisites:** `docs/Social-PhaseA-Implementation-Report.md`, `docs/Social-Force-PhaseB-Implementation-Report.md`
**Scope:** Full submission lifecycle UX + verification workflow on the Phase A substrate and Phase B service boundary. No dual-read, no dual-write, no Firebase fallback in the active submission path. Campaign and Election untouched.

---

## 1. Status

**COMPLETE.**

## 2. Discovery

Verified before editing (current source, not assumptions):

- **Phase B bridge state:** the member page already submitted via the `submit_social_task` RPC and loaded history via `getMySubmissions()`, but had **no pending-resubmission flow** (a pending submission just showed "Submitted for review" with no update path) and **no submission-history surface**. The admin review modal verified via the RPC but exposed no pending/verified counts and no verification metadata.
- **Legacy consumers of the submission functions:** exactly one remained — `src/components/dashboard/SocialMemberDashboard.tsx` imports `getUserTaskSubmissions` (Phase E scope). `submitTaskCompletion`, `getSubmissionsForTaskWithUsers`, and `verifyTaskSubmission` had zero active consumers after Phase B.
- **Legacy model:** `pending → verified` only (verify-only product; no rejection state); one submission per member per task (`{taskId}_{userId}` dedup in Firestore, now `UNIQUE(task_id, submitter_id)`); legacy "unverify" already removed in Phase B (verified immutable per the Phase A award-linkage guard) — not restored.
- **0028 side effects:** verification inserts the audit (`social_submission:verify`) and the notification (`type 'task'`, title "Task verified", link `/portal/tasks`, created_by = verifier) server-side inside the RPC transaction.
- **Evidence:** the submission model is **proof-URL based** (text column, ≤2048 chars); no file evidence exists anywhere in the product → Media Service **not** introduced (§11).

## 3. Submission model

Unchanged from Phase A — consumed, never recreated:

```text
social_tasks → social_task_submissions (UNIQUE(task_id, submitter_id)) → social_point_awards
```

The submission is the qualifying event; the RPC-owned verification inserts the authoritative award and flips status; `profiles.points` remains a server-maintained projection. No submission mutation in Phase C bypasses the authority RPCs.

## 4. Service

`src/lib/supabase/socialForce.ts` remains the **only** Social Force boundary (no `socialSubmissions.ts`). Phase C additions:

- `getMySubmissionsForTask(supabase, taskId)` — the caller's row(s) for one task, for the pending-resubmission flow. One query, RLS-scoped.
- `getSubmissionsCount(supabase, taskIds)` — pending/verified counts per task for the admin listing badges. **One** grouped pass over the RLS view (`select task_id, status` + aggregate in the service), never a per-task fanout.

No RPC wrapper was added (Phase A already provides all five authority RPCs; the service rejects any client write path — still zero `.insert()/.update()/.delete()`).

## 5. Member UX

`/portal/tasks`:

- **No submission** → proof input (when `proof_required`) + "Mark Completed" → RPC.
- **Pending** → yellow "Submitted for review" state with submitted-at date, proof link, and a new **"Update proof"** action: it loads the caller's current row via `getMySubmissionsForTask`, pre-fills the proof input, and resubmits through the RPC (server upsert overwrites proof while pending — §8 upsert experience).
- **Verified** → green "Task verified" state; no further submission offered. A defensive client guard also blocks the call path (server remains authoritative).
- **My Submissions history (§14):** a collapsible panel with per-row task title, platform/action, submitted date, proof link, status chip, pending count, and an "Update proof" shortcut for pending rows — all from **one** `getMySubmissions()` RLS-scoped query.

## 6. Admin UX

`/portal/admin/tasks`:

- Listing badges per task: `N pending` / `M verified` from `getSubmissionsCount` (one query for the whole listing; updated optimistically after each verification).
- Review modal: submitter name/email (batched profile lookup), proof link, status chip, and — new in Phase C — the **verification date and "by you" attribution** for verified rows (§18 verified-state display).
- Verify button only on pending rows (no unverify control exists); conflict refusals surface as user-safe `SocialForceError` messages, never raw database text.

## 7. Proof/evidence

Preserved exactly: URL-based proof, required flag enforced server-side by the RPC (`proof URL is required for this task`), pre-filled and editable while pending, immutable once verified. **No file evidence exists in the product; Media Service was deliberately not introduced** (gate §11: "preserve the URL-based contract"). Documented as the evidence disposition.

## 8. Authorization

Unchanged boundaries, re-proven: `resolveSocialAccess` gates both routes (UX layer); RLS restricts submissions reads to submitter-or-admin; the RPCs resolve submitter/tenant/verifier from `auth.uid()`. Social members submit and resubmit own pending rows only; campaign-only members and election officers are denied submission and verification; admin verifies without social membership; module-disabled fails closed for both reads and both RPCs.

## 9. Award integrity

Verification reaches the ledger only through `verify_social_submission`: the RPC inserts the award (`source='task_verification'`, points = `social_tasks.points` resolved server-side) **before** the status transition so the guard trigger proves the linkage, then updates the `profiles.points` projection. Hosted-verified: exactly one award of 33 points for a 33-point task, recipient = submitter, `awarded_by` = verifying admin. The verify RPC's argument list contains no `points` parameter — an admin cannot type an arbitrary amount (asserted by catalog test).

## 10. Audit/notifications

Both server-generated inside the RPC transaction (Phase A behavior preserved, hosted-verified): audit row with server-resolved actor + tenant; notification to the submitter (`type='task'`, "Task verified", `/portal/tasks`). No Social-specific audit/notification tables; no client notification writes.

## 11. Firebase cutover

The active submission path (`socialForce.ts`, `/portal/tasks`, `/portal/admin/tasks`) contains **zero** Firebase/Firestore imports and **zero** legacy submission functions (`submitTaskCompletion`, `getUserTaskSubmissions`, `getSubmissionsForTaskWithUsers`, `verifyTaskSubmission`) — asserted by static scan in both the security suite and the hosted harness. Remaining legacy consumers (documented, permitted until their phases): `SocialMemberDashboard` → `getUserTaskSubmissions` (Phase E), plus non-Social Firebase consumers outside Social scope (global cleanup is not Phase C scope).

## 12. Tests

`tests/security/phaseC-social-force.test.ts` — **24/24**: module gating (submit + verify + reads fail closed; restore verified) · membership/authority (4 identities × submit/verify) · ownership (RLS insert/alter, immutable submitter_id and tenant_id) · lifecycle (pending upsert single-row, verified refuses second verify/direct mutation/resubmission, inactive/expired refuse) · proof contract · award integrity (exact points, authoritative recipient/verifier, projection movement, direct INSERT denied, no points argument on the RPC) · audit + notification side effects with server-resolved identity · tenant isolation (submit/read/verify cross-tenant) · direct abuse (anon/member DELETE, award DELETE denied) · Firebase boundary + RPC-only service proof + typed error classification.

## 13. Full regression

**494/494 across 15 suites**, arithmetic exact:

authorization 18 · geography 8 · phase1b 16 · phase1c-election 40 · phase2-election-app 14 · phaseA-campaign-core 68 · phaseB-campaign-activities 80 · phaseC-campaign-assignments 43 · phaseD-campaign-reports-issues 47 · phaseE-campaign-coordination-members 44 · final-campaign-lock 27 · phaseA-social-force 31 · phaseB-social-force 23 · **phaseC-social-force 24** · tenant-isolation 11 = **494**. Zero skipped.

## 14. Hosted acceptance

`scripts/db/verify-hosted-smoke-social-c.ts` — **35/35** first run against the real hosted project (real GoTrue JWTs, PostgREST, RLS, public RPC wrappers):

A Member submission (4) · B Resubmission (2) · C Verification (3) · D Award (2) · E Notification (1) · F Audit (1) · G Immutability (5) · H Authorization (8: member/campaign-only/officer/cross-tenant submit+read+verify/module-off) · I Direct abuse (5) · J Firebase boundary (2) · K Pristine cleanup (1: 0 tasks, 0 subs, 0 awards, **0 notifications**, 0 tenants, 0 users, 0 module rows; FORCE-RLS restored).

## 15. Campaign protection

No Campaign file, migration, route, or service touched by Phase C (Phase C footprint: `socialForce.ts`, two Tasks pages, one new test file, one new harness, this report). Campaign suites green in full regression; the lock suite's boundary invariant (no Campaign-owned task/points/leaderboard surface) still passes. Campaign members gain no Social authority (H2/H3 hosted).

## 16. Election protection

No Election file touched; election suites green (40 + 14). Election Officer semantics unchanged — denied Social submission and verification without Social/admin authority (H4 hosted).

## 17. Deviations

None. Phase C introduced no lifecycle states, no unverify path, no new RPCs, no Media integration, no leaderboard/dashboard work, and no schema changes — the substrate and ratified contracts were consumed exactly as established. (The legacy "unverify" removal was already recorded as the Phase B deviation; it was not restored.)

## 18. Deferred work

- **Phase D — Points + Leaderboard UI:** point history, totals presentation, leaderboard surfaces (the Phase A projection updates naturally as verification awards points; no UI was touched in Phase C).
- **Phase E — Dashboard/navigation/final Firebase Social cleanup:** `SocialMemberDashboard` (last Social legacy consumer), remaining portal Firebase imports, social dashboard cutover, legacy service deletion.
- **Phase F — Social Force Lock Gate.**

## 19. Conclusion

Phase C is complete: the full submission lifecycle (submit → pending → resubmit-while-pending → verify → verified-immutable) runs on the Phase A substrate through the canonical service, with award, audit, and notification integrity verified locally (24/24) and hosted (35/35), full regression 494/494, TypeScript 0 errors, build passed, touched-file lint clean, and the hosted project returned to pristine state.

**STOPPING before Phase D per gate §34.**
