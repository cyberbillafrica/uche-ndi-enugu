/**
 * POLITICORE — Phase 1B security tests.
 *
 * Covers the Phase 1B surface on top of the Phase 1A suites:
 *  - tenant provisioning (bootstrap + post-bootstrap refusal, incl. the
 *    0010 NULL-bypass regression found in hosted acceptance testing)
 *  - signup profile backfill (member ≠ public-participant seam)
 *  - custom access token hook claims (stable identity context only)
 *  - notifications RPC semantics (own-rows only, unread count)
 *  - module activation audit (server-side audit trail)
 *  - officer boundary (election_officer ≠ tenant admin authority)
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  as,
  assign,
  createTenant,
  createUser,
  getDb,
  TENANT_A,
  TENANT_B,
} from "./helpers";
import { applyMigrations } from "../../scripts/db/apply-migrations";

let db: PGlite;

beforeAll(async () => {
  db = await getDb();
  // Each test file gets a fresh database — recreate the fixture tenants.
  await createTenant(db, "tenant-a", "Tenant A", { social: true, campaign: true, election: true }, TENANT_A);
  await createTenant(db, "tenant-b", "Tenant B", {}, TENANT_B);
});

// ── fixtures: auth user + profile without going through the trigger ─────────
async function makeUser(opts: {
  tenantId?: string;
  email?: string;
  accessRole?: string;
  memberships?: string[];
}) {
  return createUser(db, {
    tenantId: opts.tenantId ?? TENANT_A,
    email: opts.email ?? `${crypto.randomUUID()}@test.local`,
    fullName: "Test User",
    accessRole: opts.accessRole ?? "member",
    membershipTypes: opts.memberships ?? [],
  });
}

let platformAdmin: { authId: string } | null = null;

/** Provision as a real platform_super_admin fixture (JWT in place). */
async function provisionAs(slug: string, name: string, email: string): Promise<string> {
  if (!platformAdmin) {
    platformAdmin = await makeUser({ email: "platform-admin@test.local", accessRole: "platform_super_admin" });
  }
  const r = await as(db, "authenticated", platformAdmin.authId,
    `SELECT (politicore.provision_tenant($1,$2,$3)).tenant_id AS tenant_id`, [slug, name, email]);
  if (r.error || !r.rows.length) throw new Error(r.error ?? "provision failed");
  return r.rows[0].tenant_id as string;
}

describe("tenant provisioning (0007 + 0010)", () => {
  it("provision_tenant creates tenant, all four module rows, and settings", async () => {
    const tenantId = await provisionAs("prov-test-1", "Prov Test One", "owner@prov.test");
    expect(tenantId).toBeTruthy();

    const mods = await db.query<{ module: string; enabled: boolean }>(
      `SELECT module::text, enabled FROM politicore.tenant_modules WHERE tenant_id = $1 ORDER BY module`,
      [tenantId]
    );
    expect(mods.rows.map((m) => `${m.module}:${m.enabled}`)).toEqual([
      "campaign:false",
      "election:false",
      "governance:false",
      "social:false",
    ]);

    const settings = await db.query<{ ts: number; ps: number }>(
      `SELECT (SELECT count(*)::int FROM politicore.tenant_settings WHERE tenant_id = $1) ts,
              (SELECT count(*)::int FROM politicore.public_site_settings WHERE tenant_id = $1) ps`,
      [tenantId]
    );
    expect(settings.rows[0].ts).toBe(1);
    expect(settings.rows[0].ps).toBe(1);
  });

  it("is refused for a non-platform-admin caller (0010 NULL-bypass regression)", async () => {
    // An authenticated caller with a JWT but no profile and no platform role:
    // is_platform_admin() is NULL — the 0007 version silently allowed this.
    const stranger = crypto.randomUUID();
    const err = await as(db, "authenticated", stranger, `SELECT politicore.provision_tenant('sneaky-1b','Sneaky 1B','x@y.test')`);
    expect(err.error).toMatch(/requires platform_super_admin/i);
  });

  it("is refused for a plain member after bootstrap", async () => {
    const u = await makeUser({ email: "plain-member@prov.test" });
    const err = await as(db, "authenticated", u.authId,
      `SELECT politicore.provision_tenant('sneaky-2','Sneaky 2','x@y.test')`);
    expect(err.error).toMatch(/requires platform_super_admin/i);
  });

  it("is refused for duplicate slug and invalid slug", async () => {
    await provisionAs("prov-dup", "Prov Dup", "o@dup.test");
    const dup = await as(db, "authenticated", platformAdmin!.authId,
      `SELECT politicore.provision_tenant('prov-dup','Prov Dup 2','o2@dup.test')`);
    expect(dup.error ?? "").toMatch(/already exists/i);
    const bad = await as(db, "authenticated", platformAdmin!.authId,
      `SELECT politicore.provision_tenant('Bad Slug!','x','o@x.test')`);
    expect(bad.error ?? "").toMatch(/invalid tenant slug/i);
  });
});

