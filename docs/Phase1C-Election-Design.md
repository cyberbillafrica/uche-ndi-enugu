# POLITICORE — PHASE 1C

# Election & Result Management — Architecture Validation & Migration Gate

Status: **DESIGN COMPLETE — AWAITING APPROVAL** (hard stop respected; no Election implementation performed)

---

## 0. Executive Summary

The Phase 1A/1B Supabase foundation was inspected migration-by-migration, the live hosted
database was cataloged read-only, and the entire legacy Firebase Election implementation was
traced (services, types, 7 portal pages, 3 realtime listeners, and the full Election-relevant
surface of `firestore.rules`).

Findings that shape the design:

1. **The Supabase foundation contains zero Election tables.** The 19 `politicore` tables are
   pure foundation (tenancy, authorization, geography, media, audit, notifications). The
   election-shaped TypeScript types in `src/types` (ElectionCycle, ElectionContest,
   ElectionCandidate, ElectionSettings) were designed for Firestore but never migrated. The
   Election domain is genuine greenfield on the Supabase side.
2. **The legacy engine is already contest-aware** — the Firestore engine (unlike the earlier
   single-election design the Phase 1C brief was written against) already models election
   cycles and contests. Phase 1C's job is therefore to **normalize** that model relationally,
   not to invent multi-contest support.
3. **Key legacy defects to fix, not port**: vote counting by party *name string*
   (`results: {party, votes}[]` — rename a party and history breaks); client-side aggregation
   in `useMemo`; `contest_type`/`contest_scope` denormalized on every result row; evidence
   stored as Cloudinary URLs with no registry; no uniqueness on the result identity
   (`{contest}__{PU}` exists only in the doc ID).

The design below reuses 100% of the Phase 1A/1B authorization, scope, media, audit, and
notification infrastructure, adds 10 domain tables, 3 workflow RPCs, and 1 SQL view.

---

## 1. What Was Inspected (evidence base)

### 1.1 Supabase migrations (all 14, 0000–0013)

| Migration | Content relevant to Election |
|---|---|
| `0000_auth_shim.sql` | Self-guarding auth shim; Supabase roles (`anon`/`authenticated`/`service_role`); grants |
| `0001_core_schema.sql` | 19 tables. Election-relevant: `profiles(lga_id, ward_id, polling_unit_id)` registered geography; `media_assets(purpose, visibility, provider)`; `system_audits`; `notifications(type CHECK includes 'election')`. **No election tables** |
| `0002_rls_authorization.sql` | `has_permission()` central resolver (admin → officer fixed set → explicit deny → explicit allow → position defaults at covering scope); `scope_chain()` / `scope_covers()` hierarchical resolution; `my_scopes()`; RLS + FORCE on all 19 tables; deny-by-default for policy-less tables |
| `0003_geography_data.sql` | 1 state / 3 zones / 17 LGAs / 260 wards / 4,145 PUs (0013-corrected zone names) |
| `0004_reference_seed.sql` | Permission catalog — Election family seeded: `submit_election_pu_report`, `submit_election_incident`, `upload_election_result`, `view_election_dashboard`, `manage_election_settings`; gap noted in §5.2 |
| `0005_rpc_wrappers.sql` | Client-callable RPC surface (`politicore_has_permission`, `my_module_enabled`, …) |
| `0006_hosted_hardening_and_auth_hook.sql` | Force-RLS on hosted; `custom_access_token_hook`; `backfill_profile_on_signup` trigger |
| `0007_postgrest_surface_and_provisioning.sql` | `provision_tenant`; security-invoker `public` views |
| `0008_notification_rpc_surface.sql` | `my_unread_count()`, `mark_notifications_read()` |
| `0009_postgrest_views_and_realtime.sql` | Remaining views; `ALTER PUBLICATION supabase_realtime ADD TABLE politicore.notifications` |
| `0010–0012` | Provision-guard NULL fix; module-default fix; auth-hook metadata fix |
| `0013_senatorial_zone_correction.sql` | Zone-identity repair (Enugu West), assertion of 1/3/17/260/4,145 |

### 1.2 Live hosted database (read-only catalog query)

PostgreSQL 17.6 · **19 `politicore` tables** (exactly the foundation set) · **28 functions** ·
**10 security-invoker views in `public`** (`politicore_profiles`, `tenants`,
`tenant_modules`, `public_site_settings`, `notifications`, `states`, `senatorial_zones`,
`lgas`, `wards`, `polling_units`) · realtime publication carries only `notifications` ·
4,145 PUs · **zero election/pu tables and policies**.

### 1.3 Legacy Firebase Election implementation

- **Service core** — `src/lib/firebase/election.ts` (836 lines): cycles/contests/parties/
  candidates CRUD with client-side seed fallbacks (`election-seed.ts`), settings doc
  (`election_settings/{tenantId}` with client fallback defaults), contest-aware result
  submission (`submitElectionResultWithEvidence` — mandatory Cloudinary EC8 URL, deterministic
  doc ID `{contestId}__{pollingUnitId}`, `status='submitted'`, `verified=false`), officer
  review (`reviewElectionResult` — approve/reject/clarify/reopen + append-only history),
  admin correction (`correctElectionResult` — forces `pending_review` + `verified=false`),
  PU reports, incidents, 3 realtime subscribers with role-based query constraints.
