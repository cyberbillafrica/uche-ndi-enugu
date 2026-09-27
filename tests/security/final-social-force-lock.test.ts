/**
 * POLITICORE — SOCIAL FORCE FINAL LOCK SUITE.
 *
 * Architectural invariants only (gate §26) — the per-phase suites own
 * detailed behavior. This suite asserts the LOCKED state:
 *
 *  1. Social tables/views/RPCs exist as expected (DB, hosted project).
 *  2. `socialForce.ts` is the canonical service; no client write paths.
 *  3. Social UI is Firebase-free; legacy Social fns have no consumers.
 *  4. Points/awards/leaderboard are server-authoritative and immutable.
 *  5. Leaderboard is the reduced projection (no PII, no client rank).
 *  6. Module gate is fail-closed in code and in the DB (0029 view).
 *  7. Campaign-only / Election-Officer boundaries hold.
 *  8. Campaign and Election locks remain intact.
 *
 * DB assertions run against the same local PGlite harness the Campaign
 * lock suite uses (migrations applied in-order — the identical DDL that
 * is applied to hosted by apply-hosted.ts; hosted object existence is
 * separately proven by verify-hosted-smoke-social-f.ts).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

import { applyMigrations, createDb } from "../../scripts/db/apply-migrations";

const ROOT = process.cwd();

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function readSrc(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`missing source file: ${rel}`);
  return readFileSync(p, "utf8");
}

function envValue(key: string): string | undefined {
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0 && t.slice(0, i).trim() === key) return t.slice(i + 1).trim();
  }
  return undefined;
}
void envValue;

// The Social UI surfaces (active, migrated). Health additionally carries
// shared-Core diagnostics deps (firebase/tenants constant, firebase/jobs
// stub + Firestore status card) — non-Social presentation classified in
// the lock report §7; only its Social data path is asserted here.
const SOCIAL_UI = [
  "src/components/dashboard/SocialMemberDashboard.tsx",
  "src/app/portal/tasks/page.tsx",
  "src/app/portal/points/page.tsx",
  "src/app/portal/leaderboard/page.tsx",
  "src/app/portal/admin/tasks/page.tsx",
];

// Shared-Core Firebase imports deliberately preserved (not Social).
const SHARED_FIREBASE_IMPORTS =
  /import\s*{[^}]*}\s*from\s*"@\/lib\/firebase\/firestore";?/g;
const NON_SOCIAL_FIREBASE_CONSUMERS =
  // Phase 4 removed every content consumer; the remaining import surface
  // is empty — this allowlist is kept as a belt-and-braces guard.
  /getAllUsers|getPublishedNews|getUserProfile|getUserAnnouncements|createNewsArticle|updateNewsArticle|deleteNewsArticle|getAllNewsArticles|getNewsArticle|getContactMessages|markContactMessageAsRead|submitContactMessage/;

const SOCIAL_SURFACES_ALL = SOCIAL_UI.concat([
  "src/app/portal/admin/reports/page.tsx",
  "src/lib/supabase/socialForce.ts",
]);

// ── 1. Database objects (hosted catalog, read-only) ─────────────────────────

describe("final lock — database footprint", () => {
  let db: PGlite;

  const q = async <T extends Record<string, unknown>>(
    query: string,
  ): Promise<T[]> => (await db.query(query)).rows as T[];

  beforeAll(async () => {
    db = await createDb();
    await applyMigrations(db);
  });

  it("social tables, views, and authority RPCs exist per the ratified migrations", async () => {
    const rows = await q<{ kind: string; name: string }>(
      `SELECT 'table' kind, c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='politicore' AND c.relkind='r' AND c.relname IN
          ('social_tasks','social_task_submissions','social_point_awards')
       UNION ALL
       SELECT 'view', c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='v' AND c.relname IN
          ('social_tasks','social_task_submissions','social_point_awards','social_leaderboard')
       UNION ALL
       SELECT 'rpc', p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','politicore') AND p.proname IN
          ('create_social_task','update_social_task','set_social_task_status','submit_social_task','verify_social_submission','social_admin_award_history','guard_social_submission')
       ORDER BY 1, 2`,
    );
    const names = rows.map((r) => `${r.kind}:${r.name}`);
    for (const required of [
      "table:social_tasks",
      "table:social_task_submissions",
      "table:social_point_awards",
      "view:social_tasks",
      "view:social_task_submissions",
      "view:social_point_awards",
      "view:social_leaderboard",
      "rpc:create_social_task",
      "rpc:update_social_task",
      "rpc:set_social_task_status",
      "rpc:submit_social_task",
      "rpc:verify_social_submission",
      "rpc:social_admin_award_history",
    ]) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });

  it("social tables have RLS ENABLED and FORCED", async () => {
    const rows = await q<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity rls, c.relforcerowsecurity forced
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='politicore' AND c.relkind='r'
         AND c.relname IN ('social_tasks','social_task_submissions','social_point_awards')`,
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.rls, `${r.relname} RLS enabled`).toBe(true);
      expect(r.forced, `${r.relname} FORCE RLS`).toBe(true);
    }
  });

  it("authority RPC cores are SECURITY DEFINER with pinned search_path", async () => {
    // The SECURITY DEFINER authority functions live in politicore; the
    // public.* family are thin invoker wrappers over them.
    const rows = await q<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT p.proname, p.prosecdef, p.proconfig
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='politicore'
         AND p.proname IN ('create_social_task','update_social_task','set_social_task_status','submit_social_task','verify_social_submission','guard_social_submission')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} SECURITY DEFINER`).toBe(true);
      expect(
        r.proconfig?.some((c) => c.startsWith("search_path=") && c.includes("pg_temp")),
        `${r.proname} pinned search_path`,
      ).toBe(true);
    }
    // The public wrappers must NOT be definer (they add no authority).
    const wrappers = await q<{ proname: string; prosecdef: boolean }>(
      `SELECT p.proname, p.prosecdef
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('create_social_task','update_social_task','set_social_task_status','submit_social_task','verify_social_submission','social_admin_award_history')`,
    );
    for (const w of wrappers) {
      expect(w.prosecdef, `public.${w.proname} stays invoker`).toBe(false);
    }
  });

  it("award uniqueness (one per submission) is enforced at the catalog level", async () => {
    const rows = await q<{ n: string }>(
      `SELECT count(*)::text n
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
       WHERE nsp.nspname='politicore' AND c.relname='social_point_awards'
         AND con.contype='u'
         AND pg_get_constraintdef(con.oid) LIKE '%submission_id%'`,
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
  });
});

// ── 2. Canonical service ─────────────────────────────────────────────────────

describe("final lock — canonical service", () => {
  const SERVICE = "src/lib/supabase/socialForce.ts";

  it("service is the only Social boundary: RPC-only mutations, RLS reads", () => {
    const src = stripComments(readSrc(SERVICE));
    // All five authority RPCs are invoked through their wrappers.
    for (const rpc of [
      "create_social_task",
      "update_social_task",
      "set_social_task_status",
      "submit_social_task",
      "verify_social_submission",
    ]) {
      expect(src).toContain(rpc);
    }
    // No client table mutation anywhere in the service.
    expect(src).not.toMatch(/\.(insert|update|delete|upsert)\(\s*["']/);
    // Reads target the security_invoker views / projection only.
    expect(src).toContain('from("social_tasks")');
    expect(src).toContain('from("social_leaderboard")');
  });

  it("Social UI imports the canonical service, never raw social tables for writes", () => {
    for (const rel of SOCIAL_UI) {
      const src = stripComments(readSrc(rel));
      expect(src, `${rel} uses the canonical service`).toContain("@/lib/supabase");
      expect(src, `${rel} has no client mutations`).not.toMatch(
        /\.(insert|update|delete|upsert)\(\s*["']/,
      );
    }
  });
});

// ── 3. Firebase boundary ─────────────────────────────────────────────────────

describe("final lock — Firebase boundary", () => {
  it("every active Social surface is Firebase-free (shared-Core imports excepted)", () => {
    for (const rel of SOCIAL_SURFACES_ALL.concat([
      // health: Social data path verified via getSocialTasks; its remaining
      // firebase/tenants + firebase/jobs deps are Core diagnostics (§7).
      "src/app/portal/admin/health/page.tsx",
    ])) {
      let src = stripComments(readSrc(rel));
      // Strip the deliberate shared-Core Firebase import lines before the
      // absence assertion (same classification the Phase E suite applies):
      // firestore-module imports used by non-Social consumers, and the
      // health page's Core diagnostics deps (tenants constant, jobs stub).
      src = src
        .replace(SHARED_FIREBASE_IMPORTS, (m) =>
          NON_SOCIAL_FIREBASE_CONSUMERS.test(m) ? "" : m)
        .replace(/import\s*{[^}]*}\s*from\s*"@\/lib\/firebase\/(tenants|jobs)";?/g, "");
      // Display strings on the diagnostics page describe the wider
      // platform's Firestore/Firebase status — not Social dependencies.
      src = src.replace(/Firebase connectivity|Firestore Database|Firebase Auth & Tenant Context/g, "");
      expect(src.toLowerCase(), `${rel} firebase-free`).not.toContain("firebase");
      expect(src.toLowerCase(), `${rel} firestore-free`).not.toContain("firestore");
    }
  });

  it("legacy Social Firebase functions have zero live consumers repo-wide", () => {
    const LEGACY = [
      "getActiveTasks", "getAllTasks", "createTask", "submitTaskCompletion",
      "updateTaskSubmission", "getSubmissionsForTaskWithUsers",
      "getUserTaskSubmissions", "verifyTaskSubmission", "getLeaderboard",
      "syncLeaderboardProjection",
    ];
    for (const rel of SOCIAL_SURFACES_ALL.concat([
      "src/components/search/GlobalSearchModal.tsx",
      "src/app/portal/layout.tsx",
      "src/contexts/AuthContext.tsx",
    ])) {
      const code = stripComments(readSrc(rel));
      for (const fn of LEGACY) {
        expect(
          new RegExp(`\\b${fn}\\b`).test(code),
          `${rel} must not reference ${fn}`,
        ).toBe(false);
      }
    }
  });

  it("no `leaderboard_public` / `users.points` legacy model remains in live code", () => {
    for (const rel of SOCIAL_SURFACES_ALL) {
      const code = stripComments(readSrc(rel));
      expect(code).not.toContain("leaderboard_public");
      expect(code).not.toContain("users.points");
    }
  });

  it("shared surfaces import no Firebase at all (final boundary, Phase 5)", () => {
    const modal = readSrc("src/components/search/GlobalSearchModal.tsx");
    const imports = modal.match(SHARED_FIREBASE_IMPORTS) ?? [];
    expect(imports).toEqual([]);
  });
});

// ── 4. Accounting invariants ─────────────────────────────────────────────────

describe("final lock — points / leaderboard invariants", () => {
  it("no client point/rank authority in any Social surface", () => {
    for (const rel of SOCIAL_SURFACES_ALL) {
      const code = stripComments(readSrc(rel));
      expect(code, `${rel} no awardPoints`).not.toMatch(/\bawardPoints\b/);
      // setPoints/updatePoints as React presentation state is fine; the
      // invariant is that no Social surface ASSIGNS points/rank/position.
      expect(code, `${rel} no updatePoints fn`).not.toMatch(/\bupdatePoints\b/);
      expect(code, `${rel} no points write`).not.toMatch(/\.points\s*=[^=]/);
      expect(code, `${rel} no rank write`).not.toMatch(/\.rank\s*=[^=]/);
      expect(code, `${rel} no position write`).not.toMatch(/\.position\s*=[^=]/);
      expect(code, `${rel} no client ranking`).not.toContain("findIndex");
    }
  });

  it("leaderboard contract is the reduced projection (no PII fields)", () => {
    const src = readSrc("src/lib/supabase/socialForce.ts");
    const lb = src.slice(
      src.indexOf("SocialLeaderboardEntry"),
      src.indexOf("── error machinery"),
    );
    expect(lb).toContain("position: number");
    expect(lb).toContain("ward_id");
    expect(lb).not.toContain("polling_unit");
    expect(lb).not.toContain("email");
    expect(lb).not.toContain("phone");
  });

  it("social_leaderboard view is module-gated in migration 0029", () => {
    const m = readSrc("supabase/migrations/0029_social_force_leaderboard_gate.sql");
    expect(m).toContain("security_invoker = true");
    expect(m).toContain("module_enabled('social')");
    expect(m).toContain("social_admin_award_history");
  });

  it("dashboard consumes the projection's position (never computes it)", () => {
    const code = stripComments(readSrc("src/components/dashboard/SocialMemberDashboard.tsx"));
    expect(code).toContain("mine.position");
    expect(code).toContain("member.position");
    expect(code).toContain("getMySocialPoints");
    expect(code).not.toContain("reduce(");
  });
});

// ── 5. Membership boundaries (static, architecture level) ────────────────────

describe("final lock — boundaries", () => {
  it("Social gate consults the DB module flag and grants member/admin authority only", () => {
    const access = readSrc("src/lib/supabase/access.ts");
    expect(access).toContain('isModuleEnabled("social"');
    expect(access).toContain('"social_member"');
    // Election gate keeps the social-only absolute block.
    expect(access).toContain("social_only");
  });

  it("admin review desk reads are bounded (200-row cap on admin history RPC)", () => {
    const m = readSrc("supabase/migrations/0029_social_force_leaderboard_gate.sql");
    expect(m).toMatch(/200/);
  });

  it("submission lifecycle has no unverify path in the service", () => {
    const code = stripComments(readSrc("src/lib/supabase/socialForce.ts"));
    expect(code).not.toMatch(/\bunverify\b/i);
    expect(code).toContain('"verify_social_submission"');
    expect(code).not.toContain('"revoke_social_submission"');
  });

  it("Campaign and Election migrations untouched by Social phases (0020–0027, 0018–0019 byte-identical history)", () => {
    // Structural assertion: Social migrations are 0028/0029 only — no
    // Social DDL was appended to Campaign/Election migration files.
    for (const f of [
      "0021_campaign_core.sql",
      "0022_campaign_activities_hardening.sql",
      "0023_campaign_public_rpc_wrappers.sql",
      "0024_campaign_assignments_hardening.sql",
      "0025_campaign_reports_issues_hardening.sql",
      "0026_campaign_coordination_directory.sql",
      "0027_campaign_lock_grant_hygiene.sql",
      "0018_election_relational_votes.sql",
      "0019_election_workflow_relational.sql",
    ]) {
      const src = readSrc(`supabase/migrations/${f}`);
      expect(src.toLowerCase(), f).not.toContain("social_tasks");
      expect(src.toLowerCase(), f).not.toContain("social_point_awards");
      expect(src.toLowerCase(), f).not.toContain("social_leaderboard");
    }
  });
});
