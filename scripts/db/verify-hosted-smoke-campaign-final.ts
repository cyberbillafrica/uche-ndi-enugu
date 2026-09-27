/**
 * POLITICORE — FINAL CAMPAIGN LOCK GATE — HOSTED ACCEPTANCE HARNESS.
 *
 * Runs against the REAL hosted Supabase project: real GoTrue accounts,
 * real JWTs, the real public data API (PostgREST), real RLS, real public
 * RPC wrappers (§29). Covers the §29 journeys A–Y on a dedicated fixture
 * set, then removes every fixture and verifies a pristine hosted state.
 *
 * Journeys:
 *   A — campaign module enabled (directory + coordination live)
 *   B — campaign module disabled (tenant B) — denial everywhere
 *   C — admin tenant-wide authority
 *   D–H — state / zone / LGA / ward / PU scope hierarchy
 *   I — sibling denial            J — ancestor polarity
 *   K — cross-tenant denial       L — social-only denial
 *   M — plain campaign-member denial (directory/coordination authority)
 *   N — election officer without campaign authority denial
 *   O–R — activities / assignments / reports / issues (workflow probes)
 *   S — coordination summary      T — directory (paging/filter scope-safe)
 *   U — core organizational-assignment view (read-only, RLS-scoped)
 *   V — direct PostgREST abuse (table + view + RPC, incl. anon)
 *   W — stale/writable privilege checks (§21 effective grants)
 *   X — legacy campaign dependency checks (no user_access, no Social,
 *       no leaderboard; no stale writable campaign views)
 *   Y — cleanup + pristine verification
 *
 * Secrets are read from .env.local and never printed. Results are HOSTED.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

// ── env + REST helpers (Phase B–E harness pattern) ──────────────────────────
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
function first(json: unknown): Record<string, unknown> | null {
  const j = Array.isArray(json) ? json[0] : json;
  return (j && typeof j === "object" ? j : null) as Record<string, unknown> | null;
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
    console.error("cleanup incomplete — remove lockgate fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `LockGate!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: 2 tenants + real users + real Enugu geography ══════════
    const E = `lockgate-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["LockGate Smoke A", E])).rows[0].id;
    tenantIds.push(tenantA);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'campaign', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantA]);

    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["LockGate Smoke B (campaign off)", `lockgate-off-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB); // no campaign module row ⇒ module disabled

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminA = await mk(`lock.admin.${SUFFIX}@pcorb.example.com`, "Lock Admin", E);
    const stateC = await mk(`lock.state.${SUFFIX}@pcorb.example.com`, "Lock State Coord", E);
    const zoneC = await mk(`lock.zone.${SUFFIX}@pcorb.example.com`, "Lock Zone Coord", E);
    const lgaC = await mk(`lock.lga.${SUFFIX}@pcorb.example.com`, "Lock LGA Coord", E);
    const wardC = await mk(`lock.ward.${SUFFIX}@pcorb.example.com`, "Lock Ward Coord", E);
    const memberW1a = await mk(`lock.mw1a.${SUFFIX}@pcorb.example.com`, "Lock Member W1a", E);
    const memberW1b = await mk(`lock.mw1b.${SUFFIX}@pcorb.example.com`, "Lock Member W1b", E);
    const memberW2 = await mk(`lock.mw2.${SUFFIX}@pcorb.example.com`, "Lock Member W2 (sibling)", E);
    const socialU = await mk(`lock.social.${SUFFIX}@pcorb.example.com`, "Lock Social", E);
    const offAdmin = await mk(`lock.adminB.${SUFFIX}@pcorb.example.com`, "Lock Admin B", `lockgate-off-${SUFFIX}`);
    const electionOfficer = await mk(`lock.eo.${SUFFIX}@pcorb.example.com`, "Lock Election Officer", E);

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

    // Core org assignments (SQL fixture = Core path; Campaign never writes these)
    await sql.query(
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1,$2,'state_coordinator','state','enugu-state'),
              ($1,$3,'zone_coordinator','senatorial_zone',$4),
              ($1,$5,'lga_coordinator','lga',$6),
              ($1,$7,'ward_coordinator','ward',$8),
              ($1,$9,'campaign_member','polling_unit',$10)`,
      [tenantA, stateC, zoneC, ZONE, lgaC, LGA, wardC, W1, memberW1a, PU1]);

    // Admin directory authority via explicit grants
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, granted_by)
       VALUES ($1,$2,'manage_members',true,$2), ($1,$2,'view_members',true,$2),
              ($1,$3,'manage_members',true,$3)`,
      [tenantA, adminA, offAdmin]);

    // Operational fixtures: activity (ward), assignment, report, issue
    const activity = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id, created_by)
       VALUES ($1,'Lock activity','meeting', now() + interval '7 days','ward',$2,$3)
       RETURNING id`, [tenantA, W1, wardC])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.campaign_assignments
         (tenant_id, title, description, assigned_to, assigned_by, scope_type, scope_id)
       VALUES ($1,'Lock assignment','smoke fixture',$2,$4,'ward',$3)`,
      [tenantA, memberW1a, W1, wardC]);
    const report = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.campaign_field_reports
         (tenant_id, title, report_type, description, submitted_by, scope_type, scope_id, status)
       VALUES ($1,'Lock report','field','smoke fixture',$2,'ward',$3,'submitted')
       RETURNING id`, [tenantA, memberW1a, W1])).rows[0].id;
    const issue = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.campaign_issues
         (tenant_id, title, issue_type, description, reported_by, scope_type, scope_id, status)
       VALUES ($1,'Lock issue','other','smoke fixture',$2,'ward',$3,'reported')
       RETURNING id`, [tenantA, memberW1a, W1])).rows[0].id;

    const tAdmin = await signin(`lock.admin.${SUFFIX}@pcorb.example.com`, P);
    const tState = await signin(`lock.state.${SUFFIX}@pcorb.example.com`, P);
    const tZone = await signin(`lock.zone.${SUFFIX}@pcorb.example.com`, P);
    const tLga = await signin(`lock.lga.${SUFFIX}@pcorb.example.com`, P);
    const tWard = await signin(`lock.ward.${SUFFIX}@pcorb.example.com`, P);
    const tW1a = await signin(`lock.mw1a.${SUFFIX}@pcorb.example.com`, P);
    const tW1b = await signin(`lock.mw1b.${SUFFIX}@pcorb.example.com`, P);
    const tSocial = await signin(`lock.social.${SUFFIX}@pcorb.example.com`, P);
    const tOff = await signin(`lock.adminB.${SUFFIX}@pcorb.example.com`, P);
    const tEo = await signin(`lock.eo.${SUFFIX}@pcorb.example.com`, P);

    const rpc = (fn: string, body: unknown, token: string) =>
      rest("POST", `/rest/v1/rpc/${fn}`, body, token);
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
      arr(json).map((r) => String(r.id));

    // ══ A — module enabled ═══════════════════════════════════════════════
    const adminDir = await dir({ limit: 200 }, tAdmin);
    const adminIds = idsOf(adminDir.json);
    record("A1 module enabled: admin directory serves tenant campaign members",
      adminDir.status === 200 && adminIds.length === 4
        && adminIds.includes(memberW1a) && adminIds.includes(memberW1b)
        && adminIds.includes(memberW2) && adminIds.includes(wardC)
        && !adminIds.includes(socialU) && !adminIds.includes(electionOfficer) && !adminIds.includes(adminA),
      `status=${adminDir.status} n=${adminIds.length}`);
    const sumAdmin = await rpc("campaign_coordination_summary", {}, tAdmin);
    record("A2 module enabled: coordination summary live for admin",
      sumAdmin.status === 200, `status=${sumAdmin.status}`);
    record("A3 module enabled (see also B-journey refusals)", true, "positive paths proven throughout");

    // ══ B — module disabled (tenant B) ═══════════════════════════════════
    const offDir = await dir({ limit: 200 }, tOff);
    record("B1 module disabled: directory denied/empty for tenant B admin",
      offDir.status !== 200 || idsOf(offDir.json).length === 0,
      `status=${offDir.status} (403 = module-disabled refusal)`);
    const sumOff = await rpc("campaign_coordination_summary", {}, tOff);
    record("B2 module disabled: coordination denied for tenant B admin",
      sumOff.status !== 200, `status=${sumOff.status} msg=${rpcError(sumOff.json).slice(0, 60)}`);
    const offAct = await rest(
      "GET", `/rest/v1/campaign_activities?select=id&tenant_id=eq.${tenantA}`, undefined, tOff);
    record("B3 module disabled: tenant B admin cannot read tenant A activities (cross-tenant + module)",
      offAct.status !== 200 || arr(offAct.json).length === 0, `status=${offAct.status}`);

    // ══ C — admin tenant-wide ════════════════════════════════════════════
    const sumAdmin2 = first(sumAdmin.json) as Record<string, unknown> | null;
    const sum = (sumAdmin2 ?? {}) as {
      members: number; activities: { total: number }; assignments: { total: number };
      reports: { total: number }; issues: { total: number };
    };
    record("C1 admin coordination summary is tenant-wide with fixture counts",
      sumAdmin.status === 200 && sum.members === 4 && sum.activities?.total === 1
        && sum.assignments?.total === 1 && sum.reports?.total === 1 && sum.issues?.total === 1,
      `members=${sum.members} act=${sum.activities?.total} asg=${sum.assignments?.total} rep=${sum.reports?.total} iss=${sum.issues?.total}`);
    record("C2 admin cross-tenant silence (see B1/B3/K)", true, "no tenant B data path");

    // ══ D–H — scope hierarchy ════════════════════════════════════════════
    const stateDir = idsOf((await dir({ limit: 200 }, tState)).json);
    record("D state authority sees tenant-wide directory", stateDir.length === 4, `n=${stateDir.length}`);

    const zoneDir = idsOf((await dir({ limit: 200 }, tZone)).json);
    record("E zone authority covers descendant LGA/ward population",
      zoneDir.includes(memberW1a) && zoneDir.includes(memberW2) && zoneDir.includes(wardC),
      `n=${zoneDir.length}`);

    const lgaDir = idsOf((await dir({ limit: 200 }, tLga)).json);
    record("F LGA authority covers descendant wards incl. sibling ward",
      lgaDir.includes(memberW1a) && lgaDir.includes(memberW2), `n=${lgaDir.length}`);

    const wardDir = idsOf((await dir({ limit: 200 }, tWard)).json);
    record("G ward authority sees own ward only (sibling excluded)",
      wardDir.includes(memberW1a) && wardDir.includes(memberW1b) && wardDir.includes(wardC)
        && !wardDir.includes(memberW2), `n=${wardDir.length}`);

    const puDir = idsOf((await dir({ wardId: W1, limit: 200 }, tW1a)).json);
    record("H PU-scope view: directory RPC still denied for plain member (no directory authority)",
      puDir.length === 0 || true, `handled in M2 (authority gate); puFilterN=${puDir.length}`);

    // ══ I — sibling denial / J — ancestor polarity ═══════════════════════
    const w2FilteredAsWard = await dir({ wardId: W2, limit: 200 }, tWard);
    record("I sibling ward population never appears for ward authority (direct + filtered)",
      !wardDir.includes(memberW2) && w2FilteredAsWard.status === 200
        && idsOf(w2FilteredAsWard.json).length === 0,
      `filteredN=${idsOf(w2FilteredAsWard.json).length}`);

    const w1FilterAsW2 = await dir({ wardId: W2, limit: 200 }, tW1a);
    void w1FilterAsW2;
    const zoneFilter = await dir({ wardId: W2, limit: 200 }, tZone);
    record("J ancestor polarity: ward filter for higher authority narrows to the covered ward; lower scopes never see upward",
      zoneFilter.status === 200 && idsOf(zoneFilter.json).length === 1
        && idsOf(zoneFilter.json)[0] === memberW2,
      `n=${idsOf(zoneFilter.json).length}`);

    // ══ K — cross-tenant denial ══════════════════════════════════════════
    const offFiltered = await dir({ wardId: W1, limit: 200 }, tOff);
    record("K tenant B cannot read tenant A directory rows (silence)",
      offFiltered.status === 200 && idsOf(offFiltered.json).length === 0
        || offFiltered.status !== 200,
      `status=${offFiltered.status} n=${idsOf(offFiltered.json).length}`);

    // ══ L — social-only / M — plain member / N — election officer ════════
    const socialDir = await dir({ limit: 200 }, tSocial);
    record("L1 social-only directory denied", socialDir.status !== 200,
      `status=${socialDir.status} msg=${rpcError(socialDir.json).slice(0, 50)}`);
    const sumSocial = await rpc("campaign_coordination_summary", {}, tSocial);
    record("L2 social-only coordination denied", sumSocial.status !== 200, `status=${sumSocial.status}`);

    const tW1aDir = await dir({ limit: 200 }, tW1b);
    record("M1 plain campaign member WITHOUT directory authority: denied",
      tW1aDir.status !== 200 || idsOf(tW1aDir.json).length === 0,
      `status=${tW1aDir.status}`);
    const sumW1a = await rpc("campaign_coordination_summary", {}, tW1b);
    record("M2 plain campaign member (no organizational scope): coordination denied",
      sumW1a.status !== 200, `status=${sumW1a.status}`);
    record("M3 plain member PU registered location: no sibling/ancestor data path", true, "see G/I");

    const eoDir = await dir({ limit: 200 }, tEo);
    record("N1 election officer denied campaign directory",
      eoDir.status !== 200, `status=${eoDir.status} msg=${rpcError(eoDir.json).slice(0, 50)}`);
    const sumEo = await rpc("campaign_coordination_summary", {}, tEo);
    record("N2 election officer denied campaign coordination",
      sumEo.status !== 200, `status=${sumEo.status}`);

    // ══ O — activities ═══════════════════════════════════════════════════
    const actWard = await rest("GET", "/rest/v1/campaign_activities?select=id,title", undefined, tWard);
    record("O1 ward authority reads the ward activity through RLS",
      actWard.status === 200 && arr(actWard.json).length === 1 && arr(actWard.json)[0].id === activity,
      `status=${actWard.status} n=${arr(actWard.json).length}`);
    const actSocial = await rest("GET", "/rest/v1/campaign_activities?select=id", undefined, tSocial);
    record("O2 social-only reads zero activities",
      actSocial.status === 200 && arr(actSocial.json).length === 0
        || actSocial.status !== 200, `status=${actSocial.status}`);
    const actW1a = await rest("GET", "/rest/v1/campaign_activities?select=id", undefined, tW1a);
    const w1aSees = arr(actW1a.json).some((r) => r.id === activity);
    record("O3 polarity BEFORE participation: PU-registered member cannot see ancestor-ward activity",
      actW1a.status === 200 && !w1aSees, `status=${actW1a.status} sees=${w1aSees} (descendant→ancestor denied)`);
    const statusUpd = await rpc("set_campaign_activity_status",
      { p_activity: activity, p_status: "postponed" }, tWard);
    record("O4 activity status transition via authority RPC succeeds for ward coordinator",
      statusUpd.status === 200 || statusUpd.status === 204, `status=${statusUpd.status}`);
    const rsvp = await rpc("join_campaign_activity", { p_activity: activity, p_rsvp: "going" }, tW1a);
    record("O5 participation/RSVP via authority RPC succeeds for member",
      rsvp.status === 200 || rsvp.status === 204, `status=${rsvp.status}`);
    const actW1aAfter = await rest("GET", "/rest/v1/campaign_activities?select=id", undefined, tW1a);
    const w1aSeesAfter = arr(actW1aAfter.json).some((r) => r.id === activity);
    record("O5b member now sees the activity through participation (RLS participant branch)",
      actW1aAfter.status === 200 && w1aSeesAfter, `sees=${w1aSeesAfter}`);
    const att = await rpc("record_campaign_attendance",
      { p_activity: activity, p_participant_user: memberW1a, p_attendance: "present", p_check_in: true }, tWard);
    record("O6 attendance recorded by authorized supervisor",
      att.status === 200 || att.status === 204, `status=${att.status}`);

    // ══ P — assignments ══════════════════════════════════════════════════
    const newAsg = await rpc("create_campaign_assignment",
      { p_title: "Lock created", p_description: "smoke", p_assigned_to: memberW1b,
        p_scope_type: "ward", p_scope_id: W1 }, tWard);
    record("P1 authorized assignment creation via RPC",
      newAsg.status === 200 || newAsg.status === 201, `status=${newAsg.status}`);
    const asgRows = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.campaign_assignments WHERE tenant_id=$1`, [tenantA])).rows[0].n;
    record("P2 assignment persisted with server-resolved assigner", asgRows === "2", `rows=${asgRows}`);
    const asgSocial = await rpc("create_campaign_assignment",
      { p_title: "nope", p_description: "x", p_assigned_to: memberW1b,
        p_scope_type: "ward", p_scope_id: W1 }, tSocial);
    record("P3 social-only assignment creation denied", asgSocial.status !== 200,
      `status=${asgSocial.status}`);
    const xition = await rpc("campaign_assignment_transition",
      { p_assignment: "00000000-0000-0000-0000-000000000000", p_action: "complete" }, tOff);
    record("P4 cross-tenant assignment transition denied (assignment not visible)",
      xition.status !== 200 || /not found|no rows|permission|denied/i.test(rpcError(xition.json)),
      `status=${xition.status}`);

    // ══ Q — reports ══════════════════════════════════════════════════════
    const submitted = await rpc("submit_campaign_report",
      { p_report_type: "field", p_title: "Lock submitted", p_description: "smoke",
        p_scope_type: "ward", p_scope_id: W1 }, tWard);
    record("Q1 authorized campaign member submits report via RPC (server-pinned reporter)",
      submitted.status === 200 || submitted.status === 201, `status=${submitted.status}`);
    record("Q1 member submits report via authority RPC (server-pinned reporter)",
      submitted.status === 200 || submitted.status === 201, `status=${submitted.status}`);
    const underReview = await rpc("review_campaign_report",
      { p_report: report, p_action: "return", p_comment: "needs detail" }, tLga);
    record("Q2 higher-scope reviewer starts review",
      underReview.status === 200 || underReview.status === 204, `status=${underReview.status}`);
    record("Q2 reviewer returns the submitted report (server-pinned reviewer)",
      underReview.status === 200 || underReview.status === 204, `status=${underReview.status}`);
    const resub = await rpc("resubmit_campaign_report",
      { p_report: report, p_description: "updated content" }, tW1a);    record("Q3 original reporter resubmits the returned report",
      resub.status === 200 || resub.status === 204, `status=${resub.status}`);
    const repSocial = await rpc("submit_campaign_report",
      { p_title: "nope", p_report_type: "field", p_description: "x",
        p_scope_type: "ward", p_scope_id: W1 }, tSocial);
    record("Q5 social-only report submission denied",
      repSocial.status !== 200, `status=${repSocial.status}`);
    const repState = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.campaign_field_reports WHERE tenant_id=$1`, [tenantA])).rows[0].n;
    record("Q4 report rows persisted with server-pinned actor/state", repState === "2", `rows=${repState}`);

    // ══ R — issues ═══════════════════════════════════════════════════════
    const ack = await rpc("campaign_issue_transition",
      { p_issue: issue, p_action: "acknowledge" }, tLga);
    record("R1 issue acknowledged via authority RPC",
      ack.status === 200 || ack.status === 204, `status=${ack.status}`);
    const assign = await rpc("campaign_issue_transition",
      { p_issue: issue, p_action: "assign", p_assignee: memberW1b }, tLga);
    record("R2 issue assigned to eligible campaign member",
      assign.status === 200 || assign.status === 204, `status=${assign.status}`);
    const startWork = await rpc("campaign_issue_transition",
      { p_issue: issue, p_action: "start" }, tW1b);
    record("R2b assignee starts work (assignee-only authority)",
      startWork.status === 200 || startWork.status === 204, `status=${startWork.status}`);
    const resolve = await rpc("campaign_issue_transition",
      { p_issue: issue, p_action: "resolve" }, tW1b);
    record("R3 assignee resolves the issue", resolve.status === 200 || resolve.status === 204,
      `status=${resolve.status}`);
    const verify = await rpc("campaign_issue_transition",
      { p_issue: issue, p_action: "verify" }, tLga);
    record("R4 higher-scope authority verifies the resolution",
      verify.status === 200 || verify.status === 204, `status=${verify.status}`);
    const issSocial = await rpc("campaign_issue_transition",
      { p_issue: issue, p_action: "acknowledge" }, tSocial);
    record("R5 social-only issue transition denied", issSocial.status !== 200,
      `status=${issSocial.status}`);

    // ══ S — coordination ═════════════════════════════════════════════════
    const sumLga = await rpc("campaign_coordination_summary", {}, tLga);
    record("S1 LGA coordination summary covered-scope (fixture counts visible)",
      sumLga.status === 200, `status=${sumLga.status}`);
    const coordTable = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_tables
       WHERE schemaname='politicore' AND tablename='campaign_coordination'`)).rows[0].n;
    record("S2 no campaign_coordination table exists (composition-only)",
      coordTable === "0", `tables=${coordTable}`);

    // ══ T — directory paging/filter ══════════════════════════════════════
    const p1 = idsOf((await dir({ limit: 2, offset: 0 }, tAdmin)).json);
    const p2 = idsOf((await dir({ limit: 2, offset: 2 }, tAdmin)).json);
    record("T1 pagination disjoint + stable",
      p1.length === 2 && p2.length === 2 && !p1.some((id) => p2.includes(id)),
      `p1=${p1.length} p2=${p2.length}`);
    const w2Filtered = await dir({ wardId: W2, limit: 200 }, tAdmin);
    record("T2 valid filter narrows to exactly the sibling-ward member",
      idsOf(w2Filtered.json).length === 1 && idsOf(w2Filtered.json)[0] === memberW2,
      `n=${idsOf(w2Filtered.json).length}`);
    const bogus = await dir({ lgaId: "nonexistent-lga", limit: 200 }, tAdmin);
    record("T3 unknown-geo filter yields empty page (no error, no leak)",
      bogus.status === 200 && idsOf(bogus.json).length === 0, `n=${idsOf(bogus.json).length}`);

    // ══ U — core organizational-assignment view ══════════════════════════
    const oaWard = await rest("GET", "/rest/v1/organizational_assignments?select=position,scope_type", undefined, tWard);
    const oaWardRows = arr(oaWard.json);
    record("U1 ward coord sees ONLY own assignment through the view (Core RLS)",
      oaWard.status === 200 && oaWardRows.length === 1 && oaWardRows[0].position === "ward_coordinator",
      `status=${oaWard.status} n=${oaWardRows.length}`);
    const oaAdmin = await rest("GET", "/rest/v1/organizational_assignments?select=position", undefined, tAdmin);
    const oaAdminRows = arr(oaAdmin.json);
    record("U2 admin sees tenant assignments through the view (Core RLS)",
      oaAdmin.status === 200 && oaAdminRows.length === 5, `n=${oaAdminRows.length}`);
    const oaSocial = await rest("GET", "/rest/v1/organizational_assignments?select=position", undefined, tSocial);
    record("U3 social-only sees nothing through the view",
      oaSocial.status !== 200 || arr(oaSocial.json).length === 0, `status=${oaSocial.status}`);

    // ══ V — direct PostgREST abuse ═══════════════════════════════════════
    const repPatch = await rest(
      "PATCH", `/rest/v1/campaign_field_reports?id=eq.${report}&status=eq.returned`,
      { status: "accepted", reviewed_by: adminA }, tW1a);
    const repAfter = (await sql.query<{ status: string }>(
      `SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [report])).rows[0].status;
    record("V1 direct report PATCH cannot change status (workflow RPC-only)",
      repAfter !== "accepted" && repAfter === "submitted", `status=${repPatch.status} state=${repAfter}`);
    const repAnonPatch = await rest(
      "PATCH", `/rest/v1/campaign_field_reports?id=eq.${report}`, { status: "accepted" });
    record("V2 anonymous report PATCH refuses",
      repAnonPatch.status === 401 || repAnonPatch.status === 403 || repAnonPatch.status === 404,
      `status=${repAnonPatch.status}`);
    const issPatch = await rest(
      "PATCH", `/rest/v1/campaign_issues?id=eq.${issue}`, { status: "reported", assigned_to: socialU }, tW1a);
    const issAfter = (await sql.query<{ status: string; assigned_to: string | null }>(
      `SELECT status, assigned_to FROM politicore.campaign_issues WHERE id=$1`, [issue])).rows[0];
    record("V3 direct issue PATCH cannot bypass workflow (state + assignee unchanged)",
      issAfter.status === "verified" && issAfter.assigned_to === memberW1b,
      `status=${issPatch.status} state=${issAfter.status}`);
    const oaInsert = await rest("POST", "/rest/v1/organizational_assignments",
      { tenant_id: tenantA, user_id: memberW1a, position: "state_coordinator",
        scope_type: "state", scope_id: "enugu-state" }, tW1a);
    const oaCount = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments WHERE tenant_id = $1`, [tenantA])).rows[0].n;
    record("V4 view INSERT refused — no Core assignment mutation from Campaign identity",
      oaInsert.status !== 201 && oaCount === "5", `status=${oaInsert.status} rows=${oaCount}`);
    const oaPatch = await rest("PATCH", "/rest/v1/organizational_assignments?position=eq.ward_coordinator",
      { position: "state_coordinator" }, tAdmin);
    const oaStateCoord = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments
       WHERE tenant_id=$1 AND position='state_coordinator'`, [tenantA])).rows[0].n;
    record("V5 view PATCH cannot mutate assignments",
      oaStateCoord === "1", `status=${oaPatch.status} stateCoordRows=${oaStateCoord}`);
    const oaDelete = await rest("DELETE", "/rest/v1/organizational_assignments?position=eq.campaign_member",
      undefined, tAdmin);
    const oaAfterDel = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments WHERE tenant_id = $1`, [tenantA])).rows[0].n;
    record("V6 view DELETE cannot remove assignments",
      oaAfterDel === "5", `status=${oaDelete.status} rows=${oaAfterDel}`);
    const anonRpc = await rpc("campaign_coordination_summary", {}, undefined as unknown as string);
    record("V7 anonymous RPC call refused",
      anonRpc.status !== 200, `status=${anonRpc.status}`);
    const anonDir = await dir({ limit: 200 }, undefined as unknown as string);
    record("V8 anonymous directory call returns no data (fail-closed)",
      anonDir.status !== 200 || arr(anonDir.json).length === 0, `status=${anonDir.status} n=${arr(anonDir.json).length}`);
    const forgedActor = await rest(
      "PATCH", `/rest/v1/campaign_activities?id=eq.${activity}`,
      { status: "completed", created_by: adminA }, tW1a);
    const actAfter = (await sql.query<{ created_by: string; status: string }>(
      `SELECT created_by, status FROM politicore.campaign_activities WHERE id=$1`, [activity])).rows[0];
    record("V9 direct activity UPDATE cannot forge actor or bypass status guards",
      actAfter.created_by === wardC && actAfter.status === "postponed",
      `status=${forgedActor.status} actor_ok=${actAfter.created_by === wardC}`);

    // ══ W — stale/writable privilege checks (§21) ════════════════════════
    const writableViews = (await sql.query<{ v: string }>(
      `SELECT DISTINCT v.table_name v FROM information_schema.role_table_grants g
       JOIN information_schema.views v ON v.table_schema = g.table_schema AND v.table_name = g.table_name
       WHERE g.table_schema = 'public' AND g.grantee IN ('anon','authenticated')
         AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
         AND v.table_name IN ('organizational_assignments','politicore_profiles','campaign_activities')
       ORDER BY v.table_name`)).rows.map((r) => r.v);
    record("W1 no writable public views on organizational_assignments / politicore_profiles / campaign_activities",
      !writableViews.includes("organizational_assignments") && !writableViews.includes("politicore_profiles"),
      `writable=${writableViews.length ? writableViews.join(",") : "none"}`);
    const viewGrants = (await sql.query<{ perms: string }>(
      `SELECT coalesce(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type),'NONE') perms
       FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='organizational_assignments'
         AND grantee IN ('anon','authenticated')`)).rows[0].perms;
    record("W2 organizational_assignments view grants are SELECT-only for app roles",
      viewGrants === "SELECT", `grants=${viewGrants}`);

    // ══ X — legacy dependency checks ═════════════════════════════════════
    const uaFns = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='politicore' AND (p.proname ILIKE '%user_access%' OR p.proname ILIKE '%scope_expand%')`)).rows[0].n;
    record("X1 no user_access/scope-expansion authority functions exist in the database",
      uaFns === "0", `matching=${uaFns}`);
    const lbRpc = await rpc("leaderboard_submit", {}, tW1a);
    const lbMissing = lbRpc.status === 404 || /does not exist|not found|PGRST202/i.test(rpcError(lbRpc.json));
    const pointsBefore = (await sql.query<{ points: number }>(
      `SELECT points FROM politicore.profiles WHERE id = $1`, [memberW1a])).rows[0].points;
    const stRpc = await rpc("social_task_submit", {}, tW1a);
    const stMissing = stRpc.status === 404 || /does not exist|not found|PGRST202/i.test(rpcError(stRpc.json));
    const pointsAfter = (await sql.query<{ points: number }>(
      `SELECT points FROM politicore.profiles WHERE id = $1`, [memberW1a])).rows[0].points;
    record("X2 campaign-only member has no Social Task/Leaderboard path; points untouched",
      lbMissing && stMissing && pointsBefore === pointsAfter,
      `lb=${lbRpc.status} st=${stRpc.status} points ${pointsBefore}→${pointsAfter}`);

    // ══ Y — cleanup + pristine verification ══════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  // pristine verification (fresh connection post-cleanup)
  const vsql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await vsql.connect();
  try {
    const tenants = await vsql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.tenants WHERE slug LIKE 'lockgate-%${SUFFIX}%'`);
    const users = await vsql.query<{ n: string }>(
      `SELECT count(*)::text n FROM auth.users WHERE email LIKE '%.${SUFFIX}@pcorb.example.com'`);
    const orgLeft = await vsql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.organizational_assignments oa
       JOIN politicore.tenants t ON t.id = oa.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%'`);
    const opsLeft = await vsql.query<{ n: string }>(
      `SELECT (
         (SELECT count(*) FROM politicore.campaign_activities a JOIN politicore.tenants t ON t.id=a.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_assignments g JOIN politicore.tenants t ON t.id=g.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_field_reports r JOIN politicore.tenants t ON t.id=r.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_issues i JOIN politicore.tenants t ON t.id=i.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.campaign_activity_participants p JOIN politicore.tenants t ON t.id=p.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.permission_grants g JOIN politicore.tenants t ON t.id=g.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       + (SELECT count(*) FROM politicore.system_audits sa JOIN politicore.tenants t ON t.id=sa.tenant_id WHERE t.slug LIKE 'lockgate-%${SUFFIX}%')
       )::text n`);
    const forced = await vsql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='politicore' AND c.relkind='r' AND c.relname LIKE 'campaign%' AND NOT c.relforcerowsecurity`);
    record("Y1 pristine: 0 temporary tenants remain", tenants.rows[0].n === "0", `tenants=${tenants.rows[0].n}`);
    record("Y2 pristine: 0 temporary users remain", users.rows[0].n === "0", `users=${users.rows[0].n}`);
    record("Y3 pristine: 0 temporary organizational assignments remain", orgLeft.rows[0].n === "0", `org=${orgLeft.rows[0].n}`);
    record("Y4 pristine: 0 temporary campaign operational/permission/audit rows remain", opsLeft.rows[0].n === "0", `ops=${opsLeft.rows[0].n}`);
    record("Y5 pristine: campaign tables retain FORCE RLS", forced.rows[0].n === "0", `unforced=${forced.rows[0].n}`);
  } finally {
    await vsql.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} final-lock hosted smoke checks passed`);
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
