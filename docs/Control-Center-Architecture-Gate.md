# PolitiCore — Control Center Architecture & Product Design Gate

**Status:** PHASE 21 — ARCHITECTURE GATE — **PASS**
**Type:** Architecture/product-design only. No implementation, no migrations, no permissions, no roles, no locked-module changes.
**Preceding:** Phase 20 — Cross-Module Integration & Production Readiness Gate — PASS (933/933 · 39 suites · hosted 245/246 · residue 0)
**Locked and untouched:** Core Identity/Auth, Core Geography, Core Notifications, Core Media, Core Audit, Social Force, Campaign, Election, Governance, public content modules.

---

## 1. Control Center definition

**DECISION.** Control Center is the administrative control plane for a PolitiCore tenant and its activated services:

> CONTROL CENTER CONFIGURES THE PLATFORM; MODULES OWN THEIR DOMAIN OPERATIONS.

It is **not** a fifth business module. It owns configuration, administration surfaces, and platform-health visibility. It never takes ownership of Social Force, Campaign, Election, or Governance domain operations, and never stores domain records.

**RATIONALE.** PolitiCore's four business modules are peer operational domains. Their administration (tasks, cases, contests, projects) lives in their own surfaces. What is missing is the *platform* administration layer: which services a tenant runs, what the public site looks like, who has access, and how the organization is structured. That layer must exist without competing with the modules.

**ALTERNATIVES REJECTED.**
- *Control Center as an umbrella super-app absorbing module admin:* rejected — creates a second configurator per module and ownership inversion (§29).
- *Federating configuration into each module:* rejected — service activation and site experience are tenant-global concerns with no single module owner; scattering them recreates the pre-Phase-20 fragmentation.

---

## 2. Ownership boundaries

**DECISION.**

| Domain | Owner | Control Center relationship |
| --- | --- | --- |
| Social Tasks, submissions, review, points, leaderboard, social participation | **Social Force** | activation toggle, link-out only |
| Campaign assignments, activities, attendance, field reports, issues, coordination/member operations | **Campaign** | activation toggle, link-out only |
| Election cycles, contests, candidates, election configuration, submissions, review, results, evidence | **Election** | activation toggle + link to the authoritative Election Control Center (§21 of the prompt, §21 below) |
| Governance requests/intake/projects/commitments/consultations/petitions/polls/engagements/accountability/analytics/memory | **Governance** | activation toggle, link-out only |
| Identity, membership, access roles, permissions, assignments, geography | **Core** | People & Access surfaces *link/orchestrate* existing admin surfaces; Core remains sole authority |
| Notifications / Audit / Media | **Core** | consumed, never duplicated |
| Tenant configuration, service entitlement/activation, website experience, branding/theme, navigation, homepage composition, SEO metadata, platform health visibility, configuration governance | **Control Center** | sole owner |

**RATIONALE.** The Phase 20 gate proved one-owner-per-domain as an invariant. Control Center extends that invariant to the configuration plane: configuration has an owner too, and it is Control Center.

---

## 3. The four-service model

**DECISION.** The four first-class tenant services are exactly the existing `politicore.module_code_enum`:

```sql
CREATE TYPE politicore.module_code_enum AS ENUM ('social', 'campaign', 'election', 'governance');
```

No fifth value is added; Control Center itself is not a service and must never join this enum. A tenant may be entitled to one, several, or all four.

---

## 4. Service entitlement vs service activation

**DECISION.** Two independent concepts, stored separately:

### Entitlement — "the tenant has contracted access to this service"
Stored in the existing **`politicore.platform_settings`** singleton (migration 0001, already `FORCE RLS`) under a `service_entitlements` key, managed by **platform authority only** (`tenant_super_admin`/`platform_super_admin` — existing access roles; `service_role` for provisioning flows). Not tenant-editable.

### Activation — "the tenant currently runs this service operationally"
Stored in the existing **`politicore.tenant_modules.enabled`** (per-tenant, per-module), toggled by tenant admin authority (§18). This is the only flag the runtime consults — every existing gate (`module_enabled()`, `my_module_enabled()`, all module RPCs, RLS, navigation) already reads it.

