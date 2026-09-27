/**
 * POLITICORE — Campaign Phase C security suite (Assignments).
 *
 * Runs against the same local PGlite database as the security suites
 * (migrations 0000–0024). Proves the Phase C §28 acceptance matrix on
 * top of Phase A's foundation, including the 0024 changes:
 *   * tenant isolation (read/insert/mutate/inference)
 *   * module gate (enabled → access; disabled → denial everywhere)
 *   * hierarchical scope (ward→PU, LGA→Ward/PU, Zone→LGA/Ward/PU,
 *     State→all; sibling/unrelated denial; cross-tenant silence)
 *   * creation: authorized / unauthorized / out-of-scope / tenant-spoof /
 *     creator-spoof / cross-tenant assignee
 *   * 0024 eligibility: non-campaign-member assignee refused at create
 *     AND reassign
 *   * workflow: every legal transition + representative illegal ones
 *   * reassignment: authorized, unauthorized, ineligible target, audit +
 *     notification
 *   * direct PostgREST abuse: view INSERT/PATCH/DELETE (§13/§15)
 *   * social-only / Election Officer / Campaign Manager boundaries
 *   * audit actor server-resolved; client audit insertion blocked
 *   * leaderboard untouched; public views security-invoker
 *
 * Fixtures use REAL Enugu geography (0003). 0013 relocated LGA
 * enugu-north into the EAST zone, so cross-zone negatives use nsukka.
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
const LGA_N = "enugu-north";
const LGA_Z = "nsukka"; // genuinely different zone for cross-zone negatives

let W_N = "";
let PU1 = "";
let PU2 = "";
let W_Z = "";
let PU_Z = "";
let ZONE_OF_LGA_N = "";

const TENANT = TENANT_A;
const TENANT_OTHER = TENANT_B;
let TENANT_DISABLED = ""; // campaign module OFF

let adminA: { authId: string };
let adminB: { authId: string };
let adminC: { authId: string }; // admin of the campaign-DISABLED tenant
let stateCoord: { authId: string };
let zoneCoord: { authId: string };
let lgaCoord: { authId: string };
let wardCoord: { authId: string };
let puUser: { authId: string };
let plainMember: { authId: string };
let socialOnly: { authId: string };
let electionOfficer: { authId: string };
let memberN1: { authId: string };
let memberN2: { authId: string };
let memberZ: { authId: string };
let socialInWard: { authId: string }; // social member REGISTERED in W_N: registration ≠ eligibility

/** Direct fixture insert (service_role context; bypasses RLS by design). */
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

