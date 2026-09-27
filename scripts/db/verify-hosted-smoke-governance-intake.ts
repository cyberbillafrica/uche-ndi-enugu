/**
 * POLITICORE — Governance Public Intake (Phase 10) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project: the real public data API
 * (PostgREST) as the anonymous browser, real RLS, the real public RPC
 * wrappers — proving the contact-verified public intake slice end to end
 * under the same acceptance standard as the Campaign / Social / Governance
 * harnesses.
 *
 * Journeys (prompt §27):
 *   J1  — anon base-table surface: zero governance/intake/credential rows
 *         reachable over the public API (404/empty everywhere)
 *   J2  — gates: public_intake OFF, module OFF, bad category, oversized
 *         subject all fail closed over the wire
 *   J3  — contact-verified submission: staging row + delivery intent,
 *         NO participant, NO request, NO identity before activation
 *   J4  — activation: single-use token → reference + 256-bit secret;
 *         replay is rejected; cross-site slug is rejected
 *   J5  — the activated case enters the CANONICAL Governance workflow
 *         (staff acknowledge → acknowledged, PUBLIC event)
 *   J6  — tracking: reference alone insufficient; wrong secret yields the
 *         empty no-oracle result; correct pair returns the minimal
 *         public-lifecycle projection only; failures audited per window
 *   J7  — duplicate collapse (resend rotates the token, one staging row)
 *         and the per-contact cooldown over the wire
 *   J8  — participant dedup: two activations, one external participant
 *   E   — pristine cleanup (0 fixtures: staging/credentials/intents/
 *         governance rows/audits/tenants/auth users)
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

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
}
function arr(json: unknown): Record<string, unknown>[] {
  return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
}
function msg(json: unknown): string {
  const m = (json as { message?: string } | null)?.message ?? "";
  return String(m);
}
function first(json: unknown): Record<string, unknown> | undefined {
  return Array.isArray(json) ? (json as Record<string, unknown>[])[0] : undefined;
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

const GOV_TABLES = [
  "governance_request_events", "governance_assignments", "governance_requests",
  "governance_participants", "governance_request_categories",
  "governance_intake_staging", "governance_tracking_credentials",
];

/** Latest verification code for a contact (the delivery-intent inbox). */
async function latestToken(sql: pg.Client, email: string): Promise<string> {
  const r = await sql.query<{ body: string }>(
    `SELECT body FROM politicore.core_delivery_intents
      WHERE to_address = $1 AND channel = 'email'
      ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  const m = String(r.rows[0]?.body ?? "").match(/code \(valid for 24 hours\): (\S+)/);
  if (!m) throw new Error(`no verification code found for ${email}`);
  return m[1];
}

async function agePastCooldown(sql: pg.Client, email: string) {
  await sql.query(
    `UPDATE politicore.system_audits
        SET occurred_at = occurred_at - interval '11 minutes'
      WHERE action = 'governance_public_intake'
        AND new_value ->> 'ch' = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [email]
  );
}

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  try {
    const CLEAN_TABLES = [...GOV_TABLES, "notifications", "permission_grants",
                          "system_audits", "tenants", "tenant_modules",
                          "core_delivery_intents"];
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
        await sql.query(`DELETE FROM politicore.core_delivery_intents WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE action LIKE 'governance_%' AND tenant_id IS NULL`);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        const left = await sql.query<{ n: string }>(
          `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        if (left.rows[0].n === "0") break;
      }
    } finally {
      await sql.query("SET session_replication_role = DEFAULT");
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log("cleanup: fixtures removed, FORCE-RLS state restored " +
      `on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove intake fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `GovIntake!${SUFFIX}`;

  try {
    // ══ 0. preconditions ═════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    const m37 = await sql.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.governance_verify_public_request(text,text)') IS NOT NULL
         AND to_regprocedure('politicore.governance_track_public_request(text,text)') IS NOT NULL AS ok`);
    if (!m37.rows[0].ok) throw new Error("migration 0037/0040/0042 not applied on hosted — run apply-hosted first");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `govint-${SUFFIX}`;
    const tenantOn = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Public Intake — on`, E])).rows[0].id;
    tenantIds.push(tenantOn);
    const tenantIso = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Public Intake — toggle off`, `${E}-iso`])).rows[0].id;
    tenantIds.push(tenantIso);
    const tenantOff = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Public Intake — module off`, `${E}-off`])).rows[0].id;
    tenantIds.push(tenantOff);

    await sql.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
       VALUES ($1,'governance',true), ($2,'governance',true), ($3,'governance',false)`,
      [tenantOn, tenantIso, tenantOff]);
    await sql.query(
      `UPDATE politicore.tenant_modules
          SET config = jsonb_build_object('public_intake', true)
        WHERE tenant_id = $1 AND module = 'governance'`,
      [tenantOn]);
    await sql.query(
      `INSERT INTO politicore.governance_request_categories (tenant_id, name, description, is_active)
       VALUES ($1, 'Water Supply', 'water issues', true),
              ($1, 'Roads', 'road issues', true)`,
      [tenantOn]);

    // One staff identity for the canonical-workflow journey (J5).
    const stfEmail = `${E}-stf@test.local`;
    emails.push(stfEmail);
    const stfId = await createAuthUser(sql, stfEmail, P, "Gov Intake Staff", E);
    await sql.query(
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'manage_cases', true), ($1, $2, 'assign_cases', true)`,
      [tenantOn, stfId]);
    await new Promise((r) => setTimeout(r, 1500));
    const stfToken = await signin(stfEmail, P);

    const CONTACT = `citizen-${SUFFIX}@mail.example`;
    const SUBJECT = `Borehole outage on Market Road ${SUFFIX}`;

    // ══ J1. anon base-table surface over the public API ═════════════════
    let surfaceClean = true;
    const probed: string[] = [];
    for (const t of GOV_TABLES) {
      const r = await rest("GET", `/rest/v1/${t}?select=*`);
      probed.push(`${t}=${r.status}`);
      if (r.status < 400 && arr(r.json).length > 0) surfaceClean = false;
    }
    for (const t of ["governance_intake_staging", "governance_tracking_credentials",
                     "core_delivery_intents"]) {
      const r = await rest("GET", `/rest/v1/${t}?select=*`);
      probed.push(`${t}=${r.status}`);
      if (r.status < 400 && arr(r.json).length > 0) surfaceClean = false;
    }
    record("J1 anon base-table surface exposes nothing",
      surfaceClean, probed.join(", "));

    // ══ J2. gates fail closed over the wire ═════════════════════════════
    const intakeCall = (slug: string, email: string, subject: string, category?: string) =>
      rest("POST", "/rest/v1/rpc/governance_public_intake", {
        p_tenant_slug: slug, p_contact_email: email, p_full_name: "Citizen Probe",
        p_category: category ?? "Water Supply", p_subject: subject,
        p_description: "This description is long enough to pass validation checks.",
        p_ward_id: null, p_lga_id: null, p_polling_unit_id: null, p_consent: true,
      });
    const gToggle = await intakeCall(`${E}-iso`, `iso-${CONTACT}`, "Toggle off probe");
    const gModule = await intakeCall(`${E}-off`, `off-${CONTACT}`, "Module off probe");
    const gCat    = await intakeCall(E, `cat-${CONTACT}`, "Category probe", "Nonexistent Category");
    const gBig    = await intakeCall(E, `big-${CONTACT}`, "x".repeat(201));
    record("J2 gates fail closed (toggle, module, category, size)",
      gToggle.status >= 400 && /public intake is not available/i.test(msg(gToggle.json)) &&
      gModule.status >= 400 && gCat.status >= 400 &&
      /category is not available/i.test(msg(gCat.json)) && gBig.status >= 400,
      `toggle=${gToggle.status}, module=${gModule.status}, category=${gCat.status} ` +
      `"${msg(gCat.json).slice(0, 40)}", size=${gBig.status}`);

    // ══ J3. submission stages without participant/request/identity ══════
    const sub = await intakeCall(E, CONTACT, SUBJECT);
    const counts = await sql.query<{ parts: string; reqs: string; staging: string }>(
      `SELECT (SELECT count(*)::text FROM politicore.governance_participants WHERE email = $1) AS parts,
              (SELECT count(*)::text FROM politicore.governance_requests r
                JOIN politicore.governance_participants p ON p.id = r.participant_id
               WHERE p.email = $1) AS reqs,
              (SELECT count(*)::text FROM politicore.governance_intake_staging s
                JOIN politicore.tenants t ON t.id = s.tenant_id
               WHERE t.slug = $2 AND s.status = 'pending') AS staging`,
      [CONTACT, E]);
    record("J3 submission TRUE; staging exists; NO participant/request/identity",
      sub.status === 200 && sub.json === true &&
      counts.rows[0].staging === "1" && counts.rows[0].parts === "0" &&
      counts.rows[0].reqs === "0",
      `intake=${sub.status} ${String(sub.json)}, staging=${counts.rows[0].staging}, ` +
      `participants=${counts.rows[0].parts}, requests=${counts.rows[0].reqs}`);

    // ══ J4. activation: single-use, reference + 256-bit secret ══════════
    const token1 = await latestToken(sql, CONTACT);
    const ver = await rest("POST", "/rest/v1/rpc/governance_verify",
      { p_token: token1, p_tenant_slug: E });
    const vrow = first(ver.json);
    const ref1 = String(vrow?.reference_code ?? "");
    const secret1 = String(vrow?.tracking_secret ?? "");
    const replay = await rest("POST", "/rest/v1/rpc/governance_verify",
      { p_token: token1, p_tenant_slug: E });

    // Cross-site replay: a NEW pending staging for the same tenant, verified
    // against the WRONG site slug → tenant_mismatch (fail closed).
    await agePastCooldown(sql, CONTACT);
    const sub2 = await intakeCall(E, CONTACT, `Cross-site probe ${SUFFIX}`);
    const token2 = await latestToken(sql, CONTACT);
    const xsite = await rest("POST", "/rest/v1/rpc/governance_verify",
      { p_token: token2, p_tenant_slug: `${E}-iso` });
    record("J4 activation issues reference+secret once; replay and cross-site fail",
      ver.status === 200 && /^GR-\d{4}-[0-9A-Fa-f]{8}$/.test(ref1) &&
      secret1.length === 64 && replay.status >= 400 &&
      sub2.status === 200 && xsite.status >= 400,
      `verify=${ver.status}, ref=${ref1}, secret=${secret1.length} chars, ` +
      `replay=${replay.status}, cross-site=${xsite.status}`);

    // ══ J5. the activated case enters the CANONICAL Governance workflow ═
    const ack = await rest("POST", "/rest/v1/rpc/acknowledge_governance_request",
      { p_request_id: (await sql.query<{ id: string }>(
          `SELECT id FROM politicore.governance_requests WHERE reference_code = $1`, [ref1]
        )).rows[0].id, p_note: "Logged by the office" }, stfToken);
    record("J5 staff acknowledge works on the public-intake case (canonical queue)",
      ack.status === 200,
      `acknowledge=${ack.status} ${ack.status !== 200 ? msg(ack.json).slice(0, 60) : ""}`);

    // ══ J6. tracking: no oracle, minimal projection, audited failures ═══
    const noSecret = await rest("POST", "/rest/v1/rpc/governance_track",
      { p_reference: ref1, p_tracking_secret: "" });
    const wrong = await rest("POST", "/rest/v1/rpc/governance_track",
      { p_reference: ref1, p_tracking_secret: "a".repeat(64) });
    const ok = await rest("POST", "/rest/v1/rpc/governance_track",
      { p_reference: ref1, p_tracking_secret: secret1 });
    const okRows = arr(ok.json);
    const okCols = okRows.length > 0 ? Object.keys(okRows[0]).sort().join(",") : "";
    const kinds = okRows.map((r) => String(r.event_kind ?? ""));
    const statuses = new Set(okRows.map((r) => String(r.status)));
    // Two more failed attempts → the rejection audit ledger grows.
    await rest("POST", "/rest/v1/rpc/governance_track",
      { p_reference: ref1, p_tracking_secret: "b".repeat(64) });
    await rest("POST", "/rest/v1/rpc/governance_track",
      { p_reference: ref1, p_tracking_secret: "c".repeat(64) });
    const rej = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.system_audits
        WHERE action = 'governance_tracking_rejected'
          AND new_value ->> 'ref' = $1`, [ref1]);
    record("J6 tracking is reference+secret; minimal public projection; failures audited",
      noSecret.status >= 400 && /required/i.test(msg(noSecret.json)) &&
      wrong.status === 200 && arr(wrong.json).length === 0 &&
      ok.status === 200 && okRows.length >= 2 &&
      okCols === "created_at,event_created_at,event_kind,reference_code,status" &&
      kinds.includes("submitted") && kinds.includes("acknowledged") &&
      statuses.size === 1 && Number(rej.rows[0].n) >= 3,
      `noSecret=${noSecret.status}, wrong=${wrong.status}/${arr(wrong.json).length}, ` +
      `ok=${okRows.length} rows [${kinds.join(",")}], cols=[${okCols}], ` +
      `rejections=${rej.rows[0].n}`);

    // ══ J7. duplicate collapse + per-contact cooldown over the wire ═════
    const dupe = `dupe-${SUFFIX}@mail.example`;
    const dupeSubject = `Duplicate collapse wire probe ${SUFFIX}`;
    await intakeCall(E, dupe, dupeSubject);
    const tokA = await latestToken(sql, dupe);
    const resend = await intakeCall(E, dupe, dupeSubject);
    const staged = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.governance_intake_staging s
         JOIN politicore.tenants t ON t.id = s.tenant_id
        WHERE t.slug = $1 AND s.status = 'pending'
          AND s.subject_hash = encode(sha256(convert_to(lower($2), 'UTF8')), 'hex')`,
      [E, dupeSubject]);
    const tokB = await latestToken(sql, dupe);
    const oldTry = await rest("POST", "/rest/v1/rpc/governance_verify",
      { p_token: tokA, p_tenant_slug: E });
    const cool = await intakeCall(E, dupe, `A different subject within cooldown ${SUFFIX}`);
    record("J7 identical pending filing resends (rotated token, one row); cooldown holds",
      resend.status === 200 && resend.json === true && staged.rows[0].n === "1" &&
      tokB !== tokA && oldTry.status >= 400 && cool.status === 200 && cool.json === false,
      `resend=${String(resend.json)}, staging=${staged.rows[0].n}, ` +
      `old-token=${oldTry.status}, cooldown-block=${String(cool.json)}`);

    // ══ J8. participant dedup across activations ════════════════════════
    // (CONTACT has two activations: borehole + cross-site probe.)
    const dedup = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.governance_participants WHERE email = $1`,
      [CONTACT]);
    record("J8 two activations share ONE external participant",
      dedup.rows[0].n === "1", `participants=${dedup.rows[0].n}`);

  } catch (e) {
    record("harness error", false, (e as Error).message);
  } finally {
    await cleanup(sql, tenantIds, emails);
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nGovernance public intake hosted acceptance: ${passed}/${results.length}`);
  if (passed !== results.length) process.exitCode = 1;
}

main();
