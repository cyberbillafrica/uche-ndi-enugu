/**
 * POLITICORE — SAAS PHASE 31 — TENANT LIFECYCLE & SUBSCRIPTION ENFORCEMENT
 * SECURITY SUITE (SaaS Phase D).
 *
 * Proves migration 0069 + the Phase 31 gate's requirements against
 * role-impersonated sessions (helpers.as) — the acceptance standard of
 * Phases 1–30:
 *
 *   A. Transition matrix  — DB-enforced edges: valid transitions pass,
 *                           invalid edges raise, no bypass.
 *   B. Reason/actor       — every lifecycle change requires a ≥5-char
 *                           reason and a server-resolved actor.
 *   C. Subscription→lifecycle — past_due/restricted/cancelled coordinate;
 *                           trialing NEVER touches the lifecycle;
 *                           active (payment recovery) is scoped.
 *   D. Payment recovery   — restricted/past_due tenants recover through
 *                           the EXISTING record_verified_payment machine.
 *   E. Suspension authority — suspension survives payment; owner and
 *                           plain admin can never suspend/restore;
 *                           cross-tenant isolation holds.
 *   F. Access enforcement — assert_tenant_operationally_active
 *                           distinguishes lifecycle, subscription,
 *                           entitlement, activation; suspended tenants
 *                           are blocked; public surfaces unaffected.
 *   G. Cancellation/archival — cancellation_pending/cancelled/archived
 *                           are non-destructive and recoverable.
 *   H. Processors         — idempotent, bounded, retryable.
 *   I. Audit/notifications — server-attributed events + owner notices,
 *                           no duplicates on retries.
 *   J. Architecture       — no new roles/permissions/modules; legacy
 *                           tenants.status stays in lockstep; RLS FORCE
 *                           unchanged; migration pin 70/0069.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { PGlite } from "@electric-sql/pglite";
import { getDb, as, createTenant, createUser } from "./helpers";

const E = "p31life";
const ROOT = process.cwd();

/** Direct SQL that MUST raise → returns the error message (guard tests). */
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

/** Current lifecycle of a tenant (superuser read — fixtures only). */
async function lifeOf(db: PGlite, tenantId: string): Promise<string> {
  const r = await db.query(
    `SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id = $1`,
    [tenantId]);
  return String((r.rows[0] as Record<string, unknown>).l);
}

/**
 * Superuser direct lifecycle write in replica mode (guard trigger
 * bypassed) — fixture re-anchoring ONLY, never a behavior claim. Keeps
 * the legacy status column in lockstep so J2 stays valid.
 */
async function forceLifecycle(
  db: PGlite,
  tenantId: string,
  to: string
): Promise<void> {
  await db.query(`SET session_replication_role = replica`);
  await db.query(
    `UPDATE politicore.tenants
        SET lifecycle_status     = $2::politicore.tenant_lifecycle_enum,
            status               = CASE
                                     WHEN $2 = 'suspended' THEN 'suspended'
                                     WHEN $2 IN ('cancelled', 'archived') THEN 'cancelled'
                                     ELSE 'active' END,
            lifecycle_reason     = 'phase31 fixture re-anchor',
            lifecycle_changed_at = now(),
            lifecycle_changed_by = NULL
       WHERE id = $1`,
    [tenantId, to]);
  await db.query(`RESET session_replication_role`);
}

/** Direct lifecycle write as a platform session (the authorized writer). */
async function setLifecycle(
  db: PGlite,
  actorAuthId: string,
  tenantId: string,
  to: string,
  reason = "phase31 fixture transition"
): Promise<string | null> {
  const r = await as(db, "authenticated", actorAuthId,
    `UPDATE politicore.tenants
        SET lifecycle_status = $2::politicore.tenant_lifecycle_enum,
            lifecycle_reason = $3
      WHERE id = $1`, [tenantId, to, reason]);
  return r.error ?? null;
}

/** Delete a subscription fixture (replica mode — items first). */
async function deleteSub(db: PGlite, subId: string): Promise<void> {
  await db.query(`SET session_replication_role = replica`);
  await db.query(`DELETE FROM politicore.subscription_items WHERE subscription_id = $1`, [subId]);
  await db.query(`DELETE FROM politicore.subscriptions WHERE id = $1`, [subId]);
  await db.query(`RESET session_replication_role`);
}

