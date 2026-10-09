/** Scratch probe: apply all migrations (incl. 0068) on fresh pglite + smoke the new RPCs. */
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations, createDb } from "../scripts/db/apply-migrations";

async function main() {
  const db: PGlite = await createDb();
  await applyMigrations(db);
  console.log("migrations applied OK");

  const q = async (sql: string, params?: unknown[]) =>
    (await db.query(sql, params as never[])).rows as Record<string, unknown>[];

  console.log("reserved count:", (await q("SELECT array_length(politicore.reserved_tenant_slugs(), 1) AS n"))[0].n);
  console.log("normalize:", (await q("SELECT politicore.normalize_tenant_slug('  Acme --Campaign_2027! ') AS s"))[0].s);
  console.log("available:", JSON.stringify((await q("SELECT * FROM public.tenant_slug_available('www')"))[0]));
  console.log("available2:", JSON.stringify((await q("SELECT * FROM public.tenant_slug_available(' acme campaign ')"))[0]));

  // anon must NOT execute the provisioning RPC (no JWT subject)
  await db.query("SELECT set_config('role','anon',false)");
  await db.query("SELECT set_config('request.jwt.claims','{}',false)");
  const anonState = await q("SELECT * FROM public.onboarding_state()");
  console.log("anon onboarding_state:", JSON.stringify(anonState[0]));
  try {
    await q("SELECT public.complete_tenant_onboarding('probe-x','Probe X',null,'starter','monthly')");
    console.log("ERROR: anon provisioning was allowed!");
  } catch (e) {
    console.log("anon provisioning denied OK:", (e as Error).message.slice(0, 80));
  }

  // authenticated user with a bare auth identity can onboard
  await db.query("RESET role");
  await db.query("SELECT set_config('request.jwt.claims','{}',false)");
  const uid = crypto.randomUUID();
  await db.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, 'probe-owner@p30.test.local')`,
    [uid]
  );
  await db.query("SELECT set_config('role','authenticated',false)");
  await db.query(
    "SELECT set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ sub: uid, role: "authenticated" })]
  );
  const st = await q("SELECT * FROM public.onboarding_state()");
  console.log("bare identity stage:", JSON.stringify(st[0]));
  const done = await q(
    `SELECT * FROM public.complete_tenant_onboarding('probe-x','Probe X','Probe Owner','starter','monthly')`
  );
  console.log("onboarded:", JSON.stringify(done[0]));

  const profile = await q(
    `SELECT access_role::text, tenant_id FROM politicore.profiles WHERE id = $1`, [uid]
  );
  console.log("profile:", JSON.stringify(profile[0]));

  const sub = await q(
    `SELECT s.status::text, s.trial_end, i.unit_price_minor, i.currency
       FROM politicore.subscriptions s
       JOIN politicore.subscription_items i ON i.subscription_id = s.id
      WHERE s.tenant_id = $1`, [String(done[0].tenant_id)]
  );
  console.log("subscription:", JSON.stringify(sub[0]));

  const mods = await q(
    `SELECT module::text, enabled FROM politicore.tenant_modules WHERE tenant_id = $1 ORDER BY module::text`,
    [String(done[0].tenant_id)]
  );
  console.log("modules:", JSON.stringify(mods));

  await db.query("RESET role");
  const ent = await q(
    `SELECT settings->'service_entitlements'->>$1 AS map FROM politicore.platform_settings WHERE id = 1`,
    [String(done[0].tenant_id)]
  );
  console.log("entitlement map:", ent[0].map);

  const after = await q("SELECT * FROM public.onboarding_state()");
  console.log("state after:", JSON.stringify(after[0]));

  // duplicate retry must fail
  try {
    await q(`SELECT public.complete_tenant_onboarding('probe-y','Probe Y',null,'starter','monthly')`);
    console.log("ERROR: duplicate onboarding was allowed!");
  } catch (e) {
    console.log("duplicate denied OK:", (e as Error).message.slice(0, 90));
  }

  // plan code authority: unknown plan rejected
  await db.query("RESET role");
  await db.query("SELECT set_config('request.jwt.claims','{}',false)");
  const uid2 = crypto.randomUUID();
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'probe2@p30.test.local')`, [uid2]);
  await db.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uid2, role: "authenticated" })]);
  try {
    await q(`SELECT public.complete_tenant_onboarding('probe-z','Probe Z',null,'nonexistent-plan','weekly')`);
    console.log("ERROR: bad plan accepted!");
  } catch (e) {
    console.log("bad plan denied OK:", (e as Error).message.slice(0, 90));
  }

  const aud = await q(
    `SELECT action FROM politicore.system_audits WHERE tenant_id = $1 ORDER BY action`,
    [String(done[0].tenant_id)]
  );
  console.log("audits:", aud.map((r) => String(r.action)).join(", "));
  const notif = await q(
    `SELECT title FROM politicore.notifications WHERE tenant_id = $1`,
    [String(done[0].tenant_id)]
  );
  console.log("notifications:", notif.map((r) => String(r.title)).join(","));

  console.log("PROBE OK");
  await db.close();
}

main().catch((e) => {
  console.error("PROBE FAILED:", (e as Error).message);
  process.exit(1);
});
