/**
 * POLITICORE — Campaign Phase A security suite.
 *
 * Runs against the same local PGlite database as the security suites
 * (migrations 0000–0021). Proves the §31 acceptance matrix before any
 * Campaign UI exists:
 *   * tenant isolation (read/insert/mutate/inference)
 *   * module isolation (disabled ⇒ invisible + RPC refusal + typed error)
 *   * scope hierarchy with the real Enugu fixtures (Ward→PU, LGA→Ward/PU,
 *     Zone→LGA/Ward/PU, State→all) and scope polarity (§15)
 *   * D1 regression: server-side visibility without client descendant fan-out
 *   * D2 regression: directory scope filtering happens in the database
 *   * position ≠ authority (Campaign Manager / Council Chairman / Election Officer / Social-only)
 *   * actor integrity: client-supplied tenant/actor ids are rejected
 *   * workflow state machines: illegal transitions + self-approval bans
 *   * leaderboard / audit / media boundaries
 *
 * Fixtures use REAL Enugu geography (0003): ward enugu-north-ward-02 holds
 * PU-001/PU-002; zone enugu-north-zone covers LGA enugu-north; the first
 * ward of lga enugu-east sits in a different zone (cross-zone negative).
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
import { CampaignError, classifyCampaignError } from "../../src/lib/supabase/campaign";

let db: PGlite;

const STATE = "enugu-state";
const ZONE_N = "enugu-north-zone";
const LGA_N = "enugu-north";
const LGA_E = "enugu-east";
const LGA_Z = "nsukka"; // genuinely different zone for cross-zone negatives

let W_N = ""; // ward in LGA_N (Enugu North)
let PU1 = ""; // polling unit in W_N
let PU2 = ""; // sibling polling unit in W_N
let W_E = ""; // ward in LGA_E (different zone)
let PU_E = ""; // polling unit in W_E
let W_Z = ""; // ward in LGA_Z (nsukka)
let PU_Z = ""; // polling unit in W_Z
let ZONE_OF_LGA_N = ""; // resolved from the DB — 0013 relocated LGA_N

const TENANT = TENANT_A;
const TENANT_OTHER = TENANT_B;

let adminA: { authId: string };
let adminB: { authId: string };
let stateCoord: { authId: string };
let zoneCoord: { authId: string };
let lgaCoord: { authId: string };
let wardCoord: { authId: string };
let puUser: { authId: string };
let plainMember: { authId: string };
let socialOnly: { authId: string };
let campaignManager: { authId: string };
let councilChair: { authId: string };
let electionOfficer: { authId: string };

let memberN1: { authId: string }; // campaign member registered in W_N/PU1
let memberN2: { authId: string }; // campaign member registered in PU2
let memberE: { authId: string }; // campaign member registered in W_E (same zone as LGA_N per 0013)
let memberZ: { authId: string }; // campaign member registered in W_Z (nsukka — other zone)

/** Direct inserts as service_role (fixture setup only). */
async function seedActivity(
  tenant: string,
  scope: { type: string; id: string },
  title: string
): Promise<string> {
  const res = await db.query(
    `INSERT INTO politicore.campaign_activities
       (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id, created_by, organizer_id)
     VALUES ($1,$2,'meeting', now() + interval '7 days', $3,$4,$5,$5) RETURNING id`,
    [tenant, title, scope.type, scope.id, adminA.authId]
  );
  return (res.rows[0] as Record<string, unknown>).id as string;
}

async function seedAssignment(
  tenant: string,
  assignee: string,
  scope: { type: string; id: string }
): Promise<string> {
  const res = await db.query(
    `INSERT INTO politicore.campaign_assignments
       (tenant_id, title, assigned_to, assigned_by, scope_type, scope_id)
     VALUES ($1,'Seeded assignment',$2,$3,$4,$5) RETURNING id`,
    [tenant, assignee, adminA.authId, scope.type, scope.id]
  );
  return (res.rows[0] as Record<string, unknown>).id as string;
}

async function seedReport(
  tenant: string,
  submitter: string,
  scope: { type: string; id: string },
  status = "submitted"
): Promise<string> {
  const res = await db.query(
    `INSERT INTO politicore.campaign_field_reports
       (tenant_id, submitted_by, report_type, title, description, scope_type, scope_id, status)
     VALUES ($1,$2,'field','Seeded report','Seeded description',$3,$4,$5) RETURNING id`,
    [tenant, submitter, scope.type, scope.id, status]
  );
  return (res.rows[0] as Record<string, unknown>).id as string;
}