```
Entitled=true, Enabled=true   → operational (normal running state)
Entitled=true, Enabled=false  → dormant: hidden + fail-closed, data intact, re-enable restores
Entitled=false                → not contracted: activation toggle is not offered; any stray enabled row is ignored for provisioning purposes (activation still requires entitlement in Phase 22's RPC)
```

**RATIONALE.** Entitlement is a commercial/product fact that must not live in the same mutable row as the operational state; activation is operational and already fully wired through the existing substrate. Using `platform_settings` avoids a new table while keeping entitlement out of tenant hands.

**ALTERNATIVES REJECTED.** A dedicated `service_entitlements` table (speculative — one row of product config does not justify it; Stop Condition: "large speculative abstraction"); overloading `tenant_modules.enabled` to mean both (collapses two authorities into one mutable flag).

---

## 5. Module activation semantics

**DECISION.** Activation is **tenant-global and non-destructive**. Turning a service OFF for tenant T:

- disables the service for tenant T only (global *within the tenant*, never across PolitiCore);
- hides portal/public navigation and homepage service sections (presentation);
- fails closed at every route/service/RPC (existing `module_enabled()` gates — already proven by every phase suite);
- leaves all service data intact; alters no historical records; deletes nothing;
- re-enabling restores full access to the existing data.

Activation is an operational state change, never a lifecycle/destructive operation. Phase 22's toggle RPC will additionally assert `audit_module_change()` coverage (already exists on `tenant_modules`) and Core Audit entries.

---

## 6. Module activation is not authorization (mandatory layering)

**DECISION.** The Phase 20-proven authorization stack remains the sole authority:

```
Identity → Membership → Access Role → Permission → Organizational Assignment → Geographic Scope
```

with module activation as an additional independent gate:

```
Module Enabled AND User Authorized → Operation permitted
```

Service activation never substitutes for authorization, never bypasses `has_permission` deny-wins, and never appears in permission computation. The Control Center adds zero authorization logic — it toggles an operational flag and renders administration UI that is itself gated by existing authority.

---

## 7. Homepage Builder architecture (flagship no-code feature)

**DECISION.** The homepage becomes a **configuration-driven ordered composition** rendered by a section engine, replacing the current hard-coded 500-line `src/app/page.tsx` (ElectionCountdown + five fixed `<section>` blocks).

Conceptual model:

```
Homepage composition
 → ordered list of section instances
      each: { stable_id, section_type, display_order, enabled,
              config (typed payload), service_dependency, presentation }
```

- **Section registry** lives in code (a typed map of `section_type → { component, config schema, defaults, service_dependency }`), versioned with the app — never in the database. The database stores only *instances* of registered types.
- **Storage** uses the existing `public_site_settings.homepage` jsonb (column already exists, tenant PK, `FORCE RLS`): no new table. Shape (contract-level, finalized in Phase 24):
  `{ revision, draft: {sections[]}, published: {sections[], published_at, published_by}, history: [last ≤10 published revisions] }`.
- The public homepage renders `published`; admin preview renders `draft` (§17).
- Unregistered (stale) section types in stored config are skipped defensively at render time — forward/backward compatible.
- **Full-fidelity render guarantee:** a section whose data fetch fails renders its configured fallback (empty state), never a blank homepage — the invariant the current page.tsx comment already establishes for the countdown, generalized.

**RATIONALE.** A code-side registry keeps configuration safe (only known types with validated payloads), testable, and evolvable; the jsonb composition keeps the smallest possible DB footprint (zero tables) consistent with every prior gate's derived/no-duplication rule.

---

## 8. Homepage content ownership (not a second CMS)

**DECISION.** The Homepage Builder controls **WHAT appears, WHERE, WHETHER enabled, and HOW presented** — never the content itself.

| Section | Builder controls | Canonical owner (untouched) |
| --- | --- | --- |
| News | enabled, order, item count, layout, featured mode | News module (records, publication state, content) |
| Events | enabled, order, upcoming/past, item count, layout | Events module |
| Biography / Manifesto | enabled, order, layout, excerpt length | Biography / Manifesto modules |
| Gallery | enabled, order, layout, image count | Gallery module |
| Governance Projects / Commitments / Updates | presentation + public-projection binding | Governance (records + Phase 18 publication authority) |
| Election Countdown | enabled, order, presentation | Election (cycles/dates via existing public RPCs) |
| Public Accountability / Participation | presentation | Governance Phase 18 projections |

