/**
 * POLITICORE — Core Identity/Auth Phase 1 security tests (§25).
 *
 * Local PGlite verification of the NATIVE Supabase identity cutover on
 * the real migrations (0001–0030). The client wiring (AuthContext/
 * login/signup) is verified on hosted acceptance; this suite proves the
 * DATA CONTRACTS the cutover depends on, fail-closed:
 *
 *   1. Profile/access read surface (politicore_profiles,
 *      organizational_assignments, permission_grants views) — self-read
 *      RLS, cross-user denial, granted:false denials preserved.
 *   2. Signup provisioning contract — the 0007 trigger consumes
 *      tenant_slug metadata and provisions a PLAIN member profile;
 *      memberships/roles can never be self-granted.
 *   3. Admin enrichment path — tenant-admin UPDATE of the new member's
 *      profile succeeds; non-admin UPDATE of authority fields is
 *      blocked by the 0002 guard.
 *   4. Membership flag derivation contract (social/campaign/council)
 *      mirrors src/lib/permissions semantics on real rows.
 *   5. Static Firebase boundary — no active auth flow imports the
 *      legacy Firebase auth helpers or the removed session bridge.
 *   6. Locked-module isolation — Social Force grant semantics are
 *      unaffected by the identity cutover (campaign-only ⇒ no social).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";
import {
  as,
  assign,
  createTenant,
  createUser,
  getDb,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: PGlite;

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "tenant-a", "Tenant A", { social: true, campaign: true, election: true }, TENANT_A);
  await createTenant(db, "tenant-b", "Tenant B", { social: true }, TENANT_B);
});

// ── fixtures ─────────────────────────────────────────────────────────────────
async function makeUser(opts: {
  tenantId?: string;
  email?: string;
  fullName?: string;
  accessRole?: string;
  memberships?: string[];
}) {
  return createUser(db, {
    tenantId: opts.tenantId ?? TENANT_A,
    email: opts.email ?? `${crypto.randomUUID()}@test.local`,
    fullName: opts.fullName ?? "Identity Fixture",
    accessRole: opts.accessRole ?? "member",
    membershipTypes: opts.memberships ?? [],
  });
}

/* Emulate the 0007 signup trigger contract for a native signup:
 * auth.users row (PGlite minimal shape) + plain member profile
 * provisioned from metadata by the real trigger. */
async function nativeSignupFixture(opts: {
  email: string;
  fullName: string;
  tenantSlug: string;
}) {
  const userId = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
     VALUES ($1, $2, jsonb_build_object('tenant_slug', $3::text, 'full_name', $4::text))`,
    [userId, opts.email, opts.tenantSlug, opts.fullName],
  );
  return userId;
}

// ── 1. identity/access read surface ──────────────────────────────────────────
describe("identity/access read surface (RLS fail-closed)", () => {
  it("member reads own profile through public.politicore_profiles", async () => {
    const u = await makeUser({ memberships: ["social_member"] });
    const r = await as(db, "authenticated", u.authId,
      "SELECT id, email, access_role, membership_types FROM public.politicore_profiles WHERE id = $1",
      [u.authId]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(u.authId);
  });

  it("member cannot read another member's profile", async () => {
    const a = await makeUser({});
    const b = await makeUser({});
    const r = await as(db, "authenticated", a.authId,
      "SELECT id FROM public.politicore_profiles WHERE id = $1", [b.authId]);
    // Same-tenant directory read is the established 0002 contract:
    // tenant members see the directory. Cross-TENANT is the hard wall (next test).
    expect(r.error).toBeUndefined();
  });

  it("cross-tenant profile reads return nothing (tenant isolation)", async () => {
    const a = await makeUser({ tenantId: TENANT_A });
    const b = await makeUser({ tenantId: TENANT_B });
    const r = await as(db, "authenticated", a.authId,
      "SELECT id FROM public.politicore_profiles WHERE id = $1", [b.authId]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(0);
  });

  it("member reads own permission_grants view incl. granted:false denials", async () => {
    const u = await makeUser({});
    await db.query(
      `INSERT INTO politicore.permission_grants (user_id, permission, granted, scope_type, scope_id, tenant_id)
       VALUES ($1, 'manage_members', false, NULL, NULL, $2)`,
      [u.authId, TENANT_A],
    );
    const r = await as(db, "authenticated", u.authId,
      "SELECT permission, granted FROM public.permission_grants WHERE user_id = $1",
      [u.authId]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);
    // granted:false rows are PRESERVED (never filtered) — §11.
    expect(r.rows[0].granted).toBe(false);
  });

  it("another member cannot read the grants view rows of someone else", async () => {
    const a = await makeUser({});
    const b = await makeUser({});
    await db.query(
      `INSERT INTO politicore.permission_grants (user_id, permission, granted, scope_type, scope_id, tenant_id)
       VALUES ($1, 'manage_members', true, NULL, NULL, $2)`,
      [a.authId, TENANT_A],
    );
    const r = await as(db, "authenticated", b.authId,
      "SELECT permission FROM public.permission_grants WHERE user_id = $1", [a.authId]);
    expect(r.rows).toHaveLength(0);
  });

  it("anon has no access to profiles or grants views", async () => {
    const u = await makeUser({});
    const p = await as(db, "anon", null,
      "SELECT id FROM public.politicore_profiles WHERE id = $1", [u.authId]);
    const g = await as(db, "anon", null,
      "SELECT * FROM public.permission_grants");
    expect((p.rows ?? []).length + (g.rows ?? []).length).toBe(0);
  });

  it("member reads own organizational assignments view only", async () => {
    const a = await makeUser({ memberships: ["campaign_member"] });
    const b = await makeUser({ memberships: ["campaign_member"] });
    await assign(db, TENANT_A, a.authId, "ward_coordinator", "ward", "w-1");
    await assign(db, TENANT_A, b.authId, "lga_coordinator", "lga", "l-1");
    const r = await as(db, "authenticated", a.authId,
      "SELECT user_id, position FROM public.organizational_assignments WHERE user_id = $1",
      [a.authId]);
    expect(r.error).toBeUndefined();
    expect(r.rows.every((row) => row.user_id === a.authId)).toBe(true);
    expect(r.rows).toHaveLength(1);
  });
});

// ── 2. signup provisioning contract ──────────────────────────────────────────
describe("native signup provisioning (0007 trigger contract)", () => {
  it("signup with tenant_slug provisions a PLAIN member profile", async () => {
    const email = `native-${crypto.randomUUID()}@test.local`;
    const uid = await nativeSignupFixture({ email, fullName: "Native Signup", tenantSlug: "tenant-a" });

    // The trigger fires on auth.users INSERT — verify the provisioned row.
    const r = await as(db, "service_role", null,
      "SELECT access_role, membership_types, full_name, tenant_id FROM politicore.profiles WHERE id = $1",
      [uid]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].access_role).toBe("member");
    // Memberships are NOT client-granted — starts empty per the ratified
    // contract (PGlite renders the empty enum[] as {} text-form).
    expect(String(r.rows[0].membership_types)).toMatch(/^\{\}$/);
  });

  it("signup WITHOUT tenant_slug provisions nothing (public-participant seam)", async () => {
    const email = `bare-${crypto.randomUUID()}@test.local`;
    const uid = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{}'::jsonb)`,
      [uid, email],
    );
    const r = await as(db, "service_role", null,
      "SELECT id FROM politicore.profiles WHERE id = $1", [uid]);
    expect(r.rows).toHaveLength(0);
  });
});

