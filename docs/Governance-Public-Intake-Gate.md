# PolitiCore — Governance Public Intake & External Participant Architecture Gate

**Status:** GO — architecture decision recorded; **no public intake implemented** (§24)
**Type:** Architecture/product gate (Phase 9)
**Preceding:** Governance Architecture Gate (Phase 6) · First Vertical Slice (Phase 7) · Notifications Integration (Phase 8)
**Security suite:** `tests/security/governance-public-intake-gate.test.ts` (10/10)
**Schema impact:** **NONE** — zero migrations required by this gate.

---

## A. External participant model (§2, §4A)

The Phase 6 `governance_participants` representation is confirmed as the canonical external-participant model. **No second table, no new identity system, no roles.**

```text
Portal member:      governance_participants.profile_id = profiles.id  (UNIQUE, 1:1)
External person:    governance_participants.profile_id = NULL
                    email and/or phone present (contact CHECK constraint)
                    display_label = tenant wording (Citizen / Customer / …)
```

Decisions:

* **Required contact fields** — at least one of `email` or `phone` (the existing `governance_participants_contact` CHECK). **Either is acceptable**; email is preferred because verification (§B) and notification delivery (§L) are cheapest and most automatable. Phone-only is allowed but defers verification/delivery to a separately gated channel decision.
* **Both required for particular flows?** No. No flow requires both.
* **Duplicate detection** — the existing partial unique index deduplicates anonymous participants per tenant by `lower(email)`. Phone-only duplicates are accepted in Phase 6 and remain so; if external phone-first intake is ever enabled, a matching partial unique index on phone becomes a *gated schema requirement* — recorded here, not applied.
* **Merging** — out of scope for the first slice. If ever needed: staff-authorized, audited, requested-rows-repointed merge in one transaction; never automatic.
* **Authenticated-linking collision** — `profile_id` is UNIQUE; the existing submit RPC upserts on `(profile_id)`. A member filing for the first time always resolves to their own linked participant. See §M for converting an *external* participant.

## B. Submission authentication model (§4B)

Analysis of the four models:

| Model | Security | Privacy | Accessibility | Abuse | UX | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 — fully anonymous | Poorest: unattributable flooding, no recipient binding | Weak: nothing to authenticate tracking against | Best | Worst | Simplest | Rejected |
| 2 — contact verification before submit | Strong attribution; verified channel for updates | Strong | Medium (needs email access) | Strong controls possible | Extra step before filing | **Adopted** |
| 3 — submit now + secret for tracking | Medium: attribution deferred; secret becomes the sole credential | Medium | High | Needs strict throttling (unverified intake) | Fastest filing | Deferred — second slice |
| 4 — account required | Strongest | Strong | Poorest: excludes non-members | Strongest | Portal signup is a real barrier | Rejected — defeats the purpose |

**Decision: Model 2 — contact-verified submission** is the future public entry: submit contact + request → verify (email OTP/magic-link at the implementation phase; no SMS in the first slice) → request activates and enters the staff queue. Until verification, the request sits in a pre-active state invisible to staff workflows (implementation-phase mechanism, to be designed against this gate).

Model 3 is explicitly recorded as a **deferred second slice** (fast filing with a tracking secret), not silently dropped. Models 1 and 4 are rejected.

## C. Secure tracking model (§5, §6, §9)

**Reference-code security verdict (§6):** the existing `GR-YYYY-XXXXXXXX` code is `GR-` + year + the first 8 hex chars of the request UUID — **~32 bits, deterministic from the row id**. It is an **identifier only, never a credential** (pinned by test I10). Public lookup by reference alone is therefore forbidden (§9): enumeration of 32 bits is feasible at scale and each hit would confirm a case exists.

**Decision: reference (public identifier) + high-entropy tracking secret (credential).**

* Tracking secret: ≥ 128 bits of CSPRNG entropy, generated at verification, **shown once** to the participant, stored **hash-only** (same discipline as password hashing), never stored in plaintext, rotatable.
* Public lookup model: `reference + tracking secret` together, served exclusively through a narrow SECURITY DEFINER RPC that (a) validates a constant-time hash match, (b) enforces `module_enabled('governance')`, (c) returns only the public/participant-visible projection (§E), (d) is rate-limited (§F). **No `GET /request/[reference]` anonymous lookup, ever.**
* Never implemented: reference-as-credential, sequential/enumerable identifiers, magic-link-only access without contact verification (magic links are a *delivery* channel for the verified flow, not the tracking credential).

## D. Public submission boundary (§10)

Anonymous visitors may submit, through a controlled server-side RPC (never base-table grants):

