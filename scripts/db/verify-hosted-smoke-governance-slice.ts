/**
 * POLITICORE — Governance Phase 7 (vertical slice UI) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and replays the exact
 * data-API traffic the Phase 7 application surface produces
 * (src/lib/supabase/governance.ts): the access-resolution RPC, the
 * embedded-join reads, the queue filters, the category view CRUD and the
 * authority RPCs — under the same hosted standard as the prior phases.
 *
 * Journeys (service surface):
 *   S1  — access resolution (admin): role fast path, all flags true
 *   S2  — access resolution (staff): view_governance + view_cases grants
 *   S3  — access resolution (member): explicit view_governance deny →
 *         navigation fails closed (Phase 7 §13 contract)
 *   S4  — My Requests surface: embedded category/participant join reads,
 *         participant-scoped (listMyRequests traffic)
 *   S5  — request detail read: reference code + embedded join (getMyRequest)
 *   S6  — participant event read: submitted event visible, internal
 *         staff response excluded (getRequestEvents under RLS)
 *   S7  — staff queue: server-side status/ilike/assigned filters + embedded
 *         joins (listCases traffic — no client fan-out)
 *   S8  — lifecycle through the service RPCs: acknowledge → awaiting_info
 *         → in_progress → resolved (case-detail actions)
 *   S9  — staff response both visibilities through respond RPC
 *   S10 — feedback through rate RPC: once, then rejected
 *   S11 — category admin: list/create through the public view; member
 *         create denied; deactivate drops it from the member read
 *   E   — pristine cleanup + FORCE-RLS restored
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
  process.exitCode = 1;
  process.exit(1);
}

async function rest(
  method: string, url: string, body?: unknown, token?: string, prefer?: string
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST") headers.Prefer = prefer ?? "return=representation";
  if (method === "PATCH") headers.Prefer = prefer ?? "return=representation";
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
function msg(json: unknown): string {
  const m = (json as { message?: string } | null)?.message ?? "";
  return String(m);
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

const GOV_TABLES = [
  "governance_request_events", "governance_assignments", "governance_requests",
  "governance_participants", "governance_request_categories",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  try {
    const CLEAN_TABLES = [
      ...GOV_TABLES, "notifications", "permission_grants", "system_audits",
      "tenants", "tenant_modules",
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
      await sql.query("SET session_replication_role = replica");
      for (let pass = 0; pass < 4; pass++) {
        for (const t of GOV_TABLES) {
          await sql.query(`DELETE FROM politicore.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
        }
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        const left = await sql.query<{ n: string }>(
          `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        if (left.rows[0].n === "0") break;
      }
    } finally {
      await sql.query("SET session_replication_role = DEFAULT");
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove governance fixtures manually:", (e as Error).message);
  }
}

// The embedded-join select the Phase 7 service issues on every request read.
const REQUEST_SELECT = encodeURIComponent(
  "id,tenant_id,reference_code,participant_id,category_id,title,details,status,is_public," +
  "ward_id,lga_id,polling_unit_id,assigned_profile_id,resolved_at,closed_at," +
  "feedback_rating,feedback_comment,created_at,updated_at," +
  "category:governance_request_categories(id,name)," +
  "participant:governance_participants(id,full_name,display_label)",
);

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `GovSlice!${SUFFIX}`;

  try {
    // ══ 0. hosted + migration preconditions ══════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m34 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('public.submit_governance_request(text,text,uuid,text,text,text)')
         IS NOT NULL AS ok`);
    if (!m34.rows[0].ok) throw new Error("migration 0034 not applied on hosted — run apply-hosted first");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `govsl-${SUFFIX}`;
    const mk = async (name: string, slug: string) => {
      const id = (await sql.query<{ id: string }>(
        `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
        [name, slug])).rows[0].id;
      tenantIds.push(id);
      return id;
    };
    const tenantA = await mk(`Governance Slice — main`, E);
    const tenantB = await mk(`Governance Slice — isolation`, `govsl-iso-${SUFFIX}`);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true)`,
      [tenantA, tenantB]);

    const admEmail = `${E}-adm@test.local`;
    const stfEmail = `${E}-stf@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, stfEmail, memEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "Gov Admin", E);
    const stfId = await createAuthUser(sql, stfEmail, P, "Gov Staff", E);
    const memId = await createAuthUser(sql, memEmail, P, "Gov Member", E);
    await createAuthUser(sql, isoEmail, P, "Gov Iso", `govsl-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'view_governance', true), ($1, $2, 'view_cases', true),
              ($1, $2, 'manage_cases', true), ($1, $2, 'assign_cases', true),
              ($1, $3, 'view_governance', false)`,
      [tenantA, stfId, memId]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const stfToken = await signin(stfEmail, P);
    const memToken = await signin(memEmail, P);

    // ══ S1. access resolution — admin fast path ══════════════════════════
    const admPerm = await rest(
      "POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "view_governance" }, admToken);
    const admPerm2 = await rest(
      "POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "manage_cases" }, admToken);
    record("S1 admin access: role fast path grants every flag",
      admPerm.status === 200 && admPerm.json === true &&
      admPerm2.status === 200 && admPerm2.json === true,
      `view_governance=${String(admPerm.json)}, manage_cases=${String(admPerm2.json)}`);

    // ══ S2. access resolution — staff via grants ═════════════════════════
    const stfNav = await rest(
      "POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "view_governance" }, stfToken);
    const stfCases = await rest(
      "POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "view_cases" }, stfToken);
    record("S2 staff access: view_governance + view_cases via grants",
      stfNav.json === true && stfCases.json === true,
      `view_governance=${String(stfNav.json)}, view_cases=${String(stfCases.json)}`);

    // ══ S3. access resolution — member deny row fails nav closed ═════════
    const memNav = await rest(
      "POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "view_governance" }, memToken);
    const memCases = await rest(
      "POST", "/rest/v1/rpc/politicore_has_permission",
      { p_permission: "view_cases" }, memToken);
    record("S3 member access: view_governance deny → navigation closed",
      memNav.json === false && memCases.json === false,
      `view_governance=${String(memNav.json)}, view_cases=${String(memCases.json)}`);

    // ══ S4. My Requests surface (participant-scoped, embedded joins) ═════
    const sub = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: `Slice case ${SUFFIX}`, p_details: "Streetlights out on Market Road" }, memToken);
    const reqId = (sub.json as string | null) ?? "";
    if (sub.status !== 200) throw new Error(`submission failed: ${sub.status}`);

    const myPart = await rest("GET",
      `/rest/v1/governance_participants?profile_id=eq.${memId}&select=id`, undefined, memToken);
    const partId = String(arr(myPart.json)[0]?.id ?? "");

    const mine = await rest("GET",
      `/rest/v1/governance_requests?select=${REQUEST_SELECT}&participant_id=eq.${partId}&order=created_at.desc`,
      undefined, memToken);
    const mineRow = arr(mine.json)[0] ?? {};
    record("S4 my-requests read: embedded joins + participant scoping",
      mine.status === 200 && arr(mine.json).length === 1 &&
      String(mineRow.reference_code ?? "").match(/^GR-\d{4}-[0-9A-F]{8}$/) !== null &&
      (mineRow.category as Record<string, unknown> | null) !== undefined &&
      (mineRow.participant as Record<string, unknown> | null)?.id === partId,
      `rows=${arr(mine.json).length}, ref=${String(mineRow.reference_code)}`);

    // ══ S5. request detail read ══════════════════════════════════════════
    const detail = await rest("GET",
      `/rest/v1/governance_requests?select=${REQUEST_SELECT}&id=eq.${reqId}`,
      undefined, memToken);
    record("S5 request-detail read: single row, status submitted",
      detail.status === 200 && arr(detail.json).length === 1 &&
      arr(detail.json)[0]?.status === "submitted",
      `HTTP ${detail.status}, status=${String(arr(detail.json)[0]?.status)}`);

    // ══ S6. participant event read (before staff activity) ═══════════════
    const evsEarly = await rest("GET",
      `/rest/v1/governance_request_events?request_id=eq.${reqId}&select=kind,body,is_public&order=created_at.asc`,
      undefined, memToken);
    record("S6 participant sees the submitted event trail",
      evsEarly.status === 200 && arr(evsEarly.json).some((e) => e.kind === "submitted"),
      `events=${arr(evsEarly.json).map((e) => String(e.kind)).join(",")}`);

    // ══ S7. staff queue: server-side filters + embedded joins ════════════
    const q = await rest("GET",
      `/rest/v1/governance_requests?select=${REQUEST_SELECT}` +
      `&status=eq.submitted&title=ilike.*${encodeURIComponent(SUFFIX)}*&order=created_at.desc`,
      undefined, stfToken);
    record("S7 queue read: status + ilike filters resolve server-side",
      q.status === 200 && arr(q.json).length === 1 &&
      String(arr(q.json)[0]?.id) === reqId,
      `rows=${arr(q.json).length}`);

    // ══ S8. lifecycle through the service RPCs ═══════════════════════════
    // Walk the approved ladder exactly: acknowledged→awaiting_information is
    // not a legal edge (the guard rejects it — proven below), so the
    // information-request loop runs through in_progress, as the UI does.
    const ack = await rest("POST", "/rest/v1/rpc/acknowledge_governance_request",
      { p_request_id: reqId, p_note: "Received by the office" }, stfToken);
    const illegal = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "awaiting_information", p_note: "skip" }, stfToken);
    const prog = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "in_progress", p_note: "Started" }, stfToken);
    const wait = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "awaiting_information", p_note: "Need nearest landmark" }, stfToken);
    const resume = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "in_progress", p_note: "Information received" }, stfToken);
    const resolve = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "resolved", p_note: "Lights repaired" }, stfToken);
    const st = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=status,resolved_at`, undefined, memToken);
    record("S8 lifecycle: acknowledge → in_progress ⇄ awaiting_information → resolved",
      [ack, prog, wait, resume, resolve].every((r) => r.status === 200) &&
      illegal.status >= 400 && /illegal status transition/i.test(msg(illegal.json)) &&
      arr(st.json)[0]?.status === "resolved",
      `seq=${ack.status}/${illegal.status}/${prog.status}/${wait.status}/${resume.status}/${resolve.status}, status=${String(arr(st.json)[0]?.status)}`);

    // ══ S9. staff response both visibilities ═════════════════════════════
    const respPub = await rest("POST", "/rest/v1/rpc/respond_governance_request",
      { p_request_id: reqId, p_body: `Public reply ${SUFFIX}`, p_is_public: true }, stfToken);
    const respInt = await rest("POST", "/rest/v1/rpc/respond_governance_request",
      { p_request_id: reqId, p_body: `Internal note ${SUFFIX}`, p_is_public: false }, stfToken);
    const memTrail = await rest("GET",
      `/rest/v1/governance_request_events?request_id=eq.${reqId}&select=body`, undefined, memToken);
    const memBodies = arr(memTrail.json).map((r) => String(r.body)).join("|");
    record("S9 staff responses: public visible to participant, internal not",
      respPub.status === 200 && respInt.status === 200 &&
      memBodies.includes(`Public reply ${SUFFIX}`) && !memBodies.includes(`Internal note ${SUFFIX}`),
      `participant trail events=${arr(memTrail.json).length}`);

    // ══ S10. feedback through rate RPC ═══════════════════════════════════
    const rate = await rest("POST", "/rest/v1/rpc/rate_governance_request",
      { p_request_id: reqId, p_rating: 4, p_comment: "Handled well" }, memToken);
    const rate2 = await rest("POST", "/rest/v1/rpc/rate_governance_request",
      { p_request_id: reqId, p_rating: 1, p_comment: "again" }, memToken);
    const fb = await rest("GET",
      `/rest/v1/governance_requests?select=${REQUEST_SELECT}&id=eq.${reqId}`, undefined, memToken);
    record("S10 participant feedback: once, then rejected",
      rate.status === 200 && rate2.status >= 400 &&
      arr(fb.json)[0]?.feedback_rating === 4,
      `rate=${rate.status}, repeat=${rate2.status}, rating=${String(arr(fb.json)[0]?.feedback_rating)}`);

    // ══ S11. category admin through the public view ══════════════════════
    const catIns = await rest("POST", "/rest/v1/governance_request_categories",
      { tenant_id: tenantA, name: `Slice category ${SUFFIX}`, description: "admin-created" }, admToken);
    const catId = String(arr(catIns.json)[0]?.id ?? "");
    const catInsDenied = await rest("POST", "/rest/v1/governance_request_categories",
      { tenant_id: tenantA, name: `Member cat ${SUFFIX}` }, memToken);
    record("S11a category create: admin through view, member denied",
      (catIns.status === 200 || catIns.status === 201) && catId !== "" &&
      (catInsDenied.status >= 400 || arr(catInsDenied.json).length === 0),
      `admin=${catIns.status}, member=${catInsDenied.status}`);

    const off = await rest("PATCH", `/rest/v1/governance_request_categories?id=eq.${catId}`,
      { is_active: false }, admToken);
    const memCats = await rest("GET",
      `/rest/v1/governance_request_categories?id=eq.${catId}&select=id,is_active`, undefined, memToken);
    const on = await rest("PATCH", `/rest/v1/governance_request_categories?id=eq.${catId}`,
      { is_active: true }, admToken);
    record("S11b deactivate removes it from the member read; reactivate restores",
      off.status === 200 && memCats.status === 200 && arr(memCats.json).length === 0 &&
      on.status === 200,
      `off=${off.status}, member rows=${arr(memCats.json).length}, on=${on.status}`);

    // staff assign + a second request for assigned-filter coverage
    const sub2 = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: `Assigned case ${SUFFIX}`, p_details: "Blocked drainage" }, memToken);
    const req2 = (sub2.json as string) ?? "";
    await rest("POST", "/rest/v1/rpc/acknowledge_governance_request",
      { p_request_id: req2 }, stfToken);
    const asg = await rest("POST", "/rest/v1/rpc/assign_governance_request",
      { p_request_id: req2, p_assignee_profile_id: stfId, p_note: "Yours" }, stfToken);
    const qMine = await rest("GET",
      `/rest/v1/governance_requests?select=${REQUEST_SELECT}&assigned_profile_id=eq.${stfId}`,
      undefined, stfToken);
    record("S12 queue 'assigned to me' filter (listCases traffic)",
      asg.status === 200 && qMine.status === 200 &&
      arr(qMine.json).length === 1 && String(arr(qMine.json)[0]?.id) === req2 &&
      arr(qMine.json)[0]?.status === "assigned",
      `rows=${arr(qMine.json).length}, status=${String(arr(qMine.json)[0]?.status)}`);

  } catch (e) {
    record("harness error", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nGovernance slice hosted acceptance: ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main();
