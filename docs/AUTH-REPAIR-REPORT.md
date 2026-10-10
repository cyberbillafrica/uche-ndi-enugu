# PolitiCore — Auth Repair Report

**Task:** Critical Repair — Supabase Authentication, Registration, Invitations & Password Recovery
**Baseline:** through `0069_tenant_lifecycle_enforcement.sql` (Phase 31, preserved untouched)
**Scope:** standalone auth-repair task; no Phase 32 features; no unrelated refactors

---

## 1. Root causes (confirmed by inspection)

### Symptom 1 — "Registration appears to succeed, but no usable profile appears"
**Confirmed cause chain.** The application **always showed a green "Registration Successful!" success
page for any non-null `data.user`**, regardless of the actual signup disposition:

* When the hosted project requires **email confirmation** (GoTrue `GOTRUE_MAILER_AUTOCONFIRM=false`),
  `auth.signUp()` returns a `user` row but **no session**. The account exists, email-unconfirmed.
* The 0007 provisioning trigger `trg_on_auth_user_created` fires immediately on `auth.users` INSERT
  (correctly, idempotently via `ON CONFLICT (id) DO NOTHING`), so a **profile is normally created**.
* However the **application then directs the user to "Login Now"**, and GoTrue rejects the password
  grant with `Email not confirmed` → symptom 2.
* Additionally, `src/app/volunteer/page.tsx` treated any thrown/user-null outcome loosely, and signup
  API errors surfaced as a raw toast string (no accurate, actionable messaging).
* A **profile can also legitimately NOT exist** for a served-but-unconfirmed tenant_slug signup
  aborted mid-trigger (transactional rollback) — the old UI had no recoverable state for that either.

**No migration defect.** Verified: `0007.backfill_profile_on_signup` creates plain-member profiles,
idempotently; `0002` profile guard and RLS are intact; `0010` closes the NULL-subject guard bypass.

### Symptom 2 — "Newly registered account can't log in"
**Direct consequence of 1**: the user is bounced to `/login` before confirming; login fails with
`Email not confirmed`, which the login page mapped (correctly) to a friendly message but the overall
journey had already misrepresented activation. **The repair: distinguish
confirmation-required vs. activated outcomes at signup time.**

### Symptom 3 — "Invitation emails cannot complete authentication"
**Confirmed cause.** There is **no email-link callback surface in the application at all**:

* No `/auth/callback`, no `/confirm`, no `verifyOtp`/`exchangeCodeForSession` call-site anywhere
  (`grep` evidence across `src/`).
* The shared Supabase client is configured with `detectSessionInUrl: false` — deliberate for
  ordinary navigation, but nothing re-establishes a session at any route after an email link.
* Therefore every GoTrue invitation email link dies: either at an unknown app path or (with Site
  URL set to the app root) lands unverified with no handler.

**Deeper gap (honest disclosure):** the repository **has no invitation-generation mechanism.** The
only member-creation path is `createMemberByAdmin` (ephemeral secondary client + 0007 trigger).
Dashboard-initiated invitations carry no `tenant_slug` metadata → trigger correctly provisions
**no profile** → even a working callback cannot turn such an invite into a tenant membership.
Per the task's security constraints (no public admin endpoint), **no public provisioning endpoint
was invented.** The application now handles the acceptance-side correctly (§ Implemented flows
below), but **invitation generation remains a documented gap requiring the specified authorized
server-side path** to be useful end-to-end.

### Symptom 4 — "Password-reset emails have no application flow"
**Confirmed cause.** No `/forgot-password`, no `/reset-password`, no `resetPasswordForEmail` call,
no `updateUser` call anywhere. Recovery emails had **no destination at all**.

### Symptom 5 — Supabase URL/template misconfiguration
The dashboard's Site URL / Redirect URLs / template links must point at implemented routes (§5
below). A redirect allowlist alone would never have fixed symptoms 1–4; the route implementations
were the real work.

---

