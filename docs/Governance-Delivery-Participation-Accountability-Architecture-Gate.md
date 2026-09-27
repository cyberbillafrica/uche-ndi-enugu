# PolitiCore — Governance Delivery, Participation & Accountability Architecture Gate (Phase 11)

**Status:** PASS — architecture gate for the Governance module's expansion into delivery, participation, and accountability
**Type:** Architecture-only phase. No production implementation.
**Preceding:** Governance Phases 6–10 (substrate, vertical slice, notifications, public-intake gate, public-intake slice) — COMPLETE
**Locked modules:** Social Force, Campaign, Election, Core Identity/Auth, Core Geography, Core Notifications, Core Audit, Core Media, Events, News, Announcements, Firebase retirement — untouched
**Verification suite:** `tests/security/governance-phase11-architecture.test.ts`

---

## 1. Executive architectural decision

Governance evolves from a request/case system into the **tenant's delivery-and-participation ledger**: one module with four capability clusters sharing one substrate (tenant, participant, geography, updates, events, notifications, audit, media).

```text
GOVERNANCE (one module, independently activatable)
│
├── DELIVERY        Requests (exists) · Projects · Commitments
├── PARTICIPATION   Consultations · Surveys · Polls · Petitions/Proposals
├── ENGAGEMENT      Town halls · constituency/community/stakeholder meetings
└── ACCOUNTABILITY  Visibility lifecycle · public projections · outcomes
```

**DECISION:** Governance is a general organizational engagement/delivery capability that political offices are a special case of — not the reverse.
**RATIONALE:** PolitiCore is multi-tenant SaaS from day one (§18). Naming every entity for constituency politics ("constituency project officer") would corrupt the model for NGO/CSR/community tenants; naming entities generically ("project", "request", "consultation") loses nothing for political tenants because geography and terminology carry the political meaning.
**ALTERNATIVES CONSIDERED:** A separate "Community" module for non-political tenants.
**REJECTED:** Duplicates the substrate for no security or product gain; one activation flag stays simpler and all concepts (project, petition, engagement) are genuinely shared.
**IMPLICATION:** Product vocabulary in UI is tenant-presentational; the data model stays generic. No `constituency_*`, `customer_*`, or `citizen_*` columns exist anywhere.

---

## 2. Governance domain map

| Cluster | Concepts | Canonical entities (future) | Reuses |
|---|---|---|---|
| Delivery | Requests, Projects, Commitments | `governance_requests` (exists), `governance_projects`, `governance_commitments` | Core Geography, media relation, updates |
| Participation | Consultations, Surveys, Polls, Petitions, Proposals | `governance_consultations` (+responses), `governance_polls` (+votes), `governance_petitions` (+supports) | Phase 9/10 external-participant + contact-verification model |
| Engagement | Meetings, town halls, visits | `governance_engagements` | Events (optional link), updates |
| Accountability | Publication, outcomes, statistics | visibility lifecycle on the above + public RPC projections | Core Audit, Core Notifications |

Shared substrate (no duplication): `governance_participants`, the update model (§9), the geography-scope pattern (§12), `governance_request_events` for requests only, Core Notifications/Audit/Media.

**Explicitly NOT entities** (§26): `governance_organizations` (implementing agency = text field), `governance_beneficiaries` as persons (aggregate counts only), `governance_outcomes` as a standalone table (outcome = a terminal update + status on Project/Commitment), `governance_workflow_*` (the request state machine is enough; other objects use simple status enums), per-object notification/audit/media/update tables.

---

## 3. Projects architecture

**DECISION:** `governance_projects` is the canonical delivery entity. Related records: `governance_project_milestones` (child), evidence (media relations), updates (§9), geography scopes (§12), optional request links (§11).

Canonical columns (minimum, deferred to its implementation gate):

```text
tenant_id, reference/slug, title, description,
type/category (tenant-defined label, text — no taxonomy table in v1),
owner_profile_id (accountable staff), implementing_org (text),
status enum: planned | active | suspended | completed | cancelled,
planned_start/ended dates, actual_start/ended dates,
planned_budget numeric NULL, currency text, funding_source text,
progress_percent smallint (0–100, manual or milestone-derived),
beneficiary_summary text (aggregate description), beneficiaries_estimated int NULL,
is_public boolean (default false), published_at timestamptz NULL
```

**Project-type/category:** a tenant-defined text label in v1. A categories table (like `governance_request_categories`) may be added later **only if** tenants demonstrate the need to gate/list by type. Not assumed now.

