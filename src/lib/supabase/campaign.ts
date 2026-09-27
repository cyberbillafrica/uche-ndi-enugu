/**
 * POLITICORE — Campaign service layer (Phase A foundation).
 *
 * The SINGLE Campaign application boundary. Every Campaign operation in
 * migrated UI code goes through this module — pages must not scatter raw
 * Supabase queries. Phase A establishes the architecture, types, and
 * error machinery; individual workflows are filled in by Phases B–E
 * (docs/Campaign-Architecture.md §8) without new files.
 *
 * Data model (0021): campaign_activities / campaign_activity_participants /
 * campaign_assignments / campaign_field_reports / campaign_issues —
 * relationships are tables, evidence is a media_assets reference, and
 * every authority-bearing mutation is a database RPC with server-resolved
 * identity/tenant/scope. The legacy client-side expandAssignmentToScopes
 * fan-out and client-resolved authority have no equivalent here.
 *
 * Every caller passes an authenticated SupabaseClient — bridged sessions
 * only; the anon client can never satisfy the Campaign RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// ── canonical types (reflect the relational model; no Firestore shapes) ──

export type CampaignActivityType =
  | "rally"
  | "meeting"
  | "stakeholder_engagement"
  | "training"
  | "community_engagement"
  | "ward_meeting"
  | "lga_meeting"
  | "campaign_outreach"
  | "other";

export type CampaignActivityStatus =
  | "scheduled"
  | "postponed"
  | "cancelled"
  | "completed";

export type CampaignRsvp = "going" | "interested" | "not_going";

export type CampaignAttendanceState = "present" | "excused" | "absent";

export type CampaignAssignmentPriority = "low" | "medium" | "high" | "urgent";

export type CampaignAssignmentStatus =
  | "not_started"
  | "in_progress"
  | "submitted"
  | "under_review"
  | "completed"
  | "overdue";

export type CampaignReportType =
  | "activity"
  | "community"
  | "mobilization"
  | "meeting"
  | "field"
  | "other";

export type CampaignReportStatus =
  | "submitted"
  | "under_review"
  | "accepted"
  | "returned";

export type CampaignIssueType =
  | "logistics"
  | "campaign_activity"
  | "community_concern"
  | "volunteer"
  | "communication"
  | "security"
  | "infrastructure"
  | "other";

export type CampaignIssuePriority = "low" | "medium" | "high" | "urgent";

export type CampaignIssueStatus =
  | "reported"
  | "acknowledged"
  | "assigned"
  | "in_progress"
  | "resolved"
  | "verified"
  | "closed";

export type CampaignScopeType =
  | "polling_unit"
  | "ward"
  | "lga"
  | "senatorial_zone"
  | "state"
  | "campaign";

export interface CampaignScopeRef {
  scope_type: CampaignScopeType;
  scope_id: string;
}

export interface CampaignActivity {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  activity_type: CampaignActivityType;
  venue: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  expected_attendance: number | null;
  scope_type: CampaignScopeType;
  scope_id: string;
  status: CampaignActivityStatus;
  organizer_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignActivityParticipant {
  id: string;
  tenant_id: string;
  activity_id: string;
  user_id: string;
  rsvp: CampaignRsvp;
  rsvp_at: string;
  /** null = not yet recorded — attendance is an operational fact, not intent. */
  attendance: CampaignAttendanceState | null;
  checked_in_at: string | null;
  checked_out_at: string | null;
  recorded_by: string | null;
}

export interface CampaignAssignment {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  assigned_to: string;
  assigned_by: string;
  scope_type: CampaignScopeType;
  scope_id: string;
  priority: CampaignAssignmentPriority;
  status: CampaignAssignmentStatus;
  due_date: string | null;
  location: string | null;
  evidence_asset_id: string | null;
  created_at: string;
  updated_at: string;
  /** Derived presentation state — never stored (Architecture Gate §4). */
  is_overdue: boolean;
}

