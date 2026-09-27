/**
 * POLITICORE — Governance & Citizen Engagement canonical service (Phase 7).
 *
 * A thin application layer over the approved Phase 6 database contract
 * (migration 0034 + 0035 hygiene). This service OWNS NO SECURITY: every
 * operation delegates authority to the SECURITY DEFINER RPCs, the FORCE
 * RLS policies and the server-resolved identity. The client never sends
 * tenant_id or actor identity as authoritative values, never widens a
 * query beyond what RLS returns, and never mutates the append-only
 * event trail (no UPDATE/DELETE path exists anywhere).
 *
 * Lifecycle (approved):
 *   submitted → acknowledged → assigned → in_progress →
 *   awaiting_information → resolved → closed   (+ rejected; resolved may
 *   reopen to in_progress/awaiting_information; non-terminal may close)
 *
 * Privacy (approved):
 *   participants see their own requests + public/own-authored events only;
 *   staff (view_cases/manage_cases) see the tenant queue + full trails;
 *   anonymous sees nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "./config";

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type GovernanceRequestStatus =
  | "submitted"
  | "acknowledged"
  | "assigned"
  | "in_progress"
  | "awaiting_information"
  | "resolved"
  | "closed"
  | "rejected";

export type GovernanceEventKind =
  | "submitted"
  | "acknowledged"
  | "assigned"
  | "status_changed"
  | "staff_response"
  | "participant_response"
  | "resolved"
  | "closed"
  | "rejected"
  | "feedback";

export interface GovernanceRequest {
  id: string;
  tenant_id: string;
  reference_code: string;
  participant_id: string;
  category_id: string | null;
  title: string;
  details: string;
  status: GovernanceRequestStatus;
  is_public: boolean;
  ward_id: string | null;
  lga_id: string | null;
  polling_unit_id: string | null;
  assigned_profile_id: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  feedback_rating: number | null;
  feedback_comment: string | null;
  created_at: string;
  updated_at: string;
  /** Embedded by the service (FK embed), not a base column. */
  category?: { id: string; name: string } | null;
  participant?: { id: string; full_name: string; display_label: string } | null;
}

export interface GovernanceRequestEvent {
  id: number;
  tenant_id: string;
  request_id: string;
  kind: GovernanceEventKind;
  actor_profile_id: string | null;
  actor_participant_id: string | null;
  body: string;
  status_to: GovernanceRequestStatus | null;
  is_public: boolean;
  created_at: string;
}

export interface GovernanceAssignment {
  id: string;
  tenant_id: string;
  request_id: string;
  assigned_to: string;
  assigned_by: string | null;
  scope_type: string | null;
  scope_id: string | null;
  note: string;
  created_at: string;
}

export interface GovernanceCategory {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GovernanceParticipant {
  id: string;
  tenant_id: string;
  profile_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  display_label: string;
}

export interface SubmitRequestInput {
  title: string;
  details: string;
  categoryId?: string | null;
  wardId?: string | null;
  lgaId?: string | null;
  pollingUnitId?: string | null;
}

export interface GovernanceAccess {
  /** governance module enabled for the caller's tenant (fail closed). */
  moduleEnabled: boolean;
  /** Navigation/surface visibility permission (0005 domain grant or admin role). */
  canViewGovernance: boolean;
  /** any case authority (view_cases | manage_cases | assign_cases) or admin. */
  isStaff: boolean;
  canViewCases: boolean;
  canManageCases: boolean;
  canAssignCases: boolean;
  /** authenticated tenant member — participant surfaces (submit/track). */
  isParticipant: boolean;
  isAdmin: boolean;
  reason:
    | null
    | "unauthenticated"
    | "not_a_member"
    | "module_disabled"
    | "no_governance_authority";
}

// ─────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────

export type GovernanceErrorKind =
  | "unauthenticated"
  | "module_disabled"
  | "denied"
  | "not_found"
  | "rpc"
  | "query";

const KIND_MESSAGES: Record<GovernanceErrorKind, string> = {
  unauthenticated: "You must be signed in to use Governance.",
  module_disabled: "The Governance module is not enabled for this organization.",
  denied: "You do not have permission to perform this Governance action.",
  not_found: "This request could not be found.",
  rpc: "The Governance operation could not be completed.",
  query: "Governance data could not be loaded.",
};

/** Typed Governance service error — callers can branch on `kind`. */
export class GovernanceError extends Error {
  readonly kind: GovernanceErrorKind;

