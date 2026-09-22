/**
 * POLITICORE — hosted Supabase Election acceptance script (Phase 1C-Implementation).
 *
 * Proves the Election foundation on the REAL hosted project (brief §43):
 *   1. catalog: 9 election tables, RLS, policies, RPCs, views, publication,
 *      parties, permission catalog, grant/REVOKE hardening
 *   2. geography untouched: 1 state / 3 zones / 17 LGAs / 260 wards / 4,145 PUs
 *   3. real GoTrue accounts (SQL-seeded, password-grant sign-in)
 *   4. full workflow through the live data API with real JWTs:
 *      submit (registered PU / ward grant / officer) → officer review →
 *      admin correction → self-approval refusal → independent re-verification
 *      → scoped aggregation → active-election configuration
 *   5. denials: social-only, election-disabled tenant, unauthorized PU,
 *      cross-tenant
 *   6. notifications + server-side audit rows
 *
 * Cleanup removes every fixture, leaving the project pristine. Secrets are
 * read from .env.local and never printed. Results are HOSTED results only.
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
  return (json as { message?: string; error?: string })?.message
    ?? (json as { error?: string })?.error
    ?? JSON.stringify(json).slice(0, 120);
}
// PostgREST returns SETOF function results as a JSON array; unwrap for checks.
function first(json: unknown): Record<string, unknown> | null {
  const j = Array.isArray(json) ? json[0] : json;
  return (j && typeof j === "object" ? j : null) as Record<string, unknown> | null;
}

// ── SQL-seeded GoTrue-compatible auth user (Phase 1B verified recipe) ───────
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

// ── cleanup ──────────────────────────────────────────────────────────────────
async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  try {
    // FORCE RLS tables: as table owner, row-filter USING/WITH CHECK policies
    // are silently APPLIED to owner writes — deleting as owner no-ops. Capture
    // each table's true FORCE state, lift ONLY what was forced, delete, then
    // restore EXACTLY (never blanket-FORCE: election_results/history are
    // deliberately unforced as the definer-write path).
    const CLEAN_TABLES = [
      "election_result_history", "election_result_votes", "election_results", "election_candidates",
      "election_contests", "election_cycles", "pu_reports", "election_incidents",
      "election_settings", "media_assets", "notifications", "permission_grants",
      "system_audits", "tenants",
    ];
    const forceState = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [CLEAN_TABLES]);
    const wasForced = new Set(forceState.rows.filter((r) => r.forced).map((r) => r.relname));
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} NO FORCE ROW LEVEL SECURITY`);
    }
    for (const t of tenantIds) {
      await sql.query(`DELETE FROM politicore.election_result_history WHERE tenant_id = $1`, [t]);
      // ballots carry no tenant_id and RESTRICT their parent result —
      // purge via join BEFORE election_results
      await sql.query(
        `DELETE FROM politicore.election_result_votes ev
         USING politicore.election_results r
         WHERE ev.result_id = r.id AND r.tenant_id = $1`, [t]);
      for (const tbl of ["election_results", "election_candidates", "election_contests",
                         "election_cycles", "pu_reports", "election_incidents",
                         "election_settings", "permission_grants", "media_assets",
                         "notifications"]) {
        await sql.query(`DELETE FROM politicore.${tbl} WHERE tenant_id = $1`, [t]);
      }
    }
    for (const email of emails) {
      await sql.query(
        `DELETE FROM politicore.system_audits WHERE actor_id IN (SELECT id FROM auth.users WHERE email = $1)`,
        [email]);
    }
    // users (cascades profiles — FK cascade bypasses RLS, Phase 1B-verified)
    await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
    for (const t of tenantIds) {
      await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = $1`, [t]);
      await sql.query(`DELETE FROM politicore.tenants WHERE id = $1`, [t]);
    }
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.size} tables (project returned to pre-test state)`);
  } catch (e) {
    console.error("cleanup incomplete — remove phase1c fixtures manually:", (e as Error).message);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = "Ph1c-Elect!pass";

  try {
    // ══ 1. hosted catalog ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const tables = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_tables WHERE schemaname='politicore' AND tablename IN
         ('election_cycles','election_contests','political_parties','election_candidates',
          'election_results','election_result_votes','election_result_history',
          'pu_reports','election_incidents','election_settings')`);
    record("migrations applied: 10 election tables exist (incl. relational ballots)",
      tables.rows[0].n === "10", `tables: ${tables.rows[0].n}/10`);

    const rpcs = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='politicore' AND p.proname IN
         ('submit_election_result','review_election_result','correct_election_result',
          'set_active_election','get_results_aggregate','assert_valid_votes','assert_valid_ballot')`);
    record("RPCs exist (5 workflow + legacy + ballot validator)", rpcs.rows[0].n === "7", `functions: ${rpcs.rows[0].n}/7`);

    const pubRpcs = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN
         ('submit_election_result','review_election_result','correct_election_result',
          'set_active_election','get_results_aggregate')`);
    record("public RPC wrappers exposed for the data API", pubRpcs.rows[0].n === "5", `wrappers: ${pubRpcs.rows[0].n}/5`);

    const views = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_views WHERE (schemaname, viewname) IN
         (('politicore','election_results_current'),('public','election_results_current'))`);
    record("current-results views exist (politicore + public surface)", views.rows[0].n === "2", `views: ${views.rows[0].n}/2`);

    const rl = await sql.query<{ unprotected: string }>(
      `SELECT count(*)::text unprotected FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='politicore' AND c.relname IN
         ('election_cycles','election_contests','political_parties','election_candidates',
          'election_results','election_result_votes','election_result_history',
          'pu_reports','election_incidents','election_settings')
       AND (NOT c.relrowsecurity OR (c.relname <> 'political_parties' AND NOT c.relforcerowsecurity
            AND c.relname NOT IN ('election_results','election_result_votes','election_result_history')))`);
    record("RLS enabled on every election table (FORCE except results/history definer-write path)",
      rl.rows[0].unprotected === "0", `unprotected: ${rl.rows[0].unprotected}`);

    const pol = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_policies WHERE schemaname='politicore' AND tablename IN
         ('election_cycles','election_contests','political_parties','election_candidates',
          'election_results','election_result_votes','election_result_history',
          'pu_reports','election_incidents','election_settings')`);
    record("election policies exist", Number(pol.rows[0].n) >= 15, `policies: ${pol.rows[0].n}`);

    const parties = await sql.query<{ n: string }>(`SELECT count(*)::text n FROM politicore.political_parties`);
    record("platform party seed present (0016)", Number(parties.rows[0].n) >= 15, `parties: ${parties.rows[0].n}`);

    const perms = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.permissions WHERE name IN
         ('submit_election_pu_report','submit_election_incident','upload_election_result',
          'view_election_dashboard','manage_election_settings','verify_election_result','view_election_results')`);
    record("election permission catalog complete (incl. two Phase 1C additions)",
      perms.rows[0].n === "7", `permissions: ${perms.rows[0].n}/7`);

    const hard = await sql.query<{ results_del: boolean; history_writes: boolean; votes_writes: boolean }>(
      `SELECT has_table_privilege('authenticated','politicore.election_results','DELETE') results_del,
              has_table_privilege('authenticated','politicore.election_result_history','INSERT,UPDATE,DELETE')
                OR has_table_privilege('authenticated','politicore.election_result_history','DELETE')
                OR has_table_privilege('authenticated','politicore.election_result_history','UPDATE') history_writes,
              has_table_privilege('authenticated','politicore.election_result_votes','INSERT,UPDATE,DELETE')
                OR has_table_privilege('authenticated','politicore.election_result_votes','DELETE')
                OR has_table_privilege('authenticated','politicore.election_result_votes','UPDATE') votes_writes`);
    record("no result/ballot mutation for clients; history append-only (REVOKE-hardened)",
      !hard.rows[0].results_del && !hard.rows[0].history_writes && !hard.rows[0].votes_writes,
      `results DELETE: ${hard.rows[0].results_del}, history writes: ${hard.rows[0].history_writes}, votes writes: ${hard.rows[0].votes_writes}`);

    const pub = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_publication_tables WHERE pubname='supabase_realtime'
       AND schemaname='politicore' AND tablename IN ('election_results','pu_reports','election_incidents')`);
    record("realtime publication carries exactly the 3 election tables", pub.rows[0].n === "3",
      `tables: ${pub.rows[0].n}/3`);

    const geo = await sql.query(`SELECT
        (SELECT count(*) FROM politicore.states) states,
        (SELECT count(*) FROM politicore.senatorial_zones) zones,
        (SELECT count(*) FROM politicore.lgas) lgas,
        (SELECT count(*) FROM politicore.wards) wards,
        (SELECT count(*) FROM politicore.polling_units) pus`);
    const g = geo.rows[0];
    const geoOk = Number(g.states) === 1 && Number(g.zones) === 3 && Number(g.lgas) === 17
      && Number(g.wards) === 260 && Number(g.pus) === 4145;
    record("geography untouched: 1 state / 3 zones / 17 LGAs / 260 wards / 4,145 PUs", geoOk,
      `${g.states}/${g.zones}/${g.lgas}/${g.wards}/${g.pus}`);

    // ══ 2. fixtures (SQL owner): two tenants, five users, geography, cycle ══
    const E = `phase1c-elect-${SUFFIX}`;
    const prov = await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Phase 1C Election Tenant", E]);
    const tenantE = prov.rows[0].id;
    tenantIds.push(tenantE);
    // election ENABLED, campaign DISABLED → module independence is a fixture property
    // (raw tenant INSERT bypasses provision_tenant, so no module default rows exist — upsert)
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'election', true)
       ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`, [tenantE]);

    const provS = await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Phase 1C No-Election Tenant", `phase1c-noel-${SUFFIX}`]);
    const tenantS = provS.rows[0].id;
    tenantIds.push(tenantS);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminId = await mk(`phase1c.admin.${SUFFIX}@pcorb.example.com`, "1C Admin", E);
    const officerId = await mk(`phase1c.officer.${SUFFIX}@pcorb.example.com`, "1C Officer", E);
    const regId = await mk(`phase1c.regpu.${SUFFIX}@pcorb.example.com`, "1C RegPU", E);
    const wardId = await mk(`phase1c.wardgrant.${SUFFIX}@pcorb.example.com`, "1C WardGrant", E);
    const socialId = await mk(`phase1c.social.${SUFFIX}@pcorb.example.com`, "1C Social", E);
    const otherId = await mk(`phase1c.other.${SUFFIX}@pcorb.example.com`, "1C OtherTenant", `phase1c-noel-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminId]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officerId]);

    // geography identities (by code, never assumed IDs)
    const geo1 = await sql.query<{ state: string; zone: string; lga: string; w1: string; pu1: string; pu1b: string; pu2: string; w2: string }>(
      `SELECT
         (SELECT id FROM politicore.states WHERE id = 'enugu-state') state,
         (SELECT id FROM politicore.senatorial_zones WHERE id = 'enugu-east-zone') zone,
         (SELECT id FROM politicore.lgas WHERE id = 'enugu-north') lga,
         (SELECT id FROM politicore.wards WHERE lga_id = 'enugu-north' ORDER BY code LIMIT 1) w1,
         (SELECT id FROM politicore.polling_units WHERE ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code LIMIT 1) pu1,
         (SELECT id FROM politicore.polling_units WHERE ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code OFFSET 1 LIMIT 1) pu1b,
         (SELECT id FROM politicore.wards WHERE lga_id = 'enugu-north' ORDER BY code OFFSET 1 LIMIT 1) w2,
         (SELECT id FROM politicore.polling_units WHERE ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code OFFSET 1 LIMIT 1) ORDER BY code LIMIT 1) pu2`);
    const { state: STATE, zone: ZONE, lga: LGA, w1: W1, pu1: PU1, pu1b: PU1B, pu2: PU2 } = geo1.rows[0];
    if (!STATE || !ZONE || !LGA || !W1 || !PU1 || !PU1B || !PU2)
      throw new Error("geography fixture lookup failed: " + JSON.stringify(geo1.rows[0]));

    const partyAPC = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.political_parties WHERE acronym='APC'`)).rows[0]?.id;
    const partyPDP = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.political_parties WHERE acronym='PDP'`)).rows[0]?.id;
    if (!partyAPC || !partyPDP) throw new Error("party seed lookup failed");
    // REST payload: an actual JSON array (PostgREST would deliver a
    // stringified value as a JSON *string*, which the validator rejects)
    const VOTES = [{ party_id: partyAPC, votes: 100 }, { party_id: partyPDP, votes: 60 }];
    // tracked_parties is acronym-keyed (guard validates against party acronyms)
    const TRACKED = "{APC,PDP}";

    // registered-PU member + ward-grant member + social-only member
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{campaign_member}', polling_unit_id = $2 WHERE id = $1`,
      [regId, PU1]);
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [wardId]);
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, scope_type, scope_id)
       VALUES ($3, $1, 'upload_election_result', true, 'ward', $2)`, [wardId, W1, tenantE]);
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialId]);

    // election fixtures: cycle + two OPEN contests + evidence assets
    const cycleE = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.election_cycles (tenant_id, name, year, status, created_by)
       VALUES ($1, 'Cycle 2027', 2027, 'ACTIVE', $2) RETURNING id`, [tenantE, adminId])).rows[0].id;
    const contestState = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.election_contests
         (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_lgas, state_id, tracked_parties, created_by)
       VALUES ($1, $2, 'state_house', 'State House 2027', 'state_constituency', $3::text[], $4, $5, $6)
       RETURNING id`,
      [tenantE, cycleE, `{${LGA}}`, STATE, TRACKED, adminId])).rows[0].id;
    const contestGov = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.election_contests
         (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_id, tracked_parties, created_by)
       VALUES ($1, $2, 'governorship', 'Governorship 2027', 'state', $3, $4, $5)
       RETURNING id`,
      [tenantE, cycleE, STATE, TRACKED, adminId])).rows[0].id;
    await sql.query(`UPDATE politicore.election_contests SET status='OPEN' WHERE id = ANY($1)`,
      [[contestState, contestGov]]);

    // ballot fixtures: the relational ballot rule (0018) requires a
    // candidate row for every party that appears in a contest's votes
    for (const contest of [contestState, contestGov]) {
      for (const party of [partyAPC, partyPDP]) {
        await sql.query(
          `INSERT INTO politicore.election_candidates (tenant_id, contest_id, party_id, candidate_name)
           VALUES ($1, $2, $3, 'Acceptance Candidate')`, [tenantE, contest, party]);
      }
    }

    const evA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
       VALUES ($1, 'evidence', 'ec8-accept.pdf', 'election_evidence', $2) RETURNING id`,
      [tenantE, regId])).rows[0].id;
    const evWrong = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
       VALUES ($1, 'evidence', 'news-accept.pdf', 'cms_news', $2) RETURNING id`,
      [tenantE, regId])).rows[0].id;

    // ══ 3. real sign-ins (GoTrue password grant → JWT carries hook claims) ══
    const tAdmin = await signin(`phase1c.admin.${SUFFIX}@pcorb.example.com`, P);
    const tOfficer = await signin(`phase1c.officer.${SUFFIX}@pcorb.example.com`, P);
    const tReg = await signin(`phase1c.regpu.${SUFFIX}@pcorb.example.com`, P);
    const tWard = await signin(`phase1c.wardgrant.${SUFFIX}@pcorb.example.com`, P);
    const tSocial = await signin(`phase1c.social.${SUFFIX}@pcorb.example.com`, P);
    const tOther = await signin(`phase1c.other.${SUFFIX}@pcorb.example.com`, P);
    record("real GoTrue sign-in for all 6 accounts (JWTs issued by hosted Auth)", true,
      "6 access tokens issued");

    // ══ 4. workflow through the live data API ══════════════════════════════
    const submit = (token: string, contest: string, pu: string, votes: unknown, evidence: unknown) =>
      rest("POST", "/rest/v1/rpc/submit_election_result",
        { p_contest: contest, p_polling_unit: pu, p_votes: votes, p_evidence: evidence }, token);
    const review = (token: string, result: string, action: string, notes?: string) =>
      rest("POST", "/rest/v1/rpc/review_election_result",
        { p_result: result, p_action: action, p_notes: notes ?? null }, token);

    // module independence: tenant E runs Election with Campaign disabled —
    // every following check is exercised under that fixture property.
    const modq = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=election", undefined, tAdmin);
    record("election enabled / campaign disabled (module independence fixture)",
      modq.json === true, `my_module_enabled(election)=${JSON.stringify(modq.json)}`);

    // registered-PU submission
    const s1 = await submit(tReg, contestState, PU1, VOTES, evA);
    const r1 = Array.isArray(s1.json) ? (s1.json[0] as Record<string, unknown>) : null;
    record("registered-PU member submits result via live RPC (status submitted, verified false)",
      s1.status === 200 && r1?.status === "submitted" && r1?.verified === false,
      s1.status === 200 ? JSON.stringify(r1) : rpcError(s1.json));

    // unauthorized PU
    const s2 = await submit(tReg, contestState, PU2, VOTES, evA);
    record("registered-PU member CANNOT submit for another PU (registered geography)",
      s2.status >= 400 && /not authorized to submit results for polling unit/i.test(rpcError(s2.json)),
      s2.status === 200 ? "ACCEPTED — FLAW" : rpcError(s2.json));

    // ward inheritance
    const s3 = await submit(tWard, contestState, PU1B, VOTES, evA);
    record("ward-level grant covers PUs beneath the ward (hierarchical scope on hosted RLS)",
      s3.status === 200, s3.status === 200 ? "PU beneath granted ward accepted" : rpcError(s3.json));
    const s3b = await submit(tWard, contestState, PU2, VOTES, evA);
    record("ward-level grant does NOT reach the next ward",
      s3b.status >= 400 && /not authorized/i.test(rpcError(s3b.json)),
      s3b.status === 200 ? "ACCEPTED — FLAW" : rpcError(s3b.json));

    // officer tenant-wide submission
    const s4 = await submit(tOfficer, contestGov, PU2, VOTES, evA);
    record("election officer submits (tenant-wide election authority)",
      s4.status === 200, s4.status === 200 ? "accepted" : rpcError(s4.json));

    // amendment: resubmission is a DISTINCT transition (old state → submitted)
    const ridGov = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE tenant_id=$1 AND contest_id=$2 AND polling_unit_id=$3`,
      [tenantE, contestGov, PU2])).rows[0].id;
    const rej = await review(tOfficer, ridGov, "reject", "hosted resubmission test");
    const rs = await submit(tOfficer, contestGov, PU2, VOTES, evA);
    record("resubmission after rejection resets to submitted (distinct 'resubmit' history event)",
      rej.status === 200 && rs.status === 200
      && (Array.isArray(rs.json) ? (rs.json[0] as Record<string, unknown>)?.status : null) === "submitted",
      rs.status === 200 ? JSON.stringify(rs.json) : rpcError(rs.json));

    // evidence integrity
    const s5 = await submit(tReg, contestState, PU1, VOTES, null);
    const s6 = await submit(tReg, contestState, PU1, VOTES, evWrong);
    record("evidence enforced: mandatory + purpose-checked through hosted RPC",
      s5.status >= 400 && /mandatory/i.test(rpcError(s5.json))
      && s6.status >= 400 && /evidence/i.test(rpcError(s6.json)),
      `missing: ${rpcError(s5.json).slice(0, 60)} | wrong purpose: ${rpcError(s6.json).slice(0, 60)}`);

    // officer review → approve
    const rid = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE tenant_id=$1 AND contest_id=$2 AND polling_unit_id=$3`,
      [tenantE, contestState, PU1])).rows[0].id;
    const v1 = await review(tOfficer, rid, "approve", "EC8 verified on hosted");
    const v1r = first(v1.json);
    record("officer approves via live RPC (verified=true, attribution set)",
      v1.status === 200 && v1r?.verified === true,
      v1.status === 200 ? JSON.stringify(v1.json) : rpcError(v1.json));

    // admin correction → forced re-verification
    const c1 = await rest("POST", "/rest/v1/rpc/correct_election_result",
      { p_result: rid, p_votes: VOTES, p_reason: "hosted acceptance correction" }, tAdmin);
    const c1r = first(c1.json);
    record("admin corrects result (pending_review, verified=false)",
      c1.status === 200 && c1r?.status === "pending_review" && c1r?.verified === false,
      c1.status === 200 ? JSON.stringify(c1.json) : rpcError(c1.json));

    // separation of duties: correcting admin cannot approve
    const self = await review(tAdmin, rid, "approve");
    record("correcting admin CANNOT approve own correction (separation of duties)",
      self.status >= 400 && /independent verification required/i.test(rpcError(self.json)),
      self.status === 200 ? "APPROVED — FLAW" : rpcError(self.json));

    // independent re-verification
    const indep = await review(tOfficer, rid, "approve", "independent re-verification");
    const indepR = first(indep.json);
    record("independent officer re-verifies corrected result",
      indep.status === 200 && indepR?.verified === true,
      indep.status === 200 ? JSON.stringify(indep.json) : rpcError(indep.json));

    // officer boundary: no admin correction, no configuration
    const offCorr = await rest("POST", "/rest/v1/rpc/correct_election_result",
      { p_result: rid, p_votes: VOTES, p_reason: "officer attempt" }, tOfficer);
    record("officer cannot perform admin correction",
      offCorr.status >= 400 && /only tenant administrators/i.test(rpcError(offCorr.json)),
      offCorr.status === 200 ? "CORRECTED — FLAW" : rpcError(offCorr.json));

    // amendment: an APPROVED result is immutable by resubmission
    const rsApproved = await submit(tReg, contestState, PU1, VOTES, evA);
    record("approved result CANNOT be overwritten by resubmission (reopen/correct first)",
      rsApproved.status >= 400 && /resubmission blocked/i.test(rpcError(rsApproved.json)),
      rsApproved.status === 200 ? "OVERWRITTEN — FLAW" : rpcError(rsApproved.json));

    // active election configuration (admin-only RPC)
    const cfg = await rest("POST", "/rest/v1/rpc/set_active_election",
      { p_cycle: cycleE, p_contest: contestState }, tAdmin);
    record("admin sets active election/contest (Election-specific settings row)",
      cfg.status === 200, cfg.status === 200 ? "settings row written" : rpcError(cfg.json));
    const cfgOfficer = await rest("POST", "/rest/v1/rpc/set_active_election",
      { p_cycle: cycleE, p_contest: contestState }, tOfficer);
    record("officer cannot configure the active election (not tenant admin)",
      cfgOfficer.status >= 400 && /only tenant administrators/i.test(rpcError(cfgOfficer.json)),
      cfgOfficer.status === 200 ? "CONFIGURED — FLAW" : rpcError(cfgOfficer.json));

    // aggregation (invoker; scope-respecting)
    const agg = await rest("POST", "/rest/v1/rpc/get_results_aggregate",
      { p_cycle: cycleE, p_contest: contestState }, tAdmin);
    const a = (Array.isArray(agg.json) ? agg.json[0] : agg.json) as Record<string, unknown> | null;
    const partyTotals = (a?.party_totals as { acronym: string; total_votes: number }[]) ?? [];
    record("aggregation returns party totals from approved rows (ID-resolved labels, no name strings)",
      agg.status === 200 && partyTotals.length === 2
      && partyTotals.every((p) => /^[A-Z]{3,4}$/.test(p.acronym)),
      agg.status === 200 ? JSON.stringify(partyTotals) : rpcError(agg.json));
    const totalPus = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.polling_units WHERE lga_id = $1`, [LGA])).rows[0].n;
    record("aggregation reporting percentage is geography-derived (total PUs of the contest's LGA)",
      a?.total_pus_in_scope === Number(totalPus), `total_pus_in_scope=${JSON.stringify(a?.total_pus_in_scope)}, lga PUs=${totalPus}`);

    // scoped view reads (security_invoker): registered member sees only own PU row
    const vReg = await rest("GET",
      `/rest/v1/election_results_current?select=polling_unit_id,vote_details&contest_id=eq.${contestState}`, undefined, tReg);
    const regRows = Array.isArray(vReg.json) ? vReg.json as { polling_unit_id: string; vote_details: { acronym: string }[] }[] : [];
    const vd = regRows[0]?.vote_details ?? [];
    record("current-results view: member sees own PU row with ID-resolved party labels",
      vReg.status === 200 && regRows.length === 1 && regRows[0].polling_unit_id === PU1
      && vd.length === 2 && vd.every((d) => typeof d.acronym === "string"),
      vReg.status === 200 ? `${regRows.length} row(s), vote_details acronyms: ${vd.map((d) => d.acronym).join(",")}` : rpcError(vReg.json));

    // ══ 5. denials ═════════════════════════════════════════════════════════
    const socRpc = await submit(tSocial, contestState, PU1, VOTES, evA);
    record("social-only member denied at RPC boundary",
      socRpc.status >= 400 && /social members do not have election access/i.test(rpcError(socRpc.json)),
      socRpc.status === 200 ? "ACCEPTED — FLAW" : rpcError(socRpc.json));
    const socView = await rest("GET", "/rest/v1/election_results_current?select=polling_unit_id", undefined, tSocial);
    record("social-only member sees zero rows through the public view (security_invoker)",
      socView.status === 200 && Array.isArray(socView.json) && socView.json.length === 0,
      `${Array.isArray(socView.json) ? socView.json.length : "?"} rows`);

    const othRpc = await submit(tOther, contestState, PU1, VOTES, evWrong);
    const othView = await rest("GET", `/rest/v1/election_results_current?select=polling_unit_id&contest_id=eq.${contestState}`, undefined, tOther);
    record("tenant isolation: other tenant denied (module gate) and sees zero tenant-E rows",
      othRpc.status >= 400 && othView.status === 200 && Array.isArray(othView.json) && othView.json.length === 0,
      `RPC: ${rpcError(othRpc.json).slice(0, 60)} | view rows: ${Array.isArray(othView.json) ? othView.json.length : "?"}`);

    // history immutability at the hosted API layer (no REST exposure of the
    // politicore schema; REVOKE verified in catalog) + append-only trail check
    const hist = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.election_result_history h
       JOIN politicore.election_results r ON r.id = h.result_id
       WHERE r.tenant_id = $1`, [tenantE]);
    const histActions = await sql.query<{ actions: string[] }>(
      `SELECT array_agg(DISTINCT h.action ORDER BY h.action) actions
       FROM politicore.election_result_history h
       JOIN politicore.election_results r ON r.id = h.result_id
       WHERE r.tenant_id = $1`, [tenantE]);
    record("append-only history recorded every workflow transition (create/resubmit/correct/review)",
      Number(hist.rows[0].n) >= 7
      && histActions.rows[0].actions.includes("create")
      && histActions.rows[0].actions.includes("resubmit")
      && histActions.rows[0].actions.includes("correct")
      && histActions.rows[0].actions.includes("review_approve"),
      `history rows: ${hist.rows[0].n}, actions: ${histActions.rows[0].actions.join(",")}`);

    // amendment: the forensic evidence chain — every vote-bearing event
    // carries its evidence reference (old→new across resubmissions)
    const evChain = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.election_result_history h
       JOIN politicore.election_results r ON r.id = h.result_id
       WHERE r.tenant_id = $1 AND h.new_votes IS NOT NULL AND h.new_evidence_asset_id IS NULL`,
      [tenantE]);
    record("evidence chain: every vote-bearing history event carries its evidence reference",
      evChain.rows[0].n === "0", `events missing evidence ref: ${evChain.rows[0].n}`);

    // amendment: relational analytics through ordinary SQL joins
    const joinTotals = await sql.query<{ acronym: string; total: string }>(
      `SELECT pp.acronym, sum(rv.votes)::text total
       FROM politicore.election_result_votes rv
       JOIN politicore.election_results r ON r.id = rv.result_id
       JOIN politicore.political_parties pp ON pp.id = rv.party_id
       WHERE r.tenant_id = $1 AND r.contest_id = $2 AND r.status = 'approved'
       GROUP BY pp.acronym ORDER BY pp.acronym`, [tenantE, contestState]);
    const jt = Object.fromEntries(joinTotals.rows.map((x) => [x.acronym, Number(x.total)]));
    record("relational analytics: party totals via plain SQL joins over election_result_votes",
      jt["APC"] === 100 && jt["PDP"] === 60, `join totals: ${JSON.stringify(jt)}`);

    // ══ 6. notifications + audit ═══════════════════════════════════════════
    const notif = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications WHERE tenant_id = $1 AND type = 'election'`,
      [tenantE]);
    record("election notifications generated (submission/review/correction events)",
      Number(notif.rows[0].n) >= 3, `election notifications: ${notif.rows[0].n}`);
    const aud = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.system_audits WHERE tenant_id = $1
       AND affected_resource IN ('election_cycles','election_contests','election_settings')`,
      [tenantE]);
    record("election configuration changes audited server-side (existing system_audits)",
      Number(aud.rows[0].n) >= 2, `audit rows: ${aud.rows[0].n}`);

    // ══ 7. cleanup ═════════════════════════════════════════════════════════
    await cleanup(sql, tenantIds, emails);

    const failed = results.filter((r) => !r.ok);
    console.log(`\nHOSTED ELECTION ACCEPTANCE: ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      console.log("FAILED CHECKS:");
      for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
      process.exit(1);
    }
    console.log("HOSTED ELECTION ACCEPTANCE COMPLETE");
  } catch (e) {
    await cleanup(sql, tenantIds, emails);
    console.error("HOSTED ELECTION ACCEPTANCE FAILED:", (e as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
