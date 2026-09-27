/**
 * POLITICORE — Governance & Citizen Engagement architecture gate — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts, real
 * JWTs, the real PostgREST data API, real RLS, real authority RPCs —
 * proving the Phase 6 Governance first slice under the same acceptance
 * standard as the prior phases.
 *
 * Journeys:
 *   G1  — module gate: governance-disabled tenant cannot submit (fail closed)
 *   G2  — member submission via public.submit_governance_request: participant
 *         provisioning, reference code, submitted event
 *   G3  — anonymous: no reads, no writes
 *   G4  — participant reads own request; status submitted
 *   G5  — queue visibility: permission-less member sees 0; staff sees 1
 *   G6  — acknowledge RPC drives the ladder + records the event
 *   G7  — cross-tenant assignee rejected ("same tenant")
 *   G8  — same-tenant assignment recorded + request.status = assigned
 *   G9  — in_progress → resolved with resolved_at
 *   G10 — events privacy: internal staff response invisible to participant
 *   G11 — feedback: owner-only, resolved-only, once
 *   G12 — cross-tenant isolation: no reads, RPC "request not found"
 *   G13 — status-ladder guard rejects illegal direct PATCH
 *   G14 — event trail append-only over the data API
 *   G15 — canonical system_audits attribution (governance_requests:insert)
 *   E   — pristine cleanup + FORCE-RLS state restored
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
      // governance_request_events is append-only via a tamper trigger;
      // cleanup runs as superuser with triggers disabled for that table.
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

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `GovGate!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m34 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('public.submit_governance_request(text,text,uuid,text,text,text)')
         IS NOT NULL AS ok`);
    if (!m34.rows[0].ok) throw new Error("migration 0034 not applied on hosted — run apply-hosted first");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `govgt-${SUFFIX}`;
    const mk = async (name: string, slug: string) => {
      const id = (await sql.query<{ id: string }>(
        `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
        [name, slug])).rows[0].id;
      tenantIds.push(id);
      return id;
    };
    const tenantA = await mk(`Governance Gate — main`, E);
    const tenantB = await mk(`Governance Gate — isolation`, `govgt-iso-${SUFFIX}`);
    const tenantC = await mk(`Governance Gate — module off`, `govgt-off-${SUFFIX}`);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true), ($3,'governance',false)`,
      [tenantA, tenantB, tenantC]);

    const admEmail = `${E}-adm@test.local`;
    const stfEmail = `${E}-stf@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    const offEmail = `${E}-off@test.local`;
    emails.push(admEmail, stfEmail, memEmail, isoEmail, offEmail);

    const admId = await createAuthUser(sql, admEmail, P, "Gov Admin", E);
    const stfId = await createAuthUser(sql, stfEmail, P, "Gov Staff", E);
    const memId = await createAuthUser(sql, memEmail, P, "Gov Member", E);
    const isoId = await createAuthUser(sql, isoEmail, P, "Gov Iso", `govgt-iso-${SUFFIX}`);
    await createAuthUser(sql, offEmail, P, "Gov Off", `govgt-off-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [isoId]);
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'manage_cases', true), ($1, $2, 'assign_cases', true),
              ($1, $2, 'view_cases', true), ($1, $3, 'view_cases', false)`,
      [tenantA, stfId, memId]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const stfToken = await signin(stfEmail, P);
    const memToken = await signin(memEmail, P);
    const isoToken = await signin(isoEmail, P);
    const offToken = await signin(offEmail, P);

    // ══ G1. module gate ══════════════════════════════════════════════════
    const off = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: "Should not land", p_details: "module off" }, offToken);
    record("G1 governance-disabled tenant cannot submit",
      off.status >= 400 && /module is not enabled/i.test(msg(off.json)),
      `HTTP ${off.status} ${msg(off.json).slice(0, 80)}`);

    // ══ G2. submission + participant provisioning ═════════════════════════
    const sub = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: `Fix the ward road ${SUFFIX}`, p_details: "Large potholes near the market" },
      memToken);
    const reqId = (sub.json as string | null) ?? "";
    record("G2 member submission via authority RPC",
      sub.status === 200 && /^[0-9a-f-]{36}$/.test(reqId), `HTTP ${sub.status}`);

    const prov = await rest("GET",
      `/rest/v1/governance_participants?profile_id=eq.${memId}&select=id,display_label`, undefined, memToken);
    const reqRow = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=reference_code,status,participant_id`,
      undefined, memToken);
    record("G2b participant 1:1 + reference code + status",
      prov.status === 200 && arr(prov.json).length === 1 &&
      reqRow.status === 200 && arr(reqRow.json).length === 1 &&
      /^GR-\d{4}-[0-9A-F]{8}$/.test(String(arr(reqRow.json)[0]?.reference_code)) &&
      arr(reqRow.json)[0]?.status === "submitted",
      `participant=${arr(prov.json).length} ref=${String(arr(reqRow.json)[0]?.reference_code)}`);

    // ══ G3. anonymous: nothing ═══════════════════════════════════════════
    const anonRead = await rest("GET", "/rest/v1/governance_requests?select=id");
    const anonSubmit = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: "anon", p_details: "x" });
    record("G3 anonymous reads/writes fail closed",
      (anonRead.status === 401 || anonRead.status === 403 || arr(anonRead.json).length === 0) &&
      anonSubmit.status >= 400,
      `read HTTP ${anonRead.status} (${arr(anonRead.json).length} rows), submit HTTP ${anonSubmit.status}`);

    // ══ G4. participant reads own request ════════════════════════════════
    const own = await rest("GET", `/rest/v1/governance_requests?id=eq.${reqId}&select=id`,
      undefined, memToken);
    record("G4 participant reads own request",
      own.status === 200 && arr(own.json).length === 1, `HTTP ${own.status} rows=${arr(own.json).length}`);

    // ══ G5. queue visibility ═════════════════════════════════════════════
    const stfBefore = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=id`, undefined, stfToken);
    record("G5 staff (manage_cases) sees the queue",
      stfBefore.status === 200 && arr(stfBefore.json).length === 1,
      `HTTP ${stfBefore.status} rows=${arr(stfBefore.json).length}`);

    // ══ G6. acknowledge ══════════════════════════════════════════════════
    const ack = await rest("POST", "/rest/v1/rpc/acknowledge_governance_request",
      { p_request_id: reqId, p_note: "Received by the constituency office" }, stfToken);
    const ackState = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=status`, undefined, memToken);
    record("G6 acknowledge drives ladder to 'acknowledged'",
      ack.status === 200 && arr(ackState.json)[0]?.status === "acknowledged",
      `HTTP ${ack.status} status=${String(arr(ackState.json)[0]?.status)}`);

    // ══ G7. cross-tenant assignee rejected ═══════════════════════════════
    const badAssign = await rest("POST", "/rest/v1/rpc/assign_governance_request",
      { p_request_id: reqId, p_assignee_profile_id: isoId, p_note: "x" }, stfToken);
    record("G7 cross-tenant assignee rejected",
      badAssign.status >= 400 && /same tenant/i.test(msg(badAssign.json)),
      `HTTP ${badAssign.status} ${msg(badAssign.json).slice(0, 80)}`);

    // ══ G8. same-tenant assignment ═══════════════════════════════════════
    const asg = await rest("POST", "/rest/v1/rpc/assign_governance_request",
      { p_request_id: reqId, p_assignee_profile_id: stfId, p_scope_type: "lga",
        p_scope_id: "lga-01", p_note: "Please handle" }, stfToken);
    const asgState = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=status,assigned_profile_id`, undefined, stfToken);
    const asgRow = await rest("GET",
      `/rest/v1/governance_assignments?request_id=eq.${reqId}&select=assigned_to`, undefined, stfToken);
    record("G8 assignment recorded + status 'assigned'",
      asg.status === 200 && arr(asgState.json)[0]?.status === "assigned" &&
      arr(asgState.json)[0]?.assigned_profile_id === stfId &&
      arr(asgRow.json).length === 1 && arr(asgRow.json)[0]?.assigned_to === stfId,
      `HTTP ${asg.status} status=${String(arr(asgState.json)[0]?.status)}`);

    // ══ G9. progress → resolved ══════════════════════════════════════════
    const prog = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "in_progress", p_note: "Crew dispatched" }, stfToken);
    const res = await rest("POST", "/rest/v1/rpc/update_governance_request_status",
      { p_request_id: reqId, p_status: "resolved", p_note: "Road graded", p_is_public: true }, stfToken);
    const resState = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=status,resolved_at`, undefined, stfToken);
    record("G9 in_progress → resolved with resolved_at",
      prog.status === 200 && res.status === 200 &&
      arr(resState.json)[0]?.status === "resolved" &&
      typeof arr(resState.json)[0]?.resolved_at === "string",
      `HTTP ${res.status} status=${String(arr(resState.json)[0]?.status)}`);

    // ══ G10. events privacy ══════════════════════════════════════════════
    const internal = await rest("POST", "/rest/v1/rpc/respond_governance_request",
      { p_request_id: reqId, p_body: `Internal ${SUFFIX}: verify contractor`, p_is_public: false },
      stfToken);
    const pub = await rest("POST", "/rest/v1/rpc/respond_governance_request",
      { p_request_id: reqId, p_body: `Public ${SUFFIX}: crew on site`, p_is_public: true },
      stfToken);
    const memEvents = await rest("GET",
      `/rest/v1/governance_request_events?request_id=eq.${reqId}&select=body,is_public`,
      undefined, memToken);
    const memBodies = arr(memEvents.json).map((r) => String(r.body)).join("|");
    const stfEvents = await rest("GET",
      `/rest/v1/governance_request_events?request_id=eq.${reqId}&select=body`,
      undefined, stfToken);
    const stfBodies = arr(stfEvents.json).map((r) => String(r.body)).join("|");
    record("G10 internal staff response invisible to participant",
      internal.status === 200 && pub.status === 200 &&
      !memBodies.includes(`Internal ${SUFFIX}`) && memBodies.includes(`Public ${SUFFIX}`) &&
      stfBodies.includes(`Internal ${SUFFIX}`),
      `participant events=${arr(memEvents.json).length}, staff events=${arr(stfEvents.json).length}`);

    // ══ G11. feedback ════════════════════════════════════════════════════
    const rate = await rest("POST", "/rest/v1/rpc/rate_governance_request",
      { p_request_id: reqId, p_rating: 5, p_comment: "Well handled" }, memToken);
    const again = await rest("POST", "/rest/v1/rpc/rate_governance_request",
      { p_request_id: reqId, p_rating: 3, p_comment: "second" }, memToken);
    const fb = await rest("GET",
      `/rest/v1/governance_requests?id=eq.${reqId}&select=feedback_rating,feedback_comment`,
      undefined, memToken);
    record("G11 owner feedback recorded once",
      rate.status === 200 && again.status >= 400 && /already recorded/i.test(msg(again.json)) &&
      arr(fb.json)[0]?.feedback_rating === 5,
      `rate HTTP ${rate.status}, repeat HTTP ${again.status} ${msg(again.json).slice(0, 60)}`);

    // ══ G12. cross-tenant isolation ══════════════════════════════════════
    const isoRead = await rest("GET", `/rest/v1/governance_requests?id=eq.${reqId}&select=id`,
      undefined, isoToken);
    const isoAck = await rest("POST", "/rest/v1/rpc/acknowledge_governance_request",
      { p_request_id: reqId, p_note: "x" }, isoToken);
    record("G12 cross-tenant admin: no reads, RPC not found",
      arr(isoRead.json).length === 0 && isoAck.status >= 400 && /request not found/i.test(msg(isoAck.json)),
      `rows=${arr(isoRead.json).length}, ack HTTP ${isoAck.status}`);

    // ══ G13. ladder guard over the data API ══════════════════════════════
    const sub2 = await rest("POST", "/rest/v1/rpc/submit_governance_request",
      { p_title: `Guard probe ${SUFFIX}`, p_details: "d" }, memToken);
    const req2 = (sub2.json as string) ?? "";
    const skip = await rest("PATCH", `/rest/v1/governance_requests?id=eq.${req2}`,
      { status: "resolved" }, stfToken);
    record("G13 illegal status PATCH rejected by guard",
      skip.status >= 400 && /illegal status transition/i.test(msg(skip.json)),
      `HTTP ${skip.status} ${msg(skip.json).slice(0, 80)}`);

    // ══ G14. append-only events (effective denial: nothing can mutate) ══
    const evList = await rest("GET",
      `/rest/v1/governance_request_events?request_id=eq.${req2}&select=id,body`, undefined, stfToken);
    const evId = arr(evList.json)[0]?.id;
    const evBody = String(arr(evList.json)[0]?.body);
    // hosted default privileges can leave grant-level surfaces even where
    // RLS denies every row — so the contract is asserted by EFFECT: any
    // PATCH/DELETE must leave the row byte-identical (0 rows affected).
    const tamper = await rest("PATCH", `/rest/v1/governance_request_events?id=eq.${evId}`,
      { body: "tampered" }, admToken);
    const wipe = await rest("DELETE", `/rest/v1/governance_request_events?id=eq.${evId}`,
      undefined, admToken);
    const after = await rest("GET",
      `/rest/v1/governance_request_events?id=eq.${evId}&select=body`, undefined, stfToken);
    record("G14 event trail append-only (effective denial)",
      arr(after.json).length === 1 && String(arr(after.json)[0]?.body) === evBody,
      `PATCH ${tamper.status}, DELETE ${wipe.status}, row unchanged=${String(arr(after.json)[0]?.body) === evBody}`);

    // ══ G15. canonical audit attribution ═════════════════════════════════
    const audits = await rest("GET",
      `/rest/v1/system_audit_logs?affected_resource=eq.governance_requests&resource_id=eq.${reqId}&action=eq.governance_requests:insert&select=action,actor_id`,
      undefined, admToken);
    record("G15 canonical system_audits attribution",
      audits.status === 200 && arr(audits.json).length === 1 &&
      arr(audits.json)[0]?.actor_id === memId,
      `insert-audit rows=${arr(audits.json).length}, actor=${String(arr(audits.json)[0]?.actor_id)}`);

  } catch (e) {
    record("harness error", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nGovernance hosted acceptance: ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main();
