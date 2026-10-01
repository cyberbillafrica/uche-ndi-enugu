/**
 * POLITICORE — Governance Consultations & Surveys (Phase 14) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 14
 * Participation slice end-to-end through the real PostgREST data API and
 * real GoTrue identities — the same acceptance standard as Phases 6–13:
 *
 *   J1  — anon: zero surface (no reads, no RPC execute on authority RPCs)
 *   J2  — admin creates a consultation AND a survey (server mints PT-
 *         reference, tenant, actor; kind discriminator honored)
 *   J3  — RLS reads: staff see drafts; members see open instruments only
 *   J4  — lifecycle: draft→closed rejected; open→closed; publication gated
 *         by publish_accountability; results_published is terminal
 *   J5  — question integrity: invalid kind rejected; definitions immutable
 *         once open
 *   J6  — participation: member submits without any permission; duplicate,
 *         malformed, unknown-question and out-of-scale answers rejected
 *   J7  — response privacy: participant sees only their own row
 *   J8  — closes_at honored server-side
 *   J9  — scope authority: ward-scoped manager creates at their ward;
 *         tenant-wide create refused; unrelated ward rejected; campaign
 *         scope forbidden
 *   J10 — tenant isolation: cross-tenant read/mutate/participate fail closed
 *   J11 — canonical updates substrate: single-subject invariant spans
 *         project|commitment|consultation; prior subjects still work
 *   J12 — core notifications: open invitations + submission notices are
 *         canonical politicore.notifications rows
 *   J13 — audit attribution: canonical system_audits rows carry the real
 *         hosted auth.uid() as actor
 *   E   — pristine cleanup (fixtures + geo rows; FORCE-RLS state restored)
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

function arr(j: unknown): Record<string, unknown>[] {
  return Array.isArray(j) ? (j as Record<string, unknown>[]) : [];
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
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
             jsonb_build_object('tenant_slug', $5::text, 'full_name', $4::text),
             false,
             extensions.crypt($3, extensions.gen_salt('bf', 10)), now(), now(), now(),
             '', '', '', '',
             $6, '', '')
     RETURNING id`,
    [userId, email, password, fullName, slug, "+8" + userId.replace(/-/g, "").slice(0, 12)]
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

const P14_TABLES = [
  "governance_consultation_responses", "governance_consultation_scopes",
  "governance_consultations", "governance_updates", "governance_commitment_projects",
  "governance_commitment_scopes", "governance_commitments",
  "governance_project_scopes", "governance_project_milestones", "governance_projects",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], geoIds: string[]) {
  try {
    const CLEAN_TABLES = [
      ...P14_TABLES, "governance_request_events", "governance_assignments",
      "governance_requests", "governance_participants", "governance_request_categories",
      "notifications", "permission_grants", "media_assets", "system_audits",
      "tenants", "tenant_modules", "polling_units", "wards", "lgas",
      "senatorial_zones", "states", "profiles",
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
        for (const t of P14_TABLES) {
          await sql.query(`DELETE FROM politicore.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
        }
        await sql.query(`DELETE FROM politicore.governance_request_events WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.governance_assignments WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.governance_requests WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.governance_participants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.governance_request_categories WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.media_assets WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        // profiles: NO FORCE restores delete ability for the cascade from
        // auth.users (the Phase 12 residue lesson).
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        // Geography fixture rows (child-first; the Phase 12 residue lesson).
        await sql.query(`DELETE FROM politicore.polling_units WHERE id = ANY($1)`, [geoIds]);
        await sql.query(`DELETE FROM politicore.wards WHERE id = ANY($1)`, [geoIds]);
        await sql.query(`DELETE FROM politicore.lgas WHERE id = ANY($1)`, [geoIds]);
        await sql.query(`DELETE FROM politicore.senatorial_zones WHERE id = ANY($1)`, [geoIds]);
        await sql.query(`DELETE FROM politicore.states WHERE id = ANY($1)`, [geoIds]);
      }
    } finally {
      await sql.query("SET session_replication_role = DEFAULT");
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove governance participation fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const P = `GovCsu!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m51 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.submit_governance_consultation_response(uuid,jsonb,text)') IS NOT NULL AS ok`);
    if (!m51.rows[0].ok) throw new Error("migration 0051 participation signature missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, admin + scoped manager + member + iso ═════
    const E = `govcsu-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovCsu — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovCsu — isolation`, `govcsu-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true)`,
      [tenantA, tenantB]);

    const admEmail = `${E}-adm@test.local`;
    const mgrEmail = `${E}-mgr@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, mgrEmail, memEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "GovCsu Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovCsu Manager", E);
    const memId = await createAuthUser(sql, memEmail, P, "GovCsu Member", E);
    await createAuthUser(sql, isoEmail, P, "GovCsu Iso", `govcsu-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Core Geography fixtures (state → zone → lga → ward chain).
    const STATE = `cst-${SUFFIX}`;
    const ZONE = `czn-${SUFFIX}`;
    const LGA = `clg-${SUFFIX}`;
    const WARD = `cwd-${SUFFIX}`;
    const WARD2 = `cwd2-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD, WARD2);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P14 State','P4') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P14 Zone','P4') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P14 LGA','P4') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P14 Ward','P4') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P14 Ward2','P5') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

    // Ward-scoped manage_participation grant for the manager.
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, scope_type, scope_id)
       VALUES ($1, $2, 'manage_participation', true, 'ward', $3)`,
      [tenantA, mgrId, WARD]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const mgrToken = await signin(mgrEmail, P);
    const memToken = await signin(memEmail, P);
    const isoToken = await signin(isoEmail, P);

    const rpc = (name: string) => `/rest/v1/rpc/${name}`;
    // PostgREST binds jsonb parameters from real JSON values — a
    // stringified payload would arrive as a jsonb *string* scalar and be
    // rejected by the server-side array validation.
    const QUESTIONS = [
      { id: "q1", kind: "single_choice", prompt: "Priority?", options: ["Roads", "Water"], required: true },
      { id: "q2", kind: "likert", prompt: "Rate services", scale: 5 },
    ];

    // ══ J1. anon zero surface ═════════════════════════════════════════════
    const anonRead = await rest("GET", `/rest/v1/governance_consultations?select=*`);
    record("J1a anon has no read access to the instruments surface",
      (anonRead.status === 401 || (anonRead.status === 200 && arr(anonRead.json).length === 0)),
      `status ${anonRead.status}, rows ${arr(anonRead.json).length}`);
    const anonRpc = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: "00000000-0000-0000-0000-000000000000" });
    record("J1b anon cannot execute the participation RPC", anonRpc.status >= 400,
      `status ${anonRpc.status}`);
    const anonRpc2 = await rest("POST", rpc("create_governance_consultation"),
      { p_kind: "survey", p_title: "anon" });
    record("J1c anon cannot execute the authority RPC", anonRpc2.status >= 400,
      `status ${anonRpc2.status}`);

    // ══ J2. admin creates a consultation + a survey ══════════════════════
    const created = await rest("POST", rpc("create_governance_consultation"), {
      p_kind: "consultation",
      p_title: "Hosted ward services consultation",
      p_description: "Tell us what to prioritise",
      p_questions: QUESTIONS,
    }, admToken);
    const consultationId = (created.json as { [k: string]: string })?.create_governance_consultation
      ?? (created.json as string);
    record("J2a admin creates a consultation via RPC",
      created.status === 200 && typeof consultationId === "string" && consultationId.length > 0,
      `status ${created.status}, id ${String(consultationId).slice(0, 8)}…`);

    const crow = (await sql.query<{ reference_code: string; kind: string; is_public: boolean; tenant_id: string; created_by: string | null }>(
      `SELECT reference_code, kind::text, is_public, tenant_id, created_by
         FROM politicore.governance_consultations WHERE id = $1`, [consultationId])).rows[0];
    record("J2b PT- reference minted; kind + tenant + actor server-stamped; private by default",
      /^PT-[0-9A-F]{8}$/.test(crow.reference_code) && crow.kind === "consultation"
        && crow.is_public === false && crow.tenant_id === tenantA && crow.created_by !== null,
      `ref ${crow.reference_code}`);

    const createdS = await rest("POST", rpc("create_governance_consultation"), {
      p_kind: "survey",
      p_title: "Hosted member survey",
      p_questions: QUESTIONS,
    }, admToken);
    const surveyId = (createdS.json as { [k: string]: string })?.create_governance_consultation
      ?? (createdS.json as string);
    record("J2b survey uses the same canonical table with kind=survey", createdS.status === 200,
      `status ${createdS.status}`);

    // ══ J3. RLS reads — drafts staff-only ════════════════════════════════
    const admSee = await rest("GET", `/rest/v1/governance_consultations?id=eq.${consultationId}&select=id`, undefined, admToken);
    const memSee = await rest("GET", `/rest/v1/governance_consultations?id=eq.${consultationId}&select=id`, undefined, memToken);
    record("J3 staff sees the draft; member does not (drafts are staff-only)",
      arr(admSee.json).length === 1 && arr(memSee.json).length === 0,
      `admin rows ${arr(admSee.json).length}, member rows ${arr(memSee.json).length}`);

    // ══ J4. lifecycle ════════════════════════════════════════════════════
    const illegal = await rest("POST", rpc("set_governance_consultation_status"),
      { p_consultation: consultationId, p_status: "closed" }, admToken);
    record("J4a draft → closed rejected by the server guard", illegal.status >= 400,
      `status ${illegal.status}`);

    const opened = await rest("POST", rpc("set_governance_consultation_status"),
      { p_consultation: consultationId, p_status: "open" }, admToken);
    record("J4b draft → open succeeds", opened.status < 400, `status ${opened.status}`);

    const memSeeOpen = await rest("GET", `/rest/v1/governance_consultations?id=eq.${consultationId}&select=id,status`, undefined, memToken);
    record("J4c open instruments are discoverable by members",
      arr(memSeeOpen.json).length === 1 && arr(memSeeOpen.json)[0].status === "open",
      `member rows ${arr(memSeeOpen.json).length}`);

    // ══ J5. question integrity ═══════════════════════════════════════════
    const badKind = await rest("POST", rpc("create_governance_consultation"), {
      p_kind: "survey", p_title: "Bad kind", p_questions: [{ id: "q1", kind: "poll", prompt: "x" }],
    }, admToken);
    record("J5a unsupported question kind rejected", badKind.status >= 400, `status ${badKind.status}`);
    const editOpen = await rest("POST", rpc("update_governance_consultation"),
      { p_consultation: consultationId, p_title: "Changed while open" }, admToken);
    record("J5b instrument content immutable once open", editOpen.status >= 400, `status ${editOpen.status}`);

    // ══ J6. participation ════════════════════════════════════════════════
    const okResp = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Water", q2: 4 }, p_free_text: "Prioritise water." }, memToken);
    const responseId = (okResp.json as { [k: string]: string })?.submit_governance_consultation_response
      ?? (okResp.json as string);
    record("J6a member submits without any participation permission",
      okResp.status === 200 && typeof responseId === "string", `status ${okResp.status}`);

    const dup = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Roads" } }, memToken);
    record("J6b duplicate participation rejected (one response per participant)", dup.status >= 400,
      `status ${dup.status}`);

    const badOption = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Teleportation" } }, mgrToken);
    record("J6c answer outside the option set rejected", badOption.status >= 400, `status ${badOption.status}`);

    const unknownQ = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Water", ghost: "x" } }, mgrToken);
    record("J6d unknown question id rejected", unknownQ.status >= 400, `status ${unknownQ.status}`);

    const outOfScale = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Water", q2: 9 } }, mgrToken);
    record("J6e out-of-scale likert rejected", outOfScale.status >= 400, `status ${outOfScale.status}`);

    const rrow = (await sql.query<{ participant_id: string; answers: Record<string, unknown> }>(
      `SELECT participant_id, answers FROM politicore.governance_consultation_responses WHERE id = $1`, [responseId])).rows[0];
    const memParticipant = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.governance_participants WHERE profile_id = $1`, [memId])).rows[0];
    record("J6f response bound to the server-resolved participant; answers stored",
      memParticipant && rrow.participant_id === memParticipant.id && rrow.answers.q1 === "Water",
      `participant ${rrow.participant_id.slice(0, 8)}…`);

    // ══ J7. response privacy ═════════════════════════════════════════════
    const memRows = await rest("GET",
      `/rest/v1/governance_consultation_responses?consultation_id=eq.${consultationId}&select=id`, undefined, memToken);
    record("J7a participant sees only their own response row", arr(memRows.json).length === 1,
      `member rows ${arr(memRows.json).length}`);
    const admRows = await rest("GET",
      `/rest/v1/governance_consultation_responses?consultation_id=eq.${consultationId}&select=id`, undefined, admToken);
    record("J7b staff sees the response register", arr(admRows.json).length >= 1,
      `admin rows ${arr(admRows.json).length}`);

    // ══ J8. closes_at honored server-side ════════════════════════════════
    await sql.query(`UPDATE politicore.governance_consultations SET closes_at = now() - interval '1 hour' WHERE id = $1`, [consultationId]);
    const expired = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Water" } }, mgrToken);
    record("J8 submission after closes_at rejected (status still open)", expired.status >= 400,
      `status ${expired.status}`);
    await sql.query(`UPDATE politicore.governance_consultations SET closes_at = NULL WHERE id = $1`, [consultationId]);

    // ══ J9. scope authority ══════════════════════════════════════════════
    const scopedCreate = await rest("POST", rpc("create_governance_consultation"), {
      p_kind: "survey",
      p_title: "Manager ward survey",
      p_scopes: JSON.stringify([{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }]),
    }, mgrToken);
    record("J9a ward-scoped manager creates at their ward", scopedCreate.status === 200,
      `status ${scopedCreate.status}`);
    const unscopedCreate = await rest("POST", rpc("create_governance_consultation"), {
      p_kind: "survey", p_title: "Manager tenant-wide",
    }, mgrToken);
    record("J9b tenant-wide create refused for scoped grantee", unscopedCreate.status >= 400,
      `status ${unscopedCreate.status}`);
    const mgrSurveyId = (scopedCreate.json as { [k: string]: string })?.create_governance_consultation ?? (scopedCreate.json as string);
    const otherWard = await rest("POST", rpc("add_governance_consultation_scope"),
      { p_consultation: mgrSurveyId, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2 }, mgrToken);
    record("J9c unrelated ward rejected", otherWard.status >= 400, `status ${otherWard.status}`);
    const campaignScope = await rest("POST", rpc("add_governance_consultation_scope"),
      { p_consultation: surveyId, p_scope_type: "campaign", p_state_id: STATE }, admToken);
    record("J9d campaign scope forbidden", campaignScope.status >= 400, `status ${campaignScope.status}`);

    // ══ J10. tenant isolation ════════════════════════════════════════════
    const isoRead = await rest("GET", `/rest/v1/governance_consultations?id=eq.${consultationId}&select=id`, undefined, isoToken);
    record("J10a cross-tenant read returns nothing", isoRead.status === 200 && arr(isoRead.json).length === 0,
      `iso rows ${arr(isoRead.json).length}`);
    const isoUpdate = await rest("POST", rpc("set_governance_consultation_status"),
      { p_consultation: consultationId, p_status: "closed" }, isoToken);
    record("J10b cross-tenant RPC mutation fails closed", isoUpdate.status >= 400, `status ${isoUpdate.status}`);
    const isoRespond = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Water" } }, isoToken);
    record("J10c cross-tenant participation fails closed", isoRespond.status >= 400, `status ${isoRespond.status}`);

    // ══ J11. canonical updates substrate ═════════════════════════════════
    const prj = await rest("POST", rpc("create_governance_project"), { p_title: "Csu probe project" }, admToken);
    const prjId = (prj.json as { [k: string]: string })?.create_governance_project ?? (prj.json as string);
    const pupd = await rest("POST", rpc("create_governance_update"),
      { p_project: prjId, p_title: "Kickoff", p_body: "Project updates intact.", p_kind: "progress", p_is_public: false }, admToken);
    record("J11a project updates still work on the canonical substrate", pupd.status === 200, `status ${pupd.status}`);
    const cmt = await rest("POST", rpc("create_governance_commitment"), { p_title: "Csu probe commitment" }, admToken);
    const cmtId = (cmt.json as { [k: string]: string })?.create_governance_commitment ?? (cmt.json as string);
    const cupd = await rest("POST", rpc("create_governance_commitment_update"),
      { p_commitment: cmtId, p_title: "Kickoff", p_body: "Commitment updates intact.", p_kind: "progress", p_is_public: false }, admToken);
    record("J11b commitment updates still work", cupd.status === 200, `status ${cupd.status}`);
    const constraint = (await sql.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'governance_updates_single_subject'`)).rows[0].d;
    record("J11c single-subject invariant spans project|commitment|consultation",
      constraint.includes("project_id") && constraint.includes("commitment_id") && constraint.includes("consultation_id"),
      constraint.slice(0, 80) + "…");

    // ══ J12. core notifications ══════════════════════════════════════════
    const invites = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications
        WHERE tenant_id = $1 AND link_url LIKE '/governance/participate%'`, [tenantA])).rows[0];
    record("J12a open invitation fanout wrote canonical notification rows", Number(invites.n) >= 3,
      `notices ${invites.n}`);
    const staffNotice = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications
        WHERE tenant_id = $1 AND user_id = $2 AND title = 'New participation response'`, [tenantA, admId])).rows[0];
    record("J12b submission notice addressed to the instrument creator", Number(staffNotice.n) >= 1,
      `notices ${staffNotice.n}`);

    // ══ close + publication gates ════════════════════════════════════════
    const closed = await rest("POST", rpc("set_governance_consultation_status"),
      { p_consultation: consultationId, p_status: "closed" }, admToken);
    record("J4d open → closed succeeds", closed.status < 400, `status ${closed.status}`);
    const afterClose = await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consultationId, p_answers: { q1: "Roads" } }, mgrToken);
    record("J4e submission after closure rejected", afterClose.status >= 400, `status ${afterClose.status}`);

    const pubDenied = await rest("POST", rpc("publish_consultation_results"),
      { p_consultation: consultationId, p_summary: "attempt" }, mgrToken);
    record("J4f results publication requires publish_accountability", pubDenied.status >= 400,
      `status ${pubDenied.status}`);
    const pub = await rest("POST", rpc("publish_consultation_results"),
      { p_consultation: consultationId, p_summary: "Water prioritised by most respondents", p_results: { response_count: 1 } }, admToken);
    record("J4g publication succeeds for the publish_accountability holder", pub.status < 400, `status ${pub.status}`);
    const reopen = await rest("POST", rpc("set_governance_consultation_status"),
      { p_consultation: consultationId, p_status: "open" }, admToken);
    record("J4h results_published is terminal", reopen.status >= 400, `status ${reopen.status}`);

    // ══ J13. audit attribution ═══════════════════════════════════════════
    const audits = await sql.query<{ action: string; actor_id: string | null; tenant_id: string }>(
      `SELECT action, actor_id, tenant_id FROM politicore.system_audits
        WHERE affected_resource = 'governance_consultations' AND resource_id = $1
        ORDER BY occurred_at`, [consultationId]);
    // The explicit RPC audits (create + every status transition) must all
    // carry the hosted actor + tenant. (The J8 closes_at fixture rides the
    // owner connection, so its base-trigger row has actor NULL by design —
    // same provenance rule as every prior phase's harness.)
    record("J13 canonical audits carry the hosted actor + tenant",
      audits.rows.some((r) => r.action === "governance_consultation:create")
        && audits.rows.some((r) => r.action === "governance_consultation:status")
        && audits.rows.filter((r) => r.action !== "governance_consultations:update")
            .every((r) => r.tenant_id === tenantA && r.actor_id !== null),
      `${audits.rows.length} audit rows`);
    const respAudit = await sql.query<{ actor_id: string | null }>(
      `SELECT actor_id FROM politicore.system_audits
        WHERE action = 'governance_consultation:response' AND resource_id = $1`, [responseId]);
    record("J13b response audit attributes the real submitting identity",
      respAudit.rows.length === 1 && respAudit.rows[0].actor_id === memId,
      `actor ${String(respAudit.rows[0]?.actor_id ?? "none").slice(0, 8)}…`);

  } catch (e) {
    record("FATAL", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails, geoIds);
    await sql.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nGovernance Consultations & Surveys hosted acceptance: ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main();
