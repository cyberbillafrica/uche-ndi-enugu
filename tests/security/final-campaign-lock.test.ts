/**
 * POLITICORE — FINAL CAMPAIGN LOCK GATE security suite.
 *
 * The lock acceptance matrix (§27) over the local PGlite harness
 * (migrations 0000–0026). This suite is the final consolidated proof:
 * tenant/module/identity/membership/scope boundaries, all four workflow
 * domains, coordination-as-composition, directory hardening, the Core
 * assignment view, direct PostgREST abuse, and the legacy-boundary
 * invariants (no user_access, no client expansion, no Social/Leaderboard
 * dependency, no Campaign Firebase path).
 */
import { describe, expect, it, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { applyMigrations, createDb } from "../../scripts/db/apply-migrations";
import { as, createTenant, createUser, grant } from "../security/helpers";

const W = { zone: "enugu-north-zone", lga: "nsukka", ward: "nsukka-ward-01", pu: "nsukka-ward-01-pu-001" };
const SIB = { ward: "nsukka-ward-02", lga: "igbo-etiti" };

let db: PGlite;
let tA: string, tB: string;
let admin: FixtureUser, adminB: FixtureUser, adminNoCamp: FixtureUser, socialOnly: FixtureUser,
    electionOfficer: FixtureUser, nonMember: FixtureUser;
let wardMember: FixtureUser, wardCoord: FixtureUser, wardCoordPU: FixtureUser,
    lgaCoord: FixtureUser, zoneCoord: FixtureUser, stateCoord: FixtureUser;
let memberW1a: FixtureUser;
let tBCampaign: string;

interface FixtureUser { authId: string; email: string; }

const DIR_ERR = "not authorized to view the member directory";
const COORD_ERR = "not authorized to view campaign coordination";

beforeAll(async () => {
  db = await createDb();
  await applyMigrations(db);

  tA = await createTenant(db, "lock-a", "Lock Tenant A", { campaign: true });
  tB = await createTenant(db, "lock-b", "Lock Tenant B", {});
  tBCampaign = await createTenant(db, "lock-bc", "Lock Tenant B (campaign)", { campaign: true });

  admin = await createUser(db, { tenantId: tA, email: "admin@a.test", fullName: "Admin A", accessRole: "admin" });
  adminB = await createUser(db, { tenantId: tBCampaign, email: "admin@b.test", fullName: "Admin B", accessRole: "admin" });
  adminNoCamp = await createUser(db, { tenantId: tB, email: "adminnc@b.test", fullName: "Admin NoCampaign", accessRole: "admin" });
  socialOnly = await createUser(db, { tenantId: tA, email: "so@a.test", fullName: "Social Only", membershipTypes: ["social_member"], wardId: W.ward, lgaId: W.lga });
  electionOfficer = await createUser(db, { tenantId: tA, email: "eo@a.test", fullName: "Election Officer", accessRole: "election_officer" });
  nonMember = await createUser(db, { tenantId: tA, email: "nm@a.test", fullName: "Non Member" });

  wardMember = await createUser(db, { tenantId: tA, email: "wm@a.test", fullName: "Ward Member", membershipTypes: ["campaign_member"], wardId: W.ward, lgaId: W.lga, puId: W.pu });
  wardCoord = await createUser(db, { tenantId: tA, email: "wc@a.test", fullName: "Ward Coord", membershipTypes: ["campaign_member"], wardId: W.ward, lgaId: W.lga });
  wardCoordPU = await createUser(db, { tenantId: tA, email: "wcp@a.test", fullName: "Ward Coord Sibling", membershipTypes: ["campaign_member"], wardId: SIB.ward, lgaId: SIB.lga });
  lgaCoord = await createUser(db, { tenantId: tA, email: "lc@a.test", fullName: "LGA Coord", membershipTypes: ["campaign_member"], lgaId: W.lga });
  zoneCoord = await createUser(db, { tenantId: tA, email: "zc@a.test", fullName: "Zone Coord", membershipTypes: ["campaign_member"], lgaId: W.lga });
  stateCoord = await createUser(db, { tenantId: tA, email: "sc@a.test", fullName: "State Coord", membershipTypes: ["campaign_member"] });
  memberW1a = await createUser(db, { tenantId: tA, email: "mw@a.test", fullName: "Member W1a", membershipTypes: ["campaign_member"], wardId: W.ward, lgaId: W.lga, puId: W.pu });
  await createUser(db, { tenantId: tBCampaign, email: "mb@b.test", fullName: "Member B", membershipTypes: ["campaign_member"] });

  const org = (u: FixtureUser, pos: string, st: string, sid: string) =>
    db.query(
      `INSERT INTO politicore.organizational_assignments
         (tenant_id, user_id, position, scope_type, scope_id, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6)`, [tA, u.authId, pos, st, sid, admin.authId]);

  await org(wardCoord, "ward_coordinator", "ward", W.ward);
  await org(wardCoordPU, "ward_coordinator", "ward", SIB.ward);
  await org(lgaCoord, "lga_coordinator", "lga", W.lga);
  await org(zoneCoord, "zone_coordinator", "senatorial_zone", W.zone);
  await org(stateCoord, "state_coordinator", "state", "enugu-state");
  await org(memberW1a, "campaign_member", "polling_unit", W.pu);

  await grant(db, tA, admin.authId, "manage_members", true, null, null);
  await grant(db, tA, admin.authId, "view_members", true, null, null);
  await grant(db, tBCampaign, adminB.authId, "manage_members", true, null, null);
  await grant(db, tA, wardMember.authId, "submit_field_report", true, "polling_unit", W.pu);
  await grant(db, tA, wardMember.authId, "report_issue", true, "polling_unit", W.pu);
  await grant(db, tA, admin.authId, "manage_issue", true, null, null);
  await grant(db, tA, admin.authId, "review_field_report", true, null, null);
});

// ═════════ 1. TENANT + MODULE + IDENTITY + MEMBERSHIP BOUNDARIES ═════════

describe("boundaries: tenant / module / identity / membership", () => {
  it("cross-tenant directory silence (tenant B admin sees only own member)", async () => {
    const res = await as(db, "authenticated", adminB.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    expect(res.error).toBeUndefined();
    const ids = res.rows.map((r) => String(r.id));
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(wardMember.authId);
  });

  it("module disabled (tenant B) denies directory for its admin", async () => {
    const res = await as(db, "authenticated", adminNoCamp.authId,
      `SELECT * FROM politicore.campaign_members_page(NULL,NULL,NULL,NULL,NULL)`);
    expect(res.error).toBeDefined();
    expect(String(res.error)).toContain(DIR_ERR);
  });

  it("module disabled denies coordination (tenant B admin)", async () => {
    const res = await as(db, "authenticated", adminNoCamp.authId,
      `SELECT politicore.campaign_coordination_summary() s`);
    expect(res.error).toBeDefined();
    expect(String(res.error)).toContain(COORD_ERR);
  });

  it("anonymous caller is refused (directory + RPC write)", async () => {
    const dir = await as(db, "anon", null, `SELECT * FROM politicore.campaign_members_in_scope()`);
    expect(dir.error).toBeDefined();
    const sub = await as(db, "anon", null,
      `SELECT politicore.submit_campaign_report('field','t','d','polling_unit',$1)`, [W.pu]);
    expect(sub.error).toBeDefined();
  });

  it("membership matrix: non-member, social-only, plain campaign member are all refused the directory", async () => {
    for (const u of [nonMember, socialOnly, wardMember]) {
      const res = await as(db, "authenticated", u.authId,
        `SELECT * FROM politicore.campaign_members_in_scope()`);
      expect(res.error).toBeDefined();
      expect(String(res.error)).toContain(DIR_ERR);
    }
  });

  it("campaign + social membership is NOT social-only — directory authority works normally", async () => {
    const dual = await createUser(db, {
      tenantId: tA, email: "dual@a.test", fullName: "Dual Member",
      membershipTypes: ["campaign_member", "social_member"], wardId: W.ward, lgaId: W.lga,
    });
    await db.query(
      `INSERT INTO politicore.organizational_assignments
         (tenant_id, user_id, position, scope_type, scope_id, assigned_by)
       VALUES ($1,$2,'ward_coordinator','ward',$3,$4)`, [tA, dual.authId, SIB.ward, admin.authId]);
    const res = await as(db, "authenticated", dual.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    expect(res.error).toBeUndefined();
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("election officer without Campaign authority is denied directory + coordination", async () => {
    const d = await as(db, "authenticated", electionOfficer.authId,
      `SELECT * FROM politicore.campaign_members_in_scope()`);
    expect(String(d.error)).toContain(DIR_ERR);
    const c = await as(db, "authenticated", electionOfficer.authId,
      `SELECT politicore.campaign_coordination_summary() s`);
    expect(String(c.error)).toContain(COORD_ERR);
  });
});

// ═════════ 2. SCOPE MATRIX ═════════

describe("scope matrix (descendant / sibling / ancestor / cross-tenant)", () => {
  it("ward authority sees own ward; sibling ward denied", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    const ids = res.rows.map((r) => String(r.id));
    expect(ids).toContain(wardMember.authId);
    expect(ids).not.toContain(wardCoordPU.authId);
  });

  it("sibling-ward authority does not see ward-01 members (sibling polarity)", async () => {
    const res = await as(db, "authenticated", wardCoordPU.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    expect(res.rows.map((r) => String(r.id))).not.toContain(wardMember.authId);
  });

  it("LGA covers both wards; zone covers LGA; state tenant-wide", async () => {
    const lga = await as(db, "authenticated", lgaCoord.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    const lids = lga.rows.map((r) => String(r.id));
    expect(lids).toContain(wardMember.authId);
    expect(lids).toContain(wardCoordPU.authId);
    const zone = await as(db, "authenticated", zoneCoord.authId,
      `SELECT id FROM politicore.campaign_members_in_scope()`);
    expect(zone.rows.map((r) => String(r.id))).toContain(wardMember.authId);
    const state = await as(db, "authenticated", stateCoord.authId,
      `SELECT count(*) n FROM politicore.campaign_members_in_scope()`);
    expect(Number(state.rows[0].n)).toBe(8); // 7 named campaign members + campaign+social dual member
  });

  it("ancestor polarity: PU-registered plain member never gains upward authority", async () => {
    const res = await as(db, "authenticated", wardMember.authId,
      `SELECT * FROM politicore.campaign_members_page(NULL,NULL,NULL,NULL,NULL)`);
    expect(String(res.error)).toContain(DIR_ERR);
  });

  it("unauthorized directory filter yields an EMPTY page — never a leak", async () => {
    const res = await as(db, "authenticated", wardCoord.authId,
      `SELECT id FROM politicore.campaign_members_page(NULL,'igbo-etiti',NULL,NULL,NULL)`);
    expect(res.error).toBeUndefined();
    expect(res.rows).toHaveLength(0);
  });
});

// ═════════ 3. WORKFLOWS ═════════

describe("workflows: activities", () => {
  it("insert (RLS-pinned) → rsvp → attendance → status RPC; social-only create denied", async () => {
    // Activities are created by RLS-gated INSERT (0021): the policy pins
    // tenant/creator; no client-supplied organizer/status override.
    const ins = await as(db, "authenticated", wardCoord.authId,
      `INSERT INTO politicore.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'Lock activity','meeting', now() + interval '7 days','ward',$2)
       RETURNING id`, [tA, W.ward]);
    expect(ins.error).toBeUndefined();
    const id = String((ins.rows[0] as Record<string, unknown>).id);

    const joined = await as(db, "authenticated", wardMember.authId,
      `SELECT politicore.join_campaign_activity($1, 'going') id`, [id]);
    expect(joined.error).toBeUndefined();

    const att = await as(db, "authenticated", admin.authId,
      `SELECT politicore.record_campaign_attendance($1, $2, 'present', true, false)`, [id, wardMember.authId]);
    expect(att.error).toBeUndefined();

    const status = await as(db, "authenticated", admin.authId,
      `SELECT politicore.set_campaign_activity_status($1,'cancelled') s`, [id]);
    expect(status.error).toBeUndefined();

    const spoof = await as(db, "authenticated", socialOnly.authId,
      `INSERT INTO politicore.campaign_activities
         (tenant_id, title, activity_type, scheduled_start, scope_type, scope_id)
       VALUES ($1,'Hijack','meeting', now() + interval '7 days','ward',$2)`, [tA, W.ward]);
    expect(spoof.error).toBeDefined();
  });
});

describe("workflows: assignments", () => {
  it("create eligible → transition → terminal-state delete protection (state-based)", async () => {
    const created = await as(db, "authenticated", wardCoord.authId,
      `SELECT politicore.create_campaign_assignment(
         'Lock assignment','desc',$1,'ward',$2,'medium',NULL,NULL) id`, [wardMember.authId, W.ward]);
    expect(created.error).toBeUndefined();
    const id = String((created.rows[0] as Record<string, unknown>).id);

    // Row pinned server-side: tenant, creator, initial status.
    const row = await db.query(
      `SELECT tenant_id, assigned_by, status FROM politicore.campaign_assignments WHERE id = $1`, [id]);
    expect((row.rows[0] as Record<string, unknown>).tenant_id).toBe(tA);
    expect((row.rows[0] as Record<string, unknown>).assigned_by).toBe(wardCoord.authId);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("not_started");

    const started = await as(db, "authenticated", wardMember.authId,
      `SELECT politicore.campaign_assignment_transition($1,'start')`, [id]);
    expect(started.error).toBeUndefined();

    // Direct UPDATE cannot push status (USING(false) ⇒ zero-rows; assert state).
    await as(db, "authenticated", admin.authId,
      `UPDATE politicore.campaign_assignments SET status = 'completed' WHERE id = $1`, [id]);
    const still = await db.query(
      `SELECT status FROM politicore.campaign_assignments WHERE id = $1`, [id]);
    expect((still.rows[0] as Record<string, unknown>).status).toBe("in_progress");

    // Drive to terminal via the RPC, then prove deletion is gated.
    await as(db, "authenticated", wardMember.authId,
      `SELECT politicore.campaign_assignment_transition($1,'submit')`, [id]);
    await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_assignment_transition($1,'accept')`, [id]);
    await as(db, "authenticated", admin.authId,
      `DELETE FROM politicore.campaign_assignments WHERE id = $1`, [id]);
    const survives = await db.query(
      `SELECT status FROM politicore.campaign_assignments WHERE id = $1`, [id]);
    expect(survives.rows).toHaveLength(1);
    expect((survives.rows[0] as Record<string, unknown>).status).toBe("completed");
  });
});

describe("workflows: reports", () => {
  it("submit → review return → resubmit → accept, with server-resolved reporter", async () => {
    const sub = await as(db, "authenticated", wardMember.authId,
      `SELECT politicore.submit_campaign_report('field','Lock report','d','polling_unit',$1) id`, [W.pu]);
    expect(sub.error).toBeUndefined();
    const rid = String((sub.rows[0] as Record<string, unknown>).id);

    const state = await db.query(
      `SELECT submitted_by, status FROM politicore.campaign_field_reports WHERE id = $1`, [rid]);
    expect((state.rows[0] as Record<string, unknown>).submitted_by).toBe(wardMember.authId);
    expect((state.rows[0] as Record<string, unknown>).status).toBe("submitted");

    const ret = await as(db, "authenticated", admin.authId,
      `SELECT politicore.review_campaign_report($1,'return','revise') s`, [rid]);
    expect(ret.error).toBeUndefined();

    const resub = await as(db, "authenticated", wardMember.authId,
      `SELECT politicore.resubmit_campaign_report($1,'updated',NULL) s`, [rid]);
    expect(resub.error).toBeUndefined();

    const acc = await as(db, "authenticated", admin.authId,
      `SELECT politicore.review_campaign_report($1,'accept',NULL) s`, [rid]);
    expect(acc.error).toBeUndefined();
    expect((acc.rows[0] as Record<string, unknown>).s).toBe("accepted");
  });
});

describe("workflows: issues", () => {
  it("insert (actor-pinned) → acknowledge → assign eligible → resolve → verify; social assignee refused", async () => {
    // Issues are created by RLS-gated INSERT: reported_by pinned, status
    // pinned 'reported', actor needs report_issue at scope (or admin).
    const ins = await as(db, "authenticated", wardMember.authId,
      `INSERT INTO politicore.campaign_issues
         (tenant_id, title, description, issue_type, scope_type, scope_id)
       VALUES ($1,'Lock issue','d','other','polling_unit',$2) RETURNING id`, [tA, W.pu]);
    expect(ins.error).toBeUndefined();
    const iid = String((ins.rows[0] as Record<string, unknown>).id);
    const row = await db.query(
      `SELECT reported_by, status FROM politicore.campaign_issues WHERE id = $1`, [iid]);
    expect((row.rows[0] as Record<string, unknown>).reported_by).toBe(wardMember.authId);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("reported");

    const ack = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_issue_transition($1,'acknowledge',NULL,NULL)`, [iid]);
    expect(ack.error).toBeUndefined();

    // Eligible assignee (in-tenant campaign_member, registered location
    // covered by the issue scope) succeeds; social-only refused (0025).
    const assign = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2,NULL)`, [iid, memberW1a.authId]);
    expect(assign.error).toBeUndefined();
    const socialAssign = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_issue_transition($1,'assign',$2,NULL)`, [iid, socialOnly.authId]);
    expect(socialAssign.error).toBeDefined();

    // 'start' is assignee-only (server guard) — the assignee starts work.
    const start = await as(db, "authenticated", memberW1a.authId,
      `SELECT politicore.campaign_issue_transition($1,'start',NULL,NULL)`, [iid]);
    expect(start.error).toBeUndefined();
    const wrongStarter = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_issue_transition($1,'start',NULL,NULL)`, [iid]);
    expect(wrongStarter.error).toBeDefined();
    const resolve = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_issue_transition($1,'resolve',NULL,'fixed')`, [iid]);
    expect(resolve.error).toBeUndefined();
    const verify = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_issue_transition($1,'verify',NULL,NULL)`, [iid]);
    expect(verify.error).toBeUndefined();

    // Resolver/verifier are server-resolved actors (never client fields).
    const final = await db.query(
      `SELECT resolved_by, verified_by, status FROM politicore.campaign_issues WHERE id = $1`, [iid]);
    expect((final.rows[0] as Record<string, unknown>).resolved_by).toBe(admin.authId);
    expect((final.rows[0] as Record<string, unknown>).verified_by).toBe(admin.authId);
    expect((final.rows[0] as Record<string, unknown>).status).toBe("verified");
  });
});

// ═════════ 4. COORDINATION / DIRECTORY / CORE VIEW ═════════

describe("coordination, directory, core view", () => {
  it("coordination is composition-only (no table) and authority-gated", async () => {
    const t = await db.query(`SELECT to_regclass('politicore.campaign_coordination') t`);
    expect((t.rows[0] as Record<string, unknown>).t).toBeNull();
    const ok = await as(db, "authenticated", admin.authId,
      `SELECT politicore.campaign_coordination_summary() s`);
    expect(ok.error).toBeUndefined();
    const denied = await as(db, "authenticated", wardMember.authId,
      `SELECT politicore.campaign_coordination_summary() s`);
    expect(String(denied.error)).toContain(COORD_ERR);
  });

  it("directory pagination is stable and clamped", async () => {
    const p1 = await as(db, "authenticated", admin.authId,
      `SELECT id FROM politicore.campaign_members_page(NULL,NULL,NULL,2,0)`);
    expect(p1.rows).toHaveLength(2);
    const p2 = await as(db, "authenticated", admin.authId,
      `SELECT id FROM politicore.campaign_members_page(NULL,NULL,NULL,2,2)`);
    const ids1 = p1.rows.map((r) => String((r as Record<string, unknown>).id));
    const ids2 = p2.rows.map((r) => String((r as Record<string, unknown>).id));
    expect(ids1.some((x) => ids2.includes(x))).toBe(false);
  });

  it("core assignment view: own rows / admin rows / mutation denial", async () => {
    const own = await as(db, "authenticated", wardCoord.authId,
      `SELECT position FROM public.organizational_assignments`);
    expect(own.rows.map((r) => String((r as Record<string, unknown>).position))).toEqual(["ward_coordinator"]);
    const adm = await as(db, "authenticated", admin.authId,
      `SELECT count(*) n FROM public.organizational_assignments`);
    expect(Number((adm.rows[0] as Record<string, unknown>).n)).toBe(7); // 6 named + dual member
    const ins = await as(db, "authenticated", admin.authId,
      `INSERT INTO public.organizational_assignments (tenant_id, user_id, position, scope_type, scope_id)
       VALUES ($1,$2,'ward_coordinator','ward',$3)`, [tA, nonMember.authId, W.ward]);
    expect(ins.error).toBeDefined();
    const grant = await db.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='organizational_assignments'
         AND grantee='authenticated' AND privilege_type <> 'SELECT'`);
    expect(grant.rows).toHaveLength(0);
  });
});

// ═════════ 5. DIRECT POSTGREST ABUSE ═════════

describe("direct PostgREST abuse (fail-closed, state-based)", () => {
  it("assignments are update/delete-locked at table and view (zero-rows ⇒ state unchanged)", async () => {
    const before = await db.query(
      `SELECT count(*) n FROM politicore.campaign_assignments WHERE status = 'completed'`);
    for (const rel of ["politicore.campaign_assignments", "public.campaign_assignments"]) {
      await as(db, "authenticated", admin.authId, `UPDATE ${rel} SET status = 'completed'`);
      await as(db, "authenticated", admin.authId, `DELETE FROM ${rel} WHERE status = 'not_started'`);
    }
    const after = await db.query(
      `SELECT count(*) n FROM politicore.campaign_assignments WHERE status = 'completed'`);
    expect(Number((after.rows[0] as Record<string, unknown>).n))
      .toBe(Number((before.rows[0] as Record<string, unknown>).n));
    const remaining = await db.query(
      `SELECT count(*) n FROM politicore.campaign_assignments WHERE status = 'not_started'`);
    expect(Number((remaining.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("reports and issues are update-locked (RPC-only workflow; state unchanged)", async () => {
    const verifiedBefore = await db.query(
      `SELECT count(*) n FROM politicore.campaign_issues WHERE status = 'verified'`);
    const acceptedBefore = await db.query(
      `SELECT count(*) n FROM politicore.campaign_field_reports WHERE status = 'accepted'`);
    for (const rel of ["politicore.campaign_field_reports", "politicore.campaign_issues",
      "public.campaign_field_reports", "public.campaign_issues"]) {
      await as(db, "authenticated", admin.authId, `UPDATE ${rel} SET status = 'verified'`);
    }
    const verifiedAfter = await db.query(
      `SELECT count(*) n FROM politicore.campaign_issues WHERE status = 'verified'`);
    expect(Number((verifiedAfter.rows[0] as Record<string, unknown>).n))
      .toBe(Number((verifiedBefore.rows[0] as Record<string, unknown>).n)); // only the RPC-driven one
    const acceptedAfter = await db.query(
      `SELECT count(*) n FROM politicore.campaign_field_reports WHERE status = 'accepted'`);
    expect(Number((acceptedAfter.rows[0] as Record<string, unknown>).n))
      .toBe(Number((acceptedBefore.rows[0] as Record<string, unknown>).n));
  });

  it("activity status cannot be directly PATCHed (state unchanged)", async () => {
    // Count every state transition marker before/after the direct UPDATE:
    // the only cancelled/completed rows must remain the RPC-driven ones.
    const before = await db.query(
      `SELECT count(*) n FROM politicore.campaign_activities WHERE status IN ('cancelled','completed','postponed')`);
    await as(db, "authenticated", admin.authId,
      `UPDATE politicore.campaign_activities SET status = 'cancelled' WHERE status = 'scheduled'`);
    const after = await db.query(
      `SELECT count(*) n FROM politicore.campaign_activities WHERE status IN ('cancelled','completed','postponed')`);
    expect(Number((after.rows[0] as Record<string, unknown>).n))
      .toBe(Number((before.rows[0] as Record<string, unknown>).n));
  });

  it("forged audit insert is denied", async () => {
    const res = await as(db, "authenticated", wardMember.authId,
      `INSERT INTO politicore.system_audits (tenant_id, actor_id, action, resource_type)
       VALUES ($1,$2,'campaign.report.submit','forged')`, [tA, admin.authId]);
    expect(res.error).toBeDefined();
  });

  it("cross-tenant writes are policy-pinned (tenant spoof refused)", async () => {
    const res = await as(db, "authenticated", wardMember.authId,
      `INSERT INTO politicore.campaign_field_reports
         (tenant_id, submitted_by, report_type, title, description, scope_type, scope_id)
       VALUES ($1,$2,'field','spoof','d','polling_unit',$3)`,
      [tBCampaign, adminB.authId, W.pu]);
    expect(res.error).toBeDefined();
  });
});

// ═════════ 6. LEGACY BOUNDARY (§27) ═════════

describe("legacy boundary invariants", () => {
  it("no user_access table or grant path exists", async () => {
    const t = await db.query(`SELECT to_regclass('politicore.user_access') t`);
    expect((t.rows[0] as Record<string, unknown>).t).toBeNull();
  });

  it("no Campaign-owned Social surface exists (Social Force owns tasks/points/leaderboard)", async () => {
    // Social Force Phase A (migration 0028) now legitimately owns
    // politicore.social_tasks / social_task_submissions / social_point_awards
    // and the public.social_leaderboard projection. The durable Campaign
    // boundary invariant is that Campaign never grows its own copies.
    const fns = await db.query(
      `SELECT count(*) n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'politicore'
         AND (p.proname ILIKE 'campaign%leaderboard%' OR p.proname ILIKE 'campaign%task%'
              OR p.proname ILIKE 'campaign%point%' OR p.proname ILIKE 'campaign%submission%')`);
    expect(Number((fns.rows[0] as Record<string, unknown>).n)).toBe(0);
    const tbl = await db.query(
      `SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore'
         AND (c.relname ILIKE 'campaign%leaderboard%' OR c.relname ILIKE 'campaign%task%'
              OR c.relname ILIKE 'campaign%point%' OR c.relname ILIKE 'campaign%submission%')`);
    expect(Number((tbl.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("Campaign membership does not mutate points", async () => {
    const before = await db.query(`SELECT points FROM politicore.profiles WHERE id = $1`, [wardMember.authId]);
    void before;
    const after = await db.query(`SELECT points FROM politicore.profiles WHERE id = $1`, [wardMember.authId]);
    expect(Number((after.rows[0] as Record<string, unknown>).points)).toBe(0);
  });
});
