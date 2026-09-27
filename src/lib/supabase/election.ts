/**
 * POLITICORE — Election service layer (Phase 2 cutover).
 *
 * The APPLICATION BOUNDARY of the PostgreSQL Election Engine. Every
 * Election operation in migrated UI code goes through this module —
 * pages must not scatter raw Supabase queries.
 *
 * Architecture mapping (legacy → new):
 *   Firestore docs                    → politicore.* tables via data API
 *   client-side vote arrays (JSON)    → election_result_votes rows
 *                                       (composed into ElectionResult
 *                                       objects here, §5 of the brief)
 *   Cloudinary evidence               → Media Service / R2 via the
 *                                       /api/election/evidence route
 *   Firestore onSnapshot              → Supabase Realtime channels
 *                                       (RLS-scoped: the subscriber
 *                                       only ever receives rows the
 *                                       database authorizes)
 *   client-side aggregation           → get_results_aggregate RPC
 *                                       (relational SQL over
 *                                       election_result_votes)
 *   firebase election_settings doc    → election_settings row +
 *                                       set_active_election RPC
 *
 * Mutation paths (results) are RPC-only by design — the database has no
 * INSERT/UPDATE/DELETE policies on election_results/election_result_
 * votes/election_result_history, so this module never attempts direct
 * writes there. PU reports and incidents are the exception: the tables
 * carry INSERT policies evaluated by RLS, so creates go through
 * ordinary inserts with tenant/identity resolved server-side (never
 * from the payload).
 *
 * Every caller passes an authenticated SupabaseClient — real-time
 * sessions only; the anon client can never satisfy the election RLS.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type {
  BallotInput,
  ElectionAggregate,
  ElectionCandidate,
  ElectionContest,
  ElectionCycle,
  ElectionIncident,
  ElectionPartyTotal,
  ElectionResult,
  ElectionResultHistory,
  ElectionResultStatus,
  ElectionResultVote,
  ElectionSettings,
  ElectionVoteDetail,
  PUReport,
  PoliticalParty,
} from "@/types";

/** Schema of the PostgREST-exposed election tables/views. */
const SCHEMA = "politicore" as const;

// ── domain error translation (brief §28) ─────────────────────────────────

const DOMAIN_ERRORS: Array<[RegExp, string]> = [
  [/authentication required/i, "Your session has expired. Please sign in again."],
  [/election module is not enabled/i, "The Election module is not enabled for your organization."],
  [/social members do not have election access/i, "Social accounts do not have access to Election."],
  [/contest not found/i, "The selected contest could not be found."],
  [/is .*, not OPEN/i, "This contest is not open for result submission."],
  [/polling unit is outside the contest scope/i, "This polling unit is outside the selected contest's geographic scope."],
  [/polling unit not found/i, "The selected polling unit could not be found."],
  [/not authorized to submit results/i, "You are not authorized to submit results for this polling unit."],
  [/not authorized to verify/i, "You are not authorized to review or verify election results."],
  [/only tenant administrators can correct/i, "Only administrators can correct election results."],
  [/only tenant administrators can configure/i, "Only administrators can change the active election."],
  [/resubmission blocked: result is approved/i, "This result is approved. It must be reopened or corrected before it can be resubmitted."],
  [/resubmission blocked.*pending_review/i, "A correction on this result is under independent review and cannot be overwritten."],
  [/already pending_review/i, "This result is already awaiting independent review."],
  [/independent verification required/i, "Independence rule: the person who corrected or last submitted a result cannot approve it — another verifier must review it."],
  [/illegal transition/i, "That review action is not allowed in the result's current state."],
  [/invalid review action/i, "Unknown review action."],
  [/evidence asset not found/i, "The attached Form EC8 evidence is invalid or belongs to another organization."],
  [/evidence.*mandatory/i, "A photo of the Form EC8 result sheet is required."],
  [/not a candidate of contest|not a registered participant/i, "One of the parties entered is not on this contest's ballot."],
  [/duplicate party/i, "Each party may appear only once in the vote entries."],
  [/negative|must be >= 0|non-?negative/i, "Vote counts must be zero or positive whole numbers."],
  [/malformed vote payload|must be an array/i, "The vote entries could not be read. Please re-enter them."],
  [/result not found in your tenant/i, "The result could not be found."],
  [/contest does not belong to the cycle/i, "The selected contest does not belong to the selected election cycle."],
  [/CLOSED contest cannot be set as the active/i, "A closed contest cannot be made the active contest."],
  [/profile not found/i, "Your account is not linked to an organization member profile."],
];

