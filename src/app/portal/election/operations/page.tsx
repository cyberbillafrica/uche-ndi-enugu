"use client";

/**
 * POLITICORE — Election Operations / Review Desk (Phase 2 cutover).
 *
 * Officer review through the review_election_result RPC — the DATABASE
 * state machine is authoritative (§11): approve/reject/clarify legal
 * from submitted/pending_review/reopened, reopen only from approved,
 * and independent re-verification after corrections is enforced
 * server-side. Illegal actions surface the database's own error text
 * (translated, §28); the UI never invents transitions.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import {
  CheckCircle,
  XCircle,
  HelpCircle,
  RotateCcw,
  FileText,
  ShieldAlert,
  Loader2,
  Eye,
  Filter,
  Building2,
  MapPin,
  History,
  Vote,
  Clock,
  User,
} from "lucide-react";

import {
  electionErrorMessage,
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
  getActiveElection,
  getElectionCycles,
  getContestsByCycle,
  getElectionResults,
  getResultHistory,
  reviewElectionResult,
  subscribeToElectionResults,
  evidenceViewUrl,
  type ReviewAction,
} from "@/lib/supabase";
import { resolveScopeLabels } from "@/lib/supabase/geography";
import type {
  ElectionContest,
  ElectionCycle,
  ElectionResult,
  ElectionResultHistory,
  ElectionResultStatus,
} from "@/types";

export default function ElectionOperationsPage() {
  const router = useRouter();
  const toast = useToast();

  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [labelCache, setLabelCache] = useState<Map<string, string>>(new Map());

  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [selectedContestId, setSelectedContestId] = useState<string>("all");

  const [results, setResults] = useState<ElectionResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<ElectionResult | null>(null);
  const [partiesById, setPartiesById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [history, setHistory] = useState<ElectionResultHistory[]>([]);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submittingAction, setSubmittingAction] = useState(false);

  // ── access gate: Election Officer authority required (§13) ─────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bridge = await ensureSupabaseSession();
      if (cancelled) return;
      if (!bridge.sessionReady) {
        setGate(bridge.reason === "no_session" ? "no_session" : "denied");
        setLoading(false);
        return;
      }
      const supabase = bridge.supabase ?? getSupabaseClient();
      const access = await resolveElectionAccess(supabase);
      if (cancelled) return;
      // Verification authority = admin or election_officer (the resolver
      // question verify_election_result answers this authoritatively; the
      // page gate mirrors it for UX while the RPC remains the boundary).
      const verifier =
        access.allowed &&
        (access.authority === "admin" || access.authority === "election_officer");
      if (!verifier) {
        setGate("denied");
        setLoading(false);
        return;
      }
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ── initial load: active election ──────────────────────────────────
  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      try {
        const active = await getActiveElection(supabase);
        if (cancelled) return;
        const cycs = await getElectionCycles(supabase);
        if (cancelled) return;
        setCycles(cycs);
        if (active.cycle && active.contest) {
          setSelectedCycleId(active.cycle.id);
          setSelectedContestId(active.contest.id);
          const cList = await getContestsByCycle(active.cycle.id, supabase);
          if (cancelled) return;
          setContests(cList);
        } else if (cycs.length > 0) {
          setSelectedCycleId(cycs[0].id);
          const cList = await getContestsByCycle(cycs[0].id, supabase);
          if (cancelled) return;
          setContests(cList);
        }
        // party label map (relational votes resolve to acronym via id)
        const { getPoliticalParties } = await import("@/lib/supabase/election");
        const ps = await getPoliticalParties(supabase);
        if (cancelled) return;
        setPartiesById(new Map(ps.map((p) => [p.id, p.acronym])));
      } catch (err) {
        console.error("Failed to load operations data:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  // ── cycle change reload ────────────────────────────────────────────
  useEffect(() => {
    if (gate !== "ready" || !selectedCycleId) return;
    let cancelled = false;
    (async () => {
      const cList = await getContestsByCycle(selectedCycleId, getSupabaseClient()).catch(() => []);
      if (!cancelled) setContests(cList);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCycleId, gate]);

  // ── results fetch + realtime (§23) ─────────────────────────────────
  const fetchResults = useCallback(async () => {
    try {
      const rows = await getElectionResults(getSupabaseClient(), {
        contestId: selectedContestId !== "all" ? selectedContestId : undefined,
      });
      setResults(rows);
      setLoading(false);
    } catch (err) {
      console.error("Failed to load results:", err);
      setLoading(false);
    }
  }, [selectedContestId]);

  useEffect(() => {
    if (gate !== "ready") return;
    let unsub: (() => void) | null = null;
    (async () => {
      await fetchResults();
      const handle = subscribeToElectionResults(getSupabaseClient(), () => void fetchResults());
      unsub = handle.unsubscribe;
    })();
    return () => unsub?.();
  }, [gate, fetchResults]);

  // ── geography labels from the relational services (§18/§30) ────────
  const getLabels = useCallback(
    async (wardId: string, puId: string): Promise<{ ward: string; pu: string }> => {
      const key = `${wardId}/${puId}`;
      const cached = labelCache.get(key);
      if (cached) {
        const [ward, pu] = cached.split("|");
        return { ward, pu };
      }
      try {
        const [wardLabels, puLabels] = await Promise.all([
          wardId ? resolveScopeLabels("ward", wardId, getSupabaseClient()) : Promise.resolve([]),
          resolveScopeLabels("polling_unit", puId, getSupabaseClient()),
        ]);
        const ward = wardLabels.slice(-1)[0] ?? wardId;
        const pu = puLabels.slice(-1)[0] ?? puId;
        setLabelCache((prev) => new Map(prev).set(key, `${ward}|${pu}`));
        return { ward, pu };
      } catch {
        return { ward: wardId, pu: puId };
      }
    },
    [labelCache]
  );

  const [rowLabels, setRowLabels] = useState<Map<string, { ward: string; pu: string }>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = new Map<string, { ward: string; pu: string }>();
      for (const r of results.slice(0, 200)) {
        const l = await getLabels(r.ward_id, r.polling_unit_id);
        next.set(r.result_id, l);
      }
      if (!cancelled) setRowLabels(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [results, getLabels]);

  const filteredResults = results.filter((res) => {
    if (selectedContestId !== "all" && res.contest_id !== selectedContestId) return false;
    if (statusFilter === "all") return true;
    return res.status === statusFilter;
  });

  // ── review through the RPC — DB state machine decides (§11) ────────
  const handleReview = async (action: ReviewAction) => {
    if (!selectedResult) return;
    if ((action === "reject" || action === "clarify") && !reviewNotes.trim()) {
      toast.warning(`Please provide notes explaining why this result is marked ${action}.`);
      return;
    }
    setSubmittingAction(true);
    try {
      const outcome = await reviewElectionResult(
        getSupabaseClient(),
        selectedResult.result_id,
        action,
        reviewNotes.trim() || undefined
      );
      toast.success(`Result successfully marked as ${outcome.status.toUpperCase()}.`);
      setReviewNotes("");
      setSelectedResult(null);
      setHistory([]);
      await fetchResults();
    } catch (err) {
      console.error("Review action error:", err);
      toast.error(
        electionErrorMessage(err, "We couldn't process the review action. Please try again.")
      );
    } finally {
      setSubmittingAction(false);
    }
  };

  const openResult = async (res: ElectionResult) => {
    setSelectedResult(res);
    setReviewNotes(res.review_notes ?? "");
    setHistory([]);
    try {
      const h = await getResultHistory(getSupabaseClient(), res.result_id);
      setHistory(h);
    } catch (err) {
      console.error("History load failed:", err);
    }
  };

  const getStatusBadge = (status: ElectionResultStatus) => {
    switch (status) {
      case "approved":
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
            <CheckCircle className="w-3.5 h-3.5" /> Approved (Official)
          </span>
        );
      case "rejected":
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">
            <XCircle className="w-3.5 h-3.5" /> Rejected
          </span>
        );
      case "clarification_required":
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
            <HelpCircle className="w-3.5 h-3.5" /> Clarification Required
          </span>
        );
      case "reopened":
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-800 border border-purple-200">
            <RotateCcw className="w-3.5 h-3.5" /> Reopened
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />{" "}
            {status === "pending_review" ? "Pending Review (corrected)" : "Submitted"}
          </span>
        );
    }
  };

  if (gate === "loading" || loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="w-10 h-10 text-emerald-600 animate-spin" />
        <p className="text-slate-600 font-medium">Loading Election Operations Desk...</p>
      </div>
    );
  }

  if (gate === "no_session") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <ShieldAlert className="w-10 h-10 text-amber-500 mx-auto" />
        <h2 className="text-lg font-bold text-gray-900">Sign in required</h2>
        <button
          onClick={() => router.replace("/portal/auth/login")}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-apc-primary text-white"
        >
          Go to sign in
        </button>
      </div>
    );
  }

  if (gate === "denied") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">Operations Desk restricted</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Result review and verification requires Election Officer authority (or
          an explicit verification grant). This boundary is enforced by the
          database, not the interface.
        </p>
      </div>
    );
  }

  const selectedLabels = selectedResult
    ? rowLabels.get(selectedResult.result_id)
    : undefined;

  return (
    <div className="space-y-6 max-w-7xl mx-auto p-4 md:p-6">
      {/* Header */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-emerald-700 font-semibold text-sm mb-1">
            <ShieldAlert className="w-4 h-4" />
            <span>ELECTION COMMAND OPERATIONS</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900">
            Form EC8 Inspection & Audit Desk
          </h1>
          <p className="text-slate-600 text-sm mt-1">
            Review submitted polling unit results against Form EC8 physical
            evidence before official collation. Transitions follow the
            database-enforced state machine.
          </p>
        </div>

        <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs">
          <div>
            <span className="text-slate-500 block">Pending Queue</span>
            <span className="text-lg font-bold text-amber-600">
              {results.filter((r) => r.status === "submitted" || r.status === "pending_review").length}
            </span>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <span className="text-slate-500 block">Approved</span>
            <span className="text-lg font-bold text-emerald-600">
              {results.filter((r) => r.status === "approved").length}
            </span>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <span className="text-slate-500 block">Total Submissions</span>
            <span className="text-lg font-bold text-slate-800">{results.length}</span>
          </div>
        </div>
      </div>

      {/* Contest & Status Filter Toolbar */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Vote className="w-4 h-4 text-emerald-600" />
            <span className="text-xs font-bold text-slate-700">Contest:</span>
            <select
              value={selectedContestId}
              onChange={(e) => setSelectedContestId(e.target.value)}
              className="px-3 py-1.5 text-xs font-bold rounded-lg border border-slate-300 bg-slate-50 text-slate-900"
            >
              <option value="all">All Contests</option>
              {contests.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Filter className="w-4 h-4 text-slate-500" />
          {[
            { id: "all", label: "All Results" },
            { id: "submitted", label: "Pending Review" },
            { id: "approved", label: "Approved" },
            { id: "rejected", label: "Rejected" },
            { id: "clarification_required", label: "Clarification Required" },
            { id: "reopened", label: "Reopened" },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setStatusFilter(item.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                statusFilter === item.id
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Grid / Table */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left List */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 font-semibold text-slate-800 text-sm flex items-center justify-between">
            <span>Results Submissions ({filteredResults.length})</span>
            <span className="text-xs text-slate-500 font-normal">
              Click any item to inspect Form EC8 evidence
            </span>
          </div>

          {filteredResults.length === 0 ? (
            <div className="p-12 text-center text-slate-500 text-sm">
              No election submissions match the selected contest and status filter.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[700px] overflow-y-auto">
              {filteredResults.map((res) => {
                const labels = rowLabels.get(res.result_id);
                const isSelected = selectedResult?.result_id === res.result_id;
                const totalVotes = res.votes.reduce((acc, v) => acc + v.votes, 0);

                return (
                  <div
                    key={res.result_id}
                    onClick={() => void openResult(res)}
                    className={`p-4 cursor-pointer transition-colors hover:bg-slate-50 flex items-center justify-between gap-4 ${
                      isSelected ? "bg-emerald-50/60 border-l-4 border-emerald-600" : ""
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 text-sm">
                          {labels?.pu ?? res.polling_unit_id}
                        </span>
                        {getStatusBadge(res.status)}
                      </div>
                      <div className="text-[11px] font-semibold text-emerald-800">
                        Contest: {res.contest_name || res.contest_id}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3 text-slate-400" /> {res.lga_id}
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-slate-400" /> Ward:{" "}
                          {labels?.ward ?? res.ward_id}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 font-medium pt-1">
                        Total Cast Votes:{" "}
                        <span className="text-slate-900 font-bold">{totalVotes}</span> | Submitter
                        ID: {res.submitted_by.slice(0, 8)}…
                      </div>
                    </div>

                    <button className="px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-100/70 hover:bg-emerald-200 rounded-lg flex items-center gap-1 shrink-0">
                      <Eye className="w-3.5 h-3.5" /> Inspect
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Detail / Inspection Panel */}
        <div className="lg:col-span-1 bg-white rounded-2xl shadow-sm border border-slate-200 p-5 space-y-5">
          {!selectedResult ? (
            <div className="flex flex-col items-center justify-center min-h-[400px] text-center text-slate-400 space-y-3">
              <FileText className="w-12 h-12 stroke-[1.5]" />
              <p className="text-sm">
                Select a submission from the queue to view Form EC8 evidence & perform officer
                review.
              </p>
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Inspection Panel
                  </span>
                  {getStatusBadge(selectedResult.status)}
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-bold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-200">
                    Contest: {selectedResult.contest_name || selectedResult.contest_id}
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 pt-1">
                    {selectedLabels?.pu ?? selectedResult.polling_unit_id}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {selectedResult.lga_id} LGA • Ward{" "}
                    {selectedLabels?.ward ?? selectedResult.ward_id}
                  </p>
                </div>
              </div>

              {/* Submitter Info */}
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs space-y-1">
                <div className="flex items-center gap-1.5 text-slate-700 font-semibold">
                  <User className="w-3.5 h-3.5 text-slate-400" />
                  <span>Submitter ID:</span> {selectedResult.submitted_by.slice(0, 8)}…
                </div>
                {selectedResult.created_at ? (
                  <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    <span>Submission Time:</span>{" "}
                    {new Date(selectedResult.created_at).toLocaleString()}
                  </div>
                ) : null}
              </div>

              {/* Form EC8 Preview — signed private access (§10) */}
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-700 block">
                  Form EC8 Result Sheet Evidence
                </span>
                {selectedResult.evidence_asset_id ? (
                  <div className="relative aspect-[4/3] rounded-xl overflow-hidden border border-slate-200 bg-slate-900">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={evidenceViewUrl(selectedResult.evidence_asset_id)}
                      alt="Form EC8 Evidence"
                      className="w-full h-full object-contain"
                    />
                    <a
                      href={evidenceViewUrl(selectedResult.evidence_asset_id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute bottom-2 right-2 px-2.5 py-1 text-xs bg-black/75 text-white rounded-md hover:bg-black font-medium backdrop-blur-sm"
                    >
                      Open Full Image
                    </a>
                  </div>
                ) : (
                  <div className="p-6 bg-slate-100 rounded-xl text-center text-xs text-slate-500 border border-dashed border-slate-300">
                    No physical Form EC8 image attached to this submission.
                  </div>
                )}
              </div>

              {/* Party Breakdown — relational votes resolved to acronyms (§6) */}
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-700 block">
                  Submitted Party Vote Count
                </span>
                <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-1.5">
                  {selectedResult.votes.length === 0 ? (
                    <p className="text-xs text-slate-400 py-2 text-center">
                      No ballot rows recorded.
                    </p>
                  ) : (
                    selectedResult.votes.map((v) => (
                      <div
                        key={v.party_id}
                        className="flex items-center justify-between text-xs py-1 border-b border-slate-200 last:border-0"
                      >
                        <span className="font-bold uppercase text-slate-800">
                          {partiesById.get(v.party_id) ?? v.party_id.slice(0, 8)}
                        </span>
                        <span className="font-mono font-bold text-emerald-700 text-sm">
                          {v.votes.toLocaleString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Review Notes */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 block">
                  Officer Notes / Clarification Reason
                </label>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="Enter officer notes or reasons for rejection / clarification request..."
                  rows={3}
                  className="w-full text-xs p-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Action Buttons — the DB decides legality (§11) */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <span className="text-xs font-semibold text-slate-700 block">
                  Officer Decision
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleReview("approve")}
                    disabled={submittingAction}
                    className="px-3 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <CheckCircle className="w-4 h-4" /> Approve Result
                  </button>
                  <button
                    onClick={() => handleReview("reject")}
                    disabled={submittingAction}
                    className="px-3 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <XCircle className="w-4 h-4" /> Reject Result
                  </button>
                  <button
                    onClick={() => handleReview("clarify")}
                    disabled={submittingAction}
                    className="px-3 py-2 text-xs font-bold text-amber-800 bg-amber-100 hover:bg-amber-200 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <HelpCircle className="w-4 h-4" /> Request Clarification
                  </button>
                  <button
                    onClick={() => handleReview("reopen")}
                    disabled={submittingAction}
                    className="px-3 py-2 text-xs font-bold text-purple-800 bg-purple-100 hover:bg-purple-200 rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    <RotateCcw className="w-4 h-4" /> Reopen Result
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 pt-1">
                  Approved results must be reopened before resubmission; corrected results
                  pending independent review cannot be overwritten. Illegal transitions are
                  refused by the database.
                </p>
              </div>

              {/* Audit Trail */}
              {history.length > 0 && (
                <div className="space-y-2 pt-3 border-t border-slate-100">
                  <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                    <History className="w-3.5 h-3.5 text-slate-500" /> Audit Trail ({history.length})
                  </span>
                  <div className="space-y-2 max-h-40 overflow-y-auto text-xs bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                    {history.map((item) => (
                      <div
                        key={item.id}
                        className="border-b border-slate-200 pb-1.5 last:border-0 last:pb-0"
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-700">
                            Action: {item.action} · {item.old_status ?? "—"} →{" "}
                            {item.new_status ?? "—"}
                          </span>
                          <span>
                            {item.created_at
                              ? new Date(item.created_at).toLocaleTimeString()
                              : ""}
                          </span>
                        </div>
                        {item.notes && (
                          <p className="text-slate-600 text-[11px] mt-0.5">{item.notes}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