**What Projects require vs. carry as related records:**

| Concern | Verdict |
|---|---|
| Geographic accountability | **Yes** — multi-scope child rows (§12); a project without geography is tenant-wide |
| Financial information | **Fields only** (planned budget, currency, funding source as text). No ledgers, no expenditure tracking, no disbursements — deferred, likely forever out of Governance's core |
| Status | Yes — the five-value enum above; completion/cancellation are status transitions recorded as updates |
| Progress percentage | Yes, but **derived-first**: computed from milestones when milestones exist, manual otherwise |
| Milestones | Yes — `governance_project_milestones` (title, due date, done date, status, sort) — they are what make progress auditable |
| Evidence/media | Via Core Media relations (`media_assets` linked to the project/milestone/update). No Governance storage |
| Beneficiary relationships | **Aggregate only.** No person-level beneficiary tracking (privacy + PII surface with no accountability payoff). Count + free-text summary |
| Citizen feedback | Via requests linked to the project and public updates — not a separate project-feedback table |

**DECISION:** Projects exist without commitments and commitments exist without projects (§11/§6) — no mandatory link either way.
**IMPLICATION:** An NGO CSR project and a constituency infrastructure project use the identical entity; visibility defaults to Private until deliberately published (§10).

---

## 4. Commitments architecture

**DECISION:** `governance_commitments` is a structured, standalone deliverable record — deliberately NOT a mirror of the Manifesto module.

The existing Manifesto (`politicore.manifestos`, 0033) is a **single published content document** per tenant (jsonb sections, PDF). It is presentation, not structured state. Governance must not duplicate it as content; it must give commitments structure the Manifesto cannot have.

```text
governance_commitments (conceptual minimum)
tenant_id, title, details,
category (text label),
source_type: manifesto | engagement | consultation | petition | request | independent,
source_ref text NULL (human-readable anchor, e.g. "Manifesto §Water, item 3"),
owner_profile_id, geography scopes (§12),
status enum: declared | in_progress | delivered | partially_delivered | dropped,
target_description text, target_date date NULL,
progress_percent, is_public, published_at
```

**DECISIONS:**

1. **No FK to `manifestos`.** The Manifesto is tenant-primary-keyed jsonb content with no item identity — a hard FK is impossible without redesigning a locked module, and unnecessary. `source_type='manifesto'` + `source_ref` preserves the lineage displayably. A future Manifesto rework could add item IDs; that is a separate, optional gate.
2. **A commitment may exist independently** of any Manifesto item (`source_type='independent'`) — commitments made in town halls, on petitions, or in office predate/exceed any written manifesto.
3. **One commitment ↔ many projects.** Delivery of one commitment may be split across projects; linkage is an optional join (`governance_commitment_projects`). **No hard coupling** — a commitment can be delivered and evidenced without any project record.
4. **Progress/evidence/outcome:** progress percent + updates (§9); outcome = the terminal update + `status` transition. Evidence via media relations.
5. **Public visibility** is opt-in per commitment (§10) — declarations are political; publication is accountability and is a deliberate, audited act.

**ALTERNATIVES REJECTED:** Extending `manifestos.sections` jsonb with progress fields (mutates a locked content module and perverts a document into a tracker); a `manifesto_items` table inside Governance (creates a second manifesto model); mandatory project linkage (blocks legitimate soft commitments).

---

## 5. Participation architecture (the five instruments)

**DECISION:** Five products, **three canonical instruments** — the distinctions the product needs are preserved by discriminators and response models, not by five parallel tables:

| Product | Canonical entity | Discriminator | Why it shares |
|---|---|---|---|
| Consultation | `governance_consultations` | `kind='consultation'` | Structured input → responses; identical lifecycle |
| Survey | `governance_consultations` | `kind='survey'` | Structured questions → responses; identical mechanics, lighter moderation posture |
| Poll | `governance_polls` | — (own table) | One question, one vote, high volume, dedup-by-participant — a different response model entirely |
| Petition | `governance_petitions` | `origin='petition'` | Supporter accumulation + verification + closure thresholds |
| Community proposal | `governance_petitions` | `origin='proposal'` | A citizen-originated petition: same accumulation mechanics, different intake (author is the proposer) |

