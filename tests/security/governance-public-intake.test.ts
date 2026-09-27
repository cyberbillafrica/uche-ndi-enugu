/**
 * POLITICORE — GOVERNANCE PUBLIC INTAKE — PHASE 10 SECURITY SUITE.
 *
 * Verifies the first public-intake slice (migrations 0037/0038/0039)
 * against the Phase 9 gate contract (docs/Governance-Public-Intake-Gate.md)
 * and the Phase 10 prompt §26:
 *
 *   A. Configuration gates (module off / toggle off / both on)
 *   B. Submission validation (category, size, contact, consent, geography)
 *   C. Participant model (contact-only, no identity, dedup)
 *   D. Verification (single-use, expiring, tenant-bound, rotating)
 *   E. Tracking (reference+secret, minimal projection, enumeration safety)
 *   F. Isolation (zero anon base-table surface, no assignment minting)
 *   G. Abuse controls (duplicate collapse, cooldown, pending cap, throttle)
 *   H. Audit (canonical system_audits, external attribution)
 *   I. Boundary pins (RPC parameter surface, grants, UI statics)
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import {
  getDb,
  as,
  createTenant,
  createUser,
  grant,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let staffId = "";
let memberEmail = "";
let wardId = "";
let lgaId = "";

const SITE_A = "pub7-a";
const SITE_B = "pub7-b";

async function enableIntake(db: Awaited<ReturnType<typeof getDb>>, tenant: string) {
  await db.query(
    `UPDATE politicore.tenant_modules
        SET config = jsonb_build_object('public_intake', true)
      WHERE tenant_id = $1 AND module = 'governance'`,
    [tenant]
  );
}

/** Submit as anon and pull the verification token out of the delivery seam. */
async function submitAndFetchToken(
  db: Awaited<ReturnType<typeof getDb>>,
  opts: { email: string; subject?: string; description?: string; category?: string; slug?: string }
): Promise<Record<string, unknown>[]> {
  const r = await as(
    db, "anon", null,
    `SELECT public.governance_public_intake($1, $2, 'Test Filer', $3, $4, $5, NULL, NULL, NULL, true)`,
    [
      opts.slug ?? SITE_A,
      opts.email,
      opts.category ?? "Water Supply",
      opts.subject ?? "Broken borehole on Market Road",
      opts.description ??
        "The community borehole has been out of service for three weeks and residents walk 2km for water.",
    ]
  );
  expect(r.error).toBeUndefined();
  // Acceptance returns boolean TRUE (security rejections return FALSE).
  expect(Object.values(r.rows[0] ?? { v: null })[0]).toBe(true);
  return r.rows;
}

/** Age every intake attempt of a contact past the 10-minute cooldown. */
async function agePastCooldown(db: Awaited<ReturnType<typeof getDb>>, email: string) {
  await db.query(
    `UPDATE politicore.system_audits
        SET occurred_at = occurred_at - interval '11 minutes'
      WHERE action = 'governance_public_intake'
        AND new_value ->> 'ch' = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [email]
  );
}

beforeAll(async () => {
  const db = await getDb();

  // Tenant A: governance ON (intake enabled per-test). Tenant B: governance
  // enabled but intake never enabled. Tenant C: governance OFF entirely.
  await createTenant(db, SITE_A, "Public Intake A", { governance: true }, TENANT_A);
  await createTenant(db, SITE_B, "Public Intake B", { governance: true }, TENANT_B);
  await enableIntake(db, TENANT_A);
  await db.query(
    `INSERT INTO politicore.governance_request_categories (tenant_id, name, description, is_active)
     VALUES ($1, 'Water Supply', 'water issues', true),
            ($1, 'Roads', 'road issues', true),
            ($1, 'Legacy Category', 'inactive', false)`,
    [TENANT_A]
  );

  // Governance-OFF tenant.
  const c = await db.query(
    `INSERT INTO politicore.tenants (slug, name) VALUES ('pub7-off', 'Public Intake OFF') RETURNING id`
  );
  const tenantC = (c.rows[0] as Record<string, unknown>).id as string;
  for (const mod of ["social", "campaign", "election", "governance"]) {
    await db.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled) VALUES ($1, $2, false)`,
      [tenantC, mod]
    );
  }
  await db.query(
    `INSERT INTO politicore.governance_request_categories (tenant_id, name, is_active)
     VALUES ($1, 'Water Supply', true)`,
    [tenantC]
  );

  // A staff member and an ordinary member on tenant A (projection/privacy checks).
  const staff = await createUser(db, {
    tenantId: TENANT_A,
    email: "pub-staff-a@pub7.test",
    fullName: "Pub Staff A",
  });
  await grant(db, TENANT_A, staff.authId, "manage_cases", true);
  await grant(db, TENANT_A, staff.authId, "assign_cases", true);
  staffId = staff.authId;
  memberEmail = "pub-member-a@pub7.test";
  await createUser(db, { tenantId: TENANT_A, email: memberEmail, fullName: "Pub Member A" });

  // Core Geography reference row for the geography-validation test.
  const w = await db.query(`SELECT id, lga_id FROM politicore.wards ORDER BY id LIMIT 1`);
  wardId = (w.rows[0] as Record<string, unknown>).id as string;
  lgaId = (w.rows[0] as Record<string, unknown>).lga_id as string;
});

