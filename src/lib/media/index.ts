/**
 * POLITICORE — Media Service (Phase 1A).
 *
 * The only surface application modules should ever import:
 *   getMediaService() → MediaService
 *
 * Provider selection by env: MEDIA_PROVIDER = r2 (default) | local.
 * Tenant-aware object paths:  tenants/{tenantId}/{purpose}/{yyyy}/{mm}/{ulid}
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { r2Provider } from "./r2-provider";
import type {
  MediaAssetRecord,
  MediaProvider,
  MediaService,
  MediaUploadRequest,
  MediaVisibility,
} from "./types";

export * from "./types";

// ── Local provider (dev/tests; no network) ───────────────────────────────────
export function localProvider(rootDir = ".media-local"): MediaProvider {
  return {
    name: "local",
    async put(_bucket, key, body, contentType) {
      const buf = Buffer.isBuffer(body)
        ? body
        : Buffer.from(await new Response(body as ArrayBuffer).arrayBuffer());
      const full = path.join(rootDir, key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, buf);
      // contentType ignored in local provider (registry keeps it)
      void contentType;
    },
    async publicUrl(_bucket, key) {
      return `/media-local/${key}`;
    },
    async signedUrl(_bucket, key) {
      return `/media-local/${key}`;
    },
    async remove(_bucket, key) {
      await unlink(path.join(rootDir, key)).catch(() => undefined);
    },
    async exists(_bucket, key) {
      try {
        await stat(path.join(rootDir, key));
        return true;
      } catch {
        return false;
      }
    },
    async head(_bucket, key) {
      try {
        const s = await stat(path.join(rootDir, key));
        return { sizeBytes: s.size, contentType: null };
      } catch {
        return null;
      }
    },
  };
}

// ── Service over provider ────────────────────────────────────────────────────
export interface DbLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function mediaService(provider: MediaProvider, bucket: string, db: DbLike): MediaService {
  return {
    ...provider,

    async upload(req: MediaUploadRequest): Promise<MediaAssetRecord> {
      if (!req.tenantId) throw new Error("tenantId required");

      const now = new Date();
      const key = [
        "tenants",
        req.tenantId,
        req.purpose,
        String(now.getUTCFullYear()),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        `${randomUUID()}-${req.fileName ?? "file"}`,
      ].join("/");

      await provider.put(bucket, key, req.body, req.contentType, req.visibility);

      const insert = await db.query(
        `INSERT INTO politicore.media_assets
           (tenant_id, provider, bucket, object_key, visibility, content_type, size_bytes, purpose, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, tenant_id, provider, bucket, object_key, visibility, content_type, size_bytes, purpose, uploaded_by::text`,
        [
          req.tenantId,
          provider.name,
          bucket,
          key,
          req.visibility,
          req.contentType,
          null,
          req.purpose,
          req.uploadedBy ?? null,
        ]
      );
      const row = insert.rows[0];
      return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        provider: String(row.provider),
        bucket: String(row.bucket),
        objectKey: String(row.object_key),
        visibility: row.visibility as MediaVisibility,
        contentType: (row.content_type as string) ?? null,
        sizeBytes: (row.size_bytes as number) ?? null,
        purpose: (row.purpose as string) ?? null,
        url: null,
      };
    },

    async accessUrl(asset, expiresInSeconds = 3600) {
      if (asset.visibility === "public") {
        const pub = await provider.publicUrl(asset.bucket, asset.objectKey);
        if (pub) return pub;
      }
      return provider.signedUrl(asset.bucket, asset.objectKey, expiresInSeconds);
    },

    async stat(registryId) {
      const res = await db.query(
        `SELECT id, tenant_id, provider, bucket, object_key, visibility, content_type, size_bytes, purpose
         FROM politicore.media_assets WHERE id = $1`,
        [registryId]
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        provider: String(row.provider),
        bucket: String(row.bucket),
        objectKey: String(row.object_key),
        visibility: row.visibility as MediaVisibility,
        contentType: (row.content_type as string) ?? null,
        sizeBytes: (row.size_bytes as number) ?? null,
        purpose: (row.purpose as string) ?? null,
        url: null,
      };
    },
  };
}

// ── Env-based factory ────────────────────────────────────────────────────────
/**
 * Build the Media Service from environment configuration.
 *
 * `db` is the application database handle used for the media_assets
 * registry. In server contexts (Next.js route handlers, edge functions)
 * pass a query-capable handle; without one, registry-backed operations
 * (upload/stat) throw. Browser code must not call this — private URL
 * signing and provider credentials stay server-side (spec §18/§38).
 */
export function getMediaService(db?: DbLike): MediaService {
  const providerName = process.env.MEDIA_PROVIDER ?? "r2";
  const bucket =
    process.env.MEDIA_BUCKET ?? process.env.R2_BUCKET_NAME ?? "politicore-media";
  if (providerName === "local") {
    if (!db) throw new Error("getMediaService(db) requires a database handle for the registry");
    return mediaService(localProvider(), bucket, db);
  }
  const { accountId, accessKeyId, secretAccessKey, publicBaseUrl } = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
  };
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }
  if (!db) throw new Error("getMediaService(db) requires a database handle for the registry");
  return mediaService(
    r2Provider({ accountId, accessKeyId, secretAccessKey, bucket, publicBaseUrl }),
    bucket,
    db
  );
}