* subject, description (bounded length — limits set at implementation), category (tenant-active only), optional Core Geography (State → Zone → LGA → Ward → Polling Unit, every level optional — no forced Ward/PU), contact (email and/or phone), full name, explicit consent/privacy acknowledgement (required — no consent, no submission).
* **Attachments: deferred** (§K).
* The client can never supply `tenant_id`, `participant_id`, `actor` identity, status, or assignment data — all server-resolved (proven: the authority surface has no such parameters, test I5).

## E. Privacy model (§8, §19)

The Phase 6 three-tier event visibility (`is_public` / participant-authored / internal) remains authoritative and is **insert-time and immutable** (append-only trail; no application role can flip `is_public` — proven, test I7). External participants can eventually see, only through the verified tracking channel: reference, submitted date, **high-level status**, and lifecycle events of kinds `submitted / acknowledged / information_requested / resolved / closed` that are `is_public = true`. They can **never** see: internal/public staff response bodies, assignments and staff identities, internal events, other participants' requests, tenant categories configuration (beyond active category names for filing), audit records, notification records, staff contact details. Note the deliberate asymmetry: staff *response* bodies stay participant-visible-only (not public); lifecycle *facts* may be public.

## F. Abuse controls (§7)

| Control | Owner | Decision |
| --- | --- | --- |
| Per-IP rate limiting (submission + tracking attempts) | Edge/infra (hosting layer) | Required at implementation; architecture position recorded here |
| Per-contact cooldowns (same email/phone window) | Governance RPC (server-side) | Required in the public submit RPC |
| Unverified-intake flood cap (bounded pending pool) | Governance RPC | Required — pending pool MUST be bounded |
| Request size limits (title/details lengths) | Governance RPC | Required — DB CHECKs at implementation |
| Duplicate-content detection | Governance RPC | Required — identical pending contact+title collapses |
| CAPTCHA/challenge | Edge/infra | Recommended; owned by the front door, not Governance |
| Enumeration throttling on tracking RPC | Edge + RPC | Required — constant-time compare, logged failures |
| Abuse monitoring/auditing of failed attempts | Core `system_audits` | Required — no parallel audit table |

No control is claimed as implemented today. The authenticated workflow remains untouched by all of this.

## G. Notification model (§12)

Boundary: `Governance → Core notification/event intent → future external delivery mechanism (Core-owned)`. External participants have no Notification Center row to receive; the **only** sanctioned evolution is a **Core-owned external delivery channel** (email first) consuming Core notification intents — *no* `governance_email_queue`/`governance_sms_queue`/`governance_whatsapp`, no delivery infrastructure in Governance. SMS/WhatsApp/push remain future Core decisions. Portal conversion (§M) folds the participant into the existing Phase 8 Center path.

## H. Participant conversion (§13)

When an external participant later creates a portal account **with the same verified email**, the linking is **explicit and verified — never implicit**:

