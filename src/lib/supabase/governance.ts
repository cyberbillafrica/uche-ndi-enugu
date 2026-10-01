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
  /** manage_participation held (Phase 14 instrument management) or admin. */
  canManageParticipation: boolean;
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
    canManageParticipation: false,
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
      canManageParticipation: true,
      isParticipant: true,
      isAdmin: true,
      reason: null,
    };
  }

  // Database-resolved domain permissions (0005/0007 contract). Members of
  // the tenant are participants by default; staff authority comes only
  // from grants/assignments resolved server-side.
  const [canViewGovernance, canViewCases, canManageCases, canAssignCases, canManageParticipation] =
    await Promise.all([
      hasPermission(supabase, "view_governance"),
      hasPermission(supabase, "view_cases"),
      hasPermission(supabase, "manage_cases"),
      hasPermission(supabase, "assign_cases"),
      hasPermission(supabase, "manage_participation"),
    ]);

  return {
    moduleEnabled: true,
    canViewGovernance,
    isStaff: canViewCases || canManageCases || canAssignCases,
    canViewCases,
    canManageCases,
    canAssignCases,
    canManageParticipation,
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

// ═════════════════════════════════════════════════════════════════════════
// GOVERNANCE PROJECTS (Phase 12 — Delivery cluster)
// -----------------------------------------------------------------------
// Thin adapter over the 0043 authority RPCs + FORCE RLS reads. No new
// security here: the RPCs resolve tenant/actor/permission/geographic
// authority server-side and write the canonical audit trail. Progress is
// milestone-derived in the database; the UI can never contradict it.
// ═════════════════════════════════════════════════════════════════════════

export type GovernanceProjectStatus =
  | "planned"
  | "active"
  | "suspended"
  | "completed"
  | "cancelled";

export type GovernanceUpdateKind = "progress" | "milestone" | "outcome" | "announcement";

export interface GovernanceProject {
  id: string;
  tenant_id: string;
  reference_code: string;
  title: string;
  description: string;
  category_label: string;
  owner_profile_id: string | null;
  implementing_org: string;
  status: GovernanceProjectStatus;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  planned_budget: number | null;
  currency: string;
  funding_source: string;
  progress_percent: number;
  beneficiary_summary: string;
  beneficiaries_estimated: number | null;
  is_public: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  owner?: { id: string; full_name: string } | null;
}

export interface GovernanceProjectMilestone {
  id: string;
  project_id: string;
  title: string;
  description: string;
  sort_order: number;
  due_date: string | null;
  status: "pending" | "in_progress" | "done" | "cancelled";
  completed_at: string | null;
  evidence_asset_id: string | null;
  created_at: string;
}

export interface GovernanceProjectScope {
  id: string;
  project_id: string;
  scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state";
  state_id: string | null;
  zone_id: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
}

export interface GovernanceUpdate {
  id: string;
  project_id: string | null;
  author_profile_id: string | null;
  title: string;
  body: string;
  kind: GovernanceUpdateKind;
  is_public: boolean;
  published_at: string | null;
  evidence_asset_id: string | null;
  created_at: string;
  author?: { id: string; full_name: string } | null;
}

const PROJECT_SELECT = `
  id, tenant_id, reference_code, title, description, category_label,
  owner_profile_id, implementing_org, status, planned_start, planned_end,
  actual_start, actual_end, planned_budget, currency, funding_source,
  progress_percent, beneficiary_summary, beneficiaries_estimated,
  is_public, published_at, created_at, updated_at,
  owner:politicore_profiles(id, full_name)
`;

export interface ProjectListFilters {
  status?: GovernanceProjectStatus;
  lgaId?: string;
  wardId?: string;
  search?: string;
  limit?: number;
}

/**
 * Projects visible to the caller (RLS: view_governance staff + admins;
 * scope-filtered server-side by the permission resolver).
 */
export async function listProjects(
  filters: ProjectListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceProject[]> {
  let q = supabase
    .from("governance_projects")
    .select(PROJECT_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 200);

  if (filters.status) q = q.eq("status", filters.status);
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);
  if (filters.lgaId || filters.wardId) {
    // PostgRESTgeo filter: inner-embed scopes, then constrain them (a
    // project matches when ANY of its scope rows has the requested geo).
    q = q.select("scopes:governance_project_scopes!inner(lga_id, ward_id)");
    if (filters.lgaId) q = q.eq("scopes.lga_id", filters.lgaId);
    if (filters.wardId) q = q.eq("scopes.ward_id", filters.wardId);
  }

  const { data, error } = await q;
  if (error) rpcError("query", "listProjects", error);
  return (data ?? []) as unknown as GovernanceProject[];
}

export async function getProject(
  projectId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceProject | null> {
  const { data, error } = await supabase
    .from("governance_projects")
    .select(PROJECT_SELECT)
    .eq("id", projectId)
    .maybeSingle();
  if (error) rpcError("query", "getProject", error);
  return (data as unknown as GovernanceProject) ?? null;
}

export async function listProjectMilestones(
  projectId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceProjectMilestone[]> {
  const { data, error } = await supabase
    .from("governance_project_milestones")
    .select("*")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) rpcError("query", "listProjectMilestones", error);
  return (data ?? []) as unknown as GovernanceProjectMilestone[];
}

export async function listProjectScopes(
  projectId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceProjectScope[]> {
  const { data, error } = await supabase
    .from("governance_project_scopes")
    .select("*")
    .eq("project_id", projectId);
  if (error) rpcError("query", "listProjectScopes", error);
  return (data ?? []) as unknown as GovernanceProjectScope[];
}

/** Updates for a project (public rows only unless the caller is staff — RLS decides). */
export async function listProjectUpdates(
  projectId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceUpdate[]> {
  const { data, error } = await supabase
    .from("governance_updates")
    .select(
      `id, project_id, author_profile_id, title, body, kind, is_public,
       published_at, evidence_asset_id, created_at,
       author:politicore_profiles(id, full_name)`,
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) rpcError("query", "listProjectUpdates", error);
  return (data ?? []) as unknown as GovernanceUpdate[];
}

export interface CreateProjectInput {
  title: string;
  description?: string;
  categoryLabel?: string;
  implementingOrg?: string;
  ownerProfileId?: string | null;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  plannedBudget?: number | null;
  currency?: string;
  fundingSource?: string;
  beneficiarySummary?: string;
  beneficiariesEstimated?: number | null;
  scopes?: Array<{
    scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state";
    state_id?: string | null;
    zone_id?: string | null;
    lga_id?: string | null;
    ward_id?: string | null;
    polling_unit_id?: string | null;
  }>;
}

export async function createProject(
  input: CreateProjectInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_project", {
    p_title: input.title,
    p_description: input.description ?? "",
    p_category_label: input.categoryLabel ?? "",
    p_implementing_org: input.implementingOrg ?? "",
    p_owner_profile_id: input.ownerProfileId ?? null,
    p_planned_start: input.plannedStart ?? null,
    p_planned_end: input.plannedEnd ?? null,
    p_planned_budget: input.plannedBudget ?? null,
    p_currency: input.currency ?? "NGN",
    p_funding_source: input.fundingSource ?? "",
    p_beneficiary_summary: input.beneficiarySummary ?? "",
    p_beneficiaries_estimated: input.beneficiariesEstimated ?? null,
    p_scopes: input.scopes ? JSON.stringify(input.scopes) : JSON.stringify([]),
  });
  if (error) rpcError("denied", "createProject", error);
  return data as string;
}

export async function updateProject(
  projectId: string,
  fields: Partial<CreateProjectInput> & { clearActualDates?: boolean },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_project", {
    p_project: projectId,
    p_title: fields.title ?? null,
    p_description: fields.description ?? null,
    p_category_label: fields.categoryLabel ?? null,
    p_implementing_org: fields.implementingOrg ?? null,
    p_owner_profile_id: fields.ownerProfileId ?? null,
    p_planned_start: fields.plannedStart ?? null,
    p_planned_end: fields.plannedEnd ?? null,
    p_planned_budget: fields.plannedBudget ?? null,
    p_currency: fields.currency ?? null,
    p_funding_source: fields.fundingSource ?? null,
    p_beneficiary_summary: fields.beneficiarySummary ?? null,
    p_beneficiaries_estimated: fields.beneficiariesEstimated ?? null,
    p_clear_actual_dates: fields.clearActualDates ?? false,
  });
  if (error) rpcError("denied", "updateProject", error);
}

/**
 * Lifecycle transition through the 0043 server guard — the UI never
 * implements the ladder itself.
 */
export async function setProjectStatus(
  projectId: string,
  status: GovernanceProjectStatus,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_project_status", {
    p_project: projectId,
    p_status: status,
  });
  if (error) rpcError("denied", "setProjectStatus", error);
}

