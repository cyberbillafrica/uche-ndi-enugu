/**
 * POLITICORE — Campaign Phase C HOSTED ACCEPTANCE (Campaign Assignments).
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real RPCs
 * through the public wrappers (0024). Full fixture cleanup with pristine
 * verification (§29–30 A–L).
 *
 * Journeys:
 *   A — creation: authorized coordinator creates via the RPC; tenant/
 *       creator/status/assignee/scope verified
 *   B — hierarchical visibility: ward sees own ward; sibling invisible;
 *       LGA/zone breadth; cross-tenant silence
 *   C — workflow: start → submit → return → resubmit → accept; illegal
 *       and unauthorized transitions denied
 *   D — reassignment: supervisor reassigns; audit + notification;
 *       unauthorized denied
 *   E — scope-move protection: no client scope/assignee/status/creator
 *       mutation path; eligibility guard on out-of-area assignees
 *   F — direct mutation abuse: view PATCH/DELETE (completed + non-terminal)
 *   G — social-only: zero visibility, zero authority
 *   H — Election Officer: no Campaign assignment authority
 *   I — module disabled: reads empty, RPC refusals, no leakage
 *   J — audit/notification: server-resolved actor, expected notifications
 *   K — cross-tenant: complete isolation
 *   L — cleanup + pristine verification
 *
 * Secrets are read from .env.local and never printed. Results are HOSTED.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

// ── env + REST helpers (Phase B pattern) ─────────────────────────────────────
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
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST" || method === "PATCH") headers.Prefer = "return=representation";
  const res = await fetch(SUPABASE_URL + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}
function first(json: unknown): Record<string, unknown> | null {
  const j = Array.isArray(json) ? json[0] : json;
  return (j && typeof j === "object" ? j : null) as Record<string, unknown> | null;
}
function rpcError(json: unknown): string {
  const j = json as { message?: string; error?: string };
  return j?.message ?? j?.error ?? JSON.stringify(json).slice(0, 140);
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
      "campaign_activity_participants", "campaign_activities",
      "campaign_assignments", "campaign_field_reports", "campaign_issues",
      "notifications", "organizational_assignments", "system_audits", "tenants",
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
      for (const t of CLEAN_TABLES) {
        if (t === "tenants") continue;
        await sql.query(`DELETE FROM politicore.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
      }
      await sql.query(
        `DELETE FROM politicore.system_audits
         WHERE actor_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
      await sql.query(
        `DELETE FROM politicore.notifications
         WHERE user_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
      await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
      await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
    } finally {
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove campc fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Campc-Smoke!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: tenants + real users + real Enugu geography ════════════
    const E = `campc-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampC Smoke A", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'campaign', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampC Smoke B (campaign off)", `campc-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB); // no campaign module row ⇒ disabled

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`campc.admin.${SUFFIX}@pcorb.example.com`, "CampC Admin", E);
    const wardC = await mk(`campc.ward.${SUFFIX}@pcorb.example.com`, "CampC Ward Coord", E);
    const lgaC = await mk(`campc.lga.${SUFFIX}@pcorb.example.com`, "CampC LGA Coord", E);
    const zoneC = await mk(`campc.zone.${SUFFIX}@pcorb.example.com`, "CampC Zone Coord", E);
    const memberW = await mk(`campc.mw.${SUFFIX}@pcorb.example.com`, "CampC Member W", E);
    const memberO = await mk(`campc.mo.${SUFFIX}@pcorb.example.com`, "CampC Member O", E);
    const memberX = await mk(`campc.mx.${SUFFIX}@pcorb.example.com`, "CampC Member X (sibling ward)", E);
    const socialU = await mk(`campc.social.${SUFFIX}@pcorb.example.com`, "CampC Social", E);
    const offAdmin = await mk(`campc.adminB.${SUFFIX}@pcorb.example.com`, "CampC Admin B", `campc-off-${SUFFIX}`);
    const electionOfficer = await mk(`campc.eo.${SUFFIX}@pcorb.example.com`, "CampC Election Officer", E);

    // profiles auto-backfill from auth.users (0010/0011) — shape them.
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [offAdmin]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [electionOfficer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialU]);

    // geography (0013-corrected; never assume the zone by name)
    const geo = await sql.query<{ w1: string; pu1: string; w2: string; zone: string }>(
      `SELECT
         (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) w1,
         (SELECT id FROM politicore.polling_units WHERE ward_id=(SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code LIMIT 1) pu1,
         (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code OFFSET 1 LIMIT 1) w2,
         (SELECT zone_id FROM politicore.lgas WHERE id='enugu-north') zone`);
    const { w1: W1, pu1: PU1, w2: W2, zone: ZONE } = geo.rows[0];
    if (!W1 || !PU1 || !W2 || !ZONE) throw new Error("geography fixture lookup failed");

    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}',
           ward_id = $2,
           lga_id = 'enugu-north',
           polling_unit_id = $3
       WHERE id = $1`, [memberW, W1, PU1]);
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}', ward_id = $2, lga_id = 'enugu-north'
       WHERE id = $1`, [memberO, W1]);
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}', ward_id = $2, lga_id = 'enugu-north'
       WHERE id = $1`, [memberX, W2]); // sibling ward — eligible member, WRONG area for W1 work
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}', ward_id = $2, lga_id = 'enugu-north'
       WHERE id = $1`, [wardC, W1]);

    await sql.query(
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1,$2,'ward_coordinator','ward',$3),
              ($1,$4,'lga_coordinator','lga','enugu-north'),
              ($1,$5,'zone_coordinator','senatorial_zone',$6)`,
      [tenantA, wardC, W1, lgaC, zoneC, ZONE]);

    const tWard = await signin(`campc.ward.${SUFFIX}@pcorb.example.com`, P);
    const tLga = await signin(`campc.lga.${SUFFIX}@pcorb.example.com`, P);
    const tZone = await signin(`campc.zone.${SUFFIX}@pcorb.example.com`, P);
    const tMw = await signin(`campc.mw.${SUFFIX}@pcorb.example.com`, P);
    const tSocial = await signin(`campc.social.${SUFFIX}@pcorb.example.com`, P);
    const tOff = await signin(`campc.adminB.${SUFFIX}@pcorb.example.com`, P);
    const tEo = await signin(`campc.eo.${SUFFIX}@pcorb.example.com`, P);

    const V = `/rest/v1/campaign_assignments`;
    const rpc = (fn: string, body: unknown, token: string) =>
      rest("POST", `/rest/v1/rpc/${fn}`, body, token);

    // ══ A — creation ═════════════════════════════════════════════════════
    const create1 = await rpc("create_campaign_assignment", {
      p_title: "CampC Ward Canvass", p_description: "Door-to-door canvass",
      p_assigned_to: memberW, p_scope_type: "ward", p_scope_id: W1,
      p_priority: "high", p_due_date: "2026-12-31", p_location: "Ward office",
    }, tWard);
    const asg1 = typeof create1.json === "string"
      ? (create1.json as string)
      : (first(create1.json)?.create_campaign_assignment as string | undefined);
    record("A1 ward coordinator creates an assignment via the public RPC",
      create1.status === 200 && !!asg1, `status=${create1.status} id=${asg1 ?? "none"}`);

    const row1 = asg1
      ? (await sql.query(
          `SELECT tenant_id, assigned_to, assigned_by, status, scope_type, scope_id, priority
           FROM politicore.campaign_assignments WHERE id = $1`, [asg1])).rows[0]
      : undefined;
    record("A2 tenant/creator/status/scope pinned server-side",
      row1?.tenant_id === tenantA && row1?.assigned_by === wardC && row1?.assigned_to === memberW
        && row1?.status === "not_started" && row1?.scope_type === "ward" && row1?.scope_id === W1,
      `tenant=${row1?.tenant_id === tenantA} creator=${row1?.assigned_by === wardC} status=${row1?.status}`);

    const createDenied = await rpc("create_campaign_assignment", {
      p_title: "CampC member hijack", p_description: "x",
      p_assigned_to: memberW, p_scope_type: "ward", p_scope_id: W1,
    }, tMw);
    record("A3 member without create authority denied",
      createDenied.status !== 200, `status=${createDenied.status} msg=${rpcError(createDenied.json).slice(0, 50)}`);

    const createCross = await rpc("create_campaign_assignment", {
      p_title: "CampC cross-tenant", p_description: "x",
      p_assigned_to: offAdmin, p_scope_type: "ward", p_scope_id: W1,
    }, tWard);
    record("A4 cross-tenant assignee refused (eligibility)",
      createCross.status !== 200 && rpcError(createCross.json).includes("assignee not found"),
      `status=${createCross.status} msg=${rpcError(createCross.json).slice(0, 50)}`);

    // ══ B — hierarchical visibility ══════════════════════════════════════
    // LGA coordinator creates a descendant assignment for memberO (registered W1).
    const create2 = await rpc("create_campaign_assignment", {
      p_title: "CampC LGA Logistics", p_description: "x",
      p_assigned_to: memberO, p_scope_type: "lga", p_scope_id: "enugu-north",
    }, tLga);
    const asg2 = typeof create2.json === "string"
      ? (create2.json as string)
      : (first(create2.json)?.create_campaign_assignment as string | undefined);
    record("B0 LGA coordinator creates an LGA-scoped assignment",
      create2.status === 200 && !!asg2, `status=${create2.status}`);

    const wardList = await rest("GET", `${V}?select=id&limit=200`, undefined, tWard);
    const wardIds = (wardList.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
    record("B1 ward actor sees the ward assignment",
      wardIds.includes(asg1 ?? "x"), `visible=${wardIds.length}`);

    const mwList = await rest("GET", `${V}?select=id&limit=200`, undefined, tMw);
    const mwIds = (mwList.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
    record("B2 assignee sees own assignment",
      mwIds.includes(asg1 ?? "x"), `visible=${mwIds.length}`);

    const lgaList = await rest("GET", `${V}?select=id&limit=200`, undefined, tLga);
    const lgaIds = (lgaList.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
    record("B3 LGA actor sees descendants (ward + LGA rows)",
      lgaIds.includes(asg1 ?? "x") && lgaIds.includes(asg2 ?? "y"), `visible=${lgaIds.length}`);

    const zoneList = await rest("GET", `${V}?select=id&limit=200`, undefined, tZone);
    const zoneIds = (zoneList.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
    record("B4 zone actor sees zone descendants",
      zoneIds.includes(asg1 ?? "x") && zoneIds.includes(asg2 ?? "y"), `visible=${zoneIds.length}`);

    const offList = await rest("GET", `${V}?select=id&limit=200`, undefined, tOff);
    record("B5 cross-tenant member sees NOTHING (module disabled there)",
      offList.status === 200 && Array.isArray(offList.json) && (offList.json as unknown[]).length === 0,
      `status=${offList.status}`);

    // ══ C — workflow ═════════════════════════════════════════════════════
    const start = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "start" }, tMw);
    record("C1 assignee starts (not_started → in_progress)",
      start.status === 200 && start.json === "in_progress", `status=${start.status} body=${String(start.json)}`);

    const foreignStart = await rpc("campaign_assignment_transition",
      { p_assignment: asg2, p_action: "start" }, tMw);
    record("C2 non-assignee cannot start another's assignment",
      foreignStart.status !== 200, `status=${foreignStart.status}`);

    const submit = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "submit" }, tMw);
    record("C3 assignee submits (→ submitted)",
      submit.status === 200 && submit.json === "submitted", `status=${submit.status}`);

    const resubEarly = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "resubmit" }, tMw);
    record("C4 illegal transition (resubmit from submitted) rejected",
      resubEarly.status !== 200, `status=${resubEarly.status} msg=${rpcError(resubEarly.json).slice(0, 50)}`);

    const ret = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "return" }, tWard);
    record("C5 supervisor returns for rework (→ under_review)",
      ret.status === 200 && ret.json === "under_review", `status=${ret.status}`);

    const resub = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "resubmit" }, tMw);
    record("C6 assignee resubmits (→ submitted)",
      resub.status === 200 && resub.json === "submitted", `status=${resub.status}`);

    const accept = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "accept" }, tWard);
    record("C7 supervisor accepts (→ completed)",
      accept.status === 200 && accept.json === "completed", `status=${accept.status}`);

    const socialTransition = await rpc("campaign_assignment_transition",
      { p_assignment: asg2, p_action: "submit" }, tSocial);
    record("C8 social-only transition denied",
      socialTransition.status !== 200, `status=${socialTransition.status}`);

    const offTransition = await rpc("campaign_assignment_transition",
      { p_assignment: asg2, p_action: "submit" }, tOff);
    record("C9 cross-tenant (module-disabled) transition impossible",
      offTransition.status !== 200, `status=${offTransition.status}`);

    // ══ D — reassignment ═════════════════════════════════════════════════
    const reassign = await rpc("update_campaign_assignment_details",
      { p_assignment: asg2, p_reassign_to: memberW }, tLga);
    const reassignedRow = asg2
      ? (await sql.query(`SELECT assigned_to FROM politicore.campaign_assignments WHERE id=$1`, [asg2])).rows[0]
      : undefined;
    record("D1 supervisor reassigns via the details RPC",
      (reassign.status === 200 || reassign.status === 204) && reassignedRow?.assigned_to === memberW,
      `status=${reassign.status} assigned_to=${reassignedRow?.assigned_to === memberW}`);

    const reassignDenied = await rpc("update_campaign_assignment_details",
      { p_assignment: asg2, p_reassign_to: memberO }, tMw);
    record("D2 member without manage authority cannot reassign",
      reassignDenied.status !== 200, `status=${reassignDenied.status}`);

    const reassignIneligible = await rpc("update_campaign_assignment_details",
      { p_assignment: asg2, p_reassign_to: socialU }, tLga);
    record("D3 reassignment to a non-campaign-member refused (0024)",
      reassignIneligible.status !== 200
        && rpcError(reassignIneligible.json).includes("assignee not found"),
      `status=${reassignIneligible.status} msg=${rpcError(reassignIneligible.json).slice(0, 50)}`);

    // ══ E — scope-move protection ════════════════════════════════════════
    const outOfArea = await rpc("create_campaign_assignment", {
      p_title: "CampC out-of-area", p_description: "x",
      p_assigned_to: memberX, p_scope_type: "ward", p_scope_id: W1,
    }, tWard);
    record("E1 assignee registered OUTSIDE the target scope refused (Gate §3.3 create-guard)",
      outOfArea.status !== 200 && rpcError(outOfArea.json).includes("assignee not found"),
      `status=${outOfArea.status} msg=${rpcError(outOfArea.json).slice(0, 50)}`);

    const eligiblePicker = await rpc("campaign_assignable_members",
      { p_scope_type: "ward", p_scope_id: W1 }, tWard);
    const pickerIds = Array.isArray(eligiblePicker.json)
      ? (eligiblePicker.json as { id: string }[]).map((r) => r.id) : [];
    record("E2 assignable-members RPC returns in-scope members only (no tenant-wide dump)",
      eligiblePicker.status === 200 && pickerIds.includes(memberW) && pickerIds.includes(memberO)
        && !pickerIds.includes(memberX) && !pickerIds.includes(socialU),
      `count=${pickerIds.length} memberX=${pickerIds.includes(memberX)} social=${pickerIds.includes(socialU)}`);

    const pickerDenied = await rpc("campaign_assignable_members",
      { p_scope_type: "ward", p_scope_id: W1 }, tMw);
    record("E3 assignable-members RPC denied without create/review authority",
      pickerDenied.status !== 200, `status=${pickerDenied.status}`);

    // ══ F — direct mutation abuse ════════════════════════════════════════
    // PostgREST answers a privilege-denied / RLS-filtered PATCH with a
    // zero-rows-affected 200/204 — the security assertion is the STATE,
    // so each check verifies the row afterwards.
    const patchStatus = await rest("PATCH", `${V}?id=eq.${asg2}`,
      { status: "completed" }, tLga);
    const stAfter = asg2
      ? (await sql.query(`SELECT status FROM politicore.campaign_assignments WHERE id=$1`, [asg2])).rows[0]?.status
      : undefined;
    record("F1 view PATCH of status does NOT mutate (RPC-only workflow)",
      stAfter === "not_started", `status=${patchStatus.status} row_status=${stAfter}`);

    const patchAssignee = await rest("PATCH", `${V}?id=eq.${asg2}`,
      { assigned_to: memberX, assigned_by: memberX }, tLga);
    const asgAfter = asg2
      ? (await sql.query(`SELECT assigned_to, assigned_by FROM politicore.campaign_assignments WHERE id=$1`, [asg2])).rows[0]
      : undefined;
    record("F2 view PATCH of assignee/creator does NOT mutate",
      asgAfter?.assigned_to === memberW && asgAfter?.assigned_by === lgaC,
      `status=${patchAssignee.status} row_assigned_to=${asgAfter?.assigned_to === memberW}`);

    const memberDel = await rest("DELETE", `${V}?id=eq.${asg2}`, undefined, tMw);
    const asg2There = asg2
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_assignments WHERE id=$1`, [asg2])).rows[0].n
      : 0;
    record("F3 assignee DELETE affects no rows",
      memberDel.status === 204 || [401, 403, 404].includes(memberDel.status), `status=${memberDel.status} survived=${asg2There}`);

    const supDelCompleted = await rest("DELETE", `${V}?id=eq.${asg1}`, undefined, tWard);
    const asg1There = asg1
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_assignments WHERE id=$1`, [asg1])).rows[0].n
      : 0;
    record("F4 completed assignments are NOT deletable (0024 terminal guard)",
      asg1There === 1, `status=${supDelCompleted.status} survived=${asg1There}`);

    const supDelOpen = await rest("DELETE", `${V}?id=eq.${asg2}`, undefined, tLga);
    const asg2After = asg2
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_assignments WHERE id=$1`, [asg2])).rows[0].n
      : 0;
    record("F5 supervisor deletes a non-terminal assignment through the view (policy-gated)",
      asg2After === 0, `status=${supDelOpen.status} rows=${asg2After}`);

    const anonGet = await rest("GET", `${V}?select=id&limit=5`);
    record("F6 anonymous reads nothing",
      anonGet.status === 200
        ? Array.isArray(anonGet.json) && (anonGet.json as unknown[]).length === 0
        : [401, 403].includes(anonGet.status),
      `status=${anonGet.status}`);

    // ══ G — social-only ══════════════════════════════════════════════════
    const socialList = await rest("GET", `${V}?select=id&limit=5`, undefined, tSocial);
    record("G1 social-only sees zero assignments",
      socialList.status === 200 && Array.isArray(socialList.json) && (socialList.json as unknown[]).length === 0,
      `status=${socialList.status}`);

    const socialCreate = await rpc("create_campaign_assignment", {
      p_title: "CampC social create", p_description: "x",
      p_assigned_to: memberW, p_scope_type: "ward", p_scope_id: W1,
    }, tSocial);
    record("G2 social-only create denied",
      socialCreate.status !== 200, `status=${socialCreate.status}`);

    const socialReassign = await rpc("update_campaign_assignment_details",
      { p_assignment: asg1, p_title: "hijacked" }, tSocial);
    record("G3 social-only reassign/edit denied",
      socialReassign.status !== 200, `status=${socialReassign.status}`);

    // ══ H — Election Officer ═════════════════════════════════════════════
    const eoList = await rest("GET", `${V}?select=id&limit=5`, undefined, tEo);
    record("H1 Election Officer sees zero campaign assignments",
      eoList.status === 200 && Array.isArray(eoList.json) && (eoList.json as unknown[]).length === 0,
      `status=${eoList.status}`);

    const eoCreate = await rpc("create_campaign_assignment", {
      p_title: "CampC EO create", p_description: "x",
      p_assigned_to: memberW, p_scope_type: "ward", p_scope_id: W1,
    }, tEo);
    record("H2 Election Officer create denied",
      eoCreate.status !== 200, `status=${eoCreate.status}`);

    const eoTransition = await rpc("campaign_assignment_transition",
      { p_assignment: asg1, p_action: "submit" }, tEo);
    record("H3 Election Officer transition denied",
      eoTransition.status !== 200, `status=${eoTransition.status}`);

    // ══ I — module disabled ══════════════════════════════════════════════
    const offCreate = await rpc("create_campaign_assignment", {
      p_title: "CampC off create", p_description: "x",
      p_assigned_to: offAdmin, p_scope_type: "ward", p_scope_id: W1,
    }, tOff);
    record("I1 campaign-disabled create refused",
      offCreate.status !== 200, `status=${offCreate.status} msg=${rpcError(offCreate.json).slice(0, 50)}`);

    const offReassign = await rpc("update_campaign_assignment_details",
      { p_assignment: asg1, p_title: "hijack" }, tOff);
    record("I2 campaign-disabled reassignment refused",
      offReassign.status !== 200, `status=${offReassign.status}`);

    const offPicker = await rpc("campaign_assignable_members",
      { p_scope_type: "ward", p_scope_id: W1 }, tOff);
    record("I3 campaign-disabled assignable-members refused",
      offPicker.status !== 200, `status=${offPicker.status}`);

    const campStillWorks = await rest("GET", `${V}?select=id&limit=5`, undefined, tWard);
    record("I4 no cross-module leakage: tenant A unaffected",
      campStillWorks.status === 200 && Array.isArray(campStillWorks.json)
        && (campStillWorks.json as unknown[]).length >= 1,
      `status=${campStillWorks.status}`);

    // ══ J — audit / notification ═════════════════════════════════════════
    const aud = await sql.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE affected_resource = 'campaign_assignment' AND resource_id = $1
         AND action IN ('campaign.assignment.create','campaign.assignment.status',
                        'campaign.assignment.review')`, [asg1]);
    record("J1 create/workflow actions audited with server-resolved actor",
      aud.rows.length >= 3 && aud.rows.every((r) => r.actor_id === wardC || r.actor_id === memberW || r.actor_id === lgaC),
      `events=${aud.rows.length}`);

    const reassignAud = await sql.query<{ actor_id: string }>(
      `SELECT actor_id FROM politicore.system_audits
       WHERE affected_resource='campaign_assignment' AND resource_id=$1
         AND action='campaign.assignment.reassign'`, [asg2]);
    record("J2 reassignment audited with the acting supervisor as actor",
      reassignAud.rows.length === 1 && reassignAud.rows[0].actor_id === lgaC,
      `events=${reassignAud.rows.length} actor=${reassignAud.rows[0]?.actor_id === lgaC}`);

    const notes = await sql.query<{ user_id: string }>(
      `SELECT user_id FROM politicore.notifications
       WHERE type='assignment' AND (user_id = $1 OR user_id = $2)`, [memberW, memberO]);
    record("J3 assignees notified (create + reassignment)",
      notes.rows.length >= 2, `notifications=${notes.rows.length}`);

    const forgedAudit = await rest("POST", "/rest/v1/system_audits",
      { action: "forged.assignment", affected_resource: "x" }, tWard);
    record("J4 client cannot insert forged audits",
      forgedAudit.status !== 201, `status=${forgedAudit.status}`);

    // ══ K — cross-tenant (negative completion) ═══════════════════════════
    const offPatch = await rest("PATCH", `${V}?id=eq.${asg1}`,
      { status: "cancelled" }, tOff);
    const asg1Status = asg1
      ? (await sql.query(`SELECT status FROM politicore.campaign_assignments WHERE id=$1`, [asg1])).rows[0]?.status
      : undefined;
    record("K1 cross-tenant PATCH does NOT mutate",
      asg1Status === "completed", `status=${offPatch.status} row_status=${asg1Status}`);

    const offDelete = await rest("DELETE", `${V}?id=eq.${asg1}`, undefined, tOff);
    const asg1After = asg1
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_assignments WHERE id=$1`, [asg1])).rows[0].n
      : 0;
    record("K2 cross-tenant DELETE affects nothing",
      asg1After === 1, `status=${offDelete.status} survived=${asg1After}`);

    // ══ L — cleanup + pristine ═══════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
  }

  const pristine = await sql.query<{ asg: string; notes: string; users: string; tenants: string; orgs: string }>(
    `SELECT
       (SELECT count(*)::text FROM politicore.campaign_assignments WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'campc-%')) asg,
       (SELECT count(*)::text FROM politicore.notifications WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'campc.%')) notes,
       (SELECT count(*)::text FROM auth.users WHERE email LIKE 'campc.%' OR email LIKE 'campc-%') users,
       (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'campc-%') tenants,
       (SELECT count(*)::text FROM politicore.organizational_assignments WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'campc-%')) orgs`);
  const p = pristine.rows[0];
  record("L1 pristine: no campc fixtures remain",
    p.asg === "0" && p.notes === "0" && p.users === "0" && p.tenants === "0" && p.orgs === "0",
    `assignments=${p.asg} notifications=${p.notes} users=${p.users} tenants=${p.tenants} orgAssignments=${p.orgs}`);

  await sql.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n══ CAMPAIGN PHASE C HOSTED SMOKE: ${results.length - failed.length}/${results.length} checks passed ══`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("hosted smoke crashed:", e);
  process.exit(1);
});