describe("signup profile backfill (member ≠ public participant)", () => {
  it("creates a plain member profile for a provisioned signup", async () => {
    await provisionAs("backfill-t", "Backfill T", "owner@bf.test");
    const uid = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1,'bf-member@test.local', jsonb_build_object('tenant_slug','backfill-t','full_name','BF Member'))`,
      [uid]
    );
    const p = await db.query<{ access_role: string; membership_types: string[] }>(
      `SELECT access_role::text, membership_types::text[] FROM politicore.profiles WHERE id = $1`,
      [uid]
    );
    expect(p.rows.length).toBe(1);
    expect(p.rows[0].access_role).toBe("member");
    expect(p.rows[0].membership_types).toEqual([]);
  });

  it("creates NO profile when signup metadata has no tenant_slug", async () => {
    const uid = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1,'bare@test.local','{}'::jsonb)`,
      [uid]
    );
    const p = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM politicore.profiles WHERE id = $1`, [uid]);
    expect(p.rows[0].n).toBe(0);
  });

  it("rejects signups referencing an unknown tenant_slug", async () => {
    const uid = crypto.randomUUID();
    // pglite surfaces trigger errors as thrown exceptions (the hosted
    // PostgREST/auth path returns them as HTTP errors instead) — accept
    // either as evidence of rejection.
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1,'badslug@test.local', jsonb_build_object('tenant_slug','no-such-tenant'))`,
        [uid]
      );
    } catch (e) {
      rejected = true;
      expect(String(e)).toMatch(/unknown tenant_slug/i);
    }
    const left = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM politicore.profiles WHERE id = $1`, [uid]);
    expect(left.rows[0].n).toBe(0); // no profile was created
    expect(rejected).toBe(true); // and the signup itself failed
  });
});

describe("custom access token hook (0006)", () => {
  it("embeds only tenant_id and access_role for an active member", async () => {
    const u = await makeUser({ email: "hook-user@test.local", accessRole: "election_officer" });
    const r = await db.query<{ out: { claims: { app_metadata: Record<string, unknown> } } }>(
      `SELECT politicore.custom_access_token_hook(jsonb_build_object('claims', jsonb_build_object('sub', $1::uuid))) AS out`,
      [u.authId]
    );
    const am = r.rows[0].out.claims.app_metadata;
    expect(am.tenant_id).toBe(TENANT_A);
    expect(am.access_role).toBe("election_officer");
    expect(Object.keys(am).sort()).toEqual(["access_role", "tenant_id"]);
  });

  it("sets null claims for an unknown subject", async () => {
    const r = await db.query<{ out: { claims: { app_metadata: Record<string, unknown> } } }>(
      `SELECT politicore.custom_access_token_hook('{"claims":{"sub":"00000000-0000-0000-0000-000000000000"}}'::jsonb) AS out`
    );
    expect(r.rows[0].out.claims.app_metadata.tenant_id).toBeNull();
    expect(r.rows[0].out.claims.app_metadata.access_role).toBeNull();
  });

  it("does not embed a suspended member's context", async () => {
    const u = await makeUser({ email: "hook-susp@test.local" });
    await db.query(`UPDATE politicore.profiles SET lifecycle_status = 'suspended' WHERE id = $1`, [u.authId]);
    const r = await db.query<{ out: { claims: { app_metadata: Record<string, unknown> } } }>(
      `SELECT politicore.custom_access_token_hook(jsonb_build_object('claims', jsonb_build_object('sub', $1::uuid))) AS out`,
      [u.authId]
    );
    expect(r.rows[0].out.claims.app_metadata.tenant_id).toBeNull();
  });
});

describe("notifications RPCs (0007/0008)", () => {
  it("mark_notifications_read marks only the caller's own rows", async () => {
    const owner = await makeUser({ email: "notif-owner@test.local" });
    const other = await makeUser({ email: "notif-other@test.local" });

    // Seed notifications as postgres (RLS owner path).
    await db.query(
      `INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message)
       VALUES ($1,$2,'system','t1','m1'), ($1,$3,'system','t2','m2')`,
      [TENANT_A, owner.authId, other.authId]
    );

    const ids = await db.query<{ id: string }>(
      `SELECT id FROM politicore.notifications WHERE user_id = $1 ORDER BY created_at`,
      [other.authId]
    );

    // owner (an admin fixture? no — use service path) tries to mark other's rows:
    const r = await as(db, "authenticated", owner.authId,
      `SELECT politicore.mark_notifications_read($1::uuid[])`, [ids.rows.map((x) => x.id)]);
    expect(r.rows[0].mark_notifications_read).toBe(0);

    // other marks their own:
    const r2 = await as(db, "authenticated", other.authId,
      `SELECT politicore.mark_notifications_read($1::uuid[])`, [ids.rows.map((x) => x.id)]);
    expect(r2.rows[0].mark_notifications_read).toBe(ids.rows.length);
  });

  it("my_unread_count reflects only the caller's rows", async () => {
    const u = await makeUser({ email: "notif-count@test.local" });
    await db.query(
      `INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message)
       VALUES ($1,$2,'system','a','a'), ($1,$2,'system','b','b')`,
      [TENANT_A, u.authId]
    );
    const r = await as(db, "authenticated", u.authId, `SELECT politicore.my_unread_count() AS n`);
    expect(Number(r.rows[0].n)).toBe(2);
  });

  it("keeps notification inserts admin-only (ordinary member denied)", async () => {
    const member = await makeUser({ email: "notif-member@test.local" });
    const target = await makeUser({ email: "notif-target@test.local" });
    const err = await as(db, "authenticated", member.authId,
      `INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message)
       VALUES ($1,$2,'system','x','y')`,
      [TENANT_A, target.authId]);
    expect(err.error).toBeDefined(); // no policy permits member inserts
  });
});

describe("module activation audit (0007)", () => {
  it("writes a server-side audit row when a tenant admin flips a module", async () => {
    const tenantId = await provisionAs("audit-mod-t", "Audit Mod T", "o@amt.test");

    const admin = await createUser(db, {
      tenantId,
      email: "mod-admin@test.local",
      fullName: "Mod Admin",
      accessRole: "admin",
    });

    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM politicore.system_audits WHERE affected_resource = 'tenant_modules'`
    );
    await as(db, "authenticated", admin.authId,
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'election'`,
      [tenantId]);
    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM politicore.system_audits WHERE affected_resource = 'tenant_modules'`
    );
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n) + 1);
  });
});

