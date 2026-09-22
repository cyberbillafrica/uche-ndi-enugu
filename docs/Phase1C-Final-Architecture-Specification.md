# POLITICORE — PHASE 1C FINAL ARCHITECTURE SPECIFICATION

**Status:** RATIFIED, AMENDED & RECONCILED (decisions made at the Phase 1C decision gate, implemented in migrations 0014–0017, extended by the architecture-amendment migrations 0018–0019 — relational votes + history hardening; verified 40/40 local security tests + 39/39 hosted acceptance checks)

**Purpose:** Consolidated, decision-ready record of every Election architecture decision from the Phase 1C gate. Each section states the decision, the alternatives considered and rejected, and where the decision is enforced in the as-built database. This document is authoritative for future Election work; if code and this document ever disagree, the discrepancy must be reported before further change.

**Scope guard:** This document ratifies the implemented database foundation only. Election UI/service migration, Firebase removal, and application cutover remain future phases. Legacy Firebase Election (`src/lib/firebase/election.ts`, Firestore rules, Cloudinary EC8 path) is untouched and remains the behavioral reference.

---

## 1. Final Election business model

Election is a **first-class, independent, module-gated domain**: `module_enabled('election')` is required by every policy and RPC. It shares only platform foundations with other modules — tenant identity, authorization resolver, geography, Media Service, notifications, audit. Election never calls Campaign and Campaign never calls Election. A tenant may run Election for partisan campaign operations, election observation, civil-society or NGO monitoring — the database is blind to purpose.

Domain entities: 9 tables plus one integrity child — cycles, contests, parties, candidates, results, **result votes (relational ballot, amendment 0018)**, result history, PU reports, incidents, settings.

## 2. Final membership / participant model

**Decision A — Election operations never require Campaign membership.**

The pre-gate design's "campaign membership + registered PU" wording was corrected. Registered-PU submission is one of **three independent authority paths**; the registered-PU path *currently* keys off a campaign-type membership entry only because that is where the product records PU registration today — it is one disjunct among three, not a dependency.

| Question | As-built answer |
|---|---|
| Who may submit results? | (1) Admin/tenant-super-admin, (2) Election Officer, (3) holder of a scoped `upload_election_result` grant covering the PU (state/zone/LGA/ward/PU hierarchy), (4) registered-PU member (profile row with `polling_unit_id` set + `campaign_member` membership entry). |
| Who may submit PU reports? | `submit_election_pu_report` via the resolver (scoped positions/assignments) — same role-independence. |
| Who may submit incidents? | `submit_election_incident` via the resolver. |
| What makes someone an Election participant? | Holding Election-domain authority via the resolver, or being the registered submitter for a polling unit in an active contest. |
| What provides that authority? | `has_permission()` through positions, organizational assignments, explicit permission grants, the fixed officer set, or admin bypass — never a module membership. |
| Campaign disabled? | Paths (1)–(3) are entirely unaffected (verified by Test 18 *module independence* and hosted check 19: an election-only tenant works end to end). Only the registered-PU path is unavailable, because PU registration is not captured elsewhere yet. |

**Deferred:** a dedicated `election_participants` concept (registering observers at PUs without any campaign-type membership) is intentionally deferred — it is additive and does not block the current product.

## 3. Final Election Officer model

**Decision:** Election Officer remains a **first-class `access_role`** (`profiles.access_role = 'election_officer'`), exercising a **fixed election-domain set** through the Phase 1A resolver branch (0002 §2) — not through position rows.

Rationale: "organizational positions are not access roles" is preserved — officer authority is an *access role with a fixed, narrow permission set*, not a position and not general administration. The officer set is: view Election data, submit, review (approve/reject/clarify/reopen), `verify_election_result`. It excludes tenant administration, Campaign/Social/Governance management, and Admin correction. Hosted has zero `position_permissions` election rows by design; the resolver branch is the authority. Platform-super-admins see the fixed officer set too (not admin powers) — officers are not promoted to administration by seniority.

No new authorization infrastructure was created; no `election_roles`/`election_permissions` tables exist.

## 4. Final authorization matrix

| Capability | Social-only | Tenant member (no Election authority) | Campaign member (registered PU) | Scoped grant holder | Election Officer | Tenant Admin |
|---|---|---|---|---|---|---|
| Read contests/cycles/candidates | ✗ | ✓ (module on) | ✓ | ✓ | ✓ | ✓ |
| Read results (scoped) | ✗ | ✗ | own registered PU only | granted geography | tenant-wide | tenant-wide |
| Submit result | ✗ | ✗ | ✓ own PU | ✓ granted geography | ✓ tenant-wide | ✓ tenant-wide |
| Submit PU report / incident | ✗ | per resolver | per resolver | ✓ | ✓ | ✓ |
| Review/verify results | ✗ | ✗ | ✗ | with `verify_election_result` | ✓ | via admin bypass¹ |
| Correct results | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Configure cycles/contests/settings | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| Approve own correction | — | — | — | — | n/a | **✗ (absolute)** |

