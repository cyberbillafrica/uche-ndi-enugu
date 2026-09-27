# Campaign Phase B — Implementation Report (Activities)

**Status:** COMPLETE — all acceptance criteria verified.
**Parent gate:** `docs/Campaign-Architecture.md` · **Previous:** `docs/Campaign-PhaseA-Implementation-Report.md`
**Scope:** Campaign Activities UI + service cutover to Supabase/PostgreSQL. No dual-read, no dual-write, no Firebase fallback.

---

## 1. Files changed (this phase)

| File | Change |
|---|---|
| `supabase/migrations/0022_campaign_activities_hardening.sql` | **New.** Closes the §4/§16 direct-mutation path; fixes the Phase A INSERT…RETURNING RLS defect |
| `supabase/migrations/0023_campaign_public_rpc_wrappers.sql` | **New.** Thin `public.*` invoker wrappers for the 4 Campaign workflow RPCs (0015 convention) |
| `src/app/portal/campaign/activities/page.tsx` | **Rewritten** — Firebase → `src/lib/supabase/campaign.ts` (Supabase only) |
| `src/lib/supabase/access.ts` | Added `resolveCampaignAccess` route gate (§15) |
| `src/lib/supabase/campaign.ts` | `updateActivity` retargeted to the 0022 RPC; direct-UPDATE path removed |
| `src/lib/supabase/index.ts` | Re-exports for the gate/service |
| `tests/security/phaseB-campaign-activities.test.ts` | **New** — §16/§17 matrix |
| `scripts/db/verify-hosted-smoke-campaign-b.ts` | **New** — §19 A–J hosted acceptance harness |
| `scripts/db/apply-hosted.ts` | 0021/0022/0023 signature entries |

Phase A files untouched except where listed above; zero Election files touched.

## 2. Migrations

- **0022** — (a) `REVOKE UPDATE` on `politicore.campaign_activities` **and** `public.campaign_activities`; (b) `update_campaign_activity` RPC (field whitelist, per-field authorization, scope-move re-authorization, audit); (c) `can_view_campaign_activity_row()` — row-valued visibility helper replacing the self-reading definer helper in the SELECT policy; (d) `organizer_id DEFAULT auth.uid()`.
- **0023** — `public.set_campaign_activity_status`, `public.update_campaign_activity`, `public.join_campaign_activity`, `public.record_campaign_attendance` as SECURITY INVOKER delegators (all authorization in the `politicore` originals). Required for PostgREST (`/rest/v1/rpc/*`), i.e. for the application service layer itself.

## 3. RPCs added/modified

Added: `update_campaign_activity` (0022). Wrapped: `set_campaign_activity_status`, `join_campaign_activity`, `record_campaign_attendance` (+ the new update RPC) into `public.*` (0023). No existing RPC signature changed.

## 4. UI surfaces migrated

`/portal/campaign/activities` — listing (one RLS-scoped query; **zero client-side scope fan-out**), creation (policy-guarded insert; tenant/creator/status server-pinned), detail editing (0022 RPC only), status workflow (RPC only), RSVP (own-row RPC), attendance (supervisor-recorded fact; the legacy self-service "Check In Now" is intentionally gone), organizer notify, permission-aware controls, database-resolved module gate with explicit denied states (`module_disabled` / `social_only` / `not_a_member`).

## 5. Security model

- Visibility/authority: module gate + tenant + `scope_covers(grantee, record)` polarity + permission (`view/create/manage_activity`) + own-row/participant branches — all server-side.
- Direct PostgREST: INSERT policy-pinned; **UPDATE revoked at both table and view level**; DELETE policy-gated; participants INSERT own-row-only with no attendance columns writable and `USING(false)/WITH CHECK(false)` on UPDATE/DELETE.

## 6. Tests

- **Phase B suite: 80/80** (`phaseB-campaign-activities.test.ts`).
- **Full security regression: 255/255** across 8 suites — Phase A 68, Phase 1A/1B/1C, Election all green.
- `tsc --noEmit`: **0 errors** · `npm run build`: **passes** · touched-file ESLint: **0 errors**.
- Dependency scan: no Firebase/Cloudinary/`user_access`/leaderboard/client-scope-expansion references in the new path.

## 7. Hosted smoke (§19) — `verify-hosted-smoke-campaign-b.ts`

**38/38 checks passed** on the real hosted project (real GoTrue accounts, real JWTs, real PostgREST, real RLS, real RPCs; FORCE-RLS-aware cleanup, pristine verified: 0 activities / 0 notifications / 0 users / 0 tenants remaining).
A — creation + server-pinned identity ✓ · B — ward→PU, sibling denial, PU isolation, zone breadth/exclusion, cross-tenant silence ✓ · C — RPC edit + legal/illegal/out-of-scope/social/cross-tenant status ✓ · D — RSVP join/persist/upsert/foreign-row denial ✓ · E — attendance recorder server-resolved, self/other denied, fact unchanged ✓ · F — module-disabled reads/RPC refused, no cross-module leakage ✓ · G — view PATCH/DELETE abuse denied, anonymous silence ✓ · H — audits (2 events, server actor) ✓ · I — organizer notification ✓ · J — pristine ✓

## 8. Direct PostgREST mutation results (§16)

INSERT: allowed only with pinned tenant/creator/status + permission at scope (spoof/out-of-scope/module-off all 403). PATCH: **403 for every caller** (privilege revoked at view level). DELETE: policy-gated (unauthorized = zero rows affected). RPC-only authority: status/creator/tenant structurally unreachable.

## 9. Defects found and fixed (narrow, none architectural)

1. **Phase A defect — activity creation was broken for every authorized creator.** The SELECT policy used the `STABLE` definer helper `can_view_campaign_activity(id)` which re-reads `campaign_activities`; STABLE functions cannot see rows inserted by the current command, so `INSERT … RETURNING` (PostgREST and `createActivity`) always failed WITH CHECK. Fixed in 0022 via `can_view_campaign_activity_row()` evaluated from bound row values (same semantics; id-based variant retained for participants/join paths). Caught by the Phase B suite's first run.
2. **Hosted API gap — Campaign RPCs were unreachable over PostgREST** (`/rest/v1/rpc/*` 404) because they existed only in `politicore`. Fixed in 0023 with the ratified 0015 thin-wrapper pattern. This affected the real application service layer, not just the harness.
3. **§16 loophole — view-level UPDATE grant.** The public view is auto-updatable and PostgREST checks UPDATE against the view, so the 0021 grant allowed direct `status`/`created_by`/`scope` PATCH by `manage_activity` holders, bypassing the RPC state machine. Revoked in 0022; regression-tested (G1/G2).

## 10. Deviations from the prompt

- **0023 added** (not pre-listed): required by the hosted finding in §9.2; follows the established 0015 convention.
- **Legacy "Check In Now" self-service attendance removed** rather than preserved: it conflicts with §9/§10 (attendance is an operational fact recorded by an authorized supervisor); replaced by supervisor recording with server-resolved recorder identity.
- Status button gating: the premature-completion guard is enforced by the RPC (`cannot be completed before its scheduled start`), so the UI no longer duplicates the clock check.

## 11. Unresolved issues

None.

## 12. Phase C confirmation

**Phase C (Assignments) has NOT started.** No Assignments/Reports/Issues/Coordination UI work, no realtime, no member-directory migration, no Firebase deletions. Hard stop respected.