Sections consume canonical data exclusively through the **existing public services/RPCs** (Phase 4 content surfaces, Phase 18 `public_governance_*`). The Builder writes zero domain records, adds zero domain queries, and never mutates module state.

---

## 9. Section taxonomy

**DECISION.** Two classes, one registry.

### A. Content-backed sections (consume canonical platform data)
Initial catalog (documented; each implemented with its own config schema in Phase 24): `news`, `events`, `biography`, `manifesto`, `gallery`, `governance_projects`, `governance_commitments`, `governance_updates`, `public_accountability`, `public_participation`, `election_countdown`, `contact_cta`.

### B. Presentation / marketing sections (pure composition blocks)
`hero`, `rich_text`, `image_text`, `feature_cards`, `statistics`, `cta`, `quote`, `video`, `link_cards`, `divider`.

Presentation sections store their own inline content (headings, copy, image references via Core Media `media_assets` — no module storage) in their config payload. This is site-experience content owned by Control Center, not a CMS for domain content.

---

## 10. Service-aware homepage sections

**DECISION.** A section may declare `service_dependency: module_code_enum | null` (e.g. `election_countdown → election`, `governance_projects → governance`, hypothetical `social_participation → social`, `campaign_activities → campaign`).

**Deterministic rule:**

```
Service OFF → section is not renderable publicly; configuration is retained untouched.
Service ON  → section becomes eligible again, exactly as configured.
```

No homepage configuration is ever deleted or rewritten because a service was disabled. The current `ElectionCountdown` fallback behavior (render a graceful empty state rather than blanking the page) is the per-section template for degraded rendering.

---

## 11. Section enablement vs service enablement (independent)

**DECISION.**

```
Live Section Eligibility =
    section.enabled
AND (section.service_dependency IS NULL OR module_enabled(dependency))
AND content publication/visibility conditions of the backing module
```

All three are evaluated server-side at render data-resolution time. The four combinations behave correctly by construction: enabled section + disabled dependency → hidden (config retained); disabled section + enabled dependency → hidden; both enabled + published content → rendered. Concepts are never collapsed into one flag.

---

## 12. Header architecture

**DECISION.** Header is **global site chrome**, configured once, rendered by `src/components/layout/Header.tsx` from configuration instead of hard-coded values.

Configuration home (existing columns only):
- `public_site_settings.branding` → logo (Core Media reference), site name;
- `public_site_settings.navigation` → primary nav items, CTA item, mobile nav, `header` layout variant + visibility rules.

Header applies across the entire public site (root layout), never re-configured per page, never duplicated in page files.

---

## 13. Footer architecture

**DECISION.** Footer is **global site chrome**, independent of homepage composition.

Configuration home: `public_site_settings.footer` (nav groups, legal links, layout variant) + `branding` (logo, org description) + `contact` (contact info) + `social_links`. Rendered from the root layout like the Header.

---

## 14. Public navigation builder

**DECISION.** Public navigation is configurable in `public_site_settings.navigation`:

```
{ header: { items: [{ label, href, service_dependency? }], cta },
  footer_groups: [...],
  visibility: { ... } }
```

- Items may declare `service_dependency`; a disabled service hides its nav item (presentation only).
- **Navigation configuration MUST NEVER grant authorization.** Hiding a route is presentation; every route and RPC remains server/DB authoritative exactly as proven in Phase 20 (§6). A hand-typed URL to a disabled module's route fails closed at the service/RPC/DB layer regardless of nav config.

---

## 15. Branding & theme system

**DECISION.** Tenant-level branding via **design tokens** mapped onto the existing CSS custom-property system (`globals.css` today carries hard-coded `--color-apc-*` tokens; implementation phases generalize them to semantic tokens: `--color-primary/secondary/accent/surface/background/text/muted/border`, typography preferences where supported).

