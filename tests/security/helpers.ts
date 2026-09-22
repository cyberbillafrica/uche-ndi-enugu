/**
 * Security test harness.
 *
 * Creates a fresh database (all migrations) per test file, provides
 * role-impersonation helpers mirroring Supabase's PostgREST behavior
 * (SET ROLE + JWT claims GUC), and fixture builders.
 */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, createDb } from "../../scripts/db/apply-migrations";

export const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let dbPromise: Promise<PGlite> | null = null;

/** One fresh database per test FILE (not per test — too slow). */
export function getDb(): Promise<PGlite> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await createDb();
      await applyMigrations(db);
      return db;
    })();
  }
  return dbPromise;
}

/**
 * Run a query as a Supabase role with an optional JWT subject.
 *
 * Mirrors PostgREST: role + request.jwt.claims set per-request. Uses
 * session-local set_config (pglite autocommits per statement, so
 * transaction-local flags would evaporate; explicit BEGIN/COMMIT would
 * fight pglite's internal transaction state machine). Always resets.
 */
export async function as(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role",
  userId: string | null,
  sql: string,
  params?: unknown[]
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const claims = userId ? JSON.stringify({ sub: userId, role }) : "{}";
  await db.query("SELECT set_config('role', $1, false)", [role]);
  await db.query("SELECT set_config('request.jwt.claims', $1, false)", [claims]);
  try {
    const res = await db.query(sql, params as never[]);
    return { rows: res.rows as Record<string, unknown>[] };
  } catch (e) {
    return { rows: [], error: (e as Error).message };
  } finally {
    await db.query("RESET role");
    await db.query("SELECT set_config('request.jwt.claims', '{}', false)");
  }
}

export interface FixtureUser {
  authId: string;
  email: string;
  profileId: string;
}

/** Create an auth user + profile. Runs as service_role (bypasses RLS). */
export async function createUser(
  db: PGlite,
  opts: {
    tenantId: string;
    email: string;
    fullName: string;
    accessRole?: string;
    membershipTypes?: string[];
    wardId?: string | null;
    lgaId?: string | null;
    puId?: string | null;
  }
): Promise<FixtureUser> {
  const authId = crypto.randomUUID();
  const ins = await db.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, $2) RETURNING id`,
    [authId, opts.email]
  );
  const uid = (ins.rows[0] as Record<string, unknown>).id as string;
  const memberships = (opts.membershipTypes ?? []).join(",");
  await db.query(
    `INSERT INTO politicore.profiles
       (id, tenant_id, email, full_name, access_role, membership_types, ward_id, lga_id, polling_unit_id)
     VALUES ($1,$2,$3,$4,$5,string_to_array($6, ',')::politicore.membership_type_enum[],$7,$8,$9)`,
    [
      uid,
      opts.tenantId,
      opts.email,
      opts.fullName,
      opts.accessRole ?? "member",
      memberships,
      opts.wardId ?? null,
      opts.lgaId ?? null,
      opts.puId ?? null,
    ]
  );
  return { authId: uid, email: opts.email, profileId: uid };
}

export async function createTenant(
  db: PGlite,
  slug: string,
  name: string,
  modules: Partial<Record<string, boolean>> = {},
  fixedId?: string
): Promise<string> {
  const res = await db.query(
    `INSERT INTO politicore.tenants (id, slug, name) VALUES ($1, $2, $3) RETURNING id`,
    [fixedId ?? crypto.randomUUID(), slug, name]
  );
  const id = (res.rows[0] as Record<string, unknown>).id as string;
  for (const mod of ["social", "campaign", "election", "governance"]) {
    await db.query(
      `INSERT INTO politicore.tenant_modules (tenant_id, module, enabled) VALUES ($1, $2, $3)`,
      [id, mod, modules[mod] ?? false]
    );
  }
  return id;
}

export async function grant(
  db: PGlite,
  tenantId: string,
  userId: string,
  permission: string,
  granted: boolean,
  scopeType?: string | null,
  scopeId?: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO politicore.permission_grants
       (tenant_id, user_id, permission, granted, scope_type, scope_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, userId, permission, granted, scopeType ?? null, scopeId ?? null]
  );
}

export async function assign(
  db: PGlite,
  tenantId: string,
  userId: string,
  position: string,
  scopeType: string,
  scopeId: string
): Promise<void> {
  await db.query(
    `INSERT INTO politicore.organizational_assignments
       (tenant_id, user_id, position, scope_type, scope_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, userId, position, scopeType, scopeId]
  );
}