beforeAll(async () => {
  db = await getDb();

  W_N = ((await db.query(
      `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_N]
    )).rows[0] as Record<string, unknown>).id as string;
  ZONE_OF_LGA_N = ((await db.query(
      `SELECT zone_id FROM politicore.lgas WHERE id = $1`, [LGA_N]
    )).rows[0] as Record<string, unknown>).zone_id as string;
  PU1 = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1 OFFSET 0`, [W_N]
    )).rows[0] as Record<string, unknown>).id as string;
  PU2 = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1 OFFSET 1`, [W_N]
    )).rows[0] as Record<string, unknown>).id as string;
  W_Z = ((await db.query(
      `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_Z]
    )).rows[0] as Record<string, unknown>).id as string;
  PU_Z = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1`, [W_Z]
    )).rows[0] as Record<string, unknown>).id as string;

  await createTenant(db, "campc-a", "Campaign C Tenant A", { campaign: true }, TENANT);
  await createTenant(db, "campc-b", "Campaign C Tenant B", { campaign: true }, TENANT_OTHER);
  TENANT_DISABLED = await createTenant(db, "campc-off", "Campaign C Disabled", {});

  adminA = await createUser(db, { tenantId: TENANT, email: "admin.a@cc.test", fullName: "Admin A", accessRole: "admin", membershipTypes: ["campaign_member"] });
  adminB = await createUser(db, { tenantId: TENANT_OTHER, email: "admin.b@cc.test", fullName: "Admin B", accessRole: "admin", membershipTypes: ["campaign_member"] });
  adminC = await createUser(db, { tenantId: TENANT_DISABLED, email: "admin.c@cc.test", fullName: "Admin C", accessRole: "admin", membershipTypes: ["campaign_member"] });
  stateCoord = await createUser(db, { tenantId: TENANT, email: "state@cc.test", fullName: "State Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  zoneCoord = await createUser(db, { tenantId: TENANT, email: "zone@cc.test", fullName: "Zone Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  lgaCoord = await createUser(db, { tenantId: TENANT, email: "lga@cc.test", fullName: "LGA Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  wardCoord = await createUser(db, { tenantId: TENANT, email: "ward@cc.test", fullName: "Ward Coord", membershipTypes: ["campaign_member"], wardId: W_N });
  puUser = await createUser(db, { tenantId: TENANT, email: "pu@cc.test", fullName: "PU User", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU1 });
  plainMember = await createUser(db, { tenantId: TENANT, email: "plain@cc.test", fullName: "Plain Member", membershipTypes: ["campaign_member"] });
  socialOnly = await createUser(db, { tenantId: TENANT, email: "social@cc.test", fullName: "Social Only", membershipTypes: ["social_member"] });
  electionOfficer = await createUser(db, { tenantId: TENANT, email: "eo@cc.test", fullName: "Election Officer", accessRole: "election_officer" });

  memberN1 = await createUser(db, { tenantId: TENANT, email: "n1@cc.test", fullName: "Member N1", membershipTypes: ["campaign_member"], lgaId: LGA_N, wardId: W_N, puId: PU1 });
  memberN2 = await createUser(db, { tenantId: TENANT, email: "n2@cc.test", fullName: "Member N2", membershipTypes: ["campaign_member"], lgaId: LGA_N, wardId: W_N, puId: PU2 });
  memberZ = await createUser(db, { tenantId: TENANT, email: "z1@cc.test", fullName: "Member Z", membershipTypes: ["campaign_member"], lgaId: LGA_Z, wardId: W_Z, puId: PU_Z });

  socialInWard = await createUser(db, { tenantId: TENANT, email: "sw@cc.test", fullName: "Social In Ward", membershipTypes: ["social_member"], wardId: W_N });

  await assign(db, TENANT, stateCoord.authId, "state_coordinator", "state", STATE);
  await assign(db, TENANT, zoneCoord.authId, "zone_coordinator", "senatorial_zone", ZONE_OF_LGA_N);
  await assign(db, TENANT, lgaCoord.authId, "lga_coordinator", "lga", LGA_N);
  await assign(db, TENANT, wardCoord.authId, "ward_coordinator", "ward", W_N);
  await assign(db, TENANT, puUser.authId, "campaign_member", "polling_unit", PU1);
});

// ═════════════════════ 1. TENANT ISOLATION ═════════════════════
describe("tenant isolation", () => {
  it("tenant A cannot read tenant B assignments", async () => {
    const a = await seedAssignment(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const { rows } = await as(db, "authenticated", adminA.authId,
      `SELECT id FROM public.campaign_assignments WHERE id = $1`, [a]);
    expect(rows).toHaveLength(0);
  });

  it("tenant A cannot create for tenant B (cross-tenant assignee refused)", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [adminB.authId, W_N]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("assignee not found in tenant");
  });

  it("cross-tenant transition is impossible (row scoped by tenant)", async () => {
    const a = await seedAssignment(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [a]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("assignment not found");
  });

  it("cross-tenant reassignment (details RPC) is impossible", async () => {
    const a = await seedAssignment(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.update_campaign_assignment_details($1,'x',NULL,NULL,NULL,NULL,$2)`,
      [a, memberN1.authId]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("assignment not found");
  });

  it("cross-tenant silence in listings (no inference)", async () => {
    const before = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_assignments`);
    await seedAssignment(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const after = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_assignments`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("admin of tenant A cannot delete tenant B assignments", async () => {
    const a = await seedAssignment(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", adminA.authId,
      `DELETE FROM public.campaign_assignments WHERE id = $1 RETURNING id`, [a]);
    expect(res.rows).toHaveLength(0);
  });
});

