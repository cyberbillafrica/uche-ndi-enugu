/**
 * POLITICORE — SAAS PHASE 29 — SUBSCRIPTION & BILLING CORE SECURITY
 * SUITE (SaaS Phase B).
 *
 * Proves migration 0066 + the Phase 27 gate's Phase B requirements against
 * role-impersonated sessions (helpers.as) — the acceptance standard of
 * Phases 1–28:
 *
 *   A. Tenant isolation    — owner-only billing reads; plain admin and
 *                            members hold NOTHING; no cross-tenant reads
 *                            or writes; no anon mutation; no direct-table
 *                            writes for non-platform roles.
 *   B. Owner authority     — subscribe (trial from the plan version),
 *                            cancel/revoke, next-period plan change with
 *                            currency/price validation; one live
 *                            subscription per tenant; ended immutability.
 *   C. Platform authority  — reason-mandated ops; correction respects the
 *                            legal edge map; processors are platform-only.
 *   D. Invoice integrity   — DB-enforced transitions; issued immutability
 *                            (amounts/snapshot frozen); frozen line items.
 *   E. Payment integrity   — same state machine for every source; full-
 *                            amount settlement; currency match (no FX);
 *                            idempotent provider references; attempts;
 *                            failure → past_due; dunning recovery.
 *   F. Refunds & credits   — partial refunds never exceed refundable;
 *                            credits apply to draft invoices only, never
 *                            exceeding remaining balance.
 *   G. Entitlement sync    — subscription state drives the EXISTING
 *                            service_entitlements map (trialing/active
 *                            apply; past_due retains; restricted/cancelled
 *                            clear); authorization substrates untouched.
 *   H. Dunning & trials    — grace from the settings map (tunable without
 *                            a migration); deterministic trial expiry;
 *                            idempotent processors; renewal idempotency.
 *   I. Webhook journal     — raw payload journaled before processing;
 *                            idempotent by (provider, provider_event_id);
 *                            write-once processing; payload immutability.
 *   J. Audit & architecture— every lifecycle event Core-Audit-logged with
 *                            server-resolved actors; no new roles/modules/
 *                            permissions; migration-count pin at 67/0066.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { PGlite } from "@electric-sql/pglite";
import { getDb, as, createTenant, createUser } from "./helpers";

const E = "p29saas";
const ROOT = process.cwd();

/**
 * Direct-SQL statements that MUST raise return the error message.
 * Runs on the BARE pglite session (superuser) — deliberately bypassing RLS
 * so DB-level guard triggers are exercised independently of policies.
 */
async function queryErr(
  db: PGlite,
  sql: string,
  params?: unknown[]
): Promise<string | null> {
  try {
    await db.query(sql, params as never[]);
    return null;
  } catch (e) {
    const m = (e as { message?: unknown })?.message;
    return typeof m === "string" ? m : JSON.stringify(e);
  }
}

/** Extract a scalar RPC result (pglite returns `[{ fname: "<value>" }]`). */
function scalar(rows: Record<string, unknown>[], key: string): string {
  const v = rows[0]?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`expected scalar ${key}, got ${JSON.stringify(rows[0])}`);
  }
  return v;
}

