# POLITICORE — GOVERNANCE PHASE 18 REPORT

## STATUS: COMPLETE
## GATE: PASS

**Preceding:** Phase 17 — Governance Engagements — COMPLETE/PASS (866/866 · 36 suites · hosted 44/44 · residue 0)
**Next planned phase:** Phase 19 — Governance Analytics & Institutional Memory

---

## Migration list

| Migration | Purpose |
|---|---|
| `0057_governance_accountability.sql` | Phase 18 accountability layer: hardened publication authority (A), privacy buckets (B), public SECURITY DEFINER projections (C), privacy-bucketed request statistics (D), public.* wrappers (E). Applied **first-pass** on local (PGlite) and hosted — **no convergence migrations needed**; registered in `apply-hosted.ts` with a discriminating signature (stats RPC exists + `publish_accountability` inside the project-visibility function body + bucket helper exists). |

## Tables added/changed

**None.** Zero new tables, zero ALTERs. Publication rides the existing `is_public` / `published_at` columns that every canonical Governance table has carried since Phases 12–17. The prompt's §4 prohibition (no `public_projects`, `public_commitments`, …) is enforced both by design and by a suite pin (`A18`).

## Functions/RPCs

**Publication authority (restated in 0057, same signatures):**
- `politicore.set_governance_project_visibility(uuid,boolean)` — now requires `publish_accountability` (admin bypass intact) **in addition to** retained `assert_project_authority`
- `politicore.set_governance_commitment_visibility(uuid,boolean)` — same unification
- `politicore.set_governance_update_visibility(uuid,boolean)` — same gate (a public update is a public payload); subject authority retained
- Public one-line wrappers for all three (PostgREST-resolvable, anon-revoked)

**Privacy buckets (Phase 11 §29 Open Decision 4 — resolved):**
- `politicore.governance_privacy_bucket(integer)` → `0 | 1-5 | 6-20 | 21-50 | 51+`
- `politicore.governance_privacy_duration_bucket(numeric)` → `— | <=7 | 8-30 | 31-90 | 90+`
- Both revoked from every role (internal helpers)

**Public projections (SECURITY DEFINER read RPCs, 16 functions + 16 public.* wrappers):**
- `public_governance_hub(slug)` — published counts + `stats_available`
- `public_governance_projects/_project/_project_milestones/_updates(slug[,ref])`
- `public_governance_commitments/_commitment/_commitment_projects`
- `public_governance_participate(slug)` — open consultations/surveys, open published petitions, closed polls with published aggregates
- `public_governance_consultation/_petition/_poll`
- `public_governance_engagements/_engagement/_engagement_updates`
- `public_governance_request_stats(slug)` — ward/lga/state aggregate rows
- Projection RPCs keep anon EXECUTE (required by the wrapper chain, 0007/0037 convention); every other new function is revoked

## Views/projections

No views. The 0034/0047 security-invoker `public.*` view layer for canonical tables is **unchanged** (still authenticated-only via RLS, zero anon). All new public consumption flows exclusively through the narrow SECURITY DEFINER RPCs above — explicit column allowlists, never `SELECT *`.

## Service changes

`src/lib/supabase/governance.ts` gained the **ACCOUNTABILITY — PHASE 18** section: allowlist types (`PublicGovernanceHub`, `PublicGovernanceProject`, …, `PublicGovernanceRequestStat`) and 16 typed read functions (`listPublicGovernanceHub` … `listPublicGovernanceRequestStats`), plus `setCommitmentUpdateVisibility`-style naming left to the existing phase functions — `setProjectVisibility` / `setCommitmentVisibility` / `setProjectUpdateVisibility` already existed and now transparently hit the 0057-hardened RPCs. No `accountability.ts` (prompt §26 respected: one Governance service). The service accepts only a public site slug for projections — never tenant/actor/authority.

## Routes

**Public (new):** `/governance` (hub), `/governance/participate`, `/governance/participate/[kind]/[reference]` (one discriminated detail route per Phase 11 §22 — per-instrument top-level routes remain rejected), `/governance/projects/[reference]`, `/governance/commitments/[reference]`, `/governance/engagements/[reference]`, `/governance/statistics`. Header nav gained a **Governance** link. All build-verified (7 routes in the Next build manifest).

**Portal (existing, publication controls already present):** Projects detail, Commitments detail, Participation detail, Polls detail, Engagements detail each already carry the publish/retract control + per-update visibility toggles; after 0057 they all enforce `publish_accountability` server-side. No new management module (prompt §27).

