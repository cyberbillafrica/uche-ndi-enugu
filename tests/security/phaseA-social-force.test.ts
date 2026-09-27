/**
 * POLITICORE — Social Force Phase A security suite.
 *
 * Runs against the same local PGlite database as the other security
 * suites (migrations 0000–0028). Proves the Social Force Architecture
 * Gate §51/§52 database matrix for the Phase A substrate:
 *
 *   tenant isolation · module gating · membership boundaries ·
 *   task authority · submission ownership · verification authority ·
 *   point-ledger integrity · leaderboard projection safety ·
 *   direct PostgREST abuse (anon / member table · view · RPC paths)
 *
 * No Campaign, Election, or Core object is modified.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTenant, createUser, getDb, grant } from "./helpers";

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
let plainMember: FixtureUser;
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
  action?: "like" | "comment" | "share" | "make_post";
  proofRequired?: boolean;
  expirationDate?: Date | null;
}) {
  const rows = await q(
    `INSERT INTO politicore.social_tasks
       (tenant_id, title, platform, action, points, status, proof_required, expiration_date, created_by)
     VALUES ($1,$2,'facebook',$3::politicore.social_task_action,$4,$5::politicore.social_task_status,$6,$7,$8)
     RETURNING id`,
    [
      opts.tenantId,
      opts.title ?? "Fixture task",
      opts.action ?? "like",
      opts.points ?? 50,
      opts.status ?? "active",
      opts.proofRequired ?? false,
      opts.expirationDate ?? null,
      admin.authId,
    ]
  );
  return rows[0].id as string;
}

/** service_role submission for a member (fixture path). */
async function seedSubmission(taskId: string, submitterId: string, proof: string | null = null) {
  const rows = await q(
    `INSERT INTO politicore.social_task_submissions (tenant_id, task_id, submitter_id, proof_url)
     VALUES ((SELECT tenant_id FROM politicore.social_tasks WHERE id=$1), $1, $2, $3)
     RETURNING id`,
    [taskId, submitterId, proof]
  );
  return rows[0].id as string;
}

const RLS_ERR = /row-level security|violates row-level|policy/i;

beforeAll(async () => {
  db = await getDb();

  // Tenant A: social-only active (the Social Force operating mode).
  const tA = await createTenant(db, "social-a", "Tenant A", SOCIAL_ONLY);
  // Tenant B: fully provisioned — used for module gating + cross-tenant.
  const tB = await createTenant(db, "social-b", "Tenant B", ALL);
  tenantA = tA;
  tenantB = tB;

  admin = await createUser(db, { tenantId: tA, email: "adm@sa.test", fullName: "Admin A", accessRole: "admin" });
  social = await createUser(db, { tenantId: tA, email: "soc1@sa.test", fullName: "Social One", membershipTypes: ["social_member"] });
  social2 = await createUser(db, { tenantId: tA, email: "soc2@sa.test", fullName: "Social Two", membershipTypes: ["social_member"] });
  campaignOnly = await createUser(db, { tenantId: tA, email: "cmp@sa.test", fullName: "Camp Only", membershipTypes: ["campaign_member"] });
  officer = await createUser(db, { tenantId: tA, email: "eo@sa.test", fullName: "Officer A", accessRole: "election_officer" });
  plainMember = await createUser(db, { tenantId: tA, email: "plain@sa.test", fullName: "Plain A", membershipTypes: [] });

  socialB = await createUser(db, { tenantId: tB, email: "soc@sb.test", fullName: "Social B", membershipTypes: ["social_member"] });

  // A campaign authority for campaignOnly (so "campaign authorized, social
  // denied" is proven by an actually-authorized Campaign user).
  await grant(db, tA, campaignOnly.authId, "view_dashboard", true);
});