**Who creates:** staff with `manage_participation` creates consultations/surveys/polls; petitions/proposals may be **staff-created or participant-originated** (participant-originated enters a `pending`→`open` moderation state).
**Who participates:** portal members (authenticated, participant identity); external participants via the **Phase 9/10 contact-verification seam** (verified contact = participation credential for consultations/surveys/petitions); polls may additionally admit anonymous votes with server-side dedup — **OPEN DECISION** (see §29) because the dedup mechanism must not create a fingerprinting surface.
**Geographic targeting:** the geography-scope pattern (§12) — a ward consultation, an LGA petition.
**Lifecycle:** `draft → open → closed → results_published` (consultations/surveys); `draft → open → closed → verified → results_published` (petitions — signature verification before results); polls: `draft → open → closed`.
**Moderation:** participant-originated petitions/proposals require staff approval to open; responses are private until staff publish aggregates; abusive content is handled by closing + audit, not by a parallel moderation system.
**Closing rules:** manual close by staff; optional `closes_at` timestamp honored server-side.
**Result publication:** aggregates only (counts, distributions) — never individual responses; publication is an explicit audited action (`publish_accountability` permission).
**Audit:** creation, publication, closure, verification, result publication (§16).
**Relationship to Requests:** optional — a consultation may produce commitments; a petition may open a request (§11). Never mandatory.

---

## 6. Consultations architecture

Covered by §5 (instrument `governance_consultations kind='consultation'`). Distinct posture: deliberative input (open text + structured questions), longer windows, per-participant one response (`UNIQUE (consultation_id, participant_id)`), responses visible only to staff until published as thematic aggregates. Submissions notify staff via Core Notification **intents** (§14). No public comment feed in v1 (deferral noted in §29).

## 7. Surveys architecture

Same entity, `kind='survey'`: fully structured questions (jsonb question set: single-choice, multi-choice, Likert, short text), one response per participant, results are quantitative aggregates. Anonymous-but-verified participation allowed for external participants (contact verification, one response per verified contact — reusing the Phase 9/10 staging/verification pattern conceptually, **not** its tables).

## 8. Polls architecture

`governance_polls` + `governance_poll_votes`: single question, fixed options, one vote per participant (`UNIQUE (poll_id, participant_id)`), instant aggregate. Lightweight by design: no documents, no thresholds, no verification workflow. **Anonymous voting is an OPEN DECISION** — if admitted, dedup must be server-side and privacy-preserving; the architecture requires that the mechanism be decided and threat-modeled (ballot stuffing vs. fingerprinting) before implementation.

## 9. Petitions architecture

`governance_petitions` (+`governance_petition_supports`): title, demand text, `origin` (`petition`|`proposal`), proposer (participant), target/signature threshold (int, optional), status lifecycle with **signature verification** before results publish (verification sampling/volume rules are an implementation-gate detail). Supporters sign with participant identity; external supporters use verified contact. One signature per participant per petition. A petition **may** spawn a request (staff action, optional link). Support counts are the one petition datum that may become public pre-closure (opt-in).

## 10. Engagement architecture (town halls & meetings)

**DECISION:** `governance_engagements` is a first-class **process** record; the Events module remains **content**.

| | `politicore.events` (locked) | `governance_engagements` (future) |
|---|---|---|
| Purpose | Public website content: date/venue/ward blurb | Institutional process record |
| Owns | Announcement of occurrence | Agenda, stakeholders, attendance, issues raised, responses, follow-ups, outcomes |
| Created by | Content admins | Governance staff (`manage_participation`) |

Linkage is **optional** (`engagement.event_id NULL REFERENCES events`): an engagement with an event gets a public calendar presence; an internal stakeholder meeting needs none. Issues raised map to optional request links; commitments generated are recorded with `source_type='engagement'`; follow-ups are updates. Attendance is a count/roster of participants (no public PII). Geographic accountability via the scope pattern (a constituency engagement = zone/LGA-scoped engagement).

**REJECTED:** Extending `events` with governance columns (mutates a locked module; every engagement would become public website content); duplicating events inside Governance (two calendars, drift).

## 11. Governance updates architecture (one model)

**DECISION:** One canonical `governance_updates` table serving all attachable subjects:

