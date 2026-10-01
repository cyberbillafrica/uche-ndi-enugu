# PolitiCore — Governance Polls Report (Phase 16)

**Status:** PHASE 16 — COMPLETE — **PASS**
**Parent gate:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md` (§8 Polls architecture, §29 open decision 1, §30 sequencing)
**Previous:** `docs/Governance-Phase15-Report.md`
**Scope:** Governance Polls — one canonical model, authenticated participation, geographic scope, lifecycle enforcement, result publication, privacy boundaries. Anonymous participation deliberately **not** implemented (see §2). No Campaign/Election/Social Force changes. No Core changes.

---

## 1. Phase status

**PASS.** All acceptance dimensions green: local security suite, full regression, TypeScript, build, lint, hosted acceptance, hosted cleanup, locked-module verification.

## 2. Anonymous participation — the critical architecture decision

Phase 11 §29 **OPEN DECISION 1** states anonymous poll participation is admitted only *"if, and only if, the privacy-preserving dedup mechanism (no fingerprinting surface)"* is decided and threat-modeled (ballot stuffing vs. fingerprinting) before implementation. The gate does **not** resolve the mechanism — it explicitly requires the decision "before the Polls implementation phase," and every candidate mechanism would require either:

- a new identity/dedup architecture (forbidden by Phase 11 and prompt §6 — no OTP tables, no tokens, no IP identity, no fingerprinting, no client-generated IDs), or
- the Phase 10 contact-verification seam, whose per-instrument UX is itself gated by the still-open decision 2 (deferred in Phase 14), or
- an unauthenticated SECURITY DEFINER write path with no integrity model (ballot-stuffing risk the gate itself names).

Per prompt §2/§6/§36 stop condition 1, the anonymous portion **stops at the architecture boundary**. Implemented state:

- Polls are authenticated-only; the existing `governance_participants` model is the sole participation identity.
- Anon holds **nothing**: zero base-table grants, zero policies, zero RPC/wrapper EXECUTE, zero views reachable (proven locally C2 and hosted J1a–J1c).
- No dedup/anonymous identity infrastructure exists anywhere in the schema (proven by C2's schema probes).
- The exact missing decision for a future gate: *the server-side, privacy-preserving dedup mechanism for unauthenticated votes (its threat model must bound ballot stuffing without creating a fingerprinting surface), plus the abuse/rate-limiting layer that would host it.*

This is not a failure state — it is the Phase 11 architecture functioning as designed. The authenticated slice is complete; anonymous voting needs its own authorized decision, exactly as the gate planned.

## 3. Migration list

| Migration | Purpose |
|---|---|
| `0055_governance_polls.sql` | The Phase 16 primary migration: enums, 3 tables, 4 guard triggers, 2 geo-authority functions, 2 notification helpers, 9 authority RPCs + public wrappers, FORCE RLS, policies, grants/revokes. |
| *(no convergence migrations)* | 0055 converged first-pass on both local and hosted — the hosted apply and the convergence probe both verified the intended final state, and no defect surfaced at any later gate. |

## 4. Database objects

- **Types:** `politicore.governance_poll_status` — exactly `draft | open | closed` (gate §130: no `results_published` state for polls).
- **Tables:** `governance_polls` (canonical poll: `reference_code` UNIQUE PL-, title, question, description, `options jsonb` 2–20 non-empty unique strings, status, `closes_at`, `results jsonb` + `results_summary`, `is_public`, `published_at`, created_by/at/updated_at, `governance_polls_results_require_closed` CHECK); `governance_poll_scopes` (Phase 12–15 scope shape verbatim, `scope_type <> 'campaign'`); `governance_poll_votes` (poll, participant, choice, submitted_at, `UNIQUE(poll_id, participant_id)`).
- **Triggers:** `trg_governance_poll_reference` (PL- minter); `trg_governance_poll_identity` (reference immutable; visibility flips GUC-gated); `trg_governance_poll_status` (lifecycle guard `draft→open→closed` only); `trg_governance_poll_content` (options/question/title frozen outside draft); `trg_governance_poll_options` (option shape/uniqueness on every write path — CHECK constraints cannot host set-returning functions, so this runs as a trigger); `trg_governance_poll_vote_choice` (a vote's choice must be one of its poll's own options — belt-and-braces behind the RPC check); `trg_audit_*` on all three tables (Core `system_audits`).
- **Functions (17):** `make_governance_poll_reference`, `guard_governance_poll_identity`, `guard_governance_poll_status`, `guard_governance_poll_content`, `guard_governance_poll_options`, `guard_governance_poll_vote_choice`, `has_poll_geo_authority`, `assert_poll_authority`, `governance_notify_poll_open`, `create_governance_poll`, `update_governance_poll`, `set_governance_poll_status`, `publish_poll_results`, `set_governance_poll_visibility`, `add_governance_poll_scope`, `remove_governance_poll_scope`, `vote_governance_poll` — plus public text-overload wrappers.
- **Policies (SELECT-only):** polls (staff-wide + open-discoverable by members), scopes (staff-only), votes (staff-wide + own-row — ballot secrecy within the tenant). No INSERT/UPDATE/DELETE policies: every mutation flows through authority RPCs and direct writes fail closed under RLS.
- **Grants:** standard mirrored authenticated/service_role grants with explicit anon/PUBLIC revokes on views and RPC EXECUTE hygiene; **zero anon surface**.

## 5. Poll model & participation mechanics

One poll = one question + fixed options + one vote per participant (`UNIQUE(poll_id, participant_id)`), instant aggregate — Phase 11 §8 verbatim, deliberately lightweight (no documents, no thresholds, no verification workflow). Options are a fixed jsonb string array on the poll itself (the gate's two-table model); 2–20 non-empty unique strings, length-capped, validated server-side on every write path. Voting resolves the participant server-side from Core Identity (on-demand `governance_participants` row, 0034 precedent — never client-supplied), enforces open-window status **and** `closes_at`, validates option membership against the poll's own options, and appends an immutable vote. No edit/withdraw path exists (prompt §18: append-only — no UPDATE/DELETE policies, no RPC path).

## 6. Identity

Authenticated members participate through the single existing Governance participant model resolved from Core Identity. **No** poll users, voter accounts, poll roles, anonymous profiles, fake participants, or second participant tables exist (proven by C17 schema pins). Anonymous representation: none — participation is authenticated-only per §2.

## 7. Lifecycle

`draft → open → closed` exactly as gate §130 specifies — no `results_published` status for polls (publication records aggregates on a closed poll instead, see §8). Enforced in the RPC map (status argument restricted to `open|closed`), mirrored by the `guard_governance_poll_status` trigger (illegal transitions raise, reopen after closure impossible), with `closes_at` enforced server-side at vote time even while status remains `open`. Content (options/question/title) and scopes freeze outside draft; terminal records retained — no DELETE path (direct delete is a silent no-op under RLS, proven).

## 8. Results

Votes are collected as append-only rows; the live aggregate is derived from actual vote rows (no denormalized counters); publication is a separate audited act through `publish_poll_results`, which requires instrument authority **and** `publish_accountability`, refuses non-closed polls, and stores the staff-assembled aggregate + summary on the poll row. Unpublished results stay private: ordinary members cannot read other members' votes (own-row policy), and the published `results` field is the only aggregate surface. No individual vote, respondent identity, or raw-response export is ever public (C10/C12/C13, hosted J7/J9).

## 9. Permissions

The catalog remains **exactly the Phase 11 §16 seven** — `manage_participation` (poll management, geo-scoped) and `publish_accountability` (results publication + visibility) already authorized by Phase 11; zero new permissions, zero new roles (C5 pins the full catalog and probes for per-instrument permission artifacts).

## 10. Geographic authorization

Core Geography reused unchanged: State → Senatorial Zone → LGA → Ward → Polling Unit scope children with the Phase 12–15 shape verbatim, `campaign` scope forbidden, authority evaluated on the scope **being attached** (bootstrap-correct — a scope-scoped grantee cannot mint a tenant-wide poll by omission, per the 0049 rule), Core Geography existence validation fails closed on unknown ids, `has_poll_geo_authority`/`assert_poll_authority` mirror the Phase 14/15 pattern exactly.

## 11. Tenant isolation

Tenant is server-resolved in every authority path; cross-tenant reads return nothing (RLS), mutations fail closed (`not found` from the tenant check), cross-tenant votes fail closed, scope attachment cannot cross tenants. Proven locally (C3) and on hosted with real second-tenant identities (J10a–J10c).

## 12. Visibility/privacy

Private by default. Polls readable by staff within the tenant; **open** polls discoverable by any member (participation requires discovery); scopes staff-only; votes visible to staff (aggregate material) and to a voter's own row only — an ordinary member can never read another member's vote. Visibility flips are GUC-gated through `publish_accountability`; direct-table flips are silent no-ops under RLS (proven). Anon: nothing (§2). Ballot privacy preserved in every surface including the staff register.

## 13. Service layer

`src/lib/supabase/governance.ts` gained a labelled `PARTICIPATION — POLLS (Phase 16)` section: typed models (`GovernancePoll`, `GovernancePollScope`, `GovernancePollVote`, `GovernancePollStatus` + status labels) and functions `listPolls`, `getPoll`, `listPollScopes`, `listPollVotes`, `createPoll`, `updatePoll`, `setPollStatus`, `publishPollResults`, `setPollVisibility`, `addPollScope`, `removePollScope`, `submitPollVote`, `getMyPollVote` — every mutation delegated to the authority RPCs; the service owns no security. No parallel `polls.ts` service.

## 14. UI/routes

Management: `/portal/governance/participation` gained a Polls card (filter/search table + per-card "New Poll"), `/portal/governance/participation/polls/new` (options editor + scope drafts mirroring the Phase 14 form), and `/portal/governance/participation/polls/[id]` (draft editing, open/close with server-enforced `closes_at` editing, results publication, visibility, scope management, confidential vote register with live tally). Participant: `/portal/governance/participate` discovery includes open polls and `/portal/governance/participate/polls/[id]` is the one-click vote surface (own-vote confirmation, aggregate display after publication). Route guards are presentation-only; the database re-verifies everything.

## 15. Notifications

Core Notifications reused: `governance_notify_poll_open` fans out canonical `politicore.notifications` rows on open, with **recipient-correct, data-driven resolution** (profiles filtered by the poll's ward/LGA/PU scopes — structurally not a caller-relative `has_permission()` predicate, the Phase 15 §24 lesson) and best-effort failure semantics. Proven locally (C15: ward resident notified, wardless member not, cross-tenant impossible) and hosted (J13a/J13b).

## 16. Audit

Canonical `system_audits` only — RPC actions (`create/status/vote/results_published/visibility/update`) with server-resolved actor attribution, plus the base table triggers. No poll audit tables. Proven locally (C14) and hosted (J14: real GoTrue uids on every audited action; the vote audit carries the voter's own uid).

## 17. Governance Updates

**Poll is NOT an update subject.** The Phase 11 ERD names `project | commitment | request | consultation | petition | engagement` — a poll question is not a delivery narrative — so the canonical `governance_updates` substrate and its single-subject invariant are untouched (J12a/C13 pin the four-subject CHECK and the absence of poll in it). Project updates proven still working locally and hosted (J12b); commitment/consultation/petition subjects remain intact per the existing suites.

## 18. Focused security suite

`tests/security/governance-polls.test.ts` — **23/23 passing**, 0 skipped: C1 authority · C2 anonymous boundary (participation proven disabled; no dedup infrastructure) · C3 tenant isolation · C4 module gating · C5 permission catalog · C6 geography (unrelated/campaign/unknown fail; bootstrap rule; ward shape) · C7 lifecycle (illegal transitions, freeze, `closes_at`, terminality) · C8–C10 vote integrity + ballot privacy (server-resolved participant, foreign-option rejection, duplicate rejection, no direct write path, own-row reads) · C11 results (premature/ungated publication refused; aggregates verified) · C12 visibility · C13 canonical updates · C14 audit attribution · C15 recipient-correct notifications · C16 media boundary · C17 schema/security pins (FORCE RLS, zero anon surface, enum vocabulary, reference immutability, no FKs into locked modules).

## 19. Full regression

**837/837 passing — 35 suites — 0 skipped — 0 failed** (Phase 15 baseline 814 + 23 new). TypeScript: **0 errors**. Build: **PASS**. Lint on all touched files: **0 errors, 0 warnings**. The only pre-existing-suite change is the expected D1 migration-count pin update (55 → 56) with Phase 16 provenance recorded in the test itself.

## 20. Hosted acceptance

`scripts/db/verify-hosted-smoke-governance-polls.ts` — **37/37 passing** against the real hosted Supabase project (real GoTrue identities, real JWT, real PostgREST, real RLS): anon zero surface (3), creation + server stamping (2), RLS draft visibility (2), lifecycle (4), participation integrity (3), own-row privacy (1), `closes_at` (1), scope authority (5), content freeze (1), results publication (5), tenant isolation (3), canonical substrate (2), recipient-correct notifications (2), audit attribution (2), permission refusal (1). The Force-RLS cleanup procedure ran and restored security state on 33 tables.

## 21. Hosted cleanup

Post-cleanup residue probe across **16 dimensions** — tenants, auth users, profiles, polls, votes, scopes, grants, all five geography levels, notifications, audits, participants, FORCE-RLS state — returned **0 on every probe** (the recurring FORCE-RLS no-op on tenant/profile deletes was handled with the disclosed one-off purge, profiles before tenants; temp scripts deleted after the run).

## 22. Locked-module verification

Working tree contains exactly this phase's files (plus the prior phases' untracked artifacts). `0016_election_seed.sql` remains the Phase 14-disclosed repair — untouched per prompt §33. Social Force, Campaign, Election, Notifications, Events, News, Announcements, Manifesto, Core Identity, Core Geography, Core Media, Core Audit, Projects, Commitments, Consultations/Surveys, Petitions/Proposals: no modifications, no FKs from poll tables into any locked module (C17 FK probe), no second identity/participant/notification/audit/media/update system. Firebase: zero code references (the only textual mentions are suite comments documenting their absence).

## 23. Deviations

1. **Option validation as a trigger, not CHECK constraints** — PostgreSQL forbids subqueries and set-returning functions inside CHECK constraints; the option shape/uniqueness and vote-choice membership rules run as BEFORE triggers instead. Same enforcement strength (every write path, direct or RPC), disclosed here.
2. **`closes_at` presentation** — the participant vote page treats open status as the presentation gate and lets the server reject expired votes (the RPC is the authority); the earlier client wall-clock check was removed after lint flagged impure render reads.
3. **D1 pin update** — the Phase 11 architecture suite's migration-count pin moved 55 → 56 with Phase 16 provenance (the same authorized pin-update pattern as Phases 14/15).
4. **`PL-` reference prefix** — polls mint `PL-` (consultations `PT-`, petitions `PP-`); tables are separate so uniqueness domains never collide.

## 24. Deferred items

- **Anonymous poll participation** — requires the unresolved Phase 11 §29 open decision 1 (exact missing decision in §2). The bounded, authorized next step before any anonymous surface.
- External contact-verified participation (gated by open decision 2, as in Phases 14/15).
- Vote editing/withdrawal (append-only by design; not documented by Phase 11).
- Public poll result projection routes (the visibility lever exists; the public surface itself is the Phase 18 accountability hub).
- Engagements, Accountability, Analytics, Institutional Memory — not pre-built (C17 + boundary sweep confirm absence).

## 25. Architecture integrity

One Governance module · one participation architecture (three instruments, three canonical tables) · one participant model · one Core identity system · one authorization system · one geography system · one notification system · one audit system · one media system (unused here) · one update substrate (unchanged) · **one canonical Poll model** (`governance_polls` + `governance_poll_votes`, Phase 11 §8 verbatim).

---

```text
GOVERNANCE POLLS — PHASE 16: PASS
```