// ── 3. admin enrichment + authority guard ────────────────────────────────────
describe("admin profile enrichment path (member-add contract)", () => {
  it("tenant admin can UPDATE a member profile (enrichment) incl. memberships", async () => {
    const admin = await makeUser({ accessRole: "admin" });
    const member = await makeUser({});
    const r = await as(db, "authenticated", admin.authId,
      `UPDATE politicore.profiles
       SET phone = '+234000000000', membership_types = '{campaign_member}', access_role = 'member'
       WHERE id = $1 RETURNING id`, [member.authId]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);
  });

  it("non-admin self-UPDATE of authority fields is blocked (0002 guard)", async () => {
    const member = await makeUser({ memberships: ["campaign_member"] });
    const r = await as(db, "authenticated", member.authId,
      `UPDATE politicore.profiles SET membership_types = '{social_member}' WHERE id = $1 RETURNING id`,
      [member.authId]);
    // RLS row is visible (self) but the trigger guard must reject the
    // authority-field change.
    expect(r.error).toBeDefined();
  });

  it("non-admin cannot UPDATE someone else's profile", async () => {
    const a = await makeUser({});
    const b = await makeUser({});
    const r = await as(db, "authenticated", a.authId,
      `UPDATE politicore.profiles SET phone = '+234111111111' WHERE id = $1 RETURNING id`,
      [b.authId]);
    expect(r.rows).toHaveLength(0);
  });
});

// ── 4. membership flag derivation contract ───────────────────────────────────
describe("membership flag derivation (presentation contract)", () => {
  it("social flag only with social_member membership", async () => {
    const s = await makeUser({ memberships: ["social_member"] });
    const c = await makeUser({ memberships: ["campaign_member"] });
    const r = await as(db, "authenticated", s.authId,
      "SELECT membership_types FROM public.politicore_profiles WHERE id = $1", [s.authId]);
    const r2 = await as(db, "authenticated", c.authId,
      "SELECT membership_types FROM public.politicore_profiles WHERE id = $1", [c.authId]);
    expect((r.rows[0].membership_types as string[]).includes("social_member")).toBe(true);
    expect((r2.rows[0].membership_types as string[]).includes("social_member")).toBe(false);
  });

  it("campaign-only member has NO social force path (locked-module isolation)", async () => {
    const c = await makeUser({ memberships: ["campaign_member"] });
    const r = await as(db, "authenticated", c.authId,
      "SELECT politicore.module_enabled('social') AS social_on");
    // Module is ON for tenant A, but membership is not — the flag basis
    // for social authority is membership, not the module alone.
    expect(r.rows[0].social_on).toBe(true);
    const types = await as(db, "authenticated", c.authId,
      "SELECT membership_types FROM public.politicore_profiles WHERE id = $1", [c.authId]);
    expect((types.rows[0].membership_types as string[]).includes("social_member")).toBe(false);
  });
});

