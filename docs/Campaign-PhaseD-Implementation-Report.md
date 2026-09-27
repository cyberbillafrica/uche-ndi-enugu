# Campaign Phase D — Implementation Report (Field Reports + Issues)

**Status:** COMPLETE — all §37 acceptance criteria verified.
**Parent gate:** `docs/Campaign-Architecture.md` · **Previous:** `docs/Campaign-PhaseC-Implementation-Report.md`
**Scope:** Campaign Field Reports + Campaign Issues UI and service cutover to Supabase/PostgreSQL. No dual-read, no dual-write, no Firebase fallback. Reports and Issues remain two distinct domains.

---

## 1. Status

**COMPLETE.** Phase D acceptance gate (§37) passes in full. Hosted acceptance harness passes 58/58 with pristine cleanup. Phase E has NOT started.

## 2. Files changed (this phase)

| File | Change |
|---|---|
| `supabase/migrations/0025_campaign_reports_issues_hardening.sql` | **New** — submission audit, issue-assignee eligibility, 4 public RPC wrappers |
| `src/app/portal/campaign/reports/page.tsx` | Migrated to Supabase service (rewrite of legacy Firebase page) |
| `src/app/portal/campaign/issues/page.tsx` | Migrated to Supabase service (rewrite of legacy Firebase page) |
| `tests/security/phaseD-campaign-reports-issues.test.ts` | **New** — §30 security matrix, 47 tests |
| `scripts/db/verify-hosted-smoke-campaign-d.ts` | **New** — §32 hosted smoke, journeys A–O |
| `scripts/db/apply-hosted.ts` | 0025 added to hosted migration list |

`src/lib/supabase/campaign.ts` required **no changes** — the Field Report and Issue service surface was already Phase-A-complete; Phase D verified all names (`getFieldReports`, `submitFieldReport`, `reviewFieldReport`, `resubmitFieldReport`, `getIssues`, `createIssue`, `transitionIssue`) and the RPC names match.

## 3. Migrations

**0025 only.** No new tables, no schema changes, no RLS policy changes — the Phase A `campaign_field_reports` / `campaign_issues` tables satisfy the Architecture Gate and were preserved. All tenant IDs remain non-null; all workflow/actor fields remain relational (no JSONB substitution).

## 4. RPCs added/modified

**Re-issued in `politicore` (signatures unchanged, guards added):**
- `submit_campaign_report` — now writes §29 submission audit (`campaign.report.submit`) with the server-resolved reporter; initial status server-pinned `submitted`.
- `campaign_issue_transition` — `assign` action now enforces §15 assignee eligibility: in-tenant `campaign_member` whose registered location is covered by the issue scope; members without a registered location remain tenant-assignable (matches the 0024 assignment create-guard).

**New `public.*` PostgREST wrappers (§22, 0015/0023/0024 convention — thin SECURITY INVOKER delegators, zero authorization duplicated):**
- `public.submit_campaign_report(campaign_report_type, ...)`
- `public.review_campaign_report(uuid, text, text)`
- `public.resubmit_campaign_report(uuid, text, uuid)`
- `public.campaign_issue_transition(uuid, text, uuid, text)`

All four granted to `authenticated`; hosted smoke proves each is reachable over real `/rest/v1/rpc/*`.

## 5. Field Report UI migration

`/portal/campaign/reports` — Phase C structural pattern: gate → single RLS-scoped query → RPC-only workflow. Submit form (type/title/description/scope) with server-pinned initial state; status rendered from server data with explicit states for loading/empty/unauthorized/module-disabled; permission-aware review actions (review/accept/return) and resubmit for the reporter. Legacy defects eliminated: no client actor/tenant/status fields, no tenant-wide download + client filtering, no status dropdown where an RPC is required.

## 6. Issue UI migration

`/portal/campaign/issues` — same pattern: report-issue form (type/priority/scope), scoped issue list, status rendered from server data, permission-aware lifecycle actions (acknowledge/assign/resolve/verify per the Phase A enum and RPC contract). Legacy client-side status manipulation removed; every mutation goes through `campaign_issue_transition`.

## 7. Service changes

`src/lib/supabase/campaign.ts` remains the single canonical Campaign boundary. No new methods required; no parallel provider-specific services; no Firebase imports; no Cloudinary calls; no `user_access`; no client-side permission reconstruction.

## 8. Authorization model

Unchanged and database-enforced end-to-end: module gate `module_enabled('campaign')` → server-resolved tenant → server-resolved actor → `has_permission` (permission matrix: `campaign_member` carries `submit_field_report`/`report_issue`; coordinator positions carry review/manage) → `scope_covers` polarity (higher scope covers descendants; lower never covers ancestors/siblings) → own-row branches. Reviewer authority is independently re-verified inside the RPC — visibility in the UI is never sufficient to review.

## 9. RLS changes

**None** (verified acceptable): report UPDATE/DELETE remain `USING(false)` at the table (RPC-only workflow); the issues INSERT policy pins tenant/actor server-side; view grants unchanged. Direct PostgREST mutation abuse is structurally denied and tested (see §16 / hosted H).

## 10. Workflow / state machines

- **Field Report** (exact schema statuses): `submitted → under_review → accepted`, `under_review → returned`, `returned → resubmitted` — via `review_campaign_report` / `resubmit_campaign_report`. Invalid/unauthorized/out-of-scope/cross-tenant transitions fail server-side.
- **Issue** (exact Phase A enum): the established lifecycle through `campaign_issue_transition` actions including `assign` and the resolution/verification path. Issue status is fully independent of report status (§4 boundary preserved).
- No new statuses invented; the client never PATCHes status.

## 11. Audit behavior

