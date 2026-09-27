/**
 * POLITICORE — Social Force Phase B security suite (Tasks surface cutover).
 *
 * Runs against the same local PGlite database as the other security
 * suites (migrations 0000–0028). Phase B migrated the Tasks UI/service
 * onto the Phase A substrate; this suite proves the *surface* contract:
 *
 *   module gating for every authority RPC · tenant isolation on task
 *   management · membership/authority boundaries · task lifecycle
 *   (active ↔ inactive, no draft) · member visibility semantics ·
 *   service-mapping invariants (clearable fields, admin CRUD) ·
 *   cross-module boundaries · Firebase boundary of the migrated Tasks
 *   path (static scan) · typed error classification (§16).
 *
 * The full Phase A database matrix lives in phaseA-social-force.test.ts.
 * No Campaign, Election, or Core object is modified.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { as, createTenant, createUser, getDb } from "./helpers";
import { classifySocialError, SocialForceError } from "../../src/lib/supabase/socialForce";

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
let campaignOnly: FixtureUser;
let officer: FixtureUser;
let socialB: FixtureUser;

const RLS_ERR = /row-level security|violates row-level|policy/i;
void RLS_ERR; // reserved for direct-INSERT abuse probes added in later phases

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
  targetUrl?: string | null;
}) {
  const rows = await q(
    `INSERT INTO politicore.social_tasks
       (tenant_id, title, platform, action, points, status, proof_required, expiration_date, target_url, created_by)
     VALUES ($1,$2,'facebook',$3::politicore.social_task_action,$4,$5::politicore.social_task_status,$6,$7,$8,$9)
     RETURNING id`,
    [
      opts.tenantId,
      opts.title ?? "Fixture task",
      opts.action ?? "like",
      opts.points ?? 50,
      opts.status ?? "active",
      opts.proofRequired ?? false,
      opts.expirationDate ?? null,
      opts.targetUrl ?? null,
      admin.authId,
    ]
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  db = await getDb();

  // Tenant A: social-only active (the Social Force operating mode).
  const tA = await createTenant(db, "sfb-a", "SFB Tenant A", SOCIAL_ONLY);
  // Tenant B: fully provisioned — used for cross-tenant isolation.
  const tB = await createTenant(db, "sfb-b", "SFB Tenant B", ALL);
  tenantA = tA;
  tenantB = tB;

  admin = await createUser(db, { tenantId: tA, email: "adm@sfb.test", fullName: "Admin A", accessRole: "admin" });
  social = await createUser(db, { tenantId: tA, email: "soc@sfb.test", fullName: "Social One", membershipTypes: ["social_member"] });
  campaignOnly = await createUser(db, { tenantId: tA, email: "cmp@sfb.test", fullName: "Camp Only", membershipTypes: ["campaign_member"] });
  officer = await createUser(db, { tenantId: tA, email: "eo@sfb.test", fullName: "Officer A", accessRole: "election_officer" });

  socialB = await createUser(db, { tenantId: tB, email: "soc@sfb-b.test", fullName: "Social B", membershipTypes: ["social_member"] });
});

// ── module gating (every authority RPC fails closed) ─────────────────────

describe("module gating", () => {
  it("social disabled → task management RPCs refuse (create already covered in Phase A)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "gate-task" });
    await q(`UPDATE politicore.tenant_modules SET enabled=false WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    try {
      const upd = await as(db, "authenticated", admin.authId,
        `SELECT public.update_social_task($1, 'nope')`, [task]);
      expect(upd.error ?? "").toMatch(/social module is not enabled/i);

      const st = await as(db, "authenticated", admin.authId,
        `SELECT public.set_social_task_status($1, 'inactive')`, [task]);
      expect(st.error ?? "").toMatch(/social module is not enabled/i);

      const sub = await as(db, "authenticated", social.authId,
        `SELECT public.submit_social_task($1)`, [task]);
      expect(sub.error ?? "").toMatch(/social module is not enabled/i);

      const ver = await as(db, "authenticated", admin.authId,
        `SELECT public.verify_social_submission($1::uuid)`, [crypto.randomUUID()]);
      expect(ver.error ?? "").toMatch(/social module is not enabled/i);

      // Reads fail closed too: the listing the UI consumes returns nothing.
      const vis = await as(db, "authenticated", admin.authId,
        `SELECT count(*)::int n FROM public.social_tasks`);
      expect(vis.rows[0].n).toBe(0);
    } finally {
      await q(`UPDATE politicore.tenant_modules SET enabled=true WHERE tenant_id=$1 AND module='social'`, [tenantA]);
    }
  });
});

// ── tenant isolation on the management surface ───────────────────────────

describe("tenant isolation (task management)", () => {
  it("admin cannot update another tenant's task", async () => {
    const idB = await seedTask({ tenantId: tenantB, title: "b-task" });
    const r = await as(db, "authenticated", admin.authId,
      `SELECT public.update_social_task($1, 'hijacked')`, [idB]);
    expect(r.error ?? "").toMatch(/task not found/i);
    expect((await q(`SELECT title FROM politicore.social_tasks WHERE id=$1`, [idB]))[0].title)
      .not.toBe("hijacked");
  });

  it("admin cannot transition another tenant's task", async () => {
    const idB = (await q(`SELECT id FROM politicore.social_tasks WHERE title='b-task'`))[0].id as string;
    const r = await as(db, "authenticated", admin.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [idB]);
    expect(r.error ?? "").toMatch(/task not found/i);
    expect((await q(`SELECT status::text s FROM politicore.social_tasks WHERE id=$1`, [idB]))[0].s)
      .toBe("active");
  });

  it("tenant-B member cannot see tenant-A tasks", async () => {
    await seedTask({ tenantId: tenantA, title: "iso-a-task" });
    const vis = await as(db, "authenticated", socialB.authId,
      `SELECT count(*)::int n FROM public.social_tasks WHERE title='iso-a-task'`);
    expect(vis.rows[0].n).toBe(0);
  });
});

// ── membership / authority boundaries ────────────────────────────────────

describe("membership and authority boundaries", () => {
  it("social member cannot create, edit, or transition tasks", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "auth-boundary" });

    const c = await as(db, "authenticated", social.authId,
      `SELECT public.create_social_task('member task')`);
    expect(c.error ?? "").toMatch(/admin authority/i);

    const u = await as(db, "authenticated", social.authId,
      `SELECT public.update_social_task($1, 'owned')`, [task]);
    expect(u.error ?? "").toMatch(/admin authority/i);

    const s = await as(db, "authenticated", social.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [task]);
    expect(s.error ?? "").toMatch(/admin authority/i);
  });

  it("campaign-only member cannot manage or submit tasks", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='auth-boundary'`))[0].id as string;
    const c = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.create_social_task('camp task')`);
    expect(c.error ?? "").toMatch(/admin authority/i);
    const u = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.update_social_task($1, 'owned')`, [task]);
    expect(u.error ?? "").toMatch(/admin authority/i);
    const s = await as(db, "authenticated", campaignOnly.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(s.error ?? "").toMatch(/social membership is required/i);
    // And the member listing shows nothing (no social membership → no rows).
    const vis = await as(db, "authenticated", campaignOnly.authId,
      `SELECT count(*)::int n FROM public.social_tasks`);
    expect(vis.rows[0].n).toBe(0);
  });

  it("election officer without social authority cannot manage tasks", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='auth-boundary'`))[0].id as string;
    const c = await as(db, "authenticated", officer.authId,
      `SELECT public.create_social_task('eo task')`);
    expect(c.error ?? "").toMatch(/admin authority/i);
    const s = await as(db, "authenticated", officer.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [task]);
    expect(s.error ?? "").toMatch(/admin authority/i);
  });

  it("direct member table mutation bypassing the RPC is denied", async () => {
    const task = (await q(`SELECT id FROM politicore.social_tasks WHERE title='auth-boundary'`))[0].id as string;
    const r = await as(db, "authenticated", social.authId,
      `UPDATE public.social_tasks SET points = 99999 WHERE id = $1`, [task]);
    expect((r as unknown as { rowCount?: number }).rowCount ?? 0).toBe(0);
    expect(Number((await q(`SELECT points FROM politicore.social_tasks WHERE id=$1`, [task]))[0].points)).toBe(50);
  });
});

// ── task lifecycle (active ↔ inactive; no draft state) ───────────────────

describe("task lifecycle", () => {
  it("admin toggles active → inactive → active via the status RPC", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "lifecycle" });

    await as(db, "authenticated", admin.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [task]);
    expect((await q(`SELECT status::text s FROM politicore.social_tasks WHERE id=$1`, [task]))[0].s)
      .toBe("inactive");

    await as(db, "authenticated", admin.authId,
      `SELECT public.set_social_task_status($1, 'active')`, [task]);
    expect((await q(`SELECT status::text s FROM politicore.social_tasks WHERE id=$1`, [task]))[0].s)
      .toBe("active");
  });

  it("member visibility follows the lifecycle: active visible, inactive hidden", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "vis-active" });

    const visActive = await as(db, "authenticated", social.authId,
      `SELECT count(*)::int n FROM public.social_tasks WHERE id=$1`, [task]);
    expect(visActive.rows[0].n).toBe(1);

    await as(db, "authenticated", admin.authId,
      `SELECT public.set_social_task_status($1, 'inactive')`, [task]);
    const visInactive = await as(db, "authenticated", social.authId,
      `SELECT count(*)::int n FROM public.social_tasks WHERE id=$1`, [task]);
    expect(visInactive.rows[0].n).toBe(0);
  });

  it("inactive task cannot be submitted (server-enforced, not UI-enforced)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "submit-inactive", status: "inactive" });
    const r = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(r.error ?? "").toMatch(/task is not active/i);
  });

  it("expired task cannot be submitted", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "submit-expired", expirationDate: new Date(Date.now() - 3600_000) });
    const r = await as(db, "authenticated", social.authId,
      `SELECT public.submit_social_task($1)`, [task]);
    expect(r.error ?? "").toMatch(/task has expired/i);
  });

  it("invalid task data is rejected by the database (points, title)", async () => {
    const negative = await as(db, "authenticated", admin.authId,
      `SELECT public.create_social_task('bad points', null, 'facebook', 'like', -5)`);
    expect(negative.error ?? "").toMatch(/check|points|invalid/i);

    const empty = await as(db, "authenticated", admin.authId,
      `SELECT public.create_social_task('   ')`);
    expect(empty.error ?? "").toMatch(/check|title|length/i);

    const zeroOk = await as(db, "authenticated", admin.authId,
      `SELECT public.create_social_task('zero points ok', null, 'facebook', 'like', 0)`);
    expect(zeroOk.error).toBeUndefined(); // points >= 0 is legal; 0 is merely unscoreable
  });

  it("valid admin create + update through the RPCs succeed", async () => {
    const c = await as(db, "authenticated", admin.authId,
      `SELECT public.create_social_task('b-create', 'desc', 'tiktok', 'make_post', 75, 'active', 'https://x.com/t', true)`);
    expect(c.error).toBeUndefined();
    const id = c.rows[0].create_social_task as string;

    const u = await as(db, "authenticated", admin.authId,
      `SELECT public.update_social_task($1, 'b-create v2', null, 'x', 'comment', 80, null, null, false, null)`, [id]);
    expect(u.error).toBeUndefined();
    const row = (await q(
      `SELECT title, platform::text p, action::text a, points, proof_required pr FROM politicore.social_tasks WHERE id=$1`, [id]))[0];
    expect(row.title).toBe("b-create v2");
    expect(row.p).toBe("x");
    expect(row.a).toBe("comment");
    expect(Number(row.points)).toBe(80);
    expect(row.pr).toBe(false);
  });

  it("update with empty string clears a clearable field (service mapping contract)", async () => {
    const task = await seedTask({ tenantId: tenantA, title: "clearable", targetUrl: "https://x.com/old" });
    await as(db, "authenticated", admin.authId,
      `SELECT public.update_social_task($1, null, null, null, null, null, null, '', null, null)`, [task]);
    expect((await q(`SELECT target_url FROM politicore.social_tasks WHERE id=$1`, [task]))[0].target_url)
      .toBeNull();
  });

  it("task status enum admits no draft-like state", async () => {
    const types = await q(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'social_task_status' ORDER BY enumsortorder`);
    expect(types.map((r) => r.enumlabel)).toEqual(["active", "inactive"]);
  });
});

// ── typed error classification (§16: distinguishable failure modes) ──────

describe("service error classification", () => {
  it("maps raw server refusals to the documented kinds", () => {
    expect(classifySocialError("social module is not enabled")).toBe("module_disabled");
    expect(classifySocialError("task management requires admin authority")).toBe("forbidden");
    expect(classifySocialError("social membership is required to submit tasks")).toBe("forbidden");
    expect(classifySocialError("task not found")).toBe("not_found");
    expect(classifySocialError("task is not active")).toBe("invalid_transition");
    expect(classifySocialError("task has expired")).toBe("invalid_transition");
    expect(classifySocialError("submission has already been verified")).toBe("conflict");
    expect(classifySocialError("proof URL is required for this task")).toBe("validation");
    expect(classifySocialError("unauthenticated")).toBe("unauthenticated");
    expect(classifySocialError("some unexpected pg error")).toBe("infra");
  });

  it("SocialForceError presents a user-safe message per kind", () => {
    const err = new SocialForceError("module_disabled");
    expect(err.kind).toBe("module_disabled");
    expect(err.message).toMatch(/Social Force module is not enabled/i);
    expect(err.name).toBe("SocialForceError");
  });
});

// ── cross-module boundaries ──────────────────────────────────────────────

describe("cross-module boundaries", () => {
  it("Social Task cutover introduces no Campaign-owned task/points surface", async () => {
    const tbl = await db.query(
      `SELECT count(*) n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'politicore'
         AND (c.relname ILIKE 'campaign%task%' OR c.relname ILIKE 'campaign%point%' OR c.relname ILIKE 'campaign%leaderboard%')`);
    expect(Number((tbl.rows[0] as Record<string, unknown>).n)).toBe(0);
  });

  it("Social enablement grants no Campaign rows to social members", async () => {
    const acts = await as(db, "authenticated", social.authId,
      `SELECT count(*)::int n FROM public.campaign_activities`);
    expect(acts.rows[0].n).toBe(0);
  });
});

// ── Firebase boundary of the migrated Tasks path (§18 static scan) ───────

describe("firebase boundary (migrated Tasks path)", () => {
  const MIGRATED_TASKS_PATH = [
    "src/lib/supabase/socialForce.ts",
    "src/app/portal/tasks/page.tsx",
    "src/app/portal/admin/tasks/page.tsx",
    "src/lib/supabase/access.ts",
  ];

  /**
   * GlobalSearchModal is a shared surface whose Members/News sources are
   * still on legacy Firebase (not-yet-migrated surfaces — permitted
   * temporarily). Its TASKS source must be Supabase-only: the Firebase
   * tenant-wide getAllTasks read is the Phase B cutover target.
   */
  const SEARCH_MODAL = "src/components/search/GlobalSearchModal.tsx";

  const FORBIDDEN = [
    /from\s+["'][^"']*firebase[^"']*["']/i,
    /from\s+["'][^"']*firestore[^"']*["']/i,
    /\bgetDocs\b/,
    /\bgetDoc\b/,
    /\bsetDoc\b/,
    /\bupdateDoc\b/,
    /\bdeleteDoc\b/,
    /\bonSnapshot\b/,
    /\bcollection\s*\(/,
    /\bquery\s*\(/,
    /\borderBy\s*\(/,
  ];

  it("no migrated Tasks-path file imports or calls Firebase/Firestore", () => {
    const root = resolve(__dirname, "../..");
    for (const rel of MIGRATED_TASKS_PATH) {
      const src = readFileSync(resolve(root, rel), "utf8");
      for (const pattern of FORBIDDEN) {
        expect({ file: rel, pattern: String(pattern), hit: pattern.test(src) })
          .toEqual({ file: rel, pattern: String(pattern), hit: false });
      }
    }
  });

  it("GlobalSearchModal's Tasks source is the Supabase service, not the Firebase tenant-wide read", () => {
    const src = readFileSync(resolve(__dirname, "../../" + SEARCH_MODAL), "utf8");
    expect(src).not.toContain("getAllTasks");
    expect(src).toContain("getSocialTasks");
  });

  it("the canonical service resolves task operations through the Phase A RPCs and views", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/lib/supabase/socialForce.ts"), "utf8");
    for (const rpc of ["create_social_task", "update_social_task", "set_social_task_status", "submit_social_task", "verify_social_submission"]) {
      expect(src).toContain(`"${rpc}"`);
    }
    // Reads go through the security_invoker views, never the base tables.
    expect(src).toContain('.from("social_tasks")');
    expect(src).not.toContain('.from("politicore.social_tasks")');
    // No client write path at all: every mutation is an rpc() call, so
    // tenant/actor/recipient can never be client-supplied (gate §41).
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });
});