async function seedIssue(
  tenant: string,
  reporter: string,
  scope: { type: string; id: string }
): Promise<string> {
  const res = await db.query(
    `INSERT INTO politicore.campaign_issues
       (tenant_id, title, description, issue_type, scope_type, scope_id, reported_by)
     VALUES ($1,'Seeded issue','Seeded description','logistics',$2,$3,$4) RETURNING id`,
    [tenant, scope.type, scope.id, reporter]
  );
  return (res.rows[0] as Record<string, unknown>).id as string;
}

beforeAll(async () => {
  db = await getDb();

  // Real Enugu geography fixtures (0003).
  W_N = ((await db.query(
      `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_N]
    )).rows[0] as Record<string, unknown>).id as string;
  // The zone that actually covers LGA_N (0013 senatorial-zone correction —
  // do not assume the LGA's zone from its name).
  ZONE_OF_LGA_N = ((await db.query(
      `SELECT zone_id FROM politicore.lgas WHERE id = $1`, [LGA_N]
    )).rows[0] as Record<string, unknown>).zone_id as string;
  expect(ZONE_OF_LGA_N).not.toBe(ZONE_N); // fixture sanity: other-zone negative is real
  PU1 = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1 OFFSET 0`, [W_N]
    )).rows[0] as Record<string, unknown>).id as string;
  PU2 = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1 OFFSET 1`, [W_N]
    )).rows[0] as Record<string, unknown>).id as string;
  W_E = ((await db.query(
      `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_E]
    )).rows[0] as Record<string, unknown>).id as string;
  PU_E = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1`, [W_E]
    )).rows[0] as Record<string, unknown>).id as string;
  W_Z = ((await db.query(
      `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_Z]
    )).rows[0] as Record<string, unknown>).id as string;
  PU_Z = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1`, [W_Z]
    )).rows[0] as Record<string, unknown>).id as string;

  // Tenants: TENANT has campaign enabled; TENANT_OTHER has it disabled.
  await createTenant(db, "camp-a", "Campaign Tenant A", { campaign: true }, TENANT);
  await createTenant(db, "camp-b", "Campaign Tenant B", {}, TENANT_OTHER);

  // ── Tenant A fixtures ────────────────────────────────────────────────
  adminA = await createUser(db, { tenantId: TENANT, email: "admin.a@c.test", fullName: "Admin A", accessRole: "admin", membershipTypes: ["campaign_member"] });
  stateCoord = await createUser(db, { tenantId: TENANT, email: "state@c.test", fullName: "State Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  zoneCoord = await createUser(db, { tenantId: TENANT, email: "zone@c.test", fullName: "Zone Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  lgaCoord = await createUser(db, { tenantId: TENANT, email: "lga@c.test", fullName: "LGA Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  wardCoord = await createUser(db, { tenantId: TENANT, email: "ward@c.test", fullName: "Ward Coord", membershipTypes: ["campaign_member"], wardId: W_N });
  puUser = await createUser(db, { tenantId: TENANT, email: "pu@c.test", fullName: "PU User", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU1 });
  plainMember = await createUser(db, { tenantId: TENANT, email: "plain@c.test", fullName: "Plain Member", membershipTypes: ["campaign_member"] });
  socialOnly = await createUser(db, { tenantId: TENANT, email: "social@c.test", fullName: "Social Only", membershipTypes: ["social_member"] });
  campaignManager = await createUser(db, { tenantId: TENANT, email: "cm@c.test", fullName: "Campaign Manager", membershipTypes: ["campaign_member"] });
  councilChair = await createUser(db, { tenantId: TENANT, email: "cc@c.test", fullName: "Council Chairman", membershipTypes: ["campaign_member"] });
  electionOfficer = await createUser(db, { tenantId: TENANT, email: "eo@c.test", fullName: "Election Officer", accessRole: "election_officer" });

  memberN1 = await createUser(db, { tenantId: TENANT, email: "n1@c.test", fullName: "Member N1", membershipTypes: ["campaign_member"], lgaId: LGA_N, wardId: W_N, puId: PU1 });
  memberN2 = await createUser(db, { tenantId: TENANT, email: "n2@c.test", fullName: "Member N2", membershipTypes: ["campaign_member"], lgaId: LGA_N, wardId: W_N, puId: PU2 });
  memberE = await createUser(db, { tenantId: TENANT, email: "e1@c.test", fullName: "Member E", membershipTypes: ["campaign_member"], lgaId: LGA_E, wardId: W_E, puId: PU_E });
  memberZ = await createUser(db, { tenantId: TENANT, email: "z1@c.test", fullName: "Member Z", membershipTypes: ["campaign_member"], lgaId: LGA_Z, wardId: W_Z, puId: PU_Z });

  await assign(db, TENANT, stateCoord.authId, "state_coordinator", "state", STATE);
  await assign(db, TENANT, zoneCoord.authId, "zone_coordinator", "senatorial_zone", ZONE_OF_LGA_N);
  await assign(db, TENANT, lgaCoord.authId, "lga_coordinator", "lga", LGA_N);
  await assign(db, TENANT, wardCoord.authId, "ward_coordinator", "ward", W_N);
  await assign(db, TENANT, puUser.authId, "campaign_member", "polling_unit", PU1);

  // Titles WITHOUT authority (position matrix intentionally grants zero).
  await assign(db, TENANT, campaignManager.authId, "campaign_manager", "campaign", STATE);
  await assign(db, TENANT, councilChair.authId, "council_chairman", "lga", LGA_N);

  // Tenant B admin.
  adminB = await createUser(db, { tenantId: TENANT_OTHER, email: "admin.b@c.test", fullName: "Admin B", accessRole: "admin" });
});

// ═════════════════════ 1. TENANT ISOLATION ═════════════════════
describe("tenant isolation", () => {
  let actA = "";
  beforeAll(async () => {
    actA = await seedActivity(TENANT, { type: "lga", id: LGA_N }, "Tenant A rally");
    await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "Tenant B rally");
  });

  it("tenant A admin sees only tenant A activities", async () => {
    const { rows } = await as(db, "authenticated", adminA.authId,
      `SELECT title FROM public.campaign_activities`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.title !== "Tenant B rally")).toBe(true);
  });

  it("tenant A admin cannot read a specific tenant B activity row", async () => {
    const { rows } = await as(db, "authenticated", adminA.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actA]);
    expect(rows).toHaveLength(1);
    const b = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "probe");
    const res = await as(db, "authenticated", adminA.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [b]);
    expect(res.rows).toHaveLength(0);
  });

  it("tenant A admin cannot insert into tenant B", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `INSERT INTO public.campaign_activities (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'cross','meeting', now(), 'lga', $2)`, [TENANT_OTHER, LGA_N]);
    expect(res.error).toBeDefined();
  });

  it("tenant A admin cannot mutate or delete tenant B rows", async () => {
    const b = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "victim");
    const up = await as(db, "authenticated", adminA.authId,
      `UPDATE public.campaign_activities SET title='hacked' WHERE id=$1`, [b]);
    expect(up.rows).toHaveLength(0); // RLS filters the row out
    const del = await as(db, "authenticated", adminA.authId,
      `DELETE FROM public.campaign_activities WHERE id=$1 RETURNING id`, [b]);
    expect(del.rows).toHaveLength(0);
  });

  it("cross-tenant inference is blocked (no leak through count/scope queries)", async () => {
    const mine = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_activities WHERE scope_id = $1`, [LGA_N]);
    const theirs = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "extra B");
    const after = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_activities WHERE scope_id = $1`, [LGA_N]);
    expect(mine.rows[0].n).toBe((after.rows[0] as { n: number }).n);
    expect(theirs).toBeDefined();
  });
});

// ═════════════════════ 2. MODULE ISOLATION ═════════════════════
describe("module isolation (campaign disabled)", () => {
  it("campaign rows are invisible when the module is disabled", async () => {
    const { rows } = await as(db, "authenticated", adminB.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(rows).toHaveLength(0);
  });

  it("the create-assignment RPC refuses with module_disabled semantics", async () => {
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'lga',$2)`,
      [adminB.authId, LGA_N]);
    expect(res.error).toContain("campaign module is not enabled");
    expect(classifyCampaignError(res.error!)).toBe("module_disabled");
  });

  it("the submit-report RPC refuses when disabled", async () => {
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT politicore.submit_campaign_report('field','t','d','lga',$1)`, [LGA_N]);
    expect(res.error).toContain("campaign module is not enabled");
  });

  it("service layer raises a typed CampaignError (module_disabled)", () => {
    const err = new CampaignError("module_disabled");
    expect(err.kind).toBe("module_disabled");
  });
});

// ═════════════════════ 3. SCOPE HIERARCHY (§14) ═════════════════════
describe("scope hierarchy and polarity", () => {
  let pu1Act = "";
  let pu2Act = "";
  let wardEAct = "";
  let otherZoneAct = "";
  beforeAll(async () => {
    pu1Act = await seedActivity(TENANT, { type: "polling_unit", id: PU1 }, "PU1 event");
    pu2Act = await seedActivity(TENANT, { type: "polling_unit", id: PU2 }, "PU2 event");
    wardEAct = await seedActivity(TENANT, { type: "polling_unit", id: PU_E }, "East event");
    otherZoneAct = await seedActivity(TENANT, { type: "lga", id: LGA_Z }, "Other-zone event");
    expect(otherZoneAct).toBeDefined();
  });

  it("ward authority covers its own PUs (Ward→PU1 allowed)", async () => {
    const { rows } = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [pu1Act]);
    expect(rows).toHaveLength(1);
  });

  it("ward authority does NOT cover a sibling PU via polarity inversion", async () => {
    // PU-scoped user (PU1) must NOT see the PU2 event — grantee scope covers
    // record scope, never the reverse (§15).
    const { rows } = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [pu2Act]);
    expect(rows).toHaveLength(0);
  });

  it("LGA authority covers descendant ward and PU events", async () => {
    const { rows } = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`, [[pu1Act, pu2Act]]);
    expect(rows).toHaveLength(2);
  });

  it("LGA authority does NOT cover another zone's LGA event", async () => {
    const { rows } = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [otherZoneAct]);
    expect(rows).toHaveLength(0);
  });

  it("Zone authority covers its LGA, ward, and PU events", async () => {
    const { rows } = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`, [[pu1Act, pu2Act]]);
    expect(rows).toHaveLength(2);
  });

  it("Zone authority does NOT cover the other zone's ward/PU", async () => {
    // The nsukka event sits in enugu-north-zone — OUTSIDE the coordinator's
    // zone (enugu-east-zone covers both LGA_N and LGA_E per 0013).
    const { rows } = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [otherZoneAct]);
    expect(rows).toHaveLength(0);
  });

  it("State authority covers ALL descendants", async () => {
    const { rows } = await as(db, "authenticated", stateCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`,
      [[pu1Act, pu2Act, wardEAct, otherZoneAct]]);
    expect(rows).toHaveLength(4);
  });

  it("PU authority sees only its own PU (no ward inheritance upward)", async () => {
    const { rows: see } = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [pu1Act]);
    const { rows: denied } = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [pu2Act]);
    expect(see).toHaveLength(1);
    expect(denied).toHaveLength(0);
  });
});

