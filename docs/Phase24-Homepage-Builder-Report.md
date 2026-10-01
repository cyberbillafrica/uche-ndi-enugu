# PolitiCore — Phase 24 Report

## Control Center — Homepage Builder

**Status:** PHASE 24 — COMPLETE — **GATE: PASS**
**Architecture source:** `docs/Control-Center-Architecture-Gate.md` (Phase 21) + Phase 11 Governance Delivery/Participation/Accountability gate
**Preceding:** Phase 23 — Website Experience (Branding/Theme/SEO) — COMPLETE/PASS
**Phase boundary:** Homepage Builder ONLY. Phase 25 (Header/Footer/Navigation) NOT implemented.

---

## 1. Homepage configuration contract (§4, §5)

No new table. The composition lives in `politicore.public_site_settings.homepage` (JSONB), following the Phase 22/23 area conventions:

```jsonc
{
  "revision": 7,
  "draft":      { "sections": [ /* SectionInstance[] */ ] },
  "published":  { "sections": [ /* SectionInstance[] */ ] },
  "published_at": "...", "published_by": "...",
  "history": [ /* last <= 10 published revisions, oldest trimmed */ ]
}
```

A `SectionInstance` is exactly: `stable_id` (identity — never array position), `section_type`, `display_order`, `enabled`, `config`, `service_dependency` (optional, `module_code_enum` value), `presentation` (optional bounded object). No executable fields are accepted (unknown keys rejected server-side).

## 2. Migration 0062 (`supabase/migrations/0062_homepage_builder.sql`)

Pure `CREATE OR REPLACE FUNCTION` — no new tables, roles, permissions, or policies. Contents:

- `politicore.cc_validate_homepage(p_sections)` — composition allowlist: known section types only (SQL list mirrors `SQL_SECTION_TYPES`), field allowlist per instance, unique `stable_id`, unique integer `display_order`, `enabled` boolean, bounded `presentation` keys, ≤ 30 sections.
- Per-type config allowlists (§8): exact key sets per section type, matching the registry schemas 1:1 — news/events/gallery include `heading`, `election_countdown` takes `label`, hero has no media key (media refs live on `image_text.image`, `video.poster`, `biography.image`).
- Typed field checks: `item_count` 1..12, layout/alignment/image_side/background_variant/style vocabularies, text ≤ 160/120/200/2000 chars, boolean `show_excerpt`, CTA object shape.
- `cc_assert_safe_href` (§19): rejects `javascript:`/`data:`/`vbscript:`/`file:`/`about:` — internal paths, `#` fragments and HTTP(S) only.
- `cc_assert_section_media` (§18): media refs must resolve to a `public` `media_assets` row **of the same tenant** (walks `image`, `poster`, `biography image`).
- Enum probe fixed: `pg_enum` rows are unique per type — resolve via regtype **input cast**; the earlier `pg_namespace n ON n.oid = e.enumtypid` join was a category error that rejected every valid `service_dependency` (e.g. `election`).
- Restated `save_site_config_draft` + `publish_site_config` with homepage validation: save **merges** the area payload (`COALESCE(col,'{}') || payload`) so `published`/`history` survive between publish cycles — the previous replace-semantics restatement dropped them and would have blanked the public wrapper after any post-publish draft save. Publish re-validates the promoted payload, stamps provenance, archives bounded history (10), audits.
- `politicore.rollback_site_config` + `public.rollback_site_config` (§22): selects a history entry, promotes its payload to DRAFT through the normal **validated** save path (never mutates history); audited as `site_config:homepage:rollback`.
- `politicore.get_site_config_history` + public wrapper (§24 History panel): bounded `revision`/`published_at` list, payloads never leave the row.
- `politicore.get_site_config_preview` extended with `homepage` (admin-gated, returns draft-or-published only).
- **`public.get_published_homepage(slug)`** (§12/§26/§20): the public projection now evaluates eligibility **server-side** — disabled sections and enabled sections whose `service_dependency` module is not activated are suppressed from the PUBLIC composition while stored config is never mutated; malformed legacy payloads fail safe to `[]` (never 500, never leak); projects only `revision`/`sections`/`published_at`; draft and history never leave the server.

## 3. Section registry (§6, §7)

`src/lib/homepage/registry.ts` — typed catalog of the architecture-approved initial taxonomy:

- **Content-backed (12):** news, events, biography, manifesto, gallery, governance_projects, governance_commitments, governance_updates, public_accountability, public_participation, election_countdown, contact_cta.
- **Presentation (10):** hero, rich_text, image_text, feature_cards, statistics, cta, quote, video, link_cards, divider.

