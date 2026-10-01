"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Search, ShieldAlert, MessageSquareText, PenLine, Vote } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import {
  resolveGovernanceAccess,
  listConsultations,
  listPetitions,
  listPolls,
  GOVERNANCE_CONSULTATION_STATUS_LABELS,
  GOVERNANCE_CONSULTATION_KIND_LABELS,
  GOVERNANCE_PETITION_STATUS_LABELS,
  GOVERNANCE_PETITION_ORIGIN_LABELS,
  GOVERNANCE_POLL_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceConsultation,
  type GovernanceConsultationStatus,
  type GovernanceConsultationKind,
  type GovernancePetition,
  type GovernancePetitionStatus,
  type GovernancePetitionOrigin,
  type GovernancePoll,
  type GovernancePollStatus,
} from "@/lib/supabase";

const STATUS_OPTIONS: Array<GovernanceConsultationStatus | "all"> = [
  "all",
  "draft",
  "open",
  "closed",
  "results_published",
];

const PETITION_STATUS_OPTIONS: Array<GovernancePetitionStatus | "all"> = [
  "all",
  "draft",
  "pending",
  "open",
  "closed",
  "verified",
  "results_published",
];

const POLL_STATUS_OPTIONS: Array<GovernancePollStatus | "all"> = [
  "all",
  "draft",
  "open",
  "closed",
];

