# Campaign Phase A — Implementation Report

**Status:** COMPLETE — all §40 acceptance criteria verified
**Migration:** `0021_campaign_core.sql`
**Parent gate:** `docs/Campaign-Architecture.md`
**Phase:** A of A–F (Campaign Management migration)

## What was built

### Migration 0021 — Campaign core

**Enums (11):** `campaign_activity_type`, `campaign_activity_status`, `campaign_rsvp`,
`campaign_attendance_state`, `campaign_assignment_priority`, `campaign_assignment_status`,
`campaign_report_type`, `campaign_report_status`, `campaign_issue_type`,
`campaign_issue_priority`, `campaign_issue_status`. Foundation enums
(`scope_type_enum`, `module_code_enum`, …) reused — none duplicated.

**Tables (5, all `tenant_id uuid NOT NULL REFERENCES tenants(id)`):**

| Table | Key structure |
|---|---|
| `campaign_activities` | scheduled_start/end CHECK, scope-validation trigger, organizer/creator distinction preserved |
| `campaign_activity_participants` | `UNIQUE(activity_id, user_id)`; RSVP (intent) and attendance/check-in/out/recorded_by (fact) as distinct column groups |
| `campaign_assignments` | `assigned_to`/`assigned_by` FK profiles, priority/status enums, `evidence_asset_id → media_assets` |
| `campaign_field_reports` | legacy field-level shape preserved verbatim (participants/issues/community_feedback/requests/follow_up_required), reviewer columns |
| `campaign_issues` | reporter/assignee/resolver/verifier/closer as distinct columns (no generic `updated_by`); `tenant_id NOT NULL` fixes D3 |

**Indexes (16):** tenant+scope, tenant+status, tenant+scheduled_start, assignee+status,
tenant+due_date, submitter+status, reporter, issue assignee+status,
activity+participant, user+participant — per Architecture Gate §30.

**RLS:** enabled **and forced** on all five tables; 20 policies (SELECT/INSERT/UPDATE/
DELETE per table). Every policy = `module_enabled('campaign') AND tenant isolation AND
(admin OR permission-at-covering-scope OR own-record)`. `has_permission(p, scope_type,
scope_id)` natively applies `scope_covers(grantee, record)` — §15 polarity by
construction. Workflow tables (assignments/reports/issues) and attendance columns have
**no** client UPDATE path; mutations flow only through RPCs. Two SECURITY DEFINER
visibility helpers (`can_view_campaign_activity`, `campaign_activity_exists_in_tenant`)
prevent mutual RLS recursion between activities and participants without widening access.

**RPCs (11 authority surface):**
`create_campaign_assignment`, `campaign_assignment_transition`
(start/submit/return/resubmit/accept with state guards + reviewer ≠ assignee),
`update_campaign_assignment_details` (incl. audited reassignment),
`submit_campaign_report`, `review_campaign_report` (accept/return, self-approval ban),
`resubmit_campaign_report`, `campaign_issue_transition`
(acknowledge/assign/start/resolve/verify/close), `set_campaign_activity_status`,
`join_campaign_activity`, `record_campaign_attendance` (supervisor-only fact),
`campaign_members_in_scope` (D2: server-side hierarchical directory filtering).
Plus `campaign_notify` (best-effort, never fails the action), `campaign_audit`,
`my_module_settings` (§29 settings under existing `tenant_settings`), and the
`campaign_scope_exists` data-integrity validator used by per-table triggers.

**Audit & notifications:** authority RPCs write `system_audits`
(`campaign.assignment.create|reassign|review|status`, `campaign.report.review|resubmit`,
`campaign.issue.assign|status`, `campaign.activity.status`) and per-user notifications
(existing `notifications` table; failure never rolls back the business action).

**Public views (5, 0009/0020 convention):** `public.campaign_activities`,
`campaign_activity_participants`, `campaign_assignments`, `campaign_field_reports`,
`campaign_issues` — `security_invoker = true`; grants mirror base-table policy
capabilities (activities full CRUD, issues member-reportable inserts; assignments/
reports/participants views SELECT-only because writes are RPC-only).

