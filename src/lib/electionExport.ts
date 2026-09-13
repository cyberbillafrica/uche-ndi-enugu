import {
  exportToCSV,
  exportToExcel,
  exportToPDFPrint,
} from "@/lib/export";
import type { ElectionContest, ElectionCycle } from "@/types";
import type { ElectionResultDoc } from "@/lib/firebase/election";

export interface ElectionExportSummaryRow {
  contest_name: string;
  cycle_name: string;
  level: string; // e.g., "State", "LGA", "Ward", "PU"
  location_name: string;
  total_pus: number;
  approved_pus: number;
  coverage_percent: string;
  party_votes: Record<string, number>;
  total_votes: number;
  leading_party: string;
}

/**
 * Generates an operational election result export package.
 */
export function generateElectionExportPackage(params: {
  contest: ElectionContest;
  cycle: ElectionCycle;
  results: ElectionResultDoc[];
  parties: string[];
  format: "csv" | "excel" | "pdf";
}) {
  const { contest, cycle, results, parties, format } = params;

  // Build aggregated summary rows
  const partyHeaders = parties.map((p) => p.toUpperCase());
  const headers = [
    "Election Cycle",
    "Contest Name",
    "Polling Unit ID",
    "Ward ID",
    "LGA ID",
    "Status",
    ...partyHeaders,
    "Total Votes",
  ];

  const rows: (string | number)[][] = results.map((r) => {
    let rowTotal = 0;
    const partyVoteMap: Record<string, number> = {};

    for (const pr of r.results) {
      const v = Number(pr.votes) || 0;
      partyVoteMap[pr.party.toUpperCase()] = v;
      rowTotal += v;
    }

    const partyCols = partyHeaders.map((p) => partyVoteMap[p] || 0);

    return [
      cycle.name,
      contest.name,
      r.polling_unit_id,
      r.ward_id,
      r.lga_id || "Enugu",
      r.status,
      ...partyCols,
      rowTotal,
    ];
  });

  const timestamp = Date.now();
  const filename = `election_result_package_${contest.id}_${timestamp}`;

  if (format === "csv") {
    exportToCSV(`${filename}.csv`, headers, rows);
  } else if (format === "excel") {
    exportToExcel(`${filename}.xls`, "Election Results", headers, rows);
  } else if (format === "pdf") {
    exportToPDFPrint();
  }
}