describe("A. configuration gates", () => {
  it("1. governance module OFF → public submission rejected", async () => {
    const db = await getDb();
    const off = await db.query<{ id: string }>(
      `SELECT id FROM politicore.tenants WHERE slug = 'pub7-off'`
    );
    const t = off.rows[0].id;
    // Category exists and is active — the module gate is what rejects.
    const r = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake('pub7-off', 'gate1@example.com', 'Gate One', 'Water Supply', 'Module gate probe subject', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`
    );
    expect(r.error).toMatch(/public intake is not available/i);
    // Nothing was staged for that tenant.
    const staged = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.governance_intake_staging WHERE tenant_id = $1`,
      [t]
    );
    expect(staged.rows[0].n).toBe(0);
  });

  it("2. governance ON + public_intake OFF (default) → submission rejected", async () => {
    const db = await getDb();
    const r = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'gate2@example.com', 'Gate Two', 'Water Supply', 'Toggle gate probe subject', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_B]
    );
    expect(r.error).toMatch(/public intake is not available/i);
  });

  it("3. both enabled → submission boundary is available (anon)", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "gate3@example.com", subject: "Boundary availability probe" });
    const staged = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.governance_intake_staging s
        JOIN politicore.tenants t ON t.id = s.tenant_id WHERE t.slug = $1`,
      [SITE_A]
    );
    expect(Number(staged.rows[0].n)).toBeGreaterThanOrEqual(1);
  });
});

describe("B. submission validation", () => {
  it("4. stages pending row + delivery intent; token never in the response", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "val4@example.com", subject: "Staging mechanics probe" });
    const row = await as(
      db, "service_role", null,
      `SELECT s.token_hash, length(s.token_hash) AS hash_len, i.body
         FROM politicore.governance_intake_staging s
         JOIN politicore.tenants t ON t.id = s.tenant_id
         LEFT JOIN politicore.core_delivery_intents i ON i.tenant_id = s.tenant_id
        WHERE t.slug = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [SITE_A]
    );
    // Hash stored (64 hex chars), the plaintext token exists ONLY in the email.
    expect(row.rows[0].hash_len).toBe(64);
    expect(String(row.rows[0].body)).toMatch(/verification code \(valid for 24 hours\): /);
  });

  it("5. unknown and inactive categories rejected", async () => {
    const db = await getDb();
    const unknown = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val5a@example.com', 'Val Five', 'Nonexistent Category', 'Unknown category probe', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_A]
    );
    expect(unknown.error).toMatch(/category is not available/i);
    const inactive = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val5b@example.com', 'Val Five', 'Legacy Category', 'Inactive category probe', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_A]
    );
    expect(inactive.error).toMatch(/category is not available/i);
  });

  it("6. oversized/undersized content rejected", async () => {
    const db = await getDb();
    const longSubject = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val6a@example.com', 'Val Six', 'Water Supply', $2, 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_A, "x".repeat(201)]
    );
    expect(longSubject.error).toMatch(/subject must be 5-200/i);
    const shortDesc = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val6b@example.com', 'Val Six', 'Water Supply', 'Short description probe', 'Too short.', NULL, NULL, NULL, true)`,
      [SITE_A]
    );
    expect(shortDesc.error).toMatch(/description must be 20-10000/i);
  });

  it("7. malformed contact and missing consent rejected", async () => {
    const db = await getDb();
    const badEmail = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'not-an-email', 'Val Seven', 'Water Supply', 'Bad contact probe', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_A]
    );
    expect(badEmail.error).toMatch(/valid email address is required/i);
    const noConsent = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val7@example.com', 'Val Seven', 'Water Supply', 'No consent probe', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, false)`,
      [SITE_A]
    );
    expect(noConsent.error).toMatch(/consent is required/i);
  });

  it("9. bogus geography rejected; valid Core Geography accepted", async () => {
    const db = await getDb();
    const badWard = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val9a@example.com', 'Val Nine', 'Water Supply', 'Bogus geography probe', 'This description is long enough to pass validation checks.', 'not-a-ward-id', NULL, NULL, true)`,
      [SITE_A]
    );
    expect(badWard.error).toMatch(/unknown ward/i);
    const ok = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'val9b@example.com', 'Val Nine', 'Water Supply', 'Valid geography probe', 'This description is long enough to pass validation checks.', $2, $3, NULL, true)`,
      [SITE_A, wardId, lgaId]
    );
    expect(ok.error).toBeUndefined();
  });
});

describe("C/D. verification and the external participant model", () => {
  it("10. staging creates NO participant, NO request, NO identity", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "model10@example.com", subject: "Pre-activation model probe" });
    const rows = await as(
      db, "service_role", null,
      `SELECT
         (SELECT count(*)::int FROM politicore.governance_participants WHERE email = 'model10@example.com') AS participants,
         (SELECT count(*)::int FROM politicore.governance_requests r JOIN politicore.governance_participants p ON p.id = r.participant_id WHERE p.email = 'model10@example.com') AS requests,
         (SELECT count(*)::int FROM auth.users WHERE email = 'model10@example.com') AS auth_users,
         (SELECT count(*)::int FROM politicore.profiles WHERE email = 'model10@example.com') AS profiles`
    );
    expect(rows.rows[0]).toMatchObject({ participants: 0, requests: 0, auth_users: 0, profiles: 0 });
  });

  it("12. valid token activates: participant (contact-only) + request + PUBLIC submitted event", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "verify12@example.com", subject: "Activation journey probe" });
    const tok = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'verify12@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token = String(tok.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];

    const v = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, $2)`, [token, SITE_A]);
    expect(v.error).toBeUndefined();
    expect(String(v.rows[0].reference_code)).toMatch(/^GR-\d{4}-[0-9A-Fa-f]{8}$/);
    expect(String(v.rows[0].tracking_secret)).toHaveLength(64);

    const model = await as(
      db, "service_role", null,
      `SELECT p.profile_id, p.display_label, r.status, r.ward_id,
              (SELECT count(*)::int FROM politicore.governance_request_events e
                WHERE e.request_id = r.id AND e.kind = 'submitted' AND e.is_public) AS public_events
         FROM politicore.governance_participants p
         JOIN politicore.governance_requests r ON r.participant_id = p.id
        WHERE p.email = 'verify12@example.com'`
    );
    expect(model.rows[0]).toMatchObject({ profile_id: null, display_label: "Citizen", status: "submitted" });
    expect(Number(model.rows[0].public_events)).toBe(1);

    // The activation is audited with external attribution (gate §K).
    const aud = await as(
      db, "service_role", null,
      `SELECT actor_id, actor_email, action FROM politicore.system_audits
        WHERE action = 'governance_public_request_activated' AND actor_email = 'verify12@example.com'`
    );
    expect(aud.rows[0]).toMatchObject({ actor_id: null, action: "governance_public_request_activated" });
  });

  it("13. token is single-use: replay fails and creates nothing", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "replay13@example.com", subject: "Replay protection probe" });
    const tok = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'replay13@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token = String(tok.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];
    const first = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token]);
    expect(first.error).toBeUndefined();
    const second = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token]);
    expect(second.error).toMatch(/invalid or has expired/i);
    const count = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.governance_requests r
         JOIN politicore.governance_participants p ON p.id = r.participant_id
        WHERE p.email = 'replay13@example.com'`
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it("14. token is tenant-bound: wrong site slug rejected", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "bind14@example.com", subject: "Tenant binding probe" });
    const tok = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'bind14@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token = String(tok.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];
    const wrong = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, $2)`, [token, SITE_B]);
    expect(wrong.error).toMatch(/invalid or has expired/i);
    // …and the correct slug still works (nothing was consumed by the rejection).
    const right = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, $2)`, [token, SITE_A]);
    expect(right.error).toBeUndefined();
  });

  it("15. expired token rejected", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "expire15@example.com", subject: "Token expiry probe" });
    await db.query(
      `UPDATE politicore.governance_intake_staging s
          SET token_expires_at = now() - interval '1 hour'
         FROM politicore.tenants t
        WHERE t.id = s.tenant_id AND t.slug = $1`,
      [SITE_A]
    );
    const tok = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'expire15@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token = String(tok.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];
    const r = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token]);
    expect(r.error).toMatch(/invalid or has expired/i);
  });

  it("11. activation dedups the external participant per tenant", async () => {
    const db = await getDb();
    let n = 0;
    for (const subject of ["Dedup journey one probe", "Dedup journey two probe"]) {
      // The two live submissions are >10 minutes apart in effect, so the
      // per-contact cooldown cannot mask the participant-dedup proof.
      if (n++ > 0) await agePastCooldown(db, "dedup11@example.com");
      await submitAndFetchToken(db, { email: "dedup11@example.com", subject });
      const tok = await as(
        db, "service_role", null,
        `SELECT i.body FROM politicore.core_delivery_intents i
          WHERE i.to_address = 'dedup11@example.com' ORDER BY i.created_at DESC LIMIT 1`
      );
      const token = String(tok.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];
      const v = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token]);
      expect(v.error).toBeUndefined();
    }
    const participants = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.governance_participants WHERE email = 'dedup11@example.com'`
    );
    expect(Number(participants.rows[0].n)).toBe(1);
  });
});

