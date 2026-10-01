/**
 * POLITICORE — PHASE 23 — WEBSITE EXPERIENCE SECURITY SUITE.
 *
 * Proves the Branding/Theme/SEO slice (migration 0061) against
 * role-impersonated sessions (helpers.as) — the same acceptance standard
 * as Phases 6–22 (§24 coverage):
 *
 *   A.  Authority        — anon holds nothing; member cannot mutate
 *                          branding/seo; tenant admin can (own tenant);
 *                          cross-tenant mutation fails.
 *   B.  Validation       — branding allowlist (unknown keys/values
 *                          rejected; custom accepts allowed values);
 *                          SEO allowlist; arbitrary CSS/JS rejected.
 *   C.  Media binding    — logo/favicon must reference a PUBLIC asset of
 *                          the SAME tenant; cross-tenant/private/missing
 *                          references are rejected.
 *   D.  Draft safety     — draft save never alters public output; public
 *                          chrome returns published only; drafts never
 *                          reach anon or another tenant.
 *   E.  Concurrency      — stale branding/seo revision rejected; current
 *                          revision succeeds; rejected mutation overwrites
 *                          nothing.
 *   F.  Public rendering — chrome projection consumes published branding;
 *                          absent/malformed branding degrades to defaults.
 *   G.  Audit            — publish/change creates Core Audit evidence with
 *                          server-resolved tenant/actor.
 *   H.  Regression guard — no new roles/permissions; public_site_settings
 *                          remains the sole substrate; presets define no
 *                          behavior (data-only registry).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  getDb,
  as,
  createTenant,
  createUser,
} from "./helpers";

describe("phase23 — website experience (branding / theme / seo)", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let admin: { authId: string };
  let member: { authId: string };

  const BRANDING_OK = JSON.stringify({
    site_name: "Tenant A",
    preset: "apc",
  });

  beforeAll(async () => {
    db = await getDb();
    tenantA = await createTenant(db, "p23wx-a", "Phase 23 Website A", { social: true });
    tenantB = await createTenant(db, "p23wx-b", "Phase 23 Website B", { social: true });
    admin = await createUser(db, {
      tenantId: tenantA,
      email: "p23wx-admin@test.local",
      fullName: "P23 Admin A",
      accessRole: "admin",
    });
    member = await createUser(db, {
      tenantId: tenantA,
      email: "p23wx-member@test.local",
      fullName: "P23 Member A",
      accessRole: "member",
    });
    // Tenant B admin — for cross-tenant isolation proofs.
    await createUser(db, {
      tenantId: tenantB,
      email: "p23wx-admin-b@test.local",
      fullName: "P23 Admin B",
      accessRole: "admin",
    });
    // A public media asset owned by tenant A (logo material).
    await db.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ('11111111-1111-4111-8111-111111111111', $1, 'local', 'bucket', 'p23/asset-a.png', 'public', 'image/png')`,
      [tenantA]
    );
    // Tenant B's public asset — must be unusable by tenant A (§16).
    await db.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ('22222222-2222-4222-8222-222222222222', $1, 'local', 'bucket', 'p23/asset-b.png', 'public', 'image/png')`,
      [tenantB]
    );
    // A private tenant-A asset — must be unusable as branding (public site).
    await db.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ('33333333-3333-4333-8333-333333333333', $1, 'local', 'bucket', 'p23/asset-priv.png', 'private', 'image/png')`,
      [tenantA]
    );
  });

  afterAll(async () => {
    // Child-first purge (settings rows are tenant-cascaded; assets are not).
    await db.query(`DELETE FROM politicore.media_assets WHERE id::text LIKE '1%' OR id::text LIKE '2%' OR id::text LIKE '3%'`);
    await db.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [
      [tenantA, tenantB],
    ]);
    await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`, [
      [admin.authId, member.authId],
    ]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [
      [admin.authId, member.authId],
    ]);
    const bAdmin = await db.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE tenant_id = $1`, [tenantB]);
    if (bAdmin.rows.length) {
      await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`, [[bAdmin.rows[0].id]]);
      await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [[bAdmin.rows[0].id]]);
    }
    await db.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [
      [tenantA, tenantB],
    ]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  });

  // ── A. Authority ─────────────────────────────────────────────────────
  describe("A. authority", () => {
    it("A1 anon cannot mutate branding or seo (no EXECUTE, no base-table grants)", async () => {
      const r1 = await as(db, "anon", null,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"X"}'::jsonb, 0)`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"X"}'::jsonb, 0)`);
      expect(r2.error).toBeDefined();
      const r3 = await as(db, "anon", null,
        `SELECT politicore.publish_site_config('branding', 0)`);
      expect(r3.error).toBeDefined();
      // Base-table grants were revoked in 0060 (§0).
      const r4 = await as(db, "anon", null, `SELECT * FROM politicore.public_site_settings`);
      expect(r4.error).toBeDefined();
    });

    it("A2 anon cannot read the admin preview RPC", async () => {
      const r = await as(db, "anon", null,
        `SELECT politicore.get_site_config_preview('branding')`);
      expect(r.error).toBeDefined();
    });

    it("A3 ordinary member cannot mutate branding or seo", async () => {
      const r1 = await as(db, "authenticated", member.authId,
        `SELECT politicore.save_site_config_draft('branding', ${`'${BRANDING_OK}'`}::jsonb, 0)`);
      expect(r1.error).toBeDefined();
      expect(r1.error).toContain("Tenant administration authority");
      const r2 = await as(db, "authenticated", member.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"X"}'::jsonb, 0)`);
      expect(r2.error).toBeDefined();
    });

    it("A4 tenant admin can mutate own branding and seo", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Tenant A","preset":"apc"}'::jsonb, 0)`);
      expect(r1.error).toBeUndefined();
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"Tenant A site"}'::jsonb, 0)`);
      expect(r2.error).toBeUndefined();
    });

    it("A5 tenant B admin cannot mutate tenant A configuration", async () => {
      // B's session resolves current_tenant_id() to B — the RPC scopes every
      // statement to the caller's own tenant row, so A's config is untouched.
      const before = await db.query<{ branding: unknown }>(
        `SELECT branding FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      await as(db, "authenticated", (await db.query<{ id: string }>(
        `SELECT id FROM politicore.profiles WHERE tenant_id = $1 AND access_role = 'admin'`, [tenantB]
      )).rows[0].id,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Hijack"}'::jsonb, 999)`);
      const after = await db.query<{ branding: unknown }>(
        `SELECT branding FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(after.rows[0].branding).toEqual(before.rows[0].branding);
    });
  });

  // ── B. Validation ────────────────────────────────────────────────────
  describe("B. configuration validation (allowlists)", () => {
    it("B1 branding rejects unknown top-level keys", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"mystery_key":1}'::jsonb, 1)`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("Unknown branding configuration key");
    });

    it("B2 branding rejects unknown tokens and non-hex values", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"tokens":{"brand_puce":"#123456"}}'::jsonb, 1)`);
      expect(r1.error).toContain("Unknown branding token");
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"tokens":{"primary":"red"}}'::jsonb, 1)`);
      expect(r2.error).toContain("#rrggbb");
    });

    it("B3 branding rejects unknown presets, typography and radius values", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"preset":"apc-behavior"}'::jsonb, 1)`);
      expect(r1.error).toContain("Unknown branding preset");
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"typography":{"heading":"comic-sans"}}'::jsonb, 1)`);
      expect(r2.error).toContain("sans, serif or mono");
      const r3 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"radius":"99px"}'::jsonb, 1)`);
      expect(r3.error).toContain("radius");
    });

    it("B4 custom accepts allowed values (custom preset + valid token overrides)", async () => {
      const cfg = JSON.stringify({
        preset: "custom",
        tokens: { primary: "#0a6b3d", secondary: "#d71920" },
        typography: { heading: "serif", body: "sans" },
        radius: "md",
      });
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '${cfg}'::jsonb, 1)`);
      expect(r.error).toBeUndefined();
    });

    it("B5 arbitrary CSS/JS payloads are rejected (no injection surface)", async () => {
      // A CSS string cannot pass: 'tokens' values must be #rrggbb, and there
      // is no key that accepts free text except the length-capped site_name.
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"tokens":{"primary":"javascript:alert(1)"}}'::jsonb, 1)`);
      expect(r1.error).toContain("#rrggbb");
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"custom_css":"<style>x</style>"}'::jsonb, 1)`);
      expect(r2.error).toContain("Unknown branding configuration key");
    });

    it("B6 seo rejects unknown keys and oversized values", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"page_title_map":{}}'::jsonb, 1)`);
      expect(r1.error).toContain("Unknown SEO configuration key");
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"description":"${"x".repeat(301)}"}'::jsonb, 1)`);
      expect(r2.error).toContain("at most 300");
      const r3 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"canonical_url":"not-a-url"}'::jsonb, 1)`);
      expect(r3.error).toContain("absolute http(s)");
    });
  });

  // ── C. Media binding ─────────────────────────────────────────────────
  describe("C. core media binding", () => {
    it("C1 logo referencing own PUBLIC asset is accepted", async () => {
      const cfg = JSON.stringify({
        logo: { asset_id: "11111111-1111-4111-8111-111111111111" },
      });
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '${cfg}'::jsonb, 2)`);
      expect(r.error).toBeUndefined();
    });

    it("C2 cross-tenant media reference is rejected", async () => {
      const cfg = JSON.stringify({
        logo: { asset_id: "22222222-2222-4222-8222-222222222222" },
      });
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '${cfg}'::jsonb, 3)`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("public media asset of this tenant");
    });

    it("C3 private asset and missing asset references are rejected", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"logo":{"asset_id":"33333333-3333-4333-8333-333333333333"}}'::jsonb, 3)`);
      expect(r1.error).toContain("public media asset");
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"favicon":{"asset_id":"44444444-4444-4444-8444-444444444444"}}'::jsonb, 3)`);
      expect(r2.error).toContain("public media asset");
    });

    it("C4 the public brand-asset RPC returns only own-tenant public assets", async () => {
      const slugA = "p23wx-a";
      // Public asset of the public tenant → resolves.
      const ok = await as(db, "anon", null,
        `SELECT * FROM public.get_public_brand_asset('${slugA}', '11111111-1111-4111-8111-111111111111'::uuid)`);
      expect(ok.error).toBeUndefined();
      expect(ok.rows.length).toBe(1);
      // Tenant B's asset through tenant A's slug → no row (no existence leak).
      const cross = await as(db, "anon", null,
        `SELECT * FROM public.get_public_brand_asset('${slugA}', '22222222-2222-4222-8222-222222222222'::uuid)`);
      expect(cross.rows.length).toBe(0);
      // Private asset of the public tenant → no row.
      const priv = await as(db, "anon", null,
        `SELECT * FROM public.get_public_brand_asset('${slugA}', '33333333-3333-4333-8333-333333333333'::uuid)`);
      expect(priv.rows.length).toBe(0);
    });
  });

  // ── D. Draft safety / public projection ──────────────────────────────
  describe("D. draft safety and public projection", () => {
    it("D1 saving a draft does not change the published chrome", async () => {
      // Publish a known state first.
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.publish_site_config('branding', 4)`);
      const chromeBefore = await as(db, "anon", null,
        `SELECT public.get_public_site_chrome('p23wx-a') AS c`);
      const before = (chromeBefore.rows[0] as { c: { branding: { site_name?: string } } }).c;

      // Save a DRAFT with a different site name (does not publish).
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Draft Only Name"}'::jsonb, 5)`);
      const chromeAfter = await as(db, "anon", null,
        `SELECT public.get_public_site_chrome('p23wx-a') AS c`);
      const after = (chromeAfter.rows[0] as { c: { branding: { site_name?: string } } }).c;
      expect(after.branding.site_name).toBe(before.branding.site_name);
    });

    it("D2 public chrome returns published only — draft keys never leak", async () => {
      const r = await as(db, "anon", null,
        `SELECT public.get_public_site_chrome('p23wx-a') AS c`);
      const chrome = (r.rows[0] as { c: Record<string, unknown> }).c;
      const branding = chrome.branding as Record<string, unknown>;
      expect(branding).not.toHaveProperty("draft");
      expect(branding).not.toHaveProperty("history");
      expect(branding).not.toHaveProperty("updated_by");
      expect(branding).not.toHaveProperty("revision");
    });

    it("D3 draft is never returned to anon or another tenant via preview RPC", async () => {
      // Tenant B admin previewing THEIR tenant must not see A's draft.
      const bAdminId = (await db.query<{ id: string }>(
        `SELECT id FROM politicore.profiles WHERE tenant_id = $1 AND access_role = 'admin'`, [tenantB]
      )).rows[0].id;
      const r = await as(db, "authenticated", bAdminId,
        `SELECT politicore.get_site_config_preview('branding') AS p`);
      const preview = (r.rows[0] as { p: Record<string, unknown> }).p;
      expect((preview.site_name as string ?? "")).not.toBe("Draft Only Name");
    });

    it("D4 unconfigured tenant receives empty chrome (fallback-safe)", async () => {
      const r = await as(db, "anon", null,
        `SELECT public.get_public_site_chrome('p23wx-b') AS c`);
      const chrome = (r.rows[0] as { c: { branding: unknown; seo: unknown } }).c;
      expect(chrome.branding).toEqual({});
      expect(chrome.seo).toEqual({});
    });
  });

  // ── E. Concurrency ───────────────────────────────────────────────────
  describe("E. optimistic concurrency", () => {
    it("E1 stale branding revision is rejected and overwrites nothing", async () => {
      const current = await db.query<{ n: string }>(
        `SELECT COALESCE((branding->>'revision')::text,'0') n FROM politicore.public_site_settings WHERE tenant_id = $1`,
        [tenantA]);
      const rev = Number(current.rows[0]?.n ?? "0");
      // Write with a STALE base revision.
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Stale"}'::jsonb, ${rev - 1})`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("Configuration conflict");
      // Published output unchanged.
      const chrome = await as(db, "anon", null, `SELECT public.get_public_site_chrome('p23wx-a') AS c`);
      const c = (chrome.rows[0] as { c: { branding: { site_name?: string } } }).c;
      expect(c.branding.site_name).not.toBe("Stale");
    });

    it("E2 current-revision branding mutation succeeds and advances the revision", async () => {
      const current = await db.query<{ n: string }>(
        `SELECT COALESCE((branding->>'revision')::text,'0') n FROM politicore.public_site_settings WHERE tenant_id = $1`,
        [tenantA]);
      const rev = Number(current.rows[0]?.n ?? "0");
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Current Write"}'::jsonb, ${rev})`);
      expect(r.error).toBeUndefined();
      expect(Number((r.rows[0] as { save_site_config_draft: number }).save_site_config_draft)).toBe(rev + 1);
    });

    it("E3 stale SEO revision is rejected; current succeeds", async () => {
      const current = await db.query<{ n: string }>(
        `SELECT COALESCE((seo->>'revision')::text,'0') n FROM politicore.public_site_settings WHERE tenant_id = $1`,
        [tenantA]);
      const rev = Number(current.rows[0]?.n ?? "0");
      const stale = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"Stale SEO"}'::jsonb, ${rev - 1})`);
      expect(stale.error).toContain("Configuration conflict");
      const good = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"Current SEO"}'::jsonb, ${rev})`);
      expect(good.error).toBeUndefined();
    });
  });

  // ── F. Public rendering semantics ────────────────────────────────────
  describe("F. public rendering contract", () => {
    it("F1 published branding reaches the public chrome with full payload", async () => {
      // Publish the current draft; chrome must carry its tokens/preset.
      const current = await db.query<{ n: string }>(
        `SELECT COALESCE((branding->>'revision')::text,'0') n FROM politicore.public_site_settings WHERE tenant_id = $1`,
        [tenantA]);
      const rev = Number(current.rows[0]?.n ?? "0");
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.publish_site_config('branding', ${rev})`);
      const chrome = await as(db, "anon", null, `SELECT public.get_public_site_chrome('p23wx-a') AS c`);
      const branding = (chrome.rows[0] as { c: { branding: Record<string, unknown> } }).c.branding;
      expect(branding.site_name).toBe("Current Write");
    });

    it("F2 presets are data-only — the registry defines no behavior", async () => {
      // Static guard: the preset registry may not reference authorization,
      // routing, modules or permissions.
      const { readFileSync } = await import("node:fs");
      const src = readFileSync("src/lib/branding/presets.ts", "utf8");
      expect(src).not.toMatch(/has_permission|set_tenant_module_enabled|module_enabled|router\.|navigate|grant\(/);
    });
  });

  // ── G. Audit ─────────────────────────────────────────────────────────
  describe("G. core audit", () => {
    it("G1 branding publish creates auditable evidence with server-resolved actor", async () => {
      const before = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE action = 'site_config:branding:published' AND tenant_id = $1`, [tenantA]);
      const n0 = Number(before.rows[0].n);
      const current = await db.query<{ n: string }>(
        `SELECT COALESCE((branding->>'revision')::text,'0') n FROM politicore.public_site_settings WHERE tenant_id = $1`,
        [tenantA]);
      const rev = Number(current.rows[0]?.n ?? "0");
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('branding', '{"site_name":"Audited"}'::jsonb, ${rev})`);
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.publish_site_config('branding', ${rev + 1})`);
      const after = await db.query<{ n: string; actor: string }>(
        `SELECT count(*)::text n, max(actor_id::text) actor FROM politicore.system_audits
          WHERE action = 'site_config:branding:published' AND tenant_id = $1`, [tenantA]);
      expect(Number(after.rows[0].n)).toBe(n0 + 1);
      expect(after.rows[0].actor).toBe(admin.authId);
    });

    it("G2 SEO changes are audited through the same convention", async () => {
      const current = await db.query<{ n: string }>(
        `SELECT COALESCE((seo->>'revision')::text,'0') n FROM politicore.public_site_settings WHERE tenant_id = $1`,
        [tenantA]);
      const rev = Number(current.rows[0]?.n ?? "0");
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('seo', '{"title":"Audited SEO"}'::jsonb, ${rev})`);
      const audit = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE action = 'site_config:seo:draft_saved' AND tenant_id = $1`, [tenantA]);
      expect(Number(audit.rows[0].n)).toBeGreaterThanOrEqual(1);
    });
  });

  // ── H. Regression guard ──────────────────────────────────────────────
  describe("H. regression guard", () => {
    it("H1 no new roles or permissions were introduced", async () => {
      const roles = await db.query<{ role: string }>(
        `SELECT unnest(enum_range(NULL::politicore.access_role_enum))::text AS role`);
      const names = roles.rows.map((r) => r.role).sort();
      expect(names).toEqual(["admin", "election_officer", "member", "platform_super_admin", "tenant_super_admin"]);
    });

    it("H2 public_site_settings remains the sole configuration substrate (no new tables)", async () => {
      const t = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM information_schema.tables
          WHERE table_schema = 'politicore'
            AND (table_name ILIKE '%branding%' OR table_name ILIKE '%theme%'
                 OR table_name ILIKE '%website%' OR table_name ILIKE '%seo%')`);
      expect(Number(t.rows[0].n)).toBe(0);
    });

    it("H3 phase 22 control-center suite invariants still hold (activation untouched)", async () => {
      // Branding work must not have altered service activation semantics.
      // social is NOT entitled in this suite's fixture — first prove the
      // entitlement gate still refuses, then entitle + activate (the
      // Phase 22 D/E journey), then restore the dormant state.
      const denied = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', true)`);
      expect(denied.error).toContain("not entitled");
      // Single-level path: jsonb_set cannot create MISSING INTERMEDIATE
      // path keys (the Phase 22 finding), so merge the tenant key via ||.
      await db.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb),
                 ARRAY['service_entitlements'],
                 COALESCE(settings->'service_entitlements','{}'::jsonb)
                   || jsonb_build_object($1::text, jsonb_build_object('social', true)),
                 true)
          WHERE id = 1`, [tenantA]);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.set_tenant_module_enabled('social', true)`);
      expect(r.error).toBeUndefined();
      const row = r.rows[0] as { entitled: boolean; enabled: boolean; operational: boolean };
      expect(row.enabled).toBe(true);
      expect(row.operational).toBe(true);
      // Restore.
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.set_tenant_module_enabled('social', false)`);
    });
  });
});
