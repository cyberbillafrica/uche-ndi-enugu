/**
 * POLITICORE — GOVERNANCE PHASE 12 — PROJECTS SECURITY SUITE.
 *
 * Proves the Projects slice (migration 0043 + 0044 restatement) against
 * role-impersonated sessions (helpers.as) — the same acceptance standard
 * as Phases 6–11:
 *
 *   A. Tenant isolation       — cross-tenant read/mutation fails closed
 *   B. Module isolation       — governance OFF blocks; Campaign/Election
 *                               state is irrelevant to Projects
 *   C. Permission             — manage_projects required; no new role
 *   D. Geography              — multi-scope any-of authority; descendant
 *                               coverage via Core hierarchy; campaign
 *                               scope forbidden
 *   E. Milestones             — ownership, authority, derived progress
 *   F. Updates                — canonical substrate, single-subject rule,
 *                               no project_updates table
 *   G. Visibility             — private by default; staff-only base reads;
 *                               is_public does not leak to anon; guard
 *                               blocks direct-table visibility writes
 *   H. Media                  — evidence must be a same-tenant asset
 *   I. Audit                  — canonical system_audits rows, actor+tenant
 *   J. Deletion               — no app-role DELETE path (institutional
 *                               memory)
 *   K. Schema pins            — column surfaces, RLS flags, grant hygiene
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { as, createTenant, createUser, getDb, grant, TENANT_A } from "./helpers";

interface Staff {
  authId: string;
  email: string;
  profileId: string;
}

/**
 * Build a named-argument RPC call. String values are quoted; the special
 * prefix `sql:` emits a raw fragment (casts, literals like false/null).
 */
