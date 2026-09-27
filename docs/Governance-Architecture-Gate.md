# PolitiCore — Governance & Citizen Engagement Architecture Gate

**Status:** GO — Phase 6 (architecture + domain gate, first vertical slice)
**Schema:** `supabase/migrations/0034_governance_architecture_gate.sql`
**Security suite:** `tests/security/governance-architecture.test.ts` (14/14)
**Preceding state:** Core Identity · Notifications · Member Directory · Public/Content · Final Firebase Boundary — COMPLETE. Social Force, Campaign, Election, Notifications, Events/Announcements — LOCKED and untouched.
**Platform:** Supabase Auth + PostgreSQL + RLS. **Firebase: FULLY RETIRED** (Governance never touches it — §30).

---

## A. Governance purpose

PolitiCore was a campaign tool. It is now a **modular platform** whose first-class
domains — Social Force, Campaign, Election, and **Governance & Citizen Engagement**
— are independently activatable per tenant.

Governance answers a question none of the existing modules answer:

> **"How does the tenant engage with and respond to the people it serves —
> before, during, and after elections?"**

It extends PolitiCore beyond campaign/election windows: an elected official,
political organization, NGO, civic organization, or company tenant maintains
structured engagement with citizens, constituents, customers, or stakeholders.
The relationship is generic (§29); tenant-type wording (`display_label`) varies
without forking the module.

---

## B. Module boundary

### Governance owns

* Participants / constituent relationships (the tenant↔person engagement record)
* Requests & cases (intake, classification, assignment, progress, resolution, feedback)
* Request categories (tenant taxonomy)
* — later phases: Projects, Consultations, Surveys/Polls, Petitions, Engagement sessions (§N)

### Governance does NOT own (§5 — reuses, never duplicates)

| Concern | Owner |
| --- | --- |
| Identity, authentication, profiles | Supabase Auth + Core profiles |
| Tenancy & module activation | Core tenancy (`tenant_modules`, `module_enabled()`) |
| Authorization primitives | `has_permission()` / `scope_covers()` / permission grants |
| Geography | Core geography (states → zones → LGAs → wards → PUs) |
| Notifications | Core Notifications (LOCKED) |
| Audit | Canonical `system_audits` + 0002 trigger |
| Media | Provider-agnostic Media Service |
| Social Tasks/points/leaderboard | Social Force (LOCKED) |
| Activities & member assignment | Campaign (LOCKED) |
| Election results & reporting | Election (LOCKED) |
| Events / News / Announcements | Content domains (LOCKED, separate) |

**Governance vs Campaign (§6).** Campaign: *"How does the campaign organize its
people?"* Governance: *"How does the tenant serve its people?"* A rally is a
Campaign Activity; a town hall with constituents is a Governance engagement
(future phase). Volunteer assignment is Campaign; a citizen's service request is
Governance. No shared tables, services, or UI.

**Governance vs Election (§7).** No Governance table references an election;
`Governance=ON, Election=OFF` (and the inverse) is fully valid. Verified by the
schema: zero election foreign keys.

---

## C. Core entities — minimum first-slice model (§26)

Five tables — nothing speculative:

```
governance_participants   the tenant↔person engagement record
governance_request_categories   tenant-defined taxonomy
governance_requests       the request/case aggregate (+ feedback columns)
governance_request_events append-only lifecycle/response trail
governance_assignments    staff responsibility per case
```

Status ladder (only the states the workflow needs, enforced by trigger):

```
submitted → acknowledged → assigned → in_progress → awaiting_information → resolved → closed
                 ↘ rejected                          (resolved → in_progress/awaiting = reopen; any non-terminal → closed)
```

The event stream replaces six would-be tables (`case_audit_logs`, response
tables, etc.): one append-only trail covers acknowledgement, assignment, status
changes, staff/participant responses, resolution, closure, and feedback.

---

## D. Identity / participant model (§10/§11)

* **Staff are portal members** — `profiles` + access roles + permission grants.
  No new auth system, no duplicated profiles.
* **Participants are a domain record**, deliberately distinct from identity:
  * an **authenticated member** becomes a participant via `submit_governance_request`,
    which upserts the participant row linked 1:1 to `profiles.id` (UNIQUE constraint);
  * an **external person** (no portal account) is representable as a contact-based
    participant row (`email`/`phone` required when no `profile_id`) for future
    public-intake phases — WITHOUT any portal identity or access role;
  * `display_label` (`Citizen`, `Constituent`, `Customer`…) carries tenant-type
    wording. No `citizen_admin`/`constituent_coordinator` roles exist or will exist.
