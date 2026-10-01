"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Handshake, Loader2, Plus, Search, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import {
  resolveGovernanceAccess,
  listProjects,
  GOVERNANCE_PROJECT_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceProject,
  type GovernanceProjectStatus,
} from "@/lib/supabase";

const STATUS_OPTIONS: Array<GovernanceProjectStatus | "all"> = [
  "all",
  "planned",
  "active",
  "suspended",
  "completed",
  "cancelled",
];

export default function GovernanceProjectsPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [projects, setProjects] = useState<GovernanceProject[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [statusFilter, setStatusFilter] = useState<GovernanceProjectStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"projects" | "commitments">("projects");

  // Presentation-only guard (every mutation is re-verified server-side by
  // the 0043 authority RPCs).
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
        const rows = await listProjects();
        if (!cancelled) {
          setProjects(rows);
          setListLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load projects.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access]);

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [projects, statusFilter, search]);

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
          <p className="text-sm text-gray-600">
            You do not have access to Governance Projects.
          </p>
        </CardContent>
      </Card>
    );
  }

  const canManage = access.isAdmin || true; // manage authority is scope-resolved server-side; list is view-level

  const tabButton = (key: "projects" | "commitments", label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => (key === "commitments" ? router.push("/portal/governance/projects/commitments") : setTab("projects"))}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
        tab === key ? "bg-brand-primary text-white" : "border border-gray-300 text-gray-700 hover:bg-gray-50"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Projects</h1>
          <p className="text-sm text-gray-500">
            Delivery projects tracked with milestones, geography and progress.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => router.push("/portal/governance/projects/new")}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {tabButton("projects", "Projects", <FolderKanban className="h-4 w-4" />)}
        {tabButton("commitments", "Commitments", <Handshake className="h-4 w-4" />)}
      </div>

      {tab === "projects" && (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderKanban className="h-4 w-4 text-brand-primary" />
            All Projects
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Label htmlFor="project-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  id="project-search"
                  className="pl-8"
                  placeholder="Search by title…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="project-status">Status</Label>
              <select
                id="project-status"
                className="block h-10 rounded-md border border-gray-300 bg-white px-3 text-sm"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as GovernanceProjectStatus | "all")
                }
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All statuses" : GOVERNANCE_PROJECT_STATUS_LABELS[s]}
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
              No projects match the current filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Project</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Progress</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Planned end</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/governance/projects/${p.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {p.title}
                        </Link>
                        <div className="font-mono text-xs text-gray-400">{p.reference_code}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {GOVERNANCE_PROJECT_STATUS_LABELS[p.status]}
                        </span>
                        {p.is_public && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Public
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-200">
                            <div
                              className="h-full rounded-full bg-brand-primary"
                              style={{ width: `${p.progress_percent}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">{p.progress_percent}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{p.planned_end ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      )}
      {tab === "commitments" && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500">
            The Commitments tab has moved to its own page at{" "}
            <Link href="/portal/governance/projects/commitments" className="text-brand-primary hover:underline">
              Governance → Projects → Commitments
            </Link>
            .
          </CardContent>
        </Card>
      )}
    </div>
  );
}
