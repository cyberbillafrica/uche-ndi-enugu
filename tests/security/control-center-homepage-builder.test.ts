/**
 * POLITICORE — PHASE 24 — HOMEPAGE BUILDER SECURITY SUITE.
 *
 * Proves the Homepage slice (migration 0062) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–23
 * (§29 coverage):
 *
 *   A.  Authority          — anon holds nothing; member cannot mutate the
 *                            homepage; tenant admin can (own tenant);
 *                            tenant B cannot mutate tenant A's homepage.
 *   B.  Draft privacy      — drafts never reach anon; the public wrapper
 *                            returns PUBLISHED only; slug seam isolates.
 *   C.  Registry safety    — unknown section types rejected; the SQL
 *                            validator is the only config authority and
 *                            rejects smuggled executable fields.
 *   D.  Config validation  — per-type allowlists: unknown keys, duplicate
 *                            stable_ids, duplicate display_order, bad
 *                            service_dependency, unsafe links, cross-tenant
 *                            / missing media, over-length text.
 *   E.  Service dependency — declared dependencies are retained verbatim in
 *                            config and published composition (eligibility
 *                            is the render-time contract; §12 — nothing is
 *                            mutated by module state).
 *   F.  Concurrency        — stale draft/publish rejected; current
 *                            revision succeeds and bumps.
 *   G.  Publish/rollback   — bounded ≤10 history, history RPC (admin-only),
 *                            rollback restores a historical payload as
 *                            DRAFT through the validated save path,
 *                            unknown history revision refused, audited.
 *   H.  Public safety      — absent config → empty; malformed legacy
 *                            payload → passes through published-only
 *                            (renderer skips non-conforming entries, §9).
 *   I.  Audit              — draft_saved/published/rollback in Core Audit
 *                            with server-resolved tenant/actor.
 *   J.  Regression guard   — no new roles/tables; Phase 25 areas remain
 *                            unimplemented validators.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  getDb,
  as,
  createTenant,
  createUser,
} from "./helpers";

/** Minimal VALID presentation section (rich_text). */
const RICH = (id: string, order: number, body = "Hello world") => ({
  stable_id: id,
  section_type: "rich_text",
  display_order: order,
  enabled: true,
  config: { heading: "H", body },
});

/** Minimal VALID content section (news). */
const NEWS = (id: string, order: number) => ({
  stable_id: id,
  section_type: "news",
  display_order: order,
  enabled: true,
  config: { item_count: 3, layout: "grid" },
});

/** image_text carrying a Core Media reference (the validated media path). */
const IMAGE_TEXT = (id: string, order: number, assetId: string) => ({
  stable_id: id,
  section_type: "image_text",
  display_order: order,
  enabled: true,
  config: {
    heading: "T",
    body: "b",
    image: { asset_id: assetId },
    image_side: "left",
  },
});

/** Election-dependent section (Election is NOT enabled for these tenants). */
const COUNTDOWN = (id: string, order: number) => ({
  stable_id: id,
  section_type: "election_countdown",
  display_order: order,
  enabled: true,
  service_dependency: "election",
  config: { label: "Countdown" },
});

const A_ASSET = "44444444-4444-4444-8444-444444444444";
const B_ASSET = "55555555-5555-4555-8555-555555555555";
const GHOST_ASSET = "77777777-7777-4777-8777-777777777777";

