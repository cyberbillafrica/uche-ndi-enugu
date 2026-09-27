# PolitiCore — Member Directory Cutover Report (Core Identity Phase 3)

**Status:** PHASE 3 — COMPLETE
**Parent gate:** `docs/Platform-Core-Identity-Gate.md` · **Previous:** `docs/Shared-Notifications-Cutover-Report.md`
**Scope:** Member Directory data-source and authorization cutover from Firebase/Firestore to the canonical Supabase identity model. Clean cutover — no dual-read, no Firebase fallback, no parallel member model, no new authorization system. Social Force, Campaign, and Election untouched and green.

---

## Status

```text
PHASE 3 — COMPLETE
```

## Member Directory Migration

**Discovery (pre-implementation inventory).** Three live Firebase member-directory consumers existed:

| Consumer | Firebase API | Role in phase |
|---|---|---|
| `src/app/portal/admin/members/page.tsx` | `getAllUsers` + `updateUserLifecycleStatus` + `getAllLGAs` | Directory table, filters, exports, lifecycle control |
| `src/app/portal/admin/reports/page.tsx` | `getAllUsers` + `getAllLGAs` | Engagement report, totals, ward performance, geo counts |
| `src/components/search/GlobalSearchModal.tsx` | `getAllUsers` | Member search category |

Zero-consumer proof preceded every removal (repo-wide grep across `src/`, `scripts/`, `tests/`; only allowlist regexes in pre-existing security suites referenced the names).

**Canonical service.** New `src/lib/supabase/members.ts` — the single member-directory boundary:

- `listMembers()` — reads `public.politicore_profiles` (the 0009 security_invoker view over `politicore.profiles`), selecting exactly the fields the directory consumes. Visibility is decided by RLS (0002 `profiles_read`), never by service-layer filtering.
- `setMemberLifecycle()` — calls the new 0032 authority RPC `admin_set_member_lifecycle`.

Exported through the `@/lib/supabase` barrel. No speculative APIs.

**Routes/components migrated.**
- `admin/members/page.tsx` — directory list, search/filters (membership/role/status/LGA/ward), CSV/Excel exports, and lifecycle control now run on the canonical service. Lifecycle modal reason text travels to the server-side audit via the RPC's `p_status_reason`.
- `admin/reports/page.tsx` — totals, membership counts, points aggregation, ward performance map, and the Election Collation & PU Coverage section now use `listMembers` + `listAllWards` + `getGeographyCounts`.
- `GlobalSearchModal.tsx` — member search category reads `listMembers` under the same RLS scope as the directory (privileged tenant-wide for admins, tenant directory per 0002). Campaign activity, Social task, and Election search paths were not modified beyond the member source swap.

**Data contract.** Every consumed Firebase field maps 1:1 onto the canonical profile model — `id, email, full_name, phone, lga_id, ward_id, polling_unit_id, access_role, membership_types, lifecycle_status, status_reason, points, rank, created_at` — with **no gaps and no invented fields**. Sensitive `auth.users` data is not exposed; the directory consumes only the application-facing profile view.

**Search/filter behavior.** Preserved exactly: client-side filter composition over the RLS-scoped directory result set (the pre-existing behavior; result sets are tenant-scoped by the database). No tenant-wide download beyond what the canonical view already authorized, no N+1 queries — ward/LGA labels resolve through two dictionary fetches (`listLgas`, `listAllWards`) instead of nested per-LGA ward scans.

## Authorization

- **Tenant isolation:** reads constrain themselves through `politicore.current_tenant_id()` inside the 0002 policy; no client-supplied `tenant_id`/`scope_id`/`user_id` can widen access (hosted A2/A3 prove id-targeted cross-tenant reads return nothing).
- **RLS:** `profiles_read` (self + same-tenant + platform admin) is the sole directory authority. The 0027-narrowed view remains **SELECT-only** for application roles — verified by test (admin UPDATE/INSERT through the view denied).
- **Lifecycle writes:** server-authoritative only. 0032 `admin_set_member_lifecycle` is SECURITY DEFINER, resolves actor (`auth.uid()`) and tenant **inside** the function, rejects non-admins with an exception (fail closed), bounds the target to the caller's tenant, writes only `lifecycle_status` + `status_reason`, and lands in `system_audits` through the existing 0002 audit trigger. Public wrapper granted to `authenticated` only; the function is the authorization boundary (PostgREST-side EXECUTE is necessary, not sufficient).
- **Permission behavior:** unchanged — the directory adds no permission resolver, no role checks, no client-side authorization engine.
- **Organizational assignments:** geography (LGA/ward labels) consumed from the canonical geography engine; no organizational position was recast as an access role.

## Firebase Boundary

```text
Firebase Member Directory consumers before: 3 files / 4 helpers
  (admin/members page, admin/reports page, GlobalSearchModal;
   getAllUsers, getUserProfile, updateUserProfile,
   updateUserLifecycleStatus)

Firebase Member Directory consumers after:  0
getAllUsers live consumers:                  0
```

**Deleted (zero-consumer proof):**
- `getAllUsers`, `getUserProfile`, `updateUserProfile`, `getUserOrganizationalAssignments` — removed from `src/lib/firebase/firestore.ts` with a removal banner.
- `updateUserLifecycleStatus` — its sole consumer was the directory page; `src/lib/firebase/auth.ts` reduced to a documented empty seam. This completes the Core Identity Phase 1 interim seam ("updateUserLifecycleStatus remains ONLY for the directory page") exactly as that phase's report anticipated.