- **Pages** — dashboard (`/portal/election`), officer operations desk (`/operations`),
  result upload (`/upload`, Cloudinary EC8 upload), PU reports, incidents, export
  (`electionExport.ts` CSV), admin configurator (`/portal/admin/election`).
- **Types** — `src/types` ContestType (5 values), ContestScopeType (5 values),
  ElectionCycleStatus (6), ContestStatus (4), CollationStatus (4), ElectionSettings
  (`active_election_cycle_id` + `active_contest_id`).
- **Aggregation** — dashboard `useMemo` over result docs: party totals, coverage
  (`approved / PUs-in-scope`), margins; export CSV per LGA/ward.
- **UI gate** — `portal/layout.tsx`: Election group hidden from social-only members;
  operations desk officer-only; election mode hard-coded `true` in UI (tenant flag checked
  only in rules).

### 1.4 Firestore rules invariants (Election surface)

Read at `firestore.rules` lines 61–560, 1080–1450. Full invariant list in §9.

---

## 2. Product-Architecture Compliance

- **Election is module-activated per tenant** (`tenant_modules` row, `module='election'`),
  never implied by Campaign. Every Election RPC gates on `module_enabled('election')` — an
  observer organization can run Election without any Campaign entity existing.
- **No Campaign dependency**: proposed schema references only foundation tables (tenants,
  geography, profiles, media, audit, notifications) + Election tables.
- **No parallel infrastructure**: authorization = `has_permission()`/`scope_covers()`;
  geography = existing 5 tables; evidence = `media_assets` via Media Service; audit =
  `system_audits` via SECURITY DEFINER writes; notifications = existing table + RLS.
- **Results are not Admin-only** — scoped visibility per §5.3.

---

## 3. Proposed Election Schema (Deliverable A)

Naming: all in schema `politicore`, prefix `election_*` for config entities; result/report
entities unprefixed for query ergonomics. All tenant-owned tables carry `tenant_id uuid NOT
NULL REFERENCES politicore.tenants(id)` and are RLS-isolated by it. New enums:
`election_cycle_status`, `contest_type`, `contest_status`, `incident_status`,
`result_status` (see §7 for `result_status` values), `incident_severity`,
`report_type` (or reuse text CHECKs mirroring the 0001 notifications precedent).

### 3.1 `election_cycles` — the election period

- Purpose: one electoral event period (e.g. "2027 General Election") containing many contests.
- Columns: `id uuid pk`, `tenant_id`, `name`, `year int`, `description`, `status
  election_cycle_status DEFAULT 'DRAFT'` (`DRAFT|SCHEDULED|ACTIVE|PAUSED|CLOSED|ARCHIVED`),
  `start_date`, `end_date`, `created_by uuid REFERENCES profiles`, timestamps.
- Constraints/indexes: `UNIQUE (tenant_id, name)`; index `(tenant_id, status)`.
- Replaces Firestore `election_cycles` + its client-side seed fallback.

### 3.2 `election_contests` — a race within a period

- Purpose: Presidential / Governorship / Senatorial / Federal House / State House races; the
  unit that result submission is authorized against.
- Columns: `id uuid pk`, `tenant_id`, `election_cycle_id uuid NOT NULL REFERENCES
  election_cycles ON DELETE RESTRICT`, `contest_type contest_type NOT NULL`
  (`presidential|governorship|senatorial|federal_house|state_house`), `name`, `scope_type
  contest_scope_type NOT NULL` (`national|state|senatorial_zone|federal_constituency|
  state_constituency`), `scope_id text NOT NULL` (FK to the matching geography level —
  nullable-per-type, enforced by type-specific CHECKs, see 3.2.1), `election_date`,
  `status contest_status DEFAULT 'DRAFT'` (`DRAFT|OPEN|PAUSED|CLOSED`),
  `collation_status DEFAULT 'NOT_STARTED'`, `tracked_parties text[]` (FK-validated party
  acronyms — replaces the legacy name-string party rows), `focus_party_id uuid NULL
  REFERENCES political_parties`, `created_by`, timestamps.
- Constraints: `UNIQUE (tenant_id, election_cycle_id, contest_type, name)`; CHECK `status
  IN` active set; index `(tenant_id, election_cycle_id)`, index `(tenant_id, status)`.
- **Central invariant carried from rules**: results may only be created against a contest of
  the caller's tenant with `status='OPEN'` (checked in submit RPC against the race view).
- 3.2.1 Geographic validity CHECK per `contest_type`: `governorship`/`senatorial` require
  `scope_type` consistent with a `senatorial_zone`/`state` row (validated via `scope_id`
  FK helpers described in §3.10) — implemented as a type-specific CHECK + a submit-time
  RPC assertion, keeping the schema honest without exotic trigger complexity.

### 3.3 `political_parties` — shared reference data

- Purpose: party master (INEC-registered parties), referenced by contests, candidates and
  result votes. **Platform-level (not per-tenant)** — mirrors the legacy
  `political_parties` collection whose rules are world-readable and admin-writable.
