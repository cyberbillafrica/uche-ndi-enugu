/**
 * Applies supabase/migrations/*.sql in order to a local pglite database
 * (mirrors `supabase db push` semantics for local development/tests).
 */
import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as path from "path";

export async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.query("SELECT 1");
  return db;
}

export async function applyMigrations(db: PGlite, dir = "supabase/migrations"): Promise<string[]> {
  const files = fs
    .readdirSync(path.resolve(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.resolve(dir, f), "utf-8");
    await db.exec(sql);
    applied.push(f);
  }
  return applied;
}

async function main() {
  const db = await createDb();
  const applied = await applyMigrations(db);
  console.log(`Applied ${applied.length} migrations:`);
  for (const f of applied) console.log("  ✓", f);

  // quick integrity echo
  const counts = await db.query(`
    SELECT
      (SELECT count(*) FROM politicore.states) states,
      (SELECT count(*) FROM politicore.senatorial_zones) zones,
      (SELECT count(*) FROM politicore.lgas) lgas,
      (SELECT count(*) FROM politicore.wards) wards,
      (SELECT count(*) FROM politicore.polling_units) polling_units,
      (SELECT count(*) FROM politicore.permissions) permissions,
      (SELECT count(*) FROM politicore.position_permissions) position_permissions,
      (SELECT count(*) FROM politicore.tenant_modules) tenant_modules
  `);
  console.log("Row counts:", counts.rows[0] as Record<string, unknown>);

  const rls = await db.query(`
    SELECT count(*)::int AS rls_tables FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'politicore' AND c.relkind = 'r' AND c.relrowsecurity
  `);
  console.log(`Tables with RLS enabled: ${(rls.rows[0] as Record<string, unknown>).rls_tables}`);

  const policies = await db.query(`
    SELECT count(*)::int AS policies FROM pg_policies WHERE schemaname = 'politicore'
  `);
  console.log(`RLS policies: ${(policies.rows[0] as Record<string, unknown>).policies}`);

  await db.close();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