export async function setProjectVisibility(
  projectId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_project_visibility", {
    p_project: projectId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setProjectVisibility", error);
}

export async function addProjectScope(
  projectId: string,
  scope: {
    scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state";
    state_id?: string | null;
    zone_id?: string | null;
    lga_id?: string | null;
    ward_id?: string | null;
    polling_unit_id?: string | null;
  },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string | null> {
  const { data, error } = await supabase.rpc("add_governance_project_scope", {
    p_project: projectId,
    p_scope_type: scope.scope_type,
    p_state_id: scope.state_id ?? null,
    p_zone_id: scope.zone_id ?? null,
    p_lga_id: scope.lga_id ?? null,
    p_ward_id: scope.ward_id ?? null,
    p_polling_unit_id: scope.polling_unit_id ?? null,
  });
  if (error) rpcError("denied", "addProjectScope", error);
  return (data as string | null) ?? null;
}

export async function removeProjectScope(
  scopeId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("remove_governance_project_scope", {
    p_scope: scopeId,
  });
  if (error) rpcError("denied", "removeProjectScope", error);
}

export async function createProjectMilestone(
  projectId: string,
  input: {
    title: string;
    description?: string;
    sortOrder?: number;
    dueDate?: string | null;
  },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_project_milestone", {
    p_project: projectId,
    p_title: input.title,
    p_description: input.description ?? "",
    p_sort_order: input.sortOrder ?? 0,
    p_due_date: input.dueDate ?? null,
  });
  if (error) rpcError("denied", "createProjectMilestone", error);
  return data as string;
}

export async function updateProjectMilestone(
  milestoneId: string,
  fields: {
    title?: string;
    description?: string;
    sortOrder?: number;
    dueDate?: string | null;
    status?: "pending" | "in_progress" | "done" | "cancelled";
    evidenceAssetId?: string | null;
  },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_project_milestone", {
    p_milestone: milestoneId,
    p_title: fields.title ?? null,
    p_description: fields.description ?? null,
    p_sort_order: fields.sortOrder ?? null,
    p_due_date: fields.dueDate ?? null,
    p_status: fields.status ?? null,
    p_evidence_asset_id: fields.evidenceAssetId ?? null,
  });
  if (error) rpcError("denied", "updateProjectMilestone", error);
}

/**
 * Manual progress override — only lawful when the project has no
 * milestones; the database refuses otherwise (derived-first rule).
 */
export async function setProjectProgress(
  projectId: string,
  progressPercent: number,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_project_progress", {
    p_project: projectId,
    p_progress: progressPercent,
  });
  if (error) rpcError("denied", "setProjectProgress", error);
}

export async function createProjectUpdate(
  projectId: string,
  input: {
    title?: string;
    body: string;
    kind?: GovernanceUpdateKind;
    isPublic?: boolean;
    evidenceAssetId?: string | null;
  },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_update", {
    p_project: projectId,
    p_title: input.title ?? "",
    p_body: input.body,
    p_kind: input.kind ?? "progress",
    p_is_public: input.isPublic ?? false,
    p_evidence_asset_id: input.evidenceAssetId ?? null,
  });
  if (error) rpcError("denied", "createProjectUpdate", error);
  return data as string;
}

export async function setProjectUpdateVisibility(
  updateId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_update_visibility", {
    p_update: updateId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setProjectUpdateVisibility", error);
}

export const GOVERNANCE_PROJECT_STATUS_LABELS: Record<GovernanceProjectStatus, string> = {
  planned: "Planned",
  active: "Active",
  suspended: "Suspended",
  completed: "Completed",
  cancelled: "Cancelled",
};

// ─────────────────────────────────────────────────────────────────────────
// COMMITMENTS (Phase 13) — second Delivery domain. Same canonical service,
// same authorization model (manage_projects + geo scope via the RPCs);
// lineage is (source_type, source_ref) only — the Manifesto module is
// never queried (Phase 11 §4).
// ---------------------------------------------------------------------

export type GovernanceCommitmentStatus =
  | "declared"
  | "in_progress"
  | "partially_delivered"
  | "delivered"
  | "dropped";

export type GovernanceCommitmentSourceType =
  | "manifesto"
  | "engagement"
  | "consultation"
  | "petition"
  | "request"
  | "independent";

export interface GovernanceCommitment {
  id: string;
  tenant_id: string;
  reference_code: string;
  title: string;
  details: string;
  category_label: string;
  source_type: GovernanceCommitmentSourceType;
  source_ref: string | null;
  owner_profile_id: string | null;
  status: GovernanceCommitmentStatus;
  target_description: string;
  planned_start: string | null;
  target_date: string | null;
  completed_at: string | null;
  progress_percent: number;
  is_public: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  owner?: { id: string; full_name: string } | null;
}

export interface GovernanceCommitmentScope {
  id: string;
  commitment_id: string;
  scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state";
  state_id: string | null;
  zone_id: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
}

export interface GovernanceCommitmentProjectLink {
  id: string;
  commitment_id: string;
  project_id: string;
  project?: {
    id: string;
    reference_code: string;
    title: string;
    status: GovernanceProjectStatus;
  } | null;
}

const COMMITMENT_SELECT = `
  id, tenant_id, reference_code, title, details, category_label,
  source_type, source_ref, owner_profile_id, status, target_description,
  planned_start, target_date, completed_at, progress_percent,
  is_public, published_at, created_at, updated_at,
  owner:politicore_profiles(id, full_name)
`;

export interface CommitmentListFilters {
  status?: GovernanceCommitmentStatus;
  sourceType?: GovernanceCommitmentSourceType;
  lgaId?: string;
  wardId?: string;
  search?: string;
  limit?: number;
}

/**
 * Commitments visible to the caller (RLS: view_governance staff + admins;
 * scope-filtered server-side by the permission resolver).
 */
export async function listCommitments(
  filters: CommitmentListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceCommitment[]> {
  let q = supabase
    .from("governance_commitments")
    .select(COMMITMENT_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 200);

  if (filters.status) q = q.eq("status", filters.status);
  if (filters.sourceType) q = q.eq("source_type", filters.sourceType);
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);
  if (filters.lgaId || filters.wardId) {
    // PostgREST geo filter: inner-embed scopes, then constrain them (a
    // commitment matches when ANY of its scope rows has the requested geo).
    q = q.select("scopes:governance_commitment_scopes!inner(lga_id, ward_id)");
    if (filters.lgaId) q = q.eq("scopes.lga_id", filters.lgaId);
    if (filters.wardId) q = q.eq("scopes.ward_id", filters.wardId);
  }

  const { data, error } = await q;
  if (error) rpcError("query", "listCommitments", error);
  return (data ?? []) as unknown as GovernanceCommitment[];
}

