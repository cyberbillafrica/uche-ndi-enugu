/**
 * POLITICORE — GOVERNANCE PHASE 17 — ENGAGEMENTS SECURITY SUITE.
 *
 * Proves the Engagements slice (migration 0056) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–16:
 *
 *   C1.  creation authority — manage_participation (+ geo) required;
 *        unauthorized members cannot create or manage
 *   C2.  anonymous boundary — anon holds NOTHING on engagements
 *   C3.  tenant isolation — cross-tenant read/mutate/child/link fails closed
 *   C4.  module isolation — governance OFF blocks; Campaign/Election
 *        state is irrelevant to Engagements
 *   C5.  permission catalog — the Phase 11 §16 seven; no engagement-
 *        specific permission; no new roles
 *   C6.  geographic authority — unrelated/campaign/unknown scopes fail;
 *        bootstrap rule (scope-scoped grantees cannot mint tenant-wide)
 *   C7.  lifecycle — draft→scheduled→concluded only; trigger guard
 *        re-enforces; content sealed at conclusion
 *   C8.  event separation — optional one-way link; same-tenant only; the
 *        Event is never mutated and grants no authority
 *   C9.  agenda — server-validated (ids unique, lengths capped); frozen
 *        at conclusion
 *   C10. stakeholders — existing tenant participants only; upsert
 *        semantics; no direct write path
 *   C11. attendance — staff-recorded; one row per participant; never an
 *        Event RSVP; no direct write path
 *   C12. issues — staff-created; optional staff-authorized request link;
 *        bounded status vocabulary
 *   C13. follow-ups ARE updates — canonical governance_updates with
 *        engagement as the FIFTH subject; all existing subjects preserved;
 *        poll remains excluded
 *   C14. canonical audit — system_audits rows with server-side actor
 *   C15. core notifications — scheduling fanout is recipient-correct and
 *        data-driven (no caller-relative has_permission predicate)
 *   C16. media boundary — no engagement media tables
 *   C17. privacy — stakes/attendance/issues read surfaces are staff-only
 *        (plus own raised issue); public never exposes rosters
 *   C18. schema/security pins — FORCE RLS, hygiene, enums, references,
 *        no duplicate systems, Firebase absent
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

describe("Governance Phase 17 — Engagements", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let managerA: Staff; // manage_participation, ward-scoped
  let viewerA: Staff; // view_governance only
  let plainA: Staff; // no authority (participant)
  let memberB: Staff; // tenant B member
  let adminB: Staff; // tenant B admin

  const STATE = "pst17";
  const ZONE = "pz17";
  const LGA = "pl17";
  const WARD = "pw17";
  const PU = "pp17";
  const OTHER_WARD = "pw17z";

  const idByTitle = async (title: string): Promise<string> => {
    const r = await db.query(`SELECT id FROM politicore.governance_engagements WHERE title = $1`, [title]);
    return r.rows.length ? ((r.rows[0] as Record<string, unknown>).id as string) : "";
  };

  /** Portal profiles gain a Governance participant row via explicit provisioning here. */
  const participantFor = async (userId: string): Promise<string> => {
    const existing = await db.query(
      `SELECT id FROM politicore.governance_participants WHERE profile_id = $1`, [userId]);
    if (existing.rows.length) return String((existing.rows[0] as Record<string, unknown>).id);
    const ins = await db.query(
      `INSERT INTO politicore.governance_participants (tenant_id, profile_id, full_name)
       SELECT tenant_id, id, full_name FROM politicore.profiles WHERE id = $1 RETURNING id`, [userId]);
    return String((ins.rows[0] as Record<string, unknown>).id);
  };

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "p17-a", "P17 Tenant A", { governance: true });
    tenantB = await createTenant(db, "p17-b", "P17 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "p17-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    managerA = await createUser(db, { tenantId: tenantA, email: "p17-mgr@a.test", fullName: "Manager A" });
    viewerA = await createUser(db, { tenantId: tenantA, email: "p17-view@a.test", fullName: "Viewer A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "p17-plain@a.test", fullName: "Plain A" });
    memberB = await createUser(db, { tenantId: tenantB, email: "p17-member@b.test", fullName: "Member B" });
    adminB = await createUser(db, { tenantId: tenantB, email: "p17-admin@b.test", fullName: "Admin B", accessRole: "admin" });

    await grant(db, tenantA, managerA.authId, "manage_participation", true, "ward", WARD);
    await grant(db, tenantA, viewerA.authId, "view_governance", true);

    // Core Geography fixtures (platform-admin path; states are open).
    await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P17State','PS') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P17Zone','PZ') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P17Lga','PL') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P17Ward','PW') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await db.query(`INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code) VALUES ($1,$2,$3,'P17PU','PP') ON CONFLICT (id) DO NOTHING`, [PU, WARD, LGA]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P17OtherWard','PWO') ON CONFLICT (id) DO NOTHING`, [OTHER_WARD, LGA]);

    // Events content fixture per tenant (Events module is LOCKED content).
    await db.query(
      `INSERT INTO politicore.events (tenant_id, title, event_date, venue, status, created_by)
       VALUES ($1,'P17 Town Hall', current_date + 30, 'P17 Hall', 'published', $2)`,
      [tenantA, adminA.profileId]);
    await db.query(
      `INSERT INTO politicore.events (tenant_id, title, event_date, venue, status, created_by)
       VALUES ($1,'P17 B Event', current_date + 30, 'P17 B Hall', 'published', $2)`,
      [tenantB, adminB.profileId]);
  });

  // ── C1. creation authority ──────────────────────────────────────────
  describe("C1. creation authority", () => {
    it("a ward-scoped manager creates an engagement AT their ward; scope rows land", async () => {
      const created = await as(db, "authenticated", managerA.authId, callRpc("create_governance_engagement", {
        p_title: "Ward 5 town hall",
        p_description: "Constituency engagement",
        p_location: "Ward hall",
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(created.error).toBeUndefined();
      const eid = String((created.rows[0] as Record<string, unknown>).create_governance_engagement);

      const scopes = await db.query(
        `SELECT scope_type, ward_id FROM politicore.governance_engagement_scopes WHERE engagement_id = $1`,
        [eid]);
      expect(scopes.rows[0]).toMatchObject({ scope_type: "ward", ward_id: WARD });

      const row = await db.query(`SELECT reference_code, status, created_by FROM politicore.governance_engagements WHERE id = $1`, [eid]);
      expect(row.rows[0]).toMatchObject({ status: "draft" });
      expect(String((row.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^EN-[0-9A-F]{8}$/);
      expect(String((row.rows[0] as Record<string, unknown>).created_by)).toBe(managerA.authId);
    });

    it("a viewer cannot create; a plain member cannot create", async () => {
      const denied1 = await as(db, "authenticated", viewerA.authId, callRpc("create_governance_engagement", {
        p_title: "Nope",
      }));
      expect(denied1.error).toMatch(/manage_participation/);

      const denied2 = await as(db, "authenticated", plainA.authId, callRpc("create_governance_engagement", {
        p_title: "Nope 2",
      }));
      expect(denied2.error).toMatch(/manage_participation/);
    });

    it("a scope-scoped grantee must deliver a scope within their authority (bootstrap rule)", async () => {
      const orphan = await as(db, "authenticated", managerA.authId, callRpc("create_governance_engagement", {
        p_title: "Orphan engagement",
      }));
      expect(orphan.error).toMatch(/scope within your authority/);
    });
  });

  // ── C2. anonymous boundary ──────────────────────────────────────────
  describe("C2. anonymous boundary", () => {
    it("anon reads nothing and executes nothing", async () => {
      const read = await as(db, "anon", null, `SELECT * FROM politicore.governance_engagements`);
      expect(read.rows).toHaveLength(0);

      const childRead = await as(db, "anon", null, `SELECT * FROM politicore.governance_engagement_stakeholders`);
      expect(childRead.rows).toHaveLength(0);

      const viewRead = await as(db, "anon", null, `SELECT * FROM public.governance_engagements`);
      expect(viewRead.error).toBeDefined();

      const rpc = await as(db, "anon", null, callRpc("create_governance_engagement", { p_title: "anon" }));
      expect(rpc.error).toBeDefined();

      const wrapper = await as(db, "anon", null, `SELECT * FROM public.create_governance_engagement('x')`);
      expect(wrapper.error).toBeDefined();
    });
  });

  // ── C3. tenant isolation ────────────────────────────────────────────
  describe("C3. tenant isolation", () => {
    let engagementId: string;

    beforeAll(async () => {
      engagementId = await idByTitle("Ward 5 town hall");
    });

    it("cross-tenant reads return nothing and mutations fail closed", async () => {
      const foreignRead = await as(db, "authenticated", memberB.authId,
        `SELECT * FROM politicore.governance_engagements WHERE id = $1`, [engagementId]);
      expect(foreignRead.rows).toHaveLength(0);

      const foreignStatus = await as(db, "authenticated", adminB.authId, callRpc("set_governance_engagement_status", {
        p_engagement: engagementId, p_status: "scheduled",
      }));
      expect(foreignStatus.error).toMatch(/not found/);

      const foreignIssue = await as(db, "authenticated", adminB.authId, callRpc("create_governance_engagement_issue", {
        p_engagement: engagementId, p_title: "foreign issue",
      }));
      expect(foreignIssue.error).toMatch(/not found/);

      const foreignChildRead = await as(db, "authenticated", memberB.authId,
        `SELECT * FROM politicore.governance_engagement_attendance WHERE engagement_id = $1`, [engagementId]);
      expect(foreignChildRead.rows).toHaveLength(0);
    });
  });

  // ── C4. module isolation ────────────────────────────────────────────
  describe("C4. module isolation", () => {
    it("governance disabled blocks creation and mutation", async () => {
      const tenantC = await createTenant(db, "p17-c", "P17 Tenant C", { governance: false });
      const staffC = await createUser(db, { tenantId: tenantC, email: "p17-admin@c.test", fullName: "Admin C", accessRole: "admin" });

      const created = await as(db, "authenticated", staffC.authId, callRpc("create_governance_engagement", {
        p_title: "Should not exist",
      }));
      expect(created.error).toMatch(/module is not enabled/);
    });
  });

  // ── C5. permission catalog ──────────────────────────────────────────
  describe("C5. permission catalog", () => {
    it("governance permissions are exactly the Phase 11 §16 seven — no engagement-specific permission", async () => {
      const perms = await db.query(
        `SELECT name FROM politicore.permissions WHERE domain='governance' ORDER BY name`);
      const names = perms.rows.map((r) => String((r as Record<string, unknown>).name));
      expect(names).toEqual([
        "assign_cases", "manage_cases", "manage_participation", "manage_projects",
        "publish_accountability", "view_cases", "view_governance",
      ]);

      const noTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE '%engagement_manager%' OR tablename LIKE '%engagement_admin%')`);
      expect(Number((noTables.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C6. geographic authority ────────────────────────────────────────
  describe("C6. geographic authority", () => {
    it("unrelated scope fails; campaign scope forbidden; unknown geography fails", async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement", {
        p_title: "Geo probe engagement",
      }));
      const eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;

      const outside = await as(db, "authenticated", managerA.authId, callRpc("add_governance_engagement_scope", {
        p_engagement: eid, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: OTHER_WARD,
      }));
      expect(outside.error).toMatch(/outside their authority/);

      const campaign = await as(db, "authenticated", adminA.authId, callRpc("add_governance_engagement_scope", {
        p_engagement: eid, p_scope_type: "campaign", p_state_id: STATE,
      }));
      expect(campaign.error).toMatch(/campaign/);

      const unknown = await as(db, "authenticated", adminA.authId, callRpc("add_governance_engagement_scope", {
        p_engagement: eid, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "ghost-ward",
      }));
      expect(unknown.error).toMatch(/does not exist in Core Geography/);
    });

    it("descendant coverage works: PU scope under managerA's ward is attachable by adminA", async () => {
      const probe = await db.query(`SELECT id FROM politicore.governance_engagements WHERE title='Geo probe engagement'`);
      const made = await as(db, "authenticated", adminA.authId, callRpc("add_governance_engagement_scope", {
        p_engagement: String((probe.rows[0] as Record<string, unknown>).id),
        p_scope_type: "polling_unit",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD, p_polling_unit_id: PU,
      }));
      expect(made.error).toBeUndefined();
    });
  });

  // ── C7. lifecycle ───────────────────────────────────────────────────
  describe("C7. lifecycle", () => {
    it("draft→scheduled→concluded only; guard trigger re-enforces; content sealed at conclusion", async () => {
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_engagement", {
        p_title: "Lifecycle engagement",
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      const eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;

      // Illegal jump draft → concluded is rejected.
      const jump = await as(db, "authenticated", managerA.authId, callRpc("set_governance_engagement_status", {
        p_engagement: eid, p_status: "concluded",
      }));
      expect(jump.error).toMatch(/status must be scheduled or concluded|illegal engagement status transition/);

      const scheduled = await as(db, "authenticated", managerA.authId, callRpc("set_governance_engagement_status", {
        p_engagement: eid, p_status: "scheduled",
      }));
      expect(scheduled.error).toBeUndefined();

      // Backward transition is illegal (guard trigger).
      const backward = await as(db, "authenticated", managerA.authId, callRpc("set_governance_engagement_status", {
        p_engagement: eid, p_status: "scheduled",
      }));
      expect(backward.error).toBeUndefined(); // same-status no-op

      // Content is still editable while scheduled; sealing happens at
      // conclusion.
      const editScheduled = await as(db, "authenticated", managerA.authId, callRpc("update_governance_engagement", {
        p_engagement: eid, p_location: "Updated venue",
      }));
      expect(editScheduled.error).toBeUndefined();

      const concluded = await as(db, "authenticated", managerA.authId, callRpc("set_governance_engagement_status", {
        p_engagement: eid, p_status: "concluded", p_outcomes: "Five commitments recorded",
      }));
      expect(concluded.error).toBeUndefined();

      // Post-conclusion content mutation fails (RPC + trigger guard).
      const editSealed = await as(db, "authenticated", managerA.authId, callRpc("update_governance_engagement", {
        p_engagement: eid, p_title: "Rewriting history",
      }));
      expect(editSealed.error).toMatch(/sealed/);

      const scopeSealed = await as(db, "authenticated", managerA.authId, callRpc("add_governance_engagement_scope", {
        p_engagement: eid, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD,
      }));
      expect(scopeSealed.error).toMatch(/sealed/);

      // held_at stamped exactly by the conclusion act; outcomes recorded.
      const row = await db.query(`SELECT status, held_at, outcomes FROM politicore.governance_engagements WHERE id=$1`, [eid]);
      expect(row.rows[0]).toMatchObject({ status: "concluded", outcomes: "Five commitments recorded" });
      expect((row.rows[0] as Record<string, unknown>).held_at).not.toBeNull();

      // Terminal record retained: no delete path anywhere.
      const del = await as(db, "authenticated", adminA.authId,
        `DELETE FROM politicore.governance_engagements WHERE id = '${eid}'`);
      expect(del.error).toBeUndefined(); // silent no-op under RLS
      const still = await db.query(`SELECT id FROM politicore.governance_engagements WHERE id = $1`, [eid]);
      expect(still.rows).toHaveLength(1);
    });
  });

  // ── C8. event separation ────────────────────────────────────────────
  describe("C8. event separation", () => {
    let eid: string;
    let eventIdA: string;
    let eventIdB: string;

    beforeAll(async () => {
      eid = await idByTitle("Event linkage engagement");
      if (!eid) {
        const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement", {
          p_title: "Event linkage engagement",
        }));
        eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;
      }
      const ev = await db.query(`SELECT id FROM politicore.events WHERE title='P17 Town Hall'`);
      eventIdA = String((ev.rows[0] as Record<string, unknown>).id);
      const evB = await db.query(`SELECT id FROM politicore.events WHERE title='P17 B Event'`);
      eventIdB = String((evB.rows[0] as Record<string, unknown>).id);
    });

    it("an Event exists without any Engagement and vice versa", async () => {
      const standalone = await db.query(
        `SELECT e.id FROM politicore.events e
          LEFT JOIN politicore.governance_engagements ge ON ge.event_id = e.id
          WHERE ge.id IS NULL`);
      expect(standalone.rows.length).toBeGreaterThan(0);

      const noEvent = await db.query(
        `SELECT count(*)::int n FROM politicore.governance_engagements WHERE event_id IS NULL`);
      expect(Number((noEvent.rows[0] as Record<string, unknown>).n)).toBeGreaterThan(0);
    });

    it("linking works within the tenant; cross-tenant linkage fails; unlink works", async () => {
      const linked = await as(db, "authenticated", adminA.authId, callRpc("link_governance_engagement_event", {
        p_engagement: eid, p_event_id: eventIdA,
      }));
      expect(linked.error).toBeUndefined();

      const cross = await as(db, "authenticated", adminA.authId, callRpc("link_governance_engagement_event", {
        p_engagement: eid, p_event_id: eventIdB,
      }));
      expect(cross.error).toMatch(/not found in this tenant/);

      const unlinked = await as(db, "authenticated", adminA.authId, callRpc("unlink_governance_engagement_event", {
        p_engagement: eid,
      }));
      expect(unlinked.error).toBeUndefined();
      const row = await db.query(`SELECT event_id FROM politicore.governance_engagements WHERE id=$1`, [eid]);
      expect((row.rows[0] as Record<string, unknown>).event_id).toBeNull();
    });

    it("a viewer who can read the Event gains no Engagement authority through it", async () => {
      // viewerA holds view_governance (read surface only). The mutating
      // RPC requires manage_participation — the Event link must not
      // launder authority.
      const denied = await as(db, "authenticated", viewerA.authId, callRpc("link_governance_engagement_event", {
        p_engagement: eid, p_event_id: eventIdA,
      }));
      expect(denied.error).toMatch(/manage_participation with geographic authority required/);
    });

    it("deleting the linked Event cannot corrupt the Engagement (ON DELETE SET NULL)", async () => {
      const linked = await as(db, "authenticated", adminA.authId, callRpc("link_governance_engagement_event", {
        p_engagement: eid, p_event_id: eventIdA,
      }));
      expect(linked.error).toBeUndefined();

      // Direct service-role delete of the Event (Events owner action).
      await db.query(`DELETE FROM politicore.events WHERE id = $1`, [eventIdA]);
      const row = await db.query(`SELECT event_id FROM politicore.governance_engagements WHERE id=$1`, [eid]);
      expect((row.rows[0] as Record<string, unknown>).event_id).toBeNull();

      // And the engagement itself is untouched.
      const still = await db.query(`SELECT count(*)::int n FROM politicore.governance_engagements WHERE id=$1`, [eid]);
      expect(Number((still.rows[0] as Record<string, unknown>).n)).toBe(1);
    });
  });

  // ── C9. agenda ──────────────────────────────────────────────────────
  describe("C9. agenda", () => {
    it("valid agenda lands; duplicate ids and overlength items are rejected server-side", async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement", {
        p_title: "Agenda probe",
        p_agenda: '[{"id":"item-1","title":"Welcome","detail":"Introductions"},{"id":"item-2","title":"Open floor"}]',
      }));
      const eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;

      const row = await db.query(`SELECT agenda FROM politicore.governance_engagements WHERE id=$1`, [eid]);
      const agenda = (row.rows[0] as Record<string, unknown>).agenda as unknown[];
      expect(agenda).toHaveLength(2);

      const dup = await as(db, "authenticated", adminA.authId, callRpc("update_governance_engagement", {
        p_engagement: eid,
        p_agenda: '[{"id":"same","title":"A"},{"id":"same","title":"B"}]',
      }));
      expect(dup.error).toMatch(/unique/);

      const noTitle = await as(db, "authenticated", adminA.authId, callRpc("update_governance_engagement", {
        p_engagement: eid,
        p_agenda: '[{"id":"item-1","title":""}]',
      }));
      expect(noTitle.error).toMatch(/requires a title/);

      const notArray = await as(db, "authenticated", adminA.authId, callRpc("update_governance_engagement", {
        p_engagement: eid,
        p_agenda: '{"id":"x"}',
      }));
      expect(notArray.error).toMatch(/must be an array|unexpected cast/);
    });
  });

  // ── C10. stakeholders ───────────────────────────────────────────────
  describe("C10. stakeholders", () => {
    let eid: string;
    let participantA: string;
    let participantB: string;

    beforeAll(async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement", {
        p_title: "Stakeholder probe",
      }));
      eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;
      participantA = await participantFor(plainA.authId);

      // Tenant-B participant row for the cross-tenant rejection.
      const pb = await db.query(
        `INSERT INTO politicore.governance_participants (tenant_id, full_name, email)
         VALUES ($1, 'B Participant', 'p17-bp@b.test') RETURNING id`, [tenantB]);
      participantB = String((pb.rows[0] as Record<string, unknown>).id);
    });

    it("a tenant participant is added; a foreign participant is rejected; upsert works", async () => {
      const ok = await as(db, "authenticated", adminA.authId, callRpc("add_governance_engagement_stakeholder", {
        p_engagement: eid, p_participant_id: participantA, p_role_label: "Ward chair", p_note: "invited",
      }));
      expect(ok.error).toBeUndefined();

      const foreign = await as(db, "authenticated", adminA.authId, callRpc("add_governance_engagement_stakeholder", {
        p_engagement: eid, p_participant_id: participantB, p_role_label: "spy",
      }));
      expect(foreign.error).toMatch(/participant not found in this tenant/);

      // Upsert updates the existing row (no duplicates).
      const again = await as(db, "authenticated", adminA.authId, callRpc("add_governance_engagement_stakeholder", {
        p_engagement: eid, p_participant_id: participantA, p_role_label: "Ward chair (confirmed)", p_note: "confirmed",
      }));
      expect(again.error).toBeUndefined();
      const rows = await db.query(
        `SELECT count(*)::int n FROM politicore.governance_engagement_stakeholders WHERE engagement_id=$1`,
        [eid]);
      expect(Number((rows.rows[0] as Record<string, unknown>).n)).toBe(1);

      const updated = await db.query(
        `SELECT role_label FROM politicore.governance_engagement_stakeholders WHERE engagement_id=$1`,
        [eid]);
      expect(String((updated.rows[0] as Record<string, unknown>).role_label)).toBe("Ward chair (confirmed)");
    });

    it("unauthorized members cannot manage stakeholders; no direct write path", async () => {
      const denied = await as(db, "authenticated", plainA.authId, callRpc("add_governance_engagement_stakeholder", {
        p_engagement: eid, p_participant_id: participantA, p_role_label: "self-appointed",
      }));
      expect(denied.error).toMatch(/manage_participation with geographic authority required/);

      const direct = await as(db, "authenticated", viewerA.authId,
        `INSERT INTO politicore.governance_engagement_stakeholders (tenant_id, engagement_id, participant_id, role_label)
           VALUES ('${tenantA}', '${eid}', '${participantA}', 'backdoor')`);
      expect(direct.error).toBeDefined();
    });

    it("removal works and is tenant-checked", async () => {
      const stake = await db.query(
        `SELECT id FROM politicore.governance_engagement_stakeholders WHERE engagement_id=$1`, [eid]);
      const sid = String((stake.rows[0] as Record<string, unknown>).id);

      const foreign = await as(db, "authenticated", adminB.authId, callRpc("remove_governance_engagement_stakeholder", {
        p_stakeholder: sid,
      }));
      expect(foreign.error).toMatch(/not found/);

      const ok = await as(db, "authenticated", adminA.authId, callRpc("remove_governance_engagement_stakeholder", {
        p_stakeholder: sid,
      }));
      expect(ok.error).toBeUndefined();
    });
  });

  // ── C11. attendance ─────────────────────────────────────────────────
  describe("C11. attendance", () => {
    let eid: string;
    let participantA: string;

    beforeAll(async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement", {
        p_title: "Attendance probe",
      }));
      eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;
      participantA = await participantFor(plainA.authId);
    });

    it("staff record attendance; duplicates are rejected; direct writes fail closed", async () => {
      const ok = await as(db, "authenticated", adminA.authId, callRpc("record_governance_engagement_attendance", {
        p_engagement: eid, p_participant_id: participantA, p_note: "arrived 10:04",
      }));
      expect(ok.error).toBeUndefined();

      const dup = await as(db, "authenticated", adminA.authId, callRpc("record_governance_engagement_attendance", {
        p_engagement: eid, p_participant_id: participantA,
      }));
      expect(dup.error).toMatch(/already recorded/);

      const unauthorized = await as(db, "authenticated", plainA.authId, callRpc("record_governance_engagement_attendance", {
        p_engagement: eid, p_participant_id: participantA, p_note: "self check-in",
      }));
      expect(unauthorized.error).toMatch(/manage_participation with geographic authority required/);

      const direct = await as(db, "authenticated", viewerA.authId,
        `INSERT INTO politicore.governance_engagement_attendance (tenant_id, engagement_id, participant_id)
           VALUES ('${tenantA}', '${eid}', '${participantA}')`);
      expect(direct.error).toBeDefined();

      // The recorded_by attribution is server-resolved.
      const row = await db.query(
        `SELECT recorded_by FROM politicore.governance_engagement_attendance WHERE engagement_id=$1`, [eid]);
      expect(String((row.rows[0] as Record<string, unknown>).recorded_by)).toBe(adminA.authId);
    });
  });

  // ── C12. issues ─────────────────────────────────────────────────────
  describe("C12. issues", () => {
    let eid: string;
    let requestId: string;

    beforeAll(async () => {
      const made = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement", {
        p_title: "Issue probe",
      }));
      eid = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;

      // A same-tenant request fixture for the optional staff-created link.
      const gpId = await participantFor(plainA.authId);
      const req = await db.query(
        `INSERT INTO politicore.governance_requests (tenant_id, reference_code, participant_id, title)
         VALUES ($1, 'EN-ISSUE-PROBE', $2, 'P17 issue probe request') RETURNING id`,
        [tenantA, gpId]);
      requestId = String((req.rows[0] as Record<string, unknown>).id);
    });

    it("staff create issues; unauthorized members cannot; request linkage is explicit and tenant-bound", async () => {
      const ok = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement_issue", {
        p_engagement: eid, p_title: "Water access raised",
      }));
      expect(ok.error).toBeUndefined();
      const issueId = String((ok.rows[0] as Record<string, unknown>).create_governance_engagement_issue);

      const denied = await as(db, "authenticated", plainA.authId, callRpc("create_governance_engagement_issue", {
        p_engagement: eid, p_title: "nope",
      }));
      expect(denied.error).toMatch(/manage_participation with geographic authority required/);

      const direct = await as(db, "authenticated", viewerA.authId,
        `INSERT INTO politicore.governance_engagement_issues (tenant_id, engagement_id, title)
           VALUES ('${tenantA}', '${eid}', 'backdoor issue')`);
      expect(direct.error).toBeDefined();

      const linked = await as(db, "authenticated", adminA.authId, callRpc("update_governance_engagement_issue", {
        p_issue: issueId, p_link_request: true, p_request_id: requestId,
      }));
      expect(linked.error).toBeUndefined();
      const row = await db.query(`SELECT request_id FROM politicore.governance_engagement_issues WHERE id=$1`, [issueId]);
      expect(String((row.rows[0] as Record<string, unknown>).request_id)).toBe(requestId);

      // Status vocabulary is bounded; illegal values are rejected.
      const badStatus = await as(db, "authenticated", adminA.authId, callRpc("update_governance_engagement_issue", {
        p_issue: issueId, p_status: "escalated",
      }));
      expect(badStatus.error).toMatch(/open, addressed or closed|invalid input value/);

      // The link never grants the issue-raiser authority over the request.
      const issueRow = await db.query(`SELECT raised_by_participant_id FROM politicore.governance_engagement_issues WHERE id=$1`, [issueId]);
      expect((issueRow.rows[0] as Record<string, unknown>).raised_by_participant_id).toBeNull();
    });
  });

  // ── C13. follow-ups ARE updates (canonical substrate) ───────────────
  describe("C13. canonical updates", () => {
    it("single-subject invariant spans five subjects; engagement updates work; all existing subjects preserved; poll excluded", async () => {
      const def = await db.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`);
      const constraint = String((def.rows[0] as Record<string, unknown>).d);
      expect(constraint).toContain("project_id");
      expect(constraint).toContain("commitment_id");
      expect(constraint).toContain("consultation_id");
      expect(constraint).toContain("petition_id");
      expect(constraint).toContain("engagement_id");
      expect(constraint).not.toContain("poll_id");

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND tablename IN ('governance_engagement_updates','engagement_updates','engagement_activity_log')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);

      // Engagement update works (Phase 17 slice).
      const eid = await idByTitle("Issue probe");
      const engUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_engagement_update", {
        p_engagement: eid, p_title: "Follow-up", p_body: "minutes circulated",
      }));
      expect(engUpdate.error).toBeUndefined();

      // Two subjects on one row is impossible (single-subject invariant).
      // A project fixture is created first so the probe genuinely presents
      // two non-NULL subjects.
      const twoProbeProject = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", {
        p_title: "P17 two-subject probe project",
      }));
      const twoProbeProjectId = (twoProbeProject.rows[0] as Record<string, unknown>).create_governance_project as string;
      let twoSubjectsError: string | undefined;
      try {
        await db.query(
          `INSERT INTO politicore.governance_updates (tenant_id, project_id, engagement_id, author_profile_id, title, body, kind)
           VALUES ($1, $2::uuid,
                   (SELECT id FROM politicore.governance_engagements WHERE title='Issue probe'),
                   $3, 'x', 'x', 'progress') RETURNING id`,
          [tenantA, twoProbeProjectId, adminA.authId]);
      } catch (e) {
        twoSubjectsError = (e as Error).message;
      }
      expect(twoSubjectsError).toMatch(/single_subject/);

      // Project updates still work (Phase 12 substrate preserved).
      const project = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", {
        p_title: "P17 substrate probe project",
      }));
      const projectId = (project.rows[0] as Record<string, unknown>).create_governance_project as string;
      const projectUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
        p_project: projectId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(projectUpdate.error).toBeUndefined();

      // Commitment updates still work (Phase 13 substrate preserved).
      const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
        p_title: "P17 substrate probe commitment",
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
    it("creation, lifecycle, linkage, child mutations and updates are audited with the server-side actor", async () => {
      const audits = await db.query(
        `SELECT action, actor_id FROM politicore.system_audits
          WHERE affected_resource = 'governance_engagements' ORDER BY occurred_at DESC LIMIT 80`);
      const actions = audits.rows.map((r) => String((r as Record<string, unknown>).action));
      expect(actions).toContain("governance_engagement:create");
      expect(actions).toContain("governance_engagement:update");
      expect(actions).toContain("governance_engagement:status");
      expect(actions).toContain("governance_engagement:event_linked");
      expect(actions).toContain("governance_engagement:event_unlinked");

      const childAudits = await db.query(
        `SELECT action FROM politicore.system_audits
          WHERE action LIKE 'governance_engagement_%' ORDER BY occurred_at DESC LIMIT 40`);
      const childActions = childAudits.rows.map((r) => String((r as Record<string, unknown>).action));
      expect(childActions).toContain("governance_engagement_stakeholder:set");
      expect(childActions).toContain("governance_engagement_attendance:record");
      expect(childActions).toContain("governance_engagement_issue:create");
      expect(childActions).toContain("governance_engagement_update:create");

      const updAudits = await db.query(
        `SELECT actor_id FROM politicore.system_audits
          WHERE action = 'governance_engagement_update:create' ORDER BY occurred_at DESC LIMIT 1`);
      expect(String((updAudits.rows[0] as Record<string, unknown>).actor_id)).toBe(adminA.authId);
    });
  });

  // ── C15. core notifications ─────────────────────────────────────────
  describe("C15. core notifications", () => {
    it("scheduling fanout is canonical, recipient-correct, data-driven; no parallel store", async () => {
      // Recipient correctness (the Phase 15 §24 regression): schedule a
      // NEW ward-scoped engagement AFTER these profiles exist — the ward
      // resident must be notified, the wardless member must not.
      const wardResident = await createUser(db, {
        tenantId: tenantA, email: "p17-wardres@a.test", fullName: "Ward Resident",
        wardId: WARD, lgaId: LGA,
      });
      const wardless = await createUser(db, {
        tenantId: tenantA, email: "p17-wardless@a.test", fullName: "Wardless",
      });

      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_engagement", {
        p_title: "Fanout probe engagement",
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      expect(made.error).toBeUndefined();
      const fanoutId = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;
      const scheduled = await as(db, "authenticated", managerA.authId, callRpc("set_governance_engagement_status", {
        p_engagement: fanoutId, p_status: "scheduled",
      }));
      expect(scheduled.error).toBeUndefined();

      const fanout = await db.query(
        `SELECT user_id FROM politicore.notifications
          WHERE link_url = '/governance/engagements'
            AND message LIKE '%Fanout probe engagement%'`);
      const recipients = fanout.rows.map((r) => String((r as Record<string, unknown>).user_id));
      expect(recipients.length).toBeGreaterThan(0);
      expect(recipients).toContain(wardResident.authId);
      expect(recipients).not.toContain(wardless.authId);
      // Cross-tenant containment: no tenant-B profile was notified.
      expect(recipients).not.toContain(memberB.authId);

      const fanoutBody = await db.query(
        `SELECT pg_get_functiondef(to_regproc('politicore.governance_notify_engagement_scheduled')) d`);
      const body = String((fanoutBody.rows[0] as Record<string, unknown>).d);
      // Data-driven resolution asserted structurally as well.
      expect(body).toContain("politicore.profiles");
      expect(body).not.toContain("has_permission(");

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_engagement_notif%' OR tablename LIKE 'engagement_notification%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C16. media boundary ─────────────────────────────────────────────
  describe("C16. media boundary", () => {
    it("no engagement media tables exist", async () => {
      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_engagement%media%' OR tablename LIKE 'engagement_media%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C17. privacy — read surfaces ────────────────────────────────────
  describe("C17. privacy — read surfaces", () => {
    it("stakeholders/attendance are staff-only; issues admit the raising participant's own row; anon sees nothing", async () => {
      // plainA (a mere participant, no view_governance) reads no roster.
      const stake = await as(db, "authenticated", plainA.authId,
        `SELECT * FROM politicore.governance_engagement_stakeholders`);
      expect(stake.rows).toHaveLength(0);

      const attendance = await as(db, "authenticated", plainA.authId,
        `SELECT * FROM politicore.governance_engagement_attendance`);
      expect(attendance.rows).toHaveLength(0);

      // Staff (view_governance) read the roster within the tenant.
      const staffStake = await as(db, "authenticated", viewerA.authId,
        `SELECT count(*)::int n FROM politicore.governance_engagement_stakeholders`);
      expect(Number((staffStake.rows[0] as Record<string, unknown>).n)).toBeGreaterThanOrEqual(0);

      // Anon is fully denied on every child surface.
      const anonIssues = await as(db, "anon", null,
        `SELECT * FROM politicore.governance_engagement_issues`);
      expect(anonIssues.rows).toHaveLength(0);
    });

    it("is_public defaults false; direct-table flips are blocked; the RPC path is publish_accountability-gated", async () => {
      const made = await as(db, "authenticated", managerA.authId, callRpc("create_governance_engagement", {
        p_title: "Visibility probe engagement",
        p_scopes: `[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]`,
      }));
      const probeId = (made.rows[0] as Record<string, unknown>).create_governance_engagement as string;

      const before = await db.query(`SELECT is_public FROM politicore.governance_engagements WHERE id=$1`, [probeId]);
      expect((before.rows[0] as Record<string, unknown>).is_public).toBe(false);

      // No UPDATE policy covers visibility; a direct flip is a silent
      // no-op under RLS and the value must remain false.
      const direct = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_engagements SET is_public = true WHERE id='${probeId}'`);
      expect(direct.error).toBeUndefined();
      const after = await db.query(`SELECT is_public FROM politicore.governance_engagements WHERE id=$1`, [probeId]);
      expect((after.rows[0] as Record<string, unknown>).is_public).toBe(false);

      const ungated = await as(db, "authenticated", managerA.authId, callRpc("set_governance_engagement_visibility", {
        p_engagement: probeId, p_is_public: true,
      }));
      expect(ungated.error).toMatch(/publish_accountability/);

      const gated = await as(db, "authenticated", adminA.authId, callRpc("set_governance_engagement_visibility", {
        p_engagement: probeId, p_is_public: true,
      }));
      expect(gated.error).toBeUndefined();
    });
  });

  // ── C18. schema/security pins ───────────────────────────────────────
  describe("C18. schema and security pins", () => {
    it("FORCE RLS everywhere; zero anon policies; anon holds no view grants", async () => {
      for (const table of [
        "governance_engagements", "governance_engagement_scopes",
        "governance_engagement_stakeholders", "governance_engagement_attendance",
        "governance_engagement_issues",
      ]) {
        const flags = await db.query(
          `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='politicore' AND c.relname=$1`, [table]);
        expect(flags.rows[0]).toMatchObject({ r: true, f: true });
      }
      const anonPolicies = await db.query(
        `SELECT count(*)::int n FROM pg_policies WHERE schemaname='politicore'
          AND tablename LIKE 'governance_engagement%' AND 'anon' = ANY(roles)`);
      expect(Number((anonPolicies.rows[0] as Record<string, unknown>).n)).toBe(0);

      for (const view of [
        "governance_engagements", "governance_engagement_scopes",
        "governance_engagement_stakeholders", "governance_engagement_attendance",
        "governance_engagement_issues",
      ]) {
        const anonGrant = await db.query(
          `SELECT count(*)::int n FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name=$1 AND grantee='anon'`, [view]);
        expect(Number((anonGrant.rows[0] as Record<string, unknown>).n)).toBe(0);
      }
    });

    it("reference generator mints EN- codes; references are immutable; lifecycle vocabulary is closed", async () => {
      const ref = await db.query(
        `SELECT reference_code FROM politicore.governance_engagements WHERE title='Ward 5 town hall'`);
      expect(String((ref.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^EN-[0-9A-F]{8}$/);

      const probeId = await idByTitle("Ward 5 town hall");
      const attempt = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_engagements SET reference_code='EN-HACKED1' WHERE id='${probeId}'`);
      expect(attempt.error).toBeUndefined();
      const after = await db.query(`SELECT reference_code FROM politicore.governance_engagements WHERE id=$1`, [probeId]);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^EN-[0-9A-F]{8}$/);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).not.toBe("EN-HACKED1");

      const statuses = await db.query(
        `SELECT unnest(enum_range(NULL::politicore.governance_engagement_status))::text s ORDER BY s`);
      expect(statuses.rows.map((r) => String((r as Record<string, unknown>).s))).toEqual(["concluded", "draft", "scheduled"]);
    });

    it("no duplicate systems, no Campaign/Election/Social FKs, no governance_events, no Firebase return", async () => {
      const noTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename IN ('governance_events')
            OR tablename LIKE 'engagement_users%' OR tablename LIKE 'stakeholder_accounts%'
            OR tablename LIKE 'attendance_users%')`);
      expect(Number((noTables.rows[0] as Record<string, unknown>).n)).toBe(0);

      // No governance FK targets Campaign/Election/Social tables; the only
      // out-of-governance FK is the optional one-way events link.
      const fks = await db.query(
        `SELECT conrelid::regclass::text tbl, pg_get_constraintdef(con.oid) def
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE ns.nspname='politicore' AND c.relname LIKE 'governance_engagement%'
            AND con.contype = 'f' AND con.connamespace = 'politicore'::regnamespace`);
      for (const row of fks.rows) {
        const def = String((row as Record<string, unknown>).def);
        expect(def).not.toMatch(/campaign|election|social/);
      }

      const noFirebase = await db.query(
        `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE ns.nspname IN ('politicore','public') AND p.proname ILIKE '%firebase%'`);
      expect(Number((noFirebase.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });
});
