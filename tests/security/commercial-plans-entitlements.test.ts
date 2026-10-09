/**
 * POLITICORE — SAAS PHASE 28 — COMMERCIAL PLANS & ENTITLEMENTS SECURITY
 * SUITE (SaaS Phase A).
 *
 * Proves migration 0065 + the Phase 27 gate's Phase A requirements against
 * role-impersonated sessions (helpers.as) — the acceptance standard of
 * Phases 1–26:
 *
 *   A. Plan integrity      — unique codes/versions; lifecycle edges only;
 *                            active/retired immutability (commercial fields,
 *                            effective window); draft mutation rules; no
 *                            destructive plan deletion under FK RESTRICT.
 *   B. Pricing             — currency/interval required; integer minor
 *                            units; monthly ⊥ annual; duplicate rows
 *                            rejected; version-currency consistency;
 *                            price immutability on active/retired.
 *   C. Modules             — only the four EXISTING module values; the
 *                            enum itself unchanged (no SaaS values);
 *                            permission count still 43.
 *   D. Entitlements        — sync writes ONLY the existing
 *                            service_entitlements map; never tenant_modules,
 *                            permission_grants or authorization; plan
 *                            change revokes; draft/retired refuse sync.
 *   E. Tenant isolation    — sync is platform-authority-scoped; tenants
 *                            cannot touch each other's entitlement state.
 *   F. Platform authority  — plan management is platform-admin only;
 *                            tenant admins/members/anon hold nothing;
 *                            tenant-safe public catalog projection.
 *   G. Audit               — lifecycle events land in Core Audit with
 *                            server-resolved actors (seed rows excepted).
 *   H. Security posture    — no anon mutation; no client-supplied
 *                            authority fields; no direct-table writes for
 *                            non-admins; FORCE RLS on all three tables.
 *   I. Architecture        — no duplicate entitlement system; no
 *                            subscription/checkout tables; sync RPC never
 *                            touches authorization substrates; seeds
 *                            present.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { PGlite } from "@electric-sql/pglite";
import { getDb, as, createTenant, createUser } from "./helpers";

const E = "p28saas";
const ROOT = process.cwd();

/** Direct-SQL statements that MUST raise return the error message. */
async function queryErr(
  db: PGlite,
  sql: string,
  params?: unknown[]
): Promise<string | null> {
  try {
    await db.query(sql, params as never[]);
    return null;
  } catch (e) {
    return (e as Error).message;
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

describe("phase28 — commercial plans & entitlements", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let admin: { authId: string };
  let member: { authId: string };
  let adminB: { authId: string };
  let originalSettings: unknown;
  let platformAdmin: { authId: string };

  beforeAll(async () => {
    db = await getDb();
    tenantA = await createTenant(db, "p28saas-a", "Phase 28 SaaS A", {});
    tenantB = await createTenant(db, "p28saas-b", "Phase 28 SaaS B", {});
    admin = await createUser(db, { tenantId: tenantA, email: `${E}-adm@test.local`, fullName: "P28 Admin A", accessRole: "admin" });
    member = await createUser(db, { tenantId: tenantA, email: `${E}-mem@test.local`, fullName: "P28 Member A", accessRole: "member" });
    adminB = await createUser(db, { tenantId: tenantB, email: `${E}-admb@test.local`, fullName: "P28 Admin B", accessRole: "admin" });
    platformAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-platform@test.local`, fullName: "P28 Platform Admin", accessRole: "platform_super_admin" });

    const cur = await db.query(`SELECT settings FROM politicore.platform_settings WHERE id = 1`);
    originalSettings = cur.rows[0] ? (cur.rows[0] as Record<string, unknown>).settings : null;
    // Fresh per-file DBs may lack the platform_settings singleton; the sync
    // writer UPDATEs (never upserts) row id=1, so guarantee it exists.
    await db.query(`INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await db.query(
      `DELETE FROM politicore.system_audits
        WHERE tenant_id = ANY($1)
           OR (tenant_id IS NULL AND affected_resource IN ('plans','plan_versions','platform_settings'))`,
      [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`, [[admin.authId, member.authId, adminB.authId, platformAdmin.authId]]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [[admin.authId, member.authId, adminB.authId, platformAdmin.authId]]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
    if (originalSettings !== null) {
      await db.query(`UPDATE politicore.platform_settings SET settings = $1::jsonb WHERE id = 1`, [JSON.stringify(originalSettings)]);
    }
  });

  /** Create a throwaway plan + draft version as the platform admin. */
  async function probePlan(code: string, withPrices = true): Promise<{ planId: string; verId: string }> {
    const plan = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 90, 'probe') AS p`, [code, `P28 ${code}`]);
    if (plan.error) throw new Error(`probePlan create_plan: ${plan.error}`);
    const planId = scalar(plan.rows, "p");
    const ver = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, $2, 'probe') AS v`,
      [planId, withPrices ? '{"monthly": 100000}' : '{}']);
    if (ver.error) throw new Error(`probePlan create_plan_version: ${ver.error}`);
    return { planId, verId: scalar(ver.rows, "v") };
  }

  // ══ A. Plan integrity ═══════════════════════════════════════════════
  describe("A. plan integrity", () => {
    it("A1 plan codes are unique", async () => {
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan('starter', 'Duplicate Starter', NULL, 99, 'A1 duplicate probe') AS p`);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/duplicate key|unique/i);
    });

    it("A2 plan versions are uniquely versioned per plan", async () => {
      const idx = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_constraint
          WHERE conrelid = 'politicore.plan_versions'::regclass
            AND contype = 'u' AND pg_get_constraintdef(oid) LIKE '%(plan_id, version)%'`);
      expect(Number(idx.rows[0].n)).toBeGreaterThanOrEqual(1);
      // And behaviorally: a second draft gets version 2, not a collision.
      const { planId, verId } = await probePlan("p28-uniqueness");
      const v2 = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{}', 'A2 probe') AS v`, [planId]);
      expect(v2.error).toBeUndefined();
      expect(scalar(v2.rows, "v")).not.toBe(verId);
      const versions = await db.query<{ v: number[] }>(
        `SELECT array_agg(version) v FROM politicore.plan_versions WHERE plan_id = $1`, [planId]);
      expect(versions.rows[0].v.sort()).toEqual([1, 2]);
    });

    it("A3 only the authorized lifecycle edges exist (draft→active, active→retired)", async () => {
      const def = await db.query<{ d: string }>(
        `SELECT pg_get_functiondef(to_regproc('politicore.guard_plan_version_immutability')) d`);
      const body = def.rows[0].d;
      expect(body).toMatch(/OLD\.status = 'draft'\s+AND NEW\.status = 'active'/);
      expect(body).toMatch(/OLD\.status = 'active'\s+AND NEW\.status = 'retired'/);
    });

    it("A4 illegal status transitions are rejected (draft→retired, active→draft, retired→active)", async () => {
      const { verId } = await probePlan("p28-trans");

      // draft → retired: rejected by the trigger.
      const d2r = await queryErr(db,
        `UPDATE politicore.plan_versions SET status = 'retired' WHERE id = $1`, [verId]);
      expect(d2r).toMatch(/illegal plan version status transition/);

      // Legal draft → active, then active → draft: rejected.
      await db.query(`UPDATE politicore.plan_versions SET status = 'active', effective_from = now() WHERE id = $1`, [verId]);
      const a2d = await queryErr(db,
        `UPDATE politicore.plan_versions SET status = 'draft' WHERE id = $1`, [verId]);
      expect(a2d).toMatch(/illegal plan version status transition/);

      // active → retired works, then retired → active: rejected.
      await db.query(`UPDATE politicore.plan_versions SET status = 'retired', effective_to = now() WHERE id = $1`, [verId]);
      const r2a = await queryErr(db,
        `UPDATE politicore.plan_versions SET status = 'active' WHERE id = $1`, [verId]);
      expect(r2a).toMatch(/illegal plan version status transition/);
    });

    it("A5 active plan versions are immutable on commercial fields", async () => {
      const ver = await db.query<{ id: string }>(
        `SELECT v.id FROM politicore.plan_versions v JOIN politicore.plans p ON p.id = v.plan_id
          WHERE p.code = 'professional' AND v.version = 1`);
      const id = ver.rows[0].id;

      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET included_modules = ARRAY['social']::politicore.module_code_enum[] WHERE id = $1`, [id]))
        .toMatch(/commercial fields are immutable/);
      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET trial_days = 30 WHERE id = $1`, [id]))
        .toMatch(/commercial fields are immutable/);
      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET limits = '{"max_members": 1}'::jsonb WHERE id = $1`, [id]))
        .toMatch(/commercial fields are immutable/);
      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET currency = 'USD' WHERE id = $1`, [id]))
        .toMatch(/commercial fields are immutable/);
      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET feature_entitlements = '{"advanced_analytics": false}'::jsonb WHERE id = $1`, [id]))
        .toMatch(/commercial fields are immutable/);
    });

    it("A6 retired versions are immutable and the effective window is frozen", async () => {
      const { verId } = await probePlan("p28-ret");
      await db.query(`UPDATE politicore.plan_versions SET status = 'active', effective_from = now() WHERE id = $1`, [verId]);
      await db.query(`UPDATE politicore.plan_versions SET status = 'retired', effective_to = now() WHERE id = $1`, [verId]);

      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET effective_from = now() - interval '30 days' WHERE id = $1`, [verId]))
        .toMatch(/commercial fields are immutable/);
      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET trial_enabled = false WHERE id = $1`, [verId]))
        .toMatch(/commercial fields are immutable/);
      expect(await queryErr(db,
        `UPDATE politicore.plan_versions SET status = 'active' WHERE id = $1`, [verId]))
        .toMatch(/illegal plan version status transition/);
    });

    it("A7 drafts are editable while draft (mutation rules honored)", async () => {
      const { verId } = await probePlan("p28-draft", false);

      const upd = await db.query(
        `UPDATE politicore.plan_versions
            SET included_modules = ARRAY['social','campaign']::politicore.module_code_enum[],
                limits = '{"max_members": 50}'::jsonb
          WHERE id = $1`, [verId]);
      expect((upd as unknown as { error?: string }).error ?? null).toBeNull();

      const price = await db.query(
        `INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
         VALUES ($1, 'NGN', 'monthly', 250000)`, [verId]);
      expect((price as unknown as { error?: string }).error ?? null).toBeNull();

      // And through the audited draft-edit RPC.
      const edit = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.update_plan_version_draft($1, NULL, NULL, NULL, false, 7, NULL, 'A7 probe') AS v`, [verId]);
      expect(edit.error).toBeUndefined();
      const trial = await db.query<{ te: boolean; td: number }>(
        `SELECT trial_enabled te, trial_days td FROM politicore.plan_versions WHERE id = $1`, [verId]);
      expect(trial.rows[0].te).toBe(false);
      expect(trial.rows[0].td).toBe(7);
    });

    it("A8 plans are never destructively deleted where referenced (RESTRICT)", async () => {
      const fk = await db.query<{ confdeltype: string }>(
        `SELECT confdeltype FROM pg_constraint
          WHERE conrelid = 'politicore.plan_versions'::regclass AND contype = 'f'`);
      expect(fk.rows.some((r) => r.confdeltype === "r")).toBe(true);
      const ref = await db.query<{ plan_id: string }>(`SELECT plan_id FROM politicore.plan_versions LIMIT 1`);
      const err = await queryErr(db, `DELETE FROM politicore.plans WHERE id = $1`, [ref.rows[0].plan_id]);
      expect(err).toMatch(/RESTRICT/);
    });
  });

  // ══ B. Pricing ═══════════════════════════════════════════════════════
  describe("B. pricing", () => {
    it("B1 monthly and annual prices are independent rows (annual never derived)", async () => {
      const r = await db.query<{ monthly: string; annual: string }>(
        `SELECT
           (SELECT amount_minor::text FROM politicore.plan_version_prices pr
             JOIN politicore.plan_versions v ON v.id = pr.plan_version_id
             JOIN politicore.plans p ON p.id = v.plan_id
            WHERE p.code = 'starter' AND v.version = 1 AND pr.billing_interval = 'monthly') AS monthly,
           (SELECT amount_minor::text FROM politicore.plan_version_prices pr
             JOIN politicore.plan_versions v ON v.id = pr.plan_version_id
             JOIN politicore.plans p ON p.id = v.plan_id
            WHERE p.code = 'starter' AND v.version = 1 AND pr.billing_interval = 'annual') AS annual`);
      expect(r.rows[0].monthly).toBe("1500000");
      expect(r.rows[0].annual).toBe("15000000");
      expect(r.rows[0].annual).not.toBe(String(Number(r.rows[0].monthly) * 12));
    });

    it("B2 amount is integer minor units (bigint column; no fractional or string storage)", async () => {
      const col = await db.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema='politicore' AND table_name='plan_version_prices'
            AND column_name='amount_minor'`);
      expect(col.rows[0].data_type).toBe("bigint");

      const { planId } = await probePlan("p28-price", false);
      const fractional = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{"monthly": 1000.5}'::jsonb, 'B2 probe') AS v`, [planId]);
      expect(fractional.error).toBeDefined();
      expect(fractional.error).toMatch(/non-negative integer of minor units/);
      const strPrice = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{"monthly": "100000"}'::jsonb, 'B2 probe') AS v`, [planId]);
      expect(strPrice.error).toBeDefined();
      expect(strPrice.error).toMatch(/JSON number/);
    });

    it("B3 currency is required and validated (3-letter uppercase)", async () => {
      const { planId } = await probePlan("p28-cur", false);
      const bad = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'us', true, 14, '{"monthly": 100000}'::jsonb, 'B3 probe') AS v`, [planId]);
      expect(bad.error).toBeDefined();
      const ok = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{"monthly": 100000}'::jsonb, 'B3 probe') AS v`, [planId]);
      expect(ok.error).toBeUndefined();
    });

    it("B4 duplicate interval/currency rows are rejected", async () => {
      const uq = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_constraint
          WHERE conrelid = 'politicore.plan_version_prices'::regclass
            AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(plan_version_id, currency, billing_interval)%'`);
      expect(Number(uq.rows[0].n)).toBe(1);
      const { verId } = await probePlan("p28-dup");
      const dup = await queryErr(db,
        `INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
         VALUES ($1, 'NGN', 'monthly', 999)`, [verId]);
      expect(dup).toMatch(/duplicate key|unique/i);
    });

    it("B5 price currency must match the version currency", async () => {
      const { verId } = await probePlan("p28-cur2", false);
      const wrong = await queryErr(db,
        `INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
         VALUES ($1, 'USD', 'annual', 500)`, [verId]);
      expect(wrong).toMatch(/does not match the plan version currency/);
    });

    it("B6 prices of active/retired versions are immutable (no change, add, or remove)", async () => {
      const active = await db.query<{ id: string }>(
        `SELECT v.id FROM politicore.plan_versions v JOIN politicore.plans p ON p.id=v.plan_id
          WHERE p.code='starter' AND v.version=1`);
      const id = active.rows[0].id;
      expect(await queryErr(db,
        `UPDATE politicore.plan_version_prices SET amount_minor = 1 WHERE plan_version_id = $1`, [id]))
        .toMatch(/immutable/);
      expect(await queryErr(db,
        `INSERT INTO politicore.plan_version_prices (plan_version_id, currency, billing_interval, amount_minor)
         VALUES ($1, 'NGN', 'monthly', 1)`, [id]))
        .toMatch(/immutable/);
      expect(await queryErr(db,
        `DELETE FROM politicore.plan_version_prices WHERE plan_version_id = $1`, [id]))
        .toMatch(/immutable/);
    });

    it("B7 a version cannot be activated without at least one price", async () => {
      const { verId } = await probePlan("p28-noprice", false);
      const act = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.activate_plan_version($1, 'B7 probe') AS v`, [verId]);
      expect(act.error).toBeDefined();
      expect(act.error).toMatch(/no prices/i);
    });
  });

  // ══ C. Modules ══════════════════════════════════════════════════════
  describe("C. modules", () => {
    it("C1 module_code_enum is unchanged — exactly the four business modules", async () => {
      const r = await db.query<{ s: string }>(
        `SELECT string_agg(v::text, ',') s FROM unnest(enum_range(NULL::politicore.module_code_enum)) v`);
      expect(r.rows[0].s).toBe("social,campaign,election,governance");
    });

    it("C2 plan versions accept only existing module values (no SaaS taxonomy)", async () => {
      const { planId } = await probePlan("p28-mod", false);
      for (const saas of ["billing", "saas", "domains", "analytics", "plans"]) {
        const r = await as(db, "authenticated", platformAdmin.authId,
          `SELECT public.create_plan_version($1, ARRAY['social', $2], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{}', 'C2 probe') AS v`,
          [planId, saas]);
        expect(r.error, `module value ${saas} must be rejected`).toBeDefined();
      }
    });

    it("C3 a plan version must include at least one module", async () => {
      const { planId } = await probePlan("p28-empty", false);
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{}', 'C3 probe') AS v`, [planId]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/at least one module/);
    });

    it("C4 permission count remains 43 — the commercial layer adds none", async () => {
      const p = await db.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.permissions`);
      expect(Number(p.rows[0].n)).toBe(43);
    });
  });

  // ══ D. Entitlements ══════════════════════════════════════════════════
  describe("D. entitlement synchronization", () => {
    it("D1 platform admin sync writes the existing service_entitlements map only", async () => {
      const before = await db.query<{ tm: number; grants: number }>(
        `SELECT (SELECT count(*) FROM politicore.tenant_modules WHERE tenant_id = $1) tm,
                (SELECT count(*) FROM politicore.permission_grants WHERE tenant_id = $1) grants`, [tenantA]);

      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.sync_tenant_entitlements($1, 'starter', 'D1 sync probe')`, [tenantA]);
      expect(r.error).toBeUndefined();
      const map = r.rows.reduce<Record<string, boolean>>((acc, row) => {
        acc[String(row.module)] = Boolean(row.entitled); return acc;
      }, {});
      expect(map).toEqual({ social: true, campaign: true, election: false, governance: false });

      const settings = await db.query<{ se: Record<string, unknown> }>(
        `SELECT settings -> 'service_entitlements' -> $1::text AS se FROM politicore.platform_settings WHERE id = 1`, [tenantA]);
      expect(settings.rows[0].se).toEqual({ social: true, campaign: true, election: false, governance: false });

      const after = await db.query<{ tm: number; grants: number }>(
        `SELECT (SELECT count(*) FROM politicore.tenant_modules WHERE tenant_id = $1) tm,
                (SELECT count(*) FROM politicore.permission_grants WHERE tenant_id = $1) grants`, [tenantA]);
      expect(after.rows[0].tm).toBe(before.rows[0].tm);
      expect(after.rows[0].grants).toBe(before.rows[0].grants);
    });

    it("D2 sync cannot create application permission grants", async () => {
      const before = await db.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.permission_grants`);
      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'professional', 'D2 probe')`, [tenantA]);
      const after = await db.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.permission_grants`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("D3 sync cannot alter tenant_modules.enabled", async () => {
      await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'starter', 'D3 probe')`, [tenantA]);
      const after = await db.query<{ enabled: boolean }>(
        `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
      expect(after.rows[0].enabled).toBe(true); // untouched by the sync
      await db.query(`UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    });

    it("D4 sync cannot alter user authorization (resolver unchanged, single definition)", async () => {
      const r = await as(db, "authenticated", member.authId,
        `SELECT politicore.has_permission('view_area') AS ok`);
      expect(r.error).toBeUndefined();
      expect((r.rows[0] as Record<string, unknown>).ok).toBe(false);
      const def = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='politicore' AND p.proname='has_permission'`);
      expect(Number(def.rows[0].n)).toBe(1);
    });

    it("D5 a plan change cleanly revokes availability (full-map authoritative write)", async () => {
      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'professional', 'D5 upgrade probe')`, [tenantA]);
      let se = await db.query<{ se: Record<string, unknown> }>(
        `SELECT settings -> 'service_entitlements' -> $1::text AS se FROM politicore.platform_settings WHERE id = 1`, [tenantA]);
      expect(se.rows[0].se).toEqual({ social: true, campaign: true, election: true, governance: true });

      await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'starter', 'D5 downgrade probe')`, [tenantA]);
      se = await db.query<{ se: Record<string, unknown> }>(
        `SELECT settings -> 'service_entitlements' -> $1::text AS se FROM politicore.platform_settings WHERE id = 1`, [tenantA]);
      expect(se.rows[0].se).toEqual({ social: true, campaign: true, election: false, governance: false });
    });

    it("D6 draft and retired versions refuse synchronization", async () => {
      const { verId } = await probePlan("p28-sync");
      const draftSync = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.apply_plan_version_entitlements($1, $2, 'D6 draft probe')`, [tenantA, verId]);
      expect(draftSync.error).toBeDefined();
      expect(draftSync.error).toMatch(/ACTIVE/);
    });

    it("D7 unknown plan/version/tenant inputs are rejected (no silent writes)", async () => {
      const unknownPlan = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'no-such-plan', 'D7 probe')`, [tenantA]);
      expect(unknownPlan.error).toBeDefined();
      const unknownTenant = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'starter', 'D7 probe')`,
        ["00000000-0000-0000-0000-000000000000"]);
      expect(unknownTenant.error).toBeDefined();
    });

    it("D8 feature entitlements/limits are allowlisted; unlimited ≠ 0", async () => {
      const { planId } = await probePlan("p28-feat", false);
      const bad = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{"unlimited_everything": true}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{}', 'D8 probe') AS v`, [planId]);
      expect(bad.error).toBeDefined();
      expect(bad.error).toMatch(/unknown feature entitlement/);
      const badLimit = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{"max_unlimited": 1}'::jsonb, 'NGN', true, 14, '{}', 'D8 probe') AS v`, [planId]);
      expect(badLimit.error).toBeDefined();
      expect(badLimit.error).toMatch(/unknown limit key/);

      // null = unlimited; 0 = zero — distinct, deterministic representations.
      const unlimited = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{"max_members": null, "max_storage_bytes": 0}'::jsonb, 'NGN', true, 14, '{}', 'D8 probe') AS v`, [planId]);
      expect(unlimited.error).toBeUndefined();
      const verId = scalar(unlimited.rows, "v");
      const stored = await db.query<{ mm: unknown; ms: unknown }>(
        `SELECT limits -> 'max_members' mm, limits -> 'max_storage_bytes' ms FROM politicore.plan_versions WHERE id = $1`, [verId]);
      expect(stored.rows[0].mm).toBeNull();   // unlimited
      expect(stored.rows[0].ms).toBe(0);      // zero — distinctly stored
    });
  });

  // ══ E. Tenant isolation ══════════════════════════════════════════════
  describe("E. tenant isolation", () => {
    it("E1 tenant A sync never touches tenant B's entitlement state", async () => {
      const seB = await db.query<{ se: unknown }>(
        `SELECT settings -> 'service_entitlements' -> $1::text AS se FROM politicore.platform_settings WHERE id = 1`, [tenantB]);
      expect(seB.rows[0].se).toBeNull();
      const seA = await db.query<{ se: unknown }>(
        `SELECT settings -> 'service_entitlements' -> $1::text AS se FROM politicore.platform_settings WHERE id = 1`, [tenantA]);
      expect(seA.rows[0].se).toBeDefined();
    });

    it("E2 tenant admins cannot read or write the entitlement map", async () => {
      // platform_settings is platform-admin-only (0002): tenant-admin reads
      // see zero rows (RLS filter, no error) and writes change nothing.
      const rB = await as(db, "authenticated", adminB.authId,
        `SELECT settings FROM politicore.platform_settings WHERE id = 1`);
      expect(rB.rows.length).toBe(0);

      const before = await db.query<Record<string, unknown>>(
        `SELECT settings FROM politicore.platform_settings WHERE id = 1`);
      await as(db, "authenticated", adminB.authId,
        `UPDATE politicore.platform_settings SET settings = '{"hacked": true}'::jsonb WHERE id = 1`);
      const after = await db.query<Record<string, unknown>>(
        `SELECT settings FROM politicore.platform_settings WHERE id = 1`);
      expect(after.rows[0].settings).toEqual(before.rows[0].settings);
    });

    it("E3 tenant A's commercial state is untouched by tenant B sessions", async () => {
      const seA = await db.query<{ se: unknown }>(
        `SELECT settings -> 'service_entitlements' -> $1::text AS se FROM politicore.platform_settings WHERE id = 1`, [tenantA]);
      expect(seA.rows[0].se).toBeDefined();
      // B (not entitled) still cannot activate — the Phase 22 gate holds.
      const r = await as(db, "authenticated", adminB.authId,
        `SELECT politicore.set_tenant_module_enabled('social', true)`);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/not entitled/);
    });
  });

  // ══ F. Platform authority ════════════════════════════════════════════
  describe("F. platform authority", () => {
    it("F1 tenant admins cannot create or modify plans", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT public.create_plan('p28-tna', 'Tenant Admin Plan', NULL, 1, 'F1 probe') AS p`);
      expect(r1.error).toBeDefined();
      expect(r1.error).toMatch(/platform_super_admin/);
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT public.sync_tenant_entitlements($1, 'starter', 'F1 probe')`, [tenantA]);
      expect(r2.error).toBeDefined();
      expect(r2.error).toMatch(/platform_super_admin/);
    });

    it("F2 ordinary members hold no commercial administration authority", async () => {
      const r1 = await as(db, "authenticated", member.authId,
        `SELECT public.create_plan('p28-mem', 'Member Plan', NULL, 1, 'F2 probe') AS p`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "authenticated", member.authId,
        `SELECT public.sync_tenant_entitlements($1, 'starter', 'F2 probe')`, [tenantA]);
      expect(r2.error).toBeDefined();
      const r3 = await as(db, "authenticated", member.authId,
        `SELECT * FROM public.plan_catalog_admin()`);
      expect(r3.error).toBeDefined();
    });

    it("F3 anonymous callers hold nothing", async () => {
      const r1 = await as(db, "anon", null, `SELECT public.create_plan('p28-anon', 'Anon Plan', NULL, 1, 'F3 probe') AS p`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null, `SELECT public.sync_tenant_entitlements($1, 'starter', NULL)`, [tenantA]);
      expect(r2.error).toBeDefined();
      const r3 = await as(db, "anon", null, `SELECT * FROM public.plan_catalog_admin()`);
      expect(r3.error).toBeDefined();
      // anon gets NO commercial table reads either (REVOKE posture).
      const r4 = await as(db, "anon", null, `SELECT count(*) FROM politicore.plans`);
      expect(r4.error ?? "denied").toBeTruthy();
    });

    it("F4 platform admin manages the catalog through the RPC surface", async () => {
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT * FROM public.plan_catalog_admin()`);
      expect(r.error).toBeUndefined();
      const starter = r.rows.find((x) => (x as Record<string, unknown>).plan_code === "starter") as Record<string, unknown>;
      expect(starter).toBeDefined();
      expect(String(starter.status)).toBe("active");
      expect((starter.prices as Record<string, unknown>).monthly).toBe(1500000);
      expect((starter.prices as Record<string, unknown>).annual).toBe(15000000);
    });

    it("F5 the tenant-safe public catalog exposes active plans only (no drafts/retired)", async () => {
      await probePlan("p28-pub"); // stays a draft
      const r = await as(db, "authenticated", member.authId,
        `SELECT * FROM public.plan_catalog_public()`);
      expect(r.error).toBeUndefined();
      const codes = r.rows.map((x) => String((x as Record<string, unknown>).plan_code));
      expect(codes).toContain("starter");
      expect(codes).not.toContain("p28-pub");
      // anon can also read the public catalog (the only anonymous surface).
      const anon = await as(db, "anon", null, `SELECT * FROM public.plan_catalog_public()`);
      expect(anon.error).toBeUndefined();
      expect(anon.rows.map((x) => String((x as Record<string, unknown>).plan_code))).toContain("starter");
    });

    it("F6 plan administration is never exposed through tenant Control Center", async () => {
      const ccDir = path.join(ROOT, "src", "app", "portal", "control-center");
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/plan/i.test(e.name)) found.push(p);
        }
      };
      walk(ccDir);
      expect(found).toEqual([]);
    });
  });

  // ══ G. Audit ═════════════════════════════════════════════════════════
  describe("G. audit", () => {
    it("G1 plan lifecycle mutations generate Core Audit events", async () => {
      const r = await db.query<{ actions: string[] }>(
        `SELECT array_agg(DISTINCT action) actions FROM politicore.system_audits
          WHERE affected_resource IN ('plans','plan_versions','platform_settings')
            AND action IN ('plan_created','plan_version_created','plan_version_activated',
                           'plan_version_retired','plan_version_updated','entitlements_synchronized')`);
      const actions = r.rows[0]?.actions ?? [];
      for (const expected of ["plan_created", "plan_version_created", "plan_version_activated", "plan_version_updated", "entitlements_synchronized"]) {
        expect(actions).toContain(expected);
      }
    });

    it("G2 actor is server-resolved (platform admin id, never client-supplied)", async () => {
      const r = await db.query<{ actor: string }>(
        `SELECT actor_id::text actor FROM politicore.system_audits
          WHERE action = 'entitlements_synchronized' AND tenant_id = $1 LIMIT 1`, [tenantA]);
      expect(r.rows[0].actor).toBe(platformAdmin.authId);
      const seedRows = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE action = 'plan_version_activated' AND reason_notes = 'launch catalog seed'`);
      expect(Number(seedRows.rows[0].n)).toBe(3); // starter, professional, enterprise
    });

    it("G3 sync audit captures old and new entitlement values", async () => {
      const r = await db.query<{ old_value: Record<string, unknown> | null; new_value: Record<string, unknown> }>(
        `SELECT old_value, new_value FROM politicore.system_audits
          WHERE action = 'entitlements_synchronized' AND tenant_id = $1
          ORDER BY occurred_at DESC LIMIT 1`, [tenantA]);
      expect(r.rows[0].new_value.modules).toBeDefined();
      expect(r.rows[0].old_value).toBeDefined();
    });

    it("G4 no parallel commercial audit table exists (Phase 28 — superseded by 0066's billing tables)", async () => {
      // Updated in Phase 29: 0066 legitimately introduces the subscription /
      // billing tables (subscriptions, invoices, payments, billing_events…)
      // and still ships NO parallel PLAN-audit table. Pin the plan-side
      // invariant that this suite actually guards.
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='politicore' AND c.relkind='r'
            AND (c.relname LIKE '%plan_audit%' OR c.relname LIKE '%commercial_audit%'
                 OR c.relname LIKE '%entitlement_log%')`);
      expect(Number(r.rows[0].n)).toBe(0);
    });
  });

  // ══ H. Security posture ══════════════════════════════════════════════
  describe("H. security posture", () => {
    it("H1 all three commercial tables are RLS-enabled AND FORCE RLS", async () => {
      const r = await db.query<{ relname: string; enabled: boolean; forced: boolean }>(
        `SELECT c.relname, c.relrowsecurity enabled, c.relforcerowsecurity forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='politicore' AND c.relname IN ('plans','plan_versions','plan_version_prices')`);
      expect(r.rows.length).toBe(3);
      for (const t of r.rows) {
        expect(t.enabled).toBe(true);
        expect(t.forced).toBe(true);
      }
    });

    it("H2 no anonymous mutation policy exists on commercial tables", async () => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_policies
          WHERE schemaname='politicore'
            AND tablename IN ('plans','plan_versions','plan_version_prices')
            AND roles @> ARRAY['anon']::name[]`);
      expect(Number(r.rows[0].n)).toBe(0);
    });

    it("H3 non-admin direct table mutation is denied (insert raises; update/delete change nothing)", async () => {
      const r1 = await as(db, "authenticated", member.authId,
        `INSERT INTO politicore.plans (code, name) VALUES ('p28-hax', 'Hacked Plan')`);
      expect(r1.error).toBeDefined();
      expect(r1.error).toMatch(/row-level security/i);

      // UPDATE through RLS with no applicable policy silently affects zero
      // rows — assert the state is unchanged instead of an error.
      const seededLimits = await db.query<{ limits: unknown }>(
        `SELECT v.limits FROM politicore.plan_versions v JOIN politicore.plans p ON p.id=v.plan_id
          WHERE p.code='starter' AND v.version=1`);
      await as(db, "authenticated", admin.authId,
        `UPDATE politicore.plan_versions SET limits = '{"max_members": 999999999}'::jsonb WHERE status = 'active'`);
      const afterLimits = await db.query<{ limits: unknown }>(
        `SELECT v.limits FROM politicore.plan_versions v JOIN politicore.plans p ON p.id=v.plan_id
          WHERE p.code='starter' AND v.version=1`);
      expect(afterLimits.rows[0].limits).toEqual(seededLimits.rows[0].limits);

      const priceCount = await db.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.plan_version_prices`);
      await as(db, "authenticated", member.authId, `DELETE FROM politicore.plan_version_prices`);
      const priceCountAfter = await db.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.plan_version_prices`);
      expect(priceCountAfter.rows[0].n).toBe(priceCount.rows[0].n);
    });

    it("H4 tenant users see only the bounded read surface (no drafts, no admin model)", async () => {
      const drafts = await as(db, "authenticated", member.authId,
        `SELECT count(*)::int n FROM politicore.plan_versions WHERE status = 'draft'`);
      expect(drafts.error).toBeUndefined();
      expect(Number((drafts.rows[0] as Record<string, unknown>).n)).toBe(0);
      const r2 = await as(db, "authenticated", member.authId,
        `SELECT * FROM politicore.plan_catalog_admin()`);
      expect(r2.error).toBeDefined();
    });

    it("H5 RPC signatures carry no client-supplied authority fields", async () => {
      const r = await db.query<{ names: string[] }>(
        `SELECT array_agg(p.proname::text) names FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname='public' AND p.proname IN
           ('create_plan','create_plan_version','update_plan_version_draft','activate_plan_version',
            'retire_plan_version','sync_tenant_entitlements','plan_catalog_admin')`);
      expect(r.rows[0].names.length).toBe(7);
      const bad = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM information_schema.parameters
          WHERE specific_schema='public'
            AND specific_name IN ('create_plan','create_plan_version','update_plan_version_draft',
                                  'activate_plan_version','retire_plan_version','sync_tenant_entitlements')
            AND parameter_name IN ('tenant_id','actor_id','access_role','permission','is_platform_admin')`);
      expect(Number(bad.rows[0].n)).toBe(0);
    });
  });

  // ══ I. Architecture ══════════════════════════════════════════════════
  describe("I. architecture invariants", () => {
    it("I1 no duplicate entitlement substrate was created", async () => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='politicore' AND c.relkind='r'
            AND c.relname IN ('tenant_entitlements','commercial_entitlements',
                              'service_entitlements','module_entitlements')`);
      expect(Number(r.rows[0].n)).toBe(0);
      const col = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM information_schema.columns
          WHERE table_schema='politicore' AND table_name='platform_settings'
            AND column_name='settings'`);
      expect(Number(col.rows[0].n)).toBe(1);
    });

    it("I2 no Phase 29 objects exist (superseded — Phase 29 shipped 0066 with subscription/billing core)", async () => {
      // Updated in Phase 29: the subscriptions/billing core now EXISTS by
      // design (migration 0066). The invariant this suite keeps: no
      // CHECKOUT or self-service signup surface was introduced, and no
      // HTTP webhook endpoint bypasses the RPC layer.
      const checkout = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='politicore' AND c.relkind='r'
            AND (c.relname LIKE '%checkout%' OR c.relname LIKE '%signup%'
                 OR c.relname LIKE '%onboarding%')`);
      expect(Number(checkout.rows[0].n)).toBe(0);
      expect(fs.existsSync(path.join(ROOT, "src", "app", "api", "webhooks"))).toBe(false);
    });

    it("I3 the sync RPC never touches authorization or activation substrates", async () => {
      const def = await db.query<{ d: string }>(
        `SELECT pg_get_functiondef(to_regproc('politicore.apply_plan_version_entitlements')) d`);
      const body = def.rows[0].d;
      expect(body).toContain("service_entitlements");
      expect(body).not.toMatch(/INSERT INTO politicore\.permission_grants/i);
      expect(body).not.toMatch(/UPDATE politicore\.tenant_modules/i);
      expect(body).not.toMatch(/UPDATE politicore\.profiles/i);
      expect(body).not.toMatch(/GRANT /i);
      expect(body).toContain("is_platform_admin() IS TRUE");
    });

    it("I4 seeds: the launch catalog exists with NGN prices and trial 14", async () => {
      const r = await db.query<{ code: string; modules: string[]; monthly: string | null; annual: string | null; trial_days: number; status: string; currency: string }>(
        `SELECT p.code, v.included_modules::text[] modules,
                (SELECT amount_minor::text FROM politicore.plan_version_prices pr
                  WHERE pr.plan_version_id = v.id AND pr.billing_interval='monthly') monthly,
                (SELECT amount_minor::text FROM politicore.plan_version_prices pr
                  WHERE pr.plan_version_id = v.id AND pr.billing_interval='annual') annual,
                v.trial_days, v.status::text status, v.currency
           FROM politicore.plans p
           LEFT JOIN politicore.plan_versions v ON v.plan_id = p.id AND v.version = 1
          WHERE p.code IN ('starter','professional','enterprise')
          ORDER BY p.sort_order`);
      expect(r.rows.map((x) => x.code)).toEqual(["starter", "professional", "enterprise"]);
      const byCode = new Map(r.rows.map((x) => [x.code, x]));
      expect(byCode.get("starter")!.modules.sort()).toEqual(["campaign", "social"]);
      expect(byCode.get("professional")!.modules.sort()).toEqual(["campaign", "election", "governance", "social"]);
      expect(byCode.get("enterprise")!.modules.sort()).toEqual(["campaign", "election", "governance", "social"]);
      expect(byCode.get("starter")!.monthly).toBe("1500000");
      expect(byCode.get("professional")!.monthly).toBe("5000000");
      expect(byCode.get("enterprise")!.monthly).toBe("15000000");
      for (const row of r.rows) {
        expect(row.status).toBe("active");
        expect(row.currency).toBe("NGN");
        expect(row.trial_days).toBe(14);
        expect(row.monthly).not.toBeNull();
        expect(row.annual).not.toBeNull();
      }
    });

    it("I5 migration count is 70; the latest migration is 0069 (Phase 31 tenant lifecycle)", () => {
      const dir = path.join(ROOT, "supabase", "migrations");
      const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      expect(files.length).toBe(70);
      expect(files[files.length - 1]).toMatch(/^0069_/);
    });
  });
});
