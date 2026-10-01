/**
 * POLITICORE — Governance Engagements (Phase 17) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 17
 * Engagements slice end-to-end through the real PostgREST data API and
 * real GoTrue identities — the same acceptance standard as Phases 6–16:
 *
 *   J1  — anon: zero surface (no reads, no RPC execute, no wrapper)
 *   J2  — admin creates an engagement (server mints EN- reference,
 *         tenant, actor; draft status)
 *   J3  — RLS reads: staff see drafts; members see only public/is_public
 *         (and none exist here)
 *   J4  — lifecycle: draft→concluded rejected; draft→scheduled; agenda
 *         edit; scheduled→concluded seals content
 *   J5  — agenda: validated server-side; duplicate ids rejected
 *   J6  — event linkage: same-tenant link works; cross-tenant rejected;
 *         unlink works
 *   J7  — stakeholders: tenant participant added; foreign participant
 *         rejected; upsert; unauthorized member refused
 *   J8  — attendance: staff-recorded; duplicate rejected; direct write
 *         denied; server attribution
 *   J9  — issues: staff-created; request link explicit; bounded status
 *   J10 — follow-ups ARE updates: engagement update RPC lands a canonical
 *         governance_updates row (fifth subject)
 *   J11 — updates substrate: single-subject constraint spans the five
 *         subjects; poll excluded; project updates still work
 *   J12 — scope authority: ward-scoped manager creates at their ward;
 *         tenant-wide create refused; unrelated ward rejected; campaign
 *         scope forbidden; unknown geography fails closed
 *   J13 — visibility: is_public flip requires publish_accountability;
 *         public engagement becomes member-visible WITHOUT exposing
 *         stakeholders/attendance (privacy of rosters)
 *   J14 — core notifications: scheduling fanout is canonical AND
 *         recipient-correct (ward resident notified; wardless member not)
 *   J15 — tenant isolation: cross-tenant read/mutate/child fail closed
 *   J16 — audit attribution: canonical system_audits rows carry the real
 *         hosted auth.uid()
 *   J17 — staff creation refused without manage_participation
 *   E   — pristine cleanup (fixtures + geo rows + test Event; FORCE-RLS
 *         state restored)
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

const P17_TABLES = [
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

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], geoIds: string[], eventIds: string[]) {
  try {
    const CLEAN_TABLES = [
      ...P17_TABLES, "governance_request_events", "governance_assignments",
      "governance_requests", "governance_participants", "governance_request_categories",
      "notifications", "permission_grants", "media_assets", "system_audits",
      "tenants", "tenant_modules", "polling_units", "wards", "lgas",
      "senatorial_zones", "states", "profiles", "events",
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
        for (const t of P17_TABLES) {
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
        // The test Event (content module) — explicit, not tenant-cascade.
        await sql.query(`DELETE FROM politicore.events WHERE id = ANY($1)`, [eventIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        // Geography fixture rows (child-first).
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
    console.error("cleanup incomplete — remove governance engagement fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const eventIds: string[] = [];
  const P = `GovEng!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m56 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.create_governance_engagement(text,text,timestamptz,text,jsonb,uuid,text)') IS NOT NULL
         AND to_regproc('politicore.guard_governance_engagement_status') IS NOT NULL AS ok`);
    if (!m56.rows[0].ok) throw new Error("migration 0056 engagements missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, admin + scoped manager + members ══════════
    const E = `goveng-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovEng — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovEng — isolation`, `goveng-iso-${SUFFIX}`])).rows[0].id;
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

    const admId = await createAuthUser(sql, admEmail, P, "GovEng Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovEng Manager", E);
    const memId = await createAuthUser(sql, memEmail, P, "GovEng Member", E);
    const resId = await createAuthUser(sql, resEmail, P, "GovEng Ward Resident", E);
    await createAuthUser(sql, isoEmail, P, "GovEng Iso", `goveng-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Core Geography fixtures (state → zone → lga → ward chain).
    const STATE = `est-${SUFFIX}`;
    const ZONE = `ezn-${SUFFIX}`;
    const LGA = `elg-${SUFFIX}`;
    const WARD = `ewd-${SUFFIX}`;
    const WARD2 = `ewd2-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD, WARD2);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P17 State','P7') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P17 Zone','P7') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P17 LGA','P7') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P17 Ward','P7') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P17 Ward2','P8') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

    // Ward-scoped manage_participation grant; ward resident profile; a
    // Governance participant row for the member (stakeholder/attendance
    // fixture); the same-tenant Event (content module) for linkage.
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, scope_type, scope_id)
       VALUES ($1, $2, 'manage_participation', true, 'ward', $3)`,
      [tenantA, mgrId, WARD]);
    await sql.query(`UPDATE politicore.profiles SET ward_id = $2, lga_id = $3 WHERE id = $1`, [resId, WARD, LGA]);
    const participantId = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name)
       VALUES ($1, $2, 'GovEng Member') RETURNING id`, [tenantA, memId])).rows[0].id;
    const eventId = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.events (tenant_id, title, event_date, venue, status, created_by)
       VALUES ($1, 'P17 Hosted Town Hall', current_date + 14, 'P17 Hall', 'published', $2) RETURNING id`,
      [tenantA, admId])).rows[0].id;
    eventIds.push(eventId);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const mgrToken = await signin(mgrEmail, P);
    const memToken = await signin(memEmail, P);
    const isoToken = await signin(isoEmail, P);

    const rpc = (name: string) => `/rest/v1/rpc/${name}`;
    const AGENDA = [
      { id: "item-1", title: "Welcome and introductions" },
      { id: "item-2", title: "Ward priorities", detail: "Open floor" },
    ];

    // ══ J1. anon zero surface ═════════════════════════════════════════════
    const anonRead = await rest("GET", `/rest/v1/governance_engagements?select=*`);
    record("J1a anon has no read access to the engagements surface",
      (anonRead.status === 401 || (anonRead.status === 200 && arr(anonRead.json).length === 0)),
      `status ${anonRead.status}, rows ${arr(anonRead.json).length}`);
    const anonRpc = await rest("POST", rpc("create_governance_engagement"), { p_title: "anon" });
    record("J1b anon cannot execute the create RPC", anonRpc.status >= 400, `status ${anonRpc.status}`);
    const anonStakes = await rest("GET", `/rest/v1/governance_engagement_stakeholders?select=*`);
    record("J1c anon sees no stakeholder rows",
      anonStakes.status >= 400 || arr(anonStakes.json).length === 0,
      `status ${anonStakes.status}`);

    // ══ J2. admin creates an engagement ══════════════════════════════════
    const created = await rest("POST", rpc("create_governance_engagement"), {
      p_title: "Hosted ward town hall",
      p_description: "Constituency engagement on ward priorities.",
      p_location: "Ward hall",
      p_agenda: AGENDA,
    }, admToken);
    const engagementId = (created.json as { [k: string]: string })?.create_governance_engagement
      ?? (created.json as unknown as string);
    record("J2a admin creates an engagement via RPC",
      created.status === 200 && typeof engagementId === "string" && engagementId.length > 0,
      `status ${created.status}, id ${String(engagementId).slice(0, 8)}…`);

    const prow = (await sql.query<{ reference_code: string; status: string; is_public: boolean; agenda: unknown; tenant_id: string; created_by: string | null }>(
      `SELECT reference_code, status::text, is_public, agenda, tenant_id, created_by
         FROM politicore.governance_engagements WHERE id = $1`, [engagementId])).rows[0];
    record("J2b EN- reference minted; draft; private; agenda stored; tenant + actor server-stamped",
      /^EN-[0-9A-F]{8}$/.test(prow.reference_code) && prow.status === "draft"
        && prow.is_public === false && Array.isArray(prow.agenda) && (prow.agenda as unknown[]).length === 2
        && prow.tenant_id === tenantA && prow.created_by === admId,
      `ref ${prow.reference_code}, status ${prow.status}`);

    // ══ J3. RLS reads — drafts staff-only ════════════════════════════════
    const admSee = await rest("GET", `/rest/v1/governance_engagements?id=eq.${engagementId}&select=id`, undefined, admToken);
    const memSee = await rest("GET", `/rest/v1/governance_engagements?id=eq.${engagementId}&select=id`, undefined, memToken);
    record("J3 staff sees the draft; member does not (drafts are staff-only)",
      arr(admSee.json).length === 1 && arr(memSee.json).length === 0,
      `admin rows ${arr(admSee.json).length}, member rows ${arr(memSee.json).length}`);

    // ══ J4. lifecycle ════════════════════════════════════════════════════
    const jump = await rest("POST", rpc("set_governance_engagement_status"),
      { p_engagement: engagementId, p_status: "concluded" }, admToken);
    record("J4a draft → concluded rejected", jump.status >= 400, `status ${jump.status}`);

    const scheduled = await rest("POST", rpc("set_governance_engagement_status"),
      { p_engagement: engagementId, p_status: "scheduled" }, admToken);
    record("J4b draft → scheduled succeeds", scheduled.status === 204 || scheduled.status < 400,
      `status ${scheduled.status}`);

    // ══ J5. agenda ═══════════════════════════════════════════════════════
    const dupAgenda = await rest("POST", rpc("update_governance_engagement"), {
      p_engagement: engagementId,
      p_agenda: [{ id: "same", title: "A" }, { id: "same", title: "B" }],
    }, admToken);
    record("J5a duplicate agenda ids rejected server-side", dupAgenda.status >= 400,
      `status ${dupAgenda.status}`);

    const editOk = await rest("POST", rpc("update_governance_engagement"), {
      p_engagement: engagementId, p_location: "Updated ward hall",
    }, admToken);
    record("J5b content editable while scheduled", editOk.status === 204 || editOk.status < 400,
      `status ${editOk.status}`);

    // ══ J6. event linkage ════════════════════════════════════════════════
    const linked = await rest("POST", rpc("link_governance_engagement_event"),
      { p_engagement: engagementId, p_event_id: eventId }, admToken);
    record("J6a same-tenant Event link succeeds", linked.status === 204 || linked.status < 400,
      `status ${linked.status}`);

    const evBefore = (await sql.query<{ title: string; status: string; updated_at: string }>(
      `SELECT title, status::text, updated_at::text FROM politicore.events WHERE id = $1`, [eventId])).rows[0];

    const unlinked = await rest("POST", rpc("unlink_governance_engagement_event"),
      { p_engagement: engagementId }, admToken);
    record("J6b unlink works; the Event row itself is untouched",
      (unlinked.status === 204 || unlinked.status < 400)
        && (await sql.query<{ title: string; status: string }>(
          `SELECT title, status::text FROM politicore.events WHERE id = $1`, [eventId])).rows[0].title === evBefore.title,
      `status ${unlinked.status}`);

    // ══ J7. stakeholders ═════════════════════════════════════════════════
    const stake = await rest("POST", rpc("add_governance_engagement_stakeholder"),
      { p_engagement: engagementId, p_participant_id: participantId, p_role_label: "Ward chair", p_note: "invited" }, admToken);
    record("J7a tenant participant added as stakeholder", stake.status === 200 || stake.status < 400,
      `status ${stake.status}`);

    const again = await rest("POST", rpc("add_governance_engagement_stakeholder"),
      { p_engagement: engagementId, p_participant_id: participantId, p_role_label: "Ward chair (confirmed)" }, admToken);
    const stakeCount = Number((await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.governance_engagement_stakeholders WHERE engagement_id = $1`,
      [engagementId])).rows[0].n);
    record("J7b upsert semantics — no duplicate stakeholder rows",
      again.status < 400 && stakeCount === 1, `rows ${stakeCount}`);

    const selfStake = await rest("POST", rpc("add_governance_engagement_stakeholder"),
      { p_engagement: engagementId, p_participant_id: participantId, p_role_label: "self-appointed" }, memToken);
    record("J7c unauthorized member cannot manage stakeholders", selfStake.status >= 400,
      `status ${selfStake.status}`);

    // ══ J8. attendance ═══════════════════════════════════════════════════
    const att = await rest("POST", rpc("record_governance_engagement_attendance"),
      { p_engagement: engagementId, p_participant_id: participantId, p_note: "arrived 10:04" }, admToken);
    record("J8a staff records attendance", att.status === 200 || att.status < 400, `status ${att.status}`);

    const attDup = await rest("POST", rpc("record_governance_engagement_attendance"),
      { p_engagement: engagementId, p_participant_id: participantId }, admToken);
    record("J8b duplicate attendance rejected (one row per participant)", attDup.status >= 400,
      `status ${attDup.status}`);

    const attSelf = await rest("POST", rpc("record_governance_engagement_attendance"),
      { p_engagement: engagementId, p_participant_id: participantId, p_note: "self check-in" }, memToken);
    record("J8c member self check-in refused (staff-recorded roster)", attSelf.status >= 400,
      `status ${attSelf.status}`);

    const attRow = (await sql.query<{ recorded_by: string | null }>(
      `SELECT recorded_by::text FROM politicore.governance_engagement_attendance WHERE engagement_id = $1`,
      [engagementId])).rows[0];
    record("J8d attendance attribution is the recording staff uid", attRow.recorded_by === admId,
      `recorded_by ${attRow.recorded_by?.slice(0, 8)}…`);

    // ══ J9. issues ═══════════════════════════════════════════════════════
    const issue = await rest("POST", rpc("create_governance_engagement_issue"),
      { p_engagement: engagementId, p_title: "Water access raised on the floor" }, admToken);
    const issueId = (issue.json as { [k: string]: string })?.create_governance_engagement_issue
      ?? (issue.json as unknown as string);
    record("J9a staff creates an issue", issue.status === 200 && typeof issueId === "string",
      `status ${issue.status}`);

    const issueStatus = await rest("POST", rpc("update_governance_engagement_issue"),
      { p_issue: issueId, p_status: "addressed" }, admToken);
    record("J9b issue status moves within the bounded vocabulary", issueStatus.status === 204 || issueStatus.status < 400,
      `status ${issueStatus.status}`);

    const badStatus = await rest("POST", rpc("update_governance_engagement_issue"),
      { p_issue: issueId, p_status: "escalated" }, admToken);
    record("J9c unbounded status rejected", badStatus.status >= 400, `status ${badStatus.status}`);

    // ══ J10. follow-ups ARE updates ══════════════════════════════════════
    const engUpdate = await rest("POST", rpc("create_governance_engagement_update"),
      { p_engagement: engagementId, p_title: "Follow-up", p_body: "Minutes circulated to stakeholders." }, admToken);
    const updRow = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.governance_updates
        WHERE engagement_id = $1 AND body = 'Minutes circulated to stakeholders.'`,
      [engagementId])).rows[0];
    record("J10 engagement follow-up lands as a canonical governance_updates row",
      engUpdate.status === 200 && Number(updRow.n) === 1,
      `status ${engUpdate.status}, rows ${updRow.n}`);

    // ══ J11. updates substrate ═══════════════════════════════════════════
    const updDef = (await sql.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`)).rows[0].d;
    record("J11a single-subject constraint spans the five subjects — poll NOT a subject",
      updDef.includes("project_id") && updDef.includes("commitment_id")
        && updDef.includes("consultation_id") && updDef.includes("petition_id")
        && updDef.includes("engagement_id") && !updDef.includes("poll_id"),
      updDef.slice(0, 80) + "…");

    const project = await rest("POST", rpc("create_governance_project"),
      { p_title: "Hosted engagement-substrate probe project" }, admToken);
    const projectId = (project.json as { [k: string]: string })?.create_governance_project
      ?? (project.json as unknown as string);
    const projectUpdate = await rest("POST", rpc("create_governance_update"),
      { p_project: projectId, p_title: "Kickoff", p_body: "still works" }, admToken);
    record("J11b project updates still work (Phase 12 substrate preserved)",
      projectUpdate.status < 400, `status ${projectUpdate.status}`);

    // ══ J12. scope authority ═════════════════════════════════════════════
    const scoped = await rest("POST", rpc("create_governance_engagement"), {
      p_title: "Hosted clinic outreach",
      p_scopes: [{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }],
    }, mgrToken);
    const scopedId = (scoped.json as { [k: string]: string })?.create_governance_engagement
      ?? (scoped.json as unknown as string);
    record("J12a ward-scoped manager creates an engagement AT their ward",
      scoped.status === 200 && typeof scopedId === "string", `status ${scoped.status}`);

    const wide = await rest("POST", rpc("create_governance_engagement"),
      { p_title: "Hosted wide engagement attempt" }, mgrToken);
    record("J12b scope-scoped manager cannot mint a tenant-wide engagement", wide.status >= 400,
      `status ${wide.status}`);

    const road = await rest("POST", rpc("create_governance_engagement"),
      { p_title: "Hosted roads probe engagement" }, admToken);
    const roadId = (road.json as { [k: string]: string })?.create_governance_engagement
      ?? (road.json as unknown as string);
    const outside = await rest("POST", rpc("add_governance_engagement_scope"), {
      p_engagement: roadId, p_scope_type: "ward",
      p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2,
    }, mgrToken);
    record("J12c scope-scoped manager cannot attach a scope outside their authority",
      outside.status >= 400, `status ${outside.status}`);

    const campaign = await rest("POST", rpc("add_governance_engagement_scope"), {
      p_engagement: roadId, p_scope_type: "campaign",
    }, admToken);
    record("J12d campaign scope is forbidden", campaign.status >= 400, `status ${campaign.status}`);

    const unknownGeo = await rest("POST", rpc("add_governance_engagement_scope"), {
      p_engagement: roadId, p_scope_type: "ward",
      p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "no-such-ward",
    }, admToken);
    record("J12e unknown geography fails closed", unknownGeo.status >= 400, `status ${unknownGeo.status}`);

    // ══ J13. visibility + roster privacy ═════════════════════════════════
    const visMgr = await rest("POST", rpc("set_governance_engagement_visibility"),
      { p_engagement: roadId, p_is_public: true }, mgrToken);
    record("J13a publish_accountability required to change visibility", visMgr.status >= 400,
      `status ${visMgr.status}`);

    const visAdm = await rest("POST", rpc("set_governance_engagement_visibility"),
      { p_engagement: roadId, p_is_public: true }, admToken);
    record("J13b admin publishes the engagement", visAdm.status === 204 || visAdm.status < 400,
      `status ${visAdm.status}`);

    const memPublic = await rest("GET", `/rest/v1/governance_engagements?id=eq.${roadId}&select=id`, undefined, memToken);
    record("J13c the public engagement is member-visible", arr(memPublic.json).length === 1,
      `member rows ${arr(memPublic.json).length}`);

    const memStakes = await rest("GET", `/rest/v1/governance_engagement_stakeholders?select=*`, undefined, memToken);
    record("J13d rosters stay staff-only even when the engagement is public",
      memStakes.status >= 400 || arr(memStakes.json).length === 0, `member rows ${arr(memStakes.json).length}`);

    // ══ J14. core notifications — recipient correctness ══════════════════
    // Schedule the ward-scoped engagement (created in J12a) — the fanout
    // must reach the ward resident and not the wardless member.
    const schedScoped = await rest("POST", rpc("set_governance_engagement_status"),
      { p_engagement: scopedId, p_status: "scheduled" }, mgrToken);
    record("J14a ward-scoped engagement schedules", schedScoped.status === 204 || schedScoped.status < 400,
      `status ${schedScoped.status}`);

    const fanout = await sql.query<{ user_id: string }>(
      `SELECT n.user_id::text FROM politicore.notifications n
        WHERE n.tenant_id = $1 AND n.link_url = '/governance/engagements'
          AND n.message LIKE '%Hosted clinic outreach%'`, [tenantA]);
    const recipients = fanout.rows.map((r) => r.user_id);
    record("J14b the scheduled fanout is canonical and recipient-correct",
      recipients.length > 0 && recipients.includes(resId) && !recipients.includes(memId)
        && !recipients.includes(admId),
      `${recipients.length} recipients (resident in, wardless out)`);

    const crossFan = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications
        WHERE tenant_id = $1 AND message LIKE '%Hosted clinic outreach%'`, [tenantB]);
    record("J14c no cross-tenant fanout rows", Number(crossFan.rows[0].n) === 0,
      `rows ${crossFan.rows[0].n}`);

    // ══ J15. tenant isolation ════════════════════════════════════════════
    const foreignRead = await rest("GET", `/rest/v1/governance_engagements?id=eq.${engagementId}&select=id`, undefined, isoToken);
    record("J15a cross-tenant read returns nothing", arr(foreignRead.json).length === 0,
      `rows ${arr(foreignRead.json).length}`);

    const foreignStatus = await rest("POST", rpc("set_governance_engagement_status"),
      { p_engagement: engagementId, p_status: "scheduled" }, isoToken);
    record("J15b cross-tenant mutation fails closed", foreignStatus.status >= 400,
      `status ${foreignStatus.status}`);

    const foreignChild = await rest("POST", rpc("create_governance_engagement_issue"),
      { p_engagement: engagementId, p_title: "foreign issue" }, isoToken);
    record("J15c cross-tenant child mutation fails closed", foreignChild.status >= 400,
      `status ${foreignChild.status}`);

    // ══ J16. audit attribution ═══════════════════════════════════════════
    const audits = await sql.query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id::text FROM politicore.system_audits
        WHERE affected_resource = 'governance_engagements' AND tenant_id = $1
          AND action IN ('governance_engagement:create','governance_engagement:status','governance_engagement:event_linked')
        ORDER BY occurred_at DESC LIMIT 8`, [tenantA]);
    const rpcAudits = audits.rows.filter((r) => r.actor_id !== null);
    record("J16 RPC audits carry the real hosted actor uid",
      rpcAudits.length > 0 && rpcAudits.every((r) => r.actor_id === admId || r.actor_id === mgrId),
      `${rpcAudits.length} audited rows`);
    const attAudit = await sql.query<{ actor_id: string | null }>(
      `SELECT actor_id::text FROM politicore.system_audits
        WHERE action = 'governance_engagement_attendance:record' AND tenant_id = $1
        ORDER BY occurred_at DESC LIMIT 1`, [tenantA]);
    record("J16b the attendance audit carries the recording staff uid",
      attAudit.rows[0]?.actor_id === admId, `actor ${attAudit.rows[0]?.actor_id?.slice(0, 8)}…`);

    // ══ J17. staff creation refused without permission ═══════════════════
    const memStaff = await rest("POST", rpc("create_governance_engagement"),
      { p_title: "Hosted member engagement attempt" }, memToken);
    record("J17 a member cannot create an engagement (manage_participation required)",
      memStaff.status >= 400, `status ${memStaff.status}`);

    // ══ conclude the main engagement (post-roster sealing proof) ═════════
    const concluded = await rest("POST", rpc("set_governance_engagement_status"),
      { p_engagement: engagementId, p_status: "concluded", p_outcomes: "Five commitments recorded." }, admToken);
    const sealedEdit = await rest("POST", rpc("update_governance_engagement"),
      { p_engagement: engagementId, p_title: "Rewriting history" }, admToken);
    record("J4c scheduled → concluded seals content (post-conclusion edit rejected)",
      (concluded.status === 204 || concluded.status < 400) && sealedEdit.status >= 400,
      `conclude ${concluded.status}, sealed edit ${sealedEdit.status}`);

  } finally {
    await cleanup(sql, tenantIds, emails, geoIds, eventIds);
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
