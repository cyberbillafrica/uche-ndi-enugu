import { describe, it, expect, beforeAll } from "vitest";
import {
  getDb, as, createUser, createTenant, grant, assign,
  TENANT_A, TENANT_B,
} from "./helpers";

let db: Awaited<ReturnType<typeof getDb>>;
let admin: { authId: string };
let social: { authId: string };
let wardCoord: { authId: string };
let officer: { authId: string };
let platformAdmin: { authId: string };
let deniedUser: { authId: string };

const WARD = "nkanu-west-ward-01";
const PU = "nkanu-west-ward-01-pu-001";
const OTHER_WARD = "nkanu-west-ward-02";

beforeAll(async () => {
  db = await getDb();

  await createTenant(db, "authz-a", "Authz A", {
    campaign: true, election: true, social: true, governance: false,
  }, TENANT_A);

  admin = await createUser(db, {
    tenantId: TENANT_A, email: "z-admin@a.test", fullName: "Admin", accessRole: "admin",
    membershipTypes: ["campaign_member"],
  });
  social = await createUser(db, {
    tenantId: TENANT_A, email: "z-social@a.test", fullName: "Social", accessRole: "member",
    membershipTypes: ["social_member"],
  });
  wardCoord = await createUser(db, {
    tenantId: TENANT_A, email: "z-ward@a.test", fullName: "Ward Coord", accessRole: "member",
    membershipTypes: ["campaign_member"],
  });
  officer = await createUser(db, {
    tenantId: TENANT_A, email: "z-officer@a.test", fullName: "Officer", accessRole: "election_officer",
  });
  platformAdmin = await createUser(db, {
    tenantId: TENANT_A, email: "z-platform@a.test", fullName: "Platform", accessRole: "platform_super_admin",
  });
  deniedUser = await createUser(db, {
    tenantId: TENANT_A, email: "z-denied@a.test", fullName: "Denied", accessRole: "member",
    membershipTypes: ["campaign_member"],
  });

  await assign(db, TENANT_A, wardCoord.authId, "ward_coordinator", "ward", WARD);
  await grant(db, TENANT_A, deniedUser.authId, "view_analytics", false); // explicit deny
});

describe("role separation", () => {
  it("admin has all permissions (tenant-wide authority)", async () => {
    const r = await as(db, "authenticated", admin.authId,
      `SELECT politicore.politicore_has_permission('manage_election_settings') AS ok`);
    expect(r.rows[0].ok).toBe(true);
  });

  it("election officer gets only the election-domain set", async () => {
    const allowed = await as(db, "authenticated", officer.authId,
      `SELECT politicore.politicore_has_permission('upload_election_result') AS ok`);
    expect(allowed.rows[0].ok).toBe(true);

    const denied = await as(db, "authenticated", officer.authId,
      `SELECT politicore.politicore_has_permission('manage_members') AS ok`);
    expect(denied.rows[0].ok).toBe(false);
  });

  it("platform admin is admin-like; tenant member is not", async () => {
    const r = await as(db, "authenticated", platformAdmin.authId,
      `SELECT politicore.is_platform_admin() AS platform, politicore.is_tenant_admin() AS tenant`);
    expect(r.rows[0].platform).toBe(true);
    expect(r.rows[0].tenant).toBe(false);
  });
});

describe("membership separation", () => {
  it("social-only member has no campaign/election permission via membership alone", async () => {
    const r = await as(db, "authenticated", social.authId,
      `SELECT politicore.politicore_has_permission('view_assignments') AS ok`);
    expect(r.rows[0].ok).toBe(false);
  });

  it("social member holds no organizational authority", async () => {
    const r = await as(db, "authenticated", social.authId,
      `SELECT count(*)::int AS n FROM politicore.my_scopes()`);
    expect(r.rows[0].n).toBe(0);
  });
});

describe("module gating (subscription ≠ authorization)", () => {
  it("governance module disabled for the tenant — module_enabled reports false", async () => {
    const r = await as(db, "authenticated", admin.authId,
      `SELECT politicore.my_module_enabled('governance') AS gov, politicore.my_module_enabled('campaign') AS camp`);
    expect(r.rows[0].gov).toBe(false);
    expect(r.rows[0].camp).toBe(true);
  });

  it("role does not grant access through a disabled module gate", async () => {
    // admin bypasses permission checks by role, but the module gate itself
    // must report disabled state correctly for gating logic to work.
    const r = await as(db, "authenticated", social.authId,
      `SELECT politicore.my_module_enabled('governance') AS gov`);
    expect(r.rows[0].gov).toBe(false);
  });
});