- Storage: `public_site_settings.branding` — `{ logo, favicon, preset, tokens }`.
- Components consume semantic tokens only; no hard-coded colors in section/chrome components (enforced in implementation phases' lint/review).
- All branding assets (logo, favicon) resolve through **Core Media** (`media_assets`) — no direct provider storage.

---

## 16. Party theme presets (APC / PDP / NDC)

**DECISION.** Presets are **visual design-token bundles** — nothing more:

| Preset | Nature |
| --- | --- |
| `apc` | token bundle (the visual language already in globals.css) |
| `pdp` | token bundle |
| `ndc` | token bundle |
| `custom` | tenant-specified token overrides (§17) |

A preset selection writes a token bundle to `branding`. It creates **no** party-specific authorization, business logic, routing, data models, or module behavior. No party name appears in any application logic — presets are data, selected like any configuration value.

---

## 17. Custom theme

**DECISION.** `custom` permits controlled token overrides only: the documented token set (colors, typography scale, radii) exposed as validated fields in the theme editor. **No arbitrary CSS injection, no custom code editor, no script/style payload fields in v1** — the config schema whitelist-rejects unknown keys. Future extension (if ever) is a separate architecture decision.

---

## 18. Draft → Preview → Publish → Live model

**DECISION.**

- **Draft:** all website-experience configuration is edited as draft (`homepage.draft`, and equivalent draft keys for branding/navigation/footer); live site is unaffected while editing.
- **Preview:** an admin-authenticated preview surface renders the draft composition (same section engine, draft data). Preview requires admin authority — draft config is never publicly readable (RLS: public read policy exposes published state only; §20 details the read-split).
- **Publish:** an atomic action swaps the published pointer, stamps `published_at/published_by`, bumps `revision`, archives the previous revision into bounded `history` (last 10), and writes one Core Audit entry ("website configuration published"). Publish is all-or-nothing per configuration area.
- **Rollback:** re-publish a stored prior revision from history (bounded to 10; oldest falls off). Not a full CMS version tree.

**RATIONALE.** Bounded revision history inside the existing jsonb is the smallest architecture that gives administrators safety (experiment + recover) without a versioning subsystem (Stop Condition: elaborate CMS versioning unjustified).

---

## 19. Configuration versioning & concurrency

**DECISION.** A monotonic integer `revision` per configuration area with **optimistic concurrency**: mutating RPCs require the caller's base revision; a mismatch rejects with a conflict error (last-write-wins is prevented). No per-field versioning, no branching, no merge tooling. If real multi-admin contention emerges in practice, revisit as its own decision — do not pre-build.

---

## 20. Website experience configuration domain

**DECISION.** One coherent domain over the existing `public_site_settings` columns (zero schema changes required):

| Category | Column | Contents |
| --- | --- | --- |
| Brand & theme | `branding` | logo, favicon, preset, custom tokens, site name |
| Site chrome — header/nav | `navigation` | header nav, CTA, footer groups, layout variants |
| Site chrome — footer | `footer` | footer composition, legal, contact bindings |
| Homepage | `homepage` | draft/published/revision/history section composition |
| Contact | `contact` | public contact configuration |
| Social | `social_links` | social profile links |
| SEO / metadata | `seo` | site title, description, social-sharing/SEO metadata |

News, Events, Gallery, Manifesto and Governance content models are referenced, never duplicated. The Phase 4 module owns content; this domain owns presentation configuration.

---

## 21. Election configuration boundary (and every existing configurator)

**DECISION.** The existing Election Control Center remains the sole authoritative Election configurator. Control Center exposes: election service activation, high-level tenant/service state, and a **link/entry point** into Election configuration. No second election configuration model, table, or surface is created. The same principle binds every module with an authoritative configurator (Campaign settings via `manage_campaign_settings`, Governance surfaces, Social Force): **Control Center links or orchestrates; it never re-implements.**

---

## 22. Service dependency model

**DECISION.** Dependencies point from Control Center configuration **toward** module contracts, never the reverse:

```
Homepage.news            → News public service
Homepage.events          → Events public service
Homepage.manifesto       → Manifesto
Homepage.governance_*    → Governance Phase 18 public projections
Election countdown       → Election public cycle RPCs
Navigation item X        → module activation state
Theme/chrome             → Core Media (assets)
```

Modules must never depend on Control Center for core domain logic. If a module is disabled, Control Center degrades (hides sections/nav); modules never consult Control Center to function.

---

## 23. Authorization model for Control Center (zero new permissions)

**DECISION.** Control Center uses the **existing administrative authority** — no new role, no new permission:

| Capability | Authority (existing) |
| --- | --- |
| View Control Center (Overview, Services, Website) | `is_tenant_admin()` (the access-role `admin` authority already used as the write policy on `public_site_settings`) |
| Service activation toggles | `is_tenant_admin()` via Phase 22 RPCs (server-resolved tenant + actor; entitlement cross-check; Core Audit) |
| Branding/theme, homepage, navigation, header/footer, SEO | `is_tenant_admin()` (draft/publish RPCs, server-resolved) |
| Platform-level entitlement management | existing `tenant_super_admin`/`platform_super_admin` access roles over `platform_settings` |
| People & Access, Organization surfaces | link/orchestrate existing admin surfaces gated by their existing permissions (`manage_members`, geography administration, etc.) |

**Stop-condition check (§33):** no second authorization system, no new role, no new permission required — the existing catalog demonstrably supports every requirement. **Zero permissions added in this gate**, and Phase 22–26 must justify any exception against this section explicitly.

---

## 24. Audit model (Core Audit only)

**DECISION.** Every Control Center administrative mutation is auditable through **Core Audit** — no CC audit table:

| Action | Audit expectation |
| --- | --- |
| Service activation/deactivation | `audit_module_change()` (already on `tenant_modules`) + RPC audit entry |
| Theme/branding changes | Core Audit entry (who, tenant, area, revision) |
| Homepage changes | draft saves (coarse) + **publish** (mandatory, with revision) + rollback |
| Navigation / header / footer changes | Core Audit entry on publish |
| Configuration publication | Core Audit entry (area, from/to revision) |
| Access/permission administration | already Core-Audited by existing admin surfaces (unchanged) |
| Organizational administration | already Core-Audited (unchanged) |

---

## 25. Tenant isolation

**DECISION.** All Control Center configuration is tenant-scoped with zero exceptions:

- `public_site_settings`, `tenant_settings`, `tenant_modules` are tenant-PK/scoped and already `FORCE RLS` (migration 0002, proven by every phase suite).
- A tenant administrator can never read/modify another tenant's configuration, infer another tenant's service state, or access another tenant's draft/unpublished homepage. Drafts are additionally excluded from the public read policy (published-state read split designed in Phase 22's RPC layer).
- Cross-tenant platform administration is **out of scope for Phases 22–26**; `platform_settings` remains a platform-authority boundary (super-admin roles + `service_role`), and no cross-tenant console is built.

