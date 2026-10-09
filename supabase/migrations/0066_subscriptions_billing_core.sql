-- ============================================================================
-- POLITICORE — PHASE 29 — SUBSCRIPTION & BILLING CORE (SaaS PHASE B)
-- ============================================================================
--
-- Implements the Phase 27 gate's Phase B (docs/SaaS-Architecture-Product-
-- Decision-Gate.md §B5–§B9) on top of the PASSED Phase 28 substrate
-- (plans / plan_versions / plan_version_prices + the entitlement-sync
-- primitive). The commercial chain becomes:
--
--   Plan Version → Subscription → billing state → entitlement resolution
--                → EXISTING service_entitlements → EXISTING tenant activation
--                → EXISTING application authorization (RLS/permissions)
--
-- Boundaries held (gate invariants 9/10/14 — same as 0065):
--   * Subscription/billing state NEVER writes permission_grants,
--     user_access, tenant_modules, tenants.status or RLS. The ONLY
--     commercial substrate it touches is the EXISTING
--     platform_settings.settings.service_entitlements map (the same map
--     0065's sync writes — full-map authoritative write, same action).
--   * access_role_enum untouched — the owner is the EXISTING
--     tenant_super_admin; no billing role; no new permissions (count 43);
--     no new business modules (module_code_enum untouched).
--   * No PSP SDK / no provider logic in the core: provider identity is
--     DATA (text), behavior lives in the adapter seam (TypeScript) and
--     the manual/offline adapter, whose only functional path is a
--     platform-admin-recorded VERIFIED payment flowing through the SAME
--     state machine as any future provider payment.
--
-- Canonical conventions (documented for the phase report):
--   * Timezone: UTC everywhere — every timestamp is timestamptz computed
--     from the server clock (never browser-supplied). Billing periods are
--     half-open [start, end) anchored at the instant that created them;
--     renewals chain from the previous period end (no drift).
--   * Money: integer minor units (kobo for NGN), bigint. No FX anywhere:
--     a subscription records its agreed currency; invoices snapshot it;
--     multi-currency happens by selecting a price row in that currency
--     (Phase 28's normalized prices), never by conversion.
--   * Dunning: grace_period_days / max_payment_retries live in the
--     EXISTING platform_settings.settings.billing map — tunable WITHOUT a
--     migration via set_billing_config (audited).
--   * Plan changes: effective NEXT BILLING PERIOD (V1, documented) via
--     pending_plan_version_id; applied by the renewal processor or at
--     trial conversion — never a mid-period rewrite of commercial
--     references, never a mutated plan version or invoice.
--   * Trial: a subscription state (trialing), never a tenant state. 14
--     days from the plan version (Phase 28 D3), no payment method, no
--     auto-charge; expiry is deterministic (process_trial_expiries).
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ENUMS + TABLES
-- ═══════════════════════════════════════════════════════════════════════

-- Subscription lifecycle (subscription state — never tenant state).
CREATE TYPE politicore.subscription_status_enum AS ENUM
  ('trialing', 'active', 'past_due', 'restricted', 'cancelled');

-- Billing cadence (independent rows in plan_version_prices — annual is
-- never derived from monthly).
CREATE TYPE politicore.billing_interval_enum AS ENUM ('monthly', 'annual');

-- Invoice lifecycle (§13) — DB-enforced transitions below.
CREATE TYPE politicore.invoice_status_enum AS ENUM
  ('draft', 'issued', 'paid', 'past_due', 'void', 'refunded');

CREATE TYPE politicore.payment_status_enum AS ENUM
  ('pending', 'succeeded', 'failed', 'refunded');

CREATE TYPE politicore.payment_attempt_status_enum AS ENUM
  ('pending', 'succeeded', 'failed');

CREATE TYPE politicore.refund_status_enum AS ENUM
  ('pending', 'succeeded', 'failed');

-- Credits: explicit commercial adjustments (§21) — no silent edits of
-- historical invoices; applications land on DRAFT invoices only.
CREATE TYPE politicore.credit_status_enum AS ENUM
  ('issued', 'applied', 'void');

-- Provider/webhook journal processing states (§18).
CREATE TYPE politicore.billing_event_status_enum AS ENUM
  ('received', 'processed', 'rejected', 'failed');

-- Subscription items (§9): base plan at launch; conservative add-on seam
-- that is NOT a second module taxonomy and NOT permission-equivalent.
CREATE TYPE politicore.subscription_item_type_enum AS ENUM ('base_plan');

-- ── The tenant's commercial agreement ───────────────────────────────────
-- One LIVE subscription per tenant (partial unique index below). Ended
-- subscriptions are historical facts and are immutable. plan_version_id
-- is frozen by the guard trigger except for the audited next-period plan
-- change (pending_plan_version_id applied at renewal/conversion).
CREATE TABLE politicore.subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  plan_version_id        uuid NOT NULL REFERENCES politicore.plan_versions(id) ON DELETE RESTRICT,
  status                 politicore.subscription_status_enum NOT NULL DEFAULT 'trialing',
  billing_interval       politicore.billing_interval_enum NOT NULL,
  currency               text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  trial_start            timestamptz,
  trial_end              timestamptz,
  trial_reminder_sent_at timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  cancelled_at           timestamptz,
  ended_at               timestamptz,
  -- dunning bookkeeping (server-derived; never client-reported)
  failed_payment_count   integer NOT NULL DEFAULT 0 CHECK (failed_payment_count >= 0),
  past_due_since         timestamptz,
  -- V1 plan change: effective next billing period
  pending_plan_version_id uuid REFERENCES politicore.plan_versions(id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- Paid states always carry a settled period; a trial never does; the
  -- trial window persists into restricted (deterministic expiry evidence).
  CHECK ( status NOT IN ('active', 'past_due')
          OR (current_period_start IS NOT NULL AND current_period_end IS NOT NULL) ),
  CHECK ( status <> 'trialing' OR trial_end IS NOT NULL ),
  CHECK ( status <> 'trialing' OR current_period_start IS NULL ),
  CHECK ( (status = 'cancelled') = (ended_at IS NOT NULL) )
);

-- Exactly one live subscription per tenant.
CREATE UNIQUE INDEX subscriptions_one_live_per_tenant
  ON politicore.subscriptions (tenant_id) WHERE ended_at IS NULL;
CREATE INDEX subscriptions_tenant_idx  ON politicore.subscriptions (tenant_id);
CREATE INDEX subscriptions_status_idx  ON politicore.subscriptions (status);
CREATE INDEX subscriptions_period_end_idx ON politicore.subscriptions (current_period_end)
  WHERE status = 'active';
CREATE INDEX subscriptions_trial_end_idx ON politicore.subscriptions (trial_end)
  WHERE status = 'trialing';
CREATE INDEX subscriptions_past_due_idx ON politicore.subscriptions (past_due_since)
  WHERE status = 'past_due';

-- ── Subscription items (§9): base plan now; add-on seam for later ──────
CREATE TABLE politicore.subscription_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id       uuid NOT NULL REFERENCES politicore.subscriptions(id) ON DELETE RESTRICT,
  tenant_id             uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  item_type             politicore.subscription_item_type_enum NOT NULL DEFAULT 'base_plan',
  plan_version_id       uuid REFERENCES politicore.plan_versions(id) ON DELETE RESTRICT,
  capability_reference  text,
  quantity              integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor      bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval      politicore.billing_interval_enum NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  CHECK ( (item_type = 'base_plan') = (plan_version_id IS NOT NULL) ),
  CHECK ( (item_type = 'base_plan') = (capability_reference IS NULL) )
);

CREATE UNIQUE INDEX subscription_items_one_live_base_plan
  ON politicore.subscription_items (subscription_id)
  WHERE item_type = 'base_plan' AND status = 'active';
CREATE INDEX subscription_items_subscription_idx ON politicore.subscription_items (subscription_id);

-- ── Invoices (§12/§13): immutable commercial facts ──────────────────────
-- Snapshots EVERYTHING needed to render correctly forever: plan identity,
-- name, version, currency, amounts, period. Never reconstructed from
-- current plans data.
CREATE TABLE politicore.invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  subscription_id    uuid NOT NULL REFERENCES politicore.subscriptions(id) ON DELETE RESTRICT,
  plan_version_id    uuid NOT NULL REFERENCES politicore.plan_versions(id) ON DELETE RESTRICT,
  plan_code          text NOT NULL,
  plan_name          text NOT NULL,
  plan_version       integer NOT NULL CHECK (plan_version >= 1),
  billing_interval   politicore.billing_interval_enum NOT NULL,
  currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL CHECK (period_end > period_start),
  subtotal_minor     bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_credits_minor bigint NOT NULL DEFAULT 0 CHECK (discount_credits_minor >= 0),
  tax_minor          bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor        bigint NOT NULL CHECK (total_minor >= 0
                        AND total_minor = subtotal_minor - discount_credits_minor + tax_minor),
  refunded_minor     bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= total_minor),
  status             politicore.invoice_status_enum NOT NULL DEFAULT 'draft',
  invoice_number     text UNIQUE,
  issued_at          timestamptz,
  due_at             timestamptz,
  paid_at            timestamptz,
  voided_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ( (status = 'draft') = (issued_at IS NULL) )
);

CREATE INDEX invoices_tenant_idx     ON politicore.invoices (tenant_id, created_at DESC);
CREATE INDEX invoices_subscription_idx ON politicore.invoices (subscription_id);
CREATE INDEX invoices_status_idx     ON politicore.invoices (status);

-- Line items snapshot at billing time (frozen once the invoice issues).
CREATE TABLE politicore.invoice_line_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES politicore.invoices(id) ON DELETE RESTRICT,
  item_type       text NOT NULL DEFAULT 'base_plan',
  description     text NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  plan_version_id uuid REFERENCES politicore.plan_versions(id) ON DELETE RESTRICT,
  quantity        integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoice_line_items_invoice_idx ON politicore.invoice_line_items (invoice_id);

-- ═══════════════════════════════════════════════════════════════════════
-- (sections 2+ appended below)
-- ═══════════════════════════════════════════════════════════════════════

-- ── Payments (§14): actual money movement; provider identity is DATA ────
CREATE TABLE politicore.payments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  subscription_id           uuid REFERENCES politicore.subscriptions(id) ON DELETE RESTRICT,
  invoice_id                uuid NOT NULL REFERENCES politicore.invoices(id) ON DELETE RESTRICT,
  amount_minor              bigint NOT NULL CHECK (amount_minor > 0),
  currency                  text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status                    politicore.payment_status_enum NOT NULL DEFAULT 'succeeded',
  provider                  text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),
  provider_payment_reference text NOT NULL CHECK (length(provider_payment_reference) BETWEEN 1 AND 200),
  notes                     text,
  recorded_by               uuid,
  received_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- idempotency: the same provider reference can never create two payments
  UNIQUE (provider, provider_payment_reference)
);

CREATE INDEX payments_invoice_idx ON politicore.payments (invoice_id);
CREATE INDEX payments_tenant_idx  ON politicore.payments (tenant_id, received_at DESC);

-- ── Payment attempts (§15): every attempt to satisfy an invoice ─────────
-- Failure information is SERVER/PROVIDER-derived; client claims such as
-- `payment_success = true` are never accepted (no client write path).
CREATE TABLE politicore.payment_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  invoice_id          uuid NOT NULL REFERENCES politicore.invoices(id) ON DELETE RESTRICT,
  attempt_number      integer NOT NULL CHECK (attempt_number >= 1),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider            text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),
  status              politicore.payment_attempt_status_enum NOT NULL DEFAULT 'pending',
  provider_reference  text,
  failure_code        text,
  failure_message     text,
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, attempt_number)
);

CREATE INDEX payment_attempts_invoice_idx ON politicore.payment_attempts (invoice_id, attempt_number);

-- ── Refunds (§20): partial-capable, never exceed refundable ─────────────
CREATE TABLE politicore.refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  payment_id          uuid NOT NULL REFERENCES politicore.payments(id) ON DELETE RESTRICT,
  invoice_id          uuid NOT NULL REFERENCES politicore.invoices(id) ON DELETE RESTRICT,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status              politicore.refund_status_enum NOT NULL DEFAULT 'succeeded',
  provider            text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),
  provider_reference  text,
  reason              text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);

CREATE INDEX refunds_payment_idx ON politicore.refunds (payment_id);
CREATE INDEX refunds_invoice_idx ON politicore.refunds (invoice_id);

-- ── Credits (§21): explicit, accounting-safe adjustments ────────────────
-- Issued by platform authority with a reason; applied to DRAFT invoices
-- only (the issued invoice then snapshots the discount). Remaining
-- balance = amount − Σ applications. No general ledger is built.
CREATE TABLE politicore.credits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  subscription_id     uuid REFERENCES politicore.subscriptions(id) ON DELETE RESTRICT,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status              politicore.credit_status_enum NOT NULL DEFAULT 'issued',
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual')),
  reason              text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  issued_by           uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credits_tenant_idx ON politicore.credits (tenant_id);

CREATE TABLE politicore.credit_applications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE RESTRICT,
  credit_id       uuid NOT NULL REFERENCES politicore.credits(id) ON DELETE RESTRICT,
  invoice_id      uuid NOT NULL REFERENCES politicore.invoices(id) ON DELETE RESTRICT,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  applied_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_applications_credit_idx ON politicore.credit_applications (credit_id);
CREATE INDEX credit_applications_invoice_idx ON politicore.credit_applications (invoice_id);

-- ── Billing events (§18): the provider/webhook journal ──────────────────
-- Raw payload journaled BEFORE processing; idempotent by (provider,
-- provider_event_id); the SAME event can never double-pay, double-sync or
-- double-advance anything.
CREATE TABLE politicore.billing_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),
  provider_event_id   text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  event_type          text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  payload             jsonb NOT NULL,
  signature_verified  boolean NOT NULL DEFAULT false,
  processing_status   politicore.billing_event_status_enum NOT NULL DEFAULT 'received',
  processed_at        timestamptz,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX billing_events_created_idx ON politicore.billing_events (created_at DESC);