¹ Admins reach `verify_election_result` only through the central resolver's existing admin bypass **plus** Election-domain permission checks — they are verifiers of ordinary results, but the correction boundary (§12, §14) overrides.

Every row above is additionally gated by `module_enabled('election')` and tenant isolation. Social-only exclusion is enforced at four layers (RLS, RPC guards, public view, module surface) via `is_social_only()` (0014): social membership ∧ ¬campaign membership ∧ ¬admin ∧ ¬officer. A campaign member is never classified social-only.

## 5. Final geography / constituency model

**Decision B — Option B: constituencies are Election-specific scope data; core geography is untouched.**

- Core hierarchy unchanged: `states → senatorial_zones → lgas → wards → polling_units` (1/3/17/260/4,145 — never modified).
- Federal and State Constituencies are **not** new tables. A constituency contest declares `scope_type ∈ {federal_constituency, state_constituency}` and carries `scope_lgas uuid[]` (constituencies in Enugu are LGA-aligned), validated by the `trg_validate_contest_geography` trigger: non-empty, every LGA exists and belongs to the contest's state; `state_id` canonicalized from the LGA set.
- Ward→constituency exclusivity, boundary-history/effective-dating, and per-PU constituency mapping are **deferred** until a second state or official INEC boundary data demands them. Current product reality: one state, LGA-aligned constituencies.
- Scope→PU resolution is **server-side, authoritative, single-source** (`submit_election_result`): state contests check `lga.state_id`; zone contests check `lga.zone_id`; constituency contests check `pu.lga_id ∈ scope_lgas`; national covers all. Geography on the result row is **derived from the polling unit** — client-supplied ward/LGA is never trusted.
- Aggregation scopes by the same columns (`ward_id`/`lga_id`), so constituency totals are the sum over `scope_lgas`.

The gate question — *"Does this PU legally belong to this contest's scope?"* — is answered server-side in `submit_election_result` and nowhere else.

## 6. Final contest model

Types: `presidential | governorship | senatorial | federal_house | state_house`. Statuses: `DRAFT | OPEN | PAUSED | CLOSED` — results only against `OPEN`. **Campaign is not a prerequisite** (no join, no module check beyond Election itself).

Scope invariants (§8 of the gate, enforced as above):

```text
presidential   → national
governorship   → state
senatorial     → senatorial_zone
federal_house  → federal_constituency (LGA set)
state_house    → state_constituency (LGA set)
```

`tracked_parties text[]` stores **acronyms** (guard trigger rejects unknown acronyms) as a *filtering/display hint* only — it is **not** a vote-integrity reference. Vote integrity references party UUIDs exclusively (§7/§9 below), so the gate's "no second denormalized party reference" concern is satisfied: the array can never make a wrong party count as valid in results. `focus_party_id` is a UUID FK.

## 7. Final party / candidate model

- `political_parties` is **platform-level** reference data (world-readable parity with the legacy Firestore collection; writes platform-admin only). Acronym unique; INEC-registered and active flags carried.
- **Votes reference party UUIDs, never names/acronyms** — the legacy party-name-string defect is dead. `assert_valid_votes` rejects missing/malformed/unknown party IDs, negative/non-integer votes, duplicates; returns canonicalized votes.
- Candidates: `UNIQUE (contest_id, party_id)`; inactive/disqualified/withdrawn candidates are flagged, never deleted (historical integrity). Running mate supported.
- **Independent candidates: deferred.** `assert_valid_votes` rejects any party_id not in `political_parties`, so independents require a deliberate schema addition later (a platform `independent` party row is the cheapest bridge if ever needed).

## 8. Final result model

**Decision C — AMENDED by the reconciliation gate: votes are RELATIONAL (`election_result_votes` 1:N).** The gate's ruling is explicit: PostgreSQL is not a Firebase transcription target; where the domain is structurally relational, structure is enforced natively. Party votes are the canonical case — party, result, and vote count have stable relationships and must carry referential integrity, not JSON extraction.