export interface CampaignFieldReport {
  id: string;
  tenant_id: string;
  submitted_by: string;
  report_type: CampaignReportType;
  title: string;
  description: string;
  scope_type: CampaignScopeType;
  scope_id: string;
  location: string | null;
  participants: number | null;
  issues: string | null;
  community_feedback: string | null;
  requests: string | null;
  follow_up_required: boolean;
  status: CampaignReportStatus;
  evidence_asset_id: string | null;
  reviewed_by: string | null;
  review_comment: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignIssue {
  id: string;
  tenant_id: string;
  title: string;
  description: string;
  issue_type: CampaignIssueType;
  priority: CampaignIssuePriority;
  status: CampaignIssueStatus;
  scope_type: CampaignScopeType;
  scope_id: string;
  reported_by: string;
  assigned_to: string | null;
  location: string | null;
  evidence_asset_id: string | null;
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Member-directory row (server-scope-filtered; never tenant-wide leaks). */
export interface CampaignDirectoryMember {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  position_name: string | null;
  scope_type: CampaignScopeType | null;
  scope_id: string | null;
  /** Registered location (§11/§16) — present on paged directory rows. */
  lga_id?: string | null;
  ward_id?: string | null;
  polling_unit_id?: string | null;
}

// ── typed error model (Phase prompt §26 — empty ≠ denied ≠ disabled) ─────

export type CampaignErrorKind =
  | "unauthenticated"
  | "module_disabled"
  | "forbidden"
  | "outside_scope"
  | "invalid_transition"
  | "not_found"
  | "validation"
  | "infra";

const KIND_PATTERNS: Array<[RegExp, CampaignErrorKind]> = [
  [/authentication required|unauthenticated/i, "unauthenticated"],
  [/campaign module is not enabled|module.*not enabled/i, "module_disabled"],
  [/self-approval|self-review is not permitted/i, "forbidden"],
  [/invalid transition|invalid review action|unknown .* action|cannot be completed before|scheduled is the initial state/i, "invalid_transition"],
  [/not authorized|not permitted|only the (assignee|original submitter)/i, "forbidden"],
  [/not found/i, "not_found"],
  [/assignee not found in tenant|scope does not exist|is required/i, "validation"],
];

const KIND_MESSAGES: Record<CampaignErrorKind, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  module_disabled:
    "The Campaign module is not enabled for your organization.",
  forbidden:
    "You do not have permission to perform that Campaign action.",
  outside_scope:
    "That record is outside your assigned Campaign scope.",
  invalid_transition:
    "That action is not allowed in the record's current state.",
  not_found: "The requested Campaign record could not be found.",
  validation: "The submitted Campaign data is invalid.",
  infra: "A Campaign service error occurred. Please try again.",
};

function classify(message: string): CampaignErrorKind {
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return "infra";
}

/** Exposed for tests/gates: classify a raw Postgres/RPC error message. */
export function classifyCampaignError(message: string): CampaignErrorKind {
  return classify(message);
}

/** Typed Campaign service error — callers can branch on `kind`. */
export class CampaignError extends Error {
  readonly kind: CampaignErrorKind;

  constructor(kind: CampaignErrorKind, message?: string) {
    super(message ?? KIND_MESSAGES[kind]);
    this.name = "CampaignError";
    this.kind = kind;
  }
}

function rpcError(err: unknown): CampaignError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  return new CampaignError(classify(message), message);
}

function queryError(op: string, err: { message: string } | null): never {
  // Query failures against RLS-protected views are authorization or
  // infrastructure problems — NEVER folded into an empty list.
  throw new CampaignError(
    classify(err?.message ?? "unknown error"),
    `${op}: ${err?.message ?? "unknown error"}`,
  );
}

// ── internal row mapping ─────────────────────────────────────────────────

interface AssignmentRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  assigned_to: string;
  assigned_by: string;
  scope_type: CampaignAssignment["scope_type"];
  scope_id: string;
  priority: CampaignAssignment["priority"];
  status: CampaignAssignment["status"];
  due_date: string | null;
  location: string | null;
  evidence_asset_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapAssignment(row: AssignmentRow): CampaignAssignment {
  return {
    ...row,
    is_overdue:
      row.due_date !== null &&
      new Date(`${row.due_date}T23:59:59`).getTime() < Date.now() &&
      (row.status === "not_started" || row.status === "in_progress"),
  };
}

