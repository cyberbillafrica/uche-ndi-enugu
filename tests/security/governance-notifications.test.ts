/**
 * POLITICORE — Governance → Core Notifications integration (Phase 8).
 *
 * Migration 0036 wires the Governance authority RPCs into the EXISTING
 * Core Notifications module (politicore.notifications) via the Campaign
 * precedent (0021 campaign_notify): best-effort SECURITY DEFINER notify
 * helpers invoked INSIDE the authority RPC — one transaction with the
 * workflow mutation (§6/§7), inheriting its authorization (§11).
 *
 *   N1 — acknowledged → participant notification
 *   N2 — assignment → participant + assignee notifications
 *   N3 — awaiting_information → participant notification
 *   N4 — resolved → participant notification
 *   N5 — closed → participant notification
 *   N6 — failed/illegal transition → no notification
 *   N7 — duplicate protection: same-status retry, re-acknowledge and
 *        same-assignee re-assign produce no duplicates
 *   N8 — tenant isolation: notification rows resolve server-side
 *   N9 — recipient isolation: notifications are strictly per-user (RLS)
 *   N10 — privacy: responses (internal or public) never notify
 *   N11 — module disabled: RPC fails closed before any mutation/notify
 *   N12 — Notification Center contract: type='system' + link_url route
 *   N13 — no parallel Governance notification infrastructure
 *   N14 — Firebase stays retired
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
let offTenant: string;

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "govn-a", "Gov Notify A", { governance: true }, TENANT_A);
  await createTenant(db, "govn-b", "Gov Notify B", { governance: true }, TENANT_B);
  offTenant = await createTenant(db, "govn-off", "Gov Notify Off", { governance: false });
});

async function memberOf(tenantId: string) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Gov Notify Fixture",
    accessRole: "member",
    membershipTypes: ["campaign_member"],
  });
}

async function adminOf(tenantId: string) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Gov Notify Admin",
    accessRole: "admin",
    membershipTypes: ["campaign_member"],
  });
}

async function staffWithManage(tenantId: string) {
  const s = await memberOf(tenantId);
  await grant(db, tenantId, s.authId, "manage_cases", true);
  return s;
}

async function submitRequest(uid: string, title = "Notify case") {
  return as(
    db, "authenticated", uid,
    "SELECT public.submit_governance_request($1, $2) AS id",
    [title, "Notify description"],
  );
}

/** Notifications addressed to a user (RLS-scoped read, as the Center does). */
async function notificationsFor(uid: string) {
  return as(
    db, "authenticated", uid,
    `SELECT type, title, message, link_url FROM politicore.notifications
       WHERE user_id = $1 ORDER BY created_at, id`,
    [uid],
  );
}

async function countNotifications(uid: string, title: string) {
  const r = await as(
    db, "authenticated", uid,
    `SELECT count(*)::int AS n FROM politicore.notifications WHERE user_id = $1 AND title = $2`,
    [uid, title],
  );
  return Number(r.rows[0]?.n ?? 0);
}