- Columns: `id uuid pk`, `acronym text UNIQUE NOT NULL`, `name`, `logo_url`, `color`,
  `inec_registered bool DEFAULT true`, `is_active bool DEFAULT true`, timestamps.
- Index: `UNIQUE (acronym)`; read-all / platform-admin-write policies (mirrors legacy).
- Legacy party *rows* (name strings) map to `acronym`; the result-vote-by-name defect is
  fixed by FK.

### 3.4 `election_candidates` — contest participation

- Purpose: candidates per contest; contest-specific participation (a party may field
  different candidates in different races).
- Columns: `id uuid pk`, `tenant_id`, `contest_id uuid NOT NULL REFERENCES election_contests
  ON DELETE RESTRICT`, `party_id uuid NOT NULL REFERENCES political_parties`,
  `candidate_name`, `running_mate_name`, `is_active bool DEFAULT true`
  (replaces `active|disqualified|withdrawn` — disqualification is data + audit, not row
  deletion), timestamps.
- Constraints: `UNIQUE (contest_id, party_id)` (one candidate per party per contest);
  index `(contest_id)`.

### 3.5 `election_results` — the PU-level result

- Purpose: one submitted result per (contest, polling unit) — the heart of the engine and the
  unit of evidence, verification and aggregation.
- Columns:
  - identity: `id uuid pk`, `tenant_id`, `election_cycle_id uuid NOT NULL REFERENCES
    election_cycles`, `contest_id uuid NOT NULL REFERENCES election_contests`,
    `polling_unit_id text NOT NULL REFERENCES polling_units(id)`,
    `ward_id text NOT NULL REFERENCES wards(id)`, `lga_id text NOT NULL REFERENCES
    lgas(id)` (denormalized for RLS locality, matching the `wards` precedent),
  - data: `votes jsonb NOT NULL DEFAULT '[]'` — `[{party_id uuid, votes int}]` **FK-validated
    party ids** (template CHECK requires `party_id` + non-negative `votes`; referential
    validity enforced in the submit/correct RPCs against `political_parties`, because Postgres
    cannot FK into jsonb; the legacy name-string defect dies here),
  - lifecycle: `status result_status NOT NULL DEFAULT 'submitted'`, `verified bool NOT NULL
    DEFAULT false`, `reviewed_by uuid NULL REFERENCES profiles`, `review_notes text`,
    `reviewed_at timestamptz`,
  - evidence: `evidence_asset_id uuid NOT NULL REFERENCES media_assets(id)` — **required**
    (legacy EC8 evidence-mandatory invariant),
  - provenance: `submitted_by uuid NOT NULL REFERENCES profiles`, timestamps.
- Constraints: **`UNIQUE (tenant_id, contest_id, polling_unit_id)`** — the relational form of
  the deterministic `{contest}__{PU}` doc ID; CHECK `verified = (status='approved')` —
  the rules' core invariant enforced by the database itself; **no DELETE policy** (delete
  never, per rules); index `(tenant_id, contest_id, status)`, index `(tenant_id, ward_id)`.
- 3.5.1 **Submission model (open decision flagged in §11):** the legacy engine is one
  row per (contest, PU) with revision history; a PU re-submit updates the row and appends
  history. The relational design preserves this (the unique constraint IS the upsert key).
  The alternative (immutable submissions + a winner view) adds a revision table now; the
  append-only `election_result_history` below already preserves the full audit trail, so the
  simpler model is proposed.

### 3.6 `election_result_history` — append-only audit trail

- Purpose: the legacy in-document `history[]` array, promoted to a real table. Also replaces
  the flat `system_audits` usage for the result workflow with domain-structured history.
- Columns: `id uuid pk`, `tenant_id`, `result_id uuid NOT NULL REFERENCES election_results
  ON DELETE RESTRICT`, `action text NOT NULL CHECK (action IN ('create','correct',
  'review_approve','review_reject','review_clarify','reopen'))`, `actor_id uuid REFERENCES
  profiles`, `old_status result_status`, `new_status result_status`, `old_votes jsonb`,
  `new_votes jsonb`, `notes text`, `created_at timestamptz NOT NULL DEFAULT now()`.
- Constraints: **INSERT-only** (no UPDATE/DELETE policies, no grants) — append-only enforced
  by privilege, not convention; index `(result_id, created_at)`.
- Writes: only by the workflow RPCs (SECURITY INVOKER role needs the INSERT grant; RPC logic
  is the only writer — direct PostgREST inserts are additionally blocked by a trigger that
  rejects rows where `actor_id IS NULL`… see §8 for the simpler trigger choice).

### 3.7 `pu_reports` — election-day operational reports

- Purpose: operational PU situation reports (opening/turnout/conduct/closing/general).
  Distinct from result data and incidents (per §17 of the brief).
- Columns: `id uuid pk`, `tenant_id`, `ward_id`, `polling_unit_id`, `report_type`, `title`,
  `content`, `evidence_asset_id uuid NULL REFERENCES media_assets` (optional photo),
  `status text DEFAULT 'submitted'` (`submitted|under_review|acknowledged`),
  `submitted_by`, `created_at`.
- Constraints: index `(tenant_id, ward_id, created_at DESC)`.

### 3.8 `election_incidents` — incident reports