**Retained (outside this phase, classified):** `getPublishedNews` and the News/Contact/Biography/Gallery/Manifesto/Donations/portal-content/audit/jobs helper families in the shared Firebase files — owning phase is Phase 4 (public/content modules) and later. No claim of global Firebase removal is made.

## Security Tests

`tests/security/member-directory.test.ts` — **12 tests, all passing** (PGlite on real migrations 0001–0032):

- Positive (4): same-tenant directory visibility incl. cross-tenant invisibility; id-targeted own-tenant read; lifecycle suspend by tenant admin with full audit pinning (action `profiles:update`, actor, old/new values, reason persisted); reactivation flow + anonymous RPC rejection with exact audit-row count.
- Negative (5): anonymous directory reads empty; member cannot change anyone's lifecycle (including self); cross-tenant admin cannot touch a foreign-tenant member; unknown target fails closed; admin writes through the 0027 view denied (UPDATE + INSERT).
- Static (3): migrated consumers Firebase-free (GlobalSearch's remaining Firestore import pinned News-only); legacy helpers zero consumers; canonical service code Firebase-free.

## Regression

```text
previous baseline: 587/587 (20 suites)
new total:         599/599 (21 suites)
skipped: 0        failed: 0
```

Two pre-existing static pins documented interim states that this phase's authorized cutover supersedes; both were updated with intent preserved (now pin the stronger post-cutover state: `setMemberLifecycle` present / `updateUserLifecycleStatus` absent; `getAllUsers` export absent). Social Force, Campaign, and Election suites remain green and untouched.

## Hosted Acceptance

`scripts/db/verify-hosted-smoke-members.ts` — **15/15 passed** against the real hosted project (real GoTrue accounts, real JWTs, real PostgREST, real RLS, real RPC):

- A1–A5: admin reads same-tenant directory; cross-tenant members invisible (id-targeted); tenant-B admin sees zero tenant-A rows; member self-row read; anonymous read denied/empty.
- B1–B6: admin suspension via RPC (returns target id); suspension persisted (observed by recipient session); member attempt denied (HTTP 400); cross-tenant admin attempt denied (HTTP 400); reactivation restores; unknown target fails closed.
- C1: audit trail pinned server-side — 2 rows, latest actor = admin, action = `profiles:update`.
- D1–D2: migrated directory surface statically Firebase-free; canonical service + RPC wired.
- E1: pristine cleanup — fixtures removed (tenants=0, profiles=0), FORCE-RLS state restored on the 5 touched tables.

Post-run independent verification: zero leftover `membc-`/`notifc-` fixtures on hosted; hosted RLS state matches migrations exactly (the single non-FORCED table, `profiles`, is migration-intended per 0006/0010 for the provisioning trigger's owner context).

## Quality

- **TypeScript:** `npx tsc --noEmit` — 0 errors.
- **Build:** `npm run build` — pass.
- **Lint:** touched files 0 errors. Two warnings in `admin/reports/page.tsx` (`Calendar`, `AlertTriangle` unused) are pre-existing at HEAD (verified via `git show HEAD | eslint --stdin`). Net lint improvement in touched files: 3 pre-existing errors fixed (2× `no-explicit-any`, 1× setState-in-effect pattern now follows the documented health-page pattern), 9 pre-existing unused-symbol warnings eliminated.

## Locked Modules

- Social Force — PASS (no changes; full suite green)
- Campaign — PASS (no changes; full suite green)
- Election — PASS (no changes; full suite green)

Shared-Core additions were limited to what the cutover requires: migration 0032, `members.ts`, `listAllWards` in `geography.ts`, and the barrel export. No module behavior, ownership, or architecture changed.

## Deviations

1. **Election Collation & PU Coverage counts** (admin reports) previously derived counts by walking the nested Firebase LGA document (`l.wards[].pollingUnits[]`); the canonical geography engine stores these as separate relational tables, so the section now uses the existing `getGeographyCounts()` RPC-shaped helper. Same user-visible numbers, canonical source.
2. **`getAllLGAs` (Firebase electoral geography) was in the migrated directory path** (both admin pages used it for ward-name resolution). Rather than migrating all 8 of its consumers (7 belong to later phases), the two directory pages now use the canonical `listLgas`/`listAllWards`; the shared-Core addition `listAllWards` is the minimal enabling primitive. `getAllLGAs` itself is retained for its remaining later-phase consumers.
3. **Lifecycle reason text** now travels through the RPC (`p_status_reason` → `profiles.status_reason` → audit `new_value`), replacing the legacy helper's parallel `reason_notes` audit column. Server-audited either way; no user-visible behavior change beyond the canonical storage location.

## Working Tree

Pristine — intentional phase artifacts only: migration 0032, `members.ts`, geography addition, three migrated consumers, `apply-hosted.ts` registration, security suite, hosted harness, two superseded-pin test updates, this report. No debug probes or temporary fixtures remain (the earlier notifications-phase probe was already removed in Phase 2). All uncommitted files in the tree belong to the campaign's established per-phase artifact set; nothing outside this phase's scope was modified.

## Recommended Next Phase

```text
Phase 4 — Public/Content Modules Cutover
```

Approved sequence: News → Contact → Biography → Gallery → Manifesto → (Announcements only if a canonical store is actually established — do not invent one) → Site settings → Donations → Homepage. The surviving `getPublishedNews` and `getAllLGAs` consumers become the entry points for that phase's inventory.

Phase 4 work should not begin until this report is reviewed.
