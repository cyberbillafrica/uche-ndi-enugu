# PolitiCore — Campaign Architecture Validation & Migration Gate

**Status:** DESIGN GATE — READY FOR IMPLEMENTATION REVIEW
**Prepared from:** live repository audit (not assumptions) + ratified Phase 1A/1B/1C foundations
**Migration strategy:** Clean Supabase/PostgreSQL cutover — NO dual-write, NO dual-read
**Scope:** Campaign Management only. Hard stop at Social Force, Governance, Donations, Control Center, and any Election redesign.

---

## 0. Executive summary

Campaign already exists as a working product on Firebase. This gate inventories the real
implementation, maps every Firestore mechanism to the established Supabase foundation,
normalizes the two genuine structural defects (client-side scope expansion and
client-resolved scope for scoped users), and specifies the relational model, state
machines, RLS/RPC design, service boundary, and security/test plans.

**Genuine defects found in the Firebase Campaign implementation (all corrected by this design):**

| # | Defect | Correction in this design |
|---|--------|---------------------------|
| D1 | Activities/assignments/reports/issues visibility for scoped coordinators is **computed client-side** via `expandAssignmentToScopes()` fan-out queries (N+1 Firestore queries per page load); authorization effectively runs in React | Server-side hierarchical resolution: one indexed query per list + `politicore.scope_covers` RLS predicate. The client-side expander dies with the Firebase files |
| D2 | Coordinators resolve their own operating scope in the client (`coordination/page.tsx` loads `users`, `organizational_assignments`, `permission_grants` directly; `getScopedCampaignMembers` returns tenant-wide directory for zone+ scopes) | `politicore.my_scopes()` is the single resolver; RLS and `has_permission` bind it server-side. Member directory is scope-filtered by the database, not the UI |
| D3 | `tenant_id` is nullable on issues and set **client-side** on assignments/reports | `tenant_id uuid NOT NULL REFERENCES tenants(id)`, never accepted from the client — resolved server-side from the authenticated session |
| D4 | Audit exists nowhere in the Campaign surface (no review log, no reassignment log) | `system_audits` written inside the authority-bearing RPCs |