```text
governance_updates (
  id, tenant_id,
  project_id NULL REFERENCES governance_projects,
  commitment_id NULL REFERENCES governance_commitments,
  request_id NULL REFERENCES governance_requests,
  consultation_id NULL REFERENCES governance_consultations,
  petition_id NULL REFERENCES governance_petitions,
  engagement_id NULL REFERENCES governance_engagements,
  author_profile_id NULL,            -- staff-authored; external updates are events/feedback instead
  body text NOT NULL,
  kind text NOT NULL,                -- progress | milestone | outcome | announcement
  is_public boolean NOT NULL DEFAULT false,
  published_at timestamptz NULL,
  created_at timestamptz DEFAULT now(),
  CHECK (exactly one subject FK is not null)
)
```

**RATIONALE:** Six per-entity update tables would duplicate the visibility/publication/RPC/audit logic six times; a fully polymorphic string-reference table would forfeit FK integrity. Typed nullable FKs + a single-subject CHECK is the balance: one body of logic, real integrity, per-subject queries remain indexable.
**REJECTED:** Per-entity tables; a universal "content" table absorbing updates, events, and responses alike (obscures genuinely different lifecycles — §26 warns against this); forcing request progress events out of `governance_request_events` into `governance_updates` (the request event stream is append-only, insert-time-visibility, and locked by Phases 6–10 semantics — requests keep their stream; `request_id` updates exist only for cross-subject narratives, used sparingly).
**IMPLICATION:** Requests' `governance_request_events` remains authoritative for the case lifecycle; the shared update model is for Projects/Commitments/Consultations/Petitions/Engagements.

## 12. Accountability architecture (visibility model)

**DECISION:** One visibility taxonomy across all Governance objects, one owner of transitions:

```text
Private                staff-visible only (default for everything)
Internal               staff-wide within the tenant (scope-filtered)
Participant-visible    the external participant(s) involved (tracking/own-case parity)
Authenticated-visible  any signed-in member of the tenant
Public                 deliberately published; served only via narrow RPC projections
```

Defaults: **everything Private.** Publication to Public (and retraction) is an explicit staff action gated by `publish_accountability`, audited in Core Audit with actor attribution, and stamps `published_at`. Participant visibility follows the existing request model (own case + public events).

What citizens may eventually see (public projections only, via SECURITY DEFINER RPCs — never base tables):

| Surface | Public default | Contents |
|---|---|---|
| Published projects | opt-in | Status, geography, progress, milestones, public updates, evidence |
| Published commitments | opt-in | Status, progress, source lineage, delivery links, updates |
| Resolved requests | **statistics only** | Counts, resolution times, category/geo distributions — never case contents |
| Consultations/surveys | opt-in, results-stage | The instrument + published aggregate results |
| Polls | results after close | Aggregate counts |
| Petitions | opt-in | Title, demand, support count, status; signatures never public |
| Engagements | opt-in | Summary, agenda, outcomes, follow-ups — attendance is a count |
| Updates | per-update `is_public` | Public updates appear on their subject's public projection |

**REJECTED:** Public-by-default accountability ("transparency means everything is open") — PII, moderation, and safety failures; per-object bespoke visibility rules — untestable sprawl.

## 13. Request relationship architecture

**DECISION:** All cross-entity relationships are **optional**, materialized as explicit typed links (exact join mechanics per implementation gate):

```text
request  ──< project          many requests may feed one project's context
request  ──  commitment       a resolution may create a commitment (source_type='request')
petition ──  request          a petition may open a case (staff action)
consultation ── commitment    a consultation may produce a commitment
engagement ── project         an engagement may precede/initiate a project
engagement ──< request        issues raised become cases
commitment ──< project        one commitment delivered by many projects
```

Never mandatory: a Project without Commitment; a Commitment without Project; a Request without any link; a Petition that yields no case. **No relationship grants authority** — linking never changes RLS visibility; a citizen cannot self-link their request to a project to gain project visibility (links are staff-created, audited).

## 14. External participant architecture

**DECISION:** The Phase 9/10 model extends unchanged: one `governance_participants` table, `profile_id NULL` for external, contact-based, tenant-scoped, no roles, no identity system.

| Surface | External participation | Credential |
|---|---|---|
| Requests | exists today | contact verification + tracking secret (Phase 10) |
| Consultations/Surveys | verified contact → one response | same contact-verification seam concept |
| Petitions | verified contact → one signature | same |
| Polls | OPEN DECISION (anonymous dedup) | — |
| Engagements | attendance recorded by staff (no self-service in v1) | none |
| Projects/Commitments | read-only public projections | none |
| Feedback on delivery | via linked requests | request identity |

