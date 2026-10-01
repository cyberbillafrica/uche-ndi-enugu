"use client";

/**
 * POLITICORE — Admin Election Management (Phase 2 cutover: PostgreSQL).
 *
 * Configuration authority stays in the Election Engine (§26): cycles,
 * contests, candidates and the ACTIVE election live in politicore.*
 * tables governed by admin RLS policies; the active cycle+contest is
 * set through the set_active_election RPC (admin-only, cross-tenant
 * and cycle-membership guarded server-side). Party master data is
 * platform-level (0014 design) — tenant admins no longer invent
 * parties; they add CANDIDATES to contest ballots (§6), which is the
 * relational ballot rule.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import {
  electionErrorMessage,
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
  getElectionCycles,
  getContestsByCycle,
  getPoliticalParties,
  getCandidatesByContest,
  getElectionSettings,
  setActiveElection,
  createElectionCycle,
  createContest,
  createCandidate,
  updateContestStatus,
} from "@/lib/supabase";
import { listLgas, listZones } from "@/lib/supabase/geography";
import type {
  ElectionCandidate,
  ElectionContest,
  ElectionCycle,
  ElectionSettings,
  PoliticalParty,
} from "@/types";
import {
  Vote,
  Layers,
  Flag,
  UserCheck,
  CheckCircle2,
  Plus,
  Loader2,
  Shield,
  Play,
  Pause,
  XCircle,
} from "lucide-react";

type TabId = "contests" | "cycles" | "parties" | "candidates";

interface GeoOption {
  id: string;
  name: string;
  state_id?: string;
}

export default function AdminElectionManagementPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();

  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [profileTenantId, setProfileTenantId] = useState<string>("");

  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [parties, setParties] = useState<PoliticalParty[]>([]);
  const [settings, setSettings] = useState<ElectionSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<TabId>("contests");

  // Forms
  const [showCycleModal, setShowCycleModal] = useState(false);
  const [cycleForm, setCycleForm] = useState({
    name: "",
    year: 2027,
    description: "",
    status: "ACTIVE" as ElectionCycle["status"],
    start_date: "2027-02-20",
    end_date: "2027-03-15",
  });

  const [showContestModal, setShowContestModal] = useState(false);
  const [contestForm, setContestForm] = useState<{
    name: string;
    contest_type: ElectionContest["contest_type"];
    scope_type: ElectionContest["scope_type"];
    scope_id: string;
    scope_lgas: string[];
    state_id: string;
    zone_id: string;
    tracked_parties: string[];
  }>({
    name: "",
    contest_type: "governorship",
    scope_type: "state",
    scope_id: "",
    scope_lgas: [],
    state_id: "",
    zone_id: "",
    tracked_parties: [],
  });

  const [selectedContestForCandidates, setSelectedContestForCandidates] = useState<string>("");
  const [candidates, setCandidates] = useState<ElectionCandidate[]>([]);
  const [showCandidateModal, setShowCandidateModal] = useState(false);
  const [candidateForm, setCandidateForm] = useState({
    party_id: "",
    candidate_name: "",
    running_mate_name: "",
  });

  const [zones, setZones] = useState<GeoOption[]>([]);
  const [lgas, setLgas] = useState<GeoOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // ── auth + gate (admin only, §13) ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (authLoading) return;
      if (!profile) {
        router.replace("/portal/auth/login");
        return;
      }
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
      if (!access.allowed || access.authority !== "admin") {
        setGate("denied");
        setLoading(false);
        return;
      }
      setProfileTenantId(access.profile?.tenant_id ?? "");
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, authLoading, router]);

  // ── initial load ───────────────────────────────────────────────────
  useEffect(() => {
    if (gate !== "ready" || !profileTenantId) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      try {
        const [loadedSettings, loadedCycles, loadedParties, zoneList, lgaList] =
          await Promise.all([
            getElectionSettings(supabase),
            getElectionCycles(supabase),
            getPoliticalParties(supabase),
            listZones(undefined, supabase),
            listLgas({}, supabase),
          ]);
        if (cancelled) return;
        setSettings(loadedSettings);
        setCycles(loadedCycles);
        setParties(loadedParties);
        setZones(zoneList);
        setLgas(lgaList);
        const defaultCycleId = loadedSettings?.active_election_cycle_id || loadedCycles[0]?.id || "";
        setSelectedCycleId(defaultCycleId);
        if (defaultCycleId) {
          const loadedContests = await getContestsByCycle(defaultCycleId, supabase);
          if (cancelled) return;
          setContests(loadedContests);
        }
      } catch (err) {
        console.error("Failed to load admin election settings:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, profileTenantId]);

  // Reload contests when cycle changes
  useEffect(() => {
    if (gate !== "ready" || !selectedCycleId) return;
    let cancelled = false;
    getContestsByCycle(selectedCycleId, getSupabaseClient())
      .then((cList) => {
        if (cancelled) return;
        setContests(cList);
        if (cList.length > 0 && !selectedContestForCandidates) {
          setSelectedContestForCandidates(cList[0].id);
        }
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCycleId, gate]);

  // Load candidates when contest selection changes
  useEffect(() => {
    if (gate !== "ready" || !selectedContestForCandidates) return;
    let cancelled = false;
    getCandidatesByContest(selectedContestForCandidates, getSupabaseClient())
      .then((candList) => {
        if (!cancelled) setCandidates(candList);
      })
      .catch((err) => console.error(err));
    return () => {
      cancelled = true;
    };
  }, [selectedContestForCandidates, gate]);

  // ── actions ────────────────────────────────────────────────────────

  const handleSetActiveContest = async (contestId: string) => {
    setSubmitting(true);
    try {
      const updated = await setActiveElection(getSupabaseClient(), selectedCycleId, contestId);
      setSettings(updated);
      toast.success(
        `Active collation contest set to: ${
          contests.find((c) => c.id === contestId)?.name
        }`
      );
    } catch (err) {
      console.error(err);
      toast.error(
        electionErrorMessage(err, "We couldn't update the active contest. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleContestStatus = async (
    contest: ElectionContest,
    newStatus: ElectionContest["status"]
  ) => {
    try {
      await updateContestStatus(getSupabaseClient(), contest.id, newStatus);
      setContests((prev) =>
        prev.map((c) => (c.id === contest.id ? { ...c, status: newStatus } : c))
      );
      toast.success(`Contest '${contest.name}' status changed to ${newStatus}`);
    } catch (err) {
      console.error(err);
      toast.error(
        electionErrorMessage(err, "We couldn't update the contest status. Please try again.")
      );
    }
  };

  const handleCreateCycleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cycleForm.name) return;
    setSubmitting(true);
    try {
      await createElectionCycle(getSupabaseClient(), {
        tenantId: profileTenantId,
        name: cycleForm.name,
        year: cycleForm.year,
        description: cycleForm.description,
        status: cycleForm.status,
        startDate: cycleForm.start_date,
        endDate: cycleForm.end_date,
      });
      const updated = await getElectionCycles(getSupabaseClient());
      setCycles(updated);
      setShowCycleModal(false);
      toast.success("Election cycle created successfully.");
    } catch (err) {
      console.error(err);
      toast.error(
        electionErrorMessage(err, "We couldn't create the election cycle. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateContestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contestForm.name) return;
    setSubmitting(true);
    try {
      await createContest(getSupabaseClient(), {
        tenantId: profileTenantId,
        electionCycleId: selectedCycleId,
        contestType: contestForm.contest_type,
        name: contestForm.name,
        scopeType: contestForm.scope_type,
        scopeId: contestForm.scope_id || undefined,
        scopeLgas: contestForm.scope_lgas,
        stateId: contestForm.state_id || undefined,
        zoneId: contestForm.zone_id || undefined,
        trackedParties: contestForm.tracked_parties,
      });
      const updated = await getContestsByCycle(selectedCycleId, getSupabaseClient());
      setContests(updated);
      setShowContestModal(false);
      toast.success("Election contest created and configured successfully.");
    } catch (err) {
      console.error(err);
      toast.error(
        electionErrorMessage(err, "We couldn't create the contest. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateCandidateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedContestForCandidates || !candidateForm.candidate_name || !candidateForm.party_id)
      return;
    setSubmitting(true);
    try {
      await createCandidate(getSupabaseClient(), {
        tenantId: profileTenantId,
        contestId: selectedContestForCandidates,
        partyId: candidateForm.party_id,
        candidateName: candidateForm.candidate_name,
        runningMateName: candidateForm.running_mate_name || undefined,
      });
      const updatedCand = await getCandidatesByContest(
        selectedContestForCandidates,
        getSupabaseClient()
      );
      setCandidates(updatedCand);
      setShowCandidateModal(false);
      setCandidateForm({ party_id: "", candidate_name: "", running_mate_name: "" });
      toast.success("Candidate added to the contest ballot.");
    } catch (err) {
      console.error(err);
      toast.error(
        electionErrorMessage(err, "We couldn't add the candidate. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── render ─────────────────────────────────────────────────────────
  if (authLoading || loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="w-10 h-10 text-brand-primary animate-spin" />
        <p className="text-gray-600 font-medium">Loading Election Management Engine...</p>
      </div>
    );
  }

  if (gate === "no_session" || gate === "denied") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
          <Shield className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">Administrator access required</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Election configuration is restricted to tenant administrators. The
          database enforces this boundary directly.
        </p>
      </div>
    );
  }

  const partyById = new Map(parties.map((p) => [p.id, p]));

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Header */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-brand-primary font-semibold text-xs tracking-wide uppercase mb-1">
            <Shield className="w-4 h-4" />
            <span>ADMIN ELECTION ENGINE MANAGEMENT</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            Election Cycles & Contest Configurator
          </h1>
          <p className="text-gray-600 text-sm mt-1">
            Configure election events, races, contest ballots (candidates), and
            the active collation context.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="bg-brand-surface border border-brand-primary/30 p-3 rounded-xl text-xs space-y-1">
            <span className="text-gray-500 font-medium block">Active Collation Contest:</span>
            <span className="font-bold text-brand-primary text-sm block">
              {contests.find((c) => c.id === settings?.active_contest_id)?.name ||
                settings?.active_contest_id ||
                "Not Selected"}
            </span>
          </div>
        </div>
      </div>

      {/* Cycle Selector Bar */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-200 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Layers className="w-5 h-5 text-brand-primary" />
          <span className="text-sm font-bold text-gray-800">Selected Election Cycle:</span>
          <select
            value={selectedCycleId}
            onChange={(e) => setSelectedCycleId(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm font-semibold text-gray-900 bg-gray-50 focus:ring-2 focus:ring-brand-primary"
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
        {(
          [
            { id: "contests", label: `Contests & Races (${contests.length})`, icon: Vote },
            { id: "parties", label: `INEC Political Parties (${parties.length})`, icon: Flag },
            { id: "candidates", label: "Contest Ballot (Candidates)", icon: UserCheck },
            { id: "cycles", label: `Election Cycles (${cycles.length})`, icon: Layers },
          ] as Array<{ id: TabId; label: string; icon: typeof Vote }>
        ).map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 py-3 px-1 border-b-2 text-sm font-bold transition-colors ${
                isActive
                  ? "border-brand-primary text-brand-primary"
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
                  name: "",
                  contest_type: "governorship",
                  scope_type: "state",
                  scope_id: "",
                  scope_lgas: [],
                  state_id: "",
                  zone_id: "",
                  tracked_parties: [],
                });
                setShowContestModal(true);
              }}
              className="px-4 py-2 bg-brand-primary text-white text-xs font-bold rounded-lg hover:bg-brand-primary flex items-center gap-2"
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
                      ? "border-2 border-brand-primary shadow-md bg-brand-surface/20"
                      : "border-gray-200"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-700">
                        {c.contest_type}
                      </span>
                      <h3 className="text-base font-bold text-gray-900 mt-1">{c.name}</h3>
                      <p className="text-xs text-gray-500">
                        Scope: <span className="font-semibold">{c.scope_type}</span> (
                        {c.scope_id || "state-wide"})
                      </p>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      {isActiveCollation ? (
                        <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-brand-primary text-white flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> ACTIVE COLLATION
                        </span>
                      ) : (
                        <button
                          onClick={() => handleSetActiveContest(c.id)}
                          disabled={submitting}
                          className="px-2.5 py-1 text-xs font-bold text-brand-primary border border-brand-primary/40 hover:bg-brand-primary hover:text-white rounded-full transition-colors"
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

                  {/* Tracked parties — display/filter hint (ballot = candidates, §6) */}
                  <div className="border-t pt-3">
                    <span className="text-xs font-semibold text-gray-600 block mb-1.5">
                      Tracked Parties (display hint — ballot comes from Candidates):
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

                  <div className="border-t pt-3 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          handleToggleContestStatus(c, c.status === "OPEN" ? "PAUSED" : "OPEN")
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
                    <span className="text-gray-400 font-mono text-[11px]">ID: {c.id.slice(0, 8)}…</span>
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
          <div className="p-4 bg-sky-50 border border-sky-200 rounded-xl text-xs text-sky-900">
            The party registry is platform-level master data seeded from the INEC
            register (managed by platform administrators). To put a party on a
            contest&apos;s ballot, add a <strong>Candidate</strong> in the next tab —
            only ballot parties can receive votes.
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

      {/* TAB 3: CANDIDATES (the contest ballot) */}
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
              className="px-4 py-2 bg-brand-primary text-white text-xs font-bold rounded-lg hover:bg-brand-primary flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> Add Candidate for Contest
            </button>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="p-4 bg-gray-50 border-b font-bold text-sm text-gray-800">
              Registered Candidates for{" "}
              {contests.find((c) => c.id === selectedContestForCandidates)?.name}
            </div>
            {candidates.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">
                No candidates configured for this contest yet — the ballot is
                empty, so result submission is blocked until candidates exist.
              </div>
            ) : (
              <div className="divide-y">
                {candidates.map((cand) => (
                  <div key={cand.id} className="p-4 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 text-xs font-mono font-bold uppercase bg-gray-900 text-white rounded">
                          {partyById.get(cand.party_id)?.acronym ?? cand.party_id.slice(0, 8)}
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
                      active
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
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Cycle Name *
                </label>
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
                    onChange={(e) =>
                      setCycleForm({ ...cycleForm, year: parseInt(e.target.value) || 2027 })
                    }
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Status</label>
                  <select
                    value={cycleForm.status}
                    onChange={(e) =>
                      setCycleForm({
                        ...cycleForm,
                        status: e.target.value as ElectionCycle["status"],
                      })
                    }
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
                  className="px-4 py-2 text-xs font-bold bg-brand-primary text-white rounded-lg hover:bg-brand-primary"
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
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Contest Name *
                </label>
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
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Contest Type
                  </label>
                  <select
                    value={contestForm.contest_type}
                    onChange={(e) => {
                      const ct = e.target.value as ElectionContest["contest_type"];
                      let st: ElectionContest["scope_type"] = "state";
                      if (ct === "presidential") st = "national";
                      if (ct === "senatorial") st = "senatorial_zone";
                      if (ct === "federal_house") st = "federal_constituency";
                      if (ct === "state_house") st = "state_constituency";
                      setContestForm({ ...contestForm, contest_type: ct, scope_type: st });
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
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Scope Type
                  </label>
                  <input
                    type="text"
                    readOnly
                    value={contestForm.scope_type}
                    className="w-full px-3 py-2 border bg-gray-100 rounded-lg text-xs font-mono"
                  />
                </div>
              </div>

              {(contestForm.scope_type === "state" || contestForm.scope_type === "senatorial_zone") && (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    {contestForm.scope_type === "state" ? "State" : "Senatorial Zone"} *
                  </label>
                  <select
                    value={contestForm.scope_id}
                    onChange={(e) =>
                      setContestForm({
                        ...contestForm,
                        scope_id: e.target.value,
                        zone_id:
                          contestForm.scope_type === "senatorial_zone" ? e.target.value : "",
                        state_id:
                          contestForm.scope_type === "state" ? e.target.value : contestForm.state_id,
                      })
                    }
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                    required
                  >
                    <option value="">Select…</option>
                    {(contestForm.scope_type === "state"
                      ? lgas.length > 0
                        ? [{ id: lgas[0].state_id ?? "enugu-state", name: "Enugu State" }]
                        : []
                      : zones
                    ).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {(contestForm.scope_type === "federal_constituency" ||
                contestForm.scope_type === "state_constituency") && (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Constituency LGAs * (at least one)
                  </label>
                  <div className="flex flex-wrap gap-2 bg-gray-50 p-3 rounded-lg border max-h-32 overflow-y-auto">
                    {lgas.map((l) => {
                      const checked = contestForm.scope_lgas.includes(l.id);
                      return (
                        <label key={l.id} className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setContestForm({
                                ...contestForm,
                                scope_lgas: e.target.checked
                                  ? [...contestForm.scope_lgas, l.id]
                                  : contestForm.scope_lgas.filter((x) => x !== l.id),
                              })
                            }
                            className="rounded text-brand-primary"
                          />
                          <span>{l.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Tracked Parties (display hint)
                </label>
                <div className="flex flex-wrap gap-2 bg-gray-50 p-3 rounded-lg border max-h-32 overflow-y-auto">
                  {parties.map((p) => {
                    const isChecked = contestForm.tracked_parties.includes(p.acronym);
                    return (
                      <label
                        key={p.id}
                        className="flex items-center gap-1.5 text-xs font-medium cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) =>
                            setContestForm({
                              ...contestForm,
                              tracked_parties: e.target.checked
                                ? [...contestForm.tracked_parties, p.acronym]
                                : contestForm.tracked_parties.filter((x) => x !== p.acronym),
                            })
                          }
                          className="rounded text-brand-primary"
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
                  className="px-4 py-2 text-xs font-bold bg-brand-primary text-white rounded-lg hover:bg-brand-primary"
                >
                  Save Contest
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
            <h3 className="text-lg font-bold text-gray-900">Add Contest Candidate (Ballot Entry)</h3>
            <form onSubmit={handleCreateCandidateSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Party *</label>
                <select
                  value={candidateForm.party_id}
                  onChange={(e) => setCandidateForm({ ...candidateForm, party_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                >
                  <option value="">Select party…</option>
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.acronym} — {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Candidate Full Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Dr. Ifeanyi Nkanu"
                  value={candidateForm.candidate_name}
                  onChange={(e) =>
                    setCandidateForm({ ...candidateForm, candidate_name: e.target.value })
                  }
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Running Mate / Deputy (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Chief John Doe"
                  value={candidateForm.running_mate_name}
                  onChange={(e) =>
                    setCandidateForm({ ...candidateForm, running_mate_name: e.target.value })
                  }
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
                  className="px-4 py-2 text-xs font-bold bg-brand-primary text-white rounded-lg hover:bg-brand-primary"
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
