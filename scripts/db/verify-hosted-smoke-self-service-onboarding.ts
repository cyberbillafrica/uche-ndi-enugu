/**
 * POLITICORE — Self-Service Tenant Onboarding (Phase 30) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 30
 * onboarding journey end-to-end through the real PostgREST data API and
 * real GoTrue identities (same acceptance standard as Phases 6–29):
 *
 *   M1  — anonymous pricing: public catalog exposes the active seeds
 *   M2  — anonymous slug availability: reasons reserved/taken/available
 *   M3  — anonymous cannot provision (grant-denied), anon state = signin
 *   M4  — fixtures: bare auth users via SQL (NO profiles) + real tokens
 *   M5  — signup/provisioning: one RPC → tenant + owner + subscription
 *   M6  — owner authority: profile is tenant_super_admin in the new tenant
 *   M7  — subscription creation: trialing, base_plan item, NGN, +14d trial
 *   M8  — trial state: trial_end present, NO invoices, truthful next_step
 *   M9  — entitlement map matches the plan modules exactly
 *   M10 — billing visibility: onboarding_state enter_app with plan/interval
 *   M11 — duplicate prevention: owner/slug retries denied; one live sub
 *   M12 — interrupted/resumed: interrupted identity completes later
 *   M13 — cross-tenant denial: no cross-tenant exposure via state RPC
 *   M14 — plain-admin denial: existing-profile admins cannot onboard
 *   M15 — platform authority retained + platform admin cannot onboard
 *   M16 — RLS/tenant isolation: onboarding reads own tenant only
 *   M17 — migration pin/signature integrity (69 migrations, latest 0068)
 *   M18 — pristine residue cleanup (0) + FORCE RLS restored
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

/**
 * Create a BARE auth user (auth.users row, NO profile — the Phase 30
 * signup shape): raw_user_meta_data carries NO tenant_slug, so the 0007
 * trigger provisions nothing and onboarding_state resolves create_tenant.
 */
