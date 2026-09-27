/**
 * POLITICORE — CORE IDENTITY/AUTH PHASE 1 — HOSTED ACCEPTANCE (§27).
 *
 * Verifies the NATIVE Supabase identity cutover on the REAL hosted
 * project (real GoTrue, real PostgREST, real RLS, real provisioning
 * trigger). Journeys:
 *
 *   A — Native auth lifecycle   real signUp (with tenant_slug) →
 *                               profile provisioned by the 0007 trigger
 *                               → real password grant → authenticated
 *                               profile read → sign-out semantics
 *   B — AuthContext data        politicore_profiles / organizational_
 *       surface                 assignments / permission_grants views
 *                               resolve for the session (incl.
 *                               granted:false preservation)
 *   C — Identity isolation      cross-tenant profile/assignment denial;
 *                               profile self-update authority-field guard
 *   D — Admin member-add        admin (secondary-client) signup creates
 *                               the member + provisioned profile; admin
 *                               enrichment UPDATE succeeds under the
 *                               admin's own session; non-admin cannot
 *   E — Static Firebase         migrated auth surfaces have no Firebase
 *       boundary                auth imports; session bridge is gone
 *   F — Pristine cleanup        fixture tenants/users/grants removed;
 *                               FORCE-RLS state restored
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
  method: string, url: string, body?: unknown, token?: string
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST" || method === "PATCH") headers.Prefer = "return=representation";
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
function postgrestRows(res: { status: number; json: unknown; text: string }) {
  return res.status >= 200 && res.status < 300 ? arr(res.json) : [];
}

async function realSignup(
  email: string, password: string, fullName: string, slug: string
): Promise<{ userId: string | null; token: string | null; status: number }> {
  const r = await rest("POST", "/auth/v1/signup", {
    email, password,
    data: { tenant_slug: slug, full_name: fullName },
  });
  const j = r.json as { access_token?: string; user?: { id?: string } };
  return { userId: j?.user?.id ?? null, token: j?.access_token ?? null, status: r.status };
}

async function signin(email: string, password: string): Promise<string> {
  const si = await rest("POST", "/auth/v1/token?grant_type=password", { email, password });
  if (si.status !== 200)
    throw new Error(`signin failed (${si.status}): ${JSON.stringify(si.json).slice(0, 200)}`);
  return (si.json as { access_token: string }).access_token;
}

/** Create a GoTrue user directly (bcrypt) when hosted email rules reject a signup. */
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

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  try {
    const CLEAN_TABLES = [
      "social_point_awards", "social_task_submissions", "social_tasks",
      "notifications", "permission_grants", "system_audits", "tenants",
      "tenant_modules",
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
        await sql.query(`DELETE FROM politicore.notifications
                         WHERE user_id IN (SELECT id FROM auth.users WHERE email = ANY($1))
                            OR tenant_id = ANY($2)`, [emails, tenantIds]);
        /*
         * grants/assignments deletes fire trg_audit_grants/assignments
         * (AFTER DELETE) — audit rows must be deleted AFTER them, never
         * before, or the trigger re-seeds rows that block tenant removal.
         */
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.organizational_assignments WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.system_audits
                         WHERE actor_id IN (SELECT id FROM auth.users WHERE email = ANY($1))
                            OR tenant_id = ANY($2)`, [emails, tenantIds]);
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
    console.error("cleanup incomplete — remove identity-phase fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  let volId = "";
  const P = `IdentPhase1!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ Fixtures: two tenants ════════════════════════════════════════════
    const E = `ident1-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Identity Phase 1 — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'campaign', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Identity Phase 1 — isolation", `ident1-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    // ══ A. Native auth lifecycle (real GoTrue signup → provisioned profile) ═
    const volEmail = `${E}-vol@test.local`;
    emails.push(volEmail);
    const su = await realSignup(volEmail, P, "Identity Vol", E);
    let volSignupReal = false;
    if (su.status !== 200 || !su.userId) {
      // Hosted GoTrue rejects .test domains / rate-limits confirmation
      // emails — the established harness fallback (verify-hosted-auth.ts)
      // provisions the GoTrue row directly. The SIGN-IN in A3 and the
      // trigger contract in A2 (fired on direct INSERT too) remain real.
      volId = await createAuthUser(sql, volEmail, P, "Identity Vol", E);
      record("A1 real signup with tenant_slug", false,
        `GoTrue signup unavailable on hosted (HTTP ${su.status}); direct auth.users fixture used — trigger + sign-in verified instead`);
    } else {
      volSignupReal = true;
      volId = su.userId;
      record("A1 real signup with tenant_slug", true, `user ${su.userId.slice(0, 8)}… created via GoTrue`);
    }

    // Provisioning: the 0007 trigger must have created a PLAIN member profile.
    const prov = await sql.query<{ access_role: string; membership_types: string[] }>(
      `SELECT access_role::text, membership_types::text[] FROM politicore.profiles WHERE id = $1`, [volId]);
    record("A2 signup trigger provisions plain member profile",
      prov.rows.length === 1 && prov.rows[0].access_role === "member" &&
        (prov.rows[0].membership_types ?? []).length === 0,
      prov.rows.length === 1
        ? `access_role=${prov.rows[0].access_role}, memberships=[${(prov.rows[0].membership_types ?? []).join(",") || "none"}]`
        : "NO PROFILE PROVISIONED");

    // Real password grant (GoTrue) — the native session.
    const volToken = await signin(volEmail, P);
    record("A3 native password sign-in", Boolean(volToken), "real GoTrue access token issued");

    // Authenticated profile read through the hosted data API.
    const profRes = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${volId}&select=*`, undefined, volToken);
    const profRows = postgrestRows(profRes);
    record("A4 session reads own profile via data API",
      profRes.status === 200 && profRows.length === 1 && profRows[0].id === volId,
      profRows.length === 1 ? "politicore_profiles row returned" : `HTTP ${profRes.status}, rows=${profRows.length}`);

    // Grants view is reachable and empty for a fresh member.
    const grantsRes = await rest("GET", `/rest/v1/permission_grants?user_id=eq.${volId}&select=*`, undefined, volToken);
    record("A5 grants view resolves (empty for fresh member)",
      grantsRes.status === 200 && postgrestRows(grantsRes).length === 0,
      `HTTP ${grantsRes.status}`);

    // Sign-out: token revocation endpoint works (native session ends).
    const so = await rest("POST", "/auth/v1/logout", {}, volToken);
    record("A6 native sign-out endpoint", so.status === 204 || so.status === 200, `HTTP ${so.status}`);
    const volToken2 = await signin(volEmail, P); // reuse for later journeys

    // ══ B. AuthContext data surface (views + admin RLS interplay) ═════════
    // Admin fixture (direct GoTrue row + admin profile under tenant A).
    const admEmail = `${E}-adm@test.local`;
    emails.push(admEmail);
    const admId = await createAuthUser(sql, admEmail, P, "Identity Admin", E);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin', membership_types = '{campaign_member,social_member}'
       WHERE id = $1`, [admId]);

    // One seeded grant with granted:false for the volunteer — denial preserved.
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'manage_members', false)`, [tenantA, volId]);

    const g2 = await rest("GET", `/rest/v1/permission_grants?user_id=eq.${volId}&select=*`, undefined, volToken2);
    const g2rows = postgrestRows(g2);
    record("B1 granted:false denial preserved in grants view",
      g2.status === 200 && g2rows.length === 1 && g2rows[0].granted === false,
      g2rows.length === 1 ? "grant returned with granted=false (never filtered)" : `HTTP ${g2.status}, rows=${g2rows.length}`);

    // Assignments view reachable for the member (may be empty).
    const asgRes = await rest("GET", `/rest/v1/organizational_assignments?user_id=eq.${volId}&select=*`, undefined, volToken2);
    record("B2 assignments view resolves for member",
      asgRes.status === 200, `HTTP ${asgRes.status}, rows=${postgrestRows(asgRes).length}`);

    // DB resolver callable with the session (synchronous hasPermission basis).
    const permRes = await rest("POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "manage_members" }, volToken2);
    record("B3 DB permission resolver reachable (granted:false → denied)",
      permRes.status === 200 && permRes.json === false,
      `manage_members → ${JSON.stringify(permRes.json)}`);

    // ══ C. Identity isolation ════════════════════════════════════════════
    // Second-tenant member.
    const isoEmail = `${E}-iso@test.local`;
    emails.push(isoEmail);
    const isoId = await createAuthUser(sql, isoEmail, P, "Isolation Member", `ident1-iso-${SUFFIX}`);

    // Cross-tenant profile read → no rows.
    const xProf = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${isoId}&select=*`, undefined, volToken2);
    record("C1 cross-tenant profile read returns nothing",
      xProf.status === 200 && postgrestRows(xProf).length === 0,
      `HTTP ${xProf.status}, rows=${postgrestRows(xProf).length}`);

    // Self UPDATE of authority fields through the data API → denied (0002 guard).
    const guard = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${volId}`,
      { membership_types: ["social_member", "campaign_member"] }, volToken2);
    const stillPlain = await sql.query<{ mt: string[] }>(
      `SELECT membership_types::text[] AS mt FROM politicore.profiles WHERE id = $1`, [volId]);
    record("C2 self-service authority-field UPDATE is blocked",
      ((stillPlain.rows[0]?.mt ?? []).length === 0),
      `attempted self-grant; memberships still [${(stillPlain.rows[0]?.mt ?? []).join(",") || "none"}] (PATCH HTTP ${guard.status})`);

    // Admin enrichment under the admin's own session (member-add pattern):
    // the 0031 SECURITY DEFINER RPC is the enrichment transport (0027
    // narrowed the profiles view to SELECT-only). Server-side guard:
    // tenant-admin caller, same-tenant target.
    const enrich = await rest("POST", "/rest/v1/rpc/admin_enrich_member_profile",
      { p_profile_id: volId, p_phone: "+2348000000000",
        p_membership_types: ["campaign_member"], p_access_role: "member" },
      await signin(admEmail, P));
    const enriched = await sql.query<{ phone: string | null; mt: string[] }>(
      `SELECT phone, membership_types::text[] AS mt FROM politicore.profiles WHERE id = $1`, [volId]);
    record("C3 admin session enrichment RPC succeeds",
      enrich.status === 200 && enriched.rows[0]?.phone === "+2348000000000" &&
        (enriched.rows[0]?.mt ?? []).includes("campaign_member"),
      `phone=${enriched.rows[0]?.phone}, memberships=[${(enriched.rows[0]?.mt ?? []).join(",")}] (RPC HTTP ${enrich.status})`);

    // The same RPC rejects a non-admin caller (fail closed).
    const nonAdminRpc = await rest("POST", "/rest/v1/rpc/admin_enrich_member_profile",
      { p_profile_id: volId, p_phone: "+234111111111" }, volToken2);
    const afterAbuse = await sql.query<{ phone: string | null }>(
      `SELECT phone FROM politicore.profiles WHERE id = $1`, [volId]);
    record("C4 non-admin cannot invoke the enrichment RPC",
      nonAdminRpc.status >= 400 && afterAbuse.rows[0]?.phone === "+2348000000000",
      `RPC HTTP ${nonAdminRpc.status}; phone unchanged=${afterAbuse.rows[0]?.phone}`);

    // Cross-tenant admin cannot enrich a foreign-tenant profile (even an
    // admin of tenant B): server-resolved tenant bound.
    const isoAdminMade = await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [isoId]);
    void isoAdminMade;
    const crossAdminRpc = await rest("POST", "/rest/v1/rpc/admin_enrich_member_profile",
      { p_profile_id: volId, p_phone: "+2345555555555" }, await signin(isoEmail, P));
    const afterCross = await sql.query<{ phone: string | null }>(
      `SELECT phone FROM politicore.profiles WHERE id = $1`, [volId]);
    record("C5 cross-tenant admin enrichment denied",
      crossAdminRpc.status >= 400 && afterCross.rows[0]?.phone === "+2348000000000",
      `RPC HTTP ${crossAdminRpc.status}; phone unchanged=${afterCross.rows[0]?.phone}`);

    // ══ D. Admin member-add contract (secondary-client signup + admin session) ═
    const memEmail = `${E}-new@test.local`;
    emails.push(memEmail);
    const created = await realSignup(memEmail, P, "Admin Created Member", E);
    let memSignupReal = false;
    if (created.userId) {
      memSignupReal = true;
      const admToken = await signin(admEmail, P);
      const enr = await rest("POST", "/rest/v1/rpc/admin_enrich_member_profile",
        { p_profile_id: created.userId, p_phone: "+2347000000000",
          p_membership_types: ["social_member"] }, admToken);
      const row = await sql.query<{ mt: string[]; phone: string | null }>(
        `SELECT membership_types::text[] AS mt, phone FROM politicore.profiles WHERE id = $1`, [created.userId]);
      const provisioned = row.rows.length === 1 &&
        row.rows[0].mt.includes("social_member") && row.rows[0].phone === "+2347000000000";
      record("D1 admin member-add creates + provisions + enriches member",
        provisioned,
        provisioned ? "profile provisioned by trigger, enriched under admin session"
                    : `HTTP ${enr.status}, memberships=[${(row.rows[0]?.mt ?? []).join(",")}]`);
      // The admin's own session is untouched (enrichment ran WITH admToken
      // and the signup rode a separate ephemeral grant — D1 proves both).
    } else {
      // Same hosted-GoTrue fallback: provision the member row directly,
      // then verify the enrichment-under-admin-session contract (0031 RPC).
      const uid = await createAuthUser(sql, memEmail, P, "Admin Created Member", E);
      const admToken = await signin(admEmail, P);
      const enr = await rest("POST", "/rest/v1/rpc/admin_enrich_member_profile",
        { p_profile_id: uid, p_phone: "+2347000000000",
          p_membership_types: ["social_member"] }, admToken);
      const row = await sql.query<{ mt: string[]; phone: string | null }>(
        `SELECT membership_types::text[] AS mt, phone FROM politicore.profiles WHERE id = $1`, [uid]);
      const provisioned = row.rows.length === 1 &&
        row.rows[0].mt.includes("social_member") && row.rows[0].phone === "+2347000000000";
      record("D1 admin member-add creates + provisions + enriches member", provisioned,
        provisioned ? "member provisioned (direct fixture), enriched under admin session (GoTrue signup HTTP " + created.status + ")"
                    : `HTTP ${enr.status}, memberships=[${(row.rows[0]?.mt ?? []).join(",")}]`);
    }
    void memSignupReal; void volSignupReal;

    // Admin remains authenticated as admin after the member-add flow.
    const admSelf = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${admId}&select=*`, undefined, await signin(admEmail, P));
    const admSelfRows = postgrestRows(admSelf);
    record("D2 admin session remains admin after member-add",
      admSelfRows.length === 1 && admSelfRows[0].access_role === "admin",
      admSelfRows.length === 1 ? `access_role=${admSelfRows[0].access_role}` : "row missing");

    // ══ E. Static Firebase boundary ══════════════════════════════════════
    const authSurfaces = [
      "src/contexts/AuthContext.tsx",
      "src/app/login/page.tsx",
      "src/app/volunteer/page.tsx",
      "src/app/portal/admin/members/add/page.tsx",
      "src/components/layout/Header.tsx",
      "src/lib/supabase/auth.ts",
      "src/lib/supabase/session.ts",
    ];
    let fbHits = 0;
    for (const f of authSurfaces) {
      const body = fs.readFileSync(path.resolve(f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/from\s+["']firebase\/auth["']/.test(body) || /lib\/firebase\/auth["']/.test(body) ||
          body.includes("signInWithIdToken")) fbHits++;
    }
    record("E1 migrated auth surfaces are Firebase-auth-free",
      fbHits === 0, `${authSurfaces.length} surfaces scanned, ${fbHits} Firebase-auth references`);

    const bridgeGone =
      !fs.existsSync(path.resolve("src/lib/supabase/session-bridge.ts")) &&
      (() => {
        let hits = 0;
        const walk = (dir: string) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.tsx?$/.test(e.name)) continue;
            const body = fs.readFileSync(p, "utf8")
              .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
            if (body.includes("session-bridge") || body.includes("signInWithIdToken")) hits++;
          }
        };
        walk(path.resolve("src"));
        return hits === 0;
      })();
    record("E2 session bridge fully removed", bridgeGone,
      "no session-bridge file, no import, no signInWithIdToken reference");

    // ══ F. Pristine cleanup (in finally via cleanup()) ═══════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);

    const tLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
    const uLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM auth.users WHERE email LIKE '%${SUFFIX}' OR email LIKE '%${SUFFIX}-%'`);
    const gLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
    const ok = tLeft.rows[0].n === "0" && uLeft.rows[0].n === "0" && gLeft.rows[0].n === "0";
    record("F1 pristine cleanup", ok,
      `tenants=${tLeft.rows[0].n} users=${uLeft.rows[0].n} grants=${gLeft.rows[0].n}`);

    await sql.end();

    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed`);
    process.exit(pass === results.length ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
