/**
 * POLITICORE — Social Force Phase D security suite (Points + Leaderboard).
 *
 * Runs against the same local PGlite database as the other security
 * suites (migrations 0000–0029). Phase D is the read-only presentation
 * layer over the authoritative model; this suite proves the §25 matrix:
 *
 *   points (projection-sourced total; no client mutation) · history
 *   (own-awards privacy, cross-tenant denial, no private-field leaks) ·
 *   leaderboard (projection-sourced rank, tenant isolation, reduced
 *   fields, module gate — the 0029 view-definition gate) · membership
 *   boundaries · write protection (awards/points/leaderboard) ·
 *   ranking is database-supplied (UI does not recompute) · Firebase
 *   boundary of the migrated surfaces.
 *
 * No Campaign, Election, or Core object is modified.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTenant, createUser, getDb } from "./helpers";
import { classifySocialError } from "../../src/lib/supabase/socialForce";

const SOCIAL_ONLY = { social: true } as const;
const ALL = { social: true, campaign: true, election: true } as const;

interface FixtureUser {
  authId: string;
  email: string;
  profileId: string;
}

let db: PGlite;
let tenantA = "";
let tenantB = "";
let admin: FixtureUser;
let social: FixtureUser;
let social2: FixtureUser;
let campaignOnly: FixtureUser;
let officer: FixtureUser;
let socialB: FixtureUser;

async function q(sql: string, params: unknown[] = []) {
  const r = await db.query(sql, params as never[]);
  return r.rows as Record<string, unknown>[];
}

/** service_role insert of a task (RLS bypass — fixture path only). */
async function seedTask(opts: {
  tenantId: string;
  title?: string;
  points?: number;
  status?: "active" | "inactive";
}) {
  const rows = await q(
    `INSERT INTO politicore.social_tasks
       (tenant_id, title, platform, action, points, status, proof_required, created_by)
     VALUES ($1,$2,'facebook','like',$3,$4::politicore.social_task_status,false,$5)
     RETURNING id`,
    [
      opts.tenantId,
      opts.title ?? "Fixture task",
      opts.points ?? 50,
      opts.status ?? "active",
      admin.authId,
    ]
  );
  return rows[0].id as string;
}

/** service_role submission for a member (fixture path). */
async function seedSubmission(taskId: string, submitterId: string) {
  const rows = await q(
    `INSERT INTO politicore.social_task_submissions (tenant_id, task_id, submitter_id)
     VALUES ((SELECT tenant_id FROM politicore.social_tasks WHERE id=$1), $1, $2)
     RETURNING id`,
    [taskId, submitterId]
  );
  return rows[0].id as string;
}

/** Full verify path as the sanctioned fixture (award + projection). */
async function verifyAsAdmin(subId: string) {
  return as(db, "authenticated", admin.authId,
    `SELECT public.verify_social_submission($1)`, [subId]);
}

beforeAll(async () => {
  db = await getDb();

  const tA = await createTenant(db, "sfd-a", "SFD Tenant A", SOCIAL_ONLY);
  const tB = await createTenant(db, "sfd-b", "SFD Tenant B", ALL);
  tenantA = tA;
  tenantB = tB;

  admin = await createUser(db, { tenantId: tA, email: "adm@sfd.test", fullName: "Admin A", accessRole: "admin" });
  social = await createUser(db, { tenantId: tA, email: "soc1@sfd.test", fullName: "Social One", membershipTypes: ["social_member"] });
  social2 = await createUser(db, { tenantId: tA, email: "soc2@sfd.test", fullName: "Social Two", membershipTypes: ["social_member"] });
  campaignOnly = await createUser(db, { tenantId: tA, email: "cmp@sfd.test", fullName: "Camp Only", membershipTypes: ["campaign_member"] });
  officer = await createUser(db, { tenantId: tA, email: "eo@sfd.test", fullName: "Officer A", accessRole: "election_officer" });

  socialB = await createUser(db, { tenantId: tB, email: "soc@sfd-b.test", fullName: "Social B", membershipTypes: ["social_member"] });

  // Establish an award for `social` (40 pts) — the points/history fixture.
  const task = await seedTask({ tenantId: tenantA, title: "pts-fixture", points: 40 });
  const sub = await seedSubmission(task, social.authId);
  const v = await verifyAsAdmin(sub);
  if (v.error) throw new Error(`fixture verify failed: ${v.error}`);
});

