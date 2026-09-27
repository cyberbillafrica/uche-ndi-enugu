/**
 * POLITICORE — MEMBER DIRECTORY CUTOVER — HOSTED ACCEPTANCE (§16).
 *
 * Verifies the canonical member-directory contract on the REAL hosted
 * project (real GoTrue sessions, real PostgREST, real RLS, real RPCs).
 * Journeys:
 *
 *   A — Directory reads       politicore_profiles via the data API is
 *                             RLS-scoped: self + same-tenant members;
 *                             cross-tenant and anon reads return nothing
 *   B — Lifecycle RPC         admin_set_member_lifecycle: admin succeeds,
 *                             member denied, cross-tenant admin denied,
 *                             unknown target fails closed, reactivation
 *                             restores
 *   C — Server-side audit     every lifecycle write lands in
 *                             system_audits with the right actor/action
 *   D — Firebase boundary     the migrated directory consumers statically
 *                             import no Firebase
 *   E — Pristine cleanup      fixtures removed; FORCE-RLS restored
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
  if (method === "POST") headers.Prefer = "return=representation";
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
        /* audit rows must be deleted AFTER the authority tables (their
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
    console.error("cleanup incomplete — remove member-phase fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `MembCut!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `membc-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Member Directory — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Member Directory — isolation", `membc-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    const admEmail = `${E}-adm@test.local`;
    const userEmail = `${E}-user@test.local`;
    const otherEmail = `${E}-other@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, userEmail, otherEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "Directory Admin", E);
    const userId = await createAuthUser(sql, userEmail, P, "Directory User", E);
    const otherId = await createAuthUser(sql, otherEmail, P, "Directory Other", E);
    const isoId = await createAuthUser(sql, isoEmail, P, "Directory Iso", `membc-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [isoId]);

    // Hosted GoTrue runs behind a pooler; let the profile fixtures become
    // visible on GoTrue's connection before the sign-ins (token hook reads
    // profiles to build claims).
    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const userToken = await signin(userEmail, P);
    const isoToken = await signin(isoEmail, P);

    // ══ A. Directory reads (listMembers path) ════════════════════════════
    const dirA = await rest("GET",
      "/rest/v1/politicore_profiles?select=id,email,full_name", undefined, admToken);
    const dirARows = arr(dirA.json).map((r) => r.id as string);
    record("A1 admin reads the same-tenant directory (RLS view)",
      dirA.status === 200 && dirARows.includes(userId) && dirARows.includes(otherId),
      `HTTP ${dirA.status}, ${dirARows.length} tenant rows`);

    const dirB = await rest("GET",
      `/rest/v1/politicore_profiles?select=id&id=in.(${userId},${isoId})`, undefined, admToken);
    const dirBRows = arr(dirB.json).map((r) => r.id as string);
    record("A2 cross-tenant members invisible (id-targeted)",
      dirB.status === 200 && dirBRows.includes(userId) && !dirBRows.includes(isoId),
      `visible=${dirBRows.length === 1 ? "own-tenant only" : String(dirBRows.length)}`);

    const dirIso = await rest("GET",
      `/rest/v1/politicore_profiles?select=id&id=in.(${userId},${otherId})`, undefined, isoToken);
    record("A3 tenant-B admin sees zero tenant-A rows",
      dirIso.status === 200 && arr(dirIso.json).length === 0,
      `HTTP ${dirIso.status}, rows=${arr(dirIso.json).length}`);

    const dirSelf = await rest("GET",
      `/rest/v1/politicore_profiles?select=id,lifecycle_status&email=eq.${userEmail}`,
      undefined, userToken);
    record("A4 member reads their own row (self visibility)",
      dirSelf.status === 200 && arr(dirSelf.json).length === 1 &&
        arr(dirSelf.json)[0].id === userId,
      `HTTP ${dirSelf.status}`);

    const dirAnon = await rest("GET", "/rest/v1/politicore_profiles?select=id");
    record("A5 anonymous directory read denied/empty",
      dirAnon.status === 200 ? arr(dirAnon.json).length === 0 : dirAnon.status >= 400,
      `HTTP ${dirAnon.status}, rows=${arr(dirAnon.json).length}`);

    // ══ B. Lifecycle authority RPC (setMemberLifecycle path) ═════════════
    const suspend = await rest("POST", "/rest/v1/rpc/admin_set_member_lifecycle", {
      p_profile_id: userId,
      p_lifecycle_status: "suspended",
      p_status_reason: "hosted acceptance suspension",
    }, admToken);
    record("B1 tenant admin suspends a member (RPC returns target id)",
      suspend.status === 200 && suspend.json === userId,
      `HTTP ${suspend.status}, returned=${JSON.stringify(suspend.json).slice(0, 60)}`);

    const suspendedState = await rest("GET",
      `/rest/v1/politicore_profiles?select=lifecycle_status,status_reason&email=eq.${userEmail}`,
      undefined, userToken);
    const susRow = arr(suspendedState.json)[0] ?? {};
    record("B2 suspension persisted (recipient observes own state)",
      susRow.lifecycle_status === "suspended" &&
        susRow.status_reason === "hosted acceptance suspension",
      `status=${String(susRow.lifecycle_status)}`);

    const memberAttempt = await rest("POST", "/rest/v1/rpc/admin_set_member_lifecycle", {
      p_profile_id: otherId,
      p_lifecycle_status: "deactivated",
      p_status_reason: "member self-serve attempt",
    }, userToken);
    record("B3 member lifecycle attempt denied (fail closed)",
      memberAttempt.status >= 400,
      `HTTP ${memberAttempt.status}`);

    const crossTenantAttempt = await rest("POST", "/rest/v1/rpc/admin_set_member_lifecycle", {
      p_profile_id: userId,
      p_lifecycle_status: "suspended",
      p_status_reason: "cross-tenant attempt",
    }, isoToken);
    record("B4 cross-tenant admin attempt denied (server-resolved tenant)",
      crossTenantAttempt.status >= 400,
      `HTTP ${crossTenantAttempt.status}`);

    const reactivate = await rest("POST", "/rest/v1/rpc/admin_set_member_lifecycle", {
      p_profile_id: userId,
      p_lifecycle_status: "active",
      p_status_reason: "appeal accepted",
    }, admToken);
    const activeState = await rest("GET",
      `/rest/v1/politicore_profiles?select=lifecycle_status&email=eq.${userEmail}`,
      undefined, userToken);
    record("B5 reactivation restores the member",
      reactivate.status === 200 && arr(activeState.json)[0]?.lifecycle_status === "active",
      `HTTP ${reactivate.status}, status=${String(arr(activeState.json)[0]?.lifecycle_status)}`);

    const ghost = await rest("POST", "/rest/v1/rpc/admin_set_member_lifecycle", {
      p_profile_id: crypto.randomUUID(),
      p_lifecycle_status: "suspended",
    }, admToken);
    record("B6 unknown target fails closed",
      ghost.status >= 400, `HTTP ${ghost.status}`);

    // ══ C. Server-side audit trail ═══════════════════════════════════════
    const audits = await sql.query<{ n: string; actor: string; action: string }>(
      `SELECT count(*)::text AS n,
              COALESCE((SELECT actor_id::text FROM politicore.system_audits
                         WHERE resource_id = $1 ORDER BY id DESC LIMIT 1), '') AS actor,
              COALESCE((SELECT action FROM politicore.system_audits
                         WHERE resource_id = $1 ORDER BY id DESC LIMIT 1), '') AS action
         FROM politicore.system_audits WHERE resource_id = $1`,
      [userId]);
    const a = audits.rows[0];
    record("C1 lifecycle writes audited server-side (actor + action pinned)",
      Number(a.n) === 2 && a.actor === admId && a.action === "profiles:update",
      `audit_rows=${a.n}, latest_actor_is_admin=${a.actor === admId}, action=${a.action}`);

    // ══ D. Static Firebase boundary ══════════════════════════════════════
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const membersPage = strip(fs.readFileSync(
      path.resolve("src/app/portal/admin/members/page.tsx"), "utf8"));
    const reportsPage = strip(fs.readFileSync(
      path.resolve("src/app/portal/admin/reports/page.tsx"), "utf8"));
    const gsPage = strip(fs.readFileSync(
      path.resolve("src/components/search/GlobalSearchModal.tsx"), "utf8"));
    const membersSvc = strip(fs.readFileSync(
      path.resolve("src/lib/supabase/members.ts"), "utf8"));
    const noFirebase = [membersPage, reportsPage, membersSvc]
      .map((s) => !/firebase/i.test(s));
    const gsClean = !/getAllUsers|getUserProfile|updateUserProfile/.test(gsPage);
    record("D1 migrated directory surface is Firebase-free",
      noFirebase.every(Boolean) && gsClean,
      `members=${noFirebase[0]}, reports=${noFirebase[1]}, svc=${noFirebase[2]}, gs-member-helpers-gone=${gsClean}`);
    record("D2 canonical service wired",
      membersPage.includes("listMembers") && membersPage.includes("setMemberLifecycle") &&
        reportsPage.includes("listMembers") && gsPage.includes("listMembers") &&
        membersSvc.includes("admin_set_member_lifecycle"),
      "listMembers + setMemberLifecycle + RPC present in consumers/service");

    // ══ E. Pristine cleanup (in finally) ═════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);

    const tLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
    const pLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
    const ok = tLeft.rows[0].n === "0" && pLeft.rows[0].n === "0";
    record("E1 pristine cleanup", ok, `tenants=${tLeft.rows[0].n} profiles=${pLeft.rows[0].n}`);

    await sql.end();

    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed`);
    process.exit(pass === results.length ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
