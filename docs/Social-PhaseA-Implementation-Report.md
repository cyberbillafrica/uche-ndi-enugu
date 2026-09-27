# Social Force Phase A — Implementation Report (Core + Authorization)

**Status:** COMPLETE — all Phase A acceptance criteria verified.
**Parent gate:** Social Force Architecture Gate (§55 Phase A) · **Previous lock:** `docs/Campaign-Final-Lock-Report.md`
**Scope:** Social Force relational substrate + authorization + authority RPCs + audit + leaderboard projection. **No UI migration** (Phase B+). No dual-read, no dual-write, no Firebase dependency in the migrated substrate. Campaign and Election byte-untouched.

---

## 1. Discovery (gate-mandated, before any migration)

Legacy Firebase Social Force model inventoried from `src/lib/firebase/firestore.ts`, `portal/tasks`, `admin/tasks`, and `leaderboard`:

| Legacy concept | Observed shape |
|---|---|
| `/tasks` | title, description, platform (`Facebook\|X\|Instagram\|TikTok`), action (`Like\|Comment\|Share\|Make Post`), points, status (active toggle), target_url, proof_required, expiration_date |
| `/task_submissions` | task ref, submitter, proof, pending → verified |
| Point awarding | admin verify → direct mutable `users.points` write |
| `/leaderboard_public` | reduced projection (display name, points, rank) |

Product decisions preserved exactly: **active/inactive** task lifecycle (no draft exists — none invented, §11), **pending → verified** submission lifecycle (verify-only; no rejection path exists — none invented, §15), leaderboard as a **reduced public projection** excluding polling unit and contact fields (§22).

## 2. Migration — `supabase/migrations/0028_social_force_core.sql`

**Relational domain (gate §44):**

```text
social_tasks ──< social_task_submissions ──1 social_point_awards
                                        (UNIQUE(submission_id) — one award per qualifying submission, §17)
```

| Object | Detail |
|---|---|
| `social_tasks` | tenant FK, title/description, platform + action enums, points `> 0` CHECK, status enum (`active`/`inactive`), target_url, proof_required, expiration_date, created_by, tzs |
| `social_task_submissions` | task FK, submitter FK, status enum (`pending`/`verified`), proof_url, submitted_at, verified_by/verified_at; **UNIQUE (task_id, submitter_id)** — one submission per member per task |
| `social_point_awards` | **immutable ledger** (§16/§19): recipient, UNIQUE submission FK, points `> 0`, source, awarded_by, awarded_at |
| RLS | ENABLED **and FORCED** on all three tables; policies enforce tenant + identity + membership + module on every path |
| Guard trigger | submissions are immutable once verified; any status change requires an authoritative pre-existing award; ownership immutable; verifier resolved server-side |
| Authority RPCs (SECURITY DEFINER, pinned `search_path`) | `create_social_task`, `update_social_task`, `set_social_task_status`, `submit_social_task`, `verify_social_submission` — every one resolves actor/tenant from `auth.uid()`/Core, checks `module_enabled('social')`, enforces membership/permission server-side |
| Award path | verify inserts the ledger award (server-computed points from the task) **before** transitioning status, then recomputes `profiles.points` as a **projection** (`social_profile_points`) — the balance is never client-writable (§16/§18/§19) |
| Audit + notifications | verification writes `system_audits` with server-resolved actor/tenant and a Core notification to the submitter |
| Public surface | `security_invoker` views (`social_tasks`, `social_task_submissions`, `social_point_awards`) + `social_leaderboard` projection (id, tenant, full_name, points, rank, ward/LGA/zone context — **no** polling unit, email, or contacts) + thin `public` wrappers |
| Grants (ratified matrix) | tasks: authenticated SELECT; submissions: authenticated SELECT+INSERT+UPDATE (self-scoped by RLS); awards: SELECT; leaderboard: anon+authenticated SELECT; **no anon DML anywhere, no TRUNCATE** |

Points history/ledger reads arrive with Phase C/D per the gate's phased plan; the substrate already exposes the ledger table.

## 3. Files changed (this phase)

| File | Change |
|---|---|
| `supabase/migrations/0028_social_force_core.sql` | **New** — the Social Force substrate |
| `scripts/db/apply-hosted.ts` | Registered `0028` with a signature check (tables + leaderboard view + verify RPC + no app-role DML grants) |
| `tests/security/phaseA-social-force.test.ts` | **New** — Phase A security suite (§51/§52) |
| `tests/security/final-campaign-lock.test.ts` | One boundary test narrowed (see §6 Deviations) |
| `scripts/db/verify-hosted-smoke-social-a.ts` | **New** — hosted acceptance harness |

Legacy Firebase Social files (`firestore.ts` tasks/submissions/leaderboard paths, `portal/tasks`, `admin/tasks`, leaderboard page) are **retained untouched** — they are removed in the Social UI cutover phases (clean cutover, no dual-write, §37/§57).