---

## 26. Module-disabled behavior matrix (no deletion, no historical mutation, no authorization bypass)

| Surface | Social OFF | Campaign OFF | Election OFF | Governance OFF |
| --- | --- | --- | --- | --- |
| Public site | social sections/nav hidden | campaign sections/nav hidden | countdown hidden; results surfaces fail closed | governance sections/nav hidden; public hub/intake fail closed |
| Portal navigation | hidden | hidden | hidden | hidden |
| Direct route | fails closed (existing) | fails closed | fails closed | fails closed |
| Service API/RPC | `module_enabled()` refuses (proven B6-class) | refuses | refuses | refuses |
| Database | RLS/module gates authoritative | same | same | same |
| Homepage sections | hidden, config retained | hidden, config retained | hidden, config retained | hidden, config retained |
| Notifications | module events cease; Core Notifications substrate intact | same | same | same |
| Analytics/memory | social surfaces out of scope of CC analytics | same | same | Phase 19 analytics RPCs module-gated (proven) |
| Data | intact | intact | intact | intact |

---

## 27. Configuration / domain ownership matrix (final — no ambiguity)

| Configuration / data | Owner |
| --- | --- |
| Homepage composition | **Control Center** |
| Header/Footer/Navigation configuration | **Control Center** |
| Branding/theme tokens | **Control Center** |
| SEO/site metadata | **Control Center** |
| Service entitlement | **Platform authority via Control Center** (`platform_settings`) |
| Service activation | **Control Center** (`tenant_modules`) |
| News records | News |
| Event records | Events |
| Manifesto content | Manifesto |
| Biography records | Biography |
| Gallery assets | Gallery (assets via Core Media) |
| Governance projects | Governance |
| Election contests | Election |
| Social tasks | Social Force |
| Campaign activities | Campaign |
| Notification records | Core Notifications |
| Audit records | Core Audit |
| Media assets | Core Media (`media_assets`) |
| Geography | Core Geography |
| Identity / permissions / roles | Core |

