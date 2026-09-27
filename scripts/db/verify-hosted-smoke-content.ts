/**
 * POLITICORE — PUBLIC/CONTENT MODULES CUTOVER — HOSTED ACCEPTANCE (§28).
 *
 * Verifies the canonical content-domain contracts on the REAL hosted
 * project (real GoTrue sessions, real PostgREST, real RLS). Journeys:
 *
 *   A — Events            published-only public reads; admin lifecycle;
 *                         cross-tenant + anonymous writes denied
 *   B — Announcements     anonymous sessions receive nothing (published
 *                         rows included); authenticated same-tenant scope
 *                         reads; member management denied; NOT notifications
 *   C — News              published-only public reads; admin lifecycle
 *   D — Contact           anonymous submission accepted; reads admin-only
 *                         and tenant-scoped
 *   E — Single-row        biography published public / draft private
 *   F — Donations         private admin-only ledger: anon+member denied,
 *                         admin records, donors projection, canonical audit
 *   G — Static boundary   homepage canonical; no announcements publicly;
 *                         zero external Firebase imports
 *   H — Pristine cleanup  fixtures removed; FORCE-RLS restored
 *
 * Secrets are read from .env.local and never printed.
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
  method: string, url: string, body?: unknown, token?: string, prefer = ""
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { apikey: KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method === "POST") headers.Prefer = prefer || "return=representation";
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

async function cleanup(sql: pg.Client, tenantIds: string[], emails: string[]) {
  const CLEAN_TABLES = [
    "events", "announcements", "news_articles", "contact_messages", "biographies",
    "galleries", "manifestos", "donations", "donors", "notifications",
    "permission_grants", "system_audits", "tenants", "tenant_modules",
  ];
  try {
    const forceState = await sql.query<{ relname: string; forced: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore' AND c.relname = ANY($1)`, [CLEAN_TABLES]);
    const wasForced = forceState.rows.filter((r) => r.forced).map((r) => r.relname);
    for (const t of wasForced) {
      await sql.query(`ALTER TABLE politicore.${t} NO FORCE ROW LEVEL SECURITY`);
    }
    try {
      for (let pass = 0; pass < 4; pass++) {
        for (const t of CLEAN_TABLES.filter((x) => x !== "tenants")) {
          await sql.query(`DELETE FROM politicore.${t} WHERE tenant_id = ANY($1)`, [tenantIds]);
        }
        await sql.query(`DELETE FROM auth.users WHERE email = ANY($1)`, [emails]);
        await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        const left = await sql.query<{ n: string }>(
          `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
        if (left.rows[0].n === "0") break;
      }
    } finally {
      for (const t of wasForced) {
        await sql.query(`ALTER TABLE politicore.${t} FORCE ROW LEVEL SECURITY`);
      }
    }
    console.log(`cleanup: fixtures removed, FORCE-RLS state restored on ${wasForced.length} tables`);
  } catch (e) {
    console.error("cleanup incomplete — remove content-phase fixtures manually:", (e as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const tenantIds: string[] = [];
  const emails: string[] = [];
  const P = `ContCut!${SUFFIX}`;

  try {
    // ══ 0. hosted check ══════════════════════════════════════════════════
    const pre = await sql.query<{ hosted: boolean }>(
      `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`);
    if (!pre.rows[0].hosted) throw new Error("not the hosted project (auth schema missing)");

    // ══ Fixtures ═════════════════════════════════════════════════════════
    const E = `contc-${SUFFIX}`;
    const tenantA = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Content Cutover — main", E])).rows[0].id;
    tenantIds.push(tenantA);
    const tenantB = (await sql.query<{ id: string }>(
      `INSERT INTO politicore.tenants (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Content Cutover — isolation", `contc-iso-${SUFFIX}`])).rows[0].id;
    tenantIds.push(tenantB);

    const admEmail = `${E}-adm@test.local`;
    const memEmail = `${E}-mem@test.local`;
    const socEmail = `${E}-soc@test.local`;
    const isoEmail = `${E}-iso@test.local`;
    emails.push(admEmail, memEmail, socEmail, isoEmail);

    const admId = await createAuthUser(sql, admEmail, P, "Content Admin", E);
    const memId = await createAuthUser(sql, memEmail, P, "Content Member", E);
    const socId = await createAuthUser(sql, socEmail, P, "Content Social", E);
    const isoId = await createAuthUser(sql, isoEmail, P, "Content Iso", `contc-iso-${SUFFIX}`);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [admId]);
    await sql.query(`UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [isoId]);
    await sql.query(
      `UPDATE politicore.profiles SET membership_types = ARRAY['social_member']::politicore.membership_type_enum[] WHERE id = $1`,
      [socId]);

    await new Promise((r) => setTimeout(r, 1500));

    const admToken = await signin(admEmail, P);
    const memToken = await signin(memEmail, P);
    const socToken = await signin(socEmail, P);
    const isoToken = await signin(isoEmail, P);

    // ══ A. Events ════════════════════════════════════════════════════════
    const evDraft = await rest("POST", "/rest/v1/events", {
      tenant_id: tenantA, title: `Draft Event ${SUFFIX}`, description: "d",
      event_date: new Date().toISOString().slice(0, 10), venue: "V", status: "draft",
    }, admToken, "return=minimal");
    record("A1 admin creates a draft event",
      evDraft.status === 201, `HTTP ${evDraft.status}`);

    const evAnonDraft = await rest("GET",
      `/rest/v1/events?select=id&title=eq.Draft%20Event%20${SUFFIX}`);
    record("A2 anonymous draft read returns nothing (published-only public reads)",
      evAnonDraft.status === 200 && arr(evAnonDraft.json).length === 0,
      `HTTP ${evAnonDraft.status}, rows=${arr(evAnonDraft.json).length}`);

    const evPublish = await rest("PATCH",
      `/rest/v1/events?title=eq.Draft%20Event%20${SUFFIX}`,
      { status: "published" }, admToken, "return=minimal");
    const evAnonPub = await rest("GET",
      `/rest/v1/events?select=id,title&title=eq.Draft%20Event%20${SUFFIX}`);
    record("A3 admin publishes; anonymous visitors now read the event",
      evPublish.status === 204 && evAnonPub.status === 200 && arr(evAnonPub.json).length === 1,
      `publish=HTTP ${evPublish.status}, anon read=${arr(evAnonPub.json).length} row`);

    const evMemberWrite = await rest("POST", "/rest/v1/events", {
      tenant_id: tenantA, title: "member event", description: "d",
      event_date: new Date().toISOString().slice(0, 10), venue: "V",
    }, memToken, "return=minimal");
    record("A4 ordinary member event write denied (fail closed)",
      evMemberWrite.status >= 400, `HTTP ${evMemberWrite.status}`);

    const evCross = await rest("POST", "/rest/v1/events", {
      tenant_id: tenantA, title: "cross event", description: "d",
      event_date: new Date().toISOString().slice(0, 10), venue: "V",
    }, isoToken, "return=minimal");
    record("A5 cross-tenant admin event write denied (server-resolved tenant)",
      evCross.status >= 400, `HTTP ${evCross.status}`);

    const evAnonWrite = await rest("POST", "/rest/v1/events", {
      tenant_id: tenantA, title: "anon event", description: "d",
      event_date: new Date().toISOString().slice(0, 10), venue: "V",
    }, undefined, "return=minimal");
    record("A6 anonymous event write denied (no write grant)",
      evAnonWrite.status >= 400, `HTTP ${evAnonWrite.status}`);

    // ══ B. Announcements ═════════════════════════════════════════════════
    await rest("POST", "/rest/v1/announcements", {
      tenant_id: tenantA, title: `Pub Notice ${SUFFIX}`, content: "body",
      scope: "general", status: "published", published_at: new Date().toISOString(),
    }, admToken, "return=minimal");
    await rest("POST", "/rest/v1/announcements", {
      tenant_id: tenantA, title: `Camp Notice ${SUFFIX}`, content: "body",
      scope: "campaign_members", status: "published", published_at: new Date().toISOString(),
    }, admToken, "return=minimal");
    await rest("POST", "/rest/v1/announcements", {
      tenant_id: tenantA, title: `Draft Notice ${SUFFIX}`, content: "body",
      scope: "general", status: "draft",
    }, admToken, "return=minimal");

    const annAnon = await rest("GET", `/rest/v1/announcements?select=id`);
    record("B1 anonymous sessions receive NO announcements (published included)",
      annAnon.status === 200 && arr(annAnon.json).length === 0,
      `HTTP ${annAnon.status}, rows=${arr(annAnon.json).length}`);

    const annMember = await rest("GET",
      `/rest/v1/announcements?select=title&status=eq.published`, undefined, memToken);
    const annTitles = arr(annMember.json).map((r) => String(r.title));
    record("B2 same-tenant member reads published general; campaign-scope hidden; drafts hidden",
      annMember.status === 200 && annTitles.includes(`Pub Notice ${SUFFIX}`) &&
        !annTitles.includes(`Camp Notice ${SUFFIX}`) && !annTitles.includes(`Draft Notice ${SUFFIX}`),
      `visible=${annTitles.length}`);

    const annSocial = await rest("GET",
      `/rest/v1/announcements?select=title&status=eq.published`, undefined, socToken);
    record("B3 membership scope gates visibility (campaign-scope hidden from social-only)",
      arr(annSocial.json).every((r) => String(r.title) !== `Camp Notice ${SUFFIX}`) &&
        arr(annSocial.json).some((r) => String(r.title) === `Pub Notice ${SUFFIX}`),
      `social member sees ${arr(annSocial.json).length} published rows`);

    const annAdmin = await rest("GET",
      `/rest/v1/announcements?select=title&title=eq.Draft%20Notice%20${SUFFIX}`, undefined, admToken);
    record("B4 admins see drafts (management visibility)",
      arr(annAdmin.json).length === 1, `HTTP ${annAdmin.status}, rows=${arr(annAdmin.json).length}`);

    const annMemberWrite = await rest("POST", "/rest/v1/announcements", {
      tenant_id: tenantA, title: "member notice", content: "b",
    }, memToken, "return=minimal");
    record("B5 member announcement write denied (fail closed)",
      annMemberWrite.status >= 400, `HTTP ${annMemberWrite.status}`);

    const annCross = await rest("GET",
      `/rest/v1/announcements?select=id&tenant_id=eq.${tenantA}`, undefined, isoToken);
    record("B6 cross-tenant announcements invisible (tenant isolation)",
      annCross.status === 200 && arr(annCross.json).length === 0,
      `HTTP ${annCross.status}, rows=${arr(annCross.json).length}`);

    const annNotif = await rest("GET", "/rest/v1/notifications?select=id", undefined, memToken);
    const notifTitles = arr(annNotif.json);
    record("B7 announcements are not notifications (separate domains, separate data)",
      annNotif.status === 200 && notifTitles.length === 0,
      `notifications rows=${notifTitles.length}`);

    // ══ C. News ══════════════════════════════════════════════════════════
    await rest("POST", "/rest/v1/news_articles", {
      tenant_id: tenantA, title: `Live Story ${SUFFIX}`, slug: `live-${SUFFIX}`,
      status: "published", published_at: new Date().toISOString(),
    }, admToken, "return=minimal");
    await rest("POST", "/rest/v1/news_articles", {
      tenant_id: tenantA, title: `Hidden Story ${SUFFIX}`, slug: `hidden-${SUFFIX}`,
      status: "draft",
    }, admToken, "return=minimal");

    const newsAnon = await rest("GET", "/rest/v1/news_articles?select=title");
    const newsTitles = arr(newsAnon.json).map((r) => String(r.title));
    record("C1 anonymous reads published news only (drafts hidden)",
      newsAnon.status === 200 && newsTitles.includes(`Live Story ${SUFFIX}`) &&
        !newsTitles.includes(`Hidden Story ${SUFFIX}`),
      `visible=${newsTitles.length}`);

    const newsDraft = await rest("GET",
      `/rest/v1/news_articles?select=id&title=eq.Hidden%20Story%20${SUFFIX}`, undefined, memToken);
    // Same-tenant members share the tenant content surface (0002 directory
    // model): they may see their own tenant's drafts; the security boundary
    // is anonymous-published-only plus cross-tenant isolation.
    const newsDraftIso = await rest("GET",
      `/rest/v1/news_articles?select=id&title=eq.Hidden%20Story%20${SUFFIX}`, undefined, isoToken);
    record("C2 draft visibility is same-tenant only (member sees own, cross-tenant admin does not)",
      newsDraft.status === 200 && arr(newsDraft.json).length === 1 &&
        newsDraftIso.status === 200 && arr(newsDraftIso.json).length === 0,
      `same-tenant rows=${arr(newsDraft.json).length}, cross-tenant rows=${arr(newsDraftIso.json).length}`);

    // ══ D. Contact ═══════════════════════════════════════════════════════
    const contactPost = await rest("POST", "/rest/v1/contact_messages", {
      tenant_id: tenantA, name: "Hosted Visitor", email: `visitor-${SUFFIX}@example.com`,
      message: "Hello from the public contact form",
    }, undefined, "return=minimal");
    record("D1 anonymous visitor submits the public contact form",
      contactPost.status === 201, `HTTP ${contactPost.status}`);

    const contactAnonRead = await rest("GET", "/rest/v1/contact_messages?select=id");
    record("D2 anonymous cannot read any message",
      contactAnonRead.status === 200 ? arr(contactAnonRead.json).length === 0 : true,
      `HTTP ${contactAnonRead.status}, rows=${arr(contactAnonRead.json).length}`);

    const contactMemberRead = await rest("GET", "/rest/v1/contact_messages?select=id", undefined, memToken);
    record("D3 ordinary members cannot read messages",
      contactMemberRead.status === 200 && arr(contactMemberRead.json).length === 0,
      `HTTP ${contactMemberRead.status}, rows=${arr(contactMemberRead.json).length}`);

    const contactAdminRead = await rest("GET",
      `/rest/v1/contact_messages?select=id,email`, undefined, admToken);
    const contactEmails = arr(contactAdminRead.json).map((r) => String(r.email));
    record("D4 tenant admin reads own-tenant messages",
      contactAdminRead.status === 200 && contactEmails.includes(`visitor-${SUFFIX}@example.com`),
      `HTTP ${contactAdminRead.status}, rows=${contactEmails.length}`);

    const contactIsoRead = await rest("GET", "/rest/v1/contact_messages?select=id", undefined, isoToken);
    record("D5 cross-tenant admin reads no messages (tenant isolation)",
      contactIsoRead.status === 200 && arr(contactIsoRead.json).length === 0,
      `HTTP ${contactIsoRead.status}, rows=${arr(contactIsoRead.json).length}`);

    // ══ E. Single-row content (biography) ════════════════════════════════
    await rest("POST", "/rest/v1/biographies", {
      tenant_id: tenantA, full_name: "Content Candidate", about: "bio", status: "published",
    }, admToken, "return=minimal");

    const bioAnon = await rest("GET",
      `/rest/v1/biographies?select=full_name,status&full_name=eq.Content%20Candidate`);
    record("E1 published biography is publicly readable",
      bioAnon.status === 200 && arr(bioAnon.json).length === 1 &&
        arr(bioAnon.json)[0].status === "published",
      `HTTP ${bioAnon.status}, rows=${arr(bioAnon.json).length}`);

    const bioPatch = await rest("PATCH",
      `/rest/v1/biographies?tenant_id=eq.${tenantA}`, { status: "draft" }, admToken, "return=minimal");
    // biographies has no `id` column (tenant_id is the PK).
    const bioAnonDraft = await rest("GET",
      `/rest/v1/biographies?select=full_name&full_name=eq.Content%20Candidate`);
    record("E2 unpublished biography disappears from public reads",
      bioPatch.status === 204 && bioAnonDraft.status === 200 && arr(bioAnonDraft.json).length === 0,
      `patch=HTTP ${bioPatch.status}, anon HTTP ${bioAnonDraft.status}, anon rows=${arr(bioAnonDraft.json).length}`);
    await rest("PATCH", `/rest/v1/biographies?tenant_id=eq.${tenantA}`,
      { status: "published" }, admToken, "return=minimal");

    // ══ F. Donations (private admin ledger) ══════════════════════════════
    const donAnon = await rest("GET", "/rest/v1/donations?select=id");
    record("F1 anonymous donation read denied (no grant, no public path)",
      donAnon.status >= 400 || arr(donAnon.json).length === 0,
      `HTTP ${donAnon.status}`);

    const donMember = await rest("GET", "/rest/v1/donations?select=id", undefined, memToken);
    record("F2 ordinary member donation read denied",
      donMember.status === 200 && arr(donMember.json).length === 0,
      `HTTP ${donMember.status}, rows=${arr(donMember.json).length}`);

    const donMemberWrite = await rest("POST", "/rest/v1/donations", {
      tenant_id: tenantA, donor_name: "Ghost", amount: 100,
      date_received: new Date().toISOString().slice(0, 10),
    }, memToken, "return=minimal");
    record("F3 member donation write denied (fail closed)",
      donMemberWrite.status >= 400, `HTTP ${donMemberWrite.status}`);

    const donAdmin = await rest("POST", "/rest/v1/donations", {
      tenant_id: tenantA, donor_name: `Supporter ${SUFFIX}`, amount: 250000,
      date_received: new Date().toISOString().slice(0, 10),
      payment_method: "bank_transfer", created_by: admId, created_by_name: "Content Admin",
    }, admToken, "return=minimal");
    record("F4 tenant admin records a donation",
      donAdmin.status === 201, `HTTP ${donAdmin.status}`);

    const donors = await rest("GET",
      `/rest/v1/donors?select=full_name,total_received_amount&full_name=eq.Supporter%20${SUFFIX}`,
      undefined, admToken);
    record("F5 donors projection maintained server-side",
      donors.status === 200 && arr(donors.json).length === 1 &&
        Number(arr(donors.json)[0].total_received_amount) === 250000,
      `HTTP ${donors.status}, rows=${arr(donors.json).length}`);

    const donIso = await rest("GET",
      `/rest/v1/donations?select=id&tenant_id=eq.${tenantA}`, undefined, isoToken);
    record("F6 cross-tenant admin sees no ledger rows (tenant isolation)",
      donIso.status === 200 && arr(donIso.json).length === 0,
      `HTTP ${donIso.status}, rows=${arr(donIso.json).length}`);

    // ══ G. Static boundary ═══════════════════════════════════════════════
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const home = strip(fs.readFileSync(path.resolve("src/app/page.tsx"), "utf8"));
    record("G1 homepage sources events+news from canonical Supabase services",
      home.includes("listPublishedEvents") && home.includes("listPublishedNews"),
      "listPublishedEvents + listPublishedNews present");
    record("G2 announcements never reach the public homepage",
      !/announcements/i.test(home), "no announcement reference in src/app/page.tsx");

    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
      }
      return acc;
    };
    const offenders = walk(path.resolve("src")).filter((p) => {
      if (p.replace(/\\/g, "/").includes("src/lib/firebase/")) return false;
      return /from\s+["'](@\/lib\/firebase|firebase\/(app|auth|firestore|storage))["']/.test(
        strip(fs.readFileSync(p, "utf8")));
    });
    record("G3 zero external Firebase imports remain in the application",
      offenders.length === 0,
      offenders.length === 0 ? "src is Firebase-import-free" : offenders.slice(0, 3).join(", "));

    // ══ H. Pristine cleanup (in finally) ═════════════════════════════════
  } finally {
    await cleanup(sql, tenantIds, emails);

    const tLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.tenants WHERE id = ANY($1)`, [tenantIds]);
    const pLeft = await sql.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.profiles WHERE email = ANY($1)`, [emails]);
    const ok = tLeft.rows[0].n === "0" && pLeft.rows[0].n === "0";
    record("H1 pristine cleanup", ok, `tenants=${tLeft.rows[0].n} profiles=${pLeft.rows[0].n}`);

    await sql.end();

    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed`);
    // exitCode (not exit) — lets buffered pipe output flush before teardown.
    process.exitCode = pass === results.length ? 0 : 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