/**
 * Translate a Postgres/RPC error into a user-safe message (brief §28).
 * Unknown errors are logged with full detail but returned generically.
 */
export function electionErrorMessage(err: unknown, fallback: string): string {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  for (const [pattern, friendly] of DOMAIN_ERRORS) {
    if (pattern.test(message)) return friendly;
  }
  console.error("[election] unhandled domain error:", err);
  return fallback;
}

// ── internal row helpers ─────────────────────────────────────────────────

interface ResultRowLike {
  result_id: string;
  tenant_id: string;
  election_cycle_id: string;
  contest_id: string;
  contest_type: ElectionResult["contest_type"];
  contest_scope_type?: ElectionResult["contest_scope_type"];
  contest_scope_id?: string;
  contest_name?: string;
  polling_unit_id: string;
  ward_id: string;
  lga_id: string;
  status: ElectionResultStatus;
  verified: boolean;
  reviewed_by?: string | null;
  review_notes?: string | null;
  reviewed_at?: string | null;
  evidence_asset_id: string | null;
  submitted_by: string;
  created_at?: string | null;
  updated_at?: string | null;
  vote_details?: ElectionVoteDetail[] | null;
}

/** Compose the application ElectionResult from a view row (§5). */
function composeResult(row: ResultRowLike): ElectionResult {
  const votes: ElectionResultVote[] = (row.vote_details ?? []).map((v) => ({
    result_id: row.result_id,
    contest_id: row.contest_id,
    party_id: v.party_id,
    votes: v.votes,
  }));
  return {
    result_id: row.result_id,
    tenant_id: row.tenant_id,
    election_cycle_id: row.election_cycle_id,
    contest_id: row.contest_id,
    contest_type: row.contest_type,
    contest_scope_type: row.contest_scope_type,
    contest_scope_id: row.contest_scope_id,
    contest_name: row.contest_name,
    polling_unit_id: row.polling_unit_id,
    ward_id: row.ward_id,
    lga_id: row.lga_id,
    status: row.status,
    verified: row.verified,
    reviewed_by: row.reviewed_by ?? null,
    review_notes: row.review_notes ?? null,
    reviewed_at: row.reviewed_at ?? null,
    evidence_asset_id: row.evidence_asset_id,
    submitted_by: row.submitted_by,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    votes,
  };
}

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`${op}: ${error?.message ?? "unknown error"}`);
}

// ── active election / settings (§8, §26) ─────────────────────────────────

export interface ActiveElection {
  /** null when the tenant has no active configuration (settings row absent). */
  cycle: ElectionCycle | null;
  contest: import("@/types").ElectionContest | null;
}

/**
 * Resolve the active cycle + contest from election_settings. Returns
 * { cycle: null, contest: null } when no configuration exists — callers
 * must render an explicit "no active election" state and never fall
 * back to another contest (§8).
 */
export async function getActiveElection(
  supabase: SupabaseClient
): Promise<ActiveElection> {
  const settings = await getElectionSettings(supabase);
  if (!settings?.active_election_cycle_id || !settings.active_contest_id) {
    return { cycle: null, contest: null };
  }
  const [cycle, contest] = await Promise.all([
    getCycle(settings.active_election_cycle_id, supabase),
    getContest(settings.active_contest_id, supabase),
  ]);
  // contest must belong to the active cycle (DB enforces on write; defensive read)
  if (contest && cycle && contest.election_cycle_id !== cycle.id) {
    return { cycle, contest: null };
  }
  return { cycle, contest };
}

