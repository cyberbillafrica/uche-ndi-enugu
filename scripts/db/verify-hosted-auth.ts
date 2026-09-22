/**
 * POLITICORE — hosted Supabase Auth + PostgREST acceptance script (Phase 1B).
 *
 * Exercises the real Supabase Auth (GoTrue) against the live data API:
 *   1. provision a dev tenant          (politicore.provision_tenant)
 *   2. real sign-up with tenant_slug   (triggers profile backfill)
 *   3. real sign-in                    (access token issued by GoTrue)
 *   4. RLS through the live data API   (tenant isolation, role gating,
 *      self-service profile protection)
 *   5. notifications slice             (insert as admin, read as user,
 *      mark read, unread count)
 *   6. geography through the data API  (1/3/17/260/4145, anon-readable)
 *
 * Notes:
 * - GoTrue's hosted email validation rejects some test patterns; if REST
 *   signup rejects the address, account creation falls back to direct
 *   auth.users INSERT (bcrypt via pgcrypto) while SIGN-IN remains the
 *   real GoTrue password grant either way. The path used is reported.
 * - Bootstrap provisioning is open while the system has NO profiles;
 *   the refusal check therefore runs AFTER the first profile exists.
 *
 * Cleanup removes the dev tenant(s) + auth users, leaving the project
 * pristine. Secrets are read from .env.local and never printed.
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
const PUBLISHABLE_KEY =
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const DEV_TENANT_SLUG = "dev-provisioning";
const SUFFIX = Date.now().toString(36);

if (!SUPABASE_URL || !PUBLISHABLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / publishable key in .env.local");
  process.exit(1);
}

// ── REST helpers ─────────────────────────────────────────────────────────────
async function rest(
  method: string,
  url: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    apikey: PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(SUPABASE_URL + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

// ── account creation: REST signup first, SQL fallback ───────────────────────
async function createAuthUser(
  sql: pg.Client,
  email: string,
  password: string,
  fullName: string
): Promise<{ userId: string; path: "rest-signup" | "sql-insert" }> {
  const up = await rest("POST", "/auth/v1/signup", {
    email,
    password,
    data: { tenant_slug: DEV_TENANT_SLUG, full_name: fullName },
  });
  if (up.status === 200) {
    const { rows } = await sql.query<{ id: string }>(
      `UPDATE auth.users SET email_confirmed_at = now(), updated_at = now()
       WHERE email = $1 RETURNING id`,
      [email]
    );
    if (!rows.length) throw new Error("REST signup succeeded but auth.users row missing");
    return { userId: rows[0].id, path: "rest-signup" };
  }

  const errText = JSON.stringify(up.json);
  const rejected =
    errText.includes("email_address_invalid") ||
    errText.includes("Email address") ||
    errText.includes("over_email_send_rate_limit") ||
    up.status === 429; // free-tier built-in SMTP limit — SQL path still fully exercises the trigger
  if (!rejected)
    throw new Error(`signup failed unexpectedly (${up.status}): ${errText.slice(0, 300)}`);

  // SQL fallback (still triggers the real profile-backfill trigger).
  // Hosted auth.users.id has no default (GoTrue supplies the UUID), so
  // generate it here explicitly. Canonical GoTrue-compatible seed recipe
  // (empirically verified against this project's GoTrue): instance_id,
  // aud+role='authenticated', is_super_admin=false, empty-string token
  // columns (Go's parser treats NULL as invalid), bcrypt cost 10, and an
  // auth.identities row. confirmed_at is a generated column — omit it.
  const userId = crypto.randomUUID();
  const { rows } = await sql.query<{ id: string }>(
    `INSERT INTO auth.users (
       id, instance_id, aud, role, email,
       raw_app_meta_data, raw_user_meta_data, is_super_admin,
       encrypted_password,
       created_at, updated_at,
       email_confirmed_at, confirmation_sent_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       phone, phone_change_token, phone_change
     )
     VALUES (
       $1,
       '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', $2,
       jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
       jsonb_build_object('tenant_slug', $3::text, 'full_name', $4::text),
       false,
       extensions.crypt($5, extensions.gen_salt('bf', 10)),
       now(), now(),
       now(), now(),
       '', '', '', '',
       $6, '', ''
     )
     RETURNING id`,
    [userId, email, DEV_TENANT_SLUG, fullName, password,
     // GoTrue rejects NULL phone (Go scanner); phone is UNIQUE, so each
     // seeded user gets a synthetic value derived from its UUID.
     "+8" + userId.replace(/-/g, "").slice(0, 12)]
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
  return { userId: rows[0].id, path: "sql-insert" };
}

async function signin(email: string, password: string): Promise<string> {
  const si = await rest("POST", "/auth/v1/token?grant_type=password", { email, password });
  if (si.status !== 200)
    throw new Error(`signin failed (${si.status}): ${JSON.stringify(si.json).slice(0, 300)}`);
  const tokens = si.json as { access_token?: string } | null;
  if (!tokens?.access_token) throw new Error("signin returned no access_token");
  return tokens.access_token;
}

// ── cleanup ──────────────────────────────────────────────────────────────────
async function cleanup(sql: pg.Client, tenantIds: (string | null)[], emails: string[]) {
  try {
    for (const tenantId of tenantIds.filter(Boolean) as string[]) {
      await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = $1`, [tenantId]);
      await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = $1`, [tenantId]);
    }
    for (const email of emails) {
      // Cascades to politicore.profiles (profiles.id → auth.users ON DELETE CASCADE).
      await sql.query(`DELETE FROM auth.users WHERE email = $1`, [email]);
    }
    if (tenantIds.some(Boolean)) {
      // tenants is FORCE RLS; as owner lift FORCE for the delete, then restore.
      await sql.query(`ALTER TABLE politicore.tenants NO FORCE ROW LEVEL SECURITY`);
      for (const tenantId of tenantIds.filter(Boolean) as string[]) {
        await sql.query(`DELETE FROM politicore.tenants WHERE id = $1`, [tenantId]);
      }
      await sql.query(`ALTER TABLE politicore.tenants FORCE ROW LEVEL SECURITY`);
    }
    console.log("cleanup: dev tenants + auth users removed (project returned to pre-test state)");
  } catch (e) {
    console.error("cleanup incomplete — remove dev-provisioning tenant manually:", (e as Error).message);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sql = new pg.Client(getHostedConfig());
  await sql.connect();

  const pre = await sql.query<{ hosted: boolean }>(
    `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`
  );
  if (!pre.rows[0].hosted) {
    console.error("STOP: this does not look like the hosted Supabase project (auth schema/uid() missing).");
    process.exit(2);
  }

  const adminEmail = `phase1b.admin.${SUFFIX}@pcorb.example.com`;
  const userEmail = `phase1b.user.${SUFFIX}@pcorb.example.com`;
  const adminPassword = "Ph1b-Admin!pass";
  const userPassword = "Ph1b-User!pass";
  let tenantId: string | null = null;
  const extraTenantIds: string[] = [];
  const emails: string[] = [];

  try {
    // ── 1. provision dev tenant (bootstrap path: system has no profiles) ──
    const prov = await sql.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM politicore.provision_tenant($1,$2,$3,$4)`,
      [DEV_TENANT_SLUG, "Phase 1B Dev Tenant", adminEmail, "Phase 1B Admin"]
    );
    tenantId = prov.rows[0].tenant_id;
    record("provision_tenant (bootstrap)", true, `tenant ${tenantId}`);

    // ── 2/3. real Supabase Auth accounts + sign-in ─────────────────────────
    emails.push(adminEmail, userEmail);
    const admin = await createAuthUser(sql, adminEmail, adminPassword, "Phase 1B Admin");
    record(`account created (${admin.path})`, true, `auth user ${admin.userId}`);
    const adminToken = await signin(adminEmail, adminPassword);
    record("real GoTrue sign-in (admin member)", true, "access token issued");

    const prof = await sql.query(
      `SELECT access_role::text, tenant_id::text, full_name FROM politicore.profiles WHERE id = $1`,
      [admin.userId]
    );
    const p = prof.rows[0];
    const okProfile =
      p && p.access_role === "member" && p.tenant_id === tenantId && p.full_name === "Phase 1B Admin";
    record("signup → member profile backfill (trigger on auth.users)", Boolean(okProfile),
      okProfile ? "member @ dev-provisioning" : JSON.stringify(p));

    const user = await createAuthUser(sql, userEmail, userPassword, "Phase 1B User");
    const userToken = await signin(userEmail, userPassword);
    record("real GoTrue sign-in (second member)", true, `auth user ${user.userId}`);

    // ── provisioning is closed once profiles exist (0010 NULL-bypass fix) ─
    let refused = false;
    try {
      await sql.query(`SET ROLE authenticated;
        SELECT politicore.provision_tenant('sneaky','Sneaky','x@y.example.com');
        RESET ROLE`);
    } catch {
      refused = true;
    }
    record("provision_tenant refused for non-platform-admin (post-bootstrap)", refused,
      refused ? "exception raised as expected" : "NOT REFUSED — SECURITY FLAW");

    // Unknown tenant_slug must fail loudly, not silently join (trigger guard).
    let badSlugBlocked = false;
    try {
      await sql.query(
        `INSERT INTO auth.users (
           id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
           encrypted_password, email_confirmed_at,
           confirmation_token, recovery_token, email_change_token_new, email_change,
           phone, phone_change_token, phone_change
         )
         VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
                 jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
                 jsonb_build_object('tenant_slug', 'no-such-tenant'),
                 extensions.crypt($3, extensions.gen_salt('bf', 10)), now(),
                 '', '', '', '', NULL, NULL, NULL)`,
        [crypto.randomUUID(), `phase1b.badslug.${SUFFIX}@pcorb.example.com`, "Ph1b-Bad!pass"]
      );
    } catch {
      badSlugBlocked = true;
    }
    record("signup with unknown tenant_slug rejected by trigger", badSlugBlocked,
      badSlugBlocked ? "INSERT raised exception as expected" : "ACCEPTED (would create unanchored user)");

    // Signup without tenant_slug: auth user but NO profile (future
    // public-participant seam — deliberate non-creation).
    const bareId = crypto.randomUUID();
    const { rows: bareRows } = await sql.query<{ id: string }>(
      `INSERT INTO auth.users (
         id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
         encrypted_password, email_confirmed_at,
         confirmation_token, recovery_token, email_change_token_new, email_change,
         phone, phone_change_token, phone_change
       )
       VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
               jsonb_build_object('provider','email','providers',jsonb_build_array('email')),
               '{}'::jsonb,
               extensions.crypt($3, extensions.gen_salt('bf', 10)), now(),
               '', '', '', '', NULL, NULL, NULL)
       RETURNING id`,
      [bareId, `phase1b.bare.${SUFFIX}@pcorb.example.com`, "Ph1b-Bare!pass"]
    );
    emails.push(`phase1b.bare.${SUFFIX}@pcorb.example.com`);
    const bareProfile = await sql.query(
      `SELECT count(*)::int AS n FROM politicore.profiles WHERE id = $1`,
      [bareRows[0].id]
    );
    record("signup without tenant_slug creates auth user but NO profile",
      bareProfile.rows[0].n === 0, `profiles: ${bareProfile.rows[0].n} (future public-participant seam)`);

    // ── 4. RLS through the live data API ───────────────────────────────────
    const anonTenants = await rest("GET", "/rest/v1/tenants?select=id,slug");
    const anonCount = Array.isArray(anonTenants.json) ? anonTenants.json.length : -1;
    record("RLS: anon sees zero tenant rows", anonCount === 0, `${anonCount} rows (expected 0)`);

    const anonPoliticore = await rest("GET", "/rest/v1/politicore_profiles?select=id");
    // 0009 view is world-granted but RLS default-deny: anon must get 200 + 0 rows.
    record("RLS: anon REST profiles → 200 + zero rows (default-deny through view)",
      anonPoliticore.status === 200 && Array.isArray(anonPoliticore.json) && anonPoliticore.json.length === 0,
      `HTTP ${anonPoliticore.status}, ${Array.isArray(anonPoliticore.json) ? anonPoliticore.json.length : "?"} rows`);

    const pub = await rest("GET", "/rest/v1/public_site_settings?select=tenant_id");
    const pubCount = Array.isArray(pub.json) ? pub.json.length : -1;
    record("public_site_settings readable as anon (by design)", pubCount >= 1, `${pubCount} rows`);

    const idq = await rest("GET", "/rest/v1/rpc/my_tenant_id", undefined, adminToken);
    record("RPC my_tenant_id resolves provisioned tenant",
      idq.status === 200 && idq.json === tenantId, JSON.stringify(idq.json).slice(0, 60));

    const roleq = await rest("GET", "/rest/v1/rpc/my_access_role", undefined, adminToken);
    record("RPC my_access_role = member (signup never auto-admins)",
      roleq.status === 200 && roleq.json === "member", JSON.stringify(roleq.json));

    // Module activation is an explicit subscription act (0011): election
    // starts DISABLED at provision time, then is activated deliberately.
    // Verify the before/after through the live data API with a real JWT,
    // and confirm the server-side audit trigger fired on hosted.
    const modq0 = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=election", undefined, adminToken);
    record("RPC my_module_enabled(election) false after provisioning (0011 default)",
      modq0.status === 200 && modq0.json === false, JSON.stringify(modq0.json));

    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'election'`,
      [tenantId]
    );

    const modq = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=election", undefined, adminToken);
    record("RPC my_module_enabled(election) true after deliberate activation",
      modq.status === 200 && modq.json === true, JSON.stringify(modq.json));

    const audMod = await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM politicore.system_audits
       WHERE affected_resource = 'tenant_modules' AND tenant_id = $1`,
      [tenantId]
    );
    record("module activation wrote a server-side audit row (hosted trigger)",
      Number(audMod.rows[0].n) >= 1, `audit rows: ${audMod.rows[0].n}`);

    const modg = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=governance", undefined, adminToken);
    record("RPC my_module_enabled(governance) false (disabled module)",
      modg.status === 200 && modg.json === false, JSON.stringify(modg.json));

    const selfInsert = await rest("POST", "/rest/v1/politicore_profiles",
      { tenant_id: tenantId, email: "sneaky@pcorb.example.com", full_name: "Sneaky" }, adminToken);
    record("RLS: member cannot INSERT profiles (self-promo path)", selfInsert.status >= 400,
      `HTTP ${selfInsert.status}`);

    const selfElevate = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${admin.userId}`,
      { access_role: "admin" }, adminToken);
    record("RLS: member cannot self-elevate access_role", selfElevate.status >= 400,
      `HTTP ${selfElevate.status}`);

    const crossUpdate = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${admin.userId}`,
      { full_name: "Renamed via REST" }, adminToken);
    record("RLS: member self-update allowed for non-privilege field",
      // PostgREST answers PATCH with 204 No Content, not 200.
      crossUpdate.status === 200 || crossUpdate.status === 204, `HTTP ${crossUpdate.status}`);

    // ── 5. notifications slice ─────────────────────────────────────────────
    // Promote the first member to tenant admin (authority is an explicit
    // administrative act — the signup backfill deliberately creates plain
    // members only). This exercises the real "admin notifies member" flow.
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admin.userId]);

    const ins = await rest("POST", "/rest/v1/notifications",
      [
        { user_id: user.userId, tenant_id: tenantId, type: "system", title: "Welcome", message: "Phase 1B vertical slice" },
        { user_id: user.userId, tenant_id: tenantId, type: "announcement", title: "Read-mark test", message: "second row" },
      ],
      adminToken);
    record("tenant admin inserts notifications for a member", ins.status === 201, `HTTP ${ins.status}`);

    const list = await rest("GET",
      `/rest/v1/notifications?select=id,title,read_at&user_id=eq.${user.userId}`, undefined, userToken);
    const listRows: { id: string }[] = Array.isArray(list.json) ? list.json : [];
    record("member reads ONLY their own notifications", list.status === 200 && listRows.length === 2,
      `${listRows.length} rows`);

    const foreignRead = await rest("GET",
      `/rest/v1/notifications?select=id&user_id=eq.${user.userId}`, undefined, adminToken);
    record("other member cannot read user's notifications",
      foreignRead.status === 200 && Array.isArray(foreignRead.json) && foreignRead.json.length === 0,
      `${Array.isArray(foreignRead.json) ? foreignRead.json.length : "?"} rows`);

    const markIds = listRows.map((r) => r.id);
    const mark = await rest("POST", "/rest/v1/rpc/mark_notifications_read",
      { p_ids: markIds }, userToken);
    record("mark_notifications_read marks only own rows",
      mark.status === 200 && mark.json === markIds.length, `marked ${JSON.stringify(mark.json)}`);

    const unread = await rest("GET", "/rest/v1/rpc/my_unread_count", undefined, userToken);
    record("my_unread_count = 0 after marking", unread.status === 200 && unread.json === 0,
      JSON.stringify(unread.json));

    const userElevateNotif = await rest("POST", "/rest/v1/notifications",
      { user_id: admin.userId, tenant_id: tenantId, type: "system", title: "x", message: "y" },
      userToken);
    record("ordinary member cannot insert notifications for others", userElevateNotif.status >= 400,
      `HTTP ${userElevateNotif.status}`);

    // ── 6. geography through the data API ──────────────────────────────────
    const geo = await rest("GET", "/rest/v1/states?select=id,name");
    record("geography readable via data API (anon)",
      geo.status === 200 && Array.isArray(geo.json) && geo.json.length === 1,
      `states: ${JSON.stringify(geo.json)}`);

    const counts = await sql.query(`
      SELECT
        (SELECT count(*) FROM politicore.senatorial_zones) zones,
        (SELECT count(*) FROM politicore.lgas) lgas,
        (SELECT count(*) FROM politicore.wards) wards,
        (SELECT count(*) FROM politicore.polling_units) pus`);
    const c = counts.rows[0];
    record("geography totals 1/3/17/260/4145",
      Number(c.zones) === 3 && Number(c.lgas) === 17 && Number(c.wards) === 260 && Number(c.pus) === 4145,
      `${c.zones}/${c.lgas}/${c.wards}/${c.pus}`);

    // ── cleanup ────────────────────────────────────────────────────────────
    await cleanup(sql, [tenantId, ...extraTenantIds], emails);
    console.log("\nHOSTED ACCEPTANCE COMPLETE — see per-check results above");
  } catch (e) {
    await cleanup(sql, [tenantId, ...extraTenantIds], emails);
    console.error("HOSTED ACCEPTANCE FAILED:", (e as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
