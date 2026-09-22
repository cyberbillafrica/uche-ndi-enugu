/**
 * POLITICORE — Phase 1C Election security tests.
 *
 * Covers the Election database foundation (migrations 0014–0017 + the
 * architecture-amendment migrations 0018–0019):
 *  - tenant isolation, module gating (election enabled/tenants without it)
 *  - social-only zero access (direct SELECT + RPC + view)
 *  - registered-PU submission, ward/LGA/zone/state scope inheritance
 *  - explicit deny wins
 *  - Election Officer review authority (≠ tenant admin)
 *  - Admin correction + mandatory independent re-verification
 *  - result state machine (legal transitions only)
 *  - evidence integrity (mandatory, tenant-owned, election purpose)
 *  - party integrity (ID-based votes, no negatives/malformed)
 *  - relational ballots: election_result_votes with the native ballot
 *    rule (party must be a candidate of the result's contest), no
 *    client writes, FK backstop
 *  - resubmission guards (approved/pending_review immutable by
 *    resubmission) and the distinct 'resubmit' history action
 *  - evidence chain: old/new evidence references on every history event
 *  - relational analytics via ordinary SQL joins (party/ward/LGA/zone)
 *  - result identity UNIQUE (contest, PU) with upsert resubmission
 *  - history append-only (no client writes, RPC-only guard)
 *  - aggregation respects caller scope (never a data leak)
 *  - configuration authority (admin-only, cross-tenant/cycle guards)
 *  - module independence (Election works without Campaign)
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  as,
  assign,
  createTenant,
  createUser,
  grant,
  getDb,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: PGlite;

// geography fixtures (resolved from the seeded Enugu dataset)
let STATE = "enugu-state";
let LGA_X = "enugu-north"; // zone enugu-east-zone
let LGA_Y = "enugu-south"; // zone enugu-east-zone (different LGA)
let LGA_Z = "nsukka"; // zone enugu-north-zone (different zone)
let W1 = ""; let W2 = ""; // two wards of LGA_X
let PU1 = ""; let PU1B = ""; // two PUs of W1
let PU2 = ""; // first PU of W2
let PU3 = ""; // first PU of LGA_Y

let APC = ""; let PDP = ""; let OTHER_PARTY = "";

let cycleA = ""; let contestPres = ""; let contestGov = ""; let contestSen = "";
let contestFed = ""; let contestState = ""; let contestClosed = "";
let cycleC = ""; let contestC = "";

let evA = ""; let evWrong = ""; let evB = ""; let evC = "";

// users
let adminA: { authId: string }; let officerA: { authId: string };
let regPU1: { authId: string }; let regPU2: { authId: string };
let wardGrantUser: { authId: string }; let lgaViewer: { authId: string };
let zoneViewer: { authId: string }; let denyUser: { authId: string };
let socialOnly: { authId: string };
let adminB: { authId: string }; let officerB: { authId: string }; let memberB: { authId: string };
let memberC: { authId: string };

let TENANT_C = "";

const VOTES_APC_PDP = () => JSON.stringify([{ party_id: APC, votes: 100 }, { party_id: PDP, votes: 60 }]);

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "tenant-a", "Tenant A", { social: true, campaign: true, election: true }, TENANT_A);
  await createTenant(db, "tenant-b", "Tenant B", {}, TENANT_B);
  TENANT_C = await createTenant(db, "tenant-c", "Tenant C", { social: true, election: true });

  // ── geography fixtures ────────────────────────────────────────────
  const wards = await db.query<{ id: string }>(
    `SELECT id FROM politicore.wards WHERE lga_id = $1 ORDER BY id LIMIT 2`, [LGA_X]);
  W1 = wards.rows[0].id; W2 = wards.rows[1].id;
  const pus1 = await db.query<{ id: string }>(
    `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 2`, [W1]);
  PU1 = pus1.rows[0].id; PU1B = pus1.rows[1].id;
  PU2 = (await db.query<{ id: string }>(
    `SELECT id FROM politicore.polling_units WHERE ward_id = $1 ORDER BY id LIMIT 1`, [W2])).rows[0].id;
  PU3 = (await db.query<{ id: string }>(
    `SELECT pu.id FROM politicore.polling_units pu JOIN politicore.lgas l ON l.id = pu.lga_id
     WHERE l.id = $1 ORDER BY pu.id LIMIT 1`, [LGA_Y])).rows[0].id;

  const parties = await db.query<{ id: string; acronym: string }>(
    `SELECT id, acronym FROM politicore.political_parties WHERE acronym IN ('APC','PDP')`);
  APC = parties.rows.find((p) => p.acronym === "APC")!.id;
  PDP = parties.rows.find((p) => p.acronym === "PDP")!.id;
  OTHER_PARTY = (await db.query<{ id: string }>(
    `SELECT id FROM politicore.political_parties WHERE acronym NOT IN ('APC','PDP') ORDER BY acronym LIMIT 1`)).rows[0].id;

  // ── users ─────────────────────────────────────────────────────────
  adminA = await createUser(db, { tenantId: TENANT_A, email: "admin-a@test.local", fullName: "Admin A", accessRole: "admin" });
  officerA = await createUser(db, { tenantId: TENANT_A, email: "officer-a@test.local", fullName: "Officer A", accessRole: "election_officer" });
  regPU1 = await createUser(db, { tenantId: TENANT_A, email: "reg1@test.local", fullName: "Reg PU1", membershipTypes: ["campaign_member"], wardId: W1, puId: PU1 });
  regPU2 = await createUser(db, { tenantId: TENANT_A, email: "reg2@test.local", fullName: "Reg PU2", membershipTypes: ["campaign_member"], wardId: W2, puId: PU2 });
  wardGrantUser = await createUser(db, { tenantId: TENANT_A, email: "wardgrant@test.local", fullName: "Ward Grant", membershipTypes: ["campaign_member"] });
  lgaViewer = await createUser(db, { tenantId: TENANT_A, email: "lgaview@test.local", fullName: "LGA Viewer", membershipTypes: ["campaign_member"] });
  zoneViewer = await createUser(db, { tenantId: TENANT_A, email: "zoneview@test.local", fullName: "Zone Viewer", membershipTypes: ["campaign_member"] });
  denyUser = await createUser(db, { tenantId: TENANT_A, email: "deny@test.local", fullName: "Deny User", membershipTypes: ["campaign_member"] });
  socialOnly = await createUser(db, { tenantId: TENANT_A, email: "social@test.local", fullName: "Social Only", membershipTypes: ["social_member"], wardId: W1, puId: PU1 });
  adminB = await createUser(db, { tenantId: TENANT_B, email: "admin-b@test.local", fullName: "Admin B", accessRole: "admin" });
  officerB = await createUser(db, { tenantId: TENANT_B, email: "officer-b@test.local", fullName: "Officer B", accessRole: "election_officer" });
  memberB = await createUser(db, { tenantId: TENANT_B, email: "member-b@test.local", fullName: "Member B" });
  memberC = await createUser(db, { tenantId: TENANT_C, email: "member-c@test.local", fullName: "Member C", membershipTypes: ["campaign_member"], wardId: W1, puId: PU1 });

  // grants / assignments
  await grant(db, TENANT_A, wardGrantUser.authId, "upload_election_result", true, "ward", W1);
  await grant(db, TENANT_A, lgaViewer.authId, "view_election_results", true, "lga", LGA_X);
  await grant(db, TENANT_A, zoneViewer.authId, "view_election_results", true, "senatorial_zone", "enugu-east-zone");
  await grant(db, TENANT_A, denyUser.authId, "view_election_results", true, "lga", LGA_X);
  await grant(db, TENANT_A, denyUser.authId, "view_election_results", false, "ward", W1); // explicit deny wins

  // ── election config fixtures (superuser = trusted setup; the
  //    contest-geography trigger still validates these inserts) ───────
  cycleA = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_cycles (tenant_id, name, year, status, start_date, end_date, created_by)
     VALUES ($1,'Cycle A 2027',2027,'ACTIVE','2027-02-20','2027-03-15',$2) RETURNING id`,
    [TENANT_A, adminA.authId])).rows[0].id;

  contestPres = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, tracked_parties, focus_party_id, created_by)
     VALUES ($1,$2,'presidential','Presidential 2027','national','{APC,PDP}',$3,$4) RETURNING id`,
    [TENANT_A, cycleA, APC, adminA.authId])).rows[0].id;
  contestGov = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_id, tracked_parties, focus_party_id, created_by)
     VALUES ($1,$2,'governorship','Governorship 2027','state',$3,'{APC,PDP}',$4,$5) RETURNING id`,
    [TENANT_A, cycleA, STATE, APC, adminA.authId])).rows[0].id;
  await db.query(`UPDATE politicore.election_contests SET status='OPEN' WHERE id=$1`, [contestGov]);
  contestSen = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_id, tracked_parties, created_by)
     VALUES ($1,$2,'senatorial','Enugu East Senatorial 2027','senatorial_zone',$3,'{APC,PDP}',$4) RETURNING id`,
    [TENANT_A, cycleA, "enugu-east-zone", adminA.authId])).rows[0].id;
  contestFed = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_lgas, state_id, tracked_parties, created_by)
     VALUES ($1,$2,'federal_house','Enugu North/South Federal 2027','federal_constituency',$3::text[],$4,'{APC,PDP}',$5) RETURNING id`,
    [TENANT_A, cycleA, `{${LGA_X},${LGA_Y}}`, STATE, adminA.authId])).rows[0].id;
  await db.query(`UPDATE politicore.election_contests SET status='OPEN' WHERE id=$1`, [contestFed]);
  contestState = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_lgas, state_id, tracked_parties, created_by)
     VALUES ($1,$2,'state_house','Enugu North State 2027','state_constituency',$3::text[],$4,'{APC,PDP}',$5) RETURNING id`,
    [TENANT_A, cycleA, `{${LGA_X}}`, STATE, adminA.authId])).rows[0].id;
  await db.query(`UPDATE politicore.election_contests SET status='OPEN' WHERE id=$1`, [contestState]);
  contestClosed = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_id, tracked_parties, created_by)
     VALUES ($1,$2,'governorship','Old Contest','state',$3,'{APC}',$4) RETURNING id`,
    [TENANT_A, cycleA, STATE, adminA.authId])).rows[0].id;
  await db.query(`UPDATE politicore.election_contests SET status='CLOSED' WHERE id=$1`, [contestClosed]);

  // ── candidate (ballot) fixtures — the 0018 ballot rule requires a
  //    candidate row for every party that appears in a contest's votes
  for (const contest of [contestState, contestGov, contestFed]) {
    for (const party of [APC, PDP]) {
      await db.query(
        `INSERT INTO politicore.election_candidates (tenant_id, contest_id, party_id, candidate_name)
         VALUES ($1,$2,$3,'Test Candidate')`, [TENANT_A, contest, party]);
    }
  }

  cycleC = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_cycles (tenant_id, name, year, status, created_by)
     VALUES ($1,'Cycle C 2027',2027,'ACTIVE',$2) RETURNING id`, [TENANT_C, memberC.authId])).rows[0].id;
  contestC = (await db.query<{ id: string }>(
    `INSERT INTO politicore.election_contests
       (tenant_id, election_cycle_id, contest_type, name, scope_type, scope_id, tracked_parties, created_by)
     VALUES ($1,$2,'governorship','Governorship C','state',$3,'{APC}',$4) RETURNING id`,
    [TENANT_C, cycleC, STATE, memberC.authId])).rows[0].id;
  await db.query(`UPDATE politicore.election_contests SET status='OPEN' WHERE id=$1`, [contestC]);
  await db.query(
    `INSERT INTO politicore.election_candidates (tenant_id, contest_id, party_id, candidate_name)
     VALUES ($1,$2,$3,'Test Candidate C')`, [TENANT_C, contestC, APC]);

  // ── media evidence fixtures ───────────────────────────────────────
  evA = (await db.query<{ id: string }>(
    `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
     VALUES ($1,'test-bucket','ec8-a.pdf','election_evidence',$2) RETURNING id`, [TENANT_A, regPU1.authId])).rows[0].id;
  evWrong = (await db.query<{ id: string }>(
    `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
     VALUES ($1,'test-bucket','cms-news.pdf','cms_news',$2) RETURNING id`, [TENANT_A, regPU1.authId])).rows[0].id;
  evB = (await db.query<{ id: string }>(
    `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
     VALUES ($1,'test-bucket','ec8-b.pdf','election_evidence',$2) RETURNING id`, [TENANT_B, adminB.authId])).rows[0].id;
  evC = (await db.query<{ id: string }>(
    `INSERT INTO politicore.media_assets (tenant_id, bucket, object_key, purpose, uploaded_by)
     VALUES ($1,'test-bucket','ec8-c.pdf','election_evidence',$2) RETURNING id`, [TENANT_C, memberC.authId])).rows[0].id;
});

// convenience: submit as a user
async function submit(uid: string, contest: string, pu: string, votes: string, evidence: string | null) {
  return as(db, "authenticated", uid,
    `SELECT * FROM politicore.submit_election_result($1,$2,$3::jsonb,$4)`,
    [contest, pu, votes, evidence]);
}
async function review(uid: string, result: string, action: string, notes?: string) {
  return as(db, "authenticated", uid,
    `SELECT * FROM politicore.review_election_result($1,$2,$3)`,
    [result, action, notes ?? null]);
}
async function correct(uid: string, result: string, votes: string, reason?: string) {
  return as(db, "authenticated", uid,
    `SELECT * FROM politicore.correct_election_result($1,$2::jsonb,$3)`,
    [result, votes, reason ?? null]);
}

// ════════════════════════════════════════════════════════════════════
describe("submission & authorization (registered PU + scoped grants)", () => {
  it("Test 4 — campaign member submits for their registered PU", async () => {
    const r = await submit(regPU1.authId, contestState, PU1, VOTES_APC_PDP(), evA);
    expect(r.error).toBeUndefined();
    expect(r.rows[0].status).toBe("submitted");
    expect(r.rows[0].verified).toBe(false);
  });

  it("Test 4 — cannot submit for an unauthorized PU (registered elsewhere)", async () => {
    const r = await submit(regPU1.authId, contestGov, PU3, VOTES_APC_PDP(), evA);
    expect(r.error).toMatch(/not authorized to submit results for polling unit/i);
  });

  it("Test 4 — ward assignment ≠ PU authority: ward assignment without permission cannot submit", async () => {
    const u = await createUser(db, { tenantId: TENANT_A, email: "wardassign@test.local", fullName: "Ward Assign", membershipTypes: ["campaign_member"], puId: PU1 });
    await assign(db, TENANT_A, u.authId, "ward_coordinator", "ward", W2);
    // registered at PU1: own-PU submission allowed; PU2 (same assigned ward, not registered) denied
    const r = await submit(u.authId, contestGov, PU2, VOTES_APC_PDP(), evA);
    expect(r.error).toMatch(/not authorized to submit results for polling unit/i);
  });

  it("Test 5 — ward-level grant covers PUs beneath the ward, not the next ward", async () => {
    const ok = await submit(wardGrantUser.authId, contestGov, PU1B, VOTES_APC_PDP(), evA);
    expect(ok.error).toBeUndefined();
    const bad = await submit(wardGrantUser.authId, contestGov, PU2, VOTES_APC_PDP(), evA);
    expect(bad.error).toMatch(/not authorized to submit results/i);
  });

  it("Test 12 — evidence: mandatory", async () => {
    const r = await submit(regPU2.authId, contestState, PU2, VOTES_APC_PDP(), null);
    expect(r.error).toMatch(/evidence.*mandatory/i);
  });

  it("Test 12 — evidence: cross-tenant asset rejected", async () => {
    const r = await submit(regPU2.authId, contestState, PU2, VOTES_APC_PDP(), evB);
    expect(r.error).toMatch(/evidence asset not found in your tenant|not election evidence/i);
  });

  it("Test 12 — evidence: wrong-purpose asset rejected", async () => {
    const r = await submit(regPU2.authId, contestState, PU2, VOTES_APC_PDP(), evWrong);
    expect(r.error).toMatch(/not election evidence/i);
  });

  it("Test 14 — party integrity: unknown party id", async () => {
    const r = await submit(regPU2.authId, contestState, PU2,
      JSON.stringify([{ party_id: crypto.randomUUID(), votes: 5 }]), evA);
    expect(r.error).toMatch(/not a registered participant in this contest/i);
  });

  it("Test 14 — ballot rule: a globally registered party without a candidate row is not votable", async () => {
    const r = await submit(regPU2.authId, contestState, PU2,
      JSON.stringify([{ party_id: OTHER_PARTY, votes: 5 }]), evA);
    expect(r.error).toMatch(/not a registered participant in this contest/i);
  });

  it("Test 14 — party integrity: negative votes", async () => {
    const r = await submit(regPU2.authId, contestState, PU2,
      JSON.stringify([{ party_id: APC, votes: -3 }]), evA);
    expect(r.error).toMatch(/non-negative integer/i);
  });

  it("Test 14 — party integrity: malformed votes JSON", async () => {
    const r1 = await submit(regPU2.authId, contestState, PU2, JSON.stringify({ party_id: APC }), evA);
    expect(r1.error).toMatch(/must be a JSON array/i);
    const r2 = await submit(regPU2.authId, contestState, PU2, JSON.stringify([{ party_id: APC }]), evA);
    expect(r2.error).toMatch(/party_id and votes/i);
    const r3 = await submit(regPU2.authId, contestState, PU2, "[]", evA);
    expect(r3.error).toMatch(/at least one party entry/i);
  });

  it("Test 14 — party integrity: duplicate party and non-integer votes", async () => {
    const dup = await submit(regPU2.authId, contestState, PU2,
      JSON.stringify([{ party_id: APC, votes: 1 }, { party_id: APC, votes: 2 }]), evA);
    expect(dup.error).toMatch(/duplicate part/i);
    const frac = await submit(regPU2.authId, contestState, PU2,
      JSON.stringify([{ party_id: APC, votes: 1.5 }]), evA);
    expect(frac.error).toMatch(/non-negative integer/i);
  });

  it("Test 13 — result identity UNIQUE (contest, PU): resubmission upserts, history accumulates", async () => {
    // self-contained: submit twice — the second call takes the upsert path
    const r1 = await submit(regPU2.authId, contestState, PU2, VOTES_APC_PDP(), evA);
    expect(r1.error).toBeUndefined();
    const r2 = await submit(regPU2.authId, contestState, PU2, VOTES_APC_PDP(), evA);
    expect(r2.error).toBeUndefined();
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM politicore.election_results
       WHERE contest_id=$1 AND polling_unit_id=$2`, [contestState, PU2]);
    expect(rows.rows[0].n).toBe(1);
    const hist = await db.query<{ action: string; n: number }>(
      `SELECT h.action, count(*)::int n FROM politicore.election_result_history h
       JOIN politicore.election_results r ON r.id = h.result_id
       WHERE r.contest_id=$1 AND r.polling_unit_id=$2 AND h.action IN ('create','resubmit')
       GROUP BY h.action`, [contestState, PU2]);
    const byAction = Object.fromEntries(hist.rows.map((x) => [x.action, x.n]));
    expect(byAction["create"]).toBe(1);    // one initial submission
    expect(byAction["resubmit"]).toBe(1);  // resubmissions are distinct events now
    // evidence chain on the resubmit event: old→new asset references
    const ev = await db.query<{ old_evidence_asset_id: string | null; new_evidence_asset_id: string | null }>(
      `SELECT h.old_evidence_asset_id::text, h.new_evidence_asset_id::text
       FROM politicore.election_result_history h
       JOIN politicore.election_results r ON r.id = h.result_id
       WHERE r.contest_id=$1 AND r.polling_unit_id=$2 AND h.action='resubmit'`, [contestState, PU2]);
    expect(ev.rows[0].old_evidence_asset_id).toBe(evA);
    expect(ev.rows[0].new_evidence_asset_id).toBe(evA);
  });

  it("Test 13 — direct client INSERT into election_results is impossible (RPC-only writes)", async () => {
    const r = await as(db, "authenticated", regPU1.authId,
      `INSERT INTO politicore.election_results
         (tenant_id, election_cycle_id, contest_id, polling_unit_id, ward_id, lga_id, evidence_asset_id, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [TENANT_A, cycleA, contestState, PU3, W2, LGA_Y, evA, regPU1.authId]);
    expect(r.error).toMatch(/permission denied/i);
  });

  it("Amendment — direct client INSERT into election_result_votes is impossible (RPC-only writes)", async () => {
    const rid = (await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
      [contestState, PU2])).rows[0].id;
    const ins = await as(db, "authenticated", regPU1.authId,
      `INSERT INTO politicore.election_result_votes (result_id, contest_id, party_id, votes)
       VALUES ($1,$2,$3,7)`, [rid, contestState, APC]);
    expect(ins.error).toMatch(/permission denied/i);
    // native backstop: even as the table owner, a vote for a party that
    // is not a candidate of the result's contest cannot exist
    const owner = await db.query(
      `INSERT INTO politicore.election_result_votes (result_id, contest_id, party_id, votes)
       VALUES ($1,$2,$3,7)`, [rid, contestState, OTHER_PARTY])
      .then(() => null).catch((e: Error) => e.message);
    expect(owner).toMatch(/election_result_votes_/i);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("review workflow (officer / admin separation of duties)", () => {
  it("Test 8 — officer reviews: approve sets verified, reviewed_by, history", async () => {
    const r1 = await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
      [contestState, PU1]);
    const rid = r1.rows[0].id;
    const r = await review(officerA.authId, rid, "approve", "EC8 checked");
    expect(r.error).toBeUndefined();
    expect(r.rows[0].status).toBe("approved");
    expect(r.rows[0].verified).toBe(true);
    const row = await db.query<{ reviewed_by: string }>(
      `SELECT reviewed_by::text FROM politicore.election_results WHERE id=$1`, [rid]);
    expect(row.rows[0].reviewed_by).toBe(officerA.authId);
  });

  it("Test 8 — officer cannot correct results (admin-only)", async () => {
    const rid = (await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
      [contestState, PU1])).rows[0].id;
    const r = await correct(officerA.authId, rid, VOTES_APC_PDP(), "officer attempt");
    expect(r.error).toMatch(/only tenant administrators can correct/i);
  });

  it("Test 8 — officer cannot administer election configuration", async () => {
    const r = await as(db, "authenticated", officerA.authId,
      `INSERT INTO politicore.election_cycles (tenant_id, name, year) VALUES ($1,'X',2030)`, [TENANT_A]);
    expect(r.error).toMatch(/permission denied|new row violates/i);
    const u = await as(db, "authenticated", officerA.authId,
      `UPDATE politicore.election_contests SET status='CLOSED' WHERE id=$1`, [contestState]);
    // RLS USING(is_tenant_admin()) hides the row from the officer: the
    // UPDATE is a silent 0-row no-op, not an error — assert unchanged state.
    expect(u.error).toBeUndefined();
    const st = await db.query<{ status: string }>(
      `SELECT status FROM politicore.election_contests WHERE id=$1`, [contestState]);
    expect(st.rows[0].status).toBe("OPEN");
  });

  it("Test 9 — admin correction: forces pending_review, verified=false, appends correct history", async () => {
    const rid = (await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
      [contestState, PU1])).rows[0].id;
    const corrected = JSON.stringify([{ party_id: APC, votes: 120 }, { party_id: PDP, votes: 55 }]);
    const r = await correct(adminA.authId, rid, corrected, "transcription error");
    expect(r.error).toBeUndefined();
    expect(r.rows[0].status).toBe("pending_review");
    expect(r.rows[0].verified).toBe(false);
    const row = await db.query<{ status: string; verified: boolean; submitted_by: string }>(
      `SELECT status::text, verified, submitted_by::text FROM politicore.election_results WHERE id=$1`, [rid]);
    expect(row.rows[0].status).toBe("pending_review");
    expect(row.rows[0].verified).toBe(false);
    expect(row.rows[0].submitted_by).toBe(regPU1.authId); // submitter preserved
    // corrected votes live as relational ballot rows
    const ballots = await db.query<{ party_id: string; votes: number }>(
      `SELECT party_id::text, votes FROM politicore.election_result_votes WHERE result_id=$1`, [rid]);
    const tally = Object.fromEntries(ballots.rows.map((b) => [b.party_id, b.votes]));
    expect(tally[APC]).toBe(120);
    expect(tally[PDP]).toBe(55);
    const h = await db.query<{ action: string; old_votes: unknown; new_votes: unknown }>(
      `SELECT action, old_votes, new_votes FROM politicore.election_result_history
       WHERE result_id=$1 ORDER BY created_at`, [rid]);
    expect(h.rows.map((x) => x.action)).toEqual(["create", "review_approve", "correct"]);
    expect(h.rows[2].old_votes).not.toEqual(h.rows[2].new_votes);
    // evidence chain survives the correction (correction does not detach evidence)
    const evh = await db.query<{ old_evidence_asset_id: string | null; new_evidence_asset_id: string | null }>(
      `SELECT old_evidence_asset_id::text, new_evidence_asset_id::text FROM politicore.election_result_history
       WHERE result_id=$1 AND action='correct'`, [rid]);
    expect(evh.rows[0].old_evidence_asset_id).toBe(evA);
    expect(evh.rows[0].new_evidence_asset_id).toBe(evA);
  });

  it("Test 10 — correcting admin cannot approve; independent officer can", async () => {
    const rid = (await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
      [contestState, PU1])).rows[0].id;
    const self = await review(adminA.authId, rid, "approve");
    expect(self.error).toMatch(/independent verification required|cannot approve a result you corrected/i);
    const ok = await review(officerA.authId, rid, "approve");
    expect(ok.error).toBeUndefined();
    expect(ok.rows[0].verified).toBe(true);
    const h = await db.query<{ action: string }>(
      `SELECT action FROM politicore.election_result_history WHERE result_id=$1 ORDER BY created_at`, [rid]);
    expect(h.rows.map((x) => x.action)).toEqual(["create", "review_approve", "correct", "review_approve"]);
  });

  it("Test 11 — state machine: illegal transitions fail", async () => {
    // fresh submitted result for transition tests
    const s = await submit(regPU1.authId, contestFed, PU1, VOTES_APC_PDP(), evA);
    expect(s.error).toBeUndefined();
    const rid = (await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
      [contestFed, PU1])).rows[0].id;

    const rej = await review(officerA.authId, rid, "reject", "incomplete");
    expect(rej.rows[0].status).toBe("rejected");
    const approveFromRejected = await review(officerA.authId, rid, "approve");
    expect(approveFromRejected.error).toMatch(/illegal transition/i);
    const reopenFromRejected = await review(officerA.authId, rid, "reopen");
    expect(reopenFromRejected.error).toMatch(/illegal transition/i);

    // member resubmission resets to submitted (rejection recovery path)
    const rs = await submit(regPU1.authId, contestFed, PU1, VOTES_APC_PDP(), evA);
    expect(rs.error).toBeUndefined();

    const cl = await review(officerA.authId, rid, "clarify", "totals unclear");
    expect(cl.rows[0].status).toBe("clarification_required");
    const rs2 = await submit(regPU1.authId, contestFed, PU1, VOTES_APC_PDP(), evA);
    expect(rs2.rows[0].status).toBe("submitted");

    const ap = await review(officerA.authId, rid, "approve");
    expect(ap.rows[0].status).toBe("approved");
    const reopenFromApproved = await review(officerA.authId, rid, "reopen");
    expect(reopenFromApproved.rows[0].status).toBe("reopened");
    const approveTwice = await review(officerA.authId, rid, "approve");
    expect(approveTwice.rows[0].status).toBe("approved");
    const reopenAgain = await review(officerA.authId, rid, "reopen");
    expect(reopenAgain.rows[0].status).toBe("reopened");

    // amendment: an APPROVED result can no longer be overwritten by
    // resubmission — reopen (verifier) or admin correct is the only path back
    const ap2 = await review(officerA.authId, rid, "approve");
    expect(ap2.rows[0].status).toBe("approved");
    const resubmitApproved = await submit(regPU1.authId, contestFed, PU1, VOTES_APC_PDP(), evA);
    expect(resubmitApproved.error).toMatch(/resubmission blocked/i);
    const stillApproved = await db.query<{ status: string; verified: boolean }>(
      `SELECT status::text, verified FROM politicore.election_results WHERE id=$1`, [rid]);
    expect(stillApproved.rows[0].status).toBe("approved");
    expect(stillApproved.rows[0].verified).toBe(true);

    const badAction = await review(officerA.authId, rid, "delete", "x");
    expect(badAction.error).toMatch(/invalid review action/i);

    // the resubmission recovery path is a distinct history action
    const hist = await db.query<{ action: string }>(
      `SELECT action FROM politicore.election_result_history WHERE result_id=$1 ORDER BY created_at`, [rid]);
    expect(hist.rows.map((x) => x.action)).toEqual([
      "create", "review_reject", "resubmit", "review_clarify", "resubmit",
      "review_approve", "reopen", "review_approve", "reopen", "review_approve",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("visibility & aggregation (scope-respecting)", () => {
  it("Test 6 — LGA-level viewer sees results across all wards of the LGA, not other LGAs", async () => {
    // R3 exists in W2 (submitted); R1/R4-adjacent rows in W1; nothing in other LGAs for contestState
    const r = await as(db, "authenticated", lgaViewer.authId,
      `SELECT polling_unit_id FROM politicore.election_results WHERE contest_id=$1 ORDER BY polling_unit_id`,
      [contestState]);
    expect(r.error).toBeUndefined();
    expect(r.rows.map((x) => x.polling_unit_id).sort()).toEqual([PU1, PU2].sort());
  });

  it("Test 10 — zone-level viewer sees results across all LGAs of the zone", async () => {
    const r4 = await submit(officerA.authId, contestGov, PU3, VOTES_APC_PDP(), evA); // LGA_Y, zone enugu-east
    expect(r4.error).toBeUndefined();
    const r = await as(db, "authenticated", zoneViewer.authId,
      `SELECT polling_unit_id FROM politicore.election_results WHERE contest_id=$1 ORDER BY polling_unit_id`,
      [contestGov]);
    // enugu-east zone covers BOTH LGA_X (Enugu North) and LGA_Y (Enugu
    // South) per the verified geography — both contestGov rows are visible.
    expect(r.rows.map((x) => x.polling_unit_id).sort()).toEqual([PU1B, PU3].sort());
    // and the same viewer also sees the LGA_X rows of contestState (zone covers LGA_X)
    const r2 = await as(db, "authenticated", zoneViewer.authId,
      `SELECT count(*)::int n FROM politicore.election_results WHERE contest_id=$1`, [contestState]);
    expect(r2.rows[0].n).toBe(2);
  });

  it("Test 10 — registered-PU member sees own PU row but not the neighbor ward", async () => {
    const r = await as(db, "authenticated", regPU1.authId,
      `SELECT polling_unit_id FROM politicore.election_results WHERE contest_id=$1`, [contestState]);
    expect(r.rows.map((x) => x.polling_unit_id)).toEqual([PU1]);
  });

  it("Test 7 — explicit deny wins over a broader allow", async () => {
    const r = await as(db, "authenticated", denyUser.authId,
      `SELECT polling_unit_id FROM politicore.election_results WHERE contest_id=$1 ORDER BY polling_unit_id`,
      [contestState]);
    expect(r.rows.map((x) => x.polling_unit_id)).toEqual([PU2]); // W1 denied, W2 visible
  });

  it("Test 15 — aggregation respects caller scope (parties from approved rows only)", async () => {
    // admin, state scope for contestGov: one approved row (officer approved PU3 below after this? keep submitted)
    const ap = await review(officerA.authId,
      (await db.query<{ id: string }>(
        `SELECT id FROM politicore.election_results WHERE contest_id=$1 AND polling_unit_id=$2`,
        [contestGov, PU3])).rows[0].id, "approve");
    expect(ap.error).toBeUndefined();

    const agg = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.get_results_aggregate($1,$2,'lga',$3)`,
      [cycleA, contestGov, LGA_Y]);
    expect(agg.error).toBeUndefined();
    const a = agg.rows[0].get_results_aggregate as Record<string, unknown>;
    expect(a["approved_pus"]).toBe(1);
    expect(a["party_totals"]).toEqual([
      { party_id: APC, acronym: "APC", name: "All Progressives Congress", total_votes: 100 },
      { party_id: PDP, acronym: "PDP", name: "Peoples Democratic Party", total_votes: 60 },
    ]);

    // ward scope for contestState by the LGA viewer: sees both wards
    const agg2 = await as(db, "authenticated", lgaViewer.authId,
      `SELECT politicore.get_results_aggregate($1,$2,'lga',$3)`,
      [cycleA, contestState, LGA_X]);
    const a2 = agg2.rows[0].get_results_aggregate as Record<string, unknown>;
    expect(a2["approved_pus"]).toBe(1); // PU1 approved twice over (final state), PU2 submitted
    expect(a2["pending_pus"]).toBe(1);

    // a member with no visibility gets empty party totals (no leak)
    const agg3 = await as(db, "authenticated", socialOnly.authId,
      `SELECT politicore.get_results_aggregate($1,$2,NULL,NULL)`, [cycleA, contestState]);
    expect(agg3.error).toMatch(/contest not found in your tenant/i);
  });

  it("Test 15 — aggregation reporting percentage is geography-derived", async () => {
    const agg = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.get_results_aggregate($1,$2,'ward',$3)`, [cycleA, contestState, W1]);
    const a = agg.rows[0].get_results_aggregate as Record<string, unknown>;
    const total = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM politicore.polling_units WHERE ward_id=$1`, [W1]);
    expect(a["total_pus_in_scope"]).toBe(total.rows[0].n);
    expect(a["approved_pus"]).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("boundaries & hard guarantees", () => {
  it("Test 1 — tenant isolation: tenant B sees and can touch nothing of tenant A", async () => {
    const sel = await as(db, "authenticated", officerB.authId,
      `SELECT count(*)::int n FROM politicore.election_results WHERE contest_id=$1`, [contestState]);
    expect(sel.rows[0].n).toBe(0);
    const cyc = await as(db, "authenticated", adminB.authId,
      `SELECT count(*)::int n FROM politicore.election_cycles WHERE id=$1`, [cycleA]);
    expect(cyc.rows[0].n).toBe(0);
    const rid = (await db.query<{ id: string }>(
      `SELECT id FROM politicore.election_results WHERE contest_id=$1 LIMIT 1`, [contestState])).rows[0].id;
    // memberC: tenant C has election ENABLED, so the module gate passes
    // and the RPC's tenant filter itself hides tenant A's result — pure
    // tenant isolation at the RPC boundary. (officerB would trip the
    // module gate first: tenant B is election-disabled by fixture.)
    const rev = await review(memberC.authId, rid, "approve");
    expect(rev.error).toMatch(/result not found in your tenant/i);
    const revB = await as(db, "authenticated", officerB.authId,
      `SELECT politicore.review_election_result($1,'approve')`, [rid]);
    expect(revB.error).toMatch(/election module is not enabled/i);
  });

  it("Test 2 — election-disabled tenant: no reads, no writes, no RPC", async () => {
    const ins = await as(db, "authenticated", adminB.authId,
      `INSERT INTO politicore.election_cycles (tenant_id, name, year) VALUES ($1,'B Cycle',2027)`, [TENANT_B]);
    expect(ins.error).toMatch(/permission denied|violates/i);
    const sel = await as(db, "authenticated", memberB.authId,
      `SELECT count(*)::int n FROM politicore.election_contests`);
    expect(sel.rows[0].n).toBe(0);
    const rpc = await submit(adminB.authId, contestState, PU1, VOTES_APC_PDP(), evB);
    expect(rpc.error).toMatch(/election module is not enabled/i);
  });

  it("Test 3 — social-only member: zero access on every surface", async () => {
    for (const t of ["election_cycles","election_contests","election_candidates","election_results",
                     "election_result_votes","election_result_history","pu_reports","election_incidents","election_settings"]) {
      const r = await as(db, "authenticated", socialOnly.authId, `SELECT count(*)::int n FROM politicore.${t}`);
      expect(r.rows[0].n).toBe(0);
    }
    const view = await as(db, "authenticated", socialOnly.authId,
      `SELECT count(*)::int n FROM public.election_results_current`);
    expect(view.rows[0].n).toBe(0);
    const rpc = await submit(socialOnly.authId, contestState, PU1, VOTES_APC_PDP(), evA);
    expect(rpc.error).toMatch(/social members do not have election access|not authorized/i);
  });

  it("Test 16 — history is append-only: no client writes; RPC-guard blocks direct inserts", async () => {
    const ins = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.election_result_history (tenant_id, result_id, action, actor_id)
       SELECT tenant_id, id, 'create', $1 FROM politicore.election_results LIMIT 1`, [adminA.authId]);
    expect(ins.error).toMatch(/permission denied/i);
    const upd = await as(db, "authenticated", adminA.authId,
      `UPDATE politicore.election_result_history SET notes='tampered'`);
    expect(upd.error).toMatch(/permission denied/i);
    const del = await as(db, "authenticated", adminA.authId,
      `DELETE FROM politicore.election_result_history`);
    expect(del.error).toMatch(/permission denied/i);
    // even the table owner cannot bypass the RPC-context guard
    const owner = await db.query(
      `INSERT INTO politicore.election_result_history (tenant_id, result_id, action, actor_id)
       SELECT tenant_id, id, 'create', submitted_by FROM politicore.election_results LIMIT 1`)
      .then(() => null).catch((e: Error) => e.message);
    expect(owner).toMatch(/append-only and writable only by election workflow RPCs/i);
  });

  it("Test 17 — configuration: admin-only, contest∈cycle, no cross-tenant, no CLOSED activation", async () => {
    const mk = await as(db, "authenticated", adminA.authId,
      `INSERT INTO politicore.election_cycles (tenant_id, name, year, status) VALUES ($1,'Admin Cycle',2029,'ACTIVE') RETURNING id`,
      [TENANT_A]);
    expect(mk.error).toBeUndefined(); // RLS admin path works
    const newCycle = mk.rows[0].id as string;

    const set = await as(db, "authenticated", adminA.authId,
      `SELECT * FROM politicore.set_active_election($1,$2)`, [cycleA, contestState]);
    expect(set.error).toBeUndefined();

    const wrongCycle = await as(db, "authenticated", adminA.authId,
      `SELECT * FROM politicore.set_active_election($1,$2)`, [newCycle, contestState]);
    expect(wrongCycle.error).toMatch(/contest does not belong to the given election cycle/i);

    const crossTenant = await as(db, "authenticated", adminA.authId,
      `SELECT * FROM politicore.set_active_election($1,$2)`, [cycleC, contestC]);
    expect(crossTenant.error).toMatch(/not found in your tenant/i);

    const closed = await as(db, "authenticated", adminA.authId,
      `SELECT * FROM politicore.set_active_election($1,$2)`, [cycleA, contestClosed]);
    expect(closed.error).toMatch(/CLOSED contest cannot be set as the active contest/i);

    const nonAdmin = await as(db, "authenticated", officerA.authId,
      `SELECT * FROM politicore.set_active_election($1,$2)`, [cycleA, contestState]);
    expect(nonAdmin.error).toMatch(/only tenant administrators can configure/i);

    const nonAdminInsert = await as(db, "authenticated", regPU1.authId,
      `INSERT INTO politicore.election_settings (tenant_id, active_cycle_id) VALUES ($1,$2)`,
      [TENANT_A, cycleA]);
    expect(nonAdminInsert.error).toMatch(/permission denied|violates/i);
  });

  it("Test 18 — module independence: Election works with Campaign disabled (tenant C)", async () => {
    const mods = await db.query<{ campaign: boolean; election: boolean }>(
      `SELECT bool_or(module='campaign' AND enabled) campaign,
              bool_or(module='election' AND enabled) election
       FROM politicore.tenant_modules WHERE tenant_id=$1`, [TENANT_C]);
    expect(mods.rows[0].campaign).toBe(false);
    expect(mods.rows[0].election).toBe(true);

    const r = await submit(memberC.authId, contestC, PU1, JSON.stringify([{ party_id: APC, votes: 10 }]), evC);
    expect(r.error).toBeUndefined();
    expect(r.rows[0].status).toBe("submitted");
  });

  it("bonus — verified ⇔ approved invariant holds at every instant (DB CHECK)", async () => {
    const bad = await db.query(
      `UPDATE politicore.election_results SET verified = true WHERE status = 'submitted'`)
      .then(() => null).catch((e: Error) => e.message);
    expect(bad).toMatch(/violates check constraint/i);
  });

  it("bonus — realtime publication carries the three election tables", async () => {
    const pub = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='politicore'
         AND tablename IN ('election_results','pu_reports','election_incidents')
       ORDER BY tablename`);
    // pglite may lack the publication (hosted-only); assert when present
    const settings = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='politicore' AND tablename='election_settings'`);
    expect(settings.rows[0].n).toBe(0);
    if (pub.rows.length > 0) {
      expect(pub.rows.map((p) => p.tablename)).toEqual(["election_incidents", "election_results", "pu_reports"]);
    }
  });

  it("bonus — view resolves party labels from IDs (no name strings)", async () => {
    const v = await as(db, "authenticated", adminA.authId,
      `SELECT vote_details FROM public.election_results_current
       WHERE contest_id=$1 AND polling_unit_id=$2`, [contestState, PU1]);
    expect(v.error).toBeUndefined();
    const details = v.rows[0].vote_details as Array<{ acronym: string; votes: number }>;
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]).toHaveProperty("acronym");
    expect(details[0]).toHaveProperty("party_id");
  });
});

// ════════════════════════════════════════════════════════════════════
describe("relational analytics & evidence chain (amendment gate)", () => {
  it("analytics — total votes by party across a contest (approved rows only, plain joins)", async () => {
    const r = await db.query<{ acronym: string; total: string }>(
      `SELECT pp.acronym, sum(rv.votes)::text total
       FROM politicore.election_result_votes rv
       JOIN politicore.election_results r ON r.id = rv.result_id
       JOIN politicore.political_parties pp ON pp.id = rv.party_id
       WHERE r.contest_id=$1 AND r.status='approved'
       GROUP BY pp.acronym ORDER BY pp.acronym`, [contestGov]);
    const byAcronym = Object.fromEntries(r.rows.map((x) => [x.acronym, Number(x.total)]));
    expect(byAcronym["APC"]).toBe(100);
    expect(byAcronym["PDP"]).toBe(60);
  });

  it("analytics — rollups by ward, LGA, and senatorial zone via ordinary joins", async () => {
    // ward W1 (contestState): PU1 approved (120/55), PU2 submitted → excluded
    const ward = await db.query<{ acronym: string; total: string }>(
      `SELECT pp.acronym, sum(rv.votes)::text total
       FROM politicore.election_result_votes rv
       JOIN politicore.election_results r ON r.id = rv.result_id
       JOIN politicore.political_parties pp ON pp.id = rv.party_id
       WHERE r.contest_id=$1 AND r.ward_id=$2 AND r.status='approved'
       GROUP BY pp.acronym ORDER BY pp.acronym`, [contestState, W1]);
    const w = Object.fromEntries(ward.rows.map((x) => [x.acronym, Number(x.total)]));
    expect(w["APC"]).toBe(120);
    expect(w["PDP"]).toBe(55);

    // LGA rollup (contestGov approved rows are all in LGA_Y)
    const lga = await db.query<{ acronym: string; total: string }>(
      `SELECT pp.acronym, sum(rv.votes)::text total
       FROM politicore.election_result_votes rv
       JOIN politicore.election_results r ON r.id = rv.result_id
       JOIN politicore.political_parties pp ON pp.id = rv.party_id
       WHERE r.contest_id=$1 AND r.lga_id=$2 AND r.status='approved'
       GROUP BY pp.acronym ORDER BY pp.acronym`, [contestGov, LGA_Y]);
    const l = Object.fromEntries(lga.rows.map((x) => [x.acronym, Number(x.total)]));
    expect(l["APC"]).toBe(100);
    expect(l["PDP"]).toBe(60);

    // senatorial-zone rollup through the geography hierarchy
    const zone = await db.query<{ acronym: string; total: string }>(
      `SELECT pp.acronym, sum(rv.votes)::text total
       FROM politicore.election_result_votes rv
       JOIN politicore.election_results r ON r.id = rv.result_id
       JOIN politicore.lgas lg ON lg.id = r.lga_id
       JOIN politicore.political_parties pp ON pp.id = rv.party_id
       WHERE r.contest_id=$1 AND lg.zone_id='enugu-east-zone' AND r.status='approved'
       GROUP BY pp.acronym ORDER BY pp.acronym`, [contestGov]);
    const z = Object.fromEntries(zone.rows.map((x) => [x.acronym, Number(x.total)]));
    expect(z["APC"]).toBe(100);
    expect(z["PDP"]).toBe(60);
  });

  it("analytics — aggregate RPC totals equal the SQL-join totals", async () => {
    const agg = await as(db, "authenticated", adminA.authId,
      `SELECT politicore.get_results_aggregate($1,$2,NULL,NULL)`, [cycleA, contestGov]);
    const a = agg.rows[0].get_results_aggregate as { party_totals: Array<{ acronym: string; total_votes: number }> };
    const rpc = Object.fromEntries(a.party_totals.map((p) => [p.acronym, p.total_votes]));
    const sql = await db.query<{ acronym: string; total: string }>(
      `SELECT pp.acronym, sum(rv.votes)::text total
       FROM politicore.election_result_votes rv
       JOIN politicore.election_results r ON r.id = rv.result_id
       JOIN politicore.political_parties pp ON pp.id = rv.party_id
       WHERE r.contest_id=$1 AND r.status='approved' AND r.tenant_id=$2
       GROUP BY pp.acronym`, [contestGov, TENANT_A]);
    const joined = Object.fromEntries(sql.rows.map((x) => [x.acronym, Number(x.total)]));
    expect(rpc).toEqual(joined);
  });

  it("evidence chain — every vote-bearing history event carries its evidence references", async () => {
    // invariant across ALL of tenant A's history: a votes snapshot
    // always coexists with a new-evidence reference
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM politicore.election_result_history h
       JOIN politicore.election_results res ON res.id = h.result_id
       WHERE res.tenant_id=$1 AND h.new_votes IS NOT NULL AND h.new_evidence_asset_id IS NULL`,
      [TENANT_A]);
    expect(r.rows[0].n).toBe(0);

    // create events reference the submitted evidence
    const chain = await db.query<{ action: string; old_evidence_asset_id: string | null; new_evidence_asset_id: string | null }>(
      `SELECT h.action, h.old_evidence_asset_id::text, h.new_evidence_asset_id::text
       FROM politicore.election_result_history h
       JOIN politicore.election_results res ON res.id = h.result_id
       WHERE res.tenant_id=$1 AND res.contest_id=$2 AND res.polling_unit_id=$3
       ORDER BY h.created_at`, [TENANT_A, contestState, PU2]);
    expect(chain.rows[0].action).toBe("create");
    expect(chain.rows[0].new_evidence_asset_id).toBe(evA);
  });
});