* Anonymous public submission is **not enabled in this gate** — the public
  intake surface is a separately gated product decision (documented, deliberate).

---

## E. Authorization (§12)

Four domain permissions seeded into the canonical `permissions` table
(positions are NOT access roles; grants flow through the existing matrix):

| Permission | Purpose |
| --- | --- |
| `view_governance` | Navigation/surface visibility within scope |
| `view_cases` | Read the case queue within scope |
| `manage_cases` | Acknowledge, progress, respond, resolve, close |
| `assign_cases` | Assign cases to same-tenant staff |

Submission is deliberately **not** a permission: any authenticated member of a
governance-enabled tenant may submit (ownership, not privilege). Tenant admins
hold authority by role. RPCs re-verify `module_enabled('governance')` and the
caller's permission server-side on every action — fail closed.

---

## F. Geography (§13)

Optional at every level: `ward_id`, `lga_id`, `polling_unit_id` on requests,
and `scope_type`/`scope_id` on assignments — all nullable FKs into the existing
Core geography. A statewide consultation has no ward; a ward infrastructure
request has one; a hyper-local issue may carry a PU. `scope_covers()` remains
the descendant-coverage engine; nothing is materialized; no Governance geography.

---

## G. Privacy model (§14)

| Tier | Sees |
| --- | --- |
| Anonymous | **Nothing.** No reads, no writes (suite tests 1, 11). |
| Participant-owner | Own requests; **public events + own events only** — internal staff responses never leak (test 7). |
| Staff (`view_cases`/`manage_cases`) | Tenant queue; full event trail of visible cases. |
| Tenant admin | Everything in tenant. |

Public accountability publishing (`is_public` rows to the world) is **default
closed** — a future gated phase. The `public.*` views carry **no anon grants**.

---

## H. RLS strategy (§15) — all tables FORCEd

| Table | SELECT | INSERT/UPDATE |
| --- | --- | --- |
| `governance_participants` | admin, `view_cases`, or own linked row | admin; member may insert **own** profile-linked row only |
| `governance_request_categories` | admin/staff; members read `is_active` rows | admin only |
| `governance_requests` | admin, `view_cases` **or `manage_cases`**, or owner | staff insert (RPC-owned); update = admin/`manage_cases` |
| `governance_request_events` | admin/staff full; owner = public + own-authored | **no policy — RPC-only via definer paths** |
| `governance_assignments` | admin, `view_cases`/`manage_cases`, or assignee | admin/`assign_cases` only |

Two hard-won details, both pinned by tests:

* **Implicit-read rule:** Postgres requires an UPDATE row to also pass the
  SELECT policy. A `manage_cases`-only holder therefore appears in the read
  policies — otherwise their writes *silently no-op* (suite test 6 asserts the
  error AND the state).
* **Append-only:** events have no UPDATE/DELETE policy and a `BEFORE UPDATE OR
  DELETE` trigger raises — tamper-evident (test 8).

Server-side primitives only: `current_tenant_id()`, `auth.uid()`,
`has_permission()`, `is_tenant_admin()`, `module_enabled()`. No client-supplied
tenant/actor anywhere. No DELETE policy exists on requests — case records are
never deleted by application roles.

---

## I. Audit (§16)

All accountability-significant mutations (request create, assignment, category
changes; the events trail is itself the operational audit of the workflow) flow
into the **canonical `system_audits`** stream via the 0002
`audit_authority_change` trigger, with server-side actor attribution
(test 10: `governance_requests:insert`, `actor_id` = submitter). No
`governance_audit_logs` / `case_audit_logs` parallel stream exists.

---

## J. Notifications (§17)

Not wired in this gate. The boundary is fixed: a future "request assigned /
resolved → notify participant" integration **calls Core Notifications**; no
Governance notification table or second notification system will exist.

---

## K. UI boundary (§19)

Implemented now: **none** (this is an architecture gate — schema + authority
RPCs only; §35 forbids building ahead of the gate).

Defined for subsequent gated phases:

* **Public:** future accountability publishing (projects, consultations,
  engagements) — separately gated; not enabled by this schema.
* **Participant portal:** my requests, status tracking, additional info,
  feedback (RPCs already support the loop).
* **Administrative:** Governance dashboard, request queue, case management,
  category management — all under `module_enabled('governance')` + permissions.
* Navigation (§28): must render only when `module_enabled('governance')` and
  the user holds `view_governance`; never tied to Campaign or Election state.