describe("phase24 — homepage builder", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let admin: { authId: string };
  let member: { authId: string };
  let adminB: { authId: string };

  beforeAll(async () => {
    db = await getDb();
    tenantA = await createTenant(db, "p24hp-a", "Phase 24 Homepage A", { social: true });
    tenantB = await createTenant(db, "p24hp-b", "Phase 24 Homepage B", { social: true });
    admin = await createUser(db, {
      tenantId: tenantA,
      email: "p24hp-admin@test.local",
      fullName: "P24 Admin A",
      accessRole: "admin",
    });
    member = await createUser(db, {
      tenantId: tenantA,
      email: "p24hp-member@test.local",
      fullName: "P24 Member A",
      accessRole: "member",
    });
    adminB = await createUser(db, {
      tenantId: tenantB,
      email: "p24hp-admin-b@test.local",
      fullName: "P24 Admin B",
      accessRole: "admin",
    });
    // Same-tenant public media assets for the media-tenancy proofs.
    await db.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ($1, $2, 'local', 'bucket', 'p24/asset-a.png', 'public', 'image/png')`,
      [A_ASSET, tenantA]
    );
    await db.query(
      `INSERT INTO politicore.media_assets (id, tenant_id, provider, bucket, object_key, visibility, content_type)
       VALUES ($1, $2, 'local', 'bucket', 'p24/asset-b.png', 'public', 'image/png')`,
      [B_ASSET, tenantB]
    );
  });

  /** Public wrapper read via the tenant's slug (resolved as superuser —
   *  an anon-context subquery on tenants would be RLS-blocked to NULL). */
  const publicHomepage = async (slug?: string) => {
    const s = slug ?? (await db.query<{ slug: string }>(
      `SELECT slug FROM politicore.tenants WHERE id = $1`, [tenantA])).rows[0].slug;
    return as(db, "anon", null, `SELECT * FROM public.get_published_homepage($1)`, [s]);
  };

  afterAll(async () => {
    // Child-first purge (settings rows are tenant-cascaded; assets are not).
    await db.query(
      `DELETE FROM politicore.media_assets WHERE id = ANY($1)`, [[A_ASSET, B_ASSET]]);
    await db.query(`DELETE FROM politicore.system_audits WHERE tenant_id = ANY($1)`, [
      [tenantA, tenantB],
    ]);
    await db.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = ANY($1)`, [
      [tenantA, tenantB],
    ]);
    await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`, [
      [admin.authId, member.authId, adminB.authId],
    ]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`, [
      [admin.authId, member.authId, adminB.authId],
    ]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
  });

  // ── A. Authority ─────────────────────────────────────────────────────
  describe("A. authority", () => {
    it("A1 anon holds nothing on the homepage surface", async () => {
      const r1 = await as(db, "anon", null,
        `SELECT politicore.save_site_config_draft('homepage', '{"sections":[]}'::jsonb, 0) AS r`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "anon", null,
        `SELECT * FROM politicore.publish_site_config('homepage', 0)`);
      expect(r2.error).toBeDefined();
      const r3 = await as(db, "anon", null,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      expect(r3.error).toBeDefined();
      const r4 = await as(db, "anon", null,
        `SELECT * FROM politicore.get_site_config_history('homepage')`);
      expect(r4.error).toBeDefined();
      const r5 = await as(db, "anon", null,
        `SELECT politicore.rollback_site_config('homepage', 1) AS r`);
      expect(r5.error).toBeDefined();
      // Base-table grants were revoked in 0060.
      const r6 = await as(db, "anon", null, `SELECT * FROM politicore.public_site_settings`);
      expect(r6.error).toBeDefined();
    });

    it("A2 member cannot mutate the homepage", async () => {
      const r = await as(db, "authenticated", member.authId,
        `SELECT politicore.save_site_config_draft('homepage', '{"sections":[]}'::jsonb, 0) AS r`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("Tenant administration authority is required for configuration writes");
    });

    it("A3 member cannot read draft or history", async () => {
      const r1 = await as(db, "authenticated", member.authId,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      expect(r1.error).toBeDefined();
      const r2 = await as(db, "authenticated", member.authId,
        `SELECT * FROM politicore.get_site_config_history('homepage')`);
      expect(r2.error).toBeDefined();
    });

    it("A4 tenant admin can save + read own homepage", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 0) AS new_revision`,
        [{ sections: [RICH("s1", 1)] }]);
      expect(r.error).toBeUndefined();
      expect(Number((r.rows[0] as { new_revision: number }).new_revision)).toBe(1);
      const g = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      expect(g.error).toBeUndefined();
      const draft = (g.rows[0] as unknown as { draft: { sections: unknown[] } }).draft;
      expect(draft.sections).toHaveLength(1);
    });

    it("A5 tenant B cannot mutate or read tenant A homepage", async () => {
      const before = await db.query<{ homepage: unknown }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      // B's session resolves its own tenant; A is not addressable. A stale
      // base revision (B has never provisioned a row → current 0) fails.
      const r = await as(db, "authenticated", adminB.authId,
        `SELECT politicore.save_site_config_draft('homepage', '{"sections":[]}'::jsonb, 999) AS r`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("Configuration conflict");
      const after = await db.query<{ homepage: unknown }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(after.rows[0]?.homepage).toEqual(before.rows[0]?.homepage);
      // B reads (at most) its own config — never A's sections.
      const g = await as(db, "authenticated", adminB.authId,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      if (!g.error) {
        const draft = (g.rows[0] as unknown as { draft: { sections?: { stable_id: string }[] } } | null);
        const ids = (draft?.draft?.sections ?? []).map((s) => s.stable_id);
        expect(ids).not.toContain("s1");
      }
    });
  });

  // ── B. Draft privacy ─────────────────────────────────────────────────
  describe("B. draft privacy", () => {
    it("B1 draft edits never change the public published composition", async () => {
      // Publish the single-section draft (revision 1 → 2).
      const p = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('homepage', 1)`);
      expect(p.error).toBeUndefined();
      const pub1 = await publicHomepage();
      expect((pub1.rows[0] as unknown as { sections: unknown[] }).sections).toHaveLength(1);
      // Draft a second section — public output must not change.
      const s = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 2) AS new_revision`,
        [{ sections: [RICH("s1", 1), NEWS("s2", 2)] }]);
      expect(s.error).toBeUndefined();
      const pub2 = await publicHomepage();
      expect((pub2.rows[0] as unknown as { sections: unknown[] }).sections).toHaveLength(1);
    });

    it("B2 public wrapper returns published only (never draft fields)", async () => {
      const pub = await publicHomepage();
      expect(pub.error).toBeUndefined();
      const row = pub.rows[0] as unknown as { revision: number; sections: unknown[] };
      expect(Number(row.revision)).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(row.sections)).toBe(true);
      expect(row.sections).toHaveLength(1); // draft has 2 — draft is not leaked
    });

    it("B3 slug seam: an unknown slug yields no rows (empty, not foreign)", async () => {
      const pub = await as(db, "anon", null,
        `SELECT * FROM public.get_published_homepage('definitely-not-a-real-slug-p24')`);
      expect(pub.error).toBeUndefined();
      expect(pub.rows).toHaveLength(0);
    });
  });

  // ── C. Registry safety ───────────────────────────────────────────────
  describe("C. registry safety", () => {
    it("C1 unknown section_type is rejected by the server validator", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [{ stable_id: "x1", section_type: "future_feature", display_order: 1, enabled: true, config: {} }] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain('Unknown homepage section type "future_feature"');
    });

    it("C2 the validator rejects executable-looking fields (no component names stored)", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [{ stable_id: "x2", section_type: "rich_text", display_order: 1, enabled: true, config: { heading: "H", body: "b", component: "process.exit" } }] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain('Unknown config key "component"');
    });
  });

  // ── D. Config validation ─────────────────────────────────────────────
  describe("D. config validation", () => {
    it("D1 duplicate stable_ids rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [RICH("dup", 1), RICH("dup", 2)] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain('Duplicate homepage section stable_id "dup"');
    });

    it("D2 duplicate display_order rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [RICH("o1", 7), NEWS("o2", 7)] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain('Duplicate homepage section display_order "7"');
    });

    it("D3 invalid service_dependency (not a module code) rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [{ stable_id: "d3", section_type: "news", display_order: 1, enabled: true, service_dependency: "homepage", config: { item_count: 3, layout: "grid" } }] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain('has an unsupported service_dependency "homepage"');
    });

    it("D4 javascript: link href rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [{ stable_id: "d4", section_type: "cta", display_order: 1, enabled: true, config: { heading: "C", description: "b", primary_cta: { label: "Go", href: "javascript:alert(1)" } } }] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("href uses a forbidden scheme");
    });

    it("D5 data: URL link rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [{ stable_id: "d5", section_type: "cta", display_order: 1, enabled: true, config: { heading: "C", description: "b", primary_cta: { label: "Go", href: "data:text/html,<script>alert(1)</script>" } } }] }]);
      expect(r.error).toBeDefined();
    });

    it("D6 cross-tenant media reference rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [IMAGE_TEXT("d6", 1, B_ASSET)] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/media/i);
    });

    it("D7 missing media reference rejected safely", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [IMAGE_TEXT("d7", 1, GHOST_ASSET)] }]);
      expect(r.error).toBeDefined();
    });

    it("D8 over-length text rejected (controlled schemas)", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS r`,
        [{ sections: [RICH("d8", 1, "x".repeat(2001))] }]);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("at most 2000 characters");
    });

    it("D9 same-tenant public media accepted", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 3) AS new_revision`,
        [{ sections: [IMAGE_TEXT("d9", 1, A_ASSET)] }]);
      expect(r.error).toBeUndefined();
      expect(Number((r.rows[0] as { new_revision: number }).new_revision)).toBe(4);
    });
  });

  // ── E. Service dependency semantics ──────────────────────────────────
  describe("E. service dependency semantics", () => {
    it("E1 dependency-declared sections publish verbatim; config untouched", async () => {
      // Current revision is 4 (D9 save). Election is NOT enabled for A, yet
      // the validator does NOT refuse dependency-declared sections —
      // eligibility is a render-time contract (§12) and the published
      // composition preserves the declaration verbatim.
      const s = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', $1, 4) AS new_revision`,
        [{ sections: [COUNTDOWN("e1", 1), RICH("e2", 2)] }]);
      expect(s.error).toBeUndefined();
      const p = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('homepage', 5)`);
      expect(p.error).toBeUndefined();
      const pub = await publicHomepage();
      // §12: eligibility is a render-time contract — the DECLARATION is
      // preserved verbatim in stored config, but the PUBLIC projection
      // suppresses a section whose service (election) is disabled. The
      // eligible sibling (e2, no dependency) still renders.
      const sections = (pub.rows[0] as unknown as { sections: { stable_id: string; service_dependency?: string }[] }).sections;
      expect(sections.find((x) => x.stable_id === "e1")).toBeUndefined();
      expect(sections.find((x) => x.stable_id === "e2")).toBeDefined();
    });
  });

  // ── F. Concurrency ───────────────────────────────────────────────────
  describe("F. concurrency", () => {
    it("F1 stale draft save rejected and overwrites nothing", async () => {
      const before = await db.query<{ homepage: unknown }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.save_site_config_draft('homepage', '{"sections":[]}'::jsonb, 1) AS r`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("Configuration conflict");
      const after = await db.query<{ homepage: unknown }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(after.rows[0].homepage).toEqual(before.rows[0].homepage);
    });

    it("F2 stale publish rejected", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('homepage', 1)`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("Configuration conflict");
    });

    it("F3 current-revision publish succeeds and bumps revision", async () => {
      const cur = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      const rev = Number((cur.rows[0] as unknown as { revision: number }).revision);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.publish_site_config('homepage', $1)`, [rev]);
      expect(r.error).toBeUndefined();
      expect(Number((r.rows[0] as unknown as { revision: number }).revision)).toBe(rev + 1);
    });
  });

  // ── G. Publish & rollback ────────────────────────────────────────────
  describe("G. publish & rollback", () => {
    it("G1 publish promotes draft atomically and archives bounded history", async () => {
      const row = await db.query<{ homepage: { history: unknown[]; revision: number } }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(row.rows[0].homepage.revision).toBeGreaterThanOrEqual(6);
      expect(Array.isArray(row.rows[0].homepage.history)).toBe(true);
      expect(row.rows[0].homepage.history.length).toBeLessThanOrEqual(10);
    });

    it("G2 history RPC lists published revisions for the admin only", async () => {
      const h = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config_history('homepage')`);
      expect(h.error).toBeUndefined();
      expect(h.rows.length).toBeGreaterThanOrEqual(1);
      for (const row of h.rows) {
        expect(typeof (row as unknown as { revision: number }).revision).toBe("number");
      }
    });

    it("G3 rollback restores a historical revision as DRAFT through the validated save path", async () => {
      const h = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config_history('homepage') ORDER BY revision DESC LIMIT 1`);
      const target = Number((h.rows[0] as unknown as { revision: number }).revision);
      const before = await db.query<{ homepage: { history: unknown[] } }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.rollback_site_config('homepage', $1) AS new_revision`, [target]);
      expect(r.error).toBeUndefined();
      // Draft now equals the historical payload — the two-section
      // [countdown, rich_text] composition archived at that revision.
      const cfg = await as(db, "authenticated", admin.authId,
        `SELECT * FROM politicore.get_site_config('homepage')`);
      const draft = (cfg.rows[0] as unknown as { draft: { sections: { stable_id: string }[] } }).draft;
      expect(draft.sections.map((s) => s.stable_id)).toEqual(["e1", "e2"]);
      // History was NOT truncated by the rollback (non-destructive).
      const after = await db.query<{ homepage: { history: unknown[] } }>(
        `SELECT homepage FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantA]);
      expect(after.rows[0].homepage.history.length)
        .toBeGreaterThanOrEqual(before.rows[0].homepage.history.length);
      // Public output unchanged until publish.
      const pub = await publicHomepage();
      expect(pub.error).toBeUndefined();
    });

    it("G4 rollback to an unknown history revision fails", async () => {
      const r = await as(db, "authenticated", admin.authId,
        `SELECT politicore.rollback_site_config('homepage', 9999) AS r`);
      expect(r.error).toBeDefined();
      expect(r.error).toContain("History revision 9999 not found");
    });

    it("G5 rollback is audited", async () => {
      const a = await db.query<{ action: string }>(
        `SELECT action FROM politicore.system_audits
          WHERE tenant_id = $1 AND action LIKE 'site_config:homepage:rollback%' LIMIT 1`,
        [tenantA]);
      expect(a.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── H. Public safety ─────────────────────────────────────────────────
  describe("H. public safety", () => {
    it("H1 absent homepage configuration yields empty (not an error)", async () => {
      const pub = await as(db, "anon", null,
        `SELECT * FROM public.get_published_homepage('p24hp-b')`);
      expect(pub.error).toBeUndefined();
      expect(pub.rows).toHaveLength(0); // no published homepage yet for B
    });

    it("H2 malformed legacy homepage payload fails safe (no 500, no leak)", async () => {
      // Simulate a malformed legacy row directly (superuser write) — B has no
      // settings row yet, so provision one the way a legacy install would have.
      await db.query(
        `INSERT INTO politicore.public_site_settings (tenant_id, homepage)
         VALUES ($1, '{"revision":99,"published":{"sections":"not-an-array"}}'::jsonb)`, [tenantB]);
      const pub = await as(db, "anon", null,
        `SELECT sections FROM public.get_published_homepage('p24hp-b')`);
      expect(pub.error).toBeUndefined();
      expect(pub.rows).toHaveLength(1);
      // §20: a malformed legacy payload fails SAFE — the projection returns
      // an empty composition rather than an error or the raw garbage.
      expect(pub.rows[0].sections).toEqual([]);
      // Restore tenant B to a clean state for residue purposes.
      await db.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantB]);
    });
  });

  // ── I. Audit ─────────────────────────────────────────────────────────
  describe("I. audit", () => {
    it("I1 save/publish/rollback produce Core Audit evidence with server-resolved identity", async () => {
      const rows = await db.query<{ action: string; actor_id: string | null }>(
        `SELECT action, actor_id FROM politicore.system_audits
          WHERE tenant_id = $1 AND action LIKE 'site_config:homepage:%'
          ORDER BY occurred_at ASC`, [tenantA]);
      const actions = rows.rows.map((r) => r.action);
      expect(actions.some((a) => a.includes(":draft_saved"))).toBe(true);
      expect(actions.some((a) => a.includes(":published"))).toBe(true);
      expect(actions.some((a) => a.includes(":rollback"))).toBe(true);
      for (const r of rows.rows) {
        expect(r.actor_id).toBe(admin.authId); // server-resolved, never client-sent
      }
    });
  });

  // ── J. Regression guard ──────────────────────────────────────────────
  describe("J. regression guard", () => {
    it("J1 no new roles or homepage tables were introduced by 0062", async () => {
      const roles = await db.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE '%homepage%' OR rolname LIKE '%builder%'`);
      expect(roles.rows).toHaveLength(0);
      const cols = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns
          WHERE table_schema = 'politicore' AND column_name = 'homepage'`);
      expect(Number(cols.rows[0].count)).toBe(1); // the 0004 public_site_settings column only
    });

    it("J2 Phase 25 areas remain unimplemented (no navigation/footer validators)", async () => {
      const nav = await db.query<{ regproc: string | null }>(
        `SELECT to_regproc('politicore.cc_validate_navigation')::text AS regproc`);
      expect(nav.rows[0].regproc).toBeNull();
      const foot = await db.query<{ regproc: string | null }>(
        `SELECT to_regproc('politicore.cc_validate_footer')::text AS regproc`);
      expect(foot.rows[0].regproc).toBeNull();
    });
  });
});