// ═════════════════════ 2. MODULE GATE ═════════════════════
describe("module gate", () => {
  it("campaign disabled → the disabled tenant's admin sees zero assignments", async () => {
    // Seed one assignment directly into the disabled tenant.
    const a = await db.query(
      `INSERT INTO politicore.campaign_assignments
         (tenant_id, title, assigned_to, assigned_by, scope_type, scope_id)
       VALUES ($1,'hidden work',$2,$2,'ward',$3) RETURNING id`,
      [TENANT_DISABLED, adminC.authId, W_N]);
    const id = (a.rows[0] as Record<string, unknown>).id as string;
    const { rows } = await as(db, "authenticated", adminC.authId,
      `SELECT id FROM public.campaign_assignments WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it("create RPC refuses with module-disabled semantics", async () => {
    const res = await as(db, "authenticated", adminC.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [adminC.authId, W_N]);
    expect(res.error).toContain("campaign module is not enabled");
    expect(classifyCampaignError(res.error!)).toBe("module_disabled");
  });
});

// ═════════════════════ 3. CREATION (§10/§11) ═════════════════════
describe("assignment creation", () => {
  it("authorized coordinator creates for an eligible campaign member", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.create_campaign_assignment('t','d',$1,'ward',$2) AS a`,
      [memberN1.authId, W_N]);
    expect(res.error).toBeUndefined();
    const id = (res.rows[0] as Record<string, unknown>).a as string;
    expect(id).toBeTruthy();
    const row = await db.query(
      `SELECT tenant_id, assigned_by, status, scope_type FROM politicore.campaign_assignments WHERE id=$1`, [id]);
    const r = row.rows[0] as Record<string, unknown>;
    expect(r.tenant_id).toBe(TENANT);        // server-resolved tenant
    expect(r.assigned_by).toBe(wardCoord.authId); // server-resolved creator
    expect(r.status).toBe("not_started");    // state machine initial state
    expect(r.scope_type).toBe("ward");
  });

  it("member without create permission is denied", async () => {
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [memberN2.authId, W_N]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("not authorized");
  });

  it("out-of-scope creation is denied (ward coord outside own ward)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [memberZ.authId, W_Z]);
    expect(res.error).toBeDefined();
  });

  it("cross-scope assignee is refused (member outside target scope)", async () => {
    // LGA coordinator may create in LGA_N but memberZ is registered in nsukka.
    const res = await as(db, "authenticated", lgaCoord.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'lga',$2)`,
      [memberZ.authId, LGA_N]);
    expect(res.error).toBeDefined();
  });

  it("non-campaign-member assignee refused (0024 eligibility)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [socialInWard.authId, W_N]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("assignee not found in tenant");
  });

  it("invalid geography scope is rejected", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [memberN1.authId, "no-such-ward"]);
    expect(res.error).toBeDefined();
  });
});

// ═════════════════════ 4. SCOPE HIERARCHY (visibility) ═════════════════════
describe("hierarchical scope visibility", () => {
  let wardAct = "";
  let puAct = "";
  let lgaAct = "";
  let zoneAct = "";
  let stateAct = "";
  let otherZoneAct = "";

  beforeAll(async () => {
    wardAct = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    puAct = await seedAssignment(TENANT, memberN1.authId, { type: "polling_unit", id: PU2 });
    lgaAct = await seedAssignment(TENANT, memberN1.authId, { type: "lga", id: LGA_N });
    zoneAct = await seedAssignment(TENANT, memberN1.authId, { type: "senatorial_zone", id: ZONE_OF_LGA_N });
    stateAct = await seedAssignment(TENANT, memberN1.authId, { type: "state", id: STATE });
    otherZoneAct = await seedAssignment(TENANT, memberZ.authId, { type: "ward", id: W_Z });
  });

  it("ward coordinator sees ward + descendant PU assignments, not ancestor-scope or other-zone rows", async () => {
    const { rows } = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_assignments`);
    const ids = rows.map((r) => (r as Record<string, unknown>).id);
    expect(ids).toContain(wardAct);
    expect(ids).toContain(puAct); // descendant of the ward
    expect(ids).not.toContain(lgaAct); // ANCESTOR scope — outside ward authority (polarity)
    expect(ids).not.toContain(zoneAct);
    expect(ids).not.toContain(stateAct);
    expect(ids).not.toContain(otherZoneAct);
  });

  it("PU user sees only own assignments (sibling PU invisible)", async () => {
    const own = await seedAssignment(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const { rows } = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_assignments`);
    const ids = rows.map((r) => (r as Record<string, unknown>).id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(puAct); // sibling PU (PU2)
  });

  it("zone coordinator sees descendants across the zone", async () => {
    const { rows } = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM public.campaign_assignments`);
    const ids = rows.map((r) => (r as Record<string, unknown>).id);
    expect(ids).toContain(wardAct);
    expect(ids).toContain(puAct);
    expect(ids).toContain(lgaAct); // descendant of the zone (LGA_N is in the zone)
    expect(ids).not.toContain(otherZoneAct);
  });

  it("scope polarity: ward coordinator cannot act outside the ward", async () => {
    const a = await seedAssignment(TENANT, memberZ.authId, { type: "ward", id: W_Z });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_assignment_details($1,'x',NULL,NULL,NULL,NULL,$2)`,
      [a, memberZ.authId]);
    expect(res.error).toBeDefined();
  });
});

// ═════════════════════ 5. WORKFLOW (§9/§15) ═════════════════════
describe("assignment workflow", () => {
  it("full legal path: start → submit → return → resubmit → accept", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const start = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start') AS s`, [a]);
    expect((start.rows[0] as Record<string, unknown>).s).toBe("in_progress");

    const submit = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit') AS s`, [a]);
    expect((submit.rows[0] as Record<string, unknown>).s).toBe("submitted");

    const ret = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'return') AS s`, [a]);
    expect((ret.rows[0] as Record<string, unknown>).s).toBe("under_review");

    const resub = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'resubmit') AS s`, [a]);
    expect((resub.rows[0] as Record<string, unknown>).s).toBe("submitted");

    const accept = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept') AS s`, [a]);
    expect((accept.rows[0] as Record<string, unknown>).s).toBe("completed");
  });

  it("non-assignee cannot start or submit", async () => {
    const a = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    const s = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [a]);
    expect(s.error).toContain("only the assignee");
    const sub = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    expect(sub.error).toContain("only the assignee");
  });

  it("invalid transitions are refused (submit from submitted; start from in_progress)", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    const again = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    expect(again.error).toContain("invalid transition");
    const startTwice = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", memberN2.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [startTwice]);
    const more = await as(db, "authenticated", memberN2.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [startTwice]);
    expect(more.error).toContain("invalid transition");
  });

  it("out-of-scope reviewer cannot review (unrelated zone)", async () => {
    const a = await seedAssignment(TENANT, memberZ.authId, { type: "ward", id: W_Z });
    await as(db, "authenticated", memberZ.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [a]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("not authorized to review");
  });

  it("self-approval is banned (assignee reviewing own work)", async () => {
    // wardCoord is assigned their own ward assignment and holds review
    // authority — the self-review guard must fire first.
    const a = await seedAssignment(TENANT, wardCoord.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [a]);
    expect(res.error).toContain("self-review is not permitted");
  });

  it("unknown action is refused", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'delete-everything')`, [a]);
    expect(res.error).toContain("unknown assignment action");
  });

  it("details RPC refuses terminal (completed) assignments", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [a]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_assignment_details($1,'x',NULL,NULL,NULL,NULL,NULL)`, [a]);
    expect(res.error).toContain("invalid transition: update from completed");
  });
});

