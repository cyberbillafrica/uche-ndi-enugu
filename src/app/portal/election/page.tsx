"use client";

/**
 * POLITICORE — Election Dashboard (Phase 2 cutover: PostgreSQL/Supabase).
 *
 * A client of the Election Engine through src/lib/supabase/election.ts:
 *   * contest-aware (cycle → contest chain, §7) with the ACTIVE contest
 *     from election_settings — never a silent fallback (§8);
 *   * official totals via get_results_aggregate (PostgreSQL aggregation
 *     over election_result_votes — never client-side totals, §20);
 *   * operational results from the security-invoker view (RLS-scoped);
 *   * realtime via Supabase (RLS-scoped) triggering a refetch (§23);
 *   * admin correction via correct_election_result (pending_review +
 *     independent re-verification, §12);
 *   * evidence viewed through the signed-access route (§10).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  AlertCircle,
  CheckCircle2,
  Upload,
  AlertTriangle,
  Bell,
  Eye,
  Edit3,
  X,
  History,
  Loader2,
  Lock,
  Vote,
  Layers,
  ArrowRightLeft,
  Filter,
} from "lucide-react";

import { HelpLink } from "@/components/help/HelpLink";
import { useToast } from "@/components/ui/toast";
import { electionErrorMessage } from "@/lib/supabase/election";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
  getActiveElection,
  getElectionCycles,
  getContestsByCycle,
  getPoliticalParties,
  getElectionResults,
  getResultHistory,
  getResultsAggregate,
  correctElectionResult,
  subscribeToElectionResults,
  evidenceViewUrl,
  type ElectionAuthority,
} from "@/lib/supabase";
import type {
  ElectionAggregate,
  ElectionContest,
  ElectionCycle,
  ElectionPartyTotal,
  ElectionResult,
  ElectionResultHistory,
  PoliticalParty,
} from "@/types";

interface AlertToast {
  id: string;
  puName: string;
  wardName: string;
  partyTotals: Array<{ acronym: string; votes: number }>;
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "Submitted",
  pending_review: "Pending Review",
  approved: "Approved",
  rejected: "Rejected",
  clarification_required: "Clarification",
  reopened: "Reopened",
};

export default function ElectionDashboard() {
  const router = useRouter();
  const toast = useToast();

  // Gate state (database-resolved: module + social-only + authority, §14/§16)
  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [authority, setAuthority] = useState<ElectionAuthority>("none");
  const [isAdmin, setIsAdmin] = useState(false);

  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [parties, setParties] = useState<PoliticalParty[]>([]);
  const [results, setResults] = useState<ElectionResult[]>([]);
  const [activeCycleId, setActiveCycleId] = useState<string>("");
  const [activeContestId, setActiveContestId] = useState<string>("");
  const [noActiveElection, setNoActiveElection] = useState(false);

  const [loading, setLoading] = useState(true);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const [aggregate, setAggregate] = useState<ElectionAggregate | null>(null);

  // Contest-aware selection (never "all" ambiguity for official totals)
  const [selectedContestId, setSelectedContestId] = useState<string>("");

  // Modals
  const [toastAlerts, setToastAlerts] = useState<AlertToast[]>([]);
  const [inspectResult, setInspectResult] = useState<ElectionResult | null>(null);
  const [inspectHistory, setInspectHistory] = useState<ElectionResultHistory[]>([]);
  const [editingResult, setEditingResult] = useState<ElectionResult | null>(null);
  const [editVotes, setEditVotes] = useState<Array<{ party_id: string; acronym: string; votes: number }>>([]);
  const [editReason, setEditReason] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // ── access gate (§14/§16) ──────────────────────────────────────────
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
      if (!access.allowed) {
        setGate("denied");
        setLoading(false);
        return;
      }
      setAuthority(access.authority);
      setIsAdmin(access.authority === "admin");
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ── initial load: active election + parties ────────────────────────
  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      try {
        const [active, partyList] = await Promise.all([
          getActiveElection(supabase),
          getPoliticalParties(supabase),
        ]);
        if (cancelled) return;
        setParties(partyList);
        if (!active.cycle || !active.contest) {
          // No active configuration: explicit empty state, no fallback (§8).
          setNoActiveElection(true);
          setLoading(false);
          return;
        }
        const cycs = await getElectionCycles(supabase);
        if (cancelled) return;
        setCycles(cycs);
        setActiveCycleId(active.cycle.id);
        setActiveContestId(active.contest.id);
        setSelectedContestId(active.contest.id);
        const cList = await getContestsByCycle(active.cycle.id, supabase);
        if (cancelled) return;
        setContests(cList);
        setNoActiveElection(false);
      } catch (err) {
        console.error("Failed to load election dashboard data:", err);
        if (!cancelled) setNoActiveElection(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  // ── contest change: reload contests for the cycle ──────────────────
  const selectedCycle = cycles.find((c) => c.id === activeCycleId) ?? null;
  const currentContest = contests.find((c) => c.id === selectedContestId) ?? null;

  // ── results fetch + realtime (§23) ─────────────────────────────────
  const fetchResults = useCallback(async () => {
    const supabase = getSupabaseClient();
    try {
      const rows = await getElectionResults(supabase, {
        contestId: selectedContestId || undefined,
      });
      setResults(rows);
      setListenerError(null);
    } catch (err) {
      console.error("Failed to load results:", err);
      setListenerError("Live results could not be loaded. Please refresh to retry.");
    }
  }, [selectedContestId]);

  useEffect(() => {
    if (gate !== "ready" || !selectedContestId) return;
    let unsub: (() => void) | null = null;
    (async () => {
      await fetchResults();
      const handle = subscribeToElectionResults(
        getSupabaseClient(),
        () => void fetchResults(),
        () =>
          setListenerError(
            "Live data stream disconnected. Please refresh the page to retry."
          )
      );
      unsub = handle.unsubscribe;
    })();
    return () => unsub?.();
  }, [gate, selectedContestId, fetchResults]);

  // ── official aggregation — PostgreSQL, over approved results (§20) ─
  useEffect(() => {
    if (gate !== "ready" || !activeCycleId || !selectedContestId) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      try {
        const agg = await getResultsAggregate(supabase, {
          cycleId: activeCycleId,
          contestId: selectedContestId,
          scopeType: null,
          scopeId: null,
        });
        if (!cancelled) setAggregate(agg);
      } catch (err) {
        console.error("Aggregation failed:", err);
        if (!cancelled) setAggregate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, activeCycleId, selectedContestId, results]);

  // Refresh aggregation after every result change (realtime refetch also
  // triggers this via the results dependency).

  // ── approval toast on realtime updates ─────────────────────────────
  const lastApprovedRef = useRef(0);
  useEffect(() => {
    if (results.length === 0) return;
    const newest = results[0]; // ordered updated_at desc by the service
    const ts = newest.updated_at ? new Date(newest.updated_at).getTime() : 0;
    // Track the newest timestamp seen so only FRESH approvals toast.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- cross-render mutable watermark, not derived state
    if (ts > lastApprovedRef.current) {
      const isFirstLoad = lastApprovedRef.current === 0;
      lastApprovedRef.current = ts;
      if (!isFirstLoad && newest.status === "approved") {
        const alert: AlertToast = {
          id: `${newest.result_id}_${ts}`,
          puName: newest.polling_unit_id,
          wardName: newest.ward_id,
          partyTotals: (currentContest?.tracked_parties ?? []).map((acronym) => ({
            acronym,
            votes:
              newest.votes
                .filter((v) => parties.find((p) => p.id === v.party_id)?.acronym === acronym)
                .reduce((sum, v) => sum + v.votes, 0) || 0,
          })),
        };
        setToastAlerts((prev) => [...prev, alert]);
        setTimeout(() => {
          setToastAlerts((prev) => prev.filter((a) => a.id !== alert.id));
        }, 6000);
      }
    }
  }, [results, currentContest, parties]);

  // ── derived views ──────────────────────────────────────────────────
  const trackedParties = currentContest?.tracked_parties ?? [];
  const partyByAcronym = useMemo(() => {
    const m = new Map<string, PoliticalParty>();
    for (const p of parties) m.set(p.acronym.toUpperCase(), p);
    return m;
  }, [parties]);

  const getPartyColor = (acronym: string): string => {
    const found = partyByAcronym.get(acronym.toUpperCase());
    if (found?.color) return found.color;
    const key = acronym.toLowerCase();
    if (key === "apc") return "#1B4F72";
    if (key === "pdp") return "#27AE60";
    if (key === "lp") return "#D35400";
    if (key === "apga") return "#8E44AD";
    if (key === "adc") return "#F39C12";
    return "#34495E";
  };

  const operationalSubmissions = results; // RLS-scoped; contest filter applied in query
  const officialApproved = useMemo(
    () => operationalSubmissions.filter((r) => r.status === "approved"),
    [operationalSubmissions]
  );

  // Per-PU votes by party acronym (relational votes resolved to labels for display)
  const votesByAcronym = (r: ElectionResult): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const v of r.votes) {
      const acronym = parties.find((p) => p.id === v.party_id)?.acronym ?? v.party_id;
      out[acronym.toUpperCase()] = v.votes;
    }
    return out;
  };

  const wardChartData = useMemo(() => {
    const wardMap = new Map<string, Record<string, unknown>>();
    for (const r of officialApproved) {
      const wardName = r.ward_id;
      if (!wardMap.has(wardName)) {
        const initObj: Record<string, unknown> = { ward: wardName };
        for (const p of trackedParties) initObj[p.toUpperCase()] = 0;
        wardMap.set(wardName, initObj);
      }
      const entry = wardMap.get(wardName)!;
      for (const v of r.votes) {
        const acronym =
          parties.find((p) => p.id === v.party_id)?.acronym ?? v.party_id;
        const k = acronym.toUpperCase();
        entry[k] = ((entry[k] as number) || 0) + v.votes;
      }
    }
    return Array.from(wardMap.values());
  }, [officialApproved, trackedParties, parties]);

  const pieChartData: Array<{ name: string; value: number }> = useMemo(
    () =>
      (aggregate?.party_totals ?? []).map((t: ElectionPartyTotal) => ({
        name: t.acronym,
        value: t.total_votes,
      })),
    [aggregate]
  );

  const partyTotalByAcronym = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of aggregate?.party_totals ?? []) m.set(t.acronym.toUpperCase(), t.total_votes);
    return m;
  }, [aggregate]);

  const comparePartyA = trackedParties[0] ?? "";
  const comparePartyB = trackedParties[1] ?? comparePartyA;
  const votesA = partyTotalByAcronym.get(comparePartyA.toUpperCase()) ?? 0;
  const votesB = partyTotalByAcronym.get(comparePartyB.toUpperCase()) ?? 0;
  const marginAB = votesA - votesB;

  const pendingCount = operationalSubmissions.filter(
    (r) => r.status === "submitted" || r.status === "pending_review"
  ).length;
  const rejectedCount = operationalSubmissions.filter((r) => r.status === "rejected").length;
  const clarifyCount = operationalSubmissions.filter(
    (r) => r.status === "clarification_required"
  ).length;
  const reopenedCount = operationalSubmissions.filter((r) => r.status === "reopened").length;

  // ── admin correction (§12 — RPC; DB forces pending_review) ─────────
  const openInspect = async (r: ElectionResult) => {
    setInspectResult(r);
    setInspectHistory([]);
    try {
      const hist = await getResultHistory(getSupabaseClient(), r.result_id);
      setInspectHistory(hist);
    } catch (err) {
      console.error("History load failed:", err);
    }
  };

  const handleSaveCorrection = async () => {
    if (!editingResult) return;
    setSavingEdit(true);
    try {
      await correctElectionResult(
        getSupabaseClient(),
        editingResult.result_id,
        editVotes.map((v) => ({ party_id: v.party_id, votes: v.votes })),
        editReason || undefined
      );
      toast.success(
        "Correction saved. The result is pending independent re-verification by an Election Officer."
      );
      setEditingResult(null);
      setEditReason("");
      await fetchResults();
    } catch (err) {
      console.error("Failed to correct election result:", err);
      toast.error(
        electionErrorMessage(err, "We couldn't save the correction. Please try again.")
      );
    } finally {
      setSavingEdit(false);
    }
  };

  // ── gate render states ─────────────────────────────────────────────
  if (gate === "loading" || loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-3">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="text-sm text-gray-500">
          Connecting to the election results engine...
        </span>
      </div>
    );
  }

  if (gate === "no_session") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <AlertCircle className="w-10 h-10 text-amber-500 mx-auto" />
        <h2 className="text-lg font-bold text-gray-900">Sign in required</h2>
        <p className="text-sm text-gray-600">
          Sign in through the portal to view Election results.
        </p>
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
          <Lock className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">Election access denied</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Your account does not have Election access, or the Election module is
          not enabled for your organization. A direct URL cannot bypass this
          check — authorization is enforced by the database.
        </p>
      </div>
    );
  }

  if (noActiveElection) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
          <Vote className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">No Active Election</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          No active election cycle and contest has been configured. An
          administrator can set it in Election Management.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto">
      {/* Toast Alert Container */}
      <div className="fixed bottom-5 right-5 z-50 space-y-3 max-w-sm w-full pointer-events-none">
        {toastAlerts.map((a) => (
          <div
            key={a.id}
            className="bg-white border-2 border-apc-primary rounded-xl shadow-xl p-4 pointer-events-auto animate-in slide-in-from-bottom-5 duration-300"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 text-apc-primary font-bold text-sm">
                <Bell className="h-4 w-4 animate-bounce" />
                <span>New Official Result Approved</span>
              </div>
              <button
                onClick={() =>
                  setToastAlerts((prev) => prev.filter((item) => item.id !== a.id))
                }
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-xs font-semibold text-gray-900">{a.puName}</p>
            <p className="text-xs text-gray-500">Ward: {a.wardName}</p>
            <div className="mt-2 grid grid-cols-3 gap-2 bg-gray-50 p-2 rounded-lg text-center text-xs font-semibold">
              {a.partyTotals.map((t) => (
                <div key={t.acronym}>
                  <span className="text-gray-500 uppercase">{t.acronym}: </span>
                  <span className="text-gray-900">{t.votes}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {listenerError && (
        <div className="p-4 bg-amber-50 text-amber-900 border border-amber-200 rounded-xl flex items-center justify-between text-xs font-semibold">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            <span>{listenerError}</span>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 font-bold"
          >
            Refresh Page
          </button>
        </div>
      )}

      {/* Contest Selector & Active Election Header (§7/§8) */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-apc-primary font-semibold text-xs tracking-wide uppercase mb-1">
            <Vote className="w-4 h-4" />
            <span>CONTEST-AWARE ELECTION DASHBOARD</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
              Official Results & Operational Collation
            </h1>
            <HelpLink article="election-dashboard" label="Election guide" />
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {selectedCycle ? `${selectedCycle.name} · ` : ""}
            {currentContest ? currentContest.name : ""} — official totals are
            calculated strictly from{" "}
            <span className="font-bold text-emerald-700">APPROVED</span> results.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <div className="flex items-center gap-1.5 bg-gray-50 p-2 rounded-xl border border-gray-200 max-w-full min-w-0">
            <Layers className="w-4 h-4 text-gray-500 shrink-0" />
            <select
              value={activeCycleId}
              onChange={async (e) => {
                const cycleId = e.target.value;
                setActiveCycleId(cycleId);
                const supabase = getSupabaseClient();
                const cList = await getContestsByCycle(cycleId, supabase);
                setContests(cList);
                if (cList.length > 0) setSelectedContestId(cList[0].id);
              }}
              className="text-xs font-bold text-gray-900 bg-transparent border-0 focus:ring-0 cursor-pointer truncate max-w-[160px] sm:max-w-xs"
            >
              {cycles.map((cy) => (
                <option key={cy.id} value={cy.id}>
                  {cy.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5 bg-apc-light/40 p-2 rounded-xl border border-apc-primary/30 max-w-full min-w-0">
            <Vote className="w-4 h-4 text-apc-primary shrink-0" />
            <select
              value={selectedContestId}
              onChange={(e) => setSelectedContestId(e.target.value)}
              className="text-xs font-bold text-apc-primary bg-transparent border-0 focus:ring-0 cursor-pointer truncate max-w-[160px] sm:max-w-xs"
            >
              {contests.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Official vs Operational Status Metrics (aggregates from PostgreSQL) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="bg-emerald-50/60 border-emerald-200">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                  Official Approved PUs
                </p>
                <p className="text-3xl font-bold text-emerald-900 mt-1">
                  {aggregate?.approved_pus ?? 0} / {aggregate?.total_pus_in_scope ?? 0}
                </p>
                <p className="text-xs text-emerald-700 mt-1 font-medium">
                  {aggregate?.reporting_pct ?? 0}% Official Coverage
                </p>
              </div>
              <CheckCircle2 className="h-8 w-8 text-emerald-600 shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                  Total Official Votes
                </p>
                <p className="text-3xl font-bold text-gray-900 mt-1">
                  {(aggregate?.party_totals ?? [])
                    .reduce((sum, t) => sum + t.total_votes, 0)
                    .toLocaleString()}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Leading:{" "}
                  <span className="font-bold text-apc-primary">
                    {(aggregate?.party_totals ?? [])
                      .slice()
                      .sort((a, b) => b.total_votes - a.total_votes)[0]?.acronym ?? "None"}
                  </span>
                </p>
              </div>
              <Upload className="h-8 w-8 text-apc-primary shrink-0" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                {comparePartyA.toUpperCase()} vs {comparePartyB.toUpperCase()} Margin
              </p>
              <p
                className={`text-3xl font-bold mt-1 ${
                  marginAB >= 0 ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {marginAB >= 0 ? `+${marginAB.toLocaleString()}` : marginAB.toLocaleString()}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {comparePartyA.toUpperCase()}: {votesA.toLocaleString()} |{" "}
                {comparePartyB.toUpperCase()}: {votesB.toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-50 border-slate-200">
          <CardContent className="p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">
              Operational Submissions Breakdown
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
              <div className="bg-white p-2 rounded border text-amber-700">
                Pending: {pendingCount}
              </div>
              <div className="bg-white p-2 rounded border text-red-700">
                Rejected: {rejectedCount}
              </div>
              <div className="bg-white p-2 rounded border text-amber-800">
                Clarify: {clarifyCount}
              </div>
              <div className="bg-white p-2 rounded border text-purple-800">
                Reopened: {reopenedCount}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Official Approved Party Totals — from the PostgreSQL aggregate */}
      <Card>
        <CardHeader className="py-4">
          <CardTitle className="text-base font-bold text-slate-900">
            Official Approved Party Totals ({trackedParties.length} Tracked Parties)
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-6">
          {trackedParties.length === 0 ? (
            <div className="p-4 bg-amber-50 text-amber-900 border border-amber-200 rounded-xl text-xs font-semibold">
              No tracked parties configured for this contest. Contact the election
              administrator.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
              {trackedParties.map((p) => {
                const v = partyTotalByAcronym.get(p.toUpperCase()) ?? 0;
                const pColor = getPartyColor(p);
                return (
                  <div
                    key={p}
                    className="p-3 rounded-xl border flex flex-col items-center text-center space-y-1"
                    style={{ borderLeftWidth: "4px", borderLeftColor: pColor }}
                  >
                    <span className="text-xs font-bold uppercase text-slate-500">{p}</span>
                    <span className="text-xl font-bold font-mono text-slate-900">
                      {v.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Ward by Ward Official Results</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              {wardChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                  No approved election results available in this scope.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={wardChartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="ward" />
                    <YAxis />
                    <Tooltip />
                    {trackedParties.map((p) => (
                      <Bar key={p} dataKey={p.toUpperCase()} fill={getPartyColor(p)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Official Vote Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              {(aggregate?.party_totals ?? []).reduce((s, t) => s + t.total_votes, 0) ===
              0 ? (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                  No official votes recorded yet in this scope.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieChartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={100}
                      dataKey="value"
                      label
                    >
                      {pieChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={getPartyColor(entry.name)} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Submitted Polling Unit Results & Inspection Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Polling Unit Results ({operationalSubmissions.length})</CardTitle>
            {!isAdmin && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
                <Lock className="h-3 w-3" /> Read-Only View
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            {operationalSubmissions.length === 0 ? (
              <p className="text-center py-8 text-sm text-gray-500">
                No polling unit election results available in this scope yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-xs font-semibold uppercase text-gray-500">
                    <th className="text-left py-3 px-4">Polling Unit / Ward</th>
                    <th className="text-left py-3 px-4">Contest</th>
                    <th className="text-left py-3 px-4">Votes (APC / PDP)</th>
                    <th className="text-center py-3 px-4">Status</th>
                    <th className="text-center py-3 px-4">Form EC8 Evidence</th>
                    <th className="text-right py-3 px-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {operationalSubmissions.map((r) => {
                    const votesMap = votesByAcronym(r);
                    return (
                      <tr key={r.result_id} className="hover:bg-gray-50/80">
                        <td className="py-3 px-4">
                          <p className="font-semibold text-gray-900">
                            {r.polling_unit_id}
                          </p>
                          <p className="text-xs text-gray-500">Ward: {r.ward_id}</p>
                        </td>
                        <td className="py-3 px-4">
                          <p className="font-semibold text-xs text-emerald-800">
                            {r.contest_name || r.contest_id}
                          </p>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-gray-700">
                          {r.votes.length === 0 ? (
                            <span className="text-gray-400">—</span>
                          ) : (
                            r.votes.map((v) => {
                              const acronym =
                                parties.find((p) => p.id === v.party_id)?.acronym ?? "?";
                              return (
                                <span key={v.party_id} className="mr-2">
                                  {acronym}: {v.votes.toLocaleString()}
                                </span>
                              );
                            })
                          )}
                        </td>
                        <td className="text-center py-3 px-4">
                          <span
                            className={`px-2.5 py-1 text-xs font-bold rounded-full ${
                              r.status === "approved"
                                ? "bg-emerald-100 text-emerald-800"
                                : r.status === "rejected"
                                  ? "bg-red-100 text-red-800"
                                  : r.status === "clarification_required"
                                    ? "bg-amber-100 text-amber-800"
                                    : r.status === "reopened"
                                      ? "bg-purple-100 text-purple-800"
                                      : "bg-blue-100 text-blue-800"
                            }`}
                          >
                            {STATUS_LABEL[r.status] ?? r.status}
                          </span>
                        </td>
                        <td className="text-center py-3 px-4">
                          {r.evidence_asset_id ? (
                            <button
                              onClick={() => void openInspect(r)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-apc-primary hover:underline"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              Inspect EC8
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">No Image</span>
                          )}
                        </td>
                        <td className="text-right py-3 px-4">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => void openInspect(r)}
                              title="View audit history"
                              className="p-1 text-gray-400 hover:text-apc-primary"
                            >
                              <History className="h-4 w-4" />
                            </button>
                            {isAdmin && (
                              <button
                                onClick={() => {
                                  setEditingResult(r);
                                  setEditVotes(
                                    r.votes.map((v) => ({
                                      party_id: v.party_id,
                                      acronym:
                                        parties.find((p) => p.id === v.party_id)?.acronym ??
                                        v.party_id,
                                      votes: v.votes,
                                    }))
                                  );
                                  setEditReason("");
                                }}
                                className="px-2.5 py-1 text-xs font-semibold rounded bg-apc-primary/10 text-apc-primary hover:bg-apc-primary hover:text-white transition-colors"
                              >
                                <Edit3 className="inline h-3 w-3 mr-1" />
                                Correct
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Inspect EC8 Evidence & Audit History Modal */}
      {inspectResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
            <div className="bg-apc-primary text-white p-5 flex items-center justify-between">
              <div>
                <h2 className="font-bold text-lg">Form EC8 Result Evidence</h2>
                <p className="text-xs text-white/80">
                  PU: {inspectResult.polling_unit_id} · Ward: {inspectResult.ward_id}
                </p>
              </div>
              <button
                onClick={() => setInspectResult(null)}
                className="p-1 hover:bg-white/10 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6">
              {inspectResult.evidence_asset_id ? (
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Official Form EC8 Result Sheet (signed private access)
                  </p>
                  <div className="rounded-xl border bg-gray-50 overflow-hidden flex items-center justify-center p-2 min-h-[250px]">
                    {/* Signed-access route; no public object URL is ever constructed (§10) */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={evidenceViewUrl(inspectResult.evidence_asset_id)}
                      alt="Form EC8 Evidence"
                      className="max-h-[350px] object-contain rounded"
                    />
                  </div>
                </div>
              ) : (
                <div className="p-6 rounded-xl border border-dashed text-center text-sm text-gray-500">
                  No Form EC8 photo evidence was attached to this submission.
                </div>
              )}

              {inspectHistory.length > 0 && (
                <div className="border-t pt-4">
                  <h3 className="font-bold text-sm text-gray-900 mb-3 flex items-center gap-1.5">
                    <History className="h-4 w-4 text-apc-primary" />
                    Audit History (append-only, database-recorded)
                  </h3>
                  <div className="space-y-3">
                    {inspectHistory.map((h) => (
                      <div key={h.id} className="bg-gray-50 p-3 rounded-lg border text-xs space-y-1">
                        <p className="font-semibold text-gray-800">
                          Action: {h.action} | Actor: {h.actor_id}
                        </p>
                        <p className="text-gray-500">
                          {h.old_status ?? "—"} → {h.new_status ?? "—"}
                          {h.new_votes
                            ? ` · ballots: ${h.new_votes
                                .map((v) => `${v.party_id.slice(0, 8)}…=${v.votes}`)
                                .join(", ")}`
                            : ""}
                        </p>
                        <p className="text-gray-500">
                          Reason / Notes: {h.notes || "None specified"}
                        </p>
                        {h.new_evidence_asset_id && (
                          <p className="text-gray-400">
                            Evidence: {h.new_evidence_asset_id.slice(0, 8)}…
                          </p>
                        )}
                        <p className="text-gray-400">Timestamp: {String(h.created_at)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t px-6 py-3 bg-gray-50 flex justify-end">
              <button
                onClick={() => setInspectResult(null)}
                className="px-4 py-2 text-sm font-semibold rounded-lg border bg-white text-gray-700 hover:bg-gray-100"
              >
                Close Inspection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Correction Modal — always lands in pending_review (§12) */}
      {editingResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-apc-primary text-white p-5 flex items-center justify-between">
              <div>
                <h2 className="font-bold text-lg">Correct Election Result</h2>
                <p className="text-xs text-white/80">
                  PU: {editingResult.polling_unit_id}
                </p>
              </div>
              <button
                onClick={() => setEditingResult(null)}
                className="p-1 hover:bg-white/10 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-xs text-gray-500">
                Correct party vote counts against the submitted Form EC8 photo
                evidence. The corrected result returns to{" "}
                <strong>pending_review</strong> and requires independent
                re-verification — it cannot be approved from this screen.
              </p>

              <div className="space-y-3">
                {editVotes.map((pr, idx) => (
                  <div key={pr.party_id} className="flex items-center justify-between gap-4">
                    <label className="text-sm font-semibold text-gray-700 uppercase">
                      {pr.acronym} Votes
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={pr.votes}
                      onChange={(e) => {
                        const updated = [...editVotes];
                        updated[idx] = {
                          ...pr,
                          votes: Math.max(0, parseInt(e.target.value) || 0),
                        };
                        setEditVotes(updated);
                      }}
                      className="w-28 px-3 py-2 border rounded-lg text-sm text-right font-mono font-bold"
                    />
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Reason / Audit Note
                </label>
                <textarea
                  rows={2}
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="e.g. Corrected typo in PDP vote count per EC8 sheet"
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>
            </div>

            <div className="border-t px-6 py-4 bg-gray-50 flex justify-end gap-2">
              <button
                onClick={() => setEditingResult(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveCorrection}
                disabled={savingEdit}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg bg-apc-primary text-white hover:bg-apc-dark disabled:opacity-50"
              >
                {savingEdit ? "Saving..." : "Save Correction"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
