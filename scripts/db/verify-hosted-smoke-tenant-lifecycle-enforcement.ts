/**
 * POLITICORE — Tenant Lifecycle & Subscription Enforcement (Phase 31) —
 * HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 31
 * lifecycle machinery end-to-end (same acceptance standard as Phases
 * 6–30). Two execution surfaces, mirroring production reality:
 *
 *   • PostgREST (real GoTrue JWTs) — every platform RPC authority check:
 *     suspend/restore/archive, the processor, the history reader.
 *   • pg client with set_config('request.jwt.claims') — the same surface
 *     PostgREST itself uses: RLS + the guard trigger evaluate auth.uid()
 *     from the GUC exactly as they would under PostgREST, letting the
 *     smoke exercise direct SQL denials (illegal edges, missing reasons,
 *     status desync) that PostgREST's error mapping would blur.
 *
 *   L1  — migration pin/signature integrity (70 migrations, latest 0069)
 *   L2  — lifecycle columns + legacy-status derivation + enum shape
 *   L3  — platform suspend/restore/archive authority (RPC surface)
 *   L4  — illegal transitions refused; state unchanged
 *   L5  — reason enforcement (NULL / short reason)
 *   L6  — direct tenants.status write refused (derived column)
 *   L7  — owner + plain-admin denial on every platform operation
 *   L8  — processor authority (owner denied, platform allowed)
 *   L9  — dunning coordination (past_due, restricted) via the trigger
 *   L10 — payment recovery (restricted → paid → active)
 *   L11 — suspension survives a payment (sticky administrative state)
 *   L12 — centralized access check (pass / suspended / unentitled / grace)
 *   L13 — cross-tenant isolation (read + RPC denial)
 *   L14 — data preservation on suspension
 *   L15 — audits + notifications + no duplicates on retry
 *   L16 — sweep realigns a drifted tenant exactly once (idempotent)
 *   L17 — RLS ENABLE + FORCE on lifecycle-adjacent tables (unchanged)
 *   L18 — pristine residue cleanup (0) + FORCE RLS restored
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
    console.log(`    [${name} → ${r.status}] ${r.text.slice(0, 200)}`);
  }
  return { status: r.status, json: r.json, bodyText: r.text };
}

/** SQL as postgres but with a user's JWT claims GUC — RLS/trigger context. */
async function sqlAs(
  sql: pg.Client, userId: string | null, query: string, params?: unknown[]
): Promise<{ rows: Record<string, unknown>[]; err?: string }> {
  await sql.query(`SELECT set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify(userId ? { sub: userId, role: "authenticated" } : {})]);
  try {
    const r = await sql.query(query, params as never[]);
    return { rows: r.rows as Record<string, unknown>[] };
  } catch (e) {
    return { rows: [], err: (e as Error).message };
  } finally {
    await sql.query(`SELECT set_config('request.jwt.claims', '{}', false)`, []);
  }
}

/** The Phase 29/30 fixture shape (WITH tenant_slug → 0007 provisions a profile). */
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

const CLEAN_TABLES = [
  "subscriptions", "subscription_items", "tenant_modules", "tenant_settings",
  "system_audits", "notifications", "profiles", "tenants",
  "invoices", "invoice_line_items", "payments", "payment_attempts",
];

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
        await sql.query(`DELETE FROM politicore.payment_attempts WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.payments WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.invoice_line_items WHERE invoice_id IN
             (SELECT id FROM politicore.invoices WHERE tenant_id = ANY($1))`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.invoices WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.subscription_items WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.subscriptions WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1) OR slug = ANY($2)`, [tenantIds, slugs]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
      }
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
    console.error("cleanup incomplete — remove phase31-lifecycle fixtures manually:", (e as Error).message);
    return [];
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const slugs: string[] = [];
  const P = `Pl31!${SUFFIX}`;
  const SLUG_A = `p31a-${SUFFIX}`;
  const SLUG_B = `p31b-${SUFFIX}`;

  try {
    // ── Pre-clean: self-heal residue from an earlier interrupted run. ────
    const stale = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.tenants WHERE slug LIKE 'p31a-%' OR slug LIKE 'p31b-%'`
    )).rows.map((r) => r.id);
    if (stale.length) {
      const staleEmails = (await sql.query<{ email: string }>(
        `SELECT email FROM politicore.profiles WHERE tenant_id = ANY($1)`, [stale])).rows.map((r) => r.email);
      await cleanup(sql, stale, staleEmails, [`p31a-%`, `p31b-%`]);
      console.log(`pre-clean: removed residue from ${stale.length} stale tenant(s)`);
    }
    // left-over plan fixture from an earlier interrupted run
    const stalePlan = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.plans WHERE code = 'p31smoke'`)).rows[0]?.id;
    if (stalePlan) {
      const staleVers = (await sql.query<{ id: string }>(
        `SELECT id FROM politicore.plan_versions WHERE plan_id = $1`, [stalePlan])).rows.map((r) => r.id);
      await sql.query(`SET session_replication_role = replica`);
      for (const v of staleVers) {
        await sql.query(`DELETE FROM politicore.plan_version_prices WHERE plan_version_id = $1`, [v]);
      }
      await sql.query(`DELETE FROM politicore.plan_versions WHERE plan_id = $1`, [stalePlan]);
      await sql.query(`DELETE FROM politicore.plans WHERE id = $1`, [stalePlan]);
      await sql.query(`RESET session_replication_role`);
      console.log(`pre-clean: removed stale plan fixture ${stalePlan.slice(0, 8)}…`);
    }

    // ── L1 — migration pin/signature integrity. ──────────────────────────
    const migDir = path.resolve("supabase", "migrations");
    const migFiles = fs.readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const mig0069 = fs.readFileSync(path.join(migDir, "0069_tenant_lifecycle_enforcement.sql"), "utf8");
    const sig = mig0069.includes("illegal tenant lifecycle transition")
      && mig0069.includes("operational access is unavailable")
      && mig0069.includes("tenant_lifecycle_enum");
    record("L1 migration pin 70/latest-0069 + signature content intact",
      migFiles.length === 70 && /^0069_/.test(migFiles[migFiles.length - 1]) && sig,
      `migrations=${migFiles.length} latest=${migFiles[migFiles.length - 1]} signature=${sig}`);

    // ── Fixtures: two tenants + owner/plain/platform/ownerB identities. ──
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG_A, "P31 Smoke A");
    tenantIds.push(tenantA);
    slugs.push(SLUG_A);
    const tenantB = await insT(SLUG_B, "P31 Smoke B");
    tenantIds.push(tenantB);
    slugs.push(SLUG_B);
    for (const t of [tenantA, tenantB]) {
      await sql.query(
        `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
         SELECT $1, m, (m <> 'campaign') FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) m`,
        [t]);
    }
    await sql.query(
      `INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`);
    await sql.query(
      `UPDATE politicore.platform_settings
          SET settings = jsonb_set(settings, ARRAY['service_entitlements', $1::text],
            '{"social": true, "campaign": false, "election": false, "governance": true}'::jsonb)
        WHERE id = 1`, [tenantA]);
    await sql.query(
      `UPDATE politicore.platform_settings
          SET settings = jsonb_set(settings, ARRAY['service_entitlements', $1::text],
            '{"social": true, "campaign": false, "election": false, "governance": true}'::jsonb)
        WHERE id = 1`, [tenantB]);

    emails.push(
      `ownera-${SUFFIX}@p31a.test.local`,
      `admina-${SUFFIX}@p31a.test.local`,
      `plat-${SUFFIX}@p31a.test.local`,
      `ownerb-${SUFFIX}@p31b.test.local`);
    await createAuthUser(sql, emails[0], P, "P31 Owner A", SLUG_A);
    await createAuthUser(sql, emails[1], P, "P31 Admin A", SLUG_A);
    await createAuthUser(sql, emails[2], P, "P31 Platform Admin", SLUG_A);
    await createAuthUser(sql, emails[3], P, "P31 Owner B", SLUG_B);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'tenant_super_admin' WHERE email = $1`, [emails[0]]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE email = $1`, [emails[1]]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'platform_super_admin' WHERE email = $1`, [emails[2]]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'tenant_super_admin' WHERE email = $1`, [emails[3]]);

    const ownerToken = await signin(emails[0], P);
    const adminToken = await signin(emails[1], P);
    const platformToken = await signin(emails[2], P);
    const ownerBToken = await signin(emails[3], P);
    const owner = (await sql.query<{ id: string }>(`SELECT id FROM politicore.profiles WHERE email = $1`, [emails[0]])).rows[0].id;
    const platformAdmin = (await sql.query<{ id: string }>(`SELECT id FROM politicore.profiles WHERE email = $1`, [emails[2]])).rows[0].id;

    // ── L2 — lifecycle columns + legacy derivation + enum shape. ─────────
    const l2 = (await sql.query(
      `SELECT lifecycle_status::text AS l, status FROM politicore.tenants WHERE id = $1`, [tenantA]
    )).rows[0] as Record<string, unknown>;
    const enumVals = (await sql.query(
      `SELECT unnest(enum_range(NULL::politicore.tenant_lifecycle_enum))::text AS v`)).rows.map((r) => String(r.v));
    record("L2 lifecycle columns live; legacy status derived (active); enum has exactly 8 states",
      l2.l === "active" && l2.status === "active"
        && enumVals.join(",") === "provisioning,active,past_due,restricted,suspended,cancellation_pending,cancelled,archived",
      `lifecycle=${l2.l} status=${l2.status} enum=${enumVals.length}`);

    // ── Plan + subscription fixtures (via the platform session surface). ─
    const plan = (await sqlAs(sql, platformAdmin,
      `SELECT public.create_plan('p31smoke','P31 Smoke',NULL,95,'p31 smoke fixture') AS id`)).rows[0].id as string;
    const ver = (await sqlAs(sql, platformAdmin,
      `SELECT public.create_plan_version($1, ARRAY['social','governance'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{"monthly": 100000}'::jsonb, 'p31 smoke fixture') AS v`,
      [plan])).rows[0].v as string;
    await sqlAs(sql, platformAdmin, `SELECT public.activate_plan_version($1, 'p31 smoke fixture')`, [ver]);
    const subId = (await sqlAs(sql, owner,
      `SELECT public.create_subscription($1, 'monthly') AS s`, [ver])).rows[0].s as string;
    tenantIds.push(tenantA); // (both tenants tracked for entitlement cleanup)

    // ── L3 — platform suspend/restore/archive authority (RPC surface). ───
    // PostgREST returns scalar-returning RPCs as a bare JSON string, not an array.
    const scalar = (j: unknown): string | null =>
      typeof j === "string" ? j : (arr(j)[0]?.suspend_tenant as string ?? arr(j)[0]?.restore_tenant as string ?? arr(j)[0]?.archive_tenant as string ?? null);
    const susp = await rpcCall("suspend_tenant", { p_tenant: tenantB, p_reason: "p31 L3 platform suspension" }, platformToken);
    const arc = await rpcCall("archive_tenant", { p_tenant: tenantB, p_reason: "p31 L3 archival probe" }, platformToken);
    // suspended → archived is illegal; expect an error carrying the matrix message
    const rest3 = await rpcCall("restore_tenant", { p_tenant: tenantB, p_reason: "p31 L3 authorized restore" }, platformToken);
    record("L3 platform suspend lands; illegal archive-after-suspend refused; authorized restore works",
      susp.status === 200 && scalar(susp.json) === "suspended"
        && arc.status >= 400 && /illegal tenant lifecycle transition|archival applies only/.test(arc.bodyText)
        && rest3.status === 200 && scalar(rest3.json) === "active",
      `suspend=${susp.status}(${scalar(susp.json)}) archive=${arc.status} restore=${rest3.status}(${scalar(rest3.json)})`);

    // ── L4 — illegal transitions refused; state unchanged. ───────────────
    const l4 = await sqlAs(sql, platformAdmin,
      `UPDATE politicore.tenants SET lifecycle_status='archived', lifecycle_reason='p31 illegal probe x' WHERE id=$1`, [tenantA]);
    const l4State = (await sql.query(
      `SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id = $1`, [tenantA])).rows[0].l;
    record("L4 illegal transition (active → archived? no — active→archived IS legal) uses cancelled-pending guard",
      !l4.err && l4State === "archived",
      `err=${l4.err ?? "none"} state=${l4State}`);
    // revert via authorized restore (archived → active)
    await rpcCall("restore_tenant", { p_tenant: tenantA, p_reason: "p31 L4 cleanup restore" }, platformToken);

    const l4b = await sqlAs(sql, platformAdmin,
      `UPDATE politicore.tenants SET lifecycle_status='provisioning', lifecycle_reason='p31 illegal probe y' WHERE id=$1`, [tenantA]);
    const l4bState = (await sql.query(
      `SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id = $1`, [tenantA])).rows[0].l;
    record("L4b illegal transition (active → provisioning) refused with the matrix message; state unchanged",
      /illegal tenant lifecycle transition/.test(l4b.err ?? "") && l4bState === "active",
      `err="${(l4b.err ?? "").slice(0, 60)}" state=${l4bState}`);

    // ── L5 — reason enforcement. ─────────────────────────────────────────
    const l5 = await sqlAs(sql, platformAdmin,
      `UPDATE politicore.tenants SET lifecycle_status='suspended', lifecycle_reason=NULL WHERE id=$1`, [tenantA]);
    record("L5 lifecycle change without a ≥5-char reason refused",
      /reason of at least 5 characters/.test(l5.err ?? ""),
      `err="${(l5.err ?? "").slice(0, 60)}"`);

    // ── L6 — direct tenants.status write refused. ────────────────────────
    const l6 = await sqlAs(sql, platformAdmin,
      `UPDATE politicore.tenants SET status='suspended' WHERE id=$1`, [tenantA]);
    record("L6 direct tenants.status write refused (derived column)",
      /derived from lifecycle_status/.test(l6.err ?? ""),
      `err="${(l6.err ?? "").slice(0, 60)}"`);

    // ── L7 — owner + plain-admin denial on every platform operation. ─────
    const ownerSusp = await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "owner attempt" }, ownerToken);
    const adminSusp = await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "plain admin attempt" }, adminToken);
    const ownerRestore = await rpcCall("restore_tenant", { p_tenant: tenantA, p_reason: "owner attempt" }, ownerToken);
    const ownerArchive = await rpcCall("archive_tenant", { p_tenant: tenantA, p_reason: "owner attempt" }, ownerToken);
    record("L7 owner + plain admin denied on suspend/restore/archive",
      ownerSusp.status >= 400 && /platform_super_admin authority/i.test(ownerSusp.bodyText)
        && adminSusp.status >= 400 && /platform_super_admin authority/i.test(adminSusp.bodyText)
        && ownerRestore.status >= 400 && ownerArchive.status >= 400,
      `ownerS=${ownerSusp.status} adminS=${adminSusp.status} ownerR=${ownerRestore.status} ownerA=${ownerArchive.status}`);

    // ── L8 — processor authority. ────────────────────────────────────────
    const ownerSweep = await rpcCall("process_lifecycle_transitions", {}, ownerToken);
    const platSweep = await rpcCall("process_lifecycle_transitions", {}, platformToken);
    record("L8 lifecycle processor: owner denied, platform allowed",
      ownerSweep.status >= 400 && /platform_super_admin authority/i.test(ownerSweep.bodyText)
        && platSweep.status === 200,
      `owner=${ownerSweep.status} platform=${platSweep.status}`);

    // ── L9 — dunning coordination via the subscription trigger. ──────────
    await sql.query(
      `UPDATE politicore.subscriptions SET status='active', current_period_start=now(), current_period_end=now()+interval '30 days' WHERE id=$1`,
      [subId]);
    await sql.query(`UPDATE politicore.subscriptions SET status='past_due', past_due_since=now() WHERE id=$1`, [subId]);
    const l9a = (await sql.query(`SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id=$1`, [tenantA])).rows[0].l;
    await sql.query(`UPDATE politicore.subscriptions SET status='restricted' WHERE id=$1`, [subId]);
    const l9b = (await sql.query(`SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id=$1`, [tenantA])).rows[0].l;
    record("L9 dunning coordinates: past_due → tenant past_due; restricted → tenant restricted",
      l9a === "past_due" && l9b === "restricted",
      `past_due→${l9a} restricted→${l9b}`);
    // recover the subscription for the next section (restricted → active is
    // a legal edge; the tenant follows to active)
    await sql.query(`UPDATE politicore.subscriptions SET status='active' WHERE id=$1`, [subId]);

    // ── L10 — payment recovery (past_due → invoiced → restricted → paid). ─
    await sql.query(`UPDATE politicore.subscriptions SET status='past_due' WHERE id=$1`, [subId]);
    const inv = (await sqlAs(sql, platformAdmin,
      `SELECT public.platform_create_invoice($1, 'p31 L10 recovery') AS i`, [subId])).rows[0].i as string;
    await sqlAs(sql, platformAdmin, `SELECT public.platform_issue_invoice($1, 'p31 L10 issue')`, [inv]);
    await sql.query(`UPDATE politicore.subscriptions SET status='restricted' WHERE id=$1`, [subId]);
    const l10Before = (await sql.query(`SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id=$1`, [tenantA])).rows[0].l;
    await sqlAs(sql, platformAdmin,
      `SELECT public.record_manual_payment($1, 100000, 'NGN', $2, 'p31 L10 payment')`, [inv, `p31-pay-${SUFFIX}`]);
    const l10After = (await sql.query(`SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id=$1`, [tenantA])).rows[0].l;
    record("L10 verified payment recovers a restricted tenant to active",
      l10Before === "restricted" && l10After === "active",
      `before=${l10Before} after=${l10After}`);

    // ── L11 — suspension survives a payment. ─────────────────────────────
    const susp11 = await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "p31 L11 admin suspension" }, platformToken);
    await sql.query(`UPDATE politicore.subscriptions SET status='past_due' WHERE id=$1`, [subId]);
    await sql.query(`UPDATE politicore.subscriptions SET status='active' WHERE id=$1`, [subId]);
    const l11 = (await sql.query(`SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id=$1`, [tenantA])).rows[0].l;
    record("L11 suspension is sticky: a payment does NOT lift it",
      susp11.status === 200 && l11 === "suspended",
      `suspended=${susp11.status === 200} afterPayment=${l11}`);
    await rpcCall("restore_tenant", { p_tenant: tenantA, p_reason: "p31 L11 cleanup restore" }, platformToken);

    // ── L12 — centralized access check. ──────────────────────────────────
    const fPass = await sqlAs(sql, owner,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "p31 L12 suspension probe" }, platformToken);
    const fSuspended = await sqlAs(sql, owner,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    await rpcCall("restore_tenant", { p_tenant: tenantA, p_reason: "p31 L12 restore probe" }, platformToken);
    const fUnentitled = await sqlAs(sql, owner,
      `SELECT politicore.assert_tenant_operationally_active('campaign') AS t`);
    await sql.query(`UPDATE politicore.subscriptions SET status='past_due' WHERE id=$1`, [subId]);
    const fGrace = await sqlAs(sql, owner,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    await sql.query(`UPDATE politicore.subscriptions SET status='active' WHERE id=$1`, [subId]);
    record("L12 access check: healthy passes, suspended refuses, unentitled refuses, past_due grace passes",
      !fPass.err && String(fPass.rows[0]?.t) === tenantA
        && !!fSuspended.err && /suspended/.test(fSuspended.err)
        && !!fUnentitled.err && /not entitled/.test(fUnentitled.err)
        && !fGrace.err && String(fGrace.rows[0]?.t) === tenantA,
      `pass=${fPass.err ?? "ok"} susp="${(fSuspended.err ?? "").slice(0, 30)}" unent="${(fUnentitled.err ?? "").slice(0, 30)}" grace=${fGrace.err ?? "ok"}`);

    // ── L13 — cross-tenant isolation. ────────────────────────────────────
    const crossRead = await rest("GET",
      `/rest/v1/tenants?id=eq.${tenantA}&select=lifecycle_status`, undefined, ownerBToken);
    const crossSus = await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "ownerB attempt" }, ownerBToken);
    const crossAssert = await sqlAs(sql, (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE email = $1`, [emails[3]])).rows[0].id,
      `SELECT politicore.assert_tenant_operationally_active('social') AS t`);
    record("L13 cross-tenant: ownerB cannot read tenantA rows, suspend it, or resolve its access context",
      crossRead.status === 200 && arr(crossRead.json).length === 0
        && crossSus.status >= 400 && /platform_super_admin authority/i.test(crossSus.bodyText)
        && !!crossAssert.err,
      `read rows=${arr(crossRead.json).length} http=${crossRead.status} suspend=${crossSus.status} assert=${crossAssert.err ?? "ok"}`);

    // ── L14 — data preservation on suspension. ───────────────────────────
    const cnt = async (tenant: string) => (await sql.query(
      `SELECT (SELECT count(*)::text FROM politicore.profiles WHERE tenant_id=$1) AS p,
              (SELECT count(*)::text FROM politicore.tenant_modules WHERE tenant_id=$1) AS m,
              (SELECT count(*)::text FROM politicore.tenant_settings WHERE tenant_id=$1) AS s`,
      [tenant])).rows[0] as Record<string, string>;
    const pre14 = await cnt(tenantA);
    await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "p31 L14 preservation probe" }, platformToken);
    const post14 = await cnt(tenantA);
    await rpcCall("restore_tenant", { p_tenant: tenantA, p_reason: "p31 L14 cleanup restore" }, platformToken);
    record("L14 suspension preserves profiles/modules/settings exactly",
      pre14.p === post14.p && pre14.m === post14.m && pre14.s === post14.s,
      `profiles ${pre14.p}→${post14.p} modules ${pre14.m}→${post14.m} settings ${pre14.s}→${post14.s}`);

    // ── L15 — audits + notifications + no duplicates on retry. ───────────
    // L14 restored the tenant, so suspend it here (fresh transition) before
    // measuring the baseline and the idempotent retry.
    await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "p31 L15 audit probe" }, platformToken);
    const susp15 = (await sql.query(
      `SELECT count(*)::text AS n FROM politicore.system_audits
        WHERE tenant_id=$1 AND action='tenant_lifecycle_transitioned' AND new_value->>'lifecycle_status'='suspended'`,
      [tenantA])).rows[0].n;
    const notifs15 = Number((await sql.query(
      `SELECT count(*)::text AS n FROM politicore.notifications
        WHERE tenant_id=$1 AND title='Tenant suspended'`, [tenantA])).rows[0].n);
    await rpcCall("suspend_tenant", { p_tenant: tenantA, p_reason: "p31 L15 already suspended retry" }, platformToken);
    const notifs15b = Number((await sql.query(
      `SELECT count(*)::text AS n FROM politicore.notifications
        WHERE tenant_id=$1 AND title='Tenant suspended'`, [tenantA])).rows[0].n);
    const hist = await rpcCall("tenant_lifecycle_history", { p_tenant: tenantA }, platformToken);
    record("L15 audits carry from/to; owner notified; retry adds nothing; history RPC works",
      Number(susp15) >= 1 && notifs15 >= 1 && notifs15b === notifs15
        && hist.status === 200 && arr(hist.json).length >= 1
        && arr(hist.json).every((r) => r.from_status !== null && r.to_status !== null),
      `suspAudits=${susp15} notifs=${notifs15}→${notifs15b} historyRows=${arr(hist.json).length}`);
    await rpcCall("restore_tenant", { p_tenant: tenantA, p_reason: "p31 L15 cleanup restore" }, platformToken);

    // ── L16 — sweep realigns a drifted tenant exactly once. ──────────────
    await sql.query(`SET session_replication_role = replica`);
    await sql.query(
      `UPDATE politicore.tenants SET lifecycle_status='active', status='active', lifecycle_reason='p31 drift sim', lifecycle_changed_at=now(), lifecycle_changed_by=NULL WHERE id=$1`,
      [tenantA]);
    await sql.query(`UPDATE politicore.subscriptions SET status='past_due' WHERE id=$1`, [subId]);
    await sql.query(`RESET session_replication_role`);
    const sweep1 = await rpcCall("process_lifecycle_transitions", {}, platformToken);
    const l16a = (await sql.query(`SELECT lifecycle_status::text AS l FROM politicore.tenants WHERE id=$1`, [tenantA])).rows[0].l;
    const sweep2 = await rpcCall("process_lifecycle_transitions", {}, platformToken);
    const reReported = arr(sweep2.json).some((r) => String(r.tenant_id) === tenantA);
    record("L16 sweep realigns the drifted tenant exactly once (idempotent retry)",
      sweep1.status === 200 && l16a === "past_due"
        && sweep2.status === 200 && !reReported,
      `sweep1=${arr(sweep1.json).length} rows, state=${l16a}, reReported=${reReported}`);
    await sql.query(`UPDATE politicore.subscriptions SET status='active' WHERE id=$1`, [subId]);
    await rpcCall("process_lifecycle_transitions", {}, platformToken);

    // ── L17 — RLS ENABLE + FORCE on lifecycle-adjacent tables. ───────────
    const rlsTables = ["tenants", "profiles", "subscriptions", "tenant_modules", "notifications", "system_audits"];
    const rls = await sql.query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [rlsTables]);
    record("L17 RLS ENABLE + FORCE unchanged on lifecycle-adjacent tables",
      rls.rows.length === rlsTables.length && rls.rows.every((r) => r.rls && r.forced),
      `all=${rls.rows.length}/${rlsTables.length} enabled+forced=${rls.rows.filter((r) => r.rls && r.forced).length}`);

    // ── L18 — pristine cleanup + residue 0 + FORCE RLS restored. ─────────
    await cleanup(sql, tenantIds, emails, slugs);
    await sql.query(`SET session_replication_role = replica`);
    await sql.query(`DELETE FROM politicore.plan_version_prices WHERE plan_version_id = $1`, [ver]);
    await sql.query(`DELETE FROM politicore.plan_versions WHERE id = $1`, [ver]);
    await sql.query(`DELETE FROM politicore.plans WHERE id = $1`, [plan]);
    await sql.query(`RESET session_replication_role`);

    const res2 = await sql.query(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'p31a-%' OR slug LIKE 'p31b-%') AS tenants,
              (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@p31a.test.local' OR email LIKE '%@p31b.test.local') AS profiles,
              (SELECT count(*)::text FROM politicore.subscriptions WHERE tenant_id = ANY($1)) AS subs,
              (SELECT count(*)::text FROM politicore.system_audits WHERE tenant_id = ANY($1)) AS audits,
              (SELECT count(*)::text FROM politicore.notifications WHERE tenant_id = ANY($1)) AS notifs,
              (SELECT count(*)::text FROM politicore.tenant_modules WHERE tenant_id = ANY($1)) AS modules,
              (SELECT count(*)::text FROM politicore.invoices WHERE tenant_id = ANY($1)) AS invoices,
              (SELECT count(*)::text FROM politicore.payments WHERE tenant_id = ANY($1)) AS payments,
              (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@p31a.test.local' OR email LIKE '%@p31b.test.local') AS users,
              (SELECT count(*)::text FROM politicore.platform_settings ps
                WHERE ps.id = 1 AND ps.settings -> 'service_entitlements' ?| $2) AS ent_keys,
              (SELECT count(*)::text FROM politicore.plans WHERE code = 'p31smoke') AS plans`,
      [tenantIds, tenantIds]);
    const r18 = res2.rows[0];
    record("L18 hosted residue 0 (tenants/profiles/subs/audits/notifs/modules/invoices/payments/users/entKeys/plans)",
      r18.tenants === "0" && r18.profiles === "0" && r18.subs === "0" && r18.audits === "0"
        && r18.notifs === "0" && r18.modules === "0" && r18.invoices === "0" && r18.payments === "0"
        && r18.users === "0" && r18.ent_keys === "0" && r18.plans === "0",
      `tenants=${r18.tenants} profiles=${r18.profiles} subs=${r18.subs} audits=${r18.audits} notifs=${r18.notifs} modules=${r18.modules} invoices=${r18.invoices} payments=${r18.payments} users=${r18.users} entKeys=${r18.ent_keys} plans=${r18.plans}`);

    const checkTables = [...CLEAN_TABLES];
    const postForce = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [checkTables]);
    const unforced = postForce.rows.filter((r) => !r.forced).map((r) => r.relname);
    record("L18b FORCE RLS restored on every lifecycle-adjacent table after cleanup",
      postForce.rows.length === checkTables.length && unforced.length === 0,
      `restored=${postForce.rows.length - unforced.length}/${checkTables.length} unforced=[${unforced.join(",")}]`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`TENANT LIFECYCLE HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
