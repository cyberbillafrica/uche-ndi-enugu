/**
 * POLITICORE — Cloudflare R2 provider for the Media Service.
 *
 * R2 exposes an S3-compatible API; this provider signs requests with
 * SigV4 (service "s3", region "auto"). Consuming modules never touch
 * this file — they use the MediaService factory in ./index.ts.
 */
import { createHash, createHmac } from "node:crypto";
import type { MediaProvider, MediaVisibility } from "./types";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public base URL for public objects (custom domain or r2.dev). */
  publicBaseUrl?: string;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function amzDate(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function uriEncode(s: string, encodeSlash = true): string {
  let out = "";
  for (const ch of s) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

interface SigV4Result {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build a SigV4-signed request (header auth) or presigned URL (query auth).
 */
export function signR2(
  config: R2Config,
  method: string,
  key: string,
  opts: {
    query?: Record<string, string>;
    body?: Buffer;
    expiresSeconds?: number; // presign when provided
  } = {}
): SigV4Result {
  const host = `${config.bucket}.${config.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = "/" + key.split("/").map((p) => uriEncode(p)).join("/");
  const now = amzDate();
  const dateStamp = now.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  const isPresign = opts.expiresSeconds !== undefined;
  const payloadHash = opts.body ? sha256Hex(opts.body) : sha256Hex(Buffer.alloc(0));

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": isPresign ? "UNSIGNED-PAYLOAD" : payloadHash,
    "x-amz-date": now,
  };

  // Canonical query string
  const queryEntries: [string, string][] = Object.entries(opts.query ?? {}).map(
    ([k, v]) => [uriEncode(k), uriEncode(v)] as [string, string]
  );
  if (isPresign) {
    queryEntries.push(
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", uriEncode(`${config.accessKeyId}/${scope}`)],
      ["X-Amz-Date", now],
      ["X-Amz-Expires", String(opts.expiresSeconds)],
      ["X-Amz-SignedHeaders", "host"]
    );
  }
  queryEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join("&");

  const signedHeaders = isPresign ? "host" : Object.keys(headers).sort().join(";");
  // Presigned URLs: the canonical request includes ONLY the headers listed
  // in SignedHeaders (verified against R2's SignatureDoesNotMatch error
  // body — including unsigned x-amz-* headers breaks the signature).
  const canonicalHeaders = (isPresign ? ["host"] : Object.keys(headers).sort())
    .map((h) => `${h}:${headers[h].trim()}\n`)
    .join("");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    isPresign ? "UNSIGNED-PAYLOAD" : payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    now,
    scope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const kDate = hmac(Buffer.from(`AWS4${config.secretAccessKey}`), dateStamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  if (isPresign) {
    const url = `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    return { url, headers: {} };
  }

  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${host}${canonicalUri}${canonicalQuery ? "?" + canonicalQuery : ""}`, headers };
}

export function r2Provider(config: R2Config): MediaProvider {
  async function call(
    method: string,
    key: string,
    opts: { body?: Buffer; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const { url, headers } = signR2(config, method, key, { body: opts.body });
    const init: RequestInit = {
      method,
      headers: { ...headers, ...(opts.headers ?? {}) },
    };
    if (opts.body) init.body = new Uint8Array(opts.body);
    const res = await fetch(url, init);
    return res;
  }

  return {
    name: "r2",

    async put(bucket, key, body, contentType, _visibility) {
      const buf = Buffer.isBuffer(body)
        ? body
        : Buffer.from(await new Response(body as ArrayBuffer).arrayBuffer());
      const res = await call("PUT", key, { body: buf, headers: { "content-type": contentType } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `R2 upload failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
        );
      }
      void bucket;
    },

    async publicUrl(_bucket, key) {
      if (!config.publicBaseUrl) return null;
      return `${config.publicBaseUrl.replace(/\/$/, "")}/${key}`;
    },

    async signedUrl(_bucket, key, expiresInSeconds) {
      const { url } = signR2(config, "GET", key, { expiresSeconds: expiresInSeconds });
      return url;
    },

    async remove(_bucket, key) {
      const res = await call("DELETE", key);
      if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`);
    },

    async exists(_bucket, key) {
      const res = await call("HEAD", key);
      return res.ok;
    },

    async head(_bucket, key) {
      const res = await call("HEAD", key);
      if (!res.ok) return null;
      return {
        sizeBytes: res.headers.get("content-length") ? Number(res.headers.get("content-length")) : null,
        contentType: res.headers.get("content-type"),
      };
    },
  };
}

export type { MediaVisibility };
