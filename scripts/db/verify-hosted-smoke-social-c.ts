/**
 * POLITICORE — SOCIAL FORCE PHASE C — HOSTED ACCEPTANCE HARNESS.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real public
 * RPC wrappers — proving the Phase C submission + verification experience
 * under the same acceptance standard as the Campaign / Social A+B harnesses.
 *
 * Journeys (gate §26):
 *   A — Member submission (view → submit → pending visible)
 *   B — Resubmission (pending proof update; no duplicate independent rows)
 *   C — Verification (admin sees submission, verifies, status flips)
 *   D — Award (exactly one, correct points/recipient/verifier)
 *   E — Notification (submitter receives the verification notice)
 *   F — Audit (server-resolved actor + tenant)
 *   G — Immutability (update fails, second verification fails, no second award)
 *   H — Authorization (member/campaign-only/officer/cross-tenant/module-off denied)
 *   I — Direct PostgREST abuse
 *   J — Firebase boundary (static scan of the migrated submission path)
 *   K — Pristine cleanup (all fixtures removed, state restored)
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
    console.error("cleanup incomplete — remove social-phase-c fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `SocForceC!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: 2 tenants + real users ═════════════════════════════════
    const E = `socfc-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase C — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Social Phase C — isolation", `socfc-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'social', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantB]);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`socc.admin.${SUFFIX}@pcorb.example.com`, "Social Admin C", E);
    const member1 = await mk(`socc.m1.${SUFFIX}@pcorb.example.com`, "Social Member C1", E);
    const campOnly = await mk(`socc.camp.${SUFFIX}@pcorb.example.com`, "Campaign-only C", E);
    const officer = await mk(`socc.eo.${SUFFIX}@pcorb.example.com`, "Officer C", E);
    const adminB = await mk(`socc.adm2.${SUFFIX}@pcorb.example.com`, "Admin C Tenant B", `socfc-iso-${SUFFIX}`);
    const socialB = await mk(`socc.b.${SUFFIX}@pcorb.example.com`, "Social C Tenant B", `socfc-iso-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminB]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [member1]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [campOnly]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialB]);

    const T = {
      admin: await signin(`socc.admin.${SUFFIX}@pcorb.example.com`, P),
      m1: await signin(`socc.m1.${SUFFIX}@pcorb.example.com`, P),
      camp: await signin(`socc.camp.${SUFFIX}@pcorb.example.com`, P),
      eo: await signin(`socc.eo.${SUFFIX}@pcorb.example.com`, P),
      adminB: await signin(`socc.adm2.${SUFFIX}@pcorb.example.com`, P),
      b: await signin(`socc.b.${SUFFIX}@pcorb.example.com`, P),
    };

    // Task for the full journey (proof required — the dominant product shape).
    const mkTask = await rest("POST", "/rest/v1/rpc/create_social_task", {
      p_title: "Phase C journey task", p_description: "hosted smoke",
      p_platform: "facebook", p_action: "share", p_points: 33,
      p_status: "active", p_target_url: "https://example.com/post",
      p_proof_required: true,
    }, T.admin);
    record("A0 admin creates proof-required task",
      mkTask.status === 200 && typeof mkTask.json === "string",
      mkTask.status === 200 ? `task ${String(mkTask.json).slice(0, 8)}…` : rpcError(mkTask.json));
    const TASK = typeof mkTask.json === "string" ? mkTask.json : "";

    // ══ A. Member submission ═════════════════════════════════════════════
    const visM1 = await rest("GET", "/rest/v1/social_tasks?id=eq." + TASK + "&select=*", undefined, T.m1);
    record("A1 authorized member sees the task",
      visM1.status === 200 && arr(visM1.json).length === 1, `${arr(visM1.json).length} row(s)`);

    const subNoProof = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.m1);
    record("A2 proof-required submission without proof refused",
      subNoProof.status === 400 && /proof url is required/i.test(rpcError(subNoProof.json)),
      `${subNoProof.status} ${rpcError(subNoProof.json).slice(0, 50)}`);

    const sub1 = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/v1" }, T.m1);
    record("A3 member submits with proof",
      sub1.status === 200 && typeof sub1.json === "string",
      sub1.status === 200 ? `submission ${String(sub1.json).slice(0, 8)}…` : rpcError(sub1.json));
    const SUB = typeof sub1.json === "string" ? sub1.json : "";

    const pendRead = await rest("GET",
      `/rest/v1/social_task_submissions?id=eq.${SUB}&select=status,proof_url`, undefined, T.m1);
    record("A4 pending state visible to the member",
      pendRead.status === 200 && arr(pendRead.json).length === 1 &&
        arr(pendRead.json)[0].status === "pending" && arr(pendRead.json)[0].proof_url === "https://proof.example/v1",
      arr(pendRead.json).length ? String(arr(pendRead.json)[0].status) : "no row");

    // ══ B. Resubmission ══════════════════════════════════════════════════
    const sub2 = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/v2" }, T.m1);
    record("B1 pending submission proof updated (upsert contract)",
      sub2.status === 200, `status ${sub2.status}`);
    const afterResub = await rest("GET",
      `/rest/v1/social_task_submissions?task_id=eq.${TASK}&select=id,proof_url`, undefined, T.m1);
    record("B2 still exactly one row for member×task (UNIQUE upheld)",
      afterResub.status === 200 && arr(afterResub.json).length === 1 &&
        arr(afterResub.json)[0].proof_url === "https://proof.example/v2",
      `${arr(afterResub.json).length} row(s)`);

    // ══ C. Verification ══════════════════════════════════════════════════
    const adminSee = await rest("GET",
      `/rest/v1/social_task_submissions?task_id=eq.${TASK}&select=*,submitter_id`, undefined, T.admin);
    record("C1 admin sees the tenant submission",
      adminSee.status === 200 && arr(adminSee.json).length === 1, `${arr(adminSee.json).length} row(s)`);

    const verify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.admin);
    record("C2 admin verifies via the authority RPC",
      verify.status === 200 || verify.status === 204, `status ${verify.status}`);

    const verRead = await rest("GET",
      `/rest/v1/social_task_submissions?id=eq.${SUB}&select=status,verified_at`, undefined, T.admin);
    record("C3 submission becomes verified (server stamped verified_at)",
      arr(verRead.json).length === 1 && arr(verRead.json)[0].status === "verified" &&
        !!arr(verRead.json)[0].verified_at,
      arr(verRead.json).length ? String(arr(verRead.json)[0].status) : "no row");

    // ══ D. Award ═════════════════════════════════════════════════════════
    const award = await rest("GET",
      `/rest/v1/social_point_awards?submission_id=eq.${SUB}&select=*`, undefined, T.m1);
    const awardRow = arr(award.json)[0];
    record("D1 exactly one award, 33 points, correct recipient + verifier",
      arr(award.json).length === 1 && awardRow && awardRow.points === 33 &&
        awardRow.recipient_id === member1 && awardRow.awarded_by === adminA,
      arr(award.json).length === 1 ? `points=${awardRow.points}` : `${arr(award.json).length} award(s)`);

    const prof = await rest("GET",
      `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("D2 profiles.points projection = 33 (authoritative path only)",
      arr(prof.json).length === 1 && arr(prof.json)[0].points === 33,
      arr(prof.json).length ? `points=${arr(prof.json)[0].points}` : "no row");

    // ══ E. Notification ══════════════════════════════════════════════════
    const note = await rest("GET",
      `/rest/v1/notifications?user_id=eq.${member1}&select=type,title,link_url&order=created_at.desc&limit=1`,
      undefined, T.m1);
    const noteRow = arr(note.json)[0];
    record("E1 submitter received the verification notification",
      arr(note.json).length === 1 && noteRow.type === "task" && noteRow.title === "Task verified" &&
        noteRow.link_url === "/portal/tasks",
      arr(note.json).length ? `${noteRow.title}` : "no notification");

    // ══ F. Audit ═════════════════════════════════════════════════════════
    const aud = await sql.query(
      `SELECT action, actor_id, tenant_id FROM politicore.system_audits
       WHERE resource_id = $1 AND action = 'social_submission:verify'`, [SUB]);
    record("F1 verification audited with server-resolved actor + tenant",
      aud.rows.length === 1 && aud.rows[0].actor_id === adminA && aud.rows[0].tenant_id === tenantA,
      `${aud.rows.length} audit row(s)`);

    // ══ G. Immutability ══════════════════════════════════════════════════
    const patch = await rest("PATCH", `/rest/v1/social_task_submissions?id=eq.${SUB}`,
      { proof_url: "https://evil.example/tamper" }, T.m1);
    record("G1 verified submission UPDATE refused",
      patch.status >= 400 || arr(patch.json).length === 0, `${patch.status}`);
    const reVerify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.admin);
    record("G2 second verification refused",
      reVerify.status === 400 && /already been verified/i.test(rpcError(reVerify.json)),
      `${reVerify.status} ${rpcError(reVerify.json).slice(0, 45)}`);
    const resubLate = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/late" }, T.m1);
    record("G3 resubmission against verified refused",
      resubLate.status === 400 && /already been verified/i.test(rpcError(resubLate.json)),
      `${resubLate.status}`);
    const awardCount = await rest("GET",
      `/rest/v1/social_point_awards?submission_id=eq.${SUB}&select=id`, undefined, T.m1);
    record("G4 no second award possible",
      arr(awardCount.json).length === 1, `${arr(awardCount.json).length} award(s)`);
    const proofNow = await rest("GET",
      `/rest/v1/social_task_submissions?id=eq.${SUB}&select=proof_url`, undefined, T.m1);
    record("G5 proof unchanged after tamper attempt",
      arr(proofNow.json).length === 1 && arr(proofNow.json)[0].proof_url === "https://proof.example/v2",
      arr(proofNow.json).length ? String(arr(proofNow.json)[0].proof_url).slice(0, 40) : "no row");

    // ══ H. Authorization ═════════════════════════════════════════════════
    const mVerify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.m1);
    record("H1 social member cannot verify",
      mVerify.status === 400 && /admin authority/i.test(rpcError(mVerify.json)),
      `${mVerify.status} ${rpcError(mVerify.json).slice(0, 45)}`);
    const campRead = await rest("GET", "/rest/v1/social_task_submissions", undefined, T.camp);
    record("H2 campaign-only member sees no submissions",
      campRead.status === 200 && arr(campRead.json).length === 0, `${arr(campRead.json).length} row(s)`);
    const campVerify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.camp);
    record("H3 campaign-only member cannot verify",
      campVerify.status === 400 && /admin authority/i.test(rpcError(campVerify.json)),
      `${campVerify.status}`);
    const eoVerify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.eo);
    record("H4 election officer cannot verify",
      eoVerify.status === 400 && /admin authority/i.test(rpcError(eoVerify.json)),
      `${eoVerify.status}`);

    // cross-tenant: tenant-B member cannot submit to tenant-A task or read tenant-A subs
    const xSubmit = await rest("POST", "/rest/v1/rpc/submit_social_task", { p_task: TASK }, T.b);
    record("H5 cross-tenant submission refused (task not found)",
      xSubmit.status === 400 && /task not found/i.test(rpcError(xSubmit.json)),
      `${xSubmit.status} ${rpcError(xSubmit.json).slice(0, 40)}`);
    const xRead = await rest("GET", "/rest/v1/social_task_submissions", undefined, T.b);
    record("H6 cross-tenant submission read silent",
      xRead.status === 200 && arr(xRead.json).length === 0, `${arr(xRead.json).length} row(s)`);
    const xVerify = await rest("POST", "/rest/v1/rpc/verify_social_submission",
      { p_submission: SUB }, T.adminB);
    record("H7 cross-tenant verification refused (submission not found)",
      xVerify.status === 400 && /submission not found/i.test(rpcError(xVerify.json)),
      `${xVerify.status}`);

    // module-disabled fail-closed round trip
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);
    const gatedSub = await rest("POST", "/rest/v1/rpc/submit_social_task",
      { p_task: TASK, p_proof_url: "https://proof.example/x" }, T.m1);
    record("H8 module disabled → submission refused",
      gatedSub.status === 400 && /social module is not enabled/i.test(rpcError(gatedSub.json)),
      `${gatedSub.status}`);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'social'`, [tenantA]);

    // ══ I. Direct PostgREST abuse ════════════════════════════════════════
    const iIns = await rest("POST", "/rest/v1/social_task_submissions",
      { tenant_id: tenantA, task_id: TASK, submitter_id: member1 }, T.camp);
    record("I1 campaign-only direct submission INSERT denied",
      iIns.status >= 400 || arr(iIns.json).length === 0, `${iIns.status}`);
    const iSpoof = await rest("POST", "/rest/v1/social_task_submissions",
      { tenant_id: tenantA, task_id: TASK, submitter_id: adminA }, T.m1);
    record("I2 member cannot spoof another submitter directly",
      iSpoof.status >= 400 || arr(iSpoof.json).length === 0, `${iSpoof.status}`);
    const iAward = await rest("POST", "/rest/v1/social_point_awards",
      { tenant_id: tenantA, recipient_id: member1, submission_id: SUB, points: 99999 }, T.m1);
    record("I3 direct award INSERT denied",
      iAward.status >= 400 || arr(iAward.json).length === 0, `${iAward.status}`);
    const iPoints = await rest("PATCH", `/rest/v1/politicore_profiles?id=eq.${member1}`,
      { points: 100000 }, T.m1);
    record("I4 member cannot mutate own points",
      iPoints.status >= 400 || arr(iPoints.json).length === 0, `${iPoints.status}`);
    const pointsNow = await rest("GET",
      `/rest/v1/politicore_profiles?id=eq.${member1}&select=points`, undefined, T.m1);
    record("I5 points unchanged after all abuse",
      arr(pointsNow.json).length === 1 && arr(pointsNow.json)[0].points === 33,
      arr(pointsNow.json).length ? `points=${arr(pointsNow.json)[0].points}` : "no row");

    // ══ J. Firebase boundary (static) ════════════════════════════════════
    const SUBMISSION_PATH = [
      "src/lib/supabase/socialForce.ts",
      "src/app/portal/tasks/page.tsx",
      "src/app/portal/admin/tasks/page.tsx",
    ];
    const LEGACY_FNS = ["submitTaskCompletion", "getUserTaskSubmissions", "getSubmissionsForTaskWithUsers", "verifyTaskSubmission"];
    const hits: string[] = [];
    for (const rel of SUBMISSION_PATH) {
      const src = fs.readFileSync(path.resolve(rel), "utf8");
      if (/from\s+["'][^"']*(firebase|firestore)[^"']*["']/i.test(src)) hits.push(`${rel}::firebase`);
      for (const fn of LEGACY_FNS) if (src.includes(fn)) hits.push(`${rel}::${fn}`);
    }
    record("J1 migrated submission path is Firebase-free",
      hits.length === 0, hits.length ? hits.slice(0, 3).join("; ") : "all clean");
    const svc = fs.readFileSync(path.resolve("src/lib/supabase/socialForce.ts"), "utf8");
    record("J2 submission mutations are RPC-only in the service",
      !/\.insert\(/.test(svc) && !/\.update\(/.test(svc) && !/\.delete\(/.test(svc) &&
        svc.includes('"submit_social_task"') && svc.includes('"verify_social_submission"'),
      "verified");

    // ══ K. Pristine cleanup ══════════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
    try {
      const residual = await sql.query<{ tasks: string; subs: string; awards: string; notes: string; tenants: string; users: string; mods: string }>(
        `SELECT
           (SELECT count(*)::text FROM politicore.social_tasks WHERE tenant_id::text = ANY($1)) tasks,
           (SELECT count(*)::text FROM politicore.social_task_submissions WHERE tenant_id::text = ANY($1)) subs,
           (SELECT count(*)::text FROM politicore.social_point_awards WHERE tenant_id::text = ANY($1)) awards,
           (SELECT count(*)::text FROM politicore.notifications WHERE tenant_id::text = ANY($1)) notes,
           (SELECT count(*)::text FROM politicore.tenants WHERE id::text = ANY($1)) tenants,
           (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@pcorb.example.com' AND email LIKE '%${SUFFIX}%') users,
           (SELECT count(*)::text FROM politicore.tenant_modules WHERE tenant_id::text = ANY($1)) mods`,
        [tenantIds]);
      const r = residual.rows[0];
      record("K1 pristine hosted state restored",
        r.tasks === "0" && r.subs === "0" && r.awards === "0" && r.notes === "0" &&
          r.tenants === "0" && r.users === "0" && r.mods === "0",
        `tasks=${r.tasks} subs=${r.subs} awards=${r.awards} notes=${r.notes} tenants=${r.tenants} users=${r.users} mods=${r.mods}`);
    } catch (e) {
      record("K1 pristine hosted state restored", false, (e as Error).message.slice(0, 100));
    }
    await sql.end();
  }

  const fails = results.filter((r) => !r.ok);
  console.log(`\n══ SOCIAL FORCE PHASE C HOSTED SMOKE: ${results.length - fails.length}/${results.length} ══`);
  if (fails.length) {
    console.log("FAILED:");
    for (const f of fails) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
