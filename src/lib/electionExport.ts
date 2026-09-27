import {
  exportToCSV,
  exportToExcel,
  exportToPDFPrint,
} from "@/lib/export";
import type { ElectionContest, ElectionCycle, ElectionResult } from "@/types";

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
 * Generates an operational election result export package from the
 * RELATIONAL application representation (§5): each result carries its
 * ballot as ElectionResultVote[] rows keyed by party_id; labels are
 * resolved via the provided party map before export (acronyms are
 * display-only — persistence identity stays party_id).
 */
export function generateElectionExportPackage(params: {
  contest: ElectionContest;
  cycle: ElectionCycle;
  results: ElectionResult[];
  /** party_id → acronym for vote label resolution. */
  partyLabels: Map<string, string>;
  format: "csv" | "excel" | "pdf";
}) {
  const { contest, cycle, results, partyLabels, format } = params;

  // Ballot parties of this contest in the caller's display order.
  const partyAcronyms = Array.from(new Set(partyLabels.values())).sort();
  const partyHeaders = partyAcronyms.map((p) => p.toUpperCase());
  const headers = [
    "Election Cycle",
    "Contest Name",
    "Polling Unit ID",
    "Ward ID",
    "LGA ID",
    "Status",
    "Verified",
    ...partyHeaders,
    "Total Votes",
  ];

  const rows: (string | number)[][] = results.map((r) => {
    let rowTotal = 0;
    const partyVoteMap: Record<string, number> = {};

    for (const v of r.votes) {
      const acronym = (partyLabels.get(v.party_id) ?? v.party_id).toUpperCase();
      partyVoteMap[acronym] = v.votes;
      rowTotal += v.votes;
    }

    const partyCols = partyHeaders.map((p) => partyVoteMap[p] || 0);

    return [
      cycle.name,
      contest.name,
      r.polling_unit_id,
      r.ward_id,
      r.lga_id,
      r.status,
      r.verified ? "YES" : "NO",
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
