"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getElectionCycles,
  getContestsByCycle,
  subscribeToElectionResults,
  type ElectionResultDoc,
} from "@/lib/firebase/election";
import { generateElectionExportPackage } from "@/lib/electionExport";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import { useAuth } from "@/contexts/AuthContext";
import { isAdminUser } from "@/lib/permissions";
import type { ElectionCycle, ElectionContest } from "@/types";
import {
  FileSpreadsheet,
  Download,
  Printer,
  Vote,
  Layers,
  Loader2,
  CheckCircle2,
} from "lucide-react";

export default function ElectionExportPage() {
  const { profile } = useAuth();
  const router = useRouter();
  const [cycles, setCycles] = useState<ElectionCycle[]>([]);
  const [contests, setContests] = useState<ElectionContest[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<string>("");
  const [selectedContestId, setSelectedContestId] = useState<string>("");
  const [results, setResults] = useState<ElectionResultDoc[]>([]);
  const [loading, setLoading] = useState(true);

  /*
   * The export package aggregates results across a whole contest,
   * which only Admins and Election Officers can read under the
   * security rules. Everyone else is redirected.
   */
  const isPrivileged =
    isAdminUser(profile) || profile?.access_role === "election_officer";

  useEffect(() => {
    if (!profile) return;

    if (!isPrivileged) {
      router.replace("/portal/election");
    }
  }, [profile, isPrivileged, router]);

  useEffect(() => {
    async function init() {
      try {
        const cList = await getElectionCycles();
        setCycles(cList);
        if (cList.length > 0) {
          const defaultCycle = cList[0].id;
          setSelectedCycleId(defaultCycle);
          const contestList = await getContestsByCycle(defaultCycle);
          setContests(contestList);
          if (contestList.length > 0) {
            setSelectedContestId(contestList[0].id);
          }
        }
      } catch (err) {
        console.error("Failed to load export package metadata:", err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  useEffect(() => {
    if (!selectedCycleId) return;
    getContestsByCycle(selectedCycleId).then((contestList) => {
      setContests(contestList);
      if (contestList.length > 0) {
        setSelectedContestId(contestList[0].id);
      }
    });
  }, [selectedCycleId]);

  useEffect(() => {
    if (!selectedContestId) return;
    const unsubscribe = subscribeToElectionResults(
      CURRENT_TENANT_ID,
      (docs) => {
        const filtered = docs.filter((d) => d.contest_id === selectedContestId);
        setResults(filtered);
      },
      (err) => console.error(err),
      { contest_id: selectedContestId },
    );
    return () => unsubscribe();
  }, [selectedContestId]);

  const currentCycle = cycles.find((c) => c.id === selectedCycleId);
  const currentContest = contests.find((c) => c.id === selectedContestId);
  const trackedParties = currentContest?.tracked_parties || [];

  const handleExport = (format: "csv" | "excel" | "pdf") => {
    if (!currentContest || !currentCycle) return;
    generateElectionExportPackage({
      contest: currentContest,
      cycle: currentCycle,
      results,
      parties: trackedParties,
      format,
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">
          Loading result export engine...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-apc-primary mb-1">
            <Vote className="h-4 w-4" />
            <span>Official Election Operations Export Package</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            Election Result Export Package
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Generate formal result summaries identified explicitly by Election
            Cycle and Contest.
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
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Select Contest
              </label>
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
                Cycle: {currentCycle?.name} · Results Loaded: {results.length}{" "}
                PUs
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleExport("csv")}
                className="px-3 py-2 bg-white border rounded-lg font-bold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5 shadow-sm"
              >
                <Download className="h-4 w-4 text-apc-primary" /> Export CSV
              </button>

              <button
                onClick={() => handleExport("excel")}
                className="px-3 py-2 bg-white border rounded-lg font-bold text-emerald-700 hover:bg-emerald-50 flex items-center gap-1.5 shadow-sm"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Export
                Excel
              </button>

              <button
                onClick={() => handleExport("pdf")}
                className="px-3 py-2 bg-apc-primary text-white rounded-lg font-bold hover:bg-apc-dark flex items-center gap-1.5 shadow-sm"
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
