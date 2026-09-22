/**
 * POLITICORE — Media Service abstraction (Phase 1A).
 *
 * Application modules depend ONLY on this interface — never on R2,
 * Supabase Storage, S3, or Cloudinary directly. The provider is chosen
 * by configuration (MEDIA_PROVIDER env var), defaulting to Cloudflare R2.
 */
export type MediaVisibility = "public" | "private";

export interface MediaUploadRequest {
  /** Tenant-owned path prefix; enforced server-side. */
  tenantId: string;
  /** Logical purpose, e.g. "election_evidence", "cms_news", "governance_attachment". */
  purpose: string;
  /** Raw bytes or Blob. */
  body: Buffer | Blob | ArrayBuffer;
  contentType: string;
  /** Optional explicit file name (else provider generates one). */
  fileName?: string;
  visibility: MediaVisibility;
}

export interface MediaAssetRecord {
  id: string;
  tenantId: string;
  provider: string;
  bucket: string;
  objectKey: string;
  visibility: MediaVisibility;
  contentType: string | null;
  sizeBytes: number | null;
  url: string | null;
}

export interface MediaProvider {
  readonly name: string;
  /** Store bytes; returns bucket + object key. */
  put(
    bucket: string,
    key: string,
    body: Buffer | Blob | ArrayBuffer,
    contentType: string,
    visibility: MediaVisibility
  ): Promise<void>;
  /** Public URL for public objects (null if not public). */
  publicUrl(bucket: string, key: string): Promise<string | null>;
  /** Signed read URL for private objects, expiring. */
  signedUrl(bucket: string, key: string, expiresInSeconds: number): Promise<string>;
  remove(bucket: string, key: string): Promise<void>;
  exists(bucket: string, key: string): Promise<boolean>;
  head(bucket: string, key: string): Promise<{ sizeBytes: number | null; contentType: string | null } | null>;
}

export interface MediaService extends MediaProvider {
  /** Upload with tenant-aware path + registry row (media_assets). */
  upload(req: MediaUploadRequest): Promise<MediaAssetRecord>;
  /** Read URL honoring visibility. */
  accessUrl(asset: { bucket: string; objectKey: string; visibility: MediaVisibility }, expiresInSeconds?: number): Promise<string>;
  /** Registry lookup + existence check. */
  stat(registryId: string): Promise<MediaAssetRecord | null>;
}