// ── activities ───────────────────────────────────────────────────────────

export async function getActivities(
  supabase: SupabaseClient,
  opts?: { status?: CampaignActivityStatus; scopeType?: CampaignScopeType; scopeId?: string },
): Promise<CampaignActivity[]> {
  let q = supabase
    .from("campaign_activities")
    .select("*")
    .order("scheduled_start", { ascending: true });
  if (opts?.status) q = q.eq("status", opts.status);
  if (opts?.scopeType) q = q.eq("scope_type", opts.scopeType);
  if (opts?.scopeId) q = q.eq("scope_id", opts.scopeId);
  const { data, error } = await q;
  if (error) queryError("getActivities", error);
  return (data ?? []) as CampaignActivity[];
}

export interface CreateActivityInput {
  title: string;
  description?: string;
  activity_type: CampaignActivityType;
  venue?: string;
  scheduled_start: string;
  scheduled_end?: string;
  expected_attendance?: number;
  scope_type: CampaignScopeType;
  scope_id: string;
  organizer_id?: string;
}

export async function createActivity(
  supabase: SupabaseClient,
  input: CreateActivityInput,
): Promise<CampaignActivity> {
  const { data, error } = await supabase
    .from("campaign_activities")
    .insert({
      title: input.title,
      description: input.description ?? null,
      activity_type: input.activity_type,
      venue: input.venue ?? null,
      scheduled_start: input.scheduled_start,
      scheduled_end: input.scheduled_end ?? null,
      expected_attendance: input.expected_attendance ?? null,
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      organizer_id: input.organizer_id ?? null,
      status: "scheduled",
    })
    .select("*")
    .single();
  if (error) queryError("createActivity", error);
  return data as CampaignActivity;
}

export interface UpdateActivityInput {
  title?: string;
  description?: string;
  activity_type?: CampaignActivityType;
  venue?: string;
  scheduled_start?: string;
  scheduled_end?: string | null;
  expected_attendance?: number;
  organizer_id?: string;
  /** Scope moves require explicit server-side authorization (0022). */
  scope_type?: CampaignScopeType;
  scope_id?: string;
}

/**
 * Detail edit via the update_campaign_activity RPC (0022). Direct UPDATE
 * is revoked: authority-bearing fields (status/creator/tenant) are not
 * editable here at all, and a scope move re-authorizes server-side.
 */
export async function updateActivity(
  supabase: SupabaseClient,
  id: string,
  input: UpdateActivityInput,
): Promise<void> {
  const { error } = await supabase.rpc("update_campaign_activity", {
    p_activity: id,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_activity_type: input.activity_type ?? null,
    p_venue: input.venue ?? null,
    p_scheduled_start: input.scheduled_start ?? null,
    p_scheduled_end: input.scheduled_end ?? null,
    p_expected_attendance: input.expected_attendance ?? null,
    p_organizer_id: input.organizer_id ?? null,
    p_scope_type: input.scope_type ?? null,
    p_scope_id: input.scope_id ?? null,
  });
  if (error) throw rpcError(error);
}

export async function deleteActivity(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("campaign_activities")
    .delete()
    .eq("id", id);
  if (error) queryError("deleteActivity", error);
}

export type CampaignActivityTransition =
  | "postpone"
  | "cancel"
  | "complete";

export async function transitionActivity(
  supabase: SupabaseClient,
  id: string,
  to: CampaignActivityTransition,
): Promise<void> {
  const map: Record<CampaignActivityTransition, CampaignActivityStatus> = {
    postpone: "postponed",
    cancel: "cancelled",
    complete: "completed",
  };
  const { error } = await supabase.rpc("set_campaign_activity_status", {
    p_activity: id,
    p_status: map[to],
  });
  if (error) throw rpcError(error);
}

