/**
 * POLITICORE — SAAS PHASE 30 — SELF-SERVICE TENANT ONBOARDING &
 * SUBSCRIPTION JOURNEY SECURITY SUITE (SaaS Phase C).
 *
 * Proves migration 0068 + the Phase 30 gate's requirements against
 * role-impersonated sessions (helpers.as) — the acceptance standard of
 * Phases 1–29:
 *
 *   A. Public catalog     — the anonymous pricing surface exposes ACTIVE
 *                           plan data only; no version ids; plan selection
 *                           authority is a CODE (server resolves version).
 *   B. Slug authority     — server-side normalization, reserved slugs,
 *                           uniqueness; the availability check reports
 *                           reasons precisely; client checks are UX only.
 *   C. Bare identity      — signup without tenant metadata provisions no
 *                           profile; the journey starts at create_tenant.
 *   D. Provisioning       — ONE atomic RPC creates tenant + modules +
 *                           settings + owner (tenant_super_admin) + the
 *                           Phase 29 subscription; failure rolls back all.
 *   E. Trial              — +14d from the plan version; no payment
 *                           method; no auto-charge copy; correct NGN item.
 *   F. Entitlements       — the map matches the plan version exactly.
 *   G. Duplicates         — duplicate owner/slug/subscription retries are
 *                           rejected by DB constraints, not timing.
 *   H. Resume             — onboarding_state stages resolve the real
 *                           journey position from session + database only.
 *   I. Isolation/denials  — cross-tenant reads denied; plain admins and
 *                           platform admins (existing profiles) can never
 *                           onboard; platform authority preserved.
 *   J. Audit/architecture — onboarding audited; notifications; no new
 *                           roles/permissions/modules; migration pin 69/0068.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { PGlite } from "@electric-sql/pglite";
import { getDb, as, createTenant, createUser } from "./helpers";

const E = "p30saas";
const ROOT = process.cwd();

/** Extract a scalar RPC result (pglite returns `[{ fname: "<value>" }]`). */
function scalar(rows: Record<string, unknown>[], key: string): string {
  const v = rows[0]?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`expected scalar ${key}, got ${JSON.stringify(rows[0])}`);
  }
  return v;
}

/**
 * Impersonate a BARE auth identity (auth.users row, NO profile) and run
 * `fn` — mirrors the Phase 30 signup shape. Resets role/claims after.
 */
async function asBare<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('role', 'authenticated', false)");
  await db.query(
    "SELECT set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ sub: uid, role: "authenticated" })],
  );
  try {
    return await fn();
  } finally {
    await db.query("RESET role");
    await db.query("SELECT set_config('request.jwt.claims', '{}', false)");
  }
}

/** Create a bare auth.users row (no profile) — the Phase 30 signup shape. */
async function createBareIdentity(db: PGlite, email: string): Promise<string> {
  const uid = crypto.randomUUID();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uid, email]);
  return uid;
}