const callRpc = (name: string, args: Record<string, unknown>) =>
  `SELECT * FROM politicore.${name}(${Object.keys(args)
    .map((k) => {
      const v = args[k];
      if (typeof v === "string" && v.startsWith("sql:")) return `${k} => ${v.slice(4)}`;
      if (typeof v === "string") return `${k} => '${(v as string).replace(/'/g, "''")}'`;
      return `${k} => ${String(v)}`;
    })
    .join(", ")})`;

describe("Governance Phase 12 — Projects", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let managerA: Staff;      // manage_projects, ward-scoped
  let viewerA: Staff;       // view_governance only
  let plainA: Staff;        // no governance authority
  let staffB: Staff;        // tenant B admin

  // Core Geography fixtures (RLS: platform admin writes; states are open).
  const STATE = "pst12";
  const ZONE = "pz12";
  const LGA = "pl12";
  const WARD = "pw12";
  const PU = "pp12";



  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "gp12-a", "GP12 Tenant A", { governance: true });
    tenantB = await createTenant(db, "gp12-b", "GP12 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "gp12-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    managerA = await createUser(db, { tenantId: tenantA, email: "gp12-mgr@a.test", fullName: "Manager A" });
    viewerA = await createUser(db, { tenantId: tenantA, email: "gp12-view@a.test", fullName: "Viewer A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "gp12-plain@a.test", fullName: "Plain A" });
    staffB = await createUser(db, { tenantId: tenantB, email: "gp12-admin@b.test", fullName: "Admin B", accessRole: "admin" });

    await grant(db, tenantA, managerA.authId, "manage_projects", true, "ward", WARD);
    await grant(db, tenantA, viewerA.authId, "view_governance", true);
  });

  const WARD2 = "pw12x";

  it("P1. Core Geography fixture chain accepts project scopes", async () => {
    // Seed minimal geography rows (platform-admin path) for authority tests.
    await db.query(
      `INSERT INTO politicore.states (id, name, code) VALUES ($1,'P12State','PS')
       ON CONFLICT (id) DO NOTHING`,
      [STATE],
    );
    await db.query(
      `INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P12Zone','PZ')
       ON CONFLICT (id) DO NOTHING`,
      [ZONE, STATE],
    );
    await db.query(
      `INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P12Lga','PL')
       ON CONFLICT (id) DO NOTHING`,
      [LGA, STATE, ZONE],
    );
    await db.query(
      `INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P12Ward','PW')
       ON CONFLICT (id) DO NOTHING`,
      [WARD, LGA],
    );
    await db.query(
      `INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code) VALUES ($1,$2,$3,'P12PU','PP')
       ON CONFLICT (id) DO NOTHING`,
      [PU, WARD, LGA],
    );

    // A ward-scoped manager can create a project AT their ward (the
    // 0045 rule: scope-scoped grantees must deliver an authorized scope).
    const created = await as(db, "authenticated", managerA.authId, callRpc("create_governance_project", {
      p_title: "Ward water scheme",
      p_scopes: JSON.stringify([{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }]),
    }));
    expect(created.error).toBeUndefined();
    const projectId = created.rows[0].create_governance_project as string;
    expect(projectId).toBeTruthy();

    // …and cannot create a tenant-wide project (no authorized scope).
    const tenantWide = await as(db, "authenticated", managerA.authId, callRpc("create_governance_project", {
      p_title: "Should abort", p_scopes: "[]",
    }));
    expect(tenantWide.error).toMatch(/scope within your authority/);

    // Scopes were attached through the inner add RPC (authority-holding).
    const scopes = await db.query(
      `SELECT scope_type, ward_id FROM politicore.governance_project_scopes WHERE project_id = $1`,
      [projectId],
    );
    expect(scopes.rows).toHaveLength(1);
    expect((scopes.rows[0] as Record<string, unknown>).scope_type).toBe("ward");
  });

  it("P2. anon has zero surface on all four new tables", async () => {
    for (const table of [
      "governance_projects",
      "governance_project_milestones",
      "governance_project_scopes",
      "governance_updates",
    ]) {
      const read = await as(db, "anon", null, `SELECT * FROM politicore.${table}`);
      expect(read.error).toBeUndefined(); // RLS filters, never errors
      expect(read.rows).toHaveLength(0);
      const write = await as(
        db, "anon", null,
        `INSERT INTO politicore.${table} (tenant_id) VALUES ('${TENANT_A}')`,
      );
      expect(write.error).toBeDefined();
    }
  });

  it("P3. tenant isolation — cross-tenant reads return nothing, mutations fail closed", async () => {
    // Create a project in tenant A as its admin.
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "A project" }));
    expect(created.error).toBeUndefined();
    const projectId = created.rows[0].create_governance_project as string;

    // Tenant B admin cannot see it.
    const crossRead = await as(db, "authenticated", staffB.authId, `SELECT * FROM politicore.governance_projects WHERE id = '${projectId}'`);
    expect(crossRead.rows).toHaveLength(0);

    // Tenant B admin cannot mutate it through the authority RPC.
    const crossUpdate = await as(db, "authenticated", staffB.authId, callRpc("update_governance_project", {
      p_project: projectId, p_title: "Hijacked",
    }));
    expect(crossUpdate.error).toMatch(/project not found/);

    // Tenant B admin cannot change its status.
    const crossStatus = await as(db, "authenticated", staffB.authId, callRpc("set_governance_project_status", {
      p_project: projectId, p_status: "completed",
    }));
    expect(crossStatus.error).toMatch(/project not found/);
  });

  it("P4. module isolation — governance OFF blocks projects; campaign/election state is irrelevant", async () => {
    // Governance-enabled tenant A works (proven above). Disable governance.
    await db.query(`UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
    const blocked = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Should fail" }));
    expect(blocked.error).toMatch(/module is not enabled/);
    await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);

    // Campaign ON + governance ON → still fine; Election OFF changes nothing.
    await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'campaign'`, [tenantA]);
    const ok = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Campaign state irrelevant" }));
    expect(ok.error).toBeUndefined();
  });

  it("P5. permission — manage_projects required; viewer/plain cannot mutate", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Perm target" }));
    const projectId = created.rows[0].create_governance_project as string;

    const viewerUpdate = await as(db, "authenticated", viewerA.authId, callRpc("update_governance_project", {
      p_project: projectId, p_title: "Nope",
    }));
    expect(viewerUpdate.error).toMatch(/manage_projects/);

    const plainUpdate = await as(db, "authenticated", plainA.authId, callRpc("update_governance_project", {
      p_project: projectId, p_title: "Nope",
    }));
    expect(plainUpdate.error).toMatch(/manage_projects|not found/);

    // The ward-scoped manager CAN update a project whose scope they hold
    // (has_project_geo_authority passes through their ward grant).
    const mgrProject = await as(db, "authenticated", managerA.authId, callRpc("create_governance_project", {
      p_title: "Manager project",
      p_scopes: JSON.stringify([{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }]),
    }));
    expect(mgrProject.error).toBeUndefined();
    const mgrProjectId = mgrProject.rows[0].create_governance_project as string;
    const mgrUpdate = await as(db, "authenticated", managerA.authId, callRpc("update_governance_project", {
      p_project: mgrProjectId, p_title: "Manager project (edited)",
    }));
    expect(mgrUpdate.error).toBeUndefined();

    // …but cannot mutate a project outside their scope.
    const outside = await as(db, "authenticated", managerA.authId, callRpc("update_governance_project", {
      p_project: projectId, p_title: "Nope",
    }));
    expect(outside.error).toMatch(/geographic authority/);
  });

  it("P6. geography — ward grant covers own ward; unrelated scope rejected; campaign scope forbidden", async () => {
    // Manager creates a project at their ward.
    const own = await as(db, "authenticated", managerA.authId, callRpc("create_governance_project", {
      p_title: "Geo own",
      p_scopes: JSON.stringify([{ scope_type: "ward", state_id: STATE, zone_id: ZONE, lga_id: LGA, ward_id: WARD }]),
    }));
    expect(own.error).toBeUndefined();
    const ownProject = own.rows[0].create_governance_project as string;
    // Re-attaching the same ward is an idempotent no-op returning the row.
    const attachOwn = await as(db, "authenticated", managerA.authId, callRpc("add_governance_project_scope", {
      p_project: ownProject, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD,
    }));
    expect(attachOwn.error).toBeUndefined();

    // …but may NOT attach an unrelated ward.
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P12WardX','PWX') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);
    const attachOther = await as(db, "authenticated", managerA.authId, callRpc("add_governance_project_scope", {
      p_project: ownProject, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2,
    }));
    expect(attachOther.error).toMatch(/outside their authority/);

    // Campaign scope value is forbidden to Governance (defense-in-depth;
    // attempted even by an admin).
    const campaignScope = await as(db, "authenticated", adminA.authId, callRpc("add_governance_project_scope", {
      p_project: ownProject, p_scope_type: "campaign",
    }));
    expect(campaignScope.error).toMatch(/campaign scope/);

    // Unknown geography ids fail closed.
    const bogus = await as(db, "authenticated", adminA.authId, callRpc("add_governance_project_scope", {
      p_project: ownProject, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "nope-ward",
    }));
    expect(bogus.error).toMatch(/does not match Core Geography/);
  });

  it("P7. lifecycle — illegal transitions rejected; timestamps server-stamped", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Lifecycle" }));
    const projectId = created.rows[0].create_governance_project as string;

    // planned → completed is illegal (must pass through active).
    const illegal = await as(db, "authenticated", adminA.authId, callRpc("set_governance_project_status", {
      p_project: projectId, p_status: "completed",
    }));
    expect(illegal.error).toMatch(/illegal project transition/);

    // planned → active stamps actual_start server-side.
    const legal = await as(db, "authenticated", adminA.authId, callRpc("set_governance_project_status", {
      p_project: projectId, p_status: "active",
    }));
    expect(legal.error).toBeUndefined();
    const row = await db.query(`SELECT actual_start, status FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("active");
    expect((row.rows[0] as Record<string, unknown>).actual_start).not.toBeNull();
  });

  it("P8. milestones — ownership + authority enforced; progress derives server-side", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Milestone project" }));
    const projectId = created.rows[0].create_governance_project as string;

    const m1 = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project_milestone", {
      p_project: projectId, p_title: "M1",
    }));
    expect(m1.error).toBeUndefined();
    const milestoneId = m1.rows[0].create_governance_project_milestone as string;

    // Viewer cannot mutate someone else's project milestone.
    const viewerMilestone = await as(db, "authenticated", viewerA.authId, callRpc("update_governance_project_milestone", {
      p_milestone: milestoneId, p_status: "done",
    }));
    expect(viewerMilestone.error).toMatch(/manage_projects/);

    // Progress starts at 0 with one pending milestone (non-cancelled count = 1).
    let row = await db.query(`SELECT progress_percent FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect(Number((row.rows[0] as Record<string, unknown>).progress_percent)).toBe(0);

    // Complete it → derived progress becomes 100.
    const done = await as(db, "authenticated", adminA.authId, callRpc("update_governance_project_milestone", {
      p_milestone: milestoneId, p_status: "done",
    }));
    expect(done.error).toBeUndefined();
    row = await db.query(`SELECT progress_percent FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect(Number((row.rows[0] as Record<string, unknown>).progress_percent)).toBe(100);

    // Manual override now REFUSES (derived-first rule).
    const manual = await as(db, "authenticated", adminA.authId, callRpc("set_governance_project_progress", {
      p_project: projectId, p_progress: "sql:42::smallint",
    }));
    expect(manual.error).toMatch(/progress is derived from milestones/);

    // completed_at is server-stamped.
    const m = await db.query(`SELECT completed_at FROM politicore.governance_project_milestones WHERE id = $1`, [milestoneId]);
    expect((m.rows[0] as Record<string, unknown>).completed_at).not.toBeNull();
  });

  it("P9. manual progress override only when milestone-free", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Manual progress" }));
    const projectId = created.rows[0].create_governance_project as string;
    const ok = await as(db, "authenticated", adminA.authId, callRpc("set_governance_project_progress", {
      p_project: projectId, p_progress: "sql:55::smallint",
    }));
    expect(ok.error).toBeUndefined();
    const row = await db.query(`SELECT progress_percent FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect(Number((row.rows[0] as Record<string, unknown>).progress_percent)).toBe(55);
  });

  it("P10. updates — canonical governance_updates, single-subject invariant, no project_updates table", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Update project" }));
    const projectId = created.rows[0].create_governance_project as string;

    const upd = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
      p_project: projectId, p_title: "Kickoff", p_body: "Work begins.", p_kind: "progress", p_is_public: false,
    }));
    expect(upd.error).toBeUndefined();
    const updateId = upd.rows[0].create_governance_update as string;

    // Server-stamped author + kind.
    const row = await db.query(
      `SELECT author_profile_id, kind, is_public FROM politicore.governance_updates WHERE id = $1`,
      [updateId],
    );
    expect((row.rows[0] as Record<string, unknown>).author_profile_id).toBeTruthy();

    // No Project-specific update table exists (canonical model only).
    const dup = await db.query(
      `SELECT to_regclass('politicore.project_updates') IS NOT NULL AS exists_project_updates`,
    );
    expect((dup.rows[0] as Record<string, unknown>).exists_project_updates).toBe(false);

    // The single-subject CHECK is present on the canonical table.
    const chk = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'politicore.governance_updates'::regclass
          AND conname = 'governance_updates_single_subject'`,
    );
    expect(chk.rows).toHaveLength(1);

    // Visibility change requires the authority RPC; viewer cannot publish.
    const viewerPublish = await as(db, "authenticated", viewerA.authId, callRpc("set_governance_update_visibility", {
      p_update: updateId, p_is_public: true,
    }));
    expect(viewerPublish.error).toMatch(/manage_projects/);
  });

  it("P11. visibility — private by default; is_public never leaks to anon; guard blocks direct writes", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Visibility" }));
    const projectId = created.rows[0].create_governance_project as string;

    // Default private.
    let row = await db.query(`SELECT is_public, published_at FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect((row.rows[0] as Record<string, unknown>).is_public).toBe(false);

    // Publish through the sanctioned RPC, then prove anon STILL cannot read
    // the base table (no anon policy — publication is projection-only).
    const publish = await as(db, "authenticated", adminA.authId, callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:true" }));
    expect(publish.error).toBeUndefined();
    const anonRead = await as(db, "anon", null, `SELECT * FROM politicore.governance_projects WHERE id = '${projectId}'`);
    expect(anonRead.rows).toHaveLength(0);

    // A direct-table write from an RLS-bypassing role raises the guard
    // (rows visible → BEFORE trigger fires).
    const direct = await as(db, "service_role", null, `UPDATE politicore.governance_projects SET is_public = false WHERE id = '${projectId}'`);
    expect(direct.error).toMatch(/authority RPC/);

    // …while the RPC path works (via admin authority). The project is now
    // private with a cleared publication stamp (GUC-gated server write).
    const viaRpc = await as(db, "authenticated", adminA.authId, callRpc("set_governance_project_visibility", { p_project: projectId, p_is_public: "sql:false" }));
    expect(viaRpc.error).toBeUndefined();
    row = await db.query(`SELECT is_public, published_at FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect((row.rows[0] as Record<string, unknown>).is_public).toBe(false);
    expect((row.rows[0] as Record<string, unknown>).published_at).toBeNull();

    // Plain member (no view_governance) cannot read base tables either.
    const memberRead = await as(db, "authenticated", plainA.authId, `SELECT * FROM politicore.governance_projects WHERE id = '${projectId}'`);
    expect(memberRead.rows).toHaveLength(0);
  });

  it("P12. media — evidence must reference a same-tenant media asset", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Evidence" }));
    const projectId = created.rows[0].create_governance_project as string;

    // Foreign-tenant asset is rejected.
    const foreign = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
      p_project: projectId, p_title: "", p_body: "x", p_kind: "progress", p_is_public: false,
      p_evidence_asset_id: "00000000-0000-0000-0000-000000000001",
    }));
    expect(foreign.error).toMatch(/evidence asset not found/);

    // A same-tenant asset (created through the media path) is accepted.
    const asset = await db.query(
      `INSERT INTO politicore.media_assets (tenant_id, provider, bucket, object_key, purpose)
       VALUES ($1, 'r2', 'test-bucket', 'gp12/evidence.png', 'governance_project_evidence')
       RETURNING id`,
      [tenantA],
    );
    const assetId = (asset.rows[0] as Record<string, unknown>).id as string;
    const ok = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
      p_project: projectId, p_title: "", p_body: "with evidence", p_kind: "progress",
      p_is_public: false, p_evidence_asset_id: assetId,
    }));
    expect(ok.error).toBeUndefined();
  });

  it("P13. audit — canonical system_audits rows with server-resolved actor and tenant", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Audited" }));
    const projectId = created.rows[0].create_governance_project as string;

    const audits = await db.query(
      `SELECT action, tenant_id, actor_id, affected_resource, resource_id
         FROM politicore.system_audits
        WHERE affected_resource = 'governance_projects' AND resource_id = $1
        ORDER BY occurred_at`,
      [projectId],
    );
    // Trigger row (insert) + RPC row (create) at minimum.
    expect(audits.rows.length).toBeGreaterThanOrEqual(2);
    const actions = audits.rows.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("governance_projects:insert");
    expect(actions).toContain("governance_project:create");
    for (const r of audits.rows) {
      expect((r as Record<string, unknown>).tenant_id).toBe(tenantA);
      expect((r as Record<string, unknown>).actor_id).toBe(adminA.authId);
    }
  });

  it("P14. deletion — no app-role DELETE path (institutional memory)", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Undeletable" }));
    const projectId = created.rows[0].create_governance_project as string;

    // Even an admin cannot DELETE through the data API (no policy exists —
    // RLS no-ops silently, touching zero rows; the record must survive).
    const del = await as(db, "authenticated", adminA.authId, `DELETE FROM politicore.governance_projects WHERE id = '${projectId}'`);
    expect(del.error).toBeUndefined();
    const still = await db.query(`SELECT count(*)::int AS n FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect(Number((still.rows[0] as Record<string, unknown>).n)).toBe(1);
  });

  it("P15. schema pins — FORCE RLS, zero anon policies, grant hygiene, immutable reference", async () => {
    for (const table of [
      "governance_projects",
      "governance_project_milestones",
      "governance_project_scopes",
      "governance_updates",
    ]) {
      const rls = await db.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'politicore'::regnamespace AND relname = $1`,
        [table],
      );
      expect((rls.rows[0] as Record<string, unknown>).relrowsecurity).toBe(true);
      expect((rls.rows[0] as Record<string, unknown>).relforcerowsecurity).toBe(true);

      const anonPolicies = await db.query(
        `SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = 'politicore' AND tablename = $1
            AND roles::text[] @> ARRAY['anon'::text]`,
        [table],
      );
      expect(Number((anonPolicies.rows[0] as Record<string, unknown>).n)).toBe(0);
    }

    // Write-policy absence on projects (mutations only via RPCs).
    const writePolicies = await db.query(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname = 'politicore' AND tablename = 'governance_projects'
          AND cmd IN ('INSERT','UPDATE','DELETE')`,
    );
    expect(Number((writePolicies.rows[0] as Record<string, unknown>).n)).toBe(0);

    // anon cannot execute the authority RPCs (revoke hygiene).
    const anonRpc = await as(db, "anon", null, `SELECT politicore.create_governance_project(p_title => 'anon')`);
    expect(anonRpc.error).toBeDefined();

    // Reference format GP-XXXXXXXX.
    const refRow = await db.query(
      `SELECT reference_code FROM politicore.governance_projects ORDER BY created_at LIMIT 1`,
    );
    expect(String((refRow.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^GP-[0-9A-F]{8}$/);
  });

  it("P16. reference immutability — reference_code cannot be reassigned", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Immutable ref" }));
    const projectId = created.rows[0].create_governance_project as string;
    // Direct-table reference write cannot succeed: authenticated callers
    // have no UPDATE policy (rows filtered before triggers — silent no-op)
    // and bypassing roles hit the identity guard. Either way the value
    // cannot change.
    await as(db, "authenticated", adminA.authId, `UPDATE politicore.governance_projects SET reference_code = 'GP-DEADBEEF' WHERE id = '${projectId}'`);
    const guardRaise = await as(db, "service_role", null, `UPDATE politicore.governance_projects SET reference_code = 'GP-DEADBEEF' WHERE id = '${projectId}'`);
    expect(guardRaise.error).toMatch(/reference is immutable/);

    const ref = await db.query(`SELECT reference_code FROM politicore.governance_projects WHERE id = $1`, [projectId]);
    expect(String((ref.rows[0] as Record<string, unknown>).reference_code)).not.toBe("GP-DEADBEEF");
  });

  it("P17. campaign/election/social FK isolation — no governance table references locked modules", async () => {
    const fks = await db.query(
      `SELECT count(*)::int AS n
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'politicore'
          AND c.contype = 'f'
          AND c.conrelid::regclass::text LIKE 'governance_%'
          AND (c.confrelid::regclass::text LIKE 'campaign%'
            OR c.confrelid::regclass::text LIKE 'election%'
            OR c.confrelid::regclass::text LIKE 'social%')`,
    );
    expect(Number((fks.rows[0] as Record<string, unknown>).n)).toBe(0);
  });
});
