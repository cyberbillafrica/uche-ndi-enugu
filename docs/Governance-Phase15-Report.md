# PolitiCore — Governance Phase 15 Report

## Petitions & Community Proposals — Second Participation Instrument

**Status:** PHASE 15 — COMPLETE — **GATE: PASS**
**Parent architecture:** `docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md` (Phase 11, esp. §9)
**Preceding:** Phase 14 — Governance Consultations & Surveys — PASS (`docs/Governance-Phase14-Report.md`)
**Scope:** One canonical petition table (`origin` discriminator), one signature table, geographic scopes, the Phase 11 `pending → open` moderation intake for participant-originated proposals, verification-before-results enforced structurally, canonical update-subject extension, portal management + participant surfaces, security suite, hosted acceptance. No Campaign/Election/Social changes. No Manifesto change. No later Governance domain.

---

## 1. Phase status

```text
PASS
```

## 2. Migration list

| File | Purpose |
|---|---|
| `supabase/migrations/0052_governance_petitions.sql` | Primary Phase 15 migration — tables, enums, scopes, supports, update-subject extension, RPCs, RLS, notification helpers, public surface |
| `supabase/migrations/0053_petition_scope_shape_convergence.sql` | **Disclosed convergence** — repairs the ward branch of the petition scope-shape CHECK (0052 transcription defect, see §24.1) |
| `supabase/migrations/0054_petition_moderation_notice_convergence.sql` | **Disclosed convergence** — restates the moderation-notice fanout with data-driven recipients (0052 helper defect, see §24.2) |

0052 is uncommitted working-tree state, so its two defects were corrected in place for fresh databases **and** shipped as convergence migrations for the already-migrated hosted project — the prompt's §34 discipline (in-place edit alone would have left hosted running broken bodies).

## 3. Database objects

**Tables (3, all FORCE RLS, zero anonymous policies):**
- `politicore.governance_petitions` — canonical instrument; `origin petition|community_proposal` (closed enum), PP- reference (server-minted, immutable), title/demand, optional `target_signatures`, `draft|pending|open|closed|verified|results_published` lifecycle, `closes_at` (server-honored), `verified_count`/`verified_at` immutable snapshot, `results`/`results_summary` (require the verified state by CHECK), `is_public`/`published_at`, proposer invariant CHECK (a community proposal always has a server-resolved proposer participant)
- `politicore.governance_petition_supports` — one signature per participant per petition (`UNIQUE(petition_id, participant_id)`), optional comment (≤ 2000 chars, server-enforced), per-row `verified_at` stamp; append-only (no UPDATE policy exists)
- `politicore.governance_petition_scopes` — Core Geography scope rows, Phase-12/14 pattern verbatim; `scope_type <> 'campaign'` enforced by CHECK + RPC; per-level shape CHECK; unique per scope tuple

**Canonical substrate extension:**
- `governance_updates` + `petition_id`; single-subject CHECK restated over `project | commitment | consultation | petition` (exactly one); partial index; `public.governance_updates` view re-expanded

**Enums (2):** `governance_petition_origin`, `governance_petition_status`

**Triggers (5):** reference generator (PP-, assign-after-loop), identity guard (reference immutable; visibility flips GUC-gated), status-transition guard (belt-and-braces behind the RPC map), audit triggers ×3

**Functions:** `has_petition_geo_authority`, `assert_petition_authority`, `governance_notify_petition_open`, `governance_notify_petition_submitted` (0054 body), `create_governance_petition`, `update_governance_petition`, `set_governance_petition_status`, `verify_governance_petition`, `publish_petition_results`, `set_governance_petition_visibility`, `add_governance_petition_scope`, `remove_governance_petition_scope`, `sign_governance_petition` — plus 9 `public.*` wrappers (PostgREST convention)

**Policies (3, SELECT-only):** petitions (staff ∪ open ∪ own-proposal), scopes (staff-only), supports (staff ∪ own row via participant join). **No INSERT/UPDATE/DELETE policies — every mutation flows through the authority RPCs; institutional memory holds by RLS.**

