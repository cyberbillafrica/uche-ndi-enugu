/**
 * POLITICORE — Control Center Administration (Phase 26) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 26
 * administration integration end-to-end through the real PostgREST data API
 * and real GoTrue identities — the same acceptance standard as Phases 6–25
 * (prompt §29 journeys):
 *
 *   J1  — clean tenant provisioning (A entitled; B bare; no settings rows)
 *   J2  — tenant-admin access (overview + status readable)
 *   J3  — ordinary member denial
 *   J4  — anonymous denial
 *   J5  — service entitlement state represented per module
 *   J6  — activation state lifecycle (enable → operational; disable → dormant)
 *   J7  — enable/disable is non-destructive and tenant-local
 *   J8  — module status display (entitled/activated/operational tri-state)
 *   J9  — module link-out integrity (canonical consoles pinned client-side)
 *   J10 — Core link-out integrity (canonical Core surfaces pinned client-side)
 *   J11 — website configuration status (draft vs published facets)
 *   J12 — system health seam intact (legacy health page remains the surface)
 *   J13 — tenant isolation (B never sees A's status)
 *   J14 — module authorization separation (grant-driven, CC-neutral)
 *   J15 — no cross-tenant status leakage via public wrappers
 *   J16 — audit integrity for actual mutations (activation + publish)
 *   J17 — pristine residue cleanup
 *   J18 — FORCE RLS restored
 *
 * No test tenants, profiles, settings, audits or entitlement residue remain.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

function loadEnv(): Record<string, string> {
  const vals: Record<string, string> = {};
  const file = path.resolve(".env.local");
  if (!fs.existsSync(file)) return vals;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) vals[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vals;
}
const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SUFFIX = Date.now().toString(36);
if (!SUPABASE_URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / publishable key in .env.local");
  process.exit(1);
}

async function rest(
  method: string, url: string, body?: unknown, token?: string
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(SUPABASE_URL + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, text };
}

function arr(j: unknown): Record<string, unknown>[] {
  return Array.isArray(j) ? (j as Record<string, unknown>[]) : [];
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

async function rpcCall(
  name: string, body: unknown, token?: string
): Promise<{ status: number; json: unknown; bodyText: string }> {
  const r = await rest("POST", `/rest/v1/rpc/${name}`, body, token);
  if (r.status >= 400) {
    console.log(`    [${name} → ${r.status}] ${r.text.slice(0, 220)}`);
  }
  return { status: r.status, json: r.json, bodyText: r.text };
}

async function createAuthUser(
  sql: pg.Client, email: string, password: string, fullName: string, slug: string
): Promise<string> {
  const userId = crypto.randomUUID();
  await sql.query(
    `INSERT INTO auth.users (
       id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
       is_super_admin, encrypted_password, created_at, updated_at, email_confirmed_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       phone, phone_change_token, phone_change
     )
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
             jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
             jsonb_build_object('tenant_slug', $5::text, 'full_name', $4::text),
             false,
             extensions.crypt($3, extensions.gen_salt('bf', 10)), now(), now(), now(),
             '', '', '', '',
             $6, '', '')
     RETURNING id`,
    [userId, email, password, fullName, slug, "+8" + userId.replace(/-/g, "").slice(0, 12)]
  );
  await sql.query(
    `INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data,
                                  last_sign_in_at, created_at, updated_at)
     VALUES ($1::uuid, $1::uuid, 'email', 'email',
             jsonb_build_object('sub', $1::uuid::text, 'email', $2::text, 'email_verified', true),
             now(), now(), now())
     ON CONFLICT DO NOTHING`,
    [userId, email]
  );
  return userId;
}

async function signin(email: string, password: string): Promise<string> {
  const si = await rest("POST", "/auth/v1/token?grant_type=password", { email, password });
  if (si.status !== 200)
    throw new Error(`signin failed (${si.status}): ${JSON.stringify(si.json).slice(0, 200)}`);
  return (si.json as { access_token: string }).access_token;
}

async function cleanup(
  sql: pg.Client, tenantIds: string[], emails: string[]
): Promise<string[]> {
  try {
    const CLEAN_TABLES = [
      "tenant_modules", "system_audits", "permission_grants", "notifications",
      "media_assets", "public_site_settings", "profiles", "tenants",
    ];
    const forceState = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [CLEAN_TABLES]);
    const wasForced = forceState.rows.filter((r) => r.forced).map((r) => r.relname);
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} NO FORCE ROW LEVEL SECURITY`);
    }
    try {
      await sql.query("SET session_replication_role = replica");
      for (let pass = 0; pass < 3; pass++) {
        await sql.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.media_assets WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
      }
      // Restore the pre-test entitlement map for the removed tenants.
      await sql.query(
        `UPDATE politicore.platform_settings
            SET settings = settings - $1::text[]
          WHERE id = 1`, [tenantIds]);
    } finally {
      await sql.query("SET session_replication_role = DEFAULT");
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
    return wasForced;
  } catch (e) {
    console.error("cleanup incomplete — remove control-center administration fixtures manually:", (e as Error).message);
    return [];
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `CcAdm!${SUFFIX}`;
  const SLUG = `ccadm-${SUFFIX}`;
  const SLUG_B = `ccadmb-${SUFFIX}`;

  try {
    // ── Fixtures: tenant A (entitled: social) + bare tenant B. ──────────
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG, "CC Admin Hosted A");
    const tenantB = await insT(SLUG_B, "CC Admin Hosted B");
    tenantIds.push(tenantA, tenantB);

    for (const t of [tenantA, tenantB]) {
      await sql.query(
        `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
         SELECT $1, m, false FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) m`,
        [t]);
    }
    await sql.query(
      `INSERT INTO politicore.platform_settings (id, settings)
       VALUES (1, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`);
    await sql.query(
      `UPDATE politicore.platform_settings
          SET settings = jsonb_set(settings, ARRAY['service_entitlements'], '{}'::jsonb, true)
        WHERE id = 1`);
    await sql.query(
      `UPDATE politicore.platform_settings
          SET settings = jsonb_set(
                settings,
                ARRAY['service_entitlements', $1::text],
                jsonb_build_object('social', true, 'campaign', false, 'election', false, 'governance', false),
                true)
        WHERE id = 1`,
      [tenantA]);

    const emailsA = [`adm-${SUFFIX}@ccadm.test.local`, `mem-${SUFFIX}@ccadm.test.local`];
    const emailsB = [`admb-${SUFFIX}@ccadm.test.local`];
    emails.push(...emailsA, ...emailsB);
    await createAuthUser(sql, emailsA[0], P, "CC Admin A", SLUG);
    await createAuthUser(sql, emailsA[1], P, "CC Member A", SLUG);
    await createAuthUser(sql, emailsB[0], P, "CC Admin B", SLUG_B);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin'
        WHERE email = ANY($1)`, [[emailsA[0], emailsB[0]]]);

    const adminToken = await signin(emailsA[0], P);
    const memberToken = await signin(emailsA[1], P);
    const adminBToken = await signin(emailsB[0], P);
    const rpc = (name: string) => `/rest/v1/rpc/${name}`;

    // ── J1 — clean provisioning. ────────────────────────────────────────
    // Prior-run residue = settings rows + site_config audits. The 1–2 plain
    // audit rows are written by THIS run's provisioning fixtures and are
    // expected; only site_config:* actions indicate leftover configuration.
    const pre = await sql.query<{ n: string }>(
      `SELECT (SELECT count(*)::text FROM politicore.public_site_settings WHERE tenant_id = ANY($1))
            || '|' || (SELECT count(*)::text FROM politicore.system_audits
                        WHERE tenant_id = ANY($1) AND action LIKE 'site_config:%') AS n`,
      [tenantIds]);
    record("J1 clean tenant provisioning", pre.rows[0].n === "0|0", `settings|site_config audits = ${pre.rows[0].n}`);

    // ── J2 — tenant-admin access. ───────────────────────────────────────
    const ov = await rest("POST", rpc("control_center_overview"), {}, adminToken);
    record("J2 admin reads overview", ov.status === 200 && arr(ov.json).length === 4,
      `status ${ov.status}, services ${arr(ov.json).length}`);

    const st = await rest("POST", rpc("control_center_site_config_status"), {}, adminToken);
    const statusRows = arr(st.json);
    record("J2 admin reads configuration status",
      st.status === 200 && statusRows.length === 5,
      `status ${st.status}, areas ${statusRows.length}`);

    // ── J3 — ordinary member denial. ────────────────────────────────────
    const memOv = await rest("POST", rpc("control_center_overview"), {}, memberToken);
    record("J3 member cannot read overview", memOv.status >= 400, `status ${memOv.status}`);
    const memSt = await rest("POST", rpc("control_center_site_config_status"), {}, memberToken);
    record("J3 member cannot read configuration status", memSt.status >= 400, `status ${memSt.status}`);

    // ── J4 — anonymous denial. ──────────────────────────────────────────
    const anonSt = await rest("POST", rpc("control_center_site_config_status"), {});
    record("J4 anonymous cannot read configuration status", anonSt.status >= 400, `status ${anonSt.status}`);
    const anonOv = await rest("POST", rpc("control_center_overview"), {});
    record("J4 anonymous cannot read overview", anonOv.status >= 400, `status ${anonOv.status}`);

    // ── J5 — entitlement state. ─────────────────────────────────────────
    const social = arr(ov.json).find((s) => s.module === "social") ?? {};
    const election = arr(ov.json).find((s) => s.module === "election") ?? {};
    record("J5 entitlement represented (social yes, election no)",
      social.entitled === true && election.entitled === false,
      `social=${social.entitled} election=${election.entitled}`);

    // ── J6 — activation lifecycle. ──────────────────────────────────────
    const en = await rpcCall("set_tenant_module_enabled", { p_module: "social", p_enabled: true }, adminToken);
    const enRow = arr(en.json)[0] ?? {};
    record("J6 entitled activation → operational",
      en.status === 200 && enRow.operational === true, `status ${en.status} operational=${enRow.operational}`);
    const dis = await rest("POST", rpc("set_tenant_module_enabled"), { p_module: "social", p_enabled: false }, adminToken);
    const disRow = arr(dis.json)[0] ?? {};
    record("J6 deactivation → dormant", dis.status === 200 && disRow.enabled === false,
      `status ${dis.status} enabled=${disRow.enabled}`);

    // ── J7 — non-destructive + tenant-local. ────────────────────────────
    const tmA = await sql.query<{ enabled: boolean }>(
      `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const tmB = await sql.query<{ enabled: boolean }>(
      `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`, [tenantB]);
    record("J7 deactivation non-destructive and tenant-local",
      tmA.rows.length === 1 && tmA.rows[0].enabled === false && tmB.rows[0].enabled === false,
      `A row intact=${tmA.rows.length === 1}, B untouched=${tmB.rows[0].enabled === false}`);
    await rest("POST", rpc("set_tenant_module_enabled"), { p_module: "social", p_enabled: true }, adminToken);

    // ── J8 — module status tri-state display data. ──────────────────────
    const ov2 = await rest("POST", rpc("control_center_overview"), {}, adminToken);
    const social2 = arr(ov2.json).find((s) => s.module === "social") ?? {};
    record("J8 status tri-state (entitled+activated → operational)",
      social2.entitled === true && social2.enabled === true && social2.operational === true,
      `entitled=${social2.entitled} enabled=${social2.enabled} operational=${social2.operational}`);

    // ── J9 — module link-out integrity (registry pinned in the codebase). ─
    const registryPath = path.resolve("src/lib/control-center/admin-registry.ts");
    const registry = fs.readFileSync(registryPath, "utf8");
    const pins: Array<[string, string]> = [
      ["social", "/portal/admin/tasks"],
      ["campaign", "/portal/campaign/coordination"],
      ["election", "/portal/election"],
      ["governance", "/portal/governance"],
    ];
    const routeExists = (href: string) => {
      const rel = href.replace(/^\//, "");
      const candidates = [
        path.join("src", "app", rel, "page.tsx"),
        path.join("src", "app", rel + ".tsx"),
      ];
      return candidates.some((c) => fs.existsSync(path.resolve(c)));
    };
    const linkOk = pins.every(([code, href]) =>
      registry.includes(`"${code}"`) && registry.includes(`href: "${href}"`) && routeExists(href));
    record("J9 module link-outs canonical + routes exist on disk", linkOk,
      pins.map(([c, h]) => `${c}→${h}`).join(", "));

    // ── J10 — Core link-out integrity. ──────────────────────────────────
    const corePins = [
      "/portal/admin/members", "/portal/admin/settings",
      "/portal/admin/audit-logs", "/portal/admin/health",
    ];
    const coreOk = corePins.every((h) => registry.includes(`href: "${h}"`) && routeExists(h));
    record("J10 Core link-outs canonical + routes exist on disk", coreOk, corePins.join(", "));

    // ── J11 — website configuration status facets. ──────────────────────
    const save = await rest("POST", rpc("save_site_config_draft"),
      { p_area: "homepage", p_draft: { sections: [] }, p_base_revision: 0 }, adminToken);
    // Hosted PostgREST returns the scalar revision unwrapped (bare number);
    // handle scalar, object and array envelopes.
    const rev = typeof save.json === "number" ? save.json
      : Number(arr(save.json)[0]?.r ?? (save.json as { r?: number } | null)?.r ?? 0);
    const pub = await rest("POST", rpc("publish_site_config"),
      { p_area: "homepage", p_base_revision: rev }, adminToken);
    record("J11 admin can save+publish homepage (prep for status)",
      save.status === 200 && pub.status === 200,
      `save ${save.status}, publish ${pub.status}`);

    const st2 = await rest("POST", rpc("control_center_site_config_status"), {}, adminToken);
    const home = arr(st2.json).find((x) => x.area === "homepage") ?? {};
    const brand = arr(st2.json).find((x) => x.area === "branding") ?? {};
    record("J11 status reflects published homepage; branding untouched",
      home.published === true && home.has_config === true && brand.published === false,
      `homepage published=${home.published}, branding published=${brand.published}`);

    const st3 = await rest("POST", rpc("control_center_site_config_status"), {}, adminToken);
    const leaks = arr(st3.json).flatMap((o) =>
      ["draft", "history", "revision", "published_by"].filter((k) => k in o));
    record("J11 status carries no payload/history/revision internals", leaks.length === 0,
      leaks.length ? `leaks=[${leaks.join(",")}]` : "clean");

    // ── J12 — system health seam intact. ────────────────────────────────
    const healthPage = path.resolve("src/app/portal/admin/health/page.tsx");
    record("J12 system health surface preserved (Control Center links, never replaces)",
      fs.existsSync(healthPage) && registry.includes("/portal/admin/health"),
      "legacy health page exists and remains the linked surface");

    // ── J13 — tenant isolation. ─────────────────────────────────────────
    const stB = await rest("POST", rpc("control_center_site_config_status"), {}, adminBToken);
    const homeB = arr(stB.json).find((x) => x.area === "homepage") ?? {};
    record("J13 tenant B never sees tenant A status",
      stB.status === 200 && homeB.published === false,
      `B homepage published=${homeB.published} (A is published)`);
    const ovB = await rest("POST", rpc("control_center_overview"), {}, adminBToken);
    const socB = arr(ovB.json).find((s) => s.module === "social") ?? {};
    record("J13 tenant B service state tenant-local",
      ovB.status === 200 && socB.enabled === false && socB.entitled === false,
      `B social entitled=${socB.entitled} enabled=${socB.enabled}`);

    // ── J14 — module authorization separation. ──────────────────────────
    const grant = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.permission_grants g
        JOIN politicore.profiles p ON p.id = g.user_id
        WHERE p.email = $1`, [emailsA[0]]);
    record("J14 Control Center admin holds zero permission grants (no CC→module authority)",
      grant.rows[0].n === "0", `grants=${grant.rows[0].n}`);

    // ── J15 — public wrappers never expose administration status. ──────
    const slugRow = await sql.query<{ slug: string }>(
      `SELECT slug FROM politicore.tenants WHERE id = $1`, [tenantA]);
    const pubChrome = await rest("GET", `/rest/v1/rpc/get_public_site_chrome?p_tenant_slug=${slugRow.rows[0].slug}`);
    const chromeBody = typeof pubChrome.text === "string" ? pubChrome.text : "";
    record("J15 public chrome has no administration/status surface",
      !chromeBody.includes("has_config") && !chromeBody.includes("site_config_status"),
      `status ${pubChrome.status}`);
    const pubCfg = await rest("POST", rpc("get_published_site_config"),
      { p_tenant_slug: slugRow.rows[0].slug, p_area: "homepage" });
    record("J15 public site config exposes published payload only",
      pubCfg.status === 200 && !pubCfg.text.includes("\"draft\"") && !pubCfg.text.includes("\"history\""),
      `status ${pubCfg.status}, leaks=${pubCfg.text.includes("\"draft\"") || pubCfg.text.includes("\"history\"")}`);

    // ── J16 — audit integrity for actual mutations. ─────────────────────
    const aud = await sql.query<{ n: string; actors: string }>(
      `SELECT count(*)::text n, string_agg(DISTINCT actor_id::text, ',') actors
         FROM politicore.system_audits
        WHERE tenant_id = $1
          AND (action LIKE 'site_config:homepage:%' OR action LIKE 'module:%')`,
      [tenantA]);
    const adminId = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE email = $1`, [emailsA[0]])).rows[0].id;
    record("J16 audit evidence with server-resolved actor",
      Number(aud.rows[0].n) >= 1 && aud.rows[0].actors === adminId,
      `records=${aud.rows[0].n} actorMatches=${aud.rows[0].actors === adminId}`);

    // ── J17 — pristine cleanup. ─────────────────────────────────────────
    const wasForced = await cleanup(sql, tenantIds, emails);
    const res = await sql.query<{ n: string }>(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'ccadm-%')
            || '|' || (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@ccadm.test.local')
            || '|' || (SELECT count(*)::text FROM politicore.system_audits WHERE tenant_id = ANY($1))
            || '|' || (SELECT count(*)::text FROM politicore.public_site_settings WHERE tenant_id = ANY($1)) AS n`,
      [tenantIds]);
    record("J17 hosted residue 0",
      res.rows[0].n === "0|0|0|0",
      `tenants|profiles|audits|settings = ${res.rows[0].n}`);

    // ── J18 — FORCE RLS restored. ──────────────────────────────────────
    const postForce = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [wasForced]);
    const unforced = postForce.rows.filter((r) => !r.forced).map((r) => r.relname);
    record("J18 FORCE RLS restored after cleanup",
      wasForced.length > 0 && unforced.length === 0,
      `restored=${postForce.rows.length - unforced.length}/${wasForced.length} unforced=[${unforced.join(",")}]`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`CONTROL CENTER ADMINISTRATION HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