export async function getCommitment(
  commitmentId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceCommitment | null> {
  const { data, error } = await supabase
    .from("governance_commitments")
    .select(COMMITMENT_SELECT)
    .eq("id", commitmentId)
    .maybeSingle();
  if (error) rpcError("query", "getCommitment", error);
  return (data as unknown as GovernanceCommitment) ?? null;
}

export async function listCommitmentScopes(
  commitmentId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceCommitmentScope[]> {
  const { data, error } = await supabase
    .from("governance_commitment_scopes")
    .select("*")
    .eq("commitment_id", commitmentId)
    .order("created_at", { ascending: true });
  if (error) rpcError("query", "listCommitmentScopes", error);
  return (data ?? []) as unknown as GovernanceCommitmentScope[];
}

/** Linked projects (optional join — never authority). */
export async function listCommitmentProjects(
  commitmentId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceCommitmentProjectLink[]> {
  const { data, error } = await supabase
    .from("governance_commitment_projects")
    .select(
      "id, commitment_id, project_id, " +
        "project:governance_projects(id, reference_code, title, status)",
    )
    .eq("commitment_id", commitmentId)
    .order("created_at", { ascending: true });
  if (error) rpcError("query", "listCommitmentProjects", error);
  return (data ?? []) as unknown as GovernanceCommitmentProjectLink[];
}

/** Canonical governance_updates with the commitment subject. */
export async function listCommitmentUpdates(
  commitmentId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceUpdate[]> {
  const { data, error } = await supabase
    .from("governance_updates")
    .select(
      "id, commitment_id, project_id, author_profile_id, title, body, kind, " +
        "is_public, published_at, evidence_asset_id, created_at, " +
        "author:politicore_profiles(id, full_name)",
    )
    .eq("commitment_id", commitmentId)
    .order("created_at", { ascending: false });
  if (error) rpcError("query", "listCommitmentUpdates", error);
  return (data ?? []) as unknown as GovernanceUpdate[];
}

/**
 * Canonical governance_updates rows for an engagement — the engagement
 * subject added in Phase 17. RLS admits staff-wide rows within the tenant
 * (plus public rows of public engagements for ordinary members).
 */
export async function listEngagementUpdates(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagementUpdate[]> {
  const { data, error } = await supabase
    .from("governance_updates")
    .select(
      "id, engagement_id, project_id, commitment_id, consultation_id, petition_id, " +
        "author_profile_id, title, body, kind, is_public, published_at, " +
        "evidence_asset_id, created_at, author:politicore_profiles(id, full_name)",
    )
    .eq("engagement_id", engagementId)
    .order("created_at", { ascending: false });
  if (error) rpcError("query", "listEngagementUpdates", error);
  return (data ?? []) as unknown as GovernanceEngagementUpdate[];
}

export interface CreateCommitmentInput {
  title: string;
  details?: string;
  categoryLabel?: string;
  sourceType?: GovernanceCommitmentSourceType;
  sourceRef?: string;
  ownerProfileId?: string;
  targetDescription?: string;
  plannedStart?: string;
  targetDate?: string;
  scopes?: Array<{
    scope_type: string;
    state_id?: string | null;
    zone_id?: string | null;
    lga_id?: string | null;
    ward_id?: string | null;
    polling_unit_id?: string | null;
  }>;
}

export async function createCommitment(
  input: CreateCommitmentInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_commitment", {
    p_title: input.title,
    p_details: input.details ?? "",
    p_category_label: input.categoryLabel ?? "",
    p_source_type: input.sourceType ?? "independent",
    p_source_ref: input.sourceRef ?? null,
    p_owner_profile_id: input.ownerProfileId ?? null,
    p_target_description: input.targetDescription ?? "",
    p_planned_start: input.plannedStart ?? null,
    p_target_date: input.targetDate ?? null,
    p_scopes: input.scopes ? JSON.stringify(input.scopes) : JSON.stringify([]),
  });
  if (error) rpcError("denied", "createCommitment", error);
  return data as string;
}

export interface UpdateCommitmentInput {
  title?: string;
  details?: string;
  categoryLabel?: string;
  sourceRef?: string;
  ownerProfileId?: string;
  targetDescription?: string;
  plannedStart?: string;
  targetDate?: string;
}

export async function updateCommitment(
  commitmentId: string,
  input: UpdateCommitmentInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_commitment", {
    p_commitment: commitmentId,
    p_title: input.title ?? null,
    p_details: input.details ?? null,
    p_category_label: input.categoryLabel ?? null,
    p_source_ref: input.sourceRef ?? null,
    p_owner_profile_id: input.ownerProfileId ?? null,
    p_target_description: input.targetDescription ?? null,
    p_planned_start: input.plannedStart ?? null,
    p_target_date: input.targetDate ?? null,
  });
  if (error) rpcError("denied", "updateCommitment", error);
}

export async function setCommitmentStatus(
  commitmentId: string,
  status: GovernanceCommitmentStatus,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_commitment_status", {
    p_commitment: commitmentId,
    p_status: status,
  });
  if (error) rpcError("denied", "setCommitmentStatus", error);
}

/** The single, explicitly reported progress authority. */
export async function setCommitmentProgress(
  commitmentId: string,
  progress: number,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_commitment_progress", {
    p_commitment: commitmentId,
    p_progress: progress,
  });
  if (error) rpcError("denied", "setCommitmentProgress", error);
}

export async function setCommitmentVisibility(
  commitmentId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_commitment_visibility", {
    p_commitment: commitmentId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setCommitmentVisibility", error);
}

export interface ScopeSpec {
  scope_type: string;
  state_id?: string | null;
  zone_id?: string | null;
  lga_id?: string | null;
  ward_id?: string | null;
  polling_unit_id?: string | null;
}

export async function addCommitmentScope(
  commitmentId: string,
  scope: ScopeSpec,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string | null> {
  const { data, error } = await supabase.rpc("add_governance_commitment_scope", {
    p_commitment: commitmentId,
    p_scope_type: scope.scope_type,
    p_state_id: scope.state_id ?? null,
    p_zone_id: scope.zone_id ?? null,
    p_lga_id: scope.lga_id ?? null,
    p_ward_id: scope.ward_id ?? null,
    p_polling_unit_id: scope.polling_unit_id ?? null,
  });
  if (error) rpcError("denied", "addCommitmentScope", error);
  return (data as string | null) ?? null;
}

export async function removeCommitmentScope(
  scopeId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("remove_governance_commitment_scope", {
    p_scope: scopeId,
  });
  if (error) rpcError("denied", "removeCommitmentScope", error);
}

/** Optional link — data relationship only; never grants authority. */
export async function linkProjectToCommitment(
  commitmentId: string,
  projectId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string | null> {
  const { data, error } = await supabase.rpc("link_governance_project", {
    p_commitment: commitmentId,
    p_project: projectId,
  });
  if (error) rpcError("denied", "linkProjectToCommitment", error);
  return (data as string | null) ?? null;
}

export async function unlinkProjectFromCommitment(
  commitmentId: string,
  projectId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("unlink_governance_project", {
    p_commitment: commitmentId,
    p_project: projectId,
  });
  if (error) rpcError("denied", "unlinkProjectFromCommitment", error);
}

export async function createCommitmentUpdate(
  commitmentId: string,
  input: { title?: string; body: string; kind?: GovernanceUpdateKind; isPublic?: boolean; evidenceAssetId?: string },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_commitment_update", {
    p_commitment: commitmentId,
    p_title: input.title ?? "",
    p_body: input.body,
    p_kind: input.kind ?? "progress",
    p_is_public: input.isPublic ?? false,
    p_evidence_asset_id: input.evidenceAssetId ?? null,
  });
  if (error) rpcError("denied", "createCommitmentUpdate", error);
  return data as string;
}

export const GOVERNANCE_COMMITMENT_STATUS_LABELS: Record<GovernanceCommitmentStatus, string> = {
  declared: "Declared",
  in_progress: "In Progress",
  partially_delivered: "Partially Delivered",
  delivered: "Delivered",
  dropped: "Dropped",
};

export const GOVERNANCE_COMMITMENT_SOURCE_LABELS: Record<GovernanceCommitmentSourceType, string> = {
  manifesto: "Manifesto",
  engagement: "Engagement",
  consultation: "Consultation",
  petition: "Petition",
  request: "Request",
  independent: "Independent",
};

// ─────────────────────────────────────────────────────────────────────────
// PARTICIPATION (Phase 14) — Consultations & Surveys. Third Governance
// domain in the same canonical service. One instrument table, kind
// discriminator (consultation | survey); management runs through the
// manage_participation RPCs; participation runs through the participant-
// identity RPC (no permission — 0034 principle). The database remains the
// only authority: tenant, eligibility, openness, duplicates and answer
// validity are all resolved/validated server-side.
// ---------------------------------------------------------------------

export type GovernanceConsultationKind = "consultation" | "survey";
export type GovernanceConsultationStatus = "draft" | "open" | "closed" | "results_published";

export interface GovernanceConsultationQuestion {
  id: string;
  kind: "single_choice" | "multi_choice" | "likert" | "short_text";
  prompt: string;
  options?: string[];
  scale?: number;
  required?: boolean;
}

export interface GovernanceConsultation {
  id: string;
  tenant_id: string;
  kind: GovernanceConsultationKind;
  reference_code: string;
  title: string;
  description: string;
  instructions: string;
  questions: GovernanceConsultationQuestion[];
  status: GovernanceConsultationStatus;
  closes_at: string | null;
  results: Record<string, unknown> | null;
  results_summary: string;
  is_public: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
}

export interface GovernanceConsultationScope {
  id: string;
  consultation_id: string;
  scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state";
  state_id: string | null;
  zone_id: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
}

export interface GovernanceConsultationResponse {
  id: string;
  consultation_id: string;
  participant_id: string;
  answers: Record<string, unknown>;
  free_text: string | null;
  submitted_at: string;
}

const CONSULTATION_SELECT = `
  id, tenant_id, kind, reference_code, title, description, instructions,
  questions, status, closes_at, results, results_summary, is_public,
  published_at, created_by, created_at, updated_at
`;

export interface ConsultationListFilters {
  kind?: GovernanceConsultationKind;
  status?: GovernanceConsultationStatus;
  onlyOpen?: boolean;
  search?: string;
  limit?: number;
}

/** Staff list (view_governance) or participant discovery (open only —
 * the FORCE RLS read policy decides which rows the caller can see). */
export async function listConsultations(
  filters: ConsultationListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceConsultation[]> {
  let q = supabase
    .from("governance_consultations")
    .select(CONSULTATION_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 200);

  if (filters.kind) q = q.eq("kind", filters.kind);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.onlyOpen) q = q.eq("status", "open");
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);

  const { data, error } = await q;
  if (error) rpcError("query", "listConsultations", error);
  return (data ?? []) as unknown as GovernanceConsultation[];
}