## 2. Files changed

**New:**
| File | Purpose |
|---|---|
| `src/lib/supabase/authLinks.ts` | Canonical callback path, internal redirect allowlist, `safeInternalRedirect()` open-redirect defense, callback URL construction |
| `src/app/auth/callback/page.tsx` | ONE canonical email-link handler: token-hash `verifyOtp` (signup/invite/recovery/…), PKCE `exchangeCodeForSession`, provider error states, validated `next` routing, recovery hand-off |
| `src/app/forgot-password/page.tsx` | Recovery request; **neutral** outcome (no account-existence disclosure) |
| `src/app/reset-password/page.tsx` | Verified-recovery-session gate + password validation + `updateUser` + fail-closed states for expired/invalid links |
| `tests/security/auth-repair.test.ts` | 26 focused tests (§7) |

**Modified:**
| File | Change |
|---|---|
| `src/lib/supabase/auth.ts` | `signUpVolunteer` and `signUpBareIdentity` now pass `emailRedirectTo` → canonical callback with correct `type` + validated `next` |
| `src/app/volunteer/page.tsx` | Accurate outcomes: session-vs-confirmation detection, actionable signup-error mapping, truthy success panel ("Almost there!" for pending confirmation) |
| `src/app/onboarding/page.tsx` | Confirmation-required bare signups no longer push to `/onboarding/complete` without a session; explicit recoverable "we sent a confirmation link" state |
| `src/app/login/page.tsx` | Added "Forgot your password?" link; fixed pre-existing unescaped apostrophe (baseline lint error) |
| `src/lib/supabase/index.ts` | Barrel export `./authLinks` |

**Not changed (deliberately):** `contexts/AuthContext.tsx`, `portal/layout.tsx`, `onboarding/complete`,
`onboarding/resume`, any migration file, `AuthContext` public contract, locked modules.

---

## 3. Database changes

**None required.** Inspection proved every DB-side contract correct:
0007 trigger (immediate, idempotent provisioning from `tenant_slug` metadata), 0002 profile guard,
0009 security_invoker views, 0012 JWT hook shape, 0069 `assert_tenant_operationally_active` +
lifecycle matrix (preserved byte-for-byte). No new migration was created after 0069 → the "schema
changes" section of the acceptance evidence is vacuously satisfied; hosted application status is
unchanged by this task.

---

## 4. Implemented flows

| Flow | Route(s) | Behavior |
|---|---|---|
| Ordinary registration | `/volunteer` → `/auth/callback?type=signup` (email link) | Accurate success/confirmation-pending outcomes; duplicate-safe (trigger `ON CONFLICT`); no privileged path |
| Login | `/login` | Existing (validated working); friendly error mapping preserved |
| Confirmation | `/auth/callback` | `verifyOtp({ type: 'signup', token_hash })`; session validated, not inferred from URL |
| Invitation acceptance | `/auth/callback?type=invite` | `verifyOtp({ type: 'invite' })` → real session → validated `next`; tenant/role resolved **by the session, never from URL** |
| Password recovery | `/forgot-password` → `/auth/callback?type=recovery` → `/reset-password` | Neutral request response; verified recovery hand-off; existing-session replacement before recovery grant; validated password + `updateUser` |
| Owner onboarding | `/pricing` → `/onboarding` → (email) → `/onboarding/resume` → `/onboarding/complete` | Bare identity preserved; confirmation-required signups recover via `onboarding_state()`; no premature/duplicate tenant or owner profile |

Open-redirect defense: `safeInternalRedirect` allowlist with strict internal-path-only semantics
(`//host`, schemes, encoded `%2F` bypasses, backslashes, traversal — all rejected; see tests).
No token/OTP/code is logged anywhere in the new modules, and no service-role credential is
referenced in any client-bundled file.

---

## 5. Supabase Dashboard configuration (manual — I could not reach the dashboard)

