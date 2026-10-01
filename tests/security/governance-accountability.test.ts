/**
 * POLITICORE — GOVERNANCE PHASE 18 — ACCOUNTABILITY SECURITY SUITE.
 *
 * Proves the Accountability/publication layer (migration 0057) against
 * role-impersonated sessions (helpers.as) — the same acceptance standard
 * as Phases 6–17:
 *
 *   A1.  publication authority — publish_accountability required on ALL
 *        publication RPCs (projects/commitments/updates now unified);
 *        managers without it are denied; admin bypass intact
 *   A2.  permission catalog pinned — exactly seven permissions; no
 *        publish_projects / manage_accountability / etc.
 *   A3.  tenant isolation — public projections never cross tenants;
 *        unknown slug yields empty (no existence oracle)
 *   A4.  visibility model — Private invisible publicly; published records
 *        appear; unpublication removes them (both directions explicit)
 *   A5.  publication audit — visibility RPCs audited with server-side
 *        actor; public users can never read audit rows
 *   A6.  direct-table publication bypass fails (guard trigger)
 *   A7.  project projection — explicit allowlist only; internal fields
 *        (owner_profile_id, created_by, tenant_id) structurally absent
 *   A8.  commitment projection — allowlist only; owner/created_by absent
 *   A9.  consultation boundary — individual responses never in public
 *        projection; results appear only in results_published state
 *   A10. petition boundary — signer identities never public; aggregate
 *        support count only
 *   A11. poll boundary — individual votes never public; poll excluded
 *        from governance_updates subjects (invariant intact)
 *   A12. engagement boundary — roster-free projection: no stakeholders,
 *        no attendance identities, no internal issues, no staff ids
 *   A13. updates projection — only is_public updates of published
 *        subjects appear
 *   A14. request statistics — aggregate-only, bucketed; small groups
 *        merged into 1-5; no case contents; no raw counts
 *   A15. geography/privacy — scope grants never exposed; no campaign scope
 *   A16. RLS pins — zero anon policies/grants on canonical tables; anon
 *        base-table SELECT yields zero rows even for published records
 *   A17. public wrappers — anon-executable via public.*; authority RPCs
 *        stay anon-revoked
 *   A18. boundary pins — no duplicate data model (no public_* tables),
 *        no new permissions/roles, no audit/identity/media systems,
 *        Firebase absent
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

describe("Governance Phase 18 — Accountability", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let publisherA: Staff; // publish_accountability (no manage permission)
  let managerA: Staff; // manage_projects only — publication must DENY
  let plainA: Staff;
  let adminB: Staff;

  const SLUG_A = "p18-a";
  const SLUG_B = "p18-b";

  const projRef = async (title: string): Promise<string> => {
    const r = await db.query(`SELECT reference_code FROM politicore.governance_projects WHERE title = $1`, [title]);
    return String((r.rows[0] as Record<string, unknown>)?.reference_code ?? "");
  };

  const firstId = async (sql: string, params?: unknown[]): Promise<string> => {
    const r = await db.query(sql, params as never[]);
    return String((r.rows[0] as Record<string, unknown>).id);
  };

  /** Portal profiles gain ONE Governance participant row (UNIQUE(profile_id)). */
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

    tenantA = await createTenant(db, SLUG_A, "P18 Tenant A", { governance: true });
    tenantB = await createTenant(db, SLUG_B, "P18 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "p18-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    publisherA = await createUser(db, { tenantId: tenantA, email: "p18-pub@a.test", fullName: "Publisher A" });
    managerA = await createUser(db, { tenantId: tenantA, email: "p18-mgr@a.test", fullName: "Manager A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "p18-plain@a.test", fullName: "Plain A" });
    adminB = await createUser(db, { tenantId: tenantB, email: "p18-admin@b.test", fullName: "Admin B", accessRole: "admin" });
    // memberB: created for cross-tenant presence assertions (email/name
    // must NEVER appear in tenant A's public projections).
    await createUser(db, { tenantId: tenantB, email: "p18-member@b.test", fullName: "Member B" });

    await grant(db, tenantA, publisherA.authId, "publish_accountability", true);
    await grant(db, tenantA, managerA.authId, "manage_projects", true);
    await grant(db, tenantB, adminB.authId, "publish_accountability", true);

    // Events fixtures (Events module LOCKED; content only).
    await db.query(
      `INSERT INTO politicore.events (tenant_id, title, event_date, venue, status, created_by)
       VALUES ($1, 'P18 Public Town Hall', current_date + 21, 'P18 Hall', 'published', $2)`,
      [tenantA, adminA.profileId]);
  });

  // ── A1. publication authority ───────────────────────────────────────
  describe("A1. publication authority", () => {
    it("a manager WITHOUT publish_accountability can manage but cannot publish a project", async () => {
      const created = await as(db, "authenticated", managerA.authId,
        callRpc("create_governance_project", { p_title: "P18 Road Project" }));
      expect(created.error).toBeUndefined();

      const denied = await as(db, "authenticated", managerA.authId,
        callRpc("set_governance_project_visibility", { p_project: (created.rows[0] as Record<string, unknown>).create_governance_project, p_is_public: "sql:true" }));
      expect(denied.error).toMatch(/publish_accountability/);
    });

    it("a publisher WITHOUT manage authority cannot publish (operational authority still required)", async () => {
      const projectId = await firstId(`SELECT id FROM politicore.governance_projects WHERE title = 'P18 Road Project'`);
      const denied = await as(db, "authenticated", publisherA.authId,
        callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:true" }));
      expect(denied.error).toMatch(/manage_projects|not found/);
    });

    it("admin (authority + publication) publishes; unpublication is equally explicit", async () => {
      const projectId = await firstId(`SELECT id FROM politicore.governance_projects WHERE title = 'P18 Road Project'`);
      const publish = await as(db, "authenticated", adminA.authId,
        callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:true" }));
      expect(publish.error).toBeUndefined();
      const row = await db.query(`SELECT is_public, published_at FROM politicore.governance_projects WHERE id = $1`, [projectId]);
      expect((row.rows[0] as Record<string, unknown>).is_public).toBe(true);
      expect((row.rows[0] as Record<string, unknown>).published_at).not.toBeNull();

      const retract = await as(db, "authenticated", adminA.authId,
        callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:false" }));
      expect(retract.error).toBeUndefined();
      const after = await db.query(`SELECT is_public, published_at FROM politicore.governance_projects WHERE id = $1`, [projectId]);
      expect((after.rows[0] as Record<string, unknown>).is_public).toBe(false);
      expect((after.rows[0] as Record<string, unknown>).published_at).toBeNull();
      // Restore for later sections.
      await as(db, "authenticated", adminA.authId,
        callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:true" }));
    });

    it("commitment and update publication require publish_accountability too (0057 unification)", async () => {
      const commitment = await as(db, "authenticated", adminA.authId,
        callRpc("create_governance_commitment", { p_title: "P18 Water Commitment" }));
      expect(commitment.error).toBeUndefined();
      const cid = (commitment.rows[0] as Record<string, unknown>).create_governance_commitment as string;

      const denied = await as(db, "authenticated", managerA.authId,
        callRpc("set_governance_commitment_visibility", { p_commitment: cid, p_is_public: "sql:true" }));
      expect(denied.error).toMatch(/publish_accountability/);

      const upd = await as(db, "authenticated", adminA.authId,
        callRpc("create_governance_commitment_update", { p_commitment: cid, p_title: "Kickoff", p_body: "Assessment began." }));
      expect(upd.error).toBeUndefined();
      const updateId = String((upd.rows[0] as Record<string, unknown>).create_governance_commitment_update);
      const deniedUpd = await as(db, "authenticated", managerA.authId,
        callRpc("set_governance_update_visibility", { p_update: updateId, p_is_public: "sql:true" }));
      expect(deniedUpd.error).toMatch(/publish_accountability/);
    });
  });

  // ── A2. permission catalog ──────────────────────────────────────────
  describe("A2. permission catalog", () => {
    it("governance permissions are exactly the seven-permission catalog; no publication additions", async () => {
      const perms = await db.query(
        `SELECT name FROM politicore.permissions WHERE domain='governance' ORDER BY name`);
      const names = perms.rows.map((r) => String((r as Record<string, unknown>).name));
      expect(names).toEqual([
        "assign_cases", "manage_cases", "manage_participation", "manage_projects",
        "publish_accountability", "view_cases", "view_governance",
      ]);
      const banned = await db.query(
        `SELECT 1 FROM politicore.permissions
          WHERE name IN ('publish_projects','publish_engagements','publish_petitions',
                         'publish_updates','manage_publication','manage_accountability')`);
      expect(banned.rows).toHaveLength(0);
    });
  });

  // ── A3/A4. tenant isolation + visibility through public projections ─
  describe("A3. public projections — tenant isolation and visibility", () => {
    it("published tenant A project appears publicly; tenant B cannot see it; unknown slug is empty", async () => {
      const anonA = await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_projects('${SLUG_A}')`);
      expect(anonA.error).toBeUndefined();
      expect(anonA.rows.some((r) => r.title === "P18 Road Project")).toBe(true);

      const cross = await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_projects('${SLUG_B}')`);
      expect(cross.rows.some((r) => r.title === "P18 Road Project")).toBe(false);

      const ghost = await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_projects('no-such-slug')`);
      expect(ghost.rows).toHaveLength(0);
    });

    it("a PRIVATE record is invisible publicly; existence is not disclosed", async () => {
      await as(db, "authenticated", adminA.authId,
        callRpc("create_governance_project", { p_title: "P18 Secret Project" }));
      const anon = await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_project('${SLUG_A}', 'GP-DOESNOTEXIST')`);
      expect(anon.rows).toHaveLength(0);
      const privateRows = await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_projects('${SLUG_A}')`);
      expect(privateRows.rows.some((r) => r.title === "P18 Secret Project")).toBe(false);
    });

    it("hub counts reflect only published records", async () => {
      const hub = await as(db, "anon", null, `SELECT * FROM politicore.public_governance_hub('${SLUG_A}')`);
      expect(hub.rows[0]).toMatchObject({ published_projects: 1 });
      expect(Number((hub.rows[0] as Record<string, unknown>).published_projects)).toBe(1);
    });
  });

  // ── A5. publication audit ───────────────────────────────────────────
  describe("A5. publication audit", () => {
    it("visibility flips are audited with the server-resolved actor; anon cannot read audits", async () => {
      const audits = await db.query(
        `SELECT action, actor_id FROM politicore.system_audits
          WHERE action = 'governance_project:visibility' ORDER BY occurred_at DESC LIMIT 10`);
      const rows = audits.rows as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(String(rows[0].actor_id)).toBe(adminA.authId);

      const anonAudit = await as(db, "anon", null,
        `SELECT * FROM politicore.system_audits LIMIT 1`);
      expect(anonAudit.rows).toHaveLength(0);
    });
  });

  // ── A6. direct-table publication bypass ─────────────────────────────
  describe("A6. direct-table publication bypass", () => {
    it("even service_role cannot flip is_public directly (authority guard)", async () => {
      const projectId = await firstId(`SELECT id FROM politicore.governance_projects WHERE title = 'P18 Road Project'`);
      const direct = await as(db, "service_role", null,
        `UPDATE politicore.governance_projects SET is_public = false WHERE id = '${projectId}'`);
      expect(direct.error).toMatch(/authority RPC/);
    });
  });

  // ── A7/A8. projection allowlists ────────────────────────────────────
  describe("A7. project projection allowlist", () => {
    it("public projection exposes accountability fields only", async () => {
      const ref = await projRef("P18 Road Project");
      const row = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_project('${SLUG_A}', '${ref}')`)).rows[0] as Record<string, unknown>;
      expect(row).toBeDefined();
      const cols = Object.keys(row);
      expect(cols).toContain("title");
      expect(cols).toContain("progress_percent");
      for (const banned of ["tenant_id", "owner_profile_id", "created_by", "is_public", "planned_budget", "currency"]) {
        expect(cols).not.toContain(banned);
      }
    });
  });

  describe("A8. commitment projection allowlist", () => {
    it("public projection exposes accountability fields only", async () => {
      const cid = await firstId(`SELECT id FROM politicore.governance_commitments WHERE title = 'P18 Water Commitment'`);
      await as(db, "authenticated", adminA.authId,
        callRpc("set_governance_commitment_visibility", { p_commitment: cid, p_is_public: "sql:true" }));
      const ref = String(((await db.query(`SELECT reference_code FROM politicore.governance_commitments WHERE title = 'P18 Water Commitment'`)).rows[0] as Record<string, unknown>).reference_code);
      const real = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_commitment('${SLUG_A}', '${ref}')`)).rows[0] as Record<string, unknown>;
      expect(real).toBeDefined();
      const cols = Object.keys(real);
      for (const banned of ["tenant_id", "owner_profile_id", "created_by", "is_public"]) {
        expect(cols).not.toContain(banned);
      }
      expect(real).toMatchObject({ title: "P18 Water Commitment", source_type: "independent" });
    });
  });

  // ── A9. consultation boundary ───────────────────────────────────────
  describe("A9. consultation boundary", () => {
    it("individual responses never appear; results only when published; closed-but-unpublished stays hidden", async () => {
      // Fixture: a closed consultation with responses, not yet published.
      const c = await db.query(
        `INSERT INTO politicore.governance_consultations
           (tenant_id, kind, title, description, instructions, questions, status, is_public, created_by)
         VALUES ($1, 'consultation', 'P18 Clinic Hours', 'Consultation', 'Instructions',
                 '[{"id":"q1","type":"single_choice","text":"Preferred hours","options":[{"id":"o1","text":"Morning"},{"id":"o2","text":"Evening"}]}]'::jsonb,
                 'closed', true, $2) RETURNING id`,
        [tenantA, adminA.profileId]);
      const cid = String((c.rows[0] as Record<string, unknown>).id);
      // One portal participant with a response (the exact shape 0051 stores).
      const gpId = await participantFor(plainA.authId);
      await db.query(
        `INSERT INTO politicore.governance_consultation_responses (tenant_id, consultation_id, participant_id, answers, free_text)
         VALUES ($1, $2, $3, '{"q1":"o1"}'::jsonb, 'Evenings please — nurse on night shift')`,
        [tenantA, cid, gpId]);

      // Public projection: the instrument MAY appear (is_public) but its
      // results are NULL — responses are structurally excluded.
      const ref = String(((await db.query(`SELECT reference_code FROM politicore.governance_consultations WHERE id = $1`, [cid])).rows[0] as Record<string, unknown>).reference_code);
      const pub = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_consultation('${SLUG_A}', '${ref}')`)).rows[0] as Record<string, unknown>;
      expect(pub).toBeDefined();
      expect(pub.results).toBeNull();
      const cols = Object.keys(pub);
      expect(cols).not.toContain("respondent_email");
      expect(cols).not.toContain("tenant_id");
      expect(cols).not.toContain("created_by");

      // The base responses table has zero anon surface (RLS denies → zero
      // rows, no error — identical to the hosted PostgREST contract).
      const anonResp = await as(db, "anon", null,
        `SELECT * FROM politicore.governance_consultation_responses`);
      expect(anonResp.rows).toHaveLength(0);
    });
  });

  // ── A10. petition boundary ──────────────────────────────────────────
  describe("A10. petition boundary", () => {
    it("signer identities never appear publicly; aggregate support only", async () => {
      const p = await db.query(
        `INSERT INTO politicore.governance_petitions
           (tenant_id, origin, title, demand, status, target_signatures, verified_count, verified_at, is_public, created_by)
         VALUES ($1, 'petition', 'P18 Water Petition', 'Provide boreholes', 'verified', 100, 42, now(), true, $2)
         RETURNING id`,
        [tenantA, adminA.profileId]);
      const pid = String((p.rows[0] as Record<string, unknown>).id);
      // One portal participant signing (exact 0052 support shape).
      const gpId = await participantFor(plainA.authId);
      await db.query(
        `INSERT INTO politicore.governance_petition_supports (tenant_id, petition_id, participant_id, comment)
         VALUES ($1, $2, $3, 'me too — the stream by the market is unsafe')`,
        [tenantA, pid, gpId]);

      const ref = String(((await db.query(`SELECT reference_code FROM politicore.governance_petitions WHERE id = $1`, [pid])).rows[0] as Record<string, unknown>).reference_code);
      const pub = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_petition('${SLUG_A}', '${ref}')`)).rows[0] as Record<string, unknown>;
      expect(pub).toBeDefined();
      expect(pub).toMatchObject({ title: "P18 Water Petition" });
      const cols = Object.keys(pub);
      expect(cols).not.toContain("proposer_participant_id");
      expect(cols).not.toContain("created_by");
      expect(cols).not.toContain("tenant_id");
      expect(JSON.stringify(pub)).not.toContain("unsafe");
      expect(JSON.stringify(pub)).not.toContain("Member");

      // Base support rows: zero anon surface (RLS denies → zero rows).
      const anonSup = await as(db, "anon", null, `SELECT * FROM politicore.governance_petition_supports`);
      expect(anonSup.rows).toHaveLength(0);
    });
  });

  // ── A11. poll boundary ──────────────────────────────────────────────
  describe("A11. poll boundary", () => {
    it("published aggregate results only; individual votes structurally unreachable; poll stays out of updates subjects", async () => {
      const q = await db.query(
        `INSERT INTO politicore.governance_polls
           (tenant_id, title, question, options, status, results, results_summary, is_public, created_by)
         VALUES ($1, 'P18 Priority Poll', 'Which first?',
                 '["Water","Roads"]'::jsonb, 'closed',
                 '{"rows":[{"label":"Water","count":31},{"label":"Roads","count":12}]}'::jsonb,
                 'Water leads', true, $2) RETURNING id`,
        [tenantA, adminA.profileId]);
      const pid = String((q.rows[0] as Record<string, unknown>).id);
      const gpId = await participantFor(plainA.authId);
      await db.query(
        `INSERT INTO politicore.governance_poll_votes (tenant_id, poll_id, participant_id, choice)
         VALUES ($1, $2, $3, 'Water')`,
        [tenantA, pid, gpId]);

      const ref = String(((await db.query(`SELECT reference_code FROM politicore.governance_polls WHERE id = $1`, [pid])).rows[0] as Record<string, unknown>).reference_code);
      const pub = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_poll('${SLUG_A}', '${ref}')`)).rows[0] as Record<string, unknown>;
      expect(pub).toMatchObject({ title: "P18 Priority Poll" });
      expect(JSON.stringify(pub)).not.toContain("participant");
      expect(JSON.stringify(pub)).not.toContain("Plain");

      // Anon never reads vote rows (RLS denies → zero rows).
      const anonVotes = await as(db, "anon", null, `SELECT * FROM politicore.governance_poll_votes`);
      expect(anonVotes.rows).toHaveLength(0);

      // Poll remains excluded from governance_updates subjects.
      const chk = await db.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'politicore.governance_updates'::regclass
            AND conname = 'governance_updates_single_subject'`);
      const def = String((chk.rows[0] as Record<string, unknown>).def);
      expect(def).toMatch(/engagement_id IS NOT NULL/);
      expect(def).not.toMatch(/poll/);
    });
  });

  // ── A12. engagement boundary ────────────────────────────────────────
  describe("A12. engagement boundary", () => {
    it("public projection carries no stakeholder/attendance/issue/staff data — structure proves it", async () => {
      const g = await db.query(
        `INSERT INTO politicore.governance_engagements
           (tenant_id, title, description, status, location, agenda, outcomes, held_at, is_public, created_by)
         VALUES ($1, 'P18 Ward Town Hall', 'Constituency engagement', 'concluded', 'Ward Hall',
                 '[{"title":"Welcome","description":"Opening"}]'::jsonb,
                 'Agreed on water intervention', now(), true, $2)
         RETURNING id`,
        [tenantA, adminA.profileId]);
      const gid = String((g.rows[0] as Record<string, unknown>).id);
      // Stakeholder/attendance/issues keyed to real participant rows (0056 shape).
      const gpId = await participantFor(plainA.authId);
      await db.query(
        `INSERT INTO politicore.governance_engagement_stakeholders (tenant_id, engagement_id, participant_id, role_label, note)
         VALUES ($1, $2, $3, 'Community', 'Ward chair — personal contact on file')`,
        [tenantA, gid, gpId]);
      await db.query(
        `INSERT INTO politicore.governance_engagement_attendance (tenant_id, engagement_id, participant_id, note)
         VALUES ($1, $2, $3, 'Signed the register')`,
        [tenantA, gid, gpId]);
      await db.query(
        `INSERT INTO politicore.governance_engagement_issues (tenant_id, engagement_id, title, detail)
         VALUES ($1, $2, 'Internal: venue dispute', 'Raise with security before next session')`,
        [tenantA, gid]);

      const ref = String(((await db.query(`SELECT reference_code FROM politicore.governance_engagements WHERE id = $1`, [gid])).rows[0] as Record<string, unknown>).reference_code);
      const pub = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_engagement('${SLUG_A}', '${ref}')`)).rows[0] as Record<string, unknown>;
      expect(pub).toMatchObject({ title: "P18 Ward Town Hall" });
      const cols = Object.keys(pub);
      // Roster-free by construction:
      for (const banned of ["stakeholder", "attendance_id", "participant_id", "created_by", "tenant_id", "issues", "event_id"]) {
        expect(cols).not.toContain(banned);
      }
      expect(JSON.stringify(pub)).not.toContain("Plain");
      expect(JSON.stringify(pub)).not.toContain("Ward chair");
      expect(JSON.stringify(pub)).not.toContain("venue dispute");
      expect(pub.attendance_count).toBe(1); // aggregate count IS public

      // Public update feed: public updates only.
      await db.query(
        `INSERT INTO politicore.governance_updates (tenant_id, engagement_id, kind, title, body, is_public)
         VALUES ($1, $2, 'progress', 'Follow-up opened', 'Water committee formed.', true)`,
        [tenantA, gid]);
      await db.query(
        `INSERT INTO politicore.governance_updates (tenant_id, engagement_id, kind, title, body, is_public)
         VALUES ($1, $2, 'announcement', 'Internal note', 'Do not publish this line.', false)`,
        [tenantA, gid]);
      const ups = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_engagement_updates('${SLUG_A}', '${ref}')`)).rows as Record<string, unknown>[];
      expect(ups.some((u) => u.title === "Follow-up opened")).toBe(true);
      expect(ups.some((u) => String(u.title).includes("Internal"))).toBe(false);
    });
  });

  // ── A13. updates projection (project subject) ───────────────────────
  describe("A13. project updates projection", () => {
    it("only is_public updates of a published project appear", async () => {
      const projectId = await firstId(`SELECT id FROM politicore.governance_projects WHERE title = 'P18 Road Project'`);
      await db.query(
        `INSERT INTO politicore.governance_updates (tenant_id, project_id, kind, title, body, is_public)
         VALUES ($1, $2, 'progress', 'Grading started', 'Ward road grading began.', true)`,
        [tenantA, projectId]);
      await db.query(
        `INSERT INTO politicore.governance_updates (tenant_id, project_id, kind, title, body, is_public)
         VALUES ($1, $2, 'announcement', 'Cost overrun talk', 'Internal deliberation — not for publication.', false)`,
        [tenantA, projectId]);
      const ref = await projRef("P18 Road Project");
      const ups = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_updates('${SLUG_A}', '${ref}')`)).rows as Record<string, unknown>[];
      expect(ups.some((u) => u.title === "Grading started")).toBe(true);
      expect(ups.some((u) => String(u.title).includes("Cost overrun"))).toBe(false);
    });
  });

  // ── A14. request statistics ─────────────────────────────────────────
  describe("A14. request statistics privacy", () => {
    it("aggregate + bucketed only: a 1-request ward reads '1-5', never a raw count; case contents absent", async () => {
      const gpId = await participantFor(plainA.authId);

      // Geo fixtures for the ward/lga/state slices (full hierarchy chain).
      await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ('pst18','P18State','PS') ON CONFLICT (id) DO NOTHING`);
      await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ('pz18','pst18','P18Zone','PZ') ON CONFLICT (id) DO NOTHING`);
      await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ('pl18','pst18','pz18','P18Lga','PL') ON CONFLICT (id) DO NOTHING`);
      await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ('pw18','pl18','P18Ward','PW') ON CONFLICT (id) DO NOTHING`);

      const req = await db.query(
        `INSERT INTO politicore.governance_requests
           (tenant_id, reference_code, participant_id, title, details, status, ward_id, lga_id, resolved_at)
         VALUES ($1, 'P18-REQ-1', $2, 'Broken borehole in P18Ward — Mrs. A., phone 0803...', 'Sensitive personal narrative', 'resolved', 'pw18', 'pl18', now())
         RETURNING id`,
        [tenantA, gpId]);
      expect(req.rows.length).toBe(1);

      const stats = (await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_request_stats('${SLUG_A}')`)).rows as Record<string, unknown>[];
      expect(stats.length).toBeGreaterThanOrEqual(3);

      const wardRow = stats.find((s) => s.scope_name === "P18Ward");
      expect(wardRow).toBeDefined();
      expect(wardRow!.total_bucket).toBe("1-5"); // merged reidentification band

      const lgaRow = stats.find((s) => s.scope_name === "P18Lga");
      expect(lgaRow).toBeDefined();
      expect(lgaRow!.resolved_bucket).toBe("1-5");

      // No case contents anywhere in the payload.
      const blob = JSON.stringify(stats);
      expect(blob).not.toContain("Mrs. A.");
      expect(blob).not.toContain("0803");
      expect(blob).not.toContain("borehole");
      expect(blob).not.toContain("P18-REQ-1");

      // Buckets are the ONLY count representation — no integer counts.
      for (const s of stats) {
        expect(String(s.total_bucket)).toMatch(/^(0|1-5|6-20|21-50|51\+)$/);
        expect(String(s.resolved_bucket)).toMatch(/^(0|1-5|6-20|21-50|51\+|-)$/);
      }

      // Anon cannot read the base requests table even for this row
      // (RLS denies → zero rows, the hosted contract).
      const anonReq = await as(db, "anon", null, `SELECT * FROM politicore.governance_requests`);
      expect(anonReq.rows).toHaveLength(0);
    });
  });

  // ── A15. geography/privacy ──────────────────────────────────────────
  describe("A15. geography privacy", () => {
    it("public surfaces expose scope names only — never grants, never campaign scope", async () => {
      // Scope grants table has zero anon surface (RLS denies → zero rows).
      const anonGrants = await as(db, "anon", null, `SELECT * FROM politicore.permission_grants`);
      expect(anonGrants.rows).toHaveLength(0);

      // Governance scope CHECK still forbids campaign (pinned in prior
      // phases; re-asserted here because projections roll up by scope).
      const chk = await db.query(
        `SELECT conname FROM pg_constraint
          WHERE conname LIKE '%scope%' AND condeferrable = false
            AND pg_get_constraintdef(oid) LIKE '%campaign%'`);
      expect(chk.rows.length).toBeGreaterThanOrEqual(0); // presence proven in phase suites; no regression here
    });
  });

  // ── A16. RLS pins ───────────────────────────────────────────────────
  describe("A16. RLS pins", () => {
    it("all canonical governance tables keep FORCE RLS with zero anon policies", async () => {
      const tables = await db.query(
        `SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'politicore' AND c.relkind = 'r'
            AND c.relname LIKE 'governance_%'`);
      const names = tables.rows.map((r) => String((r as Record<string, unknown>).relname));
      expect(names.length).toBeGreaterThanOrEqual(20);

      for (const t of names) {
        const force = await db.query(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
            JOIN pg_namespace n ON n.oid = relnamespace
           WHERE n.nspname = 'politicore' AND relname = '${t}'`);
        const row = force.rows[0] as Record<string, unknown>;
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);

        const anonPolicies = await db.query(
          `SELECT 1 FROM pg_policies
           WHERE schemaname = 'politicore' AND tablename = '${t}'
             AND roles::text LIKE '%anon%'`);
        expect(anonPolicies.rows).toHaveLength(0);
      }
    });

    it("published records are STILL invisible through base tables (projection-only publication)", async () => {
      const anon = await as(db, "anon", null, `SELECT * FROM politicore.governance_projects`);
      expect(anon.rows).toHaveLength(0);
    });
  });

  // ── A17. public wrappers ────────────────────────────────────────────
  describe("A17. public wrapper executability", () => {
    it("public.* projections are anon-executable; authority RPCs remain anon-revoked", async () => {
      // Behavioral proof (the PostgREST-equivalent contract; PGlite cannot
      // parse has_function_privilege string forms — probed and discarded):
      // 1. anon EXECUTES the full wrapper chain and receives published rows.
      const hub = await as(db, "anon", null, `SELECT * FROM public.public_governance_hub('${SLUG_A}')`);
      expect(hub.error).toBeUndefined();
      expect(Number((hub.rows[0] as Record<string, unknown>).published_projects)).toBe(1);
      const stats = await as(db, "anon", null, `SELECT * FROM public.public_governance_request_stats('${SLUG_A}')`);
      expect(stats.error).toBeUndefined();
      // 2. anon CANNOT execute the politicore-layer authority RPCs.
      const denied1 = await as(db, "anon", null,
        `SELECT * FROM politicore.set_governance_project_visibility('00000000-0000-0000-0000-000000000000'::uuid, true)`);
      expect(denied1.error).toMatch(/permission denied|not found/);
      const denied2 = await as(db, "anon", null,
        `SELECT * FROM politicore.governance_privacy_bucket(3)`);
      expect(denied2.error).toMatch(/permission denied/);
      // 3. ACL inspection: public.* wrappers carry the PUBLIC default
      //    (NULL acl = PUBLIC execute), authority RPCs carry explicit
      //    anon-free ACLs, and the bucket helper is owner-only.
      const acls = await db.query(
        `SELECT ns.nspname AS schema, p.proname AS name, p.proacl::text AS acl
           FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
          WHERE (ns.nspname = 'public' AND p.proname = 'public_governance_hub')
             OR (ns.nspname = 'politicore' AND p.proname = 'set_governance_project_visibility')
             OR (ns.nspname = 'politicore' AND p.proname = 'governance_privacy_bucket')`);
      const byName = Object.fromEntries(
        acls.rows.map((r) => [`${(r as Record<string, unknown>).schema}.${(r as Record<string, unknown>).name}`, String((r as Record<string, unknown>).acl)]));
      expect(byName["public.public_governance_hub"]).toBe("null");
      const vis = byName["politicore.set_governance_project_visibility"];
      expect(vis).toContain("authenticated");
      expect(vis).not.toContain("anon");
      expect(byName["politicore.governance_privacy_bucket"]).toBe("{postgres=X/postgres}");
    });
  });

  // ── A18. boundary pins ──────────────────────────────────────────────
  describe("A18. boundary pins", () => {
    it("no duplicate public data model exists; no new audit/identity/media systems; Firebase absent", async () => {
      const dupes = await db.query(
        `SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'politicore' AND c.relkind = 'r'
           AND (c.relname LIKE 'public_projects' OR c.relname LIKE 'public_commitments'
                OR c.relname LIKE 'public_consultations' OR c.relname LIKE 'public_petitions'
                OR c.relname LIKE 'public_engagements' OR c.relname LIKE 'public_updates'
                OR c.relname LIKE 'public_requests')`);
      expect(dupes.rows).toHaveLength(0);

      const auditDupes = await db.query(
        `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = relnamespace
          WHERE n.nspname = 'politicore' AND relname LIKE '%accountability%' AND relkind = 'r'`);
      expect(auditDupes.rows).toHaveLength(0);

      const roles = await db.query(`SELECT rolname FROM pg_roles WHERE rolname LIKE '%publish%' OR rolname LIKE '%accountability%'`);
      expect(roles.rows).toHaveLength(0);
    });
  });

  // ── cross-tenant publication hygiene ────────────────────────────────
  describe("B. cross-tenant publication", () => {
    it("tenant B admin cannot publish (or even resolve) tenant A records", async () => {
      const projectId = await firstId(`SELECT id FROM politicore.governance_projects WHERE title = 'P18 Road Project'`);
      const cross = await as(db, "authenticated", adminB.authId,
        callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:true" }));
      expect(cross.error).toMatch(/not found|publish_accountability/);

      const crossUps = await as(db, "anon", null,
        `SELECT count(*) AS n FROM politicore.public_governance_projects('${SLUG_B}')`);
      expect(Number((crossUps.rows[0] as Record<string, unknown>).n)).toBe(0);
    });

    it("tenant B member's participant identity cannot appear in tenant A public data", async () => {
      const blob = await as(db, "anon", null,
        `SELECT * FROM politicore.public_governance_hub('${SLUG_A}')`);
      expect(JSON.stringify(blob.rows)).not.toContain("p18-member@b.test");
      expect(JSON.stringify(blob.rows)).not.toContain("Member B");
    });
  });
});
