/**
 * POLITICORE — Site Chrome: Header / Footer / Navigation (Phase 25) —
 * HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 25
 * chrome slice end-to-end through the real PostgREST data API and real
 * GoTrue identities — the same acceptance standard as Phases 6–24:
 *
 *   J1  — clean tenant provisioning (A + B, all modules OFF)
 *   J2  — admin configuration access (navigation + footer areas)
 *   J3  — member denial (save/publish/preview/history)
 *   J4  — anonymous denial (save/publish/rollback/history/preview)
 *   J5  — draft save (navigation + footer), revision advances
 *   J6  — public chrome unchanged before publish
 *   J7  — publish propagation (navigation + footer)
 *   J8  — navigation rendering: published items in public chrome;
 *         governance-dependent item suppressed while module OFF
 *   J9  — footer rendering: published columns in public chrome
 *   J10 — header rendering: published presentation + CTA in public chrome
 *   J11 — service dependency OFF → item hidden, stored config retained
 *   J12 — service dependency ON → same stored item becomes eligible
 *   J13 — stale revision conflict on save AND publish; current succeeds
 *   J14 — rollback promotes history to draft (validated path, audit)
 *   J15 — history retention: bounded, entries intact across rollback
 *   J16 — tenant isolation: B admin sees only B; slug seam separates
 *   J17 — public slug isolation: chrome(A) lacks B's marker; unknown slug
 *         yields empty chrome
 *   J18 — draft/history privacy: public chrome exposes no draft/history/
 *         revision/publisher internals
 *   J19 — audit evidence (draft_saved + published + rollback, server actor)
 *   J20 — pristine cleanup (fixtures removed, residue 0)
 *   J21 — FORCE RLS restored after cleanup
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
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
}

async function rpcCall(
  name: string, body: unknown, token?: string
): Promise<{ status: number; json: unknown; bodyText: string }> {
  const r = await rest("POST", `/rest/v1/rpc/${name}`, body, token);
  if (r.status >= 400) {
    console.log(`    [${name} → ${r.status}] ${r.text.slice(0, 200)}`);
  }
  return { status: r.status, json: r.json, bodyText: r.text };
}

/** Shapes mirror migration 0063's validators exactly (no `rel` on items —
 *  external links carry rel="noopener noreferrer" in the renderer). */
const NAV_FULL = {
  items: [
    { id: "home", label: "Home", href: "/", type: "internal" },
    { id: "gov", label: "Governance", href: "/governance", type: "internal", service_dependency: "governance" },
    { id: "portal", label: "Member Portal", href: "/portal", type: "internal", visibility: "authenticated" },
    { id: "ext", label: "INEC", href: "https://www.inecnigeria.org", type: "external" },
  ],
  header: {
    show_logo: true, show_site_name: true, show_primary_nav: true,
    cta: { enabled: true, label: "Join us", href: "/register" },
    mobile_menu: "accordion", alignment: "left",
  },
};
const FOOTER_FULL = {
  columns: [
    { id: "explore", heading: "Explore", links: [{ label: "News", href: "/news" }, { label: "Events", href: "/events" }] },
    { id: "party", heading: "Party", links: [{ label: "Manifesto", href: "/manifesto" }] },
  ],
  legal: { copyright: "© 2026 HB Hosted A", links: [{ label: "Privacy", href: "/privacy" }] },
  social: { show: true },
  presentation: { layout: "columns-3", show_contact: true, show_cta: false },
};

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

const CLEAN_TABLES = [
  "tenant_modules", "system_audits", "permission_grants", "notifications",
  "media_assets", "public_site_settings", "profiles", "tenants",
];

