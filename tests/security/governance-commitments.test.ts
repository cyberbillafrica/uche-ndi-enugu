/**
 * POLITICORE — GOVERNANCE PHASE 13 — COMMITMENTS SECURITY SUITE.
 *
 * Proves the Commitments slice (migration 0048) against role-impersonated
 * sessions (helpers.as) — the same acceptance standard as Phases 6–12:
 *
 *   A. Tenant isolation       — cross-tenant read/mutation/link fails closed
 *   B. Module isolation       — governance OFF blocks; Campaign/Election
 *                               state is irrelevant to Commitments
 *   C. Permission             — manage_projects covers Commitments (Phase 11
 *                               "projects + commitments"); NO new permission,
 *                               NO new role; view_governance never manages
 *   D. Manifesto boundary     — independent commitments need no Manifesto
 *                               record; zero FKs into the locked module;
 *                               lineage is (source_type, source_ref) only
 *   E. Relationship           — commitment ⇄ project optional both ways;
 *                               one commitment ↔ many projects; links NEVER
 *                               grant authority; cross-tenant linking fails
 *   F. Geography              — descendant coverage via Core scope_covers;
 *                               unrelated scope rejected; campaign forbidden
 *   G. Lifecycle              — server-enforced transitions; terminal states
 *                               retained (institutional memory)
 *   H. Progress               — single, explicitly reported authority; audited
 *   I. Updates                — canonical governance_updates extended with the
 *                               commitment subject; single-subject invariant
 *                               preserved; project updates still work
 *   J. Visibility             — private by default; GUC-gated RPC publication;
 *                               guard blocks direct-table writes; anon nothing
 *   K. Media/Audit/Deletion   — Core media_assets evidence; canonical
 *                               system_audits; no app-role DELETE path
 *   L. Schema pins            — FORCE RLS, zero anon policies, grant hygiene,
 *                               permission catalog unchanged, GC- references
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
 * prefix `sql:` emits a raw fragment (casts, literals like true/false).
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

const WARD_SCOPE = JSON.stringify([
  { scope_type: "ward", state_id: "pst13", zone_id: "pz13", lga_id: "pl13", ward_id: "pw13" },
]);

describe("Governance Phase 13 — Commitments", () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  let adminA: Staff;
  let wardMgrA: Staff;    // manage_projects, ward-scoped
  let stateMgrA: Staff;   // manage_projects, state-scoped (descendant coverage)
  let viewerA: Staff;     // view_governance only
  let plainA: Staff;      // no governance authority
  let adminB: Staff;      // tenant B admin

  // Core Geography fixtures (distinct from the Phase 12 suite's DB).
  const STATE = "pst13";
  const ZONE = "pz13";
  const LGA = "pl13";
  const WARD = "pw13";
  const WARD2 = "pw13x";

  beforeAll(async () => {
    db = await getDb();

    tenantA = await createTenant(db, "gc13-a", "GC13 Tenant A", { governance: true });
    tenantB = await createTenant(db, "gc13-b", "GC13 Tenant B", { governance: true });

    adminA = await createUser(db, { tenantId: tenantA, email: "gc13-admin@a.test", fullName: "Admin A", accessRole: "admin" });
    wardMgrA = await createUser(db, { tenantId: tenantA, email: "gc13-ward@a.test", fullName: "Ward Manager A" });
    stateMgrA = await createUser(db, { tenantId: tenantA, email: "gc13-state@a.test", fullName: "State Manager A" });
    viewerA = await createUser(db, { tenantId: tenantA, email: "gc13-view@a.test", fullName: "Viewer A" });
    plainA = await createUser(db, { tenantId: tenantA, email: "gc13-plain@a.test", fullName: "Plain A" });
    adminB = await createUser(db, { tenantId: tenantB, email: "gc13-admin@b.test", fullName: "Admin B", accessRole: "admin" });

    await grant(db, tenantA, wardMgrA.authId, "manage_projects", true, "ward", WARD);
    await grant(db, tenantA, stateMgrA.authId, "manage_projects", true, "state", STATE);
    await grant(db, tenantA, viewerA.authId, "view_governance", true);

    // Geography chain (platform-admin path).
    await db.query(`INSERT INTO politicore.states (id, name, code) VALUES ($1,'P13State','P3') ON CONFLICT (id) DO NOTHING`, [STATE]);
    await db.query(`INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ($1,$2,'P13Zone','PZ3') ON CONFLICT (id) DO NOTHING`, [ZONE, STATE]);
    await db.query(`INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ($1,$2,$3,'P13Lga','PL3') ON CONFLICT (id) DO NOTHING`, [LGA, STATE, ZONE]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P13Ward','PW3') ON CONFLICT (id) DO NOTHING`, [WARD, LGA]);
    await db.query(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES ($1,$2,'P13WardX','PX3') ON CONFLICT (id) DO NOTHING`, [WARD2, LGA]);
  });

  it("C1. creation — ward-scoped manager creates at their ward; bare scoped grant cannot create tenant-wide", async () => {
    const created = await as(db, "authenticated", wardMgrA.authId, callRpc("create_governance_commitment", {
      p_title: "Ward clinic beds",
      p_source_type: "independent",
      p_target_description: "Ten beds equipped at the ward clinic",
      p_scopes: WARD_SCOPE,
    }));
    expect(created.error).toBeUndefined();
    const id = created.rows[0].create_governance_commitment as string;
    expect(id).toBeTruthy();

    // …and cannot create a tenant-wide commitment (the Phase 12 create rule:
    // scope-scoped grantees must deliver an authorized scope).
    const tenantWide = await as(db, "authenticated", wardMgrA.authId, callRpc("create_governance_commitment", {
      p_title: "Should abort", p_scopes: "[]",
    }));
    expect(tenantWide.error).toMatch(/scope within your authority/);
  });

  it("C2. anon has zero surface on all three new tables", async () => {
    for (const table of [
      "governance_commitments",
      "governance_commitment_scopes",
      "governance_commitment_projects",
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

  it("C3. tenant isolation — cross-tenant reads return nothing, mutations fail closed", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "A commitment" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    const crossRead = await as(db, "authenticated", adminB.authId, `SELECT * FROM politicore.governance_commitments WHERE id = '${commitmentId}'`);
    expect(crossRead.rows).toHaveLength(0);

    const crossUpdate = await as(db, "authenticated", adminB.authId, callRpc("update_governance_commitment", {
      p_commitment: commitmentId, p_title: "Hijacked",
    }));
    expect(crossUpdate.error).toMatch(/commitment not found/);

    const crossStatus = await as(db, "authenticated", adminB.authId, callRpc("set_governance_commitment_status", {
      p_commitment: commitmentId, p_status: "delivered",
    }));
    expect(crossStatus.error).toMatch(/commitment not found/);
  });

  it("C4. module isolation — governance OFF blocks commitments; campaign state is irrelevant", async () => {
    await db.query(`UPDATE politicore.tenant_modules SET enabled = false WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);
    const blocked = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Should fail" }));
    expect(blocked.error).toMatch(/module is not enabled/);
    await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'governance'`, [tenantA]);

    await db.query(`UPDATE politicore.tenant_modules SET enabled = true WHERE tenant_id = $1 AND module = 'campaign'`, [tenantA]);
    const ok = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Campaign state irrelevant" }));
    expect(ok.error).toBeUndefined();
  });

  it("C5. permission — manage_projects covers commitments; no new permission or role; view_governance never manages", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Perm target" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    const viewerUpdate = await as(db, "authenticated", viewerA.authId, callRpc("update_governance_commitment", {
      p_commitment: commitmentId, p_title: "Nope",
    }));
    expect(viewerUpdate.error).toMatch(/manage_projects/);

    const plainUpdate = await as(db, "authenticated", plainA.authId, callRpc("update_governance_commitment", {
      p_commitment: commitmentId, p_title: "Nope",
    }));
    expect(plainUpdate.error).toMatch(/manage_projects|not found/);

    // The ward manager CAN update the commitment they created at their ward
    // (reuse manage_projects — no commitment-specific permission exists).
    const own = await as(db, "authenticated", wardMgrA.authId, callRpc("create_governance_commitment", {
      p_title: "Ward manager commitment", p_scopes: WARD_SCOPE,
    }));
    expect(own.error).toBeUndefined();
    const ownId = own.rows[0].create_governance_commitment as string;
    const ownUpdate = await as(db, "authenticated", wardMgrA.authId, callRpc("update_governance_commitment", {
      p_commitment: ownId, p_title: "Ward manager commitment (edited)",
    }));
    expect(ownUpdate.error).toBeUndefined();

    // …but cannot mutate a commitment outside their scope.
    const outside = await as(db, "authenticated", wardMgrA.authId, callRpc("update_governance_commitment", {
      p_commitment: commitmentId, p_title: "Nope",
    }));
    expect(outside.error).toMatch(/geographic authority/);

    // Catalog holds: no Commitment-specific permission exists (Phase 14
    // later added the two §16 participation permissions; none mention
    // commitments).
    const perms = await db.query(
      `SELECT name FROM politicore.permissions WHERE domain = 'governance' ORDER BY name`,
    );
    expect(perms.rows.map((r) => String((r as Record<string, unknown>).name))).toEqual(
      ["assign_cases", "manage_cases", "manage_participation", "manage_projects",
       "publish_accountability", "view_cases", "view_governance"],
    );
    const commitmentPerms = await db.query(
      `SELECT count(*)::int AS n FROM politicore.permissions WHERE name LIKE '%commitment%'`,
    );
    expect(Number((commitmentPerms.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("C6. geography — state grant covers descendants via scope_covers; unrelated scope rejected; campaign forbidden; unknown geography fails", async () => {
    // State-scoped grant covers a ZONE within that state (descendant).
    const zone = await as(db, "authenticated", stateMgrA.authId, callRpc("create_governance_commitment", {
      p_title: "Zone-wide commitment",
      p_scopes: JSON.stringify([{ scope_type: "senatorial_zone", state_id: STATE, zone_id: ZONE }]),
    }));
    expect(zone.error).toBeUndefined();
    const zoneId = zone.rows[0].create_governance_commitment as string;

    // …and a ward within the same LGA/state.
    const ward = await as(db, "authenticated", stateMgrA.authId, callRpc("add_governance_commitment_scope", {
      p_commitment: zoneId, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD,
    }));
    expect(ward.error).toBeUndefined();

    // Unrelated scope: the WARD manager may not attach an LGA they don't hold.
    const unrelated = await as(db, "authenticated", wardMgrA.authId, callRpc("add_governance_commitment_scope", {
      p_commitment: zoneId, p_scope_type: "lga", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA,
    }));
    expect(unrelated.error).toMatch(/outside their authority/);

    // …nor a different ward.
    const otherWard = await as(db, "authenticated", wardMgrA.authId, callRpc("add_governance_commitment_scope", {
      p_commitment: zoneId, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: WARD2,
    }));
    expect(otherWard.error).toMatch(/outside their authority/);

    // Campaign scope value is forbidden to Governance (defense-in-depth).
    const campaignScope = await as(db, "authenticated", adminA.authId, callRpc("add_governance_commitment_scope", {
      p_commitment: zoneId, p_scope_type: "campaign",
    }));
    expect(campaignScope.error).toMatch(/campaign scope/);

    // Unknown geography ids fail closed.
    const bogus = await as(db, "authenticated", adminA.authId, callRpc("add_governance_commitment_scope", {
      p_commitment: zoneId, p_scope_type: "ward", p_state_id: STATE, p_zone_id: ZONE, p_lga_id: LGA, p_ward_id: "nope-ward",
    }));
    expect(bogus.error).toMatch(/does not match Core Geography/);
  });

  it("C7. manifesto boundary — independent commitments need no manifesto; zero FKs into the locked module", async () => {
    // The tenant holds NO manifesto row at all — the commitment still works.
    const manifestoCount = await db.query(`SELECT count(*)::int AS n FROM politicore.manifestos WHERE tenant_id = $1`, [tenantA]);
    expect(Number((manifestoCount.rows[0] as Record<string, unknown>).n)).toBe(0);

    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
      p_title: "Independent commitment",
      p_source_type: "independent",
      p_target_description: "Adopted at the January town hall",
    }));
    expect(created.error).toBeUndefined();

    // Manifesto-labeled lineage is display-only metadata — created without
    // resolving or validating any Manifesto record.
    const lineage = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
      p_title: "Manifesto-lineage commitment",
      p_source_type: "manifesto",
      p_source_ref: "Manifesto §Water, item 3",
    }));
    expect(lineage.error).toBeUndefined();
    const lineageId = lineage.rows[0].create_governance_commitment as string;
    const row = await db.query(
      `SELECT source_type, source_ref FROM politicore.governance_commitments WHERE id = $1`,
      [lineageId],
    );
    expect((row.rows[0] as Record<string, unknown>).source_type).toBe("manifesto");
    expect((row.rows[0] as Record<string, unknown>).source_ref).toBe("Manifesto §Water, item 3");

    // No governance table carries a FK into the locked Manifesto module.
    const fks = await db.query(
      `SELECT count(*)::int AS n
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'politicore'
          AND c.contype = 'f'
          AND c.conrelid::regclass::text LIKE 'governance_%'
          AND c.confrelid::regclass::text LIKE 'manifesto%'`,
    );
    expect(Number((fks.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("C8. relationship — optional both ways; one commitment ↔ many projects; links never grant authority", async () => {
    // Commitment without project.
    const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", {
      p_title: "Linked commitment",
      p_scopes: JSON.stringify([{ scope_type: "lga", state_id: STATE, zone_id: ZONE, lga_id: LGA }]),
    }));
    const commitmentId = commitment.rows[0].create_governance_commitment as string;

    // Project without commitment.
    const project = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Unaffiliated project" }));
    expect(project.error).toBeUndefined();
    const projectId = project.rows[0].create_governance_project as string;

    // One commitment ↔ many projects (two links).
    const l1 = await as(db, "authenticated", adminA.authId, callRpc("link_governance_project", {
      p_commitment: commitmentId, p_project: projectId,
    }));
    expect(l1.error).toBeUndefined();
    const p2 = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Second delivery project" }));
    const projectId2 = p2.rows[0].create_governance_project as string;
    const l2 = await as(db, "authenticated", adminA.authId, callRpc("link_governance_project", {
      p_commitment: commitmentId, p_project: projectId2,
    }));
    expect(l2.error).toBeUndefined();

    const links = await db.query(
      `SELECT count(*)::int AS n FROM politicore.governance_commitment_projects WHERE commitment_id = $1`,
      [commitmentId],
    );
    expect(Number((links.rows[0] as Record<string, unknown>).n)).toBe(2);

    // A LINK DOES NOT GRANT AUTHORITY: the ward manager (whose ward project
    // could be linked) holds no authority over the LGA-scoped commitment —
    // they cannot update it and cannot unlink the project.
    const mgrLink = await as(db, "authenticated", wardMgrA.authId, callRpc("link_governance_project", {
      p_commitment: commitmentId, p_project: projectId,
    }));
    expect(mgrLink.error).toMatch(/geographic authority|manage_projects/);

    // Unlink requires commitment authority and works for its holder.
    const mgrUnlink = await as(db, "authenticated", wardMgrA.authId, callRpc("unlink_governance_project", {
      p_commitment: commitmentId, p_project: projectId,
    }));
    expect(mgrUnlink.error).toMatch(/geographic authority|manage_projects/);

    const adminUnlink = await as(db, "authenticated", adminA.authId, callRpc("unlink_governance_project", {
      p_commitment: commitmentId, p_project: projectId2,
    }));
    expect(adminUnlink.error).toBeUndefined();
    const after = await db.query(
      `SELECT count(*)::int AS n FROM politicore.governance_commitment_projects
        WHERE commitment_id = $1 AND project_id = $2`,
      [commitmentId, projectId2],
    );
    expect(Number((after.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("C9. cross-tenant relationship protection — forged and foreign ids fail closed", async () => {
    const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Tenant A commitment" }));
    const commitmentId = commitment.rows[0].create_governance_commitment as string;
    const projectB = await as(db, "authenticated", adminB.authId, callRpc("create_governance_project", { p_title: "Tenant B project" }));
    const projectBId = projectB.rows[0].create_governance_project as string;

    // Tenant A commitment + Tenant B project cannot be linked.
    const cross = await as(db, "authenticated", adminA.authId, callRpc("link_governance_project", {
      p_commitment: commitmentId, p_project: projectBId,
    }));
    expect(cross.error).toMatch(/project not found in this tenant/);

    // Tenant B cannot mutate Tenant A's commitment.
    const crossUpdate = await as(db, "authenticated", adminB.authId, callRpc("update_governance_commitment", {
      p_commitment: commitmentId, p_title: "Hijack",
    }));
    expect(crossUpdate.error).toMatch(/commitment not found/);
  });

  it("C10. lifecycle — illegal transitions rejected; terminal stamp server-set; delivered retained", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Lifecycle" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    // declared → delivered is illegal (must pass through in_progress).
    const illegal = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_status", {
      p_commitment: commitmentId, p_status: "delivered",
    }));
    expect(illegal.error).toMatch(/illegal commitment transition/);

    const legal = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_status", {
      p_commitment: commitmentId, p_status: "in_progress",
    }));
    expect(legal.error).toBeUndefined();

    const partial = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_status", {
      p_commitment: commitmentId, p_status: "partially_delivered",
    }));
    expect(partial.error).toBeUndefined();

    const delivered = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_status", {
      p_commitment: commitmentId, p_status: "delivered",
    }));
    expect(delivered.error).toBeUndefined();
    const row = await db.query(`SELECT status, completed_at FROM politicore.governance_commitments WHERE id = $1`, [commitmentId]);
    expect((row.rows[0] as Record<string, unknown>).status).toBe("delivered");
    expect((row.rows[0] as Record<string, unknown>).completed_at).not.toBeNull();

    // Terminal: delivered is a dead end.
    const reopen = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_status", {
      p_commitment: commitmentId, p_status: "in_progress",
    }));
    expect(reopen.error).toMatch(/illegal commitment transition/);
  });

  it("C11. progress — single explicitly reported authority; range enforced; audited old→new", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Progress target" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    const outOfRange = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_progress", {
      p_commitment: commitmentId, p_progress: "sql:150::smallint",
    }));
    expect(outOfRange.error).toMatch(/between 0 and 100|progress_percent/);

    const ok = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_progress", {
      p_commitment: commitmentId, p_progress: "sql:45::smallint",
    }));
    expect(ok.error).toBeUndefined();
    const row = await db.query(`SELECT progress_percent FROM politicore.governance_commitments WHERE id = $1`, [commitmentId]);
    expect(Number((row.rows[0] as Record<string, unknown>).progress_percent)).toBe(45);

    const audit = await db.query(
      `SELECT old_value, new_value FROM politicore.system_audits
        WHERE affected_resource = 'governance_commitments' AND resource_id = $1
          AND action = 'governance_commitment:progress'`,
      [commitmentId],
    );
    expect(audit.rows.length).toBe(1);
    expect((audit.rows[0] as Record<string, unknown>).old_value).toEqual({ progress: 0 });
    expect((audit.rows[0] as Record<string, unknown>).new_value).toEqual({ progress: 45 });
  });

  it("C12. updates — canonical governance_updates extended; single-subject invariant preserved; project updates still work", async () => {
    const commitment = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Update target" }));
    const commitmentId = commitment.rows[0].create_governance_commitment as string;

    const upd = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment_update", {
      p_commitment: commitmentId, p_title: "Kickoff", p_body: "Delivery begins.", p_kind: "progress", p_is_public: false,
    }));
    expect(upd.error).toBeUndefined();
    const updateId = upd.rows[0].create_governance_commitment_update as string;

    // Subject integrity: commitment set, project NULL, author server-stamped.
    const row = await db.query(
      `SELECT commitment_id, project_id, author_profile_id, kind FROM politicore.governance_updates WHERE id = $1`,
      [updateId],
    );
    expect((row.rows[0] as Record<string, unknown>).commitment_id).toBe(commitmentId);
    expect((row.rows[0] as Record<string, unknown>).project_id).toBeNull();
    expect((row.rows[0] as Record<string, unknown>).author_profile_id).toBeTruthy();

    // No commitment-specific update table exists (canonical model only).
    const dup = await db.query(
      `SELECT to_regclass('politicore.governance_commitment_updates') IS NOT NULL AS exists_dup`,
    );
    expect((dup.rows[0] as Record<string, unknown>).exists_dup).toBe(false);

    // The single-subject CHECK survives the extension, under the same name.
    const chk = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'politicore.governance_updates'::regclass
          AND conname = 'governance_updates_single_subject'`,
    );
    expect(chk.rows).toHaveLength(1);
    expect(String((chk.rows[0] as Record<string, unknown>).def)).toContain("commitment_id");

    // PROJECT updates still work through the canonical substrate.
    const project = await as(db, "authenticated", adminA.authId, callRpc("create_governance_project", { p_title: "Still-working project" }));
    const projectId = project.rows[0].create_governance_project as string;
    const projectUpdate = await as(db, "authenticated", adminA.authId, callRpc("create_governance_update", {
      p_project: projectId, p_title: "", p_body: "Project update intact.", p_kind: "progress", p_is_public: false,
    }));
    expect(projectUpdate.error).toBeUndefined();

    // Visibility change requires authority over the commitment subject.
    const viewerPublish = await as(db, "authenticated", viewerA.authId, callRpc("set_governance_update_visibility", {
      p_update: updateId, p_is_public: true,
    }));
    expect(viewerPublish.error).toMatch(/manage_projects/);
  });

  it("C13. visibility — private by default; RPC-only publication; guard blocks direct writes; anon nothing", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Visibility" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    let row = await db.query(`SELECT is_public, published_at FROM politicore.governance_commitments WHERE id = $1`, [commitmentId]);
    expect((row.rows[0] as Record<string, unknown>).is_public).toBe(false);
    expect((row.rows[0] as Record<string, unknown>).published_at).toBeNull();

    const publish = await as(db, "authenticated", adminA.authId, callRpc("set_governance_commitment_visibility", {
      p_commitment: commitmentId, p_is_public: "sql:true",
    }));
    expect(publish.error).toBeUndefined();
    row = await db.query(`SELECT is_public, published_at FROM politicore.governance_commitments WHERE id = $1`, [commitmentId]);
    expect((row.rows[0] as Record<string, unknown>).is_public).toBe(true);
    expect((row.rows[0] as Record<string, unknown>).published_at).not.toBeNull();

    // Anon STILL cannot read the base table (no anon policy — publication is
    // projection-only; the public directory remains the future phase).
    const anonRead = await as(db, "anon", null, `SELECT * FROM politicore.governance_commitments WHERE id = '${commitmentId}'`);
    expect(anonRead.rows).toHaveLength(0);

    // A direct-table write from an RLS-bypassing role raises the guard.
    const direct = await as(db, "service_role", null, `UPDATE politicore.governance_commitments SET is_public = false WHERE id = '${commitmentId}'`);
    expect(direct.error).toMatch(/authority RPC/);

    // Plain member (no view_governance) cannot read base tables either.
    const memberRead = await as(db, "authenticated", plainA.authId, `SELECT * FROM politicore.governance_commitments WHERE id = '${commitmentId}'`);
    expect(memberRead.rows).toHaveLength(0);
  });

  it("C14. media — evidence must reference a same-tenant Core media asset", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Evidence target" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    const foreign = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment_update", {
      p_commitment: commitmentId, p_title: "", p_body: "x", p_kind: "progress", p_is_public: false,
      p_evidence_asset_id: "00000000-0000-0000-0000-000000000001",
    }));
    expect(foreign.error).toMatch(/evidence asset not found/);

    const asset = await db.query(
      `INSERT INTO politicore.media_assets (tenant_id, provider, bucket, object_key, purpose)
       VALUES ($1, 'r2', 'test-bucket', 'gc13/evidence.png', 'governance_commitment_evidence')
       RETURNING id`,
      [tenantA],
    );
    const assetId = (asset.rows[0] as Record<string, unknown>).id as string;
    const ok = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment_update", {
      p_commitment: commitmentId, p_title: "", p_body: "with evidence", p_kind: "progress",
      p_is_public: false, p_evidence_asset_id: assetId,
    }));
    expect(ok.error).toBeUndefined();
  });

  it("C15. audit — canonical system_audits rows with server-resolved actor and tenant", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Audited" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    const audits = await db.query(
      `SELECT action, tenant_id, actor_id, affected_resource, resource_id
         FROM politicore.system_audits
        WHERE affected_resource = 'governance_commitments' AND resource_id = $1
        ORDER BY occurred_at`,
      [commitmentId],
    );
    // Trigger row (insert) + RPC row (create) at minimum.
    expect(audits.rows.length).toBeGreaterThanOrEqual(2);
    const actions = audits.rows.map((r) => (r as Record<string, unknown>).action);
    expect(actions).toContain("governance_commitments:insert");
    expect(actions).toContain("governance_commitment:create");
    for (const r of audits.rows) {
      expect((r as Record<string, unknown>).tenant_id).toBe(tenantA);
      expect((r as Record<string, unknown>).actor_id).toBe(adminA.authId);
    }
  });

  it("C16. deletion — no app-role DELETE path (institutional memory)", async () => {
    const created = await as(db, "authenticated", adminA.authId, callRpc("create_governance_commitment", { p_title: "Undeletable" }));
    const commitmentId = created.rows[0].create_governance_commitment as string;

    // Even an admin cannot DELETE through the data API (no policy exists —
    // RLS no-ops silently, touching zero rows; the record must survive).
    const del = await as(db, "authenticated", adminA.authId, `DELETE FROM politicore.governance_commitments WHERE id = '${commitmentId}'`);
    expect(del.error).toBeUndefined();
    const still = await db.query(`SELECT count(*)::int AS n FROM politicore.governance_commitments WHERE id = $1`, [commitmentId]);
    expect(Number((still.rows[0] as Record<string, unknown>).n)).toBe(1);
  });

  it("C17. schema pins — FORCE RLS, zero anon policies, no write policies, grant hygiene, GC- references", async () => {
    for (const table of [
      "governance_commitments",
      "governance_commitment_scopes",
      "governance_commitment_projects",
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

      const writePolicies = await db.query(
        `SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = 'politicore' AND tablename = $1
            AND cmd IN ('INSERT','UPDATE','DELETE')`,
        [table],
      );
      expect(Number((writePolicies.rows[0] as Record<string, unknown>).n)).toBe(0);
    }

    // anon cannot execute the authority RPCs (revoke hygiene).
    const anonRpc = await as(db, "anon", null, `SELECT politicore.create_governance_commitment(p_title => 'anon')`);
    expect(anonRpc.error).toBeDefined();

    // Reference format GC-XXXXXXXX; reference immutability enforced by the
    // identity guard for RLS-bypassing writes.
    const refRow = await db.query(
      `SELECT reference_code FROM politicore.governance_commitments ORDER BY created_at LIMIT 1`,
    );
    expect(String((refRow.rows[0] as Record<string, unknown>).reference_code)).toMatch(/^GC-[0-9A-F]{8}$/);
  });
});