## Permissions

**Zero changes.** The governance domain remains exactly the seven-permission catalog (pinned in suite `A2`, mirroring the Phase 15 pin): `assign_cases`, `manage_cases`, `manage_participation`, `manage_projects`, `publish_accountability`, `view_cases`, `view_governance`. No new roles.

## Security model

```
Canonical tables (FORCE RLS, zero anon policies — unchanged, re-proven)
      ↓ explicit publication via authority RPC (manage-geo authority AND publish_accountability; audited; server-side tenant/actor)
      ↓ narrow SECURITY DEFINER projection (tenant by PUBLIC site slug; record by reference_code; explicit columns; per-domain eligibility)
Public / authenticated consumption (public.* wrapper chain; anon-executable RPC, zero base-table access)
```

Publication eligibility per domain (enforced inside the projections): projects/commitments `is_public`; consultations expose `results` only in `results_published`; petitions expose aggregate `verified_count`/`results` only; polls only `closed AND results IS NOT NULL`; engagements always roster-free. Unpublication is the same explicit RPC in reverse (stamps `published_at = NULL`), equally audited.

## Public projections

Explicit allowlists only. Verified absent from every projection: `tenant_id`, `owner_profile_id`, `created_by`, `is_public`, `participant_id`, internal audit/authorization metadata, contact fields. Engagements additionally exclude stakeholder/attendance/issue data *structurally* — the RPC selects nothing from those tables except an attendance **count** (gate §12: "attendance is a count"). Raw uuids are not exposed; records are addressed by `reference_code` + public site slug.

## Publication workflow

`publish_accountability` holder (or admin) → existing detail-surface control → authority RPC → atomic `is_public`/`published_at` write (guard trigger still blocks any direct-table path — re-proven in `A6` even against `service_role`) → Core Audit row with server-resolved `auth.uid()`. Reverse for retraction.

## Visibility model

Private (default) / Internal / Participant / Authenticated / Public per gate §12 — unchanged; no new semantics. Publication is never inferred (not from concluded/open/public-Event status). Public projection requires `is_public` AND the domain's eligibility; Event visibility is independent of Engagement visibility; the linked Event appears in the public engagement only if the Event itself is `published`, and never grants authority.

## Request statistics/privacy model

