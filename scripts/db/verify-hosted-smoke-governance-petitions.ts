/**
 * POLITICORE — Governance Petitions & Community Proposals (Phase 15) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 15
 * Petitions slice end-to-end through the real PostgREST data API and real
 * GoTrue identities — the same acceptance standard as Phases 6–14:
 *
 *   J1  — anon: zero surface (no reads, no RPC execute)
 *   J2  — admin creates a petition (server mints PP- reference, tenant,
 *         actor; draft status; origin discriminator)
 *   J3  — RLS reads: staff see drafts; members see open petitions only
 *   J4  — lifecycle: draft→closed rejected; open→closed; verified and
 *         results_published unreachable via the status RPC
 *   J5  — participation: member signs without any permission; duplicate
 *         and post-closure signing rejected
 *   J6  — verification-before-results: publish refuses a merely-closed
 *         petition; verify snapshots the count; publish then succeeds
 *   J7  — privacy: participant sees only their own signature row
 *   J8  — closes_at honored server-side
 *   J9  — scope authority: ward-scoped manager creates at their ward;
 *         tenant-wide create refused; unrelated ward rejected; campaign
 *         scope forbidden; the 0053-corrected ward shape works
 *   J10 — tenant isolation: cross-tenant read/mutate/sign fail closed
 *   J11 — canonical updates substrate: single-subject invariant spans
 *         project|commitment|consultation|petition; prior subjects still work
 *   J12 — core notifications: open fanout + moderation notice are canonical
 *         politicore.notifications rows
 *   J13 — audit attribution: canonical system_audits rows carry the real
 *         hosted auth.uid() as actor (RPC actions)
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

const P15_TABLES = [
  "governance_petition_supports", "governance_petition_scopes", "governance_petitions",
  "governance_consultation_responses", "governance_consultation_scopes",
  "governance_consultations", "governance_updates", "governance_commitment_projects",
  "governance_commitment_scopes", "governance_commitments",
  "governance_project_scopes", "governance_project_milestones", "governance_projects",
];

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[], geoIds: string[]) {
  try {
    const CLEAN_TABLES = [
      ...P15_TABLES, "governance_request_events", "governance_assignments",
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
        for (const t of P15_TABLES) {
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
    console.error("cleanup incomplete — remove governance petition fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const geoIds: string[] = [];
  const P = `GovPet!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m52 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.sign_governance_petition(uuid,text)') IS NOT NULL AS ok`);
    if (!m52.rows[0].ok) throw new Error("migration 0052 petitions signature missing on hosted — run apply-hosted first");
    const m53 = await sql.query<{ ok: boolean }>(
      `SELECT position('ward_id IS NOT NULL) AND (polling_unit_id IS NULL' in
         pg_get_constraintdef(oid)) > 0 AS ok
         FROM pg_constraint WHERE conname='governance_petition_scope_shape'`);
    if (!m53.rows[0]?.ok) throw new Error("migration 0053 scope-shape convergence missing on hosted — run apply-hosted first");

    // ══ Fixtures: two tenants, admin + scoped manager + member + iso ═════
    const E = `govpet-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovPet — main`, E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`GovPet — isolation`, `govpet-iso-${SUFFIX}`])).rows[0].id;
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

    const admId = await createAuthUser(sql, admEmail, P, "GovPet Admin", E);
    const mgrId = await createAuthUser(sql, mgrEmail, P, "GovPet Manager", E);
    const memId = await createAuthUser(sql, memEmail, P, "GovPet Member", E);
    await createAuthUser(sql, isoEmail, P, "GovPet Iso", `govpet-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);

    // Core Geography fixtures (state → zone → lga → ward chain).
    const STATE = `pst-${SUFFIX}`;
    const ZONE = `pzn-${SUFFIX}`;
    const LGA = `plg-${SUFFIX}`;
    const WARD = `pwd-${SUFFIX}`;
    const WARD2 = `pwd2-${SUFFIX}`;
    geoIds.push(STATE, ZONE, LGA, WARD, WARD2);
    await sql.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P15 State','P5') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await sql.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P15 Zone','P5') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await sql.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P15 LGA','P5') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P15 Ward','P5') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await sql.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P15 Ward2','P6') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);

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

    // ══ J1. anon zero surface ═════════════════════════════════════════════
    const anonRead = await rest("GET", `/rest/v1/governance_petitions?select=*`);
    record("J1a anon has no read access to the petitions surface",
      (anonRead.status === 401 || (anonRead.status === 200 && arr(anonRead.json).length === 0)),
      `status ${anonRead.status}, rows ${arr(anonRead.json).length}`);
    const anonRpc = await rest("POST", rpc("sign_governance_petition"),
      { p_petition: "00000000-0000-0000-0000-000000000000" });
    record("J1b anon cannot execute the participation RPC", anonRpc.status >= 400,
      `status ${anonRpc.status}`);
    const anonRpc2 = await rest("POST", rpc("verify_governance_petition"),
      { p_petition: "00000000-0000-0000-0000-000000000000" });
    record("J1c anon cannot execute the verification RPC", anonRpc2.status >= 400,
      `status ${anonRpc2.status}`);

    // ══ J2. admin creates a petition ═════════════════════════════════════
    const created = await rest("POST", rpc("create_governance_petition"), {
      p_origin: "petition",
      p_title: "Hosted ward drainage petition",
      p_demand: "Fix the drainage before the rains.",
      p_target_signatures: 50,
    }, admToken);
    const petitionId = (created.json as { [k: string]: string })?.create_governance_petition
      ?? (created.json as string);
    record("J2a admin creates a staff petition via RPC",
      created.status === 200 && typeof petitionId === "string" && petitionId.length > 0,
      `status ${created.status}, id ${String(petitionId).slice(0, 8)}…`);

    const prow = (await sql.query<{ reference_code: string; origin: string; status: string; is_public: boolean; tenant_id: string; created_by: string | null; proposer_participant_id: string | null }>(
      `SELECT reference_code, origin::text, status::text, is_public, tenant_id, created_by, proposer_participant_id
         FROM politicore.governance_petitions WHERE id = $1`, [petitionId])).rows[0];
    record("J2b PP- reference minted; origin=petition; draft; tenant + actor server-stamped; private",
      /^PP-[0-9A-F]{8}$/.test(prow.reference_code) && prow.origin === "petition"
        && prow.status === "draft" && prow.is_public === false
        && prow.tenant_id === tenantA && prow.created_by !== null
        && prow.proposer_participant_id === null,
      `ref ${prow.reference_code}, status ${prow.status}`);

    // Community proposal: member originates WITHOUT any permission.
    const propCreated = await rest("POST", rpc("create_governance_petition"), {
      p_origin: "community_proposal",
      p_title: "Hosted community market proposal",
      p_demand: "Open a weekend market.",
    }, memToken);
    const proposalId = (propCreated.json as { [k: string]: string })?.create_governance_petition
      ?? (propCreated.json as string);
    record("J2c a member originates a community proposal (no permission) → pending moderation",
      propCreated.status === 200 && typeof proposalId === "string",
      `status ${propCreated.status}`);
    const propRow = (await sql.query<{ status: string; proposer_participant_id: string | null }>(
      `SELECT status::text, proposer_participant_id FROM politicore.governance_petitions WHERE id = $1`,
      [proposalId])).rows[0];
    record("J2d proposal enters pending with a server-resolved proposer",
      propRow.status === "pending" && propRow.proposer_participant_id !== null,
      `status ${propRow.status}`);

    // ══ J3. RLS reads — drafts staff-only ════════════════════════════════
    const admSee = await rest("GET", `/rest/v1/governance_petitions?id=eq.${petitionId}&select=id`, undefined, admToken);
    const memSee = await rest("GET", `/rest/v1/governance_petitions?id=eq.${petitionId}&select=id`, undefined, memToken);
    record("J3 staff sees the draft; member does not (drafts are staff-only)",
      arr(admSee.json).length === 1 && arr(memSee.json).length === 0,
      `admin rows ${arr(admSee.json).length}, member rows ${arr(memSee.json).length}`);

    // ══ J4. lifecycle ════════════════════════════════════════════════════
    const illegal = await rest("POST", rpc("set_governance_petition_status"),
      { p_petition: petitionId, p_status: "closed" }, admToken);
    record("J4a draft → closed rejected by the server guard", illegal.status >= 400,
      `status ${illegal.status}`);

    const verifyEarly = await rest("POST", rpc("set_governance_petition_status"),
      { p_petition: petitionId, p_status: "verified" }, admToken);
    record("J4b verified is unreachable via the status RPC", verifyEarly.status >= 400,
      `status ${verifyEarly.status}`);

    const opened = await rest("POST", rpc("set_governance_petition_status"),
      { p_petition: petitionId, p_status: "open" }, admToken);
    record("J4c draft → open succeeds", opened.status < 400, `status ${opened.status}`);

    const memSeeOpen = await rest("GET", `/rest/v1/governance_petitions?id=eq.${petitionId}&select=id,status`, undefined, memToken);
    record("J4d open petitions are discoverable by members",
      arr(memSeeOpen.json).length === 1, `member rows ${arr(memSeeOpen.json).length}`);

    // ══ J5. participation ════════════════════════════════════════════════
    const signed = await rest("POST", rpc("sign_governance_petition"),
      { p_petition: petitionId, p_comment: "Drainage flooded my street last year." }, memToken);
    record("J5a member signs without any permission", signed.status === 200,
      `status ${signed.status}`);

    const dup = await rest("POST", rpc("sign_governance_petition"),
      { p_petition: petitionId }, memToken);
    record("J5b duplicate signature rejected (one per participant)", dup.status >= 400,
      `status ${dup.status}`);

    // ══ J7. privacy (own-row) — while still open ═════════════════════════
    const own = await rest("GET", `/rest/v1/governance_petition_supports?petition_id=eq.${petitionId}&select=*`, undefined, memToken);
    record("J7 participant sees only their own signature row",
      arr(own.json).length === 1, `rows ${arr(own.json).length}`);
    const anonSupports = await rest("GET", `/rest/v1/governance_petition_supports?petition_id=eq.${petitionId}&select=*`);
    record("J7b anon sees no signature rows",
      anonSupports.status >= 400 || arr(anonSupports.json).length === 0,
      `status ${anonSupports.status}`);

    // ══ J8. closes_at honored server-side ════════════════════════════════
    const past = new Date(Date.now() - 60_000).toISOString();
    const closesAtFix = await rest("POST", rpc("update_governance_petition"),
      { p_petition: petitionId, p_closes_at: past }, admToken);
    const lateSign = await rest("POST", rpc("sign_governance_petition"),
      { p_petition: petitionId }, mgrToken);
    record("J8 signature refused after a past closes_at",
      (closesAtFix.status === 200 || closesAtFix.status === 204) && lateSign.status >= 400,
      `fix ${closesAtFix.status}, late sign ${lateSign.status}`);
    // clear closes_at for the rest of the journey
    await rest("POST", rpc("update_governance_petition"),
      { p_petition: petitionId, p_clear_closes_at: true }, admToken);

    // ══ J9. scope authority (0053-corrected ward shape) ══════════════════
    const scoped = await rest("POST", rpc("create_governance_petition"), {
      p_origin: "petition",
      p_title: "Hosted ward clinic petition",
      p_scopes: [{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }],
    }, mgrToken);
    const scopedId = (scoped.json as { [k: string]: string })?.create_governance_petition
      ?? (scoped.json as string);
    record("J9a ward-scoped manager creates a petition AT their ward (0053 shape)",
      scoped.status === 200 && typeof scopedId === "string",
      `status ${scoped.status}`);

    const wide = await rest("POST", rpc("create_governance_petition"), {
      p_origin: "petition", p_title: "Hosted wide petition attempt",
    }, mgrToken);
    record("J9b scope-scoped manager cannot mint a tenant-wide petition", wide.status >= 400,
      `status ${wide.status}`);

    const attachRoad = await rest("POST", rpc("create_governance_petition"), {
      p_origin: "petition", p_title: "Hosted road petition", p_scopes: [],
    }, admToken);
    const roadId = (attachRoad.json as { [k: string]: string })?.create_governance_petition
      ?? (attachRoad.json as string);
    const outside = await rest("POST", rpc("add_governance_petition_scope"), {
      p_petition: roadId,
      p_scope_type: "ward",
      p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2,
    }, mgrToken);
    record("J9c scope-scoped manager cannot attach a scope outside their authority",
      outside.status >= 400, `status ${outside.status}`);

    const campaign = await rest("POST", rpc("add_governance_petition_scope"), {
      p_petition: roadId, p_scope_type: "campaign",
    }, admToken);
    record("J9d campaign scope is forbidden", campaign.status >= 400,
      `status ${campaign.status}`);

    const unknownGeo = await rest("POST", rpc("add_governance_petition_scope"), {
      p_petition: roadId, p_scope_type: "ward",
      p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "no-such-ward",
    }, admToken);
    record("J9e unknown geography fails closed", unknownGeo.status >= 400,
      `status ${unknownGeo.status}`);

    // ══ J6. verification-before-results ══════════════════════════════════
    const premature = await rest("POST", rpc("publish_petition_results"),
      { p_petition: petitionId, p_summary: "premature" }, admToken);
    record("J6a results refused before closure", premature.status >= 400,
      `status ${premature.status}`);

    const closed = await rest("POST", rpc("set_governance_petition_status"),
      { p_petition: petitionId, p_status: "closed" }, admToken);
    record("J6b open → closed succeeds", closed.status < 400, `status ${closed.status}`);

    const lateCloseSign = await rest("POST", rpc("sign_governance_petition"),
      { p_petition: petitionId }, memToken);
    record("J6c signing refused on a closed petition", lateCloseSign.status >= 400,
      `status ${lateCloseSign.status}`);

    const unverifiedPub = await rest("POST", rpc("publish_petition_results"),
      { p_petition: petitionId, p_summary: "unverified" }, admToken);
    record("J6d results refused on a merely-closed (unverified) petition",
      unverifiedPub.status >= 400, `status ${unverifiedPub.status}`);

    const unauthVerify = await rest("POST", rpc("verify_governance_petition"),
      { p_petition: petitionId }, memToken);
    record("J6e an unauthorized member cannot verify", unauthVerify.status >= 400,
      `status ${unauthVerify.status}`);

    const verified = await rest("POST", rpc("verify_governance_petition"),
      { p_petition: petitionId, p_note: "hosted walk-through" }, admToken);
    // PostgREST returns a bare JSON scalar for scalar-returning functions
    // (not a {fn: value} envelope).
    const verifiedCount = typeof verified.json === "number"
      ? verified.json
      : Number((verified.json as { [k: string]: number })?.verify_governance_petition);
    record("J6f staff verification snapshots the verified count",
      (verified.status === 200 || verified.status === 204) && Number(verifiedCount) === 1,
      `status ${verified.status}, count ${String(verifiedCount)}`);

    const mgrNoPub = await rest("POST", rpc("publish_petition_results"),
      { p_petition: petitionId, p_summary: "manager attempt" }, mgrToken);
    record("J6g publish_accountability required to publish results", mgrNoPub.status >= 400,
      `status ${mgrNoPub.status}`);

    const published = await rest("POST", rpc("publish_petition_results"),
      { p_petition: petitionId, p_summary: "1 verified signature — referred to works." }, admToken);
    record("J6h results publish after verification", published.status < 400,
      `status ${published.status}`);

    const afterRow = (await sql.query<{ status: string; verified_count: number | null; verified_at: string | null; results_summary: string }>(
      `SELECT status::text, verified_count, verified_at, results_summary
         FROM politicore.governance_petitions WHERE id = $1`, [petitionId])).rows[0];
    record("J6i terminal state retained: results_published + immutable verified snapshot",
      afterRow.status === "results_published" && afterRow.verified_count === 1
        && afterRow.verified_at !== null && afterRow.results_summary.length > 0,
      `status ${afterRow.status}`);

    const repub = await rest("POST", rpc("publish_petition_results"),
      { p_petition: petitionId, p_summary: "again" }, admToken);
    record("J6j no republish — terminal state", repub.status >= 400,
      `status ${repub.status}`);

    // ══ J10. tenant isolation ════════════════════════════════════════════
    const foreignRead = await rest("GET", `/rest/v1/governance_petitions?id=eq.${petitionId}&select=id`, undefined, isoToken);
    record("J10a cross-tenant read returns nothing", arr(foreignRead.json).length === 0,
      `rows ${arr(foreignRead.json).length}`);

    const foreignStatus = await rest("POST", rpc("set_governance_petition_status"),
      { p_petition: petitionId, p_status: "open" }, isoToken);
    record("J10b cross-tenant mutation fails closed", foreignStatus.status >= 400,
      `status ${foreignStatus.status}`);

    // open the scoped ward petition to prove cross-tenant SIGN fails even
    // on an open instrument
    await rest("POST", rpc("set_governance_petition_status"),
      { p_petition: scopedId, p_status: "open" }, mgrToken);
    const foreignSign = await rest("POST", rpc("sign_governance_petition"),
      { p_petition: scopedId }, isoToken);
    record("J10c cross-tenant signature fails closed", foreignSign.status >= 400,
      `status ${foreignSign.status}`);

    // ══ J11. canonical updates substrate ═════════════════════════════════
    const updDef = (await sql.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`)).rows[0].d;
    record("J11a single-subject constraint spans project|commitment|consultation|petition",
      updDef.includes("project_id") && updDef.includes("commitment_id")
        && updDef.includes("consultation_id") && updDef.includes("petition_id"),
      updDef.slice(0, 80) + "…");

    const project = await rest("POST", rpc("create_governance_project"),
      { p_title: "Hosted petition-substrate probe project" }, admToken);
    const projectId = (project.json as { [k: string]: string })?.create_governance_project
      ?? (project.json as string);
    const projectUpdate = await rest("POST", rpc("create_governance_update"),
      { p_project: projectId, p_title: "Kickoff", p_body: "still works" }, admToken);
    record("J11b project updates still work (Phase 12 substrate preserved)",
      projectUpdate.status < 400, `status ${projectUpdate.status}`);

    const commitment = await rest("POST", rpc("create_governance_commitment"),
      { p_title: "Hosted petition-substrate probe commitment" }, admToken);
    const commitmentId = (commitment.json as { [k: string]: string })?.create_governance_commitment
      ?? (commitment.json as string);
    const commitmentUpdate = await rest("POST", rpc("create_governance_commitment_update"),
      { p_commitment: commitmentId, p_title: "Kickoff", p_body: "still works" }, admToken);
    record("J11c commitment updates still work (Phase 13 substrate preserved)",
      commitmentUpdate.status < 400, `status ${commitmentUpdate.status}`);

    // ══ J12. core notifications ══════════════════════════════════════════
    const notices = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications
        WHERE tenant_id = $1 AND link_url LIKE '/governance/participate%'`, [tenantA]);
    record("J12 open-fanout invitations are canonical notifications rows",
      Number(notices.rows[0].n) > 0, `rows ${notices.rows[0].n}`);
    const modNotices = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.notifications
        WHERE tenant_id = $1 AND title = 'Community proposal awaiting review'`, [tenantA]);
    record("J12b moderation notice from the proposal intake is canonical", Number(modNotices.rows[0].n) > 0,
      `rows ${modNotices.rows[0].n}`);

    // ══ J13. audit attribution ═══════════════════════════════════════════
    const audits = await sql.query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id::text FROM politicore.system_audits
        WHERE affected_resource = 'governance_petitions' AND tenant_id = $1
          AND action IN ('governance_petition:create','governance_petition:status','governance_petition:verified')
        ORDER BY occurred_at DESC LIMIT 6`, [tenantA]);
    const rpcAudits = audits.rows.filter((r) => r.actor_id !== null);
    record("J13 RPC audits carry the real hosted actor uid",
      rpcAudits.length > 0 && rpcAudits.every((r) => r.actor_id === admId || r.actor_id === mgrId || r.actor_id === memId),
      `${rpcAudits.length} audited rows`);
    const signAudit = await sql.query<{ actor_id: string | null }>(
      `SELECT actor_id::text FROM politicore.system_audits
        WHERE action='governance_petition:sign' AND tenant_id = $1
        ORDER BY occurred_at DESC LIMIT 1`, [tenantA]);
    record("J13b the signature audit carries the signer's own uid",
      signAudit.rows[0]?.actor_id === memId, `actor ${signAudit.rows[0]?.actor_id?.slice(0, 8)}…`);

    // ══ J14. staff petition creation refused without permission ══════════
    const memStaff = await rest("POST", rpc("create_governance_petition"),
      { p_origin: "petition", p_title: "Hosted member staff-petition attempt" }, memToken);
    record("J14 a member cannot create a staff petition (origin=petition)",
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