/** election_settings row for the caller's tenant (RLS: non-social members). */
export async function getElectionSettings(
  supabase: SupabaseClient
): Promise<ElectionSettings | null> {
  const { data, error } = await supabase
    
    .from("election_settings")
    .select("tenant_id, active_cycle_id, active_contest_id, updated_by, updated_at")
    .maybeSingle();
  if (error) {
    // A missing settings row is a normal pre-configuration state; anything
    // else (RLS denial for social-only, module disabled) also resolves to
    // "no active election" — the caller renders that state explicitly.
    return null;
  }
  if (!data) return null;
  const row = data as {
    tenant_id: string;
    active_cycle_id: string | null;
    active_contest_id: string | null;
    updated_by: string | null;
    updated_at: string;
  };
  return {
    id: row.tenant_id,
    tenant_id: row.tenant_id,
    active_election_cycle_id: row.active_cycle_id,
    active_contest_id: row.active_contest_id,
    updated_by: row.updated_by ?? undefined,
    updated_at: row.updated_at,
  };
}

/** Admin-only active-election configuration via the set_active_election RPC. */
export async function setActiveElection(
  supabase: SupabaseClient,
  cycleId: string,
  contestId: string
): Promise<ElectionSettings> {
  const { data, error } = await supabase.rpc("set_active_election", {
    p_cycle: cycleId,
    p_contest: contestId,
  });
  if (error) fail("setActiveElection", error);
  const row = data as {
    tenant_id: string;
    active_cycle_id: string;
    active_contest_id: string;
    updated_by: string | null;
    updated_at: string;
  };
  return {
    id: row.tenant_id,
    tenant_id: row.tenant_id,
    active_election_cycle_id: row.active_cycle_id,
    active_contest_id: row.active_contest_id,
    updated_by: row.updated_by ?? undefined,
    updated_at: row.updated_at,
  };
}

// ── cycles (§7: cycle → contest chain) ───────────────────────────────────

export async function getElectionCycles(
  supabase: SupabaseClient
): Promise<ElectionCycle[]> {
  const { data, error } = await supabase
    
    .from("election_cycles")
    .select("*")
    .order("year", { ascending: false });
  if (error) fail("getElectionCycles", error);
  return (data ?? []) as ElectionCycle[];
}

export async function getCycle(
  cycleId: string,
  supabase: SupabaseClient
): Promise<ElectionCycle | null> {
  const { data, error } = await supabase
    
    .from("election_cycles")
    .select("*")
    .eq("id", cycleId)
    .maybeSingle();
  if (error) fail("getCycle", error);
  return (data as ElectionCycle) ?? null;
}

// ── contests (contest-aware UI, §7/§19) ──────────────────────────────────

export async function getContestsByCycle(
  cycleId: string,
  supabase: SupabaseClient
): Promise<import("@/types").ElectionContest[]> {
  const { data, error } = await supabase
    
    .from("election_contests")
    .select("*")
    .eq("election_cycle_id", cycleId)
    .order("contest_type");
  if (error) fail("getContestsByCycle", error);
  return (data ?? []).map((c) => {
    const row = c as Record<string, unknown>;
    return {
      ...(row as unknown as import("@/types").ElectionContest),
      // PG stores the constituency LGA set as scope_lgas text[]; the app
      // type keeps the legacy lga_ids field name for UI convenience.
      lga_ids: (row.scope_lgas as string[] | null) ?? [],
    } as import("@/types").ElectionContest;
  });
}