**Contact verification** reuses the conceptual Phase 10 flow (server-side credential, hash-only, single-purpose, time-bounded) — implemented per-instrument at its implementation gate, never per-tenant-ad-hoc. **Account conversion** remains the Phase 9 decision: explicit verified-email linking of an external participant to a profile — no automatic merging, no takeover surface. **No session-based public access** beyond the published projections; there is no external login.

## 15. Geography architecture

**DECISION:** One shared pattern — per-object scope child tables constraining `scope_type` to the five **geographic** enum values (`polling_unit, ward, lga, senatorial_zone, state`); the `campaign` scope value is **forbidden** to Governance (enforced by CHECK in the implementation migration). Multi-scope is first-class (a project spanning two LGAs carries two rows). Staff authorization for geo-scoped objects reuses `politicore.scope_covers` / `my_scopes` semantics — no materialized child permissions, no duplicated hierarchy, no Governance geography tables. Visibility/accountability roll up along `scope_chain` (a ward-scoped petition is discoverable from its ward, LGA, zone, state).
**IMPLICATION:** Every geo-scoped governance object answers "where is this being delivered/held/asked" for accountability statistics without any new geography substrate.

## 16. Permission architecture

**DECISION:** Exactly **three** new permissions, domains `governance`; **no new roles**:

```text
manage_projects          create/progress/complete projects AND commitments (delivery cluster)
manage_participation     create/run consultations, surveys, polls, petitions, engagements
publish_accountability   flip visibility to/from Public across all governance objects
```

Existing `view_governance` covers all reads (scope-filtered); `view_cases`/`manage_cases`/`assign_cases` remain the case queue's permissions, untouched. Submission/participation by members needs no permission (participant identity is the authorization — the 0034 principle). External participants hold no permissions by definition.
**REJECTED:** Per-instrument officer roles/permissions (Project Officer, Petition Officer, …) — no demonstrated requirement; one mega `manage_governance` write permission (blurs delivery vs. participation duties and makes accountability publication unseparable); permission proliferation per §26.

## 17. Notification integration

**DECISION:** Core Notifications only. Future features emit **notification intents** through the existing transactional helper pattern (the 0021/0036 precedent) inside authority RPCs — never queues, never Governance delivery:

```text
consultation invitation · survey invitation · petition decision/update
project update (published) · commitment update · engagement reminder
request/response updates (exists, Phase 8)
```

External participants without portal identity are addressed through the `core_delivery_intents` seam (Phase 10) — the future Core-owned provider is the only sender. No `governance_notifications`, no Governance SMTP/SMS/WhatsApp, ever.

## 18. Media integration

**DECISION:** Governance stores **relations, not files**: evidence/photos/documents on projects, milestones, updates, petitions, engagements reference `politicore.media_assets` (Core, provider-agnostic). Upload authorization, MIME/size policy, and provider choice are Core Media concerns consumed via its existing boundary. No Cloudinary/R2/S3 coupling, no `governance_files`, no evidence storage in Governance.

## 19. Audit integration

**DECISION:** All accountability-significant actions land in `system_audits` via the existing patterns: project/commitment/consultation/poll/petition/engagement creation, status transitions, **visibility changes both directions**, consultation/survey closure, petition verification/closure/result publication, engagement publication, sensitive external-participant actions (verification, conversion), accountability publication. External attribution uses the established `actor_id NULL + actor_name/actor_email` model. No Governance audit tables.

## 20. Multi-tenant / SaaS implications

**DECISION:** Every object is tenant-scoped with FORCE RLS from birth; every new table follows the 0002/0034 pattern (tenant_id FK, FORCE RLS, server-resolved tenant). Terminology stays generic (§1); political meaning is carried by tenant configuration, geography, and labels — never by schema. Module activation remains per-tenant; nothing in this architecture assumes elected office.

**REJECTED:** Schema-per-tenant, "SaaS mode" flag, postponed multi-tenancy — contradicts the platform's day-one architecture.

## 21. Module activation / dependency model

```text
Governance ON   → requests (existing) + all future clusters; public intake per public_intake toggle
Governance OFF  → every governance surface fails closed, including public intake (already enforced server-side)
```

Dependencies of Governance: **none beyond Core.** Events: optional link (engagement without event is valid). Notifications/Media/Audit: Core always present. Campaign/Election/Social Force: **no dependency in either direction**; no FK from any governance table to campaign/election/social tables. No new module codes.

## 22. Public information architecture (future, not implemented)

