# PolitiCore — Governance Public Intake Architecture Gate Report (Phase 9)

**Status:** PHASE 9 — COMPLETE (architecture gate; **no public intake implemented**)
**Architecture decision:** `docs/Governance-Public-Intake-Gate.md` (§A–O, including the threat model)
**Preceding:** Phase 7 (slice) · Phase 8 (notifications)
**Schema impact:** **No schema change.** Zero migrations. Zero product-code changes. Phase 9's footprint is exactly the gate document + one security suite.

---

## Architecture decision (summary — full detail in the gate document)

| Decision area | Outcome |
| --- | --- |
| External participant | The existing Phase 6 model is canonical: `governance_participants` with `profile_id = NULL` + email/phone; per-tenant contact dedup (partial unique index); no second table, no roles, no new identity system |
| Submission model | **Model 2 — contact-verified submission** (submit → verify → activate → queue). Model 3 (fast-filing + secret) recorded as a deferred second slice; Models 1 (fully anonymous) and 4 (account-required) rejected |
| Secure tracking | **Reference (public identifier) + high-entropy tracking secret (credential)** — ≥128-bit CSPRNG, shown once, hash-only storage, rotatable; lookup exclusively via a narrow SECURITY DEFINER RPC with constant-time compare, module gate, minimal projection, rate limiting. `GET /request/[reference]` anonymous lookup: forbidden |
| Reference-code verdict | `GR-YYYY-XXXXXXXX` = ~32 bits, deterministic from the row id — **identifier only, never a credential** (pinned by test I10) |
| Public submission boundary | Bounded subject/description, tenant-active category, optional Core Geography (all levels optional), contact, consent required; attachments deferred |
| Privacy | Phase 6 three-tier visibility stays authoritative and insert-time-immutable; external participants may eventually see lifecycle *facts* only (`submitted/acknowledged/information_requested/resolved/closed` with `is_public = true`) — never staff response bodies, assignments, staff identities, internal events, or other participants' data |
| Abuse controls | Per-IP (edge) + per-contact (RPC) limits, bounded pending pool, size CHECKs, duplicate-content collapse, CAPTCHA at the front door, tracking-RPC throttling, failed-attempt auditing via canonical `system_audits` — none claimed as implemented |
| Notifications | `Governance → Core notification intent → future Core-owned external delivery (email first)`; no `governance_email_queue`/`sms`/`whatsapp`; portal conversion folds into the Phase 8 Center path |
| Conversion | Explicit, verified-email linking only; Core Identity owns ownership proof; differing contacts never auto-merge; staff decision for differing-email claims; no duplicate participant creation |
| Media | Deferred entirely; future enablement only via the provider-agnostic Media Service with the §I control set |
| RLS strategy | **Zero policy changes**; zero anon base-table grants; public surface = at most two future SECURITY DEFINER RPCs |
| Audit | Canonical `system_audits` with `actor_id = NULL` + `actor_name`/`actor_email` for external attribution — capacity proven (I9), no schema change, no parallel audit tables |
| Tenant configuration | Single `public_intake` toggle (default disabled) in the existing tenancy config, subordinate to `module_enabled('governance')`; no speculative settings |
| First implementation slice | Submit RPC + email verification + tracking-secret issuance/lookup + minimal public page pair + tenant toggle — nothing more |

## Testing

```text
Focused gate suite    governance-public-intake-gate 10/10
  I1 external participant = contact-only domain record (no auth row, no profile, no role)
  I2 per-tenant contact dedup (case-insensitive; cross-tenant rows independent)
  I3 anon reads nothing on all five governance surfaces
  I4 reference enumeration reveals nothing to anon
  I5 submit RPC requires an authenticated participant; no tenant/actor parameters exist
  I6 submission cannot mint assignments; direct assignment insert denied
  I7 event visibility is insert-time immutable (no role can flip is_public)
  I8 module gate binds submission (Governance OFF fails closed)
  I9 system_audits accepts external attribution (actor NULL + name/email)
  I10 reference format pinned as 32-bit identifier (never a credential)
Full regression      679/679 — 28 suites — 0 skipped — 0 failed  (669 + 10, exact)
TypeScript           0 errors
Build                PASS
Lint                 0 errors
```

## Boundary proof

```text
Social Force / Campaign / Election / Core Notifications / Events /
  Announcements / Core Identity / Core Geography / Core Audit — untouched
Governance Phase 7 workflow — preserved (suite green)
Governance Phase 8 notifications — preserved (suite green)
Firebase — fully retired; zero references in Phase 9 files
No public intake UI, no anonymous RPC, no public tracking route, no CAPTCHA,
  no email/SMS integration, no new roles/geography/notification system
```

## Deferred to the next implementation phase

The first public slice exactly as scoped in gate §M (and nothing else): public submit RPC (contact-verified Model 2 with server-side throttling/limits/dedup), email verification + activation, tracking-secret issuance + verified lookup RPC, minimal public submit/track pages, `public_intake` tenant toggle. Explicitly deferred: attachments, Model 3 fast-filing, phone/SMS/WhatsApp channels, participant merge tooling, staff fanout, public accountability surfaces.

**Phase 9 stops at the architecture boundary per the final directive.**
