/**
 * POLITICORE — POST /api/branding/upload (Phase 23)
 *
 * Logo/favicon upload through the Core Media Service:
 *
 *   Branding editor → this route → Media Service → provider → media_assets
 *
 * Identity comes from the Supabase session (Authorization header — never
 * the payload); tenant comes from the server-side profile row. The upload
 * is gated on tenant ADMINISTRATION authority (the same authority that
 * guards configuration writes). Assets are stored PUBLIC because a logo/
 * favicon renders on the anonymous public site — the migration 0061
 * validators then bind the canonical asset id into the branding config.
 *
 * Server-only: R2 credentials and the registry DB handle never reach the
 * browser; the client receives only the canonical media_assets.id.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAnonKey } from "@/lib/supabase/config";
import { getMediaService, type DbLike } from "@/lib/media";

/** Build the route-handler DB handle for the Media Service registry (server-only). */
function routeDbHandle(): DbLike {
  // Lazy require keeps pg (and its TLS sockets) out of client bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg") as typeof import("pg");
  const url =
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL ??
    process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("Branding upload is not configured (DATABASE_URL missing)");
  }
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  let connected = false;
  return {
    async query(sql: string, params?: unknown[]) {
      if (!connected) {
        await client.connect();
        connected = true;
      }
      const res = await client.query(sql, params as never[]);
      return { rows: res.rows as Record<string, unknown>[] };
    },
  };
}

const BRANDING_MAX_BYTES = 2 * 1024 * 1024;
const BRANDING_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
];
const BRANDING_PURPOSES = ["branding_logo", "branding_favicon"];

/** Per-request authenticated Supabase client (forwards the Authorization header). */
function authClientFor(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabaseAnonKey();
  if (!url || !key) {
    throw new Error("Supabase is not configured for branding upload");
  }
  return createClient(url, key, {
    global: {
      headers: { Authorization: request.headers.get("Authorization") ?? "" },
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function POST(request: NextRequest) {
  try {
    const auth = authClientFor(request);
    // getUser() forwards the Authorization header; GoTrue validates the JWT
    // server-side (the storage-only getSession can never see it).
    const { data: userData } = await auth.auth.getUser();
    const user = userData.user;
    if (!user) {
      return NextResponse.json({ error: "Sign in to upload branding assets." }, { status: 401 });
    }

    // Tenant resolved server-side from the profile row — never the payload.
    const { data: profile, error: profileErr } = await auth
      .from("politicore_profiles")
      .select("tenant_id, access_role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileErr || !profile?.tenant_id) {
      return NextResponse.json(
        { error: "Your account is not linked to an organization." },
        { status: 403 }
      );
    }
    const p = profile as { tenant_id: string; access_role: string };
    // Tenant administration authority — the Control Center authority (§17).
    if (!["admin", "tenant_super_admin", "platform_super_admin"].includes(p.access_role)) {
      return NextResponse.json(
        { error: "Tenant administration authority is required for branding uploads." },
        { status: 403 }
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach an image file." }, { status: 400 });
    }
    if (file.size > BRANDING_MAX_BYTES) {
      return NextResponse.json(
        { error: "Branding image is too large (2 MB maximum)." },
        { status: 413 }
      );
    }
    if (file.type && !BRANDING_CONTENT_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Branding images must be PNG, JPEG, WebP, SVG or ICO." },
        { status: 415 }
      );
    }
    const rawPurpose = form.get("purpose");
    const purpose =
      typeof rawPurpose === "string" && BRANDING_PURPOSES.includes(rawPurpose)
        ? rawPurpose
        : "branding_logo";

    const media = getMediaService(routeDbHandle());
    const asset = await media.upload({
      tenantId: p.tenant_id,
      uploadedBy: user.id,
      purpose,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
      fileName: file.name || undefined,
      visibility: "public",
    });

    return NextResponse.json({ assetId: asset.id, purpose });
  } catch (err) {
    console.error("[api/branding/upload] failed:", err);
    const message = err instanceof Error ? err.message : "Branding upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