  constructor(kind: GovernanceErrorKind, message?: string) {
    super(message ?? KIND_MESSAGES[kind]);
    this.name = "GovernanceError";
    this.kind = kind;
  }
}

function rpcError(kind: GovernanceErrorKind, op: string, error: { message: string }): never {
  throw new GovernanceError(kind, `governance: ${op} failed: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Access resolution (presentation only — the database remains authoritative)
// ─────────────────────────────────────────────────────────────────────────

async function hasPermission(
  supabase: SupabaseClient,
  permission: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("politicore_has_permission", {
    p_permission: permission,
  });
  if (error) return false; // fail closed
  return Boolean(data);
}

/**
 * Resolve the caller's Governance surface authority.
 *
 * Mirrors resolveSocialAccess/resolveCampaignAccess: identity → tenancy →
 * module gate → database-resolved permissions. Answers are for UI
 * presentation and route guards; every mutation is re-verified by the
 * authority RPCs and RLS server-side.
 */
export async function resolveGovernanceAccess(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceAccess> {
  const { resolveIdentity } = await import("./identity");
  const identity = await resolveIdentity(supabase);

  const denied = (
    reason: Exclude<GovernanceAccess["reason"], null>,
  ): GovernanceAccess => ({
    moduleEnabled: false,
    canViewGovernance: false,
    isStaff: false,
    canViewCases: false,
    canManageCases: false,
    canAssignCases: false,
    isParticipant: false,
    isAdmin: false,
    reason,
  });

  if (!identity) return denied("unauthenticated");
  if (!identity.isTenantMember) return denied("not_a_member");

  const { isModuleEnabled } = await import("./identity");
  const moduleEnabled = await isModuleEnabled("governance", supabase);
  if (!moduleEnabled) return denied("module_disabled");

  const adminRoles = ["admin", "tenant_super_admin", "platform_super_admin"];
  const isAdmin = adminRoles.includes(identity.accessRole ?? "");

  if (isAdmin) {
    return {
      moduleEnabled: true,
      canViewGovernance: true,
      isStaff: true,
      canViewCases: true,
      canManageCases: true,
      canAssignCases: true,
      isParticipant: true,
      isAdmin: true,
      reason: null,
    };
  }

  // Database-resolved domain permissions (0005/0007 contract). Members of
  // the tenant are participants by default; staff authority comes only
  // from grants/assignments resolved server-side.
  const [canViewGovernance, canViewCases, canManageCases, canAssignCases] =
    await Promise.all([
      hasPermission(supabase, "view_governance"),
      hasPermission(supabase, "view_cases"),
      hasPermission(supabase, "manage_cases"),
      hasPermission(supabase, "assign_cases"),
    ]);

  return {
    moduleEnabled: true,
    canViewGovernance,
    isStaff: canViewCases || canManageCases || canAssignCases,
    canViewCases,
    canManageCases,
    canAssignCases,
    isParticipant: true,
    isAdmin: false,
    reason: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Participant surfaces
// ─────────────────────────────────────────────────────────────────────────

const REQUEST_SELECT = `
  id, tenant_id, reference_code, participant_id, category_id, title, details,
  status, is_public, ward_id, lga_id, polling_unit_id, assigned_profile_id,
  resolved_at, closed_at, feedback_rating, feedback_comment, created_at, updated_at,
  category:governance_request_categories(id, name),
  participant:governance_participants(id, full_name, display_label)
`;

/** The caller's own participant row (null when they have none yet). */
export async function getMyParticipant(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceParticipant | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    throw new GovernanceError("unauthenticated");
  }
  const { data, error } = await supabase
    .from("governance_participants")
    .select("*")
    .eq("profile_id", userData.user.id)
    .maybeSingle();
  if (error) rpcError("query", "getMyParticipant", error);
  return (data ?? null) as GovernanceParticipant | null;
}

/**
 * The caller's own requests, newest first. Ownership is scoped explicitly
 * through the caller's participant row (not merely left to RLS) so a
 * staff member's queue authority cannot leak into "my requests".
 */
export async function listMyRequests(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceRequest[]> {
  const me = await getMyParticipant(supabase);
  if (!me) return [];
  const { data, error } = await supabase
    .from("governance_requests")
    .select(REQUEST_SELECT)
    .eq("participant_id", me.id)
    .order("created_at", { ascending: false });
  if (error) rpcError("query", "listMyRequests", error);
  return (data ?? []) as unknown as GovernanceRequest[];
}

/** One of the caller's own requests (RLS-visible rows only). */
export async function getMyRequest(
  requestId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceRequest | null> {
  const { data, error } = await supabase
    .from("governance_requests")
    .select(REQUEST_SELECT)
    .eq("id", requestId)
    .maybeSingle();
  if (error) rpcError("query", "getMyRequest", error);
  return (data ?? null) as unknown as GovernanceRequest | null;
}

/**
 * Events of a request visible to the current session. RLS is the
 * authority: participants automatically receive public + own-authored
 * events only; staff receive the full trail. The service never widens
 * this and the UI must render exactly what this returns.
 */
export async function getRequestEvents(
  requestId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceRequestEvent[]> {
  const { data, error } = await supabase
    .from("governance_request_events")
    .select("*")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });
  if (error) rpcError("query", "getRequestEvents", error);
  return (data ?? []) as GovernanceRequestEvent[];
}

/**
 * Submit a request as the authenticated participant via the 0034
 * authority RPC. Tenant, participant and reference code are resolved
 * server-side. Returns the new request id.
 */
export async function submitRequest(
  input: SubmitRequestInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_governance_request", {
    p_title: input.title,
    p_details: input.details,
    p_category_id: input.categoryId ?? null,
    p_ward_id: input.wardId ?? null,
    p_lga_id: input.lgaId ?? null,
    p_polling_unit_id: input.pollingUnitId ?? null,
  });
  if (error) {
    if (/module is not enabled/i.test(error.message)) {
      throw new GovernanceError("module_disabled", error.message);
    }
    rpcError("denied", "submitRequest", error);
  }
  return String(data);
}

/** Participant response on their own request (0034 visibility contract). */
export async function addParticipantResponse(
  requestId: string,
  body: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("respond_governance_request", {
    p_request_id: requestId,
    p_body: body,
    p_is_public: null,
  });
  if (error) rpcError("denied", "addParticipantResponse", error);
}

/**
 * One-shot feedback on a resolved request (owner only, per the 0034
 * contract; repeats are rejected server-side).
 */
export async function submitFeedback(
  requestId: string,
  rating: number,
  comment: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("rate_governance_request", {
    p_request_id: requestId,
    p_rating: rating,
    p_comment: comment,
  });
  if (error) {
    if (/only the owning participant/i.test(error.message)) {
      throw new GovernanceError("denied", error.message);
    }
    rpcError("denied", "submitFeedback", error);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Staff surfaces
// ─────────────────────────────────────────────────────────────────────────

export interface CaseListFilters {
  status?: GovernanceRequestStatus | null;
  categoryId?: string | null;
  assignedToMe?: boolean;
  search?: string | null;
  wardId?: string | null;
  lgaId?: string | null;
}

/**
 * The staff case queue. All filtering happens in the database (PostgREST
 * predicates under RLS) — never in React. Visibility is exactly what the
 * server returns for the caller's grants/scope.
 */
export async function listCases(
  filters: CaseListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceRequest[]> {
  let q = supabase.from("governance_requests").select(REQUEST_SELECT);

  if (filters.status) q = q.eq("status", filters.status);
  if (filters.categoryId) q = q.eq("category_id", filters.categoryId);
  if (filters.wardId) q = q.eq("ward_id", filters.wardId);
  if (filters.lgaId) q = q.eq("lga_id", filters.lgaId);
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);
  if (filters.assignedToMe) {
    const { data: userData } = await supabase.auth.getUser();
    if (userData?.user) q = q.eq("assigned_profile_id", userData.user.id);
  }

  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) rpcError("query", "listCases", error);
  return (data ?? []) as unknown as GovernanceRequest[];
}

/** One case with its event trail and assignments (staff authority via RLS). */
export async function getCase(
  requestId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<{ request: GovernanceRequest | null; events: GovernanceRequestEvent[]; assignments: GovernanceAssignment[] }> {
  const request = await getMyRequest(requestId, supabase);
  if (!request) return { request: null, events: [], assignments: [] };
  const [events, assignments] = await Promise.all([
    getRequestEvents(requestId, supabase),
    (async () => {
      const { data, error } = await supabase
        .from("governance_assignments")
        .select("*")
        .eq("request_id", requestId)
        .order("created_at", { ascending: false });
      if (error) rpcError("query", "getCase.assignments", error);
      return (data ?? []) as GovernanceAssignment[];
    })(),
  ]);
  return { request, events, assignments };
}

/** submitted → acknowledged (0034 authority RPC). */
export async function acknowledgeCase(
  requestId: string,
  note = "",
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("acknowledge_governance_request", {
    p_request_id: requestId,
    p_note: note,
  });
  if (error) rpcError("denied", "acknowledgeCase", error);
}

/** Assignment to a same-tenant staff member (0034 authority RPC). */
export async function assignCase(
  requestId: string,
  assigneeProfileId: string,
  opts: { scopeType?: string | null; scopeId?: string | null; note?: string } = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("assign_governance_request", {
    p_request_id: requestId,
    p_assignee_profile_id: assigneeProfileId,
    p_scope_type: opts.scopeType ?? null,
    p_scope_id: opts.scopeId ?? null,
    p_note: opts.note ?? "",
  });
  if (error) rpcError("denied", "assignCase", error);
}

/**
 * Lifecycle transition through the 0034 RPC. The status-ladder guard is
 * the authority — the UI never reimplements or bypasses it.
 */
export async function changeCaseStatus(
  requestId: string,
  status: GovernanceRequestStatus,
  note = "",
  isPublic = false,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_request_status", {
    p_request_id: requestId,
    p_status: status,
    p_note: note,
    p_is_public: isPublic,
  });
  if (error) {
    if (/illegal status transition/i.test(error.message)) {
      throw new GovernanceError("denied", error.message);
    }
    rpcError("denied", "changeCaseStatus", error);
  }
}

/**
 * Staff response. `isPublic` maps directly onto the 0034 visibility
 * contract: internal responses stay staff-only; public responses are
 * participant-visible.
 */
export async function addStaffResponse(
  requestId: string,
  body: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("respond_governance_request", {
    p_request_id: requestId,
    p_body: body,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "addStaffResponse", error);
}

// ─────────────────────────────────────────────────────────────────────────
// Categories (admin)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Request categories visible to the caller. RLS is the authority:
 * members receive active rows; staff/admins receive all rows.
 */
export async function listCategories(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceCategory[]> {
  const { data, error } = await supabase
    .from("governance_request_categories")
    .select("*")
    .order("name", { ascending: true });
  if (error) rpcError("query", "listCategories", error);
  return (data ?? []) as GovernanceCategory[];
}

/** Create a category (admin authority via RLS; tenant resolved server-side). */
export async function createCategory(
  name: string,
  description = "",
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.from("governance_request_categories").insert({
    name,
    description,
  });
  if (error) rpcError("denied", "createCategory", error);
}

/** Update a category's label/description (admin authority via RLS). */
export async function updateCategory(
  categoryId: string,
  patch: { name?: string; description?: string },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase
    .from("governance_request_categories")
    .update(patch)
    .eq("id", categoryId);
  if (error) rpcError("denied", "updateCategory", error);
}

/** Activate/deactivate a category (admin authority via RLS). */
export async function setCategoryActive(
  categoryId: string,
  isActive: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase
    .from("governance_request_categories")
    .update({ is_active: isActive })
    .eq("id", categoryId);
  if (error) rpcError("denied", "setCategoryActive", error);
}

// ─────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ─────────────────────────────────────────────────────────────────────────

export const GOVERNANCE_STATUS_LABELS: Record<GovernanceRequestStatus, string> = {
  submitted: "Submitted",
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  in_progress: "In Progress",
  awaiting_information: "Awaiting Information",
  resolved: "Resolved",
  closed: "Closed",
  rejected: "Rejected",
};

export const GOVERNANCE_EVENT_LABELS: Record<GovernanceEventKind, string> = {
  submitted: "Request submitted",
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  status_changed: "Status updated",
  staff_response: "Staff response",
  participant_response: "Participant response",
  resolved: "Resolved",
  closed: "Closed",
  rejected: "Rejected",
  feedback: "Feedback",
};