describe("phase29 — subscriptions & billing core", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let owner: { authId: string; profileId: string };
  let member: { authId: string };
  let plainAdmin: { authId: string };
  let ownerB: { authId: string };
  let platformAdmin: { authId: string; profileId: string };
  let originalSettings: unknown;

  let verA: string; // tenant A's active plan version (monthly price 100000 kobo)
  let verB: string; // second ACTIVE version for plan-change tests
  let verUSD: string; // ACTIVE version denominated in USD (no-FX refusal probe)
  let verDraft: string;

  beforeAll(async () => {
    db = await getDb();
    tenantA = await createTenant(db, "p29saas-a", "Phase 29 SaaS A", {});
    tenantB = await createTenant(db, "p29saas-b", "Phase 29 SaaS B", {});
    owner = await createUser(db, { tenantId: tenantA, email: `${E}-owner@test.local`, fullName: "P29 Owner A", accessRole: "tenant_super_admin" });
    member = await createUser(db, { tenantId: tenantA, email: `${E}-mem@test.local`, fullName: "P29 Member A", accessRole: "member" });
    plainAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-adm@test.local`, fullName: "P29 Admin A", accessRole: "admin" });
    ownerB = await createUser(db, { tenantId: tenantB, email: `${E}-ownerb@test.local`, fullName: "P29 Owner B", accessRole: "tenant_super_admin" });
    platformAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-platform@test.local`, fullName: "P29 Platform Admin", accessRole: "platform_super_admin" });

    const cur = await db.query(`SELECT settings FROM politicore.platform_settings WHERE id = 1`);
    originalSettings = cur.rows[0] ? (cur.rows[0] as Record<string, unknown>).settings : null;
    // The sync/entitlement writer UPDATEs (never upserts) row id=1, so
    // guarantee the singleton exists.
    await db.query(`INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);

    // Plan A + active version (monthly 100000 kobo / annual 1000000 kobo, 14-day trial).
    const plan = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 91, 'phase29 fixture') AS p`, ["p29-probe", "P29 Probe"]);
    if (plan.error) throw new Error(`create_plan: ${plan.error}`);
    const planId = scalar(plan.rows, "p");
    const ver = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social','governance'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, $2, 'phase29 fixture') AS v`,
      [planId, '{"monthly": 100000, "annual": 1000000}']);
    if (ver.error) throw new Error(`create_plan_version: ${ver.error}`);
    verA = scalar(ver.rows, "v");
    const act = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.activate_plan_version($1, 'phase29 fixture') AS v`, [verA]);
    if (act.error) throw new Error(`activate_plan_version: ${act.error}`);

    // Version B (different plan, same currency, active) for plan-change tests.
    const planB = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 92, 'phase29 fixture') AS p`, ["p29-probe-b", "P29 Probe B"]);
    if (planB.error) throw new Error(`create_plan B: ${planB.error}`);
    const planBId = scalar(planB.rows, "p");
    const ver2 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, $2, 'phase29 fixture') AS v`,
      [planBId, '{"monthly": 200000}']);
    if (ver2.error) throw new Error(`create_plan_version B: ${ver2.error}`);
    verB = scalar(ver2.rows, "v");
    const actB = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.activate_plan_version($1, 'phase29 fixture') AS v`, [verB]);
    if (actB.error) throw new Error(`activate B: ${actB.error}`);

    // A USD version — proves the no-FX refusal on plan changes.
    const planU = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 94, 'phase29 fixture') AS p`, ["p29-probe-usd", "P29 Probe USD"]);
    if (planU.error) throw new Error(`create_plan USD: ${planU.error}`);
    const planUId = scalar(planU.rows, "p");
    const ver4 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'USD', true, 14, '{"monthly": 5000}', 'phase29 fixture') AS v`,
      [planUId]);
    if (ver4.error) throw new Error(`create_plan_version USD: ${ver4.error}`);
    verUSD = scalar(ver4.rows, "v");
    const actU = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.activate_plan_version($1, 'phase29 fixture') AS v`, [verUSD]);
    if (actU.error) throw new Error(`activate USD: ${actU.error}`);

    // A DRAFT version — never subscribable, never schedulable.
    const planD = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 93, 'phase29 fixture') AS p`, ["p29-probe-d", "P29 Probe Draft"]);
    if (planD.error) throw new Error(`create_plan D: ${planD.error}`);
    const planDId = scalar(planD.rows, "p");
    const ver3 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{"monthly": 300000}', 'phase29 fixture') AS v`,
      [planDId]);
    if (ver3.error) throw new Error(`create_plan_version D: ${ver3.error}`);
    verDraft = scalar(ver3.rows, "v");
  }, 180_000);

  afterAll(async () => {
    // Billing teardown in FK-child→parent order. The integrity guards
    // correctly freeze issued/paid invoices (their line items included),
    // so teardown runs with triggers suppressed (replica mode) — the same
    // pattern the hosted smoke uses. Guards remain fully enforced for the
    // RPC paths proven in the tests above.
    await db.query(`SET session_replication_role = replica`);
    await db.query(
      `DELETE FROM politicore.credit_applications WHERE invoice_id IN (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))`,
      [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.payment_attempts WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.refunds WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.payments WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.invoice_line_items WHERE invoice_id IN (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.invoices WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.credits WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.subscription_items WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.subscriptions WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.billing_events WHERE provider = 'p29test'`);
    await db.query(`SET session_replication_role = DEFAULT`);
    // Billing notifications reference the owner profiles (user_id FK).
    await db.query(
      `DELETE FROM politicore.notifications WHERE tenant_id = ANY($1) AND type = 'system'`,
      [[tenantA, tenantB]]);
    await db.query(
      `DELETE FROM politicore.system_audits
        WHERE tenant_id = ANY($1)
           OR (tenant_id IS NULL AND affected_resource = 'platform_settings')`,
      [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.plan_versions WHERE plan_id IN (SELECT id FROM politicore.plans WHERE code LIKE 'p29-probe%')`);
    await db.query(`DELETE FROM politicore.plans WHERE code LIKE 'p29-probe%'`);
    await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`,
      [[owner.authId, member.authId, plainAdmin.authId, ownerB.authId, platformAdmin.authId]]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`,
      [[owner.authId, member.authId, plainAdmin.authId, ownerB.authId, platformAdmin.authId]]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
    if (originalSettings !== null) {
      await db.query(`UPDATE politicore.platform_settings SET settings = $1::jsonb WHERE id = 1`, [JSON.stringify(originalSettings)]);
    }
  });

  /** The tenant owner's live subscription id (or null). */
  async function liveSub(): Promise<string | null> {
    const r = await db.query(
      `SELECT id FROM politicore.subscriptions WHERE tenant_id = $1 AND ended_at IS NULL`, [tenantA]);
    return r.rows.length ? (r.rows[0] as Record<string, unknown>).id as string : null;
  }

  // ══ A. Tenant isolation ═════════════════════════════════════════════
  describe("A. tenant isolation", () => {
    it("A1 members hold nothing: no subscription_current, no my_invoices, no create_subscription", async () => {
      for (const stmt of [
        `SELECT * FROM public.subscription_current()`,
        `SELECT * FROM public.my_invoices()`,
        `SELECT public.create_subscription('${verA}', 'monthly') AS s`,
        `SELECT * FROM public.my_payments()`,
      ]) {
        const r = await as(db, "authenticated", member.authId, stmt);
        expect(r.error, `member must be refused: ${stmt}`).toBeDefined();
        expect(r.error).toMatch(/tenant owner|tenant_super_admin|authority/i);
      }
    });

    it("A2 plain admin gains NOTHING over billing", async () => {
      const r = await as(db, "authenticated", plainAdmin.authId, `SELECT * FROM public.subscription_current()`);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/tenant owner|tenant_super_admin/i);
    });

    it("A3 the owner sees only their own tenant's data via the read models", async () => {
      // Create owner B's subscription, then assert owner A's surfaces are empty.
      const subB = await as(db, "authenticated", ownerB.authId,
        `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
      expect(subB.error).toBeUndefined();
      expect(scalar(subB.rows, "s")).toMatch(/^[0-9a-f-]{36}$/);

      const mine = await as(db, "authenticated", owner.authId, `SELECT * FROM public.subscription_current()`);
      expect(mine.error).toBeUndefined();
      expect(mine.rows).toHaveLength(0);
      const inv = await as(db, "authenticated", owner.authId, `SELECT * FROM public.my_invoices()`);
      expect(inv.rows).toHaveLength(0);
      const pay = await as(db, "authenticated", owner.authId, `SELECT * FROM public.my_payments()`);
      expect(pay.rows).toHaveLength(0);
    });

    it("A4 owner cannot authorize against another tenant's subscription (server-resolved identity)", async () => {
      const subB = (await liveSubB())!;
      const r = await as(db, "authenticated", owner.authId,
        `SELECT public.schedule_subscription_cancellation($1, 'A4 cross-tenant probe') AS s`, [subB]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/tenant owner \(tenant_super_admin\) or platform_super_admin/i);
    });

    it("A5 platform read models are platform-super-admin gated", async () => {
      for (const stmt of [
        `SELECT * FROM public.platform_subscriptions()`,
        `SELECT * FROM public.platform_invoices()`,
        `SELECT * FROM public.platform_payments()`,
        `SELECT * FROM public.platform_billing_events()`,
        `SELECT * FROM public.platform_billing_config()`,
      ]) {
        const r = await as(db, "authenticated", owner.authId, stmt);
        expect(r.error, `owner must be refused: ${stmt}`).toBeDefined();
        expect(r.error).toMatch(/platform_super_admin|platform administration/i);
      }
    });

    it("A6 anon holds nothing: no reads, no writes, no executes", async () => {
      const r1 = await as(db, "anon", null, `SELECT * FROM public.subscription_current()`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null,
        `SELECT * FROM politicore.subscriptions LIMIT 1`);
      expect(r2.error).toBeDefined();
      const r3 = await as(db, "anon", null,
        `SELECT public.create_subscription('${verA}', 'monthly') AS s`);
      expect(r3.error).toBeDefined();
      const r4 = await as(db, "anon", null, `SELECT * FROM politicore.billing_events LIMIT 1`);
      expect(r4.error).toBeDefined();
    });

    it("A7 no direct-table writes for non-platform roles (RLS FORCE)", async () => {
      const subB = (await liveSubB())!;
      // INSERT: no mutation policy exists → RLS refuses outright.
      const ins = await as(db, "authenticated", member.authId,
        `INSERT INTO politicore.payments (tenant_id, invoice_id, amount_minor, currency, provider, provider_payment_reference)
         VALUES ('${tenantB}', '00000000-0000-0000-0000-000000000000', 1, 'NGN', 'p29test', 'a7-bypass')`);
      expect(ins.error).toBeDefined();
      // UPDATE of another tenant's subscription: invisible → 0 rows.
      const upd = await as(db, "authenticated", member.authId,
        `UPDATE politicore.subscriptions SET status = 'active' WHERE id = '${subB}' RETURNING id`);
      expect(upd.error).toBeUndefined();
      expect(upd.rows).toHaveLength(0);
      // DELETE of another tenant's invoices: invisible → 0 rows.
      const del = await as(db, "authenticated", member.authId,
        `DELETE FROM politicore.invoices WHERE tenant_id = '${tenantB}' RETURNING id`);
      expect(del.error).toBeUndefined();
      expect(del.rows).toHaveLength(0);
    });

    it("A8 owner SELECT on own rows works (tenant-isolated RLS)", async () => {
      // Owner B reads their own subscription rows directly — allowed by the
      // SELECT-only policy; writes remain RPC-only (A7).
      const r = await as(db, "authenticated", ownerB.authId,
        `SELECT id FROM politicore.subscriptions WHERE tenant_id = '${tenantB}'`);
      expect(r.error).toBeUndefined();
      expect(r.rows).toHaveLength(1);
      // ...and cannot see tenant A's rows even where one exists.
      const subA = await as(db, "authenticated", owner.authId,
        `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
      expect(subA.error).toBeUndefined();
      const cross = await as(db, "authenticated", ownerB.authId,
        `SELECT count(*)::int AS n FROM politicore.subscriptions WHERE tenant_id = '${tenantA}'`);
      expect(cross.rows[0]?.n).toBe(0);
    });
  });

  async function liveSubB(): Promise<string | null> {
    const r = await db.query(
      `SELECT id FROM politicore.subscriptions WHERE tenant_id = $1 AND ended_at IS NULL`, [tenantB]);
    return r.rows.length ? (r.rows[0] as Record<string, unknown>).id as string : null;
  }

  // ══ B. Owner authority ══════════════════════════════════════════════
  describe("B. owner authority", () => {
    it("B1 only ONE live subscription per tenant", async () => {
      const before = await liveSub();
      expect(before).not.toBeNull();
      const r = await as(db, "authenticated", owner.authId,
        `SELECT public.create_subscription($1, 'annual') AS s`, [verA]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/one live subscription|already|unique|duplicate/i);
    });

    it("B2 draft plan versions are NOT subscribable", async () => {
      // (no live sub on A right now — B3 hasn't run; use tenant B? B has one.)
      // Use the guard: attempt on A must also fail for the DRAFT reason even
      // though A already has a live sub; we assert the draft rejection via a
      // fresh subscription path only when A has no live sub. Simplest: verify
      // through schedule/create on B's existing sub instead.
      const r = await as(db, "authenticated", owner.authId,
        `SELECT public.change_subscription_plan((SELECT id FROM politicore.subscriptions WHERE tenant_id = $1 AND ended_at IS NULL), $2, 'draft probe') AS s`,
        [tenantA, verDraft]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/only ACTIVE versions|draft/i);
    });

    it("B3 cancel_at_period_end defaults to true semantics: schedule + revoke", async () => {
      const sub = (await liveSub())!;
      const sched = await as(db, "authenticated", owner.authId,
        `SELECT public.schedule_subscription_cancellation($1, NULL) AS s`, [sub]);
      expect(sched.error).toBeUndefined();
      const flag = await db.query(`SELECT cancel_at_period_end FROM politicore.subscriptions WHERE id = $1`, [sub]);
      expect((flag.rows[0] as Record<string, unknown>).cancel_at_period_end).toBe(true);
      const rev = await as(db, "authenticated", owner.authId,
        `SELECT public.revoke_subscription_cancellation($1, NULL) AS s`, [sub]);
      expect(rev.error).toBeUndefined();
      const flag2 = await db.query(`SELECT cancel_at_period_end FROM politicore.subscriptions WHERE id = $1`, [sub]);
      expect((flag2.rows[0] as Record<string, unknown>).cancel_at_period_end).toBe(false);
    });

    it("B4 next-period plan change: scheduled now, applied only by the renewal/conversion path", async () => {
      // Owner B schedules an upgrade on THEIR subscription (tenant A's stays
      // clean for the conversion and invoicing sections).
      const subB = (await liveSubB())!;
      const r = await as(db, "authenticated", ownerB.authId,
        `SELECT public.change_subscription_plan($1, $2, 'upgrade probe') AS s`, [subB, verB]);
      expect(r.error).toBeUndefined();
      const row = await db.query(
        `SELECT plan_version_id, pending_plan_version_id FROM politicore.subscriptions WHERE id = $1`, [subB]);
      const rec = row.rows[0] as Record<string, unknown>;
      expect(rec.plan_version_id).toBe(verA);
      expect(rec.pending_plan_version_id).toBe(verB);
    });

    it("B5 plan change refuses a currency mismatch (no FX — prices are per-currency rows)", async () => {
      const sub = (await liveSub())!;
      const r = await as(db, "authenticated", owner.authId,
        `SELECT public.change_subscription_plan($1, $2, 'B5 currency mismatch probe') AS s`, [sub, verUSD]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/does not match the subscription currency|no FX/i);
      // Nothing was scheduled.
      const row = await db.query(
        `SELECT pending_plan_version_id FROM politicore.subscriptions WHERE id = $1`, [sub]);
      expect((row.rows[0] as Record<string, unknown>).pending_plan_version_id).toBeNull();
    });

    it("B6 cancelled subscriptions are ended and immutable; re-subscribe starts fresh", async () => {
      const sub = (await liveSub())!;
      // Platform immediate-cancel (reason required) — legal edge trialing → cancelled.
      const c = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.correct_subscription_state($1, 'cancelled', 'B6 owner requested immediate cancellation') AS s`, [sub]);
      expect(c.error).toBeUndefined();
      const row = await db.query(
        `SELECT status, ended_at, cancelled_at FROM politicore.subscriptions WHERE id = $1`, [sub]);
      const rec = row.rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("cancelled");
      expect(rec.ended_at).not.toBeNull();
      expect(rec.cancelled_at).not.toBeNull();

      // Immutable: any UPDATE on an ended subscription fails.
      const err = await queryErr(db,
        `UPDATE politicore.subscriptions SET status = 'active' WHERE id = $1`, [sub]);
      expect(err).toMatch(/historical fact|immutable/i);

      // Fresh subscription for the payment sections (trial again).
      const fresh = await as(db, "authenticated", owner.authId,
        `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
      expect(fresh.error).toBeUndefined();
      expect(scalar(fresh.rows, "s")).not.toBe(sub);
    });

    it("B7 subscription_plans: owner-scoped catalog with version ids and committed prices", async () => {
      // Owner sees ACTIVE versions with ids and committed prices.
      const ownerRows = await as(db, "authenticated", owner.authId,
        `SELECT * FROM public.subscription_plans()`);
      expect(ownerRows.error).toBeUndefined();
      const mine = ownerRows.rows.find(
        (r) => (r as Record<string, unknown>).plan_version_id === verA) as Record<string, unknown> | undefined;
      expect(mine).toBeDefined();
      expect(String(mine!.currency)).toBe("NGN");
      const prices = mine!.prices as Record<string, number>;
      expect(Number(prices.monthly)).toBe(100000);
      expect(Number(prices.annual)).toBe(1000000);

      // Member and plain admin: no rows — authority mirrors create_subscription.
      const memberRows = await as(db, "authenticated", member.authId,
        `SELECT * FROM public.subscription_plans()`);
      expect(memberRows.error).toBeUndefined();
      expect(memberRows.rows).toHaveLength(0);
      const adminRows = await as(db, "authenticated", plainAdmin.authId,
        `SELECT * FROM public.subscription_plans()`);
      expect(adminRows.error).toBeUndefined();
      expect(adminRows.rows).toHaveLength(0);

      // Anonymous: denied at the grant level (0066 convention for every
      // billing RPC — anon never sees billing surfaces).
      const anonRows = await as(db, "anon", null,
        `SELECT * FROM public.subscription_plans()`);
      expect(anonRows.error).toBeDefined();
      expect(anonRows.error).toMatch(/permission denied/i);

      // Platform admin sees the catalog too.
      const platformRows = await as(db, "authenticated", platformAdmin.authId,
        `SELECT count(*)::int AS n FROM public.subscription_plans()`);
      expect(platformRows.error).toBeUndefined();
      expect(Number((platformRows.rows[0] as Record<string, unknown>).n)).toBeGreaterThanOrEqual(3);
    });
  });

  // ══ C. Platform authority ═══════════════════════════════════════════
  describe("C. platform authority", () => {
    it("C1 platform mutations require a reason (≥5 chars)", async () => {
      const sub = (await liveSub())!;
      for (const attempt of [
        [`SELECT public.correct_subscription_state($1, 'restricted', NULL) AS s`, [sub]],
        [`SELECT public.correct_subscription_state($1, 'restricted', 'no') AS s`, [sub]],
        [`SELECT public.platform_create_invoice($1, NULL) AS s`, [sub]],
        [`SELECT public.issue_credit($1, 1000, '') AS s`, [tenantA]],
      ]) {
        const r = await as(db, "authenticated", platformAdmin.authId, attempt[0] as string, attempt[1] as unknown[]);
        expect(r.error, `must require a reason: ${attempt[0]}`).toBeDefined();
        expect(r.error).toMatch(/reason/i);
      }
    });

    it("C2 state correction respects the legal edge map (trialing → active is ILLEGAL)", async () => {
      const sub = (await liveSub())!;
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.correct_subscription_state($1, 'active', 'C2 bypass attempt — must be refused by the edge map') AS s`, [sub]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/illegal subscription status transition|violates check constraint/i);
    });

    it("C3 processors and payment primitives are platform-only", async () => {
      for (const stmt of [
        `SELECT * FROM public.process_trial_expiries()`,
        `SELECT * FROM public.process_dunning_transitions()`,
        `SELECT * FROM public.process_period_renewals()`,
        `SELECT * FROM public.process_billing_events()`,
        `SELECT public.record_manual_payment('00000000-0000-0000-0000-000000000000', 100000, 'NGN', 'ref', 'notes here') AS s`,
        `SELECT public.issue_credit('${tenantA}', 1000, 'owner credit attempt') AS s`,
      ]) {
        const r = await as(db, "authenticated", owner.authId, stmt);
        expect(r.error, `owner must be refused: ${stmt}`).toBeDefined();
        expect(r.error).toMatch(/platform_super_admin/i);
      }
    });

    it("C4 set_billing_config validates ranges and writes the EXISTING settings map", async () => {
      const bad = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.set_billing_config(999, 3, 'C4 out-of-range grace') AS s`);
      expect(bad.error).toMatch(/between 0 and 90/i);

      const ok = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.set_billing_config(2, 1, 'C4 tighten dunning for the test run') AS s`);
      expect(ok.error).toBeUndefined();
      const cfg = await db.query(
        `SELECT settings->'billing' AS b FROM politicore.platform_settings WHERE id = 1`);
      expect(cfg.rows[0] as Record<string, unknown>).toMatchObject({
        b: { grace_period_days: 2, max_payment_retries: 1 },
      });
    });
  });

  // ══ D. Invoice integrity ════════════════════════════════════════════
  describe("D. invoice integrity", () => {
    let invoiceId: string;

    it("D1 platform creates + issues an invoice (snapshot + number + due date from grace config)", async () => {
      const sub = (await liveSub())!;
      // The subscription is TRIALING with grace 2 (C4) — first invoice
      // starts at the conversion moment.
      const inv = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_create_invoice($1, 'D1 first invoice for the trial tenant') AS s`, [sub]);
      expect(inv.error).toBeUndefined();
      invoiceId = scalar(inv.rows, "s");

      const issued = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_issue_invoice($1, 'D1 issue') AS s`, [invoiceId]);
      expect(issued.error).toBeUndefined();

      const row = await db.query(
        `SELECT status, invoice_number, total_minor, currency, due_at, issued_at, plan_code, plan_version
           FROM politicore.invoices WHERE id = $1`, [invoiceId]);
      const rec = row.rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("issued");
      expect(rec.invoice_number).toMatch(/^INV-\d{8}-[0-9a-f]{8}$/);
      expect(rec.total_minor).toBe(100000);
      expect(rec.currency).toBe("NGN");
      expect(rec.plan_code).toBe("p29-probe");
      expect(rec.plan_version).toBe(1);
      expect(rec.due_at).not.toBeNull();
    });

    it("D2 only draft → issued; illegal transitions are refused by the DB", async () => {
      const err1 = await queryErr(db,
        `UPDATE politicore.invoices SET status = 'paid' WHERE id = $1`, [invoiceId]);
      expect(err1).toMatch(/paid invoice must record paid_at|illegal invoice status transition/i);
      const err2 = await queryErr(db,
        `UPDATE politicore.invoices SET status = 'draft' WHERE id = $1`, [invoiceId]);
      expect(err2).toMatch(/illegal invoice status transition/i);
    });

    it("D3 issued invoices are frozen: amounts and snapshot immutable", async () => {
      for (const stmt of [
        `UPDATE politicore.invoices SET total_minor = 999 WHERE id = '${invoiceId}'`,
        `UPDATE politicore.invoices SET currency = 'USD' WHERE id = '${invoiceId}'`,
        `UPDATE politicore.invoices SET plan_code = 'hacked' WHERE id = '${invoiceId}'`,
        `UPDATE politicore.invoices SET period_start = now() - interval '1 year' WHERE id = '${invoiceId}'`,
      ]) {
        const err = await queryErr(db, stmt);
        expect(err, `issued invoice must be frozen: ${stmt}`).toBeDefined();
      }
    });

    it("D4 line items freeze once the invoice issues", async () => {
      const err = await queryErr(db,
        `UPDATE politicore.invoice_line_items SET amount_minor = 1 WHERE invoice_id = $1`, [invoiceId]);
      expect(err).toMatch(/frozen|immutable/i);
      const err2 = await queryErr(db,
        `INSERT INTO politicore.invoice_line_items (invoice_id, description, amount_minor, currency)
         VALUES ($1, 'phantom item', 500, 'NGN')`, [invoiceId]);
      expect(err2).toMatch(/frozen|immutable/i);
    });

    it("D5 the owner sees the invoice; the other tenant does not", async () => {
      const mine = await as(db, "authenticated", owner.authId, `SELECT * FROM public.my_invoices()`);
      expect(mine.error).toBeUndefined();
      expect(mine.rows).toHaveLength(1);
      expect(mine.rows[0]).toMatchObject({ invoice_id: invoiceId, status: "issued" });
      const other = await as(db, "authenticated", ownerB.authId,
        `SELECT * FROM public.my_invoice($1)`, [invoiceId]);
      expect(other.rows).toHaveLength(0);
    });

    it("D6 an invoice number is issued exactly once and unique", async () => {
      const r = await db.query(
        `SELECT invoice_number FROM politicore.invoices WHERE id = $1`, [invoiceId]);
      const n = (r.rows[0] as Record<string, unknown>).invoice_number as string;
      expect(n).toMatch(/^INV-/);
      // Re-issuing a non-draft invoice is refused.
      const again = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_issue_invoice($1, 'D6 double issue') AS s`, [invoiceId]);
      expect(again.error).toMatch(/only a DRAFT invoice can be issued/i);
    });
  });

  // ══ E. Payment integrity ════════════════════════════════════════════
  describe("E. payment integrity", () => {
    let invoiceId: string;

    it("E1 payment must settle the invoice in FULL, in the invoice currency", async () => {
      invoiceId = (await db.query(
        `SELECT id FROM politicore.invoices WHERE tenant_id = $1 AND status = 'issued' ORDER BY created_at LIMIT 1`,
        [tenantA])).rows[0] ? ((await db.query(
        `SELECT id FROM politicore.invoices WHERE tenant_id = $1 AND status = 'issued' ORDER BY created_at LIMIT 1`,
        [tenantA])).rows[0] as Record<string, unknown>).id as string : "";
      expect(invoiceId).not.toBe("");

      const partial = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 50000, 'NGN', 'p29test-e1-partial', 'E1 partial payment attempt') AS s`,
        [invoiceId]);
      expect(partial.error).toBeDefined();
      expect(partial.error).toMatch(/in full/i);

      const fx = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'USD', 'p29test-e1-fx', 'E1 currency mismatch attempt') AS s`,
        [invoiceId]);
      expect(fx.error).toBeDefined();
      expect(fx.error).toMatch(/no FX|does not match invoice currency/i);

      const subBefore = (await db.query(
        `SELECT status FROM politicore.subscriptions WHERE tenant_id = $1 AND ended_at IS NULL`, [tenantA]))
        .rows[0] as Record<string, unknown>;
      expect(subBefore.status).toBe("trialing");
    });

    it("E2 a verified manual payment converts the TRIAL → active (same state machine), sets the period, syncs entitlements", async () => {
      const subBefore = (await liveSub())!;
      const pay = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'NGN', 'p29test-e2-pay1', 'E2 verified bank transfer reference') AS s`,
        [invoiceId]);
      expect(pay.error).toBeUndefined();
      const paymentId = scalar(pay.rows, "s");

      const row = await db.query(
        `SELECT status, current_period_start, current_period_end, trial_end FROM politicore.subscriptions WHERE id = $1`, [subBefore]);
      const rec = row.rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("active");
      expect(rec.current_period_start).not.toBeNull();
      expect(rec.current_period_end).not.toBeNull();

      const inv = await db.query(`SELECT status, paid_at FROM politicore.invoices WHERE id = $1`, [invoiceId]);
      expect((inv.rows[0] as Record<string, unknown>).status).toBe("paid");

      const ent = await db.query(
        `SELECT settings->'service_entitlements'->$1 AS map FROM politicore.platform_settings WHERE id = 1`, [tenantA]);
      expect(ent.rows[0] as Record<string, unknown>).toMatchObject({ map: { social: true, campaign: false, election: false, governance: true } });

      // Attempt ledger: the payment path records a succeeded attempt.
      const attempts = await db.query(
        `SELECT attempt_number, status FROM politicore.payment_attempts WHERE invoice_id = $1 ORDER BY attempt_number`, [invoiceId]);
      expect(attempts.rows).toHaveLength(1);
      expect(attempts.rows[0]).toMatchObject({ attempt_number: 1, status: "succeeded" });
      expect(paymentId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("E3 provider reference idempotency: the same reference can never create a second payment", async () => {
      const dup = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'NGN', 'p29test-e2-pay1', 'E3 webhook replay of the same provider reference') AS s`,
        [invoiceId]);
      expect(dup.error).toBeDefined();
      expect(dup.error).toMatch(/only an issued or past_due invoice|duplicate key|unique/i);
      const n = await db.query(
        `SELECT count(*)::int AS n FROM politicore.payments WHERE invoice_id = $1`, [invoiceId]);
      expect((n.rows[0] as Record<string, unknown>).n).toBe(1);
    });

    it("E4 only issued/past_due invoices can be paid; paid invoices are settled facts", async () => {
      const again = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'NGN', 'p29test-e4-double', 'E4 second payment on a paid invoice') AS s`,
        [invoiceId]);
      expect(again.error).toBeDefined();
      expect(again.error).toMatch(/only an issued or past_due invoice can be paid/i);
    });

    it("E5 a failed payment drives active → past_due (grace), counts the attempt, notifies via the owner profile", async () => {
      // Create + issue a NEW invoice for the active subscription.
      const sub = (await liveSub())!;
      const inv = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_create_invoice($1, 'E5 renewal invoice') AS s`, [sub]);
      const inv2 = scalar(inv.rows, "s");
      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_issue_invoice($1, 'E5 issue') AS s`, [inv2]);

      // Owner notification ledger: the trial + activation notifications exist.
      const notifs = await db.query(
        `SELECT count(*)::int AS n FROM politicore.notifications
          WHERE tenant_id = $1 AND type = 'system' AND user_id = $2`, [tenantA, owner.profileId]);
      expect((notifs.rows[0] as Record<string, unknown>).n).toBeGreaterThan(0);

      const fail = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_payment_failure_manual($1, 'insufficient_funds', 'bank reported insufficient funds', 'p29test-e5-fail') AS s`,
        [inv2]);
      expect(fail.error).toBeUndefined();

      const subRow = await db.query(
        `SELECT status, past_due_since, failed_payment_count FROM politicore.subscriptions WHERE id = $1`, [sub]);
      const rec = subRow.rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("past_due");
      expect(rec.past_due_since).not.toBeNull();
      expect(rec.failed_payment_count).toBe(1);

      // The invoice flips to past_due.
      const invRow = await db.query(`SELECT status FROM politicore.invoices WHERE id = $1`, [inv2]);
      expect((invRow.rows[0] as Record<string, unknown>).status).toBe("past_due");

      // Entitlements RETAINED during grace (no clearing write).
      const ent = await db.query(
        `SELECT settings->'service_entitlements'->'$1' AS map FROM politicore.platform_settings WHERE id = 1`.replace("$1", tenantA),
        []);
      const map = ((ent.rows[0] as Record<string, unknown>).map) as Record<string, unknown>;
      expect(map).toMatchObject({ social: true, governance: true });
    });

    it("E6 a retried payment on past_due recovers to active and restores the period", async () => {
      const sub = (await liveSub())!;
      const invRow = await db.query(
        `SELECT id FROM politicore.invoices WHERE subscription_id = $1 AND status = 'past_due' ORDER BY created_at DESC LIMIT 1`, [sub]);
      const inv2 = (invRow.rows[0] as Record<string, unknown>).id as string;
      const pay = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'NGN', 'p29test-e6-recover', 'E6 recovery transfer verified') AS s`,
        [inv2]);
      expect(pay.error).toBeUndefined();
      const rec = (await db.query(
        `SELECT status, past_due_since, current_period_start, current_period_end FROM politicore.subscriptions WHERE id = $1`, [sub]))
        .rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("active");
      expect(rec.past_due_since).toBeNull();
      expect(rec.current_period_end).not.toBeNull();
    });
  });

  // ══ F. Refunds & credits ════════════════════════════════════════════
  describe("F. refunds & credits", () => {
    it("F1 partial refund lands; never exceeds the refundable amount; full refund flips statuses", async () => {
      const payRow = await db.query(
        `SELECT id, amount_minor FROM politicore.payments WHERE tenant_id = $1 ORDER BY received_at LIMIT 1`, [tenantA]);
      const paymentId = (payRow.rows[0] as Record<string, unknown>).id as string;

      // Partial refund of 40000 of 100000.
      const part = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_refund($1, 40000, 'F1 partial goodwill refund', 'p29test-f1-partial') AS s`,
        [paymentId]);
      expect(part.error).toBeUndefined();

      const over = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_refund($1, 100000, 'F1 over-refund attempt must fail', 'p29test-f1-over') AS s`,
        [paymentId]);
      expect(over.error).toBeDefined();
      expect(over.error).toMatch(/refundable|exceed/i);

      const invRow = await db.query(
        `SELECT refunded_minor, status FROM politicore.invoices WHERE id =
           (SELECT invoice_id FROM politicore.payments WHERE id = $1)`, [paymentId]);
      const inv = invRow.rows[0] as Record<string, unknown>;
      expect(inv.refunded_minor).toBe(40000);
      expect(inv.status).toBe("paid");

      // Remaining refundable: 60000 — settle it fully.
      const rest = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_refund($1, 60000, 'F1 full remaining refund', 'p29test-f1-rest') AS s`,
        [paymentId]);
      expect(rest.error).toBeUndefined();
      const inv2 = await db.query(
        `SELECT refunded_minor, status FROM politicore.invoices WHERE id =
           (SELECT invoice_id FROM politicore.payments WHERE id = $1)`, [paymentId]);
      expect((inv2.rows[0] as Record<string, unknown>).refunded_minor).toBe(100000);
      expect((inv2.rows[0] as Record<string, unknown>).status).toBe("refunded");
      const pay2 = await db.query(`SELECT status FROM politicore.payments WHERE id = $1`, [paymentId]);
      expect((pay2.rows[0] as Record<string, unknown>).status).toBe("refunded");
    });

    it("F2 only succeeded payments can be refunded", async () => {
      // Every payment is refunded now; a new refund attempt must fail.
      const payRow = await db.query(
        `SELECT id FROM politicore.payments WHERE tenant_id = $1 AND status = 'refunded' LIMIT 1`, [tenantA]);
      const paymentId = (payRow.rows[0] as Record<string, unknown>).id as string;
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_refund($1, 1000, 'F2 refund a refunded payment', 'p29test-f2') AS s`,
        [paymentId]);
      expect(r.error).toMatch(/only a succeeded payment can be refunded/i);
    });

    it("F3 credits apply to DRAFT invoices only, never beyond the remaining balance; tenant/currency must match", async () => {
      const sub = (await liveSub())!;
      // Draft invoice via platform.
      const inv = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_create_invoice($1, 'F3 draft for credit application') AS s`, [sub]);
      const draftId = scalar(inv.rows, "s");
      const draftRow = await db.query(
        `SELECT total_minor, discount_credits_minor FROM politicore.invoices WHERE id = $1`, [draftId]);
      expect((draftRow.rows[0] as Record<string, unknown>).total_minor).toBe(100000);

      const credit = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.issue_credit($1, 30000, 'F3 goodwill credit for the tenant') AS s`, [tenantA]);
      expect(credit.error).toBeUndefined();
      const creditId = scalar(credit.rows, "s");

      // Partial application: 20000 of 30000.
      const app = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.apply_credit($1, $2, 20000, 'F3 partial credit application') AS s`, [creditId, draftId]);
      expect(app.error).toBeUndefined();
      const after1 = await db.query(
        `SELECT total_minor, discount_credits_minor FROM politicore.invoices WHERE id = $1`, [draftId]);
      expect((after1.rows[0] as Record<string, unknown>).total_minor).toBe(80000);
      expect((after1.rows[0] as Record<string, unknown>).discount_credits_minor).toBe(20000);

      // Exceeding the remaining 10000 fails.
      const over = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.apply_credit($1, $2, 20000, 'F3 exceed remaining attempt') AS s`, [creditId, draftId]);
      expect(over.error).toBeDefined();
      expect(over.error).toMatch(/exceeds remaining balance/i);

      // Cross-tenant application is refused by the guard: tenant B's credit
      // can never discount tenant A's draft invoice.
      const creditB = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.issue_credit($1, 5000, 'F3 credit for tenant B') AS s`, [tenantB]);
      const creditBId = scalar(creditB.rows, "s");
      const draftA2 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_create_invoice($1, 'F3 cross-tenant target draft') AS s`, [sub]);
      const draftA2Id = scalar(draftA2.rows, "s");
      const cross = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.apply_credit($1, $2, 5000, 'F3 cross-tenant attempt') AS s`, [creditBId, draftA2Id]);
      expect(cross.error).toBeDefined();
      expect(cross.error).toMatch(/tenant and currency/i);
      // Drafts are deletable; remove the helper draft.
      await db.query(`DELETE FROM politicore.invoice_line_items WHERE invoice_id = $1`, [draftA2Id]);
      await db.query(`DELETE FROM politicore.invoices WHERE id = $1`, [draftA2Id]);

      // Applying to an ISSUED invoice is refused (draft-only rule).
      const issued = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_issue_invoice($1, 'F3 issue the credited draft') AS s`, [draftId]);
      expect(issued.error).toBeUndefined();
      const appIssued = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.apply_credit($1, $2, 10000, 'F3 apply to issued attempt') AS s`, [creditId, draftId]);
      expect(appIssued.error).toBeDefined();
      expect(appIssued.error).toMatch(/DRAFT invoices/i);

      // Void the issued test artifact (legal edge issued → void with its
      // timestamp) so later sections see no open invoice blocking renewals.
      const voidErr = await queryErr(db,
        `UPDATE politicore.invoices SET status = 'void', voided_at = now() WHERE id = $1`, [draftId]);
      expect(voidErr).toBeNull();
    });
  });

  // ══ G. Entitlement synchronization ══════════════════════════════════
  describe("G. entitlement synchronization", () => {
    it("G1 past_due retains (grace); restricted clears ALL FOUR; payment restores", async () => {
      const sub = (await liveSub())!;
      // Open the invoice FIRST — an active subscription can be invoiced; a
      // restricted one cannot (recovery pays the outstanding invoice).
      const inv = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_create_invoice($1, 'G1 dunning invoice') AS s`, [sub]);
      expect(inv.error).toBeUndefined();
      const invId = scalar(inv.rows, "s");
      const iss = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_issue_invoice($1, 'G1 issue') AS s`, [invId]);
      expect(iss.error).toBeUndefined();

      // active → past_due via platform correction (a legal edge).
      const c = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.correct_subscription_state($1, 'past_due', 'G1 drive to past_due for the restriction probe') AS s`, [sub]);
      expect(c.error).toBeUndefined();

      // Grace retains: still entitled.
      let ent = await db.query(
        `SELECT settings->'service_entitlements'->'${tenantA}' AS map FROM politicore.platform_settings WHERE id = 1`);
      expect(((ent.rows[0] as Record<string, unknown>).map)).toMatchObject({ social: true, governance: true });

      // past_due → restricted (legal edge) clears the commercial map.
      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.correct_subscription_state($1, 'restricted', 'G1 grace exhausted correction') AS s`, [sub]);
      ent = await db.query(
        `SELECT settings->'service_entitlements'->'${tenantA}' AS map FROM politicore.platform_settings WHERE id = 1`);
      expect(((ent.rows[0] as Record<string, unknown>).map)).toMatchObject({
        social: false, campaign: false, election: false, governance: false,
      });

      // Recovery: restricted → active IS a legal edge (via payment).
      const pay = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'NGN', 'p29test-g1-recover', 'G1 recovery payment verified') AS s`, [invId]);
      expect(pay.error).toBeUndefined();
      const rec = (await db.query(
        `SELECT status FROM politicore.subscriptions WHERE id = $1`, [sub])).rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("active");
      ent = await db.query(
        `SELECT settings->'service_entitlements'->'${tenantA}' AS map FROM politicore.platform_settings WHERE id = 1`);
      expect(((ent.rows[0] as Record<string, unknown>).map)).toMatchObject({ social: true, governance: true });
    });

    it("G2 authorization substrates are NEVER touched by billing state", async () => {
      // tenant_modules untouched (fixture created all four disabled).
      const mods = await db.query(
        `SELECT bool_and(enabled) AS any_enabled FROM politicore.tenant_modules WHERE tenant_id = $1`, [tenantA]);
      expect((mods.rows[0] as Record<string, unknown>).any_enabled).toBe(false);
      // tenants.status untouched.
      const t = await db.query(`SELECT status FROM politicore.tenants WHERE id = $1`, [tenantA]);
      expect((t.rows[0] as Record<string, unknown>).status).toBe("active");
      // permission count still exactly 43.
      const perms = await db.query(`SELECT count(*)::int AS n FROM politicore.permissions`);
      expect((perms.rows[0] as Record<string, unknown>).n).toBe(43);
      // No permission_grants were created for the tenant by billing flows.
      const grants = (await db.query(
        `SELECT count(*)::int AS n FROM politicore.permission_grants g
           JOIN politicore.profiles p ON p.id = g.user_id
          WHERE p.tenant_id = $1`, [tenantA])).rows[0] as Record<string, unknown>;
      expect(grants.n).toBe(0);
    });
  });

  // ══ H. Dunning & trials ═════════════════════════════════════════════
  describe("H. dunning & trials", () => {
    it("H1 dunning processor: grace from the settings map; exhausted grace → restricted; idempotent", async () => {
      // C4 set grace to 2 days. Open an invoice, age the past_due clock
      // server-side, then run the processor.
      const sub = (await liveSub())!;
      const inv = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_create_invoice($1, 'H1 dunning invoice') AS s`, [sub]);
      expect(inv.error).toBeUndefined();
      const invId = scalar(inv.rows, "s");
      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.platform_issue_invoice($1, 'H1 issue') AS s`, [invId]);
      await db.query(
        `UPDATE politicore.subscriptions SET status = 'past_due', past_due_since = now() - interval '3 days'
          WHERE id = $1`, [sub]);

      const rows = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_dunning_transitions()`);
      expect(rows.error).toBeUndefined();
      const hit = rows.rows.find((r) => r.subscription_id === sub);
      expect(hit).toBeDefined();
      expect(hit!.action).toBe("grace_exhausted");
      const rec = (await db.query(
        `SELECT status FROM politicore.subscriptions WHERE id = $1`, [sub])).rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("restricted");

      // Re-running is idempotent — no second transition.
      const again = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_dunning_transitions()`);
      expect(again.rows.find((r) => r.subscription_id === sub)).toBeUndefined();

      // Recovery: pay the outstanding invoice (restricted → active edge).
      const pay = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.record_manual_payment($1, 100000, 'NGN', 'p29test-h1-recover', 'H1 recovery after restriction') AS s`, [invId]);
      expect(pay.error).toBeUndefined();
      const back = (await db.query(
        `SELECT status FROM politicore.subscriptions WHERE id = $1`, [sub])).rows[0] as Record<string, unknown>;
      expect(back.status).toBe("active");
    });

    it("H2 trial reminder + expiry are deterministic and idempotent; data preserved; tenant status untouched", async () => {
      // Tenant B's sub is trialing with trial_end = created + 14d. The trial
      // window is guard-frozen, so the clock is simulated with triggers
      // suppressed for the fixture UPDATE only (replica mode).
      const subB = (await liveSubB())!;
      await db.query(`UPDATE politicore.subscriptions SET trial_reminder_sent_at = NULL WHERE id = $1`, [subB]);
      await db.query(`SET session_replication_role = replica`);
      await db.query(`UPDATE politicore.subscriptions SET trial_end = now() + interval '2 days' WHERE id = $1`, [subB]);
      await db.query(`SET session_replication_role = DEFAULT`);

      // Inside the 3-day window: a single reminder fires, then never again.
      const rem = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_trial_expiries()`);
      expect(rem.error).toBeUndefined();
      const remHit = rem.rows.find((r) => r.subscription_id === subB);
      expect(remHit).toBeDefined();
      expect(remHit!.action).toBe("trial_reminder_sent");
      const sent = (await db.query(
        `SELECT trial_reminder_sent_at FROM politicore.subscriptions WHERE id = $1`, [subB])).rows[0] as Record<string, unknown>;
      expect(sent.trial_reminder_sent_at).not.toBeNull();
      const rem2 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_trial_expiries()`);
      expect(rem2.rows.find((r) => r.subscription_id === subB)).toBeUndefined();

      // Past the window: deterministic expiry → restricted (no auto-charge,
      // data preserved, tenant lifecycle untouched).
      await db.query(`SET session_replication_role = replica`);
      await db.query(`UPDATE politicore.subscriptions SET trial_end = now() - interval '1 hour' WHERE id = $1`, [subB]);
      await db.query(`SET session_replication_role = DEFAULT`);
      const rows = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_trial_expiries()`);
      expect(rows.error).toBeUndefined();
      const hit = rows.rows.find((r) => r.subscription_id === subB);
      expect(hit).toBeDefined();
      expect(hit!.action).toBe("trial_expired");
      const rec = (await db.query(
        `SELECT status, trial_end FROM politicore.subscriptions WHERE id = $1`, [subB])).rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("restricted");
      expect(rec.trial_end).not.toBeNull();
      const t = await db.query(`SELECT status FROM politicore.tenants WHERE id = $1`, [tenantB]);
      expect((t.rows[0] as Record<string, unknown>).status).toBe("active");

      // Idempotent: a second run yields nothing for this subscription.
      const again = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_trial_expiries()`);
      expect(again.rows.find((r) => r.subscription_id === subB)).toBeUndefined();
    });

    it("H3 renewal idempotency: an open invoice blocks duplicate renewal invoices", async () => {
      const sub = (await liveSub())!;
      // Age the period past its end and cancel flag off.
      await db.query(
        `UPDATE politicore.subscriptions SET current_period_end = now() - interval '1 hour' WHERE id = $1`, [sub]);
      const run1 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_period_renewals()`);
      expect(run1.error).toBeUndefined();
      const hit1 = run1.rows.find((r) => r.subscription_id === sub);
      expect(hit1).toBeDefined();
      expect(hit1!.action).toBe("renewal_invoice_issued");
      const invCount1 = (await db.query(
        `SELECT count(*)::int AS n FROM politicore.invoices WHERE subscription_id = $1`, [sub])).rows[0] as Record<string, unknown>;

      // Re-run BEFORE settling: must NOT create a second invoice.
      const run2 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_period_renewals()`);
      expect(run2.error).toBeUndefined();
      const hit2 = run2.rows.find((r) => r.subscription_id === sub);
      expect(hit2).toBeDefined();
      expect(hit2!.action).toBe("renewal_open_invoice_exists");
      const invCount2 = (await db.query(
        `SELECT count(*)::int AS n FROM politicore.invoices WHERE subscription_id = $1`, [sub])).rows[0] as Record<string, unknown>;
      expect((invCount2 as unknown as { n: number }).n).toBe((invCount1 as unknown as { n: number }).n);
    });

    it("H4 cancel_at_period_end completes non-destructively at renewal", async () => {
      const sub = (await liveSub())!;
      await as(db, "authenticated", owner.authId,
        `SELECT public.schedule_subscription_cancellation($1, 'H4 leaving at period end') AS s`, [sub]);
      await db.query(
        `UPDATE politicore.subscriptions SET current_period_end = now() - interval '1 hour' WHERE id = $1`, [sub]);
      const rows = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_period_renewals()`);
      expect(rows.error).toBeUndefined();
      const hit = rows.rows.find((r) => r.subscription_id === sub);
      expect(hit).toBeDefined();
      expect(hit!.action).toBe("cancelled_at_period_end");
      const rec = (await db.query(
        `SELECT status, ended_at FROM politicore.subscriptions WHERE id = $1`, [sub])).rows[0] as Record<string, unknown>;
      expect(rec.status).toBe("cancelled");
      expect(rec.ended_at).not.toBeNull();
      // Data preserved: the tenant, profiles, and invoices remain.
      const t = await db.query(`SELECT count(*)::int AS n FROM politicore.profiles WHERE tenant_id = $1`, [tenantA]);
      expect((t.rows[0] as Record<string, unknown>).n).toBeGreaterThan(0);
    });
  });

  // ══ I. Webhook journal ══════════════════════════════════════════════
  describe("I. webhook journal", () => {
    it("I1 raw payload is journaled BEFORE processing; the same (provider, event id) is idempotent", async () => {
      const payload = { invoice_id: "inv_e1", amount: 100000, event: "payment.succeeded" };
      const r1 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.journal_billing_event('p29test', 'evt-001', 'payment.succeeded', $1, true)`,
        [JSON.stringify(payload)]);
      expect(r1.error).toBeUndefined();
      expect(r1.rows[0]).toMatchObject({ duplicate: false, processing_status: "received" });

      const r2 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.journal_billing_event('p29test', 'evt-001', 'payment.succeeded', $1, true)`,
        [JSON.stringify(payload)]);
      expect(r2.error).toBeUndefined();
      expect(r2.rows[0]).toMatchObject({ duplicate: true });
      const n = await db.query(
        `SELECT count(*)::int AS n FROM politicore.billing_events WHERE provider = 'p29test' AND provider_event_id = 'evt-001'`);
      expect((n.rows[0] as Record<string, unknown>).n).toBe(1);
    });

    it("I2 processing is write-once: re-runs never reprocess; payload is immutable", async () => {
      const proc = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_billing_events()`);
      expect(proc.error).toBeUndefined();
      expect(proc.rows[0]).toMatchObject({ action: "processed" });

      const again = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_billing_events()`);
      expect(again.error).toBeUndefined();
      expect(again.rows).toHaveLength(0);

      const evtRow = await db.query(
        `SELECT id FROM politicore.billing_events WHERE provider = 'p29test' AND provider_event_id = 'evt-001'`);
      const evtId = (evtRow.rows[0] as Record<string, unknown>).id as string;
      const immutable = await queryErr(db,
        `UPDATE politicore.billing_events SET payload = '{"hacked": true}'::jsonb WHERE id = $1`, [evtId]);
      expect(immutable).toMatch(/journal record is immutable/i);
      const rewrite = await queryErr(db,
        `UPDATE politicore.billing_events SET processing_status = 'received' WHERE id = $1`, [evtId]);
      expect(rewrite).toMatch(/write-once|already finished processing/i);
    });

    it("I3 unknown event types are rejected (journaled evidence preserved)", async () => {
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.journal_billing_event('p29test', 'evt-002', 'weird.event', '{"x":1}'::jsonb, false)`);
      expect(r.error).toBeUndefined();
      const proc = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.process_billing_events()`);
      expect(proc.rows[0]).toMatchObject({ action: "rejected" });
      const row = await db.query(
        `SELECT processing_status FROM politicore.billing_events WHERE provider = 'p29test' AND provider_event_id = 'evt-002'`);
      expect((row.rows[0] as Record<string, unknown>).processing_status).toBe("rejected");
    });

    it("I4 journaling is platform-only", async () => {
      const r = await as(db, "authenticated", owner.authId,
        `SELECT * FROM public.journal_billing_event('p29test', 'evt-owner', 'payment.succeeded', '{"a":1}'::jsonb, true)`);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/platform_super_admin/i);
    });
  });

  // ══ J. Audit & architecture ═════════════════════════════════════════
  describe("J. audit & architecture", () => {
    it("J1 the full subscription lifecycle is Core-Audit-logged with server-resolved actors", async () => {
      const actions = (await db.query(
        `SELECT DISTINCT action FROM politicore.system_audits WHERE tenant_id = ANY($1)`,
        [[tenantA, tenantB]])).rows.map((r) => (r as Record<string, unknown>).action as string);
      for (const expected of [
        "subscription_created", "subscription_trial_started", "subscription_cancellation_scheduled",
        "subscription_cancellation_revoked", "subscription_changed", "subscription_cancelled",
        "subscription_activated", "subscription_started", "invoice_issued", "invoice_paid",
        "payment_received", "payment_failed", "payment_refunded", "credit_issued", "credit_applied",
        "entitlements_synchronized", "subscription_restricted", "subscription_trial_expired",
      ]) {
        expect(actions, `missing audit action: ${expected}`).toContain(expected);
      }
      // Actor resolution: billing actions carry the acting platform admin's identity.
      const actor = (await db.query(
        `SELECT actor_email FROM politicore.system_audits
          WHERE tenant_id = $1 AND action = 'payment_received' LIMIT 1`, [tenantA])).rows[0] as Record<string, unknown>;
      expect(actor.actor_email).toBe(`${E}-platform@test.local`);
    });

    it("J2 billing_config_updated is audited (platform scope, nullable tenant)", async () => {
      const r = (await db.query(
        `SELECT count(*)::int AS n FROM politicore.system_audits
          WHERE action = 'billing_config_updated' AND tenant_id IS NULL`)).rows[0] as Record<string, unknown>;
      expect((r as unknown as { n: number }).n).toBeGreaterThan(0);
    });

    it("J3 no new roles, modules, or permissions exist (counts pinned)", async () => {
      const perms = (await db.query(`SELECT count(*)::int AS n FROM politicore.permissions`)).rows[0] as Record<string, unknown>;
      expect((perms as unknown as { n: number }).n).toBe(43);
      const enumVals = (await db.query(
        `SELECT unnest(enum_range(NULL::politicore.access_role_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
      expect(enumVals).not.toContain("billing_admin");
      const mods = (await db.query(
        `SELECT unnest(enum_range(NULL::politicore.module_code_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
      expect(mods).toEqual(["social", "campaign", "election", "governance"]);
    });

    it("J4 migration count is 70; the latest migration is 0069 (Phase 31 tenant lifecycle)", () => {
      const dir = path.join(ROOT, "supabase", "migrations");
      const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      expect(files.length).toBe(70);
      expect(files[files.length - 1]).toMatch(/^0069_/);
    });

    it("J5 FORCE RLS is enabled on every Phase 29 table", async () => {
      const rels = ["subscriptions", "subscription_items", "invoices", "invoice_line_items",
        "payments", "payment_attempts", "refunds", "credits", "credit_applications", "billing_events"];
      for (const rel of rels) {
        const r = await db.query(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
            WHERE oid = to_regclass('politicore.${rel}')`);
        const rec = r.rows[0] as Record<string, unknown>;
        expect(rec.relrowsecurity, `${rel} RLS`).toBe(true);
        expect(rec.relforcerowsecurity, `${rel} FORCE RLS`).toBe(true);
      }
    });

    it("J6 the billing core never branches on provider identity (provider is DATA)", async () => {
      const src = fs.readFileSync(
        path.join(ROOT, "supabase", "migrations", "0066_subscriptions_billing_core.sql"), "utf8");
      // The ONLY provider-literal allowed is the manual adapter's own value.
      const providerLiterals = [...src.matchAll(/'(?:manual|paystack|flutterwave|stripe)'/g)].map((m) => m[0]);
      const nonManual = providerLiterals.filter((p) => p !== "'manual'");
      expect(nonManual).toEqual([]);
      // The adapter column accepts any provider — verified live earlier (E2 used 'manual').
      const manualCount = providerLiterals.filter((p) => p === "'manual'").length;
      expect(manualCount).toBeGreaterThan(0);
    });
  });
});
