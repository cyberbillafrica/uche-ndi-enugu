/** Temporary probe: distinct synthetic phone values on SQL-seeded users + GoTrue sign-in. */
import * as fs from "fs";
import pg from "pg";
import { getHostedConfig } from "./apply-hosted";

function loadEnv(): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) vals[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vals;
}
const env = loadEnv();
const KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

async function seedUser(sql: pg.Client, email: string, phone: string | null): Promise<string> {
  const uid = crypto.randomUUID();
  await sql.query(
    `INSERT INTO auth.users (
       id, instance_id, aud, role, email,
       raw_app_meta_data, raw_user_meta_data, is_super_admin,
       encrypted_password, created_at, updated_at,
       email_confirmed_at, confirmation_sent_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       phone, phone_change_token, phone_change
     )
     VALUES (
       $1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2,
       jsonb_build_object('provider','email','providers',jsonb_build_array('email')), '{}'::jsonb, false,
       extensions.crypt('Probe!pass1', extensions.gen_salt('bf', 10)), now(), now(),
       now(), now(), '', '', '', '', $3, '', ''
     )`,
    [uid, email, phone]
  );
  await sql.query(
    `INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
     VALUES ($1::uuid, $1::uuid, 'email', 'email',
             jsonb_build_object('sub', $1::uuid::text, 'email', $2::text, 'email_verified', true),
             now(), now(), now()) ON CONFLICT DO NOTHING`,
    [uid, email]
  );
  return uid;
}

async function signin(email: string): Promise<{ status: number; body: string }> {
  const si = await fetch(env.NEXT_PUBLIC_SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Probe!pass1" }),
  });
  return { status: si.status, body: (await si.text()).slice(0, 80) };
}

async function main() {
  const sql = new pg.Client({ ...getHostedConfig(), connectionTimeoutMillis: 15000 });
  await sql.connect();

  const u1 = await seedUser(sql, "probe.p1.test@pcorb.example.com", "+80000000001");
  console.log("phone='+80000000001' →", JSON.stringify(await signin("probe.p1.test@pcorb.example.com")));

  const u2 = await seedUser(sql, "probe.p2.test@pcorb.example.com", "+80000000002");
  console.log("phone='+80000000002' →", JSON.stringify(await signin("probe.p2.test@pcorb.example.com")));

  await sql.query(`DELETE FROM auth.users WHERE id IN ($1, $2)`, [u1, u2]);
  await sql.end();
  console.log("PROBE DONE");
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
