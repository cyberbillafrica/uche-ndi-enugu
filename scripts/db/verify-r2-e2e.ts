/**
 * POLITICORE — Cloudflare R2 end-to-end verification (Phase 1B, spec §17/§18).
 *
 * Runs the real MediaService (src/lib/media) against the REAL Cloudflare R2
 * bucket: upload → head/exists → public URL → private signed URL (fetched)
 * → registry with RLS (cross-tenant read denied) → delete → cleanup.
 *
 * Secrets come from .env.local and are never printed. Cleanup removes all
 * created objects and registry rows (direct DB connection for RLS-free
 * registry cleanup, matching the RLS-free direct connection used by the
 * provisioning bootstrap).
 */
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import {
  getMediaService,
  type MediaAssetRecord,
  type MediaVisibility,
} from "../../src/lib/media";
import type { MediaService } from "../../src/lib/media/types";
import { getHostedConfig } from "./apply-hosted";

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

const env = loadEnv();
const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const cfg = getHostedConfig();
  const pool = new pg.Pool({ ...cfg, max: 1 });
  const sql = await pool.connect();

  const bucket = env.R2_BUCKET_NAME ?? "politicore-media";
  const svc: MediaService = getMediaService({
    query: async (q, params) => {
      const r = await sql.query(q, params as never[]);
      return { rows: r.rows as Record<string, unknown>[] };
    },
  });

  // Distinct tenants for the isolation test.
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const registryIds: string[] = [];
  const objectKeys: string[] = [];
  let publicAsset: MediaAssetRecord | null = null;
  let privateAsset: MediaAssetRecord | null = null;

  try {
    // ── 0. real tenant rows (registry FK + RLS isolation test) ───────────
    await sql.query(`INSERT INTO politicore.tenants (id, slug, name) VALUES ($1,$2,$3)`,
      [tenantA, `r2e2-a-${SUFFIX2()}`, "R2 E2E Tenant A"]);
    await sql.query(`INSERT INTO politicore.tenants (id, slug, name) VALUES ($1,$2,$3)`,
      [tenantB, `r2e2-b-${SUFFIX2()}`, "R2 E2E Tenant B"]);

    // ── 1. upload PUBLIC asset ────────────────────────────────────────────
    const pubBody = Buffer.from(`politicore-public-${crypto.randomUUID()}`);
    publicAsset = await svc.upload({
      tenantId: tenantA,
      purpose: "cms",
      visibility: "public" as MediaVisibility,
      contentType: "text/plain",
      fileName: "public-note.txt",
      body: pubBody,
    });
    record("upload (public) → R2 + registry row", Boolean(publicAsset?.id && publicAsset.bucket === bucket),
      `key ${publicAsset?.objectKey.slice(0, 48)}…`);
    objectKeys.push(publicAsset.objectKey);
    registryIds.push(publicAsset.id);

    // ── 2. upload PRIVATE asset (election-evidence semantics) ────────────
    const privBody = Buffer.from(`politicore-private-${crypto.randomUUID()}`);
    privateAsset = await svc.upload({
      tenantId: tenantA,
      purpose: "election-evidence",
      visibility: "private" as MediaVisibility,
      contentType: "text/plain",
      fileName: "evidence.txt",
      body: privBody,
    });
    record("upload (private) → R2 + registry row", Boolean(privateAsset?.id),
      `key ${privateAsset?.objectKey.slice(0, 48)}…`);
    objectKeys.push(privateAsset.objectKey);
    registryIds.push(privateAsset.id);

    // ── 3. head / exists / registry stat ─────────────────────────────
    const provHead = await svc.head(privateAsset.bucket, privateAsset.objectKey);
    record("head() returns stored metadata (provider HEAD)",
      Boolean(provHead && provHead.contentType === "text/plain"),
      JSON.stringify(provHead));
    const regStat = await svc.stat(privateAsset.id);
    record("stat(registry) returns stored metadata",
      Boolean(regStat && regStat.visibility === "private" && regStat.objectKey === privateAsset.objectKey),
      JSON.stringify({ visibility: regStat?.visibility, purpose: regStat?.objectKey?.slice(0, 24) }));
    const existsPriv = await svc.exists(privateAsset.bucket, privateAsset.objectKey);
    record("exists() true for uploaded object", existsPriv === true, `HEAD ${privateAsset.objectKey.slice(0, 40)}…`);
    const existsMissing = await svc.exists(bucket, `tenants/${tenantA}/nope/missing-${SUFFIX2()}.bin`);
    record("exists() false for missing object", existsMissing === false);

    // ── 4. public access: unsigned fetch of the PUBLIC asset ─────────────
    // R2 only serves unsigned GETs through a PUBLIC base URL (custom
    // domain / r2.dev). Without that env the Media Service honestly falls
    // back to presigned URLs — reported as config-unresolved, not faked.
    const pubUrl = await svc.accessUrl(publicAsset, 3600);
    if (!env.R2_PUBLIC_BASE_URL) {
      const pubSignedFetch = await fetch(pubUrl);
      const pubSignedText = await pubSignedFetch.text();
      record("public asset retrievable (presigned fallback — no R2_PUBLIC_BASE_URL configured)",
        pubSignedFetch.status === 200 && pubSignedText === pubBody.toString(),
        `HTTP ${pubSignedFetch.status}; unsigned-public check UNRESOLVED (needs R2_PUBLIC_BASE_URL)`);
    } else {
      const pubFetch = await fetch(pubUrl);
      const pubText = await pubFetch.text();
      record("public asset fetchable WITHOUT signature",
        pubFetch.status === 200 && pubText === pubBody.toString(),
        `HTTP ${pubFetch.status}, ${pubText.length} bytes`);
    }

    // ── 5. private access: signed URL works, unsigned does NOT ───────────
    const signedUrl = await svc.accessUrl(privateAsset, 120);
    const signedFetch = await fetch(signedUrl);
    const signedText = await signedFetch.text();
    record("private asset fetchable WITH signature (presigned GET)",
      signedFetch.status === 200 && signedText === privBody.toString(),
      `HTTP ${signedFetch.status}, body: ${signedText.slice(0, 300)}`);

    const unsignedFetch = await fetch(signedUrl.split("?")[0]);
    const unsignedBody = await unsignedFetch.text();
    const refusal = [400, 403].includes(unsignedFetch.status);
    record("private asset DENIED without signature", refusal,
      `HTTP ${unsignedFetch.status} — ${unsignedBody.includes("<Error>")
        ? (unsignedBody.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? "R2 error")
        : unsignedBody.slice(0, 80)}`);
    const tampered = new URL(signedUrl);
    tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
    const tamperedFetch = await fetch(tampered.toString());
    record("private asset DENIED with tampered signature", tamperedFetch.status === 403,
      `HTTP ${tamperedFetch.status}`);

    // ── 6. registry tenant isolation (RLS) ───────────────────────────────
    // Tenant B's registry view must not see Tenant A's asset ids. The
    // registry check runs at the database level with real RLS semantics.
    const iso = await sql.query(
      `SELECT count(*)::int AS n FROM politicore.media_assets WHERE id = ANY($1::uuid[])`,
      [registryIds]
    );
    record("registry rows exist (owner connection)", iso.rows[0].n === registryIds.length,
      `${iso.rows[0].n}/${registryIds.length} rows`);

    // Authenticated member of tenant B must see zero of tenant A's assets.
    await sql.query(`SELECT set_config('role', 'authenticated', false)`);
    await sql.query(`SELECT set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ sub: crypto.randomUUID(), role: "authenticated" })]);
    const crossRead = await sql.query(
      `SELECT count(*)::int AS n FROM politicore.media_assets WHERE id = ANY($1::uuid[])`,
      [registryIds]
    );
    await sql.query(`RESET role`);
    await sql.query(`SELECT set_config('request.jwt.claims', '{}', false)`);
    record("registry: authenticated non-member sees 0 of tenant A's assets", crossRead.rows[0].n === 0,
      `${crossRead.rows[0].n} visible`);

    // ── 7. delete + verify gone ──────────────────────────────────────────
    await svc.remove(privateAsset.bucket, privateAsset.objectKey);
    const gone = await svc.exists(privateAsset.bucket, privateAsset.objectKey);
    record("delete removes the object (exists → false)", gone === false);

    await sql.query(`DELETE FROM politicore.media_assets WHERE id = ANY($1::uuid[])`, [registryIds]);
    const regGone = await sql.query(`SELECT count(*)::int AS n FROM politicore.media_assets WHERE id = ANY($1::uuid[])`, [registryIds]);
    record("registry rows deleted", regGone.rows[0].n === 0, `${regGone.rows[0].n} left`);
  } catch (e) {
    record("unexpected failure", false, String(e).slice(0, 300));
  } finally {
    // Best-effort cleanup: registry rows, tenants, objects.
    if (registryIds.length) {
      await sql.query(`DELETE FROM politicore.media_assets WHERE id = ANY($1::uuid[])`, [registryIds])
        .catch(() => undefined);
    }
    await sql.query(`DELETE FROM politicore.tenants WHERE id = ANY($1::uuid[])`, [[tenantA, tenantB]])
      .catch(() => undefined);
    for (const key of objectKeys) {
      await svc.remove(bucket, key).catch(() => undefined);
    }
    if (registryIds.length) {
      await sql.query(`DELETE FROM politicore.media_assets WHERE id = ANY($1::uuid[])`, [registryIds])
        .catch(() => undefined);
    }
    sql.release();
    await pool.end();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nR2 E2E: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

function SUFFIX2(): string {
  return Date.now().toString(36);
}

main();