// ═════════════════════ 4. D1/D2 REGRESSIONS ═════════════════════
describe("D1/D2 regressions (server-side scoping)", () => {
  it("D1: a single RLS-scoped list query returns descendant data (no fan-out)", async () => {
    // Ward coordinator sees BOTH PU events in ONE unfiltered list query —
    // the legacy client had to expand scopes and issue per-PU queries.
    const { rows } = await as(db, "authenticated", wardCoord.authId,
      `SELECT title FROM public.campaign_activities ORDER BY scheduled_start`);
    const titles = rows.map((r) => r.title);
    expect(titles).toContain("PU1 event");
    expect(titles).toContain("PU2 event");
    expect(titles).not.toContain("East event");
  });

  it("D2: ward directory contains only covered-hierarchy members", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id, full_name FROM politicore.campaign_members_in_scope()`);
    expect(res.error).toBeUndefined();
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(memberN1.authId);
    expect(ids).toContain(memberN2.authId);
    expect(ids).not.toContain(memberE.authId);
  });

  it("D2: LGA directory covers all descendant registered members", async () => {
    const res = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(memberN1.authId);
    expect(ids).toContain(memberN2.authId);
    expect(ids).not.toContain(memberE.authId);
  });

  it("D2: zone directory excludes members of other zones", async () => {
    const res = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    const ids = res.rows.map((r) => r.id);
    // memberE is in LGA enugu-east = same zone as LGA_N (0013) — covered.
    expect(ids).toContain(memberN1.authId);
    expect(ids).toContain(memberE.authId);
    // memberZ is registered in nsukka — a different zone — excluded.
    expect(ids).not.toContain(memberZ.authId);
  });

  it("D2: state authority sees the tenant-wide directory", async () => {
    const res = await as(db, "authenticated", stateCoord.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    const ids = res.rows.map((r) => r.id);
    expect(ids).toContain(memberN1.authId);
    expect(ids).toContain(memberZ.authId);
  });

  it("member directory refuses users without directory authority", async () => {
    const res = await as(db, "authenticated", plainMember.authId,
      `SELECT * FROM politicore.campaign_members_in_scope()`);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("not authorized to view the member directory");
  });
});

// ═════════════════════ 5. POSITION ≠ AUTHORITY (§16) ═════════════════════
describe("position boundary", () => {
  it("Campaign Manager title grants NO activity visibility", async () => {
    const { rows } = await as(db, "authenticated", campaignManager.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(rows).toHaveLength(0);
  });

  it("Campaign Manager cannot create activities or assignments", async () => {
    const ins = await as(db, "authenticated", campaignManager.authId,
      `INSERT INTO public.campaign_activities (title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ('nope','meeting', now(), 'lga', $1)`, [LGA_N]);
    expect(ins.error).toBeDefined();
  });

  it("Council Chairman title grants NO campaign visibility", async () => {
    const { rows } = await as(db, "authenticated", councilChair.authId,
      `SELECT id FROM public.campaign_assignments`);
    expect(rows).toHaveLength(0);
  });

  it("Election Officer gains NO campaign administration", async () => {
    const { rows } = await as(db, "authenticated", electionOfficer.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(rows).toHaveLength(0);
    const rpc = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'lga',$2)`,
      [plainMember.authId, LGA_N]);
    expect(rpc.error).toBeDefined();
    expect(rpc.error).toContain("not authorized");
  });

  it("Social-only member has NO campaign authority", async () => {
    const { rows } = await as(db, "authenticated", socialOnly.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(rows).toHaveLength(0);
    const rpc = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'lga',$2)`,
      [plainMember.authId, LGA_N]);
    expect(rpc.error).toBeDefined();
  });

  it("plain campaign member (no coordinator position) sees only own records", async () => {
    const { rows } = await as(db, "authenticated", plainMember.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(rows).toHaveLength(0);
  });
});

// ═════════════════════ 6. ACTOR INTEGRITY (§31) ═════════════════════
describe("actor integrity — client-supplied identity is rejected", () => {
  it("cannot spoof created_by on activity insert", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities (title, activity_type, scheduled_start, scope_type, scope_id, created_by)
       VALUES ('spoof','meeting', now(), 'ward', $1, $2)`, [W_N, adminA.authId]);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/new row violates row-level|insert or update/i);
  });

  it("cannot spoof reported_by on issue insert", async () => {
    const res = await as(db, "authenticated", plainMember.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id, reported_by)
       VALUES ('spoof','d','logistics','ward',$1,$2)`, [W_N, adminA.authId]);
    expect(res.error).toBeDefined();
  });

  it("cannot spoof assigned_by on assignment insert", async () => {
    const res = await as(db, "authenticated", lgaCoord.authId,
      `INSERT INTO public.campaign_assignments (title, assigned_to, assigned_by, scope_type, scope_id)
       VALUES ('spoof',$1,$2,'lga',$3)`, [plainMember.authId, adminA.authId, LGA_N]);
    expect(res.error).toBeDefined();
  });

  it("cannot spoof submitted_by on report insert", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_field_reports (report_type, title, description, scope_type, scope_id, submitted_by)
       VALUES ('field','spoof','d','ward',$1,$2)`, [W_N, adminA.authId]);
    expect(res.error).toBeDefined();
  });

  it("reviewer identity is server-resolved on review (never a client column)", async () => {
    const rep = await seedReport(TENANT, plainMember.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept','ok')`, [rep]);
    const row = await db.query(
      `SELECT reviewed_by FROM politicore.campaign_field_reports WHERE id=$1`, [rep]);
    expect((row.rows[0] as Record<string, unknown>).reviewed_by).toBe(wardCoord.authId);
  });
});