---

## L. Module activation (§8)

Zero new machinery: `module_code_enum` already contains `'governance'` (0001);
`tenant_modules` materializes all four modules with **governance disabled by
default** (0011 provisioning); every RPC re-checks `module_enabled('governance')`
(fail closed). Suite test 1 proves `Governance=OFF` blocks submission while
`Election`/`Campaign` state is irrelevant — true independent activation.

---

## M. First vertical slice — confirmed scope (§23/§24)

```
Citizen → Request → Acknowledgement → Assignment → Progress → Resolution → Feedback
```

* **Ready now (schema + RPCs + tests):** member submission, participant
  provisioning, acknowledgement, assignment (with scope), status progress,
  staff/participant responses with visibility control, resolution, closure,
  one-shot feedback, reference codes, full audit.
* **Next implementation phase (UI):** submit surface, participant
  "my requests", staff queue + case view, admin category management, plus
  optional Core-Notifications wiring — each an ordinary gated phase.
* **Explicitly out:** everything in §25/N.

---

## N. Deferred features (§25)

Projects, project updates, consultations, surveys/polls, petitions, engagement
sessions/town halls, accountability dashboards/analytics, public budgeting,
legislative tracking, constituent voting, mass messaging, AI classification.
Each requires its own gated phase extending this model — none may silently
reuse Content domains (Events/News/Announcements remain separate; §21/§22).

---

## O. Testing strategy

* **Security suite (this gate):** `tests/security/governance-architecture.test.ts`
  — 14 tests on real migrations: module gate, participant provisioning +
  reference codes, ownership vs queue visibility, cross-tenant assignee
  rejection, full lifecycle via RPCs, ladder-guard rejection + RLS no-op
  semantics, events privacy (internal-vs-public), append-only trail, feedback
  contract (owner-only/resolved-only/once), canonical audit attribution,
  anonymous fail-closed, cross-tenant isolation, category governance,
  participant identity model.
* **Regression:** full suite must remain ≥ 630 (see gate verification below).
* **Future phases:** each Governance feature phase adds hosted-acceptance
  journeys over the real PostgREST/GoTrue surface, mirroring prior phases.

---

## Gate verification (Phase 6 exit criteria)

| Gate | Result |
| --- | --- |
| Local migrations 0001–0035 apply clean | ✓ (PGlite, fresh DB) |
| Governance security suite | **14/14** |
| Full regression | **644/644 across 24 suites** (630 + 14, exact) |
| TypeScript | 0 errors |
| Build | PASS |
| Touched-file lint | 0 errors |
| Hosted apply | migrations 0034 + 0035 live; hosted state verified against migration contract |
| Hosted acceptance | **16/16** (`verify-hosted-smoke-governance.ts`) |
| Hosted pristine state | 0 fixture residue (incl. run-1 cleanup by `session_replication_role`) |
| Locked modules | Social Force · Campaign · Election · Notifications · Events · Announcements — untouched |
| Firebase | FULLY RETIRED — no Governance/Firebase surface |

### Discovery recorded during this gate: hosted grant-surface drift

The hosted project carries `ALTER DEFAULT PRIVILEGES` that auto-grant ALL to
`anon` (and UPDATE/DELETE to `authenticated`) on every new `public` relation.
Phase 4/5 migrations declared exact grant sets; hosted had drifted (e.g. 7 anon
privilege rows on `public.donations`). RLS remained the effective boundary, but
the grant surface was off contract and 0033's own signature clause caught it.
Resolution: **migration 0035** (`public_surface_grant_hygiene.sql`) normalizes
the 0033/0027-governed surfaces via revoke-then-grant, and 0034 self-heals its
own surface at creation (PUBLIC-explicit revokes + owner-grant normalization).
Post-repair hosted state: donations/anon = 0 rows, events/anon = exactly 1
(SELECT), governance events UPDATE/DELETE = 0 rows for every grantee. Legacy
election/core view grants were deliberately NOT touched (LOCKED modules, §3.1).

---

## Final architecture statement (§34)

```
                    POLITICORE
                        │
   ┌──────────────┬─────┴────────┬──────────────┐
   │              │              │              │
Social Force    Campaign      Election      GOVERNANCE  ← peer, not extension
                                              │
                                    Requests/Cases (first slice)
                                              │
                            Projects · Engagement · Consultations …  (future gated phases)
```

Governance is a first-class peer module: independently activatable, separately
secured, domain-owned, audit-integrated, and Firebase-free by construction.