**Permissions: +0. Zero new permissions, zero new roles.** Phase 11 §16 already places petitions under `manage_participation` ("create/run consultations, surveys, polls, petitions, engagements"). The catalog remains the seven-permission state.

## 4. Petition/Proposal model

One table, one `origin` discriminator — the Phase 11 §9 decision verbatim. A petition is staff-drafted collective support around a demand; a community proposal is the same accumulation mechanics with community intake. The distinction is data (`origin`) plus the intake rule, never separate tables, routes, or services. Columns are exactly the §9 set (title, demand, origin, proposer, target/threshold, lifecycle) — no speculative fields.

## 5. Participation/signature model

- **Authenticated members** sign with **no permission** — participant identity is the authorization (0034 principle), resolved server-side via the existing `governance_participants` model (created on demand; never client-supplied). No petition users, signatory roles, or supporter accounts.
- One signature per participant per petition, enforced by `UNIQUE(petition_id, participant_id)` **and** an explicit duplicate error.
- **No withdrawal or edit path** — Phase 11 §9 documents neither; supports are append-only and RLS-frozen.
- External contact-verified participation remains deferred (Phase 11 §29 open decision 2); anonymous participation not implemented (open decision 1 is bounded to Polls).

## 6. Verification model

Phase 11 §9 establishes **signature verification before results** and delegates sampling/volume mechanics to this implementation gate. The implemented model — the smallest complete one: closure, then a distinct staff verification act, then publication:

- `verify_governance_petition` requires `closed`, stamps every support row's `verified_at`, snapshots `verified_count` + `verified_at` on the petition (CHECK makes the snapshot immutable once written), and moves the petition to `verified`.
- Thresholds are **advisory** (Phase 11 makes `target_signatures` optional; staff judgment is the authority) — the verified count, not a naive `COUNT >= threshold`, is what publication requires.
- No OTP/email/phone/ID/dedup/fingerprint mechanics — verification is the existing staff authority act with an audited trail; no speculative providers.

## 7. Lifecycle

`draft|pending → open → closed → verified → results_published` — the Phase 11 §9 states plus the §4 participant-originated `pending` moderation intake.

- Staff-created petitions enter `draft`; member-originated community proposals enter `pending` (moderation is the control — gate §4/§131) and require staff approval to open.
- The status RPC accepts only `open`/`closed`; `verified` is reachable **only** through `verify_governance_petition` (requires closed); `results_published` **only** through `publish_petition_results` (requires verified + `publish_accountability`).
- A trigger guard re-enforces the transition map against any future direct path; reopening and re-verification are illegal; terminal records are retained (no DELETE path exists).
- `closes_at` is honored server-side (an open instrument past its deadline refuses signatures); content freezes after opening (`draft|pending`-only edits, moderation-correctable).

## 8. Results model

Exactly the §9/§11 documented concepts: collected count (staff surface), target (advisory), verified count (the authoritative datum, immutable snapshot), and an explicit published aggregate (`results_summary` + `results` jsonb) written only by `publish_petition_results`. No analytics, no demographic breakdowns, no heat maps, no independent dashboard. Individual signatures are never public (§12 boundary).

## 9. Permissions

`manage_participation` covers petition/proposal management end-to-end (staff creation, opening, verification, scoping), geo-scoped exactly like Phases 12–14. `publish_accountability` gates visibility flips and results publication. Participation and community-proposal intake need no permission (moderation `pending` is the intake control). **The seven-permission catalog is unchanged** — no `manage_petitions`, no `verify_petitions`, no per-instrument permissions, no new roles.

## 10. Geographic authorization

Core Geography reuse, Phase 12/14 pattern verbatim: `has_petition_geo_authority` evaluates the complete scope collection; `add_governance_petition_scope` validates the scope **being attached** against Core Geography and the caller's authority (bootstrap-correct); state grants cover descendants via `scope_covers`; scope-scoped grantees must deliver ≥ 1 authorized scope at creation (0049/0051 rule — no tenant-wide minting by omission); `scope_type='campaign'` is structurally impossible (CHECK + RPC).