## 4. Security suite — 31/31

`tests/security/phaseA-social-force.test.ts` on local PGlite (migrations 0000–0028):

* **Tenant isolation** — cross-tenant task visibility/mutation denied (definer RPCs pin tenant); leaderboard rows never cross tenants
* **Module gating** — social disabled ⇒ views empty + every RPC refuses with `social module is not enabled`
* **Membership** — campaign-only, election-officer, and no-membership users denied submission; admin administers without social membership (access-role authority, §9)
* **Task authority** — members denied create/update/transition via RPC *and* via direct view UPDATE; anon read denied (no grant); admin CRUD verified
* **Submission lifecycle** — resubmission upserts proof while pending; verified ⇒ resubmission refused; inactive/expired/zero-point tasks refuse submission; impersonation INSERT RLS-denied; members cannot alter others' submissions or self-verify (0-row UPDATE + RPC refusal)
* **Ledger integrity** — award = exactly task points, recipient/awarded_by server-resolved; double verification refused; direct award replay denied (no INSERT grant + UNIQUE); verified submissions immutable; `profiles.points` not client-mutable; audit row with server-resolved actor+tenant
* **Leaderboard** — derived from authoritative points only, dense contiguous ranks, reduced fields (no polling_unit/email), anon fail-closed, projection not writable
* **Cross-module** — social members gain no Campaign surface; Campaign-authorized user still denied Social

## 5. Full verification

| Gate | Result |
|---|---|
| Phase A security suite | **31/31** |
| Full security regression | **447/447 across 13 suites** — arithmetic exact: campaign-lock 27 + social-A 31 + phase1c 40 + phaseB 80 + phaseD 47 + phaseA-campaign 68 + phaseC 43 + phase2-election 14 + phaseE 44 + phase1b 16 + authorization 18 + tenant-isolation 11 + geography 8 = **447**; 0 failed, 0 skipped |
| `npx tsc --noEmit` | **0 errors** |
| `npm run build` | **passes** |
| Touched-file ESLint | **0 errors, 0 warnings** |
| Hosted migration apply | 0028 applied; substrate verified: 3 tables FORCE-RLS, 4 public views, 5 RPCs, grant matrix exactly as ratified |
| Hosted smoke (`verify-hosted-smoke-social-a.ts`) | **45/45** — real GoTrue accounts/JWTs, real PostgREST/RLS/RPC wrappers: A visibility+creation · B module-off fail-closed · C admin authority · D membership boundaries · E submission lifecycle · F verification/ledger/audit · G leaderboard projection+isolation · H direct PostgREST abuse (anon 401/403, member 403, cross-tenant silent, points unmutated) · I effective-grant audit · J no Campaign-owned social surface · K pristine cleanup (0 tasks/0 subs/0 awards/0 tenants/0 users; FORCE-RLS restored) |
| Campaign / Election protection | `git status` confirms zero changes to Campaign or Election migrations/services/pages in this phase; Election and Campaign suites all green |

## 6. Deviations

1. **`tests/security/final-campaign-lock.test.ts` — one test narrowed (intentional, documented).** The Campaign lock suite asserted *"no social_task/leaderboard functions or tables exist at all"* — an implementation-order assumption valid only before Social Force Phase A. The ratified Social gate now legitimately creates these objects under **Social** ownership. The test now asserts the durable security invariant it always meant: **no *Campaign-owned* task/point/submission/leaderboard tables or RPCs** (`campaign%task%`, `campaign%point%`, `campaign%leaderboard%`, `campaign%submission%`). No Campaign object, migration, or permission was modified.
2. None architectural. Zero gate hard-stops (§60) triggered.

## 7. Deferred (by design — later phases)

* **Phase B — Tasks UI**: `src/lib/supabase/socialForce.ts` service boundary, task listing/creation/editing/status pages, member task views (Core authorization + module gating)
* **Phase C — Submissions + verification UI** (evidence via Media Service where file storage is actually required)
* **Phase D — Points history + leaderboard UI** over the authoritative ledger
* **Phase E — Social dashboard + navigation + final Firebase Social cleanup**
* **Phase F — Social Force lock gate** (full regression, hosted acceptance, static dependency scan, `SOCIAL FORCE LOCKED`)

## 8. Conclusion

The Social Force database/domain foundation is **complete, verified locally and on the hosted project**, and satisfies the gate's non-negotiables: independently activatable module, relational schema with FORCE RLS, server-enforced lifecycle and authority, immutable auditable point ledger with one award per qualifying submission, projection-only points balance, reduced leaderboard projection, zero Firebase dependency in migrated code, and Campaign/Election byte-untouched.

**PHASE A COMPLETE — STOPPING BEFORE PHASE B** per the parent gate.
