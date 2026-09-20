"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
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

import { useAuth } from "@/contexts/AuthContext";
import {
  ElectionResultDoc,
  ElectionResultStatus,
  reviewElectionResult,
  subscribeToElectionResults,
  getElectionCycles,
  getContestsByCycle,
} from "@/lib/firebase/election";
import { getEnuguElectoralData } from "@/lib/firebase/electoral";
import type {
  EnuguStateElectoralData,
  PollingUnit,
  ElectionContest,
  ElectionCycle,
} from "@/types";

export default function ElectionOperationsPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();

  const [electoralData, setElectoralData] = useState<EnuguStateElectoralData | null>(null);
  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("all");
  const [selectedContestId, setSelectedContestId] = useState<string>("all");

  const [results, setResults] = useState<ElectionResultDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedResult, setSelectedResult] = useState<ElectionResultDoc | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [submittingAction, setSubmittingAction] = useState(false);

  // Fetch electoral data taxonomy and contests
  useEffect(() => {
    async function init() {
      const eData = await getEnuguElectoralData();
      if (eData) setElectoralData(eData);

      const cycList = await getElectionCycles();
      setCycles(cycList);

      if (cycList.length > 0) {
        const cList = await getContestsByCycle(cycList[0].id);
        setContests(cList);
      }
    }
    init();
  }, []);

  // Reload contests when cycle changes
  useEffect(() => {
    if (selectedCycleId === "all") {
      if (cycles.length > 0) {
        getContestsByCycle(cycles[0].id).then((cList) => setContests(cList));
      }
    } else {
      getContestsByCycle(selectedCycleId).then((cList) => setContests(cList));
    }
  }, [selectedCycleId, cycles]);

  // Helper map for Ward and Polling Unit labels
  const getElectoralLabels = (wardId: string, puId: string, lgaId?: string) => {
    if (!electoralData) {
      return { lga: lgaId || "Enugu State", ward: wardId, pu: puId };
    }

    let lgaName = "";
    let wardName = "";
    let puName = "";

    for (const lga of electoralData.lgas) {
      if (lgaId && lga.id === lgaId) {
        lgaName = lga.name;
      }
      for (const ward of lga.wards) {
        if (ward.id === wardId) {
          if (!lgaName) lgaName = lga.name;
          wardName = ward.name;
          const pu = ward.pollingUnits.find((p: PollingUnit) => p.id === puId);
          if (pu) puName = pu.name;
          break;
        }
      }
      if (wardName) break;
    }

    return {
      lga: lgaName || lgaId || "Enugu State",
      ward: wardName || wardId,
      pu: puName || puId,
    };
  };

  // Auth Protection Check: Strictly Election Officer per J-E2-4 & Spec §27
  useEffect(() => {
    if (authLoading) return;

    if (!profile) {
      router.replace("/portal/auth/login");
      return;
    }

    const isSocialOnly =
      profile?.membership_types?.includes("social_member") &&
      !profile?.membership_types?.includes("campaign_member") &&
      profile.access_role !== "election_officer" &&
      profile.access_role !== "admin" &&
      profile.access_role !== "tenant_super_admin" &&
      profile.access_role !== "platform_super_admin";

    if (isSocialOnly) {
      router.replace("/portal/dashboard");
      return;
    }

    if (profile.access_role !== "election_officer") {
      router.replace("/portal/dashboard");
    }
  }, [profile, authLoading, router]);

  // Subscribe to real-time election results
  useEffect(() => {
    if (!profile) return;

    const tenantId = profile.tenant_id || "default";
    const scopeConstraint = selectedContestId !== "all" ? { contest_id: selectedContestId } : undefined;

    const unsubscribe = subscribeToElectionResults(
      tenantId,
      (data) => {
        setResults(data);
        setLoading(false);
      },
      (err) => {
        console.error("Failed to subscribe to results:", err);
        setLoading(false);
      },
      scopeConstraint
    );

    return () => unsubscribe();
  }, [profile, selectedContestId]);

  if (authLoading || loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="w-10 h-10 text-emerald-600 animate-spin" />
        <p className="text-slate-600 font-medium">Loading Election Operations Desk...</p>
      </div>
    );
  }

  const filteredResults = results.filter((res) => {
    if (selectedContestId !== "all" && res.contest_id && res.contest_id !== selectedContestId) {
      return false;
    }
    if (statusFilter === "all") return true;
    return res.status === statusFilter;
  });

  const handleReview = async (action: "approve" | "reject" | "clarify" | "reopen") => {
    if (!selectedResult || !profile) return;

    if ((action === "reject" || action === "clarify") && !reviewNotes.trim()) {
      toast.warning(
        `Please provide notes explaining why this result is marked ${action}.`,
      );
      return;
    }

    setSubmittingAction(true);

    try {
      await reviewElectionResult({
        resultDocId: selectedResult.id,
        officerUserId: profile.id || "officer",
        action,
        notes: reviewNotes.trim(),
        existingDoc: selectedResult,
      });

      toast.success(
        `Result successfully marked as ${action.toUpperCase()}.`,
      );
      setReviewNotes("");
      setSelectedResult(null);
    } catch (err: unknown) {
      console.error("Review action error:", err);
      toast.error(
        getErrorMessage(err, "We couldn't process the review action. Please try again."),
      );
    } finally {
      setSubmittingAction(false);
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
      case "submitted":
      case "pending_review":
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Pending Review
          </span>
        );
    }
  };

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
            Review submitted polling unit results against Form EC8 physical evidence before official collation.
          </p>
        </div>

        {/* Quick Stats Pill */}
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
                const labels = getElectoralLabels(res.ward_id, res.polling_unit_id, res.lga_id);
                const isSelected = selectedResult?.id === res.id;
                const totalVotes = res.results.reduce((acc, curr) => acc + (curr.votes || 0), 0);
                const contestObj = contests.find((c) => c.id === res.contest_id);

                return (
                  <div
                    key={res.id}
                    onClick={() => {
                      setSelectedResult(res);
                      setReviewNotes(res.review_notes || "");
                    }}
                    className={`p-4 cursor-pointer transition-colors hover:bg-slate-50 flex items-center justify-between gap-4 ${
                      isSelected ? "bg-emerald-50/60 border-l-4 border-emerald-600" : ""
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 text-sm">{labels.pu}</span>
                        {getStatusBadge(res.status)}
                      </div>
                      <div className="text-[11px] font-semibold text-emerald-800">
                        Contest: {contestObj?.name || res.contest_id || "State Contest"}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-slate-500">
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3 text-slate-400" /> {labels.lga}
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-slate-400" /> Ward: {labels.ward}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 font-medium pt-1">
                        Total Cast Votes: <span className="text-slate-900 font-bold">{totalVotes}</span> | Submitter ID: {res.submitted_by}
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
              <p className="text-sm">Select a submission from the queue to view Form EC8 evidence & perform officer review.</p>
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Inspection Panel</span>
                  {getStatusBadge(selectedResult.status)}
                </div>
                {(() => {
                  const labels = getElectoralLabels(selectedResult.ward_id, selectedResult.polling_unit_id, selectedResult.lga_id);
                  const contestObj = contests.find((c) => c.id === selectedResult.contest_id);
                  return (
                    <div className="space-y-1">
                      <div className="text-xs font-bold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-200">
                        Contest: {contestObj?.name || selectedResult.contest_id || "General Contest"}
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 pt-1">{labels.pu}</h3>
                      <p className="text-xs text-slate-500">{labels.lga} LGA • Ward {labels.ward}</p>
                    </div>
                  );
                })()}
              </div>

              {/* Submitter Info Specs (Sec 53) */}
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs space-y-1">
                <div className="flex items-center gap-1.5 text-slate-700 font-semibold">
                  <User className="w-3.5 h-3.5 text-slate-400" />
                  <span>Submitter ID:</span> {selectedResult.submitted_by}
                </div>
                {selectedResult.created_at ? (
                  <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    <span>Submission Time:</span> {String(selectedResult.created_at)}
                  </div>
                ) : null}
              </div>

              {/* Form EC8 Preview */}
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-700 block">Form EC8 Result Sheet Evidence</span>
                {selectedResult.cloudinary_url ? (
                  <div className="relative aspect-[4/3] rounded-xl overflow-hidden border border-slate-200 bg-slate-900">
                    <img
                      src={selectedResult.cloudinary_url}
                      alt="Form EC8 Evidence"
                      className="w-full h-full object-contain"
                    />
                    <a
                      href={selectedResult.cloudinary_url}
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

              {/* Party Breakdown Table */}
              <div className="space-y-2">
                <span className="text-xs font-semibold text-slate-700 block">Submitted Party Vote Count</span>
                <div className="bg-slate-50 rounded-xl p-3 border border-slate-200 space-y-1.5">
                  {selectedResult.results.map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-slate-200 last:border-0">
                      <span className="font-bold uppercase text-slate-800">{r.party}</span>
                      <span className="font-mono font-bold text-emerald-700 text-sm">{r.votes.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Review Notes Input */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 block">Officer Notes / Clarification Reason</label>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="Enter officer notes or reasons for rejection / clarification request..."
                  rows={3}
                  className="w-full text-xs p-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Action Buttons */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <span className="text-xs font-semibold text-slate-700 block">Officer Decision</span>
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
              </div>

              {/* Audit Trail History */}
              {selectedResult.history && selectedResult.history.length > 0 && (
                <div className="space-y-2 pt-3 border-t border-slate-100">
                  <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                    <History className="w-3.5 h-3.5 text-slate-500" /> Audit Trail ({selectedResult.history.length})
                  </span>
                  <div className="space-y-2 max-h-40 overflow-y-auto text-xs bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                    {selectedResult.history.map((item, idx) => (
                      <div key={idx} className="border-b border-slate-200 pb-1.5 last:border-0 last:pb-0">
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span className="font-semibold text-slate-700">Action: {item.action}</span>
                          <span>{new Date(item.edited_at as string).toLocaleTimeString()}</span>
                        </div>
                        {item.notes && <p className="text-slate-600 text-[11px] mt-0.5">{String(item.notes)}</p>}
                        {item.reason && <p className="text-slate-600 text-[11px] mt-0.5">Reason: {String(item.reason)}</p>}
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