All authority-bearing operations use the existing `system_audits` Campaign mechanism — no new audit table. Phase D adds the missing **submission** audit. Verified sequence: submit → review → (return | accept) → resubmit; issue: assign → status transition → resolve → verify. Actor identity is always server-resolved; forged-audit client INSERT is denied.

## 12. Notification behavior

Server-side notifications fire from the authority RPCs (assignee on issue assignment, reporter on review outcomes) to the correct per-user recipients within the correct tenant; no client-supplied notification actors; no new notification table. Cross-tenant notification absence is tested.

## 13. Media / evidence behavior

Inspected the legacy Field Report implementation: evidence was a plain URL string with no tenant-scoped attachment model. Per §11, evidence references were **not** carried into the migrated surface; the Media Service (`media_assets`, provider abstraction) integration is **deferred** and documented here rather than expanding scope with a partial or tenant-unsafe attachment path. No direct Cloudinary/R2 calls exist in the migrated UI.

## 14. Security test results

`tests/security/phaseD-campaign-reports-issues.test.ts` — **47/47 passed** on the local PGlite harness (migrations 0000–0025), covering §30: tenant isolation (read/create/mutate/silence), module gate (both domains), full geography matrix with polarity (State/Zone/LGA/Ward→PU, sibling denial, ancestor polarity, unrelated denial), report workflow (valid/invalid/unauthorized/out-of-scope/cross-tenant/resubmission/accepted-mutation denial/direct view PATCH denial), issue workflow (creation/assignment/transition/resolution/verification/direct PATCH/DELETE denial), Social-only boundary, Election Officer boundary, Admin tenant boundary, audit server-resolution + forgery denial, notifications, leaderboard probe.

Two real defects were caught by this suite and fixed in 0025 before acceptance: missing submission audit; issue-assign eligibility gap. One suite bug fixed during development (cross-tenant visibility assertion needed to check TENANT_A's row specifically, since tenant B admins legitimately see their own tenant's rows).

## 15. Full regression results

**345/345 passed across 10 suites** (local `vitest.security.config.ts`):
Phase A 68 · Phase B 80 · Phase C 43 · **Phase D 47** · geography 8 · phase1a 8 · plus the 1A/1B/1C Election-foundation and Election suites — all green, Election untouched.

TypeScript: `npx tsc --noEmit` — **0 errors**. Build: `npm run build` — **passes** (exit 0, BUILD_ID written). Touched-file ESLint: **0 errors** (remaining hits are the established session-bridge reason string and comment-only mentions of eliminated legacy patterns — no imports).

Dependency scans over the migrated surfaces: no Firebase imports, no Cloudinary calls, no `user_access`, no client scope expansion.

## 16. Hosted smoke results

`scripts/db/verify-hosted-smoke-campaign-d.ts` — **58/58 passed** against the real hosted Supabase project with real GoTrue accounts, real JWTs, real PostgREST, real RLS, real public RPC wrappers (§32 A–O):

- **A** report submission (tenant/reporter/scope/status server-pinned) · **B** hierarchy (descendants visible, sibling denied, ancestor polarity, cross-tenant silence) · **C** full workflow incl. invalid-transition failures · **D** authorization (authorized reviewer succeeds; unauthorized/out-of-scope/Social-only/Election-Officer denied) · **E** issue creation · **F** issue assignment + unauthorized/cross-tenant assignment failures · **G** issue lifecycle with independent resolution/verification actors · **H** direct PostgREST abuse (report/issue PATCH + DELETE, status/actor/tenant/scope spoofs — no bypass) · **I** module disabled ⇒ both domains inaccessible · **J** Social-only complete denial · **K** Election Officer Campaign isolation · **L** audit actor/event sequence · **M** notification recipients/tenancy · **N** cross-tenant silence · **O** cleanup.
- Pristine-state verification: **0 temporary reports, issues, notifications, users, tenants** remaining.

Harness-expectation corrections made during the run (not product defects): C3's resubmit is a void RPC (204 — asserted by row state), and D4's out-of-tenant review fires the module gate first ("campaign module is not enabled" — a stronger refusal than "report not found"; assertion accepts both).

## 17. Defects found and fixed

1. **Submission not audited (§29 gap)** — `submit_campaign_report` now writes `campaign.report.submit` with the server-resolved reporter.
2. **Issue-assignee eligibility missing (§15 gap)** — `assign` action now requires an in-tenant `campaign_member` whose registered location is covered by the issue scope.
3. **PostgREST-unreachable workflow RPCs (recurring §22 class)** — all four report/issue RPCs were politicore-only; public wrappers added (application path would have 404'd on hosted).

All fixes are narrow, in 0025, and none alter the ratified architecture.

## 18. Deviations from this prompt

- **No new service methods** were needed — §24's example names already existed verbatim from Phase A; the cutover used them unchanged.
- **Evidence/media (§11)** deferred with documentation rather than partially implemented (see §13) — the legacy evidence model was an unscoped URL string incompatible with tenant-safe attachment.
- No performance changes were required (§33): listing is a single RLS-scoped relational query with pagination via the existing indexes; no scope fan-out, no N+1, no tenant-wide download.

## 19. Unresolved issues

None blocking Phase D acceptance. Deferred (documented, out of scope by §2): Media/evidence integration for Field Reports (§13); legacy Firebase Reports/Issues code remains in place awaiting the final cleanup gate (§35).

## 20. Phase E confirmation

**Phase E has NOT started.** No Campaign Coordination, Member Directory, Communications, Documents, Calendar, realtime, Firebase deletion, Social Force, Election, Governance, Donations, or Control Center work was performed.

---

```text
PHASE D COMPLETE — HOSTED ACCEPTANCE GATE PASSED — HARD STOP
Awaiting explicit authorization for PHASE E — CAMPAIGN COORDINATION + MEMBER/DIRECTORY SURFACES
```
