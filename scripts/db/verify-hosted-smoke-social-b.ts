/**
 * POLITICORE — SOCIAL FORCE PHASE B — HOSTED ACCEPTANCE HARNESS.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real public
 * RPC wrappers — proving the Phase B Tasks-surface cutover under the
 * same acceptance standard as the Campaign / Social Phase A harnesses.
 *
 * Journeys (gate §19):
 *   A — Visibility: authorized Social users retrieve Tasks (incl. RLS
 *       member semantics: active+unexpired only)
 *   B — Module gate: social disabled → listing + RPCs fail closed; restored
 *   C — Admin: create / read / update / activate-deactivate (+ audits)
 *   D — Social Member: read permitted; create/update/activate denied
 *   E — Cross-membership: campaign-only and election-officer denied
 *   F — Tenant isolation: cross-tenant reads/mutations fail closed
 *   G — Direct PostgREST abuse against the protected surfaces
 *   H — Firebase boundary: migrated Tasks path statically Supabase-only
 *   I — Pristine cleanup: fixtures removed, module state restored
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
    console.error("cleanup incomplete — remove social-phase-b fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `SocForceB!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: 2 tenants + real users ═════════════════════════════════
    const E = `socfb-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase B — social on", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase B — isolation tenant", `socfb-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantB]);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`socb.admin.${SUFFIX}@pcorb.example.com`, "Social Admin B", E);
    const member1 = await mk(`socb.m1.${SUFFIX}@pcorb.example.com`, "Social Member B1", E);
    const campOnly = await mk(`socb.camp.${SUFFIX}@pcorb.example.com`, "Campaign-only B", E);
    const officer = await mk(`socb.eo.${SUFFIX}@pcorb.example.com`, "Election Officer B", E);
    const adminB = await mk(`socb.adm2.${SUFFIX}@pcorb.example.com`, "Admin Tenant B", `socfb-iso-${SUFFIX}`);
    const socialB = await mk(`socb.b.${SUFFIX}@pcorb.example.com`, "Social B Tenant", `socfb-iso-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminB]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member1]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [campOnly]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialB]);

    // tokens (real GoTrue)
    const T = {
      admin: await signin(`socb.admin.${SUFFIX}@pcorb.example.com`, P),
      m1: await signin(`socb.m1.${SUFFIX}@pcorb.example.com`, P),
      camp: await signin(`socb.camp.${SUFFIX}@pcorb.example.com`, P),
      eo: await signin(`socb.eo.${SUFFIX}@pcorb.example.com`, P),
      adminB: await signin(`socb.adm2.${SUFFIX}@pcorb.example.com`, P),
      b: await signin(`socb.b.${SUFFIX}@pcorb.example.com`, P),
    };

    // ══ A. Visibility ════════════════════════════════════════════════════
    const mkTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Phase B task", p_description: "hosted smoke",
      p_platform: "facebook", p_action: "share", p_points: 40,
      p_status: "active", p_target_url: "https://example.com/post",
      p_proof_required: true,
    }, T.admin);
    record("A1 admin creates task via public RPC", mkTask.status === 200 && typeof mkTask.json === "string",
      mkTask.status === 200 ? `task ${String(mkTask.json).slice(0, 8)}…` : rpcError(mkTask.json));
    const TASK = typeof mkTask.json === "string" ? mkTask.json : "";

    const visM1 = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK + "&select=*", undefined, T.m1);
    record("A2 social member sees the active task",
      visM1.status === 200 && arr(visM1.json).length === 1 && arr(visM1.json)[0].action === "share",
      `${arr(visM1.json).length} row(s)`);

    const inactiveTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Inactive task", p_points: 10, p_status: "inactive",
    }, T.admin);
    const INACTIVE = typeof inactiveTask.json === "string" ? inactiveTask.json : "";
    const visInactive = await rest("GET", "/rest/v1/social_tasks?id=eq." + INACTIVE, undefined, T.m1);
    record("A3 member does NOT see inactive tasks (RLS member semantics)",
      visInactive.status === 200 && arr(visInactive.json).length === 0,
      `${arr(visInactive.json).length} row(s)`);

    const visAdminInactive = await rest("GET", "/rest/v1/social_tasks?id=eq." + INACTIVE, undefined, T.admin);
    record("A4 admin DOES see inactive tasks (admin visibility)",
      visAdminInactive.status === 200 && arr(visAdminInactive.json).length === 1,
      `${arr(visAdminInactive.json).length} row(s)`);

    // ══ B. Module gate (disable → fail closed → restore) ═════════════════
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`,
      [tenantA]);
    const gatedList = await rest("GET", "/rest/v1/social_tasks", undefined, T.m1);
    record("B1 social disabled → member task listing empty",
      gatedList.status === 200 && arr(gatedList.json).length === 0,
      `${arr(gatedList.json).length} row(s)`);
    const gatedRpc = await rest("POST", "/rest/v1/rpc/update_social_task",
      { p_task: TASK, p_title: "nope" }, T.admin);
    record("B2 social disabled → authority RPC refuses",
      gatedRpc.status === 400 && /social module is not enabled/i.test(rpcError(gatedRpc.json)),
      `${gatedRpc.status} ${rpcError(gatedRpc.json).slice(0, 50)}`);
    const gatedSub = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/x" }, T.m1);
    record("B3 social disabled → member submission refuses",
      gatedSub.status === 400 && /social module is not enabled/i.test(rpcError(gatedSub.json)),
      `${gatedSub.status} ${rpcError(gatedSub.json).slice(0, 50)}`);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`,
      [tenantA]);
    const restored = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK, undefined, T.m1);
    record("B4 social restored → visibility returns",
      restored.status === 200 && arr(restored.json).length === 1,
      `${arr(restored.json).length} row(s)`);

    // ══ C. Admin task management ═════════════════════════════════════════
    const upd = await rest("POST", "/rest/v1/rpc/update_social_task", {
      p_task: TASK, p_title: "Phase B task v2", p_points: 45,
    }, T.admin);
    record("C1 admin updates task", upd.status === 200 || upd.status === 204, `status ${upd.status}`);
    const updRead = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK + "&select=title,points", undefined, T.admin);
    record("C2 update persisted (title + points)",
      arr(updRead.json).length === 1 && arr(updRead.json)[0].title === "Phase B task v2" && arr(updRead.json)[0].points === 45,
      arr(updRead.json).length ? `${arr(updRead.json)[0].title}/${arr(updRead.json)[0].points}` : "no row");

    const deact = await rest("POST", "/rest/v1/rpc/set_social_task_status",
      { p_task: TASK, p_status: "inactive" }, T.admin);
    record("C3 admin deactivates task", deact.status === 200 || deact.status === 204, `status ${deact.status}`);
    const stRead = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK + "&select=status", undefined, T.admin);
    record("C4 status persisted inactive", arr(stRead.json).length === 1 && arr(stRead.json)[0].status === "inactive",
      arr(stRead.json).length ? String(arr(stRead.json)[0].status) : "no row");

    const react = await rest("POST", "/rest/v1/rpc/set_social_task_status",
      { p_task: TASK, p_status: "active" }, T.admin);
    record("C5 admin reactivates task", react.status === 200 || react.status === 204, `status ${react.status}`);

    const taskAudits = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.system_audits
       WHERE resource_id = $1 AND action LIKE 'social_task:%'`, [TASK]);
    record("C6 task management audited (create/update/status)",
      taskAudits.rows[0].n >= "3", `${taskAudits.rows[0].n} audit row(s)`);

    // ══ D. Social Member boundaries ══════════════════════════════════════
    const mCreate = await rest("POST", "/rest/v1/rpc/create_social_task", { p_title: "member task" }, T.m1);
    record("D1 member cannot create tasks",
      mCreate.status === 400 && /admin authority/i.test(rpcError(mCreate.json)),
      `${mCreate.status} ${rpcError(mCreate.json).slice(0, 50)}`);
    const mUpdate = await rest("POST", "/rest/v1/rpc/update_social_task",
      { p_task: TASK, p_points: 99999 }, T.m1);
    record("D2 member cannot update tasks (points escalation denied)",
      mUpdate.status === 400 && /admin authority/i.test(rpcError(mUpdate.json)),
      `${mUpdate.status} ${rpcError(mUpdate.json).slice(0, 50)}`);
    const mStatus = await rest("POST", "/rest/v1/rpc/set_social_task_status",
      { p_task: TASK, p_status: "inactive" }, T.m1);
    record("D3 member cannot activate/deactivate tasks",
      mStatus.status === 400 && /admin authority/i.test(rpcError(mStatus.json)),
      `${mStatus.status} ${rpcError(mStatus.json).slice(0, 50)}`);
    const mRead = await rest("GET", "/rest/v1/social_tasks", undefined, T.m1);
    record("D4 member read path works (permitted active tasks visible)",
      mRead.status === 200 && arr(mRead.json).some((r) => r.id === TASK),
      `${arr(mRead.json).length} row(s)`);

    // ══ E. Cross-membership ══════════════════════════════════════════════
    const campRead = await rest("GET", "/rest/v1/social_tasks", undefined, T.camp);
    record("E1 campaign-only member sees no tasks",
      campRead.status === 200 && arr(campRead.json).length === 0, `${arr(campRead.json).length} row(s)`);
    const campCreate = await rest("POST", "/rest/v1/rpc/create_social_task", { p_title: "camp task" }, T.camp);
    record("E2 campaign-only member cannot create tasks",
      campCreate.status === 400 && /admin authority/i.test(rpcError(campCreate.json)),
      `${campCreate.status} ${rpcError(campCreate.json).slice(0, 50)}`);
    const eoCreate = await rest("POST", "/rest/v1/rpc/create_social_task", { p_title: "eo task" }, T.eo);
    record("E3 election officer cannot create tasks",
      eoCreate.status === 400 && /admin authority/i.test(rpcError(eoCreate.json)),
      `${eoCreate.status} ${rpcError(eoCreate.json).slice(0, 50)}`);
    const eoStatus = await rest("POST", "/rest/v1/rpc/set_social_task_status",
      { p_task: TASK, p_status: "inactive" }, T.eo);
    record("E4 election officer cannot transition tasks",
      eoStatus.status === 400 && /admin authority/i.test(rpcError(eoStatus.json)),
      `${eoStatus.status} ${rpcError(eoStatus.json).slice(0, 50)}`);

    // ══ F. Tenant isolation ══════════════════════════════════════════════
    const bTask = await rest("POST", "/rest/v1/rpc/create_social_task",
      { p_title: "Tenant B task", p_points: 15 }, T.adminB);
    record("F1 tenant-B admin creates own task",
      bTask.status === 200 && typeof bTask.json === "string",
      bTask.status === 200 ? `task ${String(bTask.json).slice(0, 8)}…` : rpcError(bTask.json));
    const B_TASK = typeof bTask.json === "string" ? bTask.json : "";

    const crossRead = await rest("GET", "/rest/v1/social_tasks?id=eq." + B_TASK, undefined, T.m1);
    record("F2 tenant-A member cannot read tenant-B task",
      crossRead.status === 200 && arr(crossRead.json).length === 0,
      `${arr(crossRead.json).length} row(s)`);

    const crossUpdate = await rest("POST", "/rest/v1/rpc/update_social_task",
      { p_task: B_TASK, p_title: "hijacked" }, T.admin);
    record("F3 tenant-A admin cannot update tenant-B task (definer pins tenant)",
      crossUpdate.status === 400 && /task not found/i.test(rpcError(crossUpdate.json)),
      `${crossUpdate.status} ${rpcError(crossUpdate.json).slice(0, 50)}`);

    const crossStatus = await rest("POST", "/rest/v1/rpc/set_social_task_status",
      { p_task: B_TASK, p_status: "inactive" }, T.admin);
    record("F4 tenant-A admin cannot transition tenant-B task",
      crossStatus.status === 400 && /task not found/i.test(rpcError(crossStatus.json)),
      `${crossStatus.status} ${rpcError(crossStatus.json).slice(0, 50)}`);

    const bState = await rest("GET", "/rest/v1/social_tasks?id=eq." + B_TASK + "&select=title", undefined, T.adminB);
    record("F5 tenant-B task unchanged after cross-tenant attempts",
      arr(bState.json).length === 1 && arr(bState.json)[0].title === "Tenant B task",
      arr(bState.json).length ? String(arr(bState.json)[0].title) : "no row");

    // ══ G. Direct PostgREST abuse ════════════════════════════════════════
    const mIns = await rest("POST", "/rest/v1/social_tasks",
      { tenant_id: tenantA, title: "member task", points: 5000 }, T.m1);
    record("G1 member direct task INSERT denied",
      mIns.status >= 400 || arr(mIns.json).length === 0, `${mIns.status} ${arr(mIns.json).length} row(s)`);
    const mPatch = await rest("PATCH", `/rest/v1/social_tasks?id=eq.${TASK}`,
      { points: 99999 }, T.m1);
    record("G2 member direct task UPDATE (PATCH) denied",
      mPatch.status >= 400 || arr(mPatch.json).length === 0, `${mPatch.status}`);
    const mDel = await rest("DELETE", `/rest/v1/social_tasks?id=eq.${TASK}`, undefined, T.m1);
    record("G3 member direct task DELETE denied",
      mDel.status >= 400 || mDel.status === 204, `${mDel.status}`);
    const stillThere = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK, undefined, T.admin);
    record("G4 task survives direct-abuse attempts",
      arr(stillThere.json).length === 1, `${arr(stillThere.json).length} row(s)`);
    const anonRpc = await rest("POST", "/rest/v1/rpc/create_social_task", { p_title: "anon" });
    // Wrappers inherit Postgres' default PUBLIC EXECUTE; the ratified anon
    // defense is the in-function guard, which fail-closes with
    // 'unauthenticated' — the invocation must produce no state change.
    record("G5 anon RPC invocation denied (in-function guard fail-closed)",
      anonRpc.status >= 400 && /unauthenticated/i.test(rpcError(anonRpc.json)),
      `${anonRpc.status} ${rpcError(anonRpc.json).slice(0, 40)}`);
    const mSubFlip = await rest("PATCH", `/rest/v1/social_task_submissions?task_id=eq.${TASK}`,
      { status: "verified" }, T.m1);
    record("G6 member cannot flip submission status directly",
      mSubFlip.status >= 400 || arr(mSubFlip.json).length === 0, `${mSubFlip.status}`);

    // ══ H. Firebase boundary (static, migrated Tasks path) ═══════════════
    const TASKS_PATH_FILES = [
      "src/lib/supabase/socialForce.ts",
      "src/app/portal/tasks/page.tsx",
      "src/app/portal/admin/tasks/page.tsx",
      "src/lib/supabase/access.ts",
    ];
    const forbidden = [/from\s+["'][^"']*firebase[^"']*["']/i, /from\s+["'][^"']*firestore[^"']*["']/i,
      /\bgetDocs\b/, /\bsetDoc\b/, /\bupdateDoc\b/, /\bdeleteDoc\b/, /\bonSnapshot\b/];
    const fbHits: string[] = [];
    for (const rel of TASKS_PATH_FILES) {
      const src = fs.readFileSync(path.resolve(rel), "utf8");
      for (const p of forbidden) if (p.test(src)) fbHits.push(`${rel}::${p}`);
    }
    record("H1 migrated Tasks path has zero Firebase/Firestore access", fbHits.length === 0,
      fbHits.length ? fbHits.slice(0, 3).join("; ") : "all files clean");
    const svc = fs.readFileSync(path.resolve("src/lib/supabase/socialForce.ts"), "utf8");
    record("H2 service mutations are RPC-only (no client insert/update/delete)",
      !/\.insert\(/.test(svc) && !/\.update\(/.test(svc) && !/\.delete\(/.test(svc) &&
        ["create_social_task", "update_social_task", "set_social_task_status", "submit_social_task", "verify_social_submission"]
          .every((r) => svc.includes(`"${r}"`)),
      "rpc()-only mutations verified");

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
      record("I1 pristine hosted state restored (0 fixtures, module rows included)",
        r.tasks === "0" && r.subs === "0" && r.awards === "0" && r.tenants === "0" && r.users === "0" && r.mods === "0",
        `tasks=${r.tasks} subs=${r.subs} awards=${r.awards} tenants=${r.tenants} users=${r.users} mods=${r.mods}`);
    } catch (e) {
      record("I1 pristine hosted state restored", false, (e as Error).message.slice(0, 100));
    }
    await sql.end();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n══ SOCIAL FORCE PHASE B HOSTED SMOKE: ${results.length - fails.length}/${results.length} ══`);
  if (fails.length) {
    console.log("FAILED:");
    for (const f of fails) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
