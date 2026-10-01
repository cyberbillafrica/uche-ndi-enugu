"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Handshake, Loader2, Plus, Search, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import {
  resolveGovernanceAccess,
  listCommitments,
  GOVERNANCE_COMMITMENT_STATUS_LABELS,
  GOVERNANCE_COMMITMENT_SOURCE_LABELS,
  type GovernanceAccess,
  type GovernanceCommitment,
  type GovernanceCommitmentStatus,
  type GovernanceCommitmentSourceType,
} from "@/lib/supabase";

const STATUS_OPTIONS: Array<GovernanceCommitmentStatus | "all"> = [
  "all",
  "declared",
  "in_progress",
  "partially_delivered",
  "delivered",
  "dropped",
];

export default function GovernanceCommitmentsPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [commitments, setCommitments] = useState<GovernanceCommitment[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [statusFilter, setStatusFilter] = useState<GovernanceCommitmentStatus | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<GovernanceCommitmentSourceType | "all">("all");
  const [search, setSearch] = useState("");

  // Presentation-only guard (every mutation is re-verified server-side by
  // the 0048 authority RPCs).
  useEffect(() => {
    if (authLoading || !profile) return;
    let cancelled = false;
    (async () => {
      const a = await resolveGovernanceAccess();
      if (cancelled) return;
      setAccess(a);
      setGuardDone(true);
      if (!a.moduleEnabled || !a.canViewGovernance) {
        router.replace("/portal");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  useEffect(() => {
    if (!guardDone || !access?.canViewGovernance) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listCommitments();
        if (!cancelled) {
          setCommitments(rows);
          setListLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load commitments.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access]);

  const filtered = useMemo(() => {
    return commitments.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (sourceFilter !== "all" && c.source_type !== sourceFilter) return false;
      if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [commitments, statusFilter, sourceFilter, search]);

  if (!guardDone) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!access?.canViewGovernance) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldAlert className="h-10 w-10 text-amber-500" />
          <p className="text-sm text-gray-600">You do not have access to Governance Commitments.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Commitments</h1>
          <p className="text-sm text-gray-500">
            Structured delivery obligations tracked independently of projects.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/portal/governance/projects/commitments/new")}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Commitment
        </button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Handshake className="h-4 w-4 text-brand-primary" />
            All Commitments
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Label htmlFor="commitment-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  id="commitment-search"
                  className="pl-8"
                  placeholder="Search by title…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="commitment-status">Status</Label>
              <select
                id="commitment-status"
                className="block h-10 rounded-md border border-gray-300 bg-white px-3 text-sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as GovernanceCommitmentStatus | "all")}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All statuses" : GOVERNANCE_COMMITMENT_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="commitment-source">Source</Label>
              <select
                id="commitment-source"
                className="block h-10 rounded-md border border-gray-300 bg-white px-3 text-sm"
                value={sourceFilter}
                onChange={(e) =>
                  setSourceFilter(e.target.value as GovernanceCommitmentSourceType | "all")
                }
              >
                <option value="all">All sources</option>
                {Object.entries(GOVERNANCE_COMMITMENT_SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loadError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
          ) : !listLoaded ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">
              No commitments match the current filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Commitment</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Source</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Progress</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Target date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/governance/projects/commitments/${c.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {c.title}
                        </Link>
                        <div className="font-mono text-xs text-gray-400">{c.reference_code}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {GOVERNANCE_COMMITMENT_STATUS_LABELS[c.status]}
                        </span>
                        {c.is_public && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Public
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-gray-600">
                          {GOVERNANCE_COMMITMENT_SOURCE_LABELS[c.source_type]}
                        </span>
                        {c.source_ref && (
                          <div className="font-mono text-xs text-gray-400">{c.source_ref}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200">
                            <div
                              className="h-full rounded-full bg-brand-primary"
                              style={{ width: `${c.progress_percent}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">{c.progress_percent}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{c.target_date ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