* The account-creation flow (Core) or a staff action attempts the link by canonical (`lower(email)`) match.
* Because the email was already contact-verified for intake, same-email linking is permitted; **no automatic merge of differing contacts occurs** — a differing contact creates a normal linked participant via the existing upsert, and the external row stays separate.
* Collision handling: `profile_id` UNIQUE forbids double-linking; takeover prevention rests on Core Identity's account-ownership proof (email ownership), never on participant-row possession. Staff approval is **not** required for same-verified-email linking; a differing-email claim is a staff decision.
* After linking, existing external cases appear in My Requests through the normal ownership path; no data movement, no duplicate participant creation (test I2's dedup + the UNIQUE constraint are the enforcement).

## I. Media policy (§11)

**Deferred.** First public slice has no attachments. When later gated: only via the existing provider-agnostic Media Service, authenticated-scoped upload through a server-issued intake context (never direct provider uploads), size/MIME allow-lists, malware scanning owned by the Media/Media-adjacent Core layer, participant-scoped visibility, explicit retention/deletion policy — all recorded as *requirements for that gate*, none implemented.

## J. RLS / security strategy (§17)

**Zero change to existing policies.** The five governance tables keep FORCE RLS with no anon grants (proven live on hosted in Phase 6; tests I3/I4). The public surface is deliberately narrow:

* `anon` may call **at most two** future SECURITY DEFINER RPCs (public submit with server-side throttling/limits; verified tracking lookup with constant-time secret comparison). No base-table grants to `anon` — now or ever. Public writes flow only through controlled RPC entry points; base tables stay invisible.
* Role matrix: `anon` → the two RPCs only; `external participant` → nothing (a contact row is not a session); `authenticated member` → unchanged Phase 7 surfaces; `staff/admin` → unchanged queue/case authority; `service_role` → unchanged operational paths.

## K. Audit strategy (§18)

Canonical `system_audits` remains the sole owner — `actor_id` is already nullable with `actor_name`/`actor_email` (proven by test I9), so external attribution (`actor_id = NULL` + contact name/email + `action='governance_requests:public_insert'`) requires **no schema change**. Staff processing continues to audit through authenticated server-side attribution. No `governance_public_audit`/`anonymous_audit` structures.

## L. Tenant configuration (§15)

**Minimal, deferred to the implementation phase, owned by the existing tenancy model:** a single `public_intake` governance-config entry (enabled/disabled, default **disabled**) inside the existing tenant configuration mechanism — subordinate to `module_enabled('governance')` (§16: Governance OFF ⇒ backend rejects public submission outright; the config can only narrow an enabled module). Display label already exists (`display_label`). **No speculative settings** (verification mode, allowed-categories, attachment policy, public-status visibility): all fixed by this gate for the first slice and revisited only when a product need is demonstrated.

## M. First implementation slice (§22)

Exactly:

1. Public submit RPC (Model 2): contact + request + consent → pre-active pending state, server-side throttling/limits/dedup.
2. Email verification step (Core-owned delivery) → activation → enters the existing queue.
3. Tracking secret issuance (shown once, hash-stored) + verified tracking lookup RPC (§C projection).
4. Minimal public page pair (submit + track) outside the portal.
5. `public_intake` tenant toggle wired subordinate to the module gate.

Explicitly excluded from the slice (future gates): attachments (§I), Model 3 fast-filing, phone/SMS/WhatsApp channels, public accountability dashboards, Projects/Surveys/Petitions/Town Halls, staff fanout, merge tooling.

---

## N. Threat model (§20)

| # | Threat | Impact | Existing protection | Required future protection |
| --- | --- | --- | --- | --- |
| 1 | Reference-code enumeration | Case existence/content disclosure | 32-bit code disclosed only to its participant; **zero anon read surface** (I3/I4) | Reference+secret tracking RPC; rate-limited; constant-time compare |
| 2 | Tracking-token theft | Access to one case | N/A — not yet implemented | ≥128-bit CSPRNG secret, hash-only storage, shown once, rotatable, revocable |
| 3 | Account takeover via participant rows | Case hijack | profile_id UNIQUE; Core Identity owns account proof | Conversion only on Core-verified email ownership (§H) |
| 4 | Fake submissions | Queue pollution, distrust of volume | N/A (public intake not enabled) | Contact verification before queue entry (Model 2) |
| 5 | Spam/flooding | Staff overwhelmed, storage abuse | RPC-only writes; no anon grants | Per-IP + per-contact limits, bounded pending pool, size CHECKs, CAPTCHA at edge |
| 6 | Notification abuse | Harassment via system sends | Notifications only from staff-authorized RPCs (Phase 8) | External delivery only for verified contacts; Core-owned channel |
| 7 | PII exposure | Privacy violation | FORCE RLS everywhere; events immutable/append-only (I7) | §E projection; no contact data in any public payload |
| 8 | Cross-tenant access | Tenant isolation breach | current_tenant_id() in every policy/RPC (hosted-proven) | Tracking RPC binds to the request's tenant; module gate re-checked |
| 9 | Internal-event disclosure | Staff notes leak | No anon surface; participant sees only public+own events | §E: lifecycle facts only, `is_public = true`, never response bodies |
| 10 | Attachment abuse | Malware, illegal content | N/A — attachments deferred | §I requirements before any enablement |
| 11 | Participant impersonation | Acting as another filer | Contact dedup per tenant (I2) | Verification binds the contact; secrets never derivable from contact |
| 12 | Duplicate participant creation | Fragmented case history | Partial unique index on (tenant, lower(email)) (I2) | Same; phone index only if phone-first intake is ever gated in |
| 13 | Rate-limit bypass | Controls defeated | N/A | Edge limits (IP) + server-side per-contact limits; both required |
| 14 | Public query scraping | Bulk case/contact harvesting | Zero anon SELECT on any governance table (I3) | Narrow RPCs only; no list/filter surface; pagination-free projections |

## O. Locked-module verification

Social Force, Campaign, Election, Core Notifications, Events, Announcements — untouched (no file in their surfaces modified by Phase 9). Core Identity/Auth — untouched. Firebase — fully retired, zero references in every Phase 9 file. Governance Phases 7/8 — preserved; full regression green including their suites.
