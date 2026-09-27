/**
 * POLITICORE — Member Directory cutover security tests (Core Identity Phase 3).
 *
 * Local PGlite verification on the real migrations (0001–0032) of the
 * canonical member-directory contract the admin directory, admin reports,
 * and GlobalSearch now depend on:
 *
 *   1. Directory reads through public.politicore_profiles are RLS-scoped:
 *      self + same-tenant members; cross-tenant members are invisible.
 *   2. The directory serves same-tenant member visibility (the tenant-wide
 *      admin directory and GlobalSearch member search contract).
 *   3. Anonymous sessions see no profiles (denial even with id targeting).
 *   4. The 0027 view stays SELECT-only — no application-role profile writes.
 *   5. Lifecycle authority RPC (0032): admin succeeds + audits; member and
 *      cross-tenant targets fail closed; no target → exception; audit trail
 *      pinned (action, actor, old/new values, reason).
 *   6. Static Firebase boundary — the migrated directory consumers import
 *      no Firebase; the legacy member helpers have zero live consumers.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import {
  as,
  createTenant,
  createUser,
  getDb,
  TENANT_A,
  TENANT_B,
} from "./helpers";

let db: PGlite;

beforeAll(async () => {
  db = await getDb();
  await createTenant(db, "tenant-a", "Tenant A", {}, TENANT_A);
  await createTenant(db, "tenant-b", "Tenant B", {}, TENANT_B);
});

const PROFILE_COLS =
  "id, email, full_name, phone, lga_id, ward_id, polling_unit_id, access_role, membership_types, lifecycle_status, status_reason, points, rank, created_at";

async function memberOf(tenantId: string, extra: { role?: string; wardId?: string } = {}) {
  return createUser(db, {
    tenantId,
    email: `${crypto.randomUUID()}@test.local`,
    fullName: "Directory Fixture",
    accessRole: extra.role ?? "member",
    wardId: extra.wardId ?? null,
  });
}

describe("directory visibility (0002 profiles_read via the 0009 view)", () => {
  it("same-tenant member sees the tenant directory; cross-tenant members are invisible", async () => {
    const viewer = await memberOf(TENANT_A);
    const mate = await memberOf(TENANT_A);
    const stranger = await memberOf(TENANT_B);

    const r = await as(
      db,
      "authenticated",
      viewer.authId,
      `SELECT ${PROFILE_COLS} FROM public.politicore_profiles ORDER BY email`
    );
    expect(r.error).toBeUndefined();
    const seen = r.rows.map((row) => String(row.id));
    expect(seen).toContain(viewer.authId);
    expect(seen).toContain(mate.authId);
    expect(seen).not.toContain(stranger.authId);
  });

  it("cross-tenant id-targeted reads return nothing (no client-supplied tenant bypass)", async () => {
    const viewer = await memberOf(TENANT_A);
    const stranger = await memberOf(TENANT_B);

    const r = await as(
      db,
      "authenticated",
      viewer.authId,
      `SELECT id FROM public.politicore_profiles WHERE id = $1`,
      [stranger.authId]
    );
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(0);
  });

  it("anonymous sessions see no directory rows (even id-targeted)", async () => {
    const someone = await memberOf(TENANT_A);

    const r = await as(
      db,
      "anon",
      null,
      `SELECT id FROM public.politicore_profiles WHERE id = $1`,
      [someone.authId]
    );
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(0);
  });

  it("the 0027-narrowed view stays SELECT-only for application roles", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const target = await memberOf(TENANT_A);

    const upd = await as(
      db,
      "authenticated",
      admin.authId,
      `UPDATE public.politicore_profiles SET full_name = 'hijack' WHERE id = $1`,
      [target.authId]
    );
    expect(upd.error).toBeDefined();

    const ins = await as(
      db,
      "authenticated",
      admin.authId,
      `INSERT INTO public.politicore_profiles (id, tenant_id, email, full_name) VALUES ($1,$2,$3,'x')`,
      [crypto.randomUUID(), TENANT_A, `${crypto.randomUUID()}@test.local`]
    );
    expect(ins.error).toBeDefined();
  });
});

describe("lifecycle authority RPC (0032 admin_set_member_lifecycle)", () => {
  it("tenant admin suspends a member; the change is audited with actor, reason, old and new values", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const target = await memberOf(TENANT_A);

    const r = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'suspended', 'attendance policy violation')`,
      [target.authId]
    );
    expect(r.error).toBeUndefined();

    const row = await as(
      db,
      "authenticated",
      target.authId,
      `SELECT lifecycle_status, status_reason FROM politicore.profiles WHERE id = $1`,
      [target.authId]
    );
    expect(row.rows[0]).toMatchObject({
      lifecycle_status: "suspended",
      status_reason: "attendance policy violation",
    });

    const audit = await as(
      db,
      "service_role",
      null,
      `SELECT action, affected_resource, resource_id, actor_id, old_value, new_value
         FROM politicore.system_audits
        WHERE resource_id = $1 ORDER BY id DESC LIMIT 1`,
      [target.authId]
    );
    expect(audit.rows).toHaveLength(1);
    const a = audit.rows[0];
    expect(String(a.action)).toBe("profiles:update");
    expect(String(a.affected_resource)).toBe("profiles");
    expect(String(a.actor_id)).toBe(admin.authId);
    expect((a.old_value as Record<string, unknown>).lifecycle_status).toBe("active");
    expect((a.new_value as Record<string, unknown>).lifecycle_status).toBe("suspended");
  });

  it("a plain member cannot change anyone's lifecycle — including their own", async () => {
    const member = await memberOf(TENANT_A);
    const other = await memberOf(TENANT_A);

    const r = await as(
      db,
      "authenticated",
      member.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'deactivated', 'self-serve')`,
      [other.authId]
    );
    expect(r.error).toBeDefined();

    const self = await as(
      db,
      "authenticated",
      member.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'deactivated', 'self-serve')`,
      [member.authId]
    );
    expect(self.error).toBeDefined();

    const st = await as(
      db,
      "service_role",
      null,
      `SELECT lifecycle_status FROM politicore.profiles WHERE id IN ($1,$2)`,
      [member.authId, other.authId]
    );
    expect(st.rows.every((row) => row.lifecycle_status === "active")).toBe(true);
  });

  it("cross-tenant admin cannot touch a foreign-tenant member (fail closed)", async () => {
    const adminB = await memberOf(TENANT_B, { role: "admin" });
    const targetA = await memberOf(TENANT_A);

    const r = await as(
      db,
      "authenticated",
      adminB.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'suspended', 'cross-tenant')`,
      [targetA.authId]
    );
    expect(r.error).toBeDefined();

    const st = await as(
      db,
      "service_role",
      null,
      `SELECT lifecycle_status, status_reason FROM politicore.profiles WHERE id = $1`,
      [targetA.authId]
    );
    expect(st.rows[0].lifecycle_status).toBe("active");
    expect(st.rows[0].status_reason).toBeNull();
  });

  it("reactivation works and the unauthenticated caller is rejected", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });
    const target = await memberOf(TENANT_A);

    await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'suspended', 'x')`,
      [target.authId]
    );

    const back = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'active', 'appeal accepted')`,
      [target.authId]
    );
    expect(back.error).toBeUndefined();

    const anon = await as(
      db,
      "anon",
      null,
      `SELECT politicore.admin_set_member_lifecycle($1, 'deactivated')`,
      [target.authId]
    );
    expect(anon.error).toBeDefined();

    // No audit rows for the anonymous attempt beyond the two successful writes.
    const audits = await as(
      db,
      "service_role",
      null,
      `SELECT count(*)::int AS n FROM politicore.system_audits WHERE resource_id = $1`,
      [target.authId]
    );
    expect(Number(audits.rows[0].n)).toBe(2);
  });

  it("lifecycle transition on an unknown profile fails closed", async () => {
    const admin = await memberOf(TENANT_A, { role: "admin" });

    const r = await as(
      db,
      "authenticated",
      admin.authId,
      `SELECT politicore.admin_set_member_lifecycle($1, 'suspended', 'ghost')`,
      [crypto.randomUUID()]
    );
    expect(r.error).toBeDefined();
  });
});

describe("static Firebase boundary (migrated directory consumers)", () => {
  const readSrc = (rel: string) => fs.readFileSync(rel, "utf8");

  it("directory consumers import no Firebase; GlobalSearch keeps only the News source (later phase)", () => {
    // Fully migrated member-directory surfaces: zero Firebase imports.
    for (const rel of [
      "src/app/portal/admin/members/page.tsx",
      "src/app/portal/admin/reports/page.tsx",
    ]) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/from\s+["']@\/lib\/firebase\//);
    }
    // GlobalSearch: zero Firebase imports remain (Phase 5 retirement) —
    // member search flows through the canonical Supabase members service.
    const gs = readSrc("src/components/search/GlobalSearchModal.tsx");
    const imports = gs.match(/import\s*{[^}]*}\s*from\s*"@\/lib\/firebase\/firestore"/g) ?? [];
    expect(imports).toEqual([]);
  });

  it("legacy member helpers have zero live consumers", () => {
    for (const rel of [
      "src/app/portal/admin/members/page.tsx",
      "src/app/portal/admin/reports/page.tsx",
      "src/components/search/GlobalSearchModal.tsx",
      "src/contexts/AuthContext.tsx",
    ]) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/\b(getAllUsers|getUserProfile|updateUserProfile)\b/);
    }
  });

  it("the canonical members service has no Firebase dependency in code", () => {
    // Strip comment banners before scanning — only code counts.
    const code = readSrc("src/lib/supabase/members.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/firebase/i);
  });
});