async function createBareAuthUser(
  sql: pg.Client, email: string, password: string
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
             jsonb_build_object('onboarding_intent', 'tenant_owner'),
             false,
             extensions.crypt($3, extensions.gen_salt('bf', 10)), now(), now(), now(),
             '', '', '', '',
             $4, '', '')
     RETURNING id`,
    [userId, email, password, "+8" + userId.replace(/-/g, "").slice(0, 12)]
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

/** The Phase 29 fixture shape (WITH tenant_slug → 0007 provisions a profile). */
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

const ONBOARDING_TABLES = [
  "subscriptions", "subscription_items", "tenant_modules", "tenant_settings",
  "public_site_settings", "system_audits", "notifications", "profiles", "tenants",
];

const CLEAN_TABLES = [...ONBOARDING_TABLES,
  "permission_grants", "invoices", "invoice_line_items", "payments", "payment_attempts",
  "refunds", "credits", "credit_applications", "billing_events"];

async function cleanup(
  sql: pg.Client, tenantIds: string[], emails: string[], slugs: string[]
): Promise<string[]> {
  try {
    const forceState = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [CLEAN_TABLES]);
    const wasForced = forceState.rows.filter((r) => r.forced).map((r) => r.relname);
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} NO FORCE ROW LEVEL SECURITY`);
    }
    try {
      try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
      for (let pass = 0; pass < 5; pass++) {
        await sql.query(
          `DELETE FROM politicore.credit_applications WHERE invoice_id IN
             (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))
            OR tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.payment_attempts WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.refunds WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.payments WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.invoice_line_items WHERE invoice_id IN
             (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.invoices WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.credits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.subscription_items WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.subscriptions WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1) OR slug = ANY($2)`, [tenantIds, slugs]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        // Self-healing: children of any tenant removed in replica mode.
        await sql.query(`DELETE FROM politicore.subscription_items s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.subscriptions s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.tenant_modules m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.tenant_settings m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.public_site_settings m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.notifications n WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = n.tenant_id)`);
        await sql.query(`DELETE FROM politicore.permission_grants g WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = g.tenant_id)`);
        await sql.query(`DELETE FROM politicore.system_audits a WHERE a.tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = a.tenant_id)`);
      }
      // Remove the probe tenants' keys from the EXISTING entitlement map.
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
    console.error("cleanup incomplete — remove self-service-onboarding fixtures manually:", (e as Error).message);
    return [];
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const slugs: string[] = [];
  const P = `Pl30!${SUFFIX}`;
  const SLUG = `p30s-${SUFFIX}`;
  const SLUG_RESUME = `p30r-${SUFFIX}`;
  const SLUG_EXISTING = `p30e-${SUFFIX}`;

  try {
    // ── Pre-clean: self-heal residue from an earlier interrupted run. ────
    const staleTenants = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.tenants WHERE slug LIKE 'p30s%' OR slug LIKE 'p30r%' OR slug LIKE 'p30e%'`
    )).rows.map((r) => r.id);
    if (staleTenants.length) {
      try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
      for (let pass = 0; pass < 3; pass++) {
        await sql.query(`DELETE FROM politicore.subscription_items WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.subscriptions WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.tenant_settings WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.profiles WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.subscription_items s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.subscriptions s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.tenant_modules m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.tenant_settings m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.public_site_settings m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.notifications n WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = n.tenant_id)`);
        await sql.query(`DELETE FROM politicore.profiles p WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = p.tenant_id)`);
        await sql.query(`DELETE FROM auth.users WHERE email LIKE '%@p30s.test.local' OR email LIKE '%@p30r.test.local' OR email LIKE '%@p30e.test.local'`);
      }
      try { await sql.query("SET session_replication_role = DEFAULT"); } catch { /* pooler */ }
      await sql.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, '{service_entitlements}',
                  COALESCE(settings -> 'service_entitlements', '{}'::jsonb) - $1::text[], true)
          WHERE id = 1`, [staleTenants]);
      console.log(`pre-clean: removed residue from ${staleTenants.length} stale tenant(s)`);
    }

    // ── M1 — anonymous pricing. ──────────────────────────────────────────
    const anonCat = await rpcCall("plan_catalog_public", {});
    const catRows = arr(anonCat.json);
    record("M1 anonymous public catalog exposes the active seed plans",
      anonCat.status === 200 && catRows.length >= 3
        && catRows.every((r) => !("version_id" in r) && !("plan_id" in r))
        && catRows.some((r) => r.plan_code === "starter"),
      `status ${anonCat.status} rows=${catRows.length} codes=[${catRows.map((r) => r.plan_code).join(",")}]`);

    // ── M2 — anonymous slug availability. ────────────────────────────────
    const avReserved = await rpcCall("tenant_slug_available", { p_slug: "www" });
    const avNorm = await rpcCall("tenant_slug_available", { p_slug: `  P30 --Smoke_${SUFFIX}! ` });
    const avFree = await rpcCall("tenant_slug_available", { p_slug: SLUG });
    const normSlug = avNorm.status === 200 ? String(arr(avNorm.json)[0]?.slug ?? "") : "";
    record("M2 anonymous availability: reserved/taken/available + server normalization",
      avReserved.status === 200 && String(arr(avReserved.json)[0]?.reason) === "reserved"
        && avNorm.status === 200 && normSlug === `p30-smoke-${SUFFIX}`
        && avFree.status === 200 && arr(avFree.json)[0]?.available === true,
      `www→${arr(avReserved.json)[0]?.reason}, normalized→${normSlug}, free→${arr(avFree.json)[0]?.reason}`);

    // ── M3 — anonymous cannot provision. ─────────────────────────────────
    const anonProv = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: SLUG, p_tenant_name: "P30 Anon Co", p_owner_name: null, p_plan_code: "starter", p_billing_interval: "monthly" });
    record("M3 anonymous cannot provision (grant-denied)", anonProv.status >= 400, `status ${anonProv.status}`);
    const anonState = await rpcCall("onboarding_state", {});
    record("M3 anonymous onboarding_state = signin (fail-closed, no leak)",
      anonState.status === 200 && arr(anonState.json).length === 1
        && arr(anonState.json)[0].stage === "signin" && arr(anonState.json)[0].tenant_id === null,
      `stage=${arr(anonState.json)[0]?.stage}`);

    // ── M4 — fixtures: bare identities + real tokens (+ existing-tenant users). ──
    // The 0007 backfill trigger validates tenant_slug against EXISTING
    // tenants — create the platform's fixture tenant BEFORE its users.
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantE = await insT(SLUG_EXISTING, "P30 Hosted Existing");
    tenantIds.push(tenantE);
    slugs.push(SLUG_EXISTING);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       SELECT $1, m, false FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) m`,
      [tenantE]);

    emails.push(
      `bare-${SUFFIX}@p30s.test.local`,
      `bare2-${SUFFIX}@p30s.test.local`,
      `plat-${SUFFIX}@p30e.test.local`,
      `adm-${SUFFIX}@p30e.test.local`);
    await createBareAuthUser(sql, emails[0], P);
    await createBareAuthUser(sql, emails[1], P);
    await createAuthUser(sql, emails[2], P, "P30 Platform Admin", SLUG_EXISTING);
    await createAuthUser(sql, emails[3], P, "P30 Plain Admin", SLUG_EXISTING);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'platform_super_admin' WHERE email = $1`, [emails[2]]);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE email = $1`, [emails[3]]);

    const bareToken = await signin(emails[0], P);
    const bare2Token = await signin(emails[1], P);
    const platformToken = await signin(emails[2], P);
    const adminToken = await signin(emails[3], P);

    const bareStage = await rpcCall("onboarding_state", {}, bareToken);
    record("M4 bare signup identity resolves stage create_tenant (no profile provisioned)",
      bareStage.status === 200 && arr(bareStage.json)[0]?.stage === "create_tenant",
      `stage=${arr(bareStage.json)[0]?.stage}`);

    // ── M5 — signup/provisioning: ONE RPC. ───────────────────────────────
    const prov = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: SLUG, p_tenant_name: "P30 Smoke Co", p_owner_name: "P30 Owner", p_plan_code: "starter", p_billing_interval: "monthly" },
      bareToken);
    const provRows = arr(prov.json);
    const tenantA = provRows[0]?.tenant_id ? String(provRows[0].tenant_id) : "";
    const subAId = provRows[0]?.subscription_id ? String(provRows[0].subscription_id) : "";
    if (tenantA) tenantIds.push(tenantA);
    slugs.push(SLUG);
    record("M5 one RPC provisions tenant + owner + subscription (slug normalized server-side)",
      prov.status === 200 && provRows.length === 1 && tenantA !== "" && subAId !== ""
        && String(provRows[0].tenant_slug) === SLUG && String(provRows[0].subscription_status) === "trialing",
      `status ${prov.status} tenant=${tenantA.slice(0, 8)}… sub=${subAId.slice(0, 8)}…`);

    // ── M6 — owner authority. ────────────────────────────────────────────
    const profA = (await sql.query(
      `SELECT p.access_role::text AS role, p.tenant_id::text AS tenant, p.email
         FROM politicore.profiles p WHERE p.email = $1`, [emails[0]])).rows[0] as Record<string, unknown> | undefined;
    record("M6 account creator became tenant_super_admin of the NEW tenant",
      !!profA && String(profA.role) === "tenant_super_admin" && String(profA.tenant) === tenantA,
      `role=${profA?.role} tenant=${String(profA?.tenant ?? "?").slice(0, 8)}…`);

    // ── M7 — subscription creation details. ──────────────────────────────
    const subA = subAId ? (await sql.query(
      `SELECT s.status::text AS status, s.trial_start, s.trial_end, s.currency, s.billing_interval::text AS interval,
              i.unit_price_minor, i.item_type::text AS item_type
         FROM politicore.subscriptions s
         JOIN politicore.subscription_items i ON i.subscription_id = s.id
        WHERE s.id = $1`, [subAId])).rows[0] as Record<string, unknown> : ({} as Record<string, unknown>);
    const trialDays = subA.trial_end && subA.trial_start
      ? Math.abs(Number(subA.trial_end) - Number(subA.trial_start) - 14 * 86400000) < 5000 : false;
    record("M7 subscription: trialing, 14-day trial, base_plan item, NGN 1500000",
      subA.status === "trialing" && trialDays
        && String(subA.item_type) === "base_plan" && Number(subA.unit_price_minor) === 1500000
        && String(subA.currency) === "NGN" && String(subA.interval) === "monthly",
      `status=${subA.status} trial14=${trialDays} price=${subA.unit_price_minor}`);

    // ── M8 — trial state. ────────────────────────────────────────────────
    const invCount = tenantA ? Number((await sql.query(
      `SELECT count(*)::text AS n FROM politicore.invoices WHERE tenant_id = $1`, [tenantA])).rows[0].n) : -1;
    record("M8 trial started with NO invoices (no payment method implied)",
      invCount === 0, `invoices=${invCount}`);
    const stAfter = await rpcCall("onboarding_state", {}, bareToken);
    const stAfterRow = arr(stAfter.json)[0] ?? {};
    record("M8 next_step communicates no auto-charge (trialing copy)",
      stAfterRow.stage === "enter_app"
        && String(stAfterRow.next_step).includes("nothing is charged automatically")
        && String(stAfterRow.next_step).includes("no payment method is on file"),
      `stage=${stAfterRow.stage} next="${String(stAfterRow.next_step).slice(0, 60)}…"`);

    // ── M9 — entitlement map. ────────────────────────────────────────────
    const entRow = tenantA ? (await sql.query(
      `SELECT settings -> 'service_entitlements' -> $1 AS map FROM politicore.platform_settings WHERE id = 1`,
      [tenantA])).rows[0] as Record<string, unknown> : ({} as Record<string, unknown>);
    const entMap = (entRow.map ?? {}) as Record<string, unknown>;
    const planMods = tenantA ? (await sql.query<{ included: string[] }>(
      `SELECT ARRAY(SELECT m.module::text FROM politicore.tenant_modules m
         WHERE m.tenant_id = $1 AND m.enabled ORDER BY m.module::text) AS included`, [tenantA])).rows[0].included : [];
    const entTrue = Object.keys(entMap).filter((k) => entMap[k] === true).sort();
    record("M9 entitlement map matches the plan's enabled modules exactly",
      entTrue.join(",") === planMods.join(",") && planMods.length > 0,
      `map=${entTrue.join(",")} vs modules=${planMods.join(",")}`);

    // ── M10 — billing visibility via the state RPC. ──────────────────────
    record("M10 onboarding_state enter_app carries plan + interval + trial_end",
      stAfterRow.plan_code === "starter" && stAfterRow.billing_interval === "monthly"
        && stAfterRow.trial_end !== null && stAfterRow.access_role === "tenant_super_admin",
      `plan=${stAfterRow.plan_code} interval=${stAfterRow.billing_interval}`);

    // ── M11 — duplicate prevention. ──────────────────────────────────────
    const dupOwner = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: `${SLUG}-b`, p_tenant_name: "P30 Second Co", p_owner_name: null, p_plan_code: "starter", p_billing_interval: "monthly" },
      bareToken);
    const dupSlug = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: SLUG, p_tenant_name: "P30 Smoke Co", p_owner_name: null, p_plan_code: "starter", p_billing_interval: "monthly" },
      bare2Token);
    const liveSubs = Number((await sql.query(
      `SELECT count(*)::text AS n FROM politicore.subscriptions WHERE tenant_id = $1 AND ended_at IS NULL`,
      [tenantA])).rows[0].n);
    record("M11 duplicate owner + duplicate slug denied; exactly one live subscription",
      dupOwner.status >= 400 && String(dupOwner.bodyText).includes("already belongs to a tenant")
        && dupSlug.status >= 400 && String(dupSlug.bodyText).includes("already taken")
        && liveSubs === 1,
      `owner=${dupOwner.status} slug=${dupSlug.status} liveSubs=${liveSubs}`);

    // ── M12 — interrupted/resumed journey. ───────────────────────────────
    const resumeBefore = await rpcCall("onboarding_state", {}, bare2Token);
    const resumeProv = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: SLUG_RESUME, p_tenant_name: "P30 Resume Co", p_owner_name: null, p_plan_code: "professional", p_billing_interval: "annual" },
      bare2Token);
    const resumeRows = arr(resumeProv.json);
    const tenantR = resumeRows[0]?.tenant_id ? String(resumeRows[0].tenant_id) : "";
    if (tenantR) tenantIds.push(tenantR);
    slugs.push(SLUG_RESUME);
    const resumeAfter = await rpcCall("onboarding_state", {}, bare2Token);
    const rAfter = arr(resumeAfter.json)[0] ?? {};
    record("M12 interrupted identity (create_tenant) completes LATER via the same RPC",
      resumeBefore.status === 200 && arr(resumeBefore.json)[0]?.stage === "create_tenant"
        && resumeProv.status === 200 && String(resumeRows[0]?.subscription_status) === "trialing"
        && rAfter.stage === "enter_app" && rAfter.plan_code === "professional"
        && rAfter.billing_interval === "annual",
      `before=${arr(resumeBefore.json)[0]?.stage} after=${rAfter.stage} plan=${rAfter.plan_code}/${rAfter.billing_interval}`);

    // ── M13 — cross-tenant denial via the state surface. ─────────────────
    const aState = await rpcCall("onboarding_state", {}, bareToken);
    const aRow = arr(aState.json)[0] ?? {};
    record("M13 state RPC resolves ONLY the caller's own tenant (server-side identity)",
      aState.status === 200 && arr(aState.json).length === 1
        && String(aRow.tenant_id) === tenantA && String(aRow.tenant_slug) === SLUG,
      `rows=${arr(aState.json).length} tenant=${String(aRow.tenant_id).slice(0, 8)}…`);

    // ── M14 — plain-admin denial. ────────────────────────────────────────
    const adminProv = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: `p30a-${SUFFIX}`, p_tenant_name: "P30 Admin Co", p_owner_name: null, p_plan_code: "starter", p_billing_interval: "monthly" },
      adminToken);
    record("M14 plain admin (existing profile) cannot onboard",
      adminProv.status >= 400 && String(adminProv.bodyText).includes("already belongs to a tenant"),
      `status ${adminProv.status}`);

    // ── M15 — platform authority retained + platform-admin onboarding denial. ──
    const platProv = await rpcCall("complete_tenant_onboarding",
      { p_tenant_slug: `p30p-${SUFFIX}`, p_tenant_name: "P30 Platform Co", p_owner_name: null, p_plan_code: "starter", p_billing_interval: "monthly" },
      platformToken);
    const platCatalog = await rpcCall("plan_catalog_admin", {}, platformToken);
    record("M15 platform admin cannot onboard but retains platform authority",
      platProv.status >= 400 && String(platProv.bodyText).includes("already belongs to a tenant")
        && platCatalog.status === 200 && arr(platCatalog.json).length >= 3,
      `onboard=${platProv.status} catalog=${platCatalog.status} rows=${arr(platCatalog.json).length}`);

    // ── M16 — RLS/tenant isolation. ──────────────────────────────────────
    const tenantBState = await rpcCall("onboarding_state", {}, bare2Token);
    const bRow = arr(tenantBState.json)[0] ?? {};
    record("M16 two onboarded owners resolve distinct tenants (isolation through the RPC surface)",
      String(bRow.tenant_id) === tenantR && String(aRow.tenant_id) === tenantA
        && tenantA !== tenantR,
      `A=${String(aRow.tenant_id).slice(0, 8)}… R=${String(bRow.tenant_id).slice(0, 8)}…`);

    // ── M17 — migration pin/signature integrity. ─────────────────────────
    const migDir = path.resolve("supabase", "migrations");
    const migFiles = fs.readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const mig0068 = fs.readFileSync(path.join(migDir, "0068_self_service_tenant_onboarding.sql"), "utf8");
    const sig = mig0068.includes("self-service onboarding requires an authenticated session")
      && mig0068.includes("only for new tenant owners")
      && mig0068.includes("'www'");
    record("M17 migration pin 69/latest-0068 + signature content intact",
      migFiles.length === 69 && /^0068_/.test(migFiles[migFiles.length - 1]) && sig,
      `migrations=${migFiles.length} latest=${migFiles[migFiles.length - 1]} signature=${sig}`);

    // ── M18 — audits + notification evidence. ────────────────────────────
    const audits = tenantA ? (await sql.query(
      `SELECT action FROM politicore.system_audits WHERE tenant_id = $1 AND action = ANY($2)`,
      [tenantA, ["tenant:onboarding_completed", "subscription_created", "subscription_trial_started", "entitlements_synchronized"]]
    )).rows.map((r) => String((r as Record<string, unknown>).action)) : [];
    const notifCount = tenantA ? Number((await sql.query(
      `SELECT count(*)::text AS n FROM politicore.notifications WHERE tenant_id = $1`,
      [tenantA])).rows[0].n) : -1;
    record("M18 audit trail (onboarding + subscription + trial + entitlements) and trial notification",
      audits.includes("tenant:onboarding_completed") && audits.includes("subscription_created")
        && audits.includes("subscription_trial_started") && audits.includes("entitlements_synchronized")
        && notifCount >= 1,
      `audits=[${[...new Set(audits)].join(",")}] notifications=${notifCount}`);

    // ── M18b — pristine cleanup + residue 0 + FORCE RLS restored. ────────
    await cleanup(sql, tenantIds, emails, slugs);
    const res2 = await sql.query(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'p30s%' OR slug LIKE 'p30r%' OR slug LIKE 'p30e%' OR slug LIKE 'p30a-%' OR slug LIKE 'p30p-%') AS tenants,
              (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@p30s.test.local' OR email LIKE '%@p30e.test.local') AS profiles,
              (SELECT count(*)::text FROM politicore.subscriptions WHERE tenant_id = ANY($1)) AS subs,
              (SELECT count(*)::text FROM politicore.system_audits WHERE tenant_id = ANY($1)) AS audits,
              (SELECT count(*)::text FROM politicore.notifications WHERE tenant_id = ANY($1)) AS notifs,
              (SELECT count(*)::text FROM politicore.tenant_modules WHERE tenant_id = ANY($1)) AS modules,
              (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@p30s.test.local' OR email LIKE '%@p30e.test.local') AS users,
              (SELECT count(*)::text FROM politicore.platform_settings ps,
                    LATERAL (SELECT settings -> 'service_entitlements' se) s
               WHERE ps.id = 1 AND se ?| $2) AS ent_keys`,
      [tenantIds, tenantIds]);
    const r18 = res2.rows[0];
    record("M18b hosted residue 0 (tenants/profiles/subs/audits/notifs/modules/users/entKeys)",
      r18.tenants === "0" && r18.profiles === "0" && r18.subs === "0" && r18.audits === "0"
        && r18.notifs === "0" && r18.modules === "0" && r18.users === "0" && r18.ent_keys === "0",
      `tenants=${r18.tenants} profiles=${r18.profiles} subs=${r18.subs} audits=${r18.audits} notifs=${r18.notifs} modules=${r18.modules} users=${r18.users} entKeys=${r18.ent_keys}`);

    const checkTables = [...ONBOARDING_TABLES];
    const postForce = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [checkTables]);
    const unforced = postForce.rows.filter((r) => !r.forced).map((r) => r.relname);
    record("M18c FORCE RLS restored on every onboarding-adjacent table after cleanup",
      postForce.rows.length === checkTables.length && unforced.length === 0,
      `restored=${postForce.rows.length - unforced.length}/${checkTables.length} unforced=[${unforced.join(",")}]`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`SELF-SERVICE ONBOARDING HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