export async function getContest(
  contestId: string,
  supabase: SupabaseClient
): Promise<import("@/types").ElectionContest | null> {
  const { data, error } = await supabase
    
    .from("election_contests")
    .select("*")
    .eq("id", contestId)
    .maybeSingle();
  if (error) fail("getContest", error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    ...(row as unknown as import("@/types").ElectionContest),
    lga_ids: (row.scope_lgas as string[] | null) ?? [],
  } as import("@/types").ElectionContest;
}

// ── parties (§6: party_id is the identity; acronym/name are display) ─────

export async function getPoliticalParties(
  supabase: SupabaseClient
): Promise<PoliticalParty[]> {
  const { data, error } = await supabase
    
    .from("political_parties")
    .select("*")
    .eq("is_active", true)
    .order("acronym");
  if (error) fail("getPoliticalParties", error);
  return (data ?? []).map((p) => {
    const row = p as Record<string, unknown>;
    return {
      id: String(row.id),
      acronym: String(row.acronym),
      name: String(row.name),
      logo_url: (row.logo_url as string | null) ?? null,
      inec_registered: Boolean(row.inec_registered),
      status: row.is_active === false ? "inactive" : "active",
      color: (row.color as string | null) ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    } as PoliticalParty;
  });
}

// ── candidates (the contest ballot — §9 step 4) ──────────────────────────

export async function getCandidatesByContest(
  contestId: string,
  supabase: SupabaseClient
): Promise<ElectionCandidate[]> {
  const { data, error } = await supabase
    
    .from("election_candidates")
    .select("*")
    .eq("contest_id", contestId)
    .order("candidate_name");
  if (error) fail("getCandidatesByContest", error);
  return (data ?? []) as ElectionCandidate[];
}

// ── results (relational reads over the security-invoker view) ────────────

export interface ResultQueryFilter {
  contestId?: string;
  wardId?: string;
  pollingUnitId?: string;
  limit?: number;
}

/**
 * Current results visible to the caller (RLS decides scope — the client
 * filter only narrows what it wants to RENDER, never widens).
 * Votes are the composed relational ballot (§5).
 */
export async function getElectionResults(
  supabase: SupabaseClient,
  filter: ResultQueryFilter = {}
): Promise<ElectionResult[]> {
  let q = supabase
    
    .from("election_results_current")
    .select("*")
    .order("updated_at", { ascending: false });
  if (filter.contestId) q = q.eq("contest_id", filter.contestId);
  if (filter.wardId) q = q.eq("ward_id", filter.wardId);
  if (filter.pollingUnitId) q = q.eq("polling_unit_id", filter.pollingUnitId);
  if (filter.limit) q = q.limit(filter.limit);
  const { data, error } = await q;
  if (error) fail("getElectionResults", error);
  return ((data ?? []) as ResultRowLike[]).map(composeResult);
}

/** Single result with its relational ballot. */
export async function getElectionResult(
  supabase: SupabaseClient,
  resultId: string
): Promise<ElectionResult | null> {
  const { data, error } = await supabase
    
    .from("election_results_current")
    .select("*")
    .eq("result_id", resultId)
    .maybeSingle();
  if (error) fail("getElectionResult", error);
  return data ? composeResult(data as ResultRowLike) : null;
}