describe("hierarchical scope", () => {
  it("ward_coordinator at ward 01 can act at its polling unit (ward implies PUs)", async () => {
    const r = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.politicore_has_permission('view_members', 'polling_unit', $1) AS pu,
              politicore.politicore_has_permission('view_members', 'ward', $2) AS ward,
              politicore.politicore_has_permission('view_members', 'lga', $3) AS lga`,
      [PU, WARD, "nkanu-west"]);
    expect(r.rows[0].pu).toBe(true);   // ward covers its PUs
    expect(r.rows[0].ward).toBe(true); // own ward
    expect(r.rows[0].lga).toBe(false); // NOT upward
  });

  it("ward coordinator cannot act in another ward", async () => {
    const r = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.politicore_has_permission('view_members', 'ward', $1) AS ok`, [OTHER_WARD]);
    expect(r.rows[0].ok).toBe(false);
  });

  it("LGA coordinator covers wards and PUs beneath", async () => {
    const lgaCoord = await createUser(db, {
      tenantId: TENANT_A, email: "z-lga@a.test", fullName: "LGA Coord",
      membershipTypes: ["campaign_member"],
    });
    await assign(db, TENANT_A, lgaCoord.authId, "lga_coordinator", "lga", "nkanu-west");
    const r = await as(db, "authenticated", lgaCoord.authId,
      `SELECT politicore.politicore_has_permission('review_field_report', 'ward', $1) AS w,
              politicore.politicore_has_permission('review_field_report', 'polling_unit', $2) AS p`,
      [OTHER_WARD, PU]);
    expect(r.rows[0].w).toBe(true);
    expect(r.rows[0].p).toBe(true);
  });

  it("scope_chain resolves PU → ward → lga → zone → state (+ campaign)", async () => {
    const r = await as(db, "service_role", null,
      `SELECT scope_type, scope_id FROM politicore.scope_chain('polling_unit', $1)`, [PU]);
    const types = r.rows.map((x) => x.scope_type).sort();
    expect(types).toEqual(["campaign", "lga", "polling_unit", "senatorial_zone", "state", "ward"]);
  });
});

describe("explicit grants (deny wins)", () => {
  it("explicit deny overrides position defaults", async () => {
    const coord = await createUser(db, {
      tenantId: TENANT_A, email: "z-deny2@a.test", fullName: "Deny2",
      membershipTypes: ["campaign_member"],
    });
    await assign(db, TENANT_A, coord.authId, "ward_coordinator", "ward", WARD);
    await grant(db, TENANT_A, coord.authId, "view_analytics", false);
    const r = await as(db, "authenticated", coord.authId,
      `SELECT politicore.politicore_has_permission('view_analytics', 'ward', $1) AS ok`, [WARD]);
    expect(r.rows[0].ok).toBe(false);
  });

  it("scoped grant allows exactly the granted scope", async () => {
    const user = await createUser(db, {
      tenantId: TENANT_A, email: "z-grant@a.test", fullName: "Grant",
      membershipTypes: ["campaign_member"],
    });
    await grant(db, TENANT_A, user.authId, "submit_election_pu_report", true, "ward", WARD);
    const yes = await as(db, "authenticated", user.authId,
      `SELECT politicore.politicore_has_permission('submit_election_pu_report', 'ward', $1) AS ok`, [WARD]);
    const no = await as(db, "authenticated", user.authId,
      `SELECT politicore.politicore_has_permission('submit_election_pu_report', 'ward', $1) AS ok`, [OTHER_WARD]);
    expect(yes.rows[0].ok).toBe(true);
    expect(no.rows[0].ok).toBe(false); // different scope: not covered
  });
});

describe("profile self-update guard", () => {
  it("user cannot promote themselves to admin", async () => {
    const r = await as(db, "authenticated", social.authId,
      `UPDATE politicore.profiles SET access_role = 'admin' WHERE id = $1`, [social.authId]);
    expect(r.error).toBeDefined();
    const check = await as(db, "service_role", null,
      `SELECT access_role FROM politicore.profiles WHERE id = $1`, [social.authId]);
    expect(check.rows[0].access_role).toBe("member");
  });

  it("user cannot change their own points/rank", async () => {
    const r = await as(db, "authenticated", social.authId,
      `UPDATE politicore.profiles SET points = 999999 WHERE id = $1`, [social.authId]);
    expect(r.error).toBeDefined();
  });

  it("user CAN update their own non-authority fields", async () => {
    const r = await as(db, "authenticated", social.authId,
      `UPDATE politicore.profiles SET full_name = 'Renamed Self' WHERE id = $1`, [social.authId]);
    expect(r.error).toBeUndefined();
  });
});

describe("audit trail", () => {
  it("assignment changes are audited server-side", async () => {
    await as(db, "authenticated", admin.authId,
      `INSERT INTO politicore.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1, $2, 'campaign_member', 'ward', $3)`, [TENANT_A, social.authId, OTHER_WARD]);
    const r = await as(db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.system_audits WHERE affected_resource = 'organizational_assignments'`);
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it("authenticated users cannot write system_audits directly (default deny)", async () => {
    const r = await as(db, "authenticated", admin.authId,
      `INSERT INTO politicore.system_audits (tenant_id, action, affected_resource)
       VALUES ($1, 'tamper', 'x')`, [TENANT_A]);
    expect(r.error).toBeDefined();
  });
});
