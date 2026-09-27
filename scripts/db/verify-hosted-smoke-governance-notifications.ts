/**
 * POLITICORE — Governance → Core Notifications (Phase 8) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the operational
 * communication loop around the Phase 7 workflow: every staff transition
 * produces a participant notification through the EXISTING Core
 * Notifications infrastructure (0001 schema, 0002 RLS, 0008 RPC surface,
 * 0009 view), delivered by 0036 inside the authority RPCs.
 *
 * Journeys:
 *   M1  — acknowledge → participant notification exists (unread, linked)
 *   M2  — assign → participant + assignee notifications (own routes)
 *   M3  — awaiting_information → participant notification
 *   M4  — resolve → participant notification; member opens request,
 *         submits feedback (the §18 loop closes)
 *   M5  — close → participant notification
 *   M6  — duplicate protection: same-status retry adds no rows
 *   M7  — Notification Center: unread count via public.my_unread_count,
 *         mark-read via public.mark_notifications_read
 *   M8  — recipient isolation: another member reads none of them;
 *         staff/assignee notifications are not visible to the member
 *   M9  — privacy: the internal staff response produced no notification
 *   M10 — module-disabled tenant: submission fails closed (no loop at all)
 *   E   — pristine cleanup (0 fixtures: users/requests/participants/
 *         notifications/grants/tenants)
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
  method: string, url: string, body?: unknown, token?: string
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
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

/** Participant notifications for a member token (Notification Center read). */
async function memberNotifications(token: string, title: string) {
  const r = await rest("GET",
    `/rest/v1/notifications?select=id,title,message,link_url,read_at&title=eq.${encodeURIComponent(title)}&order=created_at.asc`,
    undefined, token);
  return { status: r.status, rows: arr(r.json) };
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `GovNotify!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m36 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.governance_notify(uuid,uuid,text,text,text,uuid)') IS NOT NULL AS ok`);
    if (!m36.rows[0].ok) throw new Error("migration 0036 not applied on hosted — run apply-hosted first");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `govnt-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Governance Notify — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Governance Notify — isolation`, `govnt-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);
    const tenantOff = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Governance Notify — off`, `govnt-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantOff);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true), ($3,'governance',false)`,
      [tenantA, tenantB, tenantOff]);

    const admEmail = `${E}-adm@test.local`;
    const stfEmail = `${E}-stf@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const otherEmail = `${E}-other@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    const offEmail = `${E}-off@test.local`;
    emails.push(admEmail, stfEmail, memEmail, otherEmail, isoEmail, offEmail);

    const admId = await createAuthUser(sql, admEmail, P, "Gov Notify Admin", E);
    const stfId = await createAuthUser(sql, stfEmail, P, "Gov Notify Staff", E);
    await createAuthUser(sql, memEmail, P, "Gov Notify Member", E);
    await createAuthUser(sql, otherEmail, P, "Gov Notify Other", E);
    await createAuthUser(sql, isoEmail, P, "Gov Notify Iso", `govnt-iso-${SUFFIX}`);
    await createAuthUser(sql, offEmail, P, "Gov Notify Off", `govnt-off-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'view_governance', true), ($1, $2, 'view_cases', true),
              ($1, $2, 'manage_cases', true), ($1, $2, 'assign_cases', true)`,
      [tenantA, stfId]);

    await new Promise((r) => setTimeout(r, 1500));

    await signin(admEmail, P); // admin seat exists; Center reads are per-recipient
    const stfToken = await signin(stfEmail, P);
    const memToken = await signin(memEmail, P);
    const otherToken = await signin(otherEmail, P);

    // ══ M0. submission ═══════════════════════════════════════════════════
    const sub = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: `Notify loop ${SUFFIX}`, p_details: "Water pipeline broken" }, memToken);
    const reqId = (sub.json as string | null) ?? "";
    if (sub.status !== 200) throw new Error(`submission failed: ${sub.status} ${msg(sub.json)}`);

    const before = await memberNotifications(memToken, "Request acknowledged");
    if (before.rows.length !== 0) throw new Error("unexpected pre-existing notification");

    // ══ M1. acknowledge → notification ══════════════════════════════════
    const ack = await rest("POST", "/rest/v1/rpc/acknowledge_governance_request",
      { p_request_id: reqId, p_note: "Logged by the office" }, stfToken);
    const ackNote = await memberNotifications(memToken, "Request acknowledged");
    record("M1 acknowledge notifies the participant",
      ack.status === 200 && ackNote.rows.length === 1 &&
      String(ackNote.rows[0].link_url) === `/portal/governance/requests/${reqId}` &&
      ackNote.rows[0].read_at === null,
      `ack=${ack.status}, rows=${ackNote.rows.length}, link=${String(ackNote.rows[0]?.link_url)}`);

    // ══ M2. assign → participant + assignee ═════════════════════════════
    const asg = await rest("POST", "/rest/v1/rpc/assign_governance_request",
      { p_request_id: reqId, p_assignee_profile_id: stfId, p_note: "Yours" }, stfToken);
    const asgNote = await memberNotifications(memToken, "Request assigned");
    const staffNote = await memberNotifications(stfToken, "Governance case assigned to you");
    record("M2 assignment notifies participant + assignee",
      asg.status === 200 && asgNote.rows.length === 1 &&
      String(asgNote.rows[0].link_url) === `/portal/governance/requests/${reqId}` &&
      staffNote.rows.length === 1 &&
      String(staffNote.rows[0].link_url) === `/portal/governance/cases/${reqId}`,
      `assign=${asg.status}, participant=${asgNote.rows.length}, assignee=${staffNote.rows.length}`);

    // ══ M3. awaiting_information → notification ═════════════════════════
    await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "in_progress", p_note: "Started" }, stfToken);
    const wait = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "awaiting_information", p_note: "Nearest landmark?" }, stfToken);
    const waitNote = await memberNotifications(memToken, "Information requested");
    record("M3 information request notifies the participant",
      wait.status === 200 && waitNote.rows.length === 1,
      `wait=${wait.status}, rows=${waitNote.rows.length}`);

    // ══ M4. resolve → notification; member opens request + feedback ═════
    await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "in_progress", p_note: "Info received" }, stfToken);
    const res = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "resolved", p_note: "Pipeline repaired" }, stfToken);
    const resNote = await memberNotifications(memToken, "Request resolved");
    // member opens the request through the detail surface's read
    const detail = await rest("GET",
      `/rest/v1/governance_requests?select=reference_code,status,feedback_rating&id=eq.${reqId}`,
      undefined, memToken);
    const rate = await rest("POST", "/rest/v1/rpc/rate_governance_request",
      { p_request_id: reqId, p_rating: 5, p_comment: "Well handled" }, memToken);
    record("M4 resolution notifies; member opens request and gives feedback",
      res.status === 200 && resNote.rows.length === 1 &&
      arr(detail.json).length === 1 && rate.status === 200,
      `resolve=${res.status}, note=${resNote.rows.length}, feedback=${rate.status}`);

    // ══ M5. close → notification ════════════════════════════════════════
    const close = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "closed", p_note: "Complete" }, stfToken);
    const closeNote = await memberNotifications(memToken, "Request closed");
    record("M5 closure notifies the participant",
      close.status === 200 && closeNote.rows.length === 1,
      `close=${close.status}, rows=${closeNote.rows.length}`);

    // ══ M6. duplicate protection over the data API ══════════════════════
    const retry = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "closed", p_note: "retry" }, stfToken);
    const closeNote2 = await memberNotifications(memToken, "Request closed");
    record("M6 same-status retry adds no notification",
      retry.status === 200 && closeNote2.rows.length === 1,
      `retry=${retry.status}, rows=${closeNote2.rows.length}`);

    // ══ M7. Notification Center contract (0008 RPC surface) ═════════════
    const unread = await rest("POST", "/rest/v1/rpc/my_unread_count", undefined, memToken);
    const firstUnread = await rest("GET",
      `/rest/v1/notifications?select=id&read_at=is.null&order=created_at.asc&limit=1`,
      undefined, memToken);
    const firstId = String(arr(firstUnread.json)[0]?.id ?? "");
    const mark = await rest("POST", "/rest/v1/rpc/mark_notifications_read",
      { p_ids: [firstId] }, memToken);
    const unread2 = await rest("POST", "/rest/v1/rpc/my_unread_count", undefined, memToken);
    record("M7 Center unread-count + mark-read over Governance notifications",
      Number(unread.json) >= 5 && firstId !== "" && mark.status === 200 &&
      Number(unread2.json) === Number(unread.json) - 1,
      `unread=${String(unread.json)} → ${String(unread2.json)}`);

    // ══ M8. recipient isolation ══════════════════════════════════════════
    const otherAll = await rest("GET", "/rest/v1/notifications?select=id", undefined, otherToken);
    const staffParticipantNotes = await rest("GET",
      `/rest/v1/notifications?select=id&title=eq.${encodeURIComponent("Request acknowledged")}`,
      undefined, stfToken);
    record("M8 notifications are strictly per-recipient",
      otherAll.status === 200 && arr(otherAll.json).length === 0 &&
      arr(staffParticipantNotes.json).length === 0 && staffNote.rows.length === 1,
      `other-member rows=${arr(otherAll.json).length}, staff participant-titled rows=${arr(staffParticipantNotes.json).length}`);

    // ══ M9. privacy: the internal response produced no notification ═════
    const internal = await rest("POST", "/rest/v1/rpc/respond_governance_request",
      { p_request_id: reqId, p_body: `Internal ${SUFFIX}: contractor quotes pending`, p_is_public: false },
      stfToken);
    const anyInternal = await rest("GET",
      `/rest/v1/notifications?select=id&message=ilike.*${encodeURIComponent(`Internal ${SUFFIX}`)}*`,
      undefined, memToken);
    record("M9 internal staff response leaks nowhere",
      internal.status === 200 && arr(anyInternal.json).length === 0,
      `respond=${internal.status}, notification rows=${arr(anyInternal.json).length}`);

    // ══ M10. module-disabled tenant ══════════════════════════════════════
    const offToken = await signin(offEmail, P);
    const offSub = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: "Should not land", p_details: "x" }, offToken);
    record("M10 module-disabled tenant fails closed",
      offSub.status >= 400 && /module is not enabled/i.test(msg(offSub.json)),
      `HTTP ${offSub.status} ${msg(offSub.json).slice(0, 60)}`);

  } catch (e) {
    record("harness error", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nGovernance notifications hosted acceptance: ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main();