## 11. Tenant isolation

Tenant resolved from the JWT everywhere (`current_tenant_id()` / profile lookup); tenant/actor/profile/participant identifiers are never accepted from the browser as authoritative. Cross-tenant reads return nothing (RLS), mutations raise ("not found"), signatures cannot cross tenants (participant resolution is tenant-bound), notification recipients are tenant-filtered. Proven in the focused suite (C3) **and** on hosted (J10a–c) against a real second tenant with real GoTrue identities.

## 12. Visibility/privacy

Phase 11 taxonomy: everything Private by default. Opt-in public projection (§12 of the gate: "Title, demand, support count, status; signatures never public") rides `is_public`, flipped only through the GUC-guarded RPC requiring `publish_accountability`, audited both directions. Drafts and `pending` proposals are staff-only (a proposer sees their own submission); open petitions are discoverable by members. Signature rows are staff-wide ∪ own-row only; verification stamps are internal; no public results API, no raw base-table access for anon (C2/J1).

## 13. Service layer

`src/lib/supabase/governance.ts` — new **PARTICIPATION — PETITIONS / COMMUNITY PROPOSALS (Phase 15)** section (no parallel file): types (`GovernancePetition`, `GovernancePetitionSupport`, `GovernancePetitionScope`, origin/status unions), `listPetitions` (origin/status/onlyOpen/search filters), `getPetition`, `listPetitionSupports`, `getMyPetitionSignature`, `listPetitionScopes`, `createPetition`, `updatePetition`, `setPetitionStatus`, `verifyPetition`, `publishPetitionResults`, `setPetitionVisibility`, `addPetitionScope`, `removePetitionScope`, `signPetition`, plus status/origin label maps. No browser-supplied actor or tenant identity anywhere.

## 14. UI/routes

Portal management (staff):
- `/portal/governance/participation` — existing list extended with a **Petitions & Community Proposals** table (origin/status/search filters, correct `petitions/[id]` links)
- `/portal/governance/participation/petitions/new` — creation form (origin, demand, target, closes_at, scopes)
- `/portal/governance/participation/petitions/[id]` — draft/pending editing (moderation-correctable), open/close, verification, results publication, opt-in visibility, scope management, confidential signature register

Participant surfaces (authenticated members):
- `/portal/governance/participate` — discovery list extended with open petitions/proposals
- `/portal/governance/participate/petitions/[id]` — signature flow (optional public-safe comment), one-signature confirmation, closure/expiry handling

Navigation is presentation-gated only (the existing Governance group); route guards fail closed; no separate top-level module, no calendar, no second participant dashboard. No public `/governance/*` hub (Phase 18).

## 15. Notifications

Core only, 0036/0051 best-effort intent pattern, recipients resolved server-side: **open invitation fanout** (tenant-wide or ward/LGA/PU-scoped, mirroring 0051) and the **moderation notice** to tenant admins + manage_participation grantees when a proposal lands (0054 data-driven body). Both are canonical `politicore.notifications` rows; failures RAISE WARNING and never corrupt the business mutation. No petition/proposal notification tables, no queues.

## 16. Media

Nothing in scope — the Phase 11 petition model stores relations, not files, and no attachment workflow exists in this slice; no media tables created; `media_assets` untouched (C18 pinned).

## 17. Audit

