/**
 * Maintenance: purge leftover dev-provisioning tenants + phase1b test
 * auth users from the hosted project (idempotent).
 */
import * as fs from "fs";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000, statement_timeout: 20000 });
  await sql.connect();
  console.log("connected");

  const t = await sql.query<{ id: string; slug: string }>(
    `SELECT id::text, slug FROM politicore.tenants WHERE slug IN ('dev-provisioning','sneaky')`
  );
  console.log("stale tenants:", JSON.stringify(t.rows));

  for (const row of t.rows) {
    await sql.query(`DELETE FROM politicore.system_audits WHERE tenant_id = $1`, [row.id]);
    await sql.query(`DELETE FROM politicore.notifications WHERE tenant_id = $1`, [row.id]);
    await sql.query(`DELETE FROM politicore.permission_grants WHERE tenant_id = $1`, [row.id]);
    await sql.query(`DELETE FROM politicore.organizational_assignments WHERE tenant_id = $1`, [row.id]);
    console.log("purged child rows for", row.slug);
  }

  const users = await sql.query<{ id: string }>(
    `SELECT id::text FROM auth.users WHERE email LIKE 'phase1b%'`
  );
  console.log("phase1b auth users to delete:", users.rows.length);
  await sql.query(`DELETE FROM auth.users WHERE email LIKE 'phase1b%'`);

  if (t.rows.length) {
    await sql.query(`ALTER TABLE politicore.tenants NO FORCE ROW LEVEL SECURITY`);
    for (const row of t.rows) {
      await sql.query(`DELETE FROM politicore.tenants WHERE id = $1`, [row.id]);
    }
    await sql.query(`ALTER TABLE politicore.tenants FORCE ROW LEVEL SECURITY`);
  }
  console.log("stale tenants deleted");

  const remaining = await sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM politicore.tenants WHERE slug IN ('dev-provisioning','sneaky')`
  );
  console.log("remaining stale tenants:", remaining.rows[0].n);

  await sql.end();
  console.log("PURGE DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("PURGE FAILED:", e.message);
  process.exit(1);
});