// ── points ───────────────────────────────────────────────────────────────

describe("points", () => {
  it("verified submission produced the authoritative award and projection", async () => {
    const awards = await q(
      `SELECT points, recipient_id, source FROM politicore.social_point_awards
       WHERE recipient_id=$1 AND source='task_verification'`, [social.authId]);
    expect(awards).toHaveLength(1);
    expect(Number(awards[0].points)).toBe(40);
    // Projection equals ledger aggregate (server-maintained).
    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points))
      .toBe(40);
  });

  it("member can read own points; total comes from the projection", async () => {
    const mine = await as(db, "authenticated", social.authId,
      `SELECT points FROM public.politicore_profiles WHERE id = auth.uid()`);
    expect(mine.rows).toHaveLength(1);
    expect(Number(mine.rows[0].points)).toBe(40);
  });

  it("direct profiles.points mutation fails for member AND admin", async () => {
    for (const user of [social, admin]) {
      const r = await as(db, "authenticated", user.authId,
        `UPDATE public.politicore_profiles SET points = 100000 WHERE id = $1`, [social.authId]);
      expect(r.error ?? "").toMatch(/permission denied|row-level|policy|immutable/i);
    }
    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points))
      .toBe(40);
  });

  it("direct award INSERT/UPDATE/DELETE fail closed", async () => {
    const sub = (await q(`SELECT id FROM politicore.social_task_submissions WHERE submitter_id=$1 LIMIT 1`, [social.authId]))[0].id as string;
    const ins = await as(db, "authenticated", social.authId,
      `INSERT INTO public.social_point_awards (tenant_id, recipient_id, submission_id, points) VALUES ($1,$1,$2,999)`,
      [tenantA, sub]);
    expect(ins.error ?? "").toMatch(/permission denied|row-level|policy/i);

    const upd = await as(db, "authenticated", social.authId,
      `UPDATE public.social_point_awards SET points=1 WHERE recipient_id=$1`, [social.authId]);
    expect((upd as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);

    const del = await as(db, "authenticated", social.authId,
      `DELETE FROM public.social_point_awards WHERE recipient_id=$1`, [social.authId]);
    expect(del.error ?? "").toMatch(/permission denied/i);
  });

  it("the client service offers no point-write API (static contract)", () => {
    const src = readFileSync(resolve(__dirname, "../../src/lib/supabase/socialForce.ts"), "utf8");
    for (const banned of ["awardPoints", "setPoints", "updatePoints", "setRank", "updateLeaderboard"]) {
      expect(src).not.toContain(banned);
    }
  });
});

// ── history privacy ─────────────────────────────────────────────────────

