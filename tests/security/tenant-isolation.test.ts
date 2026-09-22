import { describe, it, expect, beforeAll } from "vitest";
import {
  getDb,
  as,
  createUser,
  createTenant,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: Awaited<ReturnType<typeof getDb>>;
let adminA: { authId: string };
let memberA: { authId: string };
let adminB: { authId: string };
let memberB: { authId: string };

beforeAll(async () => {
  db = await getDb();
  // Two tenants, each with an admin and a plain member
  await createTenant(db, "tenant-a", "Tenant A", { campaign: true, election: true }, TENANT_A);
  await createTenant(db, "tenant-b", "Tenant B", { campaign: true, election: true }, TENANT_B);

  adminA = await createUser(db, {
    tenantId: TENANT_A, email: "admin@a.test", fullName: "Admin A", accessRole: "admin",
    membershipTypes: ["campaign_member"],
  });
  memberA = await createUser(db, {
    tenantId: TENANT_A, email: "member@a.test", fullName: "Member A",
    membershipTypes: ["campaign_member", "social_member"],
  });
  adminB = await createUser(db, {
    tenantId: TENANT_B, email: "admin@b.test", fullName: "Admin B", accessRole: "admin",
    membershipTypes: ["campaign_member"],
  });
  memberB = await createUser(db, {
    tenantId: TENANT_B, email: "member@b.test", fullName: "Member B",
    membershipTypes: ["campaign_member"],
  });

  // governance disabled for Tenant B (module-gating fixture)
  await db.query(
    `UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'governance'`,
    [TENANT_B]
  );
});

describe("tenant isolation — profiles", () => {
  it("admin of tenant A cannot read tenant B profiles", async () => {
    const r = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int AS n FROM politicore.profiles WHERE tenant_id = $1`, [TENANT_B]);
    expect(r.error).toBeUndefined();
    expect(r.rows[0].n).toBe(0);
  });

  it("admin of tenant A cannot update a tenant B profile", async () => {
    // RLS filters the row out: statement succeeds but modifies nothing.
    await as(db, "authenticated", adminA.authId,
      `UPDATE politicore.profiles SET full_name = 'HACKED' WHERE tenant_id = $1`, [TENANT_B]);
    const check = await as(db, "service_role", null,
      `SELECT full_name FROM politicore.profiles WHERE email = 'member@b.test'`);
    expect(check.rows[0].full_name).toBe("Member B");
  });

  it("admin of tenant A cannot delete a tenant B profile", async () => {
    await as(db, "authenticated", adminA.authId,
      `DELETE FROM politicore.profiles WHERE email = 'member@b.test'`);
    const check = await as(db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.profiles WHERE email = 'member@b.test'`);
    expect(check.rows[0].n).toBe(1);
  });
});

describe("tenant isolation — authorization records", () => {
  it("admin A cannot read tenant B assignments", async () => {
    const r = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int AS n FROM politicore.organizational_assignments WHERE tenant_id = $1`, [TENANT_B]);
    expect(r.rows[0].n).toBe(0);
  });

  it("admin A cannot create an assignment in tenant B (cross-tenant admin)", async () => {
    const r = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1, $2, 'ward_coordinator', 'lga', 'nkanu-west')`, [TENANT_B, adminB.authId]);
    expect(r.error).toBeDefined(); // WITH CHECK fails
  });

  it("admin A cannot create a permission grant in tenant B", async () => {
    const r = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.permission_grants (tenant_id, user_id, permission, granted)
       VALUES ($1, $2, 'view_dashboard', true)`, [TENANT_B, memberB.authId]);
    expect(r.error).toBeDefined();
  });
});

describe("tenant isolation — notifications & settings", () => {
  it("member A cannot read member B notifications", async () => {
    // seed a notification for memberB as service role
    await db.query(
      `INSERT INTO politicore.notifications (tenant_id, user_id, type, title, message)
       VALUES ($1, $2, 'system', 'B secret', 'private')`, [TENANT_B, memberB.authId]);
    const r = await as(db, "authenticated", memberA.authId,
      `SELECT count(*)::int AS n FROM politicore.notifications`);
    expect(r.rows[0].n).toBe(0);
  });

  it("member A cannot see tenant B tenant_settings row", async () => {
    const r = await as(db, "authenticated", memberA.authId,
      `SELECT count(*)::int AS n FROM politicore.tenant_settings WHERE tenant_id = $1`, [TENANT_B]);
    expect(r.rows[0].n).toBe(0);
  });
});

describe("tenant isolation — tenant registry", () => {
  it("a tenant member sees only their own tenant row", async () => {
    const r = await as(db, "authenticated", memberA.authId,
      `SELECT id FROM politicore.tenants`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].id).toBe(TENANT_A);
  });

  it("tenant admin cannot update another tenant row", async () => {
    await as(db, "authenticated", adminA.authId,
      `UPDATE politicore.tenants SET name = 'HACKED' WHERE id = $1`, [TENANT_B]);
    const check = await as(db, "service_role", null,
      `SELECT name FROM politicore.tenants WHERE id = $1`, [TENANT_B]);
    expect(check.rows[0].name).not.toBe("HACKED");
  });

  it("tenant admin cannot flip another tenant's module flags", async () => {
    await as(db, "authenticated", adminA.authId,
      `UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'governance'`, [TENANT_B]);
    const check = await as(db, "service_role", null,
      `SELECT enabled FROM politicore.tenant_modules WHERE tenant_id = $1 AND module = 'governance'`, [TENANT_B]);
    expect(check.rows[0].enabled).toBe(false);
  });
});
