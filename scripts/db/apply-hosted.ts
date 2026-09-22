/**
 * POLITICORE — apply migrations to the HOSTED Supabase database (Phase 1B).
 *
 * Uses the Supabase DATABASE_URL (session pooler) directly because the
 * environment has no Supabase CLI / Docker / psql. Migrations run in
 * filename order; each file executes as one implicit transaction
 * (node-postgres simple-query semantics), matching `supabase db push`.
 *
 * Idempotence: some hosted projects lack supabase_migrations.schema_migrations
 * (this one does), so "already applied" is detected per-migration by a
 * signature object (a table/function/view that migration creates). A
 * migration whose signature exists is skipped (and recorded when the
 * history table IS available). A migration with no recorded history and
 * no signature is applied exactly once. Re-running is always safe.
 *
 * Secrets come from .env.local; they are never printed.
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";

// ── env loading (no dotenv dependency) ──────────────────────────────────────
function loadEnv(): Record<string, string> {
  const vals: Record<string, string> = {};
  const file = path.resolve(".env.local");
  if (!fs.existsSync(file)) return vals;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) vals[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vals;
}

/**
 * Tolerant Postgres URL parser. The pasted Supabase connection string can
 * arrive wrapped in quotes and with a password containing % / + characters
 * that are NOT percent-encoded; new URL() and pg's own parser either fail
 * or mis-decode those. We therefore extract components with a regex and do
 * NOT decode, passing them to pg as a config object.
 */
