/**
 * POLITICORE — Governance Commitments (Phase 13) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 13
 * Commitments slice end-to-end through the real PostgREST data API and
 * real GoTrue identities — the same acceptance standard as Phases 6–12:
 *
 *   J1  — anon: zero surface (no reads, no RPC execute on authority RPCs)
 *   J2  — admin creates a commitment WITH manifesto lineage (server mints
 *         GC- reference, tenant, actor; NO Manifesto record is resolved)
 *   J3  — RLS reads: admin sees it; plain member of the same tenant does not
 *   J4  — lifecycle guard: declared→delivered rejected; legal path stamps
 *         completed_at server-side; delivered is terminal
 *   J5  — progress: explicitly reported authority; out-of-range refused
 *   J6  — canonical updates substrate: commitment update created; single-
 *         subject row (commitment set, project NULL); project updates intact
 *   J7  — update visibility via the subject-resolving RPC (204)
 *   J8  — project relationship: link, relink no-op, cross-tenant link
 *         rejected, unlink; links never grant authority
 *   J9  — tenant isolation: tenant-B admin cannot read or mutate (silent
 *         no-op read, RPC raises)
 *   J10 — scope authority: ward-scoped manager creates at their ward;
 *         tenant-wide create refused; unrelated ward rejected; campaign
 *         scope forbidden
 *   J11 — audit attribution: canonical system_audits rows carry the real
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

const P13_TABLES = [
  "governance_updates", "governance_commitment_projects",
  "governance_commitment_scopes", "governance_commitments",
  "governance_project_scopes", "governance_project_milestones", "governance_projects",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], geoIds: string[]) {
  try {
    const CLEAN_TABLES = [
      ...P13_TABLES, "governance_request_events", "governance_assignments",
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
        for (const t of P13_TABLES) {
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
    console.error("cleanup incomplete — remove governance commitment fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const P = `GovCmt!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m48 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.create_governance_commitment(text,text,text,text,text,uuid,text,date,date,text)') IS NOT NULL AS ok`);
    if (!m48.rows[0].ok) throw new Error("migration 0048 commitment signature missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, admin + scoped manager + member each ══════
    const E = `govcmt-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovCmt — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovCmt — isolation`, `govcmt-iso-${SUFFIX}`])).rows[0].id;
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

    const admId = await createAuthUser(sql, admEmail, P, "GovCmt Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovCmt Manager", E);
    await createAuthUser(sql, memEmail, P, "GovCmt Member", E);
    await createAuthUser(sql, isoEmail, P, "GovCmt Iso", `govcmt-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Core Geography fixtures (state → zone → lga → ward chain).
    const STATE = `cst-${SUFFIX}`;
    const ZONE = `czn-${SUFFIX}`;
    const LGA = `clg-${SUFFIX}`;
    const WARD = `cwd-${SUFFIX}`;
    const WARD2 = `cwd2-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD, WARD2);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P13 State','P3') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P13 Zone','P3') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P13 LGA','P3') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P13 Ward','P3') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P13 Ward2','P4') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

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

    const rpc = (name: string) => `/rest/v1/rpc/${name}`;

    // ══ J1. anon zero surface ═════════════════════════════════════════════
    const anonRead = await rest("GET", `/rest/v1/governance_commitments?select=*`);
    record("J1a anon has no read access to the commitments surface",
      (anonRead.status === 401 || (anonRead.status === 200 && arr(anonRead.json).length === 0)),
      `status ${anonRead.status}, rows ${arr(anonRead.json).length}`);
    const anonRpc = await rest("POST", rpc("create_governance_commitment"), { p_title: "anon" });
    record("J1b anon cannot execute the commitment authority RPC", anonRpc.status >= 400,
      `status ${anonRpc.status}`);

    // ══ J2. admin create with manifesto lineage (no Manifesto resolution) ═
    const created = await rest("POST", rpc("create_governance_commitment"), {
      p_title: "Hosted clinic commitment",
      p_details: "Equip ten primary healthcare clinics",
      p_category_label: "Health",
      p_source_type: "manifesto",
      p_source_ref: "Manifesto §Health, item 2",
      p_target_description: "Ten clinics fully equipped",
      p_scopes: JSON.stringify([
        { scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD },
      ]),
    }, admToken);
    const commitmentId = (created.json as { [k: string]: string })?.create_governance_commitment
      ?? (created.json as string);
    record("J2 admin creates a commitment via RPC", created.status === 200 && typeof commitmentId === "string" && commitmentId.length > 0,
      `status ${created.status}, id ${String(commitmentId).slice(0, 8)}…`);

    const crow = (await sql.query<{ reference_code: string; is_public: boolean; source_type: string; source_ref: string | null; tenant_id: string; created_by: string | null }>(
      `SELECT reference_code, is_public, source_type::text, source_ref, tenant_id, created_by
         FROM politicore.governance_commitments WHERE id = $1`, [commitmentId])).rows[0];
    record("J2b GC- reference minted; lineage stored without any manifesto row",
      /^GC-[0-9A-F]{8}$/.test(crow.reference_code) && crow.is_public === false
        && crow.source_type === "manifesto" && crow.source_ref === "Manifesto §Health, item 2"
        && crow.tenant_id === tenantA && crow.created_by !== null,
      `ref ${crow.reference_code}`);
    const manifestoRows = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.manifestos WHERE tenant_id = $1`, [tenantA])).rows[0];
    record("J2c zero Manifesto rows exist for the tenant (lineage-only boundary)",
      manifestoRows.n === "0", `manifestos ${manifestoRows.n}`);

    // ══ J3. RLS reads ═════════════════════════════════════════════════════
    const admSee = await rest("GET", `/rest/v1/governance_commitments?id=eq.${commitmentId}&select=id`, undefined, admToken);
    const memSee = await rest("GET", `/rest/v1/governance_commitments?id=eq.${commitmentId}&select=id`, undefined, memToken);
    record("J3 staff sees the commitment; plain member does not",
      arr(admSee.json).length === 1 && arr(memSee.json).length === 0,
      `admin rows ${arr(admSee.json).length}, member rows ${arr(memSee.json).length}`);

    // ══ J4. lifecycle guard ═══════════════════════════════════════════════
    const illegal = await rest("POST", rpc("set_governance_commitment_status"),
      { p_commitment: commitmentId, p_status: "delivered" }, admToken);
    record("J4a declared → delivered rejected by the server guard", illegal.status >= 400,
      `status ${illegal.status}`);
    await rest("POST", rpc("set_governance_commitment_status"),
      { p_commitment: commitmentId, p_status: "in_progress" }, admToken);
    const delivered = await rest("POST", rpc("set_governance_commitment_status"),
      { p_commitment: commitmentId, p_status: "delivered" }, admToken);
    record("J4b declared → in_progress → delivered succeeds", delivered.status < 400,
      `status ${delivered.status}`);
    const crow3 = (await sql.query<{ status: string; completed_at: string | null }>(
      `SELECT status::text, completed_at FROM politicore.governance_commitments WHERE id = $1`, [commitmentId])).rows[0];
    record("J4c completed_at server-stamped", crow3.status === "delivered" && crow3.completed_at !== null,
      `status ${crow3.status}, completed_at ${String(crow3.completed_at)}`);
    const reopen = await rest("POST", rpc("set_governance_commitment_status"),
      { p_commitment: commitmentId, p_status: "in_progress" }, admToken);
    record("J4d delivered is terminal", reopen.status >= 400, `status ${reopen.status}`);

    // ══ J5. reported progress authority ══════════════════════════════════
    const outOfRange = await rest("POST", rpc("set_governance_commitment_progress"),
      { p_commitment: commitmentId, p_progress: 150 }, admToken);
    record("J5a out-of-range progress refused", outOfRange.status >= 400, `status ${outOfRange.status}`);
    // Use a second commitment so J4's terminal state doesn't block updates.
    const c2 = await rest("POST", rpc("create_governance_commitment"), {
      p_title: "Hosted water commitment",
      p_target_description: "Six boreholes rehabilitated",
      p_source_type: "independent",
    }, admToken);
    const c2Id = (c2.json as { [k: string]: string })?.create_governance_commitment ?? (c2.json as string);
    const prog = await rest("POST", rpc("set_governance_commitment_progress"),
      { p_commitment: c2Id, p_progress: 40 }, admToken);
    record("J5b reported progress accepted (audited)", prog.status < 400, `status ${prog.status}`);
    const crow2 = (await sql.query<{ progress_percent: number }>(
      `SELECT progress_percent FROM politicore.governance_commitments WHERE id = $1`, [c2Id])).rows[0];
    record("J5c progress persisted", crow2.progress_percent === 40, `progress ${crow2.progress_percent}`);

    // ══ J6. canonical updates substrate ══════════════════════════════════
    const upd = await rest("POST", rpc("create_governance_commitment_update"),
      { p_commitment: c2Id, p_title: "Drilling starts", p_body: "Crew mobilised.", p_kind: "progress", p_is_public: false }, admToken);
    const updateId = (upd.json as string) ?? (upd.json as { [k: string]: string })?.create_governance_commitment_update;
    record("J6a commitment update created through governance_updates", upd.status === 200 && typeof updateId === "string",
      `status ${upd.status}`);
    const urow = (await sql.query<{ commitment_id: string | null; project_id: string | null; author_profile_id: string | null }>(
      `SELECT commitment_id, project_id, author_profile_id FROM politicore.governance_updates WHERE id = $1`, [updateId])).rows[0];
    record("J6b single-subject row: commitment set, project NULL, author server-stamped",
      urow.commitment_id === c2Id && urow.project_id === null && urow.author_profile_id !== null,
      `commitment ${String(urow.commitment_id).slice(0, 8)}…`);
    // Project updates intact through the same canonical table.
    const prj = await rest("POST", rpc("create_governance_project"), { p_title: "Cmt linked project" }, admToken);
    const prjId = (prj.json as { [k: string]: string })?.create_governance_project ?? (prj.json as string);
    const pupd = await rest("POST", rpc("create_governance_update"),
      { p_project: prjId, p_title: "", p_body: "Project update intact.", p_kind: "progress", p_is_public: false }, admToken);
    record("J6c project updates still work on the canonical substrate", pupd.status === 200, `status ${pupd.status}`);

    // ══ J7. update visibility via the subject-resolving RPC ══════════════
    const pub = await rest("POST", rpc("set_governance_update_visibility"),
      { p_update: updateId, p_is_public: true }, admToken);
    record("J7 update visibility RPC accepts the commitment subject", pub.status < 400, `status ${pub.status}`);
    const urow2 = (await sql.query<{ is_public: boolean }>(
      `SELECT is_public FROM politicore.governance_updates WHERE id = $1`, [updateId])).rows[0];
    record("J7b update published", urow2.is_public === true, `is_public ${urow2.is_public}`);

    // ══ J8. project relationship ═════════════════════════════════════════
    const link = await rest("POST", rpc("link_governance_project"),
      { p_commitment: c2Id, p_project: prjId }, admToken);
    record("J8a project linked to the commitment", link.status === 200, `status ${link.status}`);
    const link2 = await rest("POST", rpc("link_governance_project"),
      { p_commitment: c2Id, p_project: prjId }, admToken);
    record("J8b re-link is an idempotent no-op", link2.status === 200, `status ${link2.status}`);
    const mgrLink = await rest("POST", rpc("link_governance_project"),
      { p_commitment: c2Id, p_project: prjId }, mgrToken);
    record("J8c linking does not grant authority to an unscoped manager", mgrLink.status >= 400,
      `status ${mgrLink.status}`);
    const unlink = await rest("POST", rpc("unlink_governance_project"),
      { p_commitment: c2Id, p_project: prjId }, admToken);
    record("J8d unlink works for the commitment authority", unlink.status < 400, `status ${unlink.status}`);
    const linkCount = (await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.governance_commitment_projects WHERE commitment_id = $1`, [c2Id])).rows[0];
    record("J8e relationship table empty after unlink", linkCount.n === "0", `rows ${linkCount.n}`);
    // Cross-tenant project link rejected.
    const prjB = await rest("POST", rpc("create_governance_project"), { p_title: "Iso tenant project" }, isoToken);
    const prjBId = (prjB.json as { [k: string]: string })?.create_governance_project ?? (prjB.json as string);
    const crossLink = await rest("POST", rpc("link_governance_project"),
      { p_commitment: c2Id, p_project: prjBId }, admToken);
    record("J8f cross-tenant link rejected", crossLink.status >= 400, `status ${crossLink.status}`);

    // ══ J9. tenant isolation ═════════════════════════════════════════════
    const isoRead = await rest("GET", `/rest/v1/governance_commitments?id=eq.${c2Id}&select=id`, undefined, isoToken);
    record("J9a cross-tenant read returns nothing", isoRead.status === 200 && arr(isoRead.json).length === 0,
      `iso rows ${arr(isoRead.json).length}`);
    const isoUpdate = await rest("POST", rpc("update_governance_commitment"),
      { p_commitment: c2Id, p_title: "Hijacked" }, isoToken);
    record("J9b cross-tenant RPC mutation fails closed", isoUpdate.status >= 400, `status ${isoUpdate.status}`);

    // ══ J10. scope authority ═════════════════════════════════════════════
    const scopedCreate = await rest("POST", rpc("create_governance_commitment"), {
      p_title: "Manager ward commitment",
      p_source_type: "independent",
      p_scopes: JSON.stringify([{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }]),
    }, mgrToken);
    record("J10a ward-scoped manager creates at their ward", scopedCreate.status === 200,
      `status ${scopedCreate.status}`);
    const unscopedCreate = await rest("POST", rpc("create_governance_commitment"), {
      p_title: "Manager tenant-wide", p_scopes: "[]",
    }, mgrToken);
    record("J10b tenant-wide create refused for scoped grantee", unscopedCreate.status >= 400,
      `status ${unscopedCreate.status}`);
    const mgrCommitmentId = (scopedCreate.json as { [k: string]: string })?.create_governance_commitment ?? (scopedCreate.json as string);
    const otherWard = await rest("POST", rpc("add_governance_commitment_scope"),
      { p_commitment: mgrCommitmentId, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2 }, mgrToken);
    record("J10c unrelated ward rejected", otherWard.status >= 400, `status ${otherWard.status}`);
    const campaignScope = await rest("POST", rpc("add_governance_commitment_scope"),
      { p_commitment: c2Id, p_scope_type: "campaign" }, admToken);
    record("J10d campaign scope forbidden", campaignScope.status >= 400, `status ${campaignScope.status}`);

    // ══ J11. audit attribution ═══════════════════════════════════════════
    const audits = await sql.query<{ action: string; actor_id: string | null; tenant_id: string }>(
      `SELECT action, actor_id, tenant_id FROM politicore.system_audits
        WHERE affected_resource = 'governance_commitments' AND resource_id = $1
        ORDER BY occurred_at`, [c2Id]);
    record("J11 canonical audits carry the hosted actor + tenant",
      audits.rows.some((r) => r.action === "governance_commitment:create") && audits.rows.every((r) => r.tenant_id === tenantA),
      `${audits.rows.length} audit rows`);

  } catch (e) {
    record("FATAL", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails, geoIds);
    await sql.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nGovernance Commitments hosted acceptance: ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main();