CREATE INDEX billing_events_status_idx ON politicore.billing_events (processing_status);

-- updated_at maintenance (existing 0001 trigger).
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON politicore.subscriptions
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_invoices_updated BEFORE UPDATE ON politicore.invoices
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_credits_updated BEFORE UPDATE ON politicore.credits
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════
-- 2. BILLING CONFIGURATION + PERIOD MATH + SHARED HELPERS
-- ═══════════════════════════════════════════════════════════════════════

-- Dunning parameters live in the EXISTING platform_settings singleton —
-- tunable WITHOUT a migration (§23). Defaults: 7-day grace, 3 retries.
CREATE OR REPLACE FUNCTION politicore.billing_config()
RETURNS TABLE (grace_period_days integer, max_payment_retries integer)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
  SELECT COALESCE(
           CASE WHEN jsonb_typeof(s.billing -> 'grace_period_days') = 'number'
                THEN (s.billing -> 'grace_period_days')::text::integer END, 7),
         COALESCE(
           CASE WHEN jsonb_typeof(s.billing -> 'max_payment_retries') = 'number'
                THEN (s.billing -> 'max_payment_retries')::text::integer END, 3)
    FROM (SELECT COALESCE((SELECT settings -> 'billing'
                             FROM politicore.platform_settings WHERE id = 1), '{}'::jsonb)
            AS billing) s;
$$;

-- Server-side period arithmetic. Canonical convention: UTC instants,
-- half-open [start, end) periods; Postgres interval arithmetic resolves
-- month-end and leap-year boundaries deterministically (Jan 31 + 1 month
-- = Feb 28/29; Feb 29 + 1 year = Feb 28). Never client-supplied dates.
CREATE OR REPLACE FUNCTION politicore.billing_advance_period(
  p_from timestamptz,
  p_interval politicore.billing_interval_enum
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path = politicore, pg_temp
AS $$
  SELECT p_from + CASE p_interval
    WHEN 'monthly' THEN '1 month'::interval
    WHEN 'annual'  THEN '1 year'::interval
  END;
$$;

-- Core Audit (reuse — never a parallel subsystem). Actor fields are
-- resolved server-side from the JWT subject; a NULL subject (system/seed
-- context) yields a platform event with no actor.
CREATE OR REPLACE FUNCTION politicore.billing_audit(
  p_tenant      uuid,
  p_action      text,
  p_resource    text,
  p_resource_id text,
  p_old         jsonb DEFAULT NULL,
  p_new         jsonb DEFAULT NULL,
  p_reason      text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (p_tenant, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     p_action, p_resource, p_resource_id, p_old, p_new, p_reason);
END;
$$;

-- Core Notifications (reuse — NO billing notification table). Recipients
-- are resolved SERVER-SIDE and data-driven: the tenant owner(s) — the
-- existing tenant_super_admin profiles — only. No broad fanout (§31).
CREATE OR REPLACE FUNCTION politicore.billing_notify(
  p_tenant  uuid,
  p_title   text,
  p_message text,
  p_link    text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message, link_url)
  SELECT p_tenant, p.id, 'system', p_title, p_message, p_link
    FROM politicore.profiles p
   WHERE p.tenant_id = p_tenant
     AND p.access_role = 'tenant_super_admin'
     AND p.lifecycle_status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. GUARD TRIGGERS — DB-enforced state machines and immutability (§6/§8,
--    §13, §18). Even a future code defect or service_role session cannot
--    rewrite commercial history or take an illegal transition.
-- ═══════════════════════════════════════════════════════════════════════

-- Subscription state machine (§24/§25) — allowed edges ONLY:
--   trialing → active | restricted | cancelled
--   active   → past_due | cancelled
--   past_due → active | restricted | cancelled
--   restricted → active | cancelled
-- No `suspended` in this phase (Phase 31 tenant lifecycle). No
-- cancelled → anything: restoration is a NEW subscription (history
-- preserved). Direct active → restricted is deliberately NOT an edge:
-- restriction is reached through the recorded-failure dunning path only.
CREATE OR REPLACE FUNCTION politicore.guard_subscription_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ended subscription % is a historical fact and is immutable', OLD.id;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := (OLD.status = 'trialing'   AND NEW.status IN ('active', 'restricted', 'cancelled'))
         OR (OLD.status = 'active'     AND NEW.status IN ('past_due', 'cancelled'))
         OR (OLD.status = 'past_due'   AND NEW.status IN ('active', 'restricted', 'cancelled'))
         OR (OLD.status = 'restricted' AND NEW.status IN ('active', 'cancelled'));
    IF NOT v_ok THEN
      RAISE EXCEPTION 'illegal subscription status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;

  -- Frozen commercial identity: tenant, currency, interval, trial window.
  IF NEW.tenant_id        IS DISTINCT FROM OLD.tenant_id
  OR NEW.currency         IS DISTINCT FROM OLD.currency
  OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
  OR NEW.trial_start      IS DISTINCT FROM OLD.trial_start
  OR NEW.trial_end        IS DISTINCT FROM OLD.trial_end
  OR NEW.created_at       IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'subscription % commercial identity is immutable', OLD.id;
  END IF;

  -- The plan reference may change ONLY as the audited next-period change:
  -- the same UPDATE applies pending_plan_version_id and clears it.
  IF NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id THEN
    IF NOT (OLD.pending_plan_version_id IS NOT NULL
            AND NEW.plan_version_id = OLD.pending_plan_version_id
            AND NEW.pending_plan_version_id IS NULL) THEN
      RAISE EXCEPTION 'subscription plan reference is immutable — schedule a plan change (pending_plan_version_id) instead';
    END IF;
  END IF;

  -- Termination shape.
  IF NEW.ended_at IS NOT NULL THEN
    IF NEW.status <> 'cancelled' THEN
      RAISE EXCEPTION 'a subscription with ended_at must be cancelled';
    END IF;
    IF NEW.cancelled_at IS NULL THEN
      RAISE EXCEPTION 'a cancelled subscription must record cancelled_at';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_subscription_transition
  BEFORE UPDATE ON politicore.subscriptions
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_subscription_transition();

-- Invoice integrity (§13): deterministic transitions; commercial
-- snapshot frozen after issuance; refund bookkeeping consistent.
CREATE OR REPLACE FUNCTION politicore.guard_invoice_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := (OLD.status = 'draft'    AND NEW.status IN ('issued', 'void'))
         OR (OLD.status = 'issued'   AND NEW.status IN ('paid', 'past_due', 'void'))
         OR (OLD.status = 'past_due' AND NEW.status IN ('paid', 'void'))
         OR (OLD.status = 'paid'     AND NEW.status = 'refunded');
    IF NOT v_ok THEN
      RAISE EXCEPTION 'illegal invoice status transition % -> %', OLD.status, NEW.status;
    END IF;
    -- `refunded` requires the FULL amount refunded.
    IF NEW.status = 'refunded' AND NEW.refunded_minor < NEW.total_minor THEN
      RAISE EXCEPTION 'invoice cannot be refunded before the full amount is refunded (% / %)',
        NEW.refunded_minor, NEW.total_minor;
    END IF;
    IF NEW.status = 'paid' AND NEW.paid_at IS NULL THEN
      RAISE EXCEPTION 'a paid invoice must record paid_at';
    END IF;
    IF NEW.status = 'void' AND NEW.voided_at IS NULL THEN
      RAISE EXCEPTION 'a void invoice must record voided_at';
    END IF;
  END IF;

  -- After issuance the commercial snapshot is immutable; only the
  -- explicitly permitted accounting fields (payment state, paid
  -- timestamp, refund state, reconciliation timestamps) may change.
  IF OLD.status <> 'draft' THEN
    IF NEW.tenant_id        IS DISTINCT FROM OLD.tenant_id
    OR NEW.subscription_id  IS DISTINCT FROM OLD.subscription_id
    OR NEW.plan_version_id  IS DISTINCT FROM OLD.plan_version_id
    OR NEW.plan_code        IS DISTINCT FROM OLD.plan_code
    OR NEW.plan_name        IS DISTINCT FROM OLD.plan_name
    OR NEW.plan_version     IS DISTINCT FROM OLD.plan_version
    OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
    OR NEW.currency         IS DISTINCT FROM OLD.currency
    OR NEW.period_start     IS DISTINCT FROM OLD.period_start
    OR NEW.period_end       IS DISTINCT FROM OLD.period_end
    OR NEW.subtotal_minor   IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.discount_credits_minor IS DISTINCT FROM OLD.discount_credits_minor
    OR NEW.tax_minor        IS DISTINCT FROM OLD.tax_minor
    OR NEW.total_minor      IS DISTINCT FROM OLD.total_minor
    OR NEW.invoice_number   IS DISTINCT FROM OLD.invoice_number
    OR NEW.issued_at        IS DISTINCT FROM OLD.issued_at
    OR NEW.due_at           IS DISTINCT FROM OLD.due_at THEN
      RAISE EXCEPTION 'issued invoice % is immutable — commercial fields can never be rewritten', OLD.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_invoice_integrity
  BEFORE UPDATE ON politicore.invoices
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_invoice_integrity();

-- Line items freeze the instant their invoice issues.
CREATE OR REPLACE FUNCTION politicore.guard_invoice_line_items()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$  DECLARE
  v_status politicore.invoice_status_enum;
BEGIN
  -- Terminal-cycle exception: an invoice's commercial retention had ended
  -- (refunds and reconciliations only). Line items follow their invoice at
  -- end of life. Non-terminal states stay frozen.
  SELECT status INTO v_status
    FROM politicore.invoices
   WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_status IS DISTINCT FROM 'draft'
     AND (TG_OP <> 'DELETE' OR v_status NOT IN ('refunded', 'void')) THEN
    RAISE EXCEPTION 'invoice line items are immutable after issuance (invoice status: %)', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_invoice_line_items
  BEFORE INSERT OR UPDATE OR DELETE ON politicore.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_invoice_line_items();

-- Payment lifecycle: pending → succeeded | failed; succeeded → refunded
-- (full refund only). Monetary identity is immutable.
CREATE OR REPLACE FUNCTION politicore.guard_payment_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_refunded bigint;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ( (OLD.status = 'pending'   AND NEW.status IN ('succeeded', 'failed'))
          OR (OLD.status = 'succeeded' AND NEW.status = 'refunded') ) THEN
      RAISE EXCEPTION 'illegal payment status transition % -> %', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'refunded' THEN
      SELECT COALESCE(sum(amount_minor), 0) INTO v_refunded
        FROM politicore.refunds
       WHERE payment_id = OLD.id AND status = 'succeeded';
      IF v_refunded < OLD.amount_minor THEN
        RAISE EXCEPTION 'payment cannot be refunded before the full amount is refunded (% / %)',
          v_refunded, OLD.amount_minor;
      END IF;
    END IF;
  END IF;

  IF NEW.invoice_id     IS DISTINCT FROM OLD.invoice_id
  OR NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
  OR NEW.amount_minor   IS DISTINCT FROM OLD.amount_minor
  OR NEW.currency       IS DISTINCT FROM OLD.currency
  OR NEW.provider       IS DISTINCT FROM OLD.provider
  OR NEW.provider_payment_reference IS DISTINCT FROM OLD.provider_payment_reference THEN
    RAISE EXCEPTION 'payment % monetary identity is immutable', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_payment_integrity
  BEFORE UPDATE ON politicore.payments
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_payment_integrity();

-- Refund limit: a refund may never exceed the refundable amount of its
-- payment (payment amount − successful refunds so far), and a refund
-- always belongs to its payment's invoice and currency.
CREATE OR REPLACE FUNCTION politicore.guard_refund_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_payment  politicore.payments;
  v_refunded bigint;
BEGIN
  SELECT * INTO v_payment FROM politicore.payments
   WHERE id = COALESCE(NEW.payment_id, OLD.payment_id);
  IF v_payment.status NOT IN ('succeeded', 'refunded') THEN
    RAISE EXCEPTION 'only a succeeded payment can be refunded (status: %)', v_payment.status;
  END IF;
  IF NEW.invoice_id IS DISTINCT FROM v_payment.invoice_id
  OR NEW.currency   IS DISTINCT FROM v_payment.currency THEN
    RAISE EXCEPTION 'refund must match its payment invoice and currency';
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.amount_minor IS DISTINCT FROM OLD.amount_minor) THEN
    SELECT COALESCE(sum(amount_minor), 0) INTO v_refunded
      FROM politicore.refunds
     WHERE payment_id = v_payment.id AND status = 'succeeded'
       AND (TG_OP = 'INSERT' OR id <> OLD.id);
    IF NEW.amount_minor > v_payment.amount_minor - v_refunded THEN
      RAISE EXCEPTION 'refund exceeds refundable amount (% > %)',
        NEW.amount_minor, v_payment.amount_minor - v_refunded;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_refund_limit
  BEFORE INSERT OR UPDATE ON politicore.refunds
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_refund_limit();

-- Credits: issued/applied/void; identity frozen; applications may only
-- land on DRAFT invoices, in the credit's currency, within the remaining
-- balance. A fully consumed credit flips to `applied`.
CREATE OR REPLACE FUNCTION politicore.guard_credit_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
  OR NEW.currency     IS DISTINCT FROM OLD.currency
  OR NEW.tenant_id    IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'credit % identity is immutable', OLD.id;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ( (OLD.status = 'issued' AND NEW.status IN ('applied', 'void'))
          OR (OLD.status = 'applied' AND NEW.status = 'applied') ) THEN
      RAISE EXCEPTION 'illegal credit status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_credit_identity
  BEFORE UPDATE ON politicore.credits
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_credit_identity();

CREATE OR REPLACE FUNCTION politicore.guard_credit_application()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_credit    politicore.credits;
  v_invoice   politicore.invoices;
  v_remaining bigint;
BEGIN
  SELECT * INTO v_credit FROM politicore.credits
   WHERE id = NEW.credit_id;
  IF v_credit.status <> 'issued' THEN
    RAISE EXCEPTION 'credit % is % — only an issued credit can be applied', v_credit.id, v_credit.status;
  END IF;
  SELECT * INTO v_invoice FROM politicore.invoices
   WHERE id = NEW.invoice_id;
  IF v_invoice.status <> 'draft' THEN
    RAISE EXCEPTION 'credits may only be applied to DRAFT invoices (invoice status: %)', v_invoice.status;
  END IF;
  IF NEW.currency IS DISTINCT FROM v_credit.currency
  OR NEW.currency IS DISTINCT FROM v_invoice.currency
  OR NEW.tenant_id IS DISTINCT FROM v_credit.tenant_id
  OR v_invoice.tenant_id IS DISTINCT FROM v_credit.tenant_id THEN
    RAISE EXCEPTION 'credit application must match credit and invoice tenant and currency';
  END IF;
  SELECT v_credit.amount_minor - COALESCE(sum(amount_minor), 0) INTO v_remaining
    FROM politicore.credit_applications
   WHERE credit_id = v_credit.id;
  IF NEW.amount_minor > v_remaining THEN
    RAISE EXCEPTION 'credit application exceeds remaining balance (% > %)',
      NEW.amount_minor, v_remaining;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_credit_application
  BEFORE INSERT ON politicore.credit_applications
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_credit_application();

-- Subscription items: frozen commercial identity; only an ACTIVE item can
-- be ended (never edited, never deleted).
CREATE OR REPLACE FUNCTION politicore.guard_subscription_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.subscription_id      IS DISTINCT FROM OLD.subscription_id
    OR NEW.item_type            IS DISTINCT FROM OLD.item_type
    OR NEW.plan_version_id      IS DISTINCT FROM OLD.plan_version_id
    OR NEW.capability_reference IS DISTINCT FROM OLD.capability_reference
    OR NEW.quantity             IS DISTINCT FROM OLD.quantity
    OR NEW.unit_price_minor     IS DISTINCT FROM OLD.unit_price_minor
    OR NEW.currency             IS DISTINCT FROM OLD.currency
    OR NEW.billing_interval     IS DISTINCT FROM OLD.billing_interval
    OR NEW.created_at           IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'subscription item % is immutable — end it and create a new item instead', OLD.id;
    END IF;
    IF OLD.status = 'ended' OR (NEW.status = 'ended') <> (NEW.ended_at IS NOT NULL) THEN
      RAISE EXCEPTION 'subscription item % ended state is immutable', OLD.id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_guard_subscription_item
  BEFORE UPDATE OR DELETE ON politicore.subscription_items
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_subscription_item();

-- Billing-event journal (§18/§19): raw payload, provider identity and the
-- server-derived signature verdict are immutable; processing may advance
-- exactly once (received → processed | rejected | failed).
CREATE OR REPLACE FUNCTION politicore.guard_billing_event_journal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF NEW.provider           IS DISTINCT FROM OLD.provider
  OR NEW.provider_event_id  IS DISTINCT FROM OLD.provider_event_id
  OR NEW.event_type         IS DISTINCT FROM OLD.event_type
  OR NEW.payload            IS DISTINCT FROM OLD.payload
  OR NEW.signature_verified IS DISTINCT FROM OLD.signature_verified
  OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'billing event % journal record is immutable', OLD.id;
  END IF;
  IF NEW.processing_status IS DISTINCT FROM OLD.processing_status
     AND OLD.processing_status <> 'received' THEN
    RAISE EXCEPTION 'billing event % already finished processing (%)- the journal is write-once',
      OLD.id, OLD.processing_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_billing_event_journal
  BEFORE UPDATE ON politicore.billing_events
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_billing_event_journal();

-- ═══════════════════════════════════════════════════════════════════════
-- 4. ENTITLEMENT SYNCHRONIZATION (§22) — THE Phase 29 boundary.
--
--    Subscription state drives the commercial entitlement map (the EXIST
--    ING platform_settings.settings.service_entitlements, the SAME map
--    Phase 28's apply_plan_version_entitlements writes — identical full
--    -map semantics, identical audit action):
--
--      trialing  → apply the plan version's included modules (subject to
--                  the Phase 28 plan definition; feature flags such as
--                  custom_domains are plan-definition data the future
--                  domain phase consumes — a trial never implies them)
--      active    → apply full plan entitlements
--      past_due  → RETAIN (grace active; no write, no revocation)
--      restricted → REVOKE commercial availability (all four false) —
--                  while application permissions, tenant_modules.enabled,
--                  tenants.status and RLS remain untouched (later quota/
--                  write restriction is a future phase's concern)
--      cancelled → REVOKE (ended commercial agreement)
--
--    Server-authoritative only; runs inside billing RPCs. This is NOT a
--    duplicate primitive: it is the subscription-state-driven writer the
--    architecture assigns to this layer; the sync suite proves it writes
--    exactly the same map (and only the map) as Phase 28's primitive.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.sync_subscription_entitlements(
  p_subscription_id uuid,
  p_reason          text DEFAULT NULL
)
RETURNS TABLE (module politicore.module_code_enum, entitled boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub     politicore.subscriptions;
  v_version politicore.plan_versions;
  v_map     jsonb;
  v_prev    jsonb;
  v_apply   boolean;
BEGIN
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown subscription %', p_subscription_id;
  END IF;
  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = v_sub.plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription % references unknown plan version %', v_sub.id, v_sub.plan_version_id;
  END IF;

  v_apply := v_sub.status IN ('trialing', 'active');

  IF v_sub.status = 'past_due' THEN
    -- Grace: entitlements are RETAINED — no write, no audit noise.
    RETURN QUERY
      SELECT mod::politicore.module_code_enum,
             COALESCE(((SELECT ps.settings -> 'service_entitlements' -> v_sub.tenant_id::text -> mod::text
                          FROM politicore.platform_settings ps WHERE ps.id = 1) #>> '{}')::boolean,
                      false)
        FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) AS mod;
    RETURN;
  END IF;

  IF v_apply THEN
    v_map := jsonb_build_object(
      'social',     ('social'     = ANY (v_version.included_modules)),
      'campaign',   ('campaign'   = ANY (v_version.included_modules)),
      'election',   ('election'   = ANY (v_version.included_modules)),
      'governance', ('governance' = ANY (v_version.included_modules)));
  ELSE
    -- restricted / cancelled: commercial availability ends.
    v_map := jsonb_build_object(
      'social', false, 'campaign', false, 'election', false, 'governance', false);
  END IF;

  v_prev := (SELECT ps.settings -> 'service_entitlements' -> v_sub.tenant_id::text
               FROM politicore.platform_settings ps WHERE ps.id = 1);

  UPDATE politicore.platform_settings
     SET settings   = jsonb_set(
              jsonb_set(COALESCE(settings, '{}'::jsonb), '{service_entitlements}', '{}'::jsonb, true),
              ARRAY['service_entitlements', v_sub.tenant_id::text], v_map, true),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = 1;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, actor_name, actor_email, action,
     affected_resource, resource_id, old_value, new_value, reason_notes)
  VALUES
    (v_sub.tenant_id, auth.uid(),
     (SELECT full_name FROM politicore.profiles WHERE id = auth.uid()),
     (SELECT email     FROM politicore.profiles WHERE id = auth.uid()),
     'entitlements_synchronized', 'platform_settings', v_sub.tenant_id::text,
     v_prev,
     jsonb_build_object('subscription_id', v_sub.id, 'subscription_status', v_sub.status,
                        'plan_code', (SELECT code FROM politicore.plans WHERE id = v_version.plan_id),
                        'plan_version', v_version.version, 'modules', v_map),
     p_reason);

  RETURN QUERY
  SELECT mod::politicore.module_code_enum, (mod = ANY (v_version.included_modules))
    FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) AS mod;
