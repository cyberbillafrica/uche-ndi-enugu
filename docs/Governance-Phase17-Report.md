# PolitiCore — Governance Phase 17 Report

## Engagements (Governance process record)

**Status:** PHASE 17 — COMPLETE — **GATE: PASS**
**Architecture source:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md` (§10 Engagements; §16 permission catalog; §11 canonical-update substrate; roster-privacy decisions)
**Preceding:** Phase 16 — Governance Polls — COMPLETE (837/837 · 35 suites · hosted 37/37 · residue 0)
**Next planned phase:** Phase 18 — Governance Accountability

```text
════════════════════════════════════════════════════
 GOVERNANCE ENGAGEMENTS — PHASE 17: PASS
 1 MIGRATION · 5 TABLES · 30+2 FUNCTIONS · +0 PERMISSIONS
 SUITE 29/29 · REGRESSION 866/866 · HOSTED 44/44
 TSC 0 · BUILD PASS · LINT 0 · HOSTED PRISTINE
════════════════════════════════════════════════════
```

---

## 1. Architecture source — Phase 11 decisions used

- **§10 Engagements:** a first-class Governance **process** record owning agenda, stakeholders, attendance, issues raised, and follow-ups; Events remain CONTENT; linkage is optional and one-way.
- **§16 permission catalog:** Engagement management under the existing `manage_participation` (geo-scoped); publication under `publish_accountability`; **zero new permissions, zero new roles**.
- **§11 Governance Updates:** Engagement is an update **subject** — the canonical `governance_updates` substrate is extended to five subjects; follow-ups ARE updates.
- **Roster privacy:** stakeholders and attendance are staff surfaces, never public PII; attendance is staff-recorded (no self-service in this slice).
- **Geography/Notifications/Audit/Media:** Core reuse only.

## 2. Migration list

| Migration | Purpose |
|---|---|
| `0056_governance_engagements.sql` | The Engagements slice: 5 tables, 2 enums, authority RPCs, guards, RLS, update-subject extension, notification intent, public data-API surface. |

**No convergence migrations were required** — 0056 applied cleanly on both the local (PGlite) and hosted databases, first pass, with convergence proven by direct schema/function probes before acceptance.

## 3. Database objects

- **Tables:** `governance_engagements` (process record), `governance_engagement_scopes`, `governance_engagement_stakeholders`, `governance_engagement_attendance`, `governance_engagement_issues` — all `FORCE ROW LEVEL SECURITY`.
- **Enums:** `governance_engagement_status ('draft','scheduled','concluded')`, `governance_engagement_issue_status ('open','addressed','closed')`.
- **Column:** `governance_updates.engagement_id` (fifth subject FK, `ON DELETE CASCADE`), restated single-subject CHECK, partial index, re-expanded `public.governance_updates` view.
- **Triggers:** reference generator (`EN-` + 8 hex), identity guard (reference immutable; visibility RPC-gated), lifecycle guard (`draft→scheduled→concluded` only), content guard (sealed at conclusion), canonical audit triggers on all five tables.
- **Functions:** `validate_engagement_agenda`, `has_engagement_geo_authority`, `assert_engagement_authority`, `governance_notify_engagement_scheduled`, plus 14 authority RPCs (create/update/link/unlink-event/status/visibility/add-remove-scope/stakeholder/attendance/issue/update) and 14 `public.*` PostgREST wrappers with explicit anon/PUBLIC revokes.

## 4. Engagement model

Canonical process record with server-minted `EN-` reference, tenant + `created_by` server-stamped, agenda (validated JSON array: unique ids, ≤50 items, bounded lengths), optional `event_id`, `scheduled_at`/`held_at` (`held_at` stamped exactly by the conclusion act via a `CHECK`), location, outcomes. No speculative fields. **Events = content; Engagements = process** — preserved exactly.

## 5. Event relationship (one-way, optional, non-authoritative)

`governance_engagements.event_id → politicore.events` with `ON DELETE SET NULL`. Link/unlink are explicit authority RPCs that re-verify **same-tenant existence** and **never mutate the Event**; Event visibility never grants Engagement authority (proved by the viewer-attempt test); deleting the linked Event cannot corrupt the Engagement (`SET NULL` proven on hosted). Events remain LOCKED and Governance-independent; no reverse FK exists.

## 6. Agenda

Structured Engagement data (JSON array, no separate module/scheduler). Server-validated at create and update (ids unique/non-empty, titles required, lengths capped). Frozen at conclusion (RPC gate + trigger guard). Editing surface: draft-time agenda editor on create; JSON edit on the detail Overview tab while not concluded.

## 7. Stakeholders

Rows reference the existing `governance_participants` model — **no new identity, no stakeholder roles**. `role_label` is free text (never a role). The participant row is validated **in-tenant server-side**; the browser cannot assign arbitrary users. Upsert semantics (`UNIQUE(engagement_id, participant_id)`); removal is tenant-checked and audited. Read surface: staff-only (`view_governance`/admin).

## 8. Attendance

Staff-recorded roster (no self-service — proved: a member's self check-in is refused). One row per participant (`UNIQUE`, duplicate rejected). `recorded_by` carries the server-resolved staff uid. Read surface staff-only; never public; never an Event RSVP; no Campaign attendance reuse.

## 9. Issues

Engagement-local process records (`title/detail/status`). **Not** auto-converted to `governance_requests`: the request link is an explicit, staff-authorized, tenant-bound act (`p_link_request` + same-tenant request validation). Linking grants no authority. Status vocabulary is bounded (`open|addressed|closed`); illegal values rejected. Direct-table writes fail closed (no INSERT/UPDATE policies).

## 10. Follow-ups

**Follow-ups ARE updates** (Phase 11 §10/§11): the `create_governance_engagement_update` RPC writes canonical `governance_updates` rows with `engagement_id` as the subject — one substrate, no parallel tables (`governance_engagement_updates`/`engagement_activity_log` proven absent). Kinds reuse the existing `governance_update_kind` enum; public rows require the visibility semantics of the substrate.

## 11. Lifecycle

`draft → scheduled → concluded` — simple process lifecycle per Phase 11 (no voting/verification/moderation states). Enforced twice: authority RPCs + a `BEFORE UPDATE` guard trigger. `draft→concluded` rejected; backward transitions rejected; `concluded` seals title/description/location/scheduling/agenda/event-link (RPC + trigger); scope changes frozen at conclusion; `held_at` stamped exactly at conclusion; terminal records retained (no delete path).

## 12. Geography

Core Geography reuse exactly (`State → Senatorial Zone → LGA → Ward → Polling Unit`). Scope attach validates the attached scope against Core Geography and the caller's authority **for that scope** (bootstrap-correct: scope-scoped grantees cannot mint tenant-wide engagements by omission; descendant PU-under-ward attach works; unrelated scope, `scope_type='campaign'`, and unknown geography all fail closed).

## 13. Permissions

The seven-permission catalog is pinned unchanged by the focused suite (`assign_cases, manage_cases, manage_participation, manage_projects, publish_accountability, view_cases, view_governance`). No `manage_engagements`/`manage_attendance`/`manage_stakeholders`/`verify_engagement`/`publish_engagement` exists. No new roles.

## 14. Visibility

Engagements default **Private** (drafts staff-only). `is_public=true` makes the record visible to authenticated tenant members ("Authenticated" level) — flipped only by the audited, `publish_accountability`-gated RPC (direct-table flips are silent no-ops under RLS). Stakeholders/attendance remain staff-only even when public; issues admit only the raising participant's own row; anon holds nothing. Event visibility is independent.

## 15. Governance Updates

`governance_updates_single_subject` restated to **exactly one of** `project | commitment | consultation | petition | engagement`. The suite proves the constraint text, a genuine two-subject insert rejection, and that project + commitment updates still work; hosted acceptance re-proves the constraint plus a live project update. **Poll remains excluded** (not a subject). No poll/engagement-specific update tables exist.

## 16. Notifications

`governance_notify_engagement_scheduled` fires on scheduling (best-effort, warning-on-failure per the 0036 pattern). Recipient selection is **data-driven from the profile dataset** (tenant + ward/LGA/PU scope match) — the Phase 15 caller-relative `has_permission()` bug pattern is structurally absent (asserted on the function body). Recipient correctness proven on hosted: the ward resident is notified; the wardless member and the cross-tenant isolation profile are not. No parallel notification infrastructure.

## 17. Audit

Core `politicore.system_audits` only — canonical trigger audits on all five tables plus RPC audits for create/update/status/link/unlink/stakeholder/attendance/issue/update/visibility with server-resolved `auth.uid()` attribution (proven both locally and on hosted against real uids). No audit records exposed publicly.

## 18. Media

Not required by this slice — untouched, per the prompt. (The update RPC's optional `evidence_asset_id` validates against Core `media_assets` same-tenant, reusing the existing commitment-update convention; no new media tables/services exist.)

## 19. Service layer

`src/lib/supabase/governance.ts` gained the `ENGAGEMENTS — PHASE 17` section: `listEngagements`, `getEngagement`, `listEngagementScopes/Stakeholders/Attendance/Issues/Updates`, `createEngagement`, `updateEngagement`, `linkEngagementEvent`, `unlinkEngagementEvent`, `setEngagementStatus`, `setEngagementVisibility`, `add/removeEngagementScope`, `add/removeEngagementStakeholder`, `record/removeEngagementAttendance`, `createEngagementIssue`, `updateEngagementIssue`, `createEngagementUpdate` — typed, tenant/actor never accepted from the browser, no `src/lib/supabase/engagements.ts`.

## 20. UI/routes

- `/portal/governance/engagements` — management list (status badges, EN- refs, Event-link indicator), guarded by `resolveGovernanceAccess`.
- `/portal/governance/engagements/new` — creation with agenda editor, optional Event link, scope drafts.
- `/portal/governance/engagements/[id]` — detail with **Overview / Agenda / Stakeholders / Attendance / Issues / Updates** sections (one surface, not six modules), lifecycle controls, scopes, visibility, and the sealed-state disclosure.
- Portal nav gained the Engagements entry (Governance cluster, staff-gated).
- No participant self-service surfaces were built (Phase 11 authorizes none for engagements in this slice); no separate dashboards for children; no Governance calendar.

## 21. Focused security

`tests/security/governance-engagements.test.ts` — **29/29 pass** (C1 authority · C2 anon boundary · C3 tenant isolation · C4 module gating · C5 permission catalog · C6 geography incl. bootstrap rule · C7 lifecycle + sealing · C8 event separation incl. cross-tenant link rejection and `ON DELETE SET NULL` · C9 agenda validation · C10 stakeholders incl. upsert and foreign rejection · C11 attendance integrity · C12 issues + request linkage · C13 canonical five-subject invariant · C14 audit attribution · C15 recipient-correct notifications · C16 media boundary · C17 privacy/visibility · C18 schema pins incl. no `governance_events`, no Campaign/Election/Social FKs, no Firebase).

## 22. Full regression

**866/866 across 36 suites — 0 skipped, 0 failed** (baseline 837 + 29). The only prior-phase assertions touched were the two Phase 11 D-pins that Phase 17 necessarily supersedes (migration count 56→57 with 0056; the engagements portal route now authorized) — updated with provenance comments, not weakened.

- TypeScript: **0 errors**
- Build: **PASS**
- Lint: **0 errors / 0 new warnings** (two pre-existing `layout.tsx` warnings predate this phase — verified against HEAD, my diff adds neither line)

## 23. Hosted acceptance

`scripts/db/verify-hosted-smoke-governance-engagements.ts` — **44/44** against real GoTrue identities, real JWTs, real PostgREST, real RLS: anon zero surface; creation + `EN-` reference; RLS draft visibility; lifecycle; agenda validation; same-tenant Event link/unlink with the Event untouched; stakeholders/attendance/issues; engagement update as canonical substrate row; five-subject constraint; scope authority (incl. campaign + unknown-geo refusals); visibility gating + roster privacy while public; recipient-correct fanout; tenant isolation; audit attribution; unauthorized creation refusal; content sealing.

Deviations in harness mechanics (disclosed): (a) J10's verification query was rewritten after the first run — the original aliased `engagement_id::text` to an unread name (my query bug, not a product defect); (b) cleanup follows the established FORCE-RLS procedure, restoring the state on all 39 touched tables.

## 24. Hosted cleanup

Final residue probe — **0 on all 18 dimensions**: tenants, profiles, auth.users, engagements + all child tables, participants, events, grants, notifications, audits, all four geography levels, and zero FORCE-RLS regressions (`relforcerowsecurity=false` count 0 across `governance_%`). The known Phases 12–16 survivor pattern (FORCE-RLS no-op on tenant/profile deletes) was purged with the established one-off procedure (profiles before tenants), which also cleared the remaining prior-phase stragglers; temp scripts deleted after the run.

## 25. Locked-module verification

- Social Force, Campaign, Election, Core Identity/Auth, Core Geography, Core Notifications, Core Media, Core Audit, Events, News, Announcements, Manifesto — **untouched**.
- Governance Projects / Commitments / Consultations / Petitions / Polls — untouched; all prior suites pass unmodified.
- `0016_election_seed.sql` — the previously disclosed Phase 14 repair is preserved, not extended (tracked-modification sweep shows only Phase 17 files + that disclosed exception).
- Events remain fully independent: one-way optional FK, never mutated, never an authority source, no `governance_events`.
- Firebase remains fully retired (zero mentions in Phase 17 files).

## 26. Deviations

1. **Phase 11 D-pin updates (2)** — D1 migration count and D4 route prohibition necessarily move because Phase 17 is the authorizing gate; provenance comments added (same pattern as Phases 15/16).
2. **Harness query fix (hosted J10)** — aliasing bug in my first verification query; corrected; the underlying product behavior was correct on the first run.
3. **Residue purge scope** — the one-off purge also removed two prior-phase tenant/profile stragglers (`govgt-*`, `govint-*` slugs) disclosed for full transparency.
4. **Suite fixture detail** — Governance participant rows for portal profiles are provisioned explicitly in the suite (the signup trigger does not auto-create them in the local harness); production flows provision via the existing intake/participation paths.

## 27. Deferred items

- Participant self-service interaction with engagements (attendance confirmation, stakeholder acknowledgement) — Phase 11 authorizes none for this slice.
- Public Engagement projection — Phase 18's narrow `publish_accountability` surface.
- Engagement media/attachments — Core Media reuse is available but no workflow is authorized here.
- Governance Accountability, Analytics, Institutional Memory, public hub, external participation beyond existing authorizations — next phases.

## 28. Architecture integrity

End state: one Governance module · one Engagement process model · one Event content model · one Core identity system · one participant system · one authorization system · one geography system · one notification system · one audit system · one media system · one canonical Governance Updates substrate (five subjects, invariant enforced).

```text
GOVERNANCE ENGAGEMENTS — PHASE 17: PASS
```
