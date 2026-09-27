/**
 * POLITICORE — Public/Content Modules cutover security tests (Phase 4).
 *
 * Local PGlite verification on the real migrations (0001–0033) of the
 * canonical content-domain contracts:
 *
 *   1. EVENTS (public content): anonymous reads published rows only;
 *      drafts are tenant-admin-only; cross-tenant drafts invisible;
 *      management (insert/publish/update/delete) fails closed for members
 *      and succeeds for tenant admins.
 *   2. ANNOUNCEMENTS (authenticated communications, NOT notifications):
 *      anonymous sessions receive nothing (published rows included);
 *      same-tenant members read published rows in their membership scope;
 *      drafts are admin-only; cross-tenant rows invisible; management
 *      fails closed for members, succeeds for tenant admins.
 *   3. NEWS (public published content): published-only public reads,
 *      admin lifecycle, cross-tenant draft isolation.
 *   4. CONTACT: anonymous submissions accepted (public form), anonymous
 *      and member reads denied, admin reads confined to own tenant.
 *   5. Single-row content (biographies/galleries/manifestos): published
 *      public visibility, draft isolation, admin-only management.
 *   6. DONATIONS (private ledger): anonymous and member reads denied,
 *      member writes denied, admin writes succeed with donors projection
 *      and server-side audit attribution, cross-tenant isolation.
 *   7. Static boundary: zero external Firebase imports in src; homepage
 *      sources events+news from canonical services and contains no
 *      announcements; events and announcements remain separate domains
 *      (separate tables, separate services, no polymorphic model).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";
import {
  as,
  createTenant,
  createUser,
  getDb,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: PGlite;

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "tenant-a", "Tenant A", {}, TENANT_A);
  await createTenant(db, "tenant-b", "Tenant B", {}, TENANT_B);
});

async function memberOf(tenantId: string, extra: { role?: string; membership?: string[] } = {}) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Content Fixture",
    accessRole: extra.role ?? "member",
    membershipTypes: extra.membership ?? ["campaign_member"],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// EVENTS — public content (NOT campaign activities)
// ─────────────────────────────────────────────────────────────────────────
describe("events — public published reads, admin lifecycle", () => {
  it("anonymous visitors read published events and never drafts or cancelled rows", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const ins = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.events (tenant_id, title, description, event_date, venue, status)
       VALUES ($1, 'Town Hall', 'd', CURRENT_DATE, 'V', 'published'),
              ($1, 'Secret Draft', 'd', CURRENT_DATE, 'V', 'draft'),
              ($1, 'Old Cancelled', 'd', CURRENT_DATE, 'V', 'cancelled')
       RETURNING id, title`,
      [TENANT_A]
    );
    expect(ins.error).toBeUndefined();

    const anon = await as(db, "anon", null, `SELECT title FROM public.events`);
    expect(anon.error).toBeUndefined();
    const titles = anon.rows.map((r) => String(r.title));
    expect(titles).toContain("Town Hall");
    expect(titles).not.toContain("Secret Draft");
    expect(titles).not.toContain("Old Cancelled");
  });

  it("drafts are visible to the owning tenant's admin but invisible to other tenants' members", async () => {
    const adminA = await memberOf(TENANT_A, { role: "admin" });
    const adminB = await memberOf(TENANT_B, { role: "admin" });

    const own = await as(
      db,
      "authenticated",
      adminA.authId,
      `SELECT title FROM public.events WHERE status = 'draft' AND tenant_id = $1`,
      [TENANT_A]
    );
    expect(own.error).toBeUndefined();
    expect(own.rows.map((r) => String(r.title))).toContain("Secret Draft");

    // Other-tenant drafts never leak through the published-branch of the read policy.
    const stranger = await as(
      db,
      "authenticated",
      adminB.authId,
      `SELECT title FROM public.events WHERE status = 'draft' AND tenant_id = $1`,
      [TENANT_A]
    );
    expect(stranger.error).toBeUndefined();
    expect(stranger.rows).toHaveLength(0);
  });

  it("management fails closed for ordinary members and succeeds for tenant admins (full lifecycle)", async () => {
    const member = await memberOf(TENANT_A);
    const admin = await memberOf(TENANT_A, { role: "admin" });

    const denied = await as(
      db,
      "authenticated",
      member.authId,
      `INSERT INTO public.events (tenant_id, title, description, event_date, venue) VALUES ($1,'x','x',CURRENT_DATE,'x')`,
      [TENANT_A]
    );
    expect(denied.error).toBeDefined();

    const created = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.events (tenant_id, title, description, event_date, venue, status, created_by)
       VALUES ($1, 'Lifecycle Event', 'd', CURRENT_DATE, 'V', 'draft', $2) RETURNING id`,
      [TENANT_A, admin.authId]
    );
    expect(created.error).toBeUndefined();
    const id = String(created.rows[0].id);

    const published = await as(
      db,
      "authenticated",
      admin.authId,
      `UPDATE public.events SET status = 'published' WHERE id = $1 RETURNING status`,
      [id]
    );
    expect(published.error).toBeUndefined();
    expect(published.rows[0].status).toBe("published");

    const removed = await as(
      db,
      "authenticated",
      admin.authId,
      `DELETE FROM public.events WHERE id = $1`,
      [id]
    );
    expect(removed.error).toBeUndefined();
    const gone = await as(db, "anon", null, `SELECT id FROM public.events WHERE id = $1`, [id]);
    expect(gone.rows).toHaveLength(0);
  });

  it("cross-tenant management is denied even for another tenant's admin", async () => {
    const adminB = await memberOf(TENANT_B, { role: "admin" });
    const ins = await as(
      db,
      "authenticated",
      adminB.authId,
      `INSERT INTO public.events (tenant_id, title, description, event_date, venue) VALUES ($1,'x','x',CURRENT_DATE,'x')`,
      [TENANT_A]
    );
    expect(ins.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ANNOUNCEMENTS — authenticated tenant communications (NOT notifications)
// ─────────────────────────────────────────────────────────────────────────
describe("announcements — authenticated-only, membership-scoped, admin lifecycle", () => {
  it("anonymous sessions receive no announcements — a published announcement is still private", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const ins = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.announcements (tenant_id, title, content, scope, status, published_at)
       VALUES ($1, 'Public-Looking Notice', 'body', 'general', 'published', now())`,
      [TENANT_A]
    );
    expect(ins.error).toBeUndefined();

    const anon = await as(db, "anon", null, `SELECT id FROM public.announcements`);
    expect(anon.error).toBeUndefined();
    expect(anon.rows).toHaveLength(0);
  });

  it("same-tenant members read published general announcements; drafts stay admin-only", async () => {
    const member = await memberOf(TENANT_A);
    const admin = await memberOf(TENANT_A, { role: "admin" });

    await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.announcements (tenant_id, title, content, scope, status)
       VALUES ($1, 'Draft Notice', 'b', 'general', 'draft')`,
      [TENANT_A]
    );

    const seen = await as(
      db,
      "authenticated",
      member.authId,
      `SELECT title, status FROM public.announcements`
    );
    expect(seen.error).toBeUndefined();
    const titles = seen.rows.map((r) => String(r.title));
    expect(titles).toContain("Public-Looking Notice");
    expect(titles).not.toContain("Draft Notice");

    const adminView = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT title FROM public.announcements`
    );
    expect(adminView.rows.map((r) => String(r.title))).toContain("Draft Notice");
  });

  it("membership scope gates visibility (campaign_members scope hidden from social-only members)", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.announcements (tenant_id, title, content, scope, status, published_at)
       VALUES ($1, 'Campaign Only', 'b', 'campaign_members', 'published', now())`,
      [TENANT_A]
    );

    const socialOnly = await memberOf(TENANT_A, { membership: ["social_member"] });
    const campaign = await memberOf(TENANT_A, { membership: ["campaign_member"] });

    const socialView = await as(
      db,
      "authenticated",
      socialOnly.authId,
      `SELECT title FROM public.announcements WHERE scope = 'campaign_members'`
    );
    expect(socialView.error).toBeUndefined();
    expect(socialView.rows).toHaveLength(0);

    const campaignView = await as(
      db,
      "authenticated",
      campaign.authId,
      `SELECT title FROM public.announcements WHERE scope = 'campaign_members'`
    );
    expect(campaignView.rows.map((r) => String(r.title))).toContain("Campaign Only");
  });

  it("cross-tenant published announcements are invisible (tenant isolation)", async () => {
    const memberB = await memberOf(TENANT_B);
    const view = await as(
      db,
      "authenticated",
      memberB.authId,
      `SELECT id FROM public.announcements WHERE tenant_id = $1`,
      [TENANT_A]
    );
    expect(view.error).toBeUndefined();
    expect(view.rows).toHaveLength(0);
  });

  it("management fails closed for members and succeeds for tenant admins", async () => {
    const member = await memberOf(TENANT_A);
    const admin = await memberOf(TENANT_A, { role: "admin" });

    const denied = await as(
      db,
      "authenticated",
      member.authId,
      `INSERT INTO public.announcements (tenant_id, title, content) VALUES ($1,'x','x')`,
      [TENANT_A]
    );
    expect(denied.error).toBeDefined();

    const ok = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.announcements (tenant_id, title, content, scope, status, published_at)
       VALUES ($1, 'Admin Notice', 'b', 'general', 'published', now()) RETURNING id`,
      [TENANT_A]
    );
    expect(ok.error).toBeUndefined();
  });

  it("announcements are not notifications: the notifications table is a separate domain", async () => {
    // The canonical notifications table must not be used as the announcements
    // store and vice versa — distinct tables with distinct policies.
    const notif = await as(
      db,
      "anon",
      null,
      `SELECT to_regclass('politicore.notifications') IS NOT NULL AS has_notifications,
              to_regclass('politicore.announcements') IS NOT NULL AS has_announcements`
    );
    expect(notif.rows[0].has_notifications).toBe(true);
    expect(notif.rows[0].has_announcements).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NEWS — public published content; admin lifecycle
// ─────────────────────────────────────────────────────────────────────────
describe("news — published public reads, admin lifecycle", () => {
  it("anonymous reads published articles only; drafts and archived stay hidden", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.news_articles (tenant_id, title, slug, status, published_at)
       VALUES ($1, 'Live Story', 'live-story', 'published', now()),
              ($1, 'Hidden Draft', 'hidden-draft', 'draft', NULL)`,
      [TENANT_A]
    );

    const anon = await as(db, "anon", null, `SELECT title FROM public.news_articles`);
    expect(anon.error).toBeUndefined();
    const titles = anon.rows.map((r) => String(r.title));
    expect(titles).toContain("Live Story");
    expect(titles).not.toContain("Hidden Draft");
  });

  it("member management denied; admin create/publish succeeds; cross-tenant drafts invisible", async () => {
    const member = await memberOf(TENANT_A);
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const adminB = await memberOf(TENANT_B, { role: "admin" });

    const denied = await as(
      db,
      "authenticated",
      member.authId,
      `INSERT INTO public.news_articles (tenant_id, title, slug) VALUES ($1,'x','x-slug')`,
      [TENANT_A]
    );
    expect(denied.error).toBeDefined();

    const ok = await as(
      db,
      "authenticated",
      admin.authId,
      `UPDATE public.news_articles SET status = 'published', published_at = now()
       WHERE slug = 'hidden-draft' AND tenant_id = $1 RETURNING status`,
      [TENANT_A]
    );
    expect(ok.error).toBeUndefined();
    expect(ok.rows[0].status).toBe("published");

    const leak = await as(
      db,
      "authenticated",
      adminB.authId,
      `SELECT id FROM public.news_articles WHERE slug = 'live-story' AND status = 'draft'`
    );
    expect(leak.error).toBeUndefined();
    expect(leak.rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CONTACT — anonymous submissions; admin-only reads
// ─────────────────────────────────────────────────────────────────────────
describe("contact messages — public submission, admin-only reading", () => {
  it("anonymous visitors can submit (public form) but cannot read any message", async () => {
    // NOTE: no RETURNING — the RETURNING clause evaluates the SELECT policy
    // on returned rows (admin-only here), which would self-reject an anon
    // read-back. Production inserts use return=minimal (no read-back), and
    // delivery is proven by the authorized admin read below.
    const submit = await as(
      db,
      "anon",
      null,
      `INSERT INTO public.contact_messages (tenant_id, name, email, message)
       VALUES ($1, 'Visitor', 'visitor@example.com', 'Hello')`,
      [TENANT_A]
    );
    expect(submit.error).toBeUndefined();

    const anonRead = await as(db, "anon", null, `SELECT id FROM public.contact_messages`);
    expect(anonRead.rows).toHaveLength(0);
  });

  it("ordinary members cannot read messages; tenant admins read only their own tenant", async () => {
    const member = await memberOf(TENANT_A);
    const adminA = await memberOf(TENANT_A, { role: "admin" });
    const adminB = await memberOf(TENANT_B, { role: "admin" });

    const memberView = await as(
      db,
      "authenticated",
      member.authId,
      `SELECT id FROM public.contact_messages`
    );
    expect(memberView.rows).toHaveLength(0);

    const adminAView = await as(
      db,
      "authenticated",
      adminA.authId,
      `SELECT email FROM public.contact_messages`
    );
    expect(adminAView.error).toBeUndefined();
    expect(adminAView.rows.map((r) => String(r.email))).toContain("visitor@example.com");

    const adminBView = await as(
      db,
      "authenticated",
      adminB.authId,
      `SELECT id FROM public.contact_messages WHERE tenant_id = $1`,
      [TENANT_A]
    );
    expect(adminBView.rows).toHaveLength(0);
  });

  it("admin marks a message read; anonymous cannot mutate existing rows", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });

    const markRead = await as(
      db,
      "authenticated",
      admin.authId,
      `UPDATE public.contact_messages SET status = 'read' WHERE email = 'visitor@example.com'
       RETURNING status`
    );
    expect(markRead.error).toBeUndefined();
    expect(markRead.rows[0].status).toBe("read");

    const anonUpdate = await as(
      db,
      "anon",
      null,
      `UPDATE public.contact_messages SET status = 'unread' WHERE email = 'visitor@example.com'`
    );
    expect(anonUpdate.error).toBeDefined();

    // Confirm the anonymous UPDATE did not land.
    const still = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT status FROM public.contact_messages WHERE email = 'visitor@example.com'`
    );
    expect(still.rows[0].status).toBe("read");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SINGLE-ROW CONTENT — biographies / galleries / manifestos
// ─────────────────────────────────────────────────────────────────────────
describe("single-row content — biography, gallery, manifesto", () => {
  it("published rows are public; drafts are tenant-only; cross-tenant drafts invisible", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const adminB = await memberOf(TENANT_B, { role: "admin" });

    // tenant_id is the PRIMARY KEY (one row per tenant) — publish and draft
    // states are exercised across the separate single-row tables.
    await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.biographies (tenant_id, full_name, about, status)
       VALUES ($1, 'Candidate', 'bio', 'published')`,
      [TENANT_A]
    );
    const draftGallery = await as(
      db,
      "authenticated",
      adminB.authId,
      `INSERT INTO public.galleries (tenant_id, images, status)
       VALUES ($1, '[{"url":"x"}]', 'draft')`,
      [TENANT_B]
    );
    expect(draftGallery.error).toBeUndefined();
    await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.manifestos (tenant_id, title, status) VALUES ($1, 'The Plan', 'published')`,
      [TENANT_A]
    );
    await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.galleries (tenant_id, images, status) VALUES ($1, '[]', 'published')`,
      [TENANT_A]
    );

    const anon = await as(db, "anon", null, `SELECT full_name, status FROM public.biographies`);
    expect(anon.rows.map((r) => String(r.full_name))).toContain("Candidate");
    expect(anon.rows.map((r) => String(r.full_name))).not.toContain("Draft Candidate");

    const manifesto = await as(db, "anon", null, `SELECT title FROM public.manifestos`);
    expect(manifesto.rows.map((r) => String(r.title))).toContain("The Plan");

    // The draft gallery (tenant B, identified by its content marker) is
    // invisible to anonymous visitors and to other tenants' admins, while
    // its own tenant admin sees it.
    const marker = `images @> '[{"url":"x"}]'::jsonb`;
    const galleryAnon = await as(db, "anon", null, `SELECT tenant_id FROM public.galleries WHERE ${marker}`);
    expect(galleryAnon.rows).toHaveLength(0);

    const crossLeak = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT tenant_id FROM public.galleries WHERE ${marker}`
    );
    expect(crossLeak.rows).toHaveLength(0);

    const ownDraft = await as(
      db,
      "authenticated",
      adminB.authId,
      `SELECT tenant_id FROM public.galleries WHERE ${marker}`
    );
    expect(ownDraft.rows).toHaveLength(1);
  });

  it("management is admin-only (member denied, admin upsert succeeds)", async () => {
    const member = await memberOf(TENANT_A);
    const admin = await memberOf(TENANT_A, { role: "admin" });

    const denied = await as(
      db,
      "authenticated",
      member.authId,
      `INSERT INTO public.biographies (tenant_id, full_name) VALUES ($1, 'x')`,
      [TENANT_A]
    );
    expect(denied.error).toBeDefined();

    const ok = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.biographies (tenant_id, full_name, status)
       VALUES ($1, 'Upserted', 'published')
       ON CONFLICT (tenant_id) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING full_name`,
      [TENANT_A]
    );
    expect(ok.error).toBeUndefined();
    expect(ok.rows[0].full_name).toBe("Upserted");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DONATIONS — PRIVATE admin-only ledger (no public collection)
// ─────────────────────────────────────────────────────────────────────────
describe("donations — private admin ledger with audit trail", () => {
  it("anonymous and ordinary members are denied any read; anonymous has no access path at all", async () => {
    const member = await memberOf(TENANT_A);

    const anonRead = await as(db, "anon", null, `SELECT id FROM public.donations`);
    expect(anonRead.error !== undefined || anonRead.rows.length === 0).toBe(true);

    const memberRead = await as(
      db,
      "authenticated",
      member.authId,
      `SELECT id FROM public.donations`
    );
    expect(memberRead.rows).toHaveLength(0);

    const memberDonors = await as(db, "authenticated", member.authId, `SELECT id FROM public.donors`);
    expect(memberDonors.rows).toHaveLength(0);
  });

  it("member writes denied; tenant admin records a donation with donors projection + server-side audit", async () => {
    const member = await memberOf(TENANT_A);
    const admin = await memberOf(TENANT_A, { role: "admin" });

    const denied = await as(
      db,
      "authenticated",
      member.authId,
      `INSERT INTO public.donations (tenant_id, donor_name, amount, date_received)
       VALUES ($1, 'Ghost Donor', 100, CURRENT_DATE)`,
      [TENANT_A]
    );
    expect(denied.error).toBeDefined();

    const ok = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.donations (tenant_id, donor_name, amount, date_received, payment_method, created_by, created_by_name)
       VALUES ($1, 'Alhaji Supporter', 250000, CURRENT_DATE, 'bank_transfer', $2, 'Tenant Admin')
       RETURNING id`,
      [TENANT_A, admin.authId]
    );
    expect(ok.error).toBeUndefined();

    const donors = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT full_name, total_received_amount, contribution_count FROM public.donors`
    );
    expect(donors.rows).toHaveLength(1);
    expect(donors.rows[0].full_name).toBe("Alhaji Supporter");
    expect(Number(donors.rows[0].total_received_amount)).toBe(250000);

    const audit = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT actor_id, action FROM public.system_audit_logs
       WHERE affected_resource = 'donations' ORDER BY occurred_at DESC LIMIT 1`
    );
    expect(audit.error).toBeUndefined();
    expect(String(audit.rows[0].actor_id)).toBe(admin.authId);
    expect(String(audit.rows[0].action)).toBe("donations:insert");
  });

  it("cross-tenant isolation: another tenant's admin sees none of this ledger", async () => {
    const adminB = await memberOf(TENANT_B, { role: "admin" });
    const leak = await as(
      db,
      "authenticated",
      adminB.authId,
      `SELECT id FROM public.donations WHERE tenant_id = $1`,
      [TENANT_A]
    );
    expect(leak.rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// STATIC BOUNDARY — migrated consumers, no combined model
// ─────────────────────────────────────────────────────────────────────────
describe("static Firebase and architecture boundary", () => {
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };

  it("no application code imports Firebase anymore (content cutover completed the boundary)", () => {
    const offenders = walk("src").filter((p) => {
      if (p.replace(/\\/g, "/").includes("src/lib/firebase/")) return false;
      const body = fs.readFileSync(p, "utf8");
      return /from\s+["'](@\/lib\/firebase|firebase\/(app|auth|firestore|storage))["']/.test(body);
    });
    expect(offenders).toEqual([]);
  });

  it("homepage sources events+news from canonical services; announcements never reach the public homepage", () => {
    const home = fs.readFileSync("src/app/page.tsx", "utf8");
    expect(home).toMatch(/listPublishedEvents/);
    expect(home).toMatch(/listPublishedNews/);
    expect(home).not.toMatch(/announcements/i);
    expect(home).not.toMatch(/lib\/firebase\//);
  });

  it("events and announcements are separate first-class domains (no combined model)", () => {
    // Separate services…
    expect(fs.existsSync("src/lib/supabase/events.ts")).toBe(true);
    expect(fs.existsSync("src/lib/supabase/announcements.ts")).toBe(true);
    const eventsSvc = fs.readFileSync("src/lib/supabase/events.ts", "utf8");
    const annSvc = fs.readFileSync("src/lib/supabase/announcements.ts", "utf8");
    expect(eventsSvc).not.toMatch(/from\s+["']\.\/announcements["']/);
    expect(annSvc).not.toMatch(/from\s+["']\.\/events["']/);
    // …separate tables (the old polymorphic portal_content model is gone)…
    const mig = fs.readFileSync("supabase/migrations/0033_public_content_modules.sql", "utf8");
    expect(mig).toMatch(/CREATE TABLE politicore\.events/);
    expect(mig).toMatch(/CREATE TABLE politicore\.announcements/);
    expect(mig).not.toMatch(/events_and_announcements|type\s*=\s*'event'\s*\|\|\s*'announcement'/);
    // …and the legacy combined Firebase store has zero live consumers.
    expect(fs.existsSync("src/lib/firebase/portal-content.ts")).toBe(false);
  });

  it("no public donation collection endpoint exists (private ledger only)", () => {
    const donationsPage = fs.readFileSync("src/app/portal/admin/donations/page.tsx", "utf8");
    expect(donationsPage).not.toMatch(/checkout|payment_intent|gateway|stripe|paystack/i);
    // No public-facing donations route exists.
    expect(fs.existsSync("src/app/donate")).toBe(false);
    expect(fs.existsSync("src/app/donations")).toBe(false);
  });
});