END;
$$;

-- Owner assertion: the caller must be the subscription tenant's EXISTING
-- tenant_super_admin (V1 billing owner — §7/§B4) or a platform super
-- admin. Plain `admin` gains NOTHING; members gain NOTHING.
CREATE OR REPLACE FUNCTION politicore.assert_subscription_authorized(
  p_subscription_id uuid
)
RETURNS politicore.subscriptions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub politicore.subscriptions;
BEGIN
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown subscription %', p_subscription_id;
  END IF;
  IF NOT (politicore.is_platform_admin() IS TRUE)
     AND NOT (politicore.current_access_role() = 'tenant_super_admin'
              AND politicore.current_tenant_id() = v_sub.tenant_id) THEN
    RAISE EXCEPTION 'subscription operations require the tenant owner (tenant_super_admin) or platform_super_admin authority';
  END IF;
  RETURN v_sub;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. SUBSCRIPTION LIFECYCLE RPCs — owner (tenant_super_admin) and platform
--    authority, tenant/actor resolved server-side (§26: never from the
--    client), every mutation Core-Audit-logged.
-- ═══════════════════════════════════════════════════════════════════════

-- Create the tenant's subscription (owner-only, own tenant resolved from
-- the session). Trial comes from the plan version (Phase 28 D3 data):
-- trialing = subscription state, tenant lifecycle untouched (§10).
CREATE OR REPLACE FUNCTION politicore.create_subscription(
  p_plan_version_id  uuid,
  p_billing_interval politicore.billing_interval_enum
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant    uuid := politicore.current_tenant_id();
  v_version   politicore.plan_versions;
  v_price     bigint;
  v_sub_id    uuid;
  v_trial     boolean;
  v_sub       politicore.subscriptions;
BEGIN
  IF NOT (politicore.current_access_role() = 'tenant_super_admin') THEN
    RAISE EXCEPTION 'creating a subscription requires the tenant owner (tenant_super_admin)';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant context could not be resolved for the current session';
  END IF;
  IF EXISTS (SELECT 1 FROM politicore.subscriptions
              WHERE tenant_id = v_tenant AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'tenant already has a live subscription — cancel it or change plan instead';
  END IF;

  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = p_plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version %', p_plan_version_id;
  END IF;
  IF v_version.status <> 'active' THEN
    RAISE EXCEPTION 'plan version % is % — only ACTIVE versions can be subscribed', v_version.id, v_version.status;
  END IF;

  SELECT amount_minor INTO v_price
    FROM politicore.plan_version_prices
   WHERE plan_version_id = v_version.id
     AND currency = v_version.currency
     AND billing_interval = p_billing_interval::text;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'plan version % has no % price in % — select an available price row',
      v_version.id, p_billing_interval, v_version.currency;
  END IF;

  v_trial := v_version.trial_enabled;

  INSERT INTO politicore.subscriptions
    (tenant_id, plan_version_id, status, billing_interval, currency,
     current_period_start, current_period_end, trial_start, trial_end)
  VALUES
    (v_tenant, v_version.id,
     CASE WHEN v_trial THEN 'trialing' ELSE 'active' END::politicore.subscription_status_enum,
     p_billing_interval, v_version.currency,
     CASE WHEN v_trial THEN NULL ELSE now() END,
     CASE WHEN v_trial THEN NULL ELSE politicore.billing_advance_period(now(), p_billing_interval) END,
     CASE WHEN v_trial THEN now() ELSE NULL END,
     CASE WHEN v_trial THEN now() + make_interval(days => v_version.trial_days) ELSE NULL END)
  RETURNING * INTO v_sub;
  v_sub_id := v_sub.id;

  INSERT INTO politicore.subscription_items
    (subscription_id, tenant_id, item_type, plan_version_id,
     quantity, unit_price_minor, currency, billing_interval)
  VALUES
    (v_sub_id, v_tenant, 'base_plan', v_version.id, 1, v_price,
     v_version.currency, p_billing_interval);

  PERFORM politicore.billing_audit(
    v_tenant, 'subscription_created', 'subscriptions', v_sub_id::text,
    NULL,
    jsonb_build_object('plan_code', (SELECT code FROM politicore.plans WHERE id = v_version.plan_id),
                       'plan_version', v_version.version, 'plan_version_id', v_version.id,
                       'billing_interval', p_billing_interval, 'currency', v_version.currency,
                       'status', v_sub.status),
    'subscription created by owner');

  IF v_trial THEN
    PERFORM politicore.billing_audit(
      v_tenant, 'subscription_trial_started', 'subscriptions', v_sub_id::text, NULL,
      jsonb_build_object('trial_start', to_jsonb(v_sub.trial_start),
                         'trial_end', to_jsonb(v_sub.trial_end)),
      'trial started (no payment method, no auto-charge)');
    PERFORM politicore.billing_notify(
      v_tenant, 'Trial started',
      'Your PolitiCore trial has started. No payment method is required and nothing is charged automatically.',
      '/portal/billing');
  ELSE
    PERFORM politicore.billing_audit(
      v_tenant, 'subscription_started', 'subscriptions', v_sub_id::text, NULL,
      jsonb_build_object('billing_interval', p_billing_interval),
      'subscription started without trial');
  END IF;

  PERFORM politicore.sync_subscription_entitlements(v_sub_id, 'subscription created');

  RETURN v_sub_id;
END;
$$;

-- Schedule cancellation (§25): default cancel_at_period_end = true —
-- non-destructive, revocable, no offboarding. Owner or platform.
CREATE OR REPLACE FUNCTION politicore.schedule_subscription_cancellation(
  p_subscription_id uuid,
  p_reason          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub politicore.subscriptions;
BEGIN
  v_sub := politicore.assert_subscription_authorized(p_subscription_id);
  IF v_sub.ended_at IS NOT NULL OR v_sub.status NOT IN ('trialing', 'active') THEN
    RAISE EXCEPTION 'subscription % (% ) cannot schedule cancellation', v_sub.id, v_sub.status;
  END IF;
  IF v_sub.cancel_at_period_end THEN
    RAISE EXCEPTION 'cancellation is already scheduled for subscription %', v_sub.id;
  END IF;

  UPDATE politicore.subscriptions SET cancel_at_period_end = true WHERE id = v_sub.id;

  PERFORM politicore.billing_audit(
    v_sub.tenant_id, 'subscription_cancellation_scheduled', 'subscriptions', v_sub.id::text,
    jsonb_build_object('cancel_at_period_end', false),
    jsonb_build_object('cancel_at_period_end', true,
                       'effective_at', to_jsonb(COALESCE(v_sub.current_period_end, v_sub.trial_end))),
    p_reason);
  PERFORM politicore.billing_notify(
    v_sub.tenant_id, 'Cancellation scheduled',
    'Your subscription cancellation is scheduled for the end of the current billing period. You can revoke it before then.',
    '/portal/billing');

  RETURN v_sub.id;
END;
$$;

-- Revoke a scheduled cancellation before the period ends (§25).
CREATE OR REPLACE FUNCTION politicore.revoke_subscription_cancellation(
  p_subscription_id uuid,
  p_reason          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub politicore.subscriptions;
BEGIN
  v_sub := politicore.assert_subscription_authorized(p_subscription_id);
  IF NOT v_sub.cancel_at_period_end OR v_sub.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'no scheduled cancellation to revoke on subscription %', v_sub.id;
  END IF;

  UPDATE politicore.subscriptions SET cancel_at_period_end = false WHERE id = v_sub.id;

  PERFORM politicore.billing_audit(
    v_sub.tenant_id, 'subscription_cancellation_revoked', 'subscriptions', v_sub.id::text,
    jsonb_build_object('cancel_at_period_end', true),
    jsonb_build_object('cancel_at_period_end', false),
    p_reason);

  RETURN v_sub.id;
END;
$$;

-- Plan change (§33): owner or platform. V1 semantics — effective NEXT
-- BILLING PERIOD (or at trial conversion). The current plan reference is
-- never rewritten mid-period; historical invoices keep their snapshot.
-- No proration accounting is invented. Platform callers MUST state a
-- reason; the owner may too.
CREATE OR REPLACE FUNCTION politicore.change_subscription_plan(
  p_subscription_id uuid,
  p_plan_version_id uuid,
  p_reason          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub     politicore.subscriptions;
  v_version politicore.plan_versions;
  v_price   bigint;
  v_effective timestamptz;
BEGIN
  v_sub := politicore.assert_subscription_authorized(p_subscription_id);
  IF (politicore.is_platform_admin() IS TRUE)
     AND (p_reason IS NULL OR btrim(p_reason) = '') THEN
    RAISE EXCEPTION 'platform plan changes require a reason';
  END IF;
  IF v_sub.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'subscription % has ended — subscribe to a new plan instead', v_sub.id;
  END IF;
  IF v_sub.plan_version_id = p_plan_version_id THEN
    RAISE EXCEPTION 'subscription is already on plan version %', p_plan_version_id;
  END IF;

  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = p_plan_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown plan version %', p_plan_version_id;
  END IF;
  IF v_version.status <> 'active' THEN
    RAISE EXCEPTION 'plan version % is % — only ACTIVE versions can be scheduled', v_version.id, v_version.status;
  END IF;
  IF v_version.currency <> v_sub.currency THEN
    RAISE EXCEPTION 'plan version currency % does not match the subscription currency % (no FX — select a price row in the subscription currency)',
      v_version.currency, v_sub.currency;
  END IF;
  SELECT amount_minor INTO v_price
    FROM politicore.plan_version_prices
   WHERE plan_version_id = v_version.id
     AND currency = v_sub.currency
     AND billing_interval = v_sub.billing_interval::text;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'plan version % has no % price in %', v_version.id, v_sub.billing_interval, v_sub.currency;
  END IF;

  v_effective := COALESCE(v_sub.current_period_end, v_sub.trial_end);

  UPDATE politicore.subscriptions
     SET pending_plan_version_id = v_version.id
   WHERE id = v_sub.id;

  PERFORM politicore.billing_audit(
    v_sub.tenant_id, 'subscription_changed', 'subscriptions', v_sub.id::text,
    jsonb_build_object('plan_version_id', v_sub.plan_version_id),
    jsonb_build_object('pending_plan_version_id', v_version.id,
                       'effective_at', to_jsonb(v_effective),
                       'mode', 'next billing period', 'proration', 'none (V1)'),
    COALESCE(p_reason, 'plan change scheduled by owner'));

  RETURN v_sub.id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. OWNER READ MODELS (§26) — owner-only (tenant_super_admin of the
--    session's own tenant). Ordinary members and plain admins never see
--    billing data through these; platform uses the §9 read models.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.subscription_current()
RETURNS TABLE (
  subscription_id      uuid,
  tenant_id            uuid,
  status               politicore.subscription_status_enum,
  billing_interval     politicore.billing_interval_enum,
  currency             text,
  plan_version_id      uuid,
  plan_code            text,
  plan_name            text,
  plan_version         integer,
  feature_entitlements jsonb,
  limits               jsonb,
  unit_price_minor     bigint,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_start          timestamptz,
  trial_end            timestamptz,
  cancel_at_period_end boolean,
  pending_plan_version_id uuid,
  pending_plan_code    text,
  pending_plan_name    text,
  failed_payment_count integer,
  past_due_since       timestamptz,
  created_at           timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.current_access_role() = 'tenant_super_admin') THEN
    RAISE EXCEPTION 'billing data is visible only to the tenant owner (tenant_super_admin)';
  END IF;
  RETURN QUERY
  SELECT s.id, s.tenant_id, s.status, s.billing_interval, s.currency,
         s.plan_version_id, p.code, p.name, v.version,
         v.feature_entitlements, v.limits,
         i.unit_price_minor,
         s.current_period_start, s.current_period_end,
         s.trial_start, s.trial_end, s.cancel_at_period_end,
         s.pending_plan_version_id,
         pp.code, pp.name,
         s.failed_payment_count, s.past_due_since, s.created_at
    FROM politicore.subscriptions s
    JOIN politicore.plan_versions v ON v.id = s.plan_version_id
    JOIN politicore.plans p         ON p.id = v.plan_id
    LEFT JOIN politicore.plans pp   ON pp.id = s.pending_plan_version_id
    LEFT JOIN politicore.subscription_items i
           ON i.subscription_id = s.id AND i.item_type = 'base_plan' AND i.status = 'active'
   WHERE s.tenant_id = politicore.current_tenant_id()
     AND s.ended_at IS NULL
   ORDER BY s.created_at DESC
   LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.my_invoices()
RETURNS TABLE (
  invoice_id        uuid,
  status            politicore.invoice_status_enum,
  invoice_number    text,
  plan_code         text,
  plan_name         text,
  plan_version      integer,
  billing_interval  politicore.billing_interval_enum,
  currency          text,
  period_start      timestamptz,
  period_end        timestamptz,
  subtotal_minor    bigint,
  discount_credits_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  refunded_minor    bigint,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  line_item_count   integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.current_access_role() = 'tenant_super_admin') THEN
    RAISE EXCEPTION 'billing data is visible only to the tenant owner (tenant_super_admin)';
  END IF;
  RETURN QUERY
  SELECT inv.id, inv.status, inv.invoice_number, inv.plan_code, inv.plan_name,
         inv.plan_version, inv.billing_interval, inv.currency,
         inv.period_start, inv.period_end,
         inv.subtotal_minor, inv.discount_credits_minor, inv.tax_minor,
         inv.total_minor, inv.refunded_minor,
         inv.issued_at, inv.due_at, inv.paid_at,
         (SELECT count(*)::integer FROM politicore.invoice_line_items li
           WHERE li.invoice_id = inv.id)
    FROM politicore.invoices inv
   WHERE inv.tenant_id = politicore.current_tenant_id()
   ORDER BY inv.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.my_invoice(p_invoice_id uuid)
RETURNS TABLE (
  invoice_id        uuid,
  status            politicore.invoice_status_enum,
  invoice_number    text,
  plan_code         text,
  plan_name         text,
  plan_version      integer,
  plan_version_id   uuid,
  billing_interval  politicore.billing_interval_enum,
  currency          text,
  period_start      timestamptz,
  period_end        timestamptz,
  subtotal_minor    bigint,
  discount_credits_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  refunded_minor    bigint,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  line_items        jsonb,
  payments          jsonb,
  refunds           jsonb,
  payment_attempts  jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
BEGIN
  IF NOT (politicore.current_access_role() = 'tenant_super_admin') THEN
    RAISE EXCEPTION 'billing data is visible only to the tenant owner (tenant_super_admin)';
  END IF;
  RETURN QUERY
  SELECT inv.id, inv.status, inv.invoice_number, inv.plan_code, inv.plan_name,
         inv.plan_version, inv.plan_version_id, inv.billing_interval, inv.currency,
         inv.period_start, inv.period_end,
         inv.subtotal_minor, inv.discount_credits_minor, inv.tax_minor,
         inv.total_minor, inv.refunded_minor,
         inv.issued_at, inv.due_at, inv.paid_at,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'description', li.description, 'item_type', li.item_type,
                    'quantity', li.quantity, 'amount_minor', li.amount_minor,
                    'currency', li.currency) ORDER BY li.created_at), '[]'::jsonb)
            FROM politicore.invoice_line_items li WHERE li.invoice_id = inv.id),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'id', pay.id, 'amount_minor', pay.amount_minor, 'currency', pay.currency,
                    'status', pay.status, 'provider', pay.provider,
                    'provider_payment_reference', pay.provider_payment_reference,
                    'received_at', pay.received_at) ORDER BY pay.received_at), '[]'::jsonb)
            FROM politicore.payments pay WHERE pay.invoice_id = inv.id),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'id', r.id, 'amount_minor', r.amount_minor, 'currency', r.currency,
                    'status', r.status, 'reason', r.reason,
                    'processed_at', r.processed_at) ORDER BY r.created_at), '[]'::jsonb)
            FROM politicore.refunds r WHERE r.invoice_id = inv.id),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'attempt_number', a.attempt_number, 'status', a.status,
                    'failure_code', a.failure_code, 'failure_message', a.failure_message,
                    'attempted_at', a.attempted_at) ORDER BY a.attempt_number), '[]'::jsonb)
            FROM politicore.payment_attempts a WHERE a.invoice_id = inv.id)
    FROM politicore.invoices inv
   WHERE inv.id = p_invoice_id
     AND inv.tenant_id = v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.my_payments()