describe("tenant isolation", () => {
  it("admin sees only own-tenant tasks; cross-tenant rows invisible", async () => {
    const idA = await seedTask({ tenantId: tenantA, title: "A task" });
    await seedTask({ tenantId: tenantB, title: "B task" });

    const vis = await as(db, "authenticated", admin.authId,
      `SELECT count(*)::int n FROM public.social_tasks WHERE id = $1`, [idA]);
    expect(vis.rows[0].n).toBe(1);
    const other = await as(db, "authenticated", admin.authId,
      `SELECT count(*)::int n FROM public.social_tasks`);
    expect(other.rows[0].n).toBe(1); // exactly one tenant-A task visible
  });

  it("cross-tenant task mutation is impossible", async () => {
    const idB = (await q(`SELECT id FROM politicore.social_tasks WHERE title='B task'`))[0].id as string;
    const res = await as(db, "authenticated", admin.authId,
      `SELECT public.update_social_task($1, 'hacked')`, [idB]);
    expect(res.error ?? "").toMatch(/task not found/i); // definer fn pins tenant
    const state = await q(`SELECT title FROM politicore.social_tasks WHERE id=$1`, [idB]);
    expect(state[0].title).not.toBe("hacked");
  });

  it("member cannot see another tenant's leaderboard rows", async () => {
    const task = await seedTask({ tenantId: tenantA, points: 10 });
    const sub = await seedSubmission(task, social.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const lb = await as(db, "authenticated", socialB.authId, `SELECT * FROM public.social_leaderboard`);
    expect(lb.error).toBeUndefined();
    expect(lb.rows.find((r) => r.id === social.authId)).toBeUndefined(); // tenant-A points never leak
    for (const row of lb.rows) expect(row.tenant_id).toBe(tenantB);
  });
});

describe("module gating", () => {
  it("social module disabled → views empty + RPC refusal (fail-closed)", async () => {
    await q(`UPDATE politicore.tenant_modules SET enabled=false WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    try {
      const vis = await as(db, "authenticated", admin.authId, `SELECT count(*)::int n FROM public.social_tasks`);
      expect(vis.rows[0].n).toBe(0);
      const subs = await as(db, "authenticated", social.authId,
        `SELECT count(*)::int n FROM public.social_task_submissions`);
      expect(subs.rows[0].n).toBe(0);

      const create = await as(db, "authenticated", admin.authId,
        `SELECT public.create_social_task('x')`);
      expect(create.error ?? "").toMatch(/social module is not enabled/i);

      const submit = await as(db, "authenticated", social.authId,
        `SELECT public.submit_social_task($1::uuid)`, [crypto.randomUUID()]);
      expect(submit.error ?? "").toMatch(/social module is not enabled/i);
    } finally {
      await q(`UPDATE politicore.tenant_modules SET enabled=true WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    }
  });
});

describe("membership boundaries", () => {
  it("campaign-only member sees no participable tasks and cannot submit", async () => {
    await seedTask({ tenantId: tenantA, title: "mem-boundary" });
    const vis = await as(db, "authenticated", campaignOnly.authId,
      `SELECT count(*)::int n FROM public.social_tasks`);
    expect(vis.rows[0].n).toBe(0);

    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='mem-boundary'`))[0].id as string;
    const submit = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(submit.error ?? "").toMatch(/social membership is required/i);
  });

  it("election officer (no social authority) is denied", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='mem-boundary'`))[0].id as string;
    const submit = await as(db, "authenticated", officer.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(submit.error ?? "").toMatch(/social membership is required/i);
    const verify = await as(db, "authenticated", officer.authId,
      `SELECT public.verify_social_submission($1::uuid)`, [crypto.randomUUID()]);
    expect(verify.error ?? "").toMatch(/admin authority/i);
  });

  it("plain member (no membership) cannot submit", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='mem-boundary'`))[0].id as string;
    const submit = await as(db, "authenticated", plainMember.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(submit.error ?? "").toMatch(/social membership is required/i);
  });

  it("admin without social membership can still administer (access-role authority)", async () => {
    const t = await as(db, "authenticated", admin.authId,
      `SELECT public.create_social_task('admin-can-manage', 'd', 'facebook', 'like', 25)`);
    expect(t.error).toBeUndefined();
    expect(t.rows[0]?.create_social_task).toBeTruthy();
  });
});

describe("task authority", () => {
  it("member cannot create/update/transition tasks", async () => {
    const c = await as(db, "authenticated", social.authId,
      `SELECT public.create_social_task('member task')`);
    expect(c.error ?? "").toMatch(/admin authority/i);

    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='mem-boundary'`))[0].id as string;
    const u = await as(db, "authenticated", social.authId,
      `SELECT public.update_social_task($1, 'owned')`, [task]);
    expect(u.error ?? "").toMatch(/admin authority/i);

    const s = await as(db, "authenticated", social.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [task]);
    expect(s.error ?? "").toMatch(/admin authority/i);
  });

  it("direct member UPDATE on the view is denied and changes nothing", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='mem-boundary'`))[0].id as string;
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.social_tasks SET points = 99999 WHERE id = $1`, [task]);
    expect((r as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
    expect(Number((await q(`SELECT points FROM politicore.social_tasks WHERE id=$1`, [task]))[0].points)).toBe(50);
  });

  it("anon cannot read the participable-task surface", async () => {
    const r = await as(db, "anon", null, `SELECT count(*)::int n FROM public.social_tasks`);
    expect(r.error ?? "").toMatch(/permission denied/i); // no grant — fail-closed
    expect(r.rows).toHaveLength(0);
  });

  it("admin CRUD through the authority RPCs works", async () => {
    const c = await as(db, "authenticated", admin.authId,
      `SELECT public.create_social_task('rpc task', 'desc', 'facebook', 'share', 30, 'active', 'https://x.com/t', true)`);
    expect(c.error).toBeUndefined();
    const id = c.rows[0].create_social_task as string;

    const u = await as(db, "authenticated", admin.authId,
      `SELECT public.update_social_task($1, 'rpc task v2')`, [id]);
    expect(u.error).toBeUndefined();
    expect((await q(`SELECT title, points FROM politicore.social_tasks WHERE id=$1`, [id]))[0].title).toBe("rpc task v2");

    const st = await as(db, "authenticated", admin.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [id]);
    expect(st.error).toBeUndefined();
    expect((await q(`SELECT status::text s FROM politicore.social_tasks WHERE id=$1`, [id]))[0].s).toBe("inactive");
  });
});

