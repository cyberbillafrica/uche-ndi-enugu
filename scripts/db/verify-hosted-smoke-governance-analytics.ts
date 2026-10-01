/**
 * POLITICORE — Governance Analytics & Institutional Memory (Phase 19) —
 * HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 19
 * analytics slice end-to-end through the real PostgREST data API and real
 * GoTrue identities — the same acceptance standard as Phases 6–18:
 *
 *   J1  — anon: zero surface (analytics RPCs, timeline, authority helpers)
 *   J2  — member without view_governance: denied on every surface
 *   J3  — tenant admin (tenant-wide): derived aggregates match canonical
 *         fixtures exactly — statuses, buckets, ward distribution,
 *         milestone/linkage counts, published counts
 *   J4  — institutional memory: timeline projects canonical records only,
 *         kind filter + limit honored, bounded at 200
 *   J5  — §7 scope hardening: a WARD-SCOPED grantee sees covered slices
 *         ONLY on every aggregate and in the timeline (ward-B rows never
 *         appear); tenant-wide requires an explicit unscoped grant/admin
 *   J6  — privacy: no identities, contacts, case text, answers, or votes
 *         in any payload; participation counts appear only as buckets
 *   J7  — tenant isolation: second tenant's admin reads all-zero
 *   J8  — hygiene: authenticated execute granted, anon revoked (ACL)
 *   E   — pristine cleanup (fixtures + geo rows + FORCE-RLS restored)
 *
 * The position-default §7 path is proven in the local security suite
 * (tests/security/governance-analytics.test.ts C4); the hosted harness
 * deliberately does not seed shared position reference data.
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

const GOV_TABLES = [
  "governance_updates", "governance_engagement_issues", "governance_engagement_attendance",
  "governance_engagement_stakeholders", "governance_engagement_scopes", "governance_engagements",
  "governance_poll_votes", "governance_poll_scopes", "governance_polls",
  "governance_petition_supports", "governance_petition_scopes", "governance_petitions",
  "governance_consultation_responses", "governance_consultation_scopes", "governance_consultations",
  "governance_commitment_projects", "governance_commitment_scopes", "governance_commitments",
  "governance_project_scopes", "governance_project_milestones", "governance_projects",
  "governance_request_events", "governance_assignments", "governance_requests",
  "governance_participants", "governance_request_categories",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], geoIds: string[]) {
  try {
    const CLEAN_TABLES = [
      ...GOV_TABLES, "notifications", "permission_grants", "media_assets",
      "system_audits", "tenants", "tenant_modules", "polling_units", "wards",
      "lgas", "senatorial_zones", "states", "profiles",
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
        for (const t of GOV_TABLES) {
          await sql.query(`DELETE FROM politicore.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
        }
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.media_assets WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        // profiles + tenants: replica mode disables FK cascades, so both are
        // explicit (Phase 19 residue lesson — profiles outlived auth.users).
        await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
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
    console.error("cleanup incomplete — remove governance analytics fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const P = `GovAn!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m59 = await sql.query<{ ok: boolean }>(
      `SELECT to_regproc('politicore.governance_analytics_row_covers_typed') IS NOT NULL
         AND to_regproc('politicore.governance_analytics_tenant_wide') IS NOT NULL AS ok`);
    if (!m59.rows[0].ok) throw new Error("migration 0059 analytics hardening missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants; admin, member, ward-scoped staffer ════════
    const E = `govan-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovAn — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovAn — isolation`, `govan-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true)`,
      [tenantA, tenantB]);

    const admEmail = `${E}-adm@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const wrdEmail = `${E}-ward@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, memEmail, wrdEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "GovAn Admin", E);
    const memId = await createAuthUser(sql, memEmail, P, "GovAn Member", E);
    const wrdId = await createAuthUser(sql, wrdEmail, P, "GovAn Ward Staff", E);
    const isoId = await createAuthUser(sql, isoEmail, P, "GovAn Iso", `govan-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);
    // Tenant-B admin: proves isolation (all-zero view of tenant B), per the J7 journey.
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [isoId]);

    // Geo: state → zone → lga → ward W (covered) + ward W2 (not covered)
    const STATE = `anst-${SUFFIX}`;
    const ZONE = `anzn-${SUFFIX}`;
    const LGA = `anlg-${SUFFIX}`;
    const WARD = `anwd-${SUFFIX}`;
    const WARD2 = `anwd2-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD, WARD2);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P19 State','P9') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P19 Zone','P9') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P19 LGA','P9') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P19WardW','P9W') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P19WardW2','P9V') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

    // Authority: ward-scoped view_governance for the staffer (admin needs none)
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, scope_type, scope_id)
       VALUES ($1, $2, 'view_governance', true, 'ward', $3)`, [tenantA, wrdId, WARD]);

    // Canonical fixtures in tenant A (superuser path; mirrors the local suite)
    const catId = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_request_categories (tenant_id, name) VALUES ($1,'P19 Water') RETURNING id`, [tenantA])).rows[0].id;
    const partA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name) VALUES ($1,$2,'P19 Citizen A') RETURNING id`, [tenantA, memId])).rows[0].id;
    const partB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_participants (tenant_id, full_name, email) VALUES ($1,'P19 Citizen B',$2) RETURNING id`, [tenantA, `${E}-p2@test.local`])).rows[0].id;

    await sql.query(
      `INSERT INTO politicore.governance_requests
         (tenant_id, reference_code, participant_id, category_id, title, status, ward_id, resolved_at, created_at)
       VALUES ($1,$2,$3,$4,'Leaking pipe WardW','resolved',$5, now() - interval '3 days', now() - interval '10 days')`,
      [tenantA, `P19A-${SUFFIX}`, partA, catId, WARD]);
    await sql.query(
      `INSERT INTO politicore.governance_requests
         (tenant_id, reference_code, participant_id, category_id, title, status, ward_id, created_at)
       VALUES ($1,$2,$3,$4,'Broken borehole WardW2','submitted',$5, now() - interval '40 days')`,
      [tenantA, `P19B-${SUFFIX}`, partA, catId, WARD2]);

    const projW = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_projects (tenant_id, reference_code, title, status, is_public)
       VALUES ($1,$2,'WardW Water Project','active',true) RETURNING id`, [tenantA, `P19-${SUFFIX}-A`])).rows[0].id;
    const proj2 = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_projects (tenant_id, reference_code, title, status, is_public)
       VALUES ($1,$2,'WardW2 Road Project','completed',false) RETURNING id`, [tenantA, `P19-${SUFFIX}-B`])).rows[0].id;
    for (const [pid, ward] of [[projW, WARD], [proj2, WARD2]] as const) {
      await sql.query(
        `INSERT INTO politicore.governance_project_scopes (tenant_id, project_id, scope_type, state_id, zone_id, lga_id, ward_id)
         VALUES ($1,$2,'ward',$3,$4,$5,$6)`, [tenantA, pid, STATE, ZONE, LGA, ward]);
    }
    await sql.query(
      `INSERT INTO politicore.governance_project_milestones (tenant_id, project_id, title, status)
       VALUES ($1,$2,'M1','done'),($1,$2,'M2','pending')`, [tenantA, projW]);

    const commitment = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_commitments (tenant_id, reference_code, title, status)
       VALUES ($1,$2,'WardW Commitment','in_progress') RETURNING id`, [tenantA, `P19-${SUFFIX}-C`])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.governance_commitment_scopes (tenant_id, commitment_id, scope_type, state_id, zone_id, lga_id, ward_id)
       VALUES ($1,$2,'ward',$3,$4,$5,$6)`, [tenantA, commitment, STATE, ZONE, LGA, WARD]);
    await sql.query(
      `INSERT INTO politicore.governance_commitment_projects (tenant_id, commitment_id, project_id) VALUES ($1,$2,$3)`,
      [tenantA, commitment, projW]);

    const consult = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_consultations (tenant_id, kind, reference_code, title, status)
       VALUES ($1,'consultation',$2,'WardW Consultation','open') RETURNING id`, [tenantA, `P19-${SUFFIX}-K`])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.governance_consultation_scopes (tenant_id, consultation_id, scope_type, state_id, zone_id, lga_id, ward_id)
       VALUES ($1,$2,'ward',$3,$4,$5,$6)`, [tenantA, consult, STATE, ZONE, LGA, WARD]);
    await sql.query(
      `INSERT INTO politicore.governance_consultation_responses (tenant_id, consultation_id, participant_id, answers)
       VALUES ($1,$2,$3,'{"q1":"a"}'::jsonb),($1,$2,$4,'{"q1":"b"}'::jsonb)`, [tenantA, consult, partA, partB]);

    const petition = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_petitions (tenant_id, origin, reference_code, title, status, verified_count, verified_at)
       VALUES ($1,'petition',$2,'WardW Petition','open',7, now()) RETURNING id`, [tenantA, `P19-${SUFFIX}-E`])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.governance_petition_scopes (tenant_id, petition_id, scope_type, state_id, zone_id, lga_id, ward_id)
       VALUES ($1,$2,'ward',$3,$4,$5,$6)`, [tenantA, petition, STATE, ZONE, LGA, WARD]);

    const poll = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_polls (tenant_id, reference_code, title, question, options, status)
       VALUES ($1,$2,'WardW Poll','Priority?','["a","b"]'::jsonb,'open') RETURNING id`, [tenantA, `P19-${SUFFIX}-Q`])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.governance_poll_scopes (tenant_id, poll_id, scope_type, state_id, zone_id, lga_id, ward_id)
       VALUES ($1,$2,'ward',$3,$4,$5,$6)`, [tenantA, poll, STATE, ZONE, LGA, WARD]);
    await sql.query(
      `INSERT INTO politicore.governance_poll_votes (tenant_id, poll_id, participant_id, choice)
       VALUES ($1,$2,$3,'a'),($1,$2,$4,'b')`, [tenantA, poll, partA, partB]);

    const engagement = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.governance_engagements (tenant_id, reference_code, title, status, is_public, scheduled_at)
       VALUES ($1,$2,'WardW Townhall','scheduled',true, now() + interval '7 days') RETURNING id`, [tenantA, `P19-${SUFFIX}-G`])).rows[0].id;
    await sql.query(
      `INSERT INTO politicore.governance_engagement_scopes (tenant_id, engagement_id, scope_type, state_id, zone_id, lga_id, ward_id)
       VALUES ($1,$2,'ward',$3,$4,$5,$6)`, [tenantA, engagement, STATE, ZONE, LGA, WARD]);
    await sql.query(
      `INSERT INTO politicore.governance_engagement_attendance (tenant_id, engagement_id, participant_id)
       VALUES ($1,$2,$3),($1,$2,$4)`, [tenantA, engagement, partA, partB]);
    await sql.query(
      `INSERT INTO politicore.governance_engagement_issues (tenant_id, engagement_id, title, status)
       VALUES ($1,$2,'Water pressure','open'),($1,$2,'Road dust','closed')`, [tenantA, engagement]);

    await sql.query(
      `INSERT INTO politicore.governance_updates (tenant_id, project_id, title, body, kind, author_profile_id)
       VALUES ($1,$2,'Pipeline laid','Phase one complete.','progress',$3)`, [tenantA, projW, admId]);
    await sql.query(
      `INSERT INTO politicore.governance_updates (tenant_id, engagement_id, title, body, kind, author_profile_id)
       VALUES ($1,$2,'Follow-up scheduled','Second townhall agreed.','announcement',$3)`, [tenantA, engagement, admId]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const memToken = await signin(memEmail, P);
    const wrdToken = await signin(wrdEmail, P);
    const isoToken = await signin(isoEmail, P);

    const rpc = (name: string) => `/rest/v1/rpc/${name}`;
    const call = (name: string, token: string, body: Record<string, unknown> = {}) =>
      rest("POST", rpc(name), body, token);
    const ANALYTICS = ["governance_analytics_requests", "governance_analytics_delivery",
      "governance_analytics_participation", "governance_analytics_engagements",
      "governance_analytics_accountability"];

    // ══ J1. anon zero surface ════════════════════════════════════════════
    for (const name of ANALYTICS) {
      const r = await call(name, "");
      record(`J1 anon denied on ${name}`, r.status === 401 || r.status === 403 || r.status >= 400, `status ${r.status}`);
    }
    const anonMem = await call("governance_memory_timeline", "", { p_kind: null, p_limit: 10, p_offset: 0 });
    record("J1 anon denied on the memory timeline", anonMem.status >= 400, `status ${anonMem.status}`);
    const anonHelper = await call("governance_analytics_tenant_wide", "", { p_permission: "view_governance" });
    record("J1 anon denied on the authority helper", anonHelper.status >= 400, `status ${anonHelper.status}`);

    // ══ J2. member without view_governance ═══════════════════════════════
    const memDenied: string[] = [];
    for (const name of [...ANALYTICS, "governance_memory_timeline"]) {
      const r = await call(name, memToken, { p_kind: null, p_limit: 10, p_offset: 0 });
      if (r.status >= 400) memDenied.push(name);
    }
    record("J2 member without view_governance denied on every surface", memDenied.length === 6,
      `denied ${memDenied.length}/6`);

    // ══ J3. tenant admin — derived aggregates match fixtures exactly ═════
    const aReq = await call("governance_analytics_requests", admToken);
    const reqRow = arr(aReq.json)[0] ?? {};
    record("J3a request aggregates derive from canonical rows",
      aReq.status === 200 && Number(reqRow.total) === 2 && Number(reqRow.resolved) === 1
        && Number(reqRow.submitted) === 1 && String(reqRow.resolved_bucket) === "1-5",
      `total ${reqRow.total}, resolved_bucket ${reqRow.resolved_bucket}`);

    const aDel = await call("governance_analytics_delivery", admToken);
    const delRow = arr(aDel.json)[0] ?? {};
    record("J3b delivery aggregates: projects, milestones, linkage",
      aDel.status === 200 && Number(delRow.projects_total) === 2 && Number(delRow.projects_active) === 1
        && Number(delRow.milestones_total) === 2 && Number(delRow.milestones_done) === 1
        && Number(delRow.commitments_with_projects) === 1 && Number(delRow.commitments_without_projects) === 0,
      `projects ${delRow.projects_total}, milestones ${delRow.milestones_done}/${delRow.milestones_total}`);

    const aPar = await call("governance_analytics_participation", admToken);
    const parRow = arr(aPar.json)[0] ?? {};
    record("J3c participation aggregates: buckets only",
      aPar.status === 200 && Number(parRow.consultations_total) === 1 && Number(parRow.petitions_total) === 1
        && String(parRow.consultation_responses_bucket) === "1-5"
        && String(parRow.petitions_verified_support_bucket) === "6-20"
        && String(parRow.poll_votes_bucket) === "1-5",
      `responses ${parRow.consultation_responses_bucket}, support ${parRow.petitions_verified_support_bucket}`);

    const aEng = await call("governance_analytics_engagements", admToken);
    const engRow = arr(aEng.json)[0] ?? {};
    record("J3d engagement aggregates: counts only",
      aEng.status === 200 && Number(engRow.total) === 1 && Number(engRow.attendance_count) === 2
        && Number(engRow.issues_open) === 1 && Number(engRow.issues_closed) === 1
        && Number(engRow.followups) === 1,
      `attendance ${engRow.attendance_count}, followups ${engRow.followups}`);

    const aAcc = await call("governance_analytics_accountability", admToken);
    const accRow = arr(aAcc.json)[0] ?? {};
    record("J3e accountability aggregates: published flags only",
      aAcc.status === 200 && Number(accRow.published_projects) === 1
        && Number(accRow.published_engagements) === 1 && accRow.public_request_stats_available === true,
      `published projects ${accRow.published_projects}`);

    // ══ J4. institutional memory ═════════════════════════════════════════
    const memAll = await call("governance_memory_timeline", admToken, { p_kind: null, p_limit: 200, p_offset: 0 });
    const memRows = arr(memAll.json);
    const kinds = new Set(memRows.map((r) => String(r.kind)));
    record("J4a timeline projects every canonical kind",
      memAll.status === 200 && ["project", "commitment", "consultation", "petition", "poll", "engagement", "update"]
        .every((k) => kinds.has(k)),
      `${memRows.length} rows, kinds ${[...kinds].sort().join(",")}`);
    const memPaged = await call("governance_memory_timeline", admToken, { p_kind: "project", p_limit: 1, p_offset: 0 });
    record("J4b kind filter + limit honored", memPaged.status === 200 && arr(memPaged.json).length === 1,
      `rows ${arr(memPaged.json).length}`);
    const memCap = await call("governance_memory_timeline", admToken, { p_kind: null, p_limit: 100000, p_offset: 0 });
    record("J4c timeline is bounded at 200", arr(memCap.json).length <= 200, `rows ${arr(memCap.json).length}`);

    // ══ J5. §7 scope hardening — ward-scoped staffer sees covered slices ═
    const wReq = await call("governance_analytics_requests", wrdToken);
    const wReqRow = arr(wReq.json)[0] ?? {};
    record("J5a ward-scoped requests: covered ward only",
      wReq.status === 200 && Number(wReqRow.total) === 1 && Number(wReqRow.resolved) === 1
        && Number(wReqRow.submitted) === 0,
      `total ${wReqRow.total} (submitted ${wReqRow.submitted})`);
    const wByWard = (wReqRow.by_ward ?? {}) as Record<string, unknown>;
    record("J5b ward-scoped by_ward: no uncovered ward name appears",
      !Object.keys(wByWard).includes("P19WardW2"), `wards ${Object.keys(wByWard).join(",") || "(none)"}`);

    const wDel = await call("governance_analytics_delivery", wrdToken);
    const wDelRow = arr(wDel.json)[0] ?? {};
    record("J5c ward-scoped delivery: one project, no uncovered rows",
      wDel.status === 200 && Number(wDelRow.projects_total) === 1 && Number(wDelRow.projects_concluded) === 0,
      `projects ${wDelRow.projects_total}`);

    const wEng = await call("governance_analytics_engagements", wrdToken);
    record("J5d ward-scoped engagements: covered engagement only",
      wEng.status === 200 && Number(arr(wEng.json)[0]?.total) === 1, `total ${arr(wEng.json)[0]?.total}`);

    const wMem = await call("governance_memory_timeline", wrdToken, { p_kind: "project", p_limit: 200, p_offset: 0 });
    const wRefs = arr(wMem.json).map((r) => String(r.reference_code));
    record("J5e ward-scoped timeline: uncovered project never appears",
      wMem.status === 200 && wRefs.length === 1, `refs ${wRefs.join(",") || "(none)"}`);

    // ══ J6. privacy — structural absence in every payload ════════════════
    let privacyOk = true; let privacyDetail = "";
    for (const name of ANALYTICS) {
      const r = await call(name, admToken);
      const j = JSON.stringify(r.json).toLowerCase();
      for (const banned of ["leaking pipe", "borehole", "participant_id", "@test.local", '"answers"', '"choice"']) {
        if (j.includes(banned)) { privacyOk = false; privacyDetail = `${name} exposed ${banned}`; }
      }
    }
    record("J6 no identities, contacts, case text, answers, or votes in any payload",
      privacyOk, privacyDetail || "all payloads clean");

    // ══ J7. tenant isolation ═════════════════════════════════════════════
    const isoReq = await call("governance_analytics_requests", isoToken);
    const isoDel = await call("governance_analytics_delivery", isoToken);
    const isoMem = await call("governance_memory_timeline", isoToken, { p_kind: null, p_limit: 200, p_offset: 0 });
    record("J7 second tenant reads all-zero aggregates and an empty timeline",
      isoReq.status === 200 && Number(arr(isoReq.json)[0]?.total) === 0
        && Number(arr(isoDel.json)[0]?.projects_total) === 0 && arr(isoMem.json).length === 0,
      `requests ${arr(isoReq.json)[0]?.total}, projects ${arr(isoDel.json)[0]?.projects_total}, timeline ${arr(isoMem.json).length}`);

    // ══ J8. hygiene — ACL posture ════════════════════════════════════════
    const acls = await sql.query<{ proname: string; acl: string | null }>(
      `SELECT p.proname, p.proacl::text AS acl
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'politicore'
          AND p.proname = ANY($1)`,
      [[...ANALYTICS, "governance_memory_timeline", "governance_analytics_tenant_wide",
        "governance_analytics_row_covers", "governance_analytics_row_covers_typed"]]);
    const granteeOk = acls.rows.every((r) => {
      const acl = r.acl ?? "";
      if (["governance_analytics_tenant_wide", "governance_analytics_row_covers",
        "governance_analytics_row_covers_typed"].includes(r.proname)) {
        return !acl.includes("anon=") && !acl.includes("authenticated=");
      }
      return acl.includes("authenticated") && !acl.includes("anon=");
    });
    record("J8 analytics RPCs: authenticated-only; authority helpers: no role grants",
      acls.rows.length === 9 && granteeOk, `${acls.rows.length} functions inspected`);
  } finally {
    await cleanup(sql, tenantIds, emails, geoIds);
    await sql.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nPhase 19 hosted acceptance: ${results.length - failed.length}/${results.length} journeys passed`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