RETURNS TABLE (
  payment_id   uuid,
  invoice_id   uuid,
  invoice_number text,
  amount_minor bigint,
  currency     text,
  status       politicore.payment_status_enum,
  provider     text,
  provider_payment_reference text,
  received_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.current_access_role() = 'tenant_super_admin') THEN
    RAISE EXCEPTION 'billing data is visible only to the tenant owner (tenant_super_admin)';
  END IF;
  RETURN QUERY
  SELECT pay.id, pay.invoice_id, inv.invoice_number,
         pay.amount_minor, pay.currency, pay.status, pay.provider,
         pay.provider_payment_reference, pay.received_at
    FROM politicore.payments pay
    LEFT JOIN politicore.invoices inv ON inv.id = pay.invoice_id
   WHERE pay.tenant_id = politicore.current_tenant_id()
   ORDER BY pay.received_at DESC;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. BILLING CORE — verified payment / failure / refund recording.
--
--    ONE state machine for every payment source (§16): the manual/offline
--    adapter (platform-admin records a VERIFIED payment) and the billing
--    -event processor (§10) both flow through exactly these primitives.
--    There is no second billing path. Authority: platform_super_admin —
--    the only functional adapter this phase is platform-operated.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.record_verified_payment(
  p_invoice_id    uuid,
  p_amount_minor  bigint,
  p_currency      text,
  p_provider      text,
  p_provider_reference text,
  p_notes         text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_invoice politicore.invoices;
  v_payment uuid;
  v_sub     politicore.subscriptions;
  v_attempt integer;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'payment recording requires platform_super_admin authority';
  END IF;
  IF p_provider IS NULL OR btrim(p_provider) = '' THEN
    RAISE EXCEPTION 'provider identity is required';
  END IF;
  IF p_provider_reference IS NULL OR btrim(p_provider_reference) = '' THEN
    RAISE EXCEPTION 'a provider payment reference is required';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor <> floor(p_amount_minor) THEN
    RAISE EXCEPTION 'payment amount must be a positive integer of minor units';
  END IF;

  SELECT * INTO v_invoice FROM politicore.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown invoice %', p_invoice_id;
  END IF;
  IF v_invoice.status NOT IN ('issued', 'past_due') THEN
    RAISE EXCEPTION 'invoice % is % — only an issued or past_due invoice can be paid', v_invoice.id, v_invoice.status;
  END IF;
  IF p_currency <> v_invoice.currency THEN
    RAISE EXCEPTION 'payment currency % does not match invoice currency % (no FX)', p_currency, v_invoice.currency;
  END IF;
  IF p_amount_minor <> v_invoice.total_minor THEN
    RAISE EXCEPTION 'payment must settle the invoice in full (% <> % minor units)',
      p_amount_minor, v_invoice.total_minor;
  END IF;

  -- Idempotent by provider reference (UNIQUE) — the same provider
  -- reference can never create a second payment.
  INSERT INTO politicore.payments
    (tenant_id, subscription_id, invoice_id, amount_minor, currency,
     status, provider, provider_payment_reference, notes, recorded_by, received_at)
  VALUES
    (v_invoice.tenant_id, v_invoice.subscription_id, v_invoice.id,
     p_amount_minor, p_currency, 'succeeded', p_provider, p_provider_reference,
     p_notes, auth.uid(), now())
  RETURNING id INTO v_payment;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_attempt
    FROM politicore.payment_attempts WHERE invoice_id = v_invoice.id;
  INSERT INTO politicore.payment_attempts
    (tenant_id, invoice_id, attempt_number, amount_minor, currency, provider,
     status, provider_reference)
  VALUES
    (v_invoice.tenant_id, v_invoice.id, v_attempt, p_amount_minor, p_currency,
     p_provider, 'succeeded', p_provider_reference);

  UPDATE politicore.invoices
     SET status = 'paid', paid_at = now()
   WHERE id = v_invoice.id;

  PERFORM politicore.billing_audit(
    v_invoice.tenant_id, 'invoice_paid', 'invoices', v_invoice.id::text,
    jsonb_build_object('status', v_invoice.status),
    jsonb_build_object('status', 'paid', 'payment_id', v_payment,
                       'provider', p_provider),
    p_notes);

  -- Subscription advance through the SAME state machine.
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = v_invoice.subscription_id;
  IF v_sub.status = 'trialing' THEN
    -- A scheduled plan change applies at conversion (re-validated).
    IF v_sub.pending_plan_version_id IS NOT NULL THEN
      PERFORM politicore.change_subscription_plan_apply(v_sub.id);
      SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = v_sub.id;
    END IF;
    UPDATE politicore.subscriptions
       SET status = 'active',
           current_period_start = now(),
           current_period_end   = politicore.billing_advance_period(now(), v_sub.billing_interval)
     WHERE id = v_sub.id;
    PERFORM politicore.billing_audit(
      v_sub.tenant_id, 'subscription_started', 'subscriptions', v_sub.id::text,
      jsonb_build_object('status', 'trialing'),
      jsonb_build_object('status', 'active', 'payment_id', v_payment),
      'trial converted through a paid subscription');
    PERFORM politicore.billing_audit(
      v_sub.tenant_id, 'subscription_activated', 'subscriptions', v_sub.id::text,
      jsonb_build_object('status', 'trialing'),
      jsonb_build_object('status', 'active'),
      'subscription activated by payment');
    PERFORM politicore.billing_notify(
      v_sub.tenant_id, 'Subscription activated',
      'Your payment was received and your subscription is now active.',
      '/portal/billing');
  ELSIF v_sub.status IN ('past_due', 'restricted') THEN
    UPDATE politicore.subscriptions
       SET status = 'active', past_due_since = NULL,
           current_period_start = v_invoice.period_start,
           current_period_end   = v_invoice.period_end
     WHERE id = v_sub.id;
    PERFORM politicore.billing_audit(
      v_sub.tenant_id, 'subscription_activated', 'subscriptions', v_sub.id::text,
      jsonb_build_object('status', v_sub.status),
      jsonb_build_object('status', 'active', 'payment_id', v_payment,
                         'recovered_from', v_sub.status),
      'subscription recovered by payment');
    PERFORM politicore.billing_notify(
      v_sub.tenant_id, 'Subscription active',
      'Your payment was received and your subscription is active again.',
      '/portal/billing');
  ELSE
    -- active: the settled invoice's period becomes the paid period.
    UPDATE politicore.subscriptions
       SET current_period_start = v_invoice.period_start,
           current_period_end   = v_invoice.period_end
     WHERE id = v_sub.id;
  END IF;

  PERFORM politicore.sync_subscription_entitlements(v_invoice.subscription_id, 'payment recorded');

  PERFORM politicore.billing_audit(
    v_invoice.tenant_id, 'payment_received', 'payments', v_payment::text,
    NULL,
    jsonb_build_object('invoice_id', v_invoice.id, 'amount_minor', p_amount_minor,
                       'currency', p_currency, 'provider', p_provider,
                       'provider_payment_reference', p_provider_reference),
    p_notes);
  PERFORM politicore.billing_notify(
    v_invoice.tenant_id, 'Payment received',
    'We received your payment. Thank you.',
    '/portal/billing');

  RETURN v_payment;
END;
$$;

-- Applies a scheduled next-period plan change to the CURRENT subscription
-- (called at renewal or trial conversion — never mid-period).
CREATE OR REPLACE FUNCTION politicore.change_subscription_plan_apply(p_subscription_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub     politicore.subscriptions;
  v_version politicore.plan_versions;
  v_price   bigint;
BEGIN
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = p_subscription_id;
  IF v_sub.pending_plan_version_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = v_sub.pending_plan_version_id;
  IF v_version.status <> 'active' THEN
    -- The scheduled version was retired meanwhile: leave it pending for
    -- platform correction; the renewal continues on the current plan.
    RAISE NOTICE 'pending plan version % is no longer active — left pending', v_version.id;
    RETURN false;
  END IF;
  SELECT amount_minor INTO v_price
    FROM politicore.plan_version_prices
   WHERE plan_version_id = v_version.id
     AND currency = v_sub.currency
     AND billing_interval = v_sub.billing_interval::text;
  IF v_price IS NULL THEN
    RAISE NOTICE 'pending plan version % has no matching price — left pending', v_version.id;
    RETURN false;
  END IF;

  UPDATE politicore.subscriptions
     SET plan_version_id = v_version.id,
         pending_plan_version_id = NULL
   WHERE id = v_sub.id;

  -- End the previous base-plan item, start the new one (items are the
  -- item-level history; the subscription row holds the current state).
  UPDATE politicore.subscription_items
     SET status = 'ended', ended_at = now()
   WHERE subscription_id = v_sub.id AND status = 'active';
  INSERT INTO politicore.subscription_items
    (subscription_id, tenant_id, item_type, plan_version_id,
     quantity, unit_price_minor, currency, billing_interval)
  VALUES
    (v_sub.id, v_sub.tenant_id, 'base_plan', v_version.id, 1, v_price,
     v_sub.currency, v_sub.billing_interval);

  PERFORM politicore.billing_audit(
    v_sub.tenant_id, 'subscription_changed', 'subscriptions', v_sub.id::text,
    jsonb_build_object('plan_version_id', v_sub.plan_version_id),
    jsonb_build_object('plan_version_id', v_version.id, 'applied', true,
                       'mode', 'next billing period'),
    'scheduled plan change applied');
  RETURN true;
END;
$$;

-- Server/provider-derived payment failure (§15/§24): recorded through the
-- adapter path, never from a client claim. active → past_due (grace);
-- a repeated failure on past_due only counts the retry.
CREATE OR REPLACE FUNCTION politicore.record_payment_failure(
  p_invoice_id      uuid,
  p_failure_code    text,
  p_failure_message text,
  p_provider        text,
  p_provider_reference text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_invoice politicore.invoices;
  v_sub     politicore.subscriptions;
  v_attempt integer;
  v_attempt_id uuid;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'payment failure recording requires platform_super_admin authority';
  END IF;
  IF p_failure_code IS NULL OR btrim(p_failure_code) = ''
     OR p_failure_message IS NULL OR btrim(p_failure_message) = '' THEN
    RAISE EXCEPTION 'a server-derived failure code and message are required';
  END IF;

  SELECT * INTO v_invoice FROM politicore.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown invoice %', p_invoice_id;
  END IF;
  IF v_invoice.status NOT IN ('issued', 'past_due') THEN
    RAISE EXCEPTION 'invoice % is % — only an issued or past_due invoice can record a failure', v_invoice.id, v_invoice.status;
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_attempt
    FROM politicore.payment_attempts WHERE invoice_id = v_invoice.id;
  INSERT INTO politicore.payment_attempts
    (tenant_id, invoice_id, attempt_number, amount_minor, currency, provider,
     status, provider_reference, failure_code, failure_message)
  VALUES
    (v_invoice.tenant_id, v_invoice.id, v_attempt, v_invoice.total_minor,
     v_invoice.currency, p_provider, 'failed', p_provider_reference,
     p_failure_code, p_failure_message)
  RETURNING id INTO v_attempt_id;

  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = v_invoice.subscription_id;
  -- Dunning bookkeeping: the invoice that failed enters past_due too.
  IF v_invoice.status = 'issued' THEN
    UPDATE politicore.invoices SET status = 'past_due' WHERE id = v_invoice.id;
  END IF;
  IF v_sub.status = 'active' THEN
    UPDATE politicore.subscriptions
       SET status = 'past_due', past_due_since = now(),
           failed_payment_count = failed_payment_count + 1
     WHERE id = v_sub.id;
  ELSIF v_sub.status = 'past_due' THEN
    UPDATE politicore.subscriptions
       SET failed_payment_count = failed_payment_count + 1
     WHERE id = v_sub.id;
  END IF;

  PERFORM politicore.billing_audit(
    v_invoice.tenant_id, 'payment_failed', 'payment_attempts', v_attempt_id::text,
    NULL,
    jsonb_build_object('invoice_id', v_invoice.id, 'attempt_number', v_attempt,
                       'failure_code', p_failure_code, 'failure_message', p_failure_message,
                       'provider', p_provider),
    'server/provider-derived failure');
  PERFORM politicore.billing_notify(
    v_invoice.tenant_id, 'Payment failed',
    'A recent payment attempt failed. Update your payment to avoid service restriction.',
    '/portal/billing');

  RETURN v_attempt_id;
END;
$$;

-- Refund (§20): platform-recorded, partial-capable, never exceeding the
-- refundable amount (DB trigger enforces too). Fully refunded invoices
-- flip to `refunded`; payments to `refunded`.
CREATE OR REPLACE FUNCTION politicore.record_verified_refund(
  p_payment_id       uuid,
  p_amount_minor     bigint,
  p_reason           text,
  p_provider_reference text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_payment politicore.payments;
  v_invoice politicore.invoices;
  v_refund_id uuid;
  v_invoice_refunded bigint;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'refund recording requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a refund reason is required';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor <> floor(p_amount_minor) THEN
    RAISE EXCEPTION 'refund amount must be a positive integer of minor units';
  END IF;

  SELECT * INTO v_payment FROM politicore.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown payment %', p_payment_id;
  END IF;
  IF v_payment.status <> 'succeeded' THEN
    RAISE EXCEPTION 'payment % is % — only a succeeded payment can be refunded', v_payment.id, v_payment.status;
  END IF;

  INSERT INTO politicore.refunds
    (tenant_id, payment_id, invoice_id, amount_minor, currency, status,
     provider, provider_reference, reason, processed_at)
  VALUES
    (v_payment.tenant_id, v_payment.id, v_payment.invoice_id, p_amount_minor,
     v_payment.currency, 'succeeded', v_payment.provider, p_provider_reference,
     btrim(p_reason), now())
  RETURNING id INTO v_refund_id;

  SELECT * INTO v_invoice FROM politicore.invoices WHERE id = v_payment.invoice_id;
  v_invoice_refunded := v_invoice.refunded_minor + p_amount_minor;

  UPDATE politicore.invoices
     SET refunded_minor = v_invoice_refunded,
         status = CASE WHEN v_invoice_refunded >= v_invoice.total_minor
                       THEN 'refunded' ELSE 'paid' END::politicore.invoice_status_enum
   WHERE id = v_invoice.id;

  IF v_invoice_refunded >= v_payment.amount_minor THEN
    UPDATE politicore.payments SET status = 'refunded' WHERE id = v_payment.id;
  END IF;

  PERFORM politicore.billing_audit(
    v_payment.tenant_id, 'payment_refunded', 'refunds', v_refund_id::text,
    NULL,
    jsonb_build_object('payment_id', v_payment.id, 'invoice_id', v_invoice.id,
                       'amount_minor', p_amount_minor, 'currency', v_payment.currency,
                       'provider', v_payment.provider,
                       'provider_reference', p_provider_reference,
                       'invoice_refunded_minor', v_invoice_refunded),
    btrim(p_reason));

  RETURN v_refund_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. INVOICING (§12/§13) — draft creation snapshots the CURRENT plan
--    version, price and period at billing time; issuance stamps the
--    invoice number, issued_at and due_at (grace days from config = V1
--    payment terms). After issuance everything is immutable.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.billing_create_draft_invoice(p_subscription_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub     politicore.subscriptions;
  v_version politicore.plan_versions;
  v_price   bigint;
  v_start   timestamptz;
  v_end     timestamptz;
  v_invoice uuid;
  v_plan_code text;
  v_plan_name text;
BEGIN
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown subscription %', p_subscription_id;
  END IF;
  IF v_sub.ended_at IS NOT NULL OR v_sub.status NOT IN ('trialing', 'active', 'past_due') THEN
    RAISE EXCEPTION 'subscription % (%) cannot be invoiced', v_sub.id, v_sub.status;
  END IF;

  SELECT * INTO v_version FROM politicore.plan_versions WHERE id = v_sub.plan_version_id;
  SELECT amount_minor INTO v_price
    FROM politicore.plan_version_prices
   WHERE plan_version_id = v_version.id
     AND currency = v_sub.currency
     AND billing_interval = v_sub.billing_interval::text;
  IF v_price IS NULL THEN
    RAISE EXCEPTION 'plan version % has no % price in % — cannot invoice',
      v_version.id, v_sub.billing_interval, v_sub.currency;
  END IF;
  SELECT code, name INTO v_plan_code, v_plan_name
    FROM politicore.plans WHERE id = v_version.plan_id;

  -- Deterministic period: the next period after the subscription's last
  -- settled period end (UTC, half-open, chained — no drift). A trialing
  -- subscription's FIRST invoice starts at the conversion moment — the
  -- trial already covers the elapsed time (no retroactive charging).
  v_start := COALESCE(v_sub.current_period_end, v_sub.created_at);
  IF v_sub.status = 'trialing' THEN
    v_start := now();
  END IF;
  v_end   := politicore.billing_advance_period(v_start, v_sub.billing_interval);

  INSERT INTO politicore.invoices
    (tenant_id, subscription_id, plan_version_id, plan_code, plan_name, plan_version,
     billing_interval, currency, period_start, period_end,
     subtotal_minor, total_minor)
  VALUES
    (v_sub.tenant_id, v_sub.id, v_version.id, v_plan_code, v_plan_name, v_version.version,
     v_sub.billing_interval, v_sub.currency, v_start, v_end,
     v_price, v_price)
  RETURNING id INTO v_invoice;

  INSERT INTO politicore.invoice_line_items
    (invoice_id, item_type, description, plan_version_id, quantity, amount_minor, currency)
  VALUES
    (v_invoice, 'base_plan',
     v_plan_name || ' — ' || v_sub.billing_interval::text || ' subscription (v' || v_version.version || ')',
     v_version.id, 1, v_price, v_sub.currency);

  RETURN v_invoice;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.billing_issue_invoice(p_invoice_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_inv     politicore.invoices;
  v_grace   integer;
  v_number  text;
  v_items   integer;
BEGIN
  SELECT * INTO v_inv FROM politicore.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown invoice %', p_invoice_id;
  END IF;
  IF v_inv.status <> 'draft' THEN
    RAISE EXCEPTION 'only a DRAFT invoice can be issued (status is %)', v_inv.status;
  END IF;
  SELECT count(*) INTO v_items FROM politicore.invoice_line_items WHERE invoice_id = v_inv.id;
  IF v_items < 1 THEN
    RAISE EXCEPTION 'invoice % has no line items — cannot issue', v_inv.id;
  END IF;
  v_grace := (SELECT grace_period_days FROM politicore.billing_config());
  v_number := 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || left(replace(v_inv.id::text, '-', ''), 8);

  UPDATE politicore.invoices
     SET status = 'issued', invoice_number = v_number,
         issued_at = now(), due_at = now() + make_interval(days => v_grace)
   WHERE id = v_inv.id;

  PERFORM politicore.billing_audit(
    v_inv.tenant_id, 'invoice_issued', 'invoices', v_inv.id::text,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'issued', 'invoice_number', v_number,
                       'total_minor', v_inv.total_minor, 'currency', v_inv.currency,
                       'due_at', to_jsonb(now() + make_interval(days => v_grace))),
    p_reason);
  PERFORM politicore.billing_notify(
    v_inv.tenant_id, 'Invoice issued',
    'Invoice ' || v_number || ' for ' || (v_inv.total_minor::text) || ' ' || v_inv.currency
      || ' (minor units) was issued.',
    '/portal/billing');

  RETURN v_inv.id;
END;
$$;

-- Platform: create a draft invoice for a subscription (ad-hoc or pre-issued
-- renewal). The draft snapshots the plan; issuance freezes it.
CREATE OR REPLACE FUNCTION politicore.platform_create_invoice(
  p_subscription_id uuid,
  p_reason          text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub politicore.subscriptions;
  v_inv uuid;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'invoice administration requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason is required for platform invoice creation';
  END IF;
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown subscription %', p_subscription_id;
  END IF;

  v_inv := politicore.billing_create_draft_invoice(p_subscription_id);

  PERFORM politicore.billing_audit(
    v_sub.tenant_id, 'billing_invoice_created', 'invoices', v_inv::text,
    NULL, jsonb_build_object('subscription_id', v_sub.id, 'status', 'draft'),
    btrim(p_reason));
  RETURN v_inv;
END;
$$;

-- Platform: issue (draft → issued).
CREATE OR REPLACE FUNCTION politicore.platform_issue_invoice(p_invoice_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'invoice administration requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason is required for platform invoice issuance';
  END IF;
  RETURN politicore.billing_issue_invoice(p_invoice_id, btrim(p_reason));
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. DETERMINISTIC PROCESSORS (§24/§25/§32) — idempotent, server-side,
--    server-clock driven. Invoked by platform authority in V1 (a cron or
--    service-role runner arrives with the operations phase); each call
--    advances exactly the rows whose deterministic time has come.
-- ═══════════════════════════════════════════════════════════════════════

-- Trial lifecycle: 3-day ending reminder (once), then deterministic
-- expiry → restricted. No payment occurs, no payment method is needed,
-- tenant data is untouched, tenants.status is untouched.
CREATE OR REPLACE FUNCTION politicore.process_trial_expiries()
RETURNS TABLE (subscription_id uuid, action text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub politicore.subscriptions;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing processing requires platform_super_admin authority';
  END IF;

  FOR v_sub IN
    SELECT * FROM politicore.subscriptions
     WHERE status = 'trialing' AND trial_end > now()
       AND trial_end - now() <= interval '3 days'
       AND trial_reminder_sent_at IS NULL
  LOOP
    UPDATE politicore.subscriptions
       SET trial_reminder_sent_at = now()
     WHERE id = v_sub.id;
    PERFORM politicore.billing_notify(
      v_sub.tenant_id, 'Trial ending soon',
      'Your PolitiCore trial ends soon. Subscribe to a plan to keep your services active.',
      '/portal/billing');
    subscription_id := v_sub.id;
    action := 'trial_reminder_sent';
    RETURN NEXT;
  END LOOP;

  FOR v_sub IN
    SELECT * FROM politicore.subscriptions
     WHERE status = 'trialing' AND trial_end <= now()
     ORDER BY trial_end
  LOOP
    UPDATE politicore.subscriptions
       SET status = 'restricted'
     WHERE id = v_sub.id;
    PERFORM politicore.billing_audit(
      v_sub.tenant_id, 'subscription_trial_expired', 'subscriptions', v_sub.id::text,
      jsonb_build_object('status', 'trialing'),
      jsonb_build_object('status', 'restricted', 'trial_end', to_jsonb(v_sub.trial_end)),
      'deterministic trial expiry (no payment method, no auto-charge)');
    PERFORM politicore.sync_subscription_entitlements(v_sub.id, 'trial expired');
    PERFORM politicore.billing_notify(
      v_sub.tenant_id, 'Trial ended',
      'Your PolitiCore trial has ended. Subscribe to a plan to restore your services. Your data is preserved.',
      '/portal/billing');
    subscription_id := v_sub.id;
    action := 'trial_expired';
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Dunning (§23/§24): grace days from the EXISTING platform configuration
-- (settings.billing.grace_period_days) — tunable without a migration.
-- past_due whose grace is exhausted → restricted.
CREATE OR REPLACE FUNCTION politicore.process_dunning_transitions()
RETURNS TABLE (subscription_id uuid, action text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub   politicore.subscriptions;
  v_grace integer;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing processing requires platform_super_admin authority';
  END IF;
  v_grace := (SELECT grace_period_days FROM politicore.billing_config());

  FOR v_sub IN
    SELECT * FROM politicore.subscriptions
     WHERE status = 'past_due'
       AND past_due_since IS NOT NULL
       AND past_due_since <= now() - make_interval(days => v_grace)
     ORDER BY past_due_since
  LOOP
    UPDATE politicore.subscriptions SET status = 'restricted' WHERE id = v_sub.id;
    PERFORM politicore.billing_audit(
      v_sub.tenant_id, 'subscription_restricted', 'subscriptions', v_sub.id::text,
      jsonb_build_object('status', 'past_due'),
      jsonb_build_object('status', 'restricted', 'grace_period_days', v_grace,
                         'failed_payment_count', v_sub.failed_payment_count),
      'dunning grace exhausted');
    PERFORM politicore.sync_subscription_entitlements(v_sub.id, 'dunning grace exhausted');
    PERFORM politicore.billing_notify(
      v_sub.tenant_id, 'Subscription restricted',
      'Your subscription was restricted after the payment grace period expired. Settle your invoice to restore service. Your data is preserved.',
      '/portal/billing');
    subscription_id := v_sub.id;
    action := 'grace_exhausted';
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Renewals (§25/§33): an active subscription whose settled period has
-- ended either cancels (cancel_at_period_end) or renews: the scheduled
-- plan change (if any) applies, the next-period invoice is created AND
-- issued, entitlements re-sync. Period fields advance only on payment
-- (settled facts).
CREATE OR REPLACE FUNCTION politicore.process_period_renewals()
RETURNS TABLE (subscription_id uuid, action text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub     politicore.subscriptions;
  v_invoice uuid;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing processing requires platform_super_admin authority';
  END IF;

  FOR v_sub IN
    SELECT * FROM politicore.subscriptions
     WHERE status = 'active' AND current_period_end IS NOT NULL
       AND current_period_end <= now()
     ORDER BY current_period_end
  LOOP
    IF v_sub.cancel_at_period_end THEN
      UPDATE politicore.subscriptions
         SET status = 'cancelled', ended_at = now(), cancelled_at = now()
       WHERE id = v_sub.id;
      PERFORM politicore.billing_audit(
        v_sub.tenant_id, 'subscription_cancelled', 'subscriptions', v_sub.id::text,
        jsonb_build_object('status', 'active', 'cancel_at_period_end', true),
        jsonb_build_object('status', 'cancelled', 'ended_at', to_jsonb(now())),
        'cancellation took effect at period end (non-destructive; data preserved)');
      PERFORM politicore.sync_subscription_entitlements(v_sub.id, 'subscription cancelled at period end');
      PERFORM politicore.billing_notify(
        v_sub.tenant_id, 'Subscription ended',
        'Your subscription has ended as scheduled. Your data is preserved; you can subscribe again at any time.',
        '/portal/billing');
      subscription_id := v_sub.id;
      action := 'cancelled_at_period_end';
      RETURN NEXT;
    ELSE
      -- Idempotency: while an open invoice (draft/issued/past_due) exists
      -- the renewal is already pending settlement — never re-issue.
      IF EXISTS (SELECT 1 FROM politicore.invoices inv
                  WHERE inv.subscription_id = v_sub.id
                    AND inv.status IN ('draft', 'issued', 'past_due')) THEN
        subscription_id := v_sub.id;
        action := 'renewal_open_invoice_exists';
        RETURN NEXT;
      ELSE
        PERFORM politicore.change_subscription_plan_apply(v_sub.id);
        v_invoice := politicore.billing_create_draft_invoice(v_sub.id);
        PERFORM politicore.billing_issue_invoice(v_invoice, 'period renewal');
        PERFORM politicore.sync_subscription_entitlements(v_sub.id, 'renewal processed');
        subscription_id := v_sub.id;
        action := 'renewal_invoice_issued';
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 10. MANUAL / OFFLINE ADAPTER (§16) — the ONLY functional payment adapter
--     this phase. Platform-admin records a VERIFIED payment (actor +
--     reference + notes REQUIRED); everything flows through the §7 core
--     — there is no second billing path.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.record_manual_payment(
  p_invoice_id    uuid,
  p_amount_minor  bigint,
  p_currency      text,
  p_provider_reference text,
  p_notes         text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'manual payment recording requires platform_super_admin authority';
  END IF;
  IF p_notes IS NULL OR length(btrim(p_notes)) < 5 THEN
    RAISE EXCEPTION 'manual payment recording requires notes (verified source of the payment)';
  END IF;
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'currency must be a 3-letter ISO code';
  END IF;
  RETURN politicore.record_verified_payment(
    p_invoice_id, p_amount_minor, p_currency, 'manual',
    p_provider_reference, btrim(p_notes));
END;
$$;

CREATE OR REPLACE FUNCTION politicore.record_manual_refund(
  p_payment_id    uuid,
  p_amount_minor  bigint,
  p_reason        text,
  p_provider_reference text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'manual refund recording requires platform_super_admin authority';
  END IF;
  RETURN politicore.record_verified_refund(
    p_payment_id, p_amount_minor, p_reason, p_provider_reference);
END;
$$;

CREATE OR REPLACE FUNCTION politicore.record_payment_failure_manual(
  p_invoice_id      uuid,
  p_failure_code    text,
  p_failure_message text,
  p_provider_reference text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'payment failure recording requires platform_super_admin authority';
  END IF;
  RETURN politicore.record_payment_failure(
    p_invoice_id, p_failure_code, p_failure_message, 'manual', p_provider_reference);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 11. CREDITS (§21) — explicit platform-issued adjustments; applied to
--     DRAFT invoices only (the issued invoice then snapshots the
--     discount); remaining balance and application history are preserved.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.issue_credit(
  p_tenant_id    uuid,
  p_amount_minor bigint,
  p_reason       text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub     politicore.subscriptions;
  v_credit  uuid;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'credit administration requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a credit reason is required';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 OR p_amount_minor <> floor(p_amount_minor) THEN
    RAISE EXCEPTION 'credit amount must be a positive integer of minor units';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM politicore.tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'unknown tenant %', p_tenant_id;
  END IF;

  -- Currency is the tenant's live subscription currency (no FX).
  SELECT * INTO v_sub FROM politicore.subscriptions
   WHERE tenant_id = p_tenant_id AND ended_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant % has no live subscription — credits are denominated in the subscription currency', p_tenant_id;
  END IF;

  INSERT INTO politicore.credits
    (tenant_id, subscription_id, amount_minor, currency, status, source, reason, issued_by)
  VALUES
    (p_tenant_id, v_sub.id, p_amount_minor, v_sub.currency, 'issued', 'manual',
     btrim(p_reason), auth.uid())
  RETURNING id INTO v_credit;

  PERFORM politicore.billing_audit(
    p_tenant_id, 'credit_issued', 'credits', v_credit::text,
    NULL,
    jsonb_build_object('amount_minor', p_amount_minor, 'currency', v_sub.currency,
                       'subscription_id', v_sub.id),
    btrim(p_reason));
  RETURN v_credit;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.apply_credit(
  p_credit_id    uuid,
  p_invoice_id   uuid,
  p_amount_minor bigint,
  p_reason       text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_credit  politicore.credits;
  v_invoice politicore.invoices;
  v_app_id  uuid;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'credit administration requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a credit application reason is required';
  END IF;

  SELECT * INTO v_credit FROM politicore.credits WHERE id = p_credit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown credit %', p_credit_id;
  END IF;
  SELECT * INTO v_invoice FROM politicore.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown invoice %', p_invoice_id;
  END IF;

  INSERT INTO politicore.credit_applications
    (tenant_id, credit_id, invoice_id, amount_minor, currency, reason, applied_by)
  VALUES
    (v_credit.tenant_id, v_credit.id, v_invoice.id, p_amount_minor,
     v_credit.currency, btrim(p_reason), auth.uid())
  RETURNING id INTO v_app_id;

  -- Draft invoices may still be adjusted; issued invoices are frozen (the
  -- trigger would reject this — credits never touch issued history).
  UPDATE politicore.invoices
     SET discount_credits_minor = discount_credits_minor + p_amount_minor,
         total_minor = subtotal_minor - (discount_credits_minor + p_amount_minor) + tax_minor
   WHERE id = v_invoice.id;

  -- A fully consumed credit flips to `applied` (explicit state, no silent
  -- historical edits).
  IF (SELECT v_credit.amount_minor - COALESCE(sum(amount_minor), 0)
        FROM politicore.credit_applications
       WHERE credit_id = v_credit.id) <= 0 THEN
    UPDATE politicore.credits SET status = 'applied' WHERE id = v_credit.id;
  END IF;

  PERFORM politicore.billing_audit(
    v_credit.tenant_id, 'credit_applied', 'credit_applications', v_app_id::text,
    NULL,
    jsonb_build_object('credit_id', v_credit.id, 'invoice_id', v_invoice.id,
                       'amount_minor', p_amount_minor, 'currency', v_credit.currency),
    btrim(p_reason));
  RETURN v_app_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 12. PLATFORM AUTHORITY OPERATIONS (§27) — state correction with a
--     mandatory reason; dunning configuration without a migration.
-- ═══════════════════════════════════════════════════════════════════════

-- Explicitly authorized state correction (e.g. immediate cancellation —
-- representable in the state machine without destructive offboarding).
-- The DB trigger enforces the SAME legal edges; the reason is mandatory.
CREATE OR REPLACE FUNCTION politicore.correct_subscription_state(
  p_subscription_id uuid,
  p_new_status      text,
  p_reason          text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_sub politicore.subscriptions;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'subscription correction requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason is required for platform subscription correction';
  END IF;
  SELECT * INTO v_sub FROM politicore.subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown subscription %', p_subscription_id;
  END IF;

  UPDATE politicore.subscriptions
     SET status = p_new_status::politicore.subscription_status_enum,
         ended_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE ended_at END,
         cancelled_at = CASE WHEN p_new_status = 'cancelled' THEN now() ELSE cancelled_at END,
         past_due_since = CASE WHEN p_new_status IN ('active', 'restricted') THEN NULL ELSE past_due_since END
   WHERE id = v_sub.id;

  PERFORM politicore.billing_audit(
    v_sub.tenant_id, 'subscription_changed', 'subscriptions', v_sub.id::text,
    jsonb_build_object('status', v_sub.status),
    jsonb_build_object('status', p_new_status, 'corrected_by', 'platform_super_admin'),
    btrim(p_reason));
  PERFORM politicore.sync_subscription_entitlements(v_sub.id, 'platform state correction');

  RETURN v_sub.id;
END;
$$;

-- Dunning parameters — stored in the EXISTING platform_settings singleton
-- (settings.billing), tunable WITHOUT a migration (§23), audited.
CREATE OR REPLACE FUNCTION politicore.set_billing_config(
  p_grace_period_days  integer,
  p_max_payment_retries integer,
  p_reason             text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_new jsonb;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing configuration requires platform_super_admin authority';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason is required for billing configuration changes';
  END IF;
  IF p_grace_period_days IS NULL OR p_grace_period_days NOT BETWEEN 0 AND 90 THEN
    RAISE EXCEPTION 'grace_period_days must be between 0 and 90';
  END IF;
  IF p_max_payment_retries IS NULL OR p_max_payment_retries NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'max_payment_retries must be between 1 and 12';
  END IF;

  v_new := jsonb_build_object('grace_period_days', p_grace_period_days,
                              'max_payment_retries', p_max_payment_retries);

  UPDATE politicore.platform_settings
     SET settings   = jsonb_set(COALESCE(settings, '{}'::jsonb), '{billing}', v_new, true),
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = 1;
  IF NOT FOUND THEN
    INSERT INTO politicore.platform_settings (id, settings, updated_by)
    VALUES (1, jsonb_build_object('billing', v_new), auth.uid());
  END IF;

  PERFORM politicore.billing_audit(
    NULL, 'billing_config_updated', 'platform_settings', '1',
    (SELECT settings -> 'billing' FROM politicore.platform_settings WHERE id = 1),
    v_new, btrim(p_reason));
  RETURN v_new;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 10b. WEBHOOK / BILLING-EVENT JOURNAL RPCs (§18/§19) — raw payload is
--      journaled BEFORE any processing; idempotent by (provider,
--      provider_event_id); processing is deterministic and write-once
--      (received → processed | rejected — the guard trigger enforces).
--      V1: the manual/offline adapter is the only functional adapter, so
--      journaling is platform-operated; a journaled event's business
--      effect, if any, still flows through the §7 core primitives —
--      never a second billing path.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.journal_billing_event(
  p_provider           text,
  p_provider_event_id  text,
  p_event_type         text,
  p_payload            jsonb,
  p_signature_verified boolean
)
RETURNS TABLE (event_id uuid, duplicate boolean, processing_status politicore.billing_event_status_enum)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_existing politicore.billing_events;
  v_new      politicore.billing_events;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing-event journaling requires platform_super_admin authority';
  END IF;
  IF p_provider IS NULL OR length(btrim(p_provider)) < 2 THEN
    RAISE EXCEPTION 'provider identity is required';
  END IF;
  IF p_provider_event_id IS NULL OR btrim(p_provider_event_id) = '' THEN
    RAISE EXCEPTION 'a provider event id is required';
  END IF;
  IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
    RAISE EXCEPTION 'an event type is required';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'the raw event payload (a JSON object) is required';
  END IF;

  -- Raw payload journaled BEFORE any processing. Idempotent by
  -- (provider, provider_event_id): a replayed event returns the EXISTING
  -- journal row and can never create a second one (UNIQUE enforces too).
  INSERT INTO politicore.billing_events
    (provider, provider_event_id, event_type, payload, signature_verified)
  VALUES
    (btrim(p_provider), btrim(p_provider_event_id), btrim(p_event_type), p_payload,
     COALESCE(p_signature_verified, false))
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING * INTO v_new;

  IF v_new.id IS NOT NULL THEN
    RETURN QUERY SELECT v_new.id, false, v_new.processing_status;
    RETURN;
  END IF;

  SELECT * INTO v_existing FROM politicore.billing_events
   WHERE provider = btrim(p_provider)
     AND provider_event_id = btrim(p_provider_event_id);
  RETURN QUERY SELECT v_existing.id, true, v_existing.processing_status;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.process_billing_events()
RETURNS TABLE (event_id uuid, action text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_event politicore.billing_events;
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing-event processing requires platform_super_admin authority';
  END IF;

  -- Write-once: every event is advanced EXACTLY once, from 'received'
  -- (the journal guard trigger enforces; re-runs never reprocess).
  -- V1 classification — known provider event types with an object payload
  -- → processed; anything else → rejected (journaled evidence preserved).
  FOR v_event IN
    SELECT * FROM politicore.billing_events
     WHERE processing_status = 'received'
     ORDER BY created_at
  LOOP
    IF v_event.event_type IN (
         'payment.succeeded', 'payment.failed', 'payment.refunded',
         'invoice.issued', 'invoice.paid', 'invoice.void',
         'subscription.activated', 'subscription.cancelled')
       AND jsonb_typeof(v_event.payload) = 'object' THEN
      UPDATE politicore.billing_events
         SET processing_status = 'processed', processed_at = now()
       WHERE id = v_event.id;
      event_id := v_event.id;
      action := 'processed';
    ELSE
      UPDATE politicore.billing_events
         SET processing_status = 'rejected', processed_at = now(),
             failure_reason = 'unrecognized event type or malformed payload'
       WHERE id = v_event.id;
      event_id := v_event.id;
      action := 'rejected';
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 13. PLATFORM READ MODELS — platform_super_admin-gated listings for the
--     /portal/admin/billing surface. Money columns stay in minor units;
--     raw webhook payloads are NOT in the listing (journal metadata only).
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION politicore.platform_subscriptions()
RETURNS TABLE (
  subscription_id      uuid,
  tenant_id            uuid,
  tenant_name          text,
  tenant_slug          text,
  status               politicore.subscription_status_enum,
  billing_interval     politicore.billing_interval_enum,
  currency             text,
  plan_code            text,
  plan_name            text,
  plan_version         integer,
  unit_price_minor     bigint,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_start          timestamptz,
  trial_end            timestamptz,
  cancel_at_period_end boolean,
  pending_plan_version_id uuid,
  failed_payment_count integer,
  past_due_since       timestamptz,
  ended_at             timestamptz,
  created_at           timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing read models require platform_super_admin authority';
  END IF;
  RETURN QUERY
  SELECT s.id, s.tenant_id, t.name, t.slug, s.status, s.billing_interval,
         s.currency, p.code, p.name, v.version,
         i.unit_price_minor,
         s.current_period_start, s.current_period_end,
         s.trial_start, s.trial_end, s.cancel_at_period_end,
         s.pending_plan_version_id,
         s.failed_payment_count, s.past_due_since, s.ended_at, s.created_at
    FROM politicore.subscriptions s
    JOIN politicore.tenants t       ON t.id = s.tenant_id
    JOIN politicore.plan_versions v ON v.id = s.plan_version_id
    JOIN politicore.plans p         ON p.id = v.plan_id
    LEFT JOIN politicore.subscription_items i
           ON i.subscription_id = s.id AND i.item_type = 'base_plan' AND i.status = 'active'
   ORDER BY s.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.platform_read_models()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  IF NOT (politicore.is_platform_admin() IS TRUE) THEN
    RAISE EXCEPTION 'billing read models require platform_super_admin authority';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.platform_invoices()
RETURNS TABLE (
  invoice_id        uuid,
  tenant_id         uuid,
  tenant_name       text,
  subscription_id   uuid,
  status            politicore.invoice_status_enum,
  invoice_number    text,
  plan_code         text,
  plan_name         text,
  plan_version      integer,
  billing_interval  politicore.billing_interval_enum,
  currency          text,
  period_start      timestamptz,
  period_end        timestamptz,
  subtotal_minor    bigint,
  discount_credits_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  refunded_minor    bigint,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  voided_at         timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  PERFORM politicore.platform_read_models();
  RETURN QUERY
  SELECT inv.id, inv.tenant_id, t.name, inv.subscription_id, inv.status,
         inv.invoice_number, inv.plan_code, inv.plan_name, inv.plan_version,
         inv.billing_interval, inv.currency, inv.period_start, inv.period_end,
         inv.subtotal_minor, inv.discount_credits_minor, inv.tax_minor,
         inv.total_minor, inv.refunded_minor,
         inv.issued_at, inv.due_at, inv.paid_at, inv.voided_at
    FROM politicore.invoices inv
    JOIN politicore.tenants t ON t.id = inv.tenant_id
   ORDER BY inv.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.platform_payments()
RETURNS TABLE (
  payment_id   uuid,
  tenant_id    uuid,
  tenant_name  text,
  invoice_id   uuid,
  invoice_number text,
  subscription_id uuid,
  amount_minor bigint,
  currency     text,
  status       politicore.payment_status_enum,
  provider     text,
  provider_payment_reference text,
  notes        text,
  received_at  timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  PERFORM politicore.platform_read_models();
  RETURN QUERY
  SELECT pay.id, pay.tenant_id, t.name, pay.invoice_id, inv.invoice_number,
         pay.subscription_id, pay.amount_minor, pay.currency, pay.status,
         pay.provider, pay.provider_payment_reference, pay.notes, pay.received_at
    FROM politicore.payments pay
    JOIN politicore.tenants t ON t.id = pay.tenant_id
    LEFT JOIN politicore.invoices inv ON inv.id = pay.invoice_id
   ORDER BY pay.received_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.platform_billing_events()
RETURNS TABLE (
  event_id           uuid,
  provider           text,
  provider_event_id  text,
  event_type         text,
  processing_status  politicore.billing_event_status_enum,
  signature_verified boolean,
  failure_reason     text,
  processed_at       timestamptz,
  created_at         timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
BEGIN
  PERFORM politicore.platform_read_models();
  RETURN QUERY
  SELECT e.id, e.provider, e.provider_event_id, e.event_type,
         e.processing_status, e.signature_verified, e.failure_reason,
         e.processed_at, e.created_at
    FROM politicore.billing_events e
   ORDER BY e.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION politicore.platform_billing_config()
RETURNS TABLE (grace_period_days integer, max_payment_retries integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
BEGIN
  PERFORM politicore.platform_read_models();
  RETURN QUERY
  SELECT grace_period_days, max_payment_retries FROM politicore.billing_config();
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 14. ROW LEVEL SECURITY — the direct-table boundary. Tenant users get
--     tenant-isolated SELECT only (their own rows); platform_super_admin
--     gets FOR ALL; there is NO authenticated mutation policy — every
--     write flows exclusively through the SECURITY DEFINER RPCs above.
--     Same posture as 0065 (gate invariants 9/10/14).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE politicore.subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.subscriptions       FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.subscription_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.subscription_items  FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.invoices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.invoices            FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.invoice_line_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.invoice_line_items  FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.payments            FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.payment_attempts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.payment_attempts    FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.refunds             ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.refunds             FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.credits             ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.credits             FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.credit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.credit_applications FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.billing_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.billing_events      FORCE ROW LEVEL SECURITY;

-- Platform authority: full surface on every billing table.
CREATE POLICY subscriptions_platform_admin ON politicore.subscriptions
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY subscription_items_platform_admin ON politicore.subscription_items
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY invoices_platform_admin ON politicore.invoices
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY invoice_line_items_platform_admin ON politicore.invoice_line_items
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY payments_platform_admin ON politicore.payments
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY payment_attempts_platform_admin ON politicore.payment_attempts
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY refunds_platform_admin ON politicore.refunds
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY credits_platform_admin ON politicore.credits
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY credit_applications_platform_admin ON politicore.credit_applications
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY billing_events_platform_admin ON politicore.billing_events
  FOR ALL USING (politicore.is_platform_admin());

-- Owner visibility: the tenant's own commercial records, SELECT only.
-- Plain `admin` and members gain NOTHING (no tenant_id match ever for a
-- different tenant, and no mutation policy exists anywhere).
CREATE POLICY subscriptions_tenant_read ON politicore.subscriptions
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY subscription_items_tenant_read ON politicore.subscription_items
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY invoices_tenant_read ON politicore.invoices
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY invoice_line_items_tenant_read ON politicore.invoice_line_items
  FOR SELECT USING (EXISTS (SELECT 1 FROM politicore.invoices inv
                              WHERE inv.id = invoice_id
                                AND inv.tenant_id = politicore.current_tenant_id()));
CREATE POLICY payments_tenant_read ON politicore.payments
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY payment_attempts_tenant_read ON politicore.payment_attempts
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY refunds_tenant_read ON politicore.refunds
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY credits_tenant_read ON politicore.credits
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY credit_applications_tenant_read ON politicore.credit_applications
  FOR SELECT USING (tenant_id = politicore.current_tenant_id());

-- anon: NO table grants survive the policy posture (explicit for defense
-- in depth; the journal has no tenant surface at all).
REVOKE ALL ON politicore.subscriptions       FROM anon;
REVOKE ALL ON politicore.subscription_items  FROM anon;
REVOKE ALL ON politicore.invoices            FROM anon;
REVOKE ALL ON politicore.invoice_line_items  FROM anon;
REVOKE ALL ON politicore.payments            FROM anon;
REVOKE ALL ON politicore.payment_attempts    FROM anon;
REVOKE ALL ON politicore.refunds             FROM anon;
REVOKE ALL ON politicore.credits             FROM anon;
REVOKE ALL ON politicore.credit_applications FROM anon;
REVOKE ALL ON politicore.billing_events      FROM anon;

-- ═══════════════════════════════════════════════════════════════════════
-- 15. PUBLIC WRAPPERS + GRANTS — the Phase 28 PostgREST pattern: a thin
--     SECURITY INVOKER public.* delegate over each politicore RPC, with
--     the underlying revoked from anon/PUBLIC. Owner-facing and platform-
--     facing RPCs are granted to authenticated; authority is enforced
--     INSIDE the underlying functions (never by grant alone).
-- ═══════════════════════════════════════════════════════════════════════

-- ── owner lifecycle ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_subscription(
  p_plan_version_id uuid, p_billing_interval politicore.billing_interval_enum)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.create_subscription($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.schedule_subscription_cancellation(
  p_subscription_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.schedule_subscription_cancellation($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.revoke_subscription_cancellation(
  p_subscription_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.revoke_subscription_cancellation($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.change_subscription_plan(
  p_subscription_id uuid, p_plan_version_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.change_subscription_plan($1, $2, $3);
$$;

-- ── owner read models ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.subscription_current()
RETURNS TABLE (
  subscription_id      uuid,
  tenant_id            uuid,
  status               politicore.subscription_status_enum,
  billing_interval     politicore.billing_interval_enum,
  currency             text,
  plan_version_id      uuid,
  plan_code            text,
  plan_name            text,
  plan_version         integer,
  feature_entitlements jsonb,
  limits               jsonb,
  unit_price_minor     bigint,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_start          timestamptz,
  trial_end            timestamptz,
  cancel_at_period_end boolean,
  pending_plan_version_id uuid,
  pending_plan_code    text,
  pending_plan_name    text,
  failed_payment_count integer,
  past_due_since       timestamptz,
  created_at           timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.subscription_current();
$$;

CREATE OR REPLACE FUNCTION public.my_invoices()
RETURNS TABLE (
  invoice_id        uuid,
  status            politicore.invoice_status_enum,
  invoice_number    text,
  plan_code         text,
  plan_name         text,
  plan_version      integer,
  billing_interval  politicore.billing_interval_enum,
  currency          text,
  period_start      timestamptz,
  period_end        timestamptz,
  subtotal_minor    bigint,
  discount_credits_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  refunded_minor    bigint,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  line_item_count   integer
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.my_invoices();
$$;

CREATE OR REPLACE FUNCTION public.my_invoice(p_invoice_id uuid)
RETURNS TABLE (
  invoice_id        uuid,
  status            politicore.invoice_status_enum,
  invoice_number    text,
  plan_code         text,
  plan_name         text,
  plan_version      integer,
  plan_version_id   uuid,
  billing_interval  politicore.billing_interval_enum,
  currency          text,
  period_start      timestamptz,
  period_end        timestamptz,
  subtotal_minor    bigint,
  discount_credits_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  refunded_minor    bigint,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  line_items        jsonb,
  payments          jsonb,
  refunds           jsonb,
  payment_attempts  jsonb
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.my_invoice($1);
$$;

CREATE OR REPLACE FUNCTION public.my_payments()
RETURNS TABLE (
  payment_id   uuid,
  invoice_id   uuid,
  invoice_number text,
  amount_minor bigint,
  currency     text,
  status       politicore.payment_status_enum,
  provider     text,
  provider_payment_reference text,
  received_at  timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.my_payments();
$$;

-- ── manual / offline adapter (platform-operated) ────────────────────
CREATE OR REPLACE FUNCTION public.record_manual_payment(
  p_invoice_id uuid, p_amount_minor bigint, p_currency text,
  p_provider_reference text, p_notes text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.record_manual_payment($1, $2, $3, $4, $5);
$$;

CREATE OR REPLACE FUNCTION public.record_manual_refund(
  p_payment_id uuid, p_amount_minor bigint, p_reason text, p_provider_reference text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.record_manual_refund($1, $2, $3, $4);
$$;

CREATE OR REPLACE FUNCTION public.record_payment_failure_manual(
  p_invoice_id uuid, p_failure_code text, p_failure_message text, p_provider_reference text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.record_payment_failure_manual($1, $2, $3, $4);
$$;

-- ── webhook / billing-event journal (platform-operated in V1) ───────
CREATE OR REPLACE FUNCTION public.journal_billing_event(
  p_provider text, p_provider_event_id text, p_event_type text,
  p_payload jsonb, p_signature_verified boolean)
RETURNS TABLE (event_id uuid, duplicate boolean, processing_status politicore.billing_event_status_enum)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.journal_billing_event($1, $2, $3, $4, $5);
$$;

CREATE OR REPLACE FUNCTION public.process_billing_events()
RETURNS TABLE (event_id uuid, action text)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.process_billing_events();
$$;

-- ── deterministic processors (platform-invoked) ─────────────────────
CREATE OR REPLACE FUNCTION public.process_trial_expiries()
RETURNS TABLE (subscription_id uuid, action text)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.process_trial_expiries();
$$;

CREATE OR REPLACE FUNCTION public.process_dunning_transitions()
RETURNS TABLE (subscription_id uuid, action text)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.process_dunning_transitions();
$$;

CREATE OR REPLACE FUNCTION public.process_period_renewals()
RETURNS TABLE (subscription_id uuid, action text)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.process_period_renewals();
$$;

-- ── platform invoicing ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_create_invoice(
  p_subscription_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.platform_create_invoice($1, $2);
$$;

CREATE OR REPLACE FUNCTION public.platform_issue_invoice(
  p_invoice_id uuid, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.platform_issue_invoice($1, $2);
$$;

-- ── credits ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_credit(
  p_tenant_id uuid, p_amount_minor bigint, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.issue_credit($1, $2, $3);
$$;

CREATE OR REPLACE FUNCTION public.apply_credit(
  p_credit_id uuid, p_invoice_id uuid, p_amount_minor bigint, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.apply_credit($1, $2, $3, $4);
$$;

-- ── platform authority ops ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.correct_subscription_state(
  p_subscription_id uuid, p_new_status text, p_reason text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.correct_subscription_state($1, $2, $3);
$$;

CREATE OR REPLACE FUNCTION public.set_billing_config(
  p_grace_period_days integer, p_max_payment_retries integer, p_reason text)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT politicore.set_billing_config($1, $2, $3);
$$;

-- ── platform read models ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.platform_subscriptions()
RETURNS TABLE (
  subscription_id      uuid,
  tenant_id            uuid,
  tenant_name          text,
  tenant_slug          text,
  status               politicore.subscription_status_enum,
  billing_interval     politicore.billing_interval_enum,
  currency             text,
  plan_code            text,
  plan_name            text,
  plan_version         integer,
  unit_price_minor     bigint,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_start          timestamptz,
  trial_end            timestamptz,
  cancel_at_period_end boolean,
  pending_plan_version_id uuid,
  failed_payment_count integer,
  past_due_since       timestamptz,
  ended_at             timestamptz,
  created_at           timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.platform_subscriptions();
$$;

CREATE OR REPLACE FUNCTION public.platform_invoices()
RETURNS TABLE (
  invoice_id        uuid,
  tenant_id         uuid,
  tenant_name       text,
  subscription_id   uuid,
  status            politicore.invoice_status_enum,
  invoice_number    text,
  plan_code         text,
  plan_name         text,
  plan_version      integer,
  billing_interval  politicore.billing_interval_enum,
  currency          text,
  period_start      timestamptz,
  period_end        timestamptz,
  subtotal_minor    bigint,
  discount_credits_minor bigint,
  tax_minor         bigint,
  total_minor       bigint,
  refunded_minor    bigint,
  issued_at         timestamptz,
  due_at            timestamptz,
  paid_at           timestamptz,
  voided_at         timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.platform_invoices();
$$;

CREATE OR REPLACE FUNCTION public.platform_payments()
RETURNS TABLE (
  payment_id   uuid,
  tenant_id    uuid,
  tenant_name  text,
  invoice_id   uuid,
  invoice_number text,
  subscription_id uuid,
  amount_minor bigint,
  currency     text,
  status       politicore.payment_status_enum,
  provider     text,
  provider_payment_reference text,
  notes        text,
  received_at  timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.platform_payments();
$$;

CREATE OR REPLACE FUNCTION public.platform_billing_events()
RETURNS TABLE (
  event_id           uuid,
  provider           text,
  provider_event_id  text,
  event_type         text,
  processing_status  politicore.billing_event_status_enum,
  signature_verified boolean,
  failure_reason     text,
  processed_at       timestamptz,
  created_at         timestamptz
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.platform_billing_events();
$$;

CREATE OR REPLACE FUNCTION public.platform_billing_config()
RETURNS TABLE (grace_period_days integer, max_payment_retries integer)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT * FROM politicore.platform_billing_config();
$$;

-- ═════════════════════════════════════════════════════ grants ──

GRANT EXECUTE ON FUNCTION public.create_subscription(uuid, politicore.billing_interval_enum) TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_subscription_cancellation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_subscription_cancellation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_subscription_plan(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.correct_subscription_state(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_current() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_invoices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_invoice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_payments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_payment(uuid, bigint, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_manual_refund(uuid, bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_failure_manual(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.journal_billing_event(text, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_billing_events() TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_trial_expiries() TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_dunning_transitions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_period_renewals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_create_invoice(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_issue_invoice(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.issue_credit(uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_credit(uuid, uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_billing_config(integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_subscriptions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_invoices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_payments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_billing_events() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_billing_config() TO authenticated;

REVOKE ALL ON FUNCTION public.create_subscription(uuid, politicore.billing_interval_enum) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.schedule_subscription_cancellation(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_subscription_cancellation(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.change_subscription_plan(uuid, uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.correct_subscription_state(uuid, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_current() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.my_invoices() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.my_invoice(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.my_payments() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.record_manual_payment(uuid, bigint, text, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.record_manual_refund(uuid, bigint, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.record_payment_failure_manual(uuid, text, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.journal_billing_event(text, text, text, jsonb, boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.process_billing_events() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.process_trial_expiries() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.process_dunning_transitions() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.process_period_renewals() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_create_invoice(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_issue_invoice(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.issue_credit(uuid, bigint, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.apply_credit(uuid, uuid, bigint, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.set_billing_config(integer, integer, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_subscriptions() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_invoices() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_payments() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_billing_events() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.platform_billing_config() FROM anon, PUBLIC;

REVOKE ALL ON FUNCTION politicore.create_subscription(uuid, politicore.billing_interval_enum) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.schedule_subscription_cancellation(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.revoke_subscription_cancellation(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.change_subscription_plan(uuid, uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.correct_subscription_state(uuid, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.subscription_current() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.my_invoices() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.my_invoice(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.my_payments() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.record_manual_payment(uuid, bigint, text, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.record_manual_refund(uuid, bigint, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.record_payment_failure_manual(uuid, text, text, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.journal_billing_event(text, text, text, jsonb, boolean) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.process_billing_events() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.process_trial_expiries() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.process_dunning_transitions() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.process_period_renewals() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_create_invoice(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_issue_invoice(uuid, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.issue_credit(uuid, bigint, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.apply_credit(uuid, uuid, bigint, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.set_billing_config(integer, integer, text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_subscriptions() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_invoices() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_payments() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_billing_events() FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.platform_billing_config() FROM anon, PUBLIC;
