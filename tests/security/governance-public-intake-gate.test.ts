/**
 * POLITICORE — Governance Public Intake & External Participant gate (Phase 9).
 *
 * Phase 9 is an ARCHITECTURE gate: no public intake UI, no anonymous RPC,
 * no public tracking route is implemented. This suite proves the security
 * contracts the gate's decisions rest on — against the real migrations —
 * and pins the boundaries the future implementation must not cross.
 *
 *   I1  — external participant representation: contact-only row, no auth
 *         identity, no access role, no profiles row (§2/§4A)
 *   I2  — anonymous dedup: one participant per contact per tenant (§4A)
 *   I3  — anon reads nothing: requests/events/participants/categories
 *         return nothing without a session (§17)
 *   I4  — reference enumeration reveals nothing: knowing GR-… grants no
 *         access to any surface for anon (§5/§6/§9)
 *   I5  — submission authority: the submit RPC requires an authenticated
 *         participant; anon cannot file; no client-supplied tenant/actor
 *         parameters exist to override (§4B/§23)
 *   I6  — submission cannot mint assignments (§23)
 *   I7  — privacy: event is_public is immutable (append-only) for every
 *         application role — internal events cannot become public (§8/§19)
 *   I8  — module gate: Governance OFF rejects the (future) public path —
 *         enforced today on the authenticated path and by every RPC (§16)
 *   I9  — audit capacity: system_audits accepts actor_id = NULL with
 *         actor_name/actor_email (external attribution needs no schema
 *         change) (§18)
 *   I10 — reference-code entropy: GR-YYYY-XXXXXXXX carries ~32 bits —
 *         an identifier, never a credential (documented decision, pinned
 *         in the gate document; the tracking secret is the credential)
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  as,
  createTenant,
  createUser,
  getDb,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: PGlite;

// pg rows are untyped; the suites read known columns.
function cell(row: unknown, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "govp-a", "Gov Public A", { governance: true }, TENANT_A);
  await createTenant(db, "govp-b", "Gov Public B", { governance: true }, TENANT_B);
});

describe("Governance public intake architecture gate (Phase 9)", () => {
  it("I1. external participant: contact-only domain record, zero portal identity", async () => {
    // The representation Phase 6 permits and the gate formalizes:
    // profile_id NULL, contact present, no auth.users row, no access role.
    const pid = crypto.randomUUID();
    await db.query(
      `INSERT INTO politicore.governance_participants (id, tenant_id, full_name, email)
       VALUES ($1, $2, 'External Person', ${"'"}external-${pid.slice(0, 8)}@example.com${"'"})`,
      [pid, TENANT_A],
    );
    const row = await db.query(
      `SELECT gp.profile_id, gp.email, gp.display_label, p.id AS profile_row,
              p.access_role
         FROM politicore.governance_participants gp
         LEFT JOIN politicore.profiles p ON p.id = gp.profile_id
        WHERE gp.id = $1`, [pid],
    );
    expect(row.rows).toHaveLength(1);
    expect(cell(row.rows[0], "profile_id")).toBeNull();
    expect(cell(row.rows[0], "profile_row")).toBeNull();     // no profiles row
    expect(cell(row.rows[0], "access_role")).toBeNull();     // no access role
    expect(String(cell(row.rows[0], "email"))).toContain("@example.com");

    // no auth identity exists for the external participant
    const auth = await db.query(
      `SELECT count(*)::int AS n FROM auth.users
        WHERE email = (SELECT email FROM politicore.governance_participants WHERE id = $1)`,
      [pid],
    );
    expect(Number(cell(auth.rows[0], "n"))).toBe(0);
  });

  it("I2. anonymous participants deduplicate by contact per tenant", async () => {
    const a = crypto.randomUUID();
    const email = `dedup-${a.slice(0, 8)}@example.com`;
    await db.query(
      `INSERT INTO politicore.governance_participants (tenant_id, full_name, email)
       VALUES ($1, 'Dup One', $2)`, [TENANT_A, email],
    );
    // same email, same tenant → rejected by the partial unique index
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO politicore.governance_participants (tenant_id, full_name, email)
         VALUES ($1, 'Dup Two', $2)`, [TENANT_A, email.toUpperCase()],
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    // same email, different tenant → a separate tenant-scoped record (correct)
    const b = await db.query(
      `INSERT INTO politicore.governance_participants (tenant_id, full_name, email)
       VALUES ($1, 'Dup Cross', $2) RETURNING id`, [TENANT_B, email],
    );
    expect(b.rows).toHaveLength(1);
  });

  it("I3. anon reads nothing on any governance surface", async () => {
    for (const view of [
      "governance_requests", "governance_request_events",
      "governance_participants", "governance_request_categories",
      "governance_assignments",
    ]) {
      const r = await as(db, "anon", "", `SELECT * FROM public.${view}`, []);
      const rows = Array.isArray(r.rows) ? r.rows : [];
      const denied = r.error !== undefined || rows.length === 0;
      expect(denied).toBe(true);
    }
  });

  it("I4. knowing a reference code reveals nothing to anon (enumeration is dead)", async () => {
    const m = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Ref Owner",
      accessRole: "member",
      membershipTypes: ["campaign_member"],
    });
    const r = await as(
      db, "authenticated", m.authId,
      "SELECT public.submit_governance_request($1, $2) AS id",
      ["Enumeration probe", "d"],
    );
    const id = r.rows[0].id as string;
    const ref = await db.query(
      `SELECT reference_code FROM politicore.governance_requests WHERE id = $1`, [id],
    );
    const reference = String(cell(ref.rows[0], "reference_code"));
    expect(reference).toMatch(/^GR-\d{4}-[0-9A-F]{8}$/);

    // anon query by exact reference: no row, no error channel that leaks
    const leak = await as(
      db, "anon", "",
      `SELECT id FROM public.governance_requests WHERE reference_code = $1`, [reference],
    );
    const leakRows = Array.isArray(leak.rows) ? leak.rows : [];
    expect(leak.error !== undefined || leakRows.length === 0).toBe(true);
  });

  it("I5. the submit RPC requires an authenticated participant; anon cannot file", async () => {
    const r = await as(
      db, "anon", "",
      "SELECT public.submit_governance_request($1, $2) AS id",
      ["Anon filing attempt", "should fail"],
    );
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/authenticated participant required/i);

    // no tenant/actor parameters exist on the authority surface to override
    const sig = await db.query(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'politicore' AND p.proname = 'submit_governance_request'`,
    );
    expect(String(cell(sig.rows[0], "args"))).not.toMatch(/tenant|actor|profile/);
  });

  it("I6. submission cannot mint assignments or mutate the queue", async () => {
    const m = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Sub Only",
      accessRole: "member",
      membershipTypes: ["campaign_member"],
    });
    const r = await as(
      db, "authenticated", m.authId,
      "SELECT public.submit_governance_request($1, $2) AS id",
      ["No-assign case", "d"],
    );
    const id = r.rows[0].id as string;
    const asg = await db.query(
      `SELECT count(*)::int AS n FROM politicore.governance_assignments WHERE request_id = $1`, [id],
    );
    expect(Number(cell(asg.rows[0], "n"))).toBe(0);

    // and the submitter cannot insert an assignment row directly (write policy)
    const direct = await as(
      db, "authenticated", m.authId,
      `INSERT INTO public.governance_assignments
         (tenant_id, request_id, assigned_to, assigned_by)
       VALUES (politicore.current_tenant_id(), $1, auth.uid(), auth.uid()) RETURNING id`, [id],
    );
    expect(direct.error).toBeDefined();
  });

  it("I7. internal events cannot become public (visibility is insert-time, append-only)", async () => {
    const m = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Event Owner",
      accessRole: "member",
      membershipTypes: ["campaign_member"],
    });
    const r = await as(
      db, "authenticated", m.authId,
      "SELECT public.submit_governance_request($1, $2) AS id",
      ["Visibility case", "d"],
    );
    const id = r.rows[0].id as string;
    const ev = await db.query(
      `SELECT id FROM politicore.governance_request_events WHERE request_id = $1`, [id],
    );
    const eid = String(cell(ev.rows[0], "id"));

    // no application role can flip is_public on an existing event
    // (no UPDATE policy exists → default deny; append-only trail)
    const admin = await createUser(db, {
      tenantId: TENANT_A,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Event Admin",
      accessRole: "admin",
      membershipTypes: ["campaign_member"],
    });
    const flip = await as(
      db, "authenticated", admin.authId,
      `UPDATE public.governance_request_events SET is_public = true WHERE id = $1`, [eid],
    );
    expect(flip.error).toBeDefined();

    const state = await db.query(
      `SELECT is_public FROM politicore.governance_request_events WHERE id = $1`, [eid],
    );
    expect(cell(state.rows[0], "is_public")).toBe(false);
  });

  it("I8. the module gate binds every authority path — Governance OFF rejects submission", async () => {
    const offTenant = await createTenant(db, "govp-off", "Gov Public Off", { governance: false });
    const m = await createUser(db, {
      tenantId: offTenant,
      email: `${crypto.randomUUID()}@test.local`,
      fullName: "Off Member",
      accessRole: "member",
      membershipTypes: ["campaign_member"],
    });
    const r = await as(
      db, "authenticated", m.authId,
      "SELECT public.submit_governance_request($1, $2) AS id",
      ["Should not land", "d"],
    );
    expect(r.error).toBeDefined();
    expect(r.error).toMatch(/module is not enabled/i);
  });

  it("I9. audit capacity: external attribution fits system_audits with actor_id NULL", async () => {
    const ins = await db.query(
      `INSERT INTO politicore.system_audits
         (tenant_id, actor_id, actor_name, actor_email, action, affected_resource, resource_id)
       VALUES ($1, NULL, 'External Person', 'ext@example.com',
               'governance_requests:public_insert', 'governance_requests', $2)
       RETURNING id, actor_id, actor_name`,
      [TENANT_A, crypto.randomUUID()],
    );
    expect(ins.rows).toHaveLength(1);
    expect(cell(ins.rows[0], "actor_id")).toBeNull();
    expect(String(cell(ins.rows[0], "actor_name"))).toBe("External Person");
    await db.query(`DELETE FROM politicore.system_audits WHERE id = $1`, [cell(ins.rows[0], "id")]);
  });

  it("I10. reference codes are ~32-bit identifiers — pinned so they are never treated as credentials", async () => {
    // 8 hex chars = 32 bits: enumerable at scale, deterministic from the id.
    // The gate therefore REQUIRES a separate high-entropy tracking secret
    // (hash-stored, shown once) as the external tracking credential.
    const r = await db.query(
      `SELECT politicore.governance_reference(now(), gen_random_uuid()) AS ref`,
    );
    const ref = String(cell(r.rows[0], "ref"));
    expect(ref).toMatch(/^GR-\d{4}-[0-9A-F]{8}$/);
    const secretPart = ref.split("-")[2];
    expect(secretPart).toHaveLength(8); // 32 bits — NOT sufficient for auth
  });
});
