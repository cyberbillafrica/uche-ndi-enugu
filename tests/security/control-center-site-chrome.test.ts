/**
 * POLITICORE — PHASE 25 — SITE CHROME (HEADER / FOOTER / NAVIGATION)
 * SECURITY SUITE.
 *
 * Proves the chrome slice (migration 0063) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–24
 * (§31 coverage):
 *
 *   A.  Authority          — anon holds nothing (no EXECUTE, no base-table
 *                            grants); member cannot mutate; only the tenant
 *                            admin can; tenant B cannot touch tenant A.
 *   B.  Validation         — known fields only, known item types, bounded
 *                            arrays/nesting/lengths, unique ids + labels,
 *                            valid visibility/dependency/presentation
 *                            vocabularies, malformed structures rejected.
 *   C.  Safe destinations  — javascript:/data:/vbscript: rejected; unsafe
 *                            schemes rejected; internal/https/anchor OK.
 *   D.  Lifecycle          — draft → publish → public chrome; module
 *                            dependency OFF hides (config unmutated), ON
 *                            restores; visibility is presentation.
 *   E.  Draft privacy      — draft never public; stale revision rejected;
 *                            a draft save after publish NEVER blanks
 *                            published state or history (Phase 24 lesson).
 *   F.  Rollback/history   — rollback through the validated save path,
 *                            history never mutated by rollback, bounded to
 *                            10, Core Audit evidence with server actor.
 *   G.  Tenant isolation   — public slug A never returns tenant B chrome.
 *   H.  Architecture       — exactly one public Header renderer, one
 *                            Footer renderer, one production navigation
 *                            path; no new tables/roles/permissions; no
 *                            route generation from DB values; no direct
 *                            Cloudinary/R2 usage.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { getDb, as, createTenant, createUser } from "./helpers";

/** A complete, valid navigation configuration (§12 shape). */
const NAV_FULL = {
  items: [
    { id: "home", label: "Home", href: "/", type: "internal" },
    { id: "news", label: "News", href: "/news", type: "internal" },
    { id: "gov", label: "Governance", href: "/governance", type: "internal", service_dependency: "governance" },
    { id: "portal", label: "Member Portal", href: "/portal", type: "internal", visibility: "authenticated" },
    { id: "ext", label: "INEC", href: "https://www.inecnigeria.org", type: "external" },
    {
      id: "about", label: "About", href: "#about", type: "anchor",
      children: [{ id: "about-bio", label: "Biography", href: "/biography", type: "internal" }],
    },
  ],
  header: {
    show_logo: true, show_site_name: true, show_primary_nav: true,
    cta: { enabled: true, label: "Join us", href: "/register" },
    mobile_menu: "accordion", alignment: "left",
  },
};

/** A complete, valid footer configuration (§11/§12 shape). */
const FOOTER_FULL = {
  columns: [
    { id: "explore", heading: "Explore", links: [{ label: "News", href: "/news" }, { label: "Events", href: "/events" }] },
    { id: "party", heading: "Party", links: [{ label: "Manifesto", href: "/manifesto" }] },
  ],
  legal: { copyright: "© 2026 Tenant A", links: [{ label: "Privacy", href: "/privacy" }] },
  social: { show: true },
  presentation: { layout: "columns-3", show_contact: true, show_cta: false },
};

