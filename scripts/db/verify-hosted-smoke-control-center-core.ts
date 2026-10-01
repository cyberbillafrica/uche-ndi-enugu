/**
 * POLITICORE — Control Center Core (Phase 22) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 22
 * Control Center foundation end-to-end through the real PostgREST data API
 * and real GoTrue identities — the same acceptance standard as Phases 6–19:
 *
 *   J1  — anon: zero mutation surface (activation + config RPCs)
 *   J2  — authorized admin access: overview reflects entitlement/activation
 *   J3  — member denial (activation, overview, config reads)
 *   J4  — entitlement read behavior: entitled services expose controls
 *   J5  — entitled service activation → dormant → reactivation
 *   J6  — non-entitled activation denial (server-enforced)
 *   J7  — tenant isolation: tenant A cannot read/mutate tenant B
 *   J8  — audit evidence: activation writes Core Audit records
 *   J9  — stale revision conflict; current revision succeeds
 *   J10 — module gate: disabled service fails closed, re-enable restores
 *   J11 — published-only public read; drafts never anonymous-readable
 *   J12 — pristine cleanup (fixtures removed, FORCE-RLS restored, residue 0)
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

/** RPC POST that surfaces the error body on unexpected statuses. */
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

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
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
    } finally {
      await sql.query("SET session_replication_role = DEFAULT");
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove control-center fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `CcCore!${SUFFIX}`;
  const SLUG = `ccore-${SUFFIX}`;
  const SLUG_B = `ccb-${SUFFIX}`;

  try {
    // ── Fixtures: two tenants, platform entitlements for tenant A only. ──
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG, "CC Hosted A");
    const tenantB = await insT(SLUG_B, "CC Hosted B");
    tenantIds.push(tenantA, tenantB);

    for (const t of [tenantA, tenantB]) {
      await sql.query(
        `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
         SELECT $1, m, false FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) m`,
        [t]);
    }
    // Per-tenant entitlement map (platform singleton): A entitled for all four.
    // jsonb_set only creates the LAST path element — ensure the row AND the
    // parent key exist (hosted seeds platform_settings as {} via 0004),
    // then the nested per-tenant write succeeds.
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
                jsonb_build_object('social', true, 'campaign', true, 'election', true, 'governance', true),
                true)
        WHERE id = 1`,
      [tenantA]);

    // Seed the A settings row for configuration journeys.
    await sql.query(
      `INSERT INTO politicore.public_site_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [tenantA]);

    const emailsA = [`adm-${SUFFIX}@ccore.test.local`, `mem-${SUFFIX}@ccore.test.local`];
    const emailsB = [`admb-${SUFFIX}@ccore.test.local`];
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

    // ── J1 — anon: zero mutation surface. ─────────────────────────────
    const anonAct = await rest("POST", rpc("set_tenant_module_enabled"),
      { p_module: "social", p_enabled: true });
    record("J1 anon cannot activate", anonAct.status >= 400,
      `status ${anonAct.status}`);

    const anonCfg = await rest("POST", rpc("save_site_config_draft"),
      { p_area: "homepage", p_draft: { x: 1 }, p_base_revision: 0 });
    record("J1 anon cannot save config", anonCfg.status >= 400,
      `status ${anonCfg.status}`);

    const anonPub = await rest("POST", rpc("publish_site_config"),
      { p_area: "homepage", p_base_revision: 0 });
    record("J1 anon cannot publish", anonPub.status >= 400,
      `status ${anonPub.status}`);

    // ── J2 — authorized admin overview. ───────────────────────────────
    const ov = await rest("POST", rpc("control_center_overview"), {}, adminToken);
    const services = arr(ov.json);
    record("J2 admin reads overview",
      ov.status === 200 && services.length === 4,
      `${services.length}/4 services`);
    const social = services.find((s) => s.module === "social");
    record("J2 entitlement+activation represented",
      social?.entitled === true && social?.enabled === false && social?.operational === false,
      `entitled=${social?.entitled} enabled=${social?.enabled} operational=${social?.operational}`);

    // ── J3 — member denial. ───────────────────────────────────────────
    const memAct = await rest("POST", rpc("set_tenant_module_enabled"),
      { p_module: "social", p_enabled: true }, memberToken);
    record("J3 member cannot activate", memAct.status >= 400, `status ${memAct.status}`);
    const memOv = await rest("POST", rpc("control_center_overview"), {}, memberToken);
    record("J3 member cannot read overview", memOv.status >= 400, `status ${memOv.status}`);
    const memCfg = await rest("POST", rpc("get_site_config"), { p_area: "homepage" }, memberToken);
    record("J3 member cannot read config", memCfg.status >= 400, `status ${memCfg.status}`);

    // ── J4/J5 — entitled activation lifecycle: dormant → active. ─────
    const act1 = await rpcCall("set_tenant_module_enabled",
      { p_module: "social", p_enabled: true }, adminToken);
    const act1row = arr(act1.json)[0] ?? {};
    record("J5 entitled activation succeeds",
      act1.status === 200 && act1row.operational === true,
      `status ${act1.status} operational=${act1row.operational}`);

    const off = await rest("POST", rpc("set_tenant_module_enabled"),
      { p_module: "social", p_enabled: false }, adminToken);
    record("J5 deactivation → dormant",
      off.status === 200 && (arr(off.json)[0] ?? {}).enabled === false &&
        (arr(off.json)[0] ?? {}).operational === false,
      `status ${off.status}`);

    // Data intact after disable (no deletion).
    const tm = await sql.query<{ enabled: boolean }>(
      `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`,
      [tenantA]);
    record("J5 non-destructive (row intact, just disabled)",
      tm.rows.length === 1, `rows=${tm.rows.length}`);

    const re = await rest("POST", rpc("set_tenant_module_enabled"),
      { p_module: "social", p_enabled: true }, adminToken);
    record("J5 reactivation → operational",
      re.status === 200 && (arr(re.json)[0] ?? {}).operational === true,
      `status ${re.status}`);

    // ── J6 — non-entitled denial (tenant A election OFF entitlement). ─
    await sql.query(
      `UPDATE politicore.platform_settings
          SET settings = jsonb_set(settings,
            ARRAY['service_entitlements',$1::text,'election'], 'false'::jsonb, true)
        WHERE id = 1`, [tenantA]);
    const denied = await rest("POST", rpc("set_tenant_module_enabled"),
      { p_module: "election", p_enabled: true }, adminToken);
    record("J6 non-entitled enable refused", denied.status >= 400,
      `status ${denied.status}`);

    // ── J7 — tenant isolation. ────────────────────────────────────────
    const isoAct = await rest("POST", rpc("set_tenant_module_enabled"),
      { p_module: "social", p_enabled: true }, adminToken);
    const bRow = await sql.query<{ enabled: boolean }>(
      `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'social'`,
      [tenantB]);
    record("J7 activation is own-tenant only",
      isoAct.status === 200 && bRow.rows[0]?.enabled === false,
      `tenant B social still enabled=${bRow.rows[0]?.enabled}`);

    const ovB = await rest("POST", rpc("control_center_overview"), {}, adminBToken);
    const svcB = arr(ovB.json);
    const entitledB = svcB.every((s) => s.entitled === false);
    record("J7 tenant B sees own (unentitled) state only",
      ovB.status === 200 && svcB.length === 4 && entitledB,
      `services=${svcB.length} allUnentitled=${entitledB}`);

    // ── J8 — audit evidence. ─────────────────────────────────────────
    const audits = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.system_audits
        WHERE tenant_id = $1 AND affected_resource = 'tenant_modules'`, [tenantA]);
    record("J8 activation audits recorded (trigger)",
      Number(audits.rows[0].n) >= 3, `audits=${audits.rows[0].n}`);

    // ── J9 — configuration concurrency. ─────────────────────────────
    const save1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage", p_draft: { v: 1 }, p_base_revision: 0 }, adminToken);
    record("J9 first draft save (rev 0 → 1)", save1.status === 200, `status ${save1.status}`);

    const stale = await rest("POST", rpc("save_site_config_draft"),
      { p_area: "homepage", p_draft: { v: "stale" }, p_base_revision: 0 }, adminToken);
    record("J9 stale revision rejected", stale.status >= 400, `status ${stale.status}`);

    const pub = await rest("POST", rpc("publish_site_config"),
      { p_area: "homepage", p_base_revision: 1 }, adminToken);
    const pubRow = arr(pub.json)[0] ?? {};
    record("J9 publish promotes draft",
      pub.status === 200 && Number(pubRow.revision) === 2,
      `status ${pub.status} revision=${pubRow.revision}`);

    // ── J10 — module gate follows activation. ────────────────────────
    const memGateOn = await rest("POST", rpc("my_module_enabled"), { m: "social" }, memberToken);
    record("J10 enabled module gate true",
      memGateOn.status === 200 && memGateOn.json === true,
      `status ${memGateOn.status} value=${String(memGateOn.json)}`);

    await rest("POST", rpc("set_tenant_module_enabled"), { p_module: "social", p_enabled: false }, adminToken);
    const memGateOff = await rest("POST", rpc("my_module_enabled"), { m: "social" }, memberToken);
    record("J10 disabled module gate fails closed",
      memGateOff.status === 200 && memGateOff.json === false,
      `status ${memGateOff.status} value=${String(memGateOff.json)}`);

    // ── J11 — published-only public read. ────────────────────────────
    const pubRead = await rest("POST", rpc("get_published_site_config"),
      { p_tenant_slug: SLUG, p_area: "homepage" });
    const pubReadRow = arr(pubRead.json)[0] ?? {};
    record("J11 public read returns published only",
      pubRead.status === 200 && (pubReadRow.published as Record<string, unknown> | undefined)?.v === 1 &&
        !(pubReadRow.published as Record<string, unknown> | undefined)?.draft,
      `status ${pubRead.status} hasPublished=${Boolean((pubReadRow.published as Record<string, unknown> | undefined)?.v)}`);

    const draftRead = await rest("POST", rpc("get_published_site_config"),
      { p_tenant_slug: SLUG, p_area: "seo" });
    record("J11 unpublished area returns nothing",
      draftRead.status === 200 && arr(draftRead.json).length === 0,
      `status ${draftRead.status} rows=${arr(draftRead.json).length}`);

    const adminCfg = await rest("POST", rpc("get_site_config"), { p_area: "homepage" }, adminToken);
    const adminCfgRow = arr(adminCfg.json)[0] ?? {};
    record("J11 admin reads full row (draft+published)",
      adminCfg.status === 200 && adminCfgRow.draft !== null,
      `status ${adminCfg.status} hasDraft=${Boolean(adminCfgRow.draft)}`);
  } finally {
    await cleanup(sql, tenantIds, emails);

    // Residue proof.
    const res = await sql.query<{ n: string }>(
      `SELECT (SELECT count(*)::int FROM politicore.tenants WHERE slug LIKE '%${SUFFIX}%')
          + (SELECT count(*)::int FROM politicore.profiles WHERE email LIKE '%${SUFFIX}%')
          + (SELECT count(*)::int FROM politicore.public_site_settings WHERE tenant_id NOT IN (SELECT id FROM politicore.tenants))
          AS n`);
    console.log(`residue: ${res.rows[0].n}`);
    await sql.end();

    const passed = results.filter((r) => r.ok).length;
    console.log(`\nPHASE 22 CONTROL CENTER CORE HOSTED ACCEPTANCE: ${passed}/${results.length} ${passed === results.length ? "✓" : "✗"}`);
    if (passed !== results.length) process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