/** Append-only forensic history (submitter sees their own; officers/admins tenant-wide). */
export async function getResultHistory(
  supabase: SupabaseClient,
  resultId: string
): Promise<ElectionResultHistory[]> {
  const { data, error } = await supabase
    
    .from("election_result_history")
    .select("*")
    .eq("result_id", resultId)
    .order("created_at", { ascending: true });
  if (error) fail("getResultHistory", error);
  return (data ?? []).map((h) => {
    const row = h as Record<string, unknown>;
    return {
      id: Number(row.id),
      result_id: String(row.result_id),
      action: row.action as ElectionResultHistory["action"],
      actor_id: String(row.actor_id),
      old_status: (row.old_status as ElectionResultStatus | null) ?? null,
      new_status: (row.new_status as ElectionResultStatus | null) ?? null,
      old_votes: (row.old_votes as ElectionResultHistory["old_votes"]) ?? null,
      new_votes: (row.new_votes as ElectionResultHistory["new_votes"]) ?? null,
      old_evidence_asset_id: (row.old_evidence_asset_id as string | null) ?? null,
      new_evidence_asset_id: (row.new_evidence_asset_id as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      created_at: (row.created_at as string | null) ?? null,
    } satisfies ElectionResultHistory;
  });
}

// ── result submission (§9 — RPC is authoritative) ────────────────────────

export interface SubmitElectionResultInput {
  contestId: string;
  /** The authoritative PU id from the relational geography (never client-derived geography). */
  pollingUnitId: string;
  /** One entry per party on the contest ballot; duplicates rejected by the DB. */
  votes: BallotInput;
  /** media_assets.id of the uploaded Form EC8 (Media Service / R2). */
  evidenceAssetId: string;
}

/**
 * Submit/resubmit a PU result through submit_election_result. The RPC
 * derives tenant, module state, geography and scope server-side and
 * returns the authoritative resulting state.
 */
export async function submitElectionResult(
  supabase: SupabaseClient,
  input: SubmitElectionResultInput
): Promise<{ resultId: string; status: ElectionResultStatus; verified: boolean }> {
  const { data, error } = await supabase.rpc("submit_election_result", {
    p_contest: input.contestId,
    p_polling_unit: input.pollingUnitId,
    p_votes: input.votes,
    p_evidence: input.evidenceAssetId,
  });
  if (error) fail("submitElectionResult", error);
  const row = (data as Array<{ result_id: string; status: ElectionResultStatus; verified: boolean }>)[0];
  return { resultId: row.result_id, status: row.status, verified: row.verified };
}

// ── review / verification (§11 — the DB state machine) ───────────────────

export type ReviewAction = "approve" | "reject" | "clarify" | "reopen";

export async function reviewElectionResult(
  supabase: SupabaseClient,
  resultId: string,
  action: ReviewAction,
  notes?: string
): Promise<{ resultId: string; status: ElectionResultStatus; verified: boolean }> {
  const { data, error } = await supabase.rpc("review_election_result", {
    p_result: resultId,
    p_action: action,
    p_notes: notes ?? null,
  });
  if (error) fail("reviewElectionResult", error);
  const row = (data as Array<{ result_id: string; status: ElectionResultStatus; verified: boolean }>)[0];
  return { resultId: row.result_id, status: row.status, verified: row.verified };
}

// ── admin correction (§12 — always pending_review + independent review) ──

export async function correctElectionResult(
  supabase: SupabaseClient,
  resultId: string,
  votes: BallotInput,
  reason?: string
): Promise<{ resultId: string; status: ElectionResultStatus; verified: boolean }> {
  const { data, error } = await supabase.rpc("correct_election_result", {
    p_result: resultId,
    p_votes: votes,
    p_reason: reason ?? null,
  });
  if (error) fail("correctElectionResult", error);
  const row = (data as Array<{ result_id: string; status: ElectionResultStatus; verified: boolean }>)[0];
  return { resultId: row.result_id, status: row.status, verified: row.verified };
}

// ── aggregation (§20/§21 — PostgreSQL, not the browser) ──────────────────

export type AggregateScopeType =
  | "polling_unit"
  | "ward"
  | "lga"
  | "senatorial_zone"
  | "state"
  | "campaign";

/**
 * Authoritative party totals over approved results (and reporting
 * progress) computed inside PostgreSQL from election_result_votes.
 * RLS (security invoker) limits everything to the caller's visibility.
 */
export async function getResultsAggregate(
  supabase: SupabaseClient,
  params: {
    cycleId: string;
    contestId: string;
    scopeType?: AggregateScopeType | null;
    scopeId?: string | null;
  }
): Promise<ElectionAggregate> {
  const { data, error } = await supabase.rpc("get_results_aggregate", {
    p_cycle: params.cycleId,
    p_contest: params.contestId,
    p_scope_type: params.scopeType ?? null,
    p_scope_id: params.scopeId ?? null,
  });
  if (error) fail("getResultsAggregate", error);
  const agg = data as {
    cycle_id: string;
    contest_id: string;
    scope_type: string;
    party_totals: ElectionPartyTotal[];
    approved_pus: number;
    pending_pus: number;
    total_pus_in_scope: number;
    reporting_pct: number;
  };
  return {
    cycle_id: agg.cycle_id,
    contest_id: agg.contest_id,
    scope_type: agg.scope_type,
    party_totals: agg.party_totals ?? [],
    approved_pus: Number(agg.approved_pus ?? 0),
    pending_pus: Number(agg.pending_pus ?? 0),
    total_pus_in_scope: Number(agg.total_pus_in_scope ?? 0),
    reporting_pct: Number(agg.reporting_pct ?? 0),
  };
}

// ── PU reports (§24 — RLS-governed inserts; tenant never in payload) ─────

export interface CreatePUReportInput {
  wardId: string;
  pollingUnitId: string;
  reportType: PUReport["report_type"];
  title: string;
  content: string;
  evidenceAssetId?: string | null;
}

/** Insert is authorized by the pu_reports_insert policy (registered PU or scoped permission). */
export async function createPUReport(
  supabase: SupabaseClient,
  input: CreatePUReportInput
): Promise<PUReport> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Sign in to submit a polling unit report.");
  // Tenant + submitter are resolved SERVER-side (never from a payload):
  // submitted_by must equal auth.uid() and tenant_id must equal the
  // caller's tenant (pu_reports_insert policy); both columns have no
  // server-side defaults.
  const { data: tenantId } = await supabase.rpc("my_tenant_id");
  if (!tenantId) throw new Error("Your account is not linked to an organization.");
  const { data, error } = await supabase
    
    .from("pu_reports")
    .insert({
      tenant_id: tenantId,
      ward_id: input.wardId,
      polling_unit_id: input.pollingUnitId,
      report_type: input.reportType,
      title: input.title,
      content: input.content,
      evidence_asset_id: input.evidenceAssetId ?? null,
      submitted_by: userData.user.id,
    })
    .select("*")
    .single();
  if (error) fail("createPUReport", error);
  return data as PUReport;
}

