/**
 * POLITICORE — SOCIAL FORCE PHASE A — HOSTED ACCEPTANCE HARNESS.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real public
 * RPC wrappers — proving the Social Force Phase A substrate (0028) under
 * the same acceptance standard as the Campaign Phase A–E / lock harnesses.
 *
 * Journeys:
 *   A — social module enabled: member visibility + task submission path
 *   B — social module disabled (tenant B): fail-closed everywhere
 *   C — admin authority (no social membership needed)
 *   D — membership boundaries (campaign-only / election officer / plain)
 *   E — submission lifecycle (active/expired/proof rules, resubmission)
 *   F — verification authority + point ledger + server-resolved actor
 *   G — leaderboard projection (reduced fields, tenant isolation)
 *   H — direct PostgREST abuse (anon + member + cross-tenant)
 *   I — grants/privilege checks (0028 ratified matrix)
 *   J — legacy/dependency checks (no Campaign/social coupling)
 *   K — pristine cleanup verification
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
          `DELETE FROM politicore.system_audits
           WHERE actor_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(
          `DELETE FROM politicore.notifications
           WHERE user_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
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
    console.error("cleanup incomplete — remove social-phase-a fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `SocForceA!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: 2 tenants + real users ═════════════════════════════════
    const E = `socfa-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase A — social on", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase A — social off", `socfa-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB); // no social module row ⇒ module disabled

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`soc.admin.${SUFFIX}@pcorb.example.com`, "Social Admin A", E);
    const member1 = await mk(`soc.m1.${SUFFIX}@pcorb.example.com`, "Social Member 1", E);
    const member2 = await mk(`soc.m2.${SUFFIX}@pcorb.example.com`, "Social Member 2", E);
    const campOnly = await mk(`soc.camp.${SUFFIX}@pcorb.example.com`, "Campaign-only", E);
    const officer = await mk(`soc.eo.${SUFFIX}@pcorb.example.com`, "Election Officer", E);
    const plainU = await mk(`soc.plain.${SUFFIX}@pcorb.example.com`, "Plain Member", E);
    void plainU; // token only (T.plain) — identity asserted via D4
    const socialB = await mk(`soc.b.${SUFFIX}@pcorb.example.com`, "Social B", `socfa-off-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member1]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member2]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [campOnly]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialB]);

    // tokens (real GoTrue)
    const T = {
      admin: await signin(`soc.admin.${SUFFIX}@pcorb.example.com`, P),
      m1: await signin(`soc.m1.${SUFFIX}@pcorb.example.com`, P),
      m2: await signin(`soc.m2.${SUFFIX}@pcorb.example.com`, P),
      camp: await signin(`soc.camp.${SUFFIX}@pcorb.example.com`, P),
      eo: await signin(`soc.eo.${SUFFIX}@pcorb.example.com`, P),
      plain: await signin(`soc.plain.${SUFFIX}@pcorb.example.com`, P),
      b: await signin(`soc.b.${SUFFIX}@pcorb.example.com`, P),
    };

    // ══ A. social module enabled — visibility + submission path ══════════
    const mkTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Phase A task", p_description: "hosted smoke",
      p_platform: "facebook", p_action: "share", p_points: 25,
      p_status: "active", p_target_url: "https://example.com/post",
      p_proof_required: true,
    }, T.admin);
    record("A1 admin creates task via public RPC", mkTask.status === 200 && typeof mkTask.json === "string",
      mkTask.status === 200 ? `task ${String(mkTask.json).slice(0, 8)}…` : rpcError(mkTask.json));
    const TASK = typeof mkTask.json === "string" ? mkTask.json : "";

    const visM1 = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK, undefined, T.m1);
    record("A2 social member sees active task", visM1.status === 200 && arr(visM1.json).length === 1,
      `${arr(visM1.json).length} row(s)`);

    const expTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Expired task", p_points: 10,
      p_expiration_date: new Date(Date.now() - 3600_000).toISOString(),
    }, T.admin);
    record("A3 admin cannot create already-expired task",
      expTask.status === 400 && /expiration date must be in the future/i.test(rpcError(expTask.json)),
      `${expTask.status} ${rpcError(expTask.json).slice(0, 60)}`);

    // ══ B. social module disabled (tenant B) — fail-closed ═══════════════
    const visB = await rest("GET", "/rest/v1/social_tasks", undefined, T.b);
    record("B1 module disabled → member sees no tasks", visB.status === 200 && arr(visB.json).length === 0,
      `${arr(visB.json).length} rows`);
    const rpcB = await rest("POST", "/rest/v1/rpc/create_social_task", { p_title: "nope" }, T.b);
    record("B2 module disabled → RPC refuses",
      rpcB.status === 400 && /social module is not enabled/i.test(rpcError(rpcB.json)),
      `${rpcB.status} ${rpcError(rpcB.json).slice(0, 60)}`);
    const lbB = await rest("GET", "/rest/v1/social_leaderboard", undefined, T.b);
    record("B3 module disabled → leaderboard carries no tenant-B member rows",
      lbB.status === 200 && arr(lbB.json).every((r) => r.tenant_id !== tenantB),
      `${arr(lbB.json).length} rows visible`);

    // ══ C. admin authority (no social membership) ════════════════════════
    const upd = await rest("POST", "/rest/v1/rpc/update_social_task", {
      p_task: TASK, p_title: "Phase A task v2",
    }, T.admin);
    record("C1 admin updates task (no social membership needed)",
      upd.status === 200 || upd.status === 204, `status ${upd.status}`);
    const st = await rest("POST", "/rest/v1/rpc/set_social_task_status",
      { p_task: TASK, p_status: "inactive" }, T.admin);
    record("C2 admin deactivates task", st.status === 200 || st.status === 204, `status ${st.status}`);
    const subInactive = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/x" }, T.m1);
    record("C3 inactive task refuses submission",
      subInactive.status === 400 && /task is not active/i.test(rpcError(subInactive.json)),
      `${subInactive.status} ${rpcError(subInactive.json).slice(0, 50)}`);
    await rest("POST", "/rest/v1/rpc/set_social_task_status", { p_task: TASK, p_status: "active" }, T.admin);

    // ══ D. membership boundaries ═════════════════════════════════════════
    const subCamp = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/c" }, T.camp);
    record("D1 campaign-only member denied submission",
      subCamp.status === 400 && /social membership is required/i.test(rpcError(subCamp.json)),
      `${subCamp.status} ${rpcError(subCamp.json).slice(0, 50)}`);
    const subEo = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/e" }, T.eo);
    record("D2 election officer denied submission", subEo.status === 400 &&
      /social membership is required/i.test(rpcError(subEo.json)),
      `${subEo.status} ${rpcError(subEo.json).slice(0, 50)}`);
    const verEo = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: crypto.randomUUID() }, T.eo);
    record("D3 election officer denied verification",
      verEo.status === 400 && /admin authority/i.test(rpcError(verEo.json)),
      `${verEo.status} ${rpcError(verEo.json).slice(0, 50)}`);
    const subPlain = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/p" }, T.plain);
    record("D4 plain member denied submission", subPlain.status === 400 &&
      /social membership is required/i.test(rpcError(subPlain.json)),
      `${subPlain.status} ${rpcError(subPlain.json).slice(0, 50)}`);
    const visCamp = await rest("GET", "/rest/v1/social_tasks", undefined, T.camp);
    record("D5 campaign-only member sees no tasks", visCamp.status === 200 && arr(visCamp.json).length === 0,
      `${arr(visCamp.json).length} rows`);

    // ══ E. submission lifecycle ══════════════════════════════════════════
    const sub1 = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/1" }, T.m1);
    record("E1 member submits with proof", sub1.status === 200 && typeof sub1.json === "string",
      sub1.status === 200 ? `submission ${String(sub1.json).slice(0, 8)}…` : rpcError(sub1.json));
    const SUB = typeof sub1.json === "string" ? sub1.json : "";

    const subResub = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/2" }, T.m1);
    record("E2 pending resubmission overwrites proof (upsert, one row)",
      subResub.status === 200,
      `status ${subResub.status}`);

    const subNoProof = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK }, T.m2);
    record("E3 proof required enforced", subNoProof.status === 400 &&
      /proof url is required/i.test(rpcError(subNoProof.json)),
      `${subNoProof.status} ${rpcError(subNoProof.json).slice(0, 50)}`);

    // ══ F. verification authority + ledger ═══════════════════════════════
    const subSelf = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.m1);
    record("F1 member cannot self-verify via RPC",
      subSelf.status === 400 && /admin authority/i.test(rpcError(subSelf.json)),
      `${subSelf.status} ${rpcError(subSelf.json).slice(0, 50)}`);

    const dirVerify = await rest("PATCH", `/rest/v1/social_task_submissions?id=eq.${SUB}`,
      { status: "verified" }, T.m1);
    record("F2 direct member UPDATE cannot flip status",
      dirVerify.status >= 400 || arr(dirVerify.json).length === 0,
      `${dirVerify.status} ${arr(dirVerify.json).length} row(s)`);

    const verify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.admin);
    record("F3 admin verifies; award created",
      verify.status === 200 || verify.status === 204, `status ${verify.status}`);

    const award = await rest("GET", `/rest/v1/social_point_awards?submission_id=eq.${SUB}`, undefined, T.m1);
    const awardRow = arr(award.json)[0];
    record("F4 award exists: 25 points, server-resolved actor",
      awardRow && awardRow.points === 25 && awardRow.awarded_by === adminA && awardRow.recipient_id === member1,
      awardRow ? `points=${awardRow.points}` : "no award row");

    const prof = await rest("GET", `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("F5 profiles.points projection updated to 25",
      arr(prof.json).length === 1 && arr(prof.json)[0].points === 25,
      arr(prof.json).length ? `points=${arr(prof.json)[0].points}` : "no profile row");

    const reVerify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.admin);
    record("F6 double verification refused",
      reVerify.status === 400 && /already been verified/i.test(rpcError(reVerify.json)),
      `${reVerify.status} ${rpcError(reVerify.json).slice(0, 50)}`);

    const aud = await sql.query(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE resource_id = $1 AND action = 'social_submission:verify'`, [SUB]);
    record("F7 verification audited with server-resolved actor",
      aud.rows.length === 1 && aud.rows[0].actor_id === adminA,
      `${aud.rows.length} audit row(s)`);

    // ══ G. leaderboard projection ════════════════════════════════════════
    const lb = await rest("GET", "/rest/v1/social_leaderboard?select=*", undefined, T.m1);
    const rows = arr(lb.json);
    const mine = rows.find((r) => r.id === member1);
    record("G1 leaderboard shows verified member with 25 points",
      !!mine && mine.points === 25, mine ? `points=${mine.points}` : "member missing");
    record("G2 reduced projection (no email/polling_unit)",
      rows.every((r) => !("email" in r) && !("polling_unit_id" in r)),
      `${rows.length} rows checked`);
    record("G3 cross-tenant isolation (no tenant-B rows for tenant-A member)",
      rows.every((r) => r.tenant_id === tenantA), "all rows same tenant");
    const lbAnon = await rest("GET", "/rest/v1/social_leaderboard?select=*");
    record("G4 anon leaderboard read is RLS-fail-closed (0 rows)",
      lbAnon.status === 200 && arr(lbAnon.json).length === 0, `${arr(lbAnon.json).length} rows`);
    const lbMut = await rest("PATCH", `/rest/v1/social_leaderboard?id=eq.${member1}`, { points: 99999 }, T.m1);
    record("G5 leaderboard projection not writable", lbMut.status >= 400,
      `${lbMut.status}`);

    // ══ H. direct PostgREST abuse ════════════════════════════════════════
    const anonTasks = await rest("GET", "/rest/v1/social_tasks");
    record("H1 anon tasks read denied (no grant)",
      anonTasks.status === 401 || anonTasks.status === 403 || anonTasks.status === 404,
      `${anonTasks.status}`);
    const anonTaskIns = await rest("POST", "/rest/v1/social_tasks",
      { tenant_id: tenantA, title: "anon", points: 5000 });
    record("H2 anon direct task INSERT denied", anonTaskIns.status >= 400, `${anonTaskIns.status}`);
    const m1Ins = await rest("POST", "/rest/v1/social_tasks",
      { tenant_id: tenantA, title: "member task", points: 5000 }, T.m1);
    record("H3 member direct task INSERT RLS-denied",
      m1Ins.status >= 400 || arr(m1Ins.json).length === 0, `${m1Ins.status} ${arr(m1Ins.json).length} row(s)`);
    const awardIns = await rest("POST", "/rest/v1/social_point_awards",
      { tenant_id: tenantA, recipient_id: member1, submission_id: SUB, points: 99999 }, T.m1);
    record("H4 member direct award INSERT denied (no grant / FK)",
      awardIns.status >= 400 || arr(awardIns.json).length === 0, `${awardIns.status}`);
    const crossB = await rest("GET", `/rest/v1/social_tasks?id=eq.${TASK}`, undefined, T.b);
    record("H5 cross-tenant task read silent (module-off tenant B)",
      crossB.status === 200 && arr(crossB.json).length === 0, `${arr(crossB.json).length} rows`);
    const profMut = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${member1}`,
      { points: 100000 }, T.m1);
    record("H6 member cannot mutate own points via profiles view",
      profMut.status >= 400 || arr(profMut.json).length === 0, `${profMut.status}`);
    const afterMut = await sql.query(`SELECT points FROM politicore.profiles WHERE id = $1`, [member1]);
    record("H7 points unchanged after mutation attempts", Number(afterMut.rows[0].points) === 25,
      `points=${afterMut.rows[0].points}`);

    // ══ I. grants / privilege checks (0028 ratified matrix) ══════════════
    const grants = await sql.query<{ tn: string; g: string; privs: string }>(
      `SELECT table_name tn, grantee g, string_agg(privilege_type, ',' ORDER BY privilege_type) privs
       FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name LIKE 'social%' AND grantee IN ('anon','authenticated')
       GROUP BY 1,2 ORDER BY 1,2`);
    const g = (tn: string, gr: string) =>
      grants.rows.find((r) => r.tn === tn && r.g === gr)?.privs ?? "";
    record("I1 social_tasks grants: authenticated SELECT only",
      g("social_tasks", "authenticated") === "SELECT" && g("social_tasks", "anon") === "",
      `auth=${g("social_tasks", "authenticated") || "∅"} anon=${g("social_tasks", "anon") || "∅"}`);
    record("I2 submissions grants: authenticated SELECT+INSERT+UPDATE",
      g("social_task_submissions", "authenticated") === "INSERT,SELECT,UPDATE",
      g("social_task_submissions", "authenticated"));
    record("I3 awards grants: authenticated SELECT only (no INSERT/UPDATE/DELETE)",
      g("social_point_awards", "authenticated") === "SELECT", g("social_point_awards", "authenticated"));
    record("I4 leaderboard grants: anon+authenticated SELECT only",
      g("social_leaderboard", "anon") === "SELECT" && g("social_leaderboard", "authenticated") === "SELECT",
      `anon=${g("social_leaderboard", "anon")}`);
    const anonAwards = await rest("GET", "/rest/v1/social_point_awards");
    record("I5 anon award read denied (no grant)",
      anonAwards.status === 401 || anonAwards.status === 403 || anonAwards.status === 404,
      `${anonAwards.status}`);

    // ══ J. legacy / dependency checks ════════════════════════════════════
    const legacy = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'politicore' AND p.proname ILIKE 'campaign%' AND
             (p.proname ILIKE '%task%' OR p.proname ILIKE '%point%' OR p.proname ILIKE '%leaderboard%')`);
    record("J1 no Campaign-owned task/points/leaderboard RPCs", legacy.rows[0].n === "0",
      `${legacy.rows[0].n} matches`);
    const legacyTbl = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore' AND c.relname ILIKE 'campaign%' AND
             (c.relname ILIKE '%task%' OR c.relname ILIKE '%point%' OR c.relname ILIKE '%leaderboard%')`);
    record("J2 no Campaign-owned task/points/leaderboard tables", legacyTbl.rows[0].n === "0",
      `${legacyTbl.rows[0].n} matches`);
    const coordTbl = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore' AND c.relname = 'social_coordination'`);
    record("J3 no second coordination-style Social table", coordTbl.rows[0].n === "0",
      `${coordTbl.rows[0].n} matches`);

    // ══ K. pristine cleanup ══════════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
    try {
      const residual = await sql.query<{ tasks: string; subs: string; awards: string; tenants: string; users: string }>(
        `SELECT
           (SELECT count(*)::text FROM politicore.social_tasks WHERE tenant_id::text = ANY($1)) tasks,
           (SELECT count(*)::text FROM politicore.social_task_submissions WHERE tenant_id::text = ANY($1)) subs,
           (SELECT count(*)::text FROM politicore.social_point_awards WHERE tenant_id::text = ANY($1)) awards,
           (SELECT count(*)::text FROM politicore.tenants WHERE id::text = ANY($1)) tenants,
           (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@pcorb.example.com' AND email LIKE '%${SUFFIX}%') users`,
        [tenantIds]);
      const r = residual.rows[0];
      record("K1 pristine hosted state restored",
        r.tasks === "0" && r.subs === "0" && r.awards === "0" && r.tenants === "0" && r.users === "0",
        `tasks=${r.tasks} subs=${r.subs} awards=${r.awards} tenants=${r.tenants} users=${r.users}`);
    } catch (e) {
      record("K1 pristine hosted state restored", false, (e as Error).message.slice(0, 100));
    }
    await sql.end();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n══ SOCIAL FORCE PHASE A HOSTED SMOKE: ${results.length - fails.length}/${results.length} ══`);
  if (fails.length) {
    console.log("FAILED:");
    for (const f of fails) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