describe("officer boundary (Phase 1A semantics preserved)", () => {
  it("election_officer still lacks tenant-admin authority", async () => {
    const officer = await makeUser({ email: "officer-1b@test.local", accessRole: "election_officer" });
    const admin = await makeUser({ email: "admin-1b@test.local", accessRole: "admin" });

    const officerTenantAdmin = await as(db, "authenticated", officer.authId,
      `SELECT politicore.is_tenant_admin() AS v`);
    const adminTenantAdmin = await as(db, "authenticated", admin.authId,
      `SELECT politicore.is_tenant_admin() AS v`);
    expect(officerTenantAdmin.rows[0].v).toBe(false);
    expect(adminTenantAdmin.rows[0].v).toBe(true);

    // officer cannot manage grants (tenant-admin-only policy)
    const grantErr = await as(db, "authenticated", officer.authId,
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $1, 'view_dashboard', true)`, [TENANT_A]);
    expect(grantErr.error).toBeDefined();
  });

  it("registered location still grants no organizational authority", async () => {
    const lga = (await db.query<{ id: string }>(`SELECT id FROM politicore.lgas LIMIT 1`)).rows[0].id;
    const resident = await createUser(db, {
      tenantId: TENANT_A,
      email: "resident-1b@test.local",
      fullName: "Resident",
      lgaId: lga,
    });
    const canManage = await as(db, "authenticated", resident.authId,
      `SELECT politicore.has_permission('manage_members') AS v`);
    expect(canManage.rows[0].v).toBe(false);
  });
});