**Phase 11 §29 Open Decision 4 resolved with provenance.** Buckets `0 | 1–5 | 6–20 | 21–50 | 51+` (the prompt's endorsed ladder); durations `— | <=7 | 8–30 | 31–90 | 90+` days (median). Rationale: counts 1–5 are the reidentification tail — "Ward X: 1 request" can identify a citizen and their circumstances — so the band is merged; ≥6 carries real accountability signal while no individual is distinguishable. No category×geo cross-slices; no case contents (title/details/contact/reference are structurally absent from the projection); no differential-privacy machinery. Proven on hosted: a ward with exactly 1 resolved request reads `1-5`, and the payload contains none of the seeded case text.

## Focused security

`tests/security/governance-accountability.test.ts` — **25/25** (A1–A18 + cross-tenant section). Covers: publication authority split (manager-without-publish denied; publisher-without-manage denied; admin works), catalog pin, tenant isolation, private invisibility + no existence oracle, audited publication/unpublication with server-resolved actor, service_role direct-write guard, per-domain allowlists, consultation/petition/poll/engagement privacy (responses/signatures/votes/rosters structurally unreachable, base tables anon-deny), updates eligibility, bucketed statistics with a live reidentification probe, FORCE-RLS + zero-anon-policy pin across all 21+ governance tables, wrapper executability (behavioral + ACL), no-duplicate-model/role pin.

## Full regression

**891/891 passed — 37 suites — 0 skipped — 0 failed** (baseline 866/836 + 25 new). The two superseded Phase 11 pins were updated with provenance, not weakened: D1 (migration count 58, `0057` terminal — Phase 18 is its authorizing gate) and D4 (the public `/governance/*` hub routes now exist, authorized by this phase; the portal accountability console and later-cluster routes remain prohibited). TypeScript 0 errors. Build PASS. Lint 0 errors / 0 new warnings (one prior-phase `layout.tsx` warning remains, predating this phase).

## Hosted acceptance

`scripts/db/verify-hosted-smoke-governance-accountability.ts` — **28/28** on the real hosted stack (real GoTrue identities, real JWTs, real PostgREST, real RLS): J1 anon zero surface · J2 anon CAN use the public projections + no existence oracle · J3 publication authority split + real-uid audit · J4 private invisible / published visible · J5 allowlist columns · J6 commitment + delivery links · J7 update eligibility · J8 roster-free engagement · J9 petition aggregate-only · J10 poll lifecycle-gated aggregate-only + votes unreachable · J11 consultation responses unreachable · J12 bucketed statistics (1-request ward → `1-5`; no case contents) · J13 cross-tenant publication fails closed · J14 audited unpublication.

## Hosted residue

**0 across all 19 probe dimensions** (tenants, profiles, auth users, projects, commitments, engagements, petitions, polls, consultations, updates, participants, requests, grants, audits, notifications, states/zones/LGAs/wards). The harness cleanup restores FORCE-RLS on every table it touched; the two survivors of the known FORCE-RLS-noop pattern (profiles/tenants) were removed via the disclosed one-off purge, then re-probed pristine. Temp scripts deleted.

## Locked-module verification

Social Force, Campaign, Election, Core Identity/Auth, Core Geography, Core Notifications, Core Media, Core Audit, Events, News, Announcements, Manifesto, Projects, Commitments, Consultations/Surveys, Petitions/Community Proposals, Polls, Engagements — **untouched**. No architecture, lifecycle, permission or schema changes in any locked module. Events: zero reverse dependencies from Governance; the engagement→event link stays one-way, optional, `ON DELETE SET NULL`. Firebase: 0 references in 0057; the tracked-modification sweep matches prior phases (the only pre-existing exception remains the disclosed Phase 14 `0016_election_seed.sql` repair, preserved not extended).

## Deviations

1. **Publication-authority hardening touches Phase 12/13 RPCs** — restating `set_governance_project_visibility` / `set_governance_commitment_visibility` / `set_governance_update_visibility` to add the `publish_accountability` gate. This is a strictly-tightening change to shared Governance substrate (not a locked-module redesign) required by prompt §6/§7 ("one publication authority"); operational authority via the existing `assert_*_authority` is retained, so managers can still manage — they just can no longer publish. Two prior suites asserted the old weaker behavior; they were not weakened — the manager in them holds `manage_projects` only and still exercises create/manage paths; the publication assertions moved to the admin actor, consistent with the new (correct) gate.
2. **`GOVERNANCE_PUBLIC_*_LABELS` re-export abandoned** — the label constants live in `governance.ts` itself; public pages consume the existing exports directly instead of a self-reexport.
3. **A17 privilege check is behavioral + ACL-based** — PGlite cannot parse `has_function_privilege(name, text)` string forms (probed; discarded), so wrapper executability is proven by anon actually executing the wrapper chain, anon being denied the politicore-layer authority RPCs, and direct `proacl` inspection.
4. **Harness J11b asserts base-table denial rather than a full anon submit attempt** — the Phase 14 response RPC is authenticated-only by design; J11a proves the underlying responses table is unreachable by anon, which is the security property this phase owns.

## Deferred items

- Portal **Accountability console** (`/portal/governance/accountability`) — Phase 11 §23 envisions it; existing per-detail publication controls fully cover Phase 18's §27 requirements, so the console stays deferred to the Analytics phase alongside operational statistics.
- Search substrate beyond the projections — Phase 11 §29 Open Decision 5 remains platform-level; hub discovery is a plain projection read, no new search infrastructure (prompt §29).
- Public engagement detail remains authenticated-portal-scoped for *participation* (none exists); the public surface is the read-only process record.

## Architecture integrity

ONE Governance data model (zero new tables) · ONE publication authority (`publish_accountability`, now actually unified) · ONE visibility model (gate §12 taxonomy, unchanged) · ONE participant system · ONE authorization system (seven permissions) · ONE geography system (Core reuse; campaign scope still forbidden) · ONE notification system · ONE audit system · ONE media system (untouched) · ONE canonical Governance Updates substrate (five subjects, poll excluded — re-proven) · NARROW public projections (no anon base-table access anywhere).

```text
════════════════════════════════════════════════════
 GOVERNANCE ACCOUNTABILITY — PHASE 18: PASS
 1 MIGRATION · 0 NEW TABLES · 6+32 FUNCTIONS · +0 PERMISSIONS
 SUITE 25/25 · REGRESSION 891/891 · HOSTED 28/28
 TSC 0 · BUILD PASS · LINT 0 · HOSTED RESIDUE 0 (19 probes)
════════════════════════════════════════════════════
```

## Final gate

**GOVERNANCE ACCOUNTABILITY — PHASE 18: PASS**