- Purpose: election-day incidents (ballot snatching, violence, BVAS malfunction, late
  arrival, vote buying, other) with severity and workflow status.
- Columns: `id uuid pk`, `tenant_id`, `ward_id`, `polling_unit_id NULL` (nullable — legacy
  ward-only incidents), `incident_type`, `severity`, `description`, `evidence_asset_id uuid
  NULL`, `status incident_status DEFAULT 'reported'` (`reported|investigating|resolved|
  dismissed`), `reported_by`, timestamps.
- Index: `(tenant_id, status, created_at DESC)`.

### 3.9 `election_settings` — active collation context (admin-controlled)

- Purpose: which cycle/contest the Election UI displays and accepts submissions against.
  One row per tenant.
- Columns: `tenant_id uuid pk/REFERENCES tenants`, `active_cycle_id uuid NULL REFERENCES
  election_cycles`, `active_contest_id uuid NULL REFERENCES election_contests`,
  `updated_by`, `updated_at`.
- Writeable by tenant admins only (RLS); readable by non-social members.
- **Decision recorded (brief §7):** this is *active-election-and-contest-combination* —
  both keys on one row — matching the legacy `ElectionSettings` shape exactly, but now a
  real table with FKs instead of a settings blob; the engine's operational config stays out
  of generic `tenant_settings`.
- Consistency rule: `active_contest_id` must belong to `active_cycle_id` (submit RPC asserts
  the contest's `election_cycle_id = active_cycle_id`).

### 3.10 Validity-helper design note

Because `scope_id` polymorphism (3.2) and jsonb party refs (3.5) cannot be expressed as
plain FKs, the design uses: (a) per-type CHECK constraints for shape, plus (b) two small
SECURITY DEFINER validation functions called inside the submit/correct/configure RPCs
(`assert_valid_contest_scope(tenant, type, scope_id)` and `assert_parties_exist(party_ids)`)
so validity is enforced at the only places rows are born. This keeps the schema simple and
makes the RPCs the integrity choke points — consistent with the 1A design philosophy
(provision_tenant already works this way).

---

## 4. Existing-Schema Reuse Map (Deliverable B)

| Foundation asset | Reused for |
|---|---|
| `tenants`, `tenant_modules` (+ `module_enabled('election')`) | module activation gate |
| `profiles` (`lga_id`,`ward_id`,`polling_unit_id` registered geography) | registered-PU authority; submitter/reviewer FKs |
| `positions`, `permissions`, `position_permissions`, `organizational_assignments`, `permission_grants` | Election authorization (grants + position defaults + deny-wins) |
| `has_permission()`, `scope_covers()`, `scope_chain()`, `my_scopes()`, `has_assignment_at()`, `is_admin()`, `is_election_officer()`, `has_membership()` | every Election RLS policy and RPC gate |
| `states`→`senatorial_zones`→`lgas`→`wards`→`polling_units` | result geography FKs; aggregation roll-ups |
| `media_assets` (+ `purpose='election_evidence'` convention) | EC8 evidence, PU-report and incident photos; R2 via Media Service |
| `system_audits` (+ SECURITY DEFINER audit trigger pattern) | configuration/authority audit; result workflow has its own history table |
| `notifications` (+ `type='election'`), `my_unread_count()`, `mark_notifications_read()` | Election event notifications |
| Supabase Auth + `custom_access_token_hook` + `backfill_profile_on_signup` | identity; JWT claims for RLS |
| `public` security-invoker views pattern (0009) | new Election views exposed through the hosted data API |
| Realtime publication (0009 pattern) | realtime plan §10 |
| `provision_tenant` (0011 semantics) | tenants provision with election module **disabled**; explicit activation |

---

## 5. Authorization & Scope (Deliverables C and D)

### 5.1 Permission vocabulary (existing `permissions` rows — reused, not extended)

`view_election_dashboard`, `upload_election_result`, `submit_election_pu_report`,
`submit_election_incident`, `manage_election_settings` — plus the two gaps flagged in §5.2
(`view_election_results`, `manage_election_config`). `view_election_results` is scoped
(state/zone/LGA/ward/PU); everything else is global within the tenant.

### 5.2 Permission-set gaps (design decision — carried to implementation)

The resolver's election-officer fixed set currently contains five permissions and **no
verification permission**; the rules' "Admin is NOT automatically an Election Officer"
separation-of-duties demands: officers verify; admins correct. The design therefore
introduces **two new permission rows** (added to the catalog, aligned with the rules, which
already name them):

- `verify_election_result` — granted to `election_officer` (fixed set gains it) and
  grantable to others; **admins do NOT get it implicitly** (they may still hold it via an
  explicit grant, but the default admin-bypass in `has_permission()` needs a documented
  exception — see open decision §11.2),
- `view_election_results` — the rules already authorize members by this scoped permission;
  seeding it completes the rules-faithful vocabulary.

### 5.3 Authorization matrix (Deliverable C)

Module gate `module_enabled('election')` AND tenant isolation apply to every cell. "Scope"
means `has_permission(perm, scope)` with `scope_covers()` inheritance (assignment at Ward
reaches its PUs; LGA reaches its wards+PUs; zone→LGAs→…; state→all; `campaign` scope covers
all). Registered-PU authority = campaign membership + profile registered at that exact
(ward, PU).

| Actor (permission reality) | View results | Submit result | Verify | Reject / clarify / reopen | Correct (admin) | Configure (cycles/contests/parties/candidates/active) |
|---|---|---|---|---|---|---|
| Platform / tenant admin (`has_permission` bypass) | tenant-wide | tenant-wide | **no** (separation of duties; requires explicit `verify_election_result` grant — §11.2) | no | **yes** | **yes** |
| Election Officer (`access_role='election_officer'`) | tenant-wide | tenant-wide | **yes** (`verify_election_result` added to fixed set) | **yes** | **no** | no (read-only config) |
| Campaign member, registered at (W,PU) | own registered PU row | own registered PU row | no | no | no | no |
| Campaign member with scoped `view_election_results` grant | within grant scope | — | no | no | no | no |
| Campaign member with scoped `upload_election_result` grant | within grant scope | within grant scope | no | no | no | no |
| Campaign member with position default incl. election permissions | within assignment scope | within assignment scope | no | no | no | no |
| Social-only member | **zero** | **zero** | **zero** | **zero** | **zero** | **zero** |
| Unauthenticated | zero | zero | zero | zero | zero | zero |

### 5.4 Scope model (Deliverable D)

Nothing new is built: `scope_covers(src_type, src_id, tgt_type, tgt_id)` already resolves
PU→ward→LGA→zone→state via `scope_chain`, and `my_scopes()` yields active, time-windowed
assignments. Result row visibility = `EXISTS (my_scopes s JOIN position_permissions pp ON
pp.position = s.position WHERE pp.permission='view_election_results' AND scope_covers(s,
result.geo))` OR explicit grant covering the row's geography OR registered-PU match OR
officer/admin. Ward→PU inheritance is native (Ward's scope_chain includes its PUs' chains).
The old exact-document `user_access` model is not reproduced; grants are validated *through*
the resolver, which already implements deny-wins.

---

## 6. Election state machine (Deliverable E)

Legacy statuses: `submitted|pending_review|approved|rejected|clarification_required|reopened`.
Legacy `verified` ⇔ `status='approved'`. Design: keep the legacy vocabulary verbatim
(rules-faithful, and the UI already speaks it), add a `corrected` marker via history action
rather than a new status.

- `submitted` → (officer) `approved` [verified=true] | `rejected` | `clarification_required`
- `clarification_required` → (member re-submits — same row upsert, new history) `submitted`/`pending_review`
- `approved` → (officer) `reopened` → (officer) `approved|rejected|clarification_required`
- `rejected` → (member re-submit) `submitted`
- **Admin correction (any status) → `pending_review`, `verified=false`, votes changeable,
  immutable identity/submitter, history `action='correct'`** — an Admin can never approve
  (no `verify_election_result` by default); independent officer re-verification is mandatory
  and the DB CHECK `verified = (status='approved')` holds at every instant.

Refinements over legacy: transition machine moves from client conventions into the two
workflow RPCs (the only UPDATE paths), so an illegal transition is a database error, not a
rule violation discovered post-hoc; history rows are a real table with typed actions.

---

## 7. RPC surface (workflow choke points)

SECURITY INVOKER RPCs in `politicore` (RLS applies to every statement inside):

1. `submit_election_result(contest, pu, votes jsonb, evidence uuid)` — asserts: election
   module on; contest OPEN + same tenant; caller authorized at the PU's geography (registered
   PU / scoped `upload_election_result` / officer / admin); evidence asset exists, belongs to
   caller's tenant and has `purpose='election_evidence'`; party ids valid; upserts the row
   (UNIQUE (tenant, contest, PU)) resetting to `submitted`/`verified=false`; appends history.