export async function getConsultation(
  consultationId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceConsultation | null> {
  const { data, error } = await supabase
    .from("governance_consultations")
    .select(CONSULTATION_SELECT)
    .eq("id", consultationId)
    .maybeSingle();
  if (error) rpcError("query", "getConsultation", error);
  return (data as unknown as GovernanceConsultation) ?? null;
}

export async function listConsultationScopes(
  consultationId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceConsultationScope[]> {
  const { data, error } = await supabase
    .from("governance_consultation_scopes")
    .select("*")
    .eq("consultation_id", consultationId)
    .order("created_at", { ascending: true });
  if (error) rpcError("query", "listConsultationScopes", error);
  return (data ?? []) as unknown as GovernanceConsultationScope[];
}

/** Staff response reads (RLS also admits the participant's own row). */
export async function listConsultationResponses(
  consultationId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceConsultationResponse[]> {
  const { data, error } = await supabase
    .from("governance_consultation_responses")
    .select("id, consultation_id, participant_id, answers, free_text, submitted_at")
    .eq("consultation_id", consultationId)
    .order("submitted_at", { ascending: false });
  if (error) rpcError("query", "listConsultationResponses", error);
  return (data ?? []) as unknown as GovernanceConsultationResponse[];
}

/** The caller's own response, if any (participant return-visit parity).
 * Pass the caller's participant row id when known — a staff caller's RLS
 * surface can admit many rows, so the participant filter keeps this
 * targeted. */
export async function getMyConsultationResponse(
  consultationId: string,
  participantId?: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceConsultationResponse | null> {
  let q = supabase
    .from("governance_consultation_responses")
    .select("id, consultation_id, participant_id, answers, free_text, submitted_at")
    .eq("consultation_id", consultationId);
  if (participantId) q = q.eq("participant_id", participantId);
  const { data, error } = await q.maybeSingle();
  if (error) rpcError("query", "getMyConsultationResponse", error);
  return (data as unknown as GovernanceConsultationResponse) ?? null;
}

export interface CreateConsultationInput {
  kind: GovernanceConsultationKind;
  title: string;
  description?: string;
  instructions?: string;
  questions?: GovernanceConsultationQuestion[];
  closesAt?: string | null;
  scopes?: ScopeSpec[];
}

export async function createConsultation(
  input: CreateConsultationInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_consultation", {
    p_kind: input.kind,
    p_title: input.title,
    p_description: input.description ?? "",
    p_instructions: input.instructions ?? "",
    p_questions: JSON.stringify(input.questions ?? []),
    p_closes_at: input.closesAt ?? null,
    p_scopes: input.scopes ? JSON.stringify(input.scopes) : JSON.stringify([]),
  });
  if (error) rpcError("denied", "createConsultation", error);
  return data as string;
}

export interface UpdateConsultationInput {
  title?: string;
  description?: string;
  instructions?: string;
  questions?: GovernanceConsultationQuestion[];
  closesAt?: string | null;
  clearClosesAt?: boolean;
}

export async function updateConsultation(
  consultationId: string,
  input: UpdateConsultationInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_consultation", {
    p_consultation: consultationId,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_instructions: input.instructions ?? null,
    p_questions: input.questions ? JSON.stringify(input.questions) : null,
    p_closes_at: input.closesAt ?? null,
    p_clear_closes_at: input.clearClosesAt ?? false,
  });
  if (error) rpcError("denied", "updateConsultation", error);
}

export async function setConsultationStatus(
  consultationId: string,
  status: "open" | "closed",
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_consultation_status", {
    p_consultation: consultationId,
    p_status: status,
  });
  if (error) rpcError("denied", "setConsultationStatus", error);
}

/** The audited publish_accountability act (aggregates only). */
export async function publishConsultationResults(
  consultationId: string,
  input: { summary?: string; results?: Record<string, unknown> },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("publish_consultation_results", {
    p_consultation: consultationId,
    p_summary: input.summary ?? "",
    p_results: JSON.stringify(input.results ?? {}),
  });
  if (error) rpcError("denied", "publishConsultationResults", error);
}

export async function setConsultationVisibility(
  consultationId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_consultation_visibility", {
    p_consultation: consultationId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setConsultationVisibility", error);
}

export async function addConsultationScope(
  consultationId: string,
  scope: ScopeSpec,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string | null> {
  const { data, error } = await supabase.rpc("add_governance_consultation_scope", {
    p_consultation: consultationId,
    p_scope_type: scope.scope_type,
    p_state_id: scope.state_id ?? null,
    p_zone_id: scope.zone_id ?? null,
    p_lga_id: scope.lga_id ?? null,
    p_ward_id: scope.ward_id ?? null,
    p_polling_unit_id: scope.polling_unit_id ?? null,
  });
  if (error) rpcError("denied", "addConsultationScope", error);
  return (data as string | null) ?? null;
}

export async function removeConsultationScope(
  scopeId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("remove_governance_consultation_scope", {
    p_scope: scopeId,
  });
  if (error) rpcError("denied", "removeConsultationScope", error);
}

/** Participant submission — participant identity is the authorization. */
export async function submitConsultationResponse(
  consultationId: string,
  input: { answers?: Record<string, unknown>; freeText?: string },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_governance_consultation_response", {
    p_consultation: consultationId,
    p_answers: JSON.stringify(input.answers ?? {}),
    p_free_text: input.freeText ?? null,
  });
  if (error) rpcError("denied", "submitConsultationResponse", error);
  return data as string;
}

export const GOVERNANCE_CONSULTATION_STATUS_LABELS: Record<GovernanceConsultationStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
  results_published: "Results Published",
};

export const GOVERNANCE_CONSULTATION_KIND_LABELS: Record<GovernanceConsultationKind, string> = {
  consultation: "Consultation",
  survey: "Survey",
};

// ─────────────────────────────────────────────────────────────────────────
// PARTICIPATION — PETITIONS / COMMUNITY PROPOSALS (Phase 15)
// Fourth Governance participation slice: ONE canonical table with an
// origin discriminator (petition | community_proposal). Staff-created
// instruments enter 'draft'; participant-originated community proposals
// enter 'pending' moderation. Lifecycle draft|pending → open → closed →
// verified → results_published; verification-before-results is enforced
// server-side (publish_petition_results refuses unverified petitions).
// All authority is server-resolved — the client never sends tenant,
// participant, or actor identity.
// ─────────────────────────────────────────────────────────────────────────

export type GovernancePetitionOrigin = "petition" | "community_proposal";
export type GovernancePetitionStatus =
  | "draft"
  | "pending"
  | "open"
  | "closed"
  | "verified"
  | "results_published";