describe("point history privacy", () => {
  it("member reads own awards (RLS recipient = self)", async () => {
    const mine = await as(db, "authenticated", social.authId,
      `SELECT points, source FROM public.social_point_awards`);
    expect(mine.rows).toHaveLength(1);
    expect(Number(mine.rows[0].points)).toBe(40);
  });

  it("member cannot read another user's award history", async () => {
    // social2 reads: must not see social's award.
    const theirs = await as(db, "authenticated", social2.authId,
      `SELECT count(*)::int n FROM public.social_point_awards`);
    expect(theirs.rows[0].n).toBe(0);
  });

  it("cross-tenant history is denied (silent + RPC pinned)", async () => {
    const vis = await as(db, "authenticated", socialB.authId,
      `SELECT count(*)::int n FROM public.social_point_awards`);
    expect(vis.rows[0].n).toBe(0);

    // Admin RPC is tenant-pinned: tenant-A admin sees only tenant-A awards.
    const hist = await as(db, "authenticated", admin.authId,
      `SELECT count(*)::int n FROM public.social_admin_award_history(NULL)`);
    expect(hist.rows[0].n).toBe(1); // exactly the tenant-A fixture award
  });

  it("history surface exposes no private contact fields", async () => {
    const mine = await as(db, "authenticated", social.authId,
      `SELECT * FROM public.social_point_awards LIMIT 1`);
    const row = mine.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      for (const banned of ["email", "phone", "polling_unit_id", "full_name"]) {
        expect(row).not.toHaveProperty(banned);
      }
    }
  });

  it("admin award history RPC is admin-only and module-gated", async () => {
    const denied = await as(db, "authenticated", social.authId,
      `SELECT * FROM public.social_admin_award_history(NULL)`);
    expect(denied.error ?? "").toMatch(/admin authority/i);

    await q(`UPDATE politicore.tenant_modules SET enabled=false WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    try {
      const gated = await as(db, "authenticated", admin.authId,
        `SELECT * FROM public.social_admin_award_history(NULL)`);
      expect(gated.error ?? "").toMatch(/social module is not enabled/i);
    } finally {
      await q(`UPDATE politicore.tenant_modules SET enabled=true WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    }
  });
});

// ── leaderboard ──────────────────────────────────────────────────────────

describe("leaderboard", () => {
  it("authorized reads work; rank and points match the projection", async () => {
    const lb = await as(db, "authenticated", social.authId,
      `SELECT * FROM public.social_leaderboard ORDER BY position`);
    expect(lb.error).toBeUndefined();
    const rows = lb.rows as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const mine = rows.find((r) => r.id === social.authId);
    expect(mine).toBeTruthy();
    expect(Number(mine!.points)).toBe(40);
    // Contiguous, database-computed positions.
    rows.forEach((r, i) => expect(Number(r.position)).toBe(i + 1));
  });

  it("tenant isolated: tenant-B member sees no tenant-A rows", async () => {
    const lb = await as(db, "authenticated", socialB.authId,
      `SELECT * FROM public.social_leaderboard`);
    expect(lb.error).toBeUndefined();
    for (const row of lb.rows) expect(row.tenant_id).toBe(tenantB);
  });

  it("reduced projection: no polling unit, no email, no private contacts", async () => {
    const lb = await as(db, "authenticated", social.authId,
      `SELECT * FROM public.social_leaderboard LIMIT 1`);
    const row = lb.rows[0] as Record<string, unknown>;
    for (const banned of ["email", "phone", "polling_unit_id", "access_role", "membership_types"]) {
      expect(row).not.toHaveProperty(banned);
    }
    expect(row).toHaveProperty("full_name");
    expect(row).toHaveProperty("points");
    expect(row).toHaveProperty("position");
    expect(row).toHaveProperty("ward_name");
  });

  it("module gate (0029): social disabled → leaderboard empty for member AND admin", async () => {
    await q(`UPDATE politicore.tenant_modules SET enabled=false WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    try {
      const member = await as(db, "authenticated", social.authId,
        `SELECT count(*)::int n FROM public.social_leaderboard`);
      expect(member.rows[0].n).toBe(0);
      const adm = await as(db, "authenticated", admin.authId,
        `SELECT count(*)::int n FROM public.social_leaderboard`);
      expect(adm.rows[0].n).toBe(0);
    } finally {
      await q(`UPDATE politicore.tenant_modules SET enabled=true WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    }
  });

  it("membership gate: campaign-only and election officer see no leaderboard", async () => {
    for (const user of [campaignOnly, officer]) {
      const r = await as(db, "authenticated", user.authId,
        `SELECT count(*)::int n FROM public.social_leaderboard`);
      expect(r.rows[0].n).toBe(0);
    }
  });

  it("anon sees nothing (fail-closed through the gated view)", async () => {
    const r = await as(db, "anon", null,
      `SELECT count(*)::int n FROM public.social_leaderboard`);
    expect(r.rows[0].n).toBe(0);
  });

  it("projection cannot be mutated by anyone", async () => {
    for (const user of [social, admin]) {
      const upd = await as(db, "authenticated", user.authId,
        `UPDATE public.social_leaderboard SET points = 999999 WHERE id = $1`, [social.authId]);
      expect(upd.error ?? "").toMatch(/permission denied|read-only|cannot/i);
      const ins = await as(db, "authenticated", user.authId,
        `INSERT INTO public.social_leaderboard (id, tenant_id, full_name, points, position) VALUES (gen_random_uuid(), $1, 'fake', 1, 1)`,
        [tenantA]);
      expect(ins.error ?? "").toMatch(/permission denied|read-only|cannot/i);
      const del = await as(db, "authenticated", user.authId,
        `DELETE FROM public.social_leaderboard WHERE id = $1`, [social.authId]);
      expect(del.error ?? "").toMatch(/permission denied|read-only|cannot/i);
    }
    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points))
      .toBe(40);
  });
});

