/**
 * POLITICORE — Campaign Phase B security suite (Activities).
 *
 * Runs against a fresh local PGlite database (migrations 0000–0022) with
 * the established role-impersonation harness. Proves the Phase B gate
 * (§16/§17) before the migrated UI ships:
 *   * module gate (enabled/disabled, social-only, Election Officer)
 *   * tenant isolation incl. cross-tenant inference via ids
 *   * scope hierarchy: State → Zone → LGA → Ward → PU with the REAL Enugu
 *     fixtures; sibling ward/PU isolation; scope polarity
 *   * creation: policy-guarded INSERT (tenant/creator/status pinned),
 *     invalid geography/timestamps
 *   * editing: update_campaign_activity RPC (0022), scope-move
 *     re-authorization, and the DIRECT UPDATE REVOCATION (the §16 fix:
 *     PostgREST PATCH against the auto-updatable public view must fail)
 *   * status: set_campaign_activity_status transitions + unauthorized paths
 *   * RSVP: own-row only, uniqueness, cross-tenant denial
 *   * attendance: supervisor-recorded facts; self/other/recorder spoofing
 *     denied; check-out-before-check-in impossible
 *   * audit + notification-failure resilience + leaderboard boundary
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

let db: PGlite;

const STATE = "enugu-state";
const LGA_N = "enugu-north";
const LGA_Z = "nsukka"; // different senatorial zone (0013-corrected geography)
const LGA_E = "enugu-east"; // yet another zone for zone-negative breadth

let W_N = ""; // first ward of LGA_N
let W_N2 = ""; // sibling ward of LGA_N
let PU1 = ""; // polling unit in W_N
let PU2 = ""; // sibling polling unit in W_N
let W_Z = ""; // ward in LGA_Z
let W_E = ""; // ward in LGA_E
let ZONE_OF_LGA_N = ""; // resolved from the DB (do not assume from the name)

const TENANT = TENANT_A; // campaign enabled
const TENANT_OTHER = TENANT_B; // campaign disabled

let adminA: { authId: string };
let adminB: { authId: string };
let stateCoord: { authId: string };
let zoneCoord: { authId: string };
let lgaCoord: { authId: string };
let wardCoord: { authId: string };
let puUser: { authId: string }; // campaign_member position @ PU1
let plainMember: { authId: string }; // campaign membership, no assignment
let memberW: { authId: string }; // registered in W_N
let memberOther: { authId: string }; // registered elsewhere
let socialOnly: { authId: string };
let electionOfficer: { authId: string };
let campaignManager: { authId: string };

async function seedActivity(
  tenant: string,
  scope: { type: string; id: string },
  title: string,
  opts: { status?: string; creator?: string; startPast?: boolean } = {}
): Promise<string> {
  const creator = opts.creator ?? adminA.authId;
  const start = opts.startPast ? new Date(Date.now() - 3600_000) : new Date(Date.now() + 86_400_000);
  const end = new Date(start.getTime() + 2 * 3600_000);
  const res = await db.query(
    `INSERT INTO politicore.campaign_activities
       (tenant_id, title, description, activity_type, scheduled_start,
        scheduled_end, scope_type, scope_id, status, created_by, organizer_id)
     VALUES ($1,$2,'Seeded activity','meeting',$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
    [tenant, title, start, end, scope.type, scope.id, opts.status ?? "scheduled", creator]
  );
  return (res.rows[0] as Record<string, unknown>).id as string;
}

beforeAll(async () => {
  db = await getDb();

  W_N = ((await db.query(
    `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_N]
  )).rows[0] as Record<string, unknown>).id as string;
  W_N2 = ((await db.query(
    `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1 OFFSET 1`, [LGA_N]
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
  W_E = ((await db.query(
    `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_E]
  )).rows[0] as Record<string, unknown>).id as string;

  await createTenant(db, "campb-act", "Phase B Tenant", { campaign: true }, TENANT);
  await createTenant(db, "campb-off", "Phase B Disabled Tenant", {}, TENANT_OTHER);

  adminA = await createUser(db, { tenantId: TENANT, email: "b-admin@c.test", fullName: "Admin A", accessRole: "admin", membershipTypes: ["campaign_member"] });
  stateCoord = await createUser(db, { tenantId: TENANT, email: "b-state@c.test", fullName: "State Coord", membershipTypes: ["campaign_member"] });
  zoneCoord = await createUser(db, { tenantId: TENANT, email: "b-zone@c.test", fullName: "Zone Coord", membershipTypes: ["campaign_member"] });
  lgaCoord = await createUser(db, { tenantId: TENANT, email: "b-lga@c.test", fullName: "LGA Coord", membershipTypes: ["campaign_member"] });
  wardCoord = await createUser(db, { tenantId: TENANT, email: "b-ward@c.test", fullName: "Ward Coord", membershipTypes: ["campaign_member"] });
  puUser = await createUser(db, { tenantId: TENANT, email: "b-pu@c.test", fullName: "PU User", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU1 });
  plainMember = await createUser(db, { tenantId: TENANT, email: "b-plain@c.test", fullName: "Plain Member", membershipTypes: ["campaign_member"] });
  memberW = await createUser(db, { tenantId: TENANT, email: "b-mw@c.test", fullName: "Member W", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU1 });
  memberOther = await createUser(db, { tenantId: TENANT, email: "b-mo@c.test", fullName: "Member Other", membershipTypes: ["campaign_member"], wardId: W_E });
  socialOnly = await createUser(db, { tenantId: TENANT, email: "b-social@c.test", fullName: "Social Only", membershipTypes: ["social_member"] });
  electionOfficer = await createUser(db, { tenantId: TENANT, email: "b-eo@c.test", fullName: "Election Officer", accessRole: "election_officer", membershipTypes: ["campaign_member"] });
  campaignManager = await createUser(db, { tenantId: TENANT, email: "b-cm@c.test", fullName: "Campaign Manager", membershipTypes: ["campaign_member"] });
  adminB = await createUser(db, { tenantId: TENANT_OTHER, email: "b-adminB@c.test", fullName: "Admin B", accessRole: "admin" });

  await assign(db, TENANT, stateCoord.authId, "state_coordinator", "state", STATE);
  await assign(db, TENANT, zoneCoord.authId, "zone_coordinator", "senatorial_zone", ZONE_OF_LGA_N);
  await assign(db, TENANT, lgaCoord.authId, "lga_coordinator", "lga", LGA_N);
  await assign(db, TENANT, wardCoord.authId, "ward_coordinator", "ward", W_N);
  await assign(db, TENANT, puUser.authId, "campaign_member", "polling_unit", PU1);
  // Position WITHOUT authority (position matrix grants zero): title ≠ permission.
  await assign(db, TENANT, campaignManager.authId, "campaign_manager", "state", STATE);
});

// ═════════════════════ 1. MODULE GATE ═════════════════════
describe("module gate", () => {
  let actW = "";
  beforeAll(async () => {
    actW = await seedActivity(TENANT, { type: "ward", id: W_N }, "Module gate ward rally");
  });

  it("campaign enabled → scoped coordinator sees the activity", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actW]);
    expect(res.rows).toHaveLength(1);
  });

  it("campaign disabled (Tenant B) → its admin sees no activities", async () => {
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(res.rows).toHaveLength(0);
  });

  it("campaign disabled → status RPC refuses even the tenant admin", async () => {
    const actB = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "Disabled-tenant activity");
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actB]);
    expect(res.error).toMatch(/module is not enabled/i);
  });

  it("campaign disabled → update RPC refuses", async () => {
    const actB = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "Disabled-tenant activity 2");
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT politicore.update_campaign_activity($1, 'New title')`, [actB]);
    expect(res.error).toMatch(/module is not enabled/i);
  });

  it("campaign disabled → attendance RPC refuses", async () => {
    const actB = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "Disabled-tenant activity 3");
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actB, adminB.authId]);
    expect(res.error).toMatch(/module is not enabled/i);
  });

  it("campaign disabled → direct INSERT denied despite admin role", async () => {
    const res = await as(db, "authenticated", adminB.authId,
      `INSERT INTO public.campaign_activities (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'x','meeting', now(), 'lga', $2)`, [TENANT_OTHER, LGA_N]);
    expect(res.error).toBeDefined();
  });

  it("social-only member sees no activities", async () => {
    const res = await as(db, "authenticated", socialOnly.authId,
      `SELECT id FROM public.campaign_activities`);
    expect(res.rows).toHaveLength(0);
  });

  it("election officer gains NO campaign authority from the Election role", async () => {
    const res = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actW]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("campaign manager title alone confers NO status authority", async () => {
    const res = await as(db, "authenticated", campaignManager.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actW]);
    expect(res.error).toMatch(/not authorized/i);
  });
});

// ═════════════════════ 2. TENANT ISOLATION ═════════════════════
describe("tenant isolation", () => {
  let actA = "";
  let actB = "";
  beforeAll(async () => {
    actA = await seedActivity(TENANT, { type: "lga", id: LGA_N }, "Tenant A activity");
    actB = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "Tenant B activity");
  });

  it("Tenant A coordinator cannot read Tenant B activity", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actB]);
    expect(res.rows).toHaveLength(0);
  });

  it("a denied id is indistinguishable from a nonexistent id (no inference)", async () => {
    const denied = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actB]);
    const missing = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [crypto.randomUUID()]);
    expect(denied.rows).toHaveLength(0);
    expect(missing.rows).toHaveLength(0);
  });

  it("Tenant A coordinator cannot RSVP a Tenant B activity (RPC tenant-scoped)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.join_campaign_activity($1,'going')`, [actB]);
    expect(res.error).toMatch(/not found/i);
  });

  it("Tenant A coordinator cannot record attendance on Tenant B activity", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actB, adminB.authId]);
    expect(res.error).toMatch(/not found/i);
  });

  it("no cross-tenant participant access", async () => {
    await as(db, "authenticated", adminB.authId,
      `SELECT politicore.join_campaign_activity($1,'going')`, [actB]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activity_participants WHERE activity_id = $1`, [actB]);
    expect(res.rows).toHaveLength(0);
  });

  it("Tenant B admin cannot read Tenant A activities either", async () => {
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actA]);
    expect(res.rows).toHaveLength(0);
  });
});

// ═════════════════════ 3. SCOPE HIERARCHY & VISIBILITY ═════════════════════
describe("scope hierarchy and visibility", () => {
  let actWard = "", actWard2 = "", actPU = "", actPU2 = "", actLGA = "", actZ = "", actE = "";
  beforeAll(async () => {
    actWard = await seedActivity(TENANT, { type: "ward", id: W_N }, "Ward N activity");
    actWard2 = await seedActivity(TENANT, { type: "ward", id: W_N2 }, "Sibling ward activity");
    actPU = await seedActivity(TENANT, { type: "polling_unit", id: PU1 }, "PU1 activity");
    actPU2 = await seedActivity(TENANT, { type: "polling_unit", id: PU2 }, "PU2 activity");
    actLGA = await seedActivity(TENANT, { type: "lga", id: LGA_N }, "LGA N activity");
    actZ = await seedActivity(TENANT, { type: "lga", id: LGA_Z }, "Nsukka activity");
    actE = await seedActivity(TENANT, { type: "lga", id: LGA_E }, "Enugu East activity");
  });

  it("state authority sees activities across all descendant zones/LGAs", async () => {
    const res = await as(db, "authenticated", stateCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`,
      [[actWard, actPU, actLGA, actZ, actE]]);
    expect(res.rows).toHaveLength(5);
  });

  it("zone authority sees zone descendants (LGA/ward/PU) but not another zone", async () => {
    const inside = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1) ORDER BY id`,
      [[actWard, actPU, actLGA, actE]]); // actE: enugu-east LGA is INSIDE the zone covering LGA_N (0013)
    expect(inside.rows).toHaveLength(4);
    const outside = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`,
      [[actZ]]); // nsukka sits in a genuinely different zone
    expect(outside.rows).toHaveLength(0);
  });

  it("lga authority sees its wards and PUs but not another LGA", async () => {
    const inside = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`,
      [[actWard, actWard2, actPU, actPU2]]);
    expect(inside.rows).toHaveLength(4);
    const outside = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`,
      [[actZ, actE]]);
    expect(outside.rows).toHaveLength(0);
  });

  it("ward authority sees descendant PUs but NOT its parent LGA (polarity)", async () => {
    const inside = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = ANY($1)`,
      [[actWard, actPU, actPU2]]);
    expect(inside.rows).toHaveLength(3);
    const parent = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actLGA]);
    expect(parent.rows).toHaveLength(0);
  });

  it("sibling ward denial", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actWard2]);
    expect(res.rows).toHaveLength(0);
  });

  it("PU authority sees only its own PU; sibling PU denied", async () => {
    const own = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actPU]);
    expect(own.rows).toHaveLength(1);
    const ward = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actWard]);
    expect(ward.rows).toHaveLength(0);
    const sibling = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actPU2]);
    expect(sibling.rows).toHaveLength(0);
  });

  it("plain campaign member sees nothing until they participate (own-row branch)", async () => {
    const before = await as(db, "authenticated", plainMember.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actWard]);
    expect(before.rows).toHaveLength(0);
    await as(db, "authenticated", plainMember.authId,
      `SELECT politicore.join_campaign_activity($1,'interested')`, [actWard]);
    const after = await as(db, "authenticated", plainMember.authId,
      `SELECT id FROM public.campaign_activities WHERE id = $1`, [actWard]);
    expect(after.rows).toHaveLength(1);
  });
});

// ═════════════════════ 4. CREATION ═════════════════════
describe("activity creation", () => {
  it("authorized coordinator creates via the policy-guarded INSERT path", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'Created by ward coord','meeting', now() + interval '1 day','ward',$2)
       RETURNING created_by, status, organizer_id`, [TENANT, W_N]);
    expect(res.error).toBeUndefined();
    expect((res.rows[0] as Record<string, unknown>).created_by).toBe(wardCoord.authId);
    expect((res.rows[0] as Record<string, unknown>).status).toBe("scheduled");
    // organizer defaults server-side to the creator (0022).
    expect((res.rows[0] as Record<string, unknown>).organizer_id).toBe(wardCoord.authId);
  });

  it("creator spoofing denied", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id, created_by)
       VALUES ($1,'spoof','meeting', now(), 'ward',$2, $3)`,
      [TENANT, W_N, memberOther.authId]);
    expect(res.error).toBeDefined();
  });

  it("tenant spoofing denied", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'cross-tenant','meeting', now(), 'ward',$2)`, [TENANT_OTHER, W_N]);
    expect(res.error).toBeDefined();
  });

  it("out-of-scope creation denied (ward authority cannot create in another ward)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'elsewhere','meeting', now(), 'ward',$2)`, [TENANT, W_Z]);
    expect(res.error).toBeDefined();
  });

  it("ward authority cannot create above its scope (polarity)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'upward','meeting', now(), 'lga',$2)`, [TENANT, LGA_N]);
    expect(res.error).toBeDefined();
  });

  it("campaign member without a position/assignment cannot create", async () => {
    const res = await as(db, "authenticated", plainMember.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'no authority','meeting', now(), 'ward',$2)`, [TENANT, W_N]);
    expect(res.error).toBeDefined();
  });

  it("social-only user cannot create", async () => {
    const res = await as(db, "authenticated", socialOnly.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'social create','meeting', now(), 'ward',$2)`, [TENANT, W_N]);
    expect(res.error).toBeDefined();
  });

  it("invalid geography rejected by the scope validator", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'ghost scope','meeting', now(), 'ward','no-such-ward')`, [TENANT]);
    expect(res.error).toBeDefined();
  });

  it("invalid timestamp range rejected (end before start)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scheduled_end, scope_type, scope_id)
       VALUES ($1,'time travel','meeting', now() + interval '2 days', now() + interval '1 day','ward',$2)`,
      [TENANT, W_N]);
    expect(res.error).toBeDefined();
  });

  it("status cannot be seeded to a non-initial state by direct insert", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO public.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id, status)
       VALUES ($1,'preset completed','meeting', now(), 'ward',$2,'completed')`, [TENANT, W_N]);
    expect(res.error).toBeDefined();
  });
});

// ═════════════════════ 5. EDITING (0022 RPC + revocation) ═════════════════════
describe("activity editing", () => {
  let actWard = "", actLGA = "", actZ = "";
  beforeAll(async () => {
    actWard = await seedActivity(TENANT, { type: "ward", id: W_N }, "Editable ward activity", { creator: wardCoord.authId });
    actLGA = await seedActivity(TENANT, { type: "lga", id: LGA_N }, "LGA activity for edit negatives");
    actZ = await seedActivity(TENANT, { type: "lga", id: LGA_Z }, "Nsukka activity for scope moves");
  });

  it("authorized supervisor edits details through the RPC; audit written", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_activity($1, 'Renamed ward activity', NULL, 'rally')`, [actWard]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT title, activity_type FROM politicore.campaign_activities WHERE id = $1`, [actWard]);
    expect((row.rows[0] as Record<string, unknown>).title).toBe("Renamed ward activity");
    expect((row.rows[0] as Record<string, unknown>).activity_type).toBe("rally");
    const aud = await db.query(
      `SELECT actor_id FROM politicore.system_audits
       WHERE action = 'campaign.activity.update' AND resource_id = $1`, [actWard]);
    expect(aud.rows).toHaveLength(1);
    expect((aud.rows[0] as Record<string, unknown>).actor_id).toBe(wardCoord.authId);
  });

  it("user without manage authority cannot edit (RPC)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.update_campaign_activity($1, 'hijack')`, [actWard]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("out-of-scope edit denied", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_activity($1, 'hijack')`, [actLGA]);
    expect(res.error).toMatch(/not authorized|not found/i);
  });

  it("social-only edit denied", async () => {
    const res = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.update_campaign_activity($1, 'hijack')`, [actWard]);
    expect(res.error).toBeDefined();
  });

  it("DIRECT table UPDATE is revoked — even for the tenant admin", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `UPDATE politicore.campaign_activities SET title = 'patched' WHERE id = $1 RETURNING id`, [actWard]);
    expect(res.error).toMatch(/permission denied/i);
    expect(res.rows).toHaveLength(0);
  });

  it("DIRECT view UPDATE is revoked — the §16 PostgREST PATCH path is closed", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `UPDATE public.campaign_activities SET title = 'patched' WHERE id = $1 RETURNING id`, [actWard]);
    expect(res.error).toMatch(/permission denied/i);
    expect(res.rows).toHaveLength(0);
  });

  it("view UPDATE cannot mutate authority-bearing fields for ANY caller", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `UPDATE public.campaign_activities SET status = 'completed', created_by = $2
       WHERE id = $1 RETURNING id`, [actWard, memberOther.authId]);
    expect(res.error).toMatch(/permission denied/i);
    expect(res.rows).toHaveLength(0);
  });

  it("scope move requires create_activity authority at the NEW scope", async () => {
    const denied = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.update_campaign_activity($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'ward', $2)`,
      [actWard, W_N2]);
    expect(denied.error).toMatch(/not authorized to move/i);
  });

  it("authorized scope move succeeds (lga coordinator moves activity into its ward)", async () => {
    const res = await as(db, "authenticated", lgaCoord.authId,
      `SELECT politicore.update_campaign_activity($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'ward', $2)`,
      [actLGA, W_N]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT scope_type, scope_id FROM politicore.campaign_activities WHERE id = $1`, [actLGA]);
    expect((row.rows[0] as Record<string, unknown>).scope_id).toBe(W_N);
  });

  it("admin can move an activity across zones", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.update_campaign_activity($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'ward', $2)`,
      [actZ, W_Z]);
    expect(res.error).toBeUndefined();
  });

  it("tenant/creator/status are not RPC parameters (structurally uneditable)", async () => {
    const params = await db.query(
      `SELECT parameter_name FROM information_schema.parameters
       WHERE specific_schema='politicore' AND specific_name LIKE 'update_campaign_activity%'`);
    const names = params.rows.map((r) => (r as Record<string, unknown>).parameter_name).join(",");
    expect(names).not.toMatch(/tenant_id|created_by|status/);
  });
});

// ═════════════════════ 6. STATUS MANAGEMENT ═════════════════════
describe("activity status management", () => {
  let actPast = "", actFuture = "", actCompleted = "", actLGA = "";
  beforeAll(async () => {
    actPast = await seedActivity(TENANT, { type: "ward", id: W_N }, "Past activity (completable)", { startPast: true, creator: wardCoord.authId });
    actFuture = await seedActivity(TENANT, { type: "ward", id: W_N }, "Future activity");
    actCompleted = await seedActivity(TENANT, { type: "ward", id: W_N }, "Completed activity", { status: "completed" });
    actLGA = await seedActivity(TENANT, { type: "lga", id: LGA_N }, "LGA activity for status negatives");
  });

  it("valid transition: scheduled → postponed (authorized supervisor)", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actPast]);
    expect(res.error).toBeUndefined();
  });

  it("valid transition: → completed once the start time has passed", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'completed')`, [actPast]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT status FROM politicore.campaign_activities WHERE id = $1`, [actPast]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("completed");
  });

  it("invalid transition: completed is terminal", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actCompleted]);
    expect(res.error).toMatch(/invalid transition/i);
  });

  it("invalid transition: 'scheduled' cannot be set as a target", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'scheduled')`, [actFuture]);
    expect(res.error).toMatch(/invalid transition/i);
  });

  it("invalid transition: cannot complete before the scheduled start", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'completed')`, [actFuture]);
    expect(res.error).toMatch(/cannot be completed before/i);
  });

  it("unauthorized: PU-level member cannot change status", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actFuture]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("unauthorized: social-only user cannot change status", async () => {
    const res = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actFuture]);
    expect(res.error).toBeDefined();
  });

  it("unauthorized: election officer cannot change status", async () => {
    const res = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actFuture]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("out-of-scope: ward authority cannot change an LGA activity's status", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actLGA]);
    expect(res.error).toMatch(/not authorized|not found/i);
  });

  it("cross-tenant status change impossible", async () => {
    const actB = await seedActivity(TENANT_OTHER, { type: "lga", id: LGA_N }, "Tenant B status target");
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actB]);
    expect(res.error).toMatch(/not found/i);
  });

  it("DIRECT PostgREST status bypass denied (no UPDATE grant anywhere)", async () => {
    const tableLevel = await as(db, "authenticated", adminA.authId,
      `UPDATE politicore.campaign_activities SET status='completed' WHERE id=$1 RETURNING id`, [actFuture]);
    expect(tableLevel.error).toMatch(/permission denied/i);
    const viewLevel = await as(db, "authenticated", adminA.authId,
      `UPDATE public.campaign_activities SET status='completed' WHERE id=$1 RETURNING id`, [actFuture]);
    expect(viewLevel.error).toMatch(/permission denied/i);
    const row = await db.query(
      `SELECT status FROM politicore.campaign_activities WHERE id = $1`, [actFuture]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("scheduled");
  });

  it("status transition writes an audit event with the server-resolved actor", async () => {
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'cancelled')`, [actFuture]);
    const aud = await db.query(
      `SELECT actor_id, old_value, new_value FROM politicore.system_audits
       WHERE action='campaign.activity.status' AND resource_id=$1
       ORDER BY occurred_at DESC LIMIT 1`, [actFuture]);
    expect(aud.rows).toHaveLength(1);
    expect((aud.rows[0] as Record<string, unknown>).actor_id).toBe(wardCoord.authId);
    expect(((aud.rows[0] as Record<string, unknown>).new_value as Record<string, unknown>).status).toBe("cancelled");
  });

  it("status transition notifies the organizer (type 'activity')", async () => {
    const notes = await db.query(
      `SELECT id FROM politicore.notifications
       WHERE user_id = $1 AND type = 'activity' ORDER BY created_at DESC LIMIT 1`,
      [wardCoord.authId]);
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════ 7. RSVP ═════════════════════
describe("rsvp participation", () => {
  let actWard = "", actB = "";
  beforeAll(async () => {
    actWard = await seedActivity(TENANT, { type: "ward", id: W_N }, "RSVP ward activity");
    actB = await seedActivity(TENANT_OTHER, { type: "ward", id: W_N }, "Tenant B RSVP target");
  });

  it("member RSVPs their own row through the RPC", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `SELECT politicore.join_campaign_activity($1,'going')`, [actWard]);
    expect(res.error).toBeUndefined();
  });

  it("RSVP update rewrites the SAME row (UNIQUE(activity_id,user_id))", async () => {
    await as(db, "authenticated", memberW.authId,
      `SELECT politicore.join_campaign_activity($1,'interested')`, [actWard]);
    const rows = await db.query(
      `SELECT rsvp FROM politicore.campaign_activity_participants
       WHERE activity_id = $1 AND user_id = $2`, [actWard, memberW.authId]);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as Record<string, unknown>).rsvp).toBe("interested");
  });

  it("member cannot insert a participation row for ANOTHER user", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `INSERT INTO politicore.campaign_activity_participants (tenant_id, activity_id, user_id, rsvp)
       VALUES ($1,$2,$3,'going')`, [TENANT, actWard, memberOther.authId]);
    expect(res.error).toBeDefined();
  });

  it("another user's RSVP row is not modifiable by a member (no UPDATE path)", async () => {
    const res = await as(db, "authenticated", memberOther.authId,
      `UPDATE politicore.campaign_activity_participants SET rsvp='not_going'
       WHERE activity_id = $1 AND user_id = $2 RETURNING id`, [actWard, memberW.authId]);
    expect(res.rows).toHaveLength(0);
    const resView = await as(db, "authenticated", memberOther.authId,
      `UPDATE public.campaign_activity_participants SET rsvp='not_going'
       WHERE activity_id = $1 AND user_id = $2 RETURNING id`, [actWard, memberW.authId]);
    expect(resView.rows).toHaveLength(0);
  });

  it("cross-tenant RSVP impossible", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `SELECT politicore.join_campaign_activity($1,'going')`, [actB]);
    expect(res.error).toMatch(/not found/i);
  });

  it("direct view INSERT of a participation row is not granted (PostgREST abuse)", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `INSERT INTO public.campaign_activity_participants (activity_id, user_id, rsvp)
       VALUES ($1,$2,'going')`, [actWard, memberOther.authId]);
    expect(res.error).toBeDefined();
  });
});

// ═════════════════════ 8. ATTENDANCE ═════════════════════
describe("attendance recording", () => {
  let actWard = "", actPU = "", actLGA = "", actB = "";
  beforeAll(async () => {
    actWard = await seedActivity(TENANT, { type: "ward", id: W_N }, "Attendance ward activity", { creator: wardCoord.authId });
    actPU = await seedActivity(TENANT, { type: "polling_unit", id: PU1 }, "Attendance PU activity");
    actLGA = await seedActivity(TENANT, { type: "lga", id: LGA_N }, "Attendance LGA activity");
    actB = await seedActivity(TENANT_OTHER, { type: "ward", id: W_N }, "Tenant B attendance target");
    await as(db, "authenticated", memberW.authId, `SELECT politicore.join_campaign_activity($1,'going')`, [actWard]);
    await as(db, "authenticated", memberW.authId, `SELECT politicore.join_campaign_activity($1,'going')`, [actPU]);
    await as(db, "authenticated", memberOther.authId, `SELECT politicore.join_campaign_activity($1,'going')`, [actWard]);
  });

  it("authorized supervisor records attendance; recorder identity server-resolved", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actWard, memberW.authId]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT attendance, checked_in_at, recorded_by FROM politicore.campaign_activity_participants
       WHERE activity_id=$1 AND user_id=$2`, [actWard, memberW.authId]);
    expect((row.rows[0] as Record<string, unknown>).attendance).toBe("present");
    expect((row.rows[0] as Record<string, unknown>).checked_in_at).not.toBeNull();
    expect((row.rows[0] as Record<string, unknown>).recorded_by).toBe(wardCoord.authId);
  });

  it("participant CANNOT mark themselves present (self-check-in denied)", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actWard, memberW.authId]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("member CANNOT record ANOTHER user's attendance", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actWard, memberOther.authId]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("PU authority (create_activity) can record at its PU activity", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actPU, memberW.authId]);
    expect(res.error).toBeUndefined();
  });

  it("cross-scope supervisor denied (ward authority cannot record on an LGA activity)", async () => {
    await as(db, "authenticated", memberOther.authId, `SELECT politicore.join_campaign_activity($1,'going')`, [actLGA]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actLGA, memberOther.authId]);
    expect(res.error).toMatch(/not authorized/i);
  });

  it("cross-tenant attendance impossible", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',true)`, [actB, adminB.authId]);
    expect(res.error).toMatch(/not found/i);
  });

  it("recorder identity cannot be spoofed (no client parameter; RPC pins auth.uid())", async () => {
    // memberOther attempts to record while claiming wardCoord as recorder —
    // there is no recorder parameter at all; the row must keep the true actor.
    await as(db, "authenticated", memberOther.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'excused',false)`, [actWard, memberW.authId]);
    const row = await db.query(
      `SELECT recorded_by, attendance FROM politicore.campaign_activity_participants
       WHERE activity_id=$1 AND user_id=$2`, [actWard, memberW.authId]);
    // memberOther lacks authority — nothing changed.
    expect((row.rows[0] as Record<string, unknown>).attendance).toBe("present");
    expect((row.rows[0] as Record<string, unknown>).recorded_by).toBe(wardCoord.authId);
  });

  it("check-out before check-in is structurally impossible", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'present',false,true)`, [actWard, memberOther.authId]);
    expect(res.error).toMatch(/check|violates/i);
  });

  it("forged attendance by direct UPDATE is impossible (USING(false) policy)", async () => {
    const res = await as(db, "authenticated", memberW.authId,
      `UPDATE politicore.campaign_activity_participants SET attendance='absent', recorded_by=$2
       WHERE activity_id=$1 RETURNING id`, [actWard, memberOther.authId]);
    expect(res.rows).toHaveLength(0);
  });
});

// ═════════════════════ 9. AUDIT / NOTIFICATIONS / LEADERBOARD ═════════════════════
describe("audit, notification resilience, and leaderboard boundary", () => {
  let actNotify = "", actFail = "";
  beforeAll(async () => {
    actNotify = await seedActivity(TENANT, { type: "ward", id: W_N }, "Notify activity", { creator: wardCoord.authId });
    actFail = await seedActivity(TENANT, { type: "ward", id: W_N }, "Notify-failure activity", { creator: wardCoord.authId });
  });

  it("client cannot INSERT forged audit rows", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.system_audits (tenant_id, action, affected_resource, resource_id)
       VALUES ($1,'campaign.activity.status','campaign_activity','forged')`, [TENANT]);
    expect(res.error).toBeDefined();
  });

  it("business action SUCCEEDS when notification delivery fails (no rollback)", async () => {
    await db.query(
      `CREATE OR REPLACE FUNCTION politicore.phaseb_block_notifications() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'simulated notification infrastructure failure'; END;
       $$ LANGUAGE plpgsql`);
    await db.query(
      `DROP TRIGGER IF EXISTS phaseb_sim_notify_failure ON politicore.notifications`);
    await db.query(
      `CREATE TRIGGER phaseb_sim_notify_failure BEFORE INSERT ON politicore.notifications
       FOR EACH ROW EXECUTE FUNCTION politicore.phaseb_block_notifications()`);

    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actFail]);
    expect(res.error).toBeUndefined();
    const row = await db.query(
      `SELECT status FROM politicore.campaign_activities WHERE id = $1`, [actFail]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("postponed");

    await db.query(`DROP TRIGGER phaseb_sim_notify_failure ON politicore.notifications`);
    await db.query(`DROP FUNCTION politicore.phaseb_block_notifications()`);
  });

  it("expected notification is generated after delivery is restored", async () => {
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'cancelled')`, [actNotify]);
    const notes = await db.query(
      `SELECT title FROM politicore.notifications
       WHERE user_id = $1 AND type = 'activity' AND title LIKE '%cancelled%'
       ORDER BY created_at DESC LIMIT 1`, [wardCoord.authId]);
    expect(notes.rows).toHaveLength(1);
  });

  it("no Campaign Activity operation mutates the leaderboard projection", async () => {
    const before = await db.query(
      `SELECT points FROM politicore.profiles WHERE id = $1`, [memberW.authId]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.set_campaign_activity_status($1,'postponed')`, [actNotify]);
    await as(db, "authenticated", memberW.authId,
      `SELECT politicore.join_campaign_activity($1,'not_going')`, [actNotify]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.record_campaign_attendance($1,$2,'absent',false)`, [actNotify, memberW.authId]);
    const after = await db.query(
      `SELECT points FROM politicore.profiles WHERE id = $1`, [memberW.authId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

// ═════════════════════ 10. DIRECT POSTGREST SWEEP (§16) ═════════════════════
describe("direct PostgREST mutation sweep", () => {
  let actWard = "";
  beforeAll(async () => {
    actWard = await seedActivity(TENANT, { type: "ward", id: W_N }, "Sweep activity", { creator: wardCoord.authId });
  });

  it("anonymous (anon role) cannot read the public activities view", async () => {
    const res = await as(db, "anon", null,
      `SELECT id FROM public.campaign_activities`);
    expect(res.rows).toHaveLength(0);
  });

  it("anonymous cannot INSERT into the public view", async () => {
    const res = await as(db, "anon", null,
      `INSERT INTO public.campaign_activities (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'anon','meeting', now(), 'ward',$2)`, [TENANT, W_N]);
    expect(res.error).toBeDefined();
  });

  it("unauthorized member cannot DELETE through the view (0 rows affected)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `DELETE FROM public.campaign_activities WHERE id = $1 RETURNING id`, [actWard]);
    expect(res.rows).toHaveLength(0);
  });

  it("social-only cannot DELETE through the view", async () => {
    const res = await as(db, "authenticated", socialOnly.authId,
      `DELETE FROM public.campaign_activities WHERE id = $1 RETURNING id`, [actWard]);
    expect(res.rows).toHaveLength(0);
  });

  it("authorized manage authority CAN delete (legitimate path remains)", async () => {
    const actTmp = await seedActivity(TENANT, { type: "ward", id: W_N }, "Delete-me activity", { creator: wardCoord.authId });
    const res = await as(db, "authenticated", wardCoord.authId,
      `DELETE FROM public.campaign_activities WHERE id = $1 RETURNING id`, [actTmp]);
    expect(res.rows).toHaveLength(1);
  });
});
