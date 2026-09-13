"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  getElectionCycles,
  createElectionCycle,
  updateElectionCycle,
  getContestsByCycle,
  createContest,
  updateContest,
  getPoliticalParties,
  createPoliticalParty,
  getElectionSettings,
  setActiveCollationContest,
  getCandidatesByContest,
  createCandidate,
} from "@/lib/firebase/election";
import { getAllLGAs } from "@/lib/constants";
import type {
  ElectionCycle,
  ElectionContest,
  PoliticalParty,
  ElectionSettings,
  ContestType,
  ContestScopeType,
  LGA,
  ElectionCandidate,
} from "@/types";
import {
  Vote,
  Layers,
  Flag,
  UserCheck,
  CheckCircle2,
  AlertCircle,
  Plus,
  Loader2,
  Shield,
  Play,
  Pause,
  XCircle,
  Edit2,
  Globe,
} from "lucide-react";

export default function AdminElectionManagementPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [parties, setParties] = useState<PoliticalParty[]>([]);
  const [settings, setSettings] = useState<ElectionSettings | null>(null);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<
    "contests" | "cycles" | "parties" | "candidates"
  >("contests");

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Form states
  const [showCycleModal, setShowCycleModal] = useState(false);
  const [cycleForm, setCycleForm] = useState({
    id: "",
    name: "",
    year: 2027,
    description: "",
    status: "ACTIVE" as ElectionCycle["status"],
    start_date: "2027-02-20",
    end_date: "2027-03-15",
  });

  const [showContestModal, setShowContestModal] = useState(false);
  const [contestForm, setContestForm] = useState({
    id: "",
    election_cycle_id: "",
    contest_type: "governorship" as ContestType,
    name: "",
    scope_type: "state" as ContestScopeType,
    scope_id: "enugu-state",
    state_id: "enugu-state",
    senatorial_zone_id: "",
    selectedLgas: [] as string[],
    tracked_parties: ["apc", "pdp", "lp", "apga", "adc"],
    focus_party_id: "apc",
  });

  const [showPartyModal, setShowPartyModal] = useState(false);
  const [partyForm, setPartyForm] = useState({
    id: "",
    acronym: "",
    name: "",
    color: "#1B4F72",
    inec_registered: true,
  });

  const [selectedContestForCandidates, setSelectedContestForCandidates] =
    useState<string>("");
  const [candidates, setCandidates] = useState<ElectionCandidate[]>([]);
  const [showCandidateModal, setShowCandidateModal] = useState(false);
  const [candidateForm, setCandidateForm] = useState({
    party_id: "apc",
    candidate_name: "",
    running_mate_name: "",
  });

  // Unified Election Mode Toggle (synced with tenants/ifeanyi-4-nkanu)
  const [electionMode, setElectionMode] = useState<boolean>(true);

  const [submitting, setSubmitting] = useState(false);

  // Auth guard
  useEffect(() => {
    if (authLoading) return;
    if (!profile) {
      router.push("/portal/auth/login");
      return;
    }
    const role = profile.access_role;
    if (
      role !== "admin" &&
      role !== "tenant_super_admin" &&
      role !== "platform_super_admin"
    ) {
      router.push("/portal/dashboard");
    }
  }, [profile, authLoading, router]);

  // Load initial datasets
  useEffect(() => {
    async function loadData() {
      try {
        const lgaData = await getAllLGAs();
        setLgas(lgaData);

        const loadedSettings = await getElectionSettings();
        setSettings(loadedSettings);

        // Fetch current tenant election mode setting
        const { getCurrentTenant } = await import("@/lib/firebase/tenants");
        const { doc, getDoc } = await import("firebase/firestore");
        const { db } = await import("@/lib/firebase/config");
        const tenant = await getCurrentTenant();
        const tenantSnap = await getDoc(doc(db, "tenants", tenant.id));
        if (tenantSnap.exists()) {
          setElectionMode(tenantSnap.data().election_mode_enabled ?? true);
        }

        const loadedCycles = await getElectionCycles();
        setCycles(loadedCycles);

        const defaultCycleId =
          loadedSettings?.active_election_cycle_id ||
          loadedCycles[0]?.id ||
          "general-election-2027";
        setSelectedCycleId(defaultCycleId);

        const loadedContests = await getContestsByCycle(defaultCycleId);
        setContests(loadedContests);

        const loadedParties = await getPoliticalParties();
        setParties(loadedParties);
      } catch (err) {
        console.error("Failed to load admin election settings:", err);
      } finally {
        setLoading(false);
      }
    }
    if (profile) {
      loadData();
    }
  }, [profile]);

  // Reload contests when cycle changes
  useEffect(() => {
    if (!selectedCycleId) return;
    getContestsByCycle(selectedCycleId).then((cList) => {
      setContests(cList);
      if (cList.length > 0 && !selectedContestForCandidates) {
        setSelectedContestForCandidates(cList[0].id);
      }
    });
  }, [selectedCycleId]);

  // Load candidates when contest selection changes
  useEffect(() => {
    if (!selectedContestForCandidates) return;
    getCandidatesByContest(selectedContestForCandidates).then((candList) => {
      setCandidates(candList);
    });
  }, [selectedContestForCandidates]);

  const handleToggleElectionMode = async (enabled: boolean) => {
    if (!profile) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const { getCurrentTenant } = await import("@/lib/firebase/tenants");
      const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase/config");
      const tenant = await getCurrentTenant();
      await setDoc(
        doc(db, "tenants", tenant.id),
        { election_mode_enabled: enabled, updated_at: serverTimestamp() },
        { merge: true }
      );
      setElectionMode(enabled);
      setFeedback({
        type: "success",
        text: `Election Mode has been ${enabled ? "ENABLED" : "DISABLED"} system-wide.`,
      });
    } catch (err: unknown) {
      const errorObj = err as Error;
      setFeedback({
        type: "error",
        text: errorObj.message || "Failed to update Election Mode.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetActiveContest = async (contestId: string) => {
    if (!profile) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await setActiveCollationContest({
        activeCycleId: selectedCycleId,
        activeContestId: contestId,
        userId: profile.id || "admin",
      });
      setSettings((prev) =>
        prev
          ? { ...prev, active_contest_id: contestId }
          : {
              tenant_id: profile.tenant_id || "default",
              active_election_cycle_id: selectedCycleId,
              active_contest_id: contestId,
            }
      );
      setFeedback({
        type: "success",
        text: `Active Collation Contest set to: ${
          contests.find((c) => c.id === contestId)?.name
        }`,
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to update active contest.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleContestStatus = async (
    contest: ElectionContest,
    newStatus: ElectionContest["status"]
  ) => {
    setFeedback(null);
    try {
      await updateContest(contest.id, { status: newStatus });
      setContests((prev) =>
        prev.map((c) => (c.id === contest.id ? { ...c, status: newStatus } : c))
      );
      setFeedback({
        type: "success",
        text: `Contest '${contest.name}' status changed to ${newStatus}`,
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to update contest status.",
      });
    }
  };

  const handleCreateCycleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || !cycleForm.id || !cycleForm.name) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await createElectionCycle({
        ...cycleForm,
        userId: profile.id || "admin",
      });
      const updated = await getElectionCycles();
      setCycles(updated);
      setShowCycleModal(false);
      setFeedback({
        type: "success",
        text: "Election Cycle created successfully!",
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to create cycle.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateContestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || !contestForm.id || !contestForm.name) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await createContest({
        id: contestForm.id,
        election_cycle_id: selectedCycleId,
        contest_type: contestForm.contest_type,
        name: contestForm.name,
        scope_type: contestForm.scope_type,
        scope_id: contestForm.scope_id,
        state_id: contestForm.state_id,
        senatorial_zone_id: contestForm.senatorial_zone_id,
        lga_ids: contestForm.selectedLgas,
        tracked_parties: contestForm.tracked_parties,
        focus_party_id: contestForm.focus_party_id,
        userId: profile.id || "admin",
      });
      const updated = await getContestsByCycle(selectedCycleId);
      setContests(updated);
      setShowContestModal(false);
      setFeedback({
        type: "success",
        text: "Election Contest created & configured successfully!",
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to create contest.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreatePartySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyForm.acronym || !partyForm.name) return;
    const pId = partyForm.acronym.toLowerCase();
    setSubmitting(true);
    setFeedback(null);
    try {
      await createPoliticalParty({
        id: pId,
        acronym: partyForm.acronym.toUpperCase(),
        name: partyForm.name,
        color: partyForm.color,
        inec_registered: partyForm.inec_registered,
        status: "active",
      });
      const updatedParties = await getPoliticalParties();
      setParties(updatedParties);
      setShowPartyModal(false);
      setFeedback({
        type: "success",
        text: `Party ${partyForm.acronym.toUpperCase()} added to Master Registry!`,
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to add party.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateCandidateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedContestForCandidates || !candidateForm.candidate_name) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      await createCandidate({
        tenant_id: profile?.tenant_id || "default",
        contest_id: selectedContestForCandidates,
        party_id: candidateForm.party_id,
        candidate_name: candidateForm.candidate_name,
        running_mate_name: candidateForm.running_mate_name || undefined,
        status: "active",
      });
      const updatedCand = await getCandidatesByContest(
        selectedContestForCandidates
      );
      setCandidates(updatedCand);
      setShowCandidateModal(false);
      setCandidateForm({
        party_id: "apc",
        candidate_name: "",
        running_mate_name: "",
      });
      setFeedback({
        type: "success",
        text: "Candidate added to contest configuration!",
      });
    } catch (err: any) {
      setFeedback({
        type: "error",
        text: err.message || "Failed to add candidate.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="w-10 h-10 text-apc-primary animate-spin" />
        <p className="text-gray-600 font-medium">
          Loading Election Management Engine...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Header */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-apc-primary font-semibold text-xs tracking-wide uppercase mb-1">
            <Shield className="w-4 h-4" />
            <span>ADMIN ELECTION ENGINE MANAGEMENT</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            Election Cycles & Contest Configurator
          </h1>
          <p className="text-gray-600 text-sm mt-1">
            Configure election events, races, INEC party masters, candidates, and active collation contexts.
          </p>
        </div>

        {/* Unified Control Controls: Election Mode & Active Contest */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="bg-gray-50 border p-3 rounded-xl text-xs space-y-1">
            <span className="text-gray-500 font-semibold block">
              System Election Mode:
            </span>
            <button
              onClick={() => handleToggleElectionMode(!electionMode)}
              disabled={submitting}
              className={`px-3 py-1 text-xs font-bold rounded-lg text-white transition-colors ${
                electionMode ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"
              }`}
            >
              {electionMode ? "ENABLED (Live)" : "DISABLED (Off)"}
            </button>
          </div>

          <div className="bg-apc-light border border-apc-primary/30 p-3 rounded-xl text-xs space-y-1">
            <span className="text-gray-500 font-medium block">
              Active Collation Contest:
            </span>
            <span className="font-bold text-apc-primary text-sm block">
              {contests.find((c) => c.id === settings?.active_contest_id)?.name ||
                settings?.active_contest_id ||
                "Not Selected"}
            </span>
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-4 rounded-xl text-sm font-medium border flex items-center gap-2 ${
            feedback.type === "success"
              ? "bg-green-50 text-green-800 border-green-200"
              : "bg-red-50 text-red-800 border-red-200"
          }`}
        >
          {feedback.type === "success" ? (
            <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Cycle Selector Bar */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Layers className="w-5 h-5 text-apc-primary" />
          <span className="text-sm font-bold text-gray-800">
            Selected Election Cycle:
          </span>
          <select
            value={selectedCycleId}
            onChange={(e) => setSelectedCycleId(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm font-semibold text-gray-900 bg-gray-50 focus:ring-2 focus:ring-apc-primary"
          >
            {cycles.map((cy) => (
              <option key={cy.id} value={cy.id}>
                {cy.name} ({cy.year}) — [{cy.status}]
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={() => {
            setCycleForm({
              id: `general-election-${Date.now()}`,
              name: "",
              year: 2027,
              description: "",
              status: "ACTIVE",
              start_date: "2027-02-20",
              end_date: "2027-03-15",
            });
            setShowCycleModal(true);
          }}
          className="px-3.5 py-2 text-xs font-semibold bg-gray-900 text-white hover:bg-black rounded-lg flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Create New Election Cycle
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 gap-6">
        {[
          { id: "contests", label: `Contests & Races (${contests.length})`, icon: Vote },
          { id: "parties", label: `INEC Political Parties (${parties.length})`, icon: Flag },
          { id: "candidates", label: "Candidates Configuration", icon: UserCheck },
          { id: "cycles", label: `Election Cycles (${cycles.length})`, icon: Layers },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 py-3 px-1 border-b-2 text-sm font-bold transition-colors ${
                isActive
                  ? "border-apc-primary text-apc-primary"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: CONTESTS */}
      {activeTab === "contests" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900">
              Contests under {cycles.find((c) => c.id === selectedCycleId)?.name}
            </h2>
            <button
              onClick={() => {
                setContestForm({
                  id: `contest-${Date.now()}`,
                  election_cycle_id: selectedCycleId,
                  contest_type: "governorship",
                  name: "",
                  scope_type: "state",
                  scope_id: "enugu-state",
                  state_id: "enugu-state",
                  senatorial_zone_id: "",
                  selectedLgas: [],
                  tracked_parties: ["apc", "pdp", "lp", "apga", "adc"],
                  focus_party_id: "apc",
                });
                setShowContestModal(true);
              }}
              className="px-4 py-2 bg-apc-primary text-white text-xs font-bold rounded-lg hover:bg-apc-dark flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add New Contest
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {contests.map((c) => {
              const isActiveCollation = settings?.active_contest_id === c.id;

              return (
                <div
                  key={c.id}
                  className={`bg-white rounded-xl border p-5 space-y-4 relative ${
                    isActiveCollation
                      ? "border-2 border-apc-primary shadow-md bg-apc-light/20"
                      : "border-gray-200"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-700">
                        {c.contest_type}
                      </span>
                      <h3 className="text-base font-bold text-gray-900 mt-1">
                        {c.name}
                      </h3>
                      <p className="text-xs text-gray-500">
                        Scope: <span className="font-semibold">{c.scope_type}</span> ({c.scope_id})
                      </p>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      {isActiveCollation ? (
                        <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-apc-primary text-white flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> ACTIVE COLLATION
                        </span>
                      ) : (
                        <button
                          onClick={() => handleSetActiveContest(c.id)}
                          disabled={submitting}
                          className="px-2.5 py-1 text-xs font-bold text-apc-primary border border-apc-primary/40 hover:bg-apc-primary hover:text-white rounded-full transition-colors"
                        >
                          Set as Active Contest
                        </button>
                      )}

                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                          c.status === "OPEN"
                            ? "bg-green-100 text-green-800"
                            : c.status === "PAUSED"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        Status: {c.status}
                      </span>
                    </div>
                  </div>

                  {/* Tracked Parties */}
                  <div className="border-t pt-3">
                    <span className="text-xs font-semibold text-gray-600 block mb-1.5">
                      Tracked Parties for Entry & Analytics:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {c.tracked_parties.map((pid) => (
                        <span
                          key={pid}
                          className="px-2 py-0.5 text-xs font-mono font-bold uppercase rounded bg-gray-100 text-gray-800 border"
                        >
                          {pid}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="border-t pt-3 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          handleToggleContestStatus(
                            c,
                            c.status === "OPEN" ? "PAUSED" : "OPEN"
                          )
                        }
                        className="p-1.5 rounded hover:bg-gray-100 text-gray-700 flex items-center gap-1 font-medium"
                      >
                        {c.status === "OPEN" ? (
                          <>
                            <Pause className="w-3.5 h-3.5 text-amber-600" /> Pause Contest
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5 text-green-600" /> Open Contest
                          </>
                        )}
                      </button>
                    </div>

                    <span className="text-gray-400 font-mono text-[11px]">ID: {c.id}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: PARTIES */}
      {activeTab === "parties" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900">
              INEC Political Party Master Dataset ({parties.length})
            </h2>
            <button
              onClick={() => {
                setPartyForm({
                  id: "",
                  acronym: "",
                  name: "",
                  color: "#1B4F72",
                  inec_registered: true,
                });
                setShowPartyModal(true);
              }}
              className="px-4 py-2 bg-apc-primary text-white text-xs font-bold rounded-lg hover:bg-apc-dark flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add Political Party
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {parties.map((p) => (
              <div
                key={p.id}
                className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex flex-col items-center text-center space-y-2"
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-sm"
                  style={{ backgroundColor: p.color || "#1B4F72" }}
                >
                  {p.acronym}
                </div>
                <div>
                  <h4 className="font-bold text-gray-900 text-sm">{p.acronym}</h4>
                  <p className="text-[11px] text-gray-500 line-clamp-1">{p.name}</p>
                </div>
                <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-green-50 text-green-700 border border-green-200">
                  INEC Registered
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: CANDIDATES */}
      {activeTab === "candidates" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-200">
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold text-gray-800">Select Contest:</span>
              <select
                value={selectedContestForCandidates}
                onChange={(e) => setSelectedContestForCandidates(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-sm font-semibold"
              >
                {contests.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => setShowCandidateModal(true)}
              className="px-4 py-2 bg-apc-primary text-white text-xs font-bold rounded-lg hover:bg-apc-dark flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add Candidate for Contest
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-4 bg-gray-50 border-b font-bold text-sm text-gray-800">
              Registered Candidates for {contests.find((c) => c.id === selectedContestForCandidates)?.name}
            </div>
            {candidates.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">
                No candidates configured for this contest yet.
              </div>
            ) : (
              <div className="divide-y">
                {candidates.map((cand) => (
                  <div key={cand.id} className="p-4 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 text-xs font-mono font-bold uppercase bg-gray-900 text-white rounded">
                          {cand.party_id}
                        </span>
                        <span className="font-bold text-gray-900 text-sm">
                          {cand.candidate_name}
                        </span>
                      </div>
                      {cand.running_mate_name && (
                        <p className="text-xs text-gray-500 mt-1">
                          Running Mate: {cand.running_mate_name}
                        </p>
                      )}
                    </div>
                    <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                      {cand.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: CYCLES */}
      {activeTab === "cycles" && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-4 bg-gray-50 border-b font-bold text-sm text-gray-800">
              Configured Election Cycles
            </div>
            <div className="divide-y">
              {cycles.map((cy) => (
                <div key={cy.id} className="p-4 flex items-center justify-between">
                  <div>
                    <h4 className="font-bold text-gray-900">{cy.name}</h4>
                    <p className="text-xs text-gray-500">{cy.description}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      Start: {cy.start_date} | End: {cy.end_date}
                    </p>
                  </div>
                  <span className="px-3 py-1 text-xs font-bold rounded-full bg-green-100 text-green-800">
                    {cy.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* CREATE CYCLE MODAL */}
      {showCycleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Create Election Cycle</h3>
            <form onSubmit={handleCreateCycleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Cycle ID *</label>
                <input
                  type="text"
                  value={cycleForm.id}
                  onChange={(e) => setCycleForm({ ...cycleForm, id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Cycle Name *</label>
                <input
                  type="text"
                  placeholder="e.g. 2027 General Elections"
                  value={cycleForm.name}
                  onChange={(e) => setCycleForm({ ...cycleForm, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Year</label>
                  <input
                    type="number"
                    value={cycleForm.year}
                    onChange={(e) => setCycleForm({ ...cycleForm, year: parseInt(e.target.value) || 2027 })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Status</label>
                  <select
                    value={cycleForm.status}
                    onChange={(e) => setCycleForm({ ...cycleForm, status: e.target.value as any })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="DRAFT">DRAFT</option>
                    <option value="SCHEDULED">SCHEDULED</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowCycleModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-bold bg-apc-primary text-white rounded-lg hover:bg-apc-dark"
                >
                  Save Cycle
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE CONTEST MODAL */}
      {showContestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-900">Create New Contest</h3>
            <form onSubmit={handleCreateContestSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Contest ID *</label>
                <input
                  type="text"
                  value={contestForm.id}
                  onChange={(e) => setContestForm({ ...contestForm, id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Contest Name *</label>
                <input
                  type="text"
                  placeholder="e.g. 2027 Enugu Governorship Election"
                  value={contestForm.name}
                  onChange={(e) => setContestForm({ ...contestForm, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Contest Type</label>
                  <select
                    value={contestForm.contest_type}
                    onChange={(e) => {
                      const ct = e.target.value as ContestType;
                      let st: ContestScopeType = "state";
                      if (ct === "presidential") st = "national";
                      if (ct === "senatorial") st = "senatorial_zone";
                      if (ct === "federal_house") st = "federal_constituency";
                      if (ct === "state_house") st = "state_constituency";
                      setContestForm({
                        ...contestForm,
                        contest_type: ct,
                        scope_type: st,
                      });
                    }}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="presidential">Presidential</option>
                    <option value="governorship">Governorship</option>
                    <option value="senatorial">Senatorial</option>
                    <option value="federal_house">Federal House</option>
                    <option value="state_house">State House</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Scope Type</label>
                  <input
                    type="text"
                    readOnly
                    value={contestForm.scope_type}
                    className="w-full px-3 py-2 border bg-gray-100 rounded-lg text-xs font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Scope ID / Constituency Name</label>
                <input
                  type="text"
                  value={contestForm.scope_id}
                  onChange={(e) => setContestForm({ ...contestForm, scope_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>

              {/* Tracked Parties Selection */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Select Tracked Parties for this Contest
                </label>
                <div className="flex flex-wrap gap-2 bg-gray-50 p-3 rounded-lg border max-h-32 overflow-y-auto">
                  {parties.map((p) => {
                    const isChecked = contestForm.tracked_parties.includes(p.id);
                    return (
                      <label key={p.id} className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setContestForm({
                                ...contestForm,
                                tracked_parties: [...contestForm.tracked_parties, p.id],
                              });
                            } else {
                              setContestForm({
                                ...contestForm,
                                tracked_parties: contestForm.tracked_parties.filter((x) => x !== p.id),
                              });
                            }
                          }}
                          className="rounded text-apc-primary"
                        />
                        <span>{p.acronym}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowContestModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-bold bg-apc-primary text-white rounded-lg hover:bg-apc-dark"
                >
                  Save Contest
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE PARTY MODAL */}
      {showPartyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Add Political Party to Master</h3>
            <form onSubmit={handleCreatePartySubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Party Acronym *</label>
                <input
                  type="text"
                  placeholder="e.g. LP, APC, PDP"
                  value={partyForm.acronym}
                  onChange={(e) => setPartyForm({ ...partyForm, acronym: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs uppercase"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Official Party Name *</label>
                <input
                  type="text"
                  placeholder="e.g. Labour Party"
                  value={partyForm.name}
                  onChange={(e) => setPartyForm({ ...partyForm, name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Brand Color Code</label>
                <input
                  type="color"
                  value={partyForm.color}
                  onChange={(e) => setPartyForm({ ...partyForm, color: e.target.value })}
                  className="h-10 w-full p-1 border rounded-lg cursor-pointer"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowPartyModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-bold bg-apc-primary text-white rounded-lg hover:bg-apc-dark"
                >
                  Save Party
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE CANDIDATE MODAL */}
      {showCandidateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Add Contest Candidate</h3>
            <form onSubmit={handleCreateCandidateSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Party</label>
                <select
                  value={candidateForm.party_id}
                  onChange={(e) => setCandidateForm({ ...candidateForm, party_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                >
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.acronym} — {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Candidate Full Name *</label>
                <input
                  type="text"
                  placeholder="e.g. Dr. Ifeanyi Nkanu"
                  value={candidateForm.candidate_name}
                  onChange={(e) => setCandidateForm({ ...candidateForm, candidate_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Running Mate / Deputy (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Chief John Doe"
                  value={candidateForm.running_mate_name}
                  onChange={(e) => setCandidateForm({ ...candidateForm, running_mate_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setShowCandidateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-bold bg-apc-primary text-white rounded-lg hover:bg-apc-dark"
                >
                  Save Candidate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