export interface GovernancePetition {
  id: string;
  tenant_id: string;
  origin: GovernancePetitionOrigin;
  reference_code: string;
  title: string;
  demand: string;
  proposer_participant_id: string | null;
  created_by: string | null;
  target_signatures: number | null;
  status: GovernancePetitionStatus;
  closes_at: string | null;
  verified_count: number | null;
  verified_at: string | null;
  results: Record<string, unknown> | null;
  results_summary: string;
  is_public: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GovernancePetitionSupport {
  id: string;
  tenant_id: string;
  petition_id: string;
  participant_id: string;
  comment: string;
  verified_at: string | null;
  created_at: string;
}

export interface GovernancePetitionScope {
  id: string;
  tenant_id: string;
  petition_id: string;
  scope_type: string;
  state_id: string | null;
  zone_id: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
  created_at: string;
  created_by: string | null;
}

export interface PetitionListFilters {
  origin?: GovernancePetitionOrigin;
  status?: GovernancePetitionStatus;
  onlyOpen?: boolean;
  search?: string;
  limit?: number;
}

export async function listPetitions(
  filters: PetitionListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePetition[]> {
  let q = supabase
    .from("governance_petitions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 200);
  if (filters.origin) q = q.eq("origin", filters.origin);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.onlyOpen) q = q.eq("status", "open");
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);
  const { data, error } = await q;
  if (error) rpcError("denied", "listPetitions", error);
  return (data ?? []) as GovernancePetition[];
}

export async function getPetition(
  petitionId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePetition | null> {
  const { data, error } = await supabase
    .from("governance_petitions")
    .select("*")
    .eq("id", petitionId)
    .maybeSingle();
  if (error) rpcError("denied", "getPetition", error);
  return (data as GovernancePetition) ?? null;
}

export async function listPetitionSupports(
  petitionId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePetitionSupport[]> {
  const { data, error } = await supabase
    .from("governance_petition_supports")
    .select("*")
    .eq("petition_id", petitionId)
    .order("created_at", { ascending: false });
  if (error) rpcError("denied", "listPetitionSupports", error);
  return (data ?? []) as GovernancePetitionSupport[];
}

export async function getMyPetitionSignature(
  petitionId: string,
  participantId?: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePetitionSupport | null> {
  // RLS admits only the caller's own row for participants; the explicit
  // participant filter keeps the answer well-defined for staff callers too.
  let q = supabase
    .from("governance_petition_supports")
    .select("*")
    .eq("petition_id", petitionId);
  if (participantId) q = q.eq("participant_id", participantId);
  const { data, error } = await q.maybeSingle();
  if (error) rpcError("denied", "getMyPetitionSignature", error);
  return (data as GovernancePetitionSupport) ?? null;
}

export async function listPetitionScopes(
  petitionId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePetitionScope[]> {
  const { data, error } = await supabase
    .from("governance_petition_scopes")
    .select("*")
    .eq("petition_id", petitionId)
    .order("created_at", { ascending: true });
  if (error) rpcError("denied", "listPetitionScopes", error);
  return (data ?? []) as GovernancePetitionScope[];
}

export interface CreatePetitionInput {
  origin: GovernancePetitionOrigin;
  title: string;
  demand?: string;
  targetSignatures?: number;
  closesAt?: string;
  scopes?: ScopeSpec[];
}

export async function createPetition(
  input: CreatePetitionInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_petition", {
    p_origin: input.origin,
    p_title: input.title,
    p_demand: input.demand ?? "",
    p_target_signatures: input.targetSignatures ?? null,
    p_closes_at: input.closesAt ?? null,
    p_scopes: JSON.stringify(input.scopes ?? []),
  });
  if (error) rpcError("denied", "createPetition", error);
  return data as string;
}

export interface UpdatePetitionInput {
  title?: string;
  demand?: string;
  targetSignatures?: number;
  closesAt?: string;
  clearClosesAt?: boolean;
}

export async function updatePetition(
  petitionId: string,
  input: UpdatePetitionInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_petition", {
    p_petition: petitionId,
    p_title: input.title ?? null,
    p_demand: input.demand ?? null,
    p_target_signatures: input.targetSignatures ?? null,
    p_closes_at: input.closesAt ?? null,
    p_clear_closes_at: input.clearClosesAt ?? false,
  });
  if (error) rpcError("denied", "updatePetition", error);
}

export async function setPetitionStatus(
  petitionId: string,
  status: "open" | "closed",
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_petition_status", {
    p_petition: petitionId,
    p_status: status,
  });
  if (error) rpcError("denied", "setPetitionStatus", error);
}

export async function verifyPetition(
  petitionId: string,
  note = "",
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<number> {
  const { data, error } = await supabase.rpc("verify_governance_petition", {
    p_petition: petitionId,
    p_note: note,
  });
  if (error) rpcError("denied", "verifyPetition", error);
  return data as number;
}

export async function publishPetitionResults(
  petitionId: string,
  input: { summary?: string; results?: Record<string, unknown> } = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("publish_petition_results", {
    p_petition: petitionId,
    p_summary: input.summary ?? "",
    p_results: JSON.stringify(input.results ?? {}),
  });
  if (error) rpcError("denied", "publishPetitionResults", error);
}

export async function setPetitionVisibility(
  petitionId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_petition_visibility", {
    p_petition: petitionId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setPetitionVisibility", error);
}

export async function addPetitionScope(
  petitionId: string,
  scope: ScopeSpec,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string | null> {
  const { data, error } = await supabase.rpc("add_governance_petition_scope", {
    p_petition: petitionId,
    p_scope_type: scope.scope_type,
    p_state_id: scope.state_id ?? null,
    p_zone_id: scope.zone_id ?? null,
    p_lga_id: scope.lga_id ?? null,
    p_ward_id: scope.ward_id ?? null,
    p_polling_unit_id: scope.polling_unit_id ?? null,
  });
  if (error) rpcError("denied", "addPetitionScope", error);
  return (data as string) ?? null;
}

export async function removePetitionScope(
  scopeId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("remove_governance_petition_scope", {
    p_scope: scopeId,
  });
  if (error) rpcError("denied", "removePetitionScope", error);
}

export async function signPetition(
  petitionId: string,
  comment?: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("sign_governance_petition", {
    p_petition: petitionId,
    p_comment: comment ?? null,
  });
  if (error) rpcError("denied", "signPetition", error);
  return data as string;
}

export const GOVERNANCE_PETITION_STATUS_LABELS: Record<GovernancePetitionStatus, string> = {
  draft: "Draft",
  pending: "Pending Review",
  open: "Open",
  closed: "Closed",
  verified: "Verified",
  results_published: "Results Published",
};

export const GOVERNANCE_PETITION_ORIGIN_LABELS: Record<GovernancePetitionOrigin, string> = {
  petition: "Petition",
  community_proposal: "Community Proposal",
};

// ─────────────────────────────────────────────────────────────────────────
// PARTICIPATION — POLLS (Phase 16)
//
// Thin application layer over migration 0055. The service OWNS NO
// SECURITY: tenant, actor, participant, permission, geography, lifecycle
// and option membership are all resolved/validated by the authority RPCs
// and FORCE RLS. One vote per participant (UNIQUE), votes are
// append-only, content freezes outside draft, and anonymous participation
// does not exist (Phase 11 §29 open decision 1 — unresolved).
// ─────────────────────────────────────────────────────────────────────────

export type GovernancePollStatus = "draft" | "open" | "closed";

export const GOVERNANCE_POLL_STATUS_LABELS: Record<GovernancePollStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
};

export interface GovernancePoll {
  id: string;
  tenant_id: string;
  reference_code: string;
  title: string;
  question: string;
  description: string;
  options: string[];
  status: GovernancePollStatus;
  closes_at: string | null;
  results: Record<string, unknown> | null;
  results_summary: string;
  is_public: boolean;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GovernancePollScope {
  id: string;
  tenant_id: string;
  poll_id: string;
  scope_type: string;
  state_id: string | null;
  zone_id: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
  created_at: string;
}

export interface GovernancePollVote {
  id: string;
  tenant_id: string;
  poll_id: string;
  participant_id: string;
  choice: string;
  submitted_at: string;
}

export interface PollListFilters {
  status?: GovernancePollStatus;
  onlyOpen?: boolean;
  search?: string;
  limit?: number;
}

export async function listPolls(
  filters: PollListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePoll[]> {
  let q = supabase
    .from("governance_polls")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 200);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.onlyOpen) q = q.eq("status", "open");
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);
  const { data, error } = await q;
  if (error) rpcError("denied", "listPolls", error);
  return (data ?? []) as GovernancePoll[];
}

export async function getPoll(
  pollId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePoll | null> {
  const { data, error } = await supabase
    .from("governance_polls")
    .select("*")
    .eq("id", pollId)
    .maybeSingle();
  if (error) rpcError("denied", "getPoll", error);
  return (data as GovernancePoll) ?? null;
}

export async function listPollScopes(
  pollId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePollScope[]> {
  const { data, error } = await supabase
    .from("governance_poll_scopes")
    .select("*")
    .eq("poll_id", pollId)
    .order("created_at", { ascending: true });
  if (error) rpcError("denied", "listPollScopes", error);
  return (data ?? []) as GovernancePollScope[];
}

export interface CreatePollInput {
  title: string;
  question: string;
  options: string[];
  description?: string;
  closesAt?: string;
  scopes?: ScopeSpec[];
}

export async function createPoll(
  input: CreatePollInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_poll", {
    p_title: input.title,
    p_question: input.question,
    p_options: input.options,
    p_description: input.description ?? "",
    p_closes_at: input.closesAt ?? null,
    p_scopes: JSON.stringify(input.scopes ?? []),
  });
  if (error) rpcError("denied", "createPoll", error);
  return data as string;
}

export interface UpdatePollInput {
  title?: string;
  question?: string;
  description?: string;
  options?: string[];
  closesAt?: string;
  clearClosesAt?: boolean;
}

export async function updatePoll(
  pollId: string,
  input: UpdatePollInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_poll", {
    p_poll: pollId,
    p_title: input.title ?? null,
    p_question: input.question ?? null,
    p_description: input.description ?? null,
    p_options: input.options ?? null,
    p_closes_at: input.closesAt ?? null,
    p_clear_closes_at: input.clearClosesAt ?? false,
  });
  if (error) rpcError("denied", "updatePoll", error);
}

export async function setPollStatus(
  pollId: string,
  status: "open" | "closed",
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_poll_status", {
    p_poll: pollId,
    p_status: status,
  });
  if (error) rpcError("denied", "setPollStatus", error);
}

