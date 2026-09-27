/**
 * POLITICORE — Social Force service layer (Phase B: Tasks surface).
 *
 * The SINGLE Social Force application boundary. Every Tasks operation in
 * migrated UI code goes through this module — pages must not scatter raw
 * Supabase queries. The Phase A substrate (0028) is authoritative:
 *
 *   social_tasks → social_task_submissions → social_point_awards
 *
 * Reads go through the security_invoker views (public.social_tasks,
 * public.social_task_submissions) whose RLS policies enforce tenant +
 * module_enabled('social') + membership/authority — the client never
 * widens or narrows visibility. Authority-bearing mutations invoke the
 * Phase A SECURITY DEFINER RPCs via their public wrappers; actor and
 * tenant are always resolved server-side from auth.uid().
 *
 * This boundary deliberately exposes NO submission-verification,
 * point-award, or leaderboard mutation: verification/awarding belongs to
 * the Phase A verify RPC (wired for the admin review desk), and point
 * history/leaderboard UI is later-phase scope. profiles.points is a
 * server-maintained projection — no client path touches it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// ── canonical types (reflect the relational model; no Firestore shapes) ──

export type SocialTaskPlatform = "facebook" | "x" | "instagram" | "tiktok";

export type SocialTaskAction = "like" | "comment" | "share" | "make_post";

/** Legacy lifecycle: active ↔ inactive. No draft state (gate §11). */
export type SocialTaskStatus = "active" | "inactive";

export type SocialSubmissionStatus = "pending" | "verified";

export interface SocialTask {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  platform: SocialTaskPlatform;
  action: SocialTaskAction;
  points: number;
  status: SocialTaskStatus;
  target_url: string | null;
  proof_required: boolean;
  /** ISO timestamp or null; RLS hides expired tasks from members. */
  expiration_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SocialTaskSubmission {
  id: string;
  tenant_id: string;
  task_id: string;
  submitter_id: string;
  proof_url: string | null;
  status: SocialSubmissionStatus;
  submitted_at: string;
  verified_at: string | null;
  verified_by: string | null;
  updated_at: string;
}

/** Admin review-desk row: a submission joined to its submitter profile. */
export interface SocialSubmissionWithSubmitter extends SocialTaskSubmission {
  submitter: {
    id: string;
    full_name: string;
    email: string;
  } | null;
}

// ── Phase D: points + leaderboard (read-only over the authoritative model) ─

/** One row of the caller's point history, derived from the award ledger. */
export interface SocialPointHistoryEntry {
  id: string;
  submission_id: string | null;
  points: number;
  source: string;
  awarded_at: string;
  /** Task title when the award links to a task submission (batched lookup). */
  task_id: string | null;
  task_title: string | null;
}

/** One row of the social_leaderboard projection (reduced public fields). */
export interface SocialLeaderboardEntry {
  id: string;
  tenant_id: string;
  full_name: string;
  points: number;
  rank: string | null;
  ward_id: string | null;
  ward_name: string | null;
  lga_id: string | null;
  zone_id: string | null;
  /** Database-computed dense position within the tenant (never recomputed client-side). */
  position: number;
}

// ── error machinery (same shape as the Campaign service) ─────────────────

export type SocialErrorKind =
  | "unauthenticated"
  | "module_disabled"
  | "forbidden"
  | "invalid_transition"
  | "not_found"
  | "validation"
  | "conflict"
  | "infra";

const KIND_PATTERNS: Array<[RegExp, SocialErrorKind]> = [
  [/authentication required|unauthenticated/i, "unauthenticated"],
  [/social module is not enabled|module.*not enabled/i, "module_disabled"],
  [/social membership is required|requires admin authority|not authorized|not permitted/i, "forbidden"],
  [/already been verified|submission has already/i, "conflict"],
  [/task is not active|has expired|not scoreable/i, "invalid_transition"],
  [/task not found|submission not found/i, "not_found"],
  [/proof URL is required|title|length|invalid/i, "validation"],
];

const KIND_MESSAGES: Record<SocialErrorKind, string> = {
  unauthenticated: "Your session has expired. Please sign in again.",
  module_disabled: "The Social Force module is not enabled for your organization.",
  forbidden: "You do not have permission to perform that Social Force action.",
  invalid_transition: "That action is not allowed in the task's current state.",
  not_found: "The requested Social Force record could not be found.",
  validation: "The submitted Social Force data is invalid.",
  conflict: "That record has already been processed.",
  infra: "A Social Force service error occurred. Please try again.",
};

function classify(message: string): SocialErrorKind {
  for (const [pattern, kind] of KIND_PATTERNS) {
    if (pattern.test(message)) return kind;
  }
  return "infra";
}

/** Exposed for tests/gates: classify a raw Postgres/RPC error message. */
export function classifySocialError(message: string): SocialErrorKind {
  return classify(message);
}

/** Typed Social Force service error — callers can branch on `kind`. */
export class SocialForceError extends Error {
  readonly kind: SocialErrorKind;