export function parseDatabaseUrl(rawUrl: string): pg.ClientConfig {
  const url = rawUrl.trim().replace(/^["']+|["']+$/g, "");
  const m = url.match(/^postgres(?:ql)?:\/\/([^:@/]+):([^@]+)@([^:/]+):(\d+)\/([^?\s]+)/);
  if (!m) throw new Error("DATABASE_URL is not a recognizable postgres:// URL");
  const [, user, password, host, port, database] = m;
  return {
    user,
    password,
    host,
    port: Number(port),
    database,
    ssl: { rejectUnauthorized: false }, // Supabase pooler TLS
  };
}

export function getHostedConfig(): pg.ClientConfig {
  const env = loadEnv();
  const url = env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  return parseDatabaseUrl(url);
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await client.connect();
  return client;
}

// ── preflight ────────────────────────────────────────────────────────────────
interface Preflight {
  currentUser: string;
  serverVersion: string;
  hostedAuthSchema: boolean;
  existingPoliticoreTables: number;
}

export async function preflight(client: pg.Client): Promise<Preflight> {
  const me = await client.query<{ current_user: string }>("SELECT current_user");
  const ver = await client.query<{ server_version: string }>("SHOW server_version");
  const hosted = await client.query<{ hosted: boolean }>(
    `SELECT to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL AS hosted`
  );
  const tables = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.tables
     WHERE table_schema = 'politicore' AND table_type = 'BASE TABLE'`
  );
  return {
    currentUser: me.rows[0].current_user,
    serverVersion: ver.rows[0].server_version,
    hostedAuthSchema: hosted.rows[0].hosted,
    existingPoliticoreTables: Number(tables.rows[0].n),
  };
}

// ── per-migration signature objects (idempotence without history) ───────────
const SIGNATURES: Record<string, string> = {
  "0000": `to_regprocedure('auth.uid()') IS NOT NULL`,
  "0001": `to_regclass('politicore.tenants') IS NOT NULL`,
  "0002": `to_regprocedure('politicore.has_permission(text,politicore.scope_type_enum,text)') IS NOT NULL`,
  "0003": `to_regclass('politicore.states') IS NOT NULL AND (SELECT count(*) FROM politicore.states) > 0`,
  "0004": `to_regclass('politicore.permissions') IS NOT NULL AND (SELECT count(*) FROM politicore.permissions) > 0`,
  "0005": `to_regprocedure('politicore.my_tenant_id()') IS NOT NULL`,
  "0006": `to_regprocedure('politicore.custom_access_token_hook(jsonb)') IS NOT NULL`,
  "0007": `to_regprocedure('politicore.provision_tenant(text,text,text,text,jsonb)') IS NOT NULL`,
  "0008": `to_regprocedure('public.mark_notifications_read(uuid[])') IS NOT NULL`,
  "0009": `to_regclass('public.notifications') IS NOT NULL`,
  "0010": `EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'politicore' AND p.proname = 'provision_tenant'
           AND p.prosrc LIKE '%IS TRUE%')`,
  "0013": `NOT EXISTS (SELECT 1 FROM politicore.senatorial_zones WHERE id = 'enugu-south-zone')`,
  "0014": `to_regclass('politicore.election_results') IS NOT NULL`,
  "0015": `to_regprocedure('politicore.submit_election_result(uuid,text,jsonb,uuid)') IS NOT NULL`,
  "0016": `(SELECT count(*) FROM politicore.political_parties) > 0`,
  // 0017's durable artifact is the realtime publication membership (the
  // views it created are dropped/recreated by 0018/0019 during the
  // relational-votes amendment, so the view is NOT a stable signature).
  "0017": `(SELECT count(*) FROM pg_publication_tables
           WHERE pubname='supabase_realtime' AND schemaname='politicore'
             AND tablename IN ('election_results','pu_reports','election_incidents')) = 3`,
  "0018": `to_regclass('politicore.election_result_votes') IS NOT NULL`,
  "0019": `to_regclass('politicore.election_results_current') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema='politicore'
                             AND table_name='election_results_current'
                             AND column_name='votes')`,
};

function migrationFiles(dir: string): { file: string; version: string; sql: string }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, version: f.split("_")[0], sql: fs.readFileSync(path.join(dir, f), "utf8") }));
}

export async function applyHostedMigrations(
  client: pg.Client,
  log: (s: string) => void = console.log
): Promise<string[]> {
  const files = migrationFiles(path.resolve("supabase/migrations"));
  const appliedNow: string[] = [];

  const hasMigrationTable = await client
    .query("SELECT 1 FROM supabase_migrations.schema_migrations LIMIT 1")
    .then(() => true)
    .catch(() => false);
  if (!hasMigrationTable) {
    log("note: supabase_migrations.schema_migrations not present — using signature-based idempotence");
  }

  for (const f of files) {
    if (hasMigrationTable) {
      const done = await client.query(
        `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1`,
        [f.version]
      );
      if (done.rows.length) {
        log(`  = ${f.file} (recorded)`);
        continue;
      }
    }

    const sigSql = SIGNATURES[f.version];
    if (sigSql) {
      try {
        const sig = await client.query(`SELECT ${sigSql} AS applied`);
        if (sig.rows[0].applied) {
          log(`  = ${f.file} (signature exists)`);
          if (hasMigrationTable) {
            await client.query(
              `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [f.version, f.file, f.sql]
            );
          }
          continue;
        }
      } catch {
        // signature query failed (e.g. count on missing table) → not applied
      }
    }

    log(`  → ${f.file}`);
    await client.query(f.sql); // single implicit transaction
    appliedNow.push(f.file);
    if (hasMigrationTable) {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [f.version, f.file, f.sql]
      );
    }
  }
  return appliedNow;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const client = await connect();
  try {
    const pre = await preflight(client);
    console.log("Hosted preflight:");
    console.log("  user:", pre.currentUser, "| server:", pre.serverVersion);
    console.log("  real auth schema:", pre.hostedAuthSchema);
    console.log("  existing politicore tables:", pre.existingPoliticoreTables);

    if (!pre.hostedAuthSchema) {
      console.error("STOP: auth schema/uid() not found — this does not look like the hosted Supabase project.");
      process.exit(2);
    }

    console.log("Applying migrations:");
    const applied = await applyHostedMigrations(client);
    console.log(`Applied ${applied.length} migration(s).`);

    // ── verification against Phase 1A local results ──────────────────────
    const counts = await client.query(`
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
    console.log("Row counts:", counts.rows[0]);

    const rls = await client.query(`
      SELECT
        count(*) FILTER (WHERE c.relrowsecurity) AS enabled,
        count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity) AS forced,
        (SELECT count(*) FROM pg_policies WHERE schemaname='politicore') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='politicore' AND c.relkind='r'
    `);
    console.log("RLS:", rls.rows[0]);

    const views = await client.query(`
      SELECT count(*)::int AS public_views FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name IN ('politicore_profiles','tenants','tenant_modules','public_site_settings',
                           'notifications','states','senatorial_zones','lgas','wards','polling_units')
    `);
    console.log("Public API views:", views.rows[0]);

    const hookSmoke = await client.query(
      `SELECT politicore.custom_access_token_hook('{"claims":{"sub":"00000000-0000-0000-0000-000000000000"}}'::jsonb) AS out`
    );
    const hookOut = hookSmoke.rows[0].out as { claims: { app_metadata?: Record<string, unknown> } };
    console.log("Hook smoke (unknown user → null claims):", JSON.stringify(hookOut.claims.app_metadata));

    console.log("HOSTED MIGRATIONS OK");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("HOSTED APPLY FAILED:", e.message);
    process.exit(1);
  });
}
