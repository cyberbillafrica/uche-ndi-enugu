"use client";

/**
 * POLITICORE — Election Export (Phase 2 cutover: PostgreSQL/Supabase).
 *
 * Reads the caller-visible results through the service layer (RLS-
 * scoped; privileged users see contest-wide) and exports the relational
 * ballots with party labels resolved from party_id (§6). Contest- and
 * cycle-explicit per §7.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
  getElectionCycles,
  getContestsByCycle,
  getElectionResults,
  getPoliticalParties,
  subscribeToElectionResults,
} from "@/lib/supabase";
import { generateElectionExportPackage } from "@/lib/electionExport";
import { useAuth } from "@/contexts/AuthContext";
import {
  FileSpreadsheet,
  Download,
  Printer,
  Vote,
  Loader2,
  Lock,
} from "lucide-react";
import type {
  ElectionContest,
  ElectionCycle,
  ElectionResult,
  PoliticalParty,
} from "@/types";

export default function ElectionExportPage() {
  const { profile } = useAuth();
  const router = useRouter();
  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [selectedContestId, setSelectedContestId] = useState<string>("");
  const [results, setResults] = useState<ElectionResult[]>([]);
  const [parties, setParties] = useState<PoliticalParty[]>([]);
  const [loading, setLoading] = useState(true);

  /*
   * The export package aggregates results across a whole contest — an
   * operation for Admins and Election Officers (scoped users may run it
   * but will see only their RLS-visible rows, which the UI states).
   */
  const isPrivileged =
    profile?.access_role === "election_officer" ||
    ["admin", "tenant_super_admin", "platform_super_admin"].includes(
      profile?.access_role ?? ""
    );

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
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      try {
        const [cList, ps] = await Promise.all([
          getElectionCycles(supabase),
          getPoliticalParties(supabase),
        ]);
        if (cancelled) return;
        setCycles(cList);
        setParties(ps);
        if (cList.length > 0) {
          const defaultCycle = cList[0].id;
          setSelectedCycleId(defaultCycle);
          const contestList = await getContestsByCycle(defaultCycle, supabase);
          if (cancelled) return;
          setContests(contestList);
          if (contestList.length > 0) setSelectedContestId(contestList[0].id);
        }
      } catch (err) {
        console.error("Failed to load export package metadata:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  useEffect(() => {
    if (gate !== "ready" || !selectedCycleId) return;
    let cancelled = false;
    (async () => {
      const contestList = await getContestsByCycle(selectedCycleId, getSupabaseClient()).catch(
        () => []
      );
      if (cancelled) return;
      setContests(contestList);
      if (contestList.length > 0) setSelectedContestId(contestList[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCycleId, gate]);

  const fetchResults = useCallback(async () => {
    if (!selectedContestId) return;
    try {
      const rows = await getElectionResults(getSupabaseClient(), {
        contestId: selectedContestId,
      });
      setResults(rows);
    } catch (err) {
      console.error("Failed to load results for export:", err);
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

  const currentCycle = cycles.find((c) => c.id === selectedCycleId);
  const currentContest = contests.find((c) => c.id === selectedContestId);

  const handleExport = (format: "csv" | "excel" | "pdf") => {
    if (!currentContest || !currentCycle) return;
    const partyLabels = new Map(parties.map((p) => [p.id, p.acronym]));
    generateElectionExportPackage({
      contest: currentContest,
      cycle: currentCycle,
      results,
      partyLabels,
      format,
    });
  };

  if (gate === "loading" || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading result export engine...</span>
      </div>
    );
  }

  if (gate === "no_session" || gate === "denied") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
          <Lock className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">Export access denied</h2>
        <p className="text-sm text-gray-600">
          Election export requires Election access. Authorization is enforced by
          the database.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-primary mb-1">
            <Vote className="h-4 w-4" />
            <span>Official Election Operations Export Package</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            Election Result Export Package
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Generate formal result summaries identified explicitly by Election
            Cycle and Contest. Rows outside your authorization are excluded by
            the database.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Select Election Cycle
              </label>
              <select
                value={selectedCycleId}
                onChange={(e) => setSelectedCycleId(e.target.value)}
                className="w-full px-3 py-2 border rounded-xl text-xs font-semibold"
              >
                {cycles.map((cy) => (
                  <option key={cy.id} value={cy.id}>
                    {cy.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">Select Contest</label>
              <select
                value={selectedContestId}
                onChange={(e) => setSelectedContestId(e.target.value)}
                className="w-full px-3 py-2 border rounded-xl text-xs font-semibold"
              >
                {contests.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="p-4 bg-gray-50 rounded-xl border flex flex-wrap items-center justify-between gap-4 text-xs">
            <div>
              <p className="font-bold text-gray-900">
                {currentContest?.name || "No Contest Selected"}
              </p>
              <p className="text-gray-500">
                Cycle: {currentCycle?.name} · Results Loaded: {results.length} PUs
                {!isPrivileged && " (your authorized scope)"}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleExport("csv")}
                className="px-3 py-2 bg-white border rounded-lg font-bold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5 shadow-sm"
              >
                <Download className="h-4 w-4 text-brand-primary" /> Export CSV
              </button>

              <button
                onClick={() => handleExport("excel")}
                className="px-3 py-2 bg-white border rounded-lg font-bold text-emerald-700 hover:bg-emerald-50 flex items-center gap-1.5 shadow-sm"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export Excel
              </button>

              <button
                onClick={() => handleExport("pdf")}
                className="px-3 py-2 bg-brand-primary text-white rounded-lg font-bold hover:bg-brand-primary flex items-center gap-1.5 shadow-sm"
              >
                <Printer className="h-4 w-4" /> Print / PDF
              </button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