describe("submission lifecycle", () => {
  it("member submits via RPC; resubmission overwrites proof while pending", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "sub-lifecycle", action: "share", proofRequired: true });
    const s1 = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/1')`, [task]);
    expect(s1.error).toBeUndefined();

    const resub = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/2')`, [task]);
    expect(resub.error).toBeUndefined();
    const row = await q(
      `SELECT proof_url FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]);
    expect(row[0].proof_url).toBe("https://proof.example/2");
    expect((await q(`SELECT count(*)::int n FROM politicore.social_task_submissions WHERE task_id=$1`, [task]))[0].n).toBe(1);
  });

  it("resubmission against a verified submission is refused", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "verified-resubmit", points: 10 });
    await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [task]);
    const sub = (await q(
      `SELECT id FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]))[0].id as string;
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const again = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/late')`, [task]);
    expect(again.error ?? "").toMatch(/already been verified/i);
  });

  it("inactive task cannot be submitted", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "inactive-task", status: "inactive" });
    const r = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [task]);
    expect(r.error ?? "").toMatch(/task is not active/i);
  });

  it("expired task cannot be submitted", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "expired-task", expirationDate: new Date(Date.now() - 3600_000) });
    const r = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [task]);
    expect(r.error ?? "").toMatch(/task has expired/i);
  });

  it("member cannot submit for another member (impersonation denied)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "impersonation" });
    const r = await as(db, "authenticated", social.authId,
      `INSERT INTO public.social_task_submissions (tenant_id, task_id, submitter_id) VALUES ($1, $2, $3)`,
      [tenantA, task, social2.authId]);
    expect(r.error ?? "").toMatch(RLS_ERR);
  });

  it("member cannot alter another member's submission", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "alter-other" });
    const sub = await seedSubmission(task, social2.authId);
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.social_task_submissions SET proof_url='https://evil' WHERE id=$1`, [sub]);
    expect((r as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
    expect((await q(`SELECT proof_url FROM politicore.social_task_submissions WHERE id=$1`, [sub]))[0].proof_url).not.toBe("https://evil");
  });

  it("member cannot self-verify, even by direct UPDATE", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "self-verify" });
    const sub = await seedSubmission(task, social.authId);
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.social_task_submissions SET status='verified' WHERE id=$1`, [sub]);
    expect((r as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
    expect((await q(`SELECT status::text s FROM politicore.social_task_submissions WHERE id=$1`, [sub]))[0].s).toBe("pending");
  });

  it("member cannot call the verify RPC", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "verify-rpc-deny" });
    const sub = await seedSubmission(task, social.authId);
    const r = await as(db, "authenticated", social.authId, `SELECT public.verify_social_submission($1)`, [sub]);
    expect(r.error ?? "").toMatch(/admin authority/i);
  });

  it("zero-point task is not scoreable", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "zero-points", points: 0 });
    const r = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [task]);
    expect(r.error ?? "").toMatch(/task is not scoreable/i);
  });
});