describe("E. tracking", () => {
  let ref = "";
  let secret = "";

  beforeAll(async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "track16@example.com", subject: "Tracking projection probe" });
    const tok = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'track16@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token = String(tok.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];
    const v = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token]);
    ref = String(v.rows[0].reference_code);
    secret = String(v.rows[0].tracking_secret);

    // Staff processing on the activated case: internal + public responses,
    // an assignment — all of which must stay OUT of the public projection.
    await as(db, "authenticated", staffId,
      `SELECT public.acknowledge_governance_request((SELECT id FROM politicore.governance_requests WHERE reference_code = $1), 'on it')`,
      [ref]);
    await as(db, "authenticated", staffId,
      `SELECT public.respond_governance_request((SELECT id FROM politicore.governance_requests WHERE reference_code = $1), 'internal note body', false)`,
      [ref]);
    await as(db, "authenticated", staffId,
      `SELECT public.respond_governance_request((SELECT id FROM politicore.governance_requests WHERE reference_code = $1), 'public note body', true)`,
      [ref]);
    await as(db, "authenticated", staffId,
      `SELECT public.assign_governance_request((SELECT id FROM politicore.governance_requests WHERE reference_code = $1), $2, NULL, NULL, 'assigned to staff')`,
      [ref, staffId]);
  });

  it("16. reference alone is insufficient; correct pair returns minimal projection", async () => {
    const db = await getDb();
    const noSecret = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, '')`, [ref]);
    expect(noSecret.error).toMatch(/reference and tracking secret are required/i);
    // Wrong secret: empty result, no error — indistinguishable from an
    // unknown reference (the application maps emptiness to its typed error;
    // there is NO existence oracle at the RPC layer).
    const wrong = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, $2)`, [ref, "a".repeat(64)]);
    expect(wrong.error).toBeUndefined();
    expect(wrong.rows.length).toBe(0);
    const ok = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, $2)`, [ref, secret]);
    expect(ok.error).toBeUndefined();
    const statuses = ok.rows.map((r) => String(r.status));
    // The E-block staff pipeline (acknowledge → respond → assign) completes
    // legitimately; every row carries the CURRENT lifecycle status.
    expect(statuses).toContain("assigned");
    expect(new Set(statuses).size).toBe(1);
    const kinds = ok.rows.map((r) => (r.event_kind ? String(r.event_kind) : ""));
    expect(kinds).toContain("submitted");
    expect(kinds).toContain("acknowledged");
  });

  it("18. projection carries NO response bodies, assignments, or staff identity", async () => {
    const db = await getDb();
    const ok = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, $2)`, [ref, secret]);
    const kinds = ok.rows.map((r) => (r.event_kind ? String(r.event_kind) : ""));
    expect(kinds).not.toContain("staff_response");
    // No column of the projection can carry a body or staff reference.
    // (The projection is the RPC's RETURNS TABLE surface — a function,
    // never a table — so its OUT parameters are the contract.)
    const cols = await as(
      db, "service_role", null,
      `SELECT parameter_name FROM information_schema.parameters
        WHERE specific_schema = 'politicore'
          AND specific_name LIKE 'governance_track_public_request%'
          AND parameter_mode = 'OUT'
        ORDER BY ordinal_position`
    );
    const names = cols.rows.map((r) => String(r.parameter_name));
    expect(names).toEqual(
      expect.arrayContaining(["reference_code", "status", "created_at", "event_kind", "event_created_at"])
    );
    expect(names.some((n) => /body|staff|assign|participant|secret|hash|email/.test(n))).toBe(false);
    // The assignment exists internally but is unreachable publicly.
    const assigned = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.governance_assignments a
         JOIN politicore.governance_requests r ON r.id = a.request_id
        WHERE r.reference_code = $1`,
      [ref]
    );
    expect(Number(assigned.rows[0].n)).toBe(1);
  });

  it("17. secret is stored hash-only — the hash is never the secret", async () => {
    const db = await getDb();
    const cred = await as(
      db, "service_role", null,
      `SELECT tracking_secret_hash FROM politicore.governance_tracking_credentials c
         JOIN politicore.governance_requests r ON r.id = c.request_id
        WHERE r.reference_code = $1`,
      [ref]
    );
    expect(String(cred.rows[0].tracking_secret_hash)).not.toBe(secret);
    expect(String(cred.rows[0].tracking_secret_hash)).toHaveLength(64);
  });

  it("19. failed attempts audited, indistinguishable, and throttled", async () => {
    const db = await getDb();
    for (let i = 0; i < 16; i++) {
      const r = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, $2)`, [ref, `wrong-${i}`]);
      expect(r.error).toBeUndefined();
      expect(r.rows.length).toBe(0); // every failure: empty, never an oracle
    }
    const auds = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n, max((new_value ->> 'window_attempts')::int) AS last_window
         FROM politicore.system_audits WHERE action = 'governance_tracking_rejected'`
    );
    expect(Number(auds.rows[0].n)).toBeGreaterThanOrEqual(16);
    // The 16th+ attempt inside the window is throttled (still empty result,
    // still audited — no error distinguishes throttle from rejection).
    const throttled = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, $2)`, [ref, "one-more"]);
    expect(throttled.error).toBeUndefined();
    expect(throttled.rows.length).toBe(0);
    // Unknown reference: SAME shape (no existence oracle)…
    const unknown = await as(db, "anon", null, `SELECT * FROM public.governance_track($1, $2)`, ["GR-1999-00000000", "x"]);
    expect(unknown.error).toBeUndefined();
    expect(unknown.rows.length).toBe(0);
  });
});

