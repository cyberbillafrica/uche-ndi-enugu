/**
 * POLITICORE — POST /api/election/evidence (Phase 2 cutover)
 *
 * Election evidence upload through the Media Service (§10):
 *
 *   Election UI → this route → Media Service → R2 → media_assets
 *
 * Identity comes from the Supabase session (Authorization header —
 * never the payload); tenant comes from the server-side profile row.
 * Social-only accounts are denied here AND by every database layer.
 * Evidence is stored PRIVATE: viewing goes through the signed-access
 * route, never a constructed public URL.
 *
 * Server-only: R2 credentials and the registry DB handle never reach
 * the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getSupabaseClient,
  getSupabaseAnonKey,
} from "@/lib/supabase/config";
import { getMediaService, type DbLike } from "@/lib/media";

/**
 * Build the route-handler DB handle for the Media Service registry via
 * the direct Postgres connection (server-only).
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
    throw new Error("Evidence upload is not configured (DATABASE_URL missing)");
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

const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
const EVIDENCE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
];
const EVIDENCE_PURPOSES = ["election_evidence", "pu_report_evidence", "incident_evidence"];

/**
 * Per-request authenticated Supabase client: forwards the caller's
 * Authorization header so profile/RLS checks run as that user (the
 * shared browser client holds no server session).
 */
function authClientFor(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = getSupabaseAnonKey();
  if (!url || !key) {
    throw new Error("Supabase is not configured for evidence upload");
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
    // auth-js v2 getSession() is storage-only (persistSession is off on
    // this per-request client and no sign-in has occurred here), so it
    // can never see the caller's Authorization header. getUser() with no
    // arguments sends the request WITH the forwarded Authorization header
    // and lets GoTrue validate the JWT server-side — the same
    // hasCustomAuthorizationHeader mechanism getUser() documents.
    const { data: userData } = await auth.auth.getUser();
    const user = userData.user;
    if (!user) {
      return NextResponse.json(
        { error: "Sign in to upload evidence." },
        { status: 401 }
      );
    }

    // Tenant + social-only denial resolved server-side from the profile.
    const { data: profile, error: profileErr } = await auth
      .from("politicore_profiles")
      .select("tenant_id, membership_types, access_role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileErr || !profile?.tenant_id) {
      return NextResponse.json(
        { error: "Your account is not linked to an organization." },
        { status: 403 }
      );
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
        { error: "Social accounts cannot upload Election evidence." },
        { status: 403 }
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Attach the Form EC8 photo or PDF." },
        { status: 400 }
      );
    }
    if (file.size > EVIDENCE_MAX_BYTES) {
      return NextResponse.json(
        { error: "Evidence file is too large (10 MB maximum)." },
        { status: 413 }
      );
    }
    if (file.type && !EVIDENCE_CONTENT_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Evidence must be a photo (JPEG/PNG/WebP/HEIC) or PDF." },
        { status: 415 }
      );
    }

    const rawPurpose = form.get("purpose");
    const purpose =
      typeof rawPurpose === "string" && EVIDENCE_PURPOSES.includes(rawPurpose)
        ? rawPurpose
        : "election_evidence";

    const media = getMediaService(routeDbHandle());
    const asset = await media.upload({
      tenantId: p.tenant_id,
      uploadedBy: user.id,
      purpose,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type || "application/octet-stream",
      fileName: file.name || undefined,
      visibility: "private",
    });

    // 200 keeps every client on the documented { assetId } contract
    // (uploadElectionEvidence reads res.ok then json.assetId).
    return NextResponse.json({ assetId: asset.id }, { status: 200 });
  } catch (err) {
    console.error("[election evidence] upload failed:", err);
    return NextResponse.json(
      { error: "Evidence upload failed. Please try again." },
      { status: 500 }
    );
  }
}
