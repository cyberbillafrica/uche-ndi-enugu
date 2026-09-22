/** Temporary probe: does a pgcrypto bcrypt hash self-verify in-database? */
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();
  const uid = crypto.randomUUID();
  await sql.query(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
     VALUES ($1, 'probe.hash.test@pcorb.example.com', extensions.crypt('Probe!pass1', extensions.gen_salt('bf')), now(),
             jsonb_build_object('provider','email','providers',jsonb_build_array('email')), '{}'::jsonb)`,
    [uid]
  );
  const r = await sql.query(
    `SELECT encrypted_password,
            extensions.crypt('Probe!pass1', encrypted_password) = encrypted_password AS verifies
     FROM auth.users WHERE id = $1`,
    [uid]
  );
  console.log(
    "hash self-verify:",
    r.rows[0].verifies,
    "| hash prefix:",
    String(r.rows[0].encrypted_password).slice(0, 7),
    "| len:",
    String(r.rows[0].encrypted_password).length
  );
  await sql.query(`DELETE FROM auth.users WHERE id = $1`, [uid]);
  await sql.end();
  console.log("PROBE DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
