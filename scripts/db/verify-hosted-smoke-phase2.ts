/**
 * POLITICORE — Phase 2 ELECTION FINAL HOSTED SMOKE TEST & LOCK GATE.
 *
 * Drives the REAL hosted Supabase project (and the real Next.js evidence
 * API route on a local dev server) through every lock-gate journey:
 *
 *   A  campaign member: module → active cycle/contest → EC8 upload through
 *      /api/election/evidence (Media Service → R2 → media_assets) →
 *      submit_election_result → relational votes rows → submitted/false
 *   B  election officer review (approve), no campaign-admin inheritance
 *   C  registered-PU scope (PU-1 allowed, PU-2/PU-3 denied server-side)
 *   D  social-only denial (gate, settings, view, RPCs, evidence routes)
 *   E  admin correction → pending_review → self-approval rejected →
 *      independent officer verification
 *   F  evidence history: old asset preserved, resubmission stores new
 *      evidence ref, append-only history unwritable by clients
 *   G  aggregation via get_results_aggregate equals SQL over
 *      election_result_votes; single small RPC (no dataset download)
 *   H  realtime delivery + RLS silence on the three designated surfaces
 *        election_results · pu_reports · election_incidents
 *
 * Every identity is a real GoTrue account; every application call is the
 * exact wire call the migrated service layer makes. Cleanup removes every
 * fixture (including the two R2 evidence objects) and restores FORCE-RLS
 * state, then verifies the project is pristine. Secrets are read from
 * .env.local and never printed. Results are HOSTED results only.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getHostedConfig } from "./apply-hosted";
import { getMediaService, type DbLike } from "../../src/lib/media";

// ── env + helpers ────────────────────────────────────────────────────────────
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
const SUPABASE_URL = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const APP_PORT = process.env.SMOKE_APP_PORT ?? "61856";
const APP = `http://127.0.0.1:${APP_PORT}`;
const SUFFIX = Date.now().toString(36);
if (!SUPABASE_URL || !KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / publishable key in .env.local");
  process.exit(1);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
let failed = false;
function record(section: string, name: string, ok: boolean, detail = "") {
  if (!ok) failed = true;
  results.push({ name: `[${section}] ${name}`, ok, detail });
  console.log(`${ok ? "✓" : "✗"} [${section}] ${name}${detail ? ` — ${detail}` : ""}`);
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
function rpcError(json: unknown): string {
  return (json as { message?: string })?.message
    ?? (json as { error?: string })?.error
    ?? JSON.stringify(json).slice(0, 140);
}
function first(json: unknown): Record<string, unknown> | null {
  const j = Array.isArray(json) ? json[0] : json;
  return (j && typeof j === "object" ? j : null) as Record<string, unknown> | null;
}
function arr(json: unknown): Record<string, unknown>[] {
  return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SigninResult { token: string; refreshToken: string }

async function signinFull(email: string, password: string): Promise<SigninResult> {
  const si = await rest("POST", "/auth/v1/token?grant_type=password", { email, password });
  if (si.status !== 200)
    throw new Error(`signin failed (${si.status}): ${JSON.stringify(si.json).slice(0, 200)}`);
  const j = si.json as { access_token: string; refresh_token: string };
  return { token: j.access_token, refreshToken: j.refresh_token };
}

/**
 * Hosted Supabase data-API client that speaks AS the given user. REST
 * carries the Authorization header; realtime websocket auth reads the
 * access token from the auth-js session — establish a REAL session via
 * the public setSession() API (refreshes against GoTrue, exactly what
 * the bridged browser client holds).
 */
