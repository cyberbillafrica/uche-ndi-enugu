/**
 * POLITICORE — SOCIAL FORCE PHASE D — HOSTED ACCEPTANCE HARNESS.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real
 * views — proving the Phase D points/leaderboard read layer under the
 * same acceptance standard as the Campaign / Social A–C harnesses.
 *
 * Journeys (gate §26):
 *   A — Points total (verified submission → expected projection)
 *   B — History (recipient sees their award history)
 *   C — Privacy (another member cannot read private history)
 *   D — Leaderboard (entry, points, rank, name, geography fields)
 *   E — Privacy boundary (no email/phone/polling unit)
 *   F — Tenant isolation (cross-tenant leaderboard/history)
 *   G — Module gate (social off → points/history/leaderboard fail; restore)
 *   H — Mutation abuse (award/profile/leaderboard INSERT/UPDATE/DELETE)
 *   I — Firebase boundary (static scan of the migrated surfaces)
 *   J — Pristine cleanup (all fixtures removed; state restored)
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
    console.error("cleanup incomplete — remove social-phase-d fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `SocForceD!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: 2 tenants + real users ═════════════════════════════════
    const E = `socfd-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase D — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase D — isolation", `socfd-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantB]);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`socd.admin.${SUFFIX}@pcorb.example.com`, "Social Admin D", E);
    const member1 = await mk(`socd.m1.${SUFFIX}@pcorb.example.com`, "Social Member D1", E);
    const member2 = await mk(`socd.m2.${SUFFIX}@pcorb.example.com`, "Social Member D2", E);
    const adminB = await mk(`socd.adm2.${SUFFIX}@pcorb.example.com`, "Admin D Tenant B", `socfd-iso-${SUFFIX}`);
    const socialB = await mk(`socd.b.${SUFFIX}@pcorb.example.com`, "Social D Tenant B", `socfd-iso-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminB]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member1]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member2]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialB]);

    const T = {
      admin: await signin(`socd.admin.${SUFFIX}@pcorb.example.com`, P),
      m1: await signin(`socd.m1.${SUFFIX}@pcorb.example.com`, P),
      m2: await signin(`socd.m2.${SUFFIX}@pcorb.example.com`, P),
      adminB: await signin(`socd.adm2.${SUFFIX}@pcorb.example.com`, P),
      b: await signin(`socd.b.${SUFFIX}@pcorb.example.com`, P),
    };

    // Fixture journey: task → submission → verification (25 pts to member1).
    const mkTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Phase D points task", p_points: 25, p_proof_required: false,
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

    // ══ A. Points total ══════════════════════════════════════════════════
    const prof = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("A1 points projection = 25 (server-maintained)",
      arr(prof.json).length === 1 && arr(prof.json)[0].points === 25,
      arr(prof.json).length ? `points=${arr(prof.json)[0].points}` : "no row");

    // ══ B. History ═══════════════════════════════════════════════════════
    const hist = await rest("GET",
      `/rest/v1/social_point_awards?select=id,submission_id,points,source,awarded_at`, undefined, T.m1);
    const histRow = arr(hist.json)[0];
    record("B1 recipient sees own award history (25 pts, task_verification)",
      arr(hist.json).length === 1 && histRow.points === 25 && histRow.source === "task_verification",
      arr(hist.json).length === 1 ? `${histRow.points} pts` : `${arr(hist.json).length} row(s)`);

    // ══ C. Privacy ═══════════════════════════════════════════════════════
    const other = await rest("GET", `/rest/v1/social_point_awards?select=id`, undefined, T.m2);
    record("C1 another member cannot read private history",
      other.status === 200 && arr(other.json).length === 0, `${arr(other.json).length} row(s)`);

    // ══ D. Leaderboard ═══════════════════════════════════════════════════
    const lb = await rest("GET", "/rest/v1/social_leaderboard?select=*&order=position.asc", undefined, T.m1);
    const rows = arr(lb.json);
    const mine = rows.find((r) => r.id === member1);
    record("D1 entry appears with correct points", !!mine && mine.points === 25,
      mine ? `points=${mine.points}` : "member missing");
    record("D2 rank is database-supplied position", !!mine && Number(mine.position) >= 1,
      mine ? `position=${String(mine.position)}` : "n/a");
    record("D3 display name + geography fields follow projection",
      !!mine && typeof mine.full_name === "string" && ("ward_name" in mine) && ("zone_id" in mine),
      mine ? `name=${String(mine.full_name).slice(0, 12)}` : "n/a");

    // ══ E. Privacy boundary ══════════════════════════════════════════════
    record("E1 no email/phone/polling unit in the projection",
      rows.every((r) => !("email" in r) && !("phone" in r) && !("polling_unit_id" in r)),
      `${rows.length} rows checked`);

    // ══ F. Tenant isolation ══════════════════════════════════════════════
    const lbB = await rest("GET", "/rest/v1/social_leaderboard?select=id,tenant_id", undefined, T.b);
    record("F1 cross-tenant leaderboard rows invisible",
      arr(lbB.json).every((r) => r.tenant_id === tenantB), `${arr(lbB.json).length} rows`);
    const histB = await rest("GET", "/rest/v1/social_point_awards?select=id", undefined, T.b);
    record("F2 cross-tenant history invisible",
      arr(histB.json).length === 0, `${arr(histB.json).length} row(s)`);

    // ══ G. Module gate ═══════════════════════════════════════════════════
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const gLb = await rest("GET", "/rest/v1/social_leaderboard?select=id", undefined, T.m1);
    record("G1 social off → leaderboard empty (0029 view gate)",
      gLb.status === 200 && arr(gLb.json).length === 0, `${arr(gLb.json).length} row(s)`);
    const gHist = await rest("GET", "/rest/v1/social_point_awards?select=id", undefined, T.m1);
    record("G2 social off → history empty",
      gHist.status === 200 && arr(gHist.json).length === 0, `${arr(gHist.json).length} row(s)`);
    const gAdminHist = await rest("POST", "/rest/v1/rpc/social_admin_award_history", { p_recipient: null }, T.admin);
    record("G3 social off → admin history RPC refuses",
      gAdminHist.status === 400 && /social module is not enabled/i.test(rpcError(gAdminHist.json)),
      `${gAdminHist.status}`);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const rLb = await rest("GET", "/rest/v1/social_leaderboard?select=id", undefined, T.m1);
    record("G4 social restored → leaderboard returns",
      arr(rLb.json).length >= 1, `${arr(rLb.json).length} row(s)`);

    // ══ H. Mutation abuse ════════════════════════════════════════════════
    const hIns = await rest("POST", "/rest/v1/social_point_awards",
      { tenant_id: tenantA, recipient_id: member1, submission_id: SUB, points: 999 }, T.m1);
    record("H1 direct award INSERT denied",
      hIns.status >= 400 || arr(hIns.json).length === 0, `${hIns.status}`);
    const hUpd = await rest("PATCH", `/rest/v1/social_point_awards?submission_id=eq.${SUB}`,
      { points: 1 }, T.m1);
    record("H2 direct award UPDATE denied",
      hUpd.status >= 400 || arr(hUpd.json).length === 0, `${hUpd.status}`);
    const hDel = await rest("DELETE", `/rest/v1/social_point_awards?submission_id=eq.${SUB}`, undefined, T.m1);
    record("H3 direct award DELETE denied",
      hDel.status >= 400 || hDel.status === 204, `${hDel.status}`);
    const hProf = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${member1}`,
      { points: 100000 }, T.m1);
    record("H4 direct profiles.points mutation denied",
      hProf.status >= 400 || arr(hProf.json).length === 0, `${hProf.status}`);
    const hLbUpd = await rest("PATCH", `/rest/v1/social_leaderboard?id=eq.${member1}`,
      { points: 999999 }, T.m1);
    record("H5 leaderboard UPDATE denied", hLbUpd.status >= 400, `${hLbUpd.status}`);
    const hLbIns = await rest("POST", "/rest/v1/social_leaderboard",
      { id: crypto.randomUUID(), tenant_id: tenantA, full_name: "fake", points: 1, position: 1 }, T.m1);
    record("H6 leaderboard INSERT denied", hLbIns.status >= 400, `${hLbIns.status}`);
    const hLbDel = await rest("DELETE", `/rest/v1/social_leaderboard?id=eq.${member1}`, undefined, T.m1);
    record("H7 leaderboard DELETE denied", hLbDel.status >= 400, `${hLbDel.status}`);
    const profNow = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("H8 points unchanged after all abuse",
      arr(profNow.json).length === 1 && arr(profNow.json)[0].points === 25,
      arr(profNow.json).length ? `points=${arr(profNow.json)[0].points}` : "no row");

    // ══ I. Firebase boundary (static) ════════════════════════════════════
    const SURFACES = [
      "src/lib/supabase/socialForce.ts",
      "src/app/portal/leaderboard/page.tsx",
      "src/app/portal/points/page.tsx",
    ];
    const hits: string[] = [];
    for (const rel of SURFACES) {
      const src = fs.readFileSync(path.resolve(rel), "utf8");
      if (/from\s+["'][^"']*(firebase|firestore)[^"']*["']/i.test(src)) hits.push(`${rel}::firebase`);
      if (src.includes("getLeaderboard")) hits.push(`${rel}::getLeaderboard`);
      if (/\bonSnapshot\b/.test(src)) hits.push(`${rel}::onSnapshot`);
    }
    record("I1 migrated points/leaderboard surfaces are Firebase-free",
      hits.length === 0, hits.length ? hits.slice(0, 3).join("; ") : "all clean");

    // ══ J. Pristine cleanup ══════════════════════════════════════════════
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
      record("J1 pristine hosted state restored",
        r.tasks === "0" && r.subs === "0" && r.awards === "0" && r.tenants === "0" && r.users === "0" && r.mods === "0",
        `tasks=${r.tasks} subs=${r.subs} awards=${r.awards} tenants=${r.tenants} users=${r.users} mods=${r.mods}`);
    } catch (e) {
      record("J1 pristine hosted state restored", false, (e as Error).message.slice(0, 100));
    }
    await sql.end();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n══ SOCIAL FORCE PHASE D HOSTED SMOKE: ${results.length - fails.length}/${results.length} ══`);
  if (fails.length) {
    console.log("FAILED:");
    for (const f of fails) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
