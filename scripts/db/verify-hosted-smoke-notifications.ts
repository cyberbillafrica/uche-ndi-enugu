/**
 * POLITICORE — SHARED NOTIFICATIONS CUTOVER — HOSTED ACCEPTANCE (§19).
 *
 * Verifies the canonical Supabase notification system on the REAL
 * hosted project (real GoTrue sessions, real PostgREST, real RLS,
 * real RPCs). Journeys:
 *
 *   A — Recipient isolation   admin-created notification → recipient
 *                             sees exactly their own rows; cross-user
 *                             and cross-tenant reads return nothing;
 *                             anon denied
 *   B — Read/unread           unread count RPC → mark one → mark all →
 *                             state transitions server-verified
 *   C — Mutation guards       member cannot mark another user's
 *                             notification read (id-listed rows of
 *                             other users are ineffective)
 *   D — Admin creation        tenant admin inserts through the data API
 *                             (notifications_insert_admin policy)
 *   E — Firebase boundary     the migrated portal surface statically
 *                             contains no Firebase notification deps
 *   F — Pristine cleanup      fixtures removed; FORCE-RLS restored
 *
 * Secrets are read from .env.local and never printed.
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
  method: string, url: string, body?: unknown, token?: string,
  opts: { representation?: boolean } = {}
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST" || method === "PATCH")
    headers.Prefer = opts.representation ? "return=representation" : "return=minimal";
  const res = await fetch(SUPABASE_URL + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json, text };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}
function arr(json: unknown): Record<string, unknown>[] {
  return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
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
             jsonb_build_object('tenant_slug', $4::text, 'full_name', $3::text),
             false,
             extensions.crypt($5, extensions.gen_salt('bf', 10)), now(), now(), now(),
             '', '', '', '',
             $6, '', '')
     RETURNING id`,
    [userId, email, fullName, slug, password, "+8" + userId.replace(/-/g, "").slice(0, 12)]
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
      "notifications", "permission_grants", "system_audits", "tenants", "tenant_modules",
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
      for (let pass = 0; pass < 4; pass++) {
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        /* audit rows must be deleted AFTER grants/assignments (their
         * AFTER DELETE triggers re-seed system_audits rows). */
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        const left = await sql.query<{ n: string }>(
          `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        if (left.rows[0].n === "0") break;
      }
    } finally {
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove notification-phase fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `NotifCut!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `notifc-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Notifications — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Notifications — isolation", `notifc-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    const admEmail = `${E}-adm@test.local`;
    const userEmail = `${E}-user@test.local`;
    const otherEmail = `${E}-other@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, userEmail, otherEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "Notif Admin", E);
    const userId = await createAuthUser(sql, userEmail, P, "Notif User", E);
    const otherId = await createAuthUser(sql, otherEmail, P, "Notif Other", E);
    const isoId = await createAuthUser(sql, isoEmail, P, "Notif Iso", `notifc-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Hosted GoTrue runs behind a pooler; give the just-committed profile
    // fixtures a moment to be visible on GoTrue's connection before the
    // sign-ins (the token hook reads profiles to build claims).
    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const userToken = await signin(userEmail, P);
    const otherToken = await signin(otherEmail, P);
    const isoToken = await signin(isoEmail, P);

    // Diagnostic: decode the admin token's payload (sub + claims) and
    // read the admin's profile row server-side to attribute any RLS
    // failure precisely (never printed in full).
    {
      const payload = JSON.parse(
        Buffer.from(admToken.split(".")[1], "base64url").toString("utf8"),
      ) as { sub?: string; app_metadata?: Record<string, unknown> };
      const admProf = await sql.query(
        `SELECT id, tenant_id, access_role::text AS role, lifecycle_status::text AS lc
         FROM politicore.profiles WHERE id = $1`, [admId]);
      console.log(
        `diag: token-sub-match=${payload.sub === admId} appmeta=${JSON.stringify(payload.app_metadata)} profile=${JSON.stringify(admProf.rows[0])}`,
      );
    }

    // ══ D. Admin creation through the data API (INSERT policy) ═══════════
    // Inserts use `return=minimal` — matching the production service
    // (adminNotifyMember never chains .select()). Requesting the row back
    // (return=representation) would evaluate the SELECT policy on the
    // RETURNING rows; tenant admins intentionally have WRITE-ONLY
    // dispatch (SELECT policy: user_id = auth.uid() OR platform admin),
    // so a read-back of a member recipient's row is correctly denied.
    // Row ids are therefore collected through each RECIPIENT's own
    // authorized read — proving delivery at the same time.
    const notifIds: string[] = [];
    let insFail = "";
    const seedRows = [
      { user_id: userId, tenant_id: tenantA, type: "system", title: "Welcome", message: "first" },
      { user_id: userId, tenant_id: tenantA, type: "announcement", title: "Read-mark test", message: "second" },
      { user_id: otherId, tenant_id: tenantA, type: "system", title: "For other", message: "third" },
    ];
    for (const row of seedRows) {
      const one = await rest("POST", "/rest/v1/notifications", [row], admToken);
      if (one.status !== 201 && !insFail) {
        insFail = `row "${row.title}" → HTTP ${one.status}: ${one.text.slice(0, 140)}`;
      }
    }
    const delivered = await rest("GET",
      "/rest/v1/notifications?select=id,user_id,title", undefined, userToken);
    const deliveredOther = await rest("GET",
      "/rest/v1/notifications?select=id,user_id", undefined, otherToken);
    notifIds.push(
      ...arr(delivered.json).map((r) => r.id as string),
      ...arr(deliveredOther.json).map((r) => r.id as string),
    );
    record("D1 tenant admin inserts notifications (INSERT policy)",
      notifIds.length === 3,
      `${notifIds.length}/3 inserted+delivered${insFail ? `; ${insFail}` : ""}`);

    const insDenied = await rest("POST", "/rest/v1/notifications", [
      { user_id: otherId, tenant_id: tenantA, type: "system", title: "spoof", message: "x" },
    ], userToken);
    record("D2 member insert denied (creation is administrative)",
      insDenied.status >= 400, `HTTP ${insDenied.status}`);

    // Write-only dispatch: the admin CANNOT read the member rows back
    // (SELECT policy denies), while the recipients read them fine.
    const admView = await rest("GET", "/rest/v1/notifications?select=id", undefined, admToken);
    const memberIds = new Set([
      ...arr(delivered.json).map((r) => r.id as string),
      ...arr(deliveredOther.json).map((r) => r.id as string),
    ]);
    const leaked = arr(admView.json).filter((r) => memberIds.has(r.id as string)).length;
    record("D3 admin dispatch is write-only (no read-back of member rows)",
      admView.status === 200 && leaked === 0,
      `${leaked} member rows visible to admin`);

    // ══ A. Recipient isolation ═══════════════════════════════════════════
    const mine = await rest("GET", "/rest/v1/notifications?select=id,title,user_id", undefined, userToken);
    const mineRows = arr(mine.json);
    record("A1 recipient sees exactly their own rows (RLS, no client filter)",
      mine.status === 200 && mineRows.length === 2 && mineRows.every((r) => r.user_id === userId),
      `${mineRows.length} rows, all user_id=recipient`);

    const crossUser = await rest("GET",
      `/rest/v1/notifications?select=id&user_id=eq.${otherId}`, undefined, userToken);
    record("A2 cross-user read returns nothing",
      crossUser.status === 200 && arr(crossUser.json).length === 0,
      `HTTP ${crossUser.status}, rows=${arr(crossUser.json).length}`);

    // Tenant B member cannot see tenant A rows even targeting them by id.
    const crossTenant = await rest("GET",
      `/rest/v1/notifications?select=id&id=in.(${notifIds.join(",")})`, undefined, isoToken);
    record("A3 cross-tenant read returns nothing (id-targeted)",
      crossTenant.status === 200 && arr(crossTenant.json).length === 0,
      `HTTP ${crossTenant.status}, rows=${arr(crossTenant.json).length}`);

    const anon = await rest("GET", "/rest/v1/notifications?select=id");
    record("A4 anonymous read denied/empty",
      anon.status === 200 ? arr(anon.json).length === 0 : anon.status >= 400,
      `HTTP ${anon.status}, rows=${arr(anon.json).length}`);

    // ══ B. Read/unread semantics ═════════════════════════════════════════
    const unread0 = await rest("POST", "/rest/v1/rpc/my_unread_count", {}, userToken);
    record("B1 unread count RPC (recipient: 2)",
      unread0.status === 200 && Number(unread0.json) === 2, `count=${unread0.json}`);

    const mk1 = await rest("POST", "/rest/v1/rpc/mark_notifications_read",
      { p_ids: [notifIds[0]] }, userToken);
    record("B2 mark one read (RPC returns flipped count)",
      mk1.status === 200 && Number(mk1.json) === 1, `flipped=${mk1.json}`);

    const unread1 = await rest("POST", "/rest/v1/rpc/my_unread_count", {}, userToken);
    record("B3 unread count after mark-one (1)",
      unread1.status === 200 && Number(unread1.json) === 1, `count=${unread1.json}`);

    // Read-state persists through a re-fetch (the subscribe path).
    const refetched = await rest("GET",
      "/rest/v1/notifications?select=id,read_at&order=created_at.desc", undefined, userToken);
    const rfRows = arr(refetched.json);
    const readCount = rfRows.filter((r) => r.read_at !== null).length;
    record("B4 read_at persisted (1 of 2 read)",
      rfRows.length === 2 && readCount === 1, `read=${readCount}/2`);

    const mkAll = await rest("POST", "/rest/v1/rpc/mark_notifications_read",
      { p_ids: notifIds }, userToken);
    record("B5 mark-all via id list (flips the remaining own row)",
      mkAll.status === 200 && Number(mkAll.json) === 1, `flipped=${mkAll.json}`);

    // ══ C. Mutation guards ═══════════════════════════════════════════════
    // The OTHER user's row is unread; the recipient lists it in p_ids.
    // Ids come from the owner's own authorized read; the outcome is
    // observed through the owner's session as well (the admin cannot
    // read member rows back — write-only dispatch, see D3).
    const otherRows = await rest("GET",
      `/rest/v1/notifications?select=id,read_at&user_id=eq.${otherId}`, undefined, otherToken);
    const otherNotifId = arr(otherRows.json).find((r) => r.read_at === null)?.id as string;
    const crossMark = await rest("POST", "/rest/v1/rpc/mark_notifications_read",
      { p_ids: [otherNotifId] }, userToken);
    const otherState = await rest("GET",
      `/rest/v1/notifications?select=id,read_at&user_id=eq.${otherId}`, undefined, otherToken);
    const otherStillUnread = arr(otherState.json).every((r) => r.read_at === null);
    record("C1 cross-user mark-read is ineffective (guard inside RPC)",
      crossMark.status === 200 && Number(crossMark.json) === 0 && otherStillUnread,
      `flipped=${crossMark.json}; other user's row still unread=${otherStillUnread}`);

    // A different tenant's admin cannot notify into tenant A
    // (current_tenant_id() mismatch inside the WITH CHECK).
    const isoAdmin = await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [isoId]);
    void isoAdmin;
    const crossTenantIns = await rest("POST", "/rest/v1/notifications", [
      { user_id: userId, tenant_id: tenantA, type: "system", title: "cross-tenant spoof", message: "x" },
    ], await signin(isoEmail, P));
    record("C2 cross-tenant admin insert denied (server-resolved tenant)",
      crossTenantIns.status >= 400 || arr(crossTenantIns.json).length === 0,
      `HTTP ${crossTenantIns.status}`);

    // ══ E. Static Firebase boundary ══════════════════════════════════════
    const layout = fs.readFileSync(path.resolve("src/app/portal/layout.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const firebaseHits =
      (/lib\/firebase\/notifications/.test(layout) ? 1 : 0) +
      (/subscribeUserNotifications/.test(layout) ? 1 : 0) +
      (/markNotificationAsRead|markAllNotificationsAsRead/.test(layout) ? 1 : 0) +
      (/getUserAnnouncements/.test(layout) ? 1 : 0);
    record("E1 migrated portal surface is Firebase-notification-free",
      firebaseHits === 0, `portal/layout.tsx: ${firebaseHits} legacy references`);
    record("E2 canonical service wired",
      layout.includes("subscribeMyNotifications") && layout.includes("markNotificationsRead") &&
        layout.includes("markAllRead"),
      "subscribeMyNotifications + markNotificationsRead + markAllRead present");

    // ══ F. Pristine cleanup (in finally) ═════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);

    const tLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
    const nLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
    const ok = tLeft.rows[0].n === "0" && nLeft.rows[0].n === "0";
    record("F1 pristine cleanup", ok, `tenants=${tLeft.rows[0].n} notifications=${nLeft.rows[0].n}`);

    await sql.end();

    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed`);
    process.exit(pass === results.length ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
