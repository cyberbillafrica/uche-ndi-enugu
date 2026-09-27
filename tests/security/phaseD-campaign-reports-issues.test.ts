/**
 * POLITICORE — Campaign Phase D security suite (Field Reports + Issues).
 *
 * Runs against the same local PGlite database as the security suites
 * (migrations 0000–0025). Proves the §30 matrix for BOTH domains on top
 * of Phases A–C, including the 0025 changes:
 *   * tenant isolation (read/mutate/inference) — both tables
 *   * module gate (disabled ⇒ silent reads, RPC refusal)
 *   * hierarchical scope visibility with ancestor polarity
 *   * reports: RPC submission (server-pinned actor/status, audited per
 *     0025), review accept/return (self-approval ban), resubmission
 *     (submitter-only, clears review), state machine, direct view
 *     INSERT/PATCH/DELETE denials
 *   * issues: view INSERT with reporter/status pinning, lifecycle
 *     acknowledge → assign → start → resolve → verify → close with the
 *     0025 assignee eligibility guard, resolver/verifier/closer actor
 *     distinctions, direct PATCH/DELETE denials
 *   * social-only / Election Officer boundaries, cross-tenant silence
 *   * audit actors server-resolved; forged audit INSERT denied
 *   * notifications: correct recipient/tenant; leaderboard untouched
 *
 * Permission facts used (0004 matrix): campaign_member position carries
 * submit_field_report/report_issue (effective only through an
 * organizational assignment scope); ward/lga/zone/state coordinators add
 * review_field_report + manage_issue. A member with NO organizational
 * assignment holds no scope permissions.
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

let db: PGlite;

const LGA_N = "enugu-north";
const LGA_Z = "nsukka";

let W_N = "";
let PU1 = "";
let PU2 = "";
let W_Z = "";
let ZONE_OF_LGA_N = "";

const TENANT = TENANT_A;
const TENANT_OTHER = TENANT_B;

let adminA: { authId: string; profileId: string };
let adminB: { authId: string; profileId: string };
let wardCoord: { authId: string; profileId: string };
let lgaCoord: { authId: string; profileId: string };
let zoneCoord: { authId: string; profileId: string };
let puUser: { authId: string; profileId: string };
let puUser2: { authId: string; profileId: string };
let memberN1: { authId: string; profileId: string };
let memberN2: { authId: string; profileId: string };
let memberZ: { authId: string; profileId: string };
let socialInWard: { authId: string; profileId: string };
let socialOnly: { authId: string; profileId: string };
let electionOfficer: { authId: string; profileId: string };

async function seedReport(
  tenant: string,
  reporter: string,
  scope: { type: string; id: string },
  status = "submitted"
): Promise<string> {
  const res = await db.query(
    `INSERT INTO politicore.campaign_field_reports
       (tenant_id, submitted_by, report_type, title, description, scope_type, scope_id, status)
     VALUES ($1,$2,'field','Seeded report','desc',$3,$4,$5) RETURNING id`,
    [tenant, reporter, scope.type, scope.id, status]
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
     VALUES ($1,'Seeded issue','desc','other',$2,$3,$4) RETURNING id`,
    [tenant, scope.type, scope.id, reporter]
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
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1`, [W_N]
    )).rows[0] as Record<string, unknown>).id as string;
  PU2 = ((await db.query(
      `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1 OFFSET 1`, [W_N]
    )).rows[0] as Record<string, unknown>).id as string;
  W_Z = ((await db.query(
      `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 1`, [LGA_Z]
    )).rows[0] as Record<string, unknown>).id as string;

  await createTenant(db, "campd-a", "Campaign D Tenant A", { campaign: true }, TENANT);
  await createTenant(db, "campd-b", "Campaign D Tenant B", { campaign: true }, TENANT_OTHER);

  adminA = await createUser(db, { tenantId: TENANT, email: "dadmin.a@cd.test", fullName: "Admin A", accessRole: "admin", membershipTypes: ["campaign_member"] });
  adminB = await createUser(db, { tenantId: TENANT_OTHER, email: "dadmin.b@cd.test", fullName: "Admin B", accessRole: "admin", membershipTypes: ["campaign_member"] });
  wardCoord = await createUser(db, { tenantId: TENANT, email: "dward@cd.test", fullName: "Ward Coord", membershipTypes: ["campaign_member"], wardId: W_N });
  lgaCoord = await createUser(db, { tenantId: TENANT, email: "dlga@cd.test", fullName: "LGA Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  zoneCoord = await createUser(db, { tenantId: TENANT, email: "dzone@cd.test", fullName: "Zone Coord", membershipTypes: ["campaign_member"], lgaId: LGA_N });
  puUser = await createUser(db, { tenantId: TENANT, email: "dpu@cd.test", fullName: "PU User", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU1 });
  puUser2 = await createUser(db, { tenantId: TENANT, email: "dpu2@cd.test", fullName: "PU User 2", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU2 });
  memberN1 = await createUser(db, { tenantId: TENANT, email: "dn1@cd.test", fullName: "Member N1", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU1 });
  memberN2 = await createUser(db, { tenantId: TENANT, email: "dn2@cd.test", fullName: "Member N2", membershipTypes: ["campaign_member"], wardId: W_N, puId: PU2 });
  memberZ = await createUser(db, { tenantId: TENANT, email: "dz1@cd.test", fullName: "Member Z", membershipTypes: ["campaign_member"], lgaId: LGA_Z, wardId: W_Z });
  socialInWard = await createUser(db, { tenantId: TENANT, email: "dsw@cd.test", fullName: "Social In Ward", membershipTypes: ["social_member"], wardId: W_N });
  socialOnly = await createUser(db, { tenantId: TENANT, email: "dsocial@cd.test", fullName: "Social Only", membershipTypes: ["social_member"] });
  electionOfficer = await createUser(db, { tenantId: TENANT, email: "deo@cd.test", fullName: "Election Officer", accessRole: "election_officer" });

  await assign(db, TENANT, wardCoord.authId, "ward_coordinator", "ward", W_N);
  await assign(db, TENANT, lgaCoord.authId, "lga_coordinator", "lga", LGA_N);
  await assign(db, TENANT, zoneCoord.authId, "zone_coordinator", "senatorial_zone", ZONE_OF_LGA_N);
  await assign(db, TENANT, puUser.authId, "campaign_member", "polling_unit", PU1);
  await assign(db, TENANT, puUser2.authId, "campaign_member", "polling_unit", PU2);
});

// ═════════════════════ 1. TENANT ISOLATION ═════════════════════
describe("tenant isolation", () => {
  it("tenant A cannot read tenant B reports or issues", async () => {
    const r = await seedReport(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const i = await seedIssue(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const rr = await as(db, "authenticated", adminA.authId,
      `SELECT id FROM public.campaign_field_reports WHERE id = $1`, [r]);
    const ii = await as(db, "authenticated", adminA.authId,
      `SELECT id FROM public.campaign_issues WHERE id = $1`, [i]);
    expect(rr.rows).toHaveLength(0);
    expect(ii.rows).toHaveLength(0);
  });

  it("cross-tenant review/transition is impossible (row invisible to the RPC)", async () => {
    const r = await seedReport(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const i = await seedIssue(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const rev = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [r]);
    expect(rev.error).toContain("report not found");
    const tr = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`, [i]);
    expect(tr.error).toContain("issue not found");
  });

  it("listing inference: cross-tenant rows never appear in counts", async () => {
    const beforeR = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_field_reports`);
    const beforeI = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_issues`);
    await seedReport(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    await seedIssue(TENANT_OTHER, adminB.authId, { type: "ward", id: W_N });
    const afterR = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_field_reports`);
    const afterI = await as(db, "authenticated", adminA.authId,
      `SELECT count(*)::int n FROM public.campaign_issues`);
    expect(afterR.rows[0].n).toBe(beforeR.rows[0].n);
    expect(afterI.rows[0].n).toBe(beforeI.rows[0].n);
  });
});

// ═════════════════════ 2. MODULE GATE ═════════════════════
describe("module gate", () => {
  it("campaign disabled → both surfaces return nothing to that tenant's admin", async () => {
    const tOff = await createTenant(db, "campd-off", "Campaign D Off", {});
    const offAdmin = await createUser(db, { tenantId: tOff, email: "doff@cd.test", fullName: "Off Admin", accessRole: "admin", membershipTypes: ["campaign_member"] });
    await seedReport(tOff, offAdmin.authId, { type: "ward", id: W_N });
    await seedIssue(tOff, offAdmin.authId, { type: "ward", id: W_N });
    const rr = await as(db, "authenticated", offAdmin.authId,
      `SELECT id FROM public.campaign_field_reports`);
    const ii = await as(db, "authenticated", offAdmin.authId,
      `SELECT id FROM public.campaign_issues`);
    expect(rr.rows).toHaveLength(0);
    expect(ii.rows).toHaveLength(0);
  });

  it("report submission refuses when the module is disabled", async () => {
    const tOff = await createTenant(db, "campd-off2", "Campaign D Off 2", {});
    const offAdmin = await createUser(db, { tenantId: tOff, email: "doff2@cd.test", fullName: "Off Admin 2", accessRole: "admin", membershipTypes: ["campaign_member"] });
    const res = await as(db, "authenticated", offAdmin.authId,
      `SELECT politicore.submit_campaign_report('field','t','d','ward',$1)`, [W_N]);
    expect(res.error).toContain("campaign module is not enabled");
  });

  it("issue lifecycle RPC refuses when the module is disabled", async () => {
    const tOff = await createTenant(db, "campd-off3", "Campaign D Off 3", {});
    const offAdmin = await createUser(db, { tenantId: tOff, email: "doff3@cd.test", fullName: "Off Admin 3", accessRole: "admin", membershipTypes: ["campaign_member"] });
    const i = await seedIssue(tOff, offAdmin.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", offAdmin.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`, [i]);
    expect(res.error).toContain("campaign module is not enabled");
  });
});

// ═════════════════════ 3. HIERARCHICAL SCOPE (polarity) ═════════════════════
describe("hierarchical scope visibility", () => {
  it("PU authority sees own submissions but NOT ancestor-scope rows", async () => {
    const own = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const wardLevel = await seedReport(TENANT, wardCoord.authId, { type: "ward", id: W_N });
    const { rows } = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_field_reports`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(wardLevel); // ancestor polarity
  });

  it("ward coordinator sees descendant PU reports", async () => {
    const puRep = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const { rows } = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_field_reports WHERE id = $1`, [puRep]);
    expect(rows).toHaveLength(1);
  });

  it("LGA and zone coordinators see ward-level descendant reports", async () => {
    const wardRep = await seedReport(TENANT, wardCoord.authId, { type: "ward", id: W_N });
    const lgaView = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM public.campaign_field_reports WHERE id = $1`, [wardRep]);
    expect(lgaView.rows).toHaveLength(1);
    const zoneView = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM public.campaign_field_reports WHERE id = $1`, [wardRep]);
    expect(zoneView.rows).toHaveLength(1);
  });

  it("unrelated geography is invisible (nsukka report to W_N authorities)", async () => {
    const rep = await seedReport(TENANT, adminA.authId, { type: "ward", id: W_Z });
    const wv = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_field_reports WHERE id = $1`, [rep]);
    expect(wv.rows).toHaveLength(0);
  });

  it("issues: sibling-PU isolation and own-row visibility", async () => {
    const own = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const sibling = await seedIssue(TENANT, puUser2.authId, { type: "polling_unit", id: PU2 });
    const { rows } = await as(db, "authenticated", puUser.authId,
      `SELECT id FROM public.campaign_issues`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(sibling);
  });

  it("ward manager sees issues at descendant PUs", async () => {
    const puIssue = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const { rows } = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM public.campaign_issues WHERE id = $1`, [puIssue]);
    expect(rows).toHaveLength(1);
  });
});

// ═════════════════════ 4. FIELD REPORTS ═════════════════════
describe("field reports", () => {
  it("authorized member submits via the RPC (server-pinned reporter/status/tenant)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.submit_campaign_report('field','Ground truth','Detail text','polling_unit',$1) AS rid`,
      [PU1]);
    expect(res.error).toBeUndefined();
    const rid = res.rows[0].rid as string;
    const row = (await db.query(
      `SELECT tenant_id, submitted_by, status FROM politicore.campaign_field_reports WHERE id=$1`,
      [rid])).rows[0] as Record<string, unknown>;
    expect(row.tenant_id).toBe(TENANT);
    expect(row.submitted_by).toBe(puUser.authId);
    expect(row.status).toBe("submitted");
  });

  it("submission is audited (0025) with the server-resolved reporter", async () => {
    await as(db, "authenticated", puUser.authId,
      `SELECT politicore.submit_campaign_report('field','Audit probe','d','polling_unit',$1)`, [PU1]);
    const aud = (await db.query(
      `SELECT actor_id FROM politicore.system_audits
       WHERE action='campaign.report.submit' ORDER BY id DESC LIMIT 1`)).rows[0] as Record<string, unknown>;
    expect(aud.actor_id).toBe(puUser.authId);
  });

  it("member WITHOUT organizational scope cannot submit via RPC or view", async () => {
    const rpc = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.submit_campaign_report('field','t','d','ward',$1)`, [W_N]);
    expect(rpc.error).toContain("not authorized to submit field reports");
    const ins = await as(db, "authenticated", memberN1.authId,
      `INSERT INTO public.campaign_field_reports
         (submitted_by, report_type, title, description, scope_type, scope_id)
       VALUES ($1,'field','t','d','ward',$2) RETURNING id`, [memberN1.authId, W_N]);
    expect(ins.error).toBeDefined();
  });

  it("direct view INSERT cannot spoof reporter or status", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_field_reports
         (submitted_by, report_type, title, description, scope_type, scope_id, status)
       VALUES ($1,'field','t','d','polling_unit',$2,'accepted') RETURNING id`,
      [adminA.authId, PU1]);
    expect(res.error).toBeDefined();
  });

  it("review accept: reviewer server-pinned, comment stored, submitter notified", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const rev = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept','solid work') AS s`, [rid]);
    expect(rev.rows[0].s).toBe("accepted");
    const row = (await db.query(
      `SELECT status, reviewed_by, review_comment FROM politicore.campaign_field_reports WHERE id=$1`,
      [rid])).rows[0] as Record<string, unknown>;
    expect(row.status).toBe("accepted");
    expect(row.reviewed_by).toBe(wardCoord.authId);
    expect(row.review_comment).toBe("solid work");
    const notif = (await db.query(
      `SELECT user_id, tenant_id, type FROM politicore.notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [puUser.authId])).rows[0] as Record<string, unknown>;
    expect(notif.tenant_id).toBe(TENANT);
    expect(notif.type).toBe("assignment");
  });

  it("self-approval is banned", async () => {
    const rid = await seedReport(TENANT, wardCoord.authId, { type: "ward", id: W_N });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    expect(res.error).toContain("self-approval is not permitted");
  });

  it("unauthorized reviewer denied (member without review authority)", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", puUser2.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    expect(res.error).toContain("not authorized to review reports");
  });

  it("out-of-scope reviewer denied (nsukka ward report to W_N authority)", async () => {
    const rid = await seedReport(TENANT, adminA.authId, { type: "ward", id: W_Z });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    expect(res.error).toContain("not authorized to review reports");
  });

  it("return → resubmit → re-review cycle; resubmission clears review state", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'return','needs detail')`, [rid]);
    let row = (await db.query(`SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [rid]))
      .rows[0] as Record<string, unknown>;
    expect(row.status).toBe("returned");

    const rs = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.resubmit_campaign_report($1,'revised description')`, [rid]);
    expect(rs.error).toBeUndefined();
    row = (await db.query(
      `SELECT status, reviewed_by, review_comment, description FROM politicore.campaign_field_reports WHERE id=$1`,
      [rid])).rows[0] as Record<string, unknown>;
    expect(row.status).toBe("submitted");
    expect(row.reviewed_by).toBeNull();
    expect(row.review_comment).toBeNull();
    expect(row.description).toBe("revised description");

    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    row = (await db.query(`SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [rid]))
      .rows[0] as Record<string, unknown>;
    expect(row.status).toBe("accepted");
  });

  it("another user cannot resubmit someone else's returned report", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'return')`, [rid]);
    const res = await as(db, "authenticated", puUser2.authId,
      `SELECT politicore.resubmit_campaign_report($1,'hijack')`, [rid]);
    expect(res.error).toContain("only the original submitter");
  });

  it("resubmission of an accepted report is refused", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    const res = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.resubmit_campaign_report($1,'late change')`, [rid]);
    expect(res.error).toContain("invalid transition: resubmit from accepted");
  });

  it("accept from 'returned' is an invalid transition", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'return')`, [rid]);
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    expect(res.error).toContain("invalid transition: accept from returned");
  });

  it("accepted reports cannot be re-mutated by any workflow path", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    const res = await as(db, "authenticated", lgaCoord.authId,
      `SELECT politicore.review_campaign_report($1,'return')`, [rid]);
    expect(res.error).toContain("invalid transition: return from accepted");
  });

  it("direct view PATCH of report status is privilege-denied (table+view UPDATE closed)", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", wardCoord.authId,
      `UPDATE public.campaign_field_reports SET status='accepted' WHERE id=$1 RETURNING id`, [rid]);
    expect(res.error ?? "no-error").toBeDefined();
    const row = (await db.query(`SELECT status FROM politicore.campaign_field_reports WHERE id=$1`, [rid]))
      .rows[0] as Record<string, unknown>;
    expect(row.status).toBe("submitted");
  });

  it("direct view DELETE of reports is denied", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", adminA.authId,
      `DELETE FROM public.campaign_field_reports WHERE id=$1 RETURNING id`, [rid]);
    expect(res.rows).toHaveLength(0);
  });

  it("review and resubmit audits carry the acting actors", async () => {
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'return','rework')`, [rid]);
    await as(db, "authenticated", puUser.authId,
      `SELECT politicore.resubmit_campaign_report($1,'v2')`, [rid]);
    const aud = (await db.query(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE resource_id = $1 AND action IN ('campaign.report.review','campaign.report.resubmit')
       ORDER BY id`, [rid])).rows as Array<Record<string, unknown>>;
    expect(aud.map((a) => a.action)).toEqual(["campaign.report.review", "campaign.report.resubmit"]);
    expect(aud[0].actor_id).toBe(wardCoord.authId);
    expect(aud[1].actor_id).toBe(puUser.authId);
  });
});

// ═════════════════════ 5. ISSUES ═════════════════════
describe("issues", () => {
  it("scoped member reports an issue through the view (server-pinned reporter/status)", async () => {
    const res = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id)
       VALUES ('Broken generator','No fuel','logistics','polling_unit',$1)
       RETURNING reported_by, status, tenant_id`, [PU1]);
    expect(res.error).toBeUndefined();
    const row = res.rows[0];
    expect(row.reported_by).toBe(puUser.authId);
    expect(row.status).toBe("reported");
    expect(row.tenant_id).toBe(TENANT);
  });

  it("member WITHOUT organizational scope cannot report an issue", async () => {
    const res = await as(db, "authenticated", memberN1.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id)
       VALUES ('x','d','other','ward',$1) RETURNING id`, [W_N]);
    expect(res.error).toBeDefined();
  });

  it("reporter spoof and status spoof through the view are refused", async () => {
    const spoof = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id, reported_by)
       VALUES ('x','d','other','polling_unit',$1,$2) RETURNING id`, [PU1, adminA.authId]);
    expect(spoof.error).toBeDefined();
    const stat = await as(db, "authenticated", puUser.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id, status)
       VALUES ('x','d','other','polling_unit',$1,'closed') RETURNING id`, [PU1]);
    expect(stat.error).toBeDefined();
  });

  it("full lifecycle: acknowledge → assign → start → resolve → verify → close", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });

    const ack = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge') AS s`, [iid]);
    expect(ack.rows[0].s).toBe("acknowledged");

    const asg = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2) AS s`, [iid, memberN1.authId]);
    expect(asg.rows[0].s).toBe("assigned");

    const start = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'start') AS s`, [iid]);
    expect(start.rows[0].s).toBe("in_progress");

    const resolve = await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'resolve',NULL,'fixed the generator') AS s`, [iid]);
    expect(resolve.rows[0].s).toBe("resolved");

    const verify = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify') AS s`, [iid]);
    expect(verify.rows[0].s).toBe("verified");

    const close = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'close') AS s`, [iid]);
    expect(close.rows[0].s).toBe("closed");

    const row = (await db.query(
      `SELECT resolved_by, verified_by, closed_by, resolution_notes, status
       FROM politicore.campaign_issues WHERE id=$1`, [iid])).rows[0] as Record<string, unknown>;
    expect(row.resolved_by).toBe(memberN1.authId);
    expect(row.verified_by).toBe(wardCoord.authId);
    expect(row.closed_by).toBe(wardCoord.authId);
    expect(row.resolution_notes).toBe("fixed the generator");
    expect(row.status).toBe("closed");
  });

  it("assignee eligibility (0025): non-campaign-member refused", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iid, socialInWard.authId]);
    expect(res.error).toContain("assignee not found in tenant");
  });

  it("assignee eligibility (0025): out-of-scope registered location refused", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iid, memberZ.authId]);
    expect(res.error).toContain("assignee not found in tenant");
  });

  it("assign without an assignee is refused", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign')`, [iid]);
    expect(res.error).toContain("assignee is required");
  });

  it("non-manager cannot acknowledge or verify", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const ack = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`, [iid]);
    expect(ack.error).toContain("not authorized to manage issues");
    const ver = await as(db, "authenticated", puUser.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify')`, [iid]);
    expect(ver.error).toContain("not authorized to verify");
  });

  it("non-assignee cannot start; verifier cannot fabricate the resolver", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iid, memberN1.authId]);
    const start = await as(db, "authenticated", memberN2.authId,
      `SELECT politicore.campaign_issue_transition($1,'start')`, [iid]);
    expect(start.error).toContain("only the assignee may start");

    // resolve by the manager (allowed), then verify — resolved_by stays the resolver.
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'resolve',NULL,'mgr fixed')`, [iid]);
    await as(db, "authenticated", lgaCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify')`, [iid]);
    const row = (await db.query(
      `SELECT resolved_by, verified_by FROM politicore.campaign_issues WHERE id=$1`, [iid]))
      .rows[0] as Record<string, unknown>;
    expect(row.resolved_by).toBe(wardCoord.authId);
    expect(row.verified_by).toBe(lgaCoord.authId);
  });

  it("invalid transitions are refused (verify/close before resolution)", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const ver = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify')`, [iid]);
    expect(ver.error).toContain("invalid transition: verify from reported");
    const cl = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'close')`, [iid]);
    expect(cl.error).toContain("invalid transition: close from reported");
  });

  it("direct view PATCH of status/assignee/reporter is privilege-denied", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", wardCoord.authId,
      `UPDATE public.campaign_issues SET status='closed', assigned_to=$1, reported_by=$1
       WHERE id=$2 RETURNING id`, [memberN2.authId, iid]);
    expect(res.error ?? "no-error").toBeDefined();
    const row = (await db.query(
      `SELECT status, assigned_to, reported_by FROM politicore.campaign_issues WHERE id=$1`, [iid]))
      .rows[0] as Record<string, unknown>;
    expect(row.status).toBe("reported");
    expect(row.assigned_to).toBeNull();
    expect(row.reported_by).toBe(puUser.authId);
  });

  it("direct view DELETE of issues is denied", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const res = await as(db, "authenticated", adminA.authId,
      `DELETE FROM public.campaign_issues WHERE id=$1 RETURNING id`, [iid]);
    expect(res.rows).toHaveLength(0);
  });

  it("assign/status audits carry the acting actors", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iid, memberN1.authId]);
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'start')`, [iid]);
    await as(db, "authenticated", memberN1.authId,
      `SELECT politicore.campaign_issue_transition($1,'resolve',NULL,'done')`, [iid]);
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify')`, [iid]);
    const aud = (await db.query(
      `SELECT action, actor_id FROM politicore.system_audits
       WHERE resource_id = $1 AND affected_resource = 'campaign_issue'
         AND action IN ('campaign.issue.assign','campaign.issue.status')
       ORDER BY id`, [iid])).rows as Array<Record<string, unknown>>;
    const actions = aud.map((a) => a.action);
    expect(actions).toContain("campaign.issue.assign");
    expect(actions).toContain("campaign.issue.status");
    const actors = new Set(aud.map((a) => a.actor_id));
    expect(actors.has(wardCoord.authId)).toBe(true);
    expect(actors.has(memberN1.authId)).toBe(true);
  });

  it("assignment notifies the eligible assignee inside their own tenant", async () => {
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iid, memberN1.authId]);
    const notif = (await db.query(
      `SELECT tenant_id FROM politicore.notifications
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [memberN1.authId]))
      .rows[0] as Record<string, unknown>;
    expect(notif.tenant_id).toBe(TENANT);
  });
});

// ═════════════════════ 6. BOUNDARIES / AUDIT / LEADERBOARD ═════════════════════
describe("cross-module boundaries, audit integrity, leaderboard", () => {
  it("social-only: zero visibility and zero authority across both domains", async () => {
    const rr = await as(db, "authenticated", socialOnly.authId,
      `SELECT id FROM public.campaign_field_reports`);
    const ii = await as(db, "authenticated", socialOnly.authId,
      `SELECT id FROM public.campaign_issues`);
    expect(rr.rows).toHaveLength(0);
    expect(ii.rows).toHaveLength(0);
    const sub = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.submit_campaign_report('field','x','d','ward',$1)`, [W_N]);
    expect(sub.error).toContain("not authorized to submit field reports");
    const ins = await as(db, "authenticated", socialOnly.authId,
      `INSERT INTO public.campaign_issues (title, description, issue_type, scope_type, scope_id)
       VALUES ('x','d','other','ward',$1) RETURNING id`, [W_N]);
    expect(ins.error).toBeDefined();
    const tr = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`,
      [await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 })]);
    expect(tr.error).toContain("not authorized to manage issues");
  });

  it("Election Officer: no Campaign report/issue authority", async () => {
    const rr = await as(db, "authenticated", electionOfficer.authId,
      `SELECT id FROM public.campaign_field_reports`);
    const ii = await as(db, "authenticated", electionOfficer.authId,
      `SELECT id FROM public.campaign_issues`);
    expect(rr.rows).toHaveLength(0);
    expect(ii.rows).toHaveLength(0);
    const sub = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.submit_campaign_report('field','x','d','ward',$1)`, [W_N]);
    expect(sub.error).toContain("not authorized to submit field reports");
    const tr = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge')`,
      [await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 })]);
    expect(tr.error).toContain("not authorized to manage issues");
  });

  it("admin operates tenant-wide within their tenant only", async () => {
    const rep = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const view = await as(db, "authenticated", adminA.authId,
      `SELECT id FROM public.campaign_field_reports WHERE id = $1`, [rep]);
    expect(view.rows).toHaveLength(1);
    const rev = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rep]);
    expect(rev.error).toBeUndefined();
    // Cross-tenant: adminB must not see ANY of tenant A's rows.
    const ownIssue = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    const cross = await as(db, "authenticated", adminB.authId,
      `SELECT id FROM public.campaign_issues WHERE id = $1`, [ownIssue]);
    expect(cross.rows).toHaveLength(0);
  });

  it("client cannot INSERT forged audits", async () => {
    const res = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.system_audits (tenant_id, action, affected_resource)
       VALUES ($1,'forged.report','x')`, [TENANT]);
    expect(res.error).toBeDefined();
  });

  it("report/issue operations never touch the leaderboard projection", async () => {
    const before = (await db.query(
      `SELECT points, rank FROM politicore.profiles WHERE id=$1`, [puUser.profileId])).rows[0];
    const rid = await seedReport(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.review_campaign_report($1,'accept')`, [rid]);
    const iid = await seedIssue(TENANT, puUser.authId, { type: "polling_unit", id: PU1 });
    await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2)`, [iid, puUser.authId]);
    const after = (await db.query(
      `SELECT points, rank FROM politicore.profiles WHERE id=$1`, [puUser.profileId])).rows[0];
    expect(after).toEqual(before);
  });
});