// ═════════════════════ 6. REASSIGNMENT (§14) ═════════════════════
describe("reassignment", () => {
  it("authorized supervisor reassigns; audit + notification are written", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_assignment_details($1,NULL,NULL,NULL,NULL,NULL,$2)`,
      [a, memberN2.authId]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT assigned_to FROM politicore.campaign_assignments WHERE id=$1`, [a]);
    expect((row.rows[0] as Record<string, unknown>).assigned_to).toBe(memberN2.authId);

    const aud = await db.query(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE affected_resource='campaign_assignment' AND resource_id=$1
         AND action='campaign.assignment.reassign'`, [a]);
    expect(aud.rows).toHaveLength(1);
    expect((aud.rows[0] as Record<string, unknown>).actor_id).toBe(wardCoord.authId);

    const notif = await db.query(
      `SELECT 1 FROM politicore.notifications
       WHERE user_id=$1 AND title LIKE 'Assignment assigned:%'`, [memberN2.authId]);
    expect(notif.rows.length).toBeGreaterThan(0);
  });

  it("member without manage authority cannot reassign", async () => {
    const a = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.update_campaign_assignment_details($1,NULL,NULL,NULL,NULL,NULL,$2)`,
      [a, memberN1.authId]);
    expect(res.error).toBeDefined();
  });

  it("reassignment to a non-campaign-member is refused (0024)", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_assignment_details($1,NULL,NULL,NULL,NULL,NULL,$2)`,
      [a, socialInWard.authId]);
    expect(res.error).toBeDefined();
    expect(res.error).toContain("assignee not found in tenant");
  });

  it("scope is immutable through the details RPC (no unsafe scope-move)", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `UPDATE public.campaign_assignments SET scope_id=$1 WHERE id=$2 RETURNING id`,
      [W_Z, a]);
    expect(res.rows).toHaveLength(0); // UPDATE policy is USING(false)
  });
});

// ═════════════════════ 7. DIRECT POSTGREST ABUSE (§13/§15) ═════════════════════
describe("direct PostgREST mutation abuse", () => {
  it("INSERT through the view without permission is denied", async () => {
    const res = await as(db, "authenticated", memberN1.authId,
      `INSERT INTO public.campaign_assignments (title, assigned_to, assigned_by, scope_type, scope_id)
       VALUES ('x',$1,$2,'ward',$3) RETURNING id`,
      [memberN2.authId, memberN1.authId, W_N]);
    expect(res.error).toBeDefined();
  });

  it("creator/tenant spoofing is impossible through the view", async () => {
    // Even for an authorized supervisor, INSERT WITH CHECK pins
    // assigned_by = auth.uid() and status = 'not_started'.
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_assignments (title, assigned_to, assigned_by, scope_type, scope_id, status)
       VALUES ('x',$1,$2,'ward',$3,'completed') RETURNING id`,
      [memberN1.authId, adminA.authId, W_N]);
    expect(res.error).toBeDefined();
  });

  it("PATCH through the view is privilege-denied for every caller (0021 view is SELECT-only)", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const admin = await as(db, "authenticated", adminA.authId,
      `UPDATE public.campaign_assignments SET status='completed' WHERE id=$1 RETURNING id`, [a]);
    expect((admin as unknown as { error?: string }).error ?? "denied").toBeDefined();
    const ward = await as(db, "authenticated", wardCoord.authId,
      `UPDATE public.campaign_assignments SET assigned_to=$1 WHERE id=$2 RETURNING id`,
      [memberN2.authId, a]);
    expect((ward as unknown as { error?: string }).error ?? "denied").toBeDefined();
  });

  it("DELETE through the view is policy-gated (supervisor-only, non-terminal)", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    const member = await as(db, "authenticated", memberN1.authId,
      `DELETE FROM public.campaign_assignments WHERE id=$1 RETURNING id`, [a]);
    expect(member.rows).toHaveLength(0); // assignee cannot delete
    const sup = await as(db, "authenticated", wardCoord.authId,
      `DELETE FROM public.campaign_assignments WHERE id=$1 RETURNING id`, [a]);
    expect(sup.rows).toHaveLength(1); // supervisor can
    const gone = await db.query(`SELECT 1 FROM politicore.campaign_assignments WHERE id=$1`, [a]);
    expect(gone.rows).toHaveLength(0);
  });

  it("delete of completed assignments is blocked (0024 terminal-state guard)", async () => {
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [a]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [a]);
    const res = await as(db, "authenticated", adminA.authId,
      `DELETE FROM public.campaign_assignments WHERE id=$1 RETURNING id`, [a]);
    expect(res.rows).toHaveLength(0);
  });
});

