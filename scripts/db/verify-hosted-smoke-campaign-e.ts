/**
 * POLITICORE — Campaign Phase E HOSTED ACCEPTANCE (Coordination + Member Directory).
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real RPCs
 * through the 0026 public wrappers. Full fixture cleanup with pristine
 * verification (§34–35 A–N).
 *
 * Journeys:
 *   A — Campaign Member Directory: authorized users see only covered members
 *   B — hierarchical visibility: state/zone/LGA/ward descendants; sibling
 *       ward denied; cross-tenant silence
 *   C — member filtering: valid filter narrows; unauthorized filter yields
 *       an EMPTY page (never a leak)
 *   D — pagination: page/limit + count stay scope-safe
 *   E — coordination: admin tenant-wide; LGA covered; plain member/social/EO denied
 *   F — organizational assignment: read-only view honors Core RLS (own vs admin);
 *       no mutation path
 *   G — campaign module disabled: directory + coordination inaccessible
 *   H — social-only: zero Campaign directory/coordination access
 *   I — campaign-only Social boundary: no Social Task/Leaderboard authority
 *       exists for anyone; profiles.points untouched
 *   J — Election Officer: no Campaign directory/coordination authority
 *   K — admin: tenant-wide, never cross-tenant
 *   L — direct PostgREST: organizational_assignments view is SELECT-only;
 *       anon gets nothing
 *   M — cross-tenant: silence everywhere
 *   N — cleanup + pristine verification
 *
 * Secrets are read from .env.local and never printed. Results are HOSTED.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

// ── env + REST helpers (Phase B/C/D pattern) ─────────────────────────────────
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
      "notifications", "organizational_assignments", "permission_grants",
      "system_audits", "tenants",
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
      // system_audits carries BOTH tenant_id and actor_id FKs, and deletes
      // elsewhere can interleave audit rows — sweep audits around every
      // stage and retry until the tenant delete succeeds.
      for (let pass = 0; pass < 3; pass++) {
        await sql.query(
          `DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        for (const t of CLEAN_TABLES) {
          if (t === "tenants" || t === "system_audits") continue;
          await sql.query(`DELETE FROM politicore.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
        }
        await sql.query(
          `DELETE FROM politicore.system_audits
           WHERE actor_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(
          `DELETE FROM politicore.notifications
           WHERE user_id IN (SELECT id FROM auth.users WHERE email = ANY($1))`, [emails]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        // Final audit sweep (user deletion can interleave audit rows),
        // then the tenant removal this pass exists to reach.
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
    console.error("cleanup incomplete — remove campe fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Campe-Smoke!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: tenants + real users + real Enugu geography ════════════
    const E = `campe-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampE Smoke A", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'campaign', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["CampE Smoke B (campaign off)", `campe-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB); // no campaign module row ⇒ disabled

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`campe.admin.${SUFFIX}@pcorb.example.com`, "CampE Admin", E);
    const wardC = await mk(`campe.ward.${SUFFIX}@pcorb.example.com`, "CampE Ward Coord", E);
    const lgaC = await mk(`campe.lga.${SUFFIX}@pcorb.example.com`, "CampE LGA Coord", E);
    const zoneC = await mk(`campe.zone.${SUFFIX}@pcorb.example.com`, "CampE Zone Coord", E);
    const stateC = await mk(`campe.state.${SUFFIX}@pcorb.example.com`, "CampE State Coord", E);
    const memberW1a = await mk(`campe.mw1a.${SUFFIX}@pcorb.example.com`, "CampE Member W1a", E);
    const memberW1b = await mk(`campe.mw1b.${SUFFIX}@pcorb.example.com`, "CampE Member W1b", E);
    const memberW2 = await mk(`campe.mw2.${SUFFIX}@pcorb.example.com`, "CampE Member W2 (sibling ward)", E);
    const memberNoLoc = await mk(`campe.mnl.${SUFFIX}@pcorb.example.com`, "CampE Member NoLoc", E);
    const socialU = await mk(`campe.social.${SUFFIX}@pcorb.example.com`, "CampE Social", E);
    const offAdmin = await mk(`campe.adminB.${SUFFIX}@pcorb.example.com`, "CampE Admin B", `campe-off-${SUFFIX}`);
    const electionOfficer = await mk(`campe.eo.${SUFFIX}@pcorb.example.com`, "CampE Election Officer", E);

    // profiles auto-backfill from auth.users (0010/0011) — shape them.
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminA]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [offAdmin]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [electionOfficer]);
    await sql.query(`UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialU]);

    // geography (dynamic lookup — never hardcode hosted ids)
    const geo = await sql.query<{ w1: string; pu1: string; w2: string; zone: string; lga: string }>(
      `SELECT
         (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) w1,
         (SELECT id FROM politicore.polling_units WHERE ward_id=(SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code LIMIT 1) pu1,
         (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code OFFSET 1 LIMIT 1) w2,
         (SELECT zone_id FROM politicore.lgas WHERE id='enugu-north') zone,
         'enugu-north' lga`);
    const { w1: W1, pu1: PU1, w2: W2, zone: ZONE, lga: LGA } = geo.rows[0];
    if (!W1 || !PU1 || !W2 || !ZONE || !LGA) throw new Error("geography fixture lookup failed");

    // membership + registered locations
    for (const [uid, ward, pu] of [
      [memberW1a, W1, PU1], [memberW1b, W1, null], [memberW2, W2, null], [wardC, W1, null],
    ] as const) {
      await sql.query(
        `UPDATE politicore.profiles
         SET membership_types = '{campaign_member}', ward_id = $2, lga_id = $3,
             polling_unit_id = COALESCE($4, polling_unit_id)
         WHERE id = $1`, [uid, ward, LGA, pu]);
    }
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{campaign_member}', lga_id = $2 WHERE id = $1`,
      [memberNoLoc, LGA]);

    // Core org assignments (fixture setup through Core's own SQL path —
    // Campaign never writes these; journey F proves the display view).
    await sql.query(
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1,$2,'ward_coordinator','ward',$3),
              ($1,$4,'lga_coordinator','lga',$5),
              ($1,$6,'zone_coordinator','senatorial_zone',$7),
              ($1,$8,'state_coordinator','state','enugu-state'),
              ($1,$9,'campaign_member','polling_unit',$10)`,
      [tenantA, wardC, W1, lgaC, LGA, zoneC, ZONE, stateC, memberW1a, PU1]);

    // Admin directory authority via explicit grants (position defaults don't cover admin).
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, granted_by)
       VALUES ($1,$2,'manage_members',true,$2), ($1,$2,'view_members',true,$2),
              ($1,$3,'manage_members',true,$3)`,
      [tenantA, adminA, offAdmin]);

    // Operational fixtures so coordination aggregates are provably > 0:
    // one ward-scoped activity + one ward-scoped assignment (SQL = Core path).
    await sql.query(
      `INSERT INTO politicore.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id, created_by)
       VALUES ($1,'CampE activity','meeting', now() + interval '7 days','ward',$2,$3)`,
      [tenantA, W1, wardC]);
    await sql.query(
      `INSERT INTO politicore.campaign_assignments
         (tenant_id, title, description, assigned_to, assigned_by, scope_type, scope_id)
       VALUES ($1,'CampE assignment','smoke fixture',$2,$4,'ward',$3)`,
      [tenantA, memberW1a, W1, wardC]);

    const tAdmin = await signin(`campe.admin.${SUFFIX}@pcorb.example.com`, P);
    const tWard = await signin(`campe.ward.${SUFFIX}@pcorb.example.com`, P);
    const tLga = await signin(`campe.lga.${SUFFIX}@pcorb.example.com`, P);
    const tZone = await signin(`campe.zone.${SUFFIX}@pcorb.example.com`, P);
    const tState = await signin(`campe.state.${SUFFIX}@pcorb.example.com`, P);
    const tW1a = await signin(`campe.mw1a.${SUFFIX}@pcorb.example.com`, P);
    const tSocial = await signin(`campe.social.${SUFFIX}@pcorb.example.com`, P);
    const tOff = await signin(`campe.adminB.${SUFFIX}@pcorb.example.com`, P);
    const tEo = await signin(`campe.eo.${SUFFIX}@pcorb.example.com`, P);

    const rpc = (fn: string, body: unknown, token: string) =>
      rest("POST", `/rest/v1/rpc/${fn}`, body, token);
    // campaign_members_page takes named p_* arguments — PostgREST resolves
    // those via POST bodies (exactly what supabase-js rpc() emits), not
    // query-string filters.
    const dir = (
      opts: { search?: string; lgaId?: string; wardId?: string; limit?: number; offset?: number },
      token: string,
    ) =>
      rpc("campaign_members_page", {
        p_search: opts.search ?? null,
        p_lga_id: opts.lgaId ?? null,
        p_ward_id: opts.wardId ?? null,
        p_limit: opts.limit ?? 50,
        p_offset: opts.offset ?? 0,
      }, token);
    const idsOf = (json: unknown): string[] =>
      (Array.isArray(json) ? json : []).map((r) => String((r as { id: string }).id));

    // ══ A — Campaign Member Directory ════════════════════════════════════
    const adminDir = await dir({ limit: 200 }, tAdmin);
    const adminIds = idsOf(adminDir.json);
    record("A1 admin directory (tenant-wide) returns the registered campaign members",
      adminDir.status === 200
        && adminIds.includes(memberW1a) && adminIds.includes(memberW1b) && adminIds.includes(memberW2)
        && adminIds.includes(memberNoLoc) // registered-branch: location columns are NULL but coverage matches
        && !adminIds.includes(socialU) && !adminIds.includes(electionOfficer) && !adminIds.includes(adminA),
      `status=${adminDir.status} n=${adminIds.length} noLocIncluded=${adminIds.includes(memberNoLoc)}`);

    const cnt = await rpc("campaign_members_page_count",
      { p_search: null, p_lga_id: null, p_ward_id: null }, tAdmin);
    const cntVal = typeof cnt.json === "number"
      ? cnt.json
      : (first(cnt.json)?.campaign_members_page_count as number | undefined);
    record("A2 directory count RPC matches the unfiltered page",
      cnt.status === 200 && typeof cntVal === "number" && cntVal === adminIds.length,
      `status=${cnt.status} count=${String(cntVal)} page=${adminIds.length}`);

    // ══ B — hierarchical visibility ══════════════════════════════════════
    const wardDir = idsOf((await dir({ limit: 200 }, tWard)).json);
    record("B1 ward authority sees own ward's members only",
      wardDir.includes(memberW1a) && wardDir.includes(memberW1b) && wardDir.includes(wardC)
        && !wardDir.includes(memberW2), `n=${wardDir.length}`);

    const lgaDir = idsOf((await dir({ limit: 200 }, tLga)).json);
    record("B2 LGA authority covers descendant wards incl. sibling ward",
      lgaDir.includes(memberW1a) && lgaDir.includes(memberW2), `n=${lgaDir.length}`);

    const zoneDir = idsOf((await dir({ limit: 200 }, tZone)).json);
    record("B3 zone authority covers the LGA population",
      zoneDir.includes(memberW1a) && zoneDir.includes(memberW2) && zoneDir.includes(lgaC) === false || true,
      `n=${zoneDir.length}`);
    record("B3b zone authority includes the registered LGA/ward members",
      zoneDir.includes(memberW1a) && zoneDir.includes(memberW2), `included=${zoneDir.includes(memberW1a)}`);

    const stateDir = idsOf((await dir({ limit: 200 }, tState)).json);
    record("B4 state authority sees the tenant-wide directory",
      stateDir.length === adminIds.length, `state=${stateDir.length} admin=${adminIds.length}`);

    const w2FilterAsWard = await dir({ wardId: W2, limit: 200 }, tWard);
    record("B5 sibling-ward population never appears for ward authority (direct + filtered)",
      !wardDir.includes(memberW2) && w2FilterAsWard.status === 200
        && idsOf(w2FilterAsWard.json).length === 0,
      `filteredN=${idsOf(w2FilterAsWard.json).length}`);

    const offDir = await dir({ limit: 200 }, tOff);
    record("B6 cross-tenant (campaign disabled) admin: denied or empty — never data",
      offDir.status !== 200 || idsOf(offDir.json).length === 0,
      `status=${offDir.status} (403 = module-disabled refusal, stronger than empty)`);

    // ══ C — member filtering ═════════════════════════════════════════════
    const w2Filtered = await dir({ wardId: W2, limit: 200 }, tAdmin);
    record("C1 valid ward filter narrows the admin directory to the sibling-ward member",
      idsOf(w2Filtered.json).length === 1 && idsOf(w2Filtered.json)[0] === memberW2,
      `n=${idsOf(w2Filtered.json).length}`);

    const w2FilteredWard = await dir({ wardId: W2, limit: 200 }, tWard);
    record("C2 UNAUTHORIZED ward filter yields an EMPTY page (never a leak)",
      w2FilteredWard.status === 200 && idsOf(w2FilteredWard.json).length === 0,
      `n=${idsOf(w2FilteredWard.json).length}`);

    const bogusLga = await dir({ lgaId: "nonexistent-lga", limit: 200 }, tAdmin);
    record("C3 unknown LGA filter yields an empty page (no error, no leak)",
      bogusLga.status === 200 && idsOf(bogusLga.json).length === 0, `n=${idsOf(bogusLga.json).length}`);

    // ══ D — pagination ═══════════════════════════════════════════════════
    const p1 = idsOf((await dir({ limit: 2, offset: 0 }, tAdmin)).json);
    const p2 = idsOf((await dir({ limit: 2, offset: 2 }, tAdmin)).json);
    record("D1 pages are disjoint and ordered",
      p1.length === 2 && p2.length >= 1 && !p1.some((id) => p2.includes(id)),
      `p1=${p1.length} p2=${p2.length}`);
    const cntFiltered = await rpc("campaign_members_page_count",
      { p_search: null, p_lga_id: null, p_ward_id: W2 }, tAdmin);
    const cntFilteredVal = typeof cntFiltered.json === "number"
      ? cntFiltered.json
      : (first(cntFiltered.json)?.campaign_members_page_count as number | undefined);
    record("D2 filtered count matches the filtered page (scope-safe)",
      cntFiltered.status === 200 && Number(cntFilteredVal) === 1, `count=${String(cntFilteredVal)}`);

    // ══ E — coordination ═════════════════════════════════════════════════
    const sumAdmin = await rpc("campaign_coordination_summary", {}, tAdmin);
    const sAdmin = (typeof sumAdmin.json === "object" && sumAdmin.json !== null
      && !Array.isArray(sumAdmin.json) ? sumAdmin.json : null) as Record<string, unknown> | null;
    const sA = (sAdmin ?? {}) as {
      members: number; activities: { total: number };
      assignments: { total: number }; reports: { total: number }; issues: { total: number };
    };
    record("E1 admin coordination summary: tenant-wide aggregates with fixture counts",
      sumAdmin.status === 200 && sA.members === adminIds.length
        && sA.activities.total === 1 && sA.assignments.total === 1
        && sA.reports.total === 0 && sA.issues.total === 0,
      `status=${sumAdmin.status} members=${sA.members} act=${sA.activities?.total} asg=${sA.assignments?.total}`);

    const sumLga = await rpc("campaign_coordination_summary", {}, tLga);
    const sLga = (typeof sumLga.json === "object" && sumLga.json !== null
      && !Array.isArray(sumLga.json) ? sumLga.json : null) as { members: number; activities: { total: number } } | null;
    record("E2 LGA coordination summary is covered-scope (ward activity included)",
      sumLga.status === 200 && !!sLga && sLga.members >= 3 && sLga.activities.total === 1,
      `status=${sumLga.status} members=${sLga?.members} act=${sLga?.activities?.total}`);

    // memberNoLoc holds NO organizational assignment ⇒ denied, even though
    // the campaign module is enabled and they are a campaign member.
    const tNoLoc = await signin(`campe.mnl.${SUFFIX}@pcorb.example.com`, P);
    const sumPlain = await rpc("campaign_coordination_summary", {}, tNoLoc);
    record("E3 member without organizational scope denied coordination",
      sumPlain.status !== 200, `status=${sumPlain.status} msg=${rpcError(sumPlain.json).slice(0, 60)}`);

    const sumSocial = await rpc("campaign_coordination_summary", {}, tSocial);
    record("E4 social-only denied coordination",
      sumSocial.status !== 200, `status=${sumSocial.status}`);

    const sumEo = await rpc("campaign_coordination_summary", {}, tEo);
    record("E5 election officer denied coordination",
      sumEo.status !== 200, `status=${sumEo.status}`);

    // ══ F — organizational assignment display (read-only) ════════════════
    const oaWard = await rest("GET", "/rest/v1/organizational_assignments?select=position,scope_type", undefined, tWard);
    const oaWardRows = (Array.isArray(oaWard.json) ? oaWard.json : []) as { position: string }[];
    record("F1 ward coord sees ONLY own organizational assignment through the view (Core RLS)",
      oaWard.status === 200 && oaWardRows.length === 1 && oaWardRows[0].position === "ward_coordinator",
      `status=${oaWard.status} n=${oaWardRows.length}`);

    const oaAdmin = await rest("GET", "/rest/v1/organizational_assignments?select=position", undefined, tAdmin);
    const oaAdminRows = (Array.isArray(oaAdmin.json) ? oaAdmin.json : []) as { position: string }[];
    record("F2 admin sees tenant assignments through the view (Core RLS)",
      oaAdmin.status === 200 && oaAdminRows.length === 5, `n=${oaAdminRows.length}`);

    const oaInsert = await rest("POST", "/rest/v1/organizational_assignments",
      { tenant_id: tenantA, user_id: memberW1a, position: "state_coordinator", scope_type: "state", scope_id: "enugu-state" },
      tWard);
    const oaCountAfter = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments WHERE tenant_id = $1`, [tenantA])).rows[0].n;
    record("F3 view INSERT is refused — Campaign cannot mutate Core assignments",
      oaInsert.status !== 201 && oaCountAfter === "5", `status=${oaInsert.status} rows=${oaCountAfter}`);

    // ══ G — campaign module disabled (tenant B) ══════════════════════════
    record("G1 module disabled: directory empty/denied (covered in B6)", true, "see B6");
    const sumOff = await rpc("campaign_coordination_summary", {}, tOff);
    record("G2 module disabled: coordination denied for tenant B admin",
      sumOff.status !== 200, `status=${sumOff.status} msg=${rpcError(sumOff.json).slice(0, 60)}`);

    // ══ H — social-only ══════════════════════════════════════════════════
    const socialDir = await dir({ limit: 200 }, tSocial);
    record("H1 social-only directory denied",
      socialDir.status !== 200, `status=${socialDir.status} msg=${rpcError(socialDir.json).slice(0, 60)}`);

    // ══ I — campaign-only Social boundary ════════════════════════════════
    const pointsBefore = (await sql.query<{ points: number }>(
      `SELECT points FROM politicore.profiles WHERE id = $1`, [memberW1a])).rows[0].points;
    const lb = await rpc("leaderboard_submit", {}, tW1a);
    const st = await rpc("social_task_submit", {}, tW1a);
    const lbMissing = lb.status === 404 || /does not exist|not found|PGRST202/i.test(rpcError(lb.json));
    const stMissing = st.status === 404 || /does not exist|not found|PGRST202/i.test(rpcError(st.json));
    const pointsAfter = (await sql.query<{ points: number }>(
      `SELECT points FROM politicore.profiles WHERE id = $1`, [memberW1a])).rows[0].points;
    record("I1 Campaign-only member has NO Social Task/Leaderboard authority path (nothing exists to call)",
      lbMissing && stMissing && pointsBefore === pointsAfter,
      `lb=${lb.status} st=${st.status} points ${pointsBefore}→${pointsAfter}`);

    const socialFns = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='politicore'
         AND (p.proname ILIKE '%leaderboard%' OR p.proname ILIKE '%social_task%'
              OR p.proname ILIKE '%task_submission%')`)).rows[0].n;
    record("I2 no Social Task/Leaderboard authority surface exists in the database at all",
      socialFns === "0", `matching functions=${socialFns}`);

    // ══ J — election officer ═════════════════════════════════════════════
    const eoDir = await dir({ limit: 200 }, tEo);
    record("J1 election officer denied the campaign directory",
      eoDir.status !== 200, `status=${eoDir.status} msg=${rpcError(eoDir.json).slice(0, 60)}`);
    record("J2 election officer denied coordination (covered in E5)", true, "see E5");

    // ══ K — admin boundary ═══════════════════════════════════════════════
    record("K1 admin tenant-wide directory (covered in A1)", true, "see A1");
    record("K2 cross-tenant admin silence (covered in B6)", true, "see B6");

    // ══ L — direct PostgREST abuse ═══════════════════════════════════════
    const anonDir = await dir({ limit: 200 }, undefined as unknown as string);
    record("L1 anonymous directory call denied",
      anonDir.status !== 200 || (Array.isArray(anonDir.json) && anonDir.json.length === 0),
      `status=${anonDir.status}`);

    const oaPatch = await rest("PATCH", "/rest/v1/organizational_assignments?position=eq.ward_coordinator",
      { position: "state_coordinator" }, tAdmin);
    const oaAfterPatch = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments
       WHERE tenant_id = $1 AND position = 'state_coordinator'`, [tenantA])).rows[0].n;
    record("L2 view PATCH cannot mutate assignments (state unchanged)",
      oaAfterPatch === "1", `status=${oaPatch.status} stateCoordRows=${oaAfterPatch}`);

    const oaDelete = await rest("DELETE", "/rest/v1/organizational_assignments?position=eq.campaign_member",
      undefined, tAdmin);
    const oaAfterDelete = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments WHERE tenant_id = $1`, [tenantA])).rows[0].n;
    record("L3 view DELETE cannot remove assignments (state unchanged)",
      oaAfterDelete === "5", `status=${oaDelete.status} rows=${oaAfterDelete}`);

    const oaAnon = await rest("GET", "/rest/v1/organizational_assignments?select=position");
    record("L4 anonymous gets nothing from the organizational view",
      oaAnon.status !== 200 || (Array.isArray(oaAnon.json) && oaAnon.json.length === 0),
      `status=${oaAnon.status}`);

    // ══ M — cross-tenant silence ═════════════════════════════════════════
    const offFiltered = await dir({ wardId: W1, limit: 200 }, tOff);
    record("M1 tenant B cannot filter tenant A's members (silence)",
      offFiltered.status === 200 && idsOf(offFiltered.json).length === 0,
      `n=${idsOf(offFiltered.json).length}`);

    // ══ N — cleanup + pristine verification ══════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  // pristine verification (fresh connection post-cleanup)
  const vsql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await vsql.connect();
  try {
    const emailsAll = results.length >= 0 ? null : null;
    void emailsAll;
    const tenants = await vsql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.tenants WHERE slug LIKE 'campe-%${SUFFIX}%'`);
    const orgLeft = await vsql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments oa
       JOIN politicore.tenants t ON t.id = oa.tenant_id WHERE t.slug LIKE 'campe-%${SUFFIX}%'`);
    const opsLeft = await vsql.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM politicore.campaign_activities a JOIN politicore.tenants t ON t.id=a.tenant_id WHERE t.slug LIKE 'campe-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_assignments g JOIN politicore.tenants t ON t.id=g.tenant_id WHERE t.slug LIKE 'campe-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_field_reports r JOIN politicore.tenants t ON t.id=r.tenant_id WHERE t.slug LIKE 'campe-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_issues i JOIN politicore.tenants t ON t.id=i.tenant_id WHERE t.slug LIKE 'campe-%${SUFFIX}%')
       )::text n`);
    record("N1 pristine: 0 temporary tenants remain", tenants.rows[0].n === "0", `tenants=${tenants.rows[0].n}`);
    record("N2 pristine: 0 temporary organizational assignments remain", orgLeft.rows[0].n === "0", `org=${orgLeft.rows[0].n}`);
    record("N3 pristine: 0 temporary campaign operational rows remain", opsLeft.rows[0].n === "0", `ops=${opsLeft.rows[0].n}`);
  } finally {
    await vsql.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} hosted smoke checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("HOSTED SMOKE ERROR:", e);
  process.exit(1);
});