> **Set the production origin to your ACTUAL deployed domain.** Do not accept a guessed domain.
> The repository contains one historical default (`https://ifeanyichukwu-2027.vercel.app` in
> `src/app/news/[slug]/page.tsx`) — **verify it in Hosting/Vercel before use** and replace all
> occurrences below if your real production origin differs.

### Site URL
```
https://<your-verified-production-origin>
```

### Redirect URLs (exact list; narrowest allowlist — no wildcards)
Production:
```
https://<your-verified-production-origin>/auth/callback
https://<your-verified-production-origin>/reset-password
```
Local development (port 3000, current project convention):
```
http://localhost:3000/auth/callback
http://localhost:3000/reset-password
```

Rationale: `/auth/callback` consumes every email-link type (signup/invite/recovery/PKCE).
`/reset-password` is included because it is a legitimate deep-link target (`next` param) the
callback may hand off to. **No other URLs are needed**; do not add per-tenant wildcard routes.

### Email templates (Authentication → Templates)
All templates should target the canonical callback with a validated `next` where meaningful.
Token-hash (`{{ .TokenHash }}` + type) is the handler's default verification mode:

**Confirm signup** (Confirmation):
```
https://<origin>/auth/callback?type=signup&next=%2Flogin&token_hash={{ .TokenHash }}
```
*(Use `{{ .ConfirmationURL }}` instead only if you prefer Supabase's default link builder — the
callback also handles standard `?code=` / `?token_hash=` links either way.)*

**Invite user:**
```
https://<origin>/auth/callback?type=invite&token_hash={{ .TokenHash }}
```

**Reset password:**
```
https://<origin>/auth/callback?type=recovery&token_hash={{ .TokenHash }}
```

Magic-link / email-change templates: **not required** — the application does not use those flows
today; do not add speculative routes.

`{{ .SiteURL }}` and `{{ .RedirectTo }}` may be used as variable alternatives, but the repeated
explicit values above are safest for deterministic allowlist matching.

---

## 6. Security verification

| Check | Result |
|---|---|
| RLS policies / FORCE RLS | ✅ untouched (no migration added; 0002/0069 verified intact by suite) |
| Cross-tenant isolation | ✅ `tenant-isolation.test.ts` PASS (chunked suite) |
| Role/permission integrity | ✅ `authorization.test.ts` PASS (18/18) |
| Phase 31 lifecycle enforcement | ✅ `tenant-lifecycle-enforcement.test.ts` PASS |
| Onboarding RPC authority/idempotency | ✅ `saas-self-service-onboarding.test.ts` PASS (49/49) |
| No service-role exposure in browser code | ✅ static scan in `auth-repair.test.ts` (deny-list on SERVICE_ROLE / `DATABASE_URL` in every new client module) |
| No token/OTP/code logging in new modules | ✅ static scan in `auth-repair.test.ts` |
| Invitations cannot construct authority from URL | ✅ callback resolves membership via session only; no tenant/role in URL parsing |
| Recovery cannot be confused with login/invite | ✅ explicit `type` dispatch; recovery replaces any existing session before grant |
| Expired/used/malformed links | ✅ fail-closed error states everywhere; never a bare URL-params → success path |

---

## 7. Test evidence

| Gate | Evidence |
|---|---|
| Focused auth-repair tests | `tests/security/auth-repair.test.ts` — **26/26 PASS** |
| Full regression suite | **49/49 security-suite files PASS, 0 failures** (run sequentially per-file with bounded memory; `SUMMARY failures=0`) |
| Hosted acceptance | **NOT RUN — requires `.env.local` secrets + hosted project access**, which this environment does not provide. Existing hosted scripts are unaffected (`npm run test:hosted`). |
| `npx tsc --noEmit` | ✅ EXIT 0 |
| `npm run build` | ❌ **Environment-blocked.** Repeated attempts (6 modes of memory/worker tuning) and an **unmodified baseline tree** all die by host cgroup OOM at the compile stage (`Memory cgroup out of memory`, evidenced in kernel log). The failure is **environmental**, not caused by the repair — the baseline fails identically and no file in this repair affects bundling inputs beyond routes that type-check cleanly. |
| Changed-file lint | ✅ EXIT 0, 0 warnings (10 files). One pre-existing baseline error (`Don't` unescaped at `login/page.tsx:154`) was fixed in the touched file. Full-repo lint unaffected baseline. |