export default function GovernanceParticipationPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [instruments, setInstruments] = useState<GovernanceConsultation[]>([]);
  const [petitions, setPetitions] = useState<GovernancePetition[]>([]);
  const [polls, setPolls] = useState<GovernancePoll[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [kindFilter, setKindFilter] = useState<GovernanceConsultationKind | "all">("all");
  const [statusFilter, setStatusFilter] = useState<GovernanceConsultationStatus | "all">("all");
  const [originFilter, setOriginFilter] = useState<GovernancePetitionOrigin | "all">("all");
  const [petitionStatusFilter, setPetitionStatusFilter] = useState<GovernancePetitionStatus | "all">("all");
  const [pollStatusFilter, setPollStatusFilter] = useState<GovernancePollStatus | "all">("all");
  const [search, setSearch] = useState("");

  // Presentation-only guard (every mutation is re-verified server-side by
  // the 0051 authority RPCs).
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
        const [rows, pRows, pollRows] = await Promise.all([listConsultations(), listPetitions(), listPolls()]);
        if (!cancelled) {
          setInstruments(rows);
          setPetitions(pRows);
          setPolls(pollRows);
          setListLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load instruments.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access]);

  const filtered = useMemo(() => {
    return instruments.filter((c) => {
      if (kindFilter !== "all" && c.kind !== kindFilter) return false;
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [instruments, kindFilter, statusFilter, search]);

  const filteredPetitions = useMemo(() => {
    return petitions.filter((p) => {
      if (originFilter !== "all" && p.origin !== originFilter) return false;
      if (petitionStatusFilter !== "all" && p.status !== petitionStatusFilter) return false;
      if (search && !p.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [petitions, originFilter, petitionStatusFilter, search]);

  const filteredPolls = useMemo(() => {
    return polls.filter((poll) => {
      if (pollStatusFilter !== "all" && poll.status !== pollStatusFilter) return false;
      if (search && !poll.title.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [polls, pollStatusFilter, search]);

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
          <p className="text-sm text-gray-600">You do not have access to Governance Participation.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Participation</h1>
          <p className="text-sm text-gray-500">Consultations, surveys, petitions and community proposals — create, open, verify and publish.</p>
        </div>
        {access.canManageParticipation && (
          <Link
            href="/portal/governance/participation/new"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Instrument
          </Link>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareText className="h-4 w-4 text-brand-primary" />
            Instruments
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="p-kind">Type</Label>
              <select
                id="p-kind"
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value as GovernanceConsultationKind | "all")}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="all">All types</option>
                {Object.entries(GOVERNANCE_CONSULTATION_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="p-status">Status</Label>
              <select
                id="p-status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as GovernanceConsultationStatus | "all")}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === "all" ? "All statuses" : GOVERNANCE_CONSULTATION_STATUS_LABELS[value as GovernanceConsultationStatus]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="p-search">Search</Label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  id="p-search"
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
              No instruments match the current filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Instrument</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Type</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Questions</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Closes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/governance/participation/${c.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {c.title}
                        </Link>
                        <div className="font-mono text-xs text-gray-400">{c.reference_code}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {GOVERNANCE_CONSULTATION_KIND_LABELS[c.kind]}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {GOVERNANCE_CONSULTATION_STATUS_LABELS[c.status]}
                        </span>
                        {c.is_public && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Public
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{c.questions?.length ?? 0}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {c.closes_at ? new Date(c.closes_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <PenLine className="h-4 w-4 text-brand-primary" />
            Petitions & Community Proposals
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="pp-origin">Origin</Label>
              <select
                id="pp-origin"
                value={originFilter}
                onChange={(e) => setOriginFilter(e.target.value as GovernancePetitionOrigin | "all")}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="all">All origins</option>
                {Object.entries(GOVERNANCE_PETITION_ORIGIN_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pp-status">Status</Label>
              <select
                id="pp-status"
                value={petitionStatusFilter}
                onChange={(e) => setPetitionStatusFilter(e.target.value as GovernancePetitionStatus | "all")}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {PETITION_STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === "all" ? "All statuses" : GOVERNANCE_PETITION_STATUS_LABELS[value as GovernancePetitionStatus]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pp-search">Search</Label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  id="pp-search"
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
          ) : filteredPetitions.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">
              No petitions or proposals match the current filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Petition</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Origin</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Target</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Closes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredPetitions.map((p) => (
                    <tr key={p.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/governance/participation/petitions/${p.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {p.title}
                        </Link>
                        <div className="font-mono text-xs text-gray-400">{p.reference_code}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        {GOVERNANCE_PETITION_ORIGIN_LABELS[p.origin]}
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {GOVERNANCE_PETITION_STATUS_LABELS[p.status]}
                        </span>
                        {p.is_public && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Public
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{p.target_signatures ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {p.closes_at ? new Date(p.closes_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Vote className="h-4 w-4 text-brand-primary" />
              Polls
            </span>
            {access.canManageParticipation && (
              <Link
                href="/portal/governance/participation/polls/new"
                className="inline-flex items-center gap-1.5 rounded-lg border border-brand-primary/30 px-2.5 py-1.5 text-xs font-medium text-brand-primary hover:bg-brand-primary/5"
              >
                <Plus className="h-3.5 w-3.5" />
                New Poll
              </Link>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="pl-status">Status</Label>
              <select
                id="pl-status"
                value={pollStatusFilter}
                onChange={(e) => setPollStatusFilter(e.target.value as GovernancePollStatus | "all")}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {POLL_STATUS_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === "all" ? "All statuses" : GOVERNANCE_POLL_STATUS_LABELS[value as GovernancePollStatus]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pl-search">Search</Label>
              <div className="relative mt-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  id="pl-search"
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
          ) : filteredPolls.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">
              No polls match the current filters.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Poll</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Options</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-500">Closes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredPolls.map((poll) => (
                    <tr key={poll.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/portal/governance/participation/polls/${poll.id}`}
                          className="font-medium text-brand-primary hover:underline"
                        >
                          {poll.title}
                        </Link>
                        <div className="font-mono text-xs text-gray-400">{poll.reference_code}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          {GOVERNANCE_POLL_STATUS_LABELS[poll.status]}
                        </span>
                        {poll.is_public && (
                          <span className="ml-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                            Public
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{poll.options?.length ?? 0}</td>
                      <td className="px-4 py-3 text-gray-600">
                        {poll.closes_at ? new Date(poll.closes_at).toLocaleDateString() : "—"}
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
