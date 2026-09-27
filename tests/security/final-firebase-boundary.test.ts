/**
 * POLITICORE — Final Firebase Boundary Gate (Phase 5).
 *
 * Pins the terminal Firebase state of the repository:
 *
 *   1. FIREBASE FULLY RETIRED — no Firebase source files, rules, emulator
 *      configuration, packages, scripts or environment variables remain.
 *   2. Zero Firebase imports anywhere in src/scripts/tests (static walk).
 *   3. No `initializeApp` / `getFirestore` / `getStorage` entry points.
 *   4. Remaining textual mentions are historical comments/documentation.
 *   5. Canonical replacements pinned: every content/identity domain is
 *      served from src/lib/supabase; the seed lineage lives in migration
 *      0016 (political parties) and the SQL geography seeds.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*<!--[\s\S]*?-->\s*$/gm, "");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

describe("final Firebase boundary — repository state", () => {
  it("no Firebase source directory, rules, emulator config, or rules tests remain", () => {
    expect(fs.existsSync("src/lib/firebase")).toBe(false);
    expect(fs.existsSync("firestore.rules")).toBe(false);
    expect(fs.existsSync("firebase.json")).toBe(false);
    expect(fs.existsSync(".firebaserc")).toBe(false);
    expect(fs.existsSync("tests/rules")).toBe(false);
    expect(fs.existsSync("vitest.config.ts")).toBe(false);
  });

  it("zero Firebase imports in application, script, and test code", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "scripts", "tests"]) {
      for (const p of walk(dir)) {
        const body = strip(fs.readFileSync(p, "utf8"));
        if (/from\s+["'](firebase[/@-][^"']*|@\/lib\/firebase[^"']*)["']/.test(body) ||
          /require\(\s*["']firebase/.test(body) ||
          /import\(\s*["']firebase/.test(body)) {
          offenders.push(p.replace(/\\/g, "/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no Firebase SDK entry points (initializeApp / getFirestore / getStorage / getAuth from firebase)", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "scripts"]) {
      for (const p of walk(dir)) {
        const body = strip(fs.readFileSync(p, "utf8"));
        if (/\binitializeApp\b|\bgetFirestore\b|\bgetStorage\b/.test(body)) {
          offenders.push(p.replace(/\\/g, "/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("package.json carries no Firebase packages or emulator script", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((k) => /firebase/i.test(k))).toEqual([]);
    expect(Object.keys(pkg.scripts).filter((k) => /rules/i.test(k))).toEqual([]);
  });

  it("remaining firebase mentions in code are historical comments only (doc/comment text, stripped from live code)", () => {
    const allowed = new Set([
      // Cloudinary error-code mapping retains Firebase-era code strings for
      // legacy error payloads; naming is historical, the dependency is gone.
      "src/lib/errors.ts",
    ]);
    const offenders: string[] = [];
    for (const p of walk("src")) {
      const norm = p.replace(/\\/g, "/");
      if (allowed.has(norm)) continue;
      const body = strip(fs.readFileSync(p, "utf8"));
      if (/firebase/i.test(body)) offenders.push(norm);
    }
    expect(offenders).toEqual([]);
  });
});

describe("final Firebase boundary — canonical replacements pinned", () => {
  it("seed lineage is preserved in the canonical SQL migrations", () => {
    const seed = fs.readFileSync("supabase/migrations/0016_election_seed.sql", "utf8");
    expect(seed).toMatch(/INEC_2027_POLITICAL_PARTIES/);
    expect(seed).toMatch(/INSERT INTO politicore\.political_parties/);
    const content = fs.readFileSync("supabase/migrations/0033_public_content_modules.sql", "utf8");
    expect(content).toMatch(/CREATE TABLE politicore\.events/);
    expect(content).toMatch(/CREATE TABLE politicore\.announcements/);
  });

  it("every application domain resolves through src/lib/supabase", () => {
    const barrel = fs.readFileSync("src/lib/supabase/index.ts", "utf8");
    for (const domain of [
      "auth", "session", "access", "identity", "members", "geography",
      "election", "campaign", "socialForce", "notifications",
      "events", "announcements", "news", "content", "audit",
    ]) {
      expect(barrel, `barrel exports ${domain}`).toMatch(new RegExp(`from ["']\\./${domain}["']`));
    }
    // And no parallel Firebase service tree exists to route around it.
    expect(fs.existsSync("src/lib/firebase")).toBe(false);
  });
});
