/**
 * POLITICORE — Social Force Phase C security suite (Submissions + Verification).
 *
 * Runs against the same local PGlite database as the other security
 * suites (migrations 0000–0028). Phase C completed the submission and
 * verification experience on the Phase A substrate; this suite proves
 * the full §25 matrix for that surface:
 *
 *   module gating · membership/authority · ownership (server-derived) ·
 *   lifecycle (pending → verified; verified immutable) · proof contract ·
 *   award integrity (exactly task.points, one award, authoritative
 *   recipient/verifier) · audit + notification side effects ·
 *   tenant isolation · direct PostgREST abuse · Firebase boundary of
 *   the migrated submission path.
 *
 * The Phase A suite (phaseA-social-force.test.ts) established the deep
 * substrate matrix; Phase C re-proves the §25 items against the SAME
 * fixture model with explicit cross-checks. No Campaign, Election, or
 * Core object is modified.
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

beforeAll(async () => {
  db = await getDb();

  const tA = await createTenant(db, "sfc-a", "SFC Tenant A", SOCIAL_ONLY);
  const tB = await createTenant(db, "sfc-b", "SFC Tenant B", ALL);
  tenantA = tA;
  tenantB = tB;

  admin = await createUser(db, { tenantId: tA, email: "adm@sfc.test", fullName: "Admin A", accessRole: "admin" });
  social = await createUser(db, { tenantId: tA, email: "soc1@sfc.test", fullName: "Social One", membershipTypes: ["social_member"] });
  social2 = await createUser(db, { tenantId: tA, email: "soc2@sfc.test", fullName: "Social Two", membershipTypes: ["social_member"] });
  campaignOnly = await createUser(db, { tenantId: tA, email: "cmp@sfc.test", fullName: "Camp Only", membershipTypes: ["campaign_member"] });
  officer = await createUser(db, { tenantId: tA, email: "eo@sfc.test", fullName: "Officer A", accessRole: "election_officer" });

  socialB = await createUser(db, { tenantId: tB, email: "soc@sfc-b.test", fullName: "Social B", membershipTypes: ["social_member"] });
});

// ── module gating ────────────────────────────────────────────────────────

describe("module gating", () => {
  it("social disabled → submission AND verification denied (fail-closed)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "gate-c" });
    const sub = await seedSubmission(task, social.authId);
    await q(`UPDATE politicore.tenant_modules SET enabled=false WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    try {
      const submit = await as(db, "authenticated", social.authId,
        `SELECT public.submit_social_task($1)`, [task]);
      expect(submit.error ?? "").toMatch(/social module is not enabled/i);

      const verify = await as(db, "authenticated", admin.authId,
        `SELECT public.verify_social_submission($1)`, [sub]);
      expect(verify.error ?? "").toMatch(/social module is not enabled/i);

      // Reads fail closed too.
      const vis = await as(db, "authenticated", admin.authId,
        `SELECT count(*)::int n FROM public.social_task_submissions`);
      expect(vis.rows[0].n).toBe(0);
    } finally {
      await q(`UPDATE politicore.tenant_modules SET enabled=true WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    }
  });

  it("social enabled → member submission path works end-to-end", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "enabled-c", points: 20 });
    const s = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/on')`, [task]);
    expect(s.error).toBeUndefined();
    const row = (await q(
      `SELECT status::text st, submitter_id FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]))[0];
    expect(row.st).toBe("pending");
    expect(row.submitter_id).toBe(social.authId);
  });
});

// ── membership / authority ───────────────────────────────────────────────

describe("membership and verification authority", () => {
  it("campaign-only member cannot submit or verify", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "camp-deny-c", points: 20 });
    const sub = await seedSubmission(task, social.authId);

    const submit = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(submit.error ?? "").toMatch(/social membership is required/i);

    const verify = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.verify_social_submission($1)`, [sub]);
    expect(verify.error ?? "").toMatch(/admin authority/i);
  });

  it("election officer without social authority cannot submit or verify", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='camp-deny-c'`))[0].id as string;
    const sub = (await q(
      `SELECT id FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]))[0].id as string;

    const submit = await as(db, "authenticated", officer.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(submit.error ?? "").toMatch(/social membership is required/i);

    const verify = await as(db, "authenticated", officer.authId,
      `SELECT public.verify_social_submission($1)`, [sub]);
    expect(verify.error ?? "").toMatch(/admin authority/i);
  });

  it("ordinary social member cannot verify (admin-only authority)", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='enabled-c'`))[0].id as string;
    const sub = (await q(
      `SELECT id FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2 AND status='pending'`,
      [task, social.authId]))[0].id as string;

    const verify = await as(db, "authenticated", social.authId,
      `SELECT public.verify_social_submission($1)`, [sub]);
    expect(verify.error ?? "").toMatch(/admin authority/i);
  });

  it("admin without social membership can verify (access-role authority)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "admin-verify-c", points: 5 });
    const sub = await seedSubmission(task, social2.authId);
    const v = await as(db, "authenticated", admin.authId,
      `SELECT public.verify_social_submission($1)`, [sub]);
    expect(v.error).toBeUndefined();
  });
});

// ── ownership (server-derived; client never trusted) ─────────────────────

describe("submission ownership", () => {
  it("member cannot insert a submission for another user (RLS)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "own-insert" });
    const r = await as(db, "authenticated", social.authId,
      `INSERT INTO public.social_task_submissions (tenant_id, task_id, submitter_id) VALUES ($1, $2, $3)`,
      [tenantA, task, social2.authId]);
    expect(r.error ?? "").toMatch(/row-level security|violates row-level|policy/i);
    expect((await q(
      `SELECT count(*)::int n FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social2.authId]))[0].n).toBe(0);
  });

  it("member cannot alter another user's submission (RLS: zero rows)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "own-alter" });
    const sub = await seedSubmission(task, social2.authId, "https://proof.example/orig");
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.social_task_submissions SET proof_url='https://evil' WHERE id=$1`, [sub]);
    expect((r as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
    expect((await q(`SELECT proof_url FROM politicore.social_task_submissions WHERE id=$1`, [sub]))[0].proof_url)
      .toBe("https://proof.example/orig");
  });

  it("submitter_id is immutable (ownership guard)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "own-immutable" });
    const sub = await seedSubmission(task, social.authId);
    const r = await as(db, "authenticated", admin.authId,
      `UPDATE politicore.social_task_submissions SET submitter_id=$1 WHERE id=$2`, [social2.authId, sub]);
    expect(r.error ?? "").toMatch(/ownership is immutable/i);
  });

  it("tenant_id is immutable", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='own-immutable'`))[0].id as string;
    const sub = (await q(
      `SELECT id FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]))[0].id as string;
    const r = await as(db, "authenticated", admin.authId,
      `UPDATE politicore.social_task_submissions SET tenant_id=$1 WHERE id=$2`, [tenantB, sub]);
    expect(r.error ?? "").toMatch(/ownership is immutable/i);
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────

describe("submission lifecycle", () => {
  it("new submission → pending; pending proof update works; one row per member/task", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "life-c", action: "share", proofRequired: true });

    const s1 = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/v1')`, [task]);
    expect(s1.error).toBeUndefined();
    expect((await q(
      `SELECT status::text st FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]))[0].st).toBe("pending");

    const s2 = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/v2')`, [task]);
    expect(s2.error).toBeUndefined();
    const rows = await q(
      `SELECT proof_url, status::text st FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [task, social.authId]);
    expect(rows).toHaveLength(1); // UNIQUE(task_id, submitter_id) upsert
    expect(rows[0].proof_url).toBe("https://proof.example/v2");
    expect(rows[0].st).toBe("pending");
  });

  it("pending → verified via the RPC; then every mutation is refused", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "life-verify-c", points: 15 });
    const sub = await seedSubmission(task, social.authId, "https://proof.example/lv");

    const v = await as(db, "authenticated", admin.authId,
      `SELECT public.verify_social_submission($1)`, [sub]);
    expect(v.error).toBeUndefined();
    expect((await q(`SELECT status::text st FROM politicore.social_task_submissions WHERE id=$1`, [sub]))[0].st)
      .toBe("verified");

    // Second verification refused.
    const again = await as(db, "authenticated", admin.authId,
      `SELECT public.verify_social_submission($1)`, [sub]);
    expect(again.error ?? "").toMatch(/already been verified/i);

    // Direct mutation of the verified row refused (guard + policy).
    const flip = await as(db, "authenticated", admin.authId,
      `UPDATE public.social_task_submissions SET status='pending' WHERE id=$1`, [sub]);
    expect(flip.error ?? "").toMatch(/verified submissions are immutable|row-level/i);

    // Resubmission against a verified submission refused.
    const resub = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/late')`, [task]);
    expect(resub.error ?? "").toMatch(/already been verified/i);
  });

  it("inactive and expired tasks refuse submission", async () => {
    const inactive = await seedTask({ tenantId: tenantA, title: "life-inactive-c", status: "inactive" });
    const r1 = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [inactive]);
    expect(r1.error ?? "").toMatch(/task is not active/i);

    const expired = await seedTask({ tenantId: tenantA, title: "life-expired-c", expirationDate: new Date(Date.now() - 3600_000) });
    const r2 = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [expired]);
    expect(r2.error ?? "").toMatch(/task has expired/i);
  });
});

// ── proof contract ───────────────────────────────────────────────────────

describe("proof contract", () => {
  it("proof-required task refuses submission without proof", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "proof-req-c", action: "share", proofRequired: true });
    const r = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [task]);
    expect(r.error ?? "").toMatch(/proof url is required/i);
  });

  it("proof-required task accepts valid proof; not-required task accepts none", async () => {
    const req = await seedTask({ tenantId: tenantA, title: "proof-ok-c", action: "share", proofRequired: true });
    const ok = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1, 'https://proof.example/ok')`, [req]);
    expect(ok.error).toBeUndefined();

    const noReq = await seedTask({ tenantId: tenantA, title: "proof-none-c", action: "like", proofRequired: false });
    const none = await as(db, "authenticated", social.authId, `SELECT public.submit_social_task($1)`, [noReq]);
    expect(none.error).toBeUndefined();
    expect((await q(
      `SELECT proof_url FROM politicore.social_task_submissions WHERE task_id=$1 AND submitter_id=$2`,
      [noReq, social.authId]))[0].proof_url).toBeNull();
  });
});

// ── award integrity ──────────────────────────────────────────────────────

describe("award integrity", () => {
  it("verification awards exactly task.points to the submitter from the verifier; duplicate impossible", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "award-c", points: 77 });
    const sub = await seedSubmission(task, social.authId);

    const before = Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points);
    const v = await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);
    expect(v.error).toBeUndefined();

    const awards = await q(
      `SELECT points, recipient_id, awarded_by, source FROM politicore.social_point_awards WHERE submission_id=$1`, [sub]);
    expect(awards).toHaveLength(1);
    expect(Number(awards[0].points)).toBe(77); // exactly task.points — never client-supplied
    expect(awards[0].recipient_id).toBe(social.authId);
    expect(awards[0].awarded_by).toBe(admin.authId);
    expect(awards[0].source).toBe("task_verification");

    // profiles.points projection moved only through the authoritative path.
    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points))
      .toBe(before + 77);

    // Direct award INSERT denied (no grant / policy).
    const direct = await as(db, "authenticated", admin.authId,
      `INSERT INTO public.social_point_awards (tenant_id, recipient_id, submission_id, points, awarded_by)
       VALUES ($1,$2,$3,1,$4)`, [tenantA, social.authId, sub, admin.authId]);
    expect(direct.error ?? "").toMatch(/permission denied|unique|duplicate/i);
  });

  it("member cannot insert awards or mutate points (client cannot award)", async () => {
    const sub = (await q(`SELECT id FROM politicore.social_task_submissions WHERE submitter_id=$1 LIMIT 1`, [social.authId]))[0].id as string;

    const ins = await as(db, "authenticated", social.authId,
      `INSERT INTO public.social_point_awards (tenant_id, recipient_id, submission_id, points)
       VALUES ($1,$1,$2,99999)`, [tenantA, sub]);
    expect(ins.error ?? "").toMatch(/permission denied|row-level|policy/i);

    const before = Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points);
    const prof = await as(db, "authenticated", social.authId,
      `UPDATE public.politicore_profiles SET points = 100000 WHERE id = $1`, [social.authId]);
    expect(prof.error ?? "").toMatch(/permission denied|row-level|policy|immutable/i);
    expect(Number((await q(`SELECT points FROM politicore.profiles WHERE id=$1`, [social.authId]))[0].points)).toBe(before);

    // Admin cannot type an arbitrary amount either: the RPC takes no points argument.
    const fn = await q(
      `SELECT array_to_string(p.proargnames, ',') args FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='politicore' AND p.proname='verify_social_submission'`);
    expect(String(fn[0].args ?? "")).not.toContain("points");
  });
});

// ── audit + notification side effects ────────────────────────────────────

describe("audit and notification side effects", () => {
  it("verification produces system_audits with server-resolved actor + tenant", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "audit-c", points: 6 });
    const sub = await seedSubmission(task, social2.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const audits = await q(
      `SELECT action, actor_id, tenant_id FROM politicore.system_audits
       WHERE resource_id=$1 AND action='social_submission:verify'`, [sub]);
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_id).toBe(admin.authId);
    expect(audits[0].tenant_id).toBe(tenantA);
  });

  it("verification notifies the submitter (server-generated, Core infrastructure)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "notify-c", points: 8 });
    const sub = await seedSubmission(task, social.authId);
    await as(db, "authenticated", admin.authId, `SELECT public.verify_social_submission($1)`, [sub]);

    const notes = await q(
      `SELECT type, user_id, title, link_url FROM politicore.notifications
       WHERE user_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [social.authId, tenantA]);
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe("task");
    expect(notes[0].title).toBe("Task verified");
    expect(notes[0].link_url).toBe("/portal/tasks");
    expect(String(notes[0].title) + JSON.stringify(notes[0])).not.toMatch(/undefined/);
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("cross-tenant submission, read, and verification all fail closed", async () => {
    // Tenant A task is invisible to tenant-B member: RPC pins tenant.
    const taskA = (await q(`SELECT id FROM politicore.social_tasks WHERE title='enabled-c'`))[0].id as string;
    const submit = await as(db, "authenticated", socialB.authId,
      `SELECT public.submit_social_task($1)`, [taskA]);
    expect(submit.error ?? "").toMatch(/task not found/i);

    // Tenant-B member cannot read tenant-A submissions.
    const read = await as(db, "authenticated", socialB.authId,
      `SELECT count(*)::int n FROM public.social_task_submissions`);
    expect(read.rows[0].n).toBe(0);

    // Tenant-A admin cannot verify a tenant-B submission (definer pins tenant).
    const taskB = await seedTask({ tenantId: tenantB, title: "iso-b-c", points: 10 });
    const subB = await seedSubmission(taskB, socialB.authId);
    const verify = await as(db, "authenticated", admin.authId,
      `SELECT public.verify_social_submission($1)`, [subB]);
    expect(verify.error ?? "").toMatch(/submission not found/i);
    expect((await q(`SELECT status::text st FROM politicore.social_task_submissions WHERE id=$1`, [subB]))[0].st)
      .toBe("pending");
  });
});

// ── direct PostgREST abuse ───────────────────────────────────────────────

describe("direct PostgREST abuse", () => {
  it("anon and member direct probes all fail closed", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='enabled-c'`))[0].id as string;

    // Anon: no grants on submissions/awards.
    const anonIns = await as(db, "anon", null,
      `INSERT INTO public.social_task_submissions (tenant_id, task_id, submitter_id) VALUES ($1,$2,$3)`,
      [tenantA, task, social.authId]);
    expect(anonIns.error ?? "").toMatch(/permission denied|row-level|policy/i);

    const anonAwards = await as(db, "anon", null, `SELECT count(*)::int n FROM public.social_point_awards`);
    expect(anonAwards.error ?? "").toMatch(/permission denied/i);

    // Member DELETE is not granted.
    const del = await as(db, "authenticated", social.authId,
      `DELETE FROM public.social_task_submissions WHERE submitter_id = auth.uid()`);
    expect(del.error ?? "").toMatch(/permission denied/i);

    // Admin cannot bypass the award ledger by deleting awards.
    const awardDel = await as(db, "authenticated", admin.authId,
      `DELETE FROM public.social_point_awards WHERE recipient_id = $1`, [social.authId]);
    expect(awardDel.error ?? "").toMatch(/permission denied/i);
  });
});

// ── Firebase boundary of the migrated submission path ────────────────────

describe("firebase boundary (migrated submission path)", () => {
  const SUBMISSION_PATH = [
    "src/lib/supabase/socialForce.ts",
    "src/app/portal/tasks/page.tsx",
    "src/app/portal/admin/tasks/page.tsx",
  ];

  const LEGACY_FNS = ["submitTaskCompletion", "getUserTaskSubmissions", "getSubmissionsForTaskWithUsers", "verifyTaskSubmission"];

  it("no migrated submission-path file touches Firebase or legacy Social functions", () => {
    const root = resolve(__dirname, "../..");
    for (const rel of SUBMISSION_PATH) {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect({ file: rel, firebase: /from\s+["'][^"']*(firebase|firestore)[^"']*["']/i.test(src) })
        .toEqual({ file: rel, firebase: false });
      for (const fn of LEGACY_FNS) {
        expect({ file: rel, fn, present: src.includes(fn) }).toEqual({ file: rel, fn, present: false });
      }
    }
    // Phase E: the last legacy consumer (SocialMemberDashboard) is cut
    // over too — the whole submission path is Firebase-free.
    const dash = readFileSync(resolve(root, "src/components/dashboard/SocialMemberDashboard.tsx"), "utf8");
    expect(dash.includes("getUserTaskSubmissions")).toBe(false);
    expect(dash.includes("firebase")).toBe(false);
  });

  it("submission mutations are RPC-only in the service", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/lib/supabase/socialForce.ts"), "utf8");
    expect(src).toContain('"submit_social_task"');
    expect(src).toContain('"verify_social_submission"');
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });

  it("typed error classification covers the submission/verification refusals", () => {
    expect(classifySocialError("social membership is required to submit tasks")).toBe("forbidden");
    expect(classifySocialError("submission has already been verified")).toBe("conflict");
    expect(classifySocialError("proof URL is required for this task")).toBe("validation");
    expect(classifySocialError("task is not active")).toBe("invalid_transition");
    expect(classifySocialError("submission not found")).toBe("not_found");
    expect(classifySocialError("submission verification requires admin authority")).toBe("forbidden");
  });
});