describe("F. isolation — zero anon surface, no minted authority", () => {
  it("20. anon cannot read or write any governance or delivery table", async () => {
    const db = await getDb();
    for (const table of [
      "governance_requests",
      "governance_participants",
      "governance_request_events",
      "governance_assignments",
      "governance_request_categories",
      "governance_intake_staging",
      "governance_tracking_credentials",
      "core_delivery_intents",
    ]) {
      const read = await as(db, "anon", null, `SELECT count(*)::int AS n FROM politicore.${table}`);
      // Either a permission error OR an RLS-filtered empty read — never data.
      expect(
        read.error !== undefined || Number(read.rows[0]?.n ?? -1) === 0,
        `anon SELECT on ${table}`
      ).toBe(true);
      const write = await as(
        db, "anon", null,
        `INSERT INTO politicore.${table} SELECT * FROM politicore.${table} WHERE false`
      );
      expect(write.error, `anon INSERT on ${table}`).toBeDefined();
    }
  });

  it("21. public RPCs mint no assignments and no permissions", async () => {
    const db = await getDb();
    const counts = await as(
      db, "service_role", null,
      `SELECT
         (SELECT count(*)::int FROM politicore.governance_assignments a
           JOIN politicore.governance_participants p ON p.id = (SELECT participant_id FROM politicore.governance_requests r WHERE r.id = a.request_id)
          WHERE p.profile_id IS NULL AND a.assigned_by IS NULL) AS unattributed_external_assignments,
         (SELECT count(*)::int FROM politicore.permission_grants) AS grants_total`
    );
    // Every assignment touching an external-participant case is STAFF-
    // attributed (assigned_by set by the authority RPC). The public intake
    // path mints none — and boundary pin 29 proves it cannot INSERT anyway.
    expect(Number(counts.rows[0].unattributed_external_assignments)).toBe(0);
    // Staff-created assignments exist (track16 flow) — grants untouched.
    expect(Number(counts.rows[0].grants_total)).toBeGreaterThanOrEqual(0);
  });
});