2. `review_election_result(result uuid, action text, notes text)` — officer-only
   (`verify_election_result`); asserts legal transition; sets `reviewed_by = auth.uid()`
   (attribution), `verified = (action='approve')`; appends history.
3. `correct_election_result(result uuid, votes jsonb, reason text)` — admin-only; identity/
   submitter immutable; forces `pending_review` + `verified=false`; appends history.
4. `set_active_election(cycle uuid, contest uuid)` — admin-only; asserts contest ∈ cycle.
5. `get_results_aggregate(cycle, contest, scope_type, scope_id)` — returns party totals,
   approved-PU count, total PUs in scope, reporting % — computed over rows visible under the
   caller's own RLS (SECURITY INVOKER, so scope applies automatically).

Plus a SQL view `election_results_current` (result row joined to contest metadata + party
labels resolved from ids) for list surfaces, exposed via a security-invoker `public` view
(0009 pattern) for the hosted data API.

Direct PostgREST writes are still RLS-gated, but the RPCs are the intended path; policy
design (§8) keeps direct writes maximally constrained so the RPCs' stronger guarantees
(transitions, attribution, upsert semantics) cannot be bypassed into a weaker state.

---

## 8. RLS plan (Deliverable G)

Every table: RLS ENABLE + FORCE, tenant-isolation SELECT policies, deny-by-default
(no policy ⇒ no access; `service_role` bypasses for trusted server code).

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `election_cycles`, `election_contests`, `election_candidates`, `election_settings` | tenant non-social members: `tenant_id = current_tenant AND NOT is_social_only()` | tenant admin | tenant admin | tenant admin (config) / `false` for settings |
| `political_parties` | all (world-readable, mirrors legacy) | platform admin | platform admin | platform admin |
| `election_results` | scoped (§5.4: admin/officer tenant-wide; registered PU; scoped `view_election_results` via `scope_covers`; social-only excluded) | none (submit only via RPC) | none (review/correct only via RPC) | **none — delete never** |
| `election_result_history` | participants (submitter + officer/admin of tenant) | none direct — RPC + trigger-guarded | none | none |
| `pu_reports`, `election_incidents` | admin/officer tenant-wide; registered (ward[,PU]); scoped `view_pu_reports`/`view_election_incidents` | own submission, geo-restricted (registered/scoped/`submit_*`) | admin (status workflow) | admin |
| `election_settings` | non-social members | admin | admin | false |