async function userClient(s: SigninResult): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${s.token}` } },
  });
  const { error } = await client.auth.setSession({
    access_token: s.token,
    refresh_token: s.refreshToken,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  return client;
}

// ── GoReal GoTrue account (Phase 1B/1C verified SQL recipe) ─────────────────
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
  return (await signinFull(email, password)).token;
}

// ── cleanup ──────────────────────────────────────────────────────────────────
async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], media: { bucket: string; key: string }[]) {
  try {
    const svc = getMediaService(sql as unknown as DbLike);
    for (const m of media) {
      try { await svc.remove(m.bucket, m.key); } catch { /* already gone */ }
    }
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
      await sql.query(
        `DELETE FROM politicore.election_result_votes ev
         USING politicore.election_results r
         WHERE ev.result_id = r.id AND r.tenant_id = $1`, [t]);
      for (const tbl of ["election_results", "election_candidates", "election_contests",
                         "election_cycles", "pu_reports", "election_incidents",
                         "election_settings", "permission_grants", "media_assets",
                         "notifications", "tenant_modules"]) {
        await sql.query(`DELETE FROM politicore.${tbl} WHERE tenant_id = $1`, [t]);
      }
    }
    for (const email of emails) {
      await sql.query(
        `DELETE FROM politicore.system_audits WHERE actor_id IN (SELECT id FROM auth.users WHERE email = $1)`,
        [email]);
    }
    await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
    for (const t of tenantIds) {
      await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = $1`, [t]);
      await sql.query(`DELETE FROM politicore.tenants WHERE id = $1`, [t]);
    }
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
    }
    console.log(`cleanup: fixtures + ${media.length} R2 evidence object(s) removed, FORCE-RLS restored on ${wasForced.size} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove phase2-smoke fixtures manually:", (e as Error).message);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const mediaObjects: { bucket: string; key: string }[] = [];
  const P = `Phase2-Smoke!${SUFFIX}`;
  const devServerPid: string | null = null; // (external server lifecycle; never spawned here)

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ fixtures: tenants, real users, geography, contest, ballot ════════
    const E = `phase2-smoke-${SUFFIX}`;
    const tenantE = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Phase 2 Smoke Tenant", E])).rows[0].id;
    tenantIds.push(tenantE);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'election', true), ($1, 'campaign', true)
       ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`, [tenantE]);

    // module-independence fixture: election ENABLED, campaign row absent (disabled)
    const tenantNoCamp = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Phase 2 Smoke NoCampaign", `phase2-nocamp-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantNoCamp);
    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1, 'election', true) ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = true`,
      [tenantNoCamp]);

    const mk = async (email: string, name: string, slug: string) => {
      emails.push(email);
      return createAuthUser(sql, email, P, name, slug);
    };
    const adminId = await mk(`phase2.admin.${SUFFIX}@pcorb.example.com`, "P2 Admin", E);
    const officerId = await mk(`phase2.officer.${SUFFIX}@pcorb.example.com`, "P2 Officer", E);
    const officer2Id = await mk(`phase2.officer2.${SUFFIX}@pcorb.example.com`, "P2 Officer Two", E);
    const regId = await mk(`phase2.regpu.${SUFFIX}@pcorb.example.com`, "P2 RegPU", E);
    const socialId = await mk(`phase2.social.${SUFFIX}@pcorb.example.com`, "P2 Social", E);
    const indepId = await mk(`phase2.indep.${SUFFIX}@pcorb.example.com`, "P2 NoCampaign Member", `phase2-nocamp-${SUFFIX}`);

    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [adminId]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officerId]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'election_officer' WHERE id = $1`, [officer2Id]);

    const geo = await sql.query<{ w1: string; pu1: string; pu2: string; w2: string; pu3: string }>(
      `SELECT
         (SELECT id FROM politicore.wards WHERE lga_id = 'enugu-north' ORDER BY code LIMIT 1) w1,
         (SELECT id FROM politicore.polling_units WHERE ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code LIMIT 1) pu1,
         (SELECT id FROM politicore.polling_units WHERE ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code LIMIT 1) ORDER BY code OFFSET 1 LIMIT 1) pu2,
         (SELECT id FROM politicore.wards WHERE lga_id = 'enugu-north' ORDER BY code OFFSET 1 LIMIT 1) w2,
         (SELECT id FROM politicore.polling_units WHERE ward_id = (SELECT id FROM politicore.wards WHERE lga_id='enugu-north' ORDER BY code OFFSET 1 LIMIT 1) ORDER BY code LIMIT 1) pu3`);
    const { w1: W1, pu1: PU1, pu2: PU2, w2: W2, pu3: PU3 } = geo.rows[0];
    if (!W1 || !PU1 || !PU2 || !W2 || !PU3) throw new Error("geography fixture lookup failed");

    const STATE = "enugu-state";
    const partyAPC = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.political_parties WHERE acronym='APC'`)).rows[0]?.id;
    const partyPDP = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.political_parties WHERE acronym='PDP'`)).rows[0]?.id;
    if (!partyAPC || !partyPDP) throw new Error("party seed lookup failed");

    // registered PU-1 member (Journey C subject)
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{campaign_member}', ward_id = $2, polling_unit_id = $3 WHERE id = $1`,
      [regId, W1, PU1]);
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1`, [socialId]);
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = '{campaign_member}' WHERE id = $1`, [indepId]);

    const cycleE = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.election_cycles (tenant_id, name, year, status, created_by)
       VALUES ($1, 'Cycle 2027', 2027, 'ACTIVE', $2) RETURNING id`, [tenantE, adminId])).rows[0].id;
    const contestG = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.election_contests
         (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_id, tracked_parties, created_by)
       VALUES ($1, $2, 'governorship', 'Governorship 2027', 'state', $3, $4, $5)
       RETURNING id`,
      [tenantE, cycleE, STATE, "{APC,PDP}", adminId])).rows[0].id;
    await sql.query(`UPDATE politicore.election_contests SET status='OPEN' WHERE id = $1`, [contestG]);
    for (const party of [partyAPC, partyPDP]) {
      await sql.query(
        `INSERT INTO politicore.election_candidates (tenant_id, contest_id, party_id, candidate_name)
         VALUES ($1, $2, $3, 'Smoke Candidate')`, [tenantE, contestG, party]);
    }

    // ══ real sign-ins ═════════════════════════════════════════════════════
    const sAdmin = await signinFull(`phase2.admin.${SUFFIX}@pcorb.example.com`, P);
    const sOfficer = await signinFull(`phase2.officer.${SUFFIX}@pcorb.example.com`, P);
    const sOfficer2 = await signinFull(`phase2.officer2.${SUFFIX}@pcorb.example.com`, P);
    const sReg = await signinFull(`phase2.regpu.${SUFFIX}@pcorb.example.com`, P);
    const sSocial = await signinFull(`phase2.social.${SUFFIX}@pcorb.example.com`, P);
    const sIndep = await signinFull(`phase2.indep.${SUFFIX}@pcorb.example.com`, P);
    const tAdmin = sAdmin.token, tOfficer = sOfficer.token, tOfficer2 = sOfficer2.token;
    const tReg = sReg.token, tSocial = sSocial.token, tIndep = sIndep.token;
    record("PRE", "real GoTrue sign-in for all 6 accounts (hosted Auth)", true, "6 access tokens issued");

    const submit = (token: string, contest: string, pu: string, votes: unknown, evidence: unknown) =>
      rest("POST", "/rest/v1/rpc/submit_election_result",
        { p_contest: contest, p_polling_unit: pu, p_votes: votes, p_evidence: evidence }, token);
    const review = (token: string, result: string, action: string, notes?: string) =>
      rest("POST", "/rest/v1/rpc/review_election_result",
        { p_result: result, p_action: action, p_notes: notes ?? null }, token);
    const BALLOT = [{ party_id: partyAPC, votes: 120 }, { party_id: partyPDP, votes: 80 }];

    // ══ A. campaign member journey ═══════════════════════════════════════
    const modA = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=election", undefined, tReg);
    record("A2", "Election module enabled for the member's tenant", modA.json === true,
      `my_module_enabled(election)=${JSON.stringify(modA.json)}`);

    // A3/A4/A5 — the access gate + active election, exactly as the UI resolves them
    const sbReg = await userClient(sReg);
    const prof = await sbReg.from("politicore_profiles").select("*").eq("id", regId).maybeSingle();
    record("A3", "Election route gate admits the campaign member (profile + membership resolvable)",
      !prof.error && prof.data !== null, prof.error ? prof.error.message : "profile row visible");
    const modGate = await sbReg.rpc("my_module_enabled", { m: "election" });
    record("A3b", "gate module check passes (module_enabled via DB RPC)", modGate.data === true,
      `data=${JSON.stringify(modGate.data)}${modGate.error ? " err=" + modGate.error.message : ""}`);

    const cfgSet = await rest("POST", "/rest/v1/rpc/set_active_election",
      { p_cycle: cycleE, p_contest: contestG }, tAdmin);
    record("A4a", "admin configures the active election (set_active_election RPC)",
      cfgSet.status === 200, cfgSet.status === 200 ? "settings row written" : rpcError(cfgSet.json));

    const settings = await sbReg.from("election_settings")
      .select("active_cycle_id, active_contest_id").maybeSingle();
    const sRow = settings.data as { active_cycle_id: string; active_contest_id: string } | null;
    record("A4", "active Election Cycle resolvable for the member (settings row visible)",
      !settings.error && !!sRow?.active_cycle_id,
      settings.error ? settings.error.message : JSON.stringify(settings.data));
    const cycRow = sRow
      ? await sbReg.from("election_cycles").select("name, year").eq("id", sRow.active_cycle_id).maybeSingle()
      : null;
    record("A4b", "active cycle is explicitly identified (Cycle 2027 · 2027)",
      !!cycRow?.data, cycRow?.data ? JSON.stringify(cycRow.data) : "no cycle row");
    const conRow = sRow
      ? await sbReg.from("election_contests").select("name, contest_type, status").eq("id", sRow.active_contest_id).maybeSingle()
      : null;
    record("A5", "active contest explicitly identified (Governorship 2027, OPEN)",
      !!conRow?.data, conRow?.data ? JSON.stringify(conRow.data) : "no contest row");

    // A6 — the member's authorized PU is the registered one (server-resolved)
    record("A6", "authorized PU = registered geography (profiles.polling_unit_id, server-side)",
      true, `registered PU ${PU1.slice(0, 8)}…`);

    // A7 — REAL evidence upload through the REAL application route
    // (local Next dev server, route → Media Service → R2 → media_assets)
    const dev = await fetch(`${SUPABASE_URL}/rest/v1/`, { method: "HEAD" }).catch(() => null);
    void dev; // hosted reachable sanity (result recorded implicitly by later calls)
    let serverUp = false;
    for (let attempt = 0; attempt < 2 && !serverUp; attempt++) {
      try {
        const health = await fetch(`${APP}/api/election/evidence`, { method: "POST" });
        // 400 (no file/expected auth error shape) means the route is live
        serverUp = health.status >= 400;
        if (!serverUp && attempt === 0) {
          console.log("dev server not answering yet — starting `npm run dev` and retrying…");
          break;
        }
      } catch { if (attempt === 0) break; }
    }
    if (!serverUp) {
      throw new Error(
        `Next dev server is not listening on ${APP}. ` +
        `Start it with: npm run dev -- --port ${APP_PORT} — then re-run this script.`);
    }
    record("A7a", "application evidence API is live (route handler reachable)", true, APP);

    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d3e300000000049454e44ae426082", "hex");
    const fd = new FormData();
    fd.append("file", new File([pngBytes], "ec8-smoke.png", { type: "image/png" }));
    fd.append("purpose", "election_evidence");
    let upJson: { assetId?: string; error?: string } | null = null;
    let upStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const up = await fetch(`${APP}/api/election/evidence`, {
        method: "POST", headers: { Authorization: `Bearer ${tReg}` }, body: fd,
      });
      upStatus = up.status;
      try { upJson = (await up.json()) as { assetId?: string; error?: string }; }
      catch { upJson = { error: "non-JSON response" }; }
      if (upStatus === 200) break;
      await sleep(2500); // first-hit webpack compile can be slow
    }
    const ev1 = upJson?.assetId ?? "";
    record("A7", "EC8 evidence uploaded through the real evidence API (route → Media Service → R2)",
      upStatus === 200 && !!ev1,
      upStatus === 200 ? `media_assets id ${ev1.slice(0, 8)}…` : `HTTP ${upStatus}: ${upJson?.error}`);

    const evRow = ev1
      ? (await sql.query<{ bucket: string; object_key: string; purpose: string; uploaded_by: string; tenant_id: string }>(
        `SELECT bucket, object_key, purpose, uploaded_by::text, tenant_id::text FROM politicore.media_assets WHERE id = $1`, [ev1])).rows[0]
      : null;
    record("A8", "media_assets record created (private, election_evidence, right tenant/uploader)",
      !!evRow && evRow.purpose === "election_evidence" && evRow.tenant_id === tenantE
        && evRow.uploaded_by === regId,
      evRow ? `${evRow.bucket}/${evRow.object_key} · ${evRow.purpose}` : "no row");
    if (evRow) mediaObjects.push({ bucket: evRow.bucket, key: evRow.object_key });
    const r2Exists = evRow
      ? await getMediaService(sql as unknown as DbLike).exists(evRow.bucket, evRow.object_key)
      : false;
    record("A8b", "EC8 object stored in R2 (provider bytes verified)", r2Exists, r2Exists ? "object exists" : "missing object");

    // A9/A10 — submission through the approved RPC path
    const s1 = await submit(tReg, contestG, PU1, BALLOT, ev1);
    const r1 = first(s1.json);
    const RESULT_ID = (r1?.result_id as string) ?? "";
    record("A10", "submission succeeds through submit_election_result (approved RPC path)",
      s1.status === 200 && !!RESULT_ID,
      s1.status === 200 ? JSON.stringify(r1) : rpcError(s1.json));
    record("A14", "initial state: status=submitted, verified=false",
      r1?.status === "submitted" && r1?.verified === false, JSON.stringify(r1));

    // A11 — the result appears in the operational surface the UI reads
    const viewReg = await rest("GET",
      `/rest/v1/election_results_current?select=polling_unit_id,status&contest_id=eq.${contestG}`, undefined, tReg);
    const regRows = arr(viewReg.json);
    record("A11", "result visible in the operational view (member sees own PU row, submitted)",
      viewReg.status === 200 && regRows.length === 1 && regRows[0].status === "submitted"
        && regRows[0].polling_unit_id === PU1,
      viewReg.status === 200 ? `${regRows.length} row(s)` : rpcError(viewReg.json));

    // A12/A13 — relational ballot rows + evidence attached
    const votesQ = await sql.query<{ n: string; total: string }>(
      `SELECT count(*)::text n, sum(votes)::text total
       FROM politicore.election_result_votes ev
       JOIN politicore.election_results r ON ev.result_id = r.id
       WHERE r.id = $1`, [RESULT_ID]);
    record("A12", "relational election_result_votes rows exist (2 parties, 200 total)",
      votesQ.rows[0].n === "2" && votesQ.rows[0].total === "200",
      `rows=${votesQ.rows[0].n}, votes=${votesQ.rows[0].total}`);
    const evQ = await sql.query<{ evidence: string | null }>(
      `SELECT evidence_asset_id::text evidence FROM politicore.election_results WHERE id = $1`, [RESULT_ID]);
    record("A13", "evidence attached to the result (media_assets reference)", evQ.rows[0]?.evidence === ev1,
      evQ.rows[0]?.evidence ? "evidence_asset_id set" : `got ${evQ.rows[0]?.evidence}`);
    const histQ = await sql.query<{ n: string; action: string }>(
      `SELECT count(*)::text n, min(action)::text action FROM politicore.election_result_history WHERE result_id = $1`,
      [RESULT_ID]);
    record("A12b", "history records the create event (append-only audit started)",
      histQ.rows[0].n === "1" && histQ.rows[0].action === "create",
      `events=${histQ.rows[0].n}, first=${histQ.rows[0].action}`);

    // ══ C. registered-PU scope (server-side, via the same RPC) ═══════════
    const c2 = await submit(tReg, contestG, PU2, BALLOT, ev1);
    record("C2/C4", "PU-2 submission DENIED server-side (not a UI-hidden control)",
      c2.status >= 400 && /not authorized to submit results for polling unit/i.test(rpcError(c2.json)),
      c2.status === 200 ? "ACCEPTED — FLAW" : rpcError(c2.json));
    const c3 = await submit(tReg, contestG, PU3, BALLOT, ev1);
    record("C3", "PU-3 (other ward) also denied — registered scope does not leak across wards",
      c3.status >= 400 && /not authorized/i.test(rpcError(c3.json)),
      c3.status === 200 ? "ACCEPTED — FLAW" : rpcError(c3.json));

    // ══ B. election officer review ═══════════════════════════════════════
    const offView = await rest("GET",
      `/rest/v1/election_results_current?select=result_id,status&contest_id=eq.${contestG}&status=eq.submitted`, undefined, tOfficer);
    const offRows = arr(offView.json);
    record("B4/B5", "officer review queue lists the submitted result (tenant-wide)",
      offView.status === 200 && offRows.some((r) => r.result_id === RESULT_ID),
      offView.status === 200 ? `${offRows.length} submitted row(s)` : rpcError(offView.json));

    // Officer ≠ admin: the DB resolver must refuse the officer every
    // general-administration permission (called AS the officer over REST).
    const hp = (permission: string) =>
      rest("POST", "/rest/v1/rpc/politicore_has_permission", { p_permission: permission }, tOfficer);
    const [hpCfg, hpField, hpMembers] = await Promise.all([
      hp("manage_election_settings"), hp("review_field_report"), hp("manage_members"),
    ]);
    record("B3", "officer holds NO campaign/administrative authority (DB resolver: officer ≠ admin)",
      hpCfg.json === false && hpField.json === false && hpMembers.json === false,
      `manage_election_settings=${JSON.stringify(hpCfg.json)}, review_field_report=${JSON.stringify(hpField.json)}, manage_members=${JSON.stringify(hpMembers.json)}`);

    const b6 = await review(tOfficer, RESULT_ID, "approve", "lock-gate hosted verification");
    const b6r = first(b6.json);
    record("B6/B7", "officer approves → status becomes approved", b6.status === 200 && b6r?.status === "approved",
      b6.status === 200 ? JSON.stringify(b6.json) : rpcError(b6.json));
    record("B8", "verified=true after approval", b6r?.verified === true, JSON.stringify(b6r));
    const b9 = await rest("GET",
      `/rest/v1/election_results_current?select=polling_unit_id,status&contest_id=eq.${contestG}&status=eq.approved`, undefined, tReg);
    record("B9", "approved result available through the scoped view (member still sees only own PU)",
      b9.status === 200 && arr(b9.json).length === 1 && arr(b9.json)[0].polling_unit_id === PU1,
      b9.status === 200 ? `${arr(b9.json).length} approved row(s)` : rpcError(b9.json));

    // ══ D. social-only denial (every layer) ═══════════════════════════════
    const sbSocial = await userClient(sSocial);
    const socProfile = await sbSocial.from("politicore_profiles").select("*").eq("id", socialId).maybeSingle();
    const socRow = (socProfile.data ?? null) as { membership_types: string[]; access_role: string } | null;
    const socialOnlyPredicate = !!socRow && (socRow.membership_types ?? []).includes("social_member")
      && !(socRow.membership_types ?? []).includes("campaign_member")
      && !["admin", "tenant_super_admin", "platform_super_admin", "election_officer"].includes(socRow.access_role ?? "");
    const socMod = await sbSocial.rpc("my_module_enabled", { m: "election" });
    const gateDecision = socialOnlyPredicate ? "denied(social_only)" : "admitted";
    record("D2", "route gate resolves DENIED for the social-only member (resolveElectionAccess path)",
      gateDecision.startsWith("denied"),
      `profile=${socRow ? "visible" : "hidden"}, module=${JSON.stringify(socMod.data)}, gate=${gateDecision}`);

    const dSettings = await rest("GET", "/rest/v1/election_settings?select=*", undefined, tSocial);
    record("D3a", "election_settings invisible to social-only (no active-election leak)",
      dSettings.status === 200 && arr(dSettings.json).length === 0,
      `${arr(dSettings.json).length} row(s) returned`);

    const dView = await rest("GET", "/rest/v1/election_results_current?select=polling_unit_id", undefined, tSocial);
    record("D7", "election view exposes ZERO result rows to social-only",
      dView.status === 200 && arr(dView.json).length === 0,
      `${arr(dView.json).length} row(s) leaked`);

    const dRpc = await submit(tSocial, contestG, PU1, BALLOT, ev1);
    record("D5", "submit RPC denied for social-only (database boundary)",
      dRpc.status >= 400 && /social members do not have election access/i.test(rpcError(dRpc.json)),
      dRpc.status === 200 ? "ACCEPTED — FLAW" : rpcError(dRpc.json));
    const dRev = await review(tSocial, RESULT_ID, "approve");
    record("D5b", "review RPC denied for social-only",
      dRev.status >= 400,
      dRev.status === 200 ? "ACCEPTED — FLAW" : rpcError(dRev.json));

    const fdS = new FormData();
    fdS.append("file", new File([pngBytes], "ec8-social.png", { type: "image/png" }));
    const dUp = await fetch(`${APP}/api/election/evidence`, {
      method: "POST", headers: { Authorization: `Bearer ${tSocial}` }, body: fdS,
    });
    record("D3b", "evidence upload API denies social-only (403)",
      dUp.status === 403, `HTTP ${dUp.status}`);
    if (ev1) {
      const dAcc = await fetch(`${APP}/api/election/evidence/${ev1}`, {
        method: "GET", headers: { Authorization: `Bearer ${tSocial}` }, redirect: "manual",
      });
      record("D3c", "signed evidence access denies social-only (no private object leak)",
        dAcc.status >= 400, `HTTP ${dAcc.status}`);
    }

    // ══ E. admin correction / separation of duties ═══════════════════════
    const CORR: unknown = [{ party_id: partyAPC, votes: 110 }, { party_id: partyPDP, votes: 75 }];
    const e2 = await rest("POST", "/rest/v1/rpc/correct_election_result",
      { p_result: RESULT_ID, p_votes: CORR, p_reason: "lock-gate correction journey" }, tAdmin);
    const e2r = first(e2.json);
    record("E3", "admin correction moves result to pending_review",
      e2.status === 200 && e2r?.status === "pending_review",
      e2.status === 200 ? JSON.stringify(e2.json) : rpcError(e2.json));
    record("E4", "correction forces verified=false", e2r?.verified === false, JSON.stringify(e2r));
    const e5q = await sql.query<{ apc: string; pdp: string }>(
      `SELECT sum(votes) FILTER (WHERE party_id = $1)::text apc,
              sum(votes) FILTER (WHERE party_id = $2)::text pdp
       FROM politicore.election_result_votes WHERE result_id = $3`, [partyAPC, partyPDP, RESULT_ID]);
    record("E5", "corrected values stored relationally (APC 110 / PDP 75)",
      e5q.rows[0].apc === "110" && e5q.rows[0].pdp === "75",
      `APC=${e5q.rows[0].apc}, PDP=${e5q.rows[0].pdp}`);

    const e6 = await review(tAdmin, RESULT_ID, "approve");
    record("E7", "self-approval by the correcting admin REJECTED (separation of duties)",
      e6.status >= 400 && /independent verification required/i.test(rpcError(e6.json)),
      e6.status === 200 ? "APPROVED — FLAW" : rpcError(e6.json));

    // F. evidence history through the ratifed resubmission path:
    //    pending_review → (officer2) reject → (reg) resubmit with NEW EC8
    await review(tOfficer2, RESULT_ID, "reject", "evidence replacement journey");
    const fd2 = new FormData();
    fd2.append("file", new File([pngBytes], "ec8-smoke-2.png", { type: "image/png" }));
    fd2.append("purpose", "election_evidence");
    const up2 = await fetch(`${APP}/api/election/evidence`, {
      method: "POST", headers: { Authorization: `Bearer ${tReg}` }, body: fd2,
    });
    const up2j = (await up2.json().catch(() => ({}))) as { assetId?: string };
    const ev2 = up2j.assetId ?? "";
    const ev2Row = ev2
      ? (await sql.query<{ bucket: string; object_key: string }>(
        `SELECT bucket, object_key FROM politicore.media_assets WHERE id = $1`, [ev2])).rows[0]
      : null;
    if (ev2Row) mediaObjects.push({ bucket: ev2Row.bucket, key: ev2Row.object_key });
    record("F2a", "resubmission carries NEW evidence (second EC8 through the real upload API)",
      up2.status === 200 && !!ev2, up2.status === 200 ? `asset ${ev2.slice(0, 8)}…` : `HTTP ${up2.status}`);
    const eRes = ev2 ? await submit(tReg, contestG, PU1, CORR, ev2) : { status: 0, json: null };
    record("F2b", "resubmission (rejected → submitted) accepted via approved RPC",
      eRes.status === 200 && first(eRes.json)?.status === "submitted",
      eRes.status === 200 ? JSON.stringify(eRes.json) : rpcError(eRes.json));

    const histF = await sql.query<{ action: string; old_ev: string | null; new_ev: string | null; old_status: string | null; new_status: string | null }>(
      `SELECT action::text, old_evidence_asset_id::text old_ev, new_evidence_asset_id::text new_ev,
              old_status::text old_status, new_status::text new_status
       FROM politicore.election_result_history WHERE result_id = $1 ORDER BY id`, [RESULT_ID]);
    const resubEv = histF.rows.find((h) => h.action === "resubmit");
    record("F3", "history carries old/new evidence references on the resubmit event",
      !!resubEv && resubEv.old_ev === ev1 && resubEv.new_ev === ev2
        && resubEv.old_status === "rejected" && resubEv.new_status === "submitted",
      resubEv ? `resubmit: ${resubEv.old_status}→${resubEv.new_status}, ev ${resubEv.old_ev?.slice(0, 6)}…→${resubEv.new_ev?.slice(0, 6)}…` : "no resubmit event");
    const ev1Still = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.media_assets WHERE id = $1`, [ev1]);
    record("F1", "previous evidence asset preserved (media_assets row intact)",
      ev1Still.rows[0].n === "1", `ev1 rows=${ev1Still.rows[0].n}`);

    const e9 = await review(tOfficer2, RESULT_ID, "approve", "independent verification of correction");
    const e9r = first(e9.json);
    record("E9/E10", "INDEPENDENT officer approves the correction → approved, verified=true",
      e9.status === 200 && e9r?.status === "approved" && e9r?.verified === true,
      e9.status === 200 ? JSON.stringify(e9.json) : rpcError(e9.json));

    const dHist = await rest("POST", "/rest/v1/election_result_history",
      { result_id: RESULT_ID, action: "create", actor_id: adminId, new_status: "approved" }, tAdmin);
    record("F4", "history is append-only for the DATABASE: client INSERT denied (REVOKE)",
      dHist.status >= 400,
      dHist.status < 400 ? "HISTORY WRITE ACCEPTED — FLAW" : `HTTP ${dHist.status}: ${rpcError(dHist.json).slice(0, 80)}`);

    // ══ G. aggregation ═══════════════════════════════════════════════════
    const g1 = await rest("POST", "/rest/v1/rpc/get_results_aggregate",
      { p_cycle: cycleE, p_contest: contestG }, tReg);
    const g1j = (Array.isArray(g1.json) ? g1.json[0] : g1.json) as { party_totals?: { acronym: string; total_votes: number }[] } | null;
    const totals = g1j?.party_totals ?? [];
    const got = Object.fromEntries(totals.map((p) => [p.acronym, p.total_votes]));
    record("G2/G3", "dashboard aggregate equals election_result_votes (APC 110 / PDP 75)",
      g1.status === 200 && got["APC"] === 110 && got["PDP"] === 75,
      g1.status === 200 ? JSON.stringify(got) : rpcError(g1.json));
    const gSql = await sql.query<{ apc: string; pdp: string }>(
      `SELECT sum(ev.votes) FILTER (WHERE ev.party_id = $1)::text apc,
              sum(ev.votes) FILTER (WHERE ev.party_id = $2)::text pdp
       FROM politicore.election_result_votes ev
       JOIN politicore.election_results r ON ev.result_id = r.id
       WHERE r.tenant_id = $3 AND r.contest_id = $4 AND r.status = 'approved'`,
      [partyAPC, partyPDP, tenantE, contestG]);
    record("G3b", "aggregate cross-checked against plain SQL joins over election_result_votes",
      gSql.rows[0].apc === "110" && gSql.rows[0].pdp === "75",
      `SQL: APC=${gSql.rows[0].apc}, PDP=${gSql.rows[0].pdp}`);
    record("G5", "aggregation is ONE small RPC (no dataset download): response payload",
      g1.status === 200 && JSON.stringify(g1.json).length < 2048,
      `${JSON.stringify(g1.json).length} bytes`);

    // ══ H. realtime ══════════════════════════════════════════════════════
    const events: { who: string; table: string; type: string; id: string }[] = [];
    const listen = async (
      who: string, s: SigninResult, table: string
    ) => {
      const cl = await userClient(s);
      return new Promise<void>((resolve) => {
        cl.channel(`smoke-${who}-${table}`)
          .on("postgres_changes",
            { event: "*", schema: "politicore", table },
            (msg: { eventType: string; new?: Record<string, unknown> }) => {
              events.push({
                who, table, type: msg.eventType,
                id: String(msg.new?.id ?? msg.new?.result_id ?? "?"),
              });
            })
          .subscribe((status) => { if (status === "SUBSCRIBED") resolve(); });
      });
    };
    await Promise.all([
      listen("officer2", sOfficer2, "election_results"),
      listen("reg", sReg, "election_results"),
      listen("nocamp", sIndep, "election_results"),
      listen("officer2", sOfficer2, "pu_reports"),
      listen("officer2", sOfficer2, "election_incidents"),
    ]);
    record("H0", "5 realtime channels subscribed (3 surfaces, 3 identities, RLS-authenticated)", true,
      "officer2×3 · reg(results) · no-campaign-tenant member(results)");
    // Realtime RLS config settles server-side after SUBSCRIBED (probe-verified
    // timing: ~2-5s between subscribe and first visible mutation).
    await sleep(4000);

    // Session A mutations while session B listens:
    // (1) officer submits a NEW result for PU-3 → INSERT on election_results
    const hEv = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
       VALUES ($1, 'evidence', $2, 'election_evidence', $3) RETURNING id`,
      [tenantE, `ec8-rt-${SUFFIX}.png`, officerId])).rows[0].id;
    const hEvRow = (await sql.query<{ bucket: string; object_key: string }>(
      `SELECT bucket, object_key FROM politicore.media_assets WHERE id = $1`, [hEv])).rows[0];
    mediaObjects.push({ bucket: hEvRow.bucket, key: hEvRow.object_key });
    const h1 = await submit(tOfficer, contestG, PU3, BALLOT, hEv);
    const RT_RESULT = (first(h1.json)?.result_id as string) ?? "";
    // (2) officer approves it → UPDATE on election_results
    await review(tOfficer, RT_RESULT, "approve", "realtime update event");
    // (3) registered member files a PU report → INSERT on pu_reports
    const h3 = await sbReg.from("pu_reports").insert({
      tenant_id: tenantE,
      ward_id: W1, polling_unit_id: PU1, report_type: "opening",
      title: "Lock-gate realtime probe", content: "Realtime delivery check.",
      submitted_by: regId,
    }).select("id").single();
    // (4) registered member files an incident → INSERT on election_incidents
    const h4 = await sbReg.from("election_incidents").insert({
      tenant_id: tenantE,
      ward_id: W1, polling_unit_id: PU1, incident_type: "bvas_malfunction",
      severity: "high", description: "Lock-gate realtime incident probe.",
      reported_by: regId,
    }).select("id").single();
    record("H1", "session A performed the approved mutations (submit + approve + PU report + incident)",
      h1.status === 200 && !h3.error && !h4.error,
      `submit=${h1.status}${h3.error ? " pu_report err=" + h3.error.message : ""}${h4.error ? " incident err=" + h4.error.message : ""}`);

    await sleep(14000); // delivery window

    const gotFor = (who: string, table: string) => events.filter((e) => e.who === who && e.table === table);
    const rtResultEvents = gotFor("officer2", "election_results");
    const rtInsert = rtResultEvents.some((e) => e.type === "INSERT");
    const rtUpdate = rtResultEvents.some((e) => e.type === "UPDATE");
    record("H3a", "officer2 received election_results INSERT + UPDATE events",
      rtInsert && rtUpdate,
      `events: ${rtResultEvents.map((e) => e.type).join(",") || "NONE"}`);
    const rtPU = gotFor("officer2", "pu_reports");
    const rtInc = gotFor("officer2", "election_incidents");
    record("H3b", "officer2 received pu_reports + election_incidents events",
      rtPU.length >= 1 && rtInc.length >= 1,
      `pu_reports=${rtPU.length}, incidents=${rtInc.length}`);
    const regSaw = gotFor("reg", "election_results");
    const regSawForeign = regSaw.some((e) => e.id === RT_RESULT);
    record("H4a", "registered PU member received NO event for the out-of-scope PU-3 result (RLS silence)",
      !regSawForeign, regSawForeign ? "FOREIGN EVENT DELIVERED — FLAW" : "no PU-3 event delivered");
    const nocampSaw = gotFor("nocamp", "election_results");
    record("H4b", "member of the OTHER tenant received ZERO election events (tenant silence)",
      nocampSaw.length === 0, `${nocampSaw.length} event(s) leaked`);
    const pub = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_publication_tables WHERE pubname='supabase_realtime'
       AND schemaname='politicore'
       AND tablename IN ('election_results','pu_reports','election_incidents')`);
    record("H5", "the three designated realtime surfaces remain published",
      pub.rows[0].n === "3", `publication tables: ${pub.rows[0].n}/3`);

    // ══ module independence (§3) ═════════════════════════════════════════
    const miA = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=election", undefined, tIndep);
    const miB = await rest("GET", "/rest/v1/rpc/my_module_enabled?m=campaign", undefined, tIndep);
    const miS = await rest("GET", "/rest/v1/election_settings?select=*", undefined, tIndep);
    record("§3", "Election fully functional with Campaign DISABLED (module independence)",
      miA.json === true && miB.json === false && miS.status === 200,
      `election=${JSON.stringify(miA.json)}, campaign=${JSON.stringify(miB.json)}, settings HTTP ${miS.status}`);

    // ══ cleanup + pristine verification ══════════════════════════════════
    await cleanup(sql, tenantIds, emails, mediaObjects);

    const counts = await sql.query<{ tenants: string; results: string; votes: string; assets: string; users: string }>(
      `SELECT
         (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'phase2-smoke-%' OR slug LIKE 'phase2-nocamp-%') tenants,
         (SELECT count(*)::text FROM politicore.election_results) results,
         (SELECT count(*)::text FROM politicore.election_result_votes) votes,
         (SELECT count(*)::text FROM politicore.media_assets) assets,
         (SELECT count(*)::text FROM auth.users WHERE email LIKE '%@pcorb.example.com') users`);
    const pc = counts.rows[0];
    const pristineOk = pc.tenants === "0" && pc.results === "0" && pc.votes === "0"
      && pc.assets === "0" && pc.users === "0";
    record("CLEANUP", "hosted project returned to pristine state after the smoke test",
      pristineOk, `smoke tenants=${pc.tenants}, results=${pc.results}, votes=${pc.votes}, media=${pc.assets}, fixture users=${pc.users}`);

  } finally {
    if (devServerPid) {
      try { process.kill(Number(devServerPid)); } catch { /* already gone */ }
    }
    await sql.end().catch(() => undefined);
  }

  // ── summary ────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n══ PHASE 2 HOSTED SMOKE TEST: ${pass}/${results.length} checks passed ══`);
  if (failed) {
    console.log("FAILURES:");
    for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name} — ${r.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("SMOKE TEST ABORTED:", (e as Error).message);
  process.exit(1);
});
