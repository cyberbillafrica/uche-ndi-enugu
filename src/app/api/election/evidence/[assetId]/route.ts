/**
 * POLITICORE — GET /api/election/evidence/[assetId] (Phase 2 cutover)
 *
 * Signed access to PRIVATE election evidence stored in R2 through the
 * Media Service. Authorization model:
 *
 *   1. authenticated session required (Authorization header);
 *   2. the asset must belong to the caller's tenant (server-resolved
 *      from the profile — a cross-tenant asset id 404s, never leaks);
 *   3. social-only accounts are denied;
 *   4. the asset must be Election-domain evidence (purpose check).
 *
 * Returns a short-lived redirect to the provider's signed URL. No R2
 * credentials or object keys ever reach the client.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAnonKey } from "@/lib/supabase/config";
import { getMediaService, type DbLike } from "@/lib/media";

function routeDbHandle(): DbLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg") as typeof import("pg");
  const url =
    process.env.DATABASE_URL ??
    process.env.SUPABASE_DB_URL ??
    process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("Evidence access is not configured (DATABASE_URL missing)");
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

function authClientFor(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabaseAnonKey();
  if (!url || !key) {
    throw new Error("Supabase is not configured for evidence access");
  }
  return createClient(url, key, {
    global: {
      headers: { Authorization: request.headers.get("Authorization") ?? "" },
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ assetId: string }> }
) {
  try {
    const { assetId } = await ctx.params;

    const auth = authClientFor(request);
    // auth-js v2 getSession() is storage-only (persistSession is off on
    // this per-request client and no sign-in has occurred here), so it
    // can never see the caller's Authorization header. getUser() with no
    // arguments sends the request WITH the forwarded Authorization header
    // and lets GoTrue validate the JWT server-side — the same
    // hasCustomAuthorizationHeader mechanism getUser() documents.
    const { data: userData } = await auth.auth.getUser();
    const user = userData.user;
    if (!user) {
      return NextResponse.json({ error: "Sign in to view evidence." }, { status: 401 });
    }

    const { data: profile } = await auth
      .from("politicore_profiles")
      .select("tenant_id, membership_types, access_role")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile?.tenant_id) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }
    const p = profile as {
      tenant_id: string;
      membership_types: string[] | null;
      access_role: string;
    };
    const mt = p.membership_types ?? [];
    const socialOnly =
      mt.includes("social_member") &&
      !mt.includes("campaign_member") &&
      !["admin", "tenant_super_admin", "platform_super_admin", "election_officer"].includes(
        p.access_role
      );
    if (socialOnly) {
      return NextResponse.json(
        { error: "Social accounts cannot access Election evidence." },
        { status: 403 }
      );
    }

    const media = getMediaService(routeDbHandle());
    const asset = await media.stat(assetId);

    // Tenant isolation: a foreign asset is indistinguishable from a
    // missing one. Election-domain purposes only.
    const purposeOk =
      !!asset?.purpose &&
      ["election_evidence", "pu_report_evidence", "incident_evidence"].includes(asset.purpose);
    if (!asset || asset.tenantId !== p.tenant_id || !purposeOk) {
      return NextResponse.json({ error: "Evidence not found." }, { status: 404 });
    }

    const url = await media.accessUrl(
      { bucket: asset.bucket, objectKey: asset.objectKey, visibility: asset.visibility },
      300 // short-lived view window
    );
    return NextResponse.redirect(url, 302);
  } catch (err) {
    console.error("[election evidence] access failed:", err);
    return NextResponse.json(
      { error: "Evidence access failed. Please try again." },
      { status: 500 }
    );
  }
}
