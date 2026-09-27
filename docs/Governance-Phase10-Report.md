# PolitiCore — Governance Public Intake & Secure Tracking — Phase 10 Report

**Status:** PHASE 10 — COMPLETE
**Parent gate:** `docs/Governance-Public-Intake-Gate.md` (Phase 9 — LOCKED) · **Previous:** `docs/Governance-Phase9-Report.md`
**Scope:** The Phase 9 §M first public slice only — tenant `public_intake` toggle, contact-verified submission, email-code verification/activation, 256-bit hash-only tracking secret, secure tracking lookup, minimal public submit/track pages, server-side abuse controls, Core Audit integration. **No implementation beyond the slice.**

---

## 1. Implementation

### Migrations (applied locally and to hosted; registered in `scripts/db/apply-hosted.ts`)

| Migration | Content |
|---|---|
| `0037_governance_public_intake.sql` | The slice's substrate: `governance_intake_staging` (hash-only staging: `contact_hash`, `subject_hash`, `token_hash` UNIQUE, `token_expires_at`, `status`, `submission` jsonb — zero PII columns), `governance_tracking_credentials` (`request_id` PK/UNIQUE, `tracking_secret_hash`), `core_delivery_intents` (the Core-owned external email seam), force-RLS on all three with **zero anon policies**, three SECURITY DEFINER implementation RPCs (`governance_submit_public_request`, `governance_verify_public_request`, `governance_track_public_request`) plus internal helpers (`governance_random_hex` UUID-CSPRNG, `governance_constant_time_equal` full-string compare, `governance_public_intake_enabled` = module gate AND `tenant_modules.config->>'public_intake'='true'`), thin `public.*` wrapper one-liners (0007/0034 convention), hygiene REVOKEs on the helpers. Built exclusively on Postgres built-ins (`sha256(bytea)`, UUID-derived randomness) — **no extension dependency**, identical on pglite and hosted. |
| `0038_governance_public_categories.sql` | Fourth wrapper `governance_public_categories(tenant_slug)` — names of ACTIVE categories only, gated on the same intake toggle (anon cannot read the categories table; the form needs the list). |
| `0039–0042` | Idempotent restatements of the final RPC bodies (hosted convergence after the pre-final 0037 application; all registered with signatures in the hosted applier). |

### RPC behavior (all authority server-side; §4/§6/§7)

- **Submit** (`governance_public_intake` → boolean): consent required; tenant resolved **by public site slug** — never a client-supplied tenant id (§21); module + `public_intake` gates; bounded/normalized input; geography validated against **Core Geography** (optional per level; no forced Ward/PU); category must exist and be ACTIVE; duplicate-content **collapse** (identical pending contact+subject reuses the staging row with a **rotated** token — a resend, before throttling), then per-contact 10-minute cooldown, ≤3 pending per contact, global pending-pool cap ≤500 (expired rows swept each call); every attempt audited to `system_audits` — the audit stream **is** the throttle ledger. **Security rejections return `FALSE` so the rejection audit commits; validation failures RAISE.** Creates **no** participant, request, assignment, permission, profile, or Auth user.
- **Verify** (`governance_verify`): hash-lookup of the single-use token (staging row `FOR UPDATE`), 24-hour expiry, optional site-slug tenant binding, gates re-checked at activation (§16), external participant deduped per tenant (case-insensitive contact), request created **directly in the canonical `submitted` state** with a PUBLIC `submitted` event (insert-time visibility — §13), one-time 256-bit CSPRNG secret issued hash-only; returns reference + secret **exactly once** (token consumed; replay/cross-site/expired → generic rejection, audited).
- **Track** (`governance_track`): `reference + secret` required (empty input RAISEs); cross-tenant candidate scan with **constant-time hash comparison**; unknown reference and wrong secret produce the **identical audited empty result** — no existence oracle; per-reference 15-min failed-attempt window (audited, 15 → silently throttled); projection is a strict **public-lifecycle whitelist** (`reference_code, status, created_at, event_kind, event_created_at`) over `is_public` events of the six public lifecycle kinds only — never bodies, staff, assignments, participants, or internal events.

### Service, routes, UI

- `src/lib/supabase/governance-public.ts` — the public service surface: typed errors (gate/config/category/validation/rate/invalid/rpc), `listPublicIntakeCategories`, `submitPublicIntake`, `verifyPublicIntake`, `trackPublicRequest`; exported from the `src/lib/supabase` barrel. The browser never supplies tenant ids, actor ids, status, visibility, or staff identity; the client factory (`getSupabaseClient()` without a session) **is** the anon role.
- `src/app/request/page.tsx` — minimal public submission page (public Header/Footer): category picker via `governance_public_categories`, optional State → LGA → Ward geography through the **existing Core Geography service**, required consent checkbox, verification step on the same page.
- `src/app/request/track/page.tsx` — minimal public tracking page: reference + secret → the minimal lifecycle projection; explicit "no directory, no search" surface.

### Tenant toggle

`public_intake` lives in the existing `tenant_modules.config` jsonb (provisioning-managed, consistent with module activation; no new settings UI — none exists for modules), strictly subordinate to `module_enabled('governance')` via `governance_public_intake_enabled`. Default **off**; no speculative configuration.