export async function publishPollResults(
  pollId: string,
  summary: string,
  results: Record<string, unknown>,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("publish_poll_results", {
    p_poll: pollId,
    p_summary: summary,
    p_results: results,
  });
  if (error) rpcError("denied", "publishPollResults", error);
}

export async function setPollVisibility(
  pollId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_poll_visibility", {
    p_poll: pollId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setPollVisibility", error);
}

export async function addPollScope(
  pollId: string,
  scope: ScopeSpec,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("add_governance_poll_scope", {
    p_poll: pollId,
    p_scope_type: scope.scope_type,
    p_state_id: scope.state_id ?? null,
    p_zone_id: scope.zone_id ?? null,
    p_lga_id: scope.lga_id ?? null,
    p_ward_id: scope.ward_id ?? null,
    p_polling_unit_id: scope.polling_unit_id ?? null,
  });
  if (error) rpcError("denied", "addPollScope", error);
  return data as string;
}

export async function removePollScope(
  scopeId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("remove_governance_poll_scope", {
    p_scope: scopeId,
  });
  if (error) rpcError("denied", "removePollScope", error);
  return data as string;
}

export async function submitPollVote(
  pollId: string,
  choice: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("vote_governance_poll", {
    p_poll: pollId,
    p_choice: choice,
  });
  if (error) rpcError("denied", "submitPollVote", error);
  return data as string;
}

