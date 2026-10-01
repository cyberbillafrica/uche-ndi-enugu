/**
 * POLITICORE — Governance Polls (Phase 16) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 16
 * Polls slice end-to-end through the real PostgREST data API and real
 * GoTrue identities — the same acceptance standard as Phases 6–15:
 *
 *   J1  — anon: zero surface (no reads, no RPC execute, no wrapper)
 *   J2  — admin creates a poll (server mints PL- reference, tenant,
 *         actor; draft status; options stored verbatim)
 *   J3  — RLS reads: staff see drafts; members see open polls only
 *   J4  — lifecycle: draft→closed rejected; results_published rejected;
 *         draft→open; open→closed
 *   J5  — participation: member votes without any permission; duplicate
 *         vote rejected; foreign option rejected; closed-poll vote rejected
 *   J6  — closes_at honored server-side
 *   J7  — privacy: participant sees only their own vote row; anon sees none
 *   J8  — scope authority: ward-scoped manager creates at their ward;
 *         tenant-wide create refused; unrelated ward rejected; campaign
 *         scope forbidden; unknown geography fails closed
 *   J9  — results: premature publish refused; publish_accountability
 *         required; publication lands aggregates on the closed poll
 *   J10 — tenant isolation: cross-tenant read/mutate/vote fail closed
 *   J11 — content freeze: options immutable outside draft
 *   J12 — canonical updates substrate: single-subject invariant unchanged
 *         (four subjects, no poll subject); project updates still work
 *   J13 — core notifications: open fanout is canonical AND recipient-
 *         correct (ward resident notified; wardless member not)
 *   J14 — audit attribution: canonical system_audits rows carry the real
 *         hosted auth.uid() (create/status/vote actions)
 *   J15 — staff creation refused without manage_participation
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

const P16_TABLES = [
  "governance_poll_votes", "governance_poll_scopes", "governance_polls",
  "governance_petition_supports", "governance_petition_scopes", "governance_petitions",
  "governance_consultation_responses", "governance_consultation_scopes",
  "governance_consultations", "governance_updates", "governance_commitment_projects",
  "governance_commitment_scopes", "governance_commitments",
  "governance_project_scopes", "governance_project_milestones", "governance_projects",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], geoIds: string[]) {
  try {
    const CLEAN_TABLES = [
      ...P16_TABLES, "governance_request_events", "governance_assignments",
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
        for (const t of P16_TABLES) {
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
    console.error("cleanup incomplete — remove governance poll fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const P = `GovPoll!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m55 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.vote_governance_poll(uuid,text)') IS NOT NULL
         AND to_regproc('politicore.guard_governance_poll_options') IS NOT NULL AS ok`);
    if (!m55.rows[0].ok) throw new Error("migration 0055 polls missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, admin + scoped manager + members ══════════
    const E = `govpoll-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovPoll — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovPoll — isolation`, `govpoll-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true)`,
      [tenantA, tenantB]);

    const admEmail = `${E}-adm@test.local`;
    const mgrEmail = `${E}-mgr@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const resEmail = `${E}-res@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, mgrEmail, memEmail, resEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "GovPoll Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovPoll Manager", E);
    const memId = await createAuthUser(sql, memEmail, P, "GovPoll Member", E);
    const resId = await createAuthUser(sql, resEmail, P, "GovPoll Ward Resident", E);
    await createAuthUser(sql, isoEmail, P, "GovPoll Iso", `govpoll-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Core Geography fixtures (state → zone → lga → ward chain).
    const STATE = `pst-${SUFFIX}`;
    const ZONE = `pzn-${SUFFIX}`;
    const LGA = `plg-${SUFFIX}`;
    const WARD = `pwd-${SUFFIX}`;
    const WARD2 = `pwd2-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD, WARD2);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P16 State','P6') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P16 Zone','P6') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P16 LGA','P6') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P16 Ward','P6') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P16 Ward2','P7') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

    // Ward-scoped manage_participation grant for the manager; the ward
    // resident's profile carries the ward (recipient-correctness fixture).
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, scope_type, scope_id)
       VALUES ($1, $2, 'manage_participation', true, 'ward', $3)`,
      [tenantA, mgrId, WARD]);
    await sql.query(`UPDATE politicore.profiles SET ward_id = $2, lga_id = $3 WHERE id = $1`, [resId, WARD, LGA]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const mgrToken = await signin(mgrEmail, P);
    const memToken = await signin(memEmail, P);
    const isoToken = await signin(isoEmail, P);

    const rpc = (name: string) => `/rest/v1/rpc/${name}`;
    const OPTIONS = ["Road repairs", "Water access", "Street lighting"];

    // ══ J1. anon zero surface ═════════════════════════════════════════════
    const anonRead = await rest("GET", `/rest/v1/governance_polls?select=*`);
    record("J1a anon has no read access to the polls surface",
      (anonRead.status === 401 || (anonRead.status === 200 && arr(anonRead.json).length === 0)),
      `status ${anonRead.status}, rows ${arr(anonRead.json).length}`);
    const anonRpc = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: "00000000-0000-0000-0000-000000000000", p_choice: "Water access" });
    record("J1b anon cannot execute the vote RPC", anonRpc.status >= 400,
      `status ${anonRpc.status}`);
    const anonVotes = await rest("GET", `/rest/v1/governance_poll_votes?select=*`);
    record("J1c anon sees no vote rows",
      anonVotes.status >= 400 || arr(anonVotes.json).length === 0,
      `status ${anonVotes.status}`);

    // ══ J2. admin creates a poll ═════════════════════════════════════════
    const created = await rest("POST", rpc("create_governance_poll"), {
      p_title: "Hosted ward water poll",
      p_question: "Which water intervention should start first?",
      p_options: OPTIONS,
      p_description: "Aggregate results will be published after closure.",
    }, admToken);
    const pollId = (created.json as { [k: string]: string })?.create_governance_poll
      ?? (created.json as string);
    record("J2a admin creates a poll via RPC",
      created.status === 200 && typeof pollId === "string" && pollId.length > 0,
      `status ${created.status}, id ${String(pollId).slice(0, 8)}…`);

    const prow = (await sql.query<{ reference_code: string; status: string; is_public: boolean; options: string[]; tenant_id: string; created_by: string | null }>(
      `SELECT reference_code, status::text, is_public, options, tenant_id, created_by
         FROM politicore.governance_polls WHERE id = $1`, [pollId])).rows[0];
    record("J2b PL- reference minted; draft; private; options stored; tenant + actor server-stamped",
      /^PL-[0-9A-F]{8}$/.test(prow.reference_code) && prow.status === "draft"
        && prow.is_public === false && JSON.stringify(prow.options) === JSON.stringify(OPTIONS)
        && prow.tenant_id === tenantA && prow.created_by === admId,
      `ref ${prow.reference_code}, status ${prow.status}`);

    // ══ J3. RLS reads — drafts staff-only ════════════════════════════════
    const admSee = await rest("GET", `/rest/v1/governance_polls?id=eq.${pollId}&select=id`, undefined, admToken);
    const memSee = await rest("GET", `/rest/v1/governance_polls?id=eq.${pollId}&select=id`, undefined, memToken);
    record("J3 staff sees the draft; member does not (drafts are staff-only)",
      arr(admSee.json).length === 1 && arr(memSee.json).length === 0,
      `admin rows ${arr(admSee.json).length}, member rows ${arr(memSee.json).length}`);

    // ══ J4. lifecycle ════════════════════════════════════════════════════
    const illegal = await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "closed" }, admToken);
    record("J4a draft → closed rejected by the server guard", illegal.status >= 400,
      `status ${illegal.status}`);

    const noResults = await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "results_published" }, admToken);
    record("J4b results_published is not a poll status (gate §130)", noResults.status >= 400,
      `status ${noResults.status}`);

    const opened = await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "open" }, admToken);
    record("J4c draft → open succeeds", opened.status < 400, `status ${opened.status}`);

    const memSeeOpen = await rest("GET", `/rest/v1/governance_polls?id=eq.${pollId}&select=id,status`, undefined, memToken);
    record("J4d open polls are discoverable by members",
      arr(memSeeOpen.json).length === 1, `member rows ${arr(memSeeOpen.json).length}`);

    // ══ J5. participation ════════════════════════════════════════════════
    const voted = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: pollId, p_choice: "Water access" }, memToken);
    record("J5a member votes without any permission", voted.status === 200,
      `status ${voted.status}`);

    const dup = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: pollId, p_choice: "Road repairs" }, memToken);
    record("J5b duplicate vote rejected (one per participant)", dup.status >= 400,
      `status ${dup.status}`);

    const foreign = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: pollId, p_choice: "Free broadband" }, mgrToken);
    record("J5c a choice outside the poll's own options is rejected", foreign.status >= 400,
      `status ${foreign.status}`);

    // ══ J7. privacy (own-row) — while still open ═════════════════════════
    const own = await rest("GET", `/rest/v1/governance_poll_votes?poll_id=eq.${pollId}&select=*`, undefined, memToken);
    record("J7 participant sees only their own vote row",
      arr(own.json).length === 1, `rows ${arr(own.json).length}`);

    // ══ J6. closes_at honored server-side ════════════════════════════════
    const past = new Date(Date.now() - 60_000).toISOString();
    const closesAtFix = await rest("POST", rpc("update_governance_poll"),
      { p_poll: pollId, p_closes_at: past }, admToken);
    const lateVote = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: pollId, p_choice: "Road repairs" }, mgrToken);
    record("J6 vote refused after a past closes_at",
      (closesAtFix.status === 200 || closesAtFix.status === 204) && lateVote.status >= 400,
      `fix ${closesAtFix.status}, late vote ${lateVote.status}`);
    // clear closes_at for the rest of the journey
    await rest("POST", rpc("update_governance_poll"),
      { p_poll: pollId, p_clear_closes_at: true }, admToken);

    // ══ J8. scope authority ══════════════════════════════════════════════
    const scoped = await rest("POST", rpc("create_governance_poll"), {
      p_title: "Hosted clinic hours poll",
      p_question: "Preferred clinic hours?",
      p_options: ["Morning", "Evening"],
      p_scopes: [{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }],
    }, mgrToken);
    const scopedId = (scoped.json as { [k: string]: string })?.create_governance_poll
      ?? (scoped.json as string);
    record("J8a ward-scoped manager creates a poll AT their ward",
      scoped.status === 200 && typeof scopedId === "string",
      `status ${scoped.status}`);

    const wide = await rest("POST", rpc("create_governance_poll"), {
      p_title: "Hosted wide poll attempt", p_question: "Q?", p_options: OPTIONS,
    }, mgrToken);
    record("J8b scope-scoped manager cannot mint a tenant-wide poll", wide.status >= 400,
      `status ${wide.status}`);

    const road = await rest("POST", rpc("create_governance_poll"), {
      p_title: "Hosted roads probe poll", p_question: "Q?", p_options: OPTIONS,
    }, admToken);
    const roadId = (road.json as { [k: string]: string })?.create_governance_poll
      ?? (road.json as string);
    const outside = await rest("POST", rpc("add_governance_poll_scope"), {
      p_poll: roadId, p_scope_type: "ward",
      p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2,
    }, mgrToken);
    record("J8c scope-scoped manager cannot attach a scope outside their authority",
      outside.status >= 400, `status ${outside.status}`);

    const campaign = await rest("POST", rpc("add_governance_poll_scope"), {
      p_poll: roadId, p_scope_type: "campaign",
    }, admToken);
    record("J8d campaign scope is forbidden", campaign.status >= 400,
      `status ${campaign.status}`);

    const unknownGeo = await rest("POST", rpc("add_governance_poll_scope"), {
      p_poll: roadId, p_scope_type: "ward",
      p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "no-such-ward",
    }, admToken);
    record("J8e unknown geography fails closed", unknownGeo.status >= 400,
      `status ${unknownGeo.status}`);

    // ══ J11. content freeze ══════════════════════════════════════════════
    const frozen = await rest("POST", rpc("update_governance_poll"), {
      p_poll: pollId, p_options: ["Borehole", "Piped supply"],
    }, admToken);
    record("J11 options are immutable once the poll is open", frozen.status >= 400,
      `status ${frozen.status}`);

    // ══ J9. results publication ══════════════════════════════════════════
    const premature = await rest("POST", rpc("publish_poll_results"),
      { p_poll: pollId, p_summary: "premature" }, admToken);
    record("J9a results refused before closure", premature.status >= 400,
      `status ${premature.status}`);

    const closed = await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "closed" }, admToken);
    record("J9b open → closed succeeds", closed.status < 400, `status ${closed.status}`);

    const lateCloseVote = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: pollId, p_choice: "Road repairs" }, memToken);
    record("J9c voting refused on a closed poll", lateCloseVote.status >= 400,
      `status ${lateCloseVote.status}`);

    const mgrNoPub = await rest("POST", rpc("publish_poll_results"),
      { p_poll: pollId, p_summary: "manager attempt" }, mgrToken);
    record("J9d publish_accountability required to publish results", mgrNoPub.status >= 400,
      `status ${mgrNoPub.status}`);

    const published = await rest("POST", rpc("publish_poll_results"),
      { p_poll: pollId, p_summary: "1 vote — water access first.",
        p_results: { "Road repairs": 0, "Water access": 1, "Street lighting": 0 } }, admToken);
    record("J9e results publish on the closed poll", published.status < 400,
      `status ${published.status}`);

    const afterRow = (await sql.query<{ status: string; results: Record<string, number> | null; results_summary: string }>(
      `SELECT status::text, results, results_summary
         FROM politicore.governance_polls WHERE id = $1`, [pollId])).rows[0];
    record("J9f published aggregates stored with the summary",
      afterRow.status === "closed" && afterRow.results_summary.length > 0
        && afterRow.results !== null && afterRow.results["Water access"] === 1,
      `status ${afterRow.status}, results ${JSON.stringify(afterRow.results)}`);

    // ══ J10. tenant isolation ════════════════════════════════════════════
    const foreignRead = await rest("GET", `/rest/v1/governance_polls?id=eq.${pollId}&select=id`, undefined, isoToken);
    record("J10a cross-tenant read returns nothing", arr(foreignRead.json).length === 0,
      `rows ${arr(foreignRead.json).length}`);

    const foreignStatus = await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "open" }, isoToken);
    record("J10b cross-tenant mutation fails closed", foreignStatus.status >= 400,
      `status ${foreignStatus.status}`);

    // open the scoped ward poll to prove cross-tenant VOTE fails even on
    // an open instrument
    await rest("POST", rpc("set_governance_poll_status"), { p_poll: scopedId, p_status: "open" }, mgrToken);
    const foreignVote = await rest("POST", rpc("vote_governance_poll"),
      { p_poll: scopedId, p_choice: "Morning" }, isoToken);
    record("J10c cross-tenant vote fails closed", foreignVote.status >= 400,
      `status ${foreignVote.status}`);

    // ══ J12. canonical updates substrate ═════════════════════════════════
    const updDef = (await sql.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`)).rows[0].d;
    record("J12a single-subject constraint spans project|commitment|consultation|petition — poll NOT a subject",
      updDef.includes("project_id") && updDef.includes("commitment_id")
        && updDef.includes("consultation_id") && updDef.includes("petition_id")
        && !updDef.includes("poll_id"),
      updDef.slice(0, 80) + "…");

    const project = await rest("POST", rpc("create_governance_project"),
      { p_title: "Hosted poll-substrate probe project" }, admToken);
    const projectId = (project.json as { [k: string]: string })?.create_governance_project
      ?? (project.json as string);
    const projectUpdate = await rest("POST", rpc("create_governance_update"),
      { p_project: projectId, p_title: "Kickoff", p_body: "still works" }, admToken);
    record("J12b project updates still work (Phase 12 substrate preserved)",
      projectUpdate.status < 400, `status ${projectUpdate.status}`);

    // ══ J13. core notifications — recipient correctness ══════════════════
    const fanout = await sql.query<{ user_id: string }>(
      `SELECT n.user_id::text FROM politicore.notifications n
        WHERE n.tenant_id = $1 AND n.link_url = '/governance/participate'
          AND n.message LIKE '%Hosted clinic hours poll%'`, [tenantA]);
    const recipients = fanout.rows.map((r) => r.user_id);
    record("J13a the ward-scoped open fanout is canonical and recipient-correct",
      recipients.length > 0 && recipients.includes(resId) && !recipients.includes(memId)
        && !recipients.includes(admId),
      `${recipients.length} recipients (resident in, wardless out)`);

    const crossFan = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications
        WHERE tenant_id = $1 AND message LIKE '%Hosted clinic hours poll%'`, [tenantB]);
    record("J13b no cross-tenant fanout rows", Number(crossFan.rows[0].n) === 0,
      `rows ${crossFan.rows[0].n}`);

    // ══ J14. audit attribution ═══════════════════════════════════════════
    const audits = await sql.query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id::text FROM politicore.system_audits
        WHERE affected_resource = 'governance_polls' AND tenant_id = $1
          AND action IN ('governance_poll:create','governance_poll:status','governance_poll:results_published')
        ORDER BY occurred_at DESC LIMIT 8`, [tenantA]);
    const rpcAudits = audits.rows.filter((r) => r.actor_id !== null);
    record("J14 RPC audits carry the real hosted actor uid",
      rpcAudits.length > 0 && rpcAudits.every((r) => r.actor_id === admId || r.actor_id === mgrId),
      `${rpcAudits.length} audited rows`);
    const voteAudit = await sql.query<{ actor_id: string | null }>(
      `SELECT actor_id::text FROM politicore.system_audits
        WHERE action='governance_poll:vote' AND tenant_id = $1
        ORDER BY occurred_at DESC LIMIT 1`, [tenantA]);
    record("J14b the vote audit carries the voter's own uid",
      voteAudit.rows[0]?.actor_id === memId, `actor ${voteAudit.rows[0]?.actor_id?.slice(0, 8)}…`);

    // ══ J15. staff creation refused without permission ═══════════════════
    const memStaff = await rest("POST", rpc("create_governance_poll"),
      { p_title: "Hosted member poll attempt", p_question: "Q?", p_options: OPTIONS }, memToken);
    record("J15 a member cannot create a poll (manage_participation required)",
      memStaff.status >= 400, `status ${memStaff.status}`);

  } finally {
    await cleanup(sql, tenantIds, emails, geoIds);
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nHOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exitCode = 1;
});
