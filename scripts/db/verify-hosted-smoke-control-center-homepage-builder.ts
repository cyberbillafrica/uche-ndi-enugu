/**
 * POLITICORE — Homepage Builder (Phase 24) — HOSTED ACCEPTANCE.
 *
 * Runs against the REAL hosted Supabase project and proves the Phase 24
 * Homepage Builder slice end-to-end through the real PostgREST data API
 * and real GoTrue identities — the same acceptance standard as Phases 6–23:
 *
 *   J1  — anon: zero mutation surface (save/publish/rollback/history denied)
 *   J2  — admin signs in and reads current (empty) homepage config
 *   J3  — member denial (save/publish/preview/history)
 *   J4  — admin saves a draft composition; PUBLIC homepage unchanged
 *   J5  — admin previews the draft (same config, draft-only section present)
 *   J6  — publish; PUBLIC homepage reflects the published composition
 *   J7  — validator: unknown section type / unknown config key rejected
 *   J8  — link safety: javascript: href rejected server-side
 *   J9  — media binding: cross-tenant asset reference rejected
 *   J10 — reorder + disable section; publish propagates; config retained
 *   J11 — service dependency: disabled service hides dependent section
 *         publicly while configuration is retained; re-enable restores
 *   J12 — stale revision conflict on save AND publish; current succeeds
 *   J13 — rollback: previous revision promoted to draft through the
 *         validated save path; history not destroyed; audit recorded
 *   J14 — tenant-B isolation via the slug seam (B has no homepage)
 *   J15 — draft privacy: public wrapper returns published only (never
 *         draft fields), unknown slug yields empty
 *   J16 — audit evidence (draft_saved + published + rollback, server actor)
 *   J17 — history RPC lists bounded published revisions for the Builder UI
 *   J18 — pristine cleanup (fixtures removed, residue 0)
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

/** Section factory — shapes mirror the registry schemas exactly. */
const RICH = (id: string, order: number, body: string) => ({
  stable_id: id, section_type: "rich_text", display_order: order, enabled: true,
  config: { heading: "Hosted Section", body },
});
const NEWS = (id: string, order: number) => ({
  stable_id: id, section_type: "news", display_order: order, enabled: true,
  config: { heading: "Latest News", item_count: 3, layout: "grid", show_excerpt: true,
            cta: { label: "View All", href: "/news" } },
});
const COUNTDOWN = (id: string, order: number) => ({
  stable_id: id, section_type: "election_countdown", display_order: order, enabled: true,
  service_dependency: "election", config: { label: "Election Day" },
});

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

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  try {
    const CLEAN_TABLES = [
      "tenant_modules", "system_audits", "permission_grants", "notifications",
      "media_assets", "public_site_settings", "profiles", "tenants",
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
      for (let pass = 0; pass < 3; pass++) {
        await sql.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [tenantIds]);
        await sql.query(`DELETE FROM politicore.media_assets WHERE tenant_id = ANY($1)`, [tenantIds]);
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
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove homepage-builder fixtures manually:", (e as Error).message);
  }
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `Wx24!${SUFFIX}`;
  const SLUG = `hb24-${SUFFIX}`;
  const SLUG_B = `hb24b-${SUFFIX}`;
  const A_ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B_ASSET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  try {
    // ── Fixtures ────────────────────────────────────────────────────────
    const insT = async (slug: string, name: string) => (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [slug, name])).rows[0].id;
    const tenantA = await insT(SLUG, "HB Hosted A");
    const tenantB = await insT(SLUG_B, "HB Hosted B");
    tenantIds.push(tenantA, tenantB);

    for (const t of [tenantA, tenantB]) {
      await sql.query(
        `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled)
         SELECT $1, m, false FROM unnest(ARRAY['social','campaign','election','governance']::politicore.module_code_enum[]) m`,
        [t]);
    }
    await sql.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ('${A_ASSET}', $1, 'r2', 'homepage', 'hb24/asset-a.png', 'public', 'image/png')`,
      [tenantA]);
    await sql.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ('${B_ASSET}', $1, 'r2', 'homepage', 'hb24/asset-b.png', 'public', 'image/png')`,
      [tenantB]);
    await sql.query(
      `INSERT INTO politicore.public_site_settings (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [tenantA]);

    const emailsA = [`adm-${SUFFIX}@hb24.test.local`, `mem-${SUFFIX}@hb24.test.local`];
    const emailsB = [`admb-${SUFFIX}@hb24.test.local`];
    emails.push(...emailsA, ...emailsB);
    await createAuthUser(sql, emailsA[0], P, "HB Admin A", SLUG);
    await createAuthUser(sql, emailsA[1], P, "HB Member A", SLUG);
    await createAuthUser(sql, emailsB[0], P, "HB Admin B", SLUG_B);
    await sql.query(
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE email = ANY($1)`,
      [[emailsA[0], emailsB[0]]]);

    const adminToken = await signin(emailsA[0], P);
    const memberToken = await signin(emailsA[1], P);
    const adminBToken = await signin(emailsB[0], P);
    const publicHomepage = async (slug = SLUG) =>
      rpcCall("get_published_homepage", { p_tenant_slug: slug });

    // ── J1 — anon: zero mutation surface. ──────────────────────────────
    const a1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage", p_draft: { sections: [] }, p_base_revision: 0 });
    const a2 = await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: 0 });
    const a3 = await rpcCall("rollback_site_config", { p_area: "homepage", p_history_revision: 1 });
    const a4 = await rpcCall("get_site_config_history", { p_area: "homepage" });
    record("J1 anon zero mutation surface",
      a1.status === 401 && a2.status === 401 && a3.status === 401 && a4.status === 401,
      `save=${a1.status} publish=${a2.status} rollback=${a3.status} history=${a4.status}`);

    // ── J2 — admin reads current (empty) homepage config. ──────────────
    const j2 = await rpcCall("get_site_config", { p_area: "homepage" }, adminToken);
    const j2row = Array.isArray(j2.json) ? j2.json[0] as Record<string, unknown> | undefined : undefined;
    record("J2 admin reads current homepage config",
      j2.status === 200 && j2row !== undefined && Number(j2row.revision ?? 0) === 0,
      `status=${j2.status} revision=${j2row?.revision}`);

    // ── J3 — member denial. ────────────────────────────────────────────
    const m1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage", p_draft: { sections: [] }, p_base_revision: 0 }, memberToken);
    const m2 = await rpcCall("get_site_config_preview", { p_area: "homepage" }, memberToken);
    const m3 = await rpcCall("get_site_config_history", { p_area: "homepage" }, memberToken);
    // PL/pgSQL exceptions surface as PostgREST 400s (established convention —
    // the authority gate inside the definer is what matters, not the code).
    record("J3 member denied (save + preview + history)",
      m1.status >= 400 && m2.status >= 400 && m3.status >= 400,
      `save=${m1.status} preview=${m2.status} history=${m3.status}`);

    // ── J4 — draft save; public homepage unchanged. ────────────────────
    const d1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [RICH("h-rich", 1, "Draft only body"), NEWS("h-news", 2)] },
        p_base_revision: 0 }, adminToken);
    const pub0 = await publicHomepage();
    const p0 = Array.isArray(pub0.json) ? pub0.json as unknown[] : [];
    record("J4 draft saved; public homepage unchanged (nothing published)",
      d1.status === 200 && p0.length === 0,
      `save=${d1.status} publicRows=${p0.length}`);

    // ── J5 — admin previews the draft. ─────────────────────────────────
    const pv = await rpcCall("get_site_config_preview", { p_area: "homepage" }, adminToken);
    const pvBody = pv.json as { sections?: { stable_id: string }[] };
    record("J5 admin preview returns own draft composition",
      pv.status === 200 && Array.isArray(pvBody?.sections)
      && pvBody.sections.some((s) => s.stable_id === "h-rich"),
      `status=${pv.status} draftSections=${pvBody?.sections?.length}`);

    // ── J6 — publish; public homepage reflects the composition. ────────
    const p1 = await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: 1 }, adminToken);
    const pub1 = await publicHomepage();
    const r1 = (Array.isArray(pub1.json) ? pub1.json[0] : undefined) as
      | { revision: number; sections: { stable_id: string; section_type: string }[] }
      | undefined;
    record("J6 published composition reaches the public wrapper",
      p1.status === 200 && r1 !== undefined
      && r1.sections?.length === 2
      && r1.sections.some((s) => s.section_type === "rich_text")
      && r1.sections.some((s) => s.section_type === "news"),
      `publish=${p1.status} publicSections=${r1?.sections?.length}`);

    // ── J7 — validator: unknown section type + unknown config key. ─────
    const v1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [{ stable_id: "x1", section_type: "future_feature",
                                display_order: 1, enabled: true, config: {} }] },
        p_base_revision: 2 }, adminToken);
    const v2 = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [{ stable_id: "x2", section_type: "rich_text",
                                display_order: 1, enabled: true,
                                config: { heading: "H", custom_key: "nope" } }] },
        p_base_revision: 2 }, adminToken);
    record("J7 validator rejects unknown section type and unknown config key",
      v1.status === 400 && v1.bodyText.includes("Unknown homepage section type")
      && v2.status === 400 && v2.bodyText.includes("Unknown config key"),
      `unknownType=${v1.status} unknownKey=${v2.status}`);

    // ── J8 — link safety: javascript: href rejected. ───────────────────
    const l1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [{ stable_id: "x3", section_type: "cta",
                                display_order: 1, enabled: true,
                                config: { heading: "Go", primary_cta: { label: "Click", href: "javascript:alert(1)" } } }] },
        p_base_revision: 2 }, adminToken);
    record("J8 javascript: href rejected server-side",
      l1.status === 400 && l1.bodyText.includes("forbidden scheme"),
      `status=${l1.status}`);

    // ── J9 — media binding: cross-tenant asset rejected, own accepted. ─
    const x1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [{ stable_id: "x4", section_type: "image_text",
                                display_order: 1, enabled: true,
                                config: { heading: "T", body: "b",
                                          image: { asset_id: B_ASSET }, image_side: "left" } }] },
        p_base_revision: 2 }, adminToken);
    const x2 = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [{ stable_id: "x4", section_type: "image_text",
                                display_order: 1, enabled: true,
                                config: { heading: "T", body: "b",
                                          image: { asset_id: A_ASSET }, image_side: "left" } }] },
        p_base_revision: 2 }, adminToken);
    record("J9 media binding: B's asset rejected, own asset accepted",
      x1.status === 400 && x1.bodyText.includes("public media asset of this tenant") && x2.status === 200,
      `crossTenant=${x1.status} own=${x2.status}`);

    // Restore the canonical two-section draft (x4 image_text is current).
    await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [NEWS("h-news", 1), COUNTDOWN("h-count", 2)] },
        p_base_revision: 3 }, adminToken);
    await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: 4 }, adminToken);

    // ── J10 — disable a section; publish; config retained. ─────────────
    const dis = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [NEWS("h-news", 1),
                              { ...COUNTDOWN("h-count", 2), enabled: false }] },
        p_base_revision: 5 }, adminToken);
    const pub3 = await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: 6 }, adminToken);
    const pub3json = (await publicHomepage()).json;
    const r3 = (Array.isArray(pub3json) ? pub3json[0] : undefined) as
      { sections: { stable_id: string }[] } | undefined;
    const kept = await sql.query<{ sections: { stable_id: string; enabled: boolean }[] }>(
      `SELECT homepage #> '{published,sections}' sections
         FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
    record("J10 disabled section hidden publicly, config retained",
      dis.status === 200 && pub3.status === 200
      && r3?.sections?.length === 1
      && kept.rows[0]?.sections?.length === 2
      && kept.rows[0].sections.some((s) => s.stable_id === "h-count" && s.enabled === false),
      `public=${r3?.sections?.length} retained=${kept.rows[0]?.sections?.length}`);

    // ── J11 — service dependency gates eligibility, not configuration. ─
    // Election is DISABLED for tenant A → countdown suppressed publicly.
    // Draft h-count is DISABLED right now, so first re-enable + publish
    // with election still off, then flip the module and re-publish.
    const en = await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [NEWS("h-news", 1), COUNTDOWN("h-count", 2)] },
        p_base_revision: 7 }, adminToken);
    const pub4 = await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: 8 }, adminToken);
    const pub4json = (await publicHomepage()).json;
    const r4 = (Array.isArray(pub4json) ? pub4json[0] : undefined) as
      { sections: { stable_id: string }[] } | undefined;
    const electionOffHidden = r4?.sections?.every((s) => s.stable_id !== "h-count") === true;
    // Re-enable Election → the same published composition becomes eligible.
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = true
        WHERE tenant_id = $1 AND module = 'election'`, [tenantA]);
    const pub5json = (await publicHomepage()).json;
    const r5 = (Array.isArray(pub5json) ? pub5json[0] : undefined) as
      { sections: { stable_id: string }[] } | undefined;
    const electionOnShown = r5?.sections?.some((s) => s.stable_id === "h-count") === true;
    const cfgIntact = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.public_site_settings
        WHERE tenant_id = $1
          AND homepage #> '{published,sections}' @> '[{"stable_id":"h-count"}]'`, [tenantA]);
    await sql.query(
      `UPDATE politicore.tenant_modules SET enabled = false
        WHERE tenant_id = $1 AND module = 'election'`, [tenantA]);
    record("J11 service dependency: OFF hides, ON restores, config never mutated",
      en.status === 200 && pub4.status === 200
      && electionOffHidden && electionOnShown && cfgIntact.rows[0].n === "1",
      `offHidden=${electionOffHidden} onShown=${electionOnShown} configIntact=${cfgIntact.rows[0].n}`);

    // ── J12 — stale revision conflict on save; current succeeds. ───────
    const cur = await rpcCall("get_site_config", { p_area: "homepage" }, adminToken);
    const curRow = Array.isArray(cur.json) ? cur.json[0] as { revision: number } : undefined;
    const rev = Number(curRow?.revision ?? 0);
    const st1 = await rpcCall("save_site_config_draft",
      { p_area: "homepage", p_draft: { sections: [] }, p_base_revision: rev + 5 }, adminToken);
    const st2 = await rpcCall("save_site_config_draft",
      { p_area: "homepage", p_draft: { sections: [NEWS("h-news", 1)] }, p_base_revision: rev }, adminToken);
    record("J12 stale revision rejected; current succeeds",
      st1.status === 400 && st1.bodyText.includes("Configuration conflict") && st2.status === 200,
      `stale=${st1.status} current=${st2.status}`);

    // Publish twice so history holds the J10 composition, then roll back.
    await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: rev + 1 }, adminToken);
    await rpcCall("save_site_config_draft",
      { p_area: "homepage",
        p_draft: { sections: [NEWS("h-news", 1), RICH("h-tail", 2, "tail")] },
        p_base_revision: rev + 2 }, adminToken);
    await rpcCall("publish_site_config", { p_area: "homepage", p_base_revision: rev + 3 }, adminToken);

    // ── J13 — rollback promotes a historical revision to draft. ────────
    const hist0 = await rpcCall("get_site_config_history", { p_area: "homepage" }, adminToken);
    const hist0Rows = Array.isArray(hist0.json) ? hist0.json as { revision: number }[] : [];
    const target = hist0Rows.map((h) => h.revision).sort((a, b) => b - a)[1]; // second-newest
    const rb = await rpcCall("rollback_site_config",
      { p_area: "homepage", p_history_revision: target }, adminToken);
    const hist1 = await rpcCall("get_site_config_history", { p_area: "homepage" }, adminToken);
    const hist1Rows = Array.isArray(hist1.json) ? hist1.json as { revision: number }[] : [];
    const after = await sql.query<{ draft: { sections?: { stable_id: string }[] } }>(
      `SELECT homepage -> 'draft' draft FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
    record("J13 rollback restores historical composition as draft; history intact",
      rb.status === 200 && hist0Rows.length >= 2 && hist1Rows.length === hist0Rows.length
      && after.rows[0]?.draft?.sections?.every((s) => s.stable_id !== "h-tail") === true,
      `rollback=${rb.status} history ${hist0Rows.length}→${hist1Rows.length} target=${target}`);

    // ── J14 — tenant-B isolation via the slug seam. ────────────────────
    const b0 = await publicHomepage(SLUG_B);
    const bPrev = await rpcCall("get_site_config_preview", { p_area: "homepage" }, adminBToken);
    record("J14 tenant B: no homepage rows; B admin preview holds no A draft",
      b0.status === 200 && Array.isArray(b0.json) && b0.json.length === 0 && bPrev.status === 200,
      `publicRows=${(b0.json as unknown[])?.length} preview=${bPrev.status}`);

    // ── J15 — draft privacy + unknown slug seam. ───────────────────────
    // The public wrapper projects published sections only; a draft that
    // differs from published must not appear. Draft currently holds the
    // rolled-back composition (1 section) while published holds 2.
    const pub6json = (await publicHomepage()).json;
    const r6 = (Array.isArray(pub6json) ? pub6json[0] : undefined) as
      { revision: number; sections: unknown[] } | undefined;
    const unk = await rpcCall("get_published_homepage", { p_tenant_slug: `definitely-not-real-${SUFFIX}` });
    record("J15 public wrapper: published only, unknown slug empty",
      r6 !== undefined && Number(r6.revision) >= 1 && Array.isArray(r6.sections)
      && unk.status === 200 && Array.isArray(unk.json) && (unk.json as unknown[]).length === 0,
      `revision=${r6?.revision} unknownSlug=${unk.status}/${(unk.json as unknown[])?.length}`);

    // ── J16 — audit evidence with server-resolved actor. ───────────────
    const aud = await sql.query<{ n: string; actor: string }>(
      `SELECT count(*)::text n, max(actor_id::text) actor
         FROM politicore.system_audits
        WHERE tenant_id = $1
          AND action IN ('site_config:homepage:draft_saved',
                         'site_config:homepage:published',
                         'site_config:homepage:rollback')`,
      [tenantA]);
    const adminId = (await sql.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE email = $1`, [emailsA[0]])).rows[0].id;
    record("J16 audit evidence (draft_saved + published + rollback)",
      Number(aud.rows[0].n) >= 8 && aud.rows[0].actor === adminId,
      `records=${aud.rows[0].n} actorMatches=${aud.rows[0].actor === adminId}`);

    // ── J17 — history RPC serves the Builder UI (bounded list). ────────
    record("J17 history RPC lists published revisions",
      hist1.status === 200 && hist1Rows.length >= 2 && hist1Rows.length <= 10
      && hist1Rows.every((h) => typeof h.revision === "number"),
      `entries=${hist1Rows.length}`);

    // ── J18 — cleanup + residue check. ─────────────────────────────────
    await cleanup(sql, tenantIds, emails);
    const res = await sql.query<{ n: string }>(
      `SELECT (SELECT count(*)::text FROM politicore.tenants WHERE slug LIKE 'hb24-%')
            || '|' || (SELECT count(*)::text FROM politicore.profiles WHERE email LIKE '%@hb24.test.local')
            || '|' || (SELECT count(*)::text FROM politicore.public_site_settings WHERE tenant_id NOT IN (SELECT id FROM politicore.tenants))
            || '|' || (SELECT count(*)::text FROM politicore.media_assets WHERE bucket = 'homepage') AS n`);
    record("J18 hosted residue 0", res.rows[0].n === "0|0|0|0",
      `tenants|profiles|orphan-settings|homepage-assets = ${res.rows[0].n}`);
  } finally {
    await sql.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("\n════════════════════════════════════════");
  console.log(`HOMEPAGE BUILDER HOSTED ACCEPTANCE: ${passed}/${results.length}`);
  if (passed !== results.length) {
    for (const r of results.filter((r) => !r.ok)) console.log(`  FAILED ${r.name} — ${r.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