Is_social_only() helper: mirrors the rules (`social_member` ∈ membership_types AND NOT
campaign AND NOT admin AND NOT officer) — one new STABLE SQL function; needed because social
members share `current_tenant_id()` with everyone else and default-deny can't express
"except social-only" for legitimately-readable config tables.

Invariants carried into policy/RPC logic (from `firestore.rules`):

1. Tenant isolation on every row (`tenant_id` from identity, never client payload).
2. Election module activation gates all Election reads/writes.
3. Social-only members: zero Election access (all four enforcement layers).
4. Election Officer = election-domain authority only; no tenant administration.
5. Admin ≠ officer by default: verification vs correction separation of duties.
6. Results not admin-only: scoped visibility for members/grants.
7. Submission only against caller-tenant `OPEN` contests.
8. Result identity UNIQUE per (contest, PU); submitter = authenticated caller.
9. Evidence mandatory (`evidence_asset_id` NOT NULL, tenant-owned, EC8 purpose).
10. Officer review: immutable geo/contest/submitter/votes; `verified ⇔ approved`;
    `reviewed_by = auth.uid()`; allowed-fields allowlist (RPC does not touch others).
11. Admin correction: identity/submitter immutable; forces `pending_review` + `verified=false`.
12. `delete: false` on results and settings.
13. PU reports/incidents: own-submission, geo-restricted creation; status workflow admin-only.
14. Verification attributable + auditable (reviewed_by + append-only history).

---

## 9. Migration Map (Deliverable F)

| Legacy Firebase component | Current behavior | Supabase destination | Notes |
|---|---|---|---|
| `election_cycles` collection + seed fallback | client-side defaults when empty | `election_cycles` table + real seed migration | no client fallbacks |
| `election_contests` + seed fallback | client defaults; OPEN check in rules | `election_contests` + type/scope CHECKs; OPEN asserted in submit RPC | |
| `political_parties` (world-readable) | INEC seed client-side | `political_parties` (platform-level) + seed migration | party rows = acronyms |
| `election_candidates` | addDoc per contest | `election_candidates` (UNIQUE contest+party) | |
| `election_settings/{tenant}` + client fallback | active cycle+contest for UI | `election_settings` table + `set_active_election` RPC | consistency asserted |
| `election_results` docs `{contest}__{PU}` | upsert-per-PU with history[] array | `election_results` (UNIQUE tenant+contest+PU) + `election_result_history` table | votes = party-id refs (defect fix) |
| `submitElectionResultWithEvidence` | client validates + Cloudinary URL | `submit_election_result` RPC | upsert semantics preserved |
| `reviewElectionResult` | transition machine in rules | `review_election_result` RPC | attribution + history |
| `correctElectionResult` | forces pending_review | `correct_election_result` RPC | identical semantics |
| `history[]` in-document array | append-only by convention | `election_result_history` INSERT-only table | |
| `subscribeToElectionResults` (3 listeners) | realtime role-scoped | Supabase Realtime on `election_results` (+ view) | §10 |
| `subscribeToPUReports` / `Incidents` | realtime ops | Supabase Realtime on both tables | §10 |
| `subscribeToElectionSettings` | realtime settings doc | **dropped** — refetch on admin change (per Migration.md) | |
| Dashboard `useMemo` aggregation | client-side reduce over docs | `get_results_aggregate` RPC + view | server-side, RLS-scoped |
| `electionExport.ts` CSV | client-side join | view + same client export code (re-pointed) | |
| Cloudinary EC8 / PU / incident uploads | unsigned client uploads, 6 folders | Media Service → `media_assets` (purpose-tagged) | Cloudinary not a new dependency; legacy code untouched until cutover |
| `portal/election/*` pages | Firestore SDK calls | same routes, Supabase clients (Phase 2 slice) | additive `src/lib/supabase/election.ts` |
| Firestore rules (election surface) | rule files | RLS + RPCs + CHECKs (§8) | documented invariant-for-invariant |
| `submitElectionResult` legacy dead path (`firestore.ts`) | dead code | **not ported** | per Migration.md |

---

## 10. Realtime plan (Deliverable H)

Genuinely needed (election-day product value, per legacy usage + Migration.md §15):

1. `election_results` — live collation dashboard, officer review queue.
2. `pu_reports` — election-day ops.
3. `election_incidents` — election-day ops.

Dropped: election-settings listener (admin-managed single row — refetch suffices).

