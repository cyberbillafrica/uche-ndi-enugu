/**
 * POLITICORE — GOVERNANCE PHASE 19 — ANALYTICS & INSTITUTIONAL MEMORY
 * SECURITY SUITE.
 *
 * Proves the Analytics slice (migrations 0058 + 0059 hardening) against
 * role-impersonated sessions (helpers.as) — the same acceptance standard
 * as Phases 6–18:
 *
 *   A. Authority — staff-gated: anon holds nothing; authenticated
 *      members without view_governance get nothing; module-off blocks
 *      all five analytics RPCs + the memory timeline.
 *   B. Tenant isolation — tenant B's aggregates are zero while tenant A
 *      holds data; tenant A's records never appear in B's timeline.
 *   C. §7 scope hardening (the 0059 contract):
 *        C1 tenant admin           → whole tenant
 *        C2 explicit UNSCOPED grant → whole tenant (legitimate)
 *        C3 explicit WARD-scoped grant → covered slices ONLY (per-row)
 *        C4 position default at ward scope → covered slices ONLY —
 *          position defaults NEVER confer tenant-wide analytics
 *        C5 scope-less entities are invisible to scoped callers
 *        C6 a scoped caller cannot widen by omitting filters (no
 *          filter parameters exist to omit — server-resolved)
 *   D. Derived correctness — status/statuses/buckets match canonical
 *      fixture data; duration + privacy buckets via governance_privacy_*.
 *   E. Privacy — no participant identity, contact, or case text in any
 *      analytics/timeline payload; individual responses/votes/signers
 *      structurally unreachable.
 *   F. Institutional memory — bounded timeline over canonical records
 *      only; kind filter + limit/offset honored; no second history model.
 *   G. Hygiene — no new tables; RPC execute granted to authenticated,
 *      withheld from anon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { as, assign, createTenant, createUser, getDb, grant } from "./helpers";

interface Staff {
  authId: string;
  email: string;
  profileId: string;
}

const RPCS = [
  "governance_analytics_requests",
  "governance_analytics_delivery",
  "governance_analytics_participation",
  "governance_analytics_engagements",
  "governance_analytics_accountability",
] as const;

const callRpc = (name: string) => `SELECT * FROM politicore.${name}()`;

describe("Governance Phase 19 — Analytics & Institutional Memory", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let tenantOff: string;
  let adminA: Staff;
  let analystA: Staff; // explicit UNSCOPED view_governance grant → tenant-wide
  let wardStaffA: Staff; // explicit WARD-scoped view_governance grant → slices only
  let positionStaffA: Staff; // position default at ward scope → slices only
  let memberA: Staff; // no authority
  let adminB: Staff;
  let adminOff: Staff; // admin of module-OFF tenant

  const STATE = "pst19";
  const ZONE = "pz19";
  const LGA = "pl19";
  const WARD_A = "pw19a";
  const WARD_B = "pw19b";
  const PU = "pp19";

  const ids = {
    participantA: "" as string,
    participantB: "" as string,
    waterCat: "" as string,
    projectWardA: "" as string,
    projectWardB: "" as string,
    commitmentWardA: "" as string,
    commitmentScopeless: "" as string,
    consultationWardA: "" as string,
    engagementWardA: "" as string,
  };

  const insertScope = async (
    table: string,
    parentCol: string,
    parentId: string,
    ward: string
  ) => {
    await db.query(
      `INSERT INTO politicore.${table}
         (tenant_id, ${parentCol}, scope_type, state_id, zone_id, lga_id, ward_id)
       VALUES ($1,$2,'ward',$3,$4,$5,$6)`,
      [tenantA, parentId, STATE, ZONE, LGA, ward]
    );
  };

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "p19-a", "P19 Tenant A", { governance: true });
    tenantB = await createTenant(db, "p19-b", "P19 Tenant B", { governance: true });
    tenantOff = await createTenant(db, "p19-off", "P19 Module Off", {}); // governance OFF

    adminA = await createUser(db, { tenantId: tenantA, email: "p19-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    analystA = await createUser(db, { tenantId: tenantA, email: "p19-analyst@a.test", fullName: "Analyst A" });
    wardStaffA = await createUser(db, { tenantId: tenantA, email: "p19-ward@a.test", fullName: "Ward Staff A" });
    positionStaffA = await createUser(db, { tenantId: tenantA, email: "p19-pos@a.test", fullName: "Position Staff A" });
    memberA = await createUser(db, { tenantId: tenantA, email: "p19-member@a.test", fullName: "Member A" });
    adminB = await createUser(db, { tenantId: tenantB, email: "p19-admin@b.test", fullName: "Admin B", accessRole: "admin" });
    adminOff = await createUser(db, { tenantId: tenantOff, email: "p19-off@o.test", fullName: "Admin Off", accessRole: "admin" });

    // Authority fixtures
    await grant(db, tenantA, analystA.authId, "view_governance", true); // unscoped → tenant-wide
    await grant(db, tenantA, wardStaffA.authId, "view_governance", true, "ward", WARD_A); // scoped
    // Position-default path: seed the position reference row, its
    // permission mapping, then assign at ward scope.
    await db.query(`INSERT INTO politicore.positions (name, description) VALUES ('governance_analyst','P19 fixture position') ON CONFLICT (name) DO NOTHING`);
    await db.query(
      `INSERT INTO politicore.position_permissions (position, permission)
       VALUES ('governance_analyst','view_governance') ON CONFLICT DO NOTHING`
    );
    await assign(db, tenantA, positionStaffA.authId, "governance_analyst", "ward", WARD_A);

    // Core Geography fixtures
    await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P19State','PS') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P19Zone','PZ') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P19Lga','PL') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P19WardA','PWA') ON CONFLICT (id) DO NOTHING`, [WARD_A, LGA]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P19WardB','PWB') ON CONFLICT (id) DO NOTHING`, [WARD_B, LGA]);
    await db.query(`INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code) VALUES ($1,$2,$3,'P19PU','PP') ON CONFLICT (id) DO NOTHING`, [PU, WARD_A, LGA]);

    // ── canonical Governance fixtures (service_role / superuser path) ──
    const cat = await db.query(
      `INSERT INTO politicore.governance_request_categories (tenant_id, name) VALUES ($1,'P19 Water') RETURNING id`, [tenantA]);
    ids.waterCat = (cat.rows[0] as Record<string, unknown>).id as string;

    const part = await db.query(
      `INSERT INTO politicore.governance_participants (tenant_id, full_name, email) VALUES ($1,'P19 Citizen','p19-citizen@a.test') RETURNING id`, [tenantA]);
    ids.participantA = (part.rows[0] as Record<string, unknown>).id as string;
    const part2 = await db.query(
      `INSERT INTO politicore.governance_participants (tenant_id, full_name, email) VALUES ($1,'P19 Citizen B','p19-citizen2@a.test') RETURNING id`, [tenantA]);
    ids.participantB = (part2.rows[0] as Record<string, unknown>).id as string;

    // Requests: one resolved in WARD_A, one submitted in WARD_B
    await db.query(
      `INSERT INTO politicore.governance_requests
         (tenant_id, reference_code, participant_id, category_id, title, status, ward_id, resolved_at, created_at)
       VALUES ($1,'GR-P19A',$2,$3,'Leaking pipe WardA','resolved',$4, now() - interval '3 days', now() - interval '10 days')`,
      [tenantA, ids.participantA, ids.waterCat, WARD_A]);
    await db.query(
      `INSERT INTO politicore.governance_requests
         (tenant_id, reference_code, participant_id, category_id, title, status, ward_id, created_at)
       VALUES ($1,'GR-P19B',$2,$3,'Broken borehole WardB','submitted',$4, now() - interval '40 days')`,
      [tenantA, ids.participantA, ids.waterCat, WARD_B]);

    // Projects: P1 ward-A (active, public, 2 milestones / 1 done), P2 ward-B (completed)
    const p1 = await db.query(
      `INSERT INTO politicore.governance_projects (tenant_id, reference_code, title, status, is_public)
       VALUES ($1,'GP-P19A','WardA Water Project','active',true) RETURNING id`, [tenantA]);
    ids.projectWardA = (p1.rows[0] as Record<string, unknown>).id as string;
    const p2 = await db.query(
      `INSERT INTO politicore.governance_projects (tenant_id, reference_code, title, status, is_public)
       VALUES ($1,'GP-P19B','WardB Road Project','completed',false) RETURNING id`, [tenantA]);
    ids.projectWardB = (p2.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_project_scopes", "project_id", ids.projectWardA, WARD_A);
    await insertScope("governance_project_scopes", "project_id", ids.projectWardB, WARD_B);
    await db.query(`INSERT INTO politicore.governance_project_milestones (tenant_id, project_id, title, status) VALUES ($1,$2,'M1','done'),($1,$2,'M2','in_progress')`, [tenantA, ids.projectWardA]);
    await db.query(`INSERT INTO politicore.governance_project_milestones (tenant_id, project_id, title, status) VALUES ($1,$2,'M3','pending')`, [tenantA, ids.projectWardB]);

    // Commitments: C1 ward-A linked to P1; C2 deliberately scope-less
    const c1 = await db.query(
      `INSERT INTO politicore.governance_commitments (tenant_id, reference_code, title, status)
       VALUES ($1,'GC-P19A','WardA Water Commitment','in_progress') RETURNING id`, [tenantA]);
    ids.commitmentWardA = (c1.rows[0] as Record<string, unknown>).id as string;
    const c2 = await db.query(
      `INSERT INTO politicore.governance_commitments (tenant_id, reference_code, title, status)
       VALUES ($1,'GC-P19B','Scopeless Commitment','declared') RETURNING id`, [tenantA]);
    ids.commitmentScopeless = (c2.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_commitment_scopes", "commitment_id", ids.commitmentWardA, WARD_A);
    await db.query(`INSERT INTO politicore.governance_commitment_projects (tenant_id, commitment_id, project_id) VALUES ($1,$2,$3)`,
      [tenantA, ids.commitmentWardA, ids.projectWardA]);

    // Consultations: K1 ward-A open (2 responses); K2 ward-B survey, results published
    const k1 = await db.query(
      `INSERT INTO politicore.governance_consultations (tenant_id, kind, reference_code, title, status)
       VALUES ($1,'consultation','PK-P19A','WardA Consultation','open') RETURNING id`, [tenantA]);
    ids.consultationWardA = (k1.rows[0] as Record<string, unknown>).id as string;
    const k2 = await db.query(
      `INSERT INTO politicore.governance_consultations (tenant_id, kind, reference_code, title, status, results)
       VALUES ($1,'survey','PK-P19B','WardB Survey','results_published','{"summary":true}'::jsonb) RETURNING id`, [tenantA]);
    const k2id = (k2.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_consultation_scopes", "consultation_id", ids.consultationWardA, WARD_A);
    await insertScope("governance_consultation_scopes", "consultation_id", k2id, WARD_B);
    await db.query(`INSERT INTO politicore.governance_consultation_responses (tenant_id, consultation_id, participant_id, answers) VALUES ($1,$2,$3,'{"q1":"a"}'::jsonb),($1,$2,$4,'{"q1":"b"}'::jsonb)`,
      [tenantA, ids.consultationWardA, ids.participantA, ids.participantB]);

    // Petitions: E1 petition ward-A open w/ verified 7; E2 proposal ward-B
    // (verified snapshot CHECK: verified_at set iff verified_count set)
    const e1 = await db.query(
      `INSERT INTO politicore.governance_petitions (tenant_id, origin, reference_code, title, status, verified_count, verified_at)
       VALUES ($1,'petition','PP-P19A','WardA Petition','open',7, now()) RETURNING id`, [tenantA]);
    const e1id = (e1.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_petition_scopes", "petition_id", e1id, WARD_A);
    const e2 = await db.query(
      `INSERT INTO politicore.governance_petitions (tenant_id, origin, reference_code, title, status, proposer_participant_id)
       VALUES ($1,'community_proposal','PP-P19B','WardB Proposal','draft',$2) RETURNING id`, [tenantA, ids.participantA]);
    const e2id = (e2.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_petition_scopes", "petition_id", e2id, WARD_B);

    // Polls: Q1 ward-A open with 3 votes
    const q1 = await db.query(
      `INSERT INTO politicore.governance_polls (tenant_id, reference_code, title, question, options, status)
       VALUES ($1,'PL-P19A','WardA Poll','Priority?','["a","b"]'::jsonb,'open') RETURNING id`, [tenantA]);
    const q1id = (q1.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_poll_scopes", "poll_id", q1id, WARD_A);
    await db.query(`INSERT INTO politicore.governance_poll_votes (tenant_id, poll_id, participant_id, choice) VALUES ($1,$2,$3,'a'),($1,$2,$4,'b')`,
      [tenantA, q1id, ids.participantA, ids.participantB]);

    // Engagements: G1 ward-A scheduled public (2 attendance, 1 open + 1 closed issue);
    // G2 ward-B concluded
    const g1 = await db.query(
      `INSERT INTO politicore.governance_engagements (tenant_id, reference_code, title, status, is_public, scheduled_at)
       VALUES ($1,'EN-P19A','WardA Townhall','scheduled',true, now() + interval '7 days') RETURNING id`, [tenantA]);
    ids.engagementWardA = (g1.rows[0] as Record<string, unknown>).id as string;
    const g2 = await db.query(
      `INSERT INTO politicore.governance_engagements (tenant_id, reference_code, title, status, held_at)
       VALUES ($1,'EN-P19B','WardB Walkabout','concluded', now() - interval '5 days') RETURNING id`, [tenantA]);
    const g2id = (g2.rows[0] as Record<string, unknown>).id as string;
    await insertScope("governance_engagement_scopes", "engagement_id", ids.engagementWardA, WARD_A);
    await insertScope("governance_engagement_scopes", "engagement_id", g2id, WARD_B);
    await db.query(`INSERT INTO politicore.governance_engagement_attendance (tenant_id, engagement_id, participant_id) VALUES ($1,$2,$3),($1,$2,$4)`,
      [tenantA, ids.engagementWardA, ids.participantA, ids.participantB]);
    await db.query(`INSERT INTO politicore.governance_engagement_issues (tenant_id, engagement_id, title, status) VALUES ($1,$2,'Water pressure','open'),($1,$2,'Road dust','closed')`,
      [tenantA, ids.engagementWardA]);

    // Canonical updates substrate: one project update, one engagement follow-up
    await db.query(`INSERT INTO politicore.governance_updates (tenant_id, project_id, title, body, kind, author_profile_id) VALUES ($1,$2,'Pipeline laid','Phase one complete.','progress',$3)`,
      [tenantA, ids.projectWardA, adminA.profileId]);
    await db.query(`INSERT INTO politicore.governance_updates (tenant_id, engagement_id, title, body, kind, author_profile_id) VALUES ($1,$2,'Follow-up scheduled','Second townhall agreed.','announcement',$3)`,
      [tenantA, ids.engagementWardA, adminA.profileId]);
  });

  afterAll(async () => {
    // Global reference rows seeded for the position-default proof are
    // removed so the shared PGlite stays pristine for other suites.
    await db.query(`DELETE FROM politicore.position_permissions WHERE position = 'governance_analyst' AND permission = 'view_governance'`);
  });

  // ── A. authority ────────────────────────────────────────────────────
  describe("A. authority", () => {
    it("anon holds nothing on any analytics or memory surface", async () => {
      for (const rpc of RPCS) {
        const r = await as(db, "anon", null, callRpc(rpc));
        expect(r.error).toBeDefined();
      }
      const mem = await as(db, "anon", null, `SELECT * FROM politicore.governance_memory_timeline(NULL, 10, 0)`);
      expect(mem.error).toBeDefined();
    });

    it("a member without view_governance is denied everywhere", async () => {
      for (const rpc of RPCS) {
        const r = await as(db, "authenticated", memberA.authId, callRpc(rpc));
        expect(r.error).toMatch(/view_governance/);
      }
      const mem = await as(db, "authenticated", memberA.authId, `SELECT * FROM politicore.governance_memory_timeline(NULL, 10, 0)`);
      expect(mem.error).toMatch(/view_governance/);
    });

    it("module-off tenant is blocked even for its admin", async () => {
      for (const rpc of RPCS) {
        const r = await as(db, "authenticated", adminOff.authId, callRpc(rpc));
        expect(r.error).toMatch(/module is not enabled/);
      }
      const mem = await as(db, "authenticated", adminOff.authId, `SELECT * FROM politicore.governance_memory_timeline(NULL, 10, 0)`);
      expect(mem.error).toMatch(/module is not enabled/);
    });
  });

  // ── B. tenant isolation ─────────────────────────────────────────────
  describe("B. tenant isolation", () => {
    it("tenant B aggregates are zero while tenant A holds data", async () => {
      const req = await as(db, "authenticated", adminB.authId, callRpc("governance_analytics_requests"));
      expect(req.error).toBeUndefined();
      expect(Number((req.rows[0] as Record<string, unknown>).total)).toBe(0);

      const del = await as(db, "authenticated", adminB.authId, callRpc("governance_analytics_delivery"));
      expect(Number((del.rows[0] as Record<string, unknown>).projects_total)).toBe(0);

      const part = await as(db, "authenticated", adminB.authId, callRpc("governance_analytics_participation"));
      expect(Number((part.rows[0] as Record<string, unknown>).polls_total)).toBe(0);

      const eng = await as(db, "authenticated", adminB.authId, callRpc("governance_analytics_engagements"));
      expect(Number((eng.rows[0] as Record<string, unknown>).total)).toBe(0);
    });

    it("tenant A records never appear in tenant B's memory timeline", async () => {
      const mem = await as(db, "authenticated", adminB.authId, `SELECT * FROM politicore.governance_memory_timeline(NULL, 200, 0)`);
      expect(mem.error).toBeUndefined();
      expect(mem.rows).toHaveLength(0);
    });
  });

  // ── C. §7 scope hardening (0059) ────────────────────────────────────
  describe("C. §7 scope hardening", () => {
    it("C1. tenant admin sees the whole tenant", async () => {
      const del = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_delivery"));
      expect(Number((del.rows[0] as Record<string, unknown>).projects_total)).toBe(2);
      const req = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_requests"));
      expect(Number((req.rows[0] as Record<string, unknown>).total)).toBe(2);
    });

    it("C2. an explicit UNSCOPED grant legitimately yields tenant-wide analytics", async () => {
      const del = await as(db, "authenticated", analystA.authId, callRpc("governance_analytics_delivery"));
      expect(Number((del.rows[0] as Record<string, unknown>).projects_total)).toBe(2);
      const req = await as(db, "authenticated", analystA.authId, callRpc("governance_analytics_requests"));
      expect(Number((req.rows[0] as Record<string, unknown>).total)).toBe(2);
    });

    it("C3. an explicit WARD-scoped grant sees covered slices ONLY", async () => {
      const del = await as(db, "authenticated", wardStaffA.authId, callRpc("governance_analytics_delivery"));
      const row = del.rows[0] as Record<string, unknown>;
      expect(Number(row.projects_total)).toBe(1);
      expect(Number(row.milestones_total)).toBe(2);
      expect(Number(row.commitments_total)).toBe(1);
      expect(Number(row.commitments_with_projects)).toBe(1);
      expect(Number(row.commitments_without_projects)).toBe(0);

      const req = await as(db, "authenticated", wardStaffA.authId, callRpc("governance_analytics_requests"));
      expect(Number((req.rows[0] as Record<string, unknown>).total)).toBe(1);

      const eng = await as(db, "authenticated", wardStaffA.authId, callRpc("governance_analytics_engagements"));
      expect(Number((eng.rows[0] as Record<string, unknown>).total)).toBe(1);
      expect(Number((eng.rows[0] as Record<string, unknown>).attendance_count)).toBe(2);
    });

    it("C4. position defaults at ward scope NEVER confer tenant-wide analytics", async () => {
      // The same restricted numbers as C3 — despite has_permission's bare
      // form being true for this user (the 0058 hole that 0059 closed).
      const del = await as(db, "authenticated", positionStaffA.authId, callRpc("governance_analytics_delivery"));
      expect(Number((del.rows[0] as Record<string, unknown>).projects_total)).toBe(1);
      const req = await as(db, "authenticated", positionStaffA.authId, callRpc("governance_analytics_requests"));
      expect(Number((req.rows[0] as Record<string, unknown>).total)).toBe(1);

      const mem = await as(db, "authenticated", positionStaffA.authId, `SELECT * FROM politicore.governance_memory_timeline('project', 200, 0)`);
      const refs = mem.rows.map((r) => String((r as Record<string, unknown>).reference_code));
      expect(refs).toContain("GP-P19A");
      expect(refs).not.toContain("GP-P19B");
    });

    it("C5. scope-less entities are invisible to scoped callers (fail closed)", async () => {
      const mem = await as(db, "authenticated", wardStaffA.authId, `SELECT * FROM politicore.governance_memory_timeline('commitment', 200, 0)`);
      const refs = mem.rows.map((r) => String((r as Record<string, unknown>).reference_code));
      expect(refs).toContain("GC-P19A");
      expect(refs).not.toContain("GC-P19B"); // scope-less → invisible
    });

    it("C6. the surface accepts no client scope filters at all (server-resolved)", async () => {
      // Structural proof: the RPC signatures expose NO filter parameters —
      // a scoped caller cannot omit/widen anything.
      for (const rpc of RPCS) {
        const sig = await db.query(
          `SELECT pg_get_function_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname='politicore' AND p.proname=$1`, [rpc]);
        expect(String((sig.rows[0] as Record<string, unknown>).args).trim()).toBe("");
      }
    });
  });

  // ── D. derived correctness ──────────────────────────────────────────
  describe("D. derived correctness", () => {
    it("request analytics match canonical statuses and geography", async () => {
      const r = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_requests"));
      const row = r.rows[0] as Record<string, unknown>;
      expect(Number(row.submitted)).toBe(1);
      expect(Number(row.resolved)).toBe(1);
      expect(String(row.resolved_bucket)).toBe("1-5");
      const byWard = row.by_ward as Record<string, string>;
      expect(byWard["P19WardA"]).toBeDefined();
      expect(byWard["P19WardB"]).toBeDefined();
      const byCat = row.by_category as Record<string, number>;
      expect(Number(byCat["P19 Water"])).toBe(2);
      const byMonth = row.by_month as Record<string, number>;
      expect(Object.values(byMonth).reduce((a, b) => a + Number(b), 0)).toBe(2);
    });

    it("delivery analytics: milestones, linkage, and ward distribution derive from canonical rows", async () => {
      const d = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_delivery"));
      const row = d.rows[0] as Record<string, unknown>;
      expect(Number(row.projects_active)).toBe(1);
      expect(Number(row.projects_concluded)).toBe(1);
      expect(Number(row.projects_published)).toBe(1);
      expect(Number(row.milestones_done)).toBe(1);
      expect(Number(row.milestones_total)).toBe(3);
      expect(Number(row.commitments_delivered)).toBe(0);
      expect(Number(row.commitments_in_progress)).toBe(1);
      const byWard = row.projects_by_ward as Record<string, number>;
      expect(Number(byWard["P19WardA"])).toBe(1);
      expect(Number(byWard["P19WardB"])).toBe(1);
    });

    it("participation analytics: only aggregates — buckets, never identities", async () => {
      const p = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_participation"));
      const row = p.rows[0] as Record<string, unknown>;
      expect(Number(row.consultations_total)).toBe(1);
      expect(Number(row.consultations_open)).toBe(1);
      // instruments family: the published-results survey is included here
      expect(Number(row.consultations_results_published)).toBe(1);
      expect(String(row.consultation_responses_bucket)).toBe("1-5");
      expect(Number(row.surveys_total)).toBe(1);
      expect(Number(row.petitions_total)).toBe(1);
      expect(String(row.petitions_verified_support_bucket)).toBe("6-20");
      expect(Number(row.proposals_total)).toBe(1);
      expect(Number(row.polls_total)).toBe(1);
      expect(String(row.poll_votes_bucket)).toBe("1-5");
    });

    it("engagement analytics: counts only, follow-ups from the canonical updates substrate", async () => {
      const e = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_engagements"));
      const row = e.rows[0] as Record<string, unknown>;
      expect(Number(row.total)).toBe(2);
      expect(Number(row.scheduled)).toBe(1);
      expect(Number(row.concluded)).toBe(1);
      expect(Number(row.published)).toBe(1);
      expect(Number(row.attendance_count)).toBe(2);
      expect(Number(row.issues_open)).toBe(1);
      expect(Number(row.issues_closed)).toBe(1);
      expect(Number(row.followups)).toBe(1);
    });

    it("accountability analytics: published counts match Phase 18 visibility flags", async () => {
      const a = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_accountability"));
      const row = a.rows[0] as Record<string, unknown>;
      expect(Number(row.published_projects)).toBe(1);
      expect(Number(row.published_engagements)).toBe(1);
      expect(Number(row.published_commitments)).toBe(0);
      expect(Number(row.public_updates)).toBe(0);
      expect(row.public_request_stats_available).toBe(true);
    });
  });

  // ── E. privacy ──────────────────────────────────────────────────────
  describe("E. privacy", () => {
    it("no analytics payload exposes identities, contacts, or case text", async () => {
      for (const rpc of RPCS) {
        const r = await as(db, "authenticated", adminA.authId, callRpc(rpc));
        const json = JSON.stringify(r.rows).toLowerCase();
        expect(json).not.toContain("participant");
        expect(json).not.toContain("@");
        expect(json).not.toContain("leaking pipe");
        expect(json).not.toContain("borehole");
      }
    });

    it("individual responses/votes/signers are structurally unreachable", async () => {
      const json = JSON.stringify(
        await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_participation"))
      );
      expect(json).not.toContain("answers");
      expect(json).not.toContain("choice");
      // Counts are only ever surfaced as privacy buckets.
      const p = await as(db, "authenticated", adminA.authId, callRpc("governance_analytics_participation"));
      const row = p.rows[0] as Record<string, unknown>;
      expect(typeof row.consultation_responses_bucket).toBe("string");
      expect(typeof row.poll_votes_bucket).toBe("string");
    });
  });

  // ── F. institutional memory ─────────────────────────────────────────
  describe("F. institutional memory", () => {
    it("timeline projects canonical records across every kind", async () => {
      const mem = await as(db, "authenticated", adminA.authId, `SELECT * FROM politicore.governance_memory_timeline(NULL, 200, 0)`);
      const kinds = new Set(mem.rows.map((r) => String((r as Record<string, unknown>).kind)));
      for (const k of ["project", "commitment", "consultation", "petition", "poll", "engagement", "update"]) {
        expect(kinds.has(k)).toBe(true);
      }
      // no second history model: only canonical substrates feed the timeline
      expect(mem.rows.length).toBeLessThanOrEqual(200);
    });

    it("kind filter, limit, and offset are honored", async () => {
      const projects = await as(db, "authenticated", adminA.authId, `SELECT * FROM politicore.governance_memory_timeline('project', 200, 0)`);
      expect(projects.rows.map((r) => (r as Record<string, unknown>).kind)).toEqual(["project", "project"]);

      const page1 = await as(db, "authenticated", adminA.authId, `SELECT * FROM politicore.governance_memory_timeline('project', 1, 0)`);
      expect(page1.rows).toHaveLength(1);
      const page2 = await as(db, "authenticated", adminA.authId, `SELECT * FROM politicore.governance_memory_timeline('project', 1, 1)`);
      expect(page2.rows).toHaveLength(1);
      expect((page1.rows[0] as Record<string, unknown>).reference_code)
        .not.toBe((page2.rows[0] as Record<string, unknown>).reference_code);

      const oversized = await as(db, "authenticated", adminA.authId, `SELECT * FROM politicore.governance_memory_timeline(NULL, 100000, 0)`);
      expect(oversized.rows.length).toBeLessThanOrEqual(200);
    });
  });

  // ── G. hygiene ──────────────────────────────────────────────────────
  describe("G. hygiene", () => {
    it("Phase 19 created ZERO new tables (derived-only architecture)", async () => {
      const tables = await db.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='politicore' AND c.relkind='r'
            AND (c.relname LIKE '%analytic%' OR c.relname LIKE '%memory%'
                 OR c.relname LIKE '%statistic%' OR c.relname LIKE '%dashboard%')`);
      expect(tables.rows).toHaveLength(0);
    });

    it("analytics RPCs execute for authenticated and never for anon", async () => {
      const acls = await db.query(
        `SELECT p.proname, p.proacl::text AS acl
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='politicore' AND p.proname = ANY($1)`,
        [[...RPCS, "governance_memory_timeline"]]
      );
      expect(acls.rows).toHaveLength(6);
      for (const row of acls.rows as Record<string, unknown>[]) {
        const acl = String(row.acl ?? "");
        expect(acl).toContain("authenticated");
        expect(acl).not.toContain("anon=");
      }
    });
  });
});