export async function listPollVotes(
  pollId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePollVote[]> {
  // RLS admits staff-wide rows within the tenant plus the caller's own
  // row; the projection stays identical for both.
  const { data, error } = await supabase
    .from("governance_poll_votes")
    .select("*")
    .eq("poll_id", pollId)
    .order("submitted_at", { ascending: true });
  if (error) rpcError("denied", "listPollVotes", error);
  return (data ?? []) as GovernancePollVote[];
}

export async function getMyPollVote(
  pollId: string,
  participantId?: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernancePollVote | null> {
  // RLS admits only the caller's own row for participants; the explicit
  // participant filter keeps the answer well-defined for staff callers too.
  let q = supabase
    .from("governance_poll_votes")
    .select("*")
    .eq("poll_id", pollId);
  if (participantId) q = q.eq("participant_id", participantId);
  const { data, error } = await q.maybeSingle();
  if (error) rpcError("denied", "getMyPollVote", error);
  return (data as GovernancePollVote) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// ENGAGEMENTS — PHASE 17
//
// Thin application layer over migration 0056. The service OWNS NO
// SECURITY: tenant, actor, permission, geography, Event-link validation,
// lifecycle and content sealing are all resolved/validated by the
// authority RPCs and FORCE RLS. Engagements are the PROCESS record;
// Events (optional link) remain CONTENT and are never mutated here.
// Follow-ups ARE updates: the canonical governance_updates substrate with
// engagement as its fifth subject.
// ─────────────────────────────────────────────────────────────────────────

export type GovernanceEngagementStatus = "draft" | "scheduled" | "concluded";

export const GOVERNANCE_ENGAGEMENT_STATUS_LABELS: Record<GovernanceEngagementStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  concluded: "Concluded",
};

export interface GovernanceEngagementAgendaItem {
  id: string;
  title: string;
  detail?: string;
}

export interface GovernanceEngagement {
  id: string;
  tenant_id: string;
  reference_code: string;
  title: string;
  description: string;
  event_id: string | null;
  status: GovernanceEngagementStatus;
  scheduled_at: string | null;
  location: string;
  agenda: GovernanceEngagementAgendaItem[];
  outcomes: string;
  held_at: string | null;
  is_public: boolean;
  published_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GovernanceEngagementScope {
  id: string;
  tenant_id: string;
  engagement_id: string;
  scope_type: string;
  state_id: string | null;
  zone_id: string | null;
  lga_id: string | null;
  ward_id: string | null;
  polling_unit_id: string | null;
  created_at: string;
}

export interface GovernanceEngagementStakeholder {
  id: string;
  tenant_id: string;
  engagement_id: string;
  participant_id: string;
  role_label: string;
  note: string;
  created_at: string;
}

export interface GovernanceEngagementAttendance {
  id: string;
  tenant_id: string;
  engagement_id: string;
  participant_id: string;
  note: string;
  recorded_at: string;
  recorded_by: string | null;
}

export interface GovernanceEngagementIssue {
  id: string;
  tenant_id: string;
  engagement_id: string;
  title: string;
  detail: string;
  raised_by_participant_id: string | null;
  request_id: string | null;
  status: "open" | "addressed" | "closed";
  created_at: string;
  updated_at: string;
}

/** A canonical governance_updates row scoped to the engagement subject. */
export interface GovernanceEngagementUpdate {
  id: string;
  engagement_id: string | null;
  project_id: string | null;
  commitment_id: string | null;
  consultation_id: string | null;
  petition_id: string | null;
  author_profile_id: string | null;
  title: string;
  body: string;
  kind: string;
  is_public: boolean;
  published_at: string | null;
  evidence_asset_id: string | null;
  created_at: string;
  author?: { id: string; full_name: string } | null;
}

export interface EngagementListFilters {
  status?: GovernanceEngagementStatus;
  search?: string;
  limit?: number;
}

export async function listEngagements(
  filters: EngagementListFilters = {},
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagement[]> {
  let q = supabase
    .from("governance_engagements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 200);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.search) q = q.ilike("title", `%${filters.search}%`);
  const { data, error } = await q;
  if (error) rpcError("denied", "listEngagements", error);
  return (data ?? []) as GovernanceEngagement[];
}

export async function getEngagement(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagement | null> {
  const { data, error } = await supabase
    .from("governance_engagements")
    .select("*")
    .eq("id", engagementId)
    .maybeSingle();
  if (error) rpcError("denied", "getEngagement", error);
  return (data as GovernanceEngagement) ?? null;
}

export async function listEngagementScopes(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagementScope[]> {
  const { data, error } = await supabase
    .from("governance_engagement_scopes")
    .select("*")
    .eq("engagement_id", engagementId)
    .order("created_at", { ascending: true });
  if (error) rpcError("denied", "listEngagementScopes", error);
  return (data ?? []) as GovernanceEngagementScope[];
}

export async function listEngagementStakeholders(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagementStakeholder[]> {
  const { data, error } = await supabase
    .from("governance_engagement_stakeholders")
    .select("*")
    .eq("engagement_id", engagementId)
    .order("created_at", { ascending: true });
  if (error) rpcError("denied", "listEngagementStakeholders", error);
  return (data ?? []) as GovernanceEngagementStakeholder[];
}

export async function listEngagementAttendance(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagementAttendance[]> {
  const { data, error } = await supabase
    .from("governance_engagement_attendance")
    .select("*")
    .eq("engagement_id", engagementId)
    .order("recorded_at", { ascending: true });
  if (error) rpcError("denied", "listEngagementAttendance", error);
  return (data ?? []) as GovernanceEngagementAttendance[];
}

export async function listEngagementIssues(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagementIssue[]> {
  const { data, error } = await supabase
    .from("governance_engagement_issues")
    .select("*")
    .eq("engagement_id", engagementId)
    .order("created_at", { ascending: true });
  if (error) rpcError("denied", "listEngagementIssues", error);
  return (data ?? []) as GovernanceEngagementIssue[];
}

export interface CreateEngagementInput {
  title: string;
  description?: string;
  scheduledAt?: string;
  location?: string;
  agenda?: GovernanceEngagementAgendaItem[];
  eventId?: string;
  scopes?: ScopeSpec[];
}

export async function createEngagement(
  input: CreateEngagementInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_engagement", {
    p_title: input.title,
    p_description: input.description ?? "",
    p_scheduled_at: input.scheduledAt ?? null,
    p_location: input.location ?? "",
    p_agenda: input.agenda ?? [],
    p_event_id: input.eventId ?? null,
    p_scopes: JSON.stringify(input.scopes ?? []),
  });
  if (error) rpcError("denied", "createEngagement", error);
  return data as string;
}

export interface UpdateEngagementInput {
  title?: string;
  description?: string;
  scheduledAt?: string;
  clearScheduledAt?: boolean;
  location?: string;
  agenda?: GovernanceEngagementAgendaItem[];
}

export async function updateEngagement(
  engagementId: string,
  input: UpdateEngagementInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_engagement", {
    p_engagement: engagementId,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_scheduled_at: input.scheduledAt ?? null,
    p_clear_scheduled_at: input.clearScheduledAt ?? false,
    p_location: input.location ?? null,
    p_agenda: input.agenda ?? null,
  });
  if (error) rpcError("denied", "updateEngagement", error);
}

export async function linkEngagementEvent(
  engagementId: string,
  eventId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("link_governance_engagement_event", {
    p_engagement: engagementId,
    p_event_id: eventId,
  });
  if (error) rpcError("denied", "linkEngagementEvent", error);
}

export async function unlinkEngagementEvent(
  engagementId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("unlink_governance_engagement_event", {
    p_engagement: engagementId,
  });
  if (error) rpcError("denied", "unlinkEngagementEvent", error);
}

export async function setEngagementStatus(
  engagementId: string,
  status: "scheduled" | "concluded",
  outcomes?: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_engagement_status", {
    p_engagement: engagementId,
    p_status: status,
    p_outcomes: outcomes ?? null,
  });
  if (error) rpcError("denied", "setEngagementStatus", error);
}

export async function setEngagementVisibility(
  engagementId: string,
  isPublic: boolean,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("set_governance_engagement_visibility", {
    p_engagement: engagementId,
    p_is_public: isPublic,
  });
  if (error) rpcError("denied", "setEngagementVisibility", error);
}

export async function addEngagementScope(
  engagementId: string,
  scope: ScopeSpec,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("add_governance_engagement_scope", {
    p_engagement: engagementId,
    p_scope_type: scope.scope_type,
    p_state_id: scope.state_id ?? null,
    p_zone_id: scope.zone_id ?? null,
    p_lga_id: scope.lga_id ?? null,
    p_ward_id: scope.ward_id ?? null,
    p_polling_unit_id: scope.polling_unit_id ?? null,
  });
  if (error) rpcError("denied", "addEngagementScope", error);
  return data as string;
}

export async function removeEngagementScope(
  scopeId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("remove_governance_engagement_scope", {
    p_scope: scopeId,
  });
  if (error) rpcError("denied", "removeEngagementScope", error);
  return data as string;
}

export async function addEngagementStakeholder(
  engagementId: string,
  participantId: string,
  roleLabel: string,
  note: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("add_governance_engagement_stakeholder", {
    p_engagement: engagementId,
    p_participant_id: participantId,
    p_role_label: roleLabel,
    p_note: note,
  });
  if (error) rpcError("denied", "addEngagementStakeholder", error);
  return data as string;
}

export async function removeEngagementStakeholder(
  stakeholderId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("remove_governance_engagement_stakeholder", {
    p_stakeholder: stakeholderId,
  });
  if (error) rpcError("denied", "removeEngagementStakeholder", error);
  return data as string;
}

export async function recordEngagementAttendance(
  engagementId: string,
  participantId: string,
  note: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("record_governance_engagement_attendance", {
    p_engagement: engagementId,
    p_participant_id: participantId,
    p_note: note,
  });
  if (error) rpcError("denied", "recordEngagementAttendance", error);
  return data as string;
}

export async function removeEngagementAttendance(
  attendanceId: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("remove_governance_engagement_attendance", {
    p_attendance: attendanceId,
  });
  if (error) rpcError("denied", "removeEngagementAttendance", error);
  return data as string;
}

export interface CreateEngagementIssueInput {
  title: string;
  detail?: string;
  raisedByParticipantId?: string;
  requestId?: string;
}

export async function createEngagementIssue(
  engagementId: string,
  input: CreateEngagementIssueInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_engagement_issue", {
    p_engagement: engagementId,
    p_title: input.title,
    p_detail: input.detail ?? "",
    p_raised_by_participant_id: input.raisedByParticipantId ?? null,
    p_request_id: input.requestId ?? null,
  });
  if (error) rpcError("denied", "createEngagementIssue", error);
  return data as string;
}

export interface UpdateEngagementIssueInput {
  status?: "open" | "addressed" | "closed";
  detail?: string;
  requestId?: string;
  linkRequest?: boolean;
}

export async function updateEngagementIssue(
  issueId: string,
  input: UpdateEngagementIssueInput,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<void> {
  const { error } = await supabase.rpc("update_governance_engagement_issue", {
    p_issue: issueId,
    p_status: input.status ?? null,
    p_detail: input.detail ?? null,
    p_request_id: input.requestId ?? null,
    p_link_request: input.linkRequest ?? false,
  });
  if (error) rpcError("denied", "updateEngagementIssue", error);
}

export async function createEngagementUpdate(
  engagementId: string,
  input: { title?: string; body: string; kind?: string; isPublic?: boolean; evidenceAssetId?: string },
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<string> {
  const { data, error } = await supabase.rpc("create_governance_engagement_update", {
    p_engagement: engagementId,
    p_title: input.title ?? "",
    p_body: input.body,
    p_kind: input.kind ?? "progress",
    p_is_public: input.isPublic ?? false,
    p_evidence_asset_id: input.evidenceAssetId ?? null,
  });
  if (error) rpcError("denied", "createEngagementUpdate", error);
  return data as string;
}

// ─────────────────────────────────────────────────────────────────────────
// ACCOUNTABILITY — PHASE 18
//
// Publication + public projection layer over migration 0057. Publication
// reuses the existing per-domain authority RPCs (which since 0057 require
// publish_accountability — one publication authority across all domains,
// prompt §6/§7); the public projection functions are the anonymous read
// surface: tenant resolved server-side by PUBLIC site slug, records
// addressed by reference_code, explicit column allowlists only. The
// service owns no security and never accepts a tenant or actor id.
// ─────────────────────────────────────────────────────────────────────────

// Public projection types (explicit allowlists mirroring 0057 columns).

export interface PublicGovernanceHub {
  published_projects: number;
  published_commitments: number;
  open_consultations: number;
  published_petitions: number;
  published_engagements: number;
  published_poll_results: number;
  stats_available: boolean;
}

export interface PublicGovernanceProjectSummary {
  reference_code: string;
  title: string;
  description: string;
  category_label: string;
  status: string;
  progress_percent: number;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
}

export interface PublicGovernanceProject extends PublicGovernanceProjectSummary {
  implementing_org: string;
  funding_source: string;
  beneficiary_summary: string;
  beneficiaries_estimated: number | null;
  published_at: string | null;
}

export interface PublicGovernanceMilestone {
  title: string;
  description: string;
  status: string;
  due_date: string | null;
  sort_order: number;
}

export interface PublicGovernanceCommitmentSummary {
  reference_code: string;
  title: string;
  details: string;
  category_label: string;
  status: string;
  source_type: string;
  source_ref: string | null;
  progress_percent: number;
  target_date: string | null;
  completed_at: string | null;
}

export interface PublicGovernanceCommitment extends PublicGovernanceCommitmentSummary {
  target_description: string;
  planned_start: string | null;
  published_at: string | null;
}

export interface PublicGovernanceLinkedProject {
  reference_code: string;
  title: string;
  status: string;
  progress_percent: number;
}

export interface PublicGovernanceParticipateItem {
  kind: string;
  reference_code: string;
  title: string;
  description: string;
  status: string;
  closes_at: string | null;
}

export interface PublicGovernanceConsultation {
  kind: string;
  reference_code: string;
  title: string;
  description: string;
  instructions: string;
  questions: unknown[];
  status: string;
  closes_at: string | null;
  results: Record<string, unknown> | null;
  results_summary: string;
  published_at: string | null;
}

export interface PublicGovernancePetition {
  origin: string;
  reference_code: string;
  title: string;
  demand: string;
  status: string;
  target_signatures: number | null;
  verified_count: number | null;
  results: Record<string, unknown> | null;
  results_summary: string;
  published_at: string | null;
}

export interface PublicGovernancePoll {
  reference_code: string;
  title: string;
  question: string;
  description: string;
  options: unknown[];
  results: Record<string, unknown> | null;
  results_summary: string;
  published_at: string | null;
}

export interface PublicGovernanceEngagementSummary {
  reference_code: string;
  title: string;
  description: string;
  status: string;
  scheduled_at: string | null;
  held_at: string | null;
  location: string;
  attendance_count: number;
}

export interface PublicGovernanceEngagement extends PublicGovernanceEngagementSummary {
  agenda: unknown[];
  outcomes: string;
  event_title: string | null;
  event_date: string | null;
  event_venue: string | null;
  published_at: string | null;
}

export interface PublicGovernanceUpdate {
  title: string;
  body: string;
  kind: string;
  created_at: string;
}

export interface PublicGovernanceRequestStat {
  scope_level: string;
  scope_name: string;
  total_bucket: string;
  open_bucket: string;
  resolved_bucket: string;
  resolution_days_bucket: string;
}

// ── Publication (authenticated; authority lives in the RPCs — 0057).
// setProjectVisibility / setCommitmentVisibility / setProjectUpdateVisibility
// already exist in their phase sections — they now hit the 0057-hardened
// RPCs (publish_accountability gate), so no re-declaration here.

// ── Public projections (anonymous; tenant by site slug, 0037 seam) ─────

async function rpcRows<T>(
  fn: string,
  args: Record<string, unknown>,
  op: string,
  supabase: SupabaseClient,
): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new GovernanceError("denied", `governance: ${op} failed: ${error.message}`);
  return (data ?? []) as T[];
}

export function listPublicGovernanceHub(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceHub[]> {
  return rpcRows<PublicGovernanceHub>("public_governance_hub", { p_tenant_slug: siteSlug }, "publicHub", supabase);
}

export function listPublicGovernanceProjects(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceProjectSummary[]> {
  return rpcRows<PublicGovernanceProjectSummary>("public_governance_projects", { p_tenant_slug: siteSlug }, "publicProjects", supabase);
}

export function getPublicGovernanceProject(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceProject[]> {
  return rpcRows<PublicGovernanceProject>("public_governance_project", { p_tenant_slug: siteSlug, p_reference: reference }, "publicProject", supabase);
}

export function listPublicGovernanceProjectMilestones(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceMilestone[]> {
  return rpcRows<PublicGovernanceMilestone>("public_governance_project_milestones", { p_tenant_slug: siteSlug, p_reference: reference }, "publicMilestones", supabase);
}

export function listPublicGovernanceProjectUpdates(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceUpdate[]> {
  return rpcRows<PublicGovernanceUpdate>("public_governance_updates", { p_tenant_slug: siteSlug, p_reference: reference }, "publicProjectUpdates", supabase);
}

export function listPublicGovernanceCommitments(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceCommitmentSummary[]> {
  return rpcRows<PublicGovernanceCommitmentSummary>("public_governance_commitments", { p_tenant_slug: siteSlug }, "publicCommitments", supabase);
}

export function getPublicGovernanceCommitment(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceCommitment[]> {
  return rpcRows<PublicGovernanceCommitment>("public_governance_commitment", { p_tenant_slug: siteSlug, p_reference: reference }, "publicCommitment", supabase);
}

export function listPublicGovernanceCommitmentProjects(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceLinkedProject[]> {
  return rpcRows<PublicGovernanceLinkedProject>("public_governance_commitment_projects", { p_tenant_slug: siteSlug, p_reference: reference }, "publicCommitmentProjects", supabase);
}

export function listPublicGovernanceParticipate(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceParticipateItem[]> {
  return rpcRows<PublicGovernanceParticipateItem>("public_governance_participate", { p_tenant_slug: siteSlug }, "publicParticipate", supabase);
}

export function getPublicGovernanceConsultation(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceConsultation[]> {
  return rpcRows<PublicGovernanceConsultation>("public_governance_consultation", { p_tenant_slug: siteSlug, p_reference: reference }, "publicConsultation", supabase);
}

export function getPublicGovernancePetition(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernancePetition[]> {
  return rpcRows<PublicGovernancePetition>("public_governance_petition", { p_tenant_slug: siteSlug, p_reference: reference }, "publicPetition", supabase);
}

export function getPublicGovernancePoll(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernancePoll[]> {
  return rpcRows<PublicGovernancePoll>("public_governance_poll", { p_tenant_slug: siteSlug, p_reference: reference }, "publicPoll", supabase);
}

export function listPublicGovernanceEngagements(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceEngagementSummary[]> {
  return rpcRows<PublicGovernanceEngagementSummary>("public_governance_engagements", { p_tenant_slug: siteSlug }, "publicEngagements", supabase);
}

export function getPublicGovernanceEngagement(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceEngagement[]> {
  return rpcRows<PublicGovernanceEngagement>("public_governance_engagement", { p_tenant_slug: siteSlug, p_reference: reference }, "publicEngagement", supabase);
}

export function listPublicGovernanceEngagementUpdates(
  siteSlug: string,
  reference: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceUpdate[]> {
  return rpcRows<PublicGovernanceUpdate>("public_governance_engagement_updates", { p_tenant_slug: siteSlug, p_reference: reference }, "publicEngagementUpdates", supabase);
}

export function listPublicGovernanceRequestStats(
  siteSlug: string,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<PublicGovernanceRequestStat[]> {
  return rpcRows<PublicGovernanceRequestStat>("public_governance_request_stats", { p_tenant_slug: siteSlug }, "publicRequestStats", supabase);
}

// ─────────────────────────────────────────────────────────────────────────
// ANALYTICS & INSTITUTIONAL MEMORY — PHASE 19
//
// Derived analytics over the canonical Governance records (migration
// 0058): no new tables, no counters, no second history model. Tenant and
// authority resolve server-side inside each RPC — the browser supplies
// nothing. All surfaces are staff-gated (view_governance / admin) and
// scoped users are geo-restricted server-side.
// ─────────────────────────────────────────────────────────────────────────

export interface GovernanceRequestsAnalytics {
  total: number;
  submitted: number;
  acknowledged: number;
  assigned: number;
  in_progress: number;
  awaiting_information: number;
  resolved: number;
  closed: number;
  rejected: number;
  resolved_bucket: string;
  median_resolution_days: string;
  by_ward: Record<string, string>;
  by_category: Record<string, number>;
  by_month: Record<string, number>;
}

export interface GovernanceDeliveryAnalytics {
  projects_total: number;
  projects_active: number;
  projects_concluded: number;
  projects_published: number;
  milestones_done: number;
  milestones_total: number;
  commitments_total: number;
  commitments_delivered: number;
  commitments_in_progress: number;
  commitments_published: number;
  commitments_with_projects: number;
  commitments_without_projects: number;
  projects_by_ward: Record<string, number>;
}

export interface GovernanceParticipationAnalytics {
  consultations_total: number;
  consultations_open: number;
  consultations_results_published: number;
  consultation_responses_bucket: string;
  surveys_total: number;
  petitions_total: number;
  petitions_open: number;
  petitions_verified_support_bucket: string;
  proposals_total: number;
  polls_total: number;
  polls_open: number;
  polls_closed_published: number;
  poll_votes_bucket: string;
}

export interface GovernanceEngagementsAnalytics {
  total: number;
  draft: number;
  scheduled: number;
  concluded: number;
  published: number;
  attendance_count: number;
  issues_open: number;
  issues_addressed: number;
  issues_closed: number;
  followups: number;
  by_ward: Record<string, number>;
}

export interface GovernanceAccountabilityAnalytics {
  published_projects: number;
  published_commitments: number;
  published_consultations: number;
  published_petitions: number;
  published_polls: number;
  published_engagements: number;
  public_updates: number;
  public_request_stats_available: boolean;
}

export interface GovernanceMemoryEntry {
  kind: string;
  reference_code: string;
  title: string;
  status: string;
  occurred_at: string;
  published: boolean;
}

export const GOVERNANCE_MEMORY_KINDS = [
  "project", "commitment", "consultation", "petition", "poll", "engagement", "update",
] as const;

async function analyticsRows<T>(
  fn: string,
  args: Record<string, unknown> | undefined,
  op: string,
  supabase: SupabaseClient,
): Promise<T[]> {
  const { data, error } = args
    ? await supabase.rpc(fn, args)
    : await supabase.rpc(fn);
  if (error) throw new GovernanceError("denied", `governance: ${op} failed: ${error.message}`);
  return (data ?? []) as T[];
}

export function getRequestsAnalytics(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceRequestsAnalytics[]> {
  return analyticsRows<GovernanceRequestsAnalytics>("governance_analytics_requests", undefined, "requestsAnalytics", supabase);
}

export function getDeliveryAnalytics(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceDeliveryAnalytics[]> {
  return analyticsRows<GovernanceDeliveryAnalytics>("governance_analytics_delivery", undefined, "deliveryAnalytics", supabase);
}

export function getParticipationAnalytics(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceParticipationAnalytics[]> {
  return analyticsRows<GovernanceParticipationAnalytics>("governance_analytics_participation", undefined, "participationAnalytics", supabase);
}

export function getEngagementsAnalytics(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceEngagementsAnalytics[]> {
  return analyticsRows<GovernanceEngagementsAnalytics>("governance_analytics_engagements", undefined, "engagementsAnalytics", supabase);
}

export function getAccountabilityAnalytics(
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceAccountabilityAnalytics[]> {
  return analyticsRows<GovernanceAccountabilityAnalytics>("governance_analytics_accountability", undefined, "accountabilityAnalytics", supabase);
}

export function listGovernanceMemoryTimeline(
  kind?: string,
  limit = 100,
  offset = 0,
  supabase: SupabaseClient = getSupabaseClient(),
): Promise<GovernanceMemoryEntry[]> {
  return analyticsRows<GovernanceMemoryEntry>(
    "governance_memory_timeline",
    { p_kind: kind ?? null, p_limit: limit, p_offset: offset },
    "memoryTimeline",
    supabase,
  );
}