describe("Governance notifications integration (Phase 8)", () => {
  it("N1. acknowledgement notifies the participant", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await staffWithManage(TENANT_A);
    const r = await submitRequest(citizen.authId);
    const id = r.rows[0].id as string;

    const ack = await as(
      db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, 'Received')`, [id],
    );
    expect(ack.error).toBeUndefined();

    const notes = await notificationsFor(citizen.authId);
    expect(notes.error).toBeUndefined();
    const row = notes.rows.find((x) => x.title === "Request acknowledged");
    expect(row).toBeDefined();
    expect(String(row!.message)).toContain("has been acknowledged");
    expect(String(row!.link_url)).toBe(`/portal/governance/requests/${id}`);
    expect(String(row!.type)).toBe("system");
  });

  it("N2. assignment notifies the participant and the assignee; reassign notifies only the new pair", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);
    await grant(db, TENANT_A, staff.authId, "assign_cases", true);
    const a1 = await memberOf(TENANT_A);
    const a2 = await memberOf(TENANT_A);

    const r = await submitRequest(citizen.authId, "Assign notify case");
    const id = r.rows[0].id as string;
    const ack = await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);
    expect(ack.error).toBeUndefined(); // the ladder requires acknowledged before assigned

    const asg1 = await as(
      db, "authenticated", staff.authId,
      `SELECT public.assign_governance_request($1, $2, NULL, NULL, 'yours')`, [id, a1.authId],
    );
    expect(asg1.error).toBeUndefined();

    // assignee notification with the STAFF route
    const a1Notes = await notificationsFor(a1.authId);
    const a1Row = a1Notes.rows.find((x) => x.title === "Governance case assigned to you");
    expect(a1Row).toBeDefined();
    expect(String(a1Row!.link_url)).toBe(`/portal/governance/cases/${id}`);

    // participant notification
    expect(await countNotifications(citizen.authId, "Request assigned")).toBe(1);

    // duplicate protection: the 0034 UNIQUE (request_id, assigned_to)
    // contract surfaced as a domain error BEFORE any mutation — no partial
    // state, no duplicate notifications
    const retry = await as(
      db, "authenticated", staff.authId,
      `SELECT public.assign_governance_request($1, $2, NULL, NULL, 'again')`, [id, a1.authId],
    );
    expect(retry.error).toBeDefined();
    expect(retry.error).toMatch(/already assigned/i);
    expect(await countNotifications(citizen.authId, "Request assigned")).toBe(1);
    expect(await countNotifications(a1.authId, "Governance case assigned to you")).toBe(1);

    // reassignment to a NEW assignee: new pair notified, old pair not again
    const asg2 = await as(
      db, "authenticated", staff.authId,
      `SELECT public.assign_governance_request($1, $2, NULL, NULL, 'move')`, [id, a2.authId],
    );
    expect(asg2.error).toBeUndefined();
    const a2Row = (await notificationsFor(a2.authId)).rows
      .find((x) => x.title === "Governance case assigned to you");
    expect(a2Row).toBeDefined();
    expect(await countNotifications(a1.authId, "Governance case assigned to you")).toBe(1);
    expect(await countNotifications(citizen.authId, "Request assigned")).toBe(2);
  });

  it("N3+N4+N5. information request, resolution and closure notify the participant", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await staffWithManage(TENANT_A);

    const r = await submitRequest(citizen.authId, "Full ladder case");
    const id = r.rows[0].id as string;
    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);
    await as(db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', NULL)`, [id]);

    const wait = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'awaiting_information', 'Need details')`, [id],
    );
    expect(wait.error).toBeUndefined();
    const back = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', 'Got them')`, [id],
    );
    expect(back.error).toBeUndefined();
    const res = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', 'Fixed')`, [id],
    );
    expect(res.error).toBeUndefined();
    const close = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'closed', 'Done')`, [id],
    );
    expect(close.error).toBeUndefined();

    const titles = (await notificationsFor(citizen.authId)).rows.map((x) => String(x.title));
    expect(titles).toContain("Information requested");
    expect(titles).toContain("Request resolved");
    expect(titles).toContain("Request closed");

    // in_progress transitions are deliberately silent (§16 — no noise):
    // exactly acknowledge + information + resolved + closed
    const n = await as(
      db, "authenticated", citizen.authId,
      `SELECT count(*)::int AS n FROM politicore.notifications WHERE user_id = $1`,
      [citizen.authId],
    );
    expect(Number(n.rows[0].n)).toBe(4);
  });

  it("N6. failed/illegal transitions generate no notification", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await staffWithManage(TENANT_A);
    const r = await submitRequest(citizen.authId, "Illegal edge case");
    const id = r.rows[0].id as string;

    // acknowledged → awaiting_information is not a ladder edge
    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);
    const skip = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'awaiting_information', 'skip')`, [id],
    );
    expect(skip.error).toBeDefined();

    // unauthorized actor cannot trigger the path either
    const r2 = await submitRequest(citizen.authId, "Unauthorized actor case");
    const id2 = r2.rows[0].id as string;
    const nobody = await as(
      db, "authenticated", (await memberOf(TENANT_A)).authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id2],
    );
    expect(nobody.error).toBeDefined();

    const n = await as(
      db, "authenticated", citizen.authId,
      `SELECT count(*)::int AS n FROM politicore.notifications WHERE user_id = $1 AND title = 'Request acknowledged'`,
      [citizen.authId],
    );
    expect(Number(n.rows[0].n)).toBe(1); // only the legal first acknowledgement
  });

  it("N7. same-status retries and re-acknowledge are silent no-ops", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await staffWithManage(TENANT_A);
    const r = await submitRequest(citizen.authId, "Retry case");
    const id = r.rows[0].id as string;

    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);
    // retry acknowledge on an acknowledged request: early return, no error
    const ack2 = await as(
      db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id],
    );
    expect(ack2.error).toBeUndefined();
    expect(await countNotifications(citizen.authId, "Request acknowledged")).toBe(1);

    // same-status update: early return
    const upd = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'acknowledged', NULL)`, [id],
    );
    expect(upd.error).toBeUndefined();
    expect(await countNotifications(citizen.authId, "Request acknowledged")).toBe(1);
  });

  it("N8+N9. notifications are server-resolved, tenant-safe and strictly per-user", async () => {
    const citizenA = await memberOf(TENANT_A);
    const staffA = await staffWithManage(TENANT_A);
    const citizenB = await memberOf(TENANT_B);

    const r = await submitRequest(citizenA.authId, "Isolation case");
    const id = r.rows[0].id as string;
    await as(db, "authenticated", staffA.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);

    // tenant B member: no notifications at all
    const b = await notificationsFor(citizenB.authId);
    expect(b.rows).toHaveLength(0);

    // recipient isolation: citizen A cannot read anyone else's row
    const a = await as(
      db, "authenticated", citizenA.authId,
      `SELECT count(*)::int AS n FROM politicore.notifications`,
      [],
    );
    // RLS limits the read to the caller's own rows (their one notification)
    expect(Number(a.rows[0].n)).toBe(1);
  });

  it("N10. responses — internal or public — never notify", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await staffWithManage(TENANT_A);
    const r = await submitRequest(citizen.authId, "Quiet case");
    const id = r.rows[0].id as string;

    const internal = await as(
      db, "authenticated", staff.authId,
      `SELECT public.respond_governance_request($1, 'internal note', false)`, [id],
    );
    expect(internal.error).toBeUndefined();
    const pub = await as(
      db, "authenticated", staff.authId,
      `SELECT public.respond_governance_request($1, 'public reply', true)`, [id],
    );
    expect(pub.error).toBeUndefined();

    const n = await as(
      db, "authenticated", citizen.authId,
      `SELECT count(*)::int AS n FROM politicore.notifications WHERE user_id = $1`,
      [citizen.authId],
    );
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("N11. module-disabled tenants cannot generate notifications (fail closed before mutation)", async () => {
    const offMember = await memberOf(offTenant);
    const r = await submitRequest(offMember.authId);
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/module is not enabled/i);

    // and an off-tenant staff action against an on-tenant request fails too
    const citizen = await memberOf(TENANT_A);
    const r2 = await submitRequest(citizen.authId, "Off staff case");
    const id2 = r2.rows[0].id as string;
    const offStaff = await staffWithManage(offTenant);
    const cross = await as(
      db, "authenticated", offStaff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id2],
    );
    expect(cross.error).toBeDefined();
    expect(await countNotifications(citizen.authId, "Request acknowledged")).toBe(0);
  });

  it("N12. notifications flow through the Core Notification Center contract", async () => {
    // The Center reads politicore.notifications via the security_invoker
    // view with type in the Core enum; governance rows use 'system' and
    // carry the deep link — assert exactly that shape end-to-end.
    const citizen = await memberOf(TENANT_A);
    const staff = await staffWithManage(TENANT_A);
    const r = await submitRequest(citizen.authId, "Center contract case");
    const id = r.rows[0].id as string;
    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, NULL)`, [id]);

    const viaView = await as(
      db, "authenticated", citizen.authId,
      `SELECT type, link_url, read_at FROM public.notifications WHERE user_id = $1`,
      [citizen.authId],
    );
    expect(viaView.error).toBeUndefined();
    expect(viaView.rows).toHaveLength(1);
    expect(String(viaView.rows[0].type)).toBe("system");
    expect(String(viaView.rows[0].link_url)).toBe(`/portal/governance/requests/${id}`);
    expect(viaView.rows[0].read_at).toBeNull();
  });

  it("N13. no parallel Governance notification infrastructure exists", async () => {
    const t = await as(db, "authenticated", (await adminOf(TENANT_A)).authId,
      `SELECT to_regclass('politicore.governance_notifications') IS NOT NULL AS a,
              to_regclass('politicore.case_notifications') IS NOT NULL AS b,
              to_regclass('politicore.participant_notifications') IS NOT NULL AS c,
              to_regclass('politicore.citizen_notifications') IS NOT NULL AS d`,
      []);
    expect(t.rows[0].a).toBe(false);
    expect(t.rows[0].b).toBe(false);
    expect(t.rows[0].c).toBe(false);
    expect(t.rows[0].d).toBe(false);
  });
});