async function cleanup(
  sql: pg.Client, tenantIds: string[], emails: string[]
): Promise<string[]> {
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
    for (let pass = 0; pass < 3; pass++) {
      await sql.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
      await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
      await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
      await sql.query(`DELETE FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
      await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
      await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
    }
  } finally {
    await sql.query("SET session_replication_role = DEFAULT");
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
    }
  }
  return wasForced;
}

/** Unwrap the chrome projection regardless of PostgREST's scalar shape. */
function chromeOf(json: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(json)) {
    const row = json[0] as Record<string, unknown> | undefined;
    return (row?.get_public_site_chrome ?? row) as Record<string, unknown> | undefined;
  }
  return json as Record<string, unknown> | undefined;
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Wx25!${SUFFIX}`;
  const SLUG = `sc25-${SUFFIX}`;
  const SLUG_B = `sc25b-${SUFFIX}`;

  try {
    // ── J1 — clean tenant provisioning. ────────────────────────────────
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG, "SC Hosted A");
    const tenantB = await insT(SLUG_B, "SC Hosted B");
    tenantIds.push(tenantA, tenantB);
    for (const t of [tenantA, tenantB]) {
      await sql.query(
        `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
         SELECT $1, m, false FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) m`,
        [t]);
    }
    const pre = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
    record("J1 clean tenant provisioning (A + B, modules OFF, no settings rows)",
      tenantA !== tenantB && pre.rows[0].n === "0",
      `settingsRows=${pre.rows[0].n}`);

    const emailsA = [`adm-${SUFFIX}@sc25.test.local`, `mem-${SUFFIX}@sc25.test.local`];
    const emailsB = [`admb-${SUFFIX}@sc25.test.local`];
    emails.push(...emailsA, ...emailsB);
    await createAuthUser(sql, emailsA[0], P, "SC Admin A", SLUG);
    await createAuthUser(sql, emailsA[1], P, "SC Member A", SLUG);
    await createAuthUser(sql, emailsB[0], P, "SC Admin B", SLUG_B);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE email = ANY($1)`,
      [[emailsA[0], emailsB[0]]]);

    const adminToken = await signin(emailsA[0], P);
    const memberToken = await signin(emailsA[1], P);
    const adminBToken = await signin(emailsB[0], P);
    // Configuration rows are provisioned with the tenant (the established
    // hosted-fixture convention, Phase 24): the editor reads revision 0.
    await sql.query(
      `INSERT INTO politicore.public_site_settings (tenant_id) VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
      [tenantA, tenantB]);

    /** Hosted revision of an area for tenant A (service connection). */
    const rev = async (area: string): Promise<number> => {
      const r = await sql.query<{ n: string }>(
        `SELECT COALESCE((${area}->>'revision')::text,'0') n
           FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      return Number(r.rows[0]?.n ?? "0");
    };
    const anonChrome = async (slug: string) => {
      const r = await rpcCall("get_public_site_chrome", { p_tenant_slug: slug });
      return { status: r.status, chrome: chromeOf(r.json) };
    };
    const navLabels = (chrome: Record<string, unknown> | undefined): string[] =>
      (((chrome?.navigation as { items?: { label: string }[] })?.items) ?? []).map((i) => i.label);

    // ── J2 — admin configuration access. ───────────────────────────────
    const j2n = await rpcCall("get_site_config", { p_area: "navigation" }, adminToken);
    const j2f = await rpcCall("get_site_config", { p_area: "footer" }, adminToken);
    // Production unwrap (controlCenter.getSiteConfig): SETOF → array of rows;
    // scalar-JSON PostgREST responses arrive unwrapped on hosted.
    const j2row = (Array.isArray(j2n.json) ? j2n.json[0] : j2n.json) as Record<string, unknown> | undefined;
    record("J2 admin configuration access (navigation + footer)",
      j2n.status === 200 && j2f.status === 200 && j2row !== undefined,
      `nav=${j2n.status} footer=${j2f.status} revision=${j2row?.revision}`);

    // ── J3 — member denial. ────────────────────────────────────────────
    const m1 = await rpcCall("save_site_config_draft",
      { p_area: "navigation", p_draft: { items: [] }, p_base_revision: 0 }, memberToken);
    const m2 = await rpcCall("publish_site_config", { p_area: "footer", p_base_revision: 0 }, memberToken);
    const m3 = await rpcCall("get_site_config_preview", { p_area: "navigation" }, memberToken);
    const m4 = await rpcCall("get_site_config_history", { p_area: "footer" }, memberToken);
    record("J3 member denied (save + publish + preview + history)",
      m1.status >= 400 && m2.status >= 400 && m3.status >= 400 && m4.status >= 400,
      `save=${m1.status} publish=${m2.status} preview=${m3.status} history=${m4.status}`);

    // ── J4 — anonymous denial. ─────────────────────────────────────────
    const a1 = await rpcCall("save_site_config_draft",
      { p_area: "navigation", p_draft: { items: [] }, p_base_revision: 0 });
    const a2 = await rpcCall("publish_site_config", { p_area: "footer", p_base_revision: 0 });
    const a3 = await rpcCall("rollback_site_config", { p_area: "navigation", p_history_revision: 1 });
    const a4 = await rpcCall("get_site_config_history", { p_area: "navigation" });
    const a5 = await rpcCall("get_site_config_preview", { p_area: "footer" });
    record("J4 anonymous denied (save + publish + rollback + history + preview)",
      a1.status === 401 && a2.status === 401 && a3.status === 401 && a4.status === 401 && a5.status === 401,
      `save=${a1.status} publish=${a2.status} rollback=${a3.status} history=${a4.status} preview=${a5.status}`);

    // ── J5 — draft save. ───────────────────────────────────────────────
    const d1 = await rpcCall("save_site_config_draft",
      { p_area: "navigation", p_draft: NAV_FULL, p_base_revision: await rev("navigation") }, adminToken);
    const d2 = await rpcCall("save_site_config_draft",
      { p_area: "footer", p_draft: FOOTER_FULL, p_base_revision: await rev("footer") }, adminToken);
    record("J5 draft saved (navigation + footer), revisions advance",
      d1.status === 200 && d2.status === 200 && (await rev("navigation")) === 1 && (await rev("footer")) === 1,
      `nav=${d1.status} footer=${d2.status} revisions=${await rev("navigation")}/${await rev("footer")}`);

    // ── J6 — public chrome unchanged before publish. ───────────────────
    const c0 = await anonChrome(SLUG);
    record("J6 public chrome unchanged before publish (empty items/columns)",
      c0.status === 200 && navLabels(c0.chrome).length === 0
      && (((c0.chrome?.footer as { columns?: unknown[] })?.columns) ?? []).length === 0,
      `items=${navLabels(c0.chrome).length}`);

    // ── J7 — publish propagation. ──────────────────────────────────────
    const p1 = await rpcCall("publish_site_config", { p_area: "navigation", p_base_revision: 1 }, adminToken);
    const p2 = await rpcCall("publish_site_config", { p_area: "footer", p_base_revision: 1 }, adminToken);
    const c1 = await anonChrome(SLUG);
    record("J7 publish propagates to the public chrome",
      p1.status === 200 && p2.status === 200 && c1.status === 200
      && navLabels(c1.chrome).length > 0
      && (((c1.chrome?.footer as { columns?: unknown[] })?.columns) ?? []).length === 2,
      `nav=${p1.status} footer=${p2.status} items=${navLabels(c1.chrome).length}`);

    // ── J8 — navigation rendering; governance item hidden (module OFF). ─
    const c8 = await anonChrome(SLUG);
    const labels8 = navLabels(c8.chrome);
    const stored8 = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.public_site_settings
        WHERE tenant_id = $1 AND navigation #> '{published,items}' @> '[{"id":"gov"}]'`, [tenantA]);
    record("J8 navigation renders publicly; governance-dependent item suppressed, stored intact",
      labels8.includes("Home") && labels8.includes("INEC") && !labels8.includes("Governance")
      && stored8.rows[0].n === "1",
      `public=[${labels8.join(",")}] storedGov=${stored8.rows[0].n}`);

    // ── J9 — footer rendering. ─────────────────────────────────────────
    const c9 = await anonChrome(SLUG);
    const cols9 = ((c9.chrome?.footer as { columns?: { heading: string }[] })?.columns) ?? [];
    record("J9 footer renders published columns",
      cols9.map((c) => c.heading).join(",") === "Explore,Party",
      `columns=[${cols9.map((c) => c.heading).join(",")}]`);

    // ── J10 — header rendering (presentation + CTA). ───────────────────
    const hdr10 = c9.chrome?.navigation as { header?: Record<string, unknown> };
    record("J10 header presentation + CTA render in the public chrome",
      hdr10?.header?.show_logo === true && hdr10?.header?.mobile_menu === "accordion"
      && (hdr10?.header?.cta as { label?: string })?.label === "Join us",
      `header=${JSON.stringify(hdr10?.header ?? {})}`);

    // ── J11 — service dependency OFF → hidden, config retained. ────────
    // (Already proven hidden in J8 while OFF; assert stored config intact.)
    record("J11 dependency OFF: item hidden publicly, stored config NOT mutated",
      !navLabels(c8.chrome).includes("Governance") && stored8.rows[0].n === "1",
      `hidden=${!navLabels(c8.chrome).includes("Governance")}`);

    // ── J12 — service dependency ON → the SAME stored item becomes eligible.
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true
        WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
    const c12 = await anonChrome(SLUG);
    const govShown = navLabels(c12.chrome).includes("Governance");
    const cfgIntact = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.public_site_settings
        WHERE tenant_id = $1 AND navigation #> '{published,items}' @> '[{"id":"gov"}]'`, [tenantA]);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false
        WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
    const c12b = await anonChrome(SLUG);
    record("J12 dependency ON restores eligibility from stored config; OFF re-hides",
      govShown && cfgIntact.rows[0].n === "1" && !navLabels(c12b.chrome).includes("Governance"),
      `onShown=${govShown} configIntact=${cfgIntact.rows[0].n === "1"}`);

    // ── J13 — stale revision conflict; current succeeds. ───────────────
    const cur = await rev("navigation");
    const st1 = await rpcCall("save_site_config_draft",
      { p_area: "navigation", p_draft: { items: [] }, p_base_revision: cur + 5 }, adminToken);
    const st2 = await rpcCall("save_site_config_draft",
      { p_area: "navigation", p_draft: NAV_FULL, p_base_revision: cur }, adminToken);
    const sp1 = await rpcCall("publish_site_config", { p_area: "navigation", p_base_revision: cur + 5 }, adminToken);
    const sp2 = await rpcCall("publish_site_config", { p_area: "navigation", p_base_revision: cur + 1 }, adminToken);
    record("J13 stale revision rejected on save AND publish; current succeeds",
      st1.status === 400 && st1.bodyText.includes("Configuration conflict")
      && st2.status === 200 && sp1.status === 400 && sp2.status === 200,
      `saveStale=${st1.status} saveCurrent=${st2.status} publishStale=${sp1.status} publishCurrent=${sp2.status}`);

    // ── J14 — rollback promotes history to draft (validated path). ─────
    const rbHist = await rpcCall("get_site_config_history", { p_area: "navigation" }, adminToken);
    const rbRows = (Array.isArray(rbHist.json) ? rbHist.json : []) as { revision: number }[];
    const rbTarget = rbRows.map((h) => h.revision).sort((a, b) => b - a)[0];
    const rb = await rpcCall("rollback_site_config",
      { p_area: "navigation", p_history_revision: rbTarget }, adminToken);
    const rbDraft = await sql.query<{ items: { id: string }[] }>(
      `SELECT navigation #> '{draft,items}' items FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
    const rbPublic = await anonChrome(SLUG);
    record("J14 rollback restores a historical revision as draft (public unchanged)",
      rb.status === 200 && (rbDraft.rows[0]?.items ?? []).length > 0
      && navLabels(rbPublic.chrome).length > 0,
      `rollback=${rb.status} target=${rbTarget}`);

    // ── J15 — history retention. ───────────────────────────────────────
    const hist = await rpcCall("get_site_config_history", { p_area: "navigation" }, adminToken);
    const histRows = (Array.isArray(hist.json) ? hist.json : []) as { revision: number }[];
    record("J15 history retained and bounded",
      hist.status === 200 && histRows.length >= 2 && histRows.length <= 10
      && histRows.every((h) => typeof h.revision === "number"),
      `entries=${histRows.length}`);

    // ── J16 — tenant isolation. ────────────────────────────────────────
    const bNav = { items: [{ id: "b-home", label: "B-ONLY-MARKER", href: "/" }] };
    await rpcCall("save_site_config_draft",
      { p_area: "navigation", p_draft: bNav, p_base_revision: 0 }, adminBToken);
    const bPub = await rpcCall("publish_site_config", { p_area: "navigation", p_base_revision: 1 }, adminBToken);
    const bPrev = await rpcCall("get_site_config_preview", { p_area: "navigation" }, adminBToken);
    const aPrev = await rpcCall("get_site_config_preview", { p_area: "navigation" }, adminToken);
    record("J16 tenant isolation: B publishes own chrome; previews never cross tenants",
      bPub.status === 200 && bPrev.status === 200 && aPrev.status === 200
      && JSON.stringify(bPrev.json).includes("B-ONLY-MARKER")
      && !JSON.stringify(aPrev.json).includes("B-ONLY-MARKER"),
      `bPublish=${bPub.status} crossLeak=${JSON.stringify(aPrev.json).includes("B-ONLY-MARKER")}`);

    // ── J17 — public slug isolation. ───────────────────────────────────
    const cA = await anonChrome(SLUG);
    const cB = await anonChrome(SLUG_B);
    const cU = await anonChrome(`definitely-not-real-${SUFFIX}`);
    record("J17 public slug isolation: chrome(A) lacks B's marker; unknown slug empty",
      JSON.stringify(cA.chrome?.navigation).indexOf("B-ONLY-MARKER") === -1
      && navLabels(cB.chrome).includes("B-ONLY-MARKER")
      && !navLabels(cB.chrome).includes("Home")
      && navLabels(cU.chrome).length === 0
      && (((cU.chrome?.footer as { columns?: unknown[] })?.columns) ?? []).length === 0,
      `crossLeak=${JSON.stringify(cA.chrome?.navigation).includes("B-ONLY-MARKER")} unknownItems=${navLabels(cU.chrome).length}`);

    // ── J18 — draft/history privacy in the public chrome. ──────────────
    const c18 = await anonChrome(SLUG);
    const nav18 = c18.chrome?.navigation as Record<string, unknown> | undefined;
    const foot18 = c18.chrome?.footer as Record<string, unknown> | undefined;
    const leakKeys = (o: Record<string, unknown> | undefined) =>
      o ? ["draft", "history", "revision", "published_at", "published_by"].filter((k) => k in o) : [];
    record("J18 public chrome exposes no draft/history/revision/publisher internals",
      leakKeys(nav18).length === 0 && leakKeys(foot18).length === 0,
      `navLeaks=[${leakKeys(nav18)}] footerLeaks=[${leakKeys(foot18)}]`);

    // ── J19 — audit evidence with server-resolved actor. ───────────────
    const aud = await sql.query<{ n: string; actor: string }>(
      `SELECT count(*)::text n, max(actor_id::text) actor
         FROM politicore.system_audits
        WHERE tenant_id = $1
          AND action IN ('site_config:navigation:draft_saved',
                         'site_config:navigation:published',
                         'site_config:navigation:rollback',
                         'site_config:footer:draft_saved',
                         'site_config:footer:published')`,
      [tenantA]);
    const adminId = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE email = $1`, [emailsA[0]])).rows[0].id;
    record("J19 audit evidence (draft_saved + published + rollback, server actor)",
      Number(aud.rows[0].n) >= 6 && aud.rows[0].actor === adminId,
      `records=${aud.rows[0].n} actorMatches=${aud.rows[0].actor === adminId}`);

    // ── J20 — pristine cleanup. ────────────────────────────────────────
    const wasForced = await cleanup(sql, tenantIds, emails);
    const res = await sql.query<{ n: string }>(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'sc25-%')
            || '|' || (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@sc25.test.local')
            || '|' || (SELECT count(*)::text FROM politicore.system_audits WHERE tenant_id = ANY($1))
            || '|' || (SELECT count(*)::text FROM politicore.public_site_settings WHERE tenant_id = ANY($1)) AS n`,
      [tenantIds]);
    record("J20 hosted residue 0",
      res.rows[0].n === "0|0|0|0",
      `tenants|profiles|audits|settings = ${res.rows[0].n}`);

    // ── J21 — FORCE RLS restored. ──────────────────────────────────────
    const postForce = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [wasForced]);
    const unforced = postForce.rows.filter((r) => !r.forced).map((r) => r.relname);
    record("J21 FORCE RLS restored after cleanup",
      wasForced.length > 0 && unforced.length === 0,
      `restored=${postForce.rows.length - unforced.length}/${wasForced.length} unforced=[${unforced.join(",")}]`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`SITE CHROME HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