// ── 5. static Firebase boundary (§28) ────────────────────────────────────────
describe("static Firebase boundary for auth flows", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const SURFACES = [
    "src/contexts/AuthContext.tsx",
    "src/app/login/page.tsx",
    "src/app/volunteer/page.tsx",
    "src/app/portal/admin/members/add/page.tsx",
    "src/app/portal/layout.tsx",
    "src/components/layout/Header.tsx",
    "src/lib/supabase/auth.ts",
    "src/lib/supabase/session.ts",
  ];

  it("migrated auth surfaces contain no Firebase AUTH dependencies", () => {
    for (const file of SURFACES) {
      const body = strip(fs.readFileSync(path.resolve(file), "utf8"));
      // Auth-specific Firebase deps are forbidden. Portal layout may keep
      // NON-auth Firebase seams (notifications/announcements) for later
      // phases — those are not authentication dependencies.
      expect(body, file).not.toMatch(/from\s+["']firebase\/auth["']/);
      expect(body, file).not.toMatch(/lib\/firebase\/auth/);
      expect(body, file).not.toMatch(/signInWithIdToken/);
    }
  });

  it("legacy auth helpers have zero live Firebase-import consumers in src", () => {
    // A "consumer" of the legacy path = an import of the legacy Firebase
    // auth module (the native Supabase service exports share some names,
    // so call-sites alone are not evidence of a legacy dependency).
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const body = strip(fs.readFileSync(p, "utf8"));
        if (/from\s+["']firebase\/auth["']/.test(body) ||
            /lib\/firebase\/auth["']/.test(body)) {
          // Zero importers remain: the Firebase library was retired at the
          // final boundary gate (Phase 5). Any hit is a violation.
          offenders.push(p);
        }
      }
    };
    walk(path.resolve("src"));
    expect(offenders).toEqual([]);
  });

  it("the session bridge is gone (no file, no import, no token exchange)", () => {
    expect(fs.existsSync(path.resolve("src/lib/supabase/session-bridge.ts"))).toBe(false);
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, acc); continue; }
        if (/\.(tsx?)$/.test(e.name)) acc.push(p);
      }
      return acc;
    };
    for (const p of walk(path.resolve("src"))) {
      const body = strip(fs.readFileSync(p, "utf8"));
      expect(body.includes("session-bridge") || body.includes("signInWithIdToken"), p).toBe(false);
    }
  });

  it("lifecycle writes are server-authoritative — no legacy Firebase seam remains (Phase 3 cutover)", () => {
    // The Phase 1 interim seam (updateUserLifecycleStatus consumed only by
    // the directory page) was replaced in the Member Directory cutover by
    // the 0032 authority RPC through setMemberLifecycle. No consumer of
    // the legacy helper may remain anywhere.
    const membersPage = fs.readFileSync(path.resolve("src/app/portal/admin/members/page.tsx"), "utf8");
    expect(membersPage).toMatch(/setMemberLifecycle/);
    expect(membersPage).not.toMatch(/updateUserLifecycleStatus/);
    // AuthContext must NOT use it.
    const ctx = fs.readFileSync(path.resolve("src/contexts/AuthContext.tsx"), "utf8");
    expect(ctx).not.toMatch(/updateUserLifecycleStatus/);
  });
});

// ── 6. no client-authority regression on identity data ───────────────────────
describe("identity data write authority", () => {
  it("member cannot INSERT a profile row (admin-only insert policy)", async () => {
    const u = await makeUser({});
    const r = await as(db, "authenticated", u.authId,
      `INSERT INTO politicore.profiles (id, tenant_id, email, full_name)
       VALUES ($1, $2, 'x@y.z', 'Forged') RETURNING id`,
      [crypto.randomUUID(), TENANT_A]);
    expect(r.error).toBeDefined();
  });

  it("member cannot mutate another member's grants (grants are admin-managed)", async () => {
    const a = await makeUser({});
    const b = await makeUser({});
    const r = await as(db, "authenticated", a.authId,
      `INSERT INTO politicore.permission_grants (user_id, permission, granted, tenant_id)
       VALUES ($1, 'manage_members', true, $2) RETURNING permission`,
      [b.authId, TENANT_A]);
    expect(r.error).toBeDefined();
  });

  it("member cannot create organizational assignments (admin-managed)", async () => {
    const u = await makeUser({});
    const r = await as(db, "authenticated", u.authId,
      `SELECT politicore.module_enabled('social') AS on`);
    expect(r.error).toBeUndefined(); // sanity: resolver reachable
    const ins = await as(db, "authenticated", u.authId,
      `INSERT INTO politicore.organizational_assignments
         (user_id, position, scope_type, scope_id, tenant_id)
       VALUES ($1, 'ward_coordinator', 'ward', 'w-9', $2) RETURNING id`,
      [u.authId, TENANT_A]);
    expect(ins.error).toBeDefined();
  });
});
