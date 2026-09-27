/**
 * POLITICORE — Campaign Phase B HOSTED ACCEPTANCE (Campaign Activities).
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real RPCs.
 * Full fixture cleanup with pristine verification (§19 A–J).
 *
 * Journeys:
 *   A — authorized member: visibility, creation, tenant/creator pinning
 *   B — scope: ward→PU inheritance, sibling denial, LGA/zone breadth,
 *       zone exclusion, cross-tenant silence
 *   C — management: edit RPC (unauthorized denied), status transitions,
 *       invalid transition rejected
 *   D — RSVP: join, persist, upsert (no duplicate), another-user denial
 *   E — attendance: supervisor records (recorder server-resolved),
 *       self-check-in denied, unauthorized recorder denied
 *   F — module boundary: campaign disabled ⇒ reads empty, RPC refusal
 *   G — direct API abuse: public-view INSERT/UPDATE/DELETE via PostgREST
 *   H — audit: authority actions produce system_audits rows
 *   I — notification: organizer notified on status change
 *   J — cleanup + pristine verification
 *
 * Secrets are read from .env.local and never printed. Results are HOSTED.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

// ── env + REST helpers ───────────────────────────────────────────────────────
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

// ── SQL-seeded GoTrue-compatible auth user (Phase 1B/2 verified recipe) ─────
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

// ── cleanup (FORCE-RLS-aware, exact-state restoration) ───────────────────────
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
        if (t === "tenants") continue; // tenants deleted explicitly below (id, not tenant_id)
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
    console.error("cleanup incomplete — remove campb fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Campb-Smoke!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: tenants + real users + geography ═══════════════════════
    const E = `campb-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampB Smoke A", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'campaign', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampB Smoke B (campaign off)", `campb-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB); // no campaign module row ⇒ disabled

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`campb.admin.${SUFFIX}@pcorb.example.com`, "CampB Admin", E);
    const wardC = await mk(`campb.ward.${SUFFIX}@pcorb.example.com`, "CampB Ward Coord", E);
    const lgaC = await mk(`campb.lga.${SUFFIX}@pcorb.example.com`, "CampB LGA Coord", E);
    const zoneC = await mk(`campb.zone.${SUFFIX}@pcorb.example.com`, "CampB Zone Coord", E);
    const puU = await mk(`campb.pu.${SUFFIX}@pcorb.example.com`, "CampB PU User", E);
    const memberW = await mk(`campb.mw.${SUFFIX}@pcorb.example.com`, "CampB Member W", E);
    const memberO = await mk(`campb.mo.${SUFFIX}@pcorb.example.com`, "CampB Member O", E);
    const socialU = await mk(`campb.social.${SUFFIX}@pcorb.example.com`, "CampB Social", E);
    const adminB = await mk(`campb.adminB.${SUFFIX}@pcorb.example.com`, "CampB Admin B", `campb-off-${SUFFIX}`);

    // profiles are auto-backfilled from auth.users (0010/0011) — update shapes.
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminB]);
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialU]);
    await sql.query(
      `UPDATE politicore.profiles
       SET membership_types = '{campaign_member}',
           ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1)
       WHERE id IN ($1,$2,$3)`, [wardC, memberW, memberO]);

    // geography + zone-of-LGA resolution (0013-corrected; never assume by name)
    const geo = await sql.query<{ w1: string; pu1: string; pu2: string; w2: string; zone: string }>(
      `SELECT
         (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) w1,
         (SELECT id FROM politicore.polling_units WHERE ward_id=(SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code LIMIT 1) pu1,
         (SELECT id FROM politicore.polling_units WHERE ward_id=(SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code OFFSET 1 LIMIT 1) pu2,
         (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code OFFSET 1 LIMIT 1) w2,
         (SELECT zone_id FROM politicore.lgas WHERE id='enugu-north') zone`);
    const { w1: W1, pu1: PU1, pu2: PU2, w2: W2, zone: ZONE } = geo.rows[0];
    if (!W1 || !PU1 || !PU2 || !W2 || !ZONE) throw new Error("geography fixture lookup failed");

    await sql.query(
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1,$2,'ward_coordinator','ward',$3),
              ($1,$4,'lga_coordinator','lga','enugu-north'),
              ($1,$5,'zone_coordinator','senatorial_zone',$6),
              ($1,$7,'campaign_member','polling_unit',$8)`,
      [tenantA, wardC, W1, lgaC, zoneC, ZONE, puU, PU1]);

    const tWard = await signin(`campb.ward.${SUFFIX}@pcorb.example.com`, P);
    const tLga = await signin(`campb.lga.${SUFFIX}@pcorb.example.com`, P);
    const tZone = await signin(`campb.zone.${SUFFIX}@pcorb.example.com`, P);
    const tPu = await signin(`campb.pu.${SUFFIX}@pcorb.example.com`, P);
    const tMw = await signin(`campb.mw.${SUFFIX}@pcorb.example.com`, P);
    const tMo = await signin(`campb.mo.${SUFFIX}@pcorb.example.com`, P);
    const tSocial = await signin(`campb.social.${SUFFIX}@pcorb.example.com`, P);
    const tB = await signin(`campb.adminB.${SUFFIX}@pcorb.example.com`, P);

    const V = `/rest/v1/campaign_activities`;
    const VP = `/rest/v1/campaign_activity_participants`;
    const start = new Date(Date.now() + 86_400_000).toISOString();

    // ══ A — authorized member: visibility + creation ═════════════════════
    const insWard = await rest("POST", V, {
      title: "CampB Ward Rally", activity_type: "rally",
      scheduled_start: start, scope_type: "ward", scope_id: W1,
    }, tWard);
    const actWard = first(insWard.json)?.id as string | undefined;
    record("A1 ward coordinator creates a ward activity via the public API",
      insWard.status === 201 && !!actWard,
      `status=${insWard.status} id=${actWard ?? "none"}`);
    const aRow = first(insWard.json);
    record("A2 tenant/creator/status pinned server-side",
      aRow?.tenant_id === tenantA && aRow?.created_by === wardC
        && aRow?.status === "scheduled" && aRow?.organizer_id === wardC,
      `tenant=${aRow?.tenant_id === tenantA} creator=${aRow?.created_by === wardC} status=${aRow?.status}`);

    const insLga = await rest("POST", V, {
      title: "CampB LGA Town Hall", activity_type: "meeting",
      scheduled_start: start, scope_type: "lga", scope_id: "enugu-north",
    }, tLga);
    const actLga = first(insLga.json)?.id as string | undefined;
    record("A3 LGA coordinator creates an LGA activity", insLga.status === 201 && !!actLga,
      `status=${insLga.status}`);

    const insPuDenied = await rest("POST", V, {
      title: "CampB PU Hijack", activity_type: "meeting",
      scheduled_start: start, scope_type: "ward", scope_id: W2,
    }, tPu);
    record("A4 PU authority cannot create outside its PU", insPuDenied.status === 403,
      `status=${insPuDenied.status}`);

    const listWard = await rest("GET", `${V}?select=id&limit=200`, undefined, tWard);
    record("A5 scoped listing returns the created activity (RLS scope)",
      listWard.status === 200 && Array.isArray(listWard.json)
        && (listWard.json as { id: string }[]).some((r) => r.id === actWard),
      `status=${listWard.status}`);

    // ══ B — scope hierarchy ══════════════════════════════════════════════
    const insPu = await rest("POST", V, {
      title: "CampB PU Meeting", activity_type: "meeting",
      scheduled_start: start, scope_type: "polling_unit", scope_id: PU1,
    }, tPu);
    const actPu = first(insPu.json)?.id as string | undefined;
    record("B0 PU authority creates within its PU", insPu.status === 201 && !!actPu,
      `status=${insPu.status}`);

    const insW2 = await rest("POST", V, {
      title: "CampB Sibling Ward", activity_type: "meeting",
      scheduled_start: start, scope_type: "ward", scope_id: W2,
    }, tWard);
    record("B1 sibling-ward creation denied for the ward coordinator", insW2.status === 403,
      `status=${insW2.status}`);

    const puList = await rest("GET", `${V}?select=id&limit=200`, undefined, tPu);
    const puIds = (puList.json as { id: string }[] | null)?.map((r) => r.id) ?? [];
    record("B2 PU authority sees only its PU (no ward/sibling rows)",
      puIds.includes(actPu ?? "x") && !puIds.includes(actWard ?? "x") && !puIds.includes(actLga ?? "x"),
      `visible=${puIds.length}`);

    const zoneList = await rest("GET", `${V}?select=id,scope_id&limit=200`, undefined, tZone);
    const zoneRows = (zoneList.json as { id: string; scope_id: string }[] | null) ?? [];
    const zoneHasNsukka = zoneRows.some((r) => r.scope_id === "nsukka");
    record("B3 zone authority sees descendants but not another zone",
      zoneRows.some((r) => r.id === actWard) && zoneRows.some((r) => r.id === actLga) && !zoneHasNsukka,
      `visible=${zoneRows.length} nsukka=${zoneHasNsukka}`);

    const bList = await rest("GET", `${V}?select=id&limit=200`, undefined, tB);
    record("B4 cross-tenant member sees NOTHING (campaign disabled there)",
      bList.status === 200 && Array.isArray(bList.json) && (bList.json as unknown[]).length === 0,
      `status=${bList.status}`);

    // ══ C — activity management ══════════════════════════════════════════
    const editDenied = await rest("POST", "/rest/v1/rpc/update_campaign_activity",
      { p_activity: actWard, p_title: "Hijacked" }, tPu);
    record("C1 unauthorized member cannot edit (RPC)", editDenied.status === 403 || editDenied.status === 500,
      `status=${editDenied.status} msg=${rpcError(editDenied.json).slice(0, 60)}`);

    const editOk = await rest("POST", "/rest/v1/rpc/update_campaign_activity",
      { p_activity: actWard, p_title: "CampB Ward Rally (renamed)" }, tWard);
    const renamed = actWard
      ? await sql.query(`SELECT title FROM politicore.campaign_activities WHERE id = $1`, [actWard])
      : { rows: [] };
    record("C2 authorized supervisor edits via the RPC",
      (editOk.status === 200 || editOk.status === 204) && renamed.rows[0]?.title === "CampB Ward Rally (renamed)",
      `status=${editOk.status} title=${String(renamed.rows[0]?.title ?? "?").slice(0, 40)}`);

    const statusOk = await rest("POST", "/rest/v1/rpc/set_campaign_activity_status",
      { p_activity: actWard, p_status: "postponed" }, tWard);
    record("C3 legal transition scheduled → postponed", statusOk.status === 200 || statusOk.status === 204,
      `status=${statusOk.status}`);

    const invalid = await rest("POST", "/rest/v1/rpc/set_campaign_activity_status",
      { p_activity: actWard, p_status: "scheduled" }, tWard);
    record("C4 invalid transition rejected", invalid.status !== 200,
      `status=${invalid.status} msg=${rpcError(invalid.json).slice(0, 60)}`);

    const statusDenied = await rest("POST", "/rest/v1/rpc/set_campaign_activity_status",
      { p_activity: actLga, p_status: "cancelled" }, tWard);
    record("C5 out-of-scope status change denied", statusDenied.status === 403 || statusDenied.status === 500,
      `status=${statusDenied.status}`);

    const socialDenied = await rest("POST", "/rest/v1/rpc/set_campaign_activity_status",
      { p_activity: actWard, p_status: "cancelled" }, tSocial);
    record("C6 social-only status change denied", socialDenied.status === 403 || socialDenied.status === 500,
      `status=${socialDenied.status}`);

    const crossDenied = await rest("POST", "/rest/v1/rpc/set_campaign_activity_status",
      { p_activity: actWard, p_status: "cancelled" }, tB);
    record("C7 cross-tenant status change impossible",
      crossDenied.status !== 200 && crossDenied.status !== 204,
      `status=${crossDenied.status}`);

    // ══ D — RSVP ═════════════════════════════════════════════════════════
    const join1 = await rest("POST", "/rest/v1/rpc/join_campaign_activity",
      { p_activity: actWard, p_rsvp: "going" }, tMw);
    record("D1 member joins (RSVP) via the RPC", join1.status === 200,
      `status=${join1.status}`);

    const dupCheck = await sql.query(
      `SELECT count(*)::int n FROM politicore.campaign_activity_participants
       WHERE activity_id = $1 AND user_id = $2`, [actWard, memberW]);
    record("D2 exactly one participant row (UNIQUE upsert)", dupCheck.rows[0].n === 1,
      `rows=${dupCheck.rows[0].n}`);

    await rest("POST", "/rest/v1/rpc/join_campaign_activity",
      { p_activity: actWard, p_rsvp: "interested" }, tMw);
    const rsvpRow = await sql.query(
      `SELECT rsvp FROM politicore.campaign_activity_participants
       WHERE activity_id = $1 AND user_id = $2`, [actWard, memberW]);
    record("D3 RSVP update rewrites the same row", rsvpRow.rows[0]?.rsvp === "interested",
      `rsvp=${rsvpRow.rows[0]?.rsvp}`);

    const foreignRsvp = await rest("POST", VP,
      { activity_id: actWard, user_id: memberO, rsvp: "not_going" }, tMw);
    record("D4 member cannot insert another user's RSVP row", foreignRsvp.status !== 201,
      `status=${foreignRsvp.status}`);

    const crossRsvp = await rest("POST", "/rest/v1/rpc/join_campaign_activity",
      { p_activity: actWard, p_rsvp: "going" }, tB);
    record("D5 cross-tenant RSVP impossible",
      crossRsvp.status !== 200 && crossRsvp.status !== 204,
      `status=${crossRsvp.status}`);

    // ══ E — attendance ═══════════════════════════════════════════════════
    const attOk = await rest("POST", "/rest/v1/rpc/record_campaign_attendance",
      { p_activity: actWard, p_participant_user: memberW, p_attendance: "present", p_check_in: true }, tWard);
    const attRow = await sql.query(
      `SELECT attendance, recorded_by, checked_in_at FROM politicore.campaign_activity_participants
       WHERE activity_id = $1 AND user_id = $2`, [actWard, memberW]);
    record("E1 supervisor records attendance; recorder server-resolved",
      (attOk.status === 200 || attOk.status === 204) && attRow.rows[0]?.attendance === "present"
        && attRow.rows[0]?.recorded_by === wardC,
      `status=${attOk.status} recorded_by=${attRow.rows[0]?.recorded_by === wardC}`);

    const selfAtt = await rest("POST", "/rest/v1/rpc/record_campaign_attendance",
      { p_activity: actWard, p_participant_user: memberW, p_attendance: "present", p_check_in: true }, tMw);
    record("E2 self-check-in denied", selfAtt.status === 403 || selfAtt.status === 500,
      `status=${selfAtt.status}`);

    const otherAtt = await rest("POST", "/rest/v1/rpc/record_campaign_attendance",
      { p_activity: actWard, p_participant_user: memberW, p_attendance: "absent" }, tMo);
    record("E3 unauthorized member cannot record another user's attendance",
      otherAtt.status === 403 || otherAtt.status === 500, `status=${otherAtt.status}`);

    const unchanged = await sql.query(
      `SELECT attendance, recorded_by FROM politicore.campaign_activity_participants
       WHERE activity_id = $1 AND user_id = $2`, [actWard, memberW]);
    record("E4 recorded fact unchanged after the denied attempts",
      unchanged.rows[0]?.attendance === "present" && unchanged.rows[0]?.recorded_by === wardC,
      `attendance=${unchanged.rows[0]?.attendance}`);

    // ══ F — module boundary ══════════════════════════════════════════════
    const bReads = await rest("GET", `${V}?select=id&limit=5`, undefined, tB);
    record("F1 campaign-disabled tenant reads return empty",
      bReads.status === 200 && Array.isArray(bReads.json) && (bReads.json as unknown[]).length === 0,
      `status=${bReads.status}`);

    const bInsert = await rest("POST", V, {
      title: "CampB Disabled Insert", activity_type: "meeting",
      scheduled_start: start, scope_type: "ward", scope_id: W1,
    }, tB);
    record("F2 campaign-disabled INSERT refused", bInsert.status === 403,
      `status=${bInsert.status}`);

    const bRpc = await rest("POST", "/rest/v1/rpc/set_campaign_activity_status",
      { p_activity: actWard, p_status: "cancelled" }, tB);
    record("F3 campaign-disabled RPC mutation refused",
      bRpc.status !== 200 && bRpc.status !== 204,
      `status=${bRpc.status}`);

    const campStillWorks = await rest("GET", `${V}?select=id&limit=5`, undefined, tWard);
    record("F4 no cross-module leakage: tenant A unaffected",
      campStillWorks.status === 200 && Array.isArray(campStillWorks.json)
        && (campStillWorks.json as unknown[]).length >= 1,
      `status=${campStillWorks.status}`);

    // ══ G — direct API abuse ═════════════════════════════════════════════
    const patchStatus = await rest("PATCH", `${V}?id=eq.${actWard}`,
      { status: "completed", created_by: memberO }, tWard);
    record("G1 view PATCH (status/creator spoof) denied — UPDATE revoked",
      patchStatus.status === 401 || patchStatus.status === 403 || patchStatus.status === 404 || patchStatus.status === 405,
      `status=${patchStatus.status}`);

    const patchByPu = await rest("PATCH", `${V}?id=eq.${actWard}`,
      { title: "sneaky" }, tPu);
    record("G2 unauthorized PATCH denied",
      patchByPu.status === 401 || patchByPu.status === 403 || patchByPu.status === 404 || patchByPu.status === 405,
      `status=${patchByPu.status}`);

    const delByPu = await rest("DELETE", `${V}?id=eq.${actWard}`, undefined, tPu);
    record("G3 unauthorized DELETE affects no rows",
      delByPu.status === 401 || delByPu.status === 403 || delByPu.status === 404
        || delByPu.status === 204, // PostgREST 204 = zero rows affected (RLS-filtered)
      `status=${delByPu.status}`);
    const stillThere = await sql.query(
      `SELECT count(*)::int n FROM politicore.campaign_activities WHERE id = $1`, [actWard]);
    record("G4 activity survived the denied DELETE", stillThere.rows[0].n === 1,
      `rows=${stillThere.rows[0].n}`);

    const anonGet = await rest("GET", `${V}?select=id&limit=5`);
    record("G5 anonymous reads nothing", anonGet.status === 200
      ? Array.isArray(anonGet.json) && (anonGet.json as unknown[]).length === 0
      : anonGet.status === 401 || anonGet.status === 403,
      `status=${anonGet.status}`);

    // ══ H — audit ════════════════════════════════════════════════════════
    const aud = await sql.query(
      `SELECT actor_id, action FROM politicore.system_audits
       WHERE affected_resource = 'campaign_activity' AND resource_id = $1
         AND action IN ('campaign.activity.status','campaign.activity.update')`, [actWard]);
    record("H1 authority actions audited with server-resolved actor",
      aud.rows.length >= 2 && aud.rows.every((r) => r.actor_id === wardC),
      `events=${aud.rows.length}`);

    // ══ I — notification ═════════════════════════════════════════════════
    const notes = await sql.query(
      `SELECT id FROM politicore.notifications
       WHERE user_id = $1 AND type = 'activity'`, [wardC]);
    record("I1 organizer notified on status change", notes.rows.length >= 1,
      `notifications=${notes.rows.length}`);

    // ══ J — cleanup + pristine ═══════════════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
  }

  // pristine verification (post-cleanup)
  const pristine = await sql.query<{ camp: string; notes: string; users: string; tenants: string }>(
    `SELECT
       (SELECT count(*)::text FROM politicore.campaign_activities WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'campb-%')) camp,
       (SELECT count(*)::text FROM politicore.notifications WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'campb.%')) notes,
       (SELECT count(*)::text FROM auth.users WHERE email LIKE 'campb.%' OR email LIKE 'campb-%') users,
       (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'campb-%') tenants`);
  const p = pristine.rows[0];
  record("J1 pristine: no campb fixtures remain",
    p.camp === "0" && p.notes === "0" && p.users === "0" && p.tenants === "0",
    `activities=${p.camp} notifications=${p.notes} users=${p.users} tenants=${p.tenants}`);

  await sql.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n══ CAMPAIGN PHASE B HOSTED SMOKE: ${results.length - failed.length}/${results.length} checks passed ══`);
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
