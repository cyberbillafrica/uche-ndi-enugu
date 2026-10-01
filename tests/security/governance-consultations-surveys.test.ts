/**
 * POLITICORE — GOVERNANCE PHASE 14 — CONSULTATIONS & SURVEYS SECURITY SUITE.
 *
 * Proves the Participation slice (migration 0051) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–13:
 *
 *   C1.  creation authority — manage_participation (+ geo) required
 *   C2.  anonymous boundary — anon holds nothing on the surface
 *   C3.  tenant isolation — cross-tenant read/mutate/participate fails closed
 *   C4.  module isolation — governance OFF blocks; Campaign/Election state
 *        is irrelevant to Participation
 *   C5.  permission catalog — the Phase 11 §16 seven; no per-instrument
 *        permissions; no new roles
 *   C6.  geographic authority — unrelated scope fails; campaign scope
 *        forbidden; scope-scoped grantees must deliver an authorized scope
 *   C7.  lifecycle — draft→open→closed→results_published only; results
 *        publication requires publish_accountability
 *   C8.  question integrity — definition validation; immutable once open;
 *        no direct write path
 *   C9.  participation eligibility — authenticated members participate
 *        without a permission; closed instruments reject
 *   C10. response ownership — a participant sees only their own response
 *   C11. duplicate participation — UNIQUE(consultation_id, participant_id)
 *   C12. response validation — malformed/unknown answers rejected;
 *        closes_at honored server-side
 *   C13. visibility — private by default; direct-table flips blocked;
 *        RPC path gated by publish_accountability
 *   C14. canonical updates — governance_updates single-subject invariant
 *        spans project|commitment|consultation; prior subjects still work
 *   C15. canonical audit — system_audits rows with server-side actor
 *   C16. core notifications — canonical notifications rows, no parallel store
 *   C17. media boundary — no consultation media tables
 *   C18. schema/security pins — FORCE RLS, hygiene, enums, reference rules
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { as, createTenant, createUser, getDb, grant } from "./helpers";

interface Staff {
  authId: string;
  email: string;
  profileId: string;
}

const callRpc = (name: string, args: Record<string, unknown>) =>
  `SELECT * FROM politicore.${name}(${Object.keys(args)
    .map((k) => {
      const v = args[k];
      if (typeof v === "string" && v.startsWith("sql:")) return `${k} => ${v.slice(4)}`;
      if (typeof v === "string") return `${k} => '${(v as string).replace(/'/g, "''")}'`;
      return `${k} => ${String(v)}`;
    })
    .join(", ")})`;

const QUESTIONS =
  '[{"id":"q1","kind":"single_choice","prompt":"Preferred option?","options":["Roads","Water","Power"],"required":true},{"id":"q2","kind":"likert","prompt":"Rate current services","scale":5},{"id":"q3","kind":"short_text","prompt":"Anything else?"}]';

describe("Governance Phase 14 — Consultations & Surveys", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let managerA: Staff; // manage_participation, ward-scoped
  let viewerA: Staff; // view_governance only
  let plainA: Staff; // no authority (participant)
  let memberB: Staff; // tenant B member
  let adminB: Staff; // tenant B admin

  const STATE = "pst14";
  const ZONE = "pz14";
  const LGA = "pl14";
  const WARD = "pw14";
  const PU = "pp14";
  const OTHER_WARD = "pw14z";

  /** Resolve an instrument id by exact title (rows[0] keyed lookups only
   * when the RPC returns its uuid column). */
  const idByTitle = async (title: string): Promise<string> => {
    const r = await db.query(`SELECT id FROM politicore.governance_consultations WHERE title = $1`, [title]);
    return (r.rows[0] as Record<string, unknown>).id as string;
  };

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "p14-a", "P14 Tenant A", { governance: true });
    tenantB = await createTenant(db, "p14-b", "P14 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "p14-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    managerA = await createUser(db, { tenantId: tenantA, email: "p14-mgr@a.test", fullName: "Manager A" });
    viewerA = await createUser(db, { tenantId: tenantA, email: "p14-view@a.test", fullName: "Viewer A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "p14-plain@a.test", fullName: "Plain A" });
    memberB = await createUser(db, { tenantId: tenantB, email: "p14-member@b.test", fullName: "Member B" });
    adminB = await createUser(db, { tenantId: tenantB, email: "p14-admin@b.test", fullName: "Admin B", accessRole: "admin" });

    await grant(db, tenantA, managerA.authId, "manage_participation", true, "ward", WARD);
    await grant(db, tenantA, viewerA.authId, "view_governance", true);

    // Core Geography fixtures (platform-admin path; states are open).
    await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P14State','PS') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P14Zone','PZ') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P14Lga','PL') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P14Ward','PW') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await db.query(`INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code) VALUES ($1,$2,$3,'P14PU','PP') ON CONFLICT (id) DO NOTHING`, [PU, WARD, LGA]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P14OtherWard','PWO') ON CONFLICT (id) DO NOTHING`, [OTHER_WARD, LGA]);
  });

  // ── C1. creation authority ──────────────────────────────────────────
  describe("C1. creation authority", () => {
    it("a ward-scoped manager creates a consultation AT their ward (scope payload rides as text)", async () => {
      const created = await as(db, "authenticated", managerA.authId, callRpc("create_governance_consultation", {
        p_kind: "consultation",
        p_title: "Ward health services consultation",
        p_questions: QUESTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(created.error).toBeUndefined();
      const row = created.rows[0] as Record<string, unknown>;
      expect(String(row.create_governance_consultation)).toMatch(/^[0-9a-f-]{36}$/);
      const scopes = await db.query(
        `SELECT scope_type, ward_id FROM politicore.governance_consultation_scopes WHERE consultation_id = $1`,
        [row.create_governance_consultation]);
      expect(scopes.rows[0]).toMatchObject({ scope_type: "ward", ward_id: WARD });
    });

    it("a viewer cannot create; a plain member cannot create", async () => {
      const denied1 = await as(db, "authenticated", viewerA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Nope survey",
      }));
      expect(denied1.error).toMatch(/manage_participation/);

      const denied2 = await as(db, "authenticated", plainA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Nope survey 2",
      }));
      expect(denied2.error).toMatch(/manage_participation/);
    });

    it("survey creation uses the same table + discriminator", async () => {
      const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey",
        p_title: "Tenant-wide member survey",
        p_questions: QUESTIONS,
      }));
      expect(created.error).toBeUndefined();
      const row = await db.query(`SELECT kind FROM politicore.governance_consultations WHERE title = 'Tenant-wide member survey'`);
      expect(row.rows[0]).toMatchObject({ kind: "survey" });
    });
  });

  // ── C2. anonymous boundary ──────────────────────────────────────────
  describe("C2. anonymous boundary", () => {
    it("anon reads nothing and cannot mutate", async () => {
      const read = await as(db, "anon", null, `SELECT * FROM politicore.governance_consultations`);
      expect(read.rows).toHaveLength(0);

      const viewRead = await as(db, "anon", null, `SELECT * FROM public.governance_consultations`);
      expect(viewRead.error).toBeDefined();

      const write = await as(db, "anon", null, callRpc("submit_governance_consultation_response", {
        p_consultation: "00000000-0000-0000-0000-000000000000",
      }));
      expect(write.error).toBeDefined();
    });
  });

  // ── C3. tenant isolation ────────────────────────────────────────────
  describe("C3. tenant isolation", () => {
    it("cross-tenant reads return nothing and mutations fail closed", async () => {
      const consultationId = await idByTitle("Ward health services consultation");

      const foreignRead = await as(db, "authenticated", memberB.authId,
        `SELECT * FROM politicore.governance_consultations WHERE id = $1`, [consultationId]);
      expect(foreignRead.rows).toHaveLength(0);

      const foreignStatus = await as(db, "authenticated", adminB.authId, callRpc("set_governance_consultation_status", {
        p_consultation: consultationId, p_status: "open",
      }));
      expect(foreignStatus.error).toMatch(/not found/);

      const foreignRespond = await as(db, "authenticated", memberB.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: consultationId,
      }));
      expect(foreignRespond.error).toMatch(/not found/);
    });
  });

  // ── C4. module isolation ────────────────────────────────────────────
  describe("C4. module isolation", () => {
    it("governance disabled blocks creation and participation", async () => {
      const tenantC = await createTenant(db, "p14-c", "P14 Tenant C", { governance: false });
      const staffC = await createUser(db, { tenantId: tenantC, email: "p14-admin@c.test", fullName: "Admin C", accessRole: "admin" });

      const created = await as(db, "authenticated", staffC.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Should not exist",
      }));
      expect(created.error).toMatch(/module is not enabled/);

      const responded = await as(db, "authenticated", staffC.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: "00000000-0000-0000-0000-000000000000",
      }));
      expect(responded.error).toMatch(/module is not enabled|not found/);
    });
  });

  // ── C5. permission model ────────────────────────────────────────────
  describe("C5. permission model", () => {
    it("the catalog is exactly the Phase 11 §16 seven; no per-instrument permissions", async () => {
      const perms = await db.query(`SELECT name FROM politicore.permissions WHERE domain='governance' ORDER BY name`);
      expect(perms.rows.map((r) => String((r as Record<string, unknown>).name))).toEqual(
        ["assign_cases", "manage_cases", "manage_participation", "manage_projects",
         "publish_accountability", "view_cases", "view_governance"],
      );
      const bad = await db.query(
        `SELECT count(*)::int n FROM politicore.permissions
          WHERE name IN ('manage_consultations','manage_surveys','survey_manager','respondent')`);
      expect(Number((bad.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C6. geographic authority ────────────────────────────────────────
  describe("C6. geographic authority", () => {
    it("unrelated scope fails; campaign scope forbidden; unknown geography fails", async () => {
      const surveyId = await idByTitle("Tenant-wide member survey");

      const outside = await as(db, "authenticated", managerA.authId, callRpc("add_governance_consultation_scope", {
        p_consultation: surveyId,
        p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: OTHER_WARD,
      }));
      expect(outside.error).toMatch(/outside their authority/);

      const campaign = await as(db, "authenticated", adminA.authId, callRpc("add_governance_consultation_scope", {
        p_consultation: surveyId,
        p_scope_type: "campaign", p_state_id: STATE,
      }));
      expect(campaign.error).toMatch(/campaign/);

      const unknown = await as(db, "authenticated", adminA.authId, callRpc("add_governance_consultation_scope", {
        p_consultation: surveyId,
        p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "ghost-ward",
      }));
      expect(unknown.error).toMatch(/does not exist in Core Geography/);
    });

    it("a scope-scoped grantee must deliver a scope within their authority (0049 rule)", async () => {
      const orphan = await as(db, "authenticated", managerA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Orphan instrument",
      }));
      expect(orphan.error).toMatch(/scope within your authority/);
    });
  });

  // ── C7. lifecycle ───────────────────────────────────────────────────
  describe("C7. lifecycle", () => {
    it("legal transitions work; results publication requires publish_accountability", async () => {
      // managerA (scoped authority, no publish_accountability) owns the
      // lifecycle probe — they pass instrument authority but not the
      // publication gate.
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_consultation", {
        p_kind: "consultation", p_title: "Lifecycle probe",
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(made.error).toBeUndefined();
      const cid = (made.rows[0] as Record<string, unknown>).create_governance_consultation as string;

      const illegal = await as(db, "authenticated", managerA.authId, callRpc("set_governance_consultation_status", {
        p_consultation: cid, p_status: "results_published",
      }));
      expect(illegal.error).toMatch(/status must be open or closed/);

      const opened = await as(db, "authenticated", managerA.authId, callRpc("set_governance_consultation_status", {
        p_consultation: cid, p_status: "open",
      }));
      expect(opened.error).toBeUndefined();

      const closed = await as(db, "authenticated", managerA.authId, callRpc("set_governance_consultation_status", {
        p_consultation: cid, p_status: "closed",
      }));
      expect(closed.error).toBeUndefined();

      const noPerm = await as(db, "authenticated", managerA.authId, callRpc("publish_consultation_results", {
        p_consultation: cid, p_summary: "attempt",
      }));
      expect(noPerm.error).toMatch(/publish_accountability/);

      const published = await as(db, "authenticated", adminA.authId, callRpc("publish_consultation_results", {
        p_consultation: cid, p_summary: "Aggregates only", p_results: '{"response_count":0}',
      }));
      expect(published.error).toBeUndefined();

      const row = await db.query(`SELECT status, results_summary FROM politicore.governance_consultations WHERE id=$1`, [cid]);
      expect(row.rows[0]).toMatchObject({ status: "results_published", results_summary: "Aggregates only" });

      // Reopen after publication is illegal (guard trigger).
      const reopen = await as(db, "authenticated", adminA.authId, callRpc("set_governance_consultation_status", {
        p_consultation: cid, p_status: "open",
      }));
      expect(reopen.error).toMatch(/illegal consultation status transition/);
    });
  });

  // ── C8. question integrity ──────────────────────────────────────────
  describe("C8. question integrity", () => {
    it("definitions are validated, immutable once open, and not directly writable", async () => {
      const badQuestions = await as(db, "authenticated", adminA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Bad questions",
        p_questions: '[{"id":"q1","kind":"poll","prompt":"x"}]',
      }));
      expect(badQuestions.error).toMatch(/unsupported question kind/);

      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Immutable questions probe",
        p_questions: QUESTIONS,
      }));
      const qid = (made.rows[0] as Record<string, unknown>).create_governance_consultation as string;
      await as(db, "authenticated", adminA.authId, callRpc("set_governance_consultation_status", {
        p_consultation: qid, p_status: "open",
      }));

      const editOpen = await as(db, "authenticated", adminA.authId, callRpc("update_governance_consultation", {
        p_consultation: qid, p_title: "Changed while open",
      }));
      expect(editOpen.error).toMatch(/only editable while in draft/);

      // No UPDATE policy on the base table: a direct write cannot land.
      const direct = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_consultations SET questions='[]'::jsonb WHERE id='${qid}'`);
      expect(direct.error).toBeUndefined(); // silent no-op under RLS
      const after = await db.query(`SELECT jsonb_array_length(questions) n FROM politicore.governance_consultations WHERE id=$1`, [qid]);
      expect(Number((after.rows[0] as Record<string, unknown>).n)).toBe(3);
    });
  });

  // ── C9–C12. participation ───────────────────────────────────────────
  describe("C9–C12. participation integrity", () => {
    let openSurveyId: string;

    beforeAll(async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Participation probe", p_questions: QUESTIONS,
      }));
      openSurveyId = (made.rows[0] as Record<string, unknown>).create_governance_consultation as string;
      await as(db, "authenticated", adminA.authId, callRpc("set_governance_consultation_status", {
        p_consultation: openSurveyId, p_status: "open",
      }));
    });

    it("C9. a member participates without any permission; a closed instrument rejects", async () => {
      const ok = await as(db, "authenticated", plainA.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId,
        p_answers: '{"q1":"Water","q2":4}',
        p_free_text: "Please prioritise water.",
      }));
      expect(ok.error).toBeUndefined();

      const draftProbe = await as(db, "authenticated", adminA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Still draft probe",
      }));
      const draftId = (draftProbe.rows[0] as Record<string, unknown>).create_governance_consultation as string;
      const rejected = await as(db, "authenticated", adminA.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: draftId,
      }));
      expect(rejected.error).toMatch(/not open/);
    });

    it("C10. a participant sees only their own response", async () => {
      const own = await as(db, "authenticated", plainA.authId,
        `SELECT participant_id, answers FROM politicore.governance_consultation_responses
          WHERE consultation_id = $1`, [openSurveyId]);
      expect(own.rows).toHaveLength(1);
      const mine = await db.query(
        `SELECT gp.id FROM politicore.governance_participants gp WHERE gp.profile_id = $1`, [plainA.authId]);
      expect(String((own.rows[0] as Record<string, unknown>).participant_id))
        .toBe(String((mine.rows[0] as Record<string, unknown>).id));
    });

    it("C11. duplicate participation fails (one response per participant per instrument)", async () => {
      const dup = await as(db, "authenticated", plainA.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId,
        p_answers: '{"q1":"Power"}',
      }));
      expect(dup.error).toMatch(/already responded/);
    });

    it("C12. malformed answers cannot bypass server validation; closes_at is honored", async () => {
      const member = await createUser(db, { tenantId: tenantA, email: "p14-v12@a.test", fullName: "V12" });

      const badOption = await as(db, "authenticated", member.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId, p_answers: '{"q1":"Teleportation"}',
      }));
      expect(badOption.error).toMatch(/not a valid option/);

      const unknownQ = await as(db, "authenticated", member.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId, p_answers: '{"q1":"Water","ghost":"x"}',
      }));
      expect(unknownQ.error).toMatch(/unknown question/);

      const outOfScale = await as(db, "authenticated", member.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId, p_answers: '{"q1":"Water","q2":9}',
      }));
      expect(outOfScale.error).toMatch(/outside the scale/);

      const missingRequired = await as(db, "authenticated", member.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId, p_answers: '{"q2":3}',
      }));
      expect(missingRequired.error).toMatch(/requires an answer/);

      // closes_at: server rejects submission after the deadline even while
      // status is still 'open'.
      await db.query(`UPDATE politicore.governance_consultations SET closes_at = now() - interval '1 hour' WHERE id = $1`, [openSurveyId]);
      const expired = await as(db, "authenticated", member.authId, callRpc("submit_governance_consultation_response", {
        p_consultation: openSurveyId, p_answers: '{"q1":"Water"}',
      }));
      expect(expired.error).toMatch(/not open/);
      await db.query(`UPDATE politicore.governance_consultations SET closes_at = NULL WHERE id = $1`, [openSurveyId]);
    });
  });

  // ── C13. visibility / privacy ───────────────────────────────────────
  describe("C13. result visibility", () => {
    it("is_public defaults false; direct-table flips are blocked; RPC path is gated", async () => {
      // A manager-owned instrument: managerA holds instrument authority
      // (so the RPC reaches the publication gate) but not
      // publish_accountability.
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_consultation", {
        p_kind: "survey", p_title: "Visibility probe",
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      const probeId = (made.rows[0] as Record<string, unknown>).create_governance_consultation as string;

      const before = await db.query(`SELECT is_public FROM politicore.governance_consultations WHERE id=$1`, [probeId]);
      expect((before.rows[0] as Record<string, unknown>).is_public).toBe(false);

      // No UPDATE policy covers visibility; the identity guard triggers on
      // any row that DID change — a direct flip is a silent no-op under
      // RLS and the value must remain false.
      const direct = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_consultations SET is_public = true WHERE id='${probeId}'`);
      expect(direct.error).toBeUndefined();
      const after = await db.query(`SELECT is_public FROM politicore.governance_consultations WHERE id=$1`, [probeId]);
      expect((after.rows[0] as Record<string, unknown>).is_public).toBe(false);

      const ungated = await as(db, "authenticated", managerA.authId, callRpc("set_governance_consultation_visibility", {
        p_consultation: probeId, p_is_public: true,
      }));
      expect(ungated.error).toMatch(/publish_accountability/);
    });

    it("no response rows are anonymously reachable", async () => {
      const publicRows = await as(db, "anon", null, `SELECT * FROM politicore.governance_consultation_responses`);
      expect(publicRows.rows).toHaveLength(0);
    });
  });

  // ── C14. canonical updates ──────────────────────────────────────────
  describe("C14. canonical updates", () => {
    it("single-subject invariant spans project|commitment|consultation; prior subjects still work", async () => {
      const def = await db.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`);
      const constraint = String((def.rows[0] as Record<string, unknown>).d);
      expect(constraint).toContain("project_id");
      expect(constraint).toContain("commitment_id");
      expect(constraint).toContain("consultation_id");

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND tablename IN ('governance_consultation_updates','governance_survey_updates')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);

      // Project updates still work (Phase 12 substrate preserved).
      const project = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", {
        p_title: "P14 substrate probe project",
      }));
      const projectId = (project.rows[0] as Record<string, unknown>).create_governance_project as string;
      const projectUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
        p_project: projectId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(projectUpdate.error).toBeUndefined();

      // Commitment updates still work (Phase 13 substrate preserved).
      const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
        p_title: "P14 substrate probe commitment",
      }));
      const commitmentId = (commitment.rows[0] as Record<string, unknown>).create_governance_commitment as string;
      const commitmentUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment_update", {
        p_commitment: commitmentId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(commitmentUpdate.error).toBeUndefined();
    });
  });

  // ── C15. canonical audit ────────────────────────────────────────────
  describe("C15. canonical audit", () => {
    it("creation, lifecycle and responses are audited with the server-side actor", async () => {
      const audits = await db.query(
        `SELECT action FROM politicore.system_audits
          WHERE affected_resource = 'governance_consultations' ORDER BY occurred_at DESC LIMIT 12`);
      const actions = audits.rows.map((r) => String((r as Record<string, unknown>).action));
      expect(actions).toContain("governance_consultation:create");
      expect(actions).toContain("governance_consultation:status");

      const respAudits = await db.query(
        `SELECT actor_id FROM politicore.system_audits
          WHERE action = 'governance_consultation:response' ORDER BY occurred_at DESC LIMIT 1`);
      expect(respAudits.rows).toHaveLength(1);
      // actor attribution is the real auth uid (plainA submitted C9's response)
      expect(String((respAudits.rows[0] as Record<string, unknown>).actor_id)).toBe(plainA.authId);
    });
  });

  // ── C16. core notifications ─────────────────────────────────────────
  describe("C16. core notifications", () => {
    it("open invitation and submission notices are canonical notifications rows; no parallel store", async () => {
      const notices = await db.query(
        `SELECT count(*)::int n FROM politicore.notifications WHERE link_url LIKE '/governance/participate%'`);
      expect(Number((notices.rows[0] as Record<string, unknown>).n)).toBeGreaterThan(0);

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_consultation_notif%' OR tablename LIKE 'survey_notif%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C17. media boundary ─────────────────────────────────────────────
  describe("C17. media boundary", () => {
    it("no consultation media tables exist", async () => {
      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_consultation%media%' OR tablename LIKE 'survey_media%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C18. schema/security pins ───────────────────────────────────────
  describe("C18. schema and security pins", () => {
    it("FORCE RLS everywhere; zero anon policies; anon holds no view grants", async () => {
      for (const table of ["governance_consultations", "governance_consultation_scopes", "governance_consultation_responses"]) {
        const flags = await db.query(
          `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='politicore' AND c.relname=$1`, [table]);
        expect(flags.rows[0]).toMatchObject({ r: true, f: true });
      }
      const anonPolicies = await db.query(
        `SELECT count(*)::int n FROM pg_policies WHERE schemaname='politicore'
          AND tablename LIKE 'governance_consult%' AND 'anon' = ANY(roles)`);
      expect(Number((anonPolicies.rows[0] as Record<string, unknown>).n)).toBe(0);

      for (const view of ["governance_consultations", "governance_consultation_scopes", "governance_consultation_responses"]) {
        const anonGrant = await db.query(
          `SELECT count(*)::int n FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name=$1 AND grantee='anon'`, [view]);
        expect(Number((anonGrant.rows[0] as Record<string, unknown>).n)).toBe(0);
      }
    });

    it("reference generator mints PT- codes; references are immutable; kind vocabulary is closed", async () => {
      const ref = await db.query(`SELECT reference_code FROM politicore.governance_consultations WHERE title='Participation probe'`);
      expect(String((ref.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^PT-[0-9A-F]{8}$/);

      const probeId = await idByTitle("Participation probe");
      // Reference is immutable — a direct rewrite is a silent no-op under
      // RLS (no UPDATE policy), and the value must survive unchanged.
      const attempt = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_consultations SET reference_code='PT-HACKED1' WHERE id='${probeId}'`);
      expect(attempt.error).toBeUndefined();
      const after = await db.query(`SELECT reference_code FROM politicore.governance_consultations WHERE id=$1`, [probeId]);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^PT-[0-9A-F]{8}$/);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).not.toBe("PT-HACKED1");

      const kinds = await db.query(
        `SELECT unnest(enum_range(NULL::politicore.governance_consultation_kind))::text k ORDER BY k`);
      expect(kinds.rows.map((r) => String((r as Record<string, unknown>).k))).toEqual(["consultation", "survey"]);
    });
  });
});