export type PUReportFilter = { wardId?: string; pollingUnitId?: string };

/**
 * PU reports visible to the caller. RLS already scopes rows
 * (admin/officer tenant-wide; members to their registered PU/ward);
 * filters only narrow rendering.
 */
export async function getPUReports(
  supabase: SupabaseClient,
  filter: PUReportFilter = {}
): Promise<PUReport[]> {
  let q = supabase
    
    .from("pu_reports")
    .select("*")
    .order("created_at", { ascending: false });
  if (filter.wardId) q = q.eq("ward_id", filter.wardId);
  if (filter.pollingUnitId) q = q.eq("polling_unit_id", filter.pollingUnitId);
  const { data, error } = await q;
  if (error) fail("getPUReports", error);
  return (data ?? []) as PUReport[];
}

// ── incidents (§25) ──────────────────────────────────────────────────────

export interface CreateIncidentInput {
  wardId: string;
  pollingUnitId?: string | null;
  incidentType: ElectionIncident["incident_type"];
  severity: ElectionIncident["severity"];
  description: string;
  evidenceAssetId?: string | null;
}

export async function createElectionIncident(
  supabase: SupabaseClient,
  input: CreateIncidentInput
): Promise<ElectionIncident> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("Sign in to report an incident.");
  // Tenant + reporter resolved SERVER-side (never from a payload):
  // reported_by must equal auth.uid() and tenant_id the caller's tenant
  // (incidents_insert policy); both columns have no server-side defaults.
  const { data: tenantId } = await supabase.rpc("my_tenant_id");
  if (!tenantId) throw new Error("Your account is not linked to an organization.");
  const { data, error } = await supabase
    
    .from("election_incidents")
    .insert({
      tenant_id: tenantId,
      ward_id: input.wardId,
      polling_unit_id: input.pollingUnitId ?? null,
      incident_type: input.incidentType,
      severity: input.severity,
      description: input.description,
      evidence_asset_id: input.evidenceAssetId ?? null,
      reported_by: userData.user.id,
    })
    .select("*")
    .single();
  if (error) fail("createElectionIncident", error);
  return data as ElectionIncident;
}

