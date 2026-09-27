/**
 * POLITICORE — Governance PUBLIC INTAKE service (Phase 10, first slice).
 *
 * The application layer over the Phase 9-gated public boundary
 * (migration 0037). Three narrow RPCs — submit, verify, track — are the
 * ONLY public surface; the browser never touches a governance table
 * (they hold FORCE RLS with zero anon grants) and never supplies any
 * authority value:
 *
 *   public.governance_public_intake(...)  → void   (stages + emails a code)
 *   public.governance_verify(...)         → ref + one-time tracking secret
 *   public.governance_track(...)          → minimal public projection
 *
 * Security properties (owned by the RPCs, mirrored here for clarity):
 *   * tenant resolution by public site slug — never a client tenant id
 *   * module_enabled + public_intake toggle gates server-side
 *   * tracking secret is a 256-bit CSPRNG value, shown once, stored
 *     hash-only; the reference code is an IDENTIFIER, never a credential
 *   * throttling, duplicate collapse, and audit live server-side
 *     (canonical system_audits stream)
 *
 * This service deliberately contains NO governance notifications, NO
 * staff surfaces, and NO new participant model — see governance.ts
 * (Phase 7) and migration 0036 (Phase 8).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "./config";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/** Limits enforced server-side by the intake RPC; mirrored for UX. */
export const PUBLIC_INTAKE_LIMITS = {
  subjectMin: 5,
  subjectMax: 200,
  descriptionMin: 20,
  descriptionMax: 10000,
  nameMax: 120,
  categoryMax: 120,
} as const;

export interface PublicIntakeInput {
  /** Public site slug (established tenant-resolution seam, gate §J/§21). */
  siteSlug: string;
  contactEmail: string;
  fullName: string;
  category: string;
  subject: string;
  description: string;
  wardId?: string | null;
  lgaId?: string | null;
  pollingUnitId?: string | null;
  /** Required explicit consent — the RPC rejects without it. */
  consent: boolean;
}

export interface PublicVerificationResult {
  referenceCode: string;
  /** Shown exactly once — never stored, never returned again. */
  trackingSecret: string;
}

export type PublicTrackEventKind =
  | "submitted"
  | "acknowledged"
  | "assigned"
  | "status_changed"
  | "resolved"
  | "closed";

export interface PublicTrackedRequest {
  referenceCode: string;
  status: string;
  createdAt: string;
  /** PUBLIC lifecycle facts only — never response bodies or staff data. */
  events: { kind: PublicTrackEventKind; createdAt: string }[];
}

// ─────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────

export type PublicIntakeErrorKind =
  | "unavailable"
  | "rejected"
  | "invalid"
  | "throttled"
  | "rpc";

const KIND_MESSAGES: Record<PublicIntakeErrorKind, string> = {
  unavailable: "Public intake is not available right now.",
  rejected: "The submission could not be accepted.",
  invalid: "The verification code is invalid or has expired.",
  throttled: "Too many attempts — please try again later.",
  rpc: "The request could not be completed.",
};

/** Typed public-intake service error — callers can branch on `kind`. */
export class PublicIntakeError extends Error {
  readonly kind: PublicIntakeErrorKind;

  constructor(kind: PublicIntakeErrorKind, message?: string) {
    super(message ?? KIND_MESSAGES[kind]);
    this.name = "PublicIntakeError";
    this.kind = kind;
  }
}

/**
 * Map an RPC error to a typed public error WITHOUT leaking internal
 * detail: messages that carry a user-facing clause pass the clause
 * through; everything else collapses to the generic kind message.
 */
function toPublicIntakeError(error: { message: string }): PublicIntakeError {
  const raw = error?.message ?? "";
  if (/too many submissions|too many pending|too many failed tracking/i.test(raw)) {
    return new PublicIntakeError("throttled", "governance: " + raw.replace(/^.*governance:\s*/, ""));
  }
  if (/invalid or has expired/i.test(raw)) {
    return new PublicIntakeError("invalid");
  }
  if (/public intake is not available|unknown public site/i.test(raw)) {
    return new PublicIntakeError("unavailable");
  }
  if (/submission rejected/i.test(raw)) {
    return new PublicIntakeError(
      "rejected",
      "governance: " + raw.replace(/^.*governance:\s*/, "")
    );
  }
  return new PublicIntakeError("rpc");
}

// ─────────────────────────────────────────────────────────────────────────
// Public RPC calls (the entire surface)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Names of ACTIVE request categories for the intake form (the only
 * category surface anon may see — no ids, no staff descriptions).
 */
export async function listPublicIntakeCategories(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string[]> {
  const { data, error } = await supabase.rpc("governance_public_categories", {
    p_tenant_slug: siteSlug,
  });
  if (error) throw toPublicIntakeError(error);
  return (Array.isArray(data) ? data : []).map(
    (r) => String((r as { category: string }).category)
  );
}

/**
 * Stage a public submission (Model 2). The verification code is
 * delivered by email through the Core delivery-intent seam — the RPC
 * deliberately returns nothing.
 */
export async function submitPublicIntake(
  input: PublicIntakeInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("governance_public_intake", {
    p_tenant_slug: input.siteSlug,
    p_contact_email: input.contactEmail.trim(),
    p_full_name: input.fullName.trim(),
    p_category: input.category.trim(),
    p_subject: input.subject.trim(),
    p_description: input.description.trim(),
    p_ward_id: input.wardId || null,
    p_lga_id: input.lgaId || null,
    p_polling_unit_id: input.pollingUnitId || null,
    p_consent: input.consent === true,
  });
  if (error) throw toPublicIntakeError(error);
}

/** Present the emailed verification code; activate the request. */
export async function verifyPublicIntake(
  token: string,
  siteSlug?: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicVerificationResult> {
  const { data, error } = await supabase.rpc("governance_verify", {
    p_token: token.trim(),
    p_tenant_slug: siteSlug ?? null,
  });
  if (error) throw toPublicIntakeError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.reference_code || !row?.tracking_secret) {
    throw new PublicIntakeError("rpc");
  }
  return {
    referenceCode: String(row.reference_code),
    trackingSecret: String(row.tracking_secret),
  };
}

/** Reference + secret → minimal public projection (or a typed error). */
export async function trackPublicRequest(
  referenceCode: string,
  trackingSecret: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicTrackedRequest> {
  const { data, error } = await supabase.rpc("governance_track", {
    p_reference: referenceCode.trim(),
    p_tracking_secret: trackingSecret.trim(),
  });
  if (error) throw toPublicIntakeError(error);
  const rows = (Array.isArray(data) ? data : [data]).filter(Boolean) as Array<{
    reference_code: string;
    status: string;
    created_at: string;
    event_kind: string | null;
    event_created_at: string | null;
  }>;
  if (rows.length === 0) throw new PublicIntakeError("invalid");
  const head = rows[0];
  return {
    referenceCode: head.reference_code,
    status: head.status,
    createdAt: head.created_at,
    events: rows
      .filter((r) => r.event_kind)
      .map((r) => ({ kind: r.event_kind as PublicTrackEventKind, createdAt: r.event_created_at as string })),
  };
}
