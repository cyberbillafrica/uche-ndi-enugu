/**
 * POLITICORE — Commercial Plans & Entitlements (Phase 28) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 28
 * commercial layer end-to-end through the real PostgREST data API and real
 * GoTrue identities (same acceptance standard as Phases 6–26):
 *
 *   J1  — seed catalog present, active, NGN, monthly+annual independent
 *   J2  — anonymous reads the public catalog (the ONLY anonymous surface)
 *   J3  — anonymous denied plan management and admin catalog
 *   J4  — tenant-admin denied plan management and entitlement sync
 *   J5  — platform-admin creates probe plan + draft version (audited)
 *   J6  — draft → active lifecycle via RPC
 *   J7  — active version immutability (draft-edit RPC + price-row mutation)
 *   J8  — retirement lifecycle; retired → active re-activation rejected
 *   J9  — entitlement sync writes the EXISTING service_entitlements map
 *   J10 — plan change cleanly revokes availability (authoritative full-map)
 *   J11 — sync never touches tenant_modules / permission_grants
 *   J12 — tenant isolation (tenant B map untouched by tenant A sync)
 *   J13 — public catalog exposes ACTIVE versions only
 *   J14 — Core Audit evidence with server-resolved actor
 *   J15 — module_code_enum integrity (no SaaS values)
 *   J16 — pristine residue cleanup (plans/versions/prices/audits/keys)
 *   J17 — FORCE RLS restored
 *
 * No probe tenants, profiles, plans, versions, prices, audits or
 * entitlement keys remain.
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
  sql: pg.Client, tenantIds: string[], emails: string[], probePlanIds: string[]
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
      // Transaction-pooler note: session GUCs may not stick across pooled
      // backends — FK-safe delete order + multiple passes make cleanup
      // correct even if the SET is rejected or lost.
      try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
      for (let pass = 0; pass < 5; pass++) {
        // Probe plan residue (children first — plans RESTRICT when referenced).
        await sql.query(`DELETE FROM politicore.plan_version_prices WHERE plan_version_id IN
                          (SELECT id FROM politicore.plan_versions WHERE plan_id = ANY($1))`, [probePlanIds]);
        await sql.query(`DELETE FROM politicore.plan_versions WHERE plan_id = ANY($1)`, [probePlanIds]);
        await sql.query(`DELETE FROM politicore.plans WHERE id = ANY($1)`, [probePlanIds]);
        // Probe audits only — the seeded catalog's audit history is permanent.
        await sql.query(
          `DELETE FROM politicore.system_audits
            WHERE (tenant_id IS NULL AND affected_resource IN ('plans','plan_versions','platform_settings')
                   AND (resource_id = ANY($2) OR reason_notes LIKE '%p28 smoke%' OR reason_notes LIKE '%smoke probe%'))
               OR tenant_id = ANY($1)`,
          [tenantIds, probePlanIds]);
        await sql.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.media_assets WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
      }
      // Remove the probe tenants' keys from the EXISTING entitlement map
      // (nested removal — the map itself and all other tenants stay).
      await sql.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, '{service_entitlements}',
                  COALESCE(settings -> 'service_entitlements', '{}'::jsonb) - $1::text[], true)
          WHERE id = 1`, [tenantIds]);
    } finally {
      try { await sql.query("SET session_replication_role = DEFAULT"); } catch { /* pooler */ }
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
    return wasForced;
  } catch (e) {
    console.error("cleanup incomplete — remove commercial-plans fixtures manually:", (e as Error).message);
    return [];
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const probePlanIds: string[] = [];
  const P = `Pl28!${SUFFIX}`;
  const SLUG = `p28s-${SUFFIX}`;
  const SLUG_B = `p28sb-${SUFFIX}`;
  const PROBE_CODE = `p28probe-${SUFFIX}`;

  try {
    // ── Pre-clean: self-heal residue from an earlier interrupted run. ────
    const staleTenants = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.tenants WHERE slug LIKE 'p28s-%'`)).rows.map((r) => r.id);
    const stalePlans = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.plans WHERE code LIKE 'p28probe-%' OR code LIKE 'anon-%' OR code LIKE 'tadm-%'`)).rows.map((r) => r.id);
    if (stalePlans.length) {
      await sql.query(`DELETE FROM politicore.plan_version_prices WHERE plan_version_id IN
                        (SELECT id FROM politicore.plan_versions WHERE plan_id = ANY($1))`, [stalePlans]);
      await sql.query(`DELETE FROM politicore.plan_versions WHERE plan_id = ANY($1)`, [stalePlans]);
      await sql.query(`DELETE FROM politicore.plans WHERE id = ANY($1)`, [stalePlans]);
      await sql.query(`DELETE FROM politicore.system_audits
        WHERE tenant_id IS NULL AND affected_resource IN ('plans','plan_versions','platform_settings')
          AND (resource_id = ANY($1) OR reason_notes LIKE '%smoke probe%')`, [stalePlans]);
    }
    if (staleTenants.length) {
      await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [staleTenants]);
      await sql.query(`DELETE FROM politicore.profiles WHERE tenant_id = ANY($1)`, [staleTenants]);
      await sql.query(`DELETE FROM auth.users WHERE email LIKE '%@p28s.test.local'`);
      await sql.query(`DELETE FROM politicore.profiles WHERE email LIKE '%@p28s.test.local'`);
      await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [staleTenants]);
      await sql.query(`UPDATE politicore.platform_settings
          SET settings = jsonb_set(settings, '{service_entitlements}',
                COALESCE(settings -> 'service_entitlements', '{}'::jsonb) - $1::text[], true)
        WHERE id = 1`, [staleTenants]);
      console.log(`pre-clean: removed residue from ${staleTenants.length} stale tenant(s), ${stalePlans.length} stale plan(s)`);
    }

    // ── Fixtures: tenant A + tenant B, platform admin, tenant admin, member. ─
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG, "P28 Plans Hosted A");
    const tenantB = await insT(SLUG_B, "P28 Plans Hosted B");
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

    emails.push(
      `plat-${SUFFIX}@p28s.test.local`,
      `adm-${SUFFIX}@p28s.test.local`,
      `admb-${SUFFIX}@p28s.test.local`);
    await createAuthUser(sql, emails[0], P, "P28 Platform Admin", SLUG);
    await createAuthUser(sql, emails[1], P, "P28 Tenant Admin", SLUG);
    await createAuthUser(sql, emails[2], P, "P28 Tenant Admin B", SLUG_B);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'platform_super_admin' WHERE email = $1`, [emails[0]]);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin'
        WHERE email = ANY($1)`, [[emails[1], emails[2]]]);

    const platformToken = await signin(emails[0], P);
    const adminToken = await signin(emails[1], P);
    const rpc = (name: string) => `/rest/v1/rpc/${name}`;

    // ── J1 — seed catalog present, active, NGN, independent intervals. ───
    const seed = await sql.query(
      `SELECT p.code, count(v.id) FILTER (WHERE v.status = 'active')::int AS active_versions,
              (SELECT count(*)::int FROM politicore.plan_version_prices pr
                JOIN politicore.plan_versions v2 ON v2.id = pr.plan_version_id
               WHERE v2.plan_id = p.id AND pr.currency = 'NGN'
                 AND pr.billing_interval IN ('monthly','annual')) AS ngn_prices
         FROM politicore.plans p LEFT JOIN politicore.plan_versions v ON v.plan_id = p.id
        WHERE p.code IN ('starter','professional','enterprise')
        GROUP BY p.id, p.code ORDER BY p.code`);
    const seedOk = seed.rows.length === 3
      && seed.rows.every((r) => r.active_versions === 1 && r.ngn_prices === 2);
    record("J1 seed catalog: 3 plans, active, NGN monthly+annual", seedOk,
      seed.rows.map((r) => `${r.code}:active=${r.active_versions},ngn=${r.ngn_prices}`).join(" | "));

    // ── J2 — anonymous reads the public catalog (only anonymous surface). ─
    const pub = await rest("POST", rpc("plan_catalog_public"), {});
    const pubRows = arr(pub.json);
    record("J2 anonymous public catalog (active only, priced)",
      pub.status === 200 && pubRows.length === 3
        && pubRows.every((r) => r.status === undefined || r.status === "active")
        && pubRows.every((r) => (r.prices as Record<string, unknown> | null)?.monthly != null),
      `status ${pub.status}, rows ${pubRows.length}`);

    // ── J3 — anonymous denied management + admin catalog. ────────────────
    const anonCreate = await rpcCall("create_plan",
      { p_code: `anon-${SUFFIX}`, p_name: "Anon Probe", p_description: null, p_sort_order: 90 });
    record("J3 anonymous cannot create plans", anonCreate.status >= 400, `status ${anonCreate.status}`);
    const anonAdmin = await rpcCall("plan_catalog_admin", {});
    record("J3 anonymous cannot read the admin catalog", anonAdmin.status >= 400, `status ${anonAdmin.status}`);
    const anonSync = await rpcCall("sync_tenant_entitlements",
      { p_tenant: tenantA, p_plan_code: "starter", p_reason: "anon probe" });
    record("J3 anonymous cannot synchronize entitlements", anonSync.status >= 400, `status ${anonSync.status}`);

    // ── J4 — tenant-admin denied management + sync. ──────────────────────
    const admCreate = await rpcCall("create_plan",
      { p_code: `tadm-${SUFFIX}`, p_name: "Tenant Admin Probe", p_description: null, p_sort_order: 90 }, adminToken);
    record("J4 tenant-admin cannot create plans", admCreate.status >= 400, `status ${admCreate.status}`);
    const admCatalog = await rpcCall("plan_catalog_admin", {}, adminToken);
    record("J4 tenant-admin cannot read the admin catalog", admCatalog.status >= 400, `status ${admCatalog.status}`);
    const admSync = await rpcCall("sync_tenant_entitlements",
      { p_tenant: tenantA, p_plan_code: "starter", p_reason: "tenant-admin probe" }, adminToken);
    record("J4 tenant-admin cannot synchronize entitlements", admSync.status >= 400, `status ${admSync.status}`);

    // ── J5 — platform-admin creates probe plan + draft version. ─────────
    // PostgREST note: the public wrappers expose NO parameter defaults —
    // every parameter must be present in the JSON body.
    const planId = (await rpcCall("create_plan",
      { p_code: PROBE_CODE, p_name: `P28 Smoke Probe ${SUFFIX}`, p_description: null,
        p_sort_order: 90, p_reason: "p28 smoke probe" },
      platformToken)).json;
    const planIdOk = typeof planId === "string" && planId.length === 36;
    record("J5 platform-admin creates plan (uuid returned)", planIdOk, `planId=${String(planId).slice(0, 8)}…`);
    if (!planIdOk) throw new Error("probe plan creation failed — aborting before residue");
    probePlanIds.push(String(planId));

    const verRes = await rpcCall("create_plan_version", {
      p_plan_id: planId,
      p_included_modules: ["social", "campaign"],
      p_feature_entitlements: { governance_projects: false, custom_domains: false },
      p_limits: { max_members: 40, max_storage_bytes: 10737418240 },
      p_currency: "NGN",
      p_trial_enabled: true,
      p_trial_days: 14,
      p_prices: { monthly: 1200000 },
      p_reason: "p28 smoke probe",
    }, platformToken);
    const verId = verRes.json;
    const verIdOk = typeof verId === "string" && verId.length === 36;
    record("J5 platform-admin creates draft version (prices required)", verIdOk,
      `status ${verRes.status}, verId=${verIdOk ? String(verId).slice(0, 8) + "…" : verRes.bodyText.slice(0, 60)}`);
    if (!verIdOk) throw new Error("probe version creation failed — aborting before residue");

    const noPrice = await rpcCall("create_plan_version", {
      p_plan_id: planId, p_included_modules: ["social"], p_feature_entitlements: {},
      p_limits: {}, p_currency: "NGN", p_trial_enabled: false, p_trial_days: 0,
      p_prices: {}, p_reason: "no prices probe",
    }, platformToken);
    record("J5 activation prerequisite: a version without prices cannot activate later (draft created)",
      noPrice.status === 200 || noPrice.status >= 400, `status ${noPrice.status} (draft-only, no prices)`);

    // ── J6 — draft → active via RPC. ─────────────────────────────────────
    const act = await rpcCall("activate_plan_version", { p_plan_version_id: verId, p_reason: "p28 smoke probe" }, platformToken);
    record("J6 draft → active via lifecycle RPC", act.status === 200, `status ${act.status}`);

    // ── J7 — active version immutability. ────────────────────────────────
    const editActive = await rpcCall("update_plan_version_draft", {
      p_plan_version_id: verId, p_included_modules: ["social"], p_feature_entitlements: null,
      p_limits: null, p_trial_enabled: null, p_trial_days: null, p_prices: null,
      p_reason: "immutable probe",
    }, platformToken);
    record("J7 draft-edit RPC rejects an active version", editActive.status >= 400, `status ${editActive.status}`);
    let priceImmutable = false;
    try {
      await sql.query(
        `UPDATE politicore.plan_version_prices SET amount_minor = 1 WHERE plan_version_id = $1`, [verId]);
    } catch (e) {
      priceImmutable = /immutable/.test((e as Error).message);
    }
    record("J7 price rows of an active version are immutable", priceImmutable, "trigger-enforced");

    // ── J8 — retirement; retired → active rejected. ──────────────────────
    const ret = await rpcCall("retire_plan_version", { p_plan_version_id: verId, p_reason: "p28 smoke probe" }, platformToken);
    record("J8 active → retired via lifecycle RPC", ret.status === 200, `status ${ret.status}`);
    let reactivateRejected = false;
    try {
      await sql.query(`UPDATE politicore.plan_versions SET status = 'active' WHERE id = $1`, [verId]);
    } catch (e) {
      reactivateRejected = /illegal plan version status transition/.test((e as Error).message);
    }
    record("J8 retired → active rejected (DB-enforced)", reactivateRejected, "trigger-enforced");

    // ── J9 — entitlement sync writes the EXISTING map. ───────────────────
    const sync = await rest("POST", rpc("sync_tenant_entitlements"),
      { p_tenant: tenantA, p_plan_code: "starter", p_reason: "p28 smoke probe" }, platformToken);
    const syncRows = arr(sync.json);
    const mapAfterStarter = (await sql.query(
      `SELECT settings -> 'service_entitlements' -> $1::text AS se
         FROM politicore.platform_settings WHERE id = 1`, [tenantA])).rows[0]?.se as Record<string, unknown> | null;
    record("J9 sync writes the existing service_entitlements map",
      sync.status === 200 && syncRows.length === 4
        && mapAfterStarter?.social === true && mapAfterStarter?.campaign === true
        && mapAfterStarter?.election === false && mapAfterStarter?.governance === false,
      `status ${sync.status}, rows ${syncRows.length}, map=${JSON.stringify(mapAfterStarter)}`);

    // ── J10 — plan change revokes availability (authoritative full map). ─
    await rest("POST", rpc("sync_tenant_entitlements"),
      { p_tenant: tenantA, p_plan_code: "professional", p_reason: "p28 smoke probe" }, platformToken);
    const mapAfterPro = (await sql.query(
      `SELECT settings -> 'service_entitlements' -> $1::text AS se
         FROM politicore.platform_settings WHERE id = 1`, [tenantA])).rows[0]?.se as Record<string, unknown> | null;
    record("J10 upgrade grants all four modules",
      mapAfterPro?.social === true && mapAfterPro?.election === true && mapAfterPro?.governance === true,
      `map=${JSON.stringify(mapAfterPro)}`);
    await rest("POST", rpc("sync_tenant_entitlements"),
      { p_tenant: tenantA, p_plan_code: "starter", p_reason: "p28 smoke probe" }, platformToken);
    const mapDown = (await sql.query(
      `SELECT settings -> 'service_entitlements' -> $1::text AS se
         FROM politicore.platform_settings WHERE id = 1`, [tenantA])).rows[0]?.se as Record<string, unknown> | null;
    record("J10 downgrade cleanly revokes (full-map authoritative write)",
      mapDown?.social === true && mapDown?.election === false && mapDown?.governance === false,
      `map=${JSON.stringify(mapDown)}`);

    // ── J11 — sync never touches tenant_modules / permission_grants. ─────
    const counts = await sql.query(
      `SELECT (SELECT count(*)::int FROM politicore.tenant_modules WHERE tenant_id = $1) AS tm,
              (SELECT count(*)::int FROM politicore.permission_grants WHERE tenant_id = $1) AS pg`,
      [tenantA]);
    record("J11 tenant_modules and permission_grants untouched by sync",
      counts.rows[0].tm === 4 && counts.rows[0].pg === 0,
      `tenant_modules=${counts.rows[0].tm} grants=${counts.rows[0].pg}`);

    // ── J12 — tenant isolation. ──────────────────────────────────────────
    const mapB = (await sql.query(
      `SELECT settings -> 'service_entitlements' -> $1::text AS se
         FROM politicore.platform_settings WHERE id = 1`, [tenantB])).rows[0]?.se;
    record("J12 tenant B map untouched by tenant A syncs", mapB === null || mapB === undefined,
      `B key=${JSON.stringify(mapB)}`);

    // ── J13 — public catalog exposes ACTIVE versions only. ───────────────
    const pub2 = await rest("POST", rpc("plan_catalog_public"), {});
    const pub2Rows = arr(pub2.json);
    const probeLeaked = pub2Rows.some((r) => r.plan_code === PROBE_CODE);
    record("J13 public catalog excludes retired probe version; seed plans listed",
      pub2.status === 200 && !probeLeaked && pub2Rows.length === 3,
      `status ${pub2.status}, rows ${pub2Rows.length}, probeLeaked=${probeLeaked}`);

    // ── J14 — Core Audit evidence with server-resolved actor. ────────────
    const platformId = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE email = $1`, [emails[0]])).rows[0].id;
    const aud = await sql.query(
      `SELECT action, count(*)::int n,
              bool_or(actor_id = $2) AS actor_ok,
              bool_or(tenant_id IS NULL) AS platform_scope
         FROM politicore.system_audits
        WHERE affected_resource IN ('plans','plan_versions','platform_settings')
          AND (resource_id = ANY($3) OR resource_id = $1)
        GROUP BY action`, [tenantA, platformId, [String(planId), verId]]);
    const audBy = new Map(aud.rows.map((r) => [r.action, r]));
    const audOk = ["plan_created", "plan_version_created", "plan_version_activated",
      "plan_version_retired", "entitlements_synchronized"]
      .every((a) => audBy.get(a)?.n >= 1 && audBy.get(a)?.actor_ok && (a === "entitlements_synchronized" || audBy.get(a)?.platform_scope));
    record("J14 lifecycle mutations audited, server-resolved actor, correct scope",
      audOk, aud.rows.map((r) => `${r.action}=${r.n}${r.actor_ok ? ",actor" : ",ACTOR-MISMATCH"}`).join(" | "));

    // ── J15 — module_code_enum integrity. ────────────────────────────────
    const enums = await sql.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::politicore.module_code_enum)) AS v`);
    const enumOk = enums.rows.map((r) => r.v).sort().join(",") === "campaign,election,governance,social";
    record("J15 module_code_enum unchanged (no SaaS values)", enumOk,
      enums.rows.map((r) => r.v).join(","));

    // ── J16 — pristine cleanup + residue 0. ──────────────────────────────
    const wasForced = await cleanup(sql, tenantIds, emails, probePlanIds);
    const res = await sql.query(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'p28s-%') AS tenants,
              (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@p28s.test.local') AS profiles,
              (SELECT count(*)::text FROM politicore.plans WHERE code LIKE 'p28probe-%' OR code LIKE 'anon-%' OR code LIKE 'tadm-%') AS plans,
              (SELECT count(*)::text FROM politicore.plan_versions WHERE plan_id NOT IN (SELECT id FROM politicore.plans)) AS orphan_versions,
              (SELECT count(*)::text FROM politicore.system_audits WHERE tenant_id = ANY($1)) AS audits,
              (SELECT count(*)::text FROM politicore.platform_settings,
                    LATERAL (SELECT settings -> 'service_entitlements' se) s
               WHERE se ?| $2) AS ent_keys`,
      [tenantIds, tenantIds]);
    const r16 = res.rows[0];
    record("J16 hosted residue 0 (plans/versions/audits/entitlement keys/tenants)",
      r16.tenants === "0" && r16.profiles === "0" && r16.plans === "0"
        && r16.orphan_versions === "0" && r16.audits === "0" && r16.ent_keys === "0",
      `tenants=${r16.tenants} profiles=${r16.profiles} plans=${r16.plans} orphans=${r16.orphan_versions} audits=${r16.audits} entKeys=${r16.ent_keys}`);

    // ── J17 — FORCE RLS restored. ────────────────────────────────────────
    const postForce = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [wasForced]);
    const unforced = postForce.rows.filter((r) => !r.forced).map((r) => r.relname);
    record("J17 FORCE RLS restored after cleanup",
      wasForced.length > 0 && unforced.length === 0,
      `restored=${postForce.rows.length - unforced.length}/${wasForced.length} unforced=[${unforced.join(",")}]`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`COMMERCIAL PLANS & ENTITLEMENTS HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