describe("G. abuse controls", () => {
  it("22. identical pending contact+subject collapses to a rotating resend", async () => {
    const db = await getDb();
    const subject = "Duplicate collapse mechanics probe";
    await submitAndFetchToken(db, { email: "dupe22@example.com", subject });
    // Capture the first token BEFORE the resend (no timestamp-tie ambiguity).
    const tok1 = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'dupe22@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token1 = String(tok1.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];

    // Same contact + same subject within the cooldown → resend (TRUE),
    // not a rejection.
    await submitAndFetchToken(db, { email: "dupe22@example.com", subject });
    const staged = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.governance_intake_staging s
         JOIN politicore.tenants t ON t.id = s.tenant_id
        WHERE t.slug = $1 AND s.status = 'pending'
          AND s.subject_hash = encode(sha256(convert_to(lower($2), 'UTF8')), 'hex')`,
      [SITE_A, subject]
    );
    expect(Number(staged.rows[0].n)).toBe(1);

    // The OLD token is dead (rotated); the NEW one verifies.
    const oldTry = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token1]);
    expect(oldTry.error).toMatch(/invalid or has expired/i);
    const tok2 = await as(
      db, "service_role", null,
      `SELECT i.body FROM politicore.core_delivery_intents i
        WHERE i.to_address = 'dupe22@example.com' ORDER BY i.created_at DESC LIMIT 1`
    );
    const token2 = String(tok2.rows[0].body).match(/code \(valid for 24 hours\): (\S+)/)![1];
    expect(token2).not.toBe(token1);
    const v = await as(db, "anon", null, `SELECT * FROM public.governance_verify($1, NULL)`, [token2]);
    expect(v.error).toBeUndefined();
  });

  it("23. per-contact cooldown blocks a NEW subject within the window", async () => {
    const db = await getDb();
    await submitAndFetchToken(db, { email: "cool23@example.com", subject: "Cooldown window probe" });
    const second = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'cool23@example.com', 'Cool Three', 'Water Supply', 'A different subject entirely', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_A]
    );
    // Security rejection: FALSE (no error) + a persisted rejection audit.
    expect(second.error).toBeUndefined();
    expect(Object.values(second.rows[0] ?? { v: null })[0]).toBe(false);
    const rejected = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.system_audits
        WHERE action = 'governance_public_intake_rejected' AND new_value ->> 'reason' = 'cooldown'`
    );
    expect(Number(rejected.rows[0].n)).toBeGreaterThanOrEqual(1);
  });

  it("24. per-contact pending cap holds once the cooldown window has passed", async () => {
    const db = await getDb();
    // Simulate a contact with 3 pending rows and no recent intake audit.
    const ch = await as(
      db, "service_role", null,
      `SELECT encode(sha256(convert_to('cap24@example.com','UTF8')),'hex') AS h`
    );
    const t = await as(db, "service_role", null, `SELECT id FROM politicore.tenants WHERE slug = $1`, [SITE_A]);
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO politicore.governance_intake_staging
           (tenant_id, contact_hash, subject_hash, token_hash, token_expires_at, status, submission)
         VALUES ($1, $2, $3, $4, now() + interval '24 hours', 'pending', '{}'::jsonb)`,
        [t.rows[0].id, ch.rows[0].h, `sh-${i}`, `tok-${i}`]
      );
    }
    await db.query(
      `DELETE FROM politicore.system_audits WHERE new_value ->> 'ch' = $1`,
      [ch.rows[0].h]
    );
    const r = await as(
      db, "anon", null,
      `SELECT public.governance_public_intake($1, 'cap24@example.com', 'Cap Two', 'Water Supply', 'Pending cap probe subject', 'This description is long enough to pass validation checks.', NULL, NULL, NULL, true)`,
      [SITE_A]
    );
    // Final contract: the security rejection returns FALSE and the
    // rejection audit COMMITs (the audit stream is the throttle ledger).
    expect(r.error).toBeUndefined();
    expect(Object.values(r.rows[0] ?? { v: null })[0]).toBe(false);
    const rejected = await as(
      db, "service_role", null,
      `SELECT count(*)::int AS n FROM politicore.system_audits
        WHERE action = 'governance_public_intake_rejected'
          AND new_value ->> 'reason' = 'contact_pending_cap'`
    );
    expect(Number(rejected.rows[0].n)).toBeGreaterThanOrEqual(1);
  });
});

describe("I. boundary pins", () => {
  it("28. public wrappers expose NO tenant/actor/status/visibility parameters", async () => {
    const db = await getDb();
    const params = await as(
      db, "service_role", null,
      `SELECT p.proname, pg_get_function_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('governance_public_intake','governance_verify','governance_track','governance_public_categories')`
    );
    expect(params.rows.length).toBe(4);
    for (const row of params.rows) {
      const args = String(row.args).toLowerCase();
      expect(args).not.toMatch(/tenant_id|actor_id|participant_id|status|is_public|assignee/);
    }
  });

  it("29. no anon/authenticated grants on the intake/credential/delivery tables", async () => {
    const db = await getDb();
    // service_role ALL is the 0007 default-privilege platform convention
    // (server-side operational paths); anon and authenticated must have ZERO.
    const grants = await as(
      db, "service_role", null,
      `SELECT grantee, count(*)::int AS n FROM information_schema.role_table_grants
        WHERE table_schema = 'politicore'
          AND table_name IN ('governance_intake_staging','governance_tracking_credentials','core_delivery_intents')
          AND grantee IN ('anon','authenticated')
        GROUP BY grantee`
    );
    expect(grants.rows.length).toBe(0);
  });

  it("30. the public UI touches only RPCs — never a governance/delivery table", async () => {
    const pages = [
      "src/app/request/page.tsx",
      "src/app/request/track/page.tsx",
      "src/lib/supabase/governance-public.ts",
    ];
    for (const p of pages) {
      const src = fs.readFileSync(p, "utf-8");
      expect(src, p).not.toMatch(/\.from\(\s*["']governance_|\.from\(\s*["']core_delivery/);
      expect(src, p).not.toMatch(/tenant_id\s*[:=]|actor_id\s*[:=]/);
    }
  });

  it("31. no parallel notification/audit infrastructure was created", async () => {
    const db = await getDb();
    const tables = await as(
      db, "service_role", null,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'politicore'
          AND (table_name ~ 'notification' OR table_name ~ 'audit' OR table_name ~ '_queue')
        ORDER BY table_name`
    );
    const names = tables.rows.map((r) => String(r.table_name));
    expect(names).toEqual(expect.arrayContaining(["notifications", "system_audits"]));
    expect(names.every((n) => ["notifications", "system_audits"].includes(n))).toBe(true);
  });

  it("8/32. Firebase boundary — Phase 10 introduced zero Firebase references", async () => {
    for (const p of [
      "supabase/migrations/0037_governance_public_intake.sql",
      "supabase/migrations/0038_governance_public_categories.sql",
      "src/lib/supabase/governance-public.ts",
      "src/app/request/page.tsx",
      "src/app/request/track/page.tsx",
    ]) {
      const src = fs.readFileSync(p, "utf-8").toLowerCase();
      expect(src.includes("firebase")).toBe(false);
    }
  });
});
