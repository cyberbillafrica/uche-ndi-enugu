# PolitiCore — Governance Phase 11 Report
## Delivery, Participation & Accountability Architecture Gate

**Status:** PHASE 11 — COMPLETE — **GATE: PASS**
**Deliverable:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md`
**Type:** Architecture-only. No migrations, no production tables/RPCs/services/routes/UI created.

---

## 1. Architecture status

**PASS.** All 30 required sections resolved with explicit DECISION / RATIONALE / ALTERNATIVES / REJECTED / IMPLICATION entries; five bounded OPEN DECISIONs documented, each owned by a specific future implementation phase and none blocking the gate.

## 2. Documents created/changed

| File | Change |
|---|---|
| `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md` | **Created** — the Phase 11 gate (§1–§30 of the phase prompt) |
| `tests/security/governance-phase11-architecture.test.ts` | **Created** — focused architecture verification suite (§31) |

Nothing else changed. Zero migrations (pinned by suite test D1: exactly 43 migration files, highest `0042_*`).

## 3. Decisions made

1. **Governance = the tenant's delivery-and-participation ledger** — four clusters (Delivery / Participation / Engagement / Accountability) on one shared substrate; a general organizational engagement/delivery capability of which political offices are a special case (multi-tenant SaaS first, political meaning carried by geography/labels, never schema).
2. **Projects** — canonical `governance_projects` + milestones child; budget as fields (no ledgers); progress derived-from-milestones-first; beneficiary data **aggregate-only** (no person-level PII); no type-taxonomy table in v1.
3. **Commitments** — standalone structured deliverables; **no FK to the locked Manifesto content document** (`source_type='manifesto'` + human-readable `source_ref` lineage instead); commitments may exist independently; one commitment ↔ many projects, no hard coupling either way.
4. **Participation: five products, three instruments** — Consultations+Surveys share `governance_consultations` (kind discriminator); Polls get their own table (different response model); Petitions+Community Proposals share `governance_petitions` (origin discriminator, verification-before-results). External participation rides the Phase 9/10 contact-verification seam conceptually — no new identity system.
5. **Engagements are process; Events stay content** — `governance_engagements` owns agenda/stakeholders/attendance/issues/follow-ups with an *optional* link to a locked-module `events` row; no Events mutation, no Governance calendar.
6. **One canonical update model** — `governance_updates` with typed nullable subject FKs + single-subject CHECK, serving Projects/Commitments/Consultations/Petitions/Engagements; request lifecycle events stay in the append-only `governance_request_events` (Phases 6–10 semantics untouched).
7. **Accountability = one visibility taxonomy** (Private / Internal / Participant / Authenticated / Public), everything default-Private, publication an explicit audited act gated by `publish_accountability`, public consumption exclusively via narrow SECURITY DEFINER RPC projections; request statistics aggregates only.
8. **All cross-entity relationships optional** (request→project, petition→request, consultation→commitment, commitment↔projects, engagement→requests…), staff-created and audited; **no link grants authority**.
9. **Geography** — per-object scope child rows constrained to the five geographic scope values; `campaign` scope forbidden to Governance; `scope_covers`/`my_scopes` reused; no Governance geography.
10. **Exactly three new permissions, zero new roles** — `manage_projects` (projects+commitments), `manage_participation` (consultations/surveys/polls/petitions/engagements), `publish_accountability`. No per-instrument officer roles.
11. **Notifications/Media/Audit** — Core only: transactional notification intents (0021/0036 pattern), `core_delivery_intents` for external delivery, `media_assets` relations for evidence, `system_audits` with external attribution. No Governance duplicates of any.
12. **Module independence** — Governance depends on Core alone; optional links only (engagement↔event); no FKs to Campaign/Election/Social in either direction.
13. **Public IA** — one `/governance` hub + `/governance/participate`; `/request` + `/request/track` unchanged. Portal: Cases / Projects (commitments tab) / Participation (instrument tabs) / Engagements / Accountability. No Updates menu, no route proliferation.
14. **Lifecycle** — terminal records retained in place (institutional memory is a product goal); no archival infrastructure; deletion is tenant-offboarding via existing CASCADE.
15. **Analytics** — derived views only, no in-line denormalized counters; metric families classified by visibility tier.

## 4. Open decisions (intentionally unresolved, each owned by a future phase)

1. **Anonymous poll participation** + privacy-preserving dedup mechanism (no fingerprinting surface) — resolves before the Polls phase.
2. **External-participation UX per instrument** (one verified contact = one response) without cross-instrument linkage leaks — before Participation I.
3. **Petition signature-verification mechanics** (sampling vs. full, thresholds) — before Petitions.
4. **Statistics anti-re-identification buckets** for public request statistics — before Accountability.
5. **Search/analytics substrate ownership** — a platform/Core decision, not Governance's.

## 5. Recommended implementation sequence (proposed, not authorized)

```text
Phase 12 — Governance Delivery: Projects (+ milestones, governance_updates, geo scopes, manage_projects)
Phase 13 — Governance Commitments (reuses updates + geo scopes; commitment↔project links)
Phase 14 — Governance Participation I: Consultations & Surveys (+ manage_participation)
Phase 15 — Governance Participation II: Petitions & Community Proposals
Phase 16 — Governance Polls (resolves OPEN DECISION 1 first)
Phase 17 — Governance Engagements
Phase 18 — Governance Accountability (publication console, public projections, /governance hub)
Phase 19 — Governance Analytics & Institutional Memory
```

Projects first because they introduce the two shared substrates (updates, geo scopes) with the simplest consumer; accountability after publishable objects exist; analytics last over stable structures.

## 6. Security verification

Focused suite **20/20** (`governance-phase11-architecture.test.ts`):

- **A — Independence:** zero FKs from any `governance_%` table into Campaign/Election/Social/content tables; scope enum unchanged (6 values incl. `campaign`, untouched); module enum unchanged (4).
- **B — Substrate:** every `governance_%` table tenant-scoped with FORCE RLS; zero anon policies on any governance table; request status enum intact.
- **C — Freeze:** exactly `assign_cases, manage_cases, view_cases, view_governance` in the governance domain; zero occurrences of `manage_projects`/`manage_participation`/`publish_accountability`/`manage_governance`; no officer/citizen/customer role values.
- **D — Locked modules:** no new migrations in an architecture-only phase (count + highest-number pinned); no tracked migration modified; no future-cluster UI routes exist (`src/app/governance/*`, `portal/governance/projects`).
- **E — No duplicate Core systems:** no governance notification/audit/media/queue tables in the schema; Core `notifications`/`system_audits`/`media_assets` present; the gate document pins the single update model and the no-duplicates rule.
- **F — Intake compatibility:** anon still reads nothing from `governance_requests`; the tracking RPC's 5-OUT projection surface unchanged; all four public intake entry points still resolve; zero Firebase imports in `src` (docstring history excepted, per the Phase 5 boundary).

## 7. Regression

```text
Full regression:   727/727 (30 suites — 707 prior + 20 new; 0 skipped, 0 failed)
Focused suite:     20/20
TypeScript:        PASS (0 errors)
Build:             PASS
Lint (touched):    PASS (0 errors)
```

## 8. Boundary verification

```text
Social Force / Campaign / Election   unchanged (no tracked migration modified; suite D)
Notifications / Events / News /
  Announcements                      unchanged (schema probe E1/E3)
Core Identity / Geography / Audit /
  Media                              unchanged (A2, E3)
Firebase                             fully retired (F4 import scan)
user_access / Campaign Communications /
  Documents / Calendar               not recreated (non-goals §27, doc-pinned)
Governance notification/audit/media/
  update systems                     none exist (E1; updates proposed-only, pinned)
New citizen/customer identity        none (participant model unchanged, F)
SaaS postponement                    none — multi-tenancy is day-one architecture (§1, §20)
```

## 9. Architecture gate

```text
GOVERNANCE DELIVERY, PARTICIPATION & ACCOUNTABILITY ARCHITECTURE GATE: PASS
```

All required architecture decisions are sufficiently resolved for implementation; the five OPEN DECISIONs are phase-bounded and change no domain model.
