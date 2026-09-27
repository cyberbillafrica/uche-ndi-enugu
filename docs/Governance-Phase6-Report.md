# PolitiCore — Governance & Citizen Engagement Architecture Gate Report (Phase 6)

**Status:** PHASE 6 — COMPLETE (architecture gate; §31 A–O in `docs/Governance-Architecture-Gate.md`)
**Preceding:** Final Firebase Boundary — COMPLETE (`FIREBASE FULLY RETIRED`)
**Scope:** Governance module boundary, activation, authorization, participant model, minimum first-slice schema, RLS, authority RPCs, audit, security suite, hosted acceptance. **No Governance UI** (§35 — next phase implements the first slice on this substrate).

---

## A. What was built

1. **Migration 0034 — `governance_architecture_gate.sql`.** The minimum first-slice model under the existing tenant architecture:
   * `governance_participants` — the tenant↔person engagement record, deliberately distinct from auth identity (optional 1:1 `profiles` link; contact-based anonymous participants; `display_label` for tenant-type wording).
   * `governance_request_categories` — tenant-defined taxonomy.
   * `governance_requests` — the case aggregate with `GR-YYYY-XXXXXXXX` reference codes, optional geography FKs (ward/LGA/PU), feedback columns, and a **status-ladder guard trigger** (`submitted → acknowledged → assigned → in_progress → awaiting_information → resolved → closed`, `+ rejected`).
   * `governance_request_events` — one **append-only** trail (acknowledgement/assignment/status/staff & participant responses/resolution/feedback) instead of six speculative tables; tamper trigger + no UPDATE/DELETE path for any role.
   * `governance_assignments` — staff responsibility with optional scope.
   * 4 domain permissions (`view_governance`, `view_cases`, `manage_cases`, `assign_cases`) — submission intentionally NOT a permission (any member of a governance-enabled tenant may submit).
   * 6 SECURITY DEFINER authority RPCs (submit/acknowledge/assign/status/respond/rate) with server-resolved actor/tenant, `module_enabled('governance')` fail-closed checks, thin `public.*` SQL wrappers (0028 convention), FORCE RLS per table, security_invoker views + exact grants, canonical `system_audits` triggers.

2. **Migration 0035 — `public_surface_grant_hygiene.sql`** (discovery-driven; see F).

3. **Security suite** — `tests/security/governance-architecture.test.ts`: **14 tests** covering the module gate, participant provisioning + reference codes, ownership vs queue visibility, cross-tenant assignee rejection, the full RPC lifecycle, ladder-guard rejection + RLS no-op semantics, internal-response privacy, append-only trail, feedback contract (owner-only/resolved-only/once), canonical audit attribution, anonymous fail-closed, cross-tenant isolation, category governance, and the participant identity model.

4. **Hosted acceptance harness** — `scripts/db/verify-hosted-smoke-governance.ts`: 16 journeys over real GoTrue/PostgREST/RLS, with full fixture cleanup.

5. **§31 architecture document** — `docs/Governance-Architecture-Gate.md` (A–O complete).

## B. Module-boundary verification

* Governance is a **peer module**: `'governance'` already in `module_code_enum` (0001), provisioned disabled (0011), independently activatable, zero Campaign/Election references, zero content-domain coupling, zero election FKs.
* Reuses: Core identity, tenancy, authorization primitives (`has_permission`/`scope_covers`/grants), geography, canonical audit. No `governance_audit_logs`, no governance notifications, no governance media, no second activation mechanism, no `citizen_*` access roles.
* UI: none built (gate boundary); navigation rule (`module_enabled('governance')` + `view_governance`) documented in §28 of the gate doc.

## C. Verification

| Gate | Result |
| --- | --- |
| Fresh local apply (PGlite, 0001–0035) | clean |
| Governance security suite | **14/14** |
| Full regression | **644/644 across 24 suites, 0 skipped/failed** (630 + 14, exact) |
| TypeScript | **0 errors** |
| Production build | **PASS** |
| Touched-file lint | **0 errors** |
| Hosted apply | 0034 + 0035 live; `HOSTED MIGRATIONS OK`; all 5 governance tables FORCE RLS; hosted state verified clause-by-clause against the migration contract |
| Hosted acceptance | **16/16** |
| Hosted pristine | 0 fixture residue (incl. run-1 cleanup via `session_replication_role`) |

## D. The first vertical slice is ready

Submission → acknowledgement → assignment (with scope) → progress → resolution → closure → feedback are all executable today **through the authority RPCs on both local and hosted**, with tenant isolation, participant ownership, staff authority, events privacy, and audit proven by 14 local + 16 hosted tests. The next phase builds the UI surfaces (public submit, participant "my requests", staff queue/case view, admin categories) plus optional Core-Notifications wiring — no further schema work required.

## E. Deviations & discoveries (all documented in the gate doc)

1. **Postgres implicit-read rule** (discovered via silent no-op): an UPDATE also requires the row to pass the SELECT policy, so `manage_cases` holders appear in read policies — otherwise staff writes silently no-op. Pinned by test 6.
2. **plpgsql enum coercions**: the status guard's VALUES list and the event-kind CASE needed explicit text/enum casts (PGlite surfaced both at apply time).
3. **`smallint` RPC signatures are uncallable via integer literals** over the PostgREST/SQL path — `rate_governance_request` uses `integer` (0028 convention).
4. **Hosted grant-surface drift (0035)**: hosted `ALTER DEFAULT PRIVILEGES` auto-grant ALL to `anon` (and UPDATE/DELETE to `authenticated`) on every new public relation. RLS remained the effective boundary (verified), but grants were off contract; 0033's signature clause caught it. 0035 normalizes the 0033/0027-governed surfaces (revoke-then-grant); 0034 self-heals its own surface (PUBLIC-explicit revokes + owner-grant normalization). Legacy election/core view grants deliberately untouched (LOCKED modules).
5. **Append-only at the grant layer**: after hygiene, the events view carries exactly SELECT+INSERT for `authenticated`/`service_role` and a SELECT-only owner row — no UPDATE/DELETE for any grantee; hosted PATCH/DELETE are hard 403s with the row byte-identical.
6. **`politicore.profiles` is RLS-enabled but not FORCEd on hosted** — pre-existing Core state (0002), reported only; LOCKED surface untouched in this gate.

## F. Security confirmation

* Supabase canonical; RLS FORCEd on all five governance tables; tenant isolation, participant ownership, staff authority, and anonymous fail-closed all proven locally and on hosted.
* No Firebase anywhere in the Governance surface (module built directly on Supabase — §30).
* No client-supplied tenant/actor anywhere; no governance DELETE policy for application roles; event trail append-only.

## G. Lock confirmation

* **Social Force** — LOCKED, unchanged.
* **Campaign** — LOCKED, unchanged.
* **Election** — LOCKED, unchanged (legacy view grants deliberately not touched).
* **Notifications** — LOCKED, unchanged; Governance triggers none (integration deferred by design).
* **Events / Announcements** — LOCKED, separate domains; no combined model introduced.
* **Firebase** — FULLY RETIRED.

## H. STOP — gate boundary

Phase 6 is an **architecture gate**. Per §35, the roadmap (projects, consultations, surveys, petitions, engagements, dashboards, analytics, public intake) proceeds as separately gated phases. The recommended next step is the **Governance vertical-slice implementation phase** (UI on the substrate above), pending review of this report and `docs/Governance-Architecture-Gate.md`.