Canonical `politicore.system_audits` only: base audit triggers on all three tables plus explicit RPC audits with old→new for create/update/status/verification/results-publication/visibility/scope-removal and a signature audit. Attribution is the server-resolved `auth.uid()` (C16 suite proof + hosted J13/J13b — the signature audit carries the signer's own hosted uid). No petition audit tables.

## 18. Governance Updates integration

`governance_updates` gained `petition_id` with the single-subject invariant restated over four subjects and a partial index. The Phase 11 ERD names Petition an update subject, but no Phase 15 workflow emits delivery-narrative updates, so no update RPC shipped — the smallest complete slice (mirroring the Phase 14 decision); a later gate can add one without further substrate changes. Hosted proofs (J11b/c) confirm project and commitment updates still work.

## 19. Focused security suite

`tests/security/governance-petitions.test.ts` — **30/30 PASS** covering C1–C20: creation authority (staff permission + member intake + bootstrap rule), anon boundary, tenant isolation, module gating, the seven-permission catalog, geo authority (campaign/unknown/outside-scope fails), lifecycle (skipped transitions, RPC gating, trigger map, content freeze), participant integrity (server-resolved signer), duplicate rule, support immutability, verification-before-results (RPC + structural CHECK), verification authority, result publication (verified-gated, publish_accountability-gated, terminal), privacy (own-row, anon-zero), canonical updates (four-subject invariant; project + commitment substrates), audit attribution, canonical notifications **including the 0054 recipient-correctness pin**, media boundary, relationship FK sweep, and schema/security pins (FORCE RLS, PP- minting/immutability, closed origin vocabulary, proposer invariant).

## 20. Full regression

- Focused suite: **30/30**
- Full regression: **814/814 — 34 suites — 0 skipped — 0 failed** (baseline 784 + 30 new)
- TypeScript: **0 errors**
- Build: **PASS**
- Lint (all touched files): **0 errors, 0 warnings**

## 21. Hosted acceptance

`scripts/db/verify-hosted-smoke-governance-petitions.ts` against the real hosted Supabase (real GoTrue, JWT, PostgREST, RLS): **43/43** — anon zero-surface; staff petition creation with PP- minting; member-originated proposal → pending with server-resolved proposer; draft-only reads and open discovery; lifecycle gating incl. terminality; signing without permission + duplicate/closed/past-closes_at refusals; own-row privacy; ward-scoped manager create/refusals/campaign ban (0053 shape proven live); cross-tenant read/mutate/sign fail-closed; verification snapshot + publication gating + no republish; four-subject update invariant with project/commitment substrates intact; open fanout + moderation notices; audit attribution (RPC actions + signer identity); staff-origin creation refused for members.

**Hosted convergence note:** 0053/0054 applied through `apply-hosted` with genuinely discriminating signatures; hosted verification probed the corrected constraint text and the data-driven helper body — identical to local behavior (the harness precondition explicitly fails if either convergence is missing).

## 22. Hosted cleanup

Harness cleanup (FORCE-RLS relaxed → `session_replication_role=replica` multi-pass child-first purge → FORCE-RLS restored) covered all fixtures, geo rows, participants, notifications, grants, audits, and profiles via auth cascade. The post-run residue probe (16 dimensions) found only the known FORCE-RLS cascade no-op (4 tenants + 8 profiles); a one-off profile-first purge removed them, and the re-probe returned **residue 0 on all 16 probes**. Both temp scripts were deleted after use (disclosed per §35).

## 23. Locked-module verification

- Social Force, Campaign, Election, Notifications, Events, News, Announcements, Manifesto, Core Identity, Core Geography, Core Media, Core Audit — untouched (working tree shows only this phase's files plus the Phase 14-disclosed `0016` repair, preserved and **not** further modified per prompt §38).
- Projects preserved: hosted J11b + suite C15 create project updates through the canonical substrate.
- Commitments preserved: hosted J11c + suite C15 create commitment updates.
- Consultations/Surveys preserved: 0052's constraint restatement keeps the consultation subject; the Phase 14 suite passes unchanged in the full run.
- No FK from petitions into Campaign/Election/Social/Manifesto/Requests (C19); no link tables that could grant authority.
- No second notification/audit/identity/participant/update system (C5/C15/C16/C17 pins).
- Firebase remains fully retired — zero Firebase imports anywhere in src/scripts/tests.

## 24. Deviations

1. **0053 — petition scope-shape ward branch (disclosed).** The 0052 `governance_petition_scope_shape` CHECK transcribed the consultation constraint with `ward_id IS NULL` in the ward branch; the correct Core Geography shape requires `ward_id IS NOT NULL`. Every ward-scoped petition creation failed the constraint. Caught by the focused suite before any UI exercised it; fixed in place in 0052 (uncommitted file) **and** shipped as convergence 0053 for the already-migrated hosted DB. Its hosted-applier signature initially checked a literal that PostgreSQL's constraint normalization (explicit parentheses) doesn't produce; the signature was corrected to match the normalized text and verified by direct probe.
2. **0054 — moderation-notice recipients (disclosed).** The 0052 `governance_notify_petition_submitted` helper filtered its fanout with a caller-relative `has_permission('manage_participation')`, which evaluates the *submitter's* authority — for member-originated proposals (the normal intake), zero recipients matched and no notice was sent. Caught by hosted acceptance J12b; diagnosed by body probe; restated in 0054 (and in 0052) with data-driven recipients (tenant admins + permission grantees). The focused suite now pins the corrected shape (C17).
3. **Harness assertion mechanics** (not product defects): PostgREST returns 204 for void RPCs and bare scalars for scalar-returning functions — J8/J6f were updated to the convention.
4. **No petition update RPC shipped.** The substrate accepts petition subjects, but no Phase 15 workflow emits delivery-narrative updates (§18) — the smallest complete slice.
5. **D1 pin updated** (Phase 11 suite): migration count 54 → 55 with provenance for 0052/0053/0054.

## 25. Deferred items

- External contact-verified participation — deferred (Phase 11 §29 open decision 2 gates it)
- Anonymous participation — deferred (bounded to Polls; open decision 1)
- Signature withdrawal/editing — not documented in Phase 11 §9; append-only enforced
- Petition→Request linking (gate §9: "a petition may open a request") — deferred; a future gate should authorize the staff action with its own link-authority rules
- Petition update RPC — substrate ready, no emitting workflow yet
- Polls, Engagements, Accountability console/directory, Governance Analytics, Institutional Memory — not implemented; no placeholders exist (`src/app/portal/governance/` contains exactly cases, categories, participate, participation, projects, requests)

## 26. Architecture integrity

```text
Phase 11 Architecture
        ↓
Phase 12 Projects               PASS
        ↓
Phase 13 Commitments             PASS
        ↓
Phase 14 Consultations/Surveys   PASS
        ↓
Phase 15 Petitions/Proposals     PASS   ← THIS PHASE
        ↓
Phase 16 Polls                   NOT IMPLEMENTED
        ↓
Phase 17 Engagements             NOT IMPLEMENTED
        ↓
Phase 18 Accountability          NOT IMPLEMENTED
        ↓
Phase 19 Analytics/Memory        NOT IMPLEMENTED
```

One canonical petition table; one signature table; one participant model; one verification model; one notification, audit, geography, and identity system; one update substrate (four subjects, single-subject invariant intact); zero parallel systems.

---

## FINAL GATE

```text
════════════════════════════════════════════════════
 GOVERNANCE PETITIONS & COMMUNITY PROPOSALS — PHASE 15: PASS
 3 MIGRATIONS · 3 TABLES · 22 FUNCTIONS · +0 PERMISSIONS
 SUITE 30/30 · REGRESSION 814/814 · HOSTED 43/43
 TSC 0 · BUILD PASS · LINT 0 · HOSTED PRISTINE
════════════════════════════════════════════════════
```

Every §40 gate condition verified: architecture compliance (Phase 11 §9/§4 model, lifecycle, verification-before-results, moderation intake); local security (30/30); hosted security (43/43 against real GoTrue/PostgREST/RLS); tenant isolation proven in both environments; module gating in the database; participation integrity (server-resolved identity, duplicate rule, append-only supports); verification-before-results enforced structurally (RPC gating + immutable snapshot CHECK); convergence migrations idempotent with genuinely discriminating signatures; cleanup with residue 0; locked modules untouched (the Phase 14-disclosed `0016` repair preserved, not extended); Firebase fully retired; no later Governance domain implemented.
