# PolitiCore — Public/Content Modules Cutover Report (Phase 4)

**Status:** PHASE 4 — COMPLETE
**Parent gate:** Platform Core Identity/Auth migration sequence · **Previous:** `docs/Member-Directory-Cutover-Report.md`
**Scope:** Events, Announcements, News, Contact, Biography, Gallery, Manifesto, Site Settings, Donations, Homepage — clean cutover from Firebase/Firestore to canonical Supabase/PostgreSQL. No dual-read, no dual-write, no Firebase fallback, no combined Events/Announcements model, no public donation collection. Social Force, Campaign, Election and Notifications untouched.

---

## A. Phase status

```text
PHASE 4 — COMPLETE
```

All §26 focused tests, §27 full regression (623/623, 22 suites, 0 skipped/failed), §28 hosted acceptance (32/32), §29 quality gates, and §31 architecture separation verified.

## B. Events

| Artifact | Detail |
|---|---|
| Database | `politicore.events` (migration **0033**) — tenant-scoped, `draft/published/cancelled` lifecycle, ward FK, FORCE RLS |
| Service | `src/lib/supabase/events.ts` — `listPublishedEvents` (upcoming-only published contract), `listEvents`, `createEvent`, `updateEvent`, `deleteEvent` |
| RLS | `events_read_published` (public: published-only; same-tenant + platform exceptions) · `events_admin` (server-resolved tenant + `is_tenant_admin()`) |
| Admin UI | `src/app/portal/admin/events/page.tsx` (split from the legacy combined page; wired into admin nav as "Events") |
| Public UI | `src/app/events/page.tsx` — **new** public `/events` route (none existed before; §7 gap closed) |
| Homepage | `src/app/page.tsx` latest-events section reads `listPublishedEvents()` only |
| Tests | Local: 4 events tests in `tests/security/content-domains.test.ts` · Hosted: A1–A6 (draft creation, anon draft denial, publish lifecycle, member/cross-tenant/anon write denials) |

## C. Announcements

| Artifact | Detail |
|---|---|
| Database | `politicore.announcements` (0033) — separate first-class table; `general/campaign_members/social_members/election_officers/admins` scope; `draft/published/archived` lifecycle; FORCE RLS |
| Service | `src/lib/supabase/announcements.ts` — independent service, zero imports from `events.ts` and vice-versa |
| RLS | `announcements_read` (same-tenant, published-only, membership-scoped via 0002 `has_membership()`; admins see all) · `announcements_admin` |
| Admin UI | `src/app/portal/admin/announcements/page.tsx` (the legacy combined page now manages announcements only; nav label "Broadcast" → "Announcements") |
| Authenticated portal UI | `src/app/portal/announcements/page.tsx` (new; linked in the member portal nav) |
| Tests | Local: 7 announcements tests (incl. published-still-private and not-notifications pins) · Hosted: B1–B7 (anon receives nothing, membership scope gating, draft admin visibility, member-write denial, cross-tenant isolation, notifications-table separation) |

**Events ≠ Announcements:** separate tables, separate services, separate RLS policies, separate UIs. The old Firebase polymorphic `portal_content.items[]` model was not reproduced; a static test pins its absence. Announcements never appear on the public homepage (pinned locally and on hosted).

## D. Other content modules

| Module | Database (0033) | Service | Consumers migrated | Notes |
|---|---|---|---|---|
| **News** | `news_articles` (published-slug unique index) | `src/lib/supabase/news.ts` | public list, `[slug]` page, admin news, GlobalSearch news source, homepage latest-news | public reads published-only |
| **Contact** | `contact_messages` (anon INSERT; unread/read) | `content.ts` (`submitContactMessage`, admin list/mark-read) | public form, admin messages page | anonymous submissions land; reads admin-only, tenant-scoped |
| **Biography** | `biographies` (tenant_id PK) | `content.ts` (`getBiography`/upsert) | public page + metadata, admin editor | published public, draft private |
| **Gallery** | `galleries` (jsonb images) | `content.ts` | public page, admin page | media URLs via the existing provider-agnostic Media Service (no new providers) |
| **Manifesto** | `manifestos` | `content.ts` | public page, admin page | sections jsonb preserves structure |
| **Site Settings** | `tenants.config` jsonb + `tenants_read_authenticated` policy | `content.ts` (`getTenantSettings`/`updateTenantSettings`) | admin settings page | single tenant-configuration system (no second one) |
| **Donations** | `donations` + `donors` projection (trigger-refreshed) | `content.ts` (ledger CRUD, filters, summaries, audit list) | admin donations page (ledger/filters/totals/audit modal) | **private admin-only ledger**; no public collection endpoint; tenant-admin-only RLS; audit via canonical `system_audits` |
| **Homepage** | — | canonical events + news services | `src/app/page.tsx` | no Firebase reads; no announcements; no Campaign Activities |