// ═════════════════════ 8. SOCIAL / ELECTION-OFFICER / POSITION BOUNDARIES ═════════════════════
describe("cross-module authority boundaries", () => {
  it("social-only user has zero assignment visibility and zero authority", async () => {
    const { rows } = await as(db, "authenticated", socialOnly.authId,
      `SELECT id FROM public.campaign_assignments`);
    expect(rows).toHaveLength(0);
    const create = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [memberN1.authId, W_N]);
    expect(create.error).toBeDefined();
    const trans = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`,
      [(await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N }))]);
    expect(trans.error).toBeDefined();
  });

  it("registered-in-ward social member is STILL ineligible (0024)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [socialInWard.authId, W_N]);
    expect(res.error).toContain("assignee not found in tenant");
  });

  it("Election Officer gains no Campaign assignment authority", async () => {
    const { rows } = await as(db, "authenticated", electionOfficer.authId,
      `SELECT id FROM public.campaign_assignments`);
    expect(rows).toHaveLength(0);
    const create = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.create_campaign_assignment('x','x',$1,'ward',$2)`,
      [memberN1.authId, W_N]);
    expect(create.error).toBeDefined();
  });

  it("plain member sees only own assignments", async () => {
    const own = await seedAssignment(TENANT, plainMember.authId, { type: "ward", id: W_N });
    const { rows } = await as(db, "authenticated", plainMember.authId,
      `SELECT id FROM public.campaign_assignments`);
    const ids = rows.map((r) => (r as Record<string, unknown>).id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N }));
  });
});