// ── participation (§8: RSVP is intent; attendance is fact) ───────────────

export async function setRsvp(
  supabase: SupabaseClient,
  activityId: string,
  rsvp: CampaignRsvp,
): Promise<string> {
  const { data, error } = await supabase.rpc("join_campaign_activity", {
    p_activity: activityId,
    p_rsvp: rsvp,
  });
  if (error) throw rpcError(error);
  return data as string;
}

export async function getParticipants(
  supabase: SupabaseClient,
  activityId: string,
): Promise<CampaignActivityParticipant[]> {
  const { data, error } = await supabase
    .from("campaign_activity_participants")
    .select("*")
    .eq("activity_id", activityId)
    .order("rsvp_at", { ascending: true });
  if (error) queryError("getParticipants", error);
  return (data ?? []) as CampaignActivityParticipant[];
}

export async function recordAttendance(
  supabase: SupabaseClient,
  activityId: string,
  participantUserId: string,
  attendance: CampaignAttendanceState,
  opts?: { checkIn?: boolean; checkOut?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc("record_campaign_attendance", {
    p_activity: activityId,
    p_participant_user: participantUserId,
    p_attendance: attendance,
    p_check_in: opts?.checkIn ?? false,
    p_check_out: opts?.checkOut ?? false,
  });
  if (error) throw rpcError(error);
}

// ── assignments (§10/§11: workflow transitions are RPC-only) ─────────────

export interface AssignmentFilter {
  /** Own assignments only (legacy getMyCampaignAssignments). */
  mine?: boolean;
  scopeType?: CampaignScopeType;
  scopeId?: string;
  status?: CampaignAssignmentStatus;
}

/** Resolve the bridged session user (never trusted for authority —
 * server-side RLS/RPCs re-resolve identity; this only scopes the query). */
async function sessionUserId(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function getAssignments(
  supabase: SupabaseClient,
  filter?: AssignmentFilter,
): Promise<CampaignAssignment[]> {
  let q = supabase
    .from("campaign_assignments")
    .select("*")
    .order("created_at", { ascending: false });
  if (filter?.mine) {
    const uid = await sessionUserId(supabase);
    if (!uid) return []; // unauthenticated: nothing can match, and RLS would deny anyway
    q = q.eq("assigned_to", uid);
  }
  if (filter?.scopeType) q = q.eq("scope_type", filter.scopeType);
  if (filter?.scopeId) q = q.eq("scope_id", filter.scopeId);
  if (filter?.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) queryError("getAssignments", error);
  return (data ?? []).map((r) => mapAssignment(r as AssignmentRow));
}

export interface CreateAssignmentInput {
  title: string;
  description?: string;
  assigned_to: string;
  scope_type: CampaignScopeType;
  scope_id: string;
  priority?: CampaignAssignmentPriority;
  due_date?: string;
  location?: string;
}

export async function createAssignment(
  supabase: SupabaseClient,
  input: CreateAssignmentInput,
): Promise<string> {
  const { data, error } = await supabase.rpc("create_campaign_assignment", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_assigned_to: input.assigned_to,
    p_scope_type: input.scope_type,
    p_scope_id: input.scope_id,
    p_priority: input.priority ?? "medium",
    p_due_date: input.due_date ?? null,
    p_location: input.location ?? null,
  });
  if (error) throw rpcError(error);
  return data as string;
}

async function assignmentAction(
  supabase: SupabaseClient,
  assignmentId: string,
  action: string,
): Promise<CampaignAssignmentStatus> {
  const { data, error } = await supabase.rpc("campaign_assignment_transition", {
    p_assignment: assignmentId,
    p_action: action,
  });
  if (error) throw rpcError(error);
  return data as CampaignAssignmentStatus;
}

export async function startAssignment(
  supabase: SupabaseClient,
  assignmentId: string,
): Promise<CampaignAssignmentStatus> {
  return assignmentAction(supabase, assignmentId, "start");
}

export async function submitAssignment(
  supabase: SupabaseClient,
  assignmentId: string,
): Promise<CampaignAssignmentStatus> {
  return assignmentAction(supabase, assignmentId, "submit");
}

/** accept → completed; return → under_review (rework path). */
export async function reviewAssignment(
  supabase: SupabaseClient,
  assignmentId: string,
  decision: "accept" | "return",
): Promise<CampaignAssignmentStatus> {
  return assignmentAction(supabase, assignmentId, decision);
}

export async function resubmitAssignment(
  supabase: SupabaseClient,
  assignmentId: string,
): Promise<CampaignAssignmentStatus> {
  return assignmentAction(supabase, assignmentId, "resubmit");
}

export interface UpdateAssignmentDetailsInput {
  title?: string;
  description?: string;
  priority?: CampaignAssignmentPriority;
  due_date?: string;
  location?: string;
  reassign_to?: string;
}

export async function updateAssignmentDetails(
  supabase: SupabaseClient,
  assignmentId: string,
  input: UpdateAssignmentDetailsInput,
): Promise<void> {
  const { error } = await supabase.rpc("update_campaign_assignment_details", {
    p_assignment: assignmentId,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_priority: input.priority ?? null,
    p_due_date: input.due_date ?? null,
    p_location: input.location ?? null,
    p_reassign_to: input.reassign_to ?? null,
  });
  if (error) throw rpcError(error);
}

export async function deleteAssignment(
  supabase: SupabaseClient,
  assignmentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("campaign_assignments")
    .delete()
    .eq("id", assignmentId);
  if (error) queryError("deleteAssignment", error);
}

/**
 * Eligible assignees for a TARGET scope — server-resolved by the 0024
 * RPC (campaign membership + registered location covered by the scope;
 * authority checked at that scope). The D2-corrected replacement for
 * the legacy tenant-wide `getAllCampaignMembersForTenant` fetch.
 */
export async function getAssignableMembers(
  supabase: SupabaseClient,
  scopeType: CampaignScopeType,
  scopeId: string,
): Promise<CampaignDirectoryMember[]> {
  const { data, error } = await supabase.rpc("campaign_assignable_members", {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (error) throw rpcError(error);
  return (data ?? []) as CampaignDirectoryMember[];
}

// ── field reports (§13/§14: submitter-visible, supervisor-reviewable) ────

export interface ReportFilter {
  mine?: boolean;
  scopeType?: CampaignScopeType;
  scopeId?: string;
  status?: CampaignReportStatus;
}

export async function getReports(
  supabase: SupabaseClient,
  filter?: ReportFilter,
): Promise<CampaignFieldReport[]> {
  let q = supabase
    .from("campaign_field_reports")
    .select("*")
    .order("created_at", { ascending: false });
  if (filter?.mine) {
    const uid = await sessionUserId(supabase);
    if (!uid) return [];
    q = q.eq("submitted_by", uid);
  }
  if (filter?.scopeType) q = q.eq("scope_type", filter.scopeType);
  if (filter?.scopeId) q = q.eq("scope_id", filter.scopeId);
  if (filter?.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) queryError("getReports", error);
  return (data ?? []) as CampaignFieldReport[];
}

export interface SubmitReportInput {
  report_type: CampaignReportType;
  title: string;
  description: string;
  scope_type: CampaignScopeType;
  scope_id: string;
  location?: string;
  participants?: number;
  issues?: string;
  community_feedback?: string;
  requests?: string;
  follow_up_required?: boolean;
  evidence_asset_id?: string;
}

export async function submitReport(
  supabase: SupabaseClient,
  input: SubmitReportInput,
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_campaign_report", {
    p_report_type: input.report_type,
    p_title: input.title,
    p_description: input.description,
    p_scope_type: input.scope_type,
    p_scope_id: input.scope_id,
    p_location: input.location ?? null,
    p_participants: input.participants ?? null,
    p_issues: input.issues ?? null,
    p_community_feedback: input.community_feedback ?? null,
    p_requests: input.requests ?? null,
    p_follow_up_required: input.follow_up_required ?? false,
    p_evidence: input.evidence_asset_id ?? null,
  });
  if (error) throw rpcError(error);
  return data as string;
}

export type ReportReviewAction = "accept" | "return";

export async function reviewReport(
  supabase: SupabaseClient,
  reportId: string,
  action: ReportReviewAction,
  comment?: string,
): Promise<CampaignReportStatus> {
  const { data, error } = await supabase.rpc("review_campaign_report", {
    p_report: reportId,
    p_action: action,
    p_comment: comment ?? null,
  });
  if (error) throw rpcError(error);
  return data as CampaignReportStatus;
}

export async function resubmitReport(
  supabase: SupabaseClient,
  reportId: string,
  description: string,
  evidenceAssetId?: string,
): Promise<void> {
  const { error } = await supabase.rpc("resubmit_campaign_report", {
    p_report: reportId,
    p_description: description,
    p_evidence: evidenceAssetId ?? null,
  });
  if (error) throw rpcError(error);
}

// ── issues (§15/§16: reporter / assignee / resolver / verifier distinct) ─

export interface IssueFilter {
  mine?: boolean;
  scopeType?: CampaignScopeType;
  scopeId?: string;
  status?: CampaignIssueStatus;
}

export async function getIssues(
  supabase: SupabaseClient,
  filter?: IssueFilter,
): Promise<CampaignIssue[]> {
  let q = supabase
    .from("campaign_issues")
    .select("*")
    .order("created_at", { ascending: false });
  if (filter?.mine) {
    const uid = await sessionUserId(supabase);
    if (!uid) return [];
    q = q.eq("reported_by", uid);
  }
  if (filter?.scopeType) q = q.eq("scope_type", filter.scopeType);
  if (filter?.scopeId) q = q.eq("scope_id", filter.scopeId);
  if (filter?.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) queryError("getIssues", error);
  return (data ?? []) as CampaignIssue[];
}

export interface CreateIssueInput {
  title: string;
  description: string;
  issue_type: CampaignIssueType;
  priority?: CampaignIssuePriority;
  scope_type: CampaignScopeType;
  scope_id: string;
  location?: string;
  evidence_asset_id?: string;
}

export async function createIssue(
  supabase: SupabaseClient,
  input: CreateIssueInput,
): Promise<string> {
  const { data, error } = await supabase
    .from("campaign_issues")
    .insert({
      title: input.title,
      description: input.description,
      issue_type: input.issue_type,
      priority: input.priority ?? "medium",
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      location: input.location ?? null,
      evidence_asset_id: input.evidence_asset_id ?? null,
      status: "reported",
    })
    .select("id")
    .single();
  if (error) queryError("createIssue", error);
  return (data as { id: string }).id;
}

async function issueAction(
  supabase: SupabaseClient,
  issueId: string,
  action: string,
  opts?: { assignee?: string; notes?: string },
): Promise<CampaignIssueStatus> {
  const { data, error } = await supabase.rpc("campaign_issue_transition", {
    p_issue: issueId,
    p_action: action,
    p_assignee: opts?.assignee ?? null,
    p_notes: opts?.notes ?? null,
  });
  if (error) throw rpcError(error);
  return data as CampaignIssueStatus;
}

/** acknowledge / start / resolve / verify / close (assign has its own API). */
export async function updateIssueStatus(
  supabase: SupabaseClient,
  issueId: string,
  action: Exclude<IssueAction, "assign">,
  notes?: string,
): Promise<CampaignIssueStatus> {
  return issueAction(supabase, issueId, action, { notes });
}

export async function assignIssue(
  supabase: SupabaseClient,
  issueId: string,
  assigneeUserId: string,
): Promise<CampaignIssueStatus> {
  return issueAction(supabase, issueId, "assign", { assignee: assigneeUserId });
}

export type IssueAction =
  | "acknowledge"
  | "assign"
  | "start"
  | "resolve"
  | "verify"
  | "close";

// ── member directory (§3.6: server-side scope filter — the D2 fix) ───────

export async function getMembers(
  supabase: SupabaseClient,
): Promise<CampaignDirectoryMember[]> {
  const { data, error } = await supabase.rpc("campaign_members_in_scope");
  if (error) throw rpcError(error);
  return (data ?? []) as CampaignDirectoryMember[];
}

export interface CampaignMemberRecord {
  id: string;
  full_name: string;
  email: string;
}/** Single member lookup — visibility decided by the database (RLS view). */
export async function getMember(
  supabase: SupabaseClient,
  memberId: string,
): Promise<CampaignMemberRecord | null> {
  const { data, error } = await supabase
    .from("politicore_profiles")
    .select("id, full_name, email")
    .eq("id", memberId)
    .maybeSingle();
  if (error) queryError("getMember", error);
  return (data as CampaignMemberRecord | null) ?? null;
}

// ── coordination (Phase E: composition over migrated data — no new tables) ─

/** Aggregate over the caller's covered Campaign population (0026). */
export interface CampaignCoordinationSummary {
  members: number;
  activities: {
    total: number; scheduled: number; postponed: number;
    cancelled: number; completed: number;
  };
  assignments: {
    total: number; not_started: number; in_progress: number; submitted: number;
    under_review: number; completed: number; overdue: number;
  };
  reports: {
    total: number; submitted: number; under_review: number;
    accepted: number; returned: number;
  };
  issues: {
    total: number; open: number; reported: number; acknowledged: number;
    assigned: number; in_progress: number; resolved: number;
    verified: number; closed: number;
  };
}

/**
 * Coordination summary for the caller's authorized coverage (§13/§14).
 * Pure aggregation over already-migrated Campaign tables; authorization
 * is server-resolved (admin/state/campaign tenant-wide, else a covered
 * organizational scope). Never trusts route parameters (§15).
 */
export async function getCoordinationSummary(
  supabase: SupabaseClient,
): Promise<CampaignCoordinationSummary> {
  const { data, error } = await supabase.rpc("campaign_coordination_summary");
  if (error) throw rpcError(error);
  return data as unknown as CampaignCoordinationSummary;
}

// ── member directory, paged + searchable (Phase E §8/§30/§31) ────────────

/** Directory page parameters — filters can only NARROW the authorized set. */
export interface CampaignDirectoryPageParams {
  /** Server-side ILIKE search over name/email/phone. */
  search?: string;
  /** Registered-LGA narrowing filter (no-op outside the caller's coverage). */
  lgaId?: string;
  /** Registered-ward narrowing filter (no-op outside the caller's coverage). */
  wardId?: string;
  limit?: number;
  offset?: number;
}

/** Paged, searchable member directory over the authoritative scope RPC. */
export async function getMembersPaged(
  supabase: SupabaseClient,
  params: CampaignDirectoryPageParams = {},
): Promise<{ members: CampaignDirectoryMember[]; total: number }> {
  const search = params.search?.trim() || null;
  const lgaId = params.lgaId?.trim() || null;
  const wardId = params.wardId?.trim() || null;
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const [membersRes, countRes] = await Promise.all([
    supabase.rpc("campaign_members_page", {
      p_search: search,
      p_lga_id: lgaId,
      p_ward_id: wardId,
      p_limit: limit,
      p_offset: offset,
    }),
    supabase.rpc("campaign_members_page_count", {
      p_search: search,
      p_lga_id: lgaId,
      p_ward_id: wardId,
    }),
  ]);
  if (membersRes.error) throw rpcError(membersRes.error);
  if (countRes.error) throw rpcError(countRes.error);
  return {
    members: (membersRes.data ?? []) as CampaignDirectoryMember[],
    total: (countRes.data ?? 0) as number,
  };
}

// ── settings (§29: module key under the existing tenant_settings) ────────

export async function getCampaignSettings(
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("my_module_settings", {
    p_module: "campaign",
  });
  if (error) throw rpcError(error);
  return (data ?? {}) as Record<string, unknown>;
}