---

## 28. Future multi-tenant compatibility

**DECISION.** Every configuration concept is `tenant_id`-keyed from day one (already true of the substrate). Explicitly **not built** (future SaaS concerns): subscription marketplace, billing, self-service tenant provisioning, enterprise white-label infrastructure beyond token presets, cross-tenant admin console. No decision in this gate prevents them: entitlement/activation separation (§4) is the hook for commercial lifecycle; the platform-authority boundary (§25) is the hook for platform operations.

---

## 29. Explicit non-goals (Control Center must NOT become)

1. a fifth business module; 2. a second authorization system; 3. a second settings system (it *is* the settings system over existing tables); 4. a second audit system; 5. a second content CMS; 6. a second Election Control Center; 7. a second Governance configuration system; 8. a duplicate geography system; 9. a duplicate member directory; 10. duplicate notifications; 11. duplicate media storage; 12. an arbitrary CSS/JS code-injection surface; 13. page-specific authorization logic; 14. a destructive service deactivation path; 15. hard-coded party-specific business logic.

---

## 30. Implementation phase decomposition (Phase 22–26 — NOT authorized by this gate)

| Phase | Scope | Highlights |
| --- | --- | --- |
| **22 — Control Center Core: Configuration & Service Activation** | Overview + Services IA; service activation RPCs (toggle, server-resolved, entitlement-checked, audited); entitlement read-model in `platform_settings`; configuration RPC skeleton (revision + optimistic concurrency) over `public_site_settings`; `/portal/control-center` shell gated by `is_tenant_admin()`; security suite + hosted acceptance | Deliberately **small**: no homepage, no theme, no builders |
| **23 — Website Experience: Branding / Theme / SEO** | Theme token system + presets (APC/PDP/NDC/custom) as token bundles; branding editor; SEO/metadata configuration; semantic-token migration of chrome components | Header/Footer still render configured values |
| **24 — Homepage Builder** | Section engine + registry; content-backed + presentation section catalog (initial subset); draft/preview/publish/rollback; service-dependency eligibility; replace hard-coded `page.tsx` | Largest phase; section catalog may be split 24a/24b if needed |
| **25 — Header / Footer / Navigation Builder** | Nav builder (items, order, CTA, service dependencies); header/footer layout variants; footer groups/legal/contact bindings | Builds on 23's chrome |
| **26 — Administration Integration** | People & Access / Organization link-orchestration surfaces; platform health visibility (existing `portal/admin/health`); audit visibility linkage; full cross-module hosted acceptance + final integration gate | No new configuration models |

Each phase runs the established acceptance standard: focused security suite, full regression, hosted acceptance, residue 0, tsc/build/lint clean.

---

## 31. Verification (this gate)

Architecture-only — verified zero production impact: no migrations, no tables, no permissions, no roles, no locked-module changes, no Firebase, no duplicate architecture (validated below). Baseline re-validated post-gate.

---

## 32. Stop conditions — review

None triggered. The design introduces no second system of any kind, no destructive operation, no code injection, no cross-tenant access, no speculative abstraction beyond the documented jsonb shapes over existing tables.

---

```text
CONTROL CENTER
│
├── Tenant Configuration            (branding · theme · SEO · site metadata)
├── Service Activation              social · campaign · election · governance  (+ platform entitlement)
├── Website Experience              header · footer · navigation · homepage builder
├── Administration                  people & access · organization  (link/orchestrate, never duplicate)
└── Platform Operations             health visibility · audit visibility

while: Social Force owns Social Force data · Campaign owns Campaign data ·
       Election owns Election data · Governance owns Governance data ·
       Core owns identity, authorization, geography, notifications, media, audit.
```

**POLITICORE — PHASE 21 — CONTROL CENTER ARCHITECTURE & PRODUCT DESIGN GATE: PASS**