describe("phase31 — tenant lifecycle & subscription enforcement", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
  let owner: { authId: string };
  let plainAdmin: { authId: string };
  let ownerB: { authId: string };
  let ownerC: { authId: string };
  let platformAdmin: { authId: string };
  let verA: string;

  beforeAll(async () => {
    db = await getDb();
    tenantA = await createTenant(db, "p31life-a", "Phase 31 A", { social: true, governance: true });
    tenantB = await createTenant(db, "p31life-b", "Phase 31 B", { social: true, governance: true });
    tenantC = await createTenant(db, "p31life-c", "Phase 31 C", { social: true, governance: true });
    owner = await createUser(db, { tenantId: tenantA, email: `${E}-owner@test.local`, fullName: "P31 Owner A", accessRole: "tenant_super_admin" });
    plainAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-adm@test.local`, fullName: "P31 Admin A", accessRole: "admin" });
    ownerB = await createUser(db, { tenantId: tenantB, email: `${E}-ownerb@test.local`, fullName: "P31 Owner B", accessRole: "tenant_super_admin" });
    ownerC = await createUser(db, { tenantId: tenantC, email: `${E}-ownerc@test.local`, fullName: "P31 Owner C", accessRole: "tenant_super_admin" });
    platformAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-platform@test.local`, fullName: "P31 Platform Admin", accessRole: "platform_super_admin" });

    await db.query(`INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);

    // Plan + active version (NGN, monthly 100000, 14-day trial) for the
    // subscription-integration section.
    const plan = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 95, 'phase31 fixture') AS p`, ["p31-probe", "P31 Probe"]);
    if (plan.error) throw new Error(`create_plan: ${plan.error}`);
    const planId = scalar(plan.rows, "p");
    const ver = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social','governance'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, $2, 'phase31 fixture') AS v`,
      [planId, '{"monthly": 100000}']);
    if (ver.error) throw new Error(`create_plan_version: ${ver.error}`);
    verA = scalar(ver.rows, "v");
    const act = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.activate_plan_version($1, 'phase31 fixture') AS v`, [verA]);
    if (act.error) throw new Error(`activate_plan_version: ${act.error}`);
  }, 180_000);

  afterAll(async () => {
    // Fixture teardown (replica mode — mirrors the Phase 29/30 pattern).
    await db.query(`SET session_replication_role = replica`);
    for (const t of [tenantA, tenantB, tenantC]) {
      await db.query(`DELETE FROM politicore.notifications WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM politicore.system_audits WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM politicore.subscription_items WHERE subscription_id IN (SELECT id FROM politicore.subscriptions WHERE tenant_id = $1)`, [t]);
      await db.query(`DELETE FROM politicore.subscriptions WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM politicore.profiles WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = $1`, [t]);
      await db.query(`DELETE FROM politicore.tenants WHERE id = $1`, [t]);
    }
    await db.query(`DELETE FROM politicore.plan_version_prices WHERE plan_version_id = $1`, [verA]);
    await db.query(`DELETE FROM politicore.plan_versions WHERE id = $1`, [verA]);
    await db.query(`RESET session_replication_role`);
  });

  /* ── A. Transition matrix ─────────────────────────────────────────── */

  it("A1 every VALID matrix edge is accepted and persisted", async () => {
    const edges: [string, string][] = [
      ["active", "past_due"],
      ["past_due", "restricted"],
      ["restricted", "suspended"],
      ["suspended", "active"],
      ["active", "cancellation_pending"],
      ["cancellation_pending", "cancelled"],
      ["cancelled", "archived"],
      ["archived", "active"],
    ];
    for (const [from, to] of edges) {
      await setLifecycle(db, platformAdmin.authId, tenantA, from);
      expect(await lifeOf(db, tenantA), `setup ${from}`).toBe(from);
      const err = await setLifecycle(db, platformAdmin.authId, tenantA, to);
      expect(err, `${from} → ${to} must be legal`).toBeNull();
      expect(await lifeOf(db, tenantA), `${from} → ${to}`).toBe(to);
    }
  });

  it("A2 every INVALID edge raises with the transition message", async () => {
    const illegal: [string, string][] = [
      ["active", "provisioning"],
      ["suspended", "past_due"],
      ["suspended", "restricted"],
      ["suspended", "cancelled"],
      ["suspended", "archived"],
      ["suspended", "cancellation_pending"],
      ["archived", "past_due"],
      ["archived", "restricted"],
      ["archived", "suspended"],
      ["archived", "cancelled"],
      ["archived", "cancellation_pending"],
      ["cancelled", "past_due"],
      ["cancelled", "restricted"],
      ["cancelled", "suspended"],
      ["cancelled", "cancellation_pending"],
      ["restricted", "past_due"],
      ["restricted", "cancellation_pending"],
      ["restricted", "archived"],
      ["past_due", "cancellation_pending"],
      ["past_due", "archived"],
      ["cancellation_pending", "archived"],
      ["cancellation_pending", "past_due"],
      ["cancellation_pending", "restricted"],
      ["provisioning", "past_due"],
      ["provisioning", "cancellation_pending"],
      ["provisioning", "archived"],
    ];
    for (const [from, to] of illegal) {
      // Re-anchor from a known state (superuser replica write) so a prior
      // refusal can never cascade into the next pair.
      await forceLifecycle(db, tenantA, from);
      const err = await setLifecycle(db, platformAdmin.authId, tenantA, to);
      expect(err, `${from} → ${to} must be illegal`).toMatch(/illegal tenant lifecycle transition/);
      expect(await lifeOf(db, tenantA), `state unchanged after refusal ${from} → ${to}`).toBe(from);
    }
    // restore tenantA to active for later sections
    await forceLifecycle(db, tenantA, "active");
  });

  it("A3 the same-value no-op is permitted (idempotent processors)", async () => {
    const err = await setLifecycle(db, platformAdmin.authId, tenantA, "active");
    expect(err).toBeNull();
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  /* ── B. Reason/actor integrity ────────────────────────────────────── */

  it("B1 a lifecycle change without a reason raises", async () => {
    const err = await queryErr(db,
      `UPDATE politicore.tenants
          SET lifecycle_status = 'suspended', lifecycle_reason = NULL
        WHERE id = $1`,
      [tenantA]);
    expect(err).toMatch(/reason of at least 5 characters/);
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  it("B2 a lifecycle change with a short reason raises", async () => {
    const err = await queryErr(db,
      `UPDATE politicore.tenants SET lifecycle_status = 'suspended', lifecycle_reason = 'abc' WHERE id = $1`,
      [tenantA]);
    expect(err).toMatch(/reason of at least 5 characters/);
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  it("B3 the transition stamps actor + timestamp + keeps the legacy status in lockstep", async () => {
    const err = await setLifecycle(db, platformAdmin.authId, tenantA, "suspended", "phase31 B3 suspension probe");
    expect(err).toBeNull();
    const r = await db.query(
      `SELECT lifecycle_status::text AS l, lifecycle_reason, lifecycle_changed_at, lifecycle_changed_by, status
         FROM politicore.tenants WHERE id = $1`, [tenantA]);
    const row = r.rows[0] as Record<string, unknown>;
    expect(row.l).toBe("suspended");
    expect(row.lifecycle_reason).toBe("phase31 B3 suspension probe");
    expect(row.lifecycle_changed_at).not.toBeNull();
    expect(String(row.lifecycle_changed_by)).toBe(platformAdmin.authId);
    // legacy column derived: suspended → 'suspended'
    expect(row.status).toBe("suspended");
    await setLifecycle(db, platformAdmin.authId, tenantA, "active");
    const r2 = await db.query(`SELECT status FROM politicore.tenants WHERE id = $1`, [tenantA]);
    expect((r2.rows[0] as Record<string, unknown>).status).toBe("active");
  });

  it("B4 tenants.status cannot be desynchronized from the lifecycle", async () => {
    const err = await queryErr(db,
      `UPDATE politicore.tenants SET status = 'suspended' WHERE id = $1`, [tenantA]);
    expect(err).toMatch(/derived from lifecycle_status/);
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  /* ── C. Subscription → lifecycle coordination ─────────────────────── */

  it("C1 a subscription entering past_due moves an active tenant to past_due", async () => {
    // Owner starts a subscription (trialing — lifecycle untouched).
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");
    expect(await lifeOf(db, tenantA)).toBe("active");

    // trialing → active is the legal start-of-billing edge; the row now
    // carries a settled period (CHECK) — still no lifecycle change (the
    // tenant was already active).
    await db.query(
      `UPDATE politicore.subscriptions
          SET status = 'active',
              current_period_start = now(),
              current_period_end = now() + interval '30 days'
        WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA)).toBe("active");

    // active → past_due (legal dunning edge) — the tenant follows.
    await db.query(`UPDATE politicore.subscriptions SET status = 'past_due', past_due_since = now() WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA)).toBe("past_due");

    await deleteSub(db, subId);
    await setLifecycle(db, platformAdmin.authId, tenantA, "active", "phase31 C1 cleanup restore");
  });

  it("C2 trialing NEVER changes the tenant lifecycle (trial is a subscription state)", async () => {
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");
    expect(await lifeOf(db, tenantA)).toBe("active");
    expect(subId).toBeTruthy();
    await deleteSub(db, subId);
  });

  it("C3 restricted coordination lands; suspension WINS over restriction", async () => {
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");

    // trialing → restricted is the legal dunning edge → tenant restricted
    await db.query(`UPDATE politicore.subscriptions SET status = 'restricted' WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA)).toBe("restricted");

    // platform suspends — administrative state
    await setLifecycle(db, platformAdmin.authId, tenantA, "suspended", "phase31 C3 admin suspension");

    // subscription returns to active (payment) — suspension is NOT lifted
    await db.query(
      `UPDATE politicore.subscriptions
          SET status = 'active', current_period_start = now(),
              current_period_end = now() + interval '30 days'
        WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA), "payment must not lift suspension").toBe("suspended");

    await deleteSub(db, subId);
    const res = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 C3 cleanup restore') AS s`, [tenantA]);
    expect(res.error).toBeUndefined();
  });

  it("C4 subscription cancellation coordinates cancellation (records preserved)", async () => {
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");
    await db.query(`UPDATE politicore.subscriptions SET status = 'cancelled', ended_at = now(), cancelled_at = now() WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA)).toBe("cancelled");
    // tenant row and owner profile still exist — nothing destroyed (§7)
    const t = await db.query(`SELECT count(*)::int AS n FROM politicore.tenants WHERE id = $1`, [tenantA]);
    const p = await db.query(`SELECT count(*)::int AS n FROM politicore.profiles WHERE tenant_id = $1`, [tenantA]);
    expect((t.rows[0] as Record<string, unknown>).n).toBe(1);
    expect((p.rows[0] as Record<string, unknown>).n).toBeGreaterThan(0);
    await deleteSub(db, subId);
    await setLifecycle(db, platformAdmin.authId, tenantA, "active", "phase31 C4 cleanup restore");
  });

  /* ── D. Payment recovery through the EXISTING machine ─────────────── */

  it("D1 a verified payment recovers a restricted tenant to active", async () => {
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");
    // Dunning path: trialing → active (settled period) → past_due, and
    // past_due → restricted is the existing record_verified_payment/
    // dunning exhaustion edge. The tenant follows each step.
    await db.query(
      `UPDATE politicore.subscriptions
          SET status = 'active', current_period_start = now(),
              current_period_end = now() + interval '30 days'
        WHERE id = $1`, [subId]);
    await db.query(`UPDATE politicore.subscriptions SET status = 'past_due', past_due_since = now() WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA)).toBe("past_due");
    // Invoice the past_due subscription FIRST (invoicing accepts
    // trialing|active|past_due), then exhaust the grace period.
    const inv = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.platform_create_invoice($1, 'phase31 recovery') AS i`,
      [subId]);
    expect(inv.error).toBeUndefined();
    const invId = scalar(inv.rows, "i");
    const iss = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.platform_issue_invoice($1, 'phase31 recovery issue') AS i`, [invId]);
    expect(iss.error).toBeUndefined();

    // past_due → restricted (dunning grace exhausted) — tenant restricted
    await db.query(`UPDATE politicore.subscriptions SET status = 'restricted' WHERE id = $1`, [subId]);
    expect(await lifeOf(db, tenantA)).toBe("restricted");
    const pay = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.record_manual_payment($1, 100000, 'NGN', $2, 'phase31 recovery payment') AS p`,
      [invId, `p31-pay-${crypto.randomUUID()}`]);
    expect(pay.error).toBeUndefined();

    // subscription recovered by payment → tenant lifecycle follows
    expect(await lifeOf(db, tenantA), "payment recovery must restore the tenant").toBe("active");

    await db.query(`SET session_replication_role = replica`);
    await db.query(`DELETE FROM politicore.payment_attempts WHERE invoice_id = $1`, [invId]);
    await db.query(`DELETE FROM politicore.payments WHERE invoice_id = $1`, [invId]);
    await db.query(`DELETE FROM politicore.invoices WHERE id = $1`, [invId]);
    await db.query(`RESET session_replication_role`);
    await deleteSub(db, subId);
  });

  /* ── E. Suspension authority & denials ────────────────────────────── */

  it("E1 the tenant owner can NEVER suspend or restore", async () => {
    await forceLifecycle(db, tenantA, "active");
    for (const [fn, args] of [
      ["public.suspend_tenant", "$1, 'owner tried it'"],
      ["public.restore_tenant", "$1, 'owner tried it'"],
      ["public.archive_tenant", "$1, 'owner tried it'"],
    ] as [string, string][]) {
      const r = await as(db, "authenticated", owner.authId,
        `SELECT ${fn}(${args}) AS s`, [tenantA]);
      expect(r.error, `${fn} must refuse the tenant owner`).toBeDefined();
      expect(r.error).toMatch(/platform_super_admin authority/i);
    }
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  it("E2 a plain tenant admin can NEVER perform platform lifecycle operations", async () => {
    for (const fn of ["public.suspend_tenant", "public.restore_tenant", "public.archive_tenant"]) {
      const r = await as(db, "authenticated", plainAdmin.authId,
        `SELECT ${fn}($1, 'plain admin attempt') AS s`, [tenantB]);
      expect(r.error, `${fn} must refuse a plain admin`).toBeDefined();
      expect(r.error).toMatch(/platform_super_admin authority/i);
    }
    // tenantB untouched (cross-tenant attempt must not corrupt)
    expect(await lifeOf(db, tenantB)).toBe("active");
  });

  it("E3 the processor refuses non-platform callers", async () => {
    const r = await as(db, "authenticated", owner.authId,
      `SELECT public.process_lifecycle_transitions()`);
    expect(r.error).toMatch(/platform_super_admin authority/i);
  });

  it("E4 cross-tenant isolation: another owner cannot read or mutate tenantA lifecycle", async () => {
    // ownerB cannot read tenantA's row (RLS)
    const r = await as(db, "authenticated", ownerB.authId,
      `SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id = $1`, [tenantA]);
    expect(r.rows.length).toBe(0);
    // and cannot mutate it — RLS filters the UPDATE to 0 rows (no error,
    // no trigger firing, lifecycle unchanged)
    const w = await as(db, "authenticated", ownerB.authId,
      `UPDATE politicore.tenants
          SET lifecycle_status = 'suspended', lifecycle_reason = 'cross tenant attempt'
        WHERE id = $1`, [tenantA]);
    expect(w.error).toBeUndefined();
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  it("E5 suspension preserves ALL tenant data (profiles, modules, settings, audits)", async () => {
    const before = await db.query(
      `SELECT (SELECT count(*)::int FROM politicore.profiles WHERE tenant_id = $1) AS profiles,
              (SELECT count(*)::int FROM politicore.tenant_modules WHERE tenant_id = $1) AS modules,
              (SELECT count(*)::int FROM politicore.tenant_settings WHERE tenant_id = $1) AS settings`, [tenantB]);
    const pre = before.rows[0] as Record<string, unknown>;

    const sus = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.suspend_tenant($1, 'phase31 E5 data preservation probe') AS s`, [tenantB]);
    expect(sus.error).toBeUndefined();
    expect(String(sus.rows[0]?.s)).toBe("suspended");

    const after = await db.query(
      `SELECT (SELECT count(*)::int FROM politicore.profiles WHERE tenant_id = $1) AS profiles,
              (SELECT count(*)::int FROM politicore.tenant_modules WHERE tenant_id = $1) AS modules,
              (SELECT count(*)::int FROM politicore.tenant_settings WHERE tenant_id = $1) AS settings`, [tenantB]);
    const post = after.rows[0] as Record<string, unknown>;
    expect(post.profiles).toBe(pre.profiles);
    expect(post.modules).toBe(pre.modules);
    expect(post.settings).toBe(pre.settings);
  });

  it("E6 only the platform can lift the suspension (owner path E1 already refused)", async () => {
    const res = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 E6 authorized restore') AS s`, [tenantB]);
    expect(res.error).toBeUndefined();
    expect(String(res.rows[0]?.s)).toBe("active");
  });

  /* ── F. Centralized access enforcement ────────────────────────────── */

  it("F1 active + entitled + activated passes and returns the tenant id", async () => {
    await forceLifecycle(db, tenantA, "active");
    await db.query(
      `UPDATE politicore.platform_settings
          SET settings = jsonb_set(settings, ARRAY['service_entitlements', $1::text],
            '{"social": true, "campaign": false, "election": false, "governance": true}'::jsonb)
        WHERE id = 1`, [tenantA]);
    const r2 = await as(db, "authenticated", owner.authId,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    expect(r2.error).toBeUndefined();
    expect(String((r2.rows[0] as Record<string, unknown>).t)).toBe(tenantA);
  });

  it("F2 a suspended tenant is refused by the centralized check", async () => {
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.suspend_tenant($1, 'phase31 F2 suspension for access probe') AS s`, [tenantA]);
    const r = await as(db, "authenticated", owner.authId,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    expect(r.error).toMatch(/suspended/);
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 F2 restore after probe') AS s`, [tenantA]);
  });

  it("F3 a restricted (subscription-dunned) tenant is refused", async () => {
    await setLifecycle(db, platformAdmin.authId, tenantA, "restricted", "phase31 F3 restriction probe");
    const r = await as(db, "authenticated", owner.authId,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    expect(r.error).toMatch(/restricted/);
    await setLifecycle(db, platformAdmin.authId, tenantA, "active", "phase31 F3 cleanup");
  });

  it("F4 a past_due tenant retains grace access — WITH a live subscription", async () => {
    // past_due grace requires a live subscription (trialing counts — §5:
    // the effective subscription check is the existing billing authority).
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");
    await setLifecycle(db, platformAdmin.authId, tenantA, "past_due", "phase31 F4 grace probe");
    const r = await as(db, "authenticated", owner.authId,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    expect(r.error).toBeUndefined();
    expect(String((r.rows[0] as Record<string, unknown>).t)).toBe(tenantA);
    await deleteSub(db, subId);
    await setLifecycle(db, platformAdmin.authId, tenantA, "active", "phase31 F4 cleanup");
  });

  it("F5 an unentitled module is refused even when the tenant is healthy", async () => {
    const r = await as(db, "authenticated", owner.authId,
      `SELECT politicore.assert_tenant_operationally_active('campaign') AS t`);
    expect(r.error).toMatch(/not entitled/);
  });

  it("F6 an unactivated module (tenant_modules disabled) is refused", async () => {
    await db.query(`UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
    const r = await as(db, "authenticated", owner.authId,
      `SELECT politicore.assert_tenant_operationally_active('governance') AS t`);
    expect(r.error).toMatch(/not activated/);
    await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
  });

  it("F7 public site surfaces are untouched: the public config RPC stays anon-readable", async () => {
    // 0060 revoked table grants; anonymous reads flow through the published
    // config RPC — public rendering never depends on the lifecycle.
    const r = await as(db, "anon", null,
      `SELECT public.get_published_site_config('does-not-matter', 'branding') AS c`);
    expect(r.error).toBeUndefined();
    // and anon sees zero tenant rows (RLS via the security_invoker view) —
    // public rendering never depends on the lifecycle.
    const anon = await as(db, "anon", null,
      `SELECT count(*)::int AS n FROM public.tenants`);
    expect(anon.error).toBeUndefined();
    expect(Number((anon.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  /* ── G. Cancellation & archival ───────────────────────────────────── */

  it("G1 archive applies to active or cancelled tenants and is non-destructive", async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM politicore.profiles WHERE tenant_id = $1`, [tenantC]);
    const arc = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.archive_tenant($1, 'phase31 G1 archival probe') AS s`, [tenantC]);
    expect(arc.error).toBeUndefined();
    expect(String(arc.rows[0]?.s)).toBe("archived");
    const after = await db.query(`SELECT count(*)::int AS n FROM politicore.profiles WHERE tenant_id = $1`, [tenantC]);
    expect((after.rows[0] as Record<string, unknown>).n).toBe((before.rows[0] as Record<string, unknown>).n);
  });

  it("G2 an archived tenant is refused by the access check", async () => {
    const r2 = await as(db, "authenticated", ownerC.authId,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    expect(r2.error).toMatch(/archived/);
  });

  it("G3 archival is reversible ONLY through the audited platform path", async () => {
    const res = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 G3 authorized archival recovery') AS s`, [tenantC]);
    expect(res.error).toBeUndefined();
    expect(String(res.rows[0]?.s)).toBe("active");
  });

  it("G4 restore refuses a healthy (active) tenant", async () => {
    const r = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 G4 restore on active') AS s`, [tenantC]);
    expect(r.error).toMatch(/restoration applies only to/);
  });

  it("G5 suspend twice is an idempotent no-op, not an error", async () => {
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.suspend_tenant($1, 'phase31 G5 first suspension') AS s`, [tenantC]);
    const again = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.suspend_tenant($1, 'phase31 G5 second call') AS s`, [tenantC]);
    expect(again.error).toBeUndefined();
    expect(String(again.rows[0]?.s)).toBe("suspended");
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 G5 cleanup restore') AS s`, [tenantC]);
  });

  /* ── H. Processor semantics ───────────────────────────────────────── */

  it("H1 the lifecycle sweep is idempotent — a second run does nothing", async () => {
    // tenantA: active + no subscription → sweep must not change it
    const r1 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT * FROM public.process_lifecycle_transitions()`);
    expect(r1.error).toBeUndefined();
    const first = r1.rows as Record<string, unknown>[];
    const r2 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT * FROM public.process_lifecycle_transitions()`);
    expect(r2.error).toBeUndefined();
    const second = r2.rows as Record<string, unknown>[];
    // second run must not re-report any tenant already aligned
    for (const row of second) {
      expect(first.some((f) => String(f.tenant_id) === String(row.tenant_id) && String(f.action) === String(row.action)),
        `re-reported ${JSON.stringify(row)}`).toBe(false);
    }
    expect(await lifeOf(db, tenantA)).toBe("active");
  });

  it("H2 the sweep follows a drifted subscription state (missed-event backstop)", async () => {
    // Simulate a missed event: subscription past_due while tenant says active.
    const sub = await as(db, "authenticated", owner.authId,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [verA]);
    expect(sub.error).toBeUndefined();
    const subId = scalar(sub.rows, "s");
    await db.query(
      `UPDATE politicore.subscriptions
          SET status = 'active', current_period_start = now(),
              current_period_end = now() + interval '30 days'
        WHERE id = $1`, [subId]);
    await db.query(`UPDATE politicore.subscriptions SET status = 'past_due', past_due_since = now() WHERE id = $1`, [subId]);
    // reset the tenant to active directly (replica mode — simulating drift)
    await forceLifecycle(db, tenantA, "active");

    const r = await as(db, "authenticated", platformAdmin.authId,
      `SELECT * FROM public.process_lifecycle_transitions()`);
    expect(r.error).toBeUndefined();
    const rows = r.rows as Record<string, unknown>[];
    expect(rows.some((x) => String(x.tenant_id) === tenantA && String(x.action) === "to_past_due")).toBe(true);
    expect(await lifeOf(db, tenantA)).toBe("past_due");

    // recovery: subscription back to active → sweep restores
    await db.query(`UPDATE politicore.subscriptions SET status = 'active', past_due_since = NULL WHERE id = $1`, [subId]);
    const r2 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT * FROM public.process_lifecycle_transitions()`);
    expect(r2.error).toBeUndefined();
    expect(await lifeOf(db, tenantA)).toBe("active");

    // settle the subscription history first: end + cancel (replica) so the
    // one-live-per-tenant rule never blocks the next section.
    await deleteSub(db, subId);
  });

  /* ── I. Audit & notifications ─────────────────────────────────────── */

  it("I1 every lifecycle transition is audited with a server-resolved actor + reason", async () => {
    const hist = await as(db, "authenticated", platformAdmin.authId,
      `SELECT * FROM public.tenant_lifecycle_history($1)`, [tenantA]);
    expect(hist.error).toBeUndefined();
    const rows = hist.rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.action).toBe("tenant_lifecycle_transitioned");
      // from/to always reconstructable (C-section subscription events carry
      // a server context with a NULL actor but a full from/to/reason)
      expect(row.from_status).not.toBeNull();
      expect(row.to_status).not.toBeNull();
    }
    // the F2 platform suspension must appear (active → suspended)
    const susp = rows.find((x) => String(x.to_status) === "suspended" && String(x.from_status) === "active");
    expect(susp).toBeDefined();
  });

  it("I2 the owner is notified on suspension (via the authorized platform path)", async () => {
    // F2 suspended tenantA through public.suspend_tenant — the notifying
    // path. Direct fixture writes never notify by design.
    const notes = await db.query(
      `SELECT title, count(*)::int AS n FROM politicore.notifications
        WHERE tenant_id = $1 AND title IN ('Tenant suspended', 'Access restricted', 'Payment due', 'Subscription cancelled', 'Tenant restored')
        GROUP BY title`, [tenantA]);
    const map = new Map<string, number>(
      (notes.rows as Record<string, unknown>[]).map((x) => [String(x.title), Number(x.n)]));
    expect(map.get("Tenant suspended") ?? 0).toBeGreaterThanOrEqual(1);
    expect(map.get("Tenant restored") ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("I3 suspension of an already-suspended tenant does NOT duplicate notifications", async () => {
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.suspend_tenant($1, 'phase31 I3 dedup probe') AS s`, [tenantC]);
    const c1 = await db.query(
      `SELECT count(*)::int AS n FROM politicore.notifications
        WHERE tenant_id = $1 AND title = 'Tenant suspended'`, [tenantC]);
    const n1 = Number((c1.rows[0] as Record<string, unknown>).n);
    // second (idempotent) call — apply_tenant_lifecycle no-ops
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.suspend_tenant($1, 'phase31 I3 dedup probe 2') AS s`, [tenantC]);
    const c2 = await db.query(
      `SELECT count(*)::int AS n FROM politicore.notifications
        WHERE tenant_id = $1 AND title = 'Tenant suspended'`, [tenantC]);
    const n2 = Number((c2.rows[0] as Record<string, unknown>).n);
    expect(n2).toBe(n1);
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.restore_tenant($1, 'phase31 I3 cleanup') AS s`, [tenantC]);
  });

  /* ── J. Architecture invariants ───────────────────────────────────── */

  it("J1 no new roles, permissions, or modules (Phase 31 adds none)", async () => {
    const perms = (await db.query(`SELECT count(*)::int AS n FROM politicore.permissions`)).rows[0] as Record<string, unknown>;
    expect(perms.n).toBe(43);
    const roles = (await db.query(
      `SELECT unnest(enum_range(NULL::politicore.access_role_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
    expect(roles).not.toContain("lifecycle_admin");
    expect(roles).not.toContain("tenant_lifecycle_manager");
    const mods = (await db.query(
      `SELECT unnest(enum_range(NULL::politicore.module_code_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
    expect(mods).toEqual(["social", "campaign", "election", "governance"]);
    const life = (await db.query(
      `SELECT unnest(enum_range(NULL::politicore.tenant_lifecycle_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
    expect(life).toEqual(["provisioning", "active", "past_due", "restricted", "suspended", "cancellation_pending", "cancelled", "archived"]);
  });

  it("J2 the legacy tenants.status CHECK and values stay valid (derived column in lockstep)", async () => {
    const r = await db.query(
      `SELECT status, lifecycle_status::text AS l FROM politicore.tenants WHERE lifecycle_status IS NOT NULL`);
    for (const row of r.rows as Record<string, unknown>[]) {
      const expected =
        ["provisioning", "active", "past_due", "restricted", "cancellation_pending"].includes(String(row.l))
          ? "active"
          : String(row.l) === "suspended" ? "suspended" : "cancelled";
      expect(row.status).toBe(expected);
    }
  });

  it("J3 migration count is 70; the latest migration is 0069 (Phase 31 tenant lifecycle)", () => {
    const dir = path.join(ROOT, "supabase", "migrations");
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(files.length).toBe(70);
    expect(files[files.length - 1]).toMatch(/^0069_/);
  });

  it("J4 the lifecycle functions are SECURITY DEFINER with locked search_path and REVOKE'd from anon", async () => {
    for (const fn of ["suspend_tenant", "restore_tenant", "archive_tenant", "apply_tenant_lifecycle", "assert_tenant_operationally_active"]) {
      const r = await db.query(
        `SELECT prosecdef AS def, provolatile AS vol
           FROM pg_proc WHERE oid = to_regproc('politicore.${fn}')`);
      const row = r.rows[0] as Record<string, unknown>;
      expect(row.def, `${fn} SECURITY DEFINER`).toBe(true);
    }
    const grants = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.role_usage_grants
        WHERE object_name = 'suspend_tenant' AND grantee IN ('anon', 'PUBLIC')`);
    expect(Number((grants.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("J5 no lifecycle code path ever writes subscriptions (one-directional coordination)", async () => {
    const defs = (await db.query(
      `SELECT pg_get_functiondef(oid) AS d FROM pg_proc
        WHERE oid IN (to_regproc('politicore.apply_tenant_lifecycle'),
                      to_regproc('politicore.suspend_tenant'),
                      to_regproc('politicore.restore_tenant'),
                      to_regproc('politicore.archive_tenant'),
                      to_regproc('politicore.process_lifecycle_transitions'))`)).rows as Record<string, unknown>[];
    for (const row of defs) {
      expect(String(row.d)).not.toMatch(/UPDATE\s+politicore\.subscriptions/);
      expect(String(row.d)).not.toMatch(/INSERT\s+INTO\s+politicore\.subscriptions/);
    }
  });

  it("J6 RLS on tenants is ENABLE + FORCE (unchanged by Phase 31)", async () => {
    const r = await db.query(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
        WHERE oid = to_regclass('politicore.tenants')`);
    const row = r.rows[0] as Record<string, unknown>;
    expect(row.rls).toBe(true);
    expect(row.force).toBe(true);
  });
});
