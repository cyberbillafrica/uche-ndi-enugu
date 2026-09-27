/**
 * POLITICORE — SOCIAL FORCE PHASE F — FINAL LOCK HOSTED ACCEPTANCE.
 *
 * Final hosted verification of the LOCKED Social Force module on the
 * REAL deployed project (real GoTrue, JWTs, PostgREST, RLS, views).
 * Consolidates the ratified invariant set (gate §23) in one harness:
 *
 *   A — Identity matrix   (social member, admin, campaign-only, officer,
 *                          second-tenant social member — real sign-ins)
 *   B — Tasks             (authorized read / unauthorized denial / module gate)
 *   C — Submissions       (own submission, cross-member + cross-tenant
 *                          privacy, verified immutability)
 *   D — Points            (authoritative projection, award uniqueness,
 *                          mutation denial)
 *   E — Leaderboard       (position, points, reduced projection, tenant
 *                          isolation, module gate, mutation denial)
 *   F — Firebase boundary (static: legacy symbols absent from live code)
 *   G — Pristine cleanup  (fixtures removed; FORCE-RLS/module state restored)
 *
 * Secrets are read from .env.local and never printed.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

// ── env + REST helpers (established harness pattern) ─────────────────────────
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
function rpcError(json: unknown): string {
  const j = json as { message?: string; error?: string };
  return j?.message ?? j?.error ?? JSON.stringify(json).slice(0, 140);
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
      "social_point_awards", "social_task_submissions", "social_tasks",
      "notifications", "permission_grants", "system_audits", "tenants",
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
      for (let pass = 0; pass < 3; pass++) {
        await sql.query(`DELETE FROM politicore.social_point_awards WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.social_task_submissions WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.social_tasks WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.notifications
           WHERE user_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(
          `DELETE FROM politicore.system_audits
           WHERE actor_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
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
    console.error("cleanup incomplete — remove social-phase-f fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `SocForceF!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ A. Identity matrix fixtures (§23 Identity) ═══════════════════════
    const E = `socff-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase F — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase F — isolation", `socff-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantB]);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`socf.admin.${SUFFIX}@pcorb.example.com`, "Social Admin F", E);
    const member1 = await mk(`socf.m1.${SUFFIX}@pcorb.example.com`, "Social Member F1", E);
    const member2 = await mk(`socf.m2.${SUFFIX}@pcorb.example.com`, "Social Member F2", E);
    const campaignOnly = await mk(`socf.cmp.${SUFFIX}@pcorb.example.com`, "Campaign Only F", E);
    const officer = await mk(`socf.off.${SUFFIX}@pcorb.example.com`, "Officer F", E);
    const socialB = await mk(`socf.b.${SUFFIX}@pcorb.example.com`, "Social F Tenant B", `socff-iso-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member1]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member2]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialB]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [campaignOnly]);

    const T = {
      admin: await signin(`socf.admin.${SUFFIX}@pcorb.example.com`, P),
      m1: await signin(`socf.m1.${SUFFIX}@pcorb.example.com`, P),
      m2: await signin(`socf.m2.${SUFFIX}@pcorb.example.com`, P),
      cmp: await signin(`socf.cmp.${SUFFIX}@pcorb.example.com`, P),
      off: await signin(`socf.off.${SUFFIX}@pcorb.example.com`, P),
      b: await signin(`socf.b.${SUFFIX}@pcorb.example.com`, P),
    };
    record("A1 identity matrix: six real hosted sessions established", true,
      "admin, 2 social members, campaign-only, election officer, tenant-B member");

    // ══ B. Tasks: authorized / unauthorized / module gate ════════════════
    const mkTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Phase F lock task", p_points: 40, p_proof_required: false,
    }, T.admin);
    const TASK = typeof mkTask.json === "string" ? mkTask.json : "";
    record("B1 admin creates task via authority RPC", mkTask.status === 200 && !!TASK,
      mkTask.status === 200 ? `task ${TASK.slice(0, 8)}…` : rpcError(mkTask.json));

    const memberCreate = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "member attempt", p_points: 5,
    }, T.m1);
    record("B2 social member cannot create tasks",
      memberCreate.status === 400, rpcError(memberCreate.json).slice(0, 60));

    const readM1 = await rest("GET", "/rest/v1/social_tasks?select=id,points", undefined, T.m1);
    record("B3 social member reads active task",
      readM1.status === 200 && arr(readM1.json).some((r) => r.id === TASK),
      `${arr(readM1.json).length} row(s)`);

    const readCmp = await rest("GET", "/rest/v1/social_tasks?select=id", undefined, T.cmp);
    record("B4 campaign-only member sees zero social tasks",
      readCmp.status === 200 && arr(readCmp.json).length === 0, `${arr(readCmp.json).length} row(s)`);

    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const readOff = await rest("GET", "/rest/v1/social_tasks?select=id", undefined, T.m1);
    record("B5 module off → tasks fail closed",
      readOff.status === 200 && arr(readOff.json).length === 0, `${arr(readOff.json).length} row(s)`);
    const rpcOff = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.m1);
    record("B6 module off → submission RPC refuses",
      rpcOff.status === 400 && /social module is not enabled/i.test(rpcError(rpcOff.json)),
      rpcError(rpcOff.json).slice(0, 50));
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);

    // ══ C. Submissions: own / privacy / immutability ═════════════════════
    const sub1 = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.m1);
    const SUB = typeof sub1.json === "string" ? sub1.json : "";
    record("C1 member submits own completion", sub1.status === 200 && !!SUB,
      sub1.status === 200 ? `sub ${SUB.slice(0, 8)}…` : rpcError(sub1.json));

    const verify = await rest("POST", "/rest/v1/rpc/verify_social_submission", { p_submission: SUB }, T.admin);
    record("C2 admin verifies (server-resolved actor/tenant/points)",
      verify.status === 200 || verify.status === 204, `status ${verify.status}`);

    const subOther = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.m2);
    record("C3 second member submits own (independent row)", subOther.status === 200,
      `status ${subOther.status}`);
    const verifyOther = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: typeof subOther.json === "string" ? subOther.json : "" }, T.admin);
    record("C4 admin verifies second submission", verifyOther.status === 200 || verifyOther.status === 204,
      `status ${verifyOther.status}`);

    const reverify = await rest("POST", "/rest/v1/rpc/verify_social_submission", { p_submission: SUB }, T.admin);
    record("C5 second verification refused (immutable verified)",
      reverify.status === 400, rpcError(reverify.json).slice(0, 60));

    const crossB = await rest("POST", "/rest/v1/rpc/verify_social_submission", { p_submission: SUB }, T.b);
    record("C6 cross-tenant verification refused",
      crossB.status === 400, rpcError(crossB.json).slice(0, 60));

    const subsM2 = await rest("GET", "/rest/v1/social_task_submissions?select=id", undefined, T.m2);
    const ownOnly = arr(subsM2.json).every((r) => r.id !== SUB);
    record("C7 member sees only own submissions",
      subsM2.status === 200 && arr(subsM2.json).length === 1 && ownOnly,
      `${arr(subsM2.json).length} row(s)`);

    const patchVerified = await rest("PATCH", `/rest/v1/social_task_submissions?id=eq.${SUB}`,
      { proof_url: "https://tamper.example/after-verify" }, T.m1);
    record("C8 direct verified-submission mutation denied",
      patchVerified.status >= 400 || arr(patchVerified.json).length === 0, `${patchVerified.status}`);

    // ══ D. Points: projection / uniqueness / mutation denial ═════════════
    const prof = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("D1 points projection equals task points (40)",
      arr(prof.json).length === 1 && arr(prof.json)[0].points === 40,
      arr(prof.json).length ? `points=${arr(prof.json)[0].points}` : "no row");

    const awardCount = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.social_point_awards WHERE submission_id = $1`, [SUB]);
    record("D2 exactly one award per qualifying submission",
      awardCount.rows[0].n === "1", `awards=${awardCount.rows[0].n}`);

    const insAward = await rest("POST", "/rest/v1/social_point_awards",
      { tenant_id: tenantA, recipient_id: member1, submission_id: SUB, points: 999 }, T.m1);
    record("D3 direct award INSERT denied", insAward.status >= 400, `${insAward.status}`);
    const delAward = await rest("DELETE", `/rest/v1/social_point_awards?submission_id=eq.${SUB}`, undefined, T.admin);
    record("D4 direct award DELETE denied (admin included)", delAward.status >= 400, `${delAward.status}`);
    const patchPts = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${member1}`,
      { points: 100000 }, T.m1);
    record("D5 direct profiles.points mutation denied",
      patchPts.status >= 400 || arr(patchPts.json).length === 0, `${patchPts.status}`);

    // ══ E. Leaderboard: invariant set ════════════════════════════════════
    const lb = await rest("GET", "/rest/v1/social_leaderboard?select=*&order=position.asc", undefined, T.m1);
    const rows = arr(lb.json);
    const mine = rows.find((r) => r.id === member1);
    record("E1 entry with database-supplied position + projection points",
      !!mine && Number(mine.position) >= 1 && mine.points === 40,
      mine ? `position=${String(mine.position)} points=${String(mine.points)}` : "missing");
    record("E2 reduced projection: no email/phone/polling unit",
      rows.every((r) => !("email" in r) && !("phone" in r) && !("polling_unit_id" in r)),
      `${rows.length} rows checked`);
    const lbB = await rest("GET", "/rest/v1/social_leaderboard?select=id,tenant_id", undefined, T.b);
    record("E3 tenant isolation on the projection",
      arr(lbB.json).every((r) => r.tenant_id === tenantB), `${arr(lbB.json).length} row(s)`);
    const lbPatch = await rest("PATCH", `/rest/v1/social_leaderboard?id=eq.${member1}`,
      { points: 999999, position: 1 }, T.admin);
    record("E4 leaderboard mutation denied (even admin)", lbPatch.status >= 400, `${lbPatch.status}`);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const lbOff = await rest("GET", "/rest/v1/social_leaderboard?select=id", undefined, T.m1);
    record("E5 module off → leaderboard fails closed (0029)",
      lbOff.status === 200 && arr(lbOff.json).length === 0, `${arr(lbOff.json).length} row(s)`);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);

    // ══ F. Firebase boundary (static, live code) ═════════════════════════
    const SURFACES = [
      "src/components/dashboard/SocialMemberDashboard.tsx",
      "src/app/portal/tasks/page.tsx",
      "src/app/portal/points/page.tsx",
      "src/app/portal/leaderboard/page.tsx",
      "src/app/portal/admin/tasks/page.tsx",
      "src/lib/supabase/socialForce.ts",
    ];
    const LEGACY = ["getLeaderboard", "getUserTaskSubmissions", "submitTaskCompletion",
      "verifyTaskSubmission", "getActiveTasks", "getAllTasks", "syncLeaderboardProjection"];
    const hits: string[] = [];
    for (const rel of SURFACES) {
      const code = fs.readFileSync(path.resolve(rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
      if (/from\s+["'][^"']*(firebase|firestore)["']/i.test(code)) hits.push(`${rel}::firebase`);
      for (const fn of LEGACY) {
        if (new RegExp(`\\b${fn}\\b`).test(code)) hits.push(`${rel}::${fn}`);
      }
    }
    record("F1 Social Force is Firebase-free in live code",
      hits.length === 0, hits.length ? hits.slice(0, 3).join("; ") : "all clean");

    // ══ G. Pristine cleanup ══════════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
    try {
      const residual = await sql.query<{ tasks: string; subs: string; awards: string; tenants: string; users: string; mods: string; notifs: string }>(
        `SELECT
           (SELECT count(*)::text FROM politicore.social_tasks WHERE tenant_id::text = ANY($1)) tasks,
           (SELECT count(*)::text FROM politicore.social_task_submissions WHERE tenant_id::text = ANY($1)) subs,
           (SELECT count(*)::text FROM politicore.social_point_awards WHERE tenant_id::text = ANY($1)) awards,
           (SELECT count(*)::text FROM politicore.tenants WHERE id::text = ANY($1)) tenants,
           (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@pcorb.example.com' AND email LIKE '%${SUFFIX}%') users,
           (SELECT count(*)::text FROM politicore.tenant_modules WHERE tenant_id::text = ANY($1)) mods,
           (SELECT count(*)::text FROM politicore.notifications
              WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE '%${SUFFIX}%')) notifs`,
        [tenantIds]);
      const r = residual.rows[0];
      record("G1 pristine hosted state restored",
        r.tasks === "0" && r.subs === "0" && r.awards === "0" && r.tenants === "0" &&
        r.users === "0" && r.mods === "0" && r.notifs === "0",
        `tasks=${r.tasks} subs=${r.subs} awards=${r.awards} tenants=${r.tenants} users=${r.users} mods=${r.mods} notifs=${r.notifs}`);
    } catch (e) {
      record("G1 pristine hosted state restored", false, (e as Error).message.slice(0, 100));
    }
    await sql.end();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n══ SOCIAL FORCE PHASE F FINAL LOCK SMOKE: ${results.length - fails.length}/${results.length} ══`);
  if (fails.length) {
    console.log("FAILED:");
    for (const f of fails) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