describe("verification authority + point ledger integrity", () => {
  it("admin verify awards exactly task points; ledger + projection stay consistent", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "award-flow", points: 120 });
    const sub = await seedSubmission(task, social.authId);
    const before = Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points);
    const v = await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);
    expect(v.error).toBeUndefined();

    const award = await q(
      `SELECT points, recipient_id, awarded_by, source FROM politicore.social_point_awards WHERE submission_id=$1`, [sub]);
    expect(award).toHaveLength(1);
    expect(Number(award[0].points)).toBe(120);
    expect(award[0].recipient_id).toBe(social.authId);
    expect(award[0].awarded_by).toBe(admin.authId);
    expect(award[0].source).toBe("task_verification");

    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points)).toBe(before + 120);
    expect((await q(`SELECT status::text s FROM politicore.social_task_submissions WHERE id=$1`, [sub]))[0].s).toBe("verified");
    // verifier pinned server-side, not client-supplied
    expect((await q(`SELECT verified_by FROM politicore.social_task_submissions WHERE id=$1`, [sub]))[0].verified_by).toBe(admin.authId);
  });

  it("double verification is refused; double award is impossible", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "double-verify", points: 10 });
    const sub = await seedSubmission(task, social.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const again = await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);
    expect(again.error ?? "").toMatch(/already been verified/i);

    // Direct award replay through the data API — no INSERT grant at all.
    const direct = await as(db, "authenticated", admin.authId,
      `INSERT INTO public.social_point_awards (tenant_id, recipient_id, submission_id, points, awarded_by)
       VALUES ($1,$2,$3,1,$4)`, [tenantA, social.authId, sub, admin.authId]);
    expect(direct.error ?? "").toMatch(/permission denied|unique|duplicate/i);
  });

  it("verified submissions are immutable", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "immutable-verified", points: 10 });
    const sub = await seedSubmission(task, social.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const r1 = await as(db, "authenticated", social.authId,
      `UPDATE public.social_task_submissions SET proof_url='https://x' WHERE id=$1`, [sub]);
    expect((r1 as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
    const r2 = await as(db, "authenticated", admin.authId,
      `UPDATE public.social_task_submissions SET status='pending' WHERE id=$1`, [sub]);
    expect(r2.error ?? "").toMatch(/verified submissions are immutable/i);
  });

  it("client-supplied points are never trusted; member cannot mutate awards", async () => {
    const sub = (await q(`SELECT id FROM politicore.social_task_submissions LIMIT 1`))[0].id as string;
    const r = await as(db, "authenticated", social.authId,
      `INSERT INTO public.social_point_awards (tenant_id, recipient_id, submission_id, points)
       VALUES ($1,$1,$2,99999)`, [tenantA, sub]);
    expect(r.error ?? "").toMatch(/permission denied|row-level|policy/i);

    const u = await as(db, "authenticated", social.authId,
      `UPDATE public.social_point_awards SET points=0 WHERE recipient_id=$1`, [social.authId]);
    expect((u as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
  });

  it("member cannot mutate profiles.points (projection is server-maintained)", async () => {
    const before = Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points);
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.politicore_profiles SET points = 100000 WHERE id = $1`, [social.authId]);
    expect(r.error ?? "").toMatch(/permission denied|row-level|policy|immutable/i);
    const after = Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points);
    expect(after).toBe(before);
  });

  it("verification lands in system_audits with server-resolved actor + tenant", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "audit-flow", points: 5 });
    const sub = await seedSubmission(task, social2.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const audits = await q(
      `SELECT action, actor_id, tenant_id FROM politicore.system_audits
       WHERE resource_id=$1 AND action='social_submission:verify'`, [sub]);
    expect(audits.length).toBe(1);
    expect(audits[0].actor_id).toBe(admin.authId);
    expect(audits[0].tenant_id).toBe(tenantA);
  });
});

describe("leaderboard projection", () => {
  it("derives from authoritative points; ranks are dense, ordered, minimal-field", async () => {
    // Self-sufficient fixture: a fresh 10-point award for social2.
    const task = await seedTask({ tenantId: tenantA, title: "lb-fixture", points: 10 });
    const before2 = Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social2.authId]))[0].points);
    const sub = await seedSubmission(task, social2.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const lb = await as(db, "authenticated", social.authId, `SELECT * FROM public.social_leaderboard ORDER BY position`);
    expect(lb.error).toBeUndefined();
    const rows = lb.rows as Record<string, unknown>[];
    const mine = rows.find((r) => r.id === social2.authId);
    expect(mine).toBeTruthy();
    expect(Number(mine!.points)).toBe(before2 + 10);
    expect(rows.every((r) => Number(r.points) > 0)).toBe(true);
    // Reduced projection: no polling-unit, email or contact fields (gate §22).
    expect(rows[0]).not.toHaveProperty("polling_unit_id");
    expect(rows[0]).not.toHaveProperty("email");
    // Ranks are contiguous and monotonic.
    rows.forEach((r, i) => expect(Number(r.position)).toBe(i + 1));
  });

  it("anon is fail-closed: no leaderboard rows, no profile rows", async () => {
    const lb = await as(db, "anon", null, `SELECT count(*)::int n FROM public.social_leaderboard`);
    expect(lb.rows[0].n).toBe(0);
    const prof = await as(db, "anon", null, `SELECT count(*)::int n FROM public.politicore_profiles`);
    expect(prof.rows[0].n).toBe(0);
  });

  it("leaderboard projection is not client-mutable through the data API", async () => {
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.social_leaderboard SET points = 1000000 WHERE id = $1`, [social.authId]);
    expect(r.error ?? "").toMatch(/permission denied|read-only|cannot/i);
    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points)).toBeLessThan(1000000);
  });
});

describe("cross-module boundaries", () => {
  it("social enablement does not open Campaign; social members gain no Campaign surface", async () => {
    const acts = await as(db, "authenticated", social.authId,
      `SELECT count(*)::int n FROM public.campaign_activities`);
    expect(acts.rows[0].n).toBe(0); // tenant A is social-only + social member has no campaign membership

    // And Campaign's authorized user (campaignOnly) is still denied Social.
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='mem-boundary'`))[0].id as string;
    const submit = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(submit.error ?? "").toMatch(/social membership is required/i);
  });
});
