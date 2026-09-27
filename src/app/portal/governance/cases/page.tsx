"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox, Loader2, ShieldAlert, Search } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import {
  resolveGovernanceAccess,
  listCases,
  listCategories,
  GOVERNANCE_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceRequest,
  type GovernanceRequestStatus,
  type GovernanceCategory,
} from "@/lib/supabase";

const STATUS_OPTIONS: GovernanceRequestStatus[] = [
  "submitted",
  "acknowledged",
  "assigned",
  "in_progress",
  "awaiting_information",
  "resolved",
  "closed",
  "rejected",
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function CaseQueuePage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [categories, setCategories] = useState<GovernanceCategory[]>([]);
  const [cases, setCases] = useState<GovernanceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [search, setSearch] = useState("");
  const searchDebounced = useDebounced(search, 350);
  const [status, setStatus] = useState<"" | GovernanceRequestStatus>("");
  const [categoryId, setCategoryId] = useState("");
  const [assignedToMe, setAssignedToMe] = useState(false);

  // ─── ROUTE GUARD (fail closed: staff authority required) ───
  useEffect(() => {
    if (authLoading) return;
    if (!profile) {
      router.replace("/portal/dashboard");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const a = await resolveGovernanceAccess();
        if (!cancelled) setAccess(a);
        if (!a.moduleEnabled || !a.canViewGovernance || !a.isStaff) {
          router.replace("/portal/dashboard");
        }
      } catch {
        router.replace("/portal/dashboard");
      } finally {
        if (!cancelled) setGuardDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  // ─── LOAD queue (all filtering database-side under RLS) ───
  useEffect(() => {
    if (!guardDone || !access?.isStaff) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [rows, cats] = await Promise.all([
          listCases({
            status: status || null,
            categoryId: categoryId || null,
            assignedToMe,
            search: searchDebounced.trim() ? searchDebounced.trim() : null,
          }),
          categories.length === 0 ? listCategories() : Promise.resolve(categories),
        ]);
        if (cancelled) return;
        setCases(rows);
        if (categories.length === 0) setCategories(cats);
        setLoadError("");
      } catch (err) {
        console.error("Failed to load case queue:", err);
        if (!cancelled) setLoadError("Unable to load the case queue right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // reload on filter change; `categories` intentionally excluded (loaded once)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardDone, access?.isStaff, status, categoryId, assignedToMe, searchDebounced]);

  if (authLoading || !guardDone || (guardDone && access?.isStaff && loading && cases.length === 0 && !loadError)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
      </div>
    );
  }

  if (guardDone && access && !access.moduleEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">
          Governance is not available
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          The Governance module is not enabled for your organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Case Queue</h1>
        <p className="mt-1 text-sm text-gray-600">
          Requests raised by participants in your organization.
        </p>
      </header>

      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="govq-search">Search</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  id="govq-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search subjects…"
                  className="pl-8"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="govq-status">Status</Label>
              <select
                id="govq-status"
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as "" | GovernanceRequestStatus)
                }
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
              >
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {GOVERNANCE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="govq-category">Category</Label>
              <select
                id="govq-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={assignedToMe}
                  onChange={(e) => setAssignedToMe(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-apc-primary focus:ring-apc-primary"
                />
                Assigned to me
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {loadError ? (
            <p className="text-sm text-red-600">{loadError}</p>
          ) : cases.length === 0 ? (
            <div className="py-10 text-center">
              <Inbox className="mx-auto mb-3 h-8 w-8 text-gray-300" />
              <p className="text-sm text-gray-500">
                No cases match the current filters.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-400">
                    <th className="py-2 pr-4 font-medium">Reference</th>
                    <th className="py-2 pr-4 font-medium">Subject</th>
                    <th className="py-2 pr-4 font-medium">Category</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Submitted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {cases.map((c) => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="py-2.5 pr-4 font-mono text-xs text-gray-600">
                        <Link href={`/portal/governance/cases/${c.id}`}>
                          {c.reference_code}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/portal/governance/cases/${c.id}`}
                          className="font-medium text-gray-900 hover:text-apc-primary"
                        >
                          {c.title}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-gray-600">
                        {c.category?.name ?? "General"}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                          {GOVERNANCE_STATUS_LABELS[c.status]}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-gray-500">
                        {formatDate(c.created_at)}
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

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
