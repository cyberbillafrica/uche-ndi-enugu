/**
 * POLITICORE — Governance & Citizen Engagement architecture gate (Phase 6).
 *
 * Local PGlite verification on the real migrations (0001–0034) of the
 * Governance first-slice contracts:
 *
 *   1. MODULE GATE: submission fails closed when the governance module is
 *      disabled for the caller's tenant (§8 — independent activation).
 *   2. PARTICIPANT MODEL: submission provisions a participant linked to
 *      the caller's profile (1:1); anonymous participants are a domain
 *      record (contact-based), never an access role (§10/§11).
 *   3. OWNERSHIP: the submitting participant reads their own request;
 *      other members cannot; the staff queue requires view_cases (§14).
 *   4. LIFECYCLE RPCs: acknowledge → assign → progress → resolve flow
 *      through authority RPCs with server-resolved actor/tenant; the
 *      status ladder trigger rejects illegal transitions; assignees must
 *      belong to the same tenant (§9/§15).
 *   5. EVENTS: staff internal responses are invisible to the participant,
 *      public responses and the participant's own events are visible;
 *      the trail is append-only (no UPDATE/DELETE path) (§14/§16).
 *   6. FEEDBACK: only the owning participant may rate a resolved request,
 *      once (§24 citizen feedback).
 *   7. AUDIT: governance mutations land in the canonical system_audits
 *      stream with server-side actor attribution — no parallel audit
 *      table (§16).
 *   8. ISOLATION: cross-tenant staff get "request not found"; anon gets
 *      nothing (submission fails closed on missing profile).
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
  await createTenant(db, "gov-a", "Governance A", { governance: true }, TENANT_A);
  await createTenant(db, "gov-b", "Governance B", { governance: true }, TENANT_B);
});

async function memberOf(tenantId: string) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Gov Fixture",
    accessRole: "member",
    membershipTypes: ["campaign_member"],
  });
}

async function submitRequest(uid: string, title = "Fix the ward road") {
  const r = await as(
    db, "authenticated", uid,
    "SELECT public.submit_governance_request($1, $2) AS id",
    [title, "Large potholes near the market"],
  );
  return r;
}

beforeAll(async () => {
  // permission grants are inserted after users exist in each test below
});

describe("Governance architecture gate (Phase 6)", () => {
  it("1. submission fails closed when the module is disabled", async () => {
    const tenantC = await createTenant(db, "gov-c", "Governance C", { governance: false });
    const m = await memberOf(tenantC);
    const r = await submitRequest(m.authId);
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/module is not enabled/i);
  });

  it("2. submission provisions a linked participant + reference + submitted event", async () => {
    const m = await memberOf(TENANT_A);
    const r = await submitRequest(m.authId);
    expect(r.error).toBeUndefined();
    const id = r.rows[0].id as string;
    expect(id).toBeTruthy();

    // participant row linked 1:1 to the caller's profile
    const p = await as(
      db, "authenticated", m.authId,
      `SELECT profile_id, full_name FROM public.governance_participants WHERE profile_id = $1`,
      [m.authId],
    );
    expect(p.error).toBeUndefined();
    expect(p.rows).toHaveLength(1);

    // human reference + initial state
    const req = await as(
      db, "authenticated", m.authId,
      `SELECT reference_code, status FROM public.governance_requests WHERE id = $1`,
      [id],
    );
    expect(req.rows[0].reference_code).toMatch(/^GR-\d{4}-[0-9A-F]{8}$/);
    expect(req.rows[0].status).toBe("submitted");

    // submitted event authored by the participant
    const ev = await as(
      db, "authenticated", m.authId,
      `SELECT kind FROM public.governance_request_events WHERE request_id = $1`,
      [id],
    );
    expect(ev.rows.map((x) => x.kind)).toContain("submitted");
  });

  it("3. ownership: owner reads own request; other members cannot", async () => {
    const owner = await memberOf(TENANT_A);
    const other = await memberOf(TENANT_A);
    const r = await submitRequest(owner.authId, "Water supply");
    const id = r.rows[0].id as string;

    const own = await as(
      db, "authenticated", owner.authId,
      `SELECT id FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(own.rows).toHaveLength(1);

    const stranger = await as(
      db, "authenticated", other.authId,
      `SELECT id FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(stranger.rows).toHaveLength(0);
  });

  it("4. staff queue requires view_cases; non-staff members see others' requests only", async () => {
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "view_cases", true);
    const citizen = await memberOf(TENANT_A);
    const plain = await memberOf(TENANT_A);
    await submitRequest(citizen.authId, "Queue probe");

    const q1 = await as(
      db, "authenticated", staff.authId,
      `SELECT count(*)::int AS n FROM public.governance_requests WHERE title = 'Queue probe'`,
    );
    expect(q1.rows[0].n).toBeGreaterThan(0);

    // a non-staff member sees only their OWN requests, not the queue
    const q2 = await as(
      db, "authenticated", plain.authId,
      `SELECT count(*)::int AS n FROM public.governance_requests WHERE title = 'Queue probe'`,
    );
    expect(q2.rows[0].n).toBe(0);
  });

  it("5. lifecycle RPCs drive the ladder and validate assignee tenancy", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    const assignee = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);
    await grant(db, TENANT_A, staff.authId, "assign_cases", true);

    const r = await submitRequest(citizen.authId, "Ladder case");
    const id = r.rows[0].id as string;

    const ack = await as(
      db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, 'Received')`, [id],
    );
    expect(ack.error).toBeUndefined();

    // assignee from another tenant is rejected
    const strangerStaff = await memberOf(TENANT_B);
    const badAssign = await as(
      db, "authenticated", staff.authId,
      `SELECT public.assign_governance_request($1, $2, NULL, NULL, 'x')`,
      [id, strangerStaff.authId],
    );
    expect(badAssign.error).toBeDefined();
    expect(badAssign.error).toMatch(/same tenant/i);

    const asg = await as(
      db, "authenticated", staff.authId,
      `SELECT public.assign_governance_request($1, $2, 'ward', ' ward-1 ', 'Please handle')`,
      [id, assignee.authId],
    );
    expect(asg.error).toBeUndefined();

    const prog = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', 'Started')`, [id],
    );
    expect(prog.error).toBeUndefined();

    const res = await as(
      db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', 'Fixed')`, [id],
    );
    expect(res.error).toBeUndefined();

    const state = await as(
      db, "authenticated", staff.authId,
      `SELECT status, assigned_profile_id, resolved_at FROM public.governance_requests WHERE id = $1`,
      [id],
    );
    expect(state.rows[0].status).toBe("resolved");
    expect(state.rows[0].assigned_profile_id).toBe(assignee.authId);
    expect(state.rows[0].resolved_at).not.toBeNull();

    // assignment row recorded
    const arow = await as(
      db, "authenticated", staff.authId,
      `SELECT assigned_to FROM public.governance_assignments WHERE request_id = $1`, [id],
    );
    expect(arow.rows[0].assigned_to).toBe(assignee.authId);
  });

  it("6. illegal status transitions are rejected by the ladder guard", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);
    const r = await submitRequest(citizen.authId, "Guard case");
    const id = r.rows[0].id as string;

    // submitted → in_progress skips the ladder (staff passes the UPDATE
    // policy, so the guard trigger is what must reject it; a non-staff
    // UPDATE would silently no-op via RLS USING(false) instead).
    const skip = await as(
      db, "authenticated", staff.authId,
      `UPDATE public.governance_requests SET status = 'in_progress' WHERE id = $1`, [id],
    );
    expect(skip.error).toBeDefined();
    expect(skip.error).toMatch(/illegal status transition/i);

    // a non-staff UPDATE is a silent no-op (RLS USING(false)) — state must
    // be unchanged, never errored into visibility
    const noop = await as(
      db, "authenticated", citizen.authId,
      `UPDATE public.governance_requests SET status = 'closed' WHERE id = $1`, [id],
    );
    expect(noop.error).toBeUndefined();
    const state = await as(
      db, "authenticated", staff.authId,
      `SELECT status::text AS s FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(state.rows[0].s).toBe("submitted");
  });

  it("7. events privacy: internal staff notes invisible to the participant", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);
    const r = await submitRequest(citizen.authId, "Privacy case");
    const id = r.rows[0].id as string;

    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, '')`, [id]);
    // internal note
    const internal = await as(
      db, "authenticated", staff.authId,
      `SELECT public.respond_governance_request($1, 'Internal: verify contractor', false)`,
      [id],
    );
    expect(internal.error).toBeUndefined();
    // public reply
    const pub = await as(
      db, "authenticated", staff.authId,
      `SELECT public.respond_governance_request($1, 'We are on it', true)`, [id],
    );
    expect(pub.error).toBeUndefined();

    const seen = await as(
      db, "authenticated", citizen.authId,
      `SELECT body, is_public FROM public.governance_request_events
        WHERE request_id = $1 AND kind = 'staff_response'`, [id],
    );
    const bodies = seen.rows.map((x) => String(x.body));
    expect(bodies).toContain("We are on it");
    expect(bodies).not.toContain("Internal: verify contractor");
  });

  it("8. the event trail is append-only for every role", async () => {
    const admin = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Gov Admin",
      accessRole: "admin",
      membershipTypes: ["campaign_member"],
    });
    const anyEvent = await as(
      db, "authenticated", admin.authId,
      `SELECT id FROM public.governance_request_events LIMIT 1`,
    );
    expect(anyEvent.rows.length).toBeGreaterThan(0);
    const eid = anyEvent.rows[0].id;

    const upd = await as(
      db, "authenticated", admin.authId,
      `UPDATE public.governance_request_events SET body = 'tampered' WHERE id = $1`, [eid],
    );
    expect(upd.error).toBeDefined();

    const del = await as(
      db, "authenticated", admin.authId,
      `DELETE FROM public.governance_request_events WHERE id = $1`, [eid],
    );
    expect(del.error).toBeDefined();
  });

  it("9. feedback: owner-only, resolved-only, once", async () => {
    const citizen = await memberOf(TENANT_A);
    const staff = await memberOf(TENANT_A);
    await grant(db, TENANT_A, staff.authId, "manage_cases", true);
    const r = await submitRequest(citizen.authId, "Feedback case");
    const id = r.rows[0].id as string;

    // cannot rate before resolution
    const early = await as(
      db, "authenticated", citizen.authId,
      `SELECT public.rate_governance_request($1, 5, 'early')`, [id],
    );
    expect(early.error).toBeDefined();

    await as(db, "authenticated", staff.authId,
      `SELECT public.acknowledge_governance_request($1, '')`, [id]);
    // walk the ladder: acknowledged -> in_progress -> resolved
    // (skipping straight to resolved is correctly rejected by the guard)
    const skip = await as(db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', 'skip')`, [id]);
    expect(skip.error).toMatch(/illegal status transition/i);
    await as(db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'in_progress', 'working')`, [id]);
    await as(db, "authenticated", staff.authId,
      `SELECT public.update_governance_request_status($1, 'resolved', 'done')`, [id]);

    const rate = await as(
      db, "authenticated", citizen.authId,
      `SELECT public.rate_governance_request($1, 5, 'thank you')`, [id],
    );
    expect(rate.error).toBeUndefined();

    const again = await as(
      db, "authenticated", citizen.authId,
      `SELECT public.rate_governance_request($1, 4, 'again')`, [id],
    );
    expect(again.error).toBeDefined();
    expect(again.error).toMatch(/already recorded/i);

    const stored = await as(
      db, "authenticated", citizen.authId,
      `SELECT feedback_rating, feedback_comment FROM public.governance_requests WHERE id = $1`,
      [id],
    );
    expect(stored.rows[0].feedback_rating).toBe(5);
    expect(stored.rows[0].feedback_comment).toBe("thank you");
  });

  it("10. mutations land in the canonical audit stream with actor attribution", async () => {
    const citizen = await memberOf(TENANT_A);
    const r = await submitRequest(citizen.authId, "Audit case");
    const id = r.rows[0].id as string;

    // The canonical 0002 audit stream is tenant-scoped readable; the
    // governance insert must appear with server-side actor attribution.
    const audits = await as(
      db, "authenticated", citizen.authId,
      `SELECT action, resource_id, actor_id FROM politicore.system_audits
        WHERE affected_resource = 'governance_requests' AND resource_id = $1`,
      [id],
    );
    expect(audits.error).toBeUndefined();
    expect(audits.rows).toHaveLength(1);
    expect(String(audits.rows[0].action)).toMatch(/governance_requests:insert/i);
    expect(audits.rows[0].actor_id).toBe(citizen.authId);
  });

  it("11. anonymous sessions: no reads, no writes, fail closed", async () => {
    const anonRead = await as(
      db, "anon", null,
      `SELECT count(*)::int AS n FROM public.governance_requests`,
    );
    expect(anonRead.error).toBeDefined();

    const anonSubmit = await as(
      db, "anon", null,
      `SELECT public.submit_governance_request('x', 'y')`,
    );
    expect(anonSubmit.error).toBeDefined();
    expect(anonSubmit.error).toMatch(/authenticated participant required/i);
  });

  it("12. cross-tenant staff are fully isolated (request not found)", async () => {
    const citizen = await memberOf(TENANT_A);
    const staffB = await memberOf(TENANT_B);
    await grant(db, TENANT_B, staffB.authId, "manage_cases", true);
    await grant(db, TENANT_B, staffB.authId, "view_cases", true);
    const r = await submitRequest(citizen.authId, "Isolation case");
    const id = r.rows[0].id as string;

    const read = await as(
      db, "authenticated", staffB.authId,
      `SELECT id FROM public.governance_requests WHERE id = $1`, [id],
    );
    expect(read.rows).toHaveLength(0);

    const ack = await as(
      db, "authenticated", staffB.authId,
      `SELECT public.acknowledge_governance_request($1, 'x')`, [id],
    );
    expect(ack.error).toBeDefined();
    expect(ack.error).toMatch(/request not found/i);
  });

  it("13. categories: admin-managed; members read active only", async () => {
    const admin = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Gov Admin 2",
      accessRole: "admin",
      membershipTypes: ["campaign_member"],
    });
    const cat = await as(
      db, "authenticated", admin.authId,
      `INSERT INTO public.governance_request_categories (tenant_id, name)
        VALUES ($1, 'Infrastructure') RETURNING id`, [TENANT_A],
    );
    expect(cat.error).toBeUndefined();
    const catId = cat.rows[0].id as string;

    await as(db, "authenticated", admin.authId,
      `UPDATE public.governance_request_categories SET is_active = false WHERE id = $1`, [catId]);

    const member = await memberOf(TENANT_A);
    const memberView = await as(
      db, "authenticated", member.authId,
      `SELECT id FROM public.governance_request_categories WHERE id = $1`, [catId],
    );
    expect(memberView.rows).toHaveLength(0); // inactive hidden from members

    const staffView = await as(
      db, "authenticated", admin.authId,
      `SELECT id FROM public.governance_request_categories WHERE id = $1`, [catId],
    );
    expect(staffView.rows).toHaveLength(1);

    const memberWrite = await as(
      db, "authenticated", member.authId,
      `INSERT INTO public.governance_request_categories (tenant_id, name)
        VALUES ($1, 'Rogue')`, [TENANT_A],
    );
    expect(memberWrite.error).toBeDefined();
  });

  it("14. anonymous participants are domain records, not access roles", async () => {
    const admin = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Gov Admin 3",
      accessRole: "admin",
      membershipTypes: ["campaign_member"],
    });
    // anonymous participant (no auth identity, contact-based)
    const anonP = await as(
      db, "authenticated", admin.authId,
      `INSERT INTO public.governance_participants (tenant_id, full_name, email, display_label)
        VALUES ($1, 'Ada Obi', 'ada.obi@example.com', 'Constituent') RETURNING id`,
      [TENANT_A],
    );
    expect(anonP.error).toBeUndefined();

    // no identity at all is invalid
    const ghost = await as(
      db, "authenticated", admin.authId,
      `INSERT INTO public.governance_participants (tenant_id, full_name)
        VALUES ($1, 'Ghost')`, [TENANT_A],
    );
    expect(ghost.error).toBeDefined();

    // a member cannot mint a participant for someone else
    const member = await memberOf(TENANT_A);
    const forged = await as(
      db, "authenticated", member.authId,
      `INSERT INTO public.governance_participants (tenant_id, profile_id, full_name)
        VALUES ($1, $2, 'Forged')`,
      [TENANT_A, admin.authId],
    );
    expect(forged.error).toBeDefined();
  });
});
