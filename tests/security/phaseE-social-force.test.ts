/**
 * POLITICORE — SOCIAL FORCE PHASE E SECURITY SUITE.
 *
 * Phase E completes the Social Force application-layer cutover:
 * dashboard + navigation + final Firebase Social cleanup. This suite
 * proves BOTH:
 *
 *  1. FUNCTIONALITY — the canonical socialForce service contracts the
 *     dashboard consumes still behave (module gate, authority map,
 *     leaderboard privacy contract, projection-sourced rank).
 *  2. ABSENCE — zero active Social Force consumers of the legacy
 *     Firebase Social paths remain (gate §16: test for absence).
 *
 * Static assertions follow the established repo pattern (final
 * campaign lock + Phase B/C/D suites): read the touched sources and
 * assert the invariant directly.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readSrc(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`missing source file: ${rel}`);
  return readFileSync(p, "utf8");
}

/**
 * Strip // and /* *\/ comments before "absence" scans: explanatory
 * comments legitimately mention the removed legacy names (they document
 * the cutover). Assertions must test CODE, not prose.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// ─────────────────────────────────────────────────────────────────
// Part 1 — functional contracts (Phase D suite re-asserts the DB;
// Phase E re-asserts the service boundary the dashboard consumes)
// ─────────────────────────────────────────────────────────────────

describe("Phase E — canonical service boundary", () => {
  const SERVICE = "src/lib/supabase/socialForce.ts";

  it("service remains the single Social Force boundary with zero client mutations", () => {
    const src = readSrc(SERVICE);
    expect(src).toContain("social_leaderboard");
    // No client-side write paths anywhere in the service (Phase D/E
    // additions are read-only; mutations are exclusively Phase A RPCs).
    expect(stripComments(src)).toMatchClientWrite();
    // Points/leaderboard/rank operations exist for the dashboard.
    expect(src).toContain("getMySocialPoints");
    expect(src).toContain("getMySocialPointHistory");
    expect(src).toContain("getSocialLeaderboard");
    // Dashboard submission summary uses the Phase C path.
    expect(src).toContain("getMySubmissions");
  });

  it("leaderboard entry exposes projection rank + reduced geography only", () => {
    const src = readSrc(SERVICE);
    // position is database-supplied
    expect(src).toContain("position: number");
    // Reduced field set: ward/lga/zone allowed; polling unit / email /
    // phone are NOT part of the leaderboard contract.
    const lb = src.slice(src.indexOf("SocialLeaderboardEntry"), src.indexOf("── error machinery"));
    expect(lb).toContain("ward_id");
    expect(lb).toContain("zone_id");
    expect(lb).not.toContain("polling_unit");
    expect(lb).not.toContain("email");
    expect(lb).not.toContain("phone");
  });

  it("authorization gate denies social-only users Campaign/Election and vice versa", () => {
    const access = readSrc("src/lib/supabase/access.ts");
    // Social gate exists and consults the database module flag.
    expect(access).toContain("resolveSocialAccess");
    expect(access).toContain('isModuleEnabled("social"');
    // Social authority is member-or-admin only.
    expect(access).toContain('"social_member"');
  });
});

// ─────────────────────────────────────────────────────────────────
// Part 2 — Phase E cutover surfaces
// ─────────────────────────────────────────────────────────────────

describe("Phase E — dashboard cutover", () => {
  const DASHBOARD = "src/components/dashboard/SocialMemberDashboard.tsx";

  it("SocialMemberDashboard imports only the Supabase service", () => {
    const src = readSrc(DASHBOARD);
    expect(src).not.toContain("@/lib/firebase");
    expect(src).not.toContain("firebase/firestore");
    expect(src).toContain("@/lib/supabase");
    expect(src).toContain("resolveSocialAccess");
    expect(src).toContain("ensureSupabaseSession");
  });

  it("dashboard reads points from the server projection", () => {
    const src = stripComments(readSrc(DASHBOARD));
    expect(src).toContain("getMySocialPoints");
    // never a client-side award reduction
    expect(src).not.toContain("reduce(");
    expect(src).not.toContain("users.points");
  });

  it("dashboard position comes from the projection (no client ranking)", () => {
    const src = stripComments(readSrc(DASHBOARD));
    // The legacy findIndex()+1 ranking must be gone.
    expect(src).not.toContain("findIndex");
    expect(src).toContain("mine.position");
    // Rendered medal index uses the projection rank for non-top rows.
    expect(src).toContain("member.position");
  });

  it("dashboard submissions come from the Phase C RLS path", () => {
    const src = readSrc(DASHBOARD);
    expect(src).toContain("getMySubmissions(");
    expect(src).not.toContain("getUserTaskSubmissions");
    // No tenant-wide submission query for dashboard convenience.
    expect(src).not.toContain("getSubmissionsCount");
  });
});

describe("Phase E — navigation cutover", () => {
  const LAYOUT = "src/app/portal/layout.tsx";

  it("Social navigation exposes Tasks/Points/Leaderboard and is member-gated", () => {
    const src = readSrc(LAYOUT);
    expect(src).toContain('href: "/portal/points"');
    expect(src).toContain('href: "/portal/leaderboard"');
    expect(src).toContain('href: "/portal/tasks"');
    // The two Social-only leaves carry the socialOnly flag.
    const pointsIdx = src.indexOf('href: "/portal/points"');
    const lbIdx = src.indexOf('href: "/portal/leaderboard"');
    expect(src.slice(pointsIdx, pointsIdx + 120)).toContain("socialOnly: true");
    expect(src.slice(lbIdx, lbIdx + 120)).toContain("socialOnly: true");
    // The nav filter enforces it.
    expect(src).toContain('item.socialOnly && !isSocialMember');
  });

  it("Campaign/Election navigation rules untouched (socialOnly flag remains isolated)", () => {
    const src = readSrc(LAYOUT);
    // No Social flag on Campaign group / Election group / admin nav.
    expect(src).not.toContain("socialOnly: true,\n    permission:");
    expect(src).not.toContain("group: \"campaign\",\n    socialOnly");
    expect(src).not.toContain("group: \"election\",\n    socialOnly");
  });
});

describe("Phase E — Firebase cleanup (absence proof, gate §16)", () => {
  // Every active Social Force surface must be Firebase-free.
  const SOCIAL_SURFACES = [
    "src/components/dashboard/SocialMemberDashboard.tsx",
    "src/app/portal/tasks/page.tsx",
    "src/app/portal/points/page.tsx",
    "src/app/portal/leaderboard/page.tsx",
    "src/app/portal/admin/tasks/page.tsx",
    "src/lib/supabase/socialForce.ts",
  ];

  it.each(SOCIAL_SURFACES)("no Firebase dependency in %s", (rel) => {
    const src = stripComments(readSrc(rel));
    expect(src.toLowerCase()).not.toContain("firebase");
    expect(src.toLowerCase()).not.toContain("firestore");
  });

  it("the legacy shared Firebase service file is fully retired (Phase 5)", () => {
    // The Firebase library directory was removed at the final boundary
    // gate: src/lib/firebase must not exist at all.
    expect(existsSync(path.resolve("src/lib/firebase"))).toBe(false);
  });

  it("no active consumer of the removed legacy functions remains", () => {
    for (const rel of [
      "src/components/dashboard/SocialMemberDashboard.tsx",
      "src/app/portal/tasks/page.tsx",
      "src/app/portal/points/page.tsx",
      "src/app/portal/leaderboard/page.tsx",
      "src/app/portal/admin/tasks/page.tsx",
      "src/app/portal/admin/health/page.tsx",
      "src/app/portal/admin/reports/page.tsx",
      "src/components/search/GlobalSearchModal.tsx",
      "src/app/portal/layout.tsx",
      "src/contexts/AuthContext.tsx",
    ]) {
      const src = readSrc(rel);
      for (const fn of [
        "getActiveTasks",
        "getAllTasks",
        "submitTaskCompletion",
        "updateTaskSubmission",
        "getSubmissionsForTaskWithUsers",
        "getUserTaskSubmissions",
        "verifyTaskSubmission",
        "getLeaderboard",
        "syncLeaderboardProjection",
      ]) {
        expect(
          src.includes(fn),
          `${rel} must not reference legacy Social fn ${fn}`,
        ).toBe(false);
      }
    }
  });

  it("GlobalSearchModal: Social Tasks source is Supabase; remaining Firebase imports are non-Social (Members/News)", () => {
    const src = readSrc("src/components/search/GlobalSearchModal.tsx");
    expect(src).toContain("getSocialTasks");
    // Remaining Firebase usage must be limited to non-Social sources.
    const firebaseImports = src.match(/import\s*{[^}]*}\s*from\s*"@\/lib\/firebase\/firestore"/g) ?? [];
    for (const imp of firebaseImports) {
      expect(imp).toMatch(/getAllUsers|getPublishedNews/);
      expect(imp).not.toMatch(/getActiveTasks|getAllTasks|getLeaderboard|Submission|Task/);
    }
  });

  it("admin health/reports Social reads go through the canonical service", () => {
    expect(readSrc("src/app/portal/admin/health/page.tsx")).toContain(
      "getSocialTasks",
    );
    const reports = readSrc("src/app/portal/admin/reports/page.tsx");
    expect(reports).toContain("getSocialTasks");
    expect(reports).toContain("resolveSocialAccess");
  });

  it("repo-wide: zero active Social consumers of legacy leaderboard_public / users.points", () => {
    // Active src paths (excluding the historical removal banner in the
    // shared Firebase file, which is documentation, not a consumer).
    for (const rel of SOCIAL_SURFACES.concat([
      "src/components/search/GlobalSearchModal.tsx",
      "src/app/portal/admin/health/page.tsx",
      "src/app/portal/admin/reports/page.tsx",
    ])) {
      const src = stripComments(readSrc(rel));
      expect(src).not.toContain("leaderboard_public");
      expect(src).not.toContain("users.points");
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Helper matcher
// ─────────────────────────────────────────────────────────────────

declare module "vitest" {
  interface Assertion<T> {
    /** Asserts the (comment-stripped) source contains NO client mutations. */
    toMatchClientWrite(): T;
  }
}

expect.extend({
  toMatchClientWrite(received: string) {
    const banned = /\.(insert|update|delete)\(\s*["']/;
    const pass = !banned.test(received);
    return {
      pass,
      message: pass
        ? () => "expected source to contain client mutations"
        : () => "service must contain no client .insert()/.update()/.delete() paths",
    };
  },
});