### Verification & delivery seam

Codes are server-generated UUID-CSPRNG hex, hash-only in `governance_intake_staging.token_hash`, 24-hour TTL, single-use, rotated on resend, never returned by any read. The email seam is **`core_delivery_intents`** — a Core-owned, force-RLS, zero-anon intent table (the documented minimum per Phase 9 §12 / prompt §8; the future Core provider consumes it). No `governance_*` queue of any kind.

## 2. Security proofs (local suite + hosted harness)

- **Anonymous base-table access: none.** Local: anon SELECTs over every governance/staging/credential table return zero rows or error; anon INSERTs error. Hosted (real PostgREST, anon key): every base table **401/404**, including staging, credentials, and `core_delivery_intents`.
- **SECURITY DEFINER boundary:** only `postgres`/`service_role` bypass RLS (verified live); public reach is exclusively the four wrapper functions; internal helpers explicitly REVOKEd from PUBLIC/anon/authenticated/service_role.
- **Tenant isolation:** site-slug resolution server-side; cross-site token replay rejected (hosted J4); tracking lookup scans candidates cross-tenant but only a constant-time hash match reveals anything, and the projection never discloses the tenant.
- **Gating:** module OFF, toggle OFF, bad category, oversized subject all fail closed over the wire (hosted J2); gates re-checked at activation.
- **Enumeration:** wrong secret ≡ unknown reference (identical empty result + identical audit shape); reference is a 32-bit identifier, never a credential; no `GET /request/[reference]` surface exists.
- **Secret hygiene:** 256-bit CSPRNG, sha256-hash-only storage, plaintext shown once in the activation response, never derivable from id/reference, hash never returned.
- **Minimal projection:** exact column set pinned by test 18 (OUT parameters of the RPC — a function, not a table) and hosted J6 (`created_at,event_created_at,event_kind,reference_code,status`).
- **No minted authority:** the public path creates no assignments/permissions/roles — boundary pin 29 (no anon/authenticated grants on the intake tables) plus test 21 (every assignment on an external-participant case is staff-attributed via the authority RPCs).
- **Audit:** all intake/verify/track attempts and rejections in canonical `system_audits` with `actor_id = NULL` + `actor_name`/`actor_email` external attribution (Phase 9 §K model); rejection audits **commit** (security rejections return FALSE instead of raising, so the ledger persists).

## 3. Testing

```text
Focused Phase 10 suite: 28/28  (tests/security/governance-public-intake.test.ts)
Full regression:       707/707 (29 suites — 679 baseline + 28 new; 0 skipped, 0 failed)
TypeScript:            PASS (0 errors)
Build:                 PASS
Lint (touched files):  PASS (0 errors)
Hosted acceptance:      8/8  (scripts/db/verify-hosted-smoke-governance-intake.ts)
Hosted residue:         0 fixtures (tenants, staging, credentials, intents,
                        participants, auth users, audits — all zero)
```

Hosted journeys: J1 zero anon surface · J2 gates fail closed · J3 staging-without-identity · J4 activation + replay/cross-site rejection · J5 canonical staff workflow on a public case · J6 no-oracle tracking + minimal projection + audited failures · J7 duplicate collapse + cooldown over the wire · J8 participant dedup.

## 4. Boundary confirmation

```text
Social Force untouched          Core Notifications reused, not redesigned
Campaign untouched              Events / Announcements untouched
Election untouched              Core Geography reused (no new geography)
Core Identity untouched (no Auth/profile/role creation on the public path)
Core Audit reused (no parallel audit/abuse tables)
Firebase remains fully retired
No attachments / Media · No SMS/WhatsApp · No Model 3 fast-filing
No participant merge tooling · No CAPTCHA (deferred by the gate)
No public directory / search / accountability surfaces
No second participant/request/notification/audit/geography system
```

Phase 7 (vertical slice) and Phase 8 (notifications) remain green inside the full regression; the activated public case enters the unmodified canonical lifecycle and produces Core notifications through the Phase 8 path.

## 5. Deviations from the Phase 9 gate

1. **Security-rejection contract:** the gate/prompt anticipated "rejected" outcomes; the implementation refines this into **validation failures RAISE** (nothing to persist) while **security rejections return FALSE / empty and COMMIT their rejection audit** — necessary because an RAISE would roll back the audit INSERT, and the audit stream is the throttle ledger. Documented in-code and tested (23, 24).
2. **Tracking rejection shape:** wrong-secret/unknown-reference return an **empty result with no error** (not a distinct "denied" marker) — required for the no-existence-oracle property; the application service maps emptiness to its typed error. Tested (16) and proven live (J6).
3. **Delivery seam:** `core_delivery_intents` is introduced as the minimum Core-owned intent boundary (prompt §8 explicitly authorizes this); actual email delivery remains a Core-owned future provider. No Governance delivery infrastructure exists.
4. **Restatement migrations 0039–0042:** bookkeeping of hosted convergence for the RPC bodies (0037 was applied to hosted mid-development before its final form). No semantic content beyond the final 0037 bodies.

Everything else follows the Phase 9 gate verbatim. **Stopped at the slice boundary** — no Projects, no public accountability surfaces, no attachments, no Model 3, no staff fanout.