Each entry: label, description, group, service dependency, defaults (reproducing the migrated hard-coded homepage's behavior), and a typed field-schema consumed by the Builder editor. `validateComposition` mirrors the SQL validator (defense in depth). No component names, module paths, or code are ever stored in JSONB — the registry is compiled into the app (`§6`: the DB stores declarative configuration only).

## 4. Section engine (§12–§14, §20, §33)

`src/lib/homepage/engine.ts` + `render.tsx`:

- **Eligibility:** `enabled AND (service_dependency IS NULL OR module_enabled(...)) AND content publication conditions` — module state via the existing SECURITY DEFINER overview RPC (public rendering receives it from the server component; no client trust).
- **Canonical sourcing:** listPublishedNews, listPublishedEvents, getGallery, biography/manifesto public services, `listPublicGovernanceProjects/Commitments/Participate/RequestStats/Hub` (Phase 18 public projections — never private Governance tables), existing Election countdown contract. No shadow domain services, no duplicated content.
- **Failure isolation (§20):** every data fetch wrapped in `tryLoad` — one failed section renders its safe empty/fallback state and never terminates the homepage; unknown section types are skipped by the registry lookup (§9).
- Bounded per-section fetches (`item_count` ≤ 12), no N+1, no second aggregation store.

## 5. Homepage migration / parity (§31, §32)

`src/app/page.tsx` was rebuilt as a thin shell: load published composition (fallback-safe defaults for unconfigured tenants) → resolve eligibility → render through `SectionRenderer`. The old hard-coded page's inventory (hero, news, events, biography, manifesto, gallery, governance, election countdown, CTAs) is fully covered by registered sections with parity defaults; there is exactly ONE production homepage renderer (the section engine). Phase 20's static audit test was updated to pin the canonical-sourcing invariant against the engine (its new home) instead of the retired hard-coded page.

## 6. Homepage Builder UI (§24)

`/portal/control-center/website/homepage` — section library (Content / Presentation groups), canvas with reorder, enable/disable, duplicate, remove, config summary, typed per-field editor (registry metadata only — no generic form engine), save (base-revision conflict handling), preview, publish, bounded History with rollback. Same-engine preview at `/portal/control-center/website/homepage/preview` (admin-gated; renders the DRAFT through the identical engine — no separate preview renderer).

## 7. Authorization / RLS / ACL (§25, §27)

`is_tenant_admin()` only — no new role, no new permission. Tenant and actor resolved server-side; FORCE RLS, grants and ACL discipline unchanged (75/75 tables, 142 policies verified by the hosted apply). Draft privacy holds: anon/member/cross-tenant hold nothing on draft, history, preview or rollback; public wrapper exposes the published composition only.

## 8. Audit (§28)

Core Audit only (`system_audits`): `site_config:homepage:draft_saved`, `...:published`, `...:rollback` with server-resolved actor/tenant and revision evidence. No homepage-specific audit subsystem.

## 9. Verification

```text
focused security:   33/33   tests/security/control-center-homepage-builder.test.ts
full regression:   1020/1020 — 42 suites — 0 failed — 0 skipped
hosted acceptance:   18/18  scripts/db/verify-hosted-smoke-control-center-homepage-builder.ts
hosted residue:      0      (tenants|profiles|orphan-settings|homepage-assets = 0|0|0|0; FORCE-RLS restored)
TypeScript:          0 errors
build:               PASS — 76/76 pages
lint:                0 errors / 0 warnings on all phase files
                     (repo-wide lint has pre-existing errors in non-phase files: contact,
                      documentation, login, news, members/add, toast, help, seed script,
                      phase1c/business-rules tests — untouched by this phase, per convention)
```

Hosted acceptance journeys: anon zero surface · admin read · member denial · draft-private/public-unchanged · admin preview · publish propagation · validator rejections (unknown type/key) · `javascript:` rejection · media tenancy (cross-tenant rejected, own accepted) · disable-hides/retains · service-dependency OFF-hides/ON-restores with config untouched · stale-revision conflict · rollback through the validated save path with intact history · tenant-B isolation · draft privacy + unknown-slug seam · audit evidence (server actor) · bounded history RPC · residue 0.

## 10. Repairs (disclosed)

1. **`pg_enum` join category error** in `cc_validate_homepage` — every valid `service_dependency` was rejected (namespace OID joined to type OID); replaced with a correct regtype-input-cast probe. Caught by the suite (E1).
2. **Save replace-vs-merge defect** — the restated 0062 save replaced the whole area column, dropping `published`/`history` after any post-publish draft save (public wrapper would go empty between publish cycles; history destroyed). Caught by the suite (B1/B2/G3).
3. **Public wrapper lacked server-side eligibility filtering** — §12 requires suppression of service-dependent sections at the boundary, not renderer trust. Implemented; suite + hosted J10/J11 now prove it.
4. **Registry↔validator drift** — news/events/gallery `heading` missing from the SQL allowlist (local suite's minimal payloads didn't exercise it; the hosted harness did). Aligned; a full sweep confirmed all 22 type allowlists match the registry schemas.
5. **Malformed legacy payload hardening** — `published.sections` of a non-array type previously raised `cannot extract elements from a scalar`; now fails safe to `[]` (H2, §20).
6. **Hosted convergence** — hosted had a stale first-apply of 0062 (signature-based idempotence); replayed the final file verbatim via a temporary script (deleted after run) and verified function-level markers on hosted.
7. **Phase 20 audit test updated** — canonical-sourcing invariant re-pinned to the section engine after the hard-coded page retirement (content-domains 24/24).

## 11. Phase 25 confirmation

NOT implemented: no Header Builder, Footer Builder, Navigation Builder, navigation/footer editors or validators, no navigation/footer areas in `cc_is_site_config_area`, no Phase 25 UI. J2 regression guard proves their absence.

## 12. Locked modules

Untouched — Social Force, Campaign, Election, Governance, Core Identity/Auth, Geography, Notifications, Media, Audit, News, Events, Biography, Manifesto, Gallery, Contact: no ownership or behavior change; the Builder is a pure orchestration/presentation consumer of their public contracts. No Firebase references; all media flows through Core Media.

## 13. Stop conditions

None triggered.

```text
POLITICORE — PHASE 24 — CONTROL CENTER HOMEPAGE BUILDER — COMPLETE / PASS
```
