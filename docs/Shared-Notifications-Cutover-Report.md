# PolitiCore — Shared Notifications Cutover Report

**Status:** PHASE 2 — COMPLETE
**Parent gate:** `docs/Platform-Core-Identity-Gate.md` (Phase 2 of the approved identity-cutover sequence)
**Scope:** Shared portal notification surface (`NotificationCenter` in `src/app/portal/layout.tsx`) cutover from Firebase/Firestore to the canonical Supabase notification system. Clean cutover — no dual read, no fallback, no parallel model. Social Force, Campaign, and Election untouched.

---

## Notification Architecture

- **Canonical implementation (pre-existing, reused — not invented):** `politicore.notifications` table (tenant-scoped, per-user rows with `read_at` read state) exposed through the `public.notifications` security_invoker view; RPCs `my_unread_count` and `mark_notifications_read` (own-rows guard inside the function); `notifications_select_own` / `notifications_insert_admin` RLS policies; `politicore_has_permission`/`current_tenant_id()` server resolvers. Registered for realtime in migration 0009.
- **Migrated consumer:** `NotificationCenter` in `src/app/portal/layout.tsx` — previously the only reader of the Firebase notification store. Now loads via `subscribeMyNotifications` (initial RLS-scoped fetch + postgres_changes realtime, re-fetch always through the authorized path; no client-side recipient filtering), marks single/all read via the guarded RPCs. Realtime semantics preserved (bell updates on new rows); no new provider/context introduced.
- **Service:** single canonical service `src/lib/supabase/notifications.ts` (`listMyNotifications`, `myUnreadCount`, `markNotificationsRead`, `markAllRead`, `adminNotifyMember`, `subscribeMyNotifications`, `watchNotifications`). `adminNotifyMember` inserts **without** `.select()` — matching the write-only dispatch security model (see Security).
- **Announcements section:** the legacy announcements UI was removed rather than migrated. No canonical Supabase announcements store exists; §12/§25 forbid inventing a parallel model or silently re-mapping another store. The section's data had no Supabase equivalent; classified for its owning future phase. Notification presentation, unread indication, navigation/link behavior, and error handling preserved.

## Security

- **RLS:** SELECT restricted to `user_id = auth.uid() OR is_platform_admin()`; INSERT limited to tenant admins with `tenant_id` bound to the server resolver; UPDATE/DELETE denied for members (read-state mutations go exclusively through `mark_notifications_read`, whose own-rows guard lives inside the SECURITY-constrained function). Verified directly against hosted PostgREST and, via raw-SQL session emulation with real JWT claims, against PostgreSQL itself.
- **Tenant isolation:** every path resolves tenant server-side (`current_tenant_id()`); cross-tenant reads return nothing (including id-targeted queries); a foreign tenant admin's insert is denied (403) even with the target tenant id supplied by the client.
- **Recipient isolation:** a recipient sees exactly their own rows; `user_id=eq.<other>` returns zero rows; anon reads return zero/denied.
- **Read/write authorization:** cross-user mark-read is ineffective (RPC flips 0 rows, state verified unchanged); member insert denied (creation is administrative).
- **Key finding (documented, not a defect):** admin notification dispatch is **write-only**. Because the SELECT policy intentionally denies tenant admins read-back of member notifications, an insert that requests `Prefer: return=representation` (PostgREST `RETURNING`) fails RLS on the RETURNING rows — while the identical insert with `return=minimal` succeeds. Proven on hosted with a four-way matrix (base table vs security_invoker view × RETURNING vs not). The production service never requests read-back. Harness check D3 pins this behavior.

## Firebase Boundary

- **Firebase notification consumers before migration:** 1 (`NotificationCenter` in `src/app/portal/layout.tsx`, reading Firestore `notifications` + announcements).
- **Firebase notification consumers after migration:** 0.
- **Removed:** legacy read/mark helpers (`subscribeUserNotifications`, `markNotificationAsRead`, `markAllNotificationsAsRead`) and the announcements loader (`getUserAnnouncements`) — consumer count had reached zero.
- **Remaining in `src/lib/firebase/notifications.ts`:** `createNotification` + `listTenantNotifications` — sole consumer is the legacy diagnostics job (`src/lib/firebase/jobs.ts`, admin health page). Classified, not deleted: writes to a store that now has no reader (dead-but-harmless legacy); removal belongs to the Jobs/diagnostics phase.
- **Remaining Firebase consumers outside this phase (unchanged):** News, Contact, Biography, Gallery, Manifesto, Homepage, Donations, tenant helpers, Member Directory surfaces, Jobs/diagnostics — all later gate phases. **No claim of global Firebase removal.**

## Locked Modules

- Social Force — PASS (untouched; suites green)
- Campaign — PASS (untouched; suites green)
- Election — PASS (untouched; suites green)

## Tests

- **Focused notification security tests:** `tests/security/shared-notifications.test.ts` — **13/13** (RLS positive/negative matrix incl. cross-user/cross-tenant read + mutation denial, anonymous denial, unread/read semantics via RPC, tenant resolution, write-only dispatch contract, static Firebase boundary, portal service contract).
- **Full regression:** **587/587 across 20 suites, 0 skipped, 0 failed** (574 baseline + 13 notification tests, exact).
- **Hosted acceptance:** `scripts/db/verify-hosted-smoke-notifications.ts` — **17/17** on the real hosted project (real GoTrue sign-ins, real PostgREST, real RLS): admin dispatch (D1/D2/D3), recipient isolation (A1–A4), read/unread lifecycle (B1–B5), cross-user and cross-tenant mutation denials (C1/C2), static Firebase boundary of the migrated surface (E1/E2), pristine cleanup (F1).
- **TypeScript:** `npx tsc --noEmit` — 0 errors.
- **Build:** `npm run build` — passed.
- **Lint:** touched files 0 errors, 4 warnings — all verified pre-existing at HEAD (`Flag`, `accessLoading`, `canViewElectionDashboard`, `profile` unused in `layout.tsx`). Two pre-existing `no-explicit-any` warnings in the touched `layout.tsx` were fixed (baseline improved); the pre-existing `any` in `firebase/notifications.ts` (touched file) was also fixed, net-lint-cleaner than HEAD.

## Static Proof

- `subscribeUserNotifications` / `markNotificationAsRead` / `markAllNotificationsAsRead` / `getUserAnnouncements`: **0 live consumers** (their only consumer, the portal layout, is migrated).
- `lib/firebase/notifications` import in the migrated surface (`src/app/portal/layout.tsx`): **0**.
- Hosted harness checks E1/E2 statically assert the migrated file is Firebase-notification-free and wired to the canonical service.

## Working Tree

- Pristine with respect to this phase: debug probes deleted (`__dbg-notif*.ts` removed), no dead imports, no temporary fixtures; hosted project verified free of this phase's fixtures (tenants/users/probe rows = 0) with FORCE-RLS state restored.
- The working tree carries the campaign's established pattern of intentional, uncommitted phase artifacts (previous-phase docs, migrations, tests) — nothing outside this phase's intentional changes was added or reverted.

## Deviations

- The legacy **announcements** panel was removed instead of migrated (no canonical Supabase store exists; creating one would violate the no-parallel-model constraint). This is a visible UI reduction, recorded here explicitly per §13/§25.
- Two pre-existing lint warnings in a touched file were fixed (baseline improvement, permitted by §20) and one pre-existing `any` in the touched legacy file was fixed. Otherwise none.

## Recommended Next Phase

```text
Member Directory Cutover
```

(Phase 3 of the approved Core Identity/Auth migration sequence.)