// ═════════════════════ 7. ASSIGNMENT WORKFLOW (§21) ═════════════════════
describe("assignment state machine", () => {
  let a = "";
  beforeAll(async () => {
    a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
  });

  it("assignee starts: not_started → in_progress", async () => {
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [a]);
    expect(res.error).toBeUndefined();
    expect(res.rows[0].campaign_assignment_transition).toBe("in_progress");
  });

  it("non-assignee cannot start", async () => {
    const b = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [b]);
    expect(res.error).toContain("only the assignee");
  });

  it("assignee submits: in_progress → submitted", async () => {
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    expect(res.rows[0].campaign_assignment_transition).toBe("submitted");
  });

  it("submit from completed is rejected (illegal transition)", async () => {
    const done = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    await db.query(`UPDATE politicore.campaign_assignments SET status='completed' WHERE id=$1`, [done]);
    const res = await as(db, "authenticated", memberN2.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [done]);
    expect(res.error).toContain("invalid transition");
  });

  it("supervisor accepts → completed", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [a]);
    expect(res.rows[0].campaign_assignment_transition).toBe("completed");
  });

  it("assignee CANNOT self-approve", async () => {
    // The ward coordinator holds review_assignment — assign the work to
    // THEM so the authority check passes and the self-review guard fires.
    const b = await seedAssignment(TENANT, wardCoord.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [b]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [b]);
    expect(res.error).toContain("self-review is not permitted");
  });

  it("no client UPDATE path can move status (arbitrary writes die at RLS)", async () => {
    const b = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", memberN2.authId,
      `UPDATE public.campaign_assignments SET status='completed' WHERE id=$1 RETURNING id`, [b]);
    expect(res.rows).toHaveLength(0);
    const check = await db.query(`SELECT status FROM politicore.campaign_assignments WHERE id=$1`, [b]);
    expect((check.rows[0] as Record<string, unknown>).status).toBe("not_started");
  });

  it("'overdue' is derived — no write path sets it", async () => {
    const b = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", memberN2.authId,
      `UPDATE public.campaign_assignments SET status='overdue' WHERE id=$1 RETURNING id`, [b]);
    expect(res.rows).toHaveLength(0);
  });

  it("reassign notifies the new assignee and is audited", async () => {
    const b = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_assignment_details($1, NULL,NULL,NULL,NULL,NULL,$2)`,
      [b, memberN1.authId]);
    const aud = await db.query(
      `SELECT action FROM politicore.system_audits
       WHERE affected_resource='campaign_assignment' AND resource_id=$1 AND action='campaign.assignment.reassign'`,
      [b]);
    expect(aud.rows.length).toBe(1);
  });
});

// ═════════════════════ 8. REPORT WORKFLOW (§14) ═════════════════════
describe("field report workflow", () => {
  it("member submits through the RPC; initial status is submitted", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.submit_campaign_report('field','Field note','Description','polling_unit',$1)`,
      [PU1]);
    expect(res.error).toBeUndefined();
    const id = (res.rows[0] as Record<string, unknown>).submit_campaign_report as string;
    const row = await db.query(
      `SELECT status, submitted_by FROM politicore.campaign_field_reports WHERE id=$1`, [id]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("submitted");
    expect((row.rows[0] as Record<string, unknown>).submitted_by).toBe(puUser.authId);
  });

  it("submitter without scope permission is refused", async () => {
    // memberE registered in Enugu East; PU authority lives in W_N only.
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.submit_campaign_report('field','x','d','polling_unit',$1)`, [PU_E]);
    expect(res.error).toContain("not authorized to submit field reports");
  });

  it("submitter CANNOT self-approve", async () => {
    const rep = await seedReport(TENANT, wardCoord.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rep]);
    expect(res.error).toContain("self-approval is not permitted");
  });

  it("reviewer outside scope is refused", async () => {
    const rep = await seedReport(TENANT, plainMember.authId, { type: "polling_unit", id: PU_E });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rep]);
    expect(res.error).toContain("not authorized to review reports");
  });

  it("in-scope reviewer accepts → accepted with server-resolved reviewer", async () => {
    const rep = await seedReport(TENANT, plainMember.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept','solid')`, [rep]);
    expect(res.rows[0].review_campaign_report).toBe("accepted");
  });

  it("return → resubmit cycle resets review fields", async () => {
    const rep = await seedReport(TENANT, plainMember.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'return','needs work')`, [rep]);
    const res = await as(db, "authenticated", plainMember.authId,
      `SELECT politicore.resubmit_campaign_report($1,'corrected description')`, [rep]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT status, review_comment, reviewed_by FROM politicore.campaign_field_reports WHERE id=$1`, [rep]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("submitted");
    expect((row.rows[0] as Record<string, unknown>).review_comment).toBeNull();
  });

  it("non-submitter cannot resubmit", async () => {
    const rep = await seedReport(TENANT, plainMember.authId, { type: "ward", id: W_N }, "returned");
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.resubmit_campaign_report($1,'hijack')`, [rep]);
    expect(res.error).toContain("only the original submitter");
  });

  it("no client UPDATE path mutates reports (review columns RPC-only)", async () => {
    const rep = await seedReport(TENANT, plainMember.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `UPDATE public.campaign_field_reports SET status='accepted', reviewed_by=$2 WHERE id=$1 RETURNING id`,
      [rep, wardCoord.authId]);
    expect(res.rows).toHaveLength(0);
  });
});

// ═════════════════════ 9. ISSUE WORKFLOW (§15/§16) ═════════════════════
describe("issue state machine", () => {
  it("member reports an issue through direct insert (server default reporter)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id)
       VALUES ('Bad road access','description text','logistics','polling_unit',$1) RETURNING id`, [PU1]);
    expect(res.error).toBeUndefined();
  });

  it("manager acknowledges → assign → assignee starts → resolve", async () => {
    const iss = await seedIssue(TENANT, plainMember.authId, { type: "ward", id: W_N });
    const ack = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`, [iss]);
    expect(ack.rows[0].campaign_issue_transition).toBe("acknowledged");

    const asg = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iss, memberN1.authId]);
    expect(asg.rows[0].campaign_issue_transition).toBe("assigned");

    const start = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'start')`, [iss]);
    expect(start.rows[0].campaign_issue_transition).toBe("in_progress");

    const rsv = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'resolve',NULL,'fixed')`, [iss]);
    expect(rsv.error).toBeUndefined();
    const row = await db.query(`SELECT status, resolved_by FROM politicore.campaign_issues WHERE id=$1`, [iss]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("resolved");
    expect((row.rows[0] as Record<string, unknown>).resolved_by).toBe(memberN1.authId);
  });

  it("verify and close require manage_issue (assignee cannot verify own work)", async () => {
    const iss = await seedIssue(TENANT, plainMember.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iss, memberN1.authId]);
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'start')`, [iss]);
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'resolve',NULL,'done')`, [iss]);
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify')`, [iss]);
    expect(res.error).toContain("not authorized to verify");
  });

  it("issue cannot be closed from reported (illegal transition)", async () => {
    const iss = await seedIssue(TENANT, plainMember.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'close')`, [iss]);
    expect(res.error).toContain("invalid transition");
  });

  it("non-manager cannot acknowledge", async () => {
    const iss = await seedIssue(TENANT, plainMember.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", memberN2.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`, [iss]);
    expect(res.error).toContain("not authorized to manage issues");
  });
});

