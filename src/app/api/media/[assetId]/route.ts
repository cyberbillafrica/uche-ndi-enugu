/**
 * POLITICORE — GET /api/media/[assetId] (Phase 23)
 *
 * Public render path for BRANDING assets (logo/favicon) registered in the
 * Core Media registry. Server-only: the Media Service and provider
 * credentials never reach the browser — the client references only the
 * canonical `media_assets.id`.
 *
 * Isolation (gate §16): the asset must exist, belong to the tenant that
 * owns the requested slug, and be PUBLIC. Anything else → 404 (existence
 * is never disclosed across tenant boundaries).
 */
import { NextRequest, NextResponse } from "next/server";

import { getSupabaseClient } from "@/lib/supabase/config";
import { getMediaService, type DbLike } from "@/lib/media";

/**
 * Build the route-handler DB handle for the Media Service registry via the
 * direct Postgres connection (server-only) — the evidence-route pattern.
 */
function routeDbHandle(): DbLike {
  // Lazy require keeps pg (and its TLS sockets) out of client bundles.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg") as typeof import("pg");
  const url =
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL ??
    process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("Media render is not configured (DATABASE_URL missing)");
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const uuid = /^[0-9a-fA-F-]{36}$/.test(assetId) ? assetId : null;
  if (!uuid) {
    return NextResponse.json({ error: "Invalid asset reference" }, { status: 404 });
  }

  const slug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";

  try {
    // SECURITY DEFINER projection: slug + asset id + visibility checked in
    // one server-side statement; anon reaches only public assets of the
    // public tenant. (RLS alone cannot express the slug→tenant join.)
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("get_public_brand_asset", {
      p_tenant_slug: slug,
      p_asset_id: uuid,
    });
    if (error || !data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const media = getMediaService(routeDbHandle());
    const url = await media.accessUrl(
      {
        bucket: data.bucket,
        objectKey: data.object_key,
        visibility: data.visibility as "public" | "private",
      },
      3600
    );
    if (!url) {
      return NextResponse.json(
        { error: "Media provider has no public base URL configured" },
        { status: 502 }
      );
    }
    return NextResponse.redirect(url, 302);
  } catch (err) {
    console.error("[api/media] render failed:", err);
    return NextResponse.json({ error: "Media render unavailable" }, { status: 502 });
  }
}