  constructor(kind: SocialErrorKind, message?: string) {
    super(message ?? KIND_MESSAGES[kind]);
    this.name = "SocialForceError";
    this.kind = kind;
  }
}

function rpcError(err: unknown): SocialForceError {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  return new SocialForceError(classify(message), message);
}

function queryError(op: string, err: { message: string } | null): never {
  // Query failures against RLS-protected views are authorization or
  // infrastructure problems — NEVER folded into an empty list.
  throw new SocialForceError(
    classify(err?.message ?? "unknown error"),
    `${op}: ${err?.message ?? "unknown error"}`,
  );
}

// ── reads (RLS-scoped through the security_invoker views) ────────────────

export interface SocialTaskListOptions {
  /** Admin surfaces pass status explicitly; member surfaces omit it (RLS already hides non-active rows). */
  status?: SocialTaskStatus;
}

/**
 * List tasks visible to the current session. RLS decides visibility:
 * admins see every task in the tenant; social members see active,
 * unexpired tasks only. Ordering follows the legacy Firestore listing
 * (created_at desc) — presentation, not authorization.
 */
export async function getSocialTasks(
  supabase: SupabaseClient,
  opts?: SocialTaskListOptions,
): Promise<SocialTask[]> {
  let q = supabase
    .from("social_tasks")
    .select("*")
    .order("created_at", { ascending: false });
  if (opts?.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) queryError("getSocialTasks", error);
  return (data ?? []) as SocialTask[];
}

/** Fetch one task by id. RLS yields zero rows for invisible tasks. */
export async function getSocialTask(
  supabase: SupabaseClient,
  taskId: string,
): Promise<SocialTask | null> {
  const { data, error } = await supabase
    .from("social_tasks")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();
  if (error) queryError("getSocialTask", error);
  return (data as SocialTask) ?? null;
}

/**
 * The caller's own submission for a task (legacy per-task state), or
 * null. RLS restricts submissions rows to the submitter (or admin).
 */
export async function getMySubmission(
  supabase: SupabaseClient,
  taskId: string,
): Promise<SocialTaskSubmission | null> {
  const { data, error } = await supabase
    .from("social_task_submissions")
    .select("*")
    .eq("task_id", taskId)
    .maybeSingle();
  if (error) queryError("getMySubmission", error);
  return (data as SocialTaskSubmission) ?? null;
}

/**
 * The caller's submission history across tasks (member "my activity").
 * RLS already restricts rows to the caller's own submissions.
 */
export async function getMySubmissions(
  supabase: SupabaseClient,
): Promise<SocialTaskSubmission[]> {
  const { data, error } = await supabase
    .from("social_task_submissions")
    .select("*")
    .order("submitted_at", { ascending: false });
  if (error) queryError("getMySubmissions", error);
  return (data ?? []) as SocialTaskSubmission[];
}

/**
 * The caller's submissions for one specific task (pending → resubmission
 * flow). One query; RLS restricts rows to the caller's own.
 */
export async function getMySubmissionsForTask(
  supabase: SupabaseClient,
  taskId: string,
): Promise<SocialTaskSubmission[]> {
  const { data, error } = await supabase
    .from("social_task_submissions")
    .select("*")
    .eq("task_id", taskId)
    .order("submitted_at", { ascending: false });
  if (error) queryError("getMySubmissionsForTask", error);
  return (data ?? []) as SocialTaskSubmission[];
}

/**
 * Admin review desk header counts: pending vs verified submissions per
 * task across the tenant (gate §15). ONE grouped query over the RLS
 * view — admins see all tenant submissions; members see only their own,
 * so the aggregate is inherently scoped. Never a per-task fanout.
 */
export async function getSubmissionsCount(
  supabase: SupabaseClient,
  taskIds: string[],
): Promise<Map<string, { pending: number; verified: number }>> {
  if (taskIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("social_task_submissions")
    .select("task_id, status")
    .in("task_id", taskIds);
  if (error) queryError("getSubmissionsCount", error);
  const counts = new Map<string, { pending: number; verified: number }>();
  for (const row of (data ?? []) as Array<{ task_id: string; status: SocialSubmissionStatus }>) {
    const c = counts.get(row.task_id) ?? { pending: 0, verified: 0 };
    if (row.status === "pending") c.pending += 1;
    else c.verified += 1;
    counts.set(row.task_id, c);
  }
  return counts;
}

/**
 * Admin review desk: every submission for a task with its submitter
 * profile (name + email only — the same minimization the legacy modal
 * displayed). RLS enforces admin-or-own visibility; the admin UI is the
 * consumer that needs the join. Two queries total — submissions plus a
 * single batched profile lookup; never per-submission fanout.
 */
export async function getSubmissionsForTask(
  supabase: SupabaseClient,
  taskId: string,
): Promise<SocialSubmissionWithSubmitter[]> {
  const { data, error } = await supabase
    .from("social_task_submissions")
    .select("*")
    .eq("task_id", taskId)
    .order("submitted_at", { ascending: false });
  if (error) queryError("getSubmissionsForTask", error);
  const rows = (data ?? []) as SocialTaskSubmission[];
  if (rows.length === 0) return [];

  const { data: profiles, error: pErr } = await supabase
    .from("politicore_profiles")
    .select("id, full_name, email")
    .in(
      "id",
      rows.map((r) => r.submitter_id),
    );
  if (pErr) queryError("getSubmissionsForTask.profiles", pErr);
  const byId = new Map(
    ((profiles ?? []) as Array<{ id: string; full_name: string; email: string }>).map(
      (p) => [p.id, p],
    ),
  );
  return rows.map((r) => ({
    ...r,
    submitter: byId.get(r.submitter_id) ?? null,
  }));
}

// ── authority mutations (Phase A RPCs; actor/tenant server-resolved) ─────

export interface CreateSocialTaskInput {
  title: string;
  description?: string | null;
  platform: SocialTaskPlatform;
  action: SocialTaskAction;
  points: number;
  status?: SocialTaskStatus;
  target_url?: string | null;
  proof_required?: boolean;
  /** Date-only (yyyy-mm-dd) or ISO timestamp; midnight local → stored timestamptz. */
  expiration_date?: string | null;
}

/** Admin task creation via the Phase A authority RPC. Returns the new task id. */
export async function createSocialTask(
  supabase: SupabaseClient,
  input: CreateSocialTaskInput,
): Promise<string> {
  const { data, error } = await supabase.rpc("create_social_task", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_platform: input.platform,
    p_action: input.action,
    p_points: input.points,
    p_status: input.status ?? "active",
    p_target_url: input.target_url ?? null,
    p_proof_required: input.proof_required ?? true,
    p_expiration_date: input.expiration_date ?? null,
  });
  if (error) throw rpcError(error);
  return data as string;
}

export interface UpdateSocialTaskInput {
  title?: string;
  description?: string | null;
  platform?: SocialTaskPlatform;
  action?: SocialTaskAction;
  points?: number;
  status?: SocialTaskStatus;
  target_url?: string | null;
  proof_required?: boolean;
  expiration_date?: string | null;
}

/**
 * The RPC treats SQL NULL as "keep current value"; fields that may be
 * cleared (description, target_url, expiration_date) map explicit UI
 * nulls to empty-string, which the RPC btrims to NULL on the server.
 */
function clearable(v: string | null | undefined): string | null | undefined {
  if (v === null) return "";
  return v;
}

/**
 * Admin task edit via the Phase A authority RPC. NULL args keep their
 * current values; explicit nulls clear nullable fields (target_url,
 * expiration_date, description).
 */
export async function updateSocialTask(
  supabase: SupabaseClient,
  taskId: string,
  input: UpdateSocialTaskInput,
): Promise<void> {
  const { error } = await supabase.rpc("update_social_task", {
    p_task: taskId,
    p_title: input.title ?? null,
    p_description: clearable(input.description),
    p_platform: input.platform ?? null,
    p_action: input.action ?? null,
    p_points: input.points ?? null,
    p_status: input.status ?? null,
    p_target_url: clearable(input.target_url),
    p_proof_required: input.proof_required ?? null,
    p_expiration_date: input.expiration_date ?? null,
  });
  if (error) throw rpcError(error);
}

/**
 * The caller's current points total — read from the authoritative
 * server-maintained projection (profiles.points, exposed through the
 * politicore_profiles view). NEVER recalculated from awards in the
 * client (gate §8).
 */
export async function getMySocialPoints(
  supabase: SupabaseClient,
): Promise<number> {
  const { data, error } = await supabase
    .from("politicore_profiles")
    .select("points")
    .maybeSingle();
  if (error) queryError("getMySocialPoints", error);
  return Number((data as { points: number | null } | null)?.points ?? 0);
}

/**
 * The caller's point history from the immutable award ledger (RLS:
 * recipient = self, or admin). Bounded, deterministic ordering; task
 * titles resolved with ONE batched lookup through the submission→task
 * chain — never per-row fanout (gate §31).
 */
export async function getMySocialPointHistory(
  supabase: SupabaseClient,
  opts?: { limit?: number },
): Promise<SocialPointHistoryEntry[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const { data, error } = await supabase
    .from("social_point_awards")
    .select("id, submission_id, points, source, awarded_at")
    .order("awarded_at", { ascending: false })
    .limit(limit);
  if (error) queryError("getMySocialPointHistory", error);
  const rows = (data ?? []) as Array<{
    id: string;
    submission_id: string | null;
    points: number;
    source: string;
    awarded_at: string;
  }>;
  if (rows.length === 0) return [];

  // submissions for these awards → their tasks (two batched queries).
  const submissionIds = rows
    .map((r) => r.submission_id)
    .filter((id): id is string => Boolean(id));
  const taskIds = new Set<string>();
  const taskBySubmission = new Map<string, string>();
  if (submissionIds.length > 0) {
    const { data: subs, error: sErr } = await supabase
      .from("social_task_submissions")
      .select("id, task_id")
      .in("id", submissionIds);
    if (sErr) queryError("getMySocialPointHistory.submissions", sErr);
    for (const s of (subs ?? []) as Array<{ id: string; task_id: string }>) {
      taskBySubmission.set(s.id, s.task_id);
      taskIds.add(s.task_id);
    }
  }
  const titleByTask = new Map<string, string>();
  if (taskIds.size > 0) {
    const { data: tasks, error: tErr } = await supabase
      .from("social_tasks")
      .select("id, title")
      .in("id", Array.from(taskIds));
    if (tErr) queryError("getMySocialPointHistory.tasks", tErr);
    for (const t of (tasks ?? []) as Array<{ id: string; title: string }>) {
      titleByTask.set(t.id, t.title);
    }
  }

  return rows.map((r) => {
    const taskId = r.submission_id ? taskBySubmission.get(r.submission_id) ?? null : null;
    return {
      id: r.id,
      submission_id: r.submission_id,
      points: r.points,
      source: r.source,
      awarded_at: r.awarded_at,
      task_id: taskId,
      task_title: taskId ? titleByTask.get(taskId) ?? null : null,
    };
  });
}

/**
 * The authoritative leaderboard projection (social_leaderboard). Rank
 * comes from the database `position` column — the client NEVER sorts
 * or recomputes rank (gate §13). Bounded result set; ordering is the
 * projection's own.
 */
export async function getSocialLeaderboard(
  supabase: SupabaseClient,
  opts?: { limit?: number },
): Promise<SocialLeaderboardEntry[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
  const { data, error } = await supabase
    .from("social_leaderboard")
    .select("*")
    .order("position", { ascending: true })
    .limit(limit);
  if (error) queryError("getSocialLeaderboard", error);
  return (data ?? []) as SocialLeaderboardEntry[];
}

/** Admin activate/deactivate via the Phase A authority RPC. */
export async function setSocialTaskStatus(
  supabase: SupabaseClient,
  taskId: string,
  status: SocialTaskStatus,
): Promise<void> {
  const { error } = await supabase.rpc("set_social_task_status", {
    p_task: taskId,
    p_status: status,
  });
  if (error) throw rpcError(error);
}

/**
 * Member submission for the current session's own behalf (Phase A RPC
 * pins submitter to auth.uid()). Bridge for the pre-existing member
 * workflow — no new submission functionality is introduced here.
 */
export async function submitSocialTask(
  supabase: SupabaseClient,
  taskId: string,
  proofUrl?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_social_task", {
    p_task: taskId,
    p_proof_url: proofUrl ?? null,
  });
  if (error) throw rpcError(error);
  return data as string;
}

/**
 * Admin verification via the Phase A authority RPC (award is inserted
 * atomically by the RPC; duplicates are structurally impossible).
 * NOTE: verified submissions are immutable in the substrate — the
 * legacy "unverify" path does not exist server-side.
 */
export async function verifySocialSubmission(
  supabase: SupabaseClient,
  submissionId: string,
): Promise<void> {
  const { error } = await supabase.rpc("verify_social_submission", {
    p_submission: submissionId,
  });
  if (error) throw rpcError(error);
}
