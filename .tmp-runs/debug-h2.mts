/** Standalone H2 reproduction: why does the sweep not report the drifted tenant? */
import { createDb, applyMigrations } from "../scripts/db/apply-migrations.ts";
import type { PGlite } from "@electric-sql/pglite";

async function asUser(db: PGlite, userId: string, sql: string, params?: unknown[]) {
  await db.query("SELECT set_config('role', 'authenticated', false)", []);
  await db.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  try {
    const r = await db.query(sql, params as never[]);
    return { rows: r.rows as Record<string, unknown>[], error: undefined };
  } catch (e) {
    return { rows: [], error: (e as Error).message };
  } finally {
    await db.query("RESET role", []);
    await db.query("SELECT set_config('request.jwt.claims', '{}', false)", []);
  }
}

const db: PGlite = await createDb();
await applyMigrations(db);

// fixtures
const t = crypto.randomUUID();
await db.query(`INSERT INTO politicore.tenants (id, slug, name) VALUES ($1,'p31dbg','P31 Dbg')`, [t]);
for (const m of ["social", "campaign", "election", "governance"]) {
  await db.query(`INSERT INTO politicore.tenant_modules (tenant_id, module, enabled) VALUES ($1,$2,true)`, [t, m]);
}
await db.query(`INSERT INTO politicore.platform_settings (id, settings) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
const owner = crypto.randomUUID();
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'dbg-owner@test.local')`, [owner]);
await db.query(`INSERT INTO politicore.profiles (id, tenant_id, email, full_name, access_role) VALUES ($1,$2,'dbg-owner@test.local','Dbg Owner','tenant_super_admin')`, [owner, t]);
const plat = crypto.randomUUID();
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'dbg-plat@test.local')`, [plat]);
await db.query(`INSERT INTO politicore.profiles (id, tenant_id, email, full_name, access_role) VALUES ($1,$2,'dbg-plat@test.local','Dbg Plat','platform_super_admin')`, [plat, t]);

const plan = await asUser(db, plat, `SELECT public.create_plan('p31dbg','P31 Dbg',NULL,95,'dbg') AS p`);
console.log("plan:", plan.error ?? plan.rows[0]);
const planId = String(plan.rows[0].p);
const ver = await asUser(db, plat,
  `SELECT public.create_plan_version($1, ARRAY['social','governance'], '{}'::jsonb, '{}'::jsonb, 'NGN', true, 14, '{"monthly": 100000}'::jsonb, 'dbg') AS v`, [planId]);
console.log("ver:", ver.error ?? ver.rows[0]);
const verId = String(ver.rows[0].v);
const act = await asUser(db, plat, `SELECT public.activate_plan_version($1,'dbg') AS v`, [verId]);
console.log("act:", act.error ?? act.rows[0]);

const sub = await asUser(db, owner, `SELECT public.create_subscription($1,'monthly') AS s`, [verId]);
console.log("sub:", sub.error ?? sub.rows[0]);
const subId = String(sub.rows[0].s);
console.log("sub status after create:", (await db.query(`SELECT status::text, current_period_start, current_period_end FROM politicore.subscriptions WHERE id=$1`, [subId])).rows[0]);
console.log("tenant lifecycle after create:", (await db.query(`SELECT lifecycle_status::text FROM politicore.tenants WHERE id=$1`, [t])).rows[0]);

const u1 = await db.query(`UPDATE politicore.subscriptions SET status='active', current_period_start=now(), current_period_end=now()+interval '30 days' WHERE id=$1`, [subId]);
console.log("u1 active:", u1.affectedRows);
const u2 = await db.query(`UPDATE politicore.subscriptions SET status='past_due', past_due_since=now() WHERE id=$1`, [subId]);
console.log("u2 past_due:", u2.affectedRows);
console.log("tenant lifecycle after past_due:", (await db.query(`SELECT lifecycle_status::text FROM politicore.tenants WHERE id=$1`, [t])).rows[0]);

// drift: force tenant active
await db.query(`SET session_replication_role = replica`);
await db.query(`UPDATE politicore.tenants SET lifecycle_status='active', status='active', lifecycle_reason='dbg drift', lifecycle_changed_at=now(), lifecycle_changed_by=NULL WHERE id=$1`, [t]);
await db.query(`RESET session_replication_role`);
console.log("tenant lifecycle after drift-forcing:", (await db.query(`SELECT lifecycle_status::text FROM politicore.tenants WHERE id=$1`, [t])).rows[0]);

// the sweep's own cursor query
const cur = await db.query(`SELECT t.id, t.lifecycle_status::text AS life, s.status AS sub_status
  FROM politicore.tenants t
  LEFT JOIN LATERAL (SELECT st.status FROM politicore.subscriptions st WHERE st.tenant_id=t.id ORDER BY st.created_at DESC LIMIT 1) s ON true
 WHERE t.lifecycle_status IN ('active','past_due')`);
console.log("sweep cursor rows for our tenant:", JSON.stringify(cur.rows.filter((r) => String(r.id) === t)));

const sw = await asUser(db, plat, `SELECT public.process_lifecycle_transitions()`);
console.log("sweep:", sw.error ?? JSON.stringify(sw.rows));
console.log("tenant lifecycle after sweep:", (await db.query(`SELECT lifecycle_status::text FROM politicore.tenants WHERE id=$1`, [t])).rows[0]);

// cleanup
await db.query(`SET session_replication_role = replica`);
await db.query(`DELETE FROM politicore.notifications WHERE tenant_id=$1`, [t]);
await db.query(`DELETE FROM politicore.system_audits WHERE tenant_id=$1`, [t]);
await db.query(`DELETE FROM politicore.subscription_items WHERE subscription_id=$1`, [subId]);
await db.query(`DELETE FROM politicore.subscriptions WHERE id=$1`, [subId]);
await db.query(`DELETE FROM politicore.profiles WHERE tenant_id=$1`, [t]);
await db.query(`DELETE FROM politicore.tenant_modules WHERE tenant_id=$1`, [t]);
await db.query(`DELETE FROM politicore.tenants WHERE id=$1`, [t]);
await db.query(`DELETE FROM politicore.plan_version_prices WHERE plan_version_id=$1`, [verId]);
await db.query(`DELETE FROM politicore.plan_versions WHERE id=$1`, [verId]);
await db.query(`RESET session_replication_role`);
process.exit(0);
