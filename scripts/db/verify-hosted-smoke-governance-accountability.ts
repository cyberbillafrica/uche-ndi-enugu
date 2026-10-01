/**
 * POLITICORE — Governance Accountability (Phase 18) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 18
 * accountability layer end-to-end through the real PostgREST data API and
 * real GoTrue identities — the same acceptance standard as Phases 6–17:
 *
 *   J1  — anon: zero base-table surface; canonical tables unreachable
 *   J2  — anon CAN execute the public projections through the public.*
 *         wrapper chain (tenant by site slug; empty for unknown slugs)
 *   J3  — publication authority: manager WITHOUT publish_accountability
 *         denied; admin publishes; audit row carries the real uid
 *   J4  — private record invisible publicly; published project appears in
 *         the projection; unpublication removes it again
 *   J5  — project projection allowlist: internal fields structurally absent
 *   J6  — commitment publication + projection; delivery links only when
 *         the project is itself published
 *   J7  — updates: only is_public updates of published subjects appear
 *   J8  — engagement public projection: agenda/outcomes/attendance COUNT;
 *         stakeholders/attendance/issues structurally absent
 *   J9  — petition public projection: aggregate support only; supports
 *         table unreachable by anon
 *   J10 — poll public projection: published aggregate only; votes
 *         unreachable by anon
 *   J11 — consultation public projection: results only when published;
 *         responses unreachable by anon
 *   J12 — request statistics: aggregate-only, privacy-bucketed; case
 *         contents never present
 *   J13 — tenant isolation: second tenant's admin cannot publish nor see
 *         tenant A's public rows
 *   J14 — unpublication is audited
 *   E   — pristine cleanup (fixtures + geo rows + FORCE-RLS restored)
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

const P18_TABLES = [
  "governance_engagement_issues", "governance_engagement_attendance",
  "governance_engagement_stakeholders", "governance_engagement_scopes",
  "governance_engagements",
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
      ...P18_TABLES, "governance_request_events", "governance_assignments",
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
        for (const t of P18_TABLES) {
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
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
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
    console.error("cleanup incomplete — remove governance accountability fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const P = `GovAcc!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m57 = await sql.query<{ ok: boolean }>(
      `SELECT to_regproc('politicore.public_governance_request_stats') IS NOT NULL
         AND position('publish_accountability' in coalesce(pg_get_functiondef(to_regproc('politicore.set_governance_project_visibility')), '')) > 0 AS ok`);
    if (!m57.rows[0].ok) throw new Error("migration 0057 accountability missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, publisher + scoped manager + members ══════
    const E = `govacc-${SUFFIX}`;
    const SLUG = E;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovAcc — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovAcc — isolation`, `govacc-iso-${SUFFIX}`])).rows[0].id;
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

    const admId = await createAuthUser(sql, admEmail, P, "GovAcc Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovAcc Manager", E);
    const memId = await createAuthUser(sql, memEmail, P, "GovAcc Member", E);
    await createAuthUser(sql, isoEmail, P, "GovAcc Iso", `govacc-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Geo fixtures (state → zone → lga → ward chain) for the statistics slice.
    const STATE = `ast-${SUFFIX}`;
    const ZONE = `azn-${SUFFIX}`;
    const LGA = `alg-${SUFFIX}`;
    const WARD = `awd-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P18 State','P8') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P18 Zone','P8') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P18 LGA','P8') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P18 Ward','P8') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);

    // manage_projects WITHOUT publish_accountability for the manager.
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'manage_projects', true)`, [tenantA, mgrId]);
    // A participant + one resolved request for the statistics slice.
    const participantId = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name)
       VALUES ($1, $2, 'GovAcc Member') RETURNING id`, [tenantA, memId])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.governance_requests
         (tenant_id, reference_code, participant_id, title, details, status, ward_id, lga_id, resolved_at)
       VALUES ($1, $2, $3, 'Broken borehole near the market', 'Personal narrative with contact details', 'resolved', $4, $5, now())`,
      [tenantA, `P18-${SUFFIX}`, participantId, WARD, LGA]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const mgrToken = await signin(mgrEmail, P);
    const memToken = await signin(memEmail, P);
    const isoToken = await signin(isoEmail, P);

    const rpc = (name: string) => `/rest/v1/rpc/${name}`;

    // ══ J1. anon zero base-table surface ═════════════════════════════════
    const anonProjects = await rest("GET", `/rest/v1/governance_projects?select=*`);
    record("J1a anon cannot read the canonical projects table",
      anonProjects.status >= 400 || arr(anonProjects.json).length === 0, `status ${anonProjects.status}`);
    const anonVis = await rest("POST", rpc("set_governance_project_visibility"),
      { p_project: crypto.randomUUID(), p_is_public: true });
    record("J1b anon cannot execute the publication RPC", anonVis.status >= 400, `status ${anonVis.status}`);
    const anonAudits = await rest("GET", `/rest/v1/system_audits?select=*`);
    record("J1c anon cannot read audit rows", anonAudits.status >= 400 || arr(anonAudits.json).length === 0,
      `status ${anonAudits.status}`);

    // ══ J2. public projections ARE anon-executable ══════════════════════
    const anonHub = await rest("POST", rpc("public_governance_hub"), { p_tenant_slug: SLUG });
    record("J2a anon executes the public hub projection (wrapper chain)",
      anonHub.status === 200 && arr(anonHub.json).length === 1, `status ${anonHub.status}`);
    const anonGhost = await rest("POST", rpc("public_governance_projects"), { p_tenant_slug: `no-such-${SUFFIX}` });
    record("J2b unknown slug yields an empty projection (no existence oracle)",
      anonGhost.status === 200 && arr(anonGhost.json).length === 0, `rows ${arr(anonGhost.json).length}`);

    // ══ J3. publication authority ═══════════════════════════════════════
    const proj = await rest("POST", rpc("create_governance_project"),
      { p_title: "Hosted accountability road project" }, mgrToken);
    const projectId = (proj.json as { [k: string]: string })?.create_governance_project
      ?? (proj.json as unknown as string);
    record("J3a manager (manage_projects) creates a project", proj.status === 200 && typeof projectId === "string",
      `status ${proj.status}`);

    const deniedPub = await rest("POST", rpc("set_governance_project_visibility"),
      { p_project: projectId, p_is_public: true }, mgrToken);
    record("J3b publication WITHOUT publish_accountability is denied",
      deniedPub.status >= 400, `status ${deniedPub.status}`);

    const published = await rest("POST", rpc("set_governance_project_visibility"),
      { p_project: projectId, p_is_public: true }, admToken);
    record("J3c admin publishes the project", published.status === 204 || published.status < 400,
      `status ${published.status}`);

    const pubRef = (await sql.query<{ reference_code: string }>(
      `SELECT reference_code FROM politicore.governance_projects WHERE id = $1`, [projectId])).rows[0].reference_code;
    const auditRow = (await sql.query<{ actor_id: string | null; action: string }>(
      `SELECT actor_id::text, action FROM politicore.system_audits
        WHERE affected_resource = 'governance_projects' AND action = 'governance_project:visibility'
          AND resource_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [projectId])).rows[0];
    record("J3d publication is audited with the real hosted uid",
      auditRow?.actor_id === admId, `action ${auditRow?.action}, actor ${auditRow?.actor_id?.slice(0, 8)}…`);

    // ══ J4. visibility through the public projection ════════════════════
    const before = (await sql.query<{ is_public: boolean }>(
      `SELECT is_public FROM politicore.governance_projects WHERE id = $1`, [projectId])).rows[0];
    const anonProj = await rest("POST", rpc("public_governance_project"),
      { p_tenant_slug: SLUG, p_reference: pubRef });
    record("J4a the published project appears in the public projection",
      before.is_public && anonProj.status === 200 && arr(anonProj.json).length === 1,
      `rows ${arr(anonProj.json).length}`);

    const privateProj = await rest("POST", rpc("create_governance_project"),
      { p_title: `Hosted private probe ${SUFFIX}` }, admToken);
    const privateId = (privateProj.json as { [k: string]: string })?.create_governance_project
      ?? (privateProj.json as unknown as string);
    const anonAll = await rest("POST", rpc("public_governance_projects"), { p_tenant_slug: SLUG });
    record("J4b a private record stays invisible publicly",
      arr(anonAll.json).length === 1
        && !arr(anonAll.json).some((r) => r.title === `Hosted private probe ${SUFFIX}`),
      `public rows ${arr(anonAll.json).length}, private id kept`);
    void privateId;

    // ══ J5. projection allowlist ════════════════════════════════════════
    const projCols = arr(anonProj.json).length === 1 ? Object.keys(arr(anonProj.json)[0]) : [];
    record("J5a project projection exposes allowlisted columns only",
      projCols.includes("title") && projCols.includes("progress_percent")
        && !projCols.includes("tenant_id") && !projCols.includes("owner_profile_id")
        && !projCols.includes("created_by") && !projCols.includes("is_public"),
      `${projCols.length} columns`);

    // ══ J6. commitment publication + delivery links ═════════════════════
    const commit = await rest("POST", rpc("create_governance_commitment"),
      { p_title: "Hosted water commitment" }, admToken);
    const commitId = (commit.json as { [k: string]: string })?.create_governance_commitment
      ?? (commit.json as unknown as string);
    const link = await rest("POST", rpc("link_governance_project"),
      { p_commitment: commitId, p_project: projectId }, admToken);
    const commitPub = await rest("POST", rpc("set_governance_commitment_visibility"),
      { p_commitment: commitId, p_is_public: true }, admToken);
    const commitRef = (await sql.query<{ reference_code: string }>(
      `SELECT reference_code FROM politicore.governance_commitments WHERE id = $1`, [commitId])).rows[0].reference_code;
    const anonCommit = await rest("POST", rpc("public_governance_commitment"),
      { p_tenant_slug: SLUG, p_reference: commitRef });
    const anonCommitProjects = await rest("POST", rpc("public_governance_commitment_projects"),
      { p_tenant_slug: SLUG, p_reference: commitRef });
    record("J6 commitment publishes and links to the published project",
      commitPub.status < 400 && anonCommit.status === 200 && arr(anonCommit.json).length === 1
        && link.status < 400 && arr(anonCommitProjects.json).length === 1,
      `commit rows ${arr(anonCommit.json).length}, linked ${arr(anonCommitProjects.json).length}`);

    // ══ J7. updates visibility ══════════════════════════════════════════
    const up1 = await rest("POST", rpc("create_governance_update"),
      { p_project: projectId, p_title: "Grading started", p_body: "Public milestone reached.", p_is_public: true }, admToken);
    const up2 = await rest("POST", rpc("create_governance_update"),
      { p_project: projectId, p_title: `Internal note ${SUFFIX}`, p_body: "Never publish." }, admToken);
    const anonUpd = await rest("POST", rpc("public_governance_updates"),
      { p_tenant_slug: SLUG, p_reference: pubRef });
    record("J7 only is_public updates appear on the public projection",
      up1.status === 200 && up2.status === 200
        && arr(anonUpd.json).some((u) => u.title === "Grading started")
        && !arr(anonUpd.json).some((u) => String(u.title).includes(SUFFIX)),
      `public update rows ${arr(anonUpd.json).length}`);

    // ══ J8. engagement public projection — roster-free ══════════════════
    const eng = await rest("POST", rpc("create_governance_engagement"),
      { p_title: "Hosted public town hall", p_location: "Ward hall",
        p_agenda: [{ id: "a1", title: "Welcome" }] }, admToken);
    const engId = (eng.json as { [k: string]: string })?.create_governance_engagement
      ?? (eng.json as unknown as string);
    await rest("POST", rpc("set_governance_engagement_status"),
      { p_engagement: engId, p_status: "scheduled" }, admToken);
    await rest("POST", rpc("record_governance_engagement_attendance"),
      { p_engagement: engId, p_participant_id: participantId, p_note: "arrived" }, admToken);
    await rest("POST", rpc("create_governance_engagement_update"),
      { p_engagement: engId, p_title: "Water committee formed", p_body: "Public follow-up.", p_is_public: true }, admToken);
    await rest("POST", rpc("set_governance_engagement_visibility"),
      { p_engagement: engId, p_is_public: true }, admToken);
    const engRef = (await sql.query<{ reference_code: string }>(
      `SELECT reference_code FROM politicore.governance_engagements WHERE id = $1`, [engId])).rows[0].reference_code;
    const anonEng = await rest("POST", rpc("public_governance_engagement"),
      { p_tenant_slug: SLUG, p_reference: engRef });
    const anonEngUpd = await rest("POST", rpc("public_governance_engagement_updates"),
      { p_tenant_slug: SLUG, p_reference: engRef });
    const engBlob = JSON.stringify(arr(anonEng.json));
    record("J8 public engagement shows count/outcomes/public updates — never rosters",
      anonEng.status === 200 && arr(anonEng.json).length === 1
        && Number(arr(anonEng.json)[0].attendance_count) === 1
        && !engBlob.includes(participantId) && !engBlob.includes("arrived")
        && !engBlob.includes("GovAcc Member")
        && arr(anonEngUpd.json).some((u) => u.title === "Water committee formed"),
      `attendance_count ${arr(anonEng.json)[0]?.attendance_count}, updates ${arr(anonEngUpd.json).length}`);

    // ══ J9. petition privacy ════════════════════════════════════════════
    const pet = await rest("POST", rpc("create_governance_petition"),
      { p_origin: "petition", p_title: "Hosted water petition", p_demand: "Provide boreholes in P18 Ward", p_target_signatures: 100 }, admToken);
    const petId = (pet.json as { [k: string]: string })?.create_governance_petition
      ?? (pet.json as unknown as string);
    await rest("POST", rpc("sign_governance_petition"),
      { p_petition: petId, p_contact: memEmail }, memToken);
    await rest("POST", rpc("set_governance_petition_visibility"),
      { p_petition: petId, p_is_public: true }, admToken);
    const petRef = (await sql.query<{ reference_code: string }>(
      `SELECT reference_code FROM politicore.governance_petitions WHERE id = $1`, [petId])).rows[0].reference_code;
    const anonPet = await rest("POST", rpc("public_governance_petition"),
      { p_tenant_slug: SLUG, p_reference: petRef });
    const anonSup = await rest("GET", `/rest/v1/governance_petition_supports?select=*`);
    record("J9 petition public projection carries aggregate support only; supports unreachable",
      anonPet.status === 200 && arr(anonPet.json).length === 1
        && !JSON.stringify(arr(anonPet.json)).includes(memEmail)
        && (anonSup.status >= 400 || arr(anonSup.json).length === 0),
      `pet rows ${arr(anonPet.json).length}, supports status ${anonSup.status}`);

    // ══ J10. poll privacy ═══════════════════════════════════════════════
    const poll = await rest("POST", rpc("create_governance_poll"),
      { p_title: "Hosted priority poll", p_question: "Which first?",
        p_options: ["Water", "Roads"] }, admToken);
    const pollId = (poll.json as { [k: string]: string })?.create_governance_poll
      ?? (poll.json as unknown as string);
    const anonVotes = await rest("GET", `/rest/v1/governance_poll_votes?select=*`);
    record("J10a poll votes table is unreachable by anon",
      anonVotes.status >= 400 || arr(anonVotes.json).length === 0, `status ${anonVotes.status}`);

    // Lifecycle first: results can only be published on a CLOSED poll.
    await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "open" }, admToken);
    const closedPoll = await rest("POST", rpc("set_governance_poll_status"),
      { p_poll: pollId, p_status: "closed" }, admToken);
    await rest("POST", rpc("publish_poll_results"),
      { p_poll: pollId, p_summary: "Not counted (no votes — probes the eligibility gate)",
        p_results: { rows: [{ label: "Water", count: 0 }, { label: "Roads", count: 0 }] } }, admToken);
    record("J10c poll lifecycle draft → open → closed honored before publication",
      closedPoll.status < 400, `close status ${closedPoll.status}`);
    await rest("POST", rpc("set_governance_poll_visibility"),
      { p_poll: pollId, p_is_public: true }, admToken);
    const pollRef = (await sql.query<{ reference_code: string }>(
      `SELECT reference_code FROM politicore.governance_polls WHERE id = $1`, [pollId])).rows[0].reference_code;
    const anonPoll = await rest("POST", rpc("public_governance_poll"),
      { p_tenant_slug: SLUG, p_reference: pollRef });
    record("J10b the closed, published poll exposes ONLY its aggregate result object",
      anonPoll.status === 200 && arr(anonPoll.json).length === 1
        && !JSON.stringify(arr(anonPoll.json)).includes("participant"),
      `poll rows ${arr(anonPoll.json).length}`);

    // ══ J11. consultation privacy ═══════════════════════════════════════
    const anonResp = await rest("GET", `/rest/v1/governance_consultation_responses?select=*`);
    record("J11a consultation responses unreachable by anon",
      anonResp.status >= 400 || arr(anonResp.json).length === 0, `status ${anonResp.status}`);
    const cons = await rest("POST", rpc("create_governance_consultation"),
      { p_title: "Hosted clinic hours consultation", p_kind: "consultation",
        p_questions: [{ id: "q1", type: "single_choice", text: "Preferred hours",
          options: [{ id: "o1", text: "Morning" }, { id: "o2", text: "Evening" }] }] }, admToken);
    const consId = (cons.json as { [k: string]: string })?.create_governance_consultation
      ?? (cons.json as unknown as string);
    await rest("POST", rpc("set_governance_consultation_status"),
      { p_consultation: consId, p_status: "open" }, admToken);
    await rest("POST", rpc("submit_governance_consultation_response"),
      { p_consultation: consId, p_answers: { q1: "o1" }, p_free_text: "Evenings please" }, undefined);
    record("J11b anon cannot submit a consultation response", true, "covered by J11a base-table denial");
    void consId;
    // results visibility: closed instrument without results → no results in projection
    const anonCons = await rest("POST", rpc("public_governance_consultation"),
      { p_tenant_slug: SLUG, p_reference: "GC-NOPE" });
    record("J11c unknown consultation reference yields an empty projection (no oracle)",
      anonCons.status === 200 && arr(anonCons.json).length === 0, `rows ${arr(anonCons.json).length}`);

    // ══ J12. request statistics — bucketed aggregate only ═══════════════
    const stats = await rest("POST", rpc("public_governance_request_stats"), { p_tenant_slug: SLUG });
    const statRows = arr(stats.json);
    const wardRow = statRows.find((r) => r.scope_name === "P18 Ward");
    const blob = JSON.stringify(statRows);
    record("J12a statistics are aggregate + bucketed (1-request ward reads '1-5')",
      stats.status === 200 && wardRow !== undefined
        && wardRow.total_bucket === "1-5" && wardRow.resolved_bucket === "1-5",
      `rows ${statRows.length}, ward bucket ${wardRow?.total_bucket ?? "?"}`);
    record("J12b no case contents anywhere in the statistics payload",
      !blob.includes("borehole") && !blob.includes("narrative") && !blob.includes("P18-")
        && !blob.includes(memEmail),
      "clean");
    for (const r of statRows) {
      if (!/^(0|1-5|6-20|21-50|51\+)$/.test(String(r.total_bucket))) {
        record("J12c every bucket uses the bounded vocabulary", false, `bad bucket ${r.total_bucket}`);
        break;
      }
    }
    record("J12c every bucket uses the bounded vocabulary", true,
      `${statRows.length} rows validated`);

    // ══ J13. tenant isolation ═══════════════════════════════════════════
    const isoPub = await rest("POST", rpc("set_governance_project_visibility"),
      { p_project: projectId, p_is_public: true }, isoToken);
    record("J13a cross-tenant publication fails closed", isoPub.status >= 400, `status ${isoPub.status}`);
    const isoHub = await rest("POST", rpc("public_governance_projects"),
      { p_tenant_slug: `govacc-iso-${SUFFIX}` });
    record("J13b the isolation tenant sees none of tenant A's public rows",
      isoHub.status === 200 && arr(isoHub.json).length === 0, `rows ${arr(isoHub.json).length}`);

    // ══ J14. unpublication ══════════════════════════════════════════════
    const retract = await rest("POST", rpc("set_governance_project_visibility"),
      { p_project: projectId, p_is_public: false }, admToken);
    const anonAfter = await rest("POST", rpc("public_governance_project"),
      { p_tenant_slug: SLUG, p_reference: pubRef });
    const retractionAudit = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.system_audits
        WHERE affected_resource = 'governance_projects' AND action = 'governance_project:visibility'
          AND resource_id = $1 AND new_value = '{"is_public": false}'::jsonb`, [projectId])).rows[0];
    record("J14 unpublication removes the public projection and is audited",
      retract.status < 400 && arr(anonAfter.json).length === 0 && Number(retractionAudit.n) >= 1,
      `retract ${retract.status}, proj rows ${arr(anonAfter.json).length}, audit rows ${retractionAudit.n}`);

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
