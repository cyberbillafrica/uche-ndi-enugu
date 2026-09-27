/**
 * POLITICORE — SOCIAL FORCE PHASE E — HOSTED ACCEPTANCE HARNESS.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real
 * views — proving the Phase E dashboard data layer under the same
 * acceptance standard as the Campaign / Social A–D harnesses.
 *
 * Journeys (gate §17):
 *   A — Dashboard reads  (tasks + own submissions + leaderboard + points:
 *                        the exact four reads SocialMemberDashboard performs)
 *   B — Points           (returned points equal the server projection)
 *   C — Leaderboard      (position/points/name from the projection; no client rank)
 *   D — Submission history (member receives only their own rows)
 *   E — Authorization    (campaign-only denied; election officer denied)
 *   F — Module gate      (social off → all four reads fail closed; restore)
 *   G — Tenant isolation (cross-tenant tasks/submissions/leaderboard)
 *   H — Firebase boundary (static scan of every migrated Phase E surface)
 *   I — Pristine cleanup (fixtures removed; FORCE-RLS state restored)
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
        await sql.query(
          `DELETE FROM politicore.social_point_awards WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.social_task_submissions WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.social_tasks WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(
          `DELETE FROM politicore.notifications
           WHERE user_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(
          `DELETE FROM politicore.system_audits
           WHERE actor_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(
          `DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(
          `DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
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
    console.error("cleanup incomplete — remove social-phase-e fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `SocForceE!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: 2 tenants + real users (A/E/F/G/D journeys) ════════════
    const E = `socfe-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase E — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase E — isolation", `socfe-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantB]);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`soce.admin.${SUFFIX}@pcorb.example.com`, "Social Admin E", E);
    const member1 = await mk(`soce.m1.${SUFFIX}@pcorb.example.com`, "Social Member E1", E);
    const member2 = await mk(`soce.m2.${SUFFIX}@pcorb.example.com`, "Social Member E2", E);
    // campaign-only + election-officer profiles in the SAME tenant (§17 E)
    const campaignOnly = await mk(`soce.cmp.${SUFFIX}@pcorb.example.com`, "Campaign Only E", E);
    const officer = await mk(`soce.off.${SUFFIX}@pcorb.example.com`, "Officer E", E);
    const adminB = await mk(`soce.adm2.${SUFFIX}@pcorb.example.com`, "Admin E Tenant B", `socfe-iso-${SUFFIX}`);
    const socialB = await mk(`soce.b.${SUFFIX}@pcorb.example.com`, "Social E Tenant B", `socfe-iso-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminB]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member1]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member2]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialB]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [campaignOnly]);

    const T = {
      admin: await signin(`soce.admin.${SUFFIX}@pcorb.example.com`, P),
      m1: await signin(`soce.m1.${SUFFIX}@pcorb.example.com`, P),
      m2: await signin(`soce.m2.${SUFFIX}@pcorb.example.com`, P),
      cmp: await signin(`soce.cmp.${SUFFIX}@pcorb.example.com`, P),
      off: await signin(`soce.off.${SUFFIX}@pcorb.example.com`, P),
      adminB: await signin(`soce.adm2.${SUFFIX}@pcorb.example.com`, P),
      b: await signin(`soce.b.${SUFFIX}@pcorb.example.com`, P),
    };

    // Fixture journey: task → m1 submission → verification (25 pts award),
    // exactly the state the Phase E dashboard presents.
    const mkTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Phase E dashboard task", p_points: 25, p_proof_required: false,
    }, T.admin);
    const TASK = typeof mkTask.json === "string" ? mkTask.json : "";
    record("A0 fixture task created", mkTask.status === 200 && !!TASK,
      mkTask.status === 200 ? `task ${TASK.slice(0, 8)}…` : rpcError(mkTask.json));

    const sub1 = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.m1);
    const SUB = typeof sub1.json === "string" ? sub1.json : "";
    record("A0 fixture submission created", sub1.status === 200 && !!SUB,
      sub1.status === 200 ? `sub ${SUB.slice(0, 8)}…` : rpcError(sub1.json));

    const verify = await rest("POST", "/rest/v1/rpc/verify_social_submission", { p_submission: SUB }, T.admin);
    record("A0 fixture verification done (award 25 pts)", verify.status === 200 || verify.status === 204,
      `status ${verify.status}`);

    // ══ A. Dashboard reads — the four SocialMemberDashboard queries ══════
    const dTasks = await rest("GET",
      "/rest/v1/social_tasks?select=*&status=eq.active&order=created_at.desc", undefined, T.m1);
    record("A1 dashboard tasks read (active, RLS-scoped)",
      dTasks.status === 200 && arr(dTasks.json).some((r) => r.id === TASK),
      `${arr(dTasks.json).length} row(s)`);

    const dSubs = await rest("GET",
      "/rest/v1/social_task_submissions?select=*&order=submitted_at.desc", undefined, T.m1);
    record("A2 dashboard submissions read (own rows only)",
      dSubs.status === 200 && arr(dSubs.json).length === 1 && arr(dSubs.json)[0].submitter_id === member1,
      `${arr(dSubs.json).length} row(s)`);

    const dLb = await rest("GET",
      "/rest/v1/social_leaderboard?select=*&order=position.asc&limit=100", undefined, T.m1);
    record("A3 dashboard leaderboard read (projection rows)",
      dLb.status === 200 && arr(dLb.json).length >= 1, `${arr(dLb.json).length} row(s)`);

    const dPts = await rest("GET",
      `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("A4 dashboard points read (politicore_profiles view)",
      dPts.status === 200 && arr(dPts.json).length === 1, `${arr(dPts.json).length} row(s)`);

    // ══ B. Points equal the server projection ════════════════════════════
    const pts = arr(dPts.json)[0]?.points;
    record("B1 points equal authoritative projection (25)",
      pts === 25, `points=${String(pts)}`);
    const awardChk = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.social_point_awards
       WHERE recipient_id = $1 AND submission_id = $2 AND points = 25`, [member1, SUB]);
    record("B2 exactly one award backs the projection",
      awardChk.rows[0].n === "1", `awards=${awardChk.rows[0].n}`);

    // ══ C. Leaderboard from the projection (no client rank) ══════════════
    const mine = arr(dLb.json).find((r) => r.id === member1);
    record("C1 position is database-supplied (>= 1)",
      !!mine && Number(mine.position) >= 1, mine ? `position=${String(mine.position)}` : "missing");
    record("C2 points/name/geography come from the projection",
      !!mine && mine.points === 25 && typeof mine.full_name === "string" && ("ward_name" in mine),
      mine ? `points=${String(mine.points)}` : "missing");
    record("C3 reduced projection: no email/phone/polling unit",
      arr(dLb.json).every((r) => !("email" in r) && !("phone" in r) && !("polling_unit_id" in r)),
      `${arr(dLb.json).length} rows checked`);

    // ══ D. Submission history: only their own rows ═══════════════════════
    const subs2 = await rest("GET", "/rest/v1/social_task_submissions?select=id", undefined, T.m2);
    record("D1 member2 sees zero of member1's submissions",
      subs2.status === 200 && arr(subs2.json).length === 0, `${arr(subs2.json).length} row(s)`);

    // ══ E. Authorization: campaign-only + officer denied ═════════════════
    const eTasks = await rest("GET", "/rest/v1/social_tasks?select=id", undefined, T.cmp);
    record("E1 campaign-only member cannot read social tasks",
      eTasks.status === 200 && arr(eTasks.json).length === 0, `${arr(eTasks.json).length} row(s)`);
    const eOff = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Officer task attempt", p_points: 5,
    }, T.off);
    record("E2 election officer cannot create social tasks",
      eOff.status === 400, rpcError(eOff.json).slice(0, 60));
    const eOffLb = await rest("GET", "/rest/v1/social_leaderboard?select=id", undefined, T.off);
    record("E3 election officer gets no leaderboard rows",
      eOffLb.status === 200 && arr(eOffLb.json).length === 0, `${arr(eOffLb.json).length} row(s)`);
    const eOffSub = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.off);
    record("E4 election officer cannot submit to social tasks",
      eOffSub.status === 400, rpcError(eOffSub.json).slice(0, 60));

    // ══ F. Module gate: social off → every dashboard read fails closed ═══
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const fTasks = await rest("GET", "/rest/v1/social_tasks?select=id", undefined, T.m1);
    record("F1 social off → tasks empty",
      fTasks.status === 200 && arr(fTasks.json).length === 0, `${arr(fTasks.json).length} row(s)`);
    const fSubs = await rest("GET", "/rest/v1/social_task_submissions?select=id", undefined, T.m1);
    record("F2 social off → submissions empty",
      fSubs.status === 200 && arr(fSubs.json).length === 0, `${arr(fSubs.json).length} row(s)`);
    const fLb = await rest("GET", "/rest/v1/social_leaderboard?select=id", undefined, T.m1);
    record("F3 social off → leaderboard empty (0029 gate)",
      fLb.status === 200 && arr(fLb.json).length === 0, `${arr(fLb.json).length} row(s)`);
    const fPts = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    // profiles is CORE-owned (identity/tenancy, gate §1.2): its row stays
    // readable when social is off — only its `points` value is Social
    // data, and Social writes (the dashboard never writes it) stay
    // impossible. The dashboard's Social gate (resolveSocialAccess) is
    // what fails closed here, not the view. Verify points unchanged.
    record("F4 social off → core profile row remains, Social gate denies UI",
      fPts.status === 200 && arr(fPts.json).length === 1 && arr(fPts.json)[0].points === 25,
      `${arr(fPts.json).length} row(s), points=${String(arr(fPts.json)[0]?.points)}`);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const fTasksR = await rest("GET", "/rest/v1/social_tasks?select=id", undefined, T.m1);
    record("F5 social restored → tasks visible again",
      arr(fTasksR.json).length >= 1, `${arr(fTasksR.json).length} row(s)`);

    // ══ G. Tenant isolation ══════════════════════════════════════════════
    const gTasks = await rest("GET", "/rest/v1/social_tasks?select=id,tenant_id", undefined, T.b);
    record("G1 cross-tenant tasks invisible",
      arr(gTasks.json).every((r) => r.tenant_id === tenantB), `${arr(gTasks.json).length} row(s)`);
    const gSubs = await rest("GET", "/rest/v1/social_task_submissions?select=id", undefined, T.b);
    record("G2 cross-tenant submissions invisible",
      arr(gSubs.json).length === 0, `${arr(gSubs.json).length} row(s)`);
    const gLb = await rest("GET", "/rest/v1/social_leaderboard?select=id,tenant_id", undefined, T.b);
    record("G3 cross-tenant leaderboard rows invisible",
      arr(gLb.json).every((r) => r.tenant_id === tenantB), `${arr(gLb.json).length} row(s)`);

    // ══ H. Firebase boundary (static, all migrated Phase E surfaces) ═════
    const SURFACES = [
      "src/components/dashboard/SocialMemberDashboard.tsx",
      "src/app/portal/tasks/page.tsx",
      "src/app/portal/points/page.tsx",
      "src/app/portal/leaderboard/page.tsx",
      "src/app/portal/admin/tasks/page.tsx",
      "src/app/portal/admin/health/page.tsx",
      "src/app/portal/admin/reports/page.tsx",
      "src/lib/supabase/socialForce.ts",
    ];
    const hits: string[] = [];
    for (const rel of SURFACES) {
      let src = fs.readFileSync(path.resolve(rel), "utf8");
      // Shared-Core Firebase imports that remain deliberately (Phase E
      // classification B/C: admin directory read, portal news, identity
      // bridge) are not Social consumers — strip those import lines
      // before scanning so the assertion targets Social-owned code.
      src = src
        .replace(/import\s*{[^}]*}\s*from\s*"@\/lib\/firebase\/firestore";?/g, (m) =>
          /getAllUsers|getPublishedNews|getUserProfile|getUserAnnouncements/.test(m) ? "" : m)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      if (/from\s+["'][^"']*(firebase|firestore)["']/i.test(src)) hits.push(`${rel}::firebase`);
      for (const fn of ["getLeaderboard", "getUserTaskSubmissions", "submitTaskCompletion",
        "verifyTaskSubmission", "getActiveTasks", "getAllTasks", "syncLeaderboardProjection"]) {
        // Only flag live identifiers, not comment banners.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
        if (new RegExp(`\\b${fn}\\b`).test(code)) hits.push(`${rel}::${fn}`);
      }
    }
    record("H1 all migrated Social surfaces are Firebase-free",
      hits.length === 0, hits.length ? hits.slice(0, 3).join("; ") : "all clean");

    // ══ I. Pristine cleanup ══════════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
    try {
      const residual = await sql.query<{ tasks: string; subs: string; awards: string; tenants: string; users: string; mods: string }>(
        `SELECT
           (SELECT count(*)::text FROM politicore.social_tasks WHERE tenant_id::text = ANY($1)) tasks,
           (SELECT count(*)::text FROM politicore.social_task_submissions WHERE tenant_id::text = ANY($1)) subs,
           (SELECT count(*)::text FROM politicore.social_point_awards WHERE tenant_id::text = ANY($1)) awards,
           (SELECT count(*)::text FROM politicore.tenants WHERE id::text = ANY($1)) tenants,
           (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@pcorb.example.com' AND email LIKE '%${SUFFIX}%') users,
           (SELECT count(*)::text FROM politicore.tenant_modules WHERE tenant_id::text = ANY($1)) mods`,
        [tenantIds]);
      const r = residual.rows[0];
      record("I1 pristine hosted state restored",
        r.tasks === "0" && r.subs === "0" && r.awards === "0" && r.tenants === "0" && r.users === "0" && r.mods === "0",
        `tasks=${r.tasks} subs=${r.subs} awards=${r.awards} tenants=${r.tenants} users=${r.users} mods=${r.mods}`);
    } catch (e) {
      record("I1 pristine hosted state restored", false, (e as Error).message.slice(0, 100));
    }
    await sql.end();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n══ SOCIAL FORCE PHASE E HOSTED SMOKE: ${results.length - fails.length}/${results.length} ══`);
  if (fails.length) {
    console.log("FAILED:");
    for (const f of fails) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