**Grants:** base tables and RPCs granted to `authenticated` (+ `service_role` where
established); no anon writes anywhere.

### Service foundation — `src/lib/supabase/campaign.ts`

Single Campaign application boundary (mirrors `election.ts` conventions): canonical
relational types, `CampaignError` with 8-kind typed model
(`unauthenticated/module_disabled/forbidden/outside_scope/invalid_transition/not_found/
validation/infra`), full §25 API surface (activities, participation, assignments with
named workflow functions, reports, issues, member directory, settings). No
catch-to-empty-array; query failures throw typed errors. Zero Firebase/Cloudinary/
user_access/leaderboard/client-scope-expansion references (verified by scan).

### Tests — `tests/security/phaseA-campaign-core.test.ts`

68 tests over the established PGlite harness, covering the §31 matrix: tenant
isolation (read/insert/mutate/delete/inference), module isolation (invisible rows,
RPC refusal, typed `module_disabled`), scope hierarchy with real Enugu fixtures
(Ward→PU allowed/sibling PU denied, LGA→Ward/PU, Zone→LGA/Ward/PU with genuine
cross-zone negatives, State→all, PU isolation), §15 polarity, D1 (single RLS-scoped
list replaces client fan-out) and D2 (server-filtered directory per coordinator
level) regressions, position ≠ authority (Campaign Manager, Council Chairman,
Election Officer, Social-only), actor integrity (created_by/reported_by/assigned_by/
submitted_by spoofing rejected; reviewer/recorder server-resolved), all three
workflow state machines (illegal transitions, self-approval bans, no client status
writes, `overdue` unwritable), participation/attendance rules, audit boundary
(client INSERT denied; RPC audits carry server-resolved actor), media FK boundary,
leaderboard immutability, grant-escalation block, security-invoker view verification.

## Verification results

| Gate | Result |
|---|---|
| Phase A suite | **68/68 pass** |
| Full security regression (7 suites incl. Phase 1A/1B/1C + Election) | **175/175 pass** |
| `npx tsc --noEmit` | **0 errors** |
| `npm run build` | **passes** |
| Touched-file eslint | **0 errors** |
| Dependency scan (Firebase/Cloudinary/user_access/leaderboard/expansion) | **clean** |
| Election protection | no Election file touched by Phase A; all Election suites green |

## Deviations from the Phase prompt (declared)

1. **Issue enum includes `verified`.** §4's list omits it, but §21's own issue
   workflow (`reported → … → resolved → verified → closed`) and the parent gate
   §3.5 require it. The parent gate and §21 are authoritative; implemented with
   `verified`.
2. **Three additional RPCs beyond the strict minimum** (`update_campaign_assignment_details`,
   `resubmit_campaign_report`, `campaign_members_in_scope`): required because RLS
   intentionally closes client UPDATE on workflow tables (reassignment/resubmission
   are authority-bearing per §11/§14) and because the D2 fix mandates server-side
   directory filtering. Plus `my_module_settings` for the §25/§29 settings surface.
3. **Server-resolved column DEFAULTs** (`tenant_id`, `created_by`, `reported_by`) on
   the two member-writable direct-insert paths (activities, issues), pinned by WITH
   CHECK equality — the browser never chooses tenant or actor (D3, done properly).
4. **`overdue`** remains in the enum per §4 but has no write path; the service derives
   `is_overdue` for presentation.

## Deferred to Phases B–E (unchanged)

Activities UI, RSVP/attendance UI, assignment workflow UI, report UI, issue UI,
coordination migration, member-directory UI, realtime (optional per gate §28),
evidence upload migration, hosted smoke gate (Phase F).

## Files changed by Phase A

- `supabase/migrations/0021_campaign_core.sql` (new)
- `src/lib/supabase/campaign.ts` (new)
- `tests/security/phaseA-campaign-core.test.ts` (new)
- `docs/Campaign-PhaseA-Implementation-Report.md` (this file)

Legacy Firebase Campaign files untouched (§35). No dual-read/dual-write. No Election,
Social, Governance, Donations, or leaderboard object modified.