Mechanics: `ALTER PUBLICATION supabase_realtime ADD TABLE politicore.election_results,
politicore.pu_reports, politicore.election_incidents;` (guarded, 0009 pattern — hosted
only). RLS applies to Realtime (postgres_changes payloads honor RLS for the subscriber), so
scope-derived row filtering carries into realtime streams. Client subscribes scoped
(contest/ward/PU) exactly as the legacy listeners did — but row security is enforced
server-side regardless.

## 11. Media plan (Deliverable I)

1. Client requests upload → `getMediaService()` (provider-agnostic; R2 today) via a small
   additive server helper (no direct R2 SDK in Election code).
2. Upload with `purpose='election_evidence'` (EC8), `'pu_report_photo'`, `'incident_photo'`.
3. Registry row created in `media_assets` (tenant, bucket, key, visibility='private',
   checksum, uploaded_by).
4. `submit_election_result` requires `evidence_asset_id`; RPC asserts the asset belongs to
   the caller's tenant and carries the election purpose — evidence cannot be borrowed across
   tenants or purposes.
5. Access via `svc.accessUrl()` (signed URL); no public evidence.
6. Legacy Cloudinary code paths remain untouched until the app cutover phase (no dual-write;
   the legacy app is the behavioral reference only).

## 12. Audit & notifications (Deliverable-adjacent)

- **Audit**: result workflow → `election_result_history` (structured, typed actions).
  Configuration and authority changes → existing `system_audits` via the 0002 audit-trigger
  pattern (`trg_audit_election_config` on cycles/contests/parties/candidates/settings
  writes). No parallel audit system.
- **Notifications** (documented minimum, `type='election'`):
  - result submitted → tenant election officers + admins (review queue prompt);
  - result approved / rejected → submitter;
  - admin correction applied → submitter + officers (re-verification required);
  - incident reported → officers + admins (severity ≥ high also tenant admins).
  Insert path: SECURITY DEFINER helper (officers/admins are the target users; RLS insert
  policy on notifications is admin-only, so the helper runs as definer) — matches the
  0008 RPC precedent.

---

## 13. Test plan (Deliverable J)

Local (pglite, `tests/security/phase1c-election.test.ts`, fresh DB per file, roles +
`auth.uid()` GUC exactly like Phase 1A/1B suites):

1. Tenant isolation — tenant B sees zero election rows of tenant A (every table, direct
   PostgREST-path queries as `authenticated`).
2. Module-disabled behavior — tenant with `election=false`: RPCs raise; RLS returns zero rows
   even with valid permissions.
3. Social-only denial — social member: zero rows on every election table; RPC permission
   checks fail (tests 4 layers: direct SELECT, RPC, view, realtime-filter equivalence note).
4. Campaign member, registered PU — can submit own-PU result for OPEN contest (with
   evidence); cannot submit neighbor PU; ward assignment ≠ PU authority (registered location
   ≠ organizational authority).
5. Scoped grants — ward-level `upload_election_result` grant covers ward PUs, not the next
   ward; LGA-level `view_election_results` covers all ward PUs beneath; explicit deny wins.
6. Officer authority — officer verifies/rejects/clarifies/reopens; officer cannot correct
   votes; officer cannot touch cycles/contests/parties (no config authority).
7. Admin separation — admin corrects votes → status `pending_review`, `verified=false`
   (DB CHECK regression); admin cannot review-approve without explicit
   `verify_election_result` grant; with explicit grant, admin may verify (documented).
8. Independent verification — after correction, officer (not correcting admin) re-approves;
   `verified=true` only via officer action; history shows correct → review_approve chain.
9. Evidence integrity — submission without asset id rejected; cross-tenant asset rejected;
   wrong-purpose asset rejected.
10. Geography inheritance — result visibility for zone-level viewer covers all LGAs/wards/
    PUs beneath (state→all; campaign scope covers all).
11. Aggregation scope — `get_results_aggregate` reflects only caller-visible rows; totals
    match hand-computed fixtures.
12. Result visibility — non-admin member sees only own-PU/scoped rows; admin/officer see all.
13. Evidence access — evidence readable by result-scoped viewers via registry (signed-URL
    path unit-faked; R2 E2E already covered by Phase 1B suite).
14. Transition machine — every illegal transition attempted via RPC errors (matrix test).
15. Attribution — `reviewed_by` set to authenticated officer; history rows carry actor ids.

Hosted acceptance (`scripts/db/verify-hosted-election.ts`, purge-verify pattern):

- apply migrations 0014+ to hosted; catalog asserts (tables, policies, publication);
- end-to-end REST/RPC flow: provision → enable election → seed cycle/contests → member
  submits with real R2 evidence asset → officer verifies → admin corrects → officer
  re-verifies; cross-tenant denial; social-only denial; aggregate RPC output; geography
  totals still 1/3/17/260/4,145.

---

## 14. Migration sequencing (proposed, for the implementation phase)

1. `0014_election_schema.sql` — enums, 10 tables, constraints, indexes, RLS + policies,
   `is_social_only()`, new permission rows + officer-set alignment.
