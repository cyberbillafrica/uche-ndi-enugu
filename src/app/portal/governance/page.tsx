"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flag, FileText, Inbox, Loader2, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import {
  getSupabaseClient,
  resolveGovernanceAccess,
  listMyRequests,
  GOVERNANCE_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceRequest,
} from "@/lib/supabase";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function GovernanceDashboardPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);
  const [requests, setRequests] = useState<GovernanceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ─── ROUTE GUARD (fail closed) ───
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
        if (!a.moduleEnabled || !a.canViewGovernance || !a.isParticipant) {
          router.replace("/portal/dashboard");
          return;
        }
      } catch {
        router.replace("/portal/dashboard");
        return;
      } finally {
        if (!cancelled) setGuardDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  // ─── LOAD ───
  useEffect(() => {
    if (!guardDone || !access?.isParticipant) return;
    let cancelled = false;
    void (async () => {
      try {
        const mine = await listMyRequests(getSupabaseClient());
        if (!cancelled) setRequests(mine);
      } catch (err) {
        console.error("Failed to load governance requests:", err);
        if (!cancelled) setLoadError("Unable to load your requests right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access?.isParticipant]);

  if (authLoading || (loading && guardDone && access?.isParticipant)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!access?.moduleEnabled) {
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

  const openCount = requests.filter(
    (r) => !["resolved", "closed", "rejected"].includes(r.status),
  ).length;

  const recent = requests.slice(0, 5);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Governance</h1>
        <p className="mt-1 text-sm text-gray-600">
          Raise service requests, follow their progress, and hold the work
          accountable — before, during, and beyond campaigns.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">My requests</p>
                <p className="text-2xl font-bold text-gray-900">
                  {requests.length}
                </p>
              </div>
              <FileText className="h-8 w-8 text-brand-primary/40" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Open</p>
                <p className="text-2xl font-bold text-gray-900">{openCount}</p>
              </div>
              <Inbox className="h-8 w-8 text-brand-primary/40" />
            </div>
          </CardContent>
        </Card>

        <Card className="border-brand-primary/20">
          <CardContent className="flex h-full items-center pt-6">
            <Link
              href="/portal/governance/requests/new"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-primary/90"
            >
              <Flag className="h-4 w-4" />
              Submit a Request
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-gray-900">
            Recent requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-sm text-red-600">{loadError}</p>
          ) : recent.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-gray-500">
                You have not submitted any requests yet.
              </p>
              <Link
                href="/portal/governance/requests/new"
                className="mt-3 inline-block text-sm font-medium text-brand-primary hover:underline"
              >
                Submit your first request →
              </Link>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {recent.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/portal/governance/requests/${r.id}`}
                    className="flex items-center justify-between gap-4 py-3 hover:bg-gray-50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">
                        {r.title}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {r.reference_code}
                        {r.category?.name ? ` · ${r.category.name}` : ""} ·{" "}
                        {formatDate(r.created_at)}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                      {GOVERNANCE_STATUS_LABELS[r.status]}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