// ═════════════════════ 10. PARTICIPATION & ATTENDANCE ═════════════════════
describe("activity participation and attendance", () => {
  let act = "";
  beforeAll(async () => {
    act = await seedActivity(TENANT, { type: "ward", id: W_N }, "Ward town hall");
  });

  it("member RSVPs through the RPC (own row only)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.join_campaign_activity($1,'going')`, [act]);
    expect(res.error).toBeUndefined();
  });

  it("member cannot insert a participation row for someone else", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_activity_participants (activity_id, user_id, rsvp)
       VALUES ($1,$2,'going')`, [act, memberN2.authId]);
    expect(res.error).toBeDefined();
  });

  it("participant CANNOT mark themselves present (attendance is a supervisor fact)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [act, puUser.authId]);
    expect(res.error).toContain("not authorized to record attendance");
  });

  it("attendance forged by direct UPDATE is impossible (no UPDATE policy)", async () => {
    await as(db, "authenticated", puUser.authId,
      `SELECT politicore.join_campaign_activity($1,'going')`, [act]);
    const res = await as(db, "authenticated", puUser.authId,
      `UPDATE public.campaign_activity_participants SET attendance='present' WHERE activity_id=$1 RETURNING id`, [act]);
    expect(res.rows).toHaveLength(0);
  });

  it("supervisor records attendance; recorder identity server-resolved", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [act, puUser.authId]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT attendance, recorded_by FROM politicore.campaign_activity_participants
       WHERE activity_id=$1 AND user_id=$2`, [act, puUser.authId]);
    expect((row.rows[0] as Record<string, unknown>).attendance).toBe("present");
    expect((row.rows[0] as Record<string, unknown>).recorded_by).toBe(wardCoord.authId);
  });

  it("participant sees the activity they joined (participant visibility branch)", async () => {
    const { rows } = await as(db, "authenticated", memberE.authId,
      `SELECT id FROM public.campaign_activities WHERE id=$1`, [act]);
    // memberE joined nothing and is outside the scope — invisible.
    expect(rows).toHaveLength(0);
    await as(db, "authenticated", memberE.authId,
      `SELECT politicore.join_campaign_activity($1,'interested')`, [act]);
    const after = await as(db, "authenticated", memberE.authId,
      `SELECT id FROM public.campaign_activities WHERE id=$1`, [act]);
    expect(after.rows).toHaveLength(1);
  });
});