2. `0015_election_workflow.sql` — 5 RPCs + validation helpers + history trigger guard.
3. `0016_election_seed.sql` — political parties (INEC set), optional 2027 cycle/contests
   seed per-tenant on activation (admin-driven, not automatic).
4. `0017_election_views_realtime.sql` — aggregate/current views, publication add (guarded).
5. App slice (separate phase per HARD STOP): `src/lib/supabase/election.ts` + page
   re-points.

Risks: jsonb votes validation is RPC-enforced (not FK) — mitigated by choke-point RPCs;
`is_social_only()` adds one predicate to config-table policies (perf negligible at this
scale); aggregate RPC per-call computation is O(visible rows) — fine at 4,145 PUs; revisit
with a materialized rollup only if profiling demands it.

---

## Phase 1C Status

**COMPLETE** (design gate; hard stop respected).

- **What was inspected**: all 14 migrations; live hosted catalog (19 tables / 28 functions /
  10 views / realtime publication / 4,145 PUs); full legacy election service (836 lines),
  types, 7 pages, 3 listeners, export lib, upload page (Cloudinary path), portal nav gates;
  the complete Election surface of `firestore.rules`; Migration.md and both phase reports.
- **What was changed**: **nothing.** Zero code, schema, or doc modifications. This document
  is the only artifact. (Todo list and read-only catalog queries only.)
- **What was NOT changed**: all migrations, hosted database, Firebase app, Firestore rules,
  foundation tables/functions/policies, geography data, media service, tests.

## Existing Supabase Foundation Reused

`tenants` · `tenant_modules` · `tenant_settings` · `profiles` (registered geography columns)
· `positions` / `permissions` / `position_permissions` / `organizational_assignments` /
`permission_grants` · `states`/`senatorial_zones`/`lgas`/`wards`/`polling_units` ·
`media_assets` · `system_audits` · `notifications` · functions: `has_permission`,
`scope_covers`, `scope_chain`, `my_scopes`, `has_assignment_at`, `is_admin`,
`is_election_officer`, `has_membership`, `module_enabled`, `current_tenant_id`,
`current_profile`, `my_unread_count`, `mark_notifications_read`, `provision_tenant`,
`custom_access_token_hook`, `backfill_profile_on_signup` · RPC wrappers (0005) ·
security-invoker `public` views (0009) · realtime publication pattern (0009).

## Proposed Election Schema

`election_cycles` · `election_contests` · `political_parties` (platform-level) ·
`election_candidates` · `election_results` · `election_result_history` · `pu_reports` ·
`election_incidents` · `election_settings` — plus `is_social_only()` helper, 2 permission
rows (`verify_election_result`, `view_election_results`), 5 workflow/aggregate RPCs, 1–2
SQL views, realtime publication additions. (10 tables — each one maps to a distinct legacy
collection or a normalization defect; nothing speculative.)

## Authorization & Scope

Module activation (`tenant_modules`) gates the domain; `has_permission()` +
`scope_covers()`/`my_scopes()` govern every operation with hierarchical inheritance
(state ⊃ zone ⊃ LGA ⊃ ward ⊃ PU; campaign scope covers all); registered-PU authority for
campaign members; officers verify, admins correct (separation of duties via
`verify_election_result`); social-only members have zero access at all four layers;
explicit deny wins. Full matrix in §5.3.

## Security Invariants Preserved

All 14 listed in §8.1, invariant-for-invariant from `firestore.rules`: tenant isolation,
module gating, social-only zero-access, officer≠admin separation of duties, scoped result
visibility, OPEN-contest submission, deterministic result identity (now a UNIQUE
constraint), evidence mandatory, officer-review immutability + attribution,
admin-correction forced re-verification, no-delete on results/settings, geo-restricted
ops-reporting, server-side audit/history.

## Migration Map

§9 — full table, collection→table, service→RPC, listener→realtime, aggregation→RPC/view,
Cloudinary→Media Service, rules→RLS/RPC/CHECK. Legacy dead path (`submitElectionResult` in
firestore.ts) explicitly not ported.

## Risks / Open Decisions

1. **Admin-verify exception (§5.2/§11.2)** — `has_permission()` bypasses grants for admins;
   the rules' "admin cannot approve own correction" needs either (a) documented exception:
   admins hold implicit `verify_election_result` but the review RPC refuses self-review of
   admin-corrected rows (rules-faithful; recommended), or (b) resolver change to make
   `verify_election_result` opt-in for admins. **Decision needed before implementation.**
2. **Result row upsert vs immutable submissions** (§3.5.1) — legacy-compatible upsert
   proposed; immutable-revision model is the alternative if the product wants per-attempt
   submissions. Default: upsert.
3. **Contest geography CHECK depth** (§3.2.1) — shape-level CHECKs + RPC-time validation
   proposed; full per-type FK machinery rejected as over-engineering for now.
4. **R2 public delivery** still needs `R2_PUBLIC_BASE_URL` for public assets (carried from
   Phase 1B; election evidence is private/signed, so not blocking).

## Recommended Next Step

If approved: **Phase 1C-Implementation** — apply `0014`–`0017` in order (schema → workflow
RPCs → seeds → views/realtime), then the local Phase 1C security suite (§13) and the hosted
acceptance script, per the sequencing in §14, stopping before any Election UI migration
(that is the phase after).