**Preserved verbatim (audit will not "fix" what isn't broken):** `scope_type`/`scope_id`
polarity of Campaign records (§3.2), the report status vocabulary `submitted →
under_review → accepted/returned` (§3.4), the assignment status set (§3.3), the member
directory's `campaign_member` membership filter (§3.6), field-level report shape
(participants/issues/community_feedback/requests/follow_up_required, §3.4).

---

## 1. Source-of-truth inventory (live repository)

### 1.1 Firebase Campaign services — every export mapped

**`src/lib/firebase/campaignActivities.ts`** (323 L; collection `campaign_activities`)

| Legacy export | New home | Notes |
|---|---|---|
| `getAllCampaignActivities()` | `campaignService.getActivities()` | was tenant-wide fetch → RLS view |
| `getCampaignActivitiesForAssignments(assignments, lgas)` | `campaignService.getActivities()` | **defect D1 dies here** — client expansion replaced by server scoping |
| `createCampaignActivity(input)` | `campaignService.createActivity()` | RPC; note legacy has `organizer_id` distinct from `created_by` — preserved |
| `updateCampaignActivity(id, input)` | `campaignService.updateActivity()` | field whitelist preserved (`manage_activity`) |
| `deleteCampaignActivity(id)` | `campaignService.deleteActivity()` | `manage_activity` + scope; participants cascade |

**`src/lib/firebase/campaignAssignments.ts`** (337 L; `campaign_assignments`)

| Legacy export | New home |
|---|---|
| `getAllCampaignAssignments(tenantId)` | `getAssignments()` (admin) / RLS view |
| `getAssignmentsForAssignmentScope(assignment, lgas)` | `getAssignments()` — D1 dies |
| `getMyCampaignAssignments(userId, userEmail)` | `getAssignments({ mine: true })` — legacy dual identity key (userId **or** email) collapses to `assigned_to uuid = profiles.id`; membership changes run through the core member service (§3.6) |
| `getScopedCampaignAssignments(tenantId, scopeType, scopeId)` | `getAssignments()` — RLS-scoped view |
| `createCampaignAssignment(data)` | `create_assignment` RPC (client passed `assigned_by`/`tenant_id` — both die) |
| `updateCampaignAssignment(id, data)` | `update_assignment` / `submit_assignment` / `review_assignment` RPCs per §3.3 |
| `deleteCampaignAssignment(id)` | RPC, supervisor-only, never in a terminal state |

**`src/lib/firebase/campaignMembers.ts`** (305 L; reads `users`)

| Legacy export | New home |
|---|---|
| `getAllCampaignMembersForTenant(tenantId)` | `getMembers()` — `manage_members` only |
| `getScopedCampaignMembers(assignment, lgas)` | `getMembers()` — scope filter server-side (defect D2's tenant-wide-for-zone leak corrected to true descendant scope) |
| `getCampaignMemberById(memberId)` | `getMember(id)` — RLS decides visibility |
| `updateCampaignMemberProfile(memberId, data)` | Core member service (§3.6); **the leaderboard-projection side effect is dropped** (§19 boundary) |
| `updateMemberMembershipTypes`, `updateMemberAccessRole` | Core member service — **Campaign never writes `profiles`** |

**`src/lib/firebase/campaignReports.ts`** (301 L; `campaign_field_reports`)

| Legacy export | New home |
|---|---|
| `getMyCampaignReports(userId)` | `getReports({ mine: true })` |
| `getScopedCampaignReportsForAssignment(assignment, lgas)` | `getReports()` — D1 dies |
| `getAllCampaignReportsForTenant(tenantId)` | `getReports()` (admin) |
| `getScopedCampaignReports(tenantId, scopeType, scopeId)` | `getReports()` |
| `createCampaignFieldReport(data)` | `submit_campaign_report` RPC (`submitted_by`/`tenant_id` die) |

**`src/lib/firebase/campaignIssues.ts`** (211 L; collection **`issues`** — renamed
`campaign_issues` to keep the Campaign namespace clean for Governance)

| Legacy export | New home |
|---|---|
| `createCampaignIssue(data)` | `create_campaign_issue` RPC |
| `getAllCampaignIssues()` | `getIssues()` (admin) — legacy fetched **across all tenants**, corrected |
| `getScopedCampaignIssues(assignment, lgas)` | `getIssues()` — D1 dies |
| `getMyCampaignIssues(userId)` | `getIssues({ mine: true })` |

**`src/lib/firebase/organizationalAssignments.ts`** (505 L) and **`permissionGrants.ts`**
(336 L) are **Core, not Campaign** — their tables (`organizational_assignments`,
`permission_grants`) already exist and are ratified. Legacy client functions are replaced
by the existing admin/RPC surface; Campaign consumes, never re-implements.
`src/lib/firebase/organization.ts` — pure client helpers — is presentation-only and dies
with its pages.

### 1.2 Firebase Campaign UI — every page mapped

| Page (LOC) | Current data mechanism | Migration mechanism |
|---|---|---|
| `campaign/page.tsx` (dashboard) | AuthContext + derived stats | Campaign service reads over RLS views |
| `campaign/area/page.tsx` (481) | AuthContext + static geography constants | Campaign service + Supabase geography |
| `campaign/activities/page.tsx` (1365) | 5 activity service calls + static geography + expandAssignmentToScopes | `campaignService.getActivities/createActivity/updateActivity/deleteActivity` + participation/attendance |
| `campaign/assignments/page.tsx` (1062) | 6 assignment service calls + members + expand | `getAssignments` + workflow RPCs + `getMembers` |
| `campaign/coordination/page.tsx` (1190) | **Direct Firestore reads of `users`, `organizational_assignments`, `permission_grants`** | Supabase identity/organization services over the existing tables (admin-gated); defect D2 dies |
| `campaign/issues/page.tsx` (706) | 3 issue service calls | `getIssues/createIssue` + issue RPCs |
| `campaign/reports/page.tsx` (921) | 4 report service calls | `getReports`/`submitReport` + review RPC |
| `campaign/members/page.tsx` (309) + `members/[id]/page.tsx` (1444) | member service (profile/membership/access-role writes) | Core member service (§3.6) + Campaign directory reads |
| `admin/reports/page.tsx` (330) | campaign report reads/review | Campaign service review RPC |
| `hooks/useScopedCampaignMembers.ts` (110) | getScopedCampaignMembers | `campaignService.getMembers` |
| `GlobalSearchModal.tsx` | campaign sections | Campaign service (same pattern as Election) |

**Fire wall (from import graph):** zero imports of the six Campaign services from
Social/Election/Governance/Donation files → Campaign touches only Campaign.

### 1.3 Realtime, media, notifications today

- **No Firestore realtime listeners** in the Campaign surface (verified by scan) —
  everything is fetch-per-render. Per §28, realtime is an *optional Phase B* addition
  (assignments + issues only) after the base cutover passes.
- **Media:** legacy evidence is a plain string column (`evidence_url` / `evidence_url`
  on assignments/reports/issues) with no upload path in the audited services. §21/§34
  normalize to Media Service + `media_assets` + relationally-referenced evidence
  (`asset_id uuid REFERENCES media_assets(id)`).
- **Notifications:** legacy Campaign calls `addNotification` (fire-and-forget, wins
  regardless of failure). Normalized to existing per-user notifications infrastructure,
  invoked inside the workflow RPCs; no Campaign collection.

### 1.4 Types

`src/types/index.ts` carries the legacy Campaign interfaces. Superseded by canonical
Supabase-backed types colocated with the Campaign service (§4) — same pattern Election
used. Legacy interfaces are not deleted in this phase (§46: record supersession, don't
rewrite history).

### 1.5 Tests

No dedicated Firebase Campaign test file exists. The local Campaign suites in this plan
(§6) are therefore **new**, built on the PGlite RLS harness used by the Phase 1A/1B/1C
suites; the hosted plan is §45 of the gate.

---

## 2. Foundation reuse — what Campaign consumes

| Concern | Consumed (already ratified) |
|---|---|
| Identity | `profiles.id = auth.users.id` |
| Tenancy | `tenant_id NOT NULL REFERENCES tenants(id)` on every Campaign table; server-resolved |
| Module gate | `module_enabled('campaign')` / `my_module_enabled` — checked in service + every policy/RPC; **Campaign activation never implies authority**; Campaign is independent of Election/Social activation |
| Authorization | `has_assignment_at`, `has_permission(user, permission, scope_type, scope_id)` — position branch + grant branch (explicit deny wins) + admin branch; `my_scopes()` |
| Scope inheritance | `scope_chain` / `scope_covers` — the only hierarchy resolver (State→Zone→LGA→Ward→PU; `campaign` covers all) |
| Geography | `states/senatorial_zones/lgas/wards/polling_units` + public views |
| Media | Media Service → R2 → `media_assets` |
| Notifications | `notifications` table + per-user service |
| Audit | `system_audits` |
| Public data API | 0009/0020 convention: `public.*` security-invoker views over `politicore.*` |

Organizational positions stay positions (position matrix in 0004 already grants
`view_assignments`+`create_assignment` to campaign_member and `review_assignment` to
ward_coordinator+; campaign_manager/council_chairman intentionally carry zero — §12/§35
boundaries hold by construction).

---

## 3. Relational data model

Conventions: `politicore` schema; `tenant_id uuid NOT NULL` everywhere; FKs to
`tenants(id)` / `profiles(id)` / geography / `media_assets(id)`; `timestamptz` with
`created_at/updated_at` defaults and the existing `set_updated_at` trigger; enum types
constrained to the audited vocabularies; partial indexes on open-status columns.

### 3.1 `campaign_activities`

```sql
CREATE TYPE politicore.campaign_activity_type AS ENUM (
  'rally','meeting','stakeholder_engagement','training',
  'community_engagement','ward_meeting','lga_meeting','campaign_outreach','other');
CREATE TYPE politicore.campaign_activity_status AS ENUM (
  'scheduled','postponed','cancelled','completed');

CREATE TABLE politicore.campaign_activities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id),
  title               text NOT NULL,
  description         text,
  activity_type       politicore.campaign_activity_type NOT NULL DEFAULT 'meeting',
  venue               text,
  scheduled_start     timestamptz NOT NULL,
  scheduled_end       timestamptz,
  expected_attendance integer CHECK (expected_attendance >= 0),
  scope_type          politicore.scope_type_enum NOT NULL,
  scope_id            text NOT NULL,
  status              politicore.campaign_activity_status NOT NULL DEFAULT 'scheduled',
  organizer_id        uuid REFERENCES politicore.profiles(id),  -- legacy organizer/creator distinction preserved
  created_by          uuid REFERENCES politicore.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start)
);
CREATE INDEX campaign_activities_scope_idx ON politicore.campaign_activities
  (tenant_id, scope_type, scope_id, scheduled_start);
CREATE INDEX campaign_activities_tenant_date_idx ON politicore.campaign_activities
  (tenant_id, scheduled_start);
```

Legacy `date`/`start_time`/`end_time` strings normalize to real timestamps (reversible
lossless mapping documented for the data-migration phase). Statuses are the controlled
set; `completed` is set by RPC only.

### 3.2 `campaign_activity_participants` — participation is attendance-free

```sql
CREATE TYPE politicore.campaign_rsvp AS ENUM ('going','interested','not_going');
CREATE TYPE politicore.campaign_attendance_state AS ENUM ('present','excused','absent');

CREATE TABLE politicore.campaign_activity_participants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id),
  activity_id    uuid NOT NULL REFERENCES politicore.campaign_activities(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES politicore.profiles(id),
  rsvp           politicore.campaign_rsvp NOT NULL DEFAULT 'going',
  rsvp_at        timestamptz NOT NULL DEFAULT now(),
  attendance     politicore.campaign_attendance_state,   -- NULL = not yet recorded (operational fact, not intent)
  checked_in_at  timestamptz,
  checked_out_at timestamptz CHECK (checked_out_at IS NULL OR checked_in_at IS NOT NULL
                                 AND checked_out_at > checked_in_at),
  recorded_by    uuid REFERENCES politicore.profiles(id), -- who recorded attendance (supervisor)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, user_id),
  UNIQUE (activity_id, user_id, tenant_id)
);
CREATE INDEX campaign_participants_activity_idx ON politicore.campaign_activity_participants (activity_id);
```

RSVP is a declaration of intent; attendance is an operational fact recorded by a
supervisor via RPC. A participant **cannot write another participant's attendance** and
cannot mark themselves present (§35) — check-in is an authority act.

### 3.3 `campaign_assignments` + workflow

```sql
CREATE TYPE politicore.campaign_assignment_priority AS ENUM ('low','medium','high','urgent');
CREATE TYPE politicore.campaign_assignment_status AS ENUM (
  'not_started','in_progress','submitted','under_review','completed','overdue');

CREATE TABLE politicore.campaign_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id),
  title        text NOT NULL,
  description  text,
  assigned_to  uuid NOT NULL REFERENCES politicore.profiles(id),
  assigned_by  uuid NOT NULL REFERENCES politicore.profiles(id),
  scope_type   politicore.scope_type_enum NOT NULL,
  scope_id     text NOT NULL,
  priority     politicore.campaign_assignment_priority NOT NULL DEFAULT 'medium',
  status       politicore.campaign_assignment_status NOT NULL DEFAULT 'not_started',
  due_date     date,
  location     text,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),  -- §21/§34; evidence_url dies
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_assignments_assignee_idx ON politicore.campaign_assignments (assigned_to, status);
CREATE INDEX campaign_assignments_scope_idx ON politicore.campaign_assignments (tenant_id, scope_type, scope_id);
CREATE INDEX campaign_assignments_status_idx ON politicore.campaign_assignments (tenant_id, status);
CREATE INDEX campaign_assignments_due_idx ON politicore.campaign_assignments (tenant_id, due_date);
```

**State machine (status vocabulary preserved verbatim; `overdue` is derived — overdue
assignments are `not_started`/`in_progress` past `due_date`, exposed via a service
derived field, not a hand-set status):**

```text
not_started ──submit(assignee)──▶ submitted ──review▶(accept)──▶ completed
not_started ──start(assignee)──▶ in_progress ─┘        └──review▶(return)──▶ under_review──▶(resubmit)──▶ submitted
```

Transitions — RPC only, checked server-side:

| Transition | Actor | Authority | Guard |
|---|---|---|---|
| create (`not_started`) | supervisor | `create_assignment` + `scope_covers(scope)`; **must also cover the assignee's registered scope** | assignee must exist in-tenant |
| start → `in_progress` | assignee | is `assigned_to` | status must be `not_started` |
| submit → `submitted` | assignee | is `assigned_to` | status `not_started`/`in_progress`; evidence optional |
| review accept → `completed` | supervisor | `review_assignment` + scope covers assignment scope | status `submitted`/`under_review`; **reviewer ≠ assignee** (self-approval ban) |
| review return → `under_review` | supervisor | same | status `submitted` |
| resubmit → `submitted` | assignee | is `assigned_to` | status `under_review` |

Illegitimate writes (arbitrary status/`assigned_by`/tenant changes) are impossible:
UPDATE via RLS is assignee-limited to non-workflow fields (`evidence_asset_id`,
`location` description-class fields) in non-terminal states; every workflow transition
is an RPC.

### 3.4 `campaign_field_reports` + workflow

```sql
CREATE TYPE politicore.campaign_report_type AS ENUM (
  'activity','community','mobilization','meeting','field','other');
CREATE TYPE politicore.campaign_report_status AS ENUM (
  'submitted','under_review','accepted','returned');

CREATE TABLE politicore.campaign_field_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES politicore.tenants(id),
  submitted_by       uuid NOT NULL REFERENCES politicore.profiles(id),
  report_type        politicore.campaign_report_type NOT NULL DEFAULT 'field',
  title              text NOT NULL,
  description        text NOT NULL,
  scope_type         politicore.scope_type_enum NOT NULL,
  scope_id           text NOT NULL,
  location           text,
  participants       integer CHECK (participants IS NULL OR participants >= 0),
  issues             text,
  community_feedback text,
  requests           text,
  follow_up_required boolean NOT NULL DEFAULT false,
  status             politicore.campaign_report_status NOT NULL DEFAULT 'submitted',
  evidence_asset_id  uuid REFERENCES politicore.media_assets(id),
  reviewed_by        uuid REFERENCES politicore.profiles(id),
  review_comment     text,
  reviewed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_reports_submitter_idx ON politicore.campaign_field_reports (submitted_by, status);
CREATE INDEX campaign_reports_scope_idx ON politicore.campaign_field_reports (tenant_id, scope_type, scope_id);
CREATE INDEX campaign_reports_status_idx ON politicore.campaign_field_reports (tenant_id, status);
```

Workflow (vocabulary preserved verbatim):
`submitted → under_review → accepted | returned → (resubmit) → submitted`.
Submitter visibility: own reports in any status (submitter-visible boundary preserved).
Review: `review_field_report` + scope covers report scope; **self-approval banned**.
Resubmit on `returned` allowed to the original submitter; re-review only via review RPC.

### 3.5 `campaign_issues` + workflow

```sql
CREATE TYPE politicore.campaign_issue_type AS ENUM (
  'logistics','campaign_activity','community_concern','volunteer',
  'communication','security','infrastructure','other');
CREATE TYPE politicore.campaign_issue_priority AS ENUM ('low','medium','high','urgent');
CREATE TYPE politicore.campaign_issue_status AS ENUM (
  'reported','acknowledged','assigned','in_progress','resolved','closed');

CREATE TABLE politicore.campaign_issues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES politicore.tenants(id),  -- D3: NOT NULL, server-resolved
  title            text NOT NULL,
  description      text NOT NULL,
  issue_type       politicore.campaign_issue_type NOT NULL DEFAULT 'other',
  priority         politicore.campaign_issue_priority NOT NULL DEFAULT 'medium',
  status           politicore.campaign_issue_status NOT NULL DEFAULT 'reported',
  scope_type       politicore.scope_type_enum NOT NULL,
  scope_id         text NOT NULL,
  reported_by      uuid NOT NULL REFERENCES politicore.profiles(id),
  assigned_to      uuid REFERENCES politicore.profiles(id),
  location         text,
  evidence_asset_id uuid REFERENCES politicore.media_assets(id),
  resolution_notes text,
  resolved_by      uuid REFERENCES politicore.profiles(id),
  resolved_at      timestamptz,
  verified_by      uuid REFERENCES politicore.profiles(id),
  verified_at      timestamptz,
  closed_by        uuid REFERENCES politicore.profiles(id),
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_issues_scope_idx ON politicore.campaign_issues (tenant_id, scope_type, scope_id);
CREATE INDEX campaign_issues_status_idx ON politicore.campaign_issues (tenant_id, status);
CREATE INDEX campaign_issues_assignee_idx ON politicore.campaign_issues (assigned_to, status);
CREATE INDEX campaign_issues_reporter_idx ON politicore.campaign_issues (reported_by);
```

**Workflow (§15):** `reported → acknowledged → assigned → in_progress → resolved →
verified → closed`, with reassignment only in open states. The four operational roles
are distinct columns — reporter / assignee / resolver (`resolved_by`) / verifier
(`verified_by`) — never collapsed into `updated_by`. Reporter can never fabricate
another reporter; close/verify require `manage_issue` + scope; assign/reassign require
`manage_issue` + scope covers both the issue scope and the assignee's registered scope.
Issues live in **open states** (`reported`…`resolved`) for supervisor visibility; `closed`
is terminal/locked.

### 3.6 Members directory — views over Core, zero new authority

Campaign **never writes `profiles`**. The directory is the existing `politicore_profiles`
public view, filtered server-side:

- `getMembers()` for admins (`manage_members`) — tenant-wide.
- Scoped coordinators — the member service resolves `my_scopes()` server-side and
  returns members whose registered location falls inside the covered scopes (ward → its
  PUs; LGA → its wards/PUs; zone → LGAs→wards→PUs; state/campaign → tenant). No
  tenant-wide leak for zone+ scopes (D2 corrected).
- Ordinary members — product-directory baseline only (`view_members` semantics).
- `membership_types.includes('campaign_member')` remains the **directory filter**
  (preserved verbatim), never an authority test (§6).

Profile edits, membership types, and access roles route through the **core member
service** (the existing admin identity surface), *not* Campaign. The legacy
leaderboard-projection side effect on profile update is **dropped** (§19 boundary:
leaderboard projection is owned by its own protected subsystem).

### 3.7 Campaign settings

Campaign module settings live under the **existing `tenant_settings`** foundation with a
normalized `campaign` module key — no new settings table, no unstructured dump.
`manage_campaign_settings` (seeded 0004) gates writes. Nothing security/workflow-relevant
is stored outside validated keys.

### 3.8 Notifications & audit mapping

| Event | Notification type | Audit |
|---|---|---|
| assignment created / re-assigned | `assignment` | `system_audits(action='campaign.assignment.create'|'campaign.assignment.reassign')` |
| assignment reviewed (accept/return) | `assignment` | `campaign.assignment.review` |
| report reviewed (accept/return) | `assignment` (legacy type set) | `campaign.report.review` |
| issue assigned / status change | `assignment` | `campaign.issue.status` |
| activity status change | `activity` | `campaign.activity.status` (management ops only) |

All notification writes occur **inside** the workflow RPCs (server-side); failure to
notify never fails the business action (legacy fire-and-forget semantics preserved).

---

## 4. Service boundary

```text
UI (campaign pages, admin/reports, search modal)
  → src/lib/supabase/campaign.ts          ← the ONLY Campaign application boundary
  → src/lib/supabase/access.ts            ← route/page gate: module_enabled('campaign') + authz
  → src/lib/supabase/session-bridge.ts    ← Firebase session → Supabase (established)
Supabase: RLS on politicore.* · public.* security-invoker views · workflow RPCs
  → PostgreSQL
```

`campaign.ts` exports (single flat service, mirroring `election.ts`):
activities (`getActivities`, `createActivity`, `updateActivity`, `deleteActivity`),
participation (`setRsvp`, `recordAttendance`), assignments (`getAssignments`,
`createAssignment`, `startAssignment`, `submitAssignment`, `reviewAssignment`,
`resubmitAssignment`, `updateAssignmentDetails`, `deleteAssignment`),
reports (`getReports`, `submitReport`, `reviewReport`, `resubmitReport`),
issues (`getIssues`, `createIssue`, `updateIssueStatus`, `assignIssue`),
members (`getMembers`, `getMember`), settings (`getCampaignSettings`), plus typed
error mapping.

**Error semantics (§33):** service errors are typed (`unauthenticated`, `module_disabled`,
`forbidden` (missing permission), `outside_scope`, `invalid_transition`, `not_found`,
`validation`, `infra`) — mapping PostgREST/RPC error codes. **No catch-to-empty-array**
anywhere (explicitly correcting the legacy pattern).

Types: canonical Campaign types colocated with the service; no `any`, no Firestore
timestamps, no provider URLs, no embedded arrays.

---

## 5. Authorization & RLS design

Every Campaign table: `ENABLE ROW LEVEL SECURITY`; SELECT policy =
`module_enabled('campaign') AND (admin OR has_permission(...) OR submitter/assignee-own
OR participant-of-activity)`. Mutations go through RPCs (`security definer` where they
need to read authority tables, with explicit tenant/identity resolution — the
established 0015/0019 pattern).

- **SELECT visibility** (strictly better than the audited Firebase behavior, which was
  tenant-visibility + client filtering): activities/issues/reports/assignments visible
  to admins tenant-wide, to holders of the relevant view/create permission within
  covered scopes, and always to their own submissions/assignments.
- **Module gate:** in every policy and RPC: module disabled ⇒ zero rows / refuse RPC.
- **Client-supplied `tenant_id`/actor IDs are never trusted** — RPCs resolve identity
  and tenant from the session; the D3 column fix makes spoofing structurally impossible.
- **Scope polarity:** Campaign records carry their own `scope_type/scope_id`; authority
  checks are `politicore.scope_covers(grantee_scope, record_scope)` — grantee scope
  must **cover** the record scope. Client-side expansion is gone (D1).
- **No `user_access` recreation** — visibility and authority are computed from
  assignments+grants at query time by the existing resolvers.

### Public data-API surface (0009/0020 convention)

`public.campaign_activities`, `public.campaign_assignments`,
`public.campaign_field_reports`, `public.campaign_issues` (+ participants view for
activity UI) — security-invoker views adding zero authorization, mirroring how Election
reads were exposed. All workflow writes go through RPCs (§27).

---

## 6. Security matrix (§35) → test mapping

| Gate §35 requirement | Local suite (PGlite) | Hosted smoke (§45 item) |
|---|---|---|
| Tenant isolation (A/B read, write, inference) | phase-A suite | 8 |
| Social-only user denied Campaign-only ops | phase-A suite | 24 |
| Member without permission denied privileged action | phase-A suite | 4 |
| Ward scope ≠ another ward; ward→PU, LGA→ward/PU, zone→LGA/ward/PU inheritance | phase-A suite (D1 regression) | 5–7 |
| Position title ≠ permission (Campaign Manager / Council Chairman carry zero) | phase-A suite | 25 (officer boundary analog) |
| Election Officer gains no Campaign administration | phase-A suite | 25 |
| No assignment outside authority / no self-elevation / no tenant change | phase-B suite | 27 |
| Assignee cannot manipulate another's restricted state | phase-B suite | 21 |
| Submitter within scope; **cannot self-approve**; reviewer outside scope denied | phase-D suite | 16–17 |
| Reporter cannot fabricate reporter; issue tenant immutable; close/verify authority | phase-D suite | 18–20 |
| Unauthorized activity create/manage/delete; attendance spoofing denied | phase-B suite | 10–12 |
| Unauthorized state transitions denied (all three machines) | per-phase suites | 21 |
| Evidence via Media Service only | phase-B hosted | 22 |
| Notification generation | phase-D suite | 23 |
| No leaderboard mutation from Campaign | phase-A suite (static + DB probe) | 26 |
| No direct client authority escalation (grants/assignments/roles) | phase-A suite | 27 |
| Audit records written by authority RPCs | per-phase suites | 28 |
| Pagination/query correctness | phase-E suite | 29 |
| Pristine cleanup | every suite | 30 |

---

## 7. Test plan

**Local (vitest, PGlite, `vitest.security.config.ts` pattern):** per §44 sub-phase —
`phaseA-campaign-core.test.ts` (module gate, RLS, scope inheritance, position/grant
boundaries), `phaseB-campaign-activities.test.ts`, `phaseC-campaign-assignments.test.ts`
(workflow + authority), `phaseD-campaign-reports-issues.test.ts`, each with fixture
cleanup + pristine assertions. Plus §36 regression checklist executed at the Phase F
gate (dashboard, area, directory, assignments, activities, RSVP, attendance, reports,
issues, coordination surfaces, notifications).

**Hosted smoke (§45, 30 items):** `scripts/db/verify-hosted-smoke-campaign.ts` following
the proven Phase 2 Election harness — real GoTrue identities, real RPCs through the real
data API, real media upload through the actual Next.js evidence-style route, realtime
settle-time handling where enabled, full fixture cleanup + pristine verification as the
final assertion.

**Regression gates:** all existing suites remain green (Phase 1A/1B/1C + Phase 2 Election
suites), `tsc --noEmit` clean, `npm run build` passes, touched-file lint zero errors,
Firebase-dependency scan shows zero Campaign imports of Firebase.

---

## 8. Implementation sub-phases (§44)

| Sub-phase | Contents | Gate |
|---|---|---|
| **A** | 0021 migration (tables/constraints/indexes/RLS/RPCs/audit hooks), public views, `campaign.ts` service core, `phaseA` suite | STOP — DB/security tests |
| **B** | Activities + participants + attendance service/UI + notifications | STOP — hosted acceptance |
| **C** | Assignments workflow + evidence + service/UI | STOP — hosted acceptance |
| **D** | Field reports + issues workflows + service/UI | STOP — hosted acceptance |
| **E** | Coordination/members surfaces onto Supabase foundation (no Core redesign) | STOP — security + regression |
| **F** | Final Campaign lock gate (all §45 items, full regression, Firebase scan) | **CAMPAIGN LOCKED** |

---

## 9. Explicitly out of scope (unchanged by this gate)

Social Force (tasks/submissions/points/leaderboard), Governance, Donations, Control
Center, Election architecture (locked — cross-module *reads* of Election data would be a
separately reviewed gate), global Firebase cleanup (Campaign files are retired only when
the cleanup phase permits; until then they are dead code to the Campaign UI after
cutover), leaderboard semantics, per-tenant schemas, any second authorization/geography
framework.

---

## 10. Gate exit-criteria checklist (§49)

- [x] Architecture boundaries documented; Campaign ⇍ Election/Social/Governance
- [x] Relational schema specified (§3) with constraints, state machines, indexes
- [x] Existing Core authorization reused; scope hierarchy via `scope_covers`; no `user_access`
- [x] RLS design specified (§5); RPC list defined (§3.3/3.4/3.5)
- [x] Service boundary defined (§4); no Firebase in the new implementation
- [x] Tenant/scope isolation, permission matrix, and direct-abuse cases enumerated (§6)
- [x] Local + hosted test plans and cutover criteria defined (§7)
- [x] Legacy defects D1–D4 documented with corrections; preserved behaviors listed (§0)
