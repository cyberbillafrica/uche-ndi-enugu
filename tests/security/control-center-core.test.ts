/**
 * POLITICORE — PHASE 22 — CONTROL CENTER CORE — SECURITY SUITE.
 *
 * Proves the Control Center foundation (migration 0060) against
 * role-impersonated sessions (helpers.as) — the same acceptance standard
 * as every phase suite:
 *
 *   A. Authentication    — anon holds nothing: no activation, no config
 *                          reads/writes, no cross-tenant inference
 *   B. Tenant admin      — authorized admin reads own overview, activates
 *                          and deactivates entitled services
 *   C. Unauthorized      — ordinary members and module staff cannot
 *                          activate or read configuration
 *   D. Entitlement       — ENTITLED AND ENABLED = OPERATIONAL; non-
 *                          entitled enable fails; stray enabled state
 *                          cannot bypass entitlement
 *   E. Tenant isolation  — tenant A cannot read/mutate tenant B; A's
 *                          activation does not affect B
 *   F. Deny-wins         — the authority path is is_tenant_admin() (not
 *                          permission_grants), preserving Phase 20's
 *                          deny-wins invariant by construction
 *   G. Audit             — activation/deactivation create Core Audit
 *                          evidence (trigger); draft saves create RPC audit
 *   H. Concurrency       — stale revision rejected; current revision
 *                          succeeds; rejected mutation does not overwrite
 *   I. Module gate       — after disable, module gate fails closed;
 *                          after re-enable, operational again
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTenant, createUser, getDb } from "./helpers";

const SLUG = "ccore";
const E = "ccore";

describe("Phase 22 — Control Center core", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let admin: { authId: string };
  let member: { authId: string };
  let staff: { authId: string };
  let adminB: { authId: string };

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, `${SLUG}-a`, "CC Tenant A", {
      social: true, campaign: true, election: true, governance: true,
    });
    tenantB = await createTenant(db, `${SLUG}-b`, "CC Tenant B", {
      social: false, campaign: false, election: false, governance: false,
    });

    // Platform entitlements: per-tenant map inside the platform singleton.
    // A entitled for everything; B entitled for nothing.
    await db.query(
      `INSERT INTO politicore.platform_settings (id, settings)
       VALUES (1, jsonb_build_object('service_entitlements', jsonb_build_object(
         $1::text, jsonb_build_object('social', true, 'campaign', true, 'election', true, 'governance', true))))
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`,
      [tenantA]);

    admin = await createUser(db, { tenantId: tenantA, email: `${E}-adm@test.local`, fullName: "CC Admin", accessRole: "admin" });
    member = await createUser(db, { tenantId: tenantA, email: `${E}-mem@test.local`, fullName: "CC Member", accessRole: "member" });
    staff = await createUser(db, { tenantId: tenantA, email: `${E}-staff@test.local`, fullName: "CC Staff", accessRole: "member", membershipTypes: ["social_member", "campaign_member"] });
    adminB = await createUser(db, { tenantId: tenantB, email: `${E}-admb@test.local`, fullName: "CC Admin B", accessRole: "admin" });

    // Geography fixtures are unnecessary here: Control Center authority is
    // is_tenant_admin()-based (§7) — scope-targeted grants play no part.
  });

  // ══ A. Authentication ══════════════════════════════════════════════
  describe("A. anonymous holds nothing", () => {
    it("A1 anon cannot activate a service", async () => {
      const r = await as(db, "anon", null, `SELECT politicore.set_tenant_module_enabled('social', true)`);
      expect(r.error).toBeDefined();
    });

    it("A2 anon cannot read the overview", async () => {
      const r = await as(db, "anon", null, `SELECT * FROM politicore.control_center_overview()`);
      expect(r.error).toBeDefined();
    });

    it("A3 anon cannot read or write configuration", async () => {
      const g = await as(db, "anon", null, `SELECT * FROM politicore.get_site_config('homepage')`);
      expect(g.error).toBeDefined();
      const s = await as(db, "anon", null, `SELECT politicore.save_site_config_draft('homepage', '{}'::jsonb, 0)`);
      expect(s.error).toBeDefined();
      const p = await as(db, "anon", null, `SELECT * FROM politicore.publish_site_config('homepage', 0)`);
      expect(p.error).toBeDefined();
    });

    it("A4 anon cannot read base config table (grants revoked) and cannot mutate it", async () => {
      const r = await as(db, "anon", null, `SELECT count(*) FROM politicore.public_site_settings`);
      expect(r.error ?? (r.rows[0] as { n: string }).n).toBeDefined();
      const w = await as(db, "anon", null,
        `UPDATE politicore.public_site_settings SET seo = '{}'::jsonb`);
      expect(w.error).toBeDefined();
    });
  });

  // ══ B. Tenant administration ═══════════════════════════════════════
  describe("B. authorized tenant admin", () => {
    it("B1 reads own overview with entitlement + activation + operational state", async () => {
      const r = await as(db, "authenticated", admin.authId, `SELECT * FROM politicore.control_center_overview()`);
      expect(r.error).toBeUndefined();
      const rows = r.rows as Array<{ module: string; entitled: boolean; enabled: boolean; operational: boolean; label: string }>;
      expect(rows.length).toBe(4);
      for (const row of rows) {
        expect(row.entitled).toBe(true);
        expect(row.enabled).toBe(true);
        expect(row.operational).toBe(true);
        expect(row.label).toBeTruthy();
      }
    });

    it("B2 can deactivate then re-activate an entitled service (non-destructive)", async () => {
      const off = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', false)`);
      expect(off.error).toBeUndefined();
      expect((off.rows[0] as { enabled: boolean }).enabled).toBe(false);
      expect((off.rows[0] as { operational: boolean }).operational).toBe(false);

      const on = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', true)`);
      expect(on.error).toBeUndefined();
      expect((on.rows[0] as { operational: boolean }).operational).toBe(true);
    });

    it("B3 data survives deactivation (no deletion)", async () => {
      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('social', false)`);
      const tm = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`,
        [tenantA]);
      expect(Number(tm.rows[0].n)).toBe(1);
      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('social', true)`);
    });
  });

  // ══ C. Unauthorized users ══════════════════════════════════════════
  describe("C. unauthorized users denied", () => {
    it("C1 ordinary member cannot activate or read overview/config", async () => {
      const a = await as(db, "authenticated", member.authId,
        `SELECT politicore.set_tenant_module_enabled('social', false)`);
      expect(a.error).toBeDefined();
      const o = await as(db, "authenticated", member.authId, `SELECT * FROM politicore.control_center_overview()`);
      expect(o.error).toBeDefined();
      const g = await as(db, "authenticated", member.authId, `SELECT * FROM politicore.get_site_config('homepage')`);
      expect(g.error).toBeDefined();
    });

    it("C2 social/campaign membership (no admin role) cannot bypass tenant-admin authority", async () => {
      const a = await as(db, "authenticated", staff.authId,
        `SELECT politicore.set_tenant_module_enabled('campaign', false)`);
      expect(a.error).toBeDefined();
    });

    it("C3 module permission grants do not confer Control Center authority (F: deny-wins by construction)", async () => {
      // A manage_cases grant on A must NOT let a member flip services —
      // the RPC's authority is is_tenant_admin(), not permission_grants.
      await db.query(
        `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
         VALUES ($1, $2, 'manage_cases', true)`, [tenantA, member.authId]);
      const a = await as(db, "authenticated", member.authId,
        `SELECT politicore.set_tenant_module_enabled('governance', false)`);
      expect(a.error).toBeDefined();
      await db.query(
        `DELETE FROM politicore.permission_grants WHERE tenant_id = $1 AND user_id = $2`,
        [tenantA, member.authId]);
    });
  });

  // ══ D. Entitlement ═════════════════════════════════════════════════
  describe("D. entitlement enforcement", () => {
    it("D1 enable succeeds for entitled service", async () => {
      await db.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, ARRAY['service_entitlements',$1::text,'social'], 'true'::jsonb, true)
          WHERE id = 1`, [tenantA]);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', false)`);
      expect(r.error).toBeUndefined();
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', true)`);
      expect(r2.error).toBeUndefined();
      expect((r2.rows[0] as { operational: boolean }).operational).toBe(true);
    });

    it("D2 enable fails for non-entitled service", async () => {
      await db.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, ARRAY['service_entitlements',$1::text,'election'], 'false'::jsonb, true)
          WHERE id = 1`, [tenantA]);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.set_tenant_module_enabled('election', true)`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("not entitled");
    });

    it("D3 stray enabled row cannot bypass entitlement (stale row is still operable DOWN, never UP)", async () => {
      // Simulate a stray enabled row for a non-entitled module.
      await db.query(
        `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'election'`,
        [tenantA]);
      // Disable (operable down — non-destructive posture) succeeds…
      const off = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('election', false)`);
      expect(off.error).toBeUndefined();
      // …but re-enable without entitlement fails.
      const up = await as(db, "authenticated", admin.authId,
        `SELECT politicore.set_tenant_module_enabled('election', true)`);
      expect(up.error).toBeDefined();
      // Overview reports the truth: entitled=false ⇒ not operational.
      const o = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.control_center_overview()`);
      const row = (o.rows as Array<{ module: string; entitled: boolean; enabled: boolean }>)
        .find((x) => x.module === "election");
      expect(row?.entitled).toBe(false);
    });

    it("D4 entitled + deactivated remains dormant, not operational", async () => {
      await db.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, ARRAY['service_entitlements',$1::text,'governance'], 'true'::jsonb, true)
          WHERE id = 1`, [tenantA]);
      const off = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('governance', false)`);
      expect(off.error).toBeUndefined();
      const o = await as(db, "authenticated", admin.authId, `SELECT * FROM politicore.control_center_overview()`);
      const row = (o.rows as Array<{ module: string; entitled: boolean; enabled: boolean; operational: boolean }>)
        .find((x) => x.module === "governance");
      expect(row?.entitled).toBe(true);
      expect(row?.enabled).toBe(false);
      expect(row?.operational).toBe(false);
    });
  });

  // ══ E. Tenant isolation ════════════════════════════════════════════
  describe("E. tenant isolation", () => {
    it("E1 tenant A admin cannot mutate tenant B's services", async () => {
      await db.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, ARRAY['service_entitlements',$1::text,'social'], 'true'::jsonb, true)
          WHERE id = 1`, [tenantA]);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', false)`);
      expect(r.error).toBeUndefined();
      // The RPC resolved A's tenant — B's social module is untouched.
      const b = await db.query<{ enabled: boolean }>(
        `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`,
        [tenantB]);
      expect(b.rows[0].enabled).toBe(false);
    });

    it("E2 tenant B admin cannot read tenant A's overview or configuration", async () => {
      const o = await as(db, "authenticated", adminB.authId, `SELECT * FROM politicore.control_center_overview()`);
      expect(o.error).toBeUndefined();
      const mods = (o.rows as Array<{ module: string }>).map((x) => x.module);
      expect(mods.length).toBe(4); // own tenant's rows only — cannot infer A
      const g = await as(db, "authenticated", adminB.authId, `SELECT * FROM politicore.get_site_config('homepage')`);
      // B has no settings row yet → empty, and certainly not A's draft.
      expect(g.error).toBeUndefined();
      expect(g.rows.length).toBe(0);
    });

    it("E3 configuration RPCs are tenant-resolved — A's draft invisible to B", async () => {
      const saved = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', '{"x":1}'::jsonb, 0)`);
      expect(saved.error).toBeUndefined();
      const b = await as(db, "authenticated", adminB.authId,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      expect(b.error).toBeUndefined();
      expect(b.rows.length).toBe(0);
    });
  });

  // ══ G. Audit ═══════════════════════════════════════════════════════
  describe("G. audit evidence", () => {
    it("G1 activation and deactivation create Core Audit records", async () => {
      const before = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE affected_resource = 'tenant_modules' AND tenant_id = $1`, [tenantA]);
      const n0 = Number(before.rows[0].n);

      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('campaign', false)`);
      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('campaign', true)`);

      const after = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE affected_resource = 'tenant_modules' AND tenant_id = $1`, [tenantA]);
      expect(Number(after.rows[0].n)).toBe(n0 + 2);

      const detail = await db.query<{ old_value: { enabled: boolean }; new_value: { enabled: boolean } }>(
        `SELECT old_value, new_value FROM politicore.system_audits
          WHERE affected_resource = 'tenant_modules' AND tenant_id = $1
          ORDER BY id DESC LIMIT 1`, [tenantA]);
      expect(detail.rows[0].old_value.enabled).toBe(false);
      expect(detail.rows[0].new_value.enabled).toBe(true);
    });

    it("G2 draft save creates a configuration audit record", async () => {
      const saved = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"T"}'::jsonb, 0)`);
      expect(saved.error).toBeUndefined();
      const audit = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE action = 'site_config:seo:draft_saved' AND tenant_id = $1`, [tenantA]);
      expect(Number(audit.rows[0].n)).toBeGreaterThanOrEqual(1);
    });
  });

  // ══ H. Concurrency ═════════════════════════════════════════════════
  describe("H. optimistic concurrency", () => {
    it("H1 current revision succeeds and advances", async () => {
      // Phase 23 note: branding payloads must satisfy the 0061 validator —
      // generic placeholder objects are now (correctly) rejected.
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"CC Core"}'::jsonb, 0) AS rev`);
      expect(r.error).toBeUndefined();
      expect(Number((r.rows[0] as { rev: number }).rev)).toBe(1);
    });

    it("H2 stale revision is rejected and does not overwrite", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Stale"}'::jsonb, 0)`);
      expect(r.error).toBeDefined();
      const cur = await as(db, "authenticated", admin.authId, `SELECT * FROM politicore.get_site_config('branding')`);
      const row = cur.rows[0] as { revision: number; draft: Record<string, unknown> | null };
      expect(row.revision).toBe(1);
      expect(row.draft).toEqual({ site_name: "CC Core" });
    });

    it("H3 publish is revision-checked and promotes the draft to published", async () => {
      const stale = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('branding', 0)`);
      expect(stale.error).toBeDefined();

      const pub = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('branding', 1)`);
      expect(pub.error).toBeUndefined();
      expect(Number((pub.rows[0] as { revision: number }).revision)).toBe(2);

      // Published state is now visible through the public wrapper —
      // and the draft key is stripped from the public projection.
      const anon = await as(db, "anon", null,
        `SELECT * FROM public.get_published_site_config('ccore-a', 'branding')`);
      expect(anon.error).toBeUndefined();
      const prow = anon.rows[0] as { published: Record<string, unknown>; area: string };
      expect(prow.area).toBe("branding");
      expect(prow.published).toEqual({ site_name: "CC Core" });
      expect(prow.published).not.toHaveProperty("draft");
    });

    it("H4 public wrapper hides unpublished areas entirely", async () => {
      const anon = await as(db, "anon", null,
        `SELECT * FROM public.get_published_site_config('ccore-a', 'seo')`);
      expect(anon.error).toBeUndefined();
      // No published state for seo → empty projection.
      expect(anon.rows.length).toBe(0);
    });

    it("H5 members cannot read drafts even when a published state exists", async () => {
      const r = await as(db, "authenticated", member.authId,
        `SELECT * FROM politicore.get_site_config('branding')`);
      expect(r.error).toBeDefined();
    });
  });

  // ══ I. Module gate ═════════════════════════════════════════════════
  describe("I. existing module gate remains authoritative", () => {
    it("I1 after disable, module_enabled fails closed; after re-enable it operates", async () => {
      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('social', false)`);
      // Evaluated in a real member-session context — module_enabled() is
      // tenant-resolved from the JWT, exactly as production gates run.
      const off = await as(db, "authenticated", member.authId,
        `SELECT politicore.module_enabled('social') AS enabled`);
      expect(off.error).toBeUndefined();
      expect((off.rows[0] as { enabled: boolean }).enabled).toBe(false);

      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('social', true)`);
      const on = await as(db, "authenticated", member.authId,
        `SELECT politicore.module_enabled('social') AS enabled`);
      expect(on.error).toBeUndefined();
      expect((on.rows[0] as { enabled: boolean }).enabled).toBe(true);
    });
  });
});