**DECISION:** One Governance public hub; intake/tracking stays where it shipped:

```text
/governance                    accountability hub (published projects, commitments,
                               open participation, engagements, request statistics)
/governance/projects/[slug]    published project + its public updates/milestones
/governance/commitments/[slug] published commitment + delivery links
/governance/participate        open consultations/surveys/polls/petitions (+ detail routes)
/governance/engagements        published engagement records
/request · /request/track      existing Phase 10 intake/tracking (unchanged)
```

**REJECTED:** `/governance/updates` (updates render on their subject); `/governance/surveys`, `/governance/polls`, `/governance/petitions` as separate top-level routes (one participation hub, discriminated detail pages); `/governance/cases` public directory (never — requests are private with statistics only).

## 23. Internal portal architecture (future, not implemented)

```text
/portal/governance
├── Dashboard           queue + delivery + participation at a glance
├── Cases               existing request queue (Phases 7–8, unchanged)
├── Projects            delivery cluster (projects; commitments as a tab — same permission)
├── Participation       consultations/surveys/polls/petitions as tabs (same permission)
├── Engagements         meeting records
└── Accountability      publication console + operational statistics
```

**REJECTED:** A top-level "Updates" menu (updates are actions inside their subjects); "Surveys", "Polls", "Petitions" as separate menu items (instrument tabs under Participation — three new permissions would otherwise tempt three menu sections with no distinct workflow).

## 24. Data lifecycle

| Class | Meaning | Retention |
|---|---|---|
| Operational | active records (open cases, running projects, open consultations) | until terminal |
| Historical | terminal records (closed/resolved, completed, closed instruments) | **retained indefinitely — institutional memory is a product goal (§23)** |
| Public | deliberately published projections | while published; retraction is audited, not erased |
| Private | unpublished staff/participant data | lifecycle of the subject record |
| Audit | `system_audits` | immutable, Core-owned retention |

**DECISION:** No archival infrastructure now. Terminal records stay in place, RLS-enforced, queryable for memory/analytics. Deletion is a tenant-offboarding concern (existing CASCADE), not a Governance feature.

## 25. Institutional memory & analytics

**Memory:** closed/terminal objects remain discoverable by geography, category, and time — the scope pattern and status enums make "what was delivered in Ward X, 2026–2027" a queryable fact. Advanced search/analytics substrates are future **Core** capabilities; Governance only guarantees its data is structured enough to be searched (status enums, scope rows, timestamps, published flags) — it builds no search index in this phase.

**Analytics model (conceptual only; classified):**

| Metric family | Examples | Visibility |
|---|---|---|
| Requests | submitted/acknowledged/resolved/closed, resolution time | operational (staff) · aggregates may become public |
| Projects | active/completed/delayed, geo distribution, progress | operational · published subset public |
| Commitments | total/active/delivered, progress | operational · published subset public |
| Participation | responses, votes, signatures, attendance | operational · published aggregates public |
| Accountability | published objects, updates, outcomes | public (by definition of publication) |

**DECISION:** Analytics are derived views over operational tables — never denormalized counters mutated in-line (drift risk). Any materialized projection comes later, behind its own gate, with freshness semantics.

## 26. Canonical relationship graph

```text
Tenant
 ├── governance_participants (internal: profile_id; external: contact)
 │
 ├── governance_requests ── governance_request_events (append-only)
 │        └─────────────── governance_assignments
 │
 ├── governance_projects ──< governance_project_milestones
 │            │   └──< geo_scopes · media relations · links(requests, commitments)
 ├── governance_commitments ──< links(projects) · geo_scopes · source lineage
 │
 ├── governance_consultations ──< governance_consultation_responses
 ├── governance_polls ──< governance_poll_votes
 ├── governance_petitions ──< governance_petition_supports
 │
 ├── governance_engagements ── (optional) events · attendance · issue links
 │
 ├── governance_updates ──< exactly one of {project, commitment, request,
 │                         consultation, petition, engagement}
 │
 └── system_audits · notifications · media_assets · core_delivery_intents   (CORE)
```

Every node: tenant_id + FORCE RLS + server-resolved identity. Dashed-by-design: any link may be absent.

## 27. Explicit non-goals (§26 — must NOT exist)

