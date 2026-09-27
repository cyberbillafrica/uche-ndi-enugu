/**
 * POLITICORE — Campaign Phase D HOSTED ACCEPTANCE (Field Reports + Issues).
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real RPCs
 * through the 0025 public wrappers. Full fixture cleanup with pristine
 * verification (§31–32 A–O).
 *
 * Journeys:
 *   A — report submission via the public RPC; server-pinned actor/tenant/
 *       status; submission audited (0025); unscoped submitter denied
 *   B — report hierarchy: PU author sees own, not ancestor rows; ward/LGA/
 *       zone see descendants; sibling/unrelated silent; cross-tenant empty
 *   C — report workflow: return → resubmit → accept; invalid transitions
 *       rejected; self-approval banned
 *   D — review authorization: unauthorized/out-of-tenant/social/EO denied
 *   E — issue creation through the view; reporter/status/tenant pinned;
 *       unscoped member denied; reporter spoof refused
 *   F — issue assignment: eligible member assigned; non-manager denied;
 *       out-of-area + social assignees refused (0025 eligibility)
 *   G — issue lifecycle: acknowledge → start → resolve → verify → close
 *       with distinct resolver/verifier/closer actors; invalid refused
 *   H — direct PostgREST abuse: report/issue PATCH + DELETE + status/
 *       actor spoofs — no workflow bypass (state asserted)
 *   I — module disabled: reads empty, submissions/transitions refused
 *   J — social-only: zero visibility, zero authority
 *   K — Election Officer: no Campaign report/issue authority
 *   L — audit: submission/review/resubmit/assign/status with
 *       server-resolved actors; forged audit INSERT denied
 *   M — notifications: reporter + assignee notified, tenant-owned
 *   N — cross-tenant: silence, PATCH/DELETE no-ops
 *   O — cleanup + pristine verification
 *
 * Secrets are read from .env.local and never printed. Results are HOSTED.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

// ── env + REST helpers (Phase B/C pattern) ───────────────────────────────────
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
function rpcError(json: unknown): string {
  const j = json as { message?: string; error?: string };
  return j?.message ?? j?.error ?? JSON.stringify(json).slice(0, 140);
}
function first(json: unknown): Record<string, unknown> | null {
  const j = Array.isArray(json) ? json[0] : json;
  return (j && typeof j === "object" ? j : null) as Record<string, unknown> | null;
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
    console.error("cleanup incomplete — remove campd fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Campd-Smoke!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: tenants + real users + real Enugu geography ════════════
    const E = `campd-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampD Smoke A", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'campaign', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampD Smoke B (campaign off)", `campd-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB); // no campaign module row ⇒ disabled

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`campd.admin.${SUFFIX}@pcorb.example.com`, "CampD Admin", E);
    const wardC = await mk(`campd.ward.${SUFFIX}@pcorb.example.com`, "CampD Ward Coord", E);
    const lgaC = await mk(`campd.lga.${SUFFIX}@pcorb.example.com`, "CampD LGA Coord", E);
    const zoneC = await mk(`campd.zone.${SUFFIX}@pcorb.example.com`, "CampD Zone Coord", E);
    const memberW = await mk(`campd.mw.${SUFFIX}@pcorb.example.com`, "CampD Member W (PU reporter)", E);
    const memberO = await mk(`campd.mo.${SUFFIX}@pcorb.example.com`, "CampD Member O", E);
    const memberX = await mk(`campd.mx.${SUFFIX}@pcorb.example.com`, "CampD Member X (sibling ward)", E);
    const socialU = await mk(`campd.social.${SUFFIX}@pcorb.example.com`, "CampD Social", E);
    const offAdmin = await mk(`campd.adminB.${SUFFIX}@pcorb.example.com`, "CampD Admin B", `campd-off-${SUFFIX}`);
    const electionOfficer = await mk(`campd.eo.${SUFFIX}@pcorb.example.com`, "CampD Election Officer", E);

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

    // memberW: campaign member with a PU organizational assignment (reporter).
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}',
           ward_id = $2, lga_id = 'enugu-north', polling_unit_id = $3
       WHERE id = $1`, [memberW, W1, PU1]);
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}', ward_id = $2, lga_id = 'enugu-north'
       WHERE id = $1`, [memberO, W1]);
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}', ward_id = $2, lga_id = 'enugu-north'
       WHERE id = $1`, [memberX, W2]); // eligible member, WRONG area for W1/PU1 work
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}', ward_id = $2, lga_id = 'enugu-north'
       WHERE id = $1`, [wardC, W1]);

    await sql.query(
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1,$2,'campaign_member','polling_unit',$3),
              ($1,$4,'ward_coordinator','ward',$5),
              ($1,$6,'lga_coordinator','lga','enugu-north'),
              ($1,$7,'zone_coordinator','senatorial_zone',$8)`,
      [tenantA, memberW, PU1, wardC, W1, lgaC, zoneC, ZONE]);

    const tWard = await signin(`campd.ward.${SUFFIX}@pcorb.example.com`, P);
    const tLga = await signin(`campd.lga.${SUFFIX}@pcorb.example.com`, P);
    const tZone = await signin(`campd.zone.${SUFFIX}@pcorb.example.com`, P);
    const tMw = await signin(`campd.mw.${SUFFIX}@pcorb.example.com`, P);
    const tSocial = await signin(`campd.social.${SUFFIX}@pcorb.example.com`, P);
    const tOff = await signin(`campd.adminB.${SUFFIX}@pcorb.example.com`, P);
    const tEo = await signin(`campd.eo.${SUFFIX}@pcorb.example.com`, P);

    const RP = `/rest/v1/campaign_field_reports`;
    const IS = `/rest/v1/campaign_issues`;
    const rpc = (fn: string, body: unknown, token: string) =>
      rest("POST", `/rest/v1/rpc/${fn}`, body, token);

    // ══ A — report submission ════════════════════════════════════════════
    const sub = await rpc("submit_campaign_report", {
      p_report_type: "field", p_title: "CampD PU ground truth",
      p_description: "Mobilization status at the PU",
      p_scope_type: "polling_unit", p_scope_id: PU1,
    }, tMw);
    const rep1 = typeof sub.json === "string"
      ? (sub.json as string)
      : ((sub.json as Record<string, unknown> | null)?.submit_campaign_report as string | undefined);
    record("A1 PU-authorized member submits a field report via the public RPC",
      sub.status === 200 && !!rep1, `status=${sub.status} id=${rep1 ?? "none"}`);

    const row1 = rep1
      ? (await sql.query(
          `SELECT tenant_id, submitted_by, status, scope_type, scope_id
           FROM politicore.campaign_field_reports WHERE id = $1`, [rep1])).rows[0]
      : undefined;
    record("A2 tenant/reporter/status/scope pinned server-side",
      row1?.tenant_id === tenantA && row1?.submitted_by === memberW
        && row1?.status === "submitted" && row1?.scope_type === "polling_unit" && row1?.scope_id === PU1,
      `tenant=${row1?.tenant_id === tenantA} reporter=${row1?.submitted_by === memberW} status=${row1?.status}`);

    const unscoped = await rpc("submit_campaign_report", {
      p_report_type: "field", p_title: "CampD hijack", p_description: "x",
      p_scope_type: "ward", p_scope_id: W1,
    }, tSocial);
    record("A3 social-only submission denied",
      unscoped.status !== 200, `status=${unscoped.status} msg=${rpcError(unscoped.json).slice(0, 50)}`);

    // ══ B — report hierarchy ═════════════════════════════════════════════
    const sub2 = await rpc("submit_campaign_report", {
      p_report_type: "field", p_title: "CampD ward report", p_description: "x",
      p_scope_type: "ward", p_scope_id: W1,
    }, tWard);
    const rep2 = typeof sub2.json === "string" ? (sub2.json as string) : undefined;
    record("B0 ward coordinator submits a ward-scoped report",
      sub2.status === 200 && !!rep2, `status=${sub2.status}`);

    const mwList = await rest("GET", `${RP}?select=id&limit=200`, undefined, tMw);
    const mwIds = (mwList.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
    record("B1 PU reporter sees own report but NOT the ancestor ward row",
      mwIds.includes(rep1 ?? "x") && !mwIds.includes(rep2 ?? "y"), `visible=${mwIds.length}`);

    for (const [label, tok] of [["ward", tWard], ["LGA", tLga], ["zone", tZone]] as const) {
      const lst = await rest("GET", `${RP}?select=id&limit=200`, undefined, tok);
      const ids = (lst.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
      record(`B2 ${label} authority sees descendant reports`,
        ids.includes(rep1 ?? "x") && ids.includes(rep2 ?? "y"), `visible=${ids.length}`);
    }

    const xList = await rest("GET", `${RP}?select=id&limit=200`,
      undefined, await signin(`campd.mx.${SUFFIX}@pcorb.example.com`, P));
    record("B3 member without organizational scope sees nothing",
      xList.status === 200 && Array.isArray(xList.json) && (xList.json as unknown[]).length === 0,
      `status=${xList.status}`);

    const offList = await rest("GET", `${RP}?select=id&limit=200`, undefined, tOff);
    record("B4 cross-tenant (module disabled) sees NOTHING",
      offList.status === 200 && Array.isArray(offList.json) && (offList.json as unknown[]).length === 0,
      `status=${offList.status}`);

    // ══ C — report workflow ══════════════════════════════════════════════
    const earlyResub = await rpc("resubmit_campaign_report",
      { p_report: rep1, p_description: "too early" }, tMw);
    record("C1 illegal resubmit (from submitted) rejected",
      earlyResub.status !== 200 && rpcError(earlyResub.json).includes("invalid transition: resubmit from submitted"),
      `status=${earlyResub.status} msg=${rpcError(earlyResub.json).slice(0, 50)}`);

    const ret = await rpc("review_campaign_report",
      { p_report: rep1, p_action: "return", p_comment: "needs detail" }, tWard);
    record("C2 reviewer returns the report (→ returned)",
      ret.status === 200 && ret.json === "returned", `status=${ret.status} body=${String(ret.json)}`);

    const resub = await rpc("resubmit_campaign_report",
      { p_report: rep1, p_description: "revised with detail" }, tMw);
    const afterResub = rep1
      ? (await sql.query(
          `SELECT status, reviewed_by, description FROM politicore.campaign_field_reports WHERE id=$1`,
          [rep1])).rows[0]
      : undefined;
    record("C3 submitter resubmits; review state cleared",
      (resub.status === 200 || resub.status === 204) && afterResub?.status === "submitted"
        && afterResub?.reviewed_by === null && afterResub?.description === "revised with detail",
      `status=${resub.status} (void RPC ⇒ 204) row_status=${afterResub?.status}`);

    const accept = await rpc("review_campaign_report",
      { p_report: rep1, p_action: "accept" }, tWard);
    record("C4 reviewer accepts (→ accepted)",
      accept.status === 200 && accept.json === "accepted", `status=${accept.status}`);

    const lateReturn = await rpc("review_campaign_report",
      { p_report: rep1, p_action: "return" }, tLga);
    record("C5 return from accepted is an invalid transition",
      lateReturn.status !== 200 && rpcError(lateReturn.json).includes("invalid transition: return from accepted"),
      `status=${lateReturn.status} msg=${rpcError(lateReturn.json).slice(0, 50)}`);

    // ══ D — review authorization ═════════════════════════════════════════
    const memberReview = await rpc("review_campaign_report",
      { p_report: rep2, p_action: "accept" }, tMw);
    record("D1 member without review permission denied",
      memberReview.status !== 200 && rpcError(memberReview.json).includes("not authorized to review"),
      `status=${memberReview.status}`);

    const socialReview = await rpc("review_campaign_report",
      { p_report: rep2, p_action: "accept" }, tSocial);
    record("D2 social-only review denied",
      socialReview.status !== 200, `status=${socialReview.status}`);

    const eoReview = await rpc("review_campaign_report",
      { p_report: rep2, p_action: "accept" }, tEo);
    record("D3 Election Officer review denied",
      eoReview.status !== 200, `status=${eoReview.status}`);

    const offReview = await rpc("review_campaign_report",
      { p_report: rep2, p_action: "accept" }, tOff);
    record("D4 out-of-tenant review impossible (module gate / report not found)",
      offReview.status !== 200
        && (rpcError(offReview.json).includes("report not found")
            || rpcError(offReview.json).includes("campaign module is not enabled")),
      `status=${offReview.status} (hosted maps PG exceptions ⇒ 400) msg=${rpcError(offReview.json).slice(0, 60)}`);

    // self-approval: wardC submits at own scope, then reviews own report.
    const selfSub = await rpc("submit_campaign_report", {
      p_report_type: "field", p_title: "CampD self", p_description: "x",
      p_scope_type: "ward", p_scope_id: W1,
    }, tWard);
    const selfRep = typeof selfSub.json === "string" ? (selfSub.json as string) : undefined;
    const selfReview = selfRep
      ? await rpc("review_campaign_report", { p_report: selfRep, p_action: "accept" }, tWard)
      : { status: 0, json: null as unknown };
    record("D5 self-approval banned",
      selfReview.status !== 200 && rpcError(selfReview.json).includes("self-approval is not permitted"),
      `status=${selfReview.status}`);

    // ══ E — issue creation ═══════════════════════════════════════════════
    const mkIssue = await rest("POST", IS, {
      title: "CampD broken generator", description: "No fuel at the PU",
      issue_type: "logistics", scope_type: "polling_unit", scope_id: PU1,
    }, tMw);
    const iss1 = first(mkIssue.json)?.id as string | undefined;
    record("E1 member reports an issue through the view (201)",
      mkIssue.status === 201 && !!iss1, `status=${mkIssue.status} id=${iss1 ?? "none"}`);

    const issRow = iss1
      ? (await sql.query(
          `SELECT tenant_id, reported_by, status, scope_type, scope_id
           FROM politicore.campaign_issues WHERE id = $1`, [iss1])).rows[0]
      : undefined;
    record("E2 reporter/status/tenant/scope pinned server-side",
      issRow?.tenant_id === tenantA && issRow?.reported_by === memberW
        && issRow?.status === "reported" && issRow?.scope_id === PU1,
      `reporter=${issRow?.reported_by === memberW} status=${issRow?.status}`);

    const xIssue = await rest("POST", IS, {
      title: "CampD unscoped", description: "x",
      issue_type: "other", scope_type: "ward", scope_id: W1,
    }, await signin(`campd.mx.${SUFFIX}@pcorb.example.com`, P));
    record("E3 member without organizational scope cannot report an issue",
      xIssue.status !== 201, `status=${xIssue.status}`);

    const spoofIssue = await rest("POST", IS, {
      title: "CampD spoof", description: "x", issue_type: "other",
      scope_type: "polling_unit", scope_id: PU1, reported_by: adminA, status: "closed",
    }, tMw);
    record("E4 reporter/status spoof refused",
      spoofIssue.status !== 201, `status=${spoofIssue.status}`);

    // ══ F — issue assignment ═════════════════════════════════════════════
    const ack = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "acknowledge" }, tWard);
    record("F1 manager acknowledges the issue (→ acknowledged)",
      ack.status === 200 && ack.json === "acknowledged", `status=${ack.status}`);

    const assign = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "assign", p_assignee: memberW }, tWard);
    record("F2 manager assigns an eligible campaign member (→ assigned)",
      assign.status === 200 && assign.json === "assigned", `status=${assign.status}`);

    const memberAssign = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "assign", p_assignee: memberO }, tMw);
    record("F3 non-manager assignment denied",
      memberAssign.status !== 200, `status=${memberAssign.status}`);

    const outOfArea = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "assign", p_assignee: memberX }, tWard);
    record("F4 out-of-area assignee refused (0025 eligibility)",
      outOfArea.status !== 200 && rpcError(outOfArea.json).includes("assignee not found"),
      `status=${outOfArea.status} msg=${rpcError(outOfArea.json).slice(0, 50)}`);

    const socialAssignee = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "assign", p_assignee: socialU }, tWard);
    record("F5 social-only assignee refused",
      socialAssignee.status !== 200, `status=${socialAssignee.status}`);

    const offAssign = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "assign", p_assignee: offAdmin }, tWard);
    record("F6 cross-tenant assignee refused",
      offAssign.status !== 200, `status=${offAssign.status}`);

    // ══ G — issue lifecycle ══════════════════════════════════════════════
    const earlyVerify = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "verify" }, tWard);
    record("G1 verify before resolve is an invalid transition",
      earlyVerify.status !== 200 && rpcError(earlyVerify.json).includes("invalid transition: verify from assigned"),
      `status=${earlyVerify.status} msg=${rpcError(earlyVerify.json).slice(0, 50)}`);

    const start = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "start" }, tMw);
    record("G2 assignee starts work (→ in_progress)",
      start.status === 200 && start.json === "in_progress", `status=${start.status}`);

    const foreignStart = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "start" }, tSocial);
    record("G3 non-assignee start denied",
      foreignStart.status !== 200, `status=${foreignStart.status}`);

    const resolve = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "resolve", p_notes: "generator refueled" }, tMw);
    record("G4 assignee resolves with notes (→ resolved)",
      resolve.status === 200 && resolve.json === "resolved", `status=${resolve.status}`);

    const verify = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "verify" }, tWard);
    record("G5 manager verifies (→ verified)",
      verify.status === 200 && verify.json === "verified", `status=${verify.status}`);

    const close = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "close" }, tWard);
    record("G6 manager closes (→ closed)",
      close.status === 200 && close.json === "closed", `status=${close.status}`);

    const issFinal = iss1
      ? (await sql.query(
          `SELECT resolved_by, verified_by, closed_by, resolution_notes, status
           FROM politicore.campaign_issues WHERE id=$1`, [iss1])).rows[0]
      : undefined;
    record("G7 resolver/verifier/closer are distinct, server-resolved actors",
      issFinal?.resolved_by === memberW && issFinal?.verified_by === wardC
        && issFinal?.closed_by === wardC && issFinal?.resolution_notes === "generator refueled"
        && issFinal?.status === "closed",
      `resolved=${issFinal?.resolved_by === memberW} verified=${issFinal?.verified_by === wardC}`);

    // ══ H — direct PostgREST abuse ═══════════════════════════════════════
    const rep2StatusBefore = rep2
      ? (await sql.query(`SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [rep2])).rows[0]?.status
      : undefined;
    const repPatch = await rest("PATCH", `${RP}?id=eq.${rep2}`,
      { status: "accepted", reviewed_by: lgaC }, tLga);
    const rep2StatusAfter = rep2
      ? (await sql.query(`SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [rep2])).rows[0]?.status
      : undefined;
    record("H1 report PATCH of status/reviewer does NOT mutate (RPC-only workflow)",
      rep2StatusBefore === rep2StatusAfter && rep2StatusAfter === "submitted",
      `status=${repPatch.status} row_status=${rep2StatusAfter}`);

    const repDel = await rest("DELETE", `${RP}?id=eq.${rep2}`, undefined, tWard);
    const rep2There = rep2
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_field_reports WHERE id=$1`, [rep2])).rows[0].n
      : 0;
    record("H2 report DELETE affects no rows",
      rep2There === 1, `status=${repDel.status} survived=${rep2There}`);

    const issPatch = await rest("PATCH", `${IS}?id=eq.${iss1}`,
      { status: "reported", assigned_to: memberX, reported_by: memberX }, tWard);
    const issAfter = iss1
      ? (await sql.query(
          `SELECT status, assigned_to, reported_by FROM politicore.campaign_issues WHERE id=$1`, [iss1])).rows[0]
      : undefined;
    record("H3 issue PATCH of status/assignee/reporter does NOT mutate",
      issAfter?.status === "closed" && issAfter?.assigned_to === memberW && issAfter?.reported_by === memberW,
      `status=${issPatch.status} row_status=${issAfter?.status}`);

    const issDel = await rest("DELETE", `${IS}?id=eq.${iss1}`, undefined, tWard);
    const issThere = iss1
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_issues WHERE id=$1`, [iss1])).rows[0].n
      : 0;
    record("H4 issue DELETE affects no rows",
      issThere === 1, `status=${issDel.status} survived=${issThere}`);

    const repInsertSpoof = await rest("POST", RP, {
      submitted_by: adminA, title: "spoof", description: "x",
      report_type: "field", scope_type: "ward", scope_id: W1, status: "accepted",
    }, tWard);
    record("H5 direct report INSERT (any fields) is privilege-denied",
      repInsertSpoof.status !== 201, `status=${repInsertSpoof.status}`);

    const anonGet = await rest("GET", `${RP}?select=id&limit=5`);
    record("H6 anonymous reads nothing",
      anonGet.status === 200
        ? Array.isArray(anonGet.json) && (anonGet.json as unknown[]).length === 0
        : [401, 403].includes(anonGet.status),
      `status=${anonGet.status}`);

    // ══ I — module disabled ══════════════════════════════════════════════
    const offSub = await rpc("submit_campaign_report", {
      p_report_type: "field", p_title: "CampD off", p_description: "x",
      p_scope_type: "ward", p_scope_id: W1,
    }, tOff);
    record("I1 campaign-disabled report submission refused",
      offSub.status !== 200 && rpcError(offSub.json).includes("campaign module is not enabled"),
      `status=${offSub.status} msg=${rpcError(offSub.json).slice(0, 50)}`);

    const offTransition = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "acknowledge" }, tOff);
    record("I2 campaign-disabled issue transition refused",
      offTransition.status !== 200, `status=${offTransition.status}`);

    const offIssList = await rest("GET", `${IS}?select=id&limit=5`, undefined, tOff);
    record("I3 campaign-disabled issue reads are empty",
      offIssList.status === 200 && Array.isArray(offIssList.json) && (offIssList.json as unknown[]).length === 0,
      `status=${offIssList.status}`);

    // ══ J — social-only ══════════════════════════════════════════════════
    const socialR = await rest("GET", `${RP}?select=id&limit=5`, undefined, tSocial);
    const socialI = await rest("GET", `${IS}?select=id&limit=5`, undefined, tSocial);
    record("J1 social-only sees zero reports and zero issues",
      socialR.status === 200 && (socialR.json as unknown[]).length === 0
        && socialI.status === 200 && (socialI.json as unknown[]).length === 0,
      `reports=${JSON.stringify(socialR.json).length < 60 ? JSON.stringify(socialR.json) : "non-empty"} issues=${JSON.stringify(socialI.json).length < 60 ? JSON.stringify(socialI.json) : "non-empty"}`);

    const socialIssue = await rest("POST", IS, {
      title: "CampD social issue", description: "x",
      issue_type: "other", scope_type: "ward", scope_id: W1,
    }, tSocial);
    record("J2 social-only issue creation denied",
      socialIssue.status !== 201, `status=${socialIssue.status}`);

    // ══ K — Election Officer ═════════════════════════════════════════════
    const eoR = await rest("GET", `${RP}?select=id&limit=5`, undefined, tEo);
    const eoI = await rest("GET", `${IS}?select=id&limit=5`, undefined, tEo);
    record("K1 Election Officer sees zero campaign reports/issues",
      eoR.status === 200 && (eoR.json as unknown[]).length === 0
        && eoI.status === 200 && (eoI.json as unknown[]).length === 0,
      `status=${eoR.status}/${eoI.status}`);

    const eoSub = await rpc("submit_campaign_report", {
      p_report_type: "field", p_title: "CampD EO", p_description: "x",
      p_scope_type: "ward", p_scope_id: W1,
    }, tEo);
    record("K2 Election Officer submission denied",
      eoSub.status !== 200, `status=${eoSub.status}`);

    const eoTransition = await rpc("campaign_issue_transition",
      { p_issue: iss1, p_action: "acknowledge" }, tEo);
    record("K3 Election Officer issue transition denied",
      eoTransition.status !== 200, `status=${eoTransition.status}`);

    // ══ L — audit ════════════════════════════════════════════════════════
    const repAud = await sql.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE affected_resource = 'campaign_field_report' AND resource_id = $1
         AND action IN ('campaign.report.submit','campaign.report.review','campaign.report.resubmit')
       ORDER BY id`, [rep1]);
    const repActs = repAud.rows.map((r) => r.action);
    record("L1 report submission/review/resubmit audited (0025) with server-resolved actors",
      repActs.includes("campaign.report.submit") && repActs.includes("campaign.report.review")
        && repActs.includes("campaign.report.resubmit")
        && repAud.rows.every((r) => r.actor_id === memberW || r.actor_id === wardC),
      `events=${repAud.rows.length}`);

    const issAud = await sql.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE affected_resource = 'campaign_issue' AND resource_id = $1
         AND action IN ('campaign.issue.assign','campaign.issue.status')
       ORDER BY id`, [iss1]);
    record("L2 issue assign/status audited with the acting actors",
      issAud.rows.some((r) => r.action === "campaign.issue.assign" && r.actor_id === wardC)
        && issAud.rows.some((r) => r.action === "campaign.issue.status" && r.actor_id === memberW),
      `events=${issAud.rows.length}`);

    const forgedAudit = await rest("POST", "/rest/v1/system_audits",
      { action: "forged.report", affected_resource: "x" }, tWard);
    record("L3 client cannot insert forged audits",
      forgedAudit.status !== 201, `status=${forgedAudit.status}`);

    // ══ M — notifications ════════════════════════════════════════════════
    const notes = await sql.query<{ user_id: string; tenant_id: string }>(
      `SELECT user_id, tenant_id FROM politicore.notifications
       WHERE type = 'assignment' AND (user_id = $1 OR user_id = $2)`, [memberW, memberO]);
    record("M1 reporter and assignee notified inside their own tenant",
      notes.rows.length >= 2 && notes.rows.every((r) => r.tenant_id === tenantA),
      `notifications=${notes.rows.length}`);

    // ══ N — cross-tenant ═════════════════════════════════════════════════
    const offPatch = await rest("PATCH", `${RP}?id=eq.${rep1}`,
      { status: "returned" }, tOff);
    const rep1Status = rep1
      ? (await sql.query(`SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [rep1])).rows[0]?.status
      : undefined;
    record("N1 cross-tenant report PATCH does NOT mutate",
      rep1Status === "accepted", `status=${offPatch.status} row_status=${rep1Status}`);

    const offDelete = await rest("DELETE", `${IS}?id=eq.${iss1}`, undefined, tOff);
    const issAfterCross = iss1
      ? (await sql.query(`SELECT count(*)::int n FROM politicore.campaign_issues WHERE id=$1`, [iss1])).rows[0].n
      : 0;
    record("N2 cross-tenant issue DELETE affects nothing",
      issAfterCross === 1, `status=${offDelete.status} survived=${issAfterCross}`);

    // ══ O — cleanup + pristine ═══════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
  }

  const pristine = await sql.query<{ rep: string; iss: string; notes: string; users: string; tenants: string; orgs: string }>(
    `SELECT
       (SELECT count(*)::text FROM politicore.campaign_field_reports WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'campd%')) rep,
       (SELECT count(*)::text FROM politicore.campaign_issues WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'campd%')) iss,
       (SELECT count(*)::text FROM politicore.notifications WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'campd.%')) notes,
       (SELECT count(*)::text FROM auth.users WHERE email LIKE 'campd.%' OR email LIKE 'campd-%') users,
       (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'campd%') tenants,
       (SELECT count(*)::text FROM politicore.organizational_assignments WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'campd%')) orgs`);
  const p = pristine.rows[0];
  record("O1 pristine: no campd fixtures remain",
    p.rep === "0" && p.iss === "0" && p.notes === "0" && p.users === "0" && p.tenants === "0" && p.orgs === "0",
    `reports=${p.rep} issues=${p.iss} notifications=${p.notes} users=${p.users} tenants=${p.tenants} orgAssignments=${p.orgs}`);

  await sql.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n══ CAMPAIGN PHASE D HOSTED SMOKE: ${results.length - failed.length}/${results.length} checks passed ══`);
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
