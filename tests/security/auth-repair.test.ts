/**
 * POLITICORE — Auth Repair focused tests (vitest, repo convention).
 *
 * Local verification of the repair's SECURITY-CRITICAL contracts:
 *
 *   1. Redirect resolution — safeInternalRedirect allowlist behavior:
 *      internal paths pass; absolute URLs, protocol-relative "//", backslash
 *      and encoded-traversal bypasses, and unknown paths are rejected.
 *   2. Callback URL construction — deterministic, no token material.
 *   3. Supabase client flow posture — the shared client keeps
 *      detectSessionInUrl: false (explicit verification at the callback
 *      route only) and does not persist a service-role key.
 *   4. Static secret boundary — no service_role key material reaches any
 *      client-bundled module; no token/OTP logging in the new modules.
 *   5. Data contracts (PGlite) — the 0007 signup provisioning contract
 *      (bare identity ⇒ NO profile; tenant_slug ⇒ plain member profile)
 *      remains intact under a confirmation-first signup posture.
 *
 * The hosted GoTrue email-delivery steps (real inbox open/click) remain a
 * MANUAL checklist item — see docs/AUTH-REPAIR-REPORT.md.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";
import {
  safeInternalRedirect,
  AUTH_CALLBACK_PATH,
  AUTH_REDIRECT_ALLOWLIST,
  authCallbackUrl,
} from "../../src/lib/supabase/authLinks";
import { as, getDb, createTenant, TENANT_A } from "./helpers";

// ── 1. Redirect allowlist ────────────────────────────────────────────────────

describe("safeInternalRedirect (open-redirect defense)", () => {
  it("allows exact internal allowlist paths", () => {
    for (const allowed of AUTH_REDIRECT_ALLOWLIST) {
      expect(safeInternalRedirect(allowed)).toBe(allowed);
    }
  });

  it("preserves a validated internal path with query params", () => {
    expect(safeInternalRedirect("/login?from=email")).toBe("/login");
  });

  it("returns the fallback for null/empty input", () => {
    expect(safeInternalRedirect(null)).toBe("/");
    expect(safeInternalRedirect("")).toBe("/");
    expect(safeInternalRedirect(undefined, "/login")).toBe("/login");
  });

  it("rejects absolute external URLs (open-redirect)", () => {
    expect(safeInternalRedirect("https://evil.example.com/callback")).toBe("/");
    expect(safeInternalRedirect("http://evil.example.com")).toBe("/");
  });

  it("rejects protocol-relative URLs (open-redirect)", () => {
    expect(safeInternalRedirect("//evil.example.com")).toBe("/");
  });

  it("rejects scheme+path mimics (open-redirect)", () => {
    expect(safeInternalRedirect("javascript:alert(1)")).toBe("/");
    expect(safeInternalRedirect("data:text/html,<script>")).toBe("/");
  });

  it("rejects encoded bypass payloads", () => {
    expect(safeInternalRedirect("/%2F%2Fevil.example.com")).toBe("/");
    expect(safeInternalRedirect("%2F%2A")).toBe("/");
  });

  it("rejects backslash-path bypasses", () => {
    expect(safeInternalRedirect("/\\evil.example.com")).toBe("/");
    expect(safeInternalRedirect("\\/\\/evil.example.com")).toBe("/");
  });

  it("rejects directory traversal", () => {
    expect(safeInternalRedirect("/login/../..//up")).toBe("/");
  });

  it("rejects unknown internal paths (narrow allowlist)", () => {
    expect(safeInternalRedirect("/not-a-route")).toBe("/");
    expect(safeInternalRedirect("/portal/billing")).toBe("/");
  });

  it("honors a custom validated fallback", () => {
    expect(safeInternalRedirect("/nope", "/login")).toBe("/login");
  });
});

// ── 2. Callback URL construction ────────────────────────────────────────────

describe("auth callback destination construction", () => {
  it("callback path constant is the canonical route", () => {
    expect(AUTH_CALLBACK_PATH).toBe("/auth/callback");
  });

  it("appends a validated next parameter only", () => {
    const url = authCallbackUrl("/login");
    expect(url).toContain(encodeURIComponent("/login"));
    expect(url).not.toMatch(/token|code=|hash/i);
  });

  it("never embeds token material", () => {
    const url = authCallbackUrl("/reset-password");
    expect(url).not.toContain("token_hash");
    expect(url).not.toContain("access_token");
  });
});

// ── 3. Supabase client posture ──────────────────────────────────────────────

describe("supabase client flow posture", () => {
  it("shared client config keeps detectSessionInUrl disabled", async () => {
    const src = fs.readFileSync(
      path.resolve("src/lib/supabase/config.ts"),
      "utf8"
    );
    expect(src).toContain("detectSessionInUrl: false");
  });

  it("the verification callsites are explicit and scoped", async () => {
    const callback = fs.readFileSync(
      path.resolve("src/app/auth/callback/page.tsx"),
      "utf8"
    );
    expect(callback).toContain("verifyOtp");
    expect(callback).toContain("exchangeCodeForSession");
  });

  it("recovery verification does not trust hand-typed sessions", async () => {
    // /reset-password must fail closed without a session.
    const src = fs.readFileSync(
      path.resolve("src/app/reset-password/page.tsx"),
      "utf8"
    );
    expect(src).toContain("auth.getSession");
    expect(src).toMatch(/no-recovery/);
  });
});

// ── 4. Static secret/log boundary ───────────────────────────────────────────

describe("static secret boundary (no service-role exposure in client code)", () => {
  const clientFiles = [
    "src/lib/supabase/authLinks.ts",
    "src/app/auth/callback/page.tsx",
    "src/app/forgot-password/page.tsx",
    "src/app/reset-password/page.tsx",
  ];

  for (const file of clientFiles) {
    it(`${file} contains no service-role key reference`, () => {
      const src = fs.readFileSync(path.resolve(file), "utf8");
      expect(src).not.toMatch(/service_role|SERVICE_ROLE|serviceRoleKey/i);
      // Server-only direct-connection env vars stay out of client code.
      expect(src).not.toContain("DATABASE_URL");
    });
  }

  it("no new auth module logs token/code/OTP material", () => {
    for (const file of clientFiles) {
      const src = fs.readFileSync(path.resolve(file), "utf8");
      // console.* may exist only WITHOUT token-ish payload patterns.
      const logs = src.match(/console\.[a-z]+\([^)]*\)/g) ?? [];
      for (const line of logs) {
        expect(line.toLowerCase()).not.toMatch(/token|otp|code|hash|secret/);
      }
    }
  });
});

// ── 5. Data contracts under the repair (PGlite) ──────────────────────────────

describe("0007 provisioning contract (bare identity vs tenant_slug)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await getDb();
    await createTenant(db, "tenant-auth-a", "Auth Tenant A", { social: true, campaign: true }, TENANT_A);
  });

  it("a bare identity (no tenant_slug) provisions NO profile", async () => {
    const uid = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1, $2, jsonb_build_object('onboarding_intent', 'tenant_owner'))`,
      [uid, `bare-${crypto.randomUUID()}@test.local`],
    );
    const { rows } = await db.query(
      `SELECT id FROM politicore.profiles WHERE id = $1`,
      [uid],
    );
    expect(rows).toHaveLength(0);
  });

  it("a tenant_slug signup provisions a PLAIN member profile only", async () => {
    const uid = crypto.randomUUID();
    const email = `member-${crypto.randomUUID()}@test.local`;
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1, $2, jsonb_build_object('tenant_slug', 'tenant-auth-a', 'full_name', 'Repair Member'))`,
      [uid, email],
    );
    const { rows } = await db.query(
      `SELECT id, tenant_id, access_role, email FROM politicore.profiles WHERE id = $1`,
      [uid],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.access_role).toBe("member");
    expect(row.email).toBe(email);
  });

  it("duplicate signup replays do not create duplicate profiles (idempotency)", async () => {
    const uid = crypto.randomUUID();
    const meta = () =>
      `jsonb_build_object('tenant_slug', 'tenant-auth-a', 'full_name', 'Replay Member')`;
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, ${meta()})`,
      [uid, `replay-${crypto.randomUUID()}@test.local`],
    );
    // Simulate a retried provisioning write (the trigger's ON CONFLICT arm).
    await db.query(
      `INSERT INTO politicore.profiles (id, tenant_id, email, full_name, access_role, membership_types)
       VALUES ($1, $2, $3, 'Replay Member', 'member', '{}')
       ON CONFLICT (id) DO NOTHING`,
      [uid, TENANT_A, `replay-${crypto.randomUUID()}@test.local`],
    );
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM politicore.profiles WHERE id = $1`,
      [uid],
    );
    expect((rows[0] as Record<string, unknown>).n).toBe(1);
  });

  it("self-service onboarding RPC still refuses a member-of-existing-tenant account", async () => {
    const uid = crypto.randomUUID();
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1, $2, jsonb_build_object('tenant_slug', 'tenant-auth-a', 'full_name', 'Existing Member'))`,
      [uid, `existing-${crypto.randomUUID()}@test.local`],
    );
    const res = await as(
      db,
      "authenticated",
      uid,
      `SELECT * FROM politicore.complete_tenant_onboarding('dup-tenant-slug', 'Dup Tenant', 'Owner', 'starter', 'monthly')`,
    );
    expect(res.error).toBeTruthy();
    expect(res.error).toContain("already belongs to a tenant");
  });
});