- `governance_organizations` / implementing-agency entities (text field suffices)
- Person-level beneficiary tracking (aggregate counts only)
- `governance_outcomes` table (outcome = terminal update + status)
- Workflow-engine tables for projects/participation (simple status enums + the existing request state machine)
- `governance_notifications`, `governance_audit`, `governance_files`, per-object update tables
- Governance geography tables, new scope enum values, materialized scope permissions
- New roles (Project Officer, Constituency Officer, …) or per-instrument permissions
- Campaign Communications/Documents/Calendar recreations; `user_access` recreation
- A universal content table absorbing updates/events/responses
- Mandatory links anywhere in the relationship graph
- Expenditure/ledger tracking inside Governance
- Public comment feeds, public request directories, public participant lists

## 28. Security implications per public surface (§30)

| Future public surface | Threats | Architectural controls |
|---|---|---|
| Published projects/commitments | scraping beyond publication; stale data presented as current | RPC-only projections of published rows; published_at semantics; no base-table anon access |
| Participation (consultations/surveys) | response flooding, PII in free text, ballot stuffing | contact verification, per-participant uniqueness, size bounds, staff-only response reads, audit |
| Polls | repeated voting, bot votes | server-side dedup (participant-bound), OPEN DECISION on anonymous mode requires its own threat model |
| Petitions | signature fraud, impersonation, harassment content | verified-contact signatures, verification-before-results, moderation state, audit |
| Request statistics | re-identification through narrow slices | aggregate-only publication, minimum bucket sizes at implementation, no geo+category slices that isolate one case |
| Engagement records | attendance PII | counts/rosters staff-only; public record is summary + outcomes |
| Public intake (exists) | unchanged Phase 10 guarantees | unchanged — the new architecture adds no intake authority |

Invariants preserved everywhere: tenant isolation, FORCE RLS, server-resolved tenant/actor, no client-supplied authority or tenant identity, no scope self-service, no anonymous base-table access, public surface = narrow SECURITY DEFINER RPCs, insert-time event visibility for requests unchanged.

## 29. Open decisions (must be resolved before their implementation gate)

1. **Anonymous poll participation** — whether polls admit unauthenticated votes and, if so, the privacy-preserving dedup mechanism (no fingerprinting surface). Required before the Polls implementation phase.
2. **External-participation UX for consultations/surveys** — how the Phase 10 contact-verification flow presents per-instrument (one verified contact = one response per instrument) without leaking cross-instrument linkage. Required before Participation implementation.
3. **Petition signature verification mechanics** — sampling vs. full verification, threshold semantics, staff workload. Required before Petitions implementation.
4. **Statistics anti-re-identification rules** — minimum aggregate bucket sizes for public request statistics. Required before the Accountability implementation phase.
5. **Search/analytics substrate ownership** — a future Core capability; Governance must not build its own. Resolved at the platform level, not in Governance.

None of these block the gate: each is bounded to its own implementation phase and none changes the domain model above.

## 30. Implementation sequencing proposal (§29/§34 — not authorized, proposed)

```text
Phase 12 — Governance Delivery: Projects (+ milestones, shared governance_updates,
           geo-scope pattern, manage_projects permission)          ← substrate ships here
Phase 13 — Governance Commitments (reuses updates + geo scopes; commitment↔project links)
Phase 14 — Governance Participation I: Consultations & Surveys
           (+ manage_participation; external verified participation)
Phase 15 — Governance Participation II: Petitions & Community Proposals
Phase 16 — Governance Polls (resolves OPEN DECISION 1 first)
Phase 17 — Governance Engagements (town halls; optional event links)
Phase 18 — Governance Accountability (publication console, public RPC projections,
           public hub routes, publish_accountability permission)
Phase 19 — Governance Analytics & Institutional Memory (derived aggregates)
```

**Rationale:** Projects first — they introduce the two shared substrates (updates, geo scopes) with the simplest consumer, so every later phase inherits instead of re-deciding. Accountability after the objects it publishes exist. Polls after the participation pattern is proven. Analytics last, over stable structures.

---

## Verification (this gate)

Focused architecture suite: `tests/security/governance-phase11-architecture.test.ts` — proves Governance's independence (no cross-module FKs), the Phase 6–10 security substrate unchanged (FORCE RLS on every governance table, zero anon policies on the intake surface), permission catalog unchanged (exactly 4 governance permissions, no new roles), scope enum unchanged (6 values, no governance-specific additions), locked-module migrations untouched this phase, zero Firebase artifacts, no governance notification/audit/media/update-duplicate tables proposed in the schema, and Phase 10 public intake still green.

*End of gate document.*