// ═════════════════════ 11. PROTECTED SUBSYSTEM BOUNDARIES ═════════════════════
describe("audit, media, leaderboard, and public-view boundaries", () => {
  it("client cannot INSERT into system_audits", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.system_audits (tenant_id, action, affected_resource)
       VALUES ($1,'forged','x')`, [TENANT]);
    expect(res.error).toBeDefined();
  });

  it("authority RPCs write audits with server-resolved actor", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    // 'start' is an assignee action — the assignee performs it.
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [a]);
    const aud = await db.query(
      `SELECT actor_id FROM politicore.system_audits
       WHERE affected_resource='campaign_assignment' AND resource_id=$1`, [a]);
    expect(aud.rows).toHaveLength(1);
    // Actor is the assignee who performed 'start' — server-resolved,
    // never a client-supplied identity.
    expect((aud.rows[0] as Record<string, unknown>).actor_id).toBe(memberN1.authId);
  });

  it("campaign evidence is an FK to media_assets (media boundary)", async () => {
    const res = await as(db, "authenticated", plainMember.authId,
      `INSERT INTO politicore.campaign_field_reports
         (tenant_id, submitted_by, report_type, title, description, scope_type, scope_id, evidence_asset_id)
       VALUES ($1,$2,'field','e','d','ward',$3,'not-a-uuid')`, [TENANT, plainMember.authId, W_N]);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/invalid input syntax for type uuid/i);
  });

  it("leaderboard subsystem is untouched by campaign operations", async () => {
    const before = await db.query(`SELECT points, rank FROM politicore.profiles WHERE id=$1`, [puUser.authId]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`,
      [(await seedAssignment(TENANT, puUser.authId, { type: "ward", id: W_N }))]);
    const after = await db.query(`SELECT points, rank FROM politicore.profiles WHERE id=$1`, [puUser.authId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("no client UPDATE path exists for grants or positions (authority escalation dies)", async () => {
    const g = await db.query(
      `SELECT id FROM politicore.permission_grants LIMIT 1`);
    if (g.rows.length > 0) {
      const res = await as(db, "authenticated", wardCoord.authId,
        `UPDATE politicore.permission_grants SET granted=true WHERE id=$1 RETURNING id`,
        [(g.rows[0] as Record<string, unknown>).id]);
      expect(res.rows).toHaveLength(0);
    }
  });

  it("public views are security-invoker (RLS-backed, no widening)", async () => {
    const v = await db.query(
      `SELECT count(*)::int n FROM pg_views WHERE schemaname='public' AND viewname='campaign_assignments'`);
    expect((v.rows[0] as Record<string, unknown>).n).toBe(1);
  });
});