export type IncidentFilter = { wardId?: string; pollingUnitId?: string };

export async function getElectionIncidents(
  supabase: SupabaseClient,
  filter: IncidentFilter = {}
): Promise<ElectionIncident[]> {
  let q = supabase
    
    .from("election_incidents")
    .select("*")
    .order("created_at", { ascending: false });
  if (filter.wardId) q = q.eq("ward_id", filter.wardId);
  if (filter.pollingUnitId) q = q.eq("polling_unit_id", filter.pollingUnitId);
  const { data, error } = await q;
  if (error) fail("getElectionIncidents", error);
  return (data ?? []) as ElectionIncident[];
}

// ── realtime (§23 — scoped subscriptions; RLS filters the stream) ────────

export interface ElectionRealtimeHandle {
  channel: RealtimeChannel;
  unsubscribe: () => void;
}

function subscribeTable(
  supabase: SupabaseClient,
  table: string,
  onChange: () => void,
  onError?: (err: Error) => void
): ElectionRealtimeHandle {
  const channel = supabase
    .channel(`election-${table}`)
    .on(
      "postgres_changes",
      // politicore.* is exposed through the realtime publication; the
      // subscriber receives only rows their RLS authorizes — this is a
      // scoped tenant stream by construction, never a global feed with
      // client-side filtering.
      { event: "*", schema: SCHEMA, table },
      onChange
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" && onError) {
        onError(new Error(`realtime subscription failed for ${table}`));
      }
    });
  return {
    channel,
    unsubscribe: () => {
      void supabase.removeChannel(channel);
    },
  };
}

/** election_results changes (RLS-scoped). Refetch through getElectionResults. */
export function subscribeToElectionResults(
  supabase: SupabaseClient,
  onChange: () => void,
  onError?: (err: Error) => void
): ElectionRealtimeHandle {
  return subscribeTable(supabase, "election_results", onChange, onError);
}

/** pu_reports changes. */
export function subscribeToPUReports(
  supabase: SupabaseClient,
  onChange: () => void,
  onError?: (err: Error) => void
): ElectionRealtimeHandle {
  return subscribeTable(supabase, "pu_reports", onChange, onError);
}

/** election_incidents changes. */
export function subscribeToElectionIncidents(
  supabase: SupabaseClient,
  onChange: () => void,
  onError?: (err: Error) => void
): ElectionRealtimeHandle {
  return subscribeTable(supabase, "election_incidents", onChange, onError);
}

// ── admin configuration (§26 — Election operational config stays in the
//    Election Engine; RLS admin policies are the writers of record) ─────

/** Create an election cycle (tenant admin; tenant from the DB identity). */
export async function createElectionCycle(
  supabase: SupabaseClient,
  input: {
    tenantId: string;
    name: string;
    year: number;
    description?: string;
    status: ElectionCycle["status"];
    startDate?: string;
    endDate?: string;
  }
): Promise<ElectionCycle> {
  const { data, error } = await supabase
    
    .from("election_cycles")
    .insert({
      tenant_id: input.tenantId,
      name: input.name,
      year: input.year,
      description: input.description || null,
      status: input.status,
      start_date: input.startDate || null,
      end_date: input.endDate || null,
    })
    .select("*")
    .single();
  if (error) fail("createElectionCycle", error);
  return data as ElectionCycle;
}

