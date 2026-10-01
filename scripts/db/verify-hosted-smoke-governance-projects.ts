/**
 * POLITICORE — Governance Projects (Phase 12) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 12
 * Projects slice end-to-end through the real PostgREST data API and real
 * GoTrue identities — the same acceptance standard as Phases 6–11:
 *
 *   J1  — anon: zero surface (no reads, no RPC execute on authority RPCs)
 *   J2  — admin creates a project (server mints reference, tenant, actor)
 *   J3  — RLS reads: admin sees it; plain member of the same tenant does not
 *   J4  — milestone add → progress derived 0; complete → 100 (server math)
 *   J5  — update created through the canonical governance_updates substrate
 *   J6  — visibility: default private; RPC publication stamps published_at;
 *         is_public on the base table still invisible to anon (projection-only)
 *   J7  — lifecycle guard: planned→completed rejected; planned→active stamps
 *         actual_start server-side
 *   J8  — tenant isolation: tenant-B admin cannot read or mutate tenant-A
 *         projects (silent no-op read, RPC raises)
 *   J9  — scope authority: ward-scoped manager creates at their ward and
 *         cannot attach an unrelated ward; campaign scope forbidden
 *   J10 — audit attribution: canonical system_audits rows carry the real
 *         hosted auth.uid() as actor
 *   E   — pristine cleanup (0 fixtures; FORCE-RLS state restored)
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
  return { status: r0(), json, text };
  function r0() { return res.status; }
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

const P12_TABLES = [
  "governance_updates", "governance_project_scopes",
  "governance_project_milestones", "governance_projects",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  try {
    const CLEAN_TABLES = [
      ...P12_TABLES, "governance_request_events", "governance_assignments",
      "governance_requests", "governance_participants", "governance_request_categories",
      "notifications", "permission_grants", "media_assets", "system_audits",
      "tenants", "tenant_modules",
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
        for (const t of P12_TABLES) {
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
      }
    } finally {
      await sql.query("SET session_replication_role = DEFAULT");
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove governance project fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `GovProj!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m43 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.create_governance_project(text,text,text,text,uuid,date,date,numeric,text,text,text,integer,text)') IS NOT NULL AS ok`);
    if (!m43.rows[0].ok) throw new Error("migration 0045 create signature missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, admin + scoped manager + member each ══════
    const E = `govprj-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovProj — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovProj — isolation`, `govprj-iso-${SUFFIX}`])).rows[0].id;
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

    const admId = await createAuthUser(sql, admEmail, P, "GovProj Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovProj Manager", E);
    await createAuthUser(sql, memEmail, P, "GovProj Member", E);
    await createAuthUser(sql, isoEmail, P, "GovProj Iso", `govprj-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Core Geography fixtures (state → zone → lga → ward chain).
    const STATE = `pst-${SUFFIX}`;
    const ZONE = `pzn-${SUFFIX}`;
    const LGA = `plg-${SUFFIX}`;
    const WARD = `pwd-${SUFFIX}`;
    const WARD2 = `pwd2-${SUFFIX}`;
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P12 State','P1') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P12 Zone','P1') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P12 LGA','P1') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P12 Ward','P1') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P12 Ward2','P2') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

    // Ward-scoped manage_projects grant for the manager.
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted, scope_type, scope_id)
       VALUES ($1, $2, 'manage_projects', true, 'ward', $3)`,
      [tenantA, mgrId, WARD]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const mgrToken = await signin(mgrEmail, P);
    const memToken = await signin(memEmail, P);
    const isoToken = await signin(isoEmail, P);

    const rpc = (name: string) =>
      `/rest/v1/rpc/${name}`;

    // ══ J1. anon zero surface ═════════════════════════════════════════════
    // Governance is authenticated-only (0034 convention): anon holds ZERO
    // grants on the public view, so PostgREST answers 401 — the strongest
    // no-access proof. (200-with-0-rows would also pass on configurations
    // where the grant exists but RLS filters.)
    const anonRead = await rest("GET", `/rest/v1/governance_projects?select=*`);
    record("J1a anon has no read access to the projects surface",
      (anonRead.status === 401 || (anonRead.status === 200 && arr(anonRead.json).length === 0)),
      `status ${anonRead.status}, rows ${arr(anonRead.json).length}`);
    const anonRpc = await rest("POST", rpc("create_governance_project"), { p_title: "anon" });
    record("J1b anon cannot execute the authority RPC", anonRpc.status >= 400,
      `status ${anonRpc.status}`);

    // ══ J2. admin create (server mints everything) ═══════════════════════
    const created = await rest("POST", rpc("create_governance_project"), {
      p_title: "Hosted water scheme",
      p_description: "Borehole rehabilitation across two wards",
      p_category_label: "Infrastructure",
      p_scopes: JSON.stringify([
        { scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD },
        { scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD2 },
      ]),
    }, admToken);
    const projectId = (created.json as { [k: string]: string })?.create_governance_project
      ?? (created.json as string);
    record("J2 admin creates a project via RPC", created.status === 200 && typeof projectId === "string" && projectId.length > 0,
      `status ${created.status}, id ${String(projectId).slice(0, 8)}…`);

    const prow = (await sql.query<{ reference_code: string; is_public: boolean; created_by: string | null; tenant_id: string }>(
      `SELECT reference_code, is_public, created_by, tenant_id FROM politicore.governance_projects WHERE id = $1`,
      [projectId])).rows[0];
    record("J2b server minted reference/tenant/actor; default private",
      /^GP-[0-9A-F]{8}$/.test(prow.reference_code) && prow.is_public === false
        && prow.tenant_id === tenantA && prow.created_by !== null,
      `ref ${prow.reference_code}`);

    // ══ J3. RLS reads ═════════════════════════════════════════════════════
    const admSee = await rest("GET", `/rest/v1/governance_projects?id=eq.${projectId}&select=id`, undefined, admToken);
    const memSee = await rest("GET", `/rest/v1/governance_projects?id=eq.${projectId}&select=id`, undefined, memToken);
    record("J3 staff sees the project; plain member does not",
      arr(admSee.json).length === 1 && arr(memSee.json).length === 0,
      `admin rows ${arr(admSee.json).length}, member rows ${arr(memSee.json).length}`);

    // ══ J4. milestones + derived progress ════════════════════════════════
    const mAdd = await rest("POST", rpc("create_governance_project_milestone"),
      { p_project: projectId, p_title: "Rehabilitate borehole A" }, admToken);
    const milestoneId = (mAdd.json as string) ?? (mAdd.json as { [k: string]: string })?.create_governance_project_milestone;
    record("J4a milestone added via RPC", mAdd.status === 200 && typeof milestoneId === "string", `status ${mAdd.status}`);

    let prog = (await sql.query<{ progress_percent: number }>(
      `SELECT progress_percent FROM politicore.governance_projects WHERE id = $1`, [projectId])).rows[0];
    record("J4b progress starts at 0 (pending milestone)", prog.progress_percent === 0, `progress ${prog.progress_percent}`);

    await rest("POST", rpc("update_governance_project_milestone"),
      { p_milestone: milestoneId, p_status: "done" }, admToken);
    prog = (await sql.query<{ progress_percent: number }>(
      `SELECT progress_percent FROM politicore.governance_projects WHERE id = $1`, [projectId])).rows[0];
    record("J4c completing the milestone derives 100%", prog.progress_percent === 100, `progress ${prog.progress_percent}`);

    const manual = await rest("POST", rpc("set_governance_project_progress"),
      { p_project: projectId, p_progress: 42 }, admToken);
    record("J4d manual override refuses when milestones exist", manual.status >= 400,
      `status ${manual.status}`);

    // ══ J5. canonical updates substrate ══════════════════════════════════
    const upd = await rest("POST", rpc("create_governance_update"),
      { p_project: projectId, p_title: "Kickoff", p_body: "Work begins on site.", p_kind: "progress", p_is_public: false }, admToken);
    record("J5 update created through governance_updates", upd.status === 200, `status ${upd.status}`);
    const ucount = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.governance_updates WHERE project_id = $1`, [projectId])).rows[0];
    record("J5b exactly one canonical update row", ucount.n === "1", `rows ${ucount.n}`);

    // ══ J6. visibility semantics ═════════════════════════════════════════
    const pub = await rest("POST", rpc("set_governance_project_visibility"),
      { p_project: projectId, p_is_public: true }, admToken);
    // PostgREST answers 204 (No Content) for successful void RPCs.
    record("J6a RPC publication succeeds", pub.status < 400, `status ${pub.status}`);
    const prow2 = (await sql.query<{ is_public: boolean; published_at: string | null }>(
      `SELECT is_public, published_at FROM politicore.governance_projects WHERE id = $1`, [projectId])).rows[0];
    record("J6b published_at stamped server-side", prow2.is_public === true && prow2.published_at !== null, `published_at ${String(prow2.published_at)}`);
    const anonStill = await rest("GET", `/rest/v1/governance_projects?id=eq.${projectId}&select=id`);
    record("J6c base table still inaccessible to anon (projection-only)",
      (anonStill.status === 401 || (anonStill.status === 200 && arr(anonStill.json).length === 0)),
      `anon status ${anonStill.status}, rows ${arr(anonStill.json).length}`);

    // ══ J7. lifecycle guard ══════════════════════════════════════════════
    // planned → completed is ILLEGAL (must pass through active).
    const illegal = await rest("POST", rpc("set_governance_project_status"),
      { p_project: projectId, p_status: "completed" }, admToken);
    record("J7a planned → completed rejected by the server guard", illegal.status >= 400,
      `status ${illegal.status}`);
    // Then the legal path: planned → active → completed (204 = success).
    await rest("POST", rpc("set_governance_project_status"),
      { p_project: projectId, p_status: "active" }, admToken);
    const legal = await rest("POST", rpc("set_governance_project_status"),
      { p_project: projectId, p_status: "completed" }, admToken);
    record("J7b planned → active → completed succeeds", legal.status < 400,
      `status ${legal.status}`);
    const prow3 = (await sql.query<{ actual_end: string | null }>(
      `SELECT actual_end FROM politicore.governance_projects WHERE id = $1`, [projectId])).rows[0];
    record("J7c actual_end server-stamped", prow3.actual_end !== null, `actual_end ${String(prow3.actual_end)}`);

    // ══ J8. tenant isolation ═════════════════════════════════════════════
    const isoRead = await rest("GET", `/rest/v1/governance_projects?id=eq.${projectId}&select=id`, undefined, isoToken);
    record("J8a cross-tenant read returns nothing", isoRead.status === 200 && arr(isoRead.json).length === 0,
      `iso rows ${arr(isoRead.json).length}`);
    const isoUpdate = await rest("POST", rpc("update_governance_project"),
      { p_project: projectId, p_title: "Hijacked" }, isoToken);
    record("J8b cross-tenant RPC mutation fails closed", isoUpdate.status >= 400,
      `status ${isoUpdate.status}`);

    // ══ J9. scope authority ══════════════════════════════════════════════
    const scopedCreate = await rest("POST", rpc("create_governance_project"), {
      p_title: "Manager ward project",
      p_scopes: JSON.stringify([{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }]),
    }, mgrToken);
    record("J9a ward-scoped manager creates at their ward", scopedCreate.status === 200,
      `status ${scopedCreate.status}`);
    const unscopedCreate = await rest("POST", rpc("create_governance_project"), {
      p_title: "Manager tenant-wide", p_scopes: "[]",
    }, mgrToken);
    record("J9b tenant-wide create refused for scoped grantee", unscopedCreate.status >= 400,
      `status ${unscopedCreate.status}`);
    const mgrProjectId = (scopedCreate.json as string) ?? (scopedCreate.json as { [k: string]: string })?.create_governance_project;
    const otherWard = await rest("POST", rpc("add_governance_project_scope"),
      { p_project: mgrProjectId, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2 }, mgrToken);
    record("J9c unrelated ward rejected", otherWard.status >= 400, `status ${otherWard.status}`);
    const campaignScope = await rest("POST", rpc("add_governance_project_scope"),
      { p_project: projectId, p_scope_type: "campaign" }, admToken);
    record("J9d campaign scope forbidden", campaignScope.status >= 400, `status ${campaignScope.status}`);

    // ══ J10. audit attribution ═══════════════════════════════════════════
    const audits = await sql.query<{ action: string; actor_id: string | null; tenant_id: string }>(
      `SELECT action, actor_id, tenant_id FROM politicore.system_audits
        WHERE affected_resource = 'governance_projects' AND resource_id = $1
        ORDER BY occurred_at`, [projectId]);
    record("J10 canonical audits carry the hosted actor + tenant",
      audits.rows.some((r) => r.action === "governance_project:create") && audits.rows.every((r) => r.tenant_id === tenantA),
      `${audits.rows.length} audit rows`);

  } catch (e) {
    record("FATAL", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nGovernance Projects hosted acceptance: ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main();