```text
election_results ──1:N──► election_result_votes
                            result_id  → election_results(id, contest_id)  [composite FK]
                            contest_id → pinned = result's own contest     [same FK]
                            party_id   → political_parties via ballot rule [composite FK]
                            votes      integer NOT NULL CHECK (votes >= 0)
                            UNIQUE (result_id, party_id)
```

The ballot rule is enforced **declaratively, with zero procedural checks at insert time**: `election_result_votes(result_id, contest_id)` FKs into `election_results(id, contest_id)` (0018 added `UNIQUE (id, contest_id)` so the result's own contest is referentially addressable), and `election_result_votes(contest_id, party_id)` FKs into `election_candidates(contest_id, party_id)` (candidate rows are therefore mandatory ballot participants). A vote for a party that is not a candidate of the result's contest is **uninsertable by anyone, including the workflow RPCs** — the `assert_valid_ballot` RPC validator is a friendly-error pre-check, not the integrity boundary. No `party_acronym` or party-name identity exists anywhere in the ballot.

Migration 0018 expanded any legacy JSONB payloads into relational rows before dropping the column (hosted was pristine; the expansion path is forward-safe and fails loudly on a rule-violating legacy row rather than silently dropping data).

Integrity on the result row itself: `UNIQUE (tenant_id, contest_id, polling_unit_id)`; `verified ⇔ status='approved'` CHECK; `verified` never client-writable; status enum `submitted | pending_review | approved | rejected | clarification_required | reopened` (no `corrected` status — correction is a history action, §9).

## 9. Final revision / history model

**Decision D — Model 1: one mutable current row per `(tenant, contest, PU)` + append-only history.**

- **Submission** = an authorized actor's upsert against the relational identity: status resets to `submitted`, `verified=false`, fresh review attribution, submitter = current actor, evidence replaced (§10). A first submission appends a `create` event; a resubmission appends a distinct `resubmit` event (amendment). Every submission event carries **old and new votes in full** (relational ballots snapshotted as canonical JSONB) **plus old/new evidence and old/new submitter references** — the pre-correction snapshot is never lost. Resubmission is legal only from `submitted / rejected / clarification_required / reopened` (fail-closed status guard; `approved` is immutable by resubmission, `pending_review` protects an in-flight correction).
- **Correction** = Admin-only RPC changing votes, forcing `pending_review`, `verified=false`, appending a `correct` event with old/new votes, old/new evidence refs, and reason. Never a new row, never a `corrected` status.
- **Current result** = the single row for the identity; it is the operational truth (dashboard simplicity preserved).
- **Forensic reconstruction** = the history trail: each event carries old status/votes, new status/votes, actor, notes, timestamp — full state replay is possible without a revisions table. Conflicting submissions resolve by last-write-wins at the identity, with the loser preserved in history — acceptable because EC8 evidence and the review workflow, not row multiplicity, are the audit anchors.
- History is append-only and RPC-only: `trg_guard_election_history_writer` accepts writes only inside workflow RPCs (transaction GUC); client INSERT/UPDATE/DELETE revoked; no DELETE policy on results — results cannot be deleted by anyone. `old_evidence_asset_id` / `new_evidence_asset_id` FK into `media_assets` (indexed) so every historical state carries its own evidence reference (§10).
- Model 2 (immutable revisions) was rejected for this phase: its benefits accrue to multi-stakeholder conflicting-submission scenarios the product does not yet have, and the history table already delivers the audit properties. Re-evaluation trigger: observation coalitions filing competing returns for the same PU.

## 10. Final evidence model

- One evidence asset per current result: `evidence_asset_id` NOT NULL FK → `media_assets`, `purpose='election_evidence'`, tenant-matched, existence-verified in the RPC. Existing Media Service/R2 only; private signed access; no Cloudinary/R2/Firebase-Storage code in Election.
- Resubmission/correction **replaces** the association but the prior `media_assets` row is never deleted (Media Service assets are append-only per Phase 1B) — original EC8 evidence is immutable and remains accessible to tenant admins/officers through history + direct asset references.
- Rejected results retain their evidence. Multiple evidence assets per submission: **deferred** (one EC8 per PU return matches the legacy product; the schema extends by adding a junction later without changing the RPC contract).
- History rows carry the **evidence chain explicitly**: `old_evidence_asset_id` → `new_evidence_asset_id` on every event (added by amendment 0018). Every vote-bearing event (create/resubmit/correct) stores its new-evidence reference; review events pin the unchanged asset on both sides. The chain is queryable by plain SQL — verified on hosted by asserting zero vote-bearing events with a NULL new-evidence reference.

## 11. Final result visibility model

**Confirmed unchanged:** unauthenticated = no access; authenticated users = RLS-scoped by the §4 matrix; social-only = zero. The `public.election_results_current` exposure is security-invoker — RLS applies to the querying role; world visibility is granted but yields rows only for authorized callers. Parties are the only world-readable Election-adjacent data (legacy parity).

**Future-ready, not implemented:** visibility classes (`PRIVATE | AUTHENTICATED | PUBLIC`) would be a per-tenant/contest setting consulted inside read policies. Deferred until a real requirement exists; nothing in the current schema blocks it.

## 12. Final state machine

```text
             submit (upsert, any authorized actor)
  ─────────────────────────────────────────────►  submitted
  submitted ──approve──► approved ──reopen──► reopened
      │  ▲                   │                    │
      └─┘ clarify → clarification_required ──────┘   (resubmit returns to submitted)
      │                      │
      └──reject──► rejected  └──(any non-approved state)──correct──► pending_review
                                                  (Admin; verified=false)
```

Transitions are enforced **only** in the workflow RPCs: `review_election_result` raises on every illegal transition (e.g. approve only from `submitted/pending_review/reopened`; reopen only from `approved`), and — added by the reconciliation gate — `submit_election_result` carries a fail-closed status guard: resubmission is legal only from `submitted / rejected / clarification_required / reopened`. **`approved` results are immutable by resubmission** (an authorized verifier must reopen, or an administrator must correct) and **`pending_review` results reject resubmission** (an admin correction is under independent review; a resubmit must not silently clear it). Both were silently overwritable in the 0014–0017 build; closed in 0019. `verified = (status='approved')` is a DB CHECK — true for no other path. Admin correction from any state except `pending_review` lands on `pending_review` (verified=false).

## 13. Final RLS strategy

RLS enabled on all 9 tables. **FORCE everywhere except** `election_results`, `election_result_history`, and `notifications` — the tables the definer workflow layer must write as owner (0006 precedent); app roles remain fully policy-governed on them (no INSERT/UPDATE/DELETE policies on results; history REVOKE-hardened + trigger-guarded). Policy composition everywhere: tenant ∧ `module_enabled('election')` ∧ `¬is_social_only()` ∧ authority. No "authenticated can read everything" policy exists.

## 14. Final RPC surface

| RPC | Mode | Purpose |
|---|---|---|
| `submit_election_result(contest, pu, votes, evidence)` | definer | 20-step submit: identity → tenant → module → tenant-owned contest → OPEN → scope validity → PU-in-scope → **fail-closed authorization** → evidence (tenant+purpose) → vote validation → upsert → history → notify officers → return row |
| `review_election_result(result_id, action, notes)` | definer | verifier authority → legal transitions → **independent-verification block** (Decision 5) → attribution → history → notify submitter |
| `correct_election_result(result_id, votes, reason)` | definer | admin-only correction → `pending_review` → history → re-verification notifications |
| `set_active_election(cycle_id, contest_id)` | definer | admin-only; same-tenant; contest ∈ cycle |
| `get_results_aggregate(cycle, contest, scope_type, scope_id)` | **invoker** | party totals, approved PU count, total PUs, reporting % — computed strictly over RLS-visible rows (never a privilege leak) |

Plus helpers `assert_valid_ballot` (amendment: friendly-error pre-check for contest-party validity; the declarative composite FKs are the actual integrity boundary), `assert_valid_votes` (legacy-shape validator retained), `validate_contest_geography`, `guard_tracked_parties`, `guard_election_history_writer`, `notify_election_roles`, `is_social_only`. Client-supplied tenant identity is never accepted anywhere — tenant comes from the authenticated profile/claims.

## 15. Final realtime strategy

Publication additions: `election_results`, `pu_reports`, `election_incidents` (guarded, idempotent). `election_settings` deliberately excluded (refetch-on-change). Realtime payloads honor subscriber RLS — not an RLS bypass.

## 16. Final notification strategy

Reuses the Phase 1B notifications infrastructure exclusively; no new notification system. Submission → officers/admins (excl. actor); review decision → submitter; correction → officers + submitter (re-verification required); serious incidents → election authorities. Definer context is what lets a non-admin workflow actor raise these (notifications INSERT remains admin-only to clients; `notifications` NO FORCE restores only the owner path).

## 17. Final migration sequence

```text
0014_election_schema.sql          — 9 tables, 11 enums, RLS, 21 policies, indexes,
                                    permissions (view_election_result,
                                    verify_election_result), is_social_only,
                                    resolver extension, audit triggers
0015_election_workflow.sql        — 5 RPCs, 5 helpers, 3 triggers, notification wiring
0016_election_seed.sql            — 17 platform parties from the authoritative legacy seed
                                    (no tenant cycles/contests seeded — modular activation)
0017_election_views_realtime.sql  — security-invoker current-results view (politicore +
                                    public exposure), realtime publication
0018_election_relational_votes.sql — AMENDMENT: relational `election_result_votes`
                                    (composite-FK ballot rule into results and candidates),
                                    forward-safe JSONB expansion + column drop, history
                                    evidence/submitter references, `resubmit` history action,
                                    `UNIQUE (id, contest_id)` FK target
0019_election_workflow_relational.sql — AMENDMENT: RPC rewrites over the relational ballot
                                    (submit/review/correct/aggregate), fail-closed resubmission
                                    status guard, views recreated on the relational model
```

Application cutover is **not** in this sequence — a later phase migrates Election services/UI. (0018/0019 were split from the gate's suggested single migration to mirror the repository's established schema/workflow separation; the split is behavioral-neutral and documented in the amendment report.)

## 18. Explicit list of decisions made

1. Election independent of Campaign (Decision A) — **four** authority paths: (1) tenant admin/super-admin, (2) Election Officer, (3) scoped `upload_election_result` grant, (4) registered-PU campaign member. (Wording corrected by the reconciliation gate — the ratified text said "three"; the implementation has always had four.)
2. Constituencies as Election scope data, not core geography (Decision B, Option B).
3. **RELATIONAL votes** (`election_result_votes`, composite-FK ballot rule) — Decision C as originally ratified (JSONB) was **superseded by the architecture amendment gate**; the gate's ruling (relational integrity first, procedural validation second) is now authoritative.
4. Mutable current row + append-only full-snapshot history (Decision D, Model 1), with distinct `create`/`resubmit` history actions and evidence/submitter references on every event (amendment).
5. Admin/officer verification separation absolute for self-correction (Decision E) — enforcing check lives in the review RPC, never in a weakened resolver.
6. Election Officer stays a first-class access role with a fixed resolver set (gate §9 — unchanged by the amendment).
7. Server-side scope resolution for every submission (gate §8 mapping).
8. `tracked_parties` = acronym hints/display only; **ballot integrity is native**: a vote's party must be a candidate of the contest via composite FKs (amendment; `tracked_parties` is never an integrity mechanism).
9. Visibility stays authenticated-scoped; PUBLIC/PRIVATE classes deferred.
10. Single evidence asset per result; assets append-only and never deleted; every historical state carries old/new evidence references (amendment).
11. Exactly 9 tables (gate §12) — no tenth table. `election_result_votes` is an integrity child of `election_results`, not an independent domain entity.
12. Results/history/ballots not FORCE-RLS (owner write path for the definer workflow); app-role behavior unchanged — ballots are client-read-only and RPC-write-only.
13. No dual read/write anywhere; Firebase Election untouched.
14. Fail-closed resubmission guard: `approved` and `pending_review` results can never be overwritten by resubmission (amendment).

## 19. Explicit list of decisions intentionally deferred

| Deferred item | Re-evaluation trigger |
|---|---|
| Dedicated election-participant registration (non-campaign observers at PUs) | Observation/NGO tenants that need PU registration without campaign membership |
| Immutable revision model (Model 2) | Competing multi-stakeholder submissions per PU |
| Independent/non-party candidates | First election with independents (schema addition) |
| Constituency boundary history / per-PU constituency mapping | Second state, or official INEC ward→constituency data |
| Ward exclusive membership per constituency | Same as above |
| `PRIVATE/AUTHENTICATED/PUBLIC` visibility classes | First tenant requiring public results |
| Multiple evidence assets per submission | Product evidence requirements beyond one EC8 |
| `election_settings` realtime | A concrete UI need |

## 20. Migration impact on the Phase 1A/1B foundation

**Additive only.** The resolver (`has_permission`) was extended with a `verify_election_result` grant category and the officer CASE branch gained the two new permissions — no existing branch, permission, or policy semantics changed. One foundation adjustment was required and is documented in 0014: `politicore.notifications` moved to **NO FORCE** RLS (same class as the 0006 fix) so the definer workflow can notify on behalf of non-admin actors; client-facing policy enforcement is unchanged. **Amendment impact (0018/0019):** equally additive — `election_result_votes` is a new child table; `election_results` gained only a UNIQUE constraint before its JSONB column was dropped; history gained columns; the views were recreated on the relational model; geography, Media, authorization tables, and all Phase 1A/1B migrations remain untouched. No Phase 1A/1B blocker was encountered.