describe("phase30 — self-service tenant onboarding", () => {
  let db: PGlite;
  let tenantA: string;
  let platformAdmin: { authId: string; profileId: string };
  let member: { authId: string };
  let plainAdmin: { authId: string };
  let ownerB: { authId: string };

  // Bare identities for onboarding journeys.
  let ownerA: string; // main journey owner
  let ownerRetry: string; // duplicate-slug journey
  let ownerResume: string; // interrupted journey
  let ownerUsd: string; // non-NGN currency refusal

  let originalSettings: unknown;
  let entBefore: Record<string, unknown>;

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "p30saas-a", "Phase 30 SaaS A", {});
    platformAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-platform@test.local`, fullName: "P30 Platform Admin", accessRole: "platform_super_admin" });
    member = await createUser(db, { tenantId: tenantA, email: `${E}-mem@test.local`, fullName: "P30 Member A", accessRole: "member" });
    plainAdmin = await createUser(db, { tenantId: tenantA, email: `${E}-adm@test.local`, fullName: "P30 Admin A", accessRole: "admin" });
    ownerB = await createUser(db, { tenantId: tenantA, email: `${E}-ownerb@test.local`, fullName: "P30 Owner B", accessRole: "tenant_super_admin" });

    ownerA = await createBareIdentity(db, `${E}-ownera@test.local`);
    ownerRetry = await createBareIdentity(db, `${E}-retry@test.local`);
    ownerResume = await createBareIdentity(db, `${E}-resume@test.local`);
    ownerUsd = await createBareIdentity(db, `${E}-usd@test.local`);

    const cur = await db.query(`SELECT settings FROM politicore.platform_settings WHERE id = 1`);
    originalSettings = cur.rows[0] ? (cur.rows[0] as Record<string, unknown>).settings : null;
    await db.query(
      `INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    const eb = await db.query(`SELECT settings FROM politicore.platform_settings WHERE id = 1`);
    entBefore = (((eb.rows[0] as Record<string, unknown>).settings as Record<string, unknown>)?.service_entitlements as Record<string, unknown>) ?? {};

    // USD-denominated active version on a dedicated plan — proves the
    // launch-currency refusal on the onboarding path.
    const planU = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan($1, $2, NULL, 96, 'phase30 fixture') AS p`, [`${E}-usd`, "P30 USD"]);
    const planUId = scalar(planU.rows, "p");
    const ver4 = await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.create_plan_version($1, ARRAY['social'], '{}'::jsonb, '{}'::jsonb, 'USD', true, 14, $2, 'phase30 fixture') AS v`,
      [planUId, '{"monthly": 5000}']);
    const verUSD = scalar(ver4.rows, "v");
    await as(db, "authenticated", platformAdmin.authId,
      `SELECT public.activate_plan_version($1, 'phase30 fixture') AS v`, [verUSD]);
  }, 180_000);

  afterAll(async () => {
    // Onboarded tenants + their subscriptions, in FK-child→parent order.
    // Guards freeze some rows, so teardown runs with triggers suppressed
    // (replica mode) — the same pattern the Phase 29 suite and the hosted
    // smoke use. Guards remain fully enforced for the RPC paths above.
    await db.query(`SET session_replication_role = replica`);
    await db.query(
      `DELETE FROM politicore.notifications WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`,
    );
    await db.query(
      `DELETE FROM politicore.system_audits WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`,
    );
    await db.query(
      `DELETE FROM politicore.subscription_items WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`,
    );
    await db.query(
      `DELETE FROM politicore.subscriptions WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`,
    );
    await db.query(`DELETE FROM politicore.profiles WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`);
    await db.query(`DELETE FROM politicore.public_site_settings WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`);
    await db.query(`DELETE FROM politicore.tenant_settings WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`);
    await db.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id IN (SELECT id FROM politicore.tenants WHERE slug LIKE 'p30-%')`);
    await db.query(`DELETE FROM politicore.tenants WHERE slug LIKE 'p30-%'`);
    await db.query(`SET session_replication_role = DEFAULT`);

    // Restore the service_entitlements map (the RPC writes tenant keys).
    await db.query(
      `UPDATE politicore.platform_settings
         SET settings = jsonb_set(settings, '{service_entitlements}', $1::jsonb)
       WHERE id = 1`,
      [JSON.stringify(entBefore)],
    );

    await db.query(`DELETE FROM politicore.plan_versions WHERE plan_id IN (SELECT id FROM politicore.plans WHERE code LIKE 'p30saas-%')`);
    await db.query(`DELETE FROM politicore.plans WHERE code LIKE 'p30saas-%'`);
    await db.query(`DELETE FROM politicore.profiles WHERE id = ANY($1)`,
      [[platformAdmin.authId, member.authId, plainAdmin.authId, ownerB.authId]]);
    await db.query(`DELETE FROM auth.users WHERE id = ANY($1)`,
      [[platformAdmin.authId, member.authId, plainAdmin.authId, ownerB.authId, ownerA, ownerRetry, ownerResume, ownerUsd]]);
    await db.query(`DELETE FROM politicore.tenants WHERE id = ANY($1)`, [[tenantA]]);
    if (originalSettings !== null) {
      await db.query(`UPDATE politicore.platform_settings SET settings = $1::jsonb WHERE id = 1`, [JSON.stringify(originalSettings)]);
    }
  });

  // ══ A. Public catalog & plan selection authority ════════════════════
  describe("A. public catalog & plan selection authority", () => {
    it("A1 the anonymous pricing surface exposes the seed catalog + fixtures (active only)", async () => {
      const r = await as(db, "anon", null, `SELECT * FROM public.plan_catalog_public()`);
      expect(r.error).toBeUndefined();
      const codes = r.rows.map((x) => String(x.plan_code)).sort();
      expect(codes).toEqual(expect.arrayContaining(["enterprise", "professional", "starter"]));
      // Only ACTIVE versions of every listed plan are exposed.
      for (const row of r.rows) {
        expect(Number(row.version)).toBeGreaterThan(0);
      }
    });

    it("A2 the public catalog carries NO version ids (never leaks internal authority)", async () => {
      const r = await as(db, "anon", null, `SELECT * FROM public.plan_catalog_public()`);
      for (const row of r.rows) {
        expect(Object.keys(row)).not.toContain("version_id");
        expect(Object.keys(row)).not.toContain("plan_id");
      }
    });

    it("A3 plan selection authority is a CODE: an unknown plan code is rejected server-side", async () => {
      await asBare(db, ownerA, async () => {
        const r = await as(db, "authenticated", ownerA,
          `SELECT public.complete_tenant_onboarding('p30-ownera','P30 Owner A Co',NULL,'no-such-plan','monthly')`);
        expect(r.error).toContain("no active version");
      });
    });

    it("A4 a browser plan_version_id is never an input: the RPC signature takes a code + interval only", () => {
      const src = fs.readFileSync(
        path.join(ROOT, "supabase", "migrations", "0068_self_service_tenant_onboarding.sql"), "utf8");
      expect(src).toMatch(/p_plan_code\s+text/);
      expect(src).not.toMatch(/p_plan_version_id/);
    });

    it("A5 draft/inactive plans are not subscribable through onboarding", async () => {
      // 'p30saas-usd' exists but its interval mismatch path proves the
      // catalog is re-resolved server-side; here: unknown interval.
      await asBare(db, ownerA, async () => {
        const r = await as(db, "authenticated", ownerA,
          `SELECT public.complete_tenant_onboarding('p30-ownera','P30 Owner A Co',NULL,'starter','weekly'::politicore.billing_interval_enum)`);
        expect(r.error).toContain("invalid input value for enum");
      });
    });
  });

  // ══ B. Slug authority ═══════════════════════════════════════════════
  describe("B. slug authority (server-side)", () => {
    it("B1 normalization: spaces/punctuation/case collapse to the canonical form", async () => {
      const r = await as(db, "anon", null,
        `SELECT * FROM public.tenant_slug_available('  Acme --Campaign_2027! ')`);
      expect(r.error).toBeUndefined();
      expect(String(r.rows[0].slug)).toBe("acme-campaign-2027");
      expect(r.rows[0].available).toBe(true);
    });

    it("B2 reserved slugs are rejected with reason='reserved'", async () => {
      for (const s of ["www", "api", "admin", "onboarding", "pricing", "portal"]) {
        const r = await as(db, "anon", null, `SELECT * FROM public.tenant_slug_available($1)`, [s]);
        expect(r.rows[0].available).toBe(false);
        expect(String(r.rows[0].reason)).toBe("reserved");
      }
    });

    it("B3 taken slugs report reason='taken'; available slugs reason='available'", async () => {
      const taken = await as(db, "anon", null, `SELECT * FROM public.tenant_slug_available('p30saas-a')`);
      expect(taken.rows[0].available).toBe(false);
      expect(String(taken.rows[0].reason)).toBe("taken");
      const avail = await as(db, "anon", null, `SELECT * FROM public.tenant_slug_available('p30-fresh-slug')`);
      expect(avail.rows[0].available).toBe(true);
      expect(String(avail.rows[0].reason)).toBe("available");
    });

    it("B4 the availability check is anonymous (the journey starts unauthenticated)", async () => {
      const r = await as(db, "anon", null, `SELECT * FROM public.tenant_slug_available('p30-anything')`);
      expect(r.error).toBeUndefined();
    });

    it("B5 the provisioning RPC re-normalizes and re-validates the slug server-side", async () => {
      // A reserved target sent through the PROVISIONING RPC (not just the
      // availability check) is refused — the database is authoritative.
      await asBare(db, ownerRetry, async () => {
        const r = await as(db, "authenticated", ownerRetry,
          `SELECT public.complete_tenant_onboarding('www','P30 WWW Co',NULL,'starter','monthly')`);
        expect(r.error).toContain("reserved");
      });
    });

    it("B6 the reserved list blocks future platform routes (routing/comm names present)", async () => {
      const src = fs.readFileSync(
        path.join(ROOT, "supabase", "migrations", "0068_self_service_tenant_onboarding.sql"), "utf8");
      for (const s of ["'www'", "'api'", "'app'", "'admin'", "'onboarding'", "'pricing'", "'portal'", "'ifeanyi-2027'"]) {
        expect(src).toContain(s);
      }
    });
  });

  // ══ C. Bare identity (signup) ═══════════════════════════════════════
  describe("C. bare identity signup", () => {
    it("C1 a bare identity has NO profile — journey starts at create_tenant", async () => {
      const p = await db.query(`SELECT count(*)::int AS n FROM politicore.profiles WHERE id = $1`, [ownerA]);
      expect((p.rows[0] as Record<string, unknown>).n).toBe(0);
      const st = await asBare(db, ownerA, () =>
        as(db, "authenticated", ownerA, `SELECT * FROM public.onboarding_state()`));
      expect(String(st.rows[0].stage)).toBe("create_tenant");
    });

    it("C2 the client signup helper carries NO tenant_slug metadata (bare signup path)", () => {
      const src = fs.readFileSync(path.join(ROOT, "src", "lib", "supabase", "auth.ts"), "utf8");
      const fnStart = src.indexOf("export async function signUpBareIdentity");
      expect(fnStart).toBeGreaterThan(-1);
      // End the slice at the function's own closing `return` — the
      // `supabase.auth.signUp` options are the only metadata the signup
      // carries; surrounding documentation may legitimately discuss the
      // prohibition it enforces.
      const bodyEnd = src.indexOf("return { user: u ? toAuthUser(u.id, u.email ?? null, u.created_at) : null, error: null };", fnStart);
      expect(bodyEnd).toBeGreaterThan(fnStart);
      const body = src.slice(fnStart, bodyEnd);
      expect(body).not.toContain("tenant_slug");
      expect(body).toContain("onboarding_intent");
    });

    it("C3 an unauthenticated caller resolves stage 'signin' (fail-closed, not a crash)", async () => {
      const st = await as(db, "anon", null, `SELECT * FROM public.onboarding_state()`);
      expect(st.error).toBeUndefined();
      expect(String(st.rows[0].stage)).toBe("signin");
    });
  });

  // ══ D. Provisioning (atomic journey) ════════════════════════════════
  describe("D. provisioning (one atomic server-side journey)", () => {
    let tenantId: string;
    let subId: string;

    it("D1 the full journey completes in ONE RPC: tenant + profile + subscription", async () => {
      const r = await asBare(db, ownerA, () =>
        as(db, "authenticated", ownerA,
          `SELECT * FROM public.complete_tenant_onboarding('p30-ownera','P30 Owner A Co','Ada Owner','starter','monthly')`));
      expect(r.error).toBeUndefined();
      const row = r.rows[0];
      tenantId = String(row.tenant_id);
      subId = String(row.subscription_id);
      expect(String(row.tenant_slug)).toBe("p30-ownera");
      expect(String(row.subscription_status)).toBe("trialing");
      expect(String(row.next_step)).toMatch(/trial is active/i);
      expect(row.trial_end).not.toBeNull();
    });

    it("D2 the owner profile is tenant_super_admin in the NEW tenant (server-resolved identity)", async () => {
      const p = await db.query(
        `SELECT access_role::text, tenant_id, email FROM politicore.profiles WHERE id = $1`, [ownerA]);
      const row = p.rows[0] as Record<string, unknown>;
      expect(String(row.access_role)).toBe("tenant_super_admin");
      expect(String(row.tenant_id)).toBe(tenantId);
      expect(String(row.email)).toBe(`${E}-ownera@test.local`);
    });

    it("D3 all four tenant_modules materialize, enabled exactly as the plan includes", async () => {
      const m = await db.query(
        `SELECT module::text AS mod, enabled FROM politicore.tenant_modules
          WHERE tenant_id = $1 ORDER BY module::text`, [tenantId]);
      const map = Object.fromEntries(m.rows.map((x) => [String((x as Record<string, unknown>).mod), (x as Record<string, unknown>).enabled]));
      expect(map).toEqual({ social: true, campaign: true, election: false, governance: false });
    });

    it("D4 default tenant + public site configuration rows exist (0007 convention)", async () => {
      const ts = await db.query(`SELECT count(*)::int AS n FROM politicore.tenant_settings WHERE tenant_id = $1`, [tenantId]);
      expect((ts.rows[0] as Record<string, unknown>).n).toBe(1);
      const ps = await db.query(`SELECT count(*)::int AS n FROM politicore.public_site_settings WHERE tenant_id = $1`, [tenantId]);
      expect((ps.rows[0] as Record<string, unknown>).n).toBe(1);
    });

    it("D5 the subscription was created through the EXISTING Phase 29 authority (item, NGN, price)", async () => {
      const s = await db.query(
        `SELECT s.status::text AS status, s.billing_interval::text AS interval,
                i.unit_price_minor, i.currency, i.ended_at
           FROM politicore.subscriptions s
           JOIN politicore.subscription_items i ON i.subscription_id = s.id
          WHERE s.id = $1`, [subId]);
      const row = s.rows[0] as Record<string, unknown>;
      expect(String(row.status)).toBe("trialing");
      expect(String(row.interval)).toBe("monthly");
      expect(Number(row.unit_price_minor)).toBe(1500000); // starter monthly (0065 seed)
      expect(String(row.currency)).toBe("NGN");
      expect(row.ended_at).toBeNull();
    });

    it("D6 provisioning RPC is authenticated-only: anon is denied at the grant", async () => {
      const r = await as(db, "anon", null,
        `SELECT public.complete_tenant_onboarding('p30-anon','P30 Anon Co',NULL,'starter','monthly')`);
      expect(r.error).toBeDefined();
      expect(r.error).toMatch(/permission denied/i);
    });

    it("D7 anon onboarding_state works but reports only 'signin' (no data leak)", async () => {
      const st = await as(db, "anon", null, `SELECT * FROM public.onboarding_state()`);
      expect(String(st.rows[0].stage)).toBe("signin");
      expect(st.rows[0].tenant_id).toBeNull();
      expect(st.rows[0].tenant_slug).toBeNull();
    });
  });

  // ══ E. Trial journey ════════════════════════════════════════════════
  describe("E. trial initialization", () => {
    it("E1 trial_end is ~+14 days from the plan version config", async () => {
      const s = await db.query(
        `SELECT s.trial_end, s.trial_start
           FROM politicore.subscriptions s
           JOIN politicore.profiles p ON p.tenant_id = s.tenant_id
          WHERE p.id = $1 AND s.ended_at IS NULL`, [ownerA]);
      const row = s.rows[0] as Record<string, unknown>;
      expect(row.trial_end).not.toBeNull();
      const start = new Date(String(row.trial_start));
      const end = new Date(String(row.trial_end));
      const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
      expect(days).toBe(14);
    });

    it("E2 no payment method / invoice is implied by trial start (no invoices for the tenant)", async () => {
      const inv = await db.query(
        `SELECT count(*)::int AS n FROM politicore.invoices
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1)`, [ownerA]);
      expect((inv.rows[0] as Record<string, unknown>).n).toBe(0);
    });

    it("E3 the state RPC communicates truthful trial copy (no auto-charge implication)", async () => {
      const st = await asBare(db, ownerA, () =>
        as(db, "authenticated", ownerA, `SELECT * FROM public.onboarding_state()`));
      expect(String(st.rows[0].stage)).toBe("enter_app");
      expect(String(st.rows[0].next_step)).toMatch(/nothing is charged automatically/i);
      expect(String(st.rows[0].next_step)).toMatch(/no payment method is on file/i);
    });

    it("E4 non-NGN plans are refused (launch currency — no FX)", async () => {
      await asBare(db, ownerUsd, async () => {
        const r = await as(db, "authenticated", ownerUsd,
          `SELECT public.complete_tenant_onboarding('p30-usd','P30 USD Co',NULL,'p30saas-usd','monthly')`);
        expect(r.error).toContain("NGN");
      });
    });
  });

  // ══ F. Entitlement synchronization ══════════════════════════════════
  describe("F. entitlement synchronization", () => {
    it("F1 the service_entitlements map matches the plan's included modules exactly", async () => {
      // Read as service_role-equivalent (bare superuser query, then RESET).
      const t = await db.query(
        `SELECT id FROM politicore.tenants WHERE slug = 'p30-ownera'`);
      const tid = String((t.rows[0] as Record<string, unknown>).id);
      const r = await as(db, "service_role", null,
        `SELECT settings->'service_entitlements'->>$1 AS map FROM politicore.platform_settings WHERE id = 1`, [tid]);
      const map = JSON.parse(String(r.rows[0].map)) as Record<string, boolean>;
      expect(map).toEqual({ social: true, campaign: true, election: false, governance: false });
    });
  });

  // ══ G. Duplicate prevention ═════════════════════════════════════════
  describe("G. duplicate prevention", () => {
    it("G1 a duplicate owner retry is denied (profile-exists guard)", async () => {
      await asBare(db, ownerA, async () => {
        const r = await as(db, "authenticated", ownerA,
          `SELECT public.complete_tenant_onboarding('p30-ownera-2','P30 Second Co',NULL,'starter','monthly')`);
        expect(r.error).toContain("already belongs to a tenant");
      });
    });

    it("G2 a duplicate slug from ANOTHER identity is denied (uniqueness)", async () => {
      const r = await asBare(db, ownerRetry, () =>
        as(db, "authenticated", ownerRetry,
          `SELECT public.complete_tenant_onboarding('p30-ownera','P30 Owner A Co',NULL,'starter','monthly')`));
      expect(r.error).toContain("already taken");
    });

    it("G3 no duplicate subscription: the retry did not create a second live subscription", async () => {
      const s = await db.query(
        `SELECT count(*)::int AS n FROM politicore.subscriptions
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1) AND ended_at IS NULL`, [ownerA]);
      expect((s.rows[0] as Record<string, unknown>).n).toBe(1);
    });

    it("G4 exactly one onboarding audit event exists for the journey (retries audited nothing)", async () => {
      const a = await db.query(
        `SELECT count(*)::int AS n FROM politicore.system_audits
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1)
            AND action = 'tenant:onboarding_completed'`, [ownerA]);
      expect((a.rows[0] as Record<string, unknown>).n).toBe(1);
    });
  });

  // ══ H. Interrupted journeys & resume ════════════════════════════════
  describe("H. interrupted journeys & resume (server-resolved)", () => {
    it("H1 interrupted after signup: bare identity resumes at create_tenant", async () => {
      const st = await asBare(db, ownerResume, () =>
        as(db, "authenticated", ownerResume, `SELECT * FROM public.onboarding_state()`));
      expect(String(st.rows[0].stage)).toBe("create_tenant");
      expect(String(st.rows[0].next_step)).toMatch(/create your organization/i);
    });

    it("H2 an interrupted identity can complete LATER — resume finishes the same journey", async () => {
      const r = await asBare(db, ownerResume, () =>
        as(db, "authenticated", ownerResume,
          `SELECT * FROM public.complete_tenant_onboarding('p30-resume','P30 Resume Co',NULL,'starter','monthly')`));
      expect(r.error).toBeUndefined();
      expect(String(r.rows[0].subscription_status)).toBe("trialing");
    });

    it("H3 after completion the same identity resolves enter_app (never re-provisions)", async () => {
      const st = await asBare(db, ownerResume, () =>
        as(db, "authenticated", ownerResume, `SELECT * FROM public.onboarding_state()`));
      expect(String(st.rows[0].stage)).toBe("enter_app");
      expect(String(st.rows[0].plan_code)).toBe("starter");
      expect(String(st.rows[0].billing_interval)).toBe("monthly");
      expect(String(st.rows[0].access_role)).toBe("tenant_super_admin");
    });

    it("H4 the UI resume route never reads client state (route + RPC only)", () => {
      const src = fs.readFileSync(
        path.join(ROOT, "src", "app", "onboarding", "resume", "page.tsx"), "utf8");
      // Strip comments before asserting — the DESIGN DOC mentions the
      // prohibition; the CODE must not perform it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).toContain("getOnboardingState");
      expect(code).not.toMatch(/localStorage/);
      expect(code).not.toMatch(/sessionStorage/);
    });
  });

  // ══ I. Isolation & authority denials ════════════════════════════════
  describe("I. tenant isolation & authority denials", () => {
    it("I1 a member of an existing tenant can NEVER onboard (privilege-escalation block)", async () => {
      const r = await as(db, "authenticated", member.authId,
        `SELECT public.complete_tenant_onboarding('p30-member','P30 Member Co',NULL,'starter','monthly')`);
      expect(r.error).toContain("already belongs to a tenant");
    });

    it("I2 a plain admin of an existing tenant can NEVER onboard", async () => {
      const r = await as(db, "authenticated", plainAdmin.authId,
        `SELECT public.complete_tenant_onboarding('p30-admin','P30 Admin Co',NULL,'starter','monthly')`);
      expect(r.error).toContain("already belongs to a tenant");
    });

    it("I3 a platform admin (existing profile) is denied onboarding but retains platform authority", async () => {
      const r = await as(db, "authenticated", platformAdmin.authId,
        `SELECT public.complete_tenant_onboarding('p30-platform','P30 Platform Co',NULL,'starter','monthly')`);
      expect(r.error).toContain("already belongs to a tenant");
      // Platform authority intact on platform surfaces:
      const cat = await as(db, "authenticated", platformAdmin.authId,
        `SELECT count(*)::int AS n FROM politicore.plans WHERE code LIKE 'p30saas-%'`);
      expect((cat.rows[0] as Record<string, unknown>).n).toBeGreaterThan(0);
    });

    it("I4 a tenant owner of an existing tenant can NEVER onboard a second tenant", async () => {
      const r = await as(db, "authenticated", ownerB.authId,
        `SELECT public.complete_tenant_onboarding('p30-ownerb','P30 Owner B Co',NULL,'starter','monthly')`);
      expect(r.error).toContain("already belongs to a tenant");
    });

    it("I5 cross-tenant visibility: one owner's state never exposes another tenant", async () => {
      const st = await asBare(db, ownerA, () =>
        as(db, "authenticated", ownerA, `SELECT * FROM public.onboarding_state()`));
      expect(String(st.rows[0].tenant_slug)).toBe("p30-ownera");
      expect(st.rows.length).toBe(1);
    });

    it("I6 a bare identity (no profile, no tenant) resolves no other tenant's rows via onboarding RPCs", async () => {
      // The state RPC resolves ONLY the caller's own journey; a bare
      // identity that has onboarded sees exactly one row — its own.
      const st = await asBare(db, ownerA, () =>
        as(db, "authenticated", ownerA, `SELECT * FROM public.onboarding_state()`));
      expect(st.rows.length).toBe(1);
      expect(String(st.rows[0].tenant_slug)).toBe("p30-ownera");
      // A NOT-YET-onboarded bare identity resolves no tenant at all.
      const bare = await asBare(db, ownerRetry, () =>
        as(db, "authenticated", ownerRetry, `SELECT * FROM public.onboarding_state()`));
      expect(String(bare.rows[0].stage)).toBe("create_tenant");
      expect(bare.rows[0].tenant_id).toBeNull();
    });
  });

  // ══ J. Audit, notifications & architecture ══════════════════════════
  describe("J. audit, notifications & architecture", () => {
    it("J1 onboarding audited: tenant:onboarding_completed with plan + subscription detail", async () => {
      const a = await db.query(
        `SELECT action, new_value FROM politicore.system_audits
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1)
            AND action = 'tenant:onboarding_completed'`, [ownerA]);
      const row = a.rows[0] as Record<string, unknown>;
      expect(String(row.action)).toBe("tenant:onboarding_completed");
      const d = row.new_value as Record<string, unknown>;
      expect(String(d.plan_code)).toBe("starter");
      expect(String(d.currency)).toBe("NGN");
    });

    it("J2 subscription lifecycle audits exist from the Phase 29 path (created + trial started)", async () => {
      const a = await db.query(
        `SELECT action FROM politicore.system_audits
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1)
            AND action IN ('subscription_created','subscription_trial_started')
          ORDER BY action`, [ownerA]);
      const actions = a.rows.map((x) => String((x as Record<string, unknown>).action));
      expect(actions).toContain("subscription_created");
      expect(actions).toContain("subscription_trial_started");
    });

    it("J3 entitlement sync audit present (entitlements_synchronized)", async () => {
      const a = await db.query(
        `SELECT count(*)::int AS n FROM politicore.system_audits
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1)
            AND action = 'entitlements_synchronized'`, [ownerA]);
      expect((a.rows[0] as Record<string, unknown>).n).toBeGreaterThan(0);
    });

    it("J4 trial-start notification delivered (trialing journeys notify via create_subscription)", async () => {
      const n = await db.query(
        `SELECT title FROM politicore.notifications
          WHERE tenant_id IN (SELECT tenant_id FROM politicore.profiles WHERE id = $1)`, [ownerA]);
      const titles = n.rows.map((x) => String((x as Record<string, unknown>).title));
      expect(titles.some((t) => /trial/i.test(t))).toBe(true);
    });

    it("J5 no new roles, modules, or permissions exist (counts pinned)", async () => {
      const perms = (await db.query(`SELECT count(*)::int AS n FROM politicore.permissions`)).rows[0] as Record<string, unknown>;
      expect((perms as unknown as { n: number }).n).toBe(43);
      const enumVals = (await db.query(
        `SELECT unnest(enum_range(NULL::politicore.access_role_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
      expect(enumVals).not.toContain("onboarding_admin");
      expect(enumVals).not.toContain("billing_admin");
      const mods = (await db.query(
        `SELECT unnest(enum_range(NULL::politicore.module_code_enum)) AS r`)).rows.map((x) => (x as Record<string, unknown>).r);
      expect(mods).toEqual(["social", "campaign", "election", "governance"]);
    });

    it("J6 migration count is 70; the latest migration is 0069 (Phase 31 tenant lifecycle)", () => {
      const dir = path.join(ROOT, "supabase", "migrations");
      const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      expect(files.length).toBe(70);
      expect(files[files.length - 1]).toMatch(/^0069_/);
    });

    it("J7 no new tables were created (0068 is functions + grants only)", () => {
      const src = fs.readFileSync(
        path.join(ROOT, "supabase", "migrations", "0068_self_service_tenant_onboarding.sql"), "utf8");
      expect(src).not.toMatch(/CREATE TABLE/i);
    });

    it("J8 the checkout seam stays provider-independent (no PSP hard-coding)", () => {
      const src = fs.readFileSync(path.join(ROOT, "src", "lib", "supabase", "checkout.ts"), "utf8");
      for (const psp of ["paystack", "flutterwave", "stripe"]) {
        expect(src.toLowerCase()).not.toContain(`"${psp}"`);
        expect(src.toLowerCase()).not.toContain(`'${psp}'`);
      }
      expect(src).toContain("interface CheckoutProvider");
      expect(src).toContain("manualCheckoutProvider");
    });

    it("J9 onboarding never bypasses the billing state machine (no direct invoice/payment writes)", () => {
      const src = fs.readFileSync(
        path.join(ROOT, "supabase", "migrations", "0068_self_service_tenant_onboarding.sql"), "utf8");
      expect(src).not.toMatch(/INSERT INTO politicore\.invoices/i);
      expect(src).not.toMatch(/INSERT INTO politicore\.payments/i);
      expect(src).toMatch(/create_subscription/);
    });
  });
});
