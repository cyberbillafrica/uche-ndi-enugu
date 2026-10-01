"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Search, ShieldAlert, UsersRound } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import {
  resolveGovernanceAccess,
  listEngagements,
  GOVERNANCE_ENGAGEMENT_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceEngagement,
  type GovernanceEngagementStatus,
} from "@/lib/supabase";

const STATUS_OPTIONS: Array<GovernanceEngagementStatus | "all"> = [
  "all",
  "draft",
  "scheduled",
  "concluded",
];

export default function GovernanceEngagementsPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [engagements, setEngagements] = useState<GovernanceEngagement[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [statusFilter, setStatusFilter] = useState<GovernanceEngagementStatus | "all">("all");
  const [search, setSearch] = useState("");

  // Presentation-only guard (every mutation is re-verified server-side by
  // the 0056 authority RPCs).
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
        const rows = await listEngagements();
        if (!cancelled) {
          setEngagements(rows);
          setListLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load engagements.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access]);

  const filtered = useMemo(() => {
    return engagements.filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (search && !e.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [engagements, statusFilter, search]);

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
          <p className="text-sm text-gray-600">You do not have access to Governance.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Engagements</h1>
          <p className="text-sm text-gray-500">
            Town halls, stakeholder meetings and constituency engagements — the Governance process record.
          </p>
        </div>
        {access.canManageParticipation && (
          <Link
            href="/portal/governance/engagements/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Engagement
          </Link>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UsersRound className="h-4 w-4 text-brand-primary" />
            Engagement records
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-status">Status</Label>
              <select
                id="e-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as GovernanceEngagementStatus | "all")}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === "all" ? "All statuses" : GOVERNANCE_ENGAGEMENT_STATUS_LABELS[value as GovernanceEngagementStatus]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="e-search">Search</Label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  id="e-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by title"
                  className="pl-9"
                />
              </div>
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
              No engagements match the current filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Engagement</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Scheduled</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Agenda</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Event</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((e) => (
                    <tr key={e.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/governance/engagements/${e.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {e.title}
                        </Link>
                        <div className="font-mono text-xs text-gray-400">{e.reference_code}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {GOVERNANCE_ENGAGEMENT_STATUS_LABELS[e.status]}
                        </span>
                        {e.is_public && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Public
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {e.scheduled_at ? new Date(e.scheduled_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{e.agenda?.length ?? 0} items</td>
                      <td className="px-4 py-3 text-gray-600">
                        {e.event_id ? "Linked" : "—"}
                      </td>
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