export interface CreateContestInput {
  tenantId: string;
  electionCycleId: string;
  contestType: ElectionResult["contest_type"];
  name: string;
  scopeType: "national" | "state" | "senatorial_zone" | "federal_constituency" | "state_constituency";
  /** uuid of the state row (state scope) or zone id (senatorial scope). */
  scopeId?: string;
  /** LGA id set for constituency scopes (the CHECK requires > 0). */
  scopeLgas?: string[];
  stateId?: string;
  zoneId?: string;
  electionDate?: string;
  /** Display/filter hint only — ballot authority is election_candidates (§6/§9). */
  trackedParties: string[];
}

/**
 * Create a contest. The database CHECK constrains the scope shape and
 * the validate_contest_geography trigger validates semantics; invalid
 * geography is rejected server-side.
 */
export async function createContest(
  supabase: SupabaseClient,
  input: CreateContestInput
): Promise<ElectionContest> {
  const { data, error } = await supabase
    
    .from("election_contests")
    .insert({
      tenant_id: input.tenantId,
      election_cycle_id: input.electionCycleId,
      contest_type: input.contestType,
      name: input.name,
      scope_type: input.scopeType,
      scope_id: input.scopeId ?? null,
      scope_lgas: input.scopeLgas ?? [],
      state_id: input.stateId ?? null,
      zone_id: input.zoneId ?? null,
      election_date: input.electionDate || null,
      tracked_parties: input.trackedParties,
    })
    .select("*")
    .single();
  if (error) fail("createContest", error);
  return data as ElectionContest;
}

/** Contest status control (OPEN/PAUSED/CLOSED) — admin policy governs. */
export async function updateContestStatus(
  supabase: SupabaseClient,
  contestId: string,
  status: "DRAFT" | "OPEN" | "PAUSED" | "CLOSED"
): Promise<void> {
  const { error } = await supabase
    
    .from("election_contests")
    .update({ status })
    .eq("id", contestId);
  if (error) fail("updateContestStatus", error);
}

export interface CreateCandidateInput {
  tenantId: string;
  contestId: string;
  partyId: string;
  candidateName: string;
  runningMateName?: string;
}

/**
 * Register a contest candidate — this is the BALLOT (§6/§9): only
 * candidate parties may appear in submitted votes (native composite FKs).
 */
export async function createCandidate(
  supabase: SupabaseClient,
  input: CreateCandidateInput
): Promise<ElectionCandidate> {
  const { data, error } = await supabase
    
    .from("election_candidates")
    .insert({
      tenant_id: input.tenantId,
      contest_id: input.contestId,
      party_id: input.partyId,
      candidate_name: input.candidateName,
      running_mate_name: input.runningMateName || null,
    })
    .select("*")
    .single();
  if (error) fail("createCandidate", error);
  return data as ElectionCandidate;
}

// ── evidence (§10 — Media Service/R2 via the server route) ───────────────

export interface UploadedEvidence {
  assetId: string;
}

/**
 * Upload Election evidence through the Media Service (server route →
 * R2 → media_assets). Private visibility: access is granted through
 * the signed-access route, never a constructed public URL.
 */
export async function uploadElectionEvidence(
  file: File
): Promise<UploadedEvidence> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/election/evidence", { method: "POST", body });
  if (!res.ok) {
    let message = "Form EC8 evidence upload failed.";
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  const json = (await res.json()) as { assetId: string };
  return { assetId: json.assetId };
}

/**
 * A short-lived URL for viewing private evidence through the signed
 * access route (never a public R2 URL).
 */
export function evidenceViewUrl(assetId: string): string {
  return `/api/election/evidence/${assetId}`;
}