// ── ranking is database-supplied (UI contract) ───────────────────────────

describe("ranking contract", () => {
  it("UI consumes the projection without re-sorting or recomputing rank", () => {
    const lbPage = readFileSync(resolve(__dirname, "../../src/app/portal/leaderboard/page.tsx"), "utf8");
    const ptsPage = readFileSync(resolve(__dirname, "../../src/app/portal/points/page.tsx"), "utf8");
    const svc = readFileSync(resolve(__dirname, "../../src/lib/supabase/socialForce.ts"), "utf8");

    // Both pages render the authoritative position/points values.
    expect(lbPage).toContain("user.position");
    expect(ptsPage).toContain("position");
    // No client-side ranking algorithm exists anywhere in the surfaces.
    for (const src of [lbPage, ptsPage, svc]) {
      expect(src).not.toMatch(/\.sort\(\s*\(\s*[a-z],\s*[a-z]\s*\)\s*=>\s*[a-z]+\.points/);
      expect(src).not.toMatch(/rank\s*=\s*index\s*\+/);
    }
    // Service orders by the projection's own column.
    expect(svc).toContain('.order("position"');
  });
});

// ── module + membership summary ──────────────────────────────────────────

describe("module and membership boundaries", () => {
  it("typed error classification covers points/leaderboard refusals", () => {
    expect(classifySocialError("award history requires admin authority")).toBe("forbidden");
    expect(classifySocialError("social module is not enabled")).toBe("module_disabled");
    expect(classifySocialError("unauthenticated")).toBe("unauthenticated");
  });
});

// ── Firebase boundary ────────────────────────────────────────────────────

describe("firebase boundary (migrated points/leaderboard path)", () => {
  const SURFACES = [
    "src/lib/supabase/socialForce.ts",
    "src/app/portal/leaderboard/page.tsx",
    "src/app/portal/points/page.tsx",
  ];

  it("no migrated points/leaderboard surface touches Firebase or legacy reads", () => {
    const root = resolve(__dirname, "../..");
    for (const rel of SURFACES) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect({ file: rel, firebase: /from\s+["'][^"']*(firebase|firestore)[^"']*["']/i.test(src) })
        .toEqual({ file: rel, firebase: false });
      expect({ file: rel, legacy: src.includes("getLeaderboard") }).toEqual({ file: rel, legacy: false });
      expect({ file: rel, snapshot: /\bonSnapshot\b/.test(src) }).toEqual({ file: rel, snapshot: false });
    }
  });

  it("the service reads the leaderboard projection, not profiles/awards reconstruction", () => {
    const svc = readFileSync(resolve(__dirname, "../../src/lib/supabase/socialForce.ts"), "utf8");
    expect(svc).toContain('.from("social_leaderboard")');
    expect(svc).toContain('.from("social_point_awards")');
    // Total comes from the projection — never an award reduce in the client.
    expect(svc).toContain(".from(\"politicore_profiles\")");
    expect(svc).not.toMatch(/reduce\(\s*\(\s*sum/);
  });
});
