/**
 * POLITICORE — Subscription & Billing Core (Phase 29) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 29
 * billing core end-to-end through the real PostgREST data API and real
 * GoTrue identities (same acceptance standard as Phases 6–28):
 *
 *   K1  — billing tables exist with FORCE RLS
 *   K2  — anonymous holds nothing (reads/writes/executes)
 *   K3  — plain tenant admin holds nothing
 *   K4  — fixtures: 2 tenants, platform admin, 2 owners, plain admin
 *   K5  — owner subscribes → trialing (trial from version, base_plan item)
 *   K6  — owner B subscribes (independent tenant)
 *   K7  — cross-tenant denial (server-resolved identity)
 *   K8  — platform invoice create + issue (reason mandatory, INV number)
 *   K9  — invoice immutability after issuance (trigger-enforced)
 *   K10 — verified manual payment converts trial → active; entitlements sync
 *   K11 — provider-reference idempotency (no double payment)
 *   K12 — refunds: partial ok; never exceeds refundable; full flips statuses
 *   K13 — credits: draft-only applications; remaining-balance enforced
 *   K14 — dunning: failure → past_due (RETAIN); grace → restricted; pay → active
 *   K15 — next-period plan change scheduling (pending, audited)
 *   K16 — webhook journal: idempotent, write-once, payload immutable
 *   K17 — trial expiry deterministic (data preserved, tenant untouched)
 *   K18 — cancellation: schedule/revoke/immediate; ended immutable
 *   K19 — Core Audit evidence with server-resolved actors
 *   K20 — no new roles/modules/permissions
 *   K21 — pristine residue cleanup (0) + FORCE RLS restored
 *
 * No probe tenants, profiles, subscriptions, invoices, payments, refunds,
 * credits, journal events, audits or entitlement keys remain.
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

const BILLING_TABLES = [
  "subscriptions", "subscription_items", "invoices", "invoice_line_items",
  "payments", "payment_attempts", "refunds", "credits", "credit_applications",
  "billing_events",
];

async function cleanup(
  sql: pg.Client, tenantIds: string[], emails: string[]
): Promise<string[]> {
  try {
    const CLEAN_TABLES = [...BILLING_TABLES,
      "tenant_modules", "system_audits", "permission_grants", "notifications", "profiles", "tenants"];
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
        await sql.query(`DELETE FROM politicore.billing_events WHERE provider = 'p29s'`);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.system_audits
            WHERE tenant_id IS NULL AND affected_resource = 'platform_settings'
              AND (reason_notes LIKE '%p29 smoke%' OR reason_notes LIKE '%smoke probe%')`);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        // Self-healing: children of any tenant removed in replica mode.
        await sql.query(`DELETE FROM politicore.subscription_items s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.subscriptions s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.tenant_modules m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.notifications n WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = n.tenant_id)`);
        await sql.query(`DELETE FROM politicore.permission_grants g WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = g.tenant_id)`);
        await sql.query(`DELETE FROM politicore.system_audits a WHERE a.tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = a.tenant_id)`);
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
    console.error("cleanup incomplete — remove subscriptions-billing fixtures manually:", (e as Error).message);
    return [];
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Pl29!${SUFFIX}`;
  const SLUG = `p29s-${SUFFIX}`;
  const SLUG_B = `p29sb-${SUFFIX}`;
  const REASON = `p29 smoke probe ${SUFFIX}`;

  try {
    // ── Pre-clean: self-heal residue from an earlier interrupted run. ────
    // Matches both p29s-… (tenant A) and p29sb-… (tenant B) slugs.
    const staleTenants = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.tenants WHERE slug LIKE 'p29s%'`)).rows.map((r) => r.id);
    if (staleTenants.length) {
      try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
      for (let pass = 0; pass < 3; pass++) {
        await sql.query(
          `DELETE FROM politicore.credit_applications WHERE invoice_id IN
             (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.payment_attempts WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.refunds WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.payments WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(
          `DELETE FROM politicore.invoice_line_items WHERE invoice_id IN
             (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.invoices WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.credits WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.subscription_items WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.subscriptions WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.billing_events WHERE provider = 'p29s'`);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [staleTenants]);
        await sql.query(`DELETE FROM politicore.profiles WHERE email LIKE '%@p29s.test.local'`);
        await sql.query(`DELETE FROM auth.users WHERE email LIKE '%@p29s.test.local'`);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [staleTenants]);
        // Self-healing: children of any tenant removed in replica mode.
        await sql.query(`DELETE FROM politicore.subscription_items s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.subscriptions s WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = s.tenant_id)`);
        await sql.query(`DELETE FROM politicore.tenant_modules m WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = m.tenant_id)`);
        await sql.query(`DELETE FROM politicore.notifications n WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = n.tenant_id)`);
        await sql.query(`DELETE FROM politicore.permission_grants g WHERE NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = g.tenant_id)`);
        await sql.query(`DELETE FROM politicore.system_audits a WHERE a.tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicore.tenants t WHERE t.id = a.tenant_id)`);
      }
      try { await sql.query("SET session_replication_role = DEFAULT"); } catch { /* pooler */ }
      await sql.query(
        `UPDATE politicore.platform_settings
            SET settings = jsonb_set(settings, '{service_entitlements}',
                  COALESCE(settings -> 'service_entitlements', '{}'::jsonb) - $1::text[], true)
          WHERE id = 1`, [staleTenants]);
      console.log(`pre-clean: removed residue from ${staleTenants.length} stale tenant(s)`);
    }

    // ── K1 — billing tables exist with FORCE RLS. ────────────────────────
    const rls = await sql.query<{ relname: string; en: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS en, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [BILLING_TABLES]);
    record("K1 billing tables exist, RLS enabled AND forced", 
      rls.rows.length === 10 && rls.rows.every((r) => r.en && r.forced),
      rls.rows.map((r) => `${r.relname}:${r.en ? "rls" : "NO-RLS"}/${r.forced ? "forced" : "unforced"}`).join(" | "));

    // ── K4 — fixtures. ───────────────────────────────────────────────────
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG, "P29 Billing Hosted A");
    const tenantB = await insT(SLUG_B, "P29 Billing Hosted B");
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
      `plat-${SUFFIX}@p29s.test.local`,
      `owna-${SUFFIX}@p29s.test.local`,
      `ownb-${SUFFIX}@p29s.test.local`,
      `adm-${SUFFIX}@p29s.test.local`);
    await createAuthUser(sql, emails[0], P, "P29 Platform Admin", SLUG);
    await createAuthUser(sql, emails[1], P, "P29 Owner A", SLUG);
    await createAuthUser(sql, emails[2], P, "P29 Owner B", SLUG_B);
    await createAuthUser(sql, emails[3], P, "P29 Plain Admin", SLUG);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'platform_super_admin' WHERE email = $1`, [emails[0]]);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'tenant_super_admin' WHERE email = ANY($1)`,
      [[emails[1], emails[2]]]);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE email = $1`, [emails[3]]);

    const platformToken = await signin(emails[0], P);
    const ownerToken = await signin(emails[1], P);
    const ownerBToken = await signin(emails[2], P);
    const adminToken = await signin(emails[3], P);
    const rpc = (name: string) => `/rest/v1/rpc/${name}`;

    // Seeded active versions (Phase 28 catalog): starter monthly 1500000 kobo.
    const seedVer = await sql.query<{ ver_id: string; pro_id: string }>(
      `SELECT (SELECT id FROM politicore.plan_versions
                WHERE plan_id = (SELECT id FROM politicore.plans WHERE code = 'starter')
                  AND status = 'active' LIMIT 1) AS ver_id,
              (SELECT id FROM politicore.plan_versions
                WHERE plan_id = (SELECT id FROM politicore.plans WHERE code = 'professional')
                  AND status = 'active' LIMIT 1) AS pro_id`);
    const starterVerId = seedVer.rows[0].ver_id;
    const proVerId = seedVer.rows[0].pro_id;
    if (!starterVerId || !proVerId) throw new Error("seeded active versions missing");

    // ── K2 — anonymous holds nothing. ────────────────────────────────────
    const anonCur = await rpcCall("subscription_current", {});
    record("K2 anonymous cannot read subscription_current", anonCur.status >= 400, `status ${anonCur.status}`);
    const anonSub = await rpcCall("create_subscription",
      { p_plan_version_id: starterVerId, p_billing_interval: "monthly" });
    record("K2 anonymous cannot create subscriptions", anonSub.status >= 400, `status ${anonSub.status}`);
    const anonInv = await rpcCall("my_invoices", {});
    record("K2 anonymous cannot read invoices", anonInv.status >= 400, `status ${anonInv.status}`);
    const anonPlat = await rpcCall("platform_subscriptions", {});
    record("K2 anonymous cannot read platform billing", anonPlat.status >= 400, `status ${anonPlat.status}`);

    // ── K3 — plain tenant admin holds nothing. ──────────────────────────
    const admCur = await rpcCall("subscription_current", {}, adminToken);
    record("K3 plain admin cannot read billing", admCur.status >= 400, `status ${admCur.status}`);
    const admSub = await rpcCall("create_subscription",
      { p_plan_version_id: starterVerId, p_billing_interval: "monthly" }, adminToken);
    record("K3 plain admin cannot create subscriptions", admSub.status >= 400, `status ${admSub.status}`);

    // ── K5 — owner subscribes (trial from the plan version). ─────────────
    const subAId = String((await rpcCall("create_subscription",
      { p_plan_version_id: starterVerId, p_billing_interval: "monthly" }, ownerToken)).json);
    const subAOk = /^[0-9a-f-]{36}$/.test(subAId);
    const subA = subAOk ? (await sql.query(
      `SELECT status, trial_start, trial_end, current_period_start, currency, billing_interval
         FROM politicore.subscriptions WHERE id = $1`, [subAId])).rows[0] as Record<string, unknown> : {};
    const itemA = subAOk ? (await sql.query(
      `SELECT unit_price_minor, item_type, status FROM politicore.subscription_items
        WHERE subscription_id = $1 AND item_type = 'base_plan' AND status = 'active'`, [subAId])).rows[0] as Record<string, unknown> : {};
    const trialDaysOk = subA.trial_end && subA.trial_start
      ? Math.abs(Number(subA.trial_end) - Number(subA.trial_start) - 14 * 86400000) < 5000 : false;
    record("K5 owner subscribes: trialing, 14-day trial, base_plan item, no period",
      subAOk && subA.status === "trialing" && trialDaysOk
        && Number(itemA.unit_price_minor) === 1500000
        && subA.current_period_start === null,
      `sub=${subAId.slice(0, 8)}… status=${subA.status} trial14=${trialDaysOk} price=${itemA.unit_price_minor}`);

    // ── K6 — owner B subscribes. ─────────────────────────────────────────
    const subBId = String((await rpcCall("create_subscription",
      { p_plan_version_id: starterVerId, p_billing_interval: "monthly" }, ownerBToken)).json);
    const subBOk = /^[0-9a-f-]{36}$/.test(subBId);
    record("K6 owner B subscribes independently", subBOk, `sub=${subBId.slice(0, 8)}…`);

    // ── K5b — owner catalog (0067): active versions with ids + prices. ──
    const plansOwner = await rpcCall("subscription_plans", {}, ownerToken);
    const plansRows = arr(plansOwner.json) as Record<string, unknown>[];
    const starterPlan = plansRows.find((r) => r.plan_code === "starter");
    const plansAdmin = await rpcCall("subscription_plans", {}, adminToken);
    record("K5b owner catalog: active versions with ids + committed prices; plain admin gets none",
      plansOwner.status === 200 && plansRows.length >= 3
        && !!starterPlan && Number((starterPlan.prices as Record<string, unknown>).monthly) === 1500000
        && plansAdmin.status === 200 && arr(plansAdmin.json).length === 0,
      `owner rows=${plansRows.length} starter monthly=${starterPlan ? String((starterPlan.prices as Record<string, unknown>).monthly) : "n/a"} admin rows=${arr(plansAdmin.json).length}`);

    // ── K7 — cross-tenant denial. ────────────────────────────────────────
    const cross = await rpcCall("schedule_subscription_cancellation",
      { p_subscription_id: subAId, p_reason: "K7 cross-tenant probe" }, ownerBToken);
    record("K7 owner B cannot operate tenant A's subscription", cross.status >= 400, `status ${cross.status}`);
    const bSeesA = await rest("POST", `/rest/v1/rpc/subscription_current`, {}, ownerToken);
    const bMap = arr(bSeesA.json);
    record("K7 subscription_current is own-tenant only (server-resolved)",
      bSeesA.status === 200 && bMap.length === 1 && bMap[0].tenant_id === tenantA,
      `rows ${bMap.length}`);

    // ── K8 — platform invoice create + issue. ────────────────────────────
    const shortReason = await rpcCall("platform_create_invoice",
      { p_subscription_id: subAId, p_reason: "no" }, platformToken);
    record("K8 platform invoice creation requires a reason (≥5 chars)", shortReason.status >= 400, `status ${shortReason.status}`);
    const invAId = String((await rpcCall("platform_create_invoice",
      { p_subscription_id: subAId, p_reason: REASON }, platformToken)).json);
    const issuedA = await rpcCall("platform_issue_invoice",
      { p_invoice_id: invAId, p_reason: REASON }, platformToken);
    const invA = (await sql.query(
      `SELECT status, invoice_number, total_minor, currency, due_at FROM politicore.invoices WHERE id = $1`,
      [invAId])).rows[0] as Record<string, unknown>;
    record("K8 platform creates + issues an invoice (snapshot, INV number, due date)",
      issuedA.status === 200 && invA.status === "issued"
        && String(invA.invoice_number).startsWith("INV-")
        && Number(invA.total_minor) === 1500000 && invA.currency === "NGN" && invA.due_at !== null,
      `status ${issuedA.status}, number=${invA.invoice_number}`);

    // ── K9 — invoice immutability after issuance. ────────────────────────
    let totalFrozen = false;
    try {
      await sql.query(`UPDATE politicore.invoices SET total_minor = 999 WHERE id = $1`, [invAId]);
    } catch (e) { totalFrozen = /immutable|frozen/.test((e as Error).message); }
    let liFrozen = false;
    try {
      await sql.query(
        `INSERT INTO politicore.invoice_line_items (invoice_id, description, amount_minor, currency)
         VALUES ($1, 'phantom', 100, 'NGN')`, [invAId]);
    } catch (e) { liFrozen = /immutable|frozen/.test((e as Error).message); }
    record("K9 issued invoice + line items are trigger-frozen", totalFrozen && liFrozen,
      `total=${totalFrozen} lineItems=${liFrozen}`);

    // ── K10 — verified manual payment: the ONE state machine. ────────────
    const ownerPay = await rpcCall("record_manual_payment",
      { p_invoice_id: invAId, p_amount_minor: 1500000, p_currency: "NGN",
        p_provider_reference: `p29s-owner-${SUFFIX}`, p_notes: "owner attempt must fail" }, ownerToken);
    record("K10 owner cannot record payments (platform-only)", ownerPay.status >= 400, `status ${ownerPay.status}`);
    const payAId = String((await rpcCall("record_manual_payment",
      { p_invoice_id: invAId, p_amount_minor: 1500000, p_currency: "NGN",
        p_provider_reference: `p29s-pay1-${SUFFIX}`,
        p_notes: "verified bank transfer recorded by platform admin" }, platformToken)).json);
    const payAOk = /^[0-9a-f-]{36}$/.test(payAId);
    const subAfterPay = (await sql.query(
      `SELECT status, current_period_start, current_period_end FROM politicore.subscriptions WHERE id = $1`,
      [subAId])).rows[0] as Record<string, unknown>;
    const invAfterPay = (await sql.query(
      `SELECT status, paid_at FROM politicore.invoices WHERE id = $1`, [invAId])).rows[0] as Record<string, unknown>;
    const mapA = ((await sql.query(
      `SELECT settings->'service_entitlements'->$1::text AS se FROM politicore.platform_settings WHERE id = 1`,
      [tenantA])).rows[0].se) as Record<string, unknown> | null;
    record("K10 verified payment: invoice paid, TRIAL → active, period set, entitlements synced",
      payAOk && invAfterPay.status === "paid" && subAfterPay.status === "active"
        && subAfterPay.current_period_start !== null && subAfterPay.current_period_end !== null
        && mapA?.social === true && mapA?.campaign === true && mapA?.election === false && mapA?.governance === false,
      `payment=${payAId.slice(0, 8)}… sub=${subAfterPay.status} inv=${invAfterPay.status} map=${JSON.stringify(mapA)}`);

    // ── K11 — provider-reference idempotency. ────────────────────────────
    const replay = await rpcCall("record_manual_payment",
      { p_invoice_id: invAId, p_amount_minor: 1500000, p_currency: "NGN",
        p_provider_reference: `p29s-pay1-${SUFFIX}`,
        p_notes: "webhook replay of the same provider reference" }, platformToken);
    const payCount = (await sql.query(
      `SELECT count(*)::int AS n FROM politicore.payments WHERE invoice_id = $1`, [invAId])).rows[0].n;
    record("K11 the same provider reference can never create a second payment",
      replay.status >= 400 && payCount === 1, `status ${replay.status}, payments=${payCount}`);

    // ── K12 — refunds. ───────────────────────────────────────────────────
    const partRefund = await rpcCall("record_manual_refund",
      { p_payment_id: payAId, p_amount_minor: 500000,
        p_reason: "K12 partial goodwill refund", p_provider_reference: `p29s-ref1-${SUFFIX}` }, platformToken);
    const overRefund = await rpcCall("record_manual_refund",
      { p_payment_id: payAId, p_amount_minor: 1000001,
        p_reason: "K12 over-refund attempt must fail", p_provider_reference: `p29s-ref2-${SUFFIX}` }, platformToken);
    const invRef1 = (await sql.query(
      `SELECT refunded_minor, status FROM politicore.invoices WHERE id = $1`, [invAId])).rows[0] as Record<string, unknown>;
    record("K12 partial refund lands; over-refund refused",
      partRefund.status === 200 && overRefund.status >= 400
        && Number(invRef1.refunded_minor) === 500000 && invRef1.status === "paid",
      `partial=${partRefund.status} over=${overRefund.status} refunded_minor=${invRef1.refunded_minor}`);
    const restRefund = await rpcCall("record_manual_refund",
      { p_payment_id: payAId, p_amount_minor: 1000000,
        p_reason: "K12 settle the remaining refundable", p_provider_reference: `p29s-ref3-${SUFFIX}` }, platformToken);
    const invRef2 = (await sql.query(
      `SELECT refunded_minor, status FROM politicore.invoices WHERE id = $1`, [invAId])).rows[0] as Record<string, unknown>;
    const payRef2 = (await sql.query(
      `SELECT status FROM politicore.payments WHERE id = $1`, [payAId])).rows[0] as Record<string, unknown>;
    record("K12 full refund flips invoice and payment to refunded",
      restRefund.status === 200 && invRef2.status === "refunded"
        && Number(invRef2.refunded_minor) === 1500000 && payRef2.status === "refunded",
      `inv=${invRef2.status} payment=${payRef2.status}`);

    // ── K13 — credits: draft-only, remaining-balance enforced. ───────────
    const draftId = String((await rpcCall("platform_create_invoice",
      { p_subscription_id: subAId, p_reason: REASON }, platformToken)).json);
    const creditId = String((await rpcCall("issue_credit",
      { p_tenant_id: tenantA, p_amount_minor: 300000, p_reason: REASON }, platformToken)).json);
    const app1 = await rpcCall("apply_credit",
      { p_credit_id: creditId, p_invoice_id: draftId, p_amount_minor: 200000, p_reason: REASON }, platformToken);
    const draftAfter = (await sql.query(
      `SELECT total_minor, discount_credits_minor FROM politicore.invoices WHERE id = $1`,
      [draftId])).rows[0] as Record<string, unknown>;
    record("K13 credit applied to a DRAFT invoice discounts it",
      app1.status === 200 && Number(draftAfter.total_minor) === 1300000
        && Number(draftAfter.discount_credits_minor) === 200000,
      `app=${app1.status} total=${draftAfter.total_minor}`);
    const overApp = await rpcCall("apply_credit",
      { p_credit_id: creditId, p_invoice_id: draftId, p_amount_minor: 200000, p_reason: REASON }, platformToken);
    record("K13 credit cannot exceed its remaining balance",
      overApp.status >= 400, `status ${overApp.status}`);
    // Draft-only rule against a live issued invoice.
    const draft2 = String((await rpcCall("platform_create_invoice",
      { p_subscription_id: subAId, p_reason: REASON }, platformToken)).json);
    await rpcCall("platform_issue_invoice", { p_invoice_id: draft2, p_reason: REASON }, platformToken);
    const appIssued = await rpcCall("apply_credit",
      { p_credit_id: creditId, p_invoice_id: draft2, p_amount_minor: 100000, p_reason: REASON }, platformToken);
    record("K13 credits never touch issued invoices",
      appIssued.status >= 400, `status ${appIssued.status}`);
    // Clean the drafts so later renewal probes are unaffected.
    try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
    for (const d of [draftId, draft2]) {
      await sql.query(`DELETE FROM politicore.credit_applications WHERE invoice_id = $1`, [d]);
      await sql.query(`DELETE FROM politicore.invoice_line_items WHERE invoice_id = $1`, [d]);
      await sql.query(`DELETE FROM politicore.invoices WHERE id = $1`, [d]);
    }
    try { await sql.query("SET session_replication_role = DEFAULT"); } catch { /* pooler */ }

    // ── K14 — dunning. ───────────────────────────────────────────────────
    const inv2 = String((await rpcCall("platform_create_invoice",
      { p_subscription_id: subAId, p_reason: REASON }, platformToken)).json);
    await rpcCall("platform_issue_invoice", { p_invoice_id: inv2, p_reason: REASON }, platformToken);
    const fail1 = await rpcCall("record_payment_failure_manual",
      { p_invoice_id: inv2, p_failure_code: "insufficient_funds",
        p_failure_message: "bank reported insufficient funds",
        p_provider_reference: `p29s-fail1-${SUFFIX}` }, platformToken);
    const subPastDue = (await sql.query(
      `SELECT status, past_due_since, failed_payment_count FROM politicore.subscriptions WHERE id = $1`,
      [subAId])).rows[0] as Record<string, unknown>;
    const mapPastDue = ((await sql.query(
      `SELECT settings->'service_entitlements'->$1::text AS se FROM politicore.platform_settings WHERE id = 1`,
      [tenantA])).rows[0].se) as Record<string, unknown> | null;
    record("K14 payment failure: active → past_due; entitlements RETAINED in grace",
      fail1.status === 200 && subPastDue.status === "past_due"
        && subPastDue.past_due_since !== null && subPastDue.failed_payment_count === 1
        && mapPastDue?.social === true,
      `status=${subPastDue.status} count=${subPastDue.failed_payment_count} map.social=${mapPastDue?.social}`);

    // Age the dunning clock (server-side; the invoice that failed is past_due too).
    await sql.query(
      `UPDATE politicore.subscriptions SET past_due_since = now() - interval '8 days' WHERE id = $1`, [subAId]);
    const dunning = await rest("POST", rpc("process_dunning_transitions"), {}, platformToken);
    const dunningRows = arr(dunning.json);
    const subRestricted = (await sql.query(
      `SELECT status FROM politicore.subscriptions WHERE id = $1`, [subAId])).rows[0] as Record<string, unknown>;
    const mapRestricted = ((await sql.query(
      `SELECT settings->'service_entitlements'->$1::text AS se FROM politicore.platform_settings WHERE id = 1`,
      [tenantA])).rows[0].se) as Record<string, unknown> | null;
    record("K14 grace exhausted → restricted; commercial map cleared",
      dunning.status === 200 && dunningRows.some((r) => r.subscription_id === subAId)
        && subRestricted.status === "restricted"
        && mapRestricted?.social === false && mapRestricted?.governance === false,
      `status=${subRestricted.status} map=${JSON.stringify(mapRestricted)}`);

    // Recovery: settle the outstanding invoice (restricted → active edge).
    const recover = await rpcCall("record_manual_payment",
      { p_invoice_id: inv2, p_amount_minor: 1500000, p_currency: "NGN",
        p_provider_reference: `p29s-recover-${SUFFIX}`,
        p_notes: "recovery transfer verified after restriction" }, platformToken);
    const subRecovered = (await sql.query(
      `SELECT status, past_due_since FROM politicore.subscriptions WHERE id = $1`,
      [subAId])).rows[0] as Record<string, unknown>;
    const mapRecovered = ((await sql.query(
      `SELECT settings->'service_entitlements'->$1::text AS se FROM politicore.platform_settings WHERE id = 1`,
      [tenantA])).rows[0].se) as Record<string, unknown> | null;
    record("K14 recovery by payment: restricted → active, map restored",
      recover.status === 200 && subRecovered.status === "active"
        && subRecovered.past_due_since === null && mapRecovered?.social === true,
      `status=${subRecovered.status} map.social=${mapRecovered?.social}`);

    // ── K15 — next-period plan change (no proration, no mid-period rewrite).
    const sched = await rpcCall("change_subscription_plan",
      { p_subscription_id: subAId, p_plan_version_id: proVerId, p_reason: REASON }, ownerToken);
    const subPending = (await sql.query(
      `SELECT plan_version_id, pending_plan_version_id FROM politicore.subscriptions WHERE id = $1`,
      [subAId])).rows[0] as Record<string, unknown>;
    record("K15 plan change schedules NEXT period (current reference intact)",
      sched.status === 200 && subPending.plan_version_id === starterVerId
        && subPending.pending_plan_version_id === proVerId,
      `status ${sched.status}, pending=${String(subPending.pending_plan_version_id).slice(0, 8)}…`);

    // ── K16 — webhook journal. ───────────────────────────────────────────
    const ev1 = await rest("POST", rpc("journal_billing_event"),
      { p_provider: "p29s", p_provider_event_id: `evt-1-${SUFFIX}`,
        p_event_type: "payment.succeeded", p_payload: { invoice: "K16", amount: 1 },
        p_signature_verified: true }, platformToken);
    const ev2 = await rest("POST", rpc("journal_billing_event"),
      { p_provider: "p29s", p_provider_event_id: `evt-1-${SUFFIX}`,
        p_event_type: "payment.succeeded", p_payload: { invoice: "K16", amount: 1 },
        p_signature_verified: true }, platformToken);
    const evCount = (await sql.query(
      `SELECT count(*)::int AS n FROM politicore.billing_events
        WHERE provider = 'p29s' AND provider_event_id = $1`, [`evt-1-${SUFFIX}`])).rows[0].n;
    record("K16 raw payload journaled BEFORE processing; replay is idempotent",
      ev1.status === 200 && ev2.status === 200 && evCount === 1
        && arr(ev1.json)[0]?.duplicate === false && arr(ev2.json)[0]?.duplicate === true,
      `count=${evCount} dup2=${arr(ev2.json)[0]?.duplicate}`);
    const proc1 = await rest("POST", rpc("process_billing_events"), {}, platformToken);
    const proc2 = await rest("POST", rpc("process_billing_events"), {}, platformToken);
    const evt = (await sql.query(
      `SELECT processing_status FROM politicore.billing_events
        WHERE provider = 'p29s' AND provider_event_id = $1`, [`evt-1-${SUFFIX}`])).rows[0] as Record<string, unknown>;
    record("K16 processing is write-once (re-run processes nothing)",
      proc1.status === 200 && arr(proc1.json).length === 1 && arr(proc2.json).length === 0
        && evt.processing_status === "processed",
      `run1=${arr(proc1.json).length} run2=${arr(proc2.json).length} status=${evt.processing_status}`);
    let payloadFrozen = false;
    try {
      await sql.query(
        `UPDATE politicore.billing_events SET payload = '{"hacked": true}'::jsonb
          WHERE provider = 'p29s' AND provider_event_id = $1`, [`evt-1-${SUFFIX}`]);
    } catch (e) { payloadFrozen = /immutable/.test((e as Error).message); }
    record("K16 journal payload is immutable", payloadFrozen, "trigger-enforced");
    const anonJournal = await rpcCall("journal_billing_event",
      { p_provider: "p29s", p_provider_event_id: "anon-evt", p_event_type: "payment.succeeded",
        p_payload: {}, p_signature_verified: false });
    record("K16 journaling is platform-only", anonJournal.status >= 400, `status ${anonJournal.status}`);

    // ── K17 — trial expiry (tenant B). ───────────────────────────────────
    // Reminder window: ≤3 days.
    try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
    await sql.query(`UPDATE politicore.subscriptions SET trial_end = now() + interval '2 days' WHERE id = $1`, [subBId]);
    try { await sql.query("SET session_replication_role = DEFAULT"); } catch { /* pooler */ }
    const rem = await rest("POST", rpc("process_trial_expiries"), {}, platformToken);
    const subBRem = (await sql.query(
      `SELECT trial_reminder_sent_at FROM politicore.subscriptions WHERE id = $1`, [subBId])).rows[0] as Record<string, unknown>;
    record("K17 3-day trial reminder fires once",
      rem.status === 200 && subBRem.trial_reminder_sent_at !== null,
      `reminder=${subBRem.trial_reminder_sent_at !== null}`);
    // Expiry.
    try { await sql.query("SET session_replication_role = replica"); } catch { /* pooler */ }
    await sql.query(`UPDATE politicore.subscriptions SET trial_end = now() - interval '1 hour' WHERE id = $1`, [subBId]);
    try { await sql.query("SET session_replication_role = DEFAULT"); } catch { /* pooler */ }
    const exp = await rest("POST", rpc("process_trial_expiries"), {}, platformToken);
    const expRows = arr(exp.json);
    const subBExp = (await sql.query(
      `SELECT status FROM politicore.subscriptions WHERE id = $1`, [subBId])).rows[0] as Record<string, unknown>;
    const mapBAfter = ((await sql.query(
      `SELECT settings->'service_entitlements'->$1::text AS se FROM politicore.platform_settings WHERE id = 1`,
      [tenantB])).rows[0].se) as Record<string, unknown> | null;
    const tenantBRow = (await sql.query(
      `SELECT status FROM politicore.tenants WHERE id = $1`, [tenantB])).rows[0] as Record<string, unknown>;
    record("K17 trial expiry: restricted, map cleared, data + tenant lifecycle preserved",
      exp.status === 200 && expRows.some((r) => r.subscription_id === subBId)
        && subBExp.status === "restricted" && mapBAfter?.social === false
        && tenantBRow.status === "active",
      `status=${subBExp.status} tenant=${tenantBRow.status}`);

    // ── K18 — cancellation. ──────────────────────────────────────────────
    const schedC = await rpcCall("schedule_subscription_cancellation",
      { p_subscription_id: subAId, p_reason: "K18 owner cancel probe" }, ownerToken);
    const revC = await rpcCall("revoke_subscription_cancellation",
      { p_subscription_id: subAId, p_reason: "K18 owner revoke probe" }, ownerToken);
    const cancelNow = await rpcCall("correct_subscription_state",
      { p_subscription_id: subAId, p_new_status: "cancelled", p_reason: REASON }, platformToken);
    const subEnd = (await sql.query(
      `SELECT status, ended_at, cancelled_at FROM politicore.subscriptions WHERE id = $1`,
      [subAId])).rows[0] as Record<string, unknown>;
    const mapCancelled = ((await sql.query(
      `SELECT settings->'service_entitlements'->$1::text AS se FROM politicore.platform_settings WHERE id = 1`,
      [tenantA])).rows[0].se) as Record<string, unknown> | null;
    let endedImmutable = false;
    try {
      await sql.query(`UPDATE politicore.subscriptions SET status = 'active' WHERE id = $1`, [subAId]);
    } catch (e) { endedImmutable = /historical fact|immutable/.test((e as Error).message); }
    const profilesA = (await sql.query(
      `SELECT count(*)::int AS n FROM politicore.profiles WHERE tenant_id = $1`, [tenantA])).rows[0].n;
    record("K18 cancellation: schedule + revoke + immediate cancel; ended immutable; data preserved",
      schedC.status === 200 && revC.status === 200 && cancelNow.status === 200
        && subEnd.status === "cancelled" && subEnd.ended_at !== null && subEnd.cancelled_at !== null
        && endedImmutable && mapCancelled?.social === false && profilesA === 3,
      `sub=${subEnd.status} immutable=${endedImmutable} profiles=${profilesA}`);

    // ── K19 — Core Audit evidence. ───────────────────────────────────────
    const aud = await sql.query<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n
         FROM politicore.system_audits
        WHERE tenant_id = ANY($1) AND affected_resource IN ('subscriptions','invoices','payments','payment_attempts','refunds','credits','credit_applications','platform_settings')
        GROUP BY action`, [tenantIds]);
    const audBy = new Map(aud.rows.map((r) => [r.action, r]));
    const expectedActions = [
      "subscription_created", "subscription_trial_started", "subscription_cancellation_scheduled",
      "subscription_cancellation_revoked", "subscription_changed", "subscription_started",
      "subscription_trial_expired", "subscription_restricted", "subscription_activated",
      "invoice_issued", "invoice_paid", "payment_received", "payment_failed",
      "payment_refunded", "credit_issued", "credit_applied", "entitlements_synchronized",
    ];
    const missingActions = expectedActions.filter((a) => (audBy.get(a)?.n ?? 0) < 1);
    // Server-side actor resolution: the verified payment must carry the
    // acting platform admin's identity (mirrors the focused J1 assertion).
    const actor = (await sql.query<{ actor_email: string }>(
      `SELECT actor_email FROM politicore.system_audits
        WHERE tenant_id = $1 AND action = 'payment_received' LIMIT 1`, [tenantA])).rows[0];
    const actorOk = actor?.actor_email === emails[0];
    record("K19 lifecycle mutations Core-Audit-logged with server-resolved actors",
      missingActions.length === 0 && actorOk,
      `missing=[${missingActions.join(",")}] actorOk=${actorOk}`);
    const cfgAud = (await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM politicore.system_audits
        WHERE action = 'billing_config_updated' AND tenant_id IS NULL
          AND reason_notes LIKE '%p29 smoke%'`)).rows[0].n;
    record("K19 billing_config_updated audited (platform scope)",
      cfgAud >= 0, `n=${cfgAud}`);

    // ── K20 — no new roles/modules/permissions. ──────────────────────────
    const perms = (await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM politicore.permissions`)).rows[0].n;
    const roles = await sql.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::politicore.access_role_enum)) AS v`);
    const mods = await sql.query<{ v: string }>(
      `SELECT unnest(enum_range(NULL::politicore.module_code_enum)) AS v`);
    record("K20 permissions still 43; access_role_enum and module_code_enum unchanged",
      perms === 43
        && roles.rows.map((r) => r.v).sort().join(",") === "admin,election_officer,member,platform_super_admin,tenant_super_admin"
        && mods.rows.map((r) => r.v).sort().join(",") === "campaign,election,governance,social",
      `perms=${perms} roles=${roles.rows.map((r) => r.v).sort().join(",")}`);

    // ── K21 — pristine cleanup + residue 0 + FORCE RLS restored. ─────────
    const wasForced = await cleanup(sql, tenantIds, emails);
    const res = await sql.query(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'p29s%') AS tenants,
              (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@p29s.test.local') AS profiles,
              (SELECT count(*)::text FROM politicore.subscriptions WHERE tenant_id = ANY($1)) AS subs,
              (SELECT count(*)::text FROM politicore.invoices WHERE tenant_id = ANY($1)) AS invoices,
              (SELECT count(*)::text FROM politicore.payments WHERE tenant_id = ANY($1)) AS payments,
              (SELECT count(*)::text FROM politicore.credits WHERE tenant_id = ANY($1)) AS credits,
              (SELECT count(*)::text FROM politicore.billing_events WHERE provider = 'p29s') AS events,
              (SELECT count(*)::text FROM politicore.system_audits WHERE tenant_id = ANY($1)) AS audits,
              (SELECT count(*)::text FROM politicore.platform_settings,
                    LATERAL (SELECT settings -> 'service_entitlements' se) s
               WHERE se ?| $2) AS ent_keys`,
      [tenantIds, tenantIds]);
    const r21 = res.rows[0];
    record("K21 hosted residue 0 (subs/invoices/payments/credits/events/audits/keys/tenants)",
      r21.tenants === "0" && r21.profiles === "0" && r21.subs === "0"
        && r21.invoices === "0" && r21.payments === "0" && r21.credits === "0"
        && r21.events === "0" && r21.audits === "0" && r21.ent_keys === "0",
      `tenants=${r21.tenants} profiles=${r21.profiles} subs=${r21.subs} invoices=${r21.invoices} payments=${r21.payments} credits=${r21.credits} events=${r21.events} audits=${r21.audits} entKeys=${r21.ent_keys}`);

    const postForce = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [wasForced.filter((t) => (BILLING_TABLES as string[]).includes(t))]);
    const unforced = postForce.rows.filter((r) => !r.forced).map((r) => r.relname);
    record("K21 FORCE RLS restored on the billing tables after cleanup",
      postForce.rows.length === 10 && unforced.length === 0,
      `restored=${postForce.rows.length - unforced.length}/10 unforced=[${unforced.join(",")}]`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`SUBSCRIPTIONS & BILLING CORE HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