Also migrated in the content path: **Audit Logs** (new canonical `src/lib/supabase/audit.ts` over the 0033 `public.system_audit_logs` security_invoker view), **System Health** (tenant constant + diagnostics seam), **Documentation** text, **GlobalSearch** (news + member sources canonical; Campaign/Social/Election search untouched), and the four remaining `getAllLGAs` consumers (volunteer signup, profile, CampaignDashboard, member creation) onto a new canonical `listLgaTree()` geography accessor (three indexed queries, no N+1, no Firestore geography).

## E. Firebase boundary

| Family | Before (live consumers) | After |
|---|---|---|
| Events + Announcements (combined `portal-content.ts`) | 4 surfaces | **0** — file deleted |
| News (`firestore.ts` + pages) | 6 | **0** |
| Contact | 2 | **0** |
| Biography / Gallery / Manifesto | 6 | **0** |
| Donations | 1 | **0** |
| Site settings (via tenants) | 1 | **0** |
| Homepage | 1 | **0** |
| Geography (`firebase/electoral.ts`, `getAllLGAs`) | 4 remaining | **0** — file deleted; seeding script's obsolete Firebase branch removed |
| `firebase/firestore.ts` | 13 exports | banner only (zero exports, zero consumers) |

Deleted with zero-consumer proof: `src/lib/firebase/{portal-content,electoral}.ts`; all content helpers purged from `firestore.ts` (now a documented removal banner); `constants.ts` Firestore loader removed.

**Remaining Firebase artifacts (all retained deliberately, none are application consumers):**

