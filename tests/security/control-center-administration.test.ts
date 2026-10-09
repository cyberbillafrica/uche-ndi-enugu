/**
 * POLITICORE — GOVERNANCE PHASE 26 — CONTROL CENTER ADMINISTRATION
 * SECURITY SUITE.
 *
 * Proves the Administration integration (migration 0064 + code-side
 * registry) against role-impersonated sessions (helpers.as) — the same
 * acceptance standard as Phases 6–25 (prompt §28 coverage):
 *
 *   A.  Control Center authority — anon/member hold nothing; tenant admin
 *       can; status RPC requires is_tenant_admin; no new permission.
 *   B.  Module activation       — entitlement false → cannot activate;
 *       entitlement true + admin → works; member cannot; tenant-local;
 *       deactivation non-destructive; module gate stays authoritative.
 *   C.  Authorization separation— Control Center access does NOT bypass
 *       module permission checks; direct module authority unchanged.
 *   D.  Configuration status    — status reflects published configuration;
 *       drafts never leak payloads; tenant isolation; missing row safe.
 *   E.  Link-out integrity      — one canonical typed registry; all
 *       destinations exist on disk; no duplicate console introduced.
 *   F.  Architecture            — no new role/permission/enum/tables; no
 *       duplicate audit/notification/media/analytics subsystems; no
 *       dynamic DB-driven routes; existing RPC ownership preserved.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { PGlite } from "@electric-sql/pglite";
import { getDb, as, createTenant, createUser } from "./helpers";

const E = "p26adm";
const ROOT = process.cwd();

// The canonical Phase 26 registry under test (imported, not duplicated).
import {
  CORE_ADMIN_LINKS,
  MODULE_ADMIN_LINKS,
  WEBSITE_ADMIN_LINKS,
} from "../../src/lib/control-center/admin-registry";

/** Migration file inventory (architecture pins). */
const migrationFiles = () =>
  fs
    .readdirSync(path.join(ROOT, "supabase", "migrations"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

describe("phase26 — control center administration", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let admin: { authId: string };
  let member: { authId: string };
  let adminB: { authId: string };
  // Original platform singleton row (restored in afterAll).
  let originalSettings: unknown;

  beforeAll(async () => {
    db = await getDb();
    tenantA = await createTenant(db, "p26adm-a", "Phase 26 Admin A", { social: false, campaign: false });
    tenantB = await createTenant(db, "p26adm-b", "Phase 26 Admin B", {});

    // Platform entitlements: A entitled for social+campaign only; B nothing.
    const cur = await db.query(`SELECT settings FROM politicore.platform_settings WHERE id = 1`);
    originalSettings = cur.rows[0] ? (cur.rows[0] as Record<string, unknown>).settings : null;
    await db.query(
      `INSERT INTO politicore.platform_settings (id, settings)
       VALUES (1, jsonb_build_object('service_entitlements', jsonb_build_object(
         $1::text, jsonb_build_object('social', true, 'campaign', true, 'election', false, 'governance', false))))
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings`,
      [tenantA]
    );

    admin = await createUser(db, { tenantId: tenantA, email: `${E}-adm@test.local`, fullName: "P26 Admin A", accessRole: "admin" });
    member = await createUser(db, { tenantId: tenantA, email: `${E}-mem@test.local`, fullName: "P26 Member A", accessRole: "member" });
    adminB = await createUser(db, { tenantId: tenantB, email: `${E}-admb@test.local`, fullName: "P26 Admin B", accessRole: "admin" });
  });

  afterAll(async () => {
    // Child-first purge; restore the platform singleton to its pre-test state.
    await db.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`, [[admin.authId, member.authId, adminB.authId]]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [[admin.authId, member.authId, adminB.authId]]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
    if (originalSettings !== null) {
      await db.query(`UPDATE politicore.platform_settings SET settings = $1::jsonb WHERE id = 1`, [JSON.stringify(originalSettings)]);
    }
  });

  // ══ A. Control Center authority ═════════════════════════════════════
  describe("A. control center authority", () => {
    it("A1 anon holds nothing on the administration surfaces", async () => {
      const r1 = await as(db, "anon", null, `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null, `SELECT * FROM politicore.control_center_overview()`);
      expect(r2.error).toBeDefined();
      const r3 = await as(db, "anon", null, `SELECT * FROM public.control_center_site_config_status()`);
      expect(r3.error).toBeDefined();
    });

    it("A2 ordinary member cannot read administration status or overview", async () => {
      const r1 = await as(db, "authenticated", member.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "authenticated", member.authId, `SELECT * FROM politicore.control_center_overview()`);
      expect(r2.error).toBeDefined();
    });

    it("A3 tenant admin reads configuration status", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(r.error).toBeUndefined();
      expect(r.rows.length).toBe(5);
      const areas = r.rows.map((x) => (x as Record<string, unknown>).area);
      expect(areas).toEqual(["branding", "seo", "homepage", "navigation", "footer"]);
    });

    it("A4 tenant B admin cannot read tenant A status (server-resolved tenant)", async () => {
      // Seed a status fingerprint into tenant A only. The save advances the
      // revision to 1; the publish must target the CURRENT revision.
      const saved = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', '{"sections":[]}'::jsonb, 0) AS r`);
      expect(saved.error).toBeUndefined();
      const rev = Number((saved.rows[0] as { r: number }).r);
      const published = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('homepage', $1)`, [rev]);
      expect(published.error).toBeUndefined();
      const rB = await as(db, "authenticated", adminB.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(rB.error).toBeUndefined();
      // B sees only its own (empty) row set — never A's published homepage.
      const bHome = rB.rows.find((x) => (x as Record<string, unknown>).area === "homepage");
      expect((bHome as Record<string, unknown>).published).toBe(false);
    });

    it("A5 no new permission was introduced for Control Center administration", async () => {
      const p = await db.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.permissions`);
      expect(Number(p.rows[0].n)).toBe(43);
      const cc = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.permissions WHERE name LIKE '%control%' OR name LIKE '%admin%'`);
      expect(Number(cc.rows[0].n)).toBe(0);
    });
  });

  // ══ B. Module activation ════════════════════════════════════════════
  describe("B. module activation (existing Phase 22 mechanism)", () => {
    it("B1 entitlement false → admin cannot activate", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.set_tenant_module_enabled('election', true)`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("not entitled");
    });

    it("B2 entitlement true + tenant admin → activation works", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', true)`);
      expect(r.error).toBeUndefined();
      expect((r.rows[0] as Record<string, unknown>).operational).toBe(true);
    });

    it("B3 ordinary member cannot activate", async () => {
      const r = await as(db, "authenticated", member.authId,
        `SELECT politicore.set_tenant_module_enabled('social', false)`);
      expect(r.error).toBeDefined();
    });

    it("B4 activation state is tenant-local (B unaffected by A's toggle)", async () => {
      const rB = await db.query<{ enabled: boolean }>(
        `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`, [tenantB]);
      expect(rB.rows[0].enabled).toBe(false);
    });

    it("B5 deactivation is non-destructive and hides the module gate", async () => {
      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('social', false)`);
      const row = await db.query<{ enabled: boolean }>(
        `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
      expect(row.rows[0].enabled).toBe(false);
      const gate = await as(db, "authenticated", member.authId,
        `SELECT politicore.module_enabled('social') AS enabled`);
      expect((gate.rows[0] as Record<string, unknown>).enabled).toBe(false);
      await as(db, "authenticated", admin.authId, `SELECT politicore.set_tenant_module_enabled('social', true)`);
      const gate2 = await as(db, "authenticated", member.authId,
        `SELECT politicore.module_enabled('social') AS enabled`);
      expect((gate2.rows[0] as Record<string, unknown>).enabled).toBe(true);
    });
  });

  // ══ C. Authorization separation ═════════════════════════════════════
  describe("C. authorization separation (§16)", () => {
    it("C1 module authority flows only from Core's resolver — never from Control Center", async () => {
      // Core's resolver grants admins everything by pre-existing design
      // (rule 1 of has_permission) — that is Core's model, untouched. What
      // Phase 26 must prove: Control Center introduces NO new authority
      // path. The admin holds zero permission_grants (role-derived only),
      // and a member gains nothing by merely being able to see the portal.
      const grants = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.permission_grants WHERE user_id = $1`, [admin.authId]);
      expect(Number(grants.rows[0].n)).toBe(0);
      const denied = await as(db, "authenticated", member.authId,
        `SELECT politicore.has_permission('view_area') AS ok`);
      expect(denied.error).toBeUndefined();
      expect((denied.rows[0] as Record<string, unknown>).ok).toBe(false);
    });

    it("C2 direct module authority remains permission-driven (grant required)", async () => {
      // With an explicit Core grant, the member gains exactly that authority;
      // Control Center played no part.
      await db.query(
        `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
         VALUES ($1, $2, 'view_area', true)`, [tenantA, member.authId]);
      const granted = await as(db, "authenticated", member.authId,
        `SELECT politicore.has_permission('view_area') AS ok`);
      expect(granted.error).toBeUndefined();
      expect((granted.rows[0] as Record<string, unknown>).ok).toBe(true);
      await db.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = $1`, [tenantA]);
      const revoked = await as(db, "authenticated", member.authId,
        `SELECT politicore.has_permission('view_area') AS ok`);
      expect((revoked.rows[0] as Record<string, unknown>).ok).toBe(false);
    });
  });

  // ══ D. Configuration status ═════════════════════════════════════════
  describe("D. configuration status summary (§20)", () => {
    it("D1 status reflects published configuration and never payloads", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(r.error).toBeUndefined();
      const home = r.rows.find((x) => (x as Record<string, unknown>).area === "homepage") as Record<string, unknown>;
      expect(home.published).toBe(true);
      expect(home.has_config).toBe(true);
      expect(home.published_at).not.toBeNull();
      // Status must not carry payloads, history or revision internals.
      const keys = Object.keys(home);
      expect(keys.sort()).toEqual(["area", "has_config", "published", "published_at"].sort());
    });

    it("D2 draft-only area shows has_config without published", async () => {
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '{"columns":[]}'::jsonb, 0) AS r`);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      const footer = r.rows.find((x) => (x as Record<string, unknown>).area === "footer") as Record<string, unknown>;
      expect(footer.has_config).toBe(true);
      expect(footer.published).toBe(false);
      expect(footer.published_at).toBeNull();
    });

    it("D3 status is read-only and aggregates only (no draft/payload exposure)", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(r.error).toBeUndefined();
      for (const row of r.rows) {
        const o = row as Record<string, unknown>;
        expect(o).not.toHaveProperty("draft");
        expect(o).not.toHaveProperty("published_payload");
        expect(o).not.toHaveProperty("history");
        expect(o).not.toHaveProperty("revision");
        expect(o).not.toHaveProperty("published_by");
      }
    });

    it("D4 missing settings row yields all-false status (never an error)", async () => {
      // Tenant B has no settings row and no configuration.
      const r = await as(db, "authenticated", adminB.authId,
        `SELECT * FROM politicore.control_center_site_config_status()`);
      expect(r.error).toBeUndefined();
      expect(r.rows.length).toBe(5);
      for (const row of r.rows) {
        const o = row as Record<string, unknown>;
        expect(o.has_config).toBe(false);
        expect(o.published).toBe(false);
      }
    });
  });

  // ══ E. Link-out integrity (§28 link-out integrity) ══════════════════
  describe("E. link-out integrity", () => {
    it("E1 module links point at canonical existing consoles (routes exist on disk)", () => {
      const expected: Record<string, string> = {
        social: "/portal/admin/tasks",
        campaign: "/portal/campaign/coordination",
        election: "/portal/election",
        governance: "/portal/governance",
      };
      for (const code of Object.keys(MODULE_ADMIN_LINKS) as Array<keyof typeof MODULE_ADMIN_LINKS>) {
        const link = MODULE_ADMIN_LINKS[code];
        expect(link.href).toBe(expected[code]);
        const rel = link.href.replace(/^\//, "");
        expect(fs.existsSync(path.join(ROOT, "src", "app", rel, "page.tsx")), `${link.href} must exist`).toBe(true);
      }
    });

    it("E2 core links point at canonical existing surfaces", () => {
      const expected = new Set([
        "/portal/admin/members",
        "/portal/admin/settings",
        "/portal/admin/audit-logs",
        "/portal/admin/health",
      ]);
      expect(CORE_ADMIN_LINKS.length).toBe(expected.size);
      for (const l of CORE_ADMIN_LINKS) {
        expect(expected.has(l.href)).toBe(true);
        const rel = l.href.replace(/^\//, "");
        expect(fs.existsSync(path.join(ROOT, "src", "app", rel, "page.tsx")), `${l.href} must exist`).toBe(true);
      }
    });

    it("E3 website links point at the Phase 22–25 editors (no duplicates)", () => {
      const expected = new Set([
        "/portal/control-center/website/branding",
        "/portal/control-center/website/seo",
        "/portal/control-center/website/homepage",
        "/portal/control-center/website/navigation",
        "/portal/control-center/website/header",
        "/portal/control-center/website/footer",
      ]);
      for (const l of WEBSITE_ADMIN_LINKS) {
        expect(expected.has(l.href)).toBe(true);
        const rel = l.href.replace(/^\//, "");
        expect(fs.existsSync(path.join(ROOT, "src", "app", rel, "page.tsx")), `${l.href} must exist`).toBe(true);
      }
    });

    it("E4 no duplicate module console was introduced under control-center", () => {
      // Only the pre-existing website editor routes exist beneath
      // /portal/control-center — no business-module consoles.
      const ccDir = path.join(ROOT, "src", "app", "portal", "control-center");
      const pageFiles: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name === "page.tsx") pageFiles.push(path.relative(ccDir, p).replace(/\\/g, "/"));
        }
      };
      walk(ccDir);
      const allowed = new Set([
        "page.tsx",
        "administration/page.tsx",
        "website/branding/page.tsx",
        "website/seo/page.tsx",
        "website/homepage/page.tsx",
        "website/homepage/preview/page.tsx",
        "website/navigation/page.tsx",
        "website/header/page.tsx",
        "website/footer/page.tsx",
      ]);
      for (const f of pageFiles) expect(allowed.has(f), `unexpected control-center route ${f}`).toBe(true);
    });
  });

  // ══ F. Architecture ═════════════════════════════════════════════════
  describe("F. architecture invariants (§28 architecture)", () => {
    it("F1 no new migration substrate: only the 0064 function addition", () => {
      const files = migrationFiles();
      // Phase 28 shipped 0065 AFTER this suite's phase; the Phase 26
      // substrate invariant is pinned by NAME to 0064, not by recency.
      expect(files).toContain("0064_control_center_administration.sql");
      const src = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "0064_control_center_administration.sql"), "utf8");
      expect(src).not.toMatch(/CREATE TABLE/i);
      expect(src).not.toMatch(/CREATE TYPE/i);
      expect(src).not.toMatch(/ALTER ROLE/i);
      expect(src).not.toMatch(/INSERT INTO politicore\.permissions/i);
      expect(src).not.toMatch(/GRANT .* ON TABLE/i);
    });

    it("F2 Control Center remains outside module_code_enum", () => {
      const q = db.query<{ s: string }>(
        `SELECT string_agg(v::text, ',') s FROM unnest(enum_range(NULL::politicore.module_code_enum)) v`);
      return q.then((r) => {
        expect(r.rows[0].s).toBe("social,campaign,election,governance");
      });
    });

    it("F3 the administration surface introduces no duplicate audit/notification/media systems", () => {
      // Core Audit remains the only audit surface; the Phase 26 RPC performs
      // no writes at all (STABLE read-only summary).
      const def = db.query<{ d: string }>(
        `SELECT pg_get_functiondef(to_regproc('politicore.control_center_site_config_status')) d`);
      return def.then((r) => {
        const body = r.rows[0].d;
        expect(body).toContain("STABLE");
        expect(body).not.toMatch(/INSERT INTO/i);
        expect(body).not.toMatch(/DELETE FROM/i);
        expect(body).not.toMatch(/UPDATE /i);
        expect(body).toContain("is_tenant_admin");
        expect(body).toContain("current_tenant_id()");
      });
    });

    it("F4 no dynamic database-driven routes in the administration surface", () => {
      const page = fs.readFileSync(
        path.join(ROOT, "src", "app", "portal", "control-center", "administration", "page.tsx"), "utf8");
      expect(page).not.toMatch(/dynamic\s*\(/);
      // All hrefs come from the static registry.
      expect(page).toContain("admin-registry");
      const registry = fs.readFileSync(
        path.join(ROOT, "src", "lib", "control-center", "admin-registry.ts"), "utf8");
      // No component names / dynamic import machinery in the registry.
      expect(registry).not.toMatch(/import\(/);
      expect(registry).not.toMatch(/\.tsx/);
    });

    it("F5 removed campaign modules remain absent from the administration registry", () => {
      const registry = fs.readFileSync(
        path.join(ROOT, "src", "lib", "control-center", "admin-registry.ts"), "utf8");
      expect(registry.toLowerCase()).not.toContain("communication");
      expect(registry.toLowerCase()).not.toContain("calendar");
      expect(registry.toLowerCase()).not.toContain("documents");
    });
  });
});
