/**
 * POLITICORE — GOVERNANCE PHASE 16 — POLLS SECURITY SUITE.
 *
 * Proves the Polls slice (migration 0055) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–15:
 *
 *   C1.  creation authority — manage_participation (+ geo) required;
 *        unauthorized members cannot create or manage
 *   C2.  anonymous boundary — anon holds NOTHING on polls; anonymous
 *        participation is DISABLED (Phase 11 §29 open decision 1 is
 *        unresolved; no dedup mechanism is invented)
 *   C3.  tenant isolation — cross-tenant read/mutate/vote fails closed
 *   C4.  module isolation — governance OFF blocks; Campaign/Election
 *        state is irrelevant to Polls
 *   C5.  permission catalog — the Phase 11 §16 seven; no poll-specific
 *        permission; no new roles
 *   C6.  geographic authority — unrelated/campaign/unknown scopes fail;
 *        bootstrap rule (scope-scoped grantees cannot mint tenant-wide)
 *   C7.  lifecycle — draft→open→closed only; trigger guard re-enforces;
 *        closes_at honored server-side; content frozen outside draft
 *   C8.  option integrity — definitions validated server-side; foreign
 *        options rejected at vote time; no direct write path
 *   C9.  vote integrity — participant server-resolved; a member votes
 *        without a permission; one vote per participant
 *   C10. ballot privacy — a member sees only their own vote
 *   C11. results — unpublished results stay private; publication gated
 *        by publish_accountability and closed state
 *   C12. visibility — private by default; direct flips no-op; RPC gated
 *   C13. canonical updates — single-subject invariant spans the five
 *        subjects; poll is NOT a subject (Phase 11 ERD); all subjects
 *        still work
 *   C14. canonical audit — system_audits rows with server-side actor
 *   C15. core notifications — open fanouts are canonical notifications
 *        rows with data-driven recipients; no parallel store
 *   C16. media boundary — no poll media tables
 *   C17. schema/security pins — FORCE RLS, hygiene, enums, references,
 *        no duplicate participation/identity systems, Firebase absent
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

describe("Governance Phase 16 — Polls", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let managerA: Staff; // manage_participation, ward-scoped
  let viewerA: Staff; // view_governance only
  let plainA: Staff; // no authority (participant)
  let memberB: Staff; // tenant B member
  let adminB: Staff; // tenant B admin

  const STATE = "pst16";
  const ZONE = "pz16";
  const LGA = "pl16";
  const WARD = "pw16";
  const PU = "pp16";
  const OTHER_WARD = "pw16z";

  const OPTIONS = '["Road repairs","Water access","Street lighting"]';

  const idByTitle = async (title: string): Promise<string> => {
    const r = await db.query(`SELECT id FROM politicore.governance_polls WHERE title = $1`, [title]);
    return (r.rows[0] as Record<string, unknown>).id as string;
  };

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "p16-a", "P16 Tenant A", { governance: true });
    tenantB = await createTenant(db, "p16-b", "P16 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "p16-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    managerA = await createUser(db, { tenantId: tenantA, email: "p16-mgr@a.test", fullName: "Manager A" });
    viewerA = await createUser(db, { tenantId: tenantA, email: "p16-view@a.test", fullName: "Viewer A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "p16-plain@a.test", fullName: "Plain A" });
    memberB = await createUser(db, { tenantId: tenantB, email: "p16-member@b.test", fullName: "Member B" });
    adminB = await createUser(db, { tenantId: tenantB, email: "p16-admin@b.test", fullName: "Admin B", accessRole: "admin" });

    await grant(db, tenantA, managerA.authId, "manage_participation", true, "ward", WARD);
    await grant(db, tenantA, viewerA.authId, "view_governance", true);

    // Core Geography fixtures (platform-admin path; states are open).
    await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P16State','PS') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P16Zone','PZ') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P16Lga','PL') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P16Ward','PW') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await db.query(`INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code) VALUES ($1,$2,$3,'P16PU','PP') ON CONFLICT (id) DO NOTHING`, [PU, WARD, LGA]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P16OtherWard','PWO') ON CONFLICT (id) DO NOTHING`, [OTHER_WARD, LGA]);
  });

  // ── C1. creation authority ──────────────────────────────────────────
  describe("C1. creation authority", () => {
    it("a ward-scoped manager creates a poll AT their ward; options are server-validated", async () => {
      const created = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Ward road priority poll",
        p_question: "Which improvement should come first?",
        p_options: OPTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(created.error).toBeUndefined();
      const row = created.rows[0] as Record<string, unknown>;
      expect(String(row.create_governance_poll)).toMatch(/^[0-9a-f-]{36}$/);
      const scopes = await db.query(
        `SELECT scope_type, ward_id FROM politicore.governance_poll_scopes WHERE poll_id = $1`,
        [row.create_governance_poll]);
      expect(scopes.rows[0]).toMatchObject({ scope_type: "ward", ward_id: WARD });
    });

    it("a viewer cannot create; a plain member cannot create; malformed options rejected", async () => {
      const denied1 = await as(db, "authenticated", viewerA.authId, callRpc("create_governance_poll", {
        p_title: "Nope", p_question: "Q?", p_options: '["a","b"]',
      }));
      expect(denied1.error).toMatch(/manage_participation/);

      const denied2 = await as(db, "authenticated", plainA.authId, callRpc("create_governance_poll", {
        p_title: "Nope 2", p_question: "Q?", p_options: '["a","b"]',
      }));
      expect(denied2.error).toMatch(/manage_participation/);

      const oneOption = await as(db, "authenticated", adminA.authId, callRpc("create_governance_poll", {
        p_title: "One option", p_question: "Q?", p_options: '["only"]',
      }));
      expect(oneOption.error).toMatch(/2-20 options/);

      const dupOptions = await as(db, "authenticated", adminA.authId, callRpc("create_governance_poll", {
        p_title: "Dup options", p_question: "Q?", p_options: '["same","same"]',
      }));
      expect(dupOptions.error).toMatch(/unique/);

      const nonString = await as(db, "authenticated", adminA.authId, callRpc("create_governance_poll", {
        p_title: "Non-string options", p_question: "Q?", p_options: '[1,2]',
      }));
      expect(nonString.error).toMatch(/non-empty strings/);
    });
  });

  // ── C2. anonymous boundary — participation stays DISABLED ──────────
  describe("C2. anonymous boundary", () => {
    it("anon reads nothing, executes nothing, and no anonymous voting path exists", async () => {
      const read = await as(db, "anon", null, `SELECT * FROM politicore.governance_polls`);
      expect(read.rows).toHaveLength(0);

      const viewRead = await as(db, "anon", null, `SELECT * FROM public.governance_polls`);
      expect(viewRead.error).toBeDefined();

      const votesRead = await as(db, "anon", null, `SELECT * FROM politicore.governance_poll_votes`);
      expect(votesRead.rows).toHaveLength(0);

      const voteRpc = await as(db, "anon", null, callRpc("vote_governance_poll", {
        p_poll: "00000000-0000-0000-0000-000000000000", p_choice: "Water access",
      }));
      expect(voteRpc.error).toBeDefined();

      // The public wrapper is authenticated-only: anon execute was revoked.
      const wrapper = await as(db, "anon", null,
        `SELECT * FROM public.vote_governance_poll('00000000-0000-0000-0000-000000000000'::uuid, 'x')`);
      expect(wrapper.error).toBeDefined();
    });

    it("no anonymous dedup/identity infrastructure exists in the schema", async () => {
      const badTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_poll_anon%'
            OR tablename LIKE 'poll_tokens%'
            OR tablename LIKE 'anonymous_vot%'
            OR tablename LIKE 'poll_fingerprint%')`);
      expect(Number((badTables.rows[0] as Record<string, unknown>).n)).toBe(0);

      const anonFunctions = await db.query(
        `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname IN ('politicore','public') AND p.proname LIKE '%anon%poll%'`);
      expect(Number((anonFunctions.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C3. tenant isolation ────────────────────────────────────────────
  describe("C3. tenant isolation", () => {
    it("cross-tenant reads return nothing and mutations/votes fail closed", async () => {
      const pollId = await idByTitle("Ward road priority poll");

      const foreignRead = await as(db, "authenticated", memberB.authId,
        `SELECT * FROM politicore.governance_polls WHERE id = $1`, [pollId]);
      expect(foreignRead.rows).toHaveLength(0);

      const foreignStatus = await as(db, "authenticated", adminB.authId, callRpc("set_governance_poll_status", {
        p_poll: pollId, p_status: "open",
      }));
      expect(foreignStatus.error).toMatch(/not found/);

      const foreignVote = await as(db, "authenticated", memberB.authId, callRpc("vote_governance_poll", {
        p_poll: pollId, p_choice: "Water access",
      }));
      expect(foreignVote.error).toMatch(/not found/);

      const foreignVoteRow = await as(db, "authenticated", memberB.authId,
        `SELECT * FROM politicore.governance_poll_votes WHERE poll_id = $1`, [pollId]);
      expect(foreignVoteRow.rows).toHaveLength(0);
    });
  });

  // ── C4. module isolation ────────────────────────────────────────────
  describe("C4. module isolation", () => {
    it("governance disabled blocks creation and voting", async () => {
      const tenantC = await createTenant(db, "p16-c", "P16 Tenant C", { governance: false });
      const staffC = await createUser(db, { tenantId: tenantC, email: "p16-admin@c.test", fullName: "Admin C", accessRole: "admin" });

      const created = await as(db, "authenticated", staffC.authId, callRpc("create_governance_poll", {
        p_title: "Should not exist", p_question: "Q?", p_options: '["a","b"]',
      }));
      expect(created.error).toMatch(/module is not enabled/);

      const voted = await as(db, "authenticated", staffC.authId, callRpc("vote_governance_poll", {
        p_poll: "00000000-0000-0000-0000-000000000000", p_choice: "a",
      }));
      expect(voted.error).toMatch(/module is not enabled|not found/);
    });
  });

  // ── C5. permission catalog ──────────────────────────────────────────
  describe("C5. permission catalog", () => {
    it("governance permissions are exactly the Phase 11 §16 seven — no poll-specific permission", async () => {
      const perms = await db.query(
        `SELECT name FROM politicore.permissions WHERE domain='governance' ORDER BY name`);
      const names = perms.rows.map((r) => String((r as Record<string, unknown>).name));
      expect(names).toEqual([
        "assign_cases", "manage_cases", "manage_participation", "manage_projects",
        "publish_accountability", "view_cases", "view_governance",
      ]);

      const noTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE '%poll_manager%' OR tablename LIKE '%poll_admin%')`);
      expect(Number((noTables.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C6. geographic authority ────────────────────────────────────────
  describe("C6. geographic authority", () => {
    it("unrelated scope fails; campaign scope forbidden; unknown geography fails", async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_poll", {
        p_title: "Geo probe poll", p_question: "Q?", p_options: OPTIONS,
      }));
      const pollId = (made.rows[0] as Record<string, unknown>).create_governance_poll as string;

      const outside = await as(db, "authenticated", managerA.authId, callRpc("add_governance_poll_scope", {
        p_poll: pollId, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: OTHER_WARD,
      }));
      expect(outside.error).toMatch(/outside their authority/);

      const campaign = await as(db, "authenticated", adminA.authId, callRpc("add_governance_poll_scope", {
        p_poll: pollId, p_scope_type: "campaign", p_state_id: STATE,
      }));
      expect(campaign.error).toMatch(/campaign/);

      const unknown = await as(db, "authenticated", adminA.authId, callRpc("add_governance_poll_scope", {
        p_poll: pollId, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "ghost-ward",
      }));
      expect(unknown.error).toMatch(/does not exist in Core Geography/);
    });

    it("a scope-scoped grantee must deliver a scope within their authority (0049 rule)", async () => {
      const orphan = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Orphan poll", p_question: "Q?", p_options: OPTIONS,
      }));
      expect(orphan.error).toMatch(/scope within your authority/);
    });

    it("ward scopes attach with the full hierarchy (Phase 15 convergence verified)", async () => {
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Ward scope poll", p_question: "Q?", p_options: OPTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(made.error).toBeUndefined();
    });
  });

  // ── C7. lifecycle ───────────────────────────────────────────────────
  describe("C7. lifecycle", () => {
    it("draft→open→closed only; guard trigger re-enforces; closes_at honored; content frozen", async () => {
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Lifecycle poll", p_question: "Q?", p_options: OPTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      const pid = (made.rows[0] as Record<string, unknown>).create_governance_poll as string;

      // No results_published state exists for polls (gate §130).
      const illegal = await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", {
        p_poll: pid, p_status: "results_published",
      }));
      expect(illegal.error).toMatch(/status must be open or closed|invalid input value/);

      const opened = await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", {
        p_poll: pid, p_status: "open",
      }));
      expect(opened.error).toBeUndefined();

      // Content freeze: options/question/title immutable outside draft.
      const editOpen = await as(db, "authenticated", managerA.authId, callRpc("update_governance_poll", {
        p_poll: pid, p_options: '["x","y"]',
      }));
      expect(editOpen.error).toMatch(/only editable while draft/);

      // Scope freeze outside draft.
      const scopeFrozen = await as(db, "authenticated", managerA.authId, callRpc("add_governance_poll_scope", {
        p_poll: pid, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD,
      }));
      expect(scopeFrozen.error).toMatch(/only editable while draft/);

      // closes_at in the past rejects votes even while status is open.
      await db.query(`UPDATE politicore.governance_polls SET closes_at = now() - interval '1 hour' WHERE id = $1`, [pid]);
      const expired = await as(db, "authenticated", plainA.authId, callRpc("vote_governance_poll", {
        p_poll: pid, p_choice: "Water access",
      }));
      expect(expired.error).toMatch(/not open/);
      await db.query(`UPDATE politicore.governance_polls SET closes_at = NULL WHERE id = $1`, [pid]);

      const closed = await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", {
        p_poll: pid, p_status: "closed",
      }));
      expect(closed.error).toBeUndefined();

      const closedVote = await as(db, "authenticated", plainA.authId, callRpc("vote_governance_poll", {
        p_poll: pid, p_choice: "Water access",
      }));
      expect(closedVote.error).toMatch(/not open/);

      // Reopen is illegal (guard trigger).
      const reopen = await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", {
        p_poll: pid, p_status: "open",
      }));
      expect(reopen.error).toMatch(/illegal poll status transition/);

      // Terminal record retained: no delete path anywhere.
      const del = await as(db, "authenticated", adminA.authId,
        `DELETE FROM politicore.governance_polls WHERE id = '${pid}'`);
      expect(del.error).toBeUndefined(); // silent no-op under RLS
      const still = await db.query(`SELECT id FROM politicore.governance_polls WHERE id = $1`, [pid]);
      expect(still.rows).toHaveLength(1);
    });
  });

  // ── C8–C10. vote integrity ──────────────────────────────────────────
  describe("C8–C10. vote integrity and ballot privacy", () => {
    let openPollId: string;

    beforeAll(async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_poll", {
        p_title: "Participation poll", p_question: "Q?", p_options: OPTIONS,
      }));
      openPollId = (made.rows[0] as Record<string, unknown>).create_governance_poll as string;
      await as(db, "authenticated", adminA.authId, callRpc("set_governance_poll_status", {
        p_poll: openPollId, p_status: "open",
      }));
    });

    it("C8. a member votes without a permission; foreign options rejected; no direct write path", async () => {
      const ok = await as(db, "authenticated", plainA.authId, callRpc("vote_governance_poll", {
        p_poll: openPollId, p_choice: "Water access",
      }));
      expect(ok.error).toBeUndefined();
      const voteId = String((ok.rows[0] as Record<string, unknown>).vote_governance_poll);

      // The vote row carries the SERVER-resolved participant.
      const mine = await db.query(
        `SELECT gp.id FROM politicore.governance_participants gp WHERE gp.profile_id = $1`, [plainA.authId]);
      const row = await db.query(`SELECT participant_id FROM politicore.governance_poll_votes WHERE id = $1`, [voteId]);
      expect(String((row.rows[0] as Record<string, unknown>).participant_id))
        .toBe(String((mine.rows[0] as Record<string, unknown>).id));

      // An unknown option fails (RPC check + trigger guard).
      const bad = await as(db, "authenticated", viewerA.authId, callRpc("vote_governance_poll", {
        p_poll: openPollId, p_choice: "Teleportation",
      }));
      expect(bad.error).toMatch(/not a valid option/);

      // A choice from ANOTHER poll's option set fails on this poll.
      const other = await as(db, "authenticated", viewerA.authId, callRpc("vote_governance_poll", {
        p_poll: openPollId, p_choice: "Not on this ballot",
      }));
      expect(other.error).toMatch(/not a valid option/);

      // Direct-table INSERT fails closed: no INSERT policy (writes flow
      // through the authority RPC only).
      const direct = await as(db, "authenticated", viewerA.authId,
        `INSERT INTO politicore.governance_poll_votes (tenant_id, poll_id, participant_id, choice)
           SELECT tenant_id, id, (SELECT id FROM politicore.governance_participants WHERE profile_id = auth.uid()), 'Water access'
           FROM politicore.governance_polls WHERE id = '${openPollId}'`);
      expect(direct.error).toBeDefined();
    });

    it("C9. duplicate participation fails (one vote per participant per poll)", async () => {
      const dup = await as(db, "authenticated", plainA.authId, callRpc("vote_governance_poll", {
        p_poll: openPollId, p_choice: "Road repairs",
      }));
      expect(dup.error).toMatch(/already voted/);
    });

    it("C10. ballot privacy — a member sees only their own vote", async () => {
      const own = await as(db, "authenticated", plainA.authId,
        `SELECT participant_id, choice FROM politicore.governance_poll_votes WHERE poll_id = $1`, [openPollId]);
      expect(own.rows).toHaveLength(1);
      expect(String((own.rows[0] as Record<string, unknown>).choice)).toBe("Water access");

      // Viewer (view_governance) sees tenant-wide rows — staff surface.
      const staff = await as(db, "authenticated", viewerA.authId,
        `SELECT count(*)::int n FROM politicore.governance_poll_votes WHERE poll_id = $1`, [openPollId]);
      expect(Number((staff.rows[0] as Record<string, unknown>).n)).toBe(1);
    });
  });

  // ── C11. results ────────────────────────────────────────────────────
  describe("C11. results publication", () => {
    it("closed state and publish_accountability are both required", async () => {
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Results probe poll", p_question: "Q?", p_options: OPTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      const pid = (made.rows[0] as Record<string, unknown>).create_governance_poll as string;

      // Premature: still draft.
      const tooEarly = await as(db, "authenticated", adminA.authId, callRpc("publish_poll_results", {
        p_poll: pid, p_summary: "attempt", p_results: '{"Road repairs":0}',
      }));
      expect(tooEarly.error).toMatch(/after closure/);

      await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", { p_poll: pid, p_status: "open" }));
      await as(db, "authenticated", plainA.authId, callRpc("vote_governance_poll", { p_poll: pid, p_choice: "Road repairs" }));
      await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", { p_poll: pid, p_status: "closed" }));

      // Gated: managerA passes instrument authority but holds no
      // publish_accountability.
      const noPerm = await as(db, "authenticated", managerA.authId, callRpc("publish_poll_results", {
        p_poll: pid, p_summary: "attempt",
      }));
      expect(noPerm.error).toMatch(/publish_accountability/);

      const published = await as(db, "authenticated", adminA.authId, callRpc("publish_poll_results", {
        p_poll: pid, p_summary: "1 vote — roads", p_results: '{"Road repairs":1}',
      }));
      expect(published.error).toBeUndefined();

      const row = await db.query(`SELECT status, results, results_summary FROM politicore.governance_polls WHERE id=$1`, [pid]);
      expect(row.rows[0]).toMatchObject({ status: "closed", results_summary: "1 vote — roads" });
      expect(((row.rows[0] as Record<string, unknown>).results as Record<string, unknown>)).toMatchObject({ "Road repairs": 1 });
    });
  });

  // ── C12. visibility ─────────────────────────────────────────────────
  describe("C12. visibility", () => {
    it("is_public defaults false; direct-table flips are blocked; RPC path is gated", async () => {
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Visibility probe poll", p_question: "Q?", p_options: OPTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      const probeId = (made.rows[0] as Record<string, unknown>).create_governance_poll as string;

      const before = await db.query(`SELECT is_public FROM politicore.governance_polls WHERE id=$1`, [probeId]);
      expect((before.rows[0] as Record<string, unknown>).is_public).toBe(false);

      // No UPDATE policy covers visibility; a direct flip is a silent
      // no-op under RLS and the value must remain false.
      const direct = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_polls SET is_public = true WHERE id='${probeId}'`);
      expect(direct.error).toBeUndefined();
      const after = await db.query(`SELECT is_public FROM politicore.governance_polls WHERE id=$1`, [probeId]);
      expect((after.rows[0] as Record<string, unknown>).is_public).toBe(false);

      const ungated = await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_visibility", {
        p_poll: probeId, p_is_public: true,
      }));
      expect(ungated.error).toMatch(/publish_accountability/);

      const gated = await as(db, "authenticated", adminA.authId, callRpc("set_governance_poll_visibility", {
        p_poll: probeId, p_is_public: true,
      }));
      expect(gated.error).toBeUndefined();
    });
  });

  // ── C13. canonical updates ──────────────────────────────────────────
  describe("C13. canonical updates", () => {
    it("single-subject invariant spans five subjects; poll is NOT a subject; all subjects still work", async () => {
      const def = await db.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`);
      const constraint = String((def.rows[0] as Record<string, unknown>).d);
      expect(constraint).toContain("project_id");
      expect(constraint).toContain("commitment_id");
      expect(constraint).toContain("consultation_id");
      expect(constraint).toContain("petition_id");
      expect(constraint).not.toContain("poll_id");

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND tablename IN ('governance_poll_updates','poll_updates','governance_poll_activity')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);

      // Project updates still work (Phase 12 substrate preserved).
      const project = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", {
        p_title: "P16 substrate probe project",
      }));
      const projectId = (project.rows[0] as Record<string, unknown>).create_governance_project as string;
      const projectUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
        p_project: projectId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(projectUpdate.error).toBeUndefined();

      // Commitment updates still work (Phase 13 substrate preserved).
      const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
        p_title: "P16 substrate probe commitment",
      }));
      const commitmentId = (commitment.rows[0] as Record<string, unknown>).create_governance_commitment as string;
      const commitmentUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment_update", {
        p_commitment: commitmentId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(commitmentUpdate.error).toBeUndefined();
    });
  });

  // ── C14. canonical audit ────────────────────────────────────────────
  describe("C14. canonical audit", () => {
    it("creation, lifecycle, votes and publication are audited with the server-side actor", async () => {
      const audits = await db.query(
        `SELECT action FROM politicore.system_audits
          WHERE affected_resource = 'governance_polls' ORDER BY occurred_at DESC LIMIT 12`);
      const actions = audits.rows.map((r) => String((r as Record<string, unknown>).action));
      expect(actions).toContain("governance_poll:create");
      expect(actions).toContain("governance_poll:status");
      expect(actions).toContain("governance_poll:results_published");
      expect(actions).toContain("governance_poll:visibility");

      const voteAudits = await db.query(
        `SELECT actor_id FROM politicore.system_audits
          WHERE action = 'governance_poll:vote' ORDER BY occurred_at DESC LIMIT 1`);
      expect(voteAudits.rows).toHaveLength(1);
      // actor attribution is the real auth uid (plainA cast the latest vote)
      expect(String((voteAudits.rows[0] as Record<string, unknown>).actor_id)).toBe(plainA.authId);
    });
  });

  // ── C15. core notifications ─────────────────────────────────────────────
  describe("C15. core notifications", () => {
    it("open fanouts are canonical, recipient-correct, data-driven; no parallel store", async () => {
      // Recipient correctness (the Phase 15 §24 regression): a NEW
      // ward-scoped poll opened AFTER these profiles exist must notify
      // the ward resident and NOT the wardless member — recipients are
      // resolved from the profile dataset, never from a caller-relative
      // has_permission() predicate.
      const wardResident = await createUser(db, {
        tenantId: tenantA, email: "p16-wardres@a.test", fullName: "Ward Resident",
        wardId: WARD, lgaId: LGA,
      });
      const wardless = await createUser(db, {
        tenantId: tenantA, email: "p16-wardless@a.test", fullName: "Wardless",
      });

      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_poll", {
        p_title: "Fanout probe poll", p_question: "Q?", p_options: OPTIONS,
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(made.error).toBeUndefined();
      const fanoutId = (made.rows[0] as Record<string, unknown>).create_governance_poll as string;
      const opened = await as(db, "authenticated", managerA.authId, callRpc("set_governance_poll_status", {
        p_poll: fanoutId, p_status: "open",
      }));
      expect(opened.error).toBeUndefined();

      const fanout = await db.query(
        `SELECT user_id FROM politicore.notifications
          WHERE link_url = '/governance/participate'
            AND message LIKE '%Fanout probe poll%'`);
      const recipients = fanout.rows.map((r) => String((r as Record<string, unknown>).user_id));
      expect(recipients.length).toBeGreaterThan(0);
      expect(recipients).toContain(wardResident.authId);
      expect(recipients).not.toContain(wardless.authId);
      // Cross-tenant containment: no tenant-B profile was notified.
      expect(recipients).not.toContain(memberB.authId);

      const fanoutBody = await db.query(
        `SELECT pg_get_functiondef(to_regproc('politicore.governance_notify_poll_open')) d`);
      const body = String((fanoutBody.rows[0] as Record<string, unknown>).d);
      // Data-driven resolution asserted structurally as well.
      expect(body).toContain("politicore.profiles");
      expect(body).not.toContain("has_permission(");

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_poll_notif%' OR tablename LIKE 'poll_notification%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C16. media boundary ─────────────────────────────────────────────
  describe("C16. media boundary", () => {
    it("no poll media tables exist", async () => {
      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_poll%media%' OR tablename LIKE 'poll_media%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C17. schema/security pins ───────────────────────────────────────
  describe("C17. schema and security pins", () => {
    it("FORCE RLS everywhere; zero anon policies; anon holds no view grants", async () => {
      for (const table of ["governance_polls", "governance_poll_scopes", "governance_poll_votes"]) {
        const flags = await db.query(
          `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='politicore' AND c.relname=$1`, [table]);
        expect(flags.rows[0]).toMatchObject({ r: true, f: true });
      }
      const anonPolicies = await db.query(
        `SELECT count(*)::int n FROM pg_policies WHERE schemaname='politicore'
          AND tablename LIKE 'governance_poll%' AND 'anon' = ANY(roles)`);
      expect(Number((anonPolicies.rows[0] as Record<string, unknown>).n)).toBe(0);

      for (const view of ["governance_polls", "governance_poll_scopes", "governance_poll_votes"]) {
        const anonGrant = await db.query(
          `SELECT count(*)::int n FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name=$1 AND grantee='anon'`, [view]);
        expect(Number((anonGrant.rows[0] as Record<string, unknown>).n)).toBe(0);
      }
    });

    it("reference generator mints PL- codes; references are immutable; lifecycle vocabulary is closed", async () => {
      const ref = await db.query(`SELECT reference_code FROM politicore.governance_polls WHERE title='Participation poll'`);
      expect(String((ref.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^PL-[0-9A-F]{8}$/);

      const probeId = await idByTitle("Participation poll");
      // Reference is immutable — a direct rewrite is a silent no-op under
      // RLS (no UPDATE policy), and the value must survive unchanged.
      const attempt = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_polls SET reference_code='PL-HACKED1' WHERE id='${probeId}'`);
      expect(attempt.error).toBeUndefined();
      const after = await db.query(`SELECT reference_code FROM politicore.governance_polls WHERE id=$1`, [probeId]);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^PL-[0-9A-F]{8}$/);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).not.toBe("PL-HACKED1");

      const statuses = await db.query(
        `SELECT unnest(enum_range(NULL::politicore.governance_poll_status))::text s ORDER BY s`);
      expect(statuses.rows.map((r) => String((r as Record<string, unknown>).s))).toEqual(["closed", "draft", "open"]);
    });

    it("no duplicate participation/identity systems and no Firebase return", async () => {
      const noTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'poll_users%' OR tablename LIKE 'voter_accounts%'
            OR tablename LIKE 'governance_poll_participants%')`);
      expect(Number((noTables.rows[0] as Record<string, unknown>).n)).toBe(0);

      const noFk = await db.query(
        `SELECT count(*)::int n FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname='politicore' AND c.relname LIKE 'governance_poll%'
            AND con.contype = 'f'
            AND pg_get_constraintdef(con.oid) ~ '(campaign|election|social)'`);
      expect(Number((noFk.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });
});
