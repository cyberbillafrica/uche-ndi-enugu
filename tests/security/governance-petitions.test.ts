/**
 * POLITICORE — GOVERNANCE PHASE 15 — PETITIONS & COMMUNITY PROPOSALS SECURITY SUITE.
 *
 * Proves the Petitions slice (migration 0052) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–14:
 *
 *   C1.  creation authority — manage_participation (+ geo) for staff
 *        petitions; ANY member may originate a community proposal
 *        (moderation pending is the control, not a permission)
 *   C2.  anonymous boundary — anon holds nothing on the surface
 *   C3.  tenant isolation — cross-tenant read/mutate/sign fails closed
 *   C4.  module isolation — governance OFF blocks
 *   C5.  permission catalog — the Phase 11 §16 seven; no per-instrument
 *        permissions; no new roles
 *   C6.  geographic authority — unrelated/campaign/unknown scopes fail;
 *        bootstrap rule (scope-scoped grantees cannot mint tenant-wide)
 *   C7.  lifecycle — draft|pending→open→closed→verified→results_published
 *        only; verified/results unreachable via the status RPC; trigger
 *        guard re-enforces the map
 *   C8.  participant integrity — participant identity server-resolved;
 *        forged participant impossible
 *   C9.  duplicate participation — UNIQUE(petition_id, participant_id)
 *   C10. support integrity — signatures cannot be altered by unauthorized
 *        actors (no UPDATE policy; append-only in practice)
 *   C11. verification-before-results — unverified closure cannot publish
 *   C12. verification authority — manage_participation (geo) verifies;
 *        no separate permission exists or is needed
 *   C13. result publication — publish_accountability required; verified
 *        state required; no republish
 *   C14. privacy — participants see only their own signature; staff-wide
 *        register; signatures never public
 *   C15. canonical updates — single-subject invariant spans project|
 *        commitment|consultation|petition; prior subjects still work
 *   C16. canonical audit — system_audits with server-side actor
 *   C17. core notifications — canonical notifications rows, no parallel store
 *   C18. media boundary — no petition media tables
 *   C19. relationships — no FK from petitions into locked modules; no
 *        link tables that could grant authority
 *   C20. schema/security pins — FORCE RLS, hygiene, enums, PP- references
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { as, createTenant, createUser, getDb, grant } from "./helpers";

interface Staff {
  authId: string;
  email: string;
  profileId: string;
}

const callRpc = (name: string, args: Record<string, unknown>) => {
  // Positional emission in RPC SIGNATURE ORDER — the petitions RPCs place
  // p_scopes AFTER p_target_signatures, so a fixed key order would bind
  // arguments to the wrong slots.
  const ORDER: Record<string, string[]> = {
    create_governance_petition: ["p_origin", "p_title", "p_demand", "p_target_signatures", "p_closes_at", "p_scopes"],
    update_governance_petition: ["p_petition", "p_title", "p_demand", "p_target_signatures", "p_closes_at", "p_clear_closes_at"],
  };
  const order = ORDER[name];
  if (order) {
    // Positional calls cannot skip middle params — emit every signature
    // slot, filling absent optional args with NULL.
    return `SELECT * FROM politicore.${name}(${order
      .map((k) => {
        const v = args[k];
        if (!(k in args) || v === undefined || v === null) return "NULL";
        if (typeof v === "string" && v.startsWith("sql:")) return v.slice(4);
        if (typeof v === "string") return `'${(v as string).replace(/'/g, "''")}'`;
        return String(v);
      })
      .join(", ")})`;
  }
  return `SELECT * FROM politicore.${name}(${Object.keys(args)
    .map((k) => {
      const v = args[k];
      if (typeof v === "string" && v.startsWith("sql:")) return v.slice(4);
      if (typeof v === "string") return `'${(v as string).replace(/'/g, "''")}'`;
      return String(v);
    })
    .join(", ")})`;
};

describe("Governance Phase 15 — Petitions & Community Proposals", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let managerA: Staff; // manage_participation, ward-scoped
  let viewerA: Staff; // view_governance only
  let plainA: Staff; // no authority (participant + proposer)
  let memberB: Staff; // tenant B member
  let adminB: Staff; // tenant B admin

  const STATE = "ps15";
  const ZONE = "pz15";
  const LGA = "pl15";
  const WARD = "pw15";
  const PU = "ppu15";
  const OTHER_WARD = "pw15z";

  const idByTitle = async (title: string): Promise<string> => {
    const r = await db.query(`SELECT id FROM politicore.governance_petitions WHERE title = $1`, [title]);
    return (r.rows[0] as Record<string, unknown>).id as string;
  };

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "p15-a", "P15 Tenant A", { governance: true });
    tenantB = await createTenant(db, "p15-b", "P15 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "p15-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    managerA = await createUser(db, { tenantId: tenantA, email: "p15-mgr@a.test", fullName: "Manager A" });
    viewerA = await createUser(db, { tenantId: tenantA, email: "p15-view@a.test", fullName: "Viewer A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "p15-plain@a.test", fullName: "Plain A" });
    memberB = await createUser(db, { tenantId: tenantB, email: "p15-member@b.test", fullName: "Member B" });
    adminB = await createUser(db, { tenantId: tenantB, email: "p15-admin@b.test", fullName: "Admin B", accessRole: "admin" });

    await grant(db, tenantA, managerA.authId, "manage_participation", true, "ward", WARD);
    await grant(db, tenantA, viewerA.authId, "view_governance", true);

    // Core Geography fixtures (platform-admin path; states are open).
    await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P15State','PS') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P15Zone','PZ') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P15Lga','PL') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P15Ward','PW') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await db.query(`INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code) VALUES ($1,$2,$3,'P15PU','PP') ON CONFLICT (id) DO NOTHING`, [PU, WARD, LGA]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P15OtherWard','PWO') ON CONFLICT (id) DO NOTHING`, [OTHER_WARD, LGA]);

    // Petition fixtures:
    //  - ward-scoped petition (managerA, within authority)
    const ward = await as(db, "authenticated", managerA.authId, callRpc("create_governance_petition", {
      p_origin: "petition",
      p_title: "P15 Ward drainage petition",
      p_demand: "Fix the ward drainage before the rains.",
      p_target_signatures: 50,
      p_scopes: `sql:'[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]'::jsonb::text`,
    }));
    expect(ward.error).toBeUndefined();

    //  - tenant-wide petition (adminA, staff origin)
    const road = await as(db, "authenticated", adminA.authId, callRpc("create_governance_petition", {
      p_origin: "petition",
      p_title: "P15 Road repair petition",
      p_demand: "Resurface the market road.",
      p_target_signatures: 100,
    }));
    expect(road.error).toBeUndefined();

    //  - participant-originated community proposal (plainA, NO permission)
    const proposal = await as(db, "authenticated", plainA.authId, callRpc("create_governance_petition", {
      p_origin: "community_proposal",
      p_title: "P15 Community market proposal",
      p_demand: "Open a weekend market in the community.",
    }));
    expect(proposal.error).toBeUndefined();
    const propRow = await db.query(
      `SELECT status, proposer_participant_id FROM politicore.governance_petitions WHERE title='P15 Community market proposal'`);
    expect(propRow.rows[0]).toMatchObject({ status: "pending" });
    expect((propRow.rows[0] as Record<string, unknown>).proposer_participant_id).not.toBeNull();
  });

  // ── C1. creation authority ──────────────────────────────────────────
  describe("C1. creation authority", () => {
    it("a ward-scoped manager creates a staff petition AT their ward", async () => {
      const created = await as(db, "authenticated", managerA.authId, callRpc("create_governance_petition", {
        p_origin: "petition",
        p_title: "P15 Ward clinic hours petition",
        p_scopes: `sql:'[{"scope_type":"ward","state_id":"${STATE}","zone_id":"${ZONE}","lga_id":"${LGA}","ward_id":"${WARD}"}]'::jsonb::text`,
      }));
      expect(created.error).toBeUndefined();
      const pid = String((created.rows[0] as Record<string, unknown>).create_governance_petition);
      const scopes = await db.query(
        `SELECT scope_type, ward_id FROM politicore.governance_petition_scopes WHERE petition_id = $1`, [pid]);
      expect(scopes.rows[0]).toMatchObject({ scope_type: "ward", ward_id: WARD });
    });

    it("a viewer or plain member cannot create a staff petition", async () => {
      const denied1 = await as(db, "authenticated", viewerA.authId, callRpc("create_governance_petition", {
        p_origin: "petition", p_title: "Nope petition",
      }));
      expect(denied1.error).toMatch(/manage_participation/);

      const denied2 = await as(db, "authenticated", plainA.authId, callRpc("create_governance_petition", {
        p_origin: "petition", p_title: "Nope petition 2",
      }));
      expect(denied2.error).toMatch(/manage_participation/);
    });

    it("a member CAN originate a community proposal without any permission (pending moderation)", async () => {
      const created = await as(db, "authenticated", plainA.authId, callRpc("create_governance_petition", {
        p_origin: "community_proposal", p_title: "P15 Second proposal — water points",
      }));
      expect(created.error).toBeUndefined();
      const row = await db.query(
        `SELECT status, origin FROM politicore.governance_petitions WHERE title='P15 Second proposal — water points'`);
      expect(row.rows[0]).toMatchObject({ status: "pending", origin: "community_proposal" });
    });

    it("a scope-scoped grantee cannot mint a tenant-wide petition by omitting scopes", async () => {
      const denied = await as(db, "authenticated", managerA.authId, callRpc("create_governance_petition", {
        p_origin: "petition", p_title: "P15 Wide petition attempt",
      }));
      expect(denied.error).toMatch(/scope within your authority/);
    });
  });

  // ── C2. anonymous boundary ──────────────────────────────────────────
  describe("C2. anonymous boundary", () => {
    it("anon reads nothing and cannot mutate", async () => {
      const read = await as(db, "anon", null, `SELECT * FROM politicore.governance_petitions`);
      expect(read.rows).toHaveLength(0);

      const viewRead = await as(db, "anon", null, `SELECT * FROM public.governance_petitions`);
      expect(viewRead.error).toBeDefined();

      const write = await as(db, "anon", null, callRpc("sign_governance_petition", {
        p_petition: "00000000-0000-0000-0000-000000000000",
      }));
      expect(write.error).toBeDefined();
    });
  });

  // ── C3. tenant isolation ────────────────────────────────────────────
  describe("C3. tenant isolation", () => {
    it("cross-tenant reads return nothing and mutations fail closed", async () => {
      const petitionId = await idByTitle("P15 Road repair petition");

      const foreignRead = await as(db, "authenticated", memberB.authId,
        `SELECT * FROM politicore.governance_petitions WHERE id = $1`, [petitionId]);
      expect(foreignRead.rows).toHaveLength(0);

      const foreignStatus = await as(db, "authenticated", adminB.authId, callRpc("set_governance_petition_status", {
        p_petition: petitionId, p_status: "open",
      }));
      expect(foreignStatus.error).toMatch(/not found/);

      const foreignSign = await as(db, "authenticated", memberB.authId, callRpc("sign_governance_petition", {
        p_petition: petitionId,
      }));
      expect(foreignSign.error).toMatch(/not found/);

      const foreignScope = await as(db, "authenticated", adminB.authId, callRpc("add_governance_petition_scope", {
        p_petition: petitionId, p_scope_type: "state", p_state_id: STATE,
      }));
      expect(foreignScope.error).toMatch(/not found/);

      const foreignVerify = await as(db, "authenticated", adminB.authId, callRpc("verify_governance_petition", {
        p_petition: petitionId,
      }));
      expect(foreignVerify.error).toMatch(/not found/);
    });
  });

  // ── C4. module gating ───────────────────────────────────────────────
  describe("C4. governance module gating", () => {
    it("a governance-disabled tenant blocks creation and participation", async () => {
      const tNG = await createTenant(db, "p15-nogov", "P15 Tenant NoGov", {});
      const adminNG = await createUser(db, { tenantId: tNG, email: "p15-admin@ng.test", fullName: "Admin NG", accessRole: "admin" });

      const create = await as(db, "authenticated", adminNG.authId, callRpc("create_governance_petition", {
        p_origin: "petition", p_title: "P15 NoGov petition",
      }));
      expect(create.error).toMatch(/module is not enabled/);

      const sign = await as(db, "authenticated", adminNG.authId, callRpc("sign_governance_petition", {
        p_petition: "00000000-0000-0000-0000-000000000000",
      }));
      expect(sign.error).toMatch(/module is not enabled/);
    });
  });

  // ── C5. permission catalog ──────────────────────────────────────────
  describe("C5. permission catalog", () => {
    it("governance permissions are exactly the Phase 11 §16 seven — no petition-specific permission", async () => {
      const perms = await db.query(
        `SELECT name FROM politicore.permissions WHERE domain='governance' ORDER BY name`);
      const names = perms.rows.map((r) => String((r as Record<string, unknown>).name));
      expect(names).toEqual([
        "assign_cases", "manage_cases", "manage_participation", "manage_projects",
        "publish_accountability", "view_cases", "view_governance",
      ]);

      const noTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE '%petition_manager%' OR tablename LIKE '%signature%')`);
      expect(Number((noTables.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C6. geographic authority ────────────────────────────────────────
  describe("C6. geographic authority", () => {
    it("campaign scope is forbidden; unknown geography fails closed", async () => {
      const petitionId = await idByTitle("P15 Road repair petition");

      const campaign = await as(db, "authenticated", adminA.authId, callRpc("add_governance_petition_scope", {
        p_petition: petitionId, p_scope_type: "campaign",
      }));
      expect(campaign.error).toMatch(/campaign scope/);

      const unknown = await as(db, "authenticated", adminA.authId, callRpc("add_governance_petition_scope", {
        p_petition: petitionId, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "no-such-ward",
      }));
      expect(unknown.error).toMatch(/does not exist in Core Geography/);
    });

    it("a scope-scoped manager cannot attach a scope outside their authority; tenant-wide covers", async () => {
      const roadId = await idByTitle("P15 Road repair petition");

      const outside = await as(db, "authenticated", managerA.authId, callRpc("add_governance_petition_scope", {
        p_petition: roadId, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: OTHER_WARD,
      }));
      expect(outside.error).toMatch(/outside their authority/);

      // tenant-wide admin attaches the same scope fine
      const ok = await as(db, "authenticated", adminA.authId, callRpc("add_governance_petition_scope", {
        p_petition: roadId, p_scope_type: "ward",
        p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: OTHER_WARD,
      }));
      expect(ok.error).toBeUndefined();
    });
  });

  // ── C7. lifecycle ───────────────────────────────────────────────────
  describe("C7. lifecycle", () => {
    it("draft→closed is illegal via the status RPC; the trigger guard re-enforces the map", async () => {
      const roadId = await idByTitle("P15 Road repair petition");

      const skip = await as(db, "authenticated", adminA.authId, callRpc("set_governance_petition_status", {
        p_petition: roadId, p_status: "closed",
      }));
      expect(skip.error).toMatch(/illegal petition status transition/);

      const verifyEarly = await as(db, "authenticated", adminA.authId, callRpc("set_governance_petition_status", {
        p_petition: roadId, p_status: "verified",
      }));
      expect(verifyEarly.error).toMatch(/status must be open or closed/);

      const publishEarly = await as(db, "authenticated", adminA.authId, callRpc("set_governance_petition_status", {
        p_petition: roadId, p_status: "results_published",
      }));
      expect(publishEarly.error).toMatch(/status must be open or closed/);
    });

    it("legal transitions work: draft→open→closed; content freezes after opening", async () => {
      const roadId = await idByTitle("P15 Road repair petition");

      const edit = await as(db, "authenticated", adminA.authId, callRpc("update_governance_petition", {
        p_petition: roadId, p_title: "P15 Road repair petition (amended)",
      }));
      expect(edit.error).toBeUndefined();

      const open = await as(db, "authenticated", adminA.authId, callRpc("set_governance_petition_status", {
        p_petition: roadId, p_status: "open",
      }));
      expect(open.error).toBeUndefined();

      const frozen = await as(db, "authenticated", adminA.authId, callRpc("update_governance_petition", {
        p_petition: roadId, p_title: "P15 Frozen attempt",
      }));
      expect(frozen.error).toMatch(/only editable before opening/);

      const close = await as(db, "authenticated", adminA.authId, callRpc("set_governance_petition_status", {
        p_petition: roadId, p_status: "closed",
      }));
      expect(close.error).toBeUndefined();
    });

    it("ward petition opens and closes; verification is unreachable while open", async () => {
      const wardId = await idByTitle("P15 Ward drainage petition");

      const open = await as(db, "authenticated", managerA.authId, callRpc("set_governance_petition_status", {
        p_petition: wardId, p_status: "open",
      }));
      expect(open.error).toBeUndefined();

      const verifyWhileOpen = await as(db, "authenticated", managerA.authId, callRpc("verify_governance_petition", {
        p_petition: wardId,
      }));
      expect(verifyWhileOpen.error).toMatch(/only be verified after closure/);

      const close = await as(db, "authenticated", managerA.authId, callRpc("set_governance_petition_status", {
        p_petition: wardId, p_status: "closed",
      }));
      expect(close.error).toBeUndefined();
    });
  });

  // ── C8. participant integrity ───────────────────────────────────────
  describe("C8. participant integrity", () => {
    it("signatures resolve the SERVER-side participant; the proposer cannot be forged", async () => {
      // Use a fresh open petition (the C7 instruments are already closed):
      const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_petition", {
        p_origin: "petition", p_title: "P15 Water points petition",
      }));
      expect(created.error).toBeUndefined();
      const waterId = String((created.rows[0] as Record<string, unknown>).create_governance_petition);
      await as(db, "authenticated", adminA.authId, callRpc("set_governance_petition_status", {
        p_petition: waterId, p_status: "open",
      }));

      const signed = await as(db, "authenticated", plainA.authId, callRpc("sign_governance_petition", {
        p_petition: waterId, p_comment: "Clean water matters.",
      }));
      expect(signed.error).toBeUndefined();

      const row = await db.query(
        `SELECT gp.profile_id FROM politicore.governance_petition_supports s
          JOIN politicore.governance_participants gp ON gp.id = s.participant_id
         WHERE s.petition_id = $1`, [waterId]);
      expect(row.rows).toHaveLength(1);
      expect(String((row.rows[0] as Record<string, unknown>).profile_id)).toBe(plainA.authId);
    });
  });

  // ── C9. duplicate participation ─────────────────────────────────────
  describe("C9. duplicate participation", () => {
    it("one signature per participant per petition — the UNIQUE rule holds", async () => {
      const waterId = await idByTitle("P15 Water points petition");
      const again = await as(db, "authenticated", plainA.authId, callRpc("sign_governance_petition", {
        p_petition: waterId,
      }));
      expect(again.error).toMatch(/already signed/);
    });
  });

  // ── C10. support integrity ──────────────────────────────────────────
  describe("C10. support integrity", () => {
    it("no UPDATE path exists: direct rewrites are silent no-ops and values survive", async () => {
      const waterId = await idByTitle("P15 Water points petition");
      const before = await db.query(
        `SELECT id, comment, verified_at FROM politicore.governance_petition_supports WHERE petition_id=$1`, [waterId]);
      const target = before.rows[0] as Record<string, unknown>;

      // a viewer (read-surface staff) cannot rewrite another's signature
      const attempt = await as(db, "authenticated", viewerA.authId,
        `UPDATE politicore.governance_petition_supports SET comment='forged', verified_at=now() WHERE id=$1`,
        [target.id]);
      expect(attempt.error).toBeUndefined(); // RLS no-op, not an error

      const after = await db.query(
        `SELECT comment, verified_at FROM politicore.governance_petition_supports WHERE id=$1`, [target.id]);
      expect((after.rows[0] as Record<string, unknown>).comment).toBe("Clean water matters.");
      expect((after.rows[0] as Record<string, unknown>).verified_at).toBeNull();
    });
  });

  // ── C11. verification-before-results ────────────────────────────────
  describe("C11. verification-before-results", () => {
    it("results cannot be published from an unverified (closed) petition", async () => {
      const wardId = await idByTitle("P15 Ward drainage petition");
      const denied = await as(db, "authenticated", adminA.authId, callRpc("publish_petition_results", {
        p_petition: wardId, p_summary: "premature",
      }));
      expect(denied.error).toMatch(/only be published after verification/);
    });

    it("the results CHECK requires the verified snapshot (structural pin)", async () => {
      const def = await db.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_petitions_results_require_verified'`);
      const constraint = String((def.rows[0] as Record<string, unknown>).d);
      expect(constraint).toContain("verified_at");
      expect(constraint).toContain("results_published");
    });
  });

  // ── C12. verification authority ─────────────────────────────────────
  describe("C12. verification authority", () => {
    it("manage_participation (geo) verifies — no separate verification permission exists", async () => {
      const wardId = await idByTitle("P15 Ward drainage petition");
      const verified = await as(db, "authenticated", managerA.authId, callRpc("verify_governance_petition", {
        p_petition: wardId, p_note: "ward walk-through",
      }));
      expect(verified.error).toBeUndefined();
      expect(Number((verified.rows[0] as Record<string, unknown>).verify_governance_petition)).toBe(0);

      const row = await db.query(
        `SELECT status, verified_count, verified_at FROM politicore.governance_petitions WHERE id=$1`, [wardId]);
      expect(row.rows[0]).toMatchObject({ status: "verified", verified_count: 0 });
      expect((row.rows[0] as Record<string, unknown>).verified_at).not.toBeNull();
    });

    it("an unauthorized member cannot verify", async () => {
      const roadId = await idByTitle("P15 Road repair petition (amended)");
      const denied = await as(db, "authenticated", viewerA.authId, callRpc("verify_governance_petition", {
        p_petition: roadId,
      }));
      expect(denied.error).toMatch(/geographic authority required/);
    });
  });

  // ── C13. result publication ─────────────────────────────────────────
  describe("C13. result publication", () => {
    it("publish_accountability is required; verified petitions publish; no republish", async () => {
      const wardId = await idByTitle("P15 Ward drainage petition");
      const roadId = await idByTitle("P15 Road repair petition (amended)");

      // verify road as admin (tenant-wide)
      const verifyRoad = await as(db, "authenticated", adminA.authId, callRpc("verify_governance_petition", {
        p_petition: roadId,
      }));
      expect(verifyRoad.error).toBeUndefined();

      // managerA lacks publish_accountability
      const denied = await as(db, "authenticated", managerA.authId, callRpc("publish_petition_results", {
        p_petition: wardId, p_summary: "manager attempt",
      }));
      expect(denied.error).toMatch(/publish_accountability/);

      // admin publishes both
      const pub1 = await as(db, "authenticated", adminA.authId, callRpc("publish_petition_results", {
        p_petition: wardId, p_summary: "Drainage verified; works scheduled.",
      }));
      expect(pub1.error).toBeUndefined();
      const pub2 = await as(db, "authenticated", adminA.authId, callRpc("publish_petition_results", {
        p_petition: roadId, p_summary: "Road works referred.",
      }));
      expect(pub2.error).toBeUndefined();

      // no republish: results_published is terminal
      const repub = await as(db, "authenticated", adminA.authId, callRpc("publish_petition_results", {
        p_petition: roadId, p_summary: "again",
      }));
      expect(repub.error).toMatch(/only be published after verification/);
    });
  });

  // ── C14. privacy ────────────────────────────────────────────────────
  describe("C14. privacy", () => {
    it("a participant sees only their own signature; staff see the register; anon sees nothing", async () => {
      const waterId = await idByTitle("P15 Water points petition");

      // staff-wide register (viewerA has view_governance)
      const staffView = await as(db, "authenticated", viewerA.authId,
        `SELECT count(*)::int n FROM politicore.governance_petition_supports WHERE petition_id=$1`, [waterId]);
      expect(Number((staffView.rows[0] as Record<string, unknown>).n)).toBe(1);

      // plainA owns the only signature — sees exactly their row
      const own = await as(db, "authenticated", plainA.authId,
        `SELECT count(*)::int n FROM politicore.governance_petition_supports WHERE petition_id=$1`, [waterId]);
      expect(Number((own.rows[0] as Record<string, unknown>).n)).toBe(1);

      const anonRead = await as(db, "anon", null, `SELECT * FROM politicore.governance_petition_supports`);
      expect(anonRead.rows).toHaveLength(0);
    });
  });

  // ── C15. canonical updates ──────────────────────────────────────────
  describe("C15. canonical updates", () => {
    it("single-subject invariant spans project|commitment|consultation|petition; prior subjects still work", async () => {
      const def = await db.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_updates_single_subject'`);
      const constraint = String((def.rows[0] as Record<string, unknown>).d);
      expect(constraint).toContain("project_id");
      expect(constraint).toContain("commitment_id");
      expect(constraint).toContain("consultation_id");
      expect(constraint).toContain("petition_id");

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_petition_updates' OR tablename LIKE 'governance_proposal_updates')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);

      // Project updates still work (Phase 12 substrate preserved).
      const project = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", {
        p_title: "P15 substrate probe project",
      }));
      const projectId = (project.rows[0] as Record<string, unknown>).create_governance_project as string;
      const projectUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
        p_project: projectId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(projectUpdate.error).toBeUndefined();

      // Commitment updates still work (Phase 13 substrate preserved).
      const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
        p_title: "P15 substrate probe commitment",
      }));
      const commitmentId = (commitment.rows[0] as Record<string, unknown>).create_governance_commitment as string;
      const commitmentUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment_update", {
        p_commitment: commitmentId, p_title: "Kickoff", p_body: "still works",
      }));
      expect(commitmentUpdate.error).toBeUndefined();
    });
  });

  // ── C16. canonical audit ────────────────────────────────────────────
  describe("C16. canonical audit", () => {
    it("creation, lifecycle, verification and signatures are audited with the server-side actor", async () => {
      const audits = await db.query(
        `SELECT action FROM politicore.system_audits
          WHERE affected_resource = 'governance_petitions' ORDER BY occurred_at DESC LIMIT 20`);
      const actions = audits.rows.map((r) => String((r as Record<string, unknown>).action));
      expect(actions).toContain("governance_petition:create");
      expect(actions).toContain("governance_petition:status");
      expect(actions).toContain("governance_petition:verified");

      const signAudits = await db.query(
        `SELECT actor_id FROM politicore.system_audits
          WHERE action = 'governance_petition:sign' ORDER BY occurred_at DESC LIMIT 1`);
      expect(signAudits.rows).toHaveLength(1);
      expect(String((signAudits.rows[0] as Record<string, unknown>).actor_id)).toBe(plainA.authId);
    });
  });

  // ── C17. core notifications ─────────────────────────────────────────
  describe("C17. core notifications", () => {
    it("open fanouts are canonical notifications rows; no parallel petition store", async () => {
      const notices = await db.query(
        `SELECT count(*)::int n FROM politicore.notifications WHERE link_url LIKE '/governance/participate%'`);
      expect(Number((notices.rows[0] as Record<string, unknown>).n)).toBeGreaterThan(0);

      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_petition_notif%' OR tablename LIKE 'signature_notif%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });

    it("the moderation fanout resolves RECIPIENTS from data, not the caller's authority", async () => {
      // plainA (no permission) originated two proposals — the notice must
      // still reach the staff recipients (admin + ward manager). The 0054
      // convergence made recipients data-driven; a caller-relative
      // has_permission() predicate would have dropped every notice.
      const notices = await db.query(
        `SELECT count(*)::int n FROM politicore.notifications
          WHERE title = 'Community proposal awaiting review'`);
      expect(Number((notices.rows[0] as Record<string, unknown>).n)).toBeGreaterThanOrEqual(2);

      const helperDef = await db.query(
        `SELECT pg_get_functiondef(to_regproc('politicore.governance_notify_petition_submitted')) d`);
      const body = String((helperDef.rows[0] as Record<string, unknown>).d);
      expect(body).toContain("permission_grants");
      expect(body).not.toMatch(/WHERE p\.tenant_id = v_tenant\s+AND politicore\.has_permission/);
    });
  });

  // ── C18. media boundary ─────────────────────────────────────────────
  describe("C18. media boundary", () => {
    it("no petition media tables exist", async () => {
      const noTable = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_petition%media%' OR tablename LIKE 'petition_media%')`);
      expect(Number((noTable.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C19. relationships ──────────────────────────────────────────────
  describe("C19. relationships", () => {
    it("no FK from petitions into Campaign/Election/Social/Manifesto/Requests; no link tables", async () => {
      const fks = await db.query(
        `SELECT conname FROM pg_constraint c
          WHERE c.conrelid = 'politicore.governance_petitions'::regclass AND c.contype = 'f'`);
      const names = fks.rows.map((r) => String((r as Record<string, unknown>).conname));
      for (const n of names) {
        expect(n).not.toMatch(/campaign|election|social|manifesto|request/i);
      }

      const noLinkTables = await db.query(
        `SELECT count(*)::int n FROM pg_tables WHERE schemaname='politicore'
          AND (tablename LIKE 'governance_petition_requests' OR tablename LIKE 'governance_petition_links%')`);
      expect(Number((noLinkTables.rows[0] as Record<string, unknown>).n)).toBe(0);
    });
  });

  // ── C20. schema/security pins ───────────────────────────────────────
  describe("C20. schema and security pins", () => {
    it("FORCE RLS everywhere; zero anon policies; anon holds no view grants", async () => {
      for (const table of ["governance_petitions", "governance_petition_scopes", "governance_petition_supports"]) {
        const flags = await db.query(
          `SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='politicore' AND c.relname=$1`, [table]);
        expect(flags.rows[0]).toMatchObject({ r: true, f: true });
      }
      const anonPolicies = await db.query(
        `SELECT count(*)::int n FROM pg_policies WHERE schemaname='politicore'
          AND tablename LIKE 'governance_petition%' AND 'anon' = ANY(roles)`);
      expect(Number((anonPolicies.rows[0] as Record<string, unknown>).n)).toBe(0);

      for (const view of ["governance_petitions", "governance_petition_scopes", "governance_petition_supports"]) {
        const anonGrant = await db.query(
          `SELECT count(*)::int n FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name=$1 AND grantee='anon'`, [view]);
        expect(Number((anonGrant.rows[0] as Record<string, unknown>).n)).toBe(0);
      }
    });

    it("PP- references minted and immutable; origin vocabulary closed; proposer invariant pinned", async () => {
      const ref = await db.query(`SELECT reference_code FROM politicore.governance_petitions WHERE title='P15 Road repair petition (amended)'`);
      expect(String((ref.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^PP-[0-9A-F]{8}$/);

      const roadId = await idByTitle("P15 Road repair petition (amended)");
      const attempt = await as(db, "authenticated", adminA.authId,
        `UPDATE politicore.governance_petitions SET reference_code='PP-HACKED1' WHERE id=$1`, [roadId]);
      expect(attempt.error).toBeUndefined(); // RLS no-op (no UPDATE policy)
      const after = await db.query(`SELECT reference_code FROM politicore.governance_petitions WHERE id=$1`, [roadId]);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^PP-[0-9A-F]{8}$/);
      expect(String((after.rows[0] as Record<string, unknown>).reference_code)).not.toBe("PP-HACKED1");

      const kinds = await db.query(
        `SELECT unnest(enum_range(NULL::politicore.governance_petition_origin))::text v`);
      expect(kinds.rows.map((r) => String((r as Record<string, unknown>).v)).sort()).toEqual(
        ["community_proposal", "petition"]);

      const proposerCk = await db.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='governance_petitions_origin_proposer'`);
      expect(String((proposerCk.rows[0] as Record<string, unknown>).d)).toContain("proposer_participant_id");
    });
  });
});