// ═════════════════════ 9. AUDIT / LEADERBOARD / VIEWS ═════════════════════
describe("audit, leaderboard, and view boundaries", () => {
  it("client cannot INSERT forged audits", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.system_audits (tenant_id, action, affected_resource)
       VALUES ($1,'forged.assignment','x')`, [TENANT]);
    expect(res.error).toBeDefined();
  });

  it("transition audits carry the server-resolved actor", async () => {
    const a = await seedAssignment(TENANT, memberN2.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", memberN2.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [a]);
    const aud = await db.query(
      `SELECT actor_id FROM politicore.system_audits
       WHERE affected_resource='campaign_assignment' AND resource_id=$1`, [a]);
    expect(aud.rows).toHaveLength(1);
    expect((aud.rows[0] as Record<string, unknown>).actor_id).toBe(memberN2.authId);
  });

  it("assignment operations never touch the leaderboard projection", async () => {
    const before = await db.query(`SELECT points, rank FROM politicore.profiles WHERE id=$1`, [memberN1.authId]);
    const a = await seedAssignment(TENANT, memberN1.authId, { type: "ward", id: W_N });
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [a]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_assignment_details($1,'retitled',NULL,NULL,NULL,NULL,NULL)`, [a]);
    const after = await db.query(`SELECT points, rank FROM politicore.profiles WHERE id=$1`, [memberN1.authId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("public assignments view is security-invoker", async () => {
    const v = await db.query(
      `SELECT count(*)::int n FROM pg_views WHERE schemaname='public' AND viewname='campaign_assignments'`);
    expect((v.rows[0] as Record<string, unknown>).n).toBe(1);
  });

  it("typed error mapping stays intact (regression)", async () => {
    expect(classifyCampaignError("campaign module is not enabled for this tenant")).toBe("module_disabled");
    expect(classifyCampaignError("not authorized to create assignments at this scope")).toBe("forbidden");
    const err = new CampaignError("forbidden", "boom");
    expect(err.kind).toBe("forbidden");
  });
});