* `src/lib/firebase/election.ts`, `election-seed.ts`, `devseed.ts` — Election rollback/seed path per the Election lock (`src/types/index.ts` documents the seam; kept for the locked module's stated rollback capability).
* `src/lib/firebase/{config,tenants,storage,jobs,notifications,audit,auth,permissionGrants}.ts` — retained as the classified legacy boundary (config hub, storage provider seam, diagnostics stub, Phase-1/2/3 documented seams). Zero external imports remain (`grep` proof: `lib/firebase` appears nowhere outside `src/lib/firebase` except a types-file comment).
* Firestore **rules tests** (`tests/rules/*`) still exercise `firestore.rules` against the emulator for the locked Election rollback surface — unchanged, by design.

**Static proof (hosted G3 + local suite):** `from "@/lib/firebase|firebase/*"` imports in application code = **0** (walks all of `src`, excludes `src/lib/firebase` internals). The application is fully on Supabase.

## F. Security

* **RLS:** every 0033 table `ENABLE`+`FORCE RLS`; policies resolve tenant/actor server-side (`current_tenant_id()`, `is_tenant_admin()`, `has_membership()`); no client-supplied authorization boundary anywhere.
* **Tenant isolation:** cross-tenant drafts, messages, announcements and ledger rows invisible to other tenants' admins (local suite + hosted B6/D5/E2/F6).
* **Publication visibility:** anonymous visitors read published rows only across events/news/biography/gallery/manifesto; drafts/cancelled/archived never leak (hosted A2/E2, local suite).
* **Announcements are authenticated-only:** anonymous sessions receive **nothing**, published rows included (hosted B1 with HTTP-200-zero-rows and local pins). Membership scope gates visibility (hosted B3). Not exposed via public search or homepage (G2).
* **Donations are admin-only:** anon has no grant; ordinary members denied read/write (hosted F1–F3); tenant admins record within their own tenant; donors projection + audit attribution are server-side (F4–F5). No public collection endpoint exists (static test + no public route).
* **Contact:** anonymous INSERT-only (public form); anonymous UPDATE attempts fail and are proven not to land; reads/mutations admin-only, tenant-scoped (D1–D5, local suite).
* **Audit:** donation writes land in the canonical `politicore.system_audits` via the 0002 authority-audit trigger — one audit stream, one read path (action `donations:insert`, actor pinned).

## G. Testing

| Gate | Result |
|---|---|
| Focused security suite | `tests/security/content-domains.test.ts` — **24/24** (events 4, announcements 7, news 2, contact 3, single-row 2, donations 3, static boundary 3 — positive, negative, cross-tenant and combined-model-absence pins) |
| Full regression | **623/623 — 22 suites — 0 skipped — 0 failed** (previous 599 + 24; locked-module suites all green) |
| Hosted acceptance | **32/32** (`scripts/db/verify-hosted-smoke-content.ts`; real GoTrue sessions + PostgREST + RLS; journeys A–H) |
| TypeScript | `tsc --noEmit` — **0 errors** |
| Build | `npm run build` — **pass** |
| Lint (touched files) | **0 errors**; three pre-existing lint *defects* in touched files were fixed (setState-in-effect ×3 with documented suppression matching the established pattern, unescaped entities, unused imports) — working tree is net-cleaner than HEAD (files-with-issues 58 → 35, errors 65 → 25 across the repo, remainder pre-existing in untouched files) |

Static pins updated with intent preserved (documented): `phaseE-social-force.test.ts` now pins the *stronger* post-cutover state (`firestore.ts` exports nothing at all); member-directory's GlobalSearch "News-only" tolerance superseded by the full boundary test.

## H. Deviations

1. **Public `/events` page is new** — no public events route previously existed (the legacy combined page was portal-only). §7 required one; built in the established public-page style.
2. **Donation audit consolidated into `system_audits`** — the draft 0033 initially created a parallel `donation_audit_logs` table; replaced during self-review with the canonical 0002 audit trigger + `system_audit_logs` view. One audit stream, no second read path (strengthens §2.1/§22 rather than deviating from it).
3. **0033 gained base-table grants** — security_invoker views require caller grants on underlying tables (PostgREST contract discovered via the local suite); grants follow 0009 conventions exactly (anon: SELECT on public families + INSERT on contact only; nothing on announcements/donations/audits).
4. **Draft visibility for same-tenant members** (news/biography/gallery/manifesto/events) — the read policies follow the 0002 same-tenant directory model (tenant-scope visibility + admin management) rather than strict admin-only drafts. Security boundary preserved where §26 demands it: anonymous-published-only and cross-tenant isolation (hosted C2 pins both). Flagged here explicitly as a policy-shape decision.
5. **Geography seeding script** — its Firebase branch (the only remaining `firebase/electoral` consumer) was removed; the script remains as an offline structure verifier since geography now seeds via SQL migrations.
6. **Pre-existing hosted fixture residue removed** — 9 probe tenants (`rt-probe` ×7, `dbg2 notif` ×2) left by earlier phases' failed turns were cleaned during §17 pristine verification.
7. **`listLgaTree()` added to `geography.ts`** — the four surviving nested-tree consumers (signup/profile/dashboard/member-add) needed the canonical `LGA[]` shape; implemented as a minimal shared-Core accessor over three indexed queries (no new geography system).

## I. Lock confirmation

* **Social Force** — untouched (no module file modified; regression green).
* **Campaign** — untouched (Campaign Activities remain the Campaign domain; Events are a separate table/service/UI; regression green).
* **Election** — untouched (no RLS/workflow/result changes; regression green).
* **Notifications** — remain separate; Announcements use their own table/service/UI (hosted B7 + local pins).
* **Events and Announcements are independent** — separate database tables, services, RLS policies, admin UIs, public/portal UIs.
* **No combined Events/Announcements model** — no `content`/`communications`/polymorphic table exists; the legacy combined Firebase store is deleted; static tests pin the separation.
* **No public donation collection** — private admin-only analytical ledger; no checkout/gateway/public form/public route (static + hosted proof).

## Working tree

Intentional phase artifacts only: 0033 migration + `apply-hosted.ts` registration, canonical services (`events.ts`, `announcements.ts`, `news.ts`, `content.ts`, `audit.ts`, `members.ts` barrel wiring, `geography.ts` tree accessor), migrated pages/components, new UIs (`/events`, admin events, portal announcements), security suite + hosted harness, deletion of zero-consumer Firebase files, static-pin updates. Debug probes removed; hosted project verified fixture-free with FORCE-RLS state matching the migrations exactly.

## Recommended Next Phase

```text
Phase 5 — Remaining Firebase seam classification + final Firebase removal gate
```

(Election rollback/seed surfaces, storage seam, diagnostics stubs, and rules tests are now the only Firebase artifacts; they are classified but still present. A final gate should either retire them or ratify their retention permanently.)