describe("phase25 — site chrome (header / footer / navigation)", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let admin: { authId: string };
  let member: { authId: string };

  /** Current stored revision for an area on tenant A (0 when unconfigured). */
  async function rev(area: string): Promise<number> {
    const r = await db.query<{ n: string }>(
      `SELECT COALESCE((${area}->>'revision')::text,'0') n
         FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
    return Number(r.rows[0]?.n ?? "0");
  }

  async function anonChrome(slug: string): Promise<Record<string, unknown>> {
    const r = await as(db, "anon", null, `SELECT public.get_public_site_chrome('${slug}') AS c`);
    expect(r.error).toBeUndefined();
    return (r.rows[0] as { c: Record<string, unknown> }).c;
  }

  function navItems(chrome: Record<string, unknown>): { label: string }[] {
    return ((chrome.navigation as { items: { label: string }[] }).items) ?? [];
  }

  beforeAll(async () => {
    db = await getDb();
    // governance deliberately NOT activated on tenant A (module-dependency proofs).
    tenantA = await createTenant(db, "p25sc-a", "Phase 25 Chrome A", { social: true });
    tenantB = await createTenant(db, "p25sc-b", "Phase 25 Chrome B", {});
    admin = await createUser(db, {
      tenantId: tenantA, email: "p25sc-admin@test.local", fullName: "P25 Admin A", accessRole: "admin",
    });
    member = await createUser(db, {
      tenantId: tenantA, email: "p25sc-member@test.local", fullName: "P25 Member A", accessRole: "member",
    });
    await createUser(db, {
      tenantId: tenantB, email: "p25sc-admin-b@test.local", fullName: "P25 Admin B", accessRole: "admin",
    });
  });

  afterAll(async () => {
    await db.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    const profs = await db.query<{ id: string }>(
      `SELECT id FROM politicore.profiles WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    const ids = profs.rows.map((r) => r.id);
    if (ids.length) {
      await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [ids]);
    }
    await db.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  });

  // ── A. Authority ─────────────────────────────────────────────────────
  describe("A. authority", () => {
    it("A1 anon cannot mutate chrome areas (no EXECUTE, no base-table grants)", async () => {
      const r1 = await as(db, "anon", null,
        `SELECT politicore.save_site_config_draft('navigation', '{"items":[]}'::jsonb, 0)`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null,
        `SELECT politicore.publish_site_config('footer', 0)`);
      expect(r2.error).toBeDefined();
      // Base-table grants were revoked in 0060 (§0/§26).
      const r3 = await as(db, "anon", null, `SELECT * FROM politicore.public_site_settings`);
      expect(r3.error).toBeDefined();
    });

    it("A2 anon cannot read the admin preview or history RPCs", async () => {
      const r1 = await as(db, "anon", null, `SELECT politicore.get_site_config_preview('navigation')`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null, `SELECT * FROM politicore.get_site_config_history('footer')`);
      expect(r2.error).toBeDefined();
    });

    it("A3 ordinary member cannot save or publish chrome configuration", async () => {
      const r1 = await as(db, "authenticated", member.authId,
        `SELECT politicore.save_site_config_draft('navigation', '{"items":[]}'::jsonb, 0)`);
      expect(r1.error).toBeDefined();
      expect(r1.error).toContain("Tenant administration authority");
      const r2 = await as(db, "authenticated", member.authId,
        `SELECT politicore.publish_site_config('navigation', 0)`);
      expect(r2.error).toBeDefined();
      expect(r2.error).toContain("Tenant administration authority");
    });

    it("A4 tenant admin can save drafts for both chrome areas (revision returned)", async () => {
      const r1 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(NAV_FULL)}'::jsonb, ${await rev("navigation")})`);
      expect(r1.error).toBeUndefined();
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '${JSON.stringify(FOOTER_FULL)}'::jsonb, ${await rev("footer")})`);
      expect(r2.error).toBeUndefined();
    });

    it("A5 tenant B admin cannot mutate tenant A chrome configuration", async () => {
      const before = await db.query<{ navigation: unknown }>(
        `SELECT navigation FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      const bAdmin = (await db.query<{ id: string }>(
        `SELECT id FROM politicore.profiles WHERE tenant_id = $1 AND access_role = 'admin'`, [tenantB])).rows[0].id;
      await as(db, "authenticated", bAdmin,
        `SELECT politicore.save_site_config_draft('navigation', '{"items":[{"id":"h","label":"Hijack","href":"/"}]}'::jsonb, 999)`);
      const after = await db.query<{ navigation: unknown }>(
        `SELECT navigation FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(after.rows[0]?.navigation).toEqual(before.rows[0]?.navigation);
    });
  });

  // ── B. Validation ────────────────────────────────────────────────────
  describe("B. configuration validation (allowlists)", () => {
    async function navReject(payload: unknown, msg: string) {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(payload)}'::jsonb, ${await rev("navigation")})`);
      expect(r.error, `${msg} — expected rejection`).toBeDefined();
      expect(r.error).toContain(msg);
    }

    it("B1 unknown top-level key, unknown header key, malformed structures rejected", async () => {
      await navReject({ items: [], mystery: 1 }, "Navigation configuration has an unknown field");
      await navReject({ items: [], header: { mystery: true } }, "Header configuration has an unknown field");
      await navReject({ items: 5 }, "Navigation items must be an array");
    });

    it("B2 unknown item type / visibility / service_dependency rejected", async () => {
      await navReject({ items: [{ id: "x", label: "X", href: "/", type: "mega-menu" }] }, "has an unsupported type");
      await navReject({ items: [{ id: "x", label: "X", href: "/", visibility: "admin" }] }, "has an unsupported visibility");
      await navReject({ items: [{ id: "x", label: "X", href: "/", service_dependency: "firebase" }] }, "has an unsupported service_dependency");
    });

    it("B3 unknown item field (executable keys) rejected", async () => {
      await navReject({ items: [{ id: "x", label: "X", href: "/", onclick: "alert(1)" }] }, "Navigation item has an unknown field");
      await navReject({ items: [{ id: "x", label: "X", href: "/", component: "./Exploit" }] }, "Navigation item has an unknown field");
    });

    it("B4 duplicate stable ids and duplicate labels rejected", async () => {
      await navReject({
        items: [
          { id: "dup", label: "One", href: "/" },
          { id: "dup", label: "Two", href: "/two" },
        ],
      }, "Navigation item ids must be unique");
      await navReject({
        items: [
          { id: "a", label: "Same", href: "/" },
          { id: "b", label: "Same", href: "/two" },
        ],
      }, "Navigation item labels must be unique");
    });

    it("B5 bounded arrays — 12 top items, 8 children, 4 columns", async () => {
      const many = Array.from({ length: 13 }, (_, i) => ({ id: `i${i}`, label: `Item ${i}`, href: `/${i}` }));
      await navReject({ items: many }, "Navigation configuration exceeds 12 top-level items");
      const kids = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, label: `Child ${i}`, href: `/c/${i}` }));
      await navReject({ items: [{ id: "p", label: "P", href: "#p", type: "anchor", children: kids }] }, "exceeds 8 children");
      const cols = Array.from({ length: 5 }, (_, i) => ({
        id: `col${i}`, heading: `Col ${i}`, links: [{ label: "L", href: "/" }],
      }));
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '${JSON.stringify({ columns: cols })}'::jsonb, ${await rev("footer")})`);
      expect(r.error).toContain("exceeds 4 columns");
    });

    it("B6 nesting beyond one child level rejected", async () => {
      await navReject({
        items: [{
          id: "p", label: "P", href: "#p", type: "anchor",
          children: [{ id: "c", label: "C", href: "/c", children: [{ id: "g", label: "G", href: "/g" }] }],
        }],
      }, "must not nest children deeper than one level");
    });

    it("B7 invalid presentation vocabulary rejected", async () => {
      await navReject({ items: [{ id: "x", label: "X", href: "/", presentation: { style: "neon" } }] }, "unsupported presentation style");
      await navReject({ items: [{ id: "x", label: "X", href: "/", presentation: { css: "color:red" } }] }, "presentation has an unknown field");
    });

    it("B8 header vocabulary — mobile_menu, alignment, CTA shape", async () => {
      await navReject({ items: [], header: { mobile_menu: "sidewinder" } }, "Header mobile_menu has an unsupported value");
      await navReject({ items: [], header: { alignment: "justified" } }, "Header alignment has an unsupported value");
      await navReject({ items: [], header: { cta: { enabled: true, label: "Go" } } }, "Header CTA href is required");
      await navReject({ items: [], header: { show_logo: "yes" } }, "Header show_logo must be a boolean");
    });

    it("B9 footer vocabulary — headings, layout, presentation", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '${JSON.stringify({
          columns: [{ id: "c", heading: "x".repeat(61), links: [] }],
        })}'::jsonb, ${await rev("footer")})`);
      expect(r.error).toContain("1..60");
      const r2 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '{"presentation":{"layout":"columns-9"}}'::jsonb, ${await rev("footer")})`);
      expect(r2.error).toContain("unsupported value");
      const r3 = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '{"custom_css":"*{}"}'::jsonb, ${await rev("footer")})`);
      expect(r3.error).toContain("Footer configuration has an unknown field");
    });
  });

  // ── C. Safe destinations (§7) ────────────────────────────────────────
  describe("C. safe destination validation", () => {
    async function navHref(href: string): Promise<string | undefined> {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify({
          items: [{ id: "x", label: "X", href }],
        })}'::jsonb, ${await rev("navigation")})`);
      return r.error;
    }

    it("C1 dangerous schemes rejected", async () => {
      expect(await navHref("javascript:alert(1)")).toContain("forbidden scheme");
      expect(await navHref("data:text/html,<script>1</script>")).toContain("forbidden scheme");
      expect(await navHref("vbscript:msgbox(1)")).toContain("forbidden scheme");
      expect(await navHref("file:///C:/win.ini")).toContain("forbidden scheme");
    });

    it("C2 non-http(s) URLs rejected", async () => {
      expect(await navHref("ftp://example.com/x")).toContain("must be an internal path or an http(s) URL");
    });

    it("C3 valid internal path, https URL and anchor accepted", async () => {
      expect(await navHref("/governance")).toBeUndefined();
      expect(await navHref("https://example.org/ok")).toBeUndefined();
      expect(await navHref("#about")).toBeUndefined();
    });
  });

  // ── D. Lifecycle + module dependency (§8/§17) ────────────────────────
  describe("D. draft, publish, public chrome, module dependency", () => {
    it("D1 drafts are not public before publish", async () => {
      const chrome = await anonChrome("p25sc-a");
      expect(navItems(chrome)).toHaveLength(0); // nothing published yet
    });

    it("D2 publish makes chrome public; governance-dependent item hidden while module OFF", async () => {
      // The C-section acceptance saves replaced the drafts with minimal
      // payloads — restore the full composition before publishing.
      const rn = await rev("navigation");
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(NAV_FULL)}'::jsonb, ${rn})`);
      const rf = await rev("footer");
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('footer', '${JSON.stringify(FOOTER_FULL)}'::jsonb, ${rf})`);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.publish_site_config('navigation', ${rn + 1})`);
      expect(r.error).toBeUndefined();
      const rfk = await as(db, "authenticated", admin.authId,
        `SELECT politicore.publish_site_config('footer', ${rf + 1})`);
      expect(rfk.error).toBeUndefined();

      const chrome = await anonChrome("p25sc-a");
      const labels = navItems(chrome).map((i) => i.label);
      expect(labels).toContain("Home");
      expect(labels).not.toContain("Governance"); // module OFF → suppressed server-side
      // Stored config was NOT mutated by eligibility (§8).
      const stored = await db.query<{ published?: { items: unknown[] } }>(
        `SELECT navigation->'published' published FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      const storedLabels = (stored.rows[0].published?.items ?? []).map((i) => (i as { label: string }).label);
      expect(storedLabels).toContain("Governance");
    });

    it("D3 module ON restores the dependent item from the SAME stored config", async () => {
      await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
      const chrome = await anonChrome("p25sc-a");
      expect(navItems(chrome).map((i) => i.label)).toContain("Governance");
      await db.query(`UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
      const after = await anonChrome("p25sc-a");
      expect(navItems(after).map((i) => i.label)).not.toContain("Governance");
    });

    it("D4 public chrome exposes no draft/history/revision/publisher internals", async () => {
      const chrome = await anonChrome("p25sc-a");
      for (const area of ["navigation", "footer"] as const) {
        const obj = chrome[area] as Record<string, unknown>;
        expect(obj).not.toHaveProperty("draft");
        expect(obj).not.toHaveProperty("history");
        expect(obj).not.toHaveProperty("revision");
        expect(obj).not.toHaveProperty("published_at");
        expect(obj).not.toHaveProperty("published_by");
      }
    });

    it("D5 footer chrome carries the published columns", async () => {
      const chrome = await anonChrome("p25sc-a");
      const footer = (chrome.footer as { columns?: { heading: string }[] }) ?? {};
      expect(footer.columns?.map((c) => c.heading) ?? []).toEqual(["Explore", "Party"]);
    });
  });

  // ── E. Draft privacy + concurrency (Phase 24 lesson) ─────────────────
  describe("E. draft privacy, concurrency, merge-safe saves", () => {
    it("E1 stale revision is rejected and overwrites nothing", async () => {
      const current = await rev("navigation");
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '{"items":[]}'::jsonb, ${current - 1})`);
      expect(r.error).toContain("Configuration conflict");
      const stored = await db.query<{ n: string }>(
        `SELECT (navigation->>'revision')::text n FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(Number(stored.rows[0].n)).toBe(current);
    });

    it("E2 a draft save after publish preserves published state AND history (merge-safe save)", async () => {
      const current = await rev("navigation");
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(NAV_FULL)}'::jsonb, ${current})`);
      expect(r.error).toBeUndefined();
      const row = await db.query<{ ok: boolean; hist: number; pub: unknown }>(
        `SELECT (navigation ? 'published') ok,
                jsonb_array_length(COALESCE(navigation->'history','[]'::jsonb)) hist,
                navigation->'published' pub
           FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(row.rows[0].ok).toBe(true);
      expect(row.rows[0].hist).toBeGreaterThanOrEqual(1);
      // Public output still serves the PUBLISHED composition.
      const chrome = await anonChrome("p25sc-a");
      expect(navItems(chrome).length).toBeGreaterThan(0);
    });

    it("E3 history/preview RPCs stay admin-only for chrome areas", async () => {
      const r = await as(db, "anon", null, `SELECT * FROM politicore.get_site_config_history('navigation')`);
      expect(r.error).toBeDefined();
      const r2 = await as(db, "authenticated", member.authId,
        `SELECT politicore.get_site_config_preview('footer')`);
      expect(r2.error).toBeDefined();
      expect(r2.error).toContain("Tenant administration authority");
    });
  });

  // ── F. Rollback & bounded history ────────────────────────────────────
  describe("F. rollback and bounded history", () => {
    it("F1 rollback promotes a history entry through the validated draft path (audit, no auto-publish)", async () => {
      // Guarantee the newest history entry carries a REAL published payload:
      // the first-ever entry records `published: null` (nothing existed
      // before the first publish), and rollback refuses a null payload.
      const r0 = await rev("navigation");
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(NAV_FULL)}'::jsonb, ${r0})`);
      await as(db, "authenticated", admin.authId,
        `SELECT politicore.publish_site_config('navigation', ${r0 + 1})`);

      const histBefore = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config_history('navigation')`);
      expect(histBefore.error).toBeUndefined();
      const entries = histBefore.rows as { revision: number }[];
      expect(entries.length).toBeGreaterThanOrEqual(1);
      // Entries are appended newest-last; roll back the most recent one.
      const target = entries[entries.length - 1].revision;
      expect(target).toBeGreaterThan(0);

      const auditsBefore = Number((await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.system_audits
          WHERE action = 'site_config:navigation:rollback' AND tenant_id = $1`, [tenantA])).rows[0].n);

      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.rollback_site_config('navigation', ${target})`);
      expect(r.error).toBeUndefined();

      // Audit evidence with the server-resolved actor.
      const audit = await db.query<{ n: string; actor: string }>(
        `SELECT count(*)::text n, max(actor_id::text) actor FROM politicore.system_audits
          WHERE action = 'site_config:navigation:rollback' AND tenant_id = $1`, [tenantA]);
      expect(Number(audit.rows[0].n)).toBe(auditsBefore + 1);
      expect(audit.rows[0].actor).toBe(admin.authId);

      // Rollback lands as a DRAFT — public output unchanged until published.
      const chrome = await anonChrome("p25sc-a");
      expect(navItems(chrome).length).toBeGreaterThan(0);

      // History was NOT mutated by the rollback (§15).
      const histAfter = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config_history('navigation')`);
      expect((histAfter.rows as { revision: number }[]).length).toBe(entries.length);
    });

    it("F2 unknown history revision rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.rollback_site_config('navigation', 999999)`);
      expect(r.error).toContain("History revision 999999 not found");
    });

    it("F3 history stays bounded at 10 entries", async () => {
      // Publish 11 more cycles; the archive must never exceed 10 entries.
      for (let i = 0; i < 11; i++) {
        const current = await rev("navigation");
        const payload = { ...NAV_FULL, header: { ...NAV_FULL.header, alignment: i % 2 === 0 ? "left" : "center" } };
        const s = await as(db, "authenticated", admin.authId,
          `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(payload)}'::jsonb, ${current})`);
        expect(s.error).toBeUndefined();
        const p = await as(db, "authenticated", admin.authId,
          `SELECT politicore.publish_site_config('navigation', ${current + 1})`);
        expect(p.error).toBeUndefined();
      }
      const hist = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config_history('navigation')`);
      // Bounded archive — never grows past the established maximum (§13/§15).
      expect(hist.rows.length).toBeLessThanOrEqual(10);
    });
  });

  // ── G. Tenant isolation ──────────────────────────────────────────────
  describe("G. tenant isolation", () => {
    it("G1 public slug A never returns tenant B configuration", async () => {
      // Give B its own distinct published navigation.
      const bAdmin = (await db.query<{ id: string }>(
        `SELECT id FROM politicore.profiles WHERE tenant_id = $1 AND access_role = 'admin'`, [tenantB])).rows[0].id;
      const bNav = { items: [{ id: "b-home", label: "B-ONLY-MARKER", href: "/" }] };
      await as(db, "authenticated", bAdmin,
        `SELECT politicore.save_site_config_draft('navigation', '${JSON.stringify(bNav)}'::jsonb, 0)`);
      await as(db, "authenticated", bAdmin, `SELECT politicore.publish_site_config('navigation', 1)`);

      const a = await anonChrome("p25sc-a");
      const b = await anonChrome("p25sc-b");
      expect(JSON.stringify(a.navigation)).not.toContain("B-ONLY-MARKER");
      expect(navItems(b).map((i) => i.label)).toContain("B-ONLY-MARKER");
      expect(JSON.stringify(b.navigation)).not.toContain("Home");
    });

    it("G2 admin preview returns only the caller's own tenant draft", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.get_site_config_preview('navigation') AS p`);
      const preview = JSON.stringify((r.rows[0] as { p: unknown }).p);
      expect(preview).not.toContain("B-ONLY-MARKER");
    });
  });

  // ── H. Rendering & architecture invariants ───────────────────────────
  describe("H. rendering and architecture", () => {
    const ROOT = path.resolve(__dirname, "../..");

    it("H1 exactly one public Header renderer and one Footer renderer", () => {
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, f.name);
          if (f.isDirectory()) {
            if (p.includes(`${path.sep}portal`)) continue; // editor UI is not a renderer
            walk(p);
          } else if (/^Header\.tsx$|^Footer\.tsx$/.test(f.name)) {
            hits.push(p);
          }
        }
      };
      walk(path.join(ROOT, "src", "components"));
      walk(path.join(ROOT, "src", "app"));
      const headers = hits.filter((p) => p.endsWith("Header.tsx"));
      const footers = hits.filter((p) => p.endsWith("Footer.tsx"));
      expect(headers).toHaveLength(1);
      expect(headers[0]).toContain(path.join("src", "components", "layout", "Header.tsx"));
      expect(footers).toHaveLength(1);
      expect(footers[0]).toContain(path.join("src", "components", "layout", "Footer.tsx"));
    });

    it("H2 the root layout mounts the single provider; renderers consume it (no second nav path)", () => {
      const layout = readFileSync(path.join(ROOT, "src", "app", "layout.tsx"), "utf8");
      expect(layout).toMatch(/PublicChromeProvider/);
      // The two renderers read published chrome exclusively through the
      // provider context — no independent fetch or second rendering path.
      for (const f of ["src/components/layout/Header.tsx", "src/components/layout/Footer.tsx"]) {
        const src = readFileSync(path.join(ROOT, f), "utf8");
        expect(src).toMatch(/usePublicChrome/);
        // No dynamic import / route generation from DB values (§29).
        expect(src).not.toMatch(/await import\(/);
        expect(src).not.toMatch(/require\(/);
      }
    });

    it("H3 no new tables, roles or permissions for chrome", async () => {
      const t = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM information_schema.tables
          WHERE table_schema = 'politicore'
            AND (table_name ILIKE '%navigation%' OR table_name ILIKE '%footer%'
                 OR table_name ILIKE '%header%' OR table_name ILIKE '%chrome%'
                 OR table_name ILIKE '%menu%')`);
      expect(Number(t.rows[0].n)).toBe(0);
      const roles = await db.query<{ role: string }>(
        `SELECT unnest(enum_range(NULL::politicore.access_role_enum))::text AS role`);
      expect(roles.rows.map((r) => r.role).sort()).toEqual(
        ["admin", "election_officer", "member", "platform_super_admin", "tenant_super_admin"]);
      const perms = await db.query<{ n: string }>(
        `SELECT count(*)::text n FROM politicore.permissions
          WHERE name ILIKE '%navigation%' OR name ILIKE '%footer%' OR name ILIKE '%header%'`);
      expect(Number(perms.rows[0].n)).toBe(0);
    });

    it("H4 no direct Cloudinary/R2 usage in the chrome surface", () => {
      for (const f of ["src/components/layout/Header.tsx", "src/components/layout/Footer.tsx", "src/components/layout/PublicChromeProvider.tsx", "src/lib/chrome/types.ts"]) {
        const src = readFileSync(path.join(ROOT, f), "utf8");
        expect(src).not.toMatch(/cloudinary|backblaze|b2_\w+|r2\.workers/i);
      }
    });

    it("H5 chrome renders have no arbitrary style/className injection surface", () => {
      // The single renderers must map presentation variants internally —
      // no admin-supplied class strings or inline style objects.
      for (const f of ["src/components/layout/Header.tsx", "src/components/layout/Footer.tsx"]) {
        const src = readFileSync(path.join(ROOT, f), "utf8");
        expect(src).not.toMatch(/style=\{\{[^}]*\b(?:item\.(?:presentation|config)|cfg\.)?a?style\b/);
        expect(src).not.toMatch(/className=\{(?:item|cfg)\.style\}/);
      }
    });
  });
});
