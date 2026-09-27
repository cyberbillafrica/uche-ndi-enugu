/**
 * POLITICORE — Governance first vertical slice (Phase 7).
 *
 * Phase 7 is an application/UI phase over the approved Phase 6 database
 * contract. Because the UI consumes the database contract directly, the
 * slice suite pins exactly what the Phase 7 surfaces are built on (§20):
 *
 *   1. ADMIN AUTHORITY: tenant admins are staff+admin for Governance —
 *      queue authority and full lifecycle without a permission grant
 *      (the resolveGovernanceAccess admin fast path mirrors this).
 *   2. PARTICIPANT/READ PUBLICITY: a manage-only participant reads their
 *      own request (RLS ownership) and acknowledge carries their note;
 *      staff responses default to participant-visible (p_is_public = NULL
 *      → v_staff).
 *   3. SERVICE-CALL CONTRACTS: acknowledge ignores a participant note,
 *      reopen resolved→in_progress is legal, closed is terminal,
 *      participant response on a non-owned request fails closed.
 *   4. Category admin authority is exactly is_tenant_admin (§10).
 *   5. Assignment scope validation is server-side (no client scope math).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  as,
  createTenant,
  createUser,
  getDb,
  grant,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: PGlite;

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "gov7-a", "Governance Slice A", { governance: true }, TENANT_A);
  await createTenant(db, "gov7-b", "Governance Slice B", { governance: true }, TENANT_B);
});

async function memberOf(tenantId: string) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Gov Slice Fixture",
    accessRole: "member",
    membershipTypes: ["campaign_member"],
  });
}

async function adminOf(tenantId: string) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Gov Slice Admin",
    accessRole: "admin",
    membershipTypes: ["campaign_member"],
  });
}

async function submitRequest(uid: string, title = "Slice case") {
  return as(
    db, "authenticated", uid,
    "SELECT public.submit_governance_request($1, $2) AS id",
    [title, "Slice description"],
  );
}

describe("Governance vertical slice (Phase 7)", () => {
  it("1. admin authority: queue + full lifecycle without a permission grant", async () => {
    const admin = await adminOf(TENANT_A);
    const citizen = await memberOf(TENANT_A);
    const r = await submitRequest(citizen.authId);
    const id = r.rows[0].id as string;

    // admin reads the queue (RLS read policy: is_tenant_admin branch)
    const queue = await as(
      db, "authenticated", admin.authId,
      `SELECT id, status FROM public.governance_requests WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(queue.error).toBeUndefined();
    expect(queue.rows.map((x) => String(x.id))).toContain(id);

    // admin drives the lifecycle without any permission_grants row
    const ack = await as(
      db, "authenticated", admin.authId,
      `SELECT public.acknowledge_governance_request($1, 'By admin')`, [id],
    );
    expect(ack.error).toBeUndefined();

    const prog = await as(
      db, "authenticated", admin.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', 'Working')`, [id],
    );
    expect(prog.error).toBeUndefined();

    const res = await as(
      db, "authenticated", admin.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', 'Done')`, [id],
    );
    expect(res.error).toBeUndefined();
  });

  it("2. manage-only participant: owns+manages; acknowledge stores the caller's note", async () => {
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);

    // staff submits their own request as a participant
    const r = await submitRequest(staff.authId, "My own case");
    const id = r.rows[0].id as string;

    const mine = await as(
      db, "authenticated", staff.authId,
      `SELECT id FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(mine.error).toBeUndefined();
    expect(mine.rows).toHaveLength(1);

    // acknowledge carries the caller's note verbatim into the event
    const ack = await as(
      db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, 'Received and queued')`, [id],
    );
    expect(ack.error).toBeUndefined();
    const evs = await as(
      db, "authenticated", staff.authId,
      `SELECT body, actor_profile_id FROM public.governance_request_events
         WHERE request_id = $1 AND kind = 'acknowledged'`, [id],
    );
    expect(evs.rows[0].body).toBe("Received and queued");
    expect(evs.rows[0].actor_profile_id).toBe(staff.authId);
  });

  it("3. staff responses default to participant-visible (p_is_public = NULL)", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);

    const r = await submitRequest(citizen.authId, "Default publicity case");
    const id = r.rows[0].id as string;

    // staff respond with p_is_public = NULL — exactly the service's
    // addStaffResponse default for the ambiguity-free contract check.
    const reply = await as(
      db, "authenticated", staff.authId,
      `SELECT public.respond_governance_request($1, 'Default visibility reply', NULL)`, [id],
    );
    expect(reply.error).toBeUndefined();

    // participant sees it without any explicit-public flag
    const seen = await as(
      db, "authenticated", citizen.authId,
      `SELECT body, is_public FROM public.governance_request_events
         WHERE request_id = $1 AND kind = 'staff_response'`, [id],
    );
    expect(seen.rows.map((x) => String(x.body))).toContain("Default visibility reply");
  });

  it("4. lifecycle edges: reopen resolved→in_progress is legal; closed is terminal", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);

    const r = await submitRequest(citizen.authId, "Reopen case");
    const id = r.rows[0].id as string;

    const ack = await as(
      db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id],
    );
    expect(ack.error).toBeUndefined();

    // directly to in_progress (acknowledged → in_progress is a legal edge)
    const prog = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', NULL)`, [id],
    );
    expect(prog.error).toBeUndefined();

    const res = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', NULL)`, [id],
    );
    expect(res.error).toBeUndefined();

    // reopen path required by the slice: resolved → in_progress
    const reopen = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', 'Reopening after follow-up')`, [id],
    );
    expect(reopen.error).toBeUndefined();

    const state = await as(
      db, "authenticated", staff.authId,
      `SELECT status FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(state.rows[0].status).toBe("in_progress");

    // resolve again, close, then confirm closed is terminal
    const res2 = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', NULL)`, [id],
    );
    expect(res2.error).toBeUndefined();

    const close = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'closed', 'Completed')`, [id],
    );
    expect(close.error).toBeUndefined();

    const reopenAfterClose = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', 'nope')`, [id],
    );
    expect(reopenAfterClose.error).toBeDefined();

    const final = await as(
      db, "authenticated", staff.authId,
      `SELECT status FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(final.rows[0].status).toBe("closed");
  });

  it("5. participant response on a non-owned request fails closed", async () => {
    const citizenA = await memberOf(TENANT_A);
    const other = await memberOf(TENANT_A);

    const r = await submitRequest(citizenA.authId, "Not yours");
    const id = r.rows[0].id as string;

    const intrude = await as(
      db, "authenticated", other.authId,
      `SELECT public.respond_governance_request($1, 'trying to respond', NULL)`, [id],
    );
    expect(intrude.error).toBeDefined();
    expect(intrude.error).toMatch(/staff or owning participant required/i);

    // and a cross-tenant member cannot even see it (ownership + tenant)
    const far = await as(
      db, "authenticated", (await memberOf(TENANT_B)).authId,
      `SELECT id FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(far.rows).toHaveLength(0);
  });

  it("6. category admin is exactly tenant-admin; members denied", async () => {
    const admin = await adminOf(TENANT_A);
    const member = await memberOf(TENANT_A);

    const ok = await as(
      db, "authenticated", admin.authId,
      `INSERT INTO public.governance_request_categories (tenant_id, name)
       VALUES ($1, 'Admin-created') RETURNING id`, [TENANT_A],
    );
    expect(ok.error).toBeUndefined();

    const denied = await as(
      db, "authenticated", member.authId,
      `INSERT INTO public.governance_request_categories (tenant_id, name)
       VALUES ($1, 'Member-created') RETURNING id`, [TENANT_A],
    );
    expect(denied.error).toBeDefined();
  });

  it("7. assignment is server-validated (cross-tenant + scope errors surface from the RPC)", async () => {
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "assign_cases", true);
    const assignee = await memberOf(TENANT_A);

    const r = await submitRequest(await memberOf(TENANT_A).then((m) => m.authId), "Assign case");
    const id = r.rows[0].id as string;

    const cross = await as(
      db, "authenticated", staff.authId,
      `SELECT public.assign_governance_request($1, $2, NULL, NULL, 'x')`,
      [id, (await memberOf(TENANT_B)).authId],
    );
    expect(cross.error).toBeDefined();
    expect(cross.error).toMatch(/same tenant/i);

    // non-staff member cannot assign at all
    const nobody = await as(
      db, "authenticated", assignee.authId,
      `SELECT public.assign_governance_request($1, $2, NULL, NULL, 'x')`,
      [id, assignee.authId],
    );
    expect(nobody.error).toBeDefined();
    expect(nobody.error).toMatch(/assign_cases required/i);
  });

  it("8. feedback once-only on resolved: contract stands for the slice UI", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);

    const r = await submitRequest(citizen.authId, "Feedback slice case");
    const id = r.rows[0].id as string;

    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);
    await as(db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', NULL)`, [id]);
    await as(db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', 'Fixed quickly')`, [id]);

    const rate = await as(
      db, "authenticated", citizen.authId,
      `SELECT public.rate_governance_request($1, 5, 'Great')`, [id],
    );
    expect(rate.error).toBeUndefined();

    const again = await as(
      db, "authenticated", citizen.authId,
      `SELECT public.rate_governance_request($1, 2, 'changed my mind')`, [id],
    );
    expect(again.error).toBeDefined();

    // staff cannot rate someone else's resolved request
    const staffRate = await as(
      db, "authenticated", staff.authId,
      `SELECT public.rate_governance_request($1, 4, 'self-review')`, [id],
    );
    expect(staffRate.error).toBeDefined();
  });
});
