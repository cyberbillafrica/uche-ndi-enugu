import { applyMigrations, createDb } from "./apply-migrations";
import * as fs from "fs";
import * as path from "path";

/**
 * Applies migrations + all seed migrations in one step (used by tests).
 * Exposes the open db handle for direct querying.
 */
export async function createTestDb(): Promise<import("@electric-sql/pglite").PGlite> {
  const db = await createDb();
  await applyMigrations(db);
  return db;
}

// re-export for seeding helpers
export { applyMigrations, createDb };
export * as fsx from "fs";
export const MIGRATIONS_DIR = path.resolve("supabase/migrations");
export function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");
}