---

## 8. Manual verification checklist (you must run these)

Real email delivery + Supabase dashboard changes cannot be exercised automatically here.

| # | Step | Expected | Where to inspect (no secrets) |
|---|---|---|---|
| 1 | Register ordinary account at `/volunteer` | If confirmation required — "Almost there! …sent a confirmation link". If auto-confirm — success + signed in | Supabase → Authentication → Users → new user; Table → `politicore.profiles` row with `tenant_id` of `ifeanyi-2027`, `access_role=member` |
| 2 | Open the confirmation email | Lands on `/auth/callback`, then `/login` session active; no token in URL bar | Auth → Users → email confirmed ✓ |
| 3 | Log in | `/portal/dashboard`; profile/tenant load | `politicore.profiles` row visible |
| 4 | Log out / log in | Session cleared and restored | — |
| 5 | Password reset | `/forgot-password` neutral outcome → email → `/auth/callback?type=recovery` → `/reset-password` → new password → login works | Auth → Users → last password-updated; no token shown |
| 6 | Invitation acceptance | Invite link → real session → `/portal/dashboard`; correct tenant membership | `politicore.profiles` row matches invitee identity |
| 7 | Owner onboarding via `/pricing` | `/onboarding` → confirm email if required → `/onboarding/resume` → `/onboarding/complete` → trial tenant active; no duplicates after refresh/back/retry | Table → `tenants` + `subscriptions` rows consistent; `politicore.profiles` has one owner row per identity |
| 8 | Restricted tenant login | Session works, but operational surfaces gated by `assert_tenant_operationally_active` — blocked by Phase 31 (unchanged) | Auth → Users row exists; `tenants.lifecycle_status` ≠ active |
| 9 | Public pages without login | `/`, `/manifesto`, `/contact`, `/news`, `/events` all render anon | — |

---

## 9. Remaining blockers

1. **Supabase dashboard URL/template changes (§5) — must be applied manually.** This repair's
   route implementations cannot substitute for the dashboard matching your real deployment origin;
   dashboard values must use the **verified production origin**.
2. **Invitation generation remains a server-side gap.** There is no trusted server-side
   invitation-provisioning function in the repository; `createMemberByAdmin` is the only existing
   authorized creation path. Dashboard-initiated invitations provision no profile (no
   `tenant_slug` metadata). The application now handles the acceptance side, but **completing end-
   to-end invitations requires an authorized server-side provisioning path** the task's security
   constraints (correctly) prevent me from inventing as a public endpoint.
3. **`npm run build` could not complete in this environment.** Baseline failure evidence above;
   tsc + full test suite + lint all pass, and no changed file affects bundling beyond clean-route
   additions. Run `npm run build` on a normal-capacity machine to clear this gate before Phase 32.
4. **Hosted acceptance scripts were not executed** (requires Supabase project credentials present
   as `.env.local`, absent from this environment).
5. **Real email delivery end-to-end** — cannot be exercised automatically in this environment;
   see manual checklist §8.

---
**GATE:**

`AUTH REPAIR: BLOCKED`

*Justification: implementation and local verification gates all have evidence (§7), but §9.1
(Dashboard use of the verified production origin), §9.2 (invitation provisioning gap), and §9.3
(build gate on a normal-capacity machine) remain unsubstantiated — none are code-defeatable, and
each requires either manual dashboard access, an explicitly authorized server-side primitive, or a
non-OOM-constrained build environment. Once those three items are cleared, the gate may be re-run
against the same checklist without further code changes.*
