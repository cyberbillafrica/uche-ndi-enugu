"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flag, Loader2, ShieldAlert } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import {
  getSupabaseClient,
  resolveGovernanceAccess,
  listMyRequests,
  listLgas,
  listAllWards,
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

export default function MyRequestsPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);
  const [requests, setRequests] = useState<GovernanceRequest[]>([]);
  const [lgaNames, setLgaNames] = useState<Map<string, string>>(new Map());
  const [wardNames, setWardNames] = useState<Map<string, string>>(new Map());
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

  // ─── LOAD ───
  useEffect(() => {
    if (!guardDone || !access?.isParticipant) return;
    let cancelled = false;
    void (async () => {
      try {
        const [mine, lgaData, wardData] = await Promise.all([
          listMyRequests(getSupabaseClient()),
          listLgas(),
          listAllWards(),
        ]);
        if (cancelled) return;
        setRequests(mine);
        setLgaNames(new Map(lgaData.map((l) => [l.id, l.name])));
        setWardNames(new Map(wardData.map((w) => [w.id, w.name])));
      } catch (err) {
        console.error("Failed to load requests:", err);
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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Requests</h1>
          <p className="mt-1 text-sm text-gray-600">
            Every request you have submitted, with its current status.
          </p>
        </div>
        <Link
          href="/portal/governance/requests/new"
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary/90"
        >
          <Flag className="h-4 w-4" />
          Submit a Request
        </Link>
      </header>

      <Card>
        <CardContent className="pt-6">
          {loadError ? (
            <p className="text-sm text-red-600">{loadError}</p>
          ) : requests.length === 0 ? (
            <div className="py-10 text-center">
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
              {requests.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/portal/governance/requests/${r.id}`}
                    className="block py-3 hover:bg-gray-50"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-900">
                        {r.title}
                      </p>
                      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                        {GOVERNANCE_STATUS_LABELS[r.status]}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      <span className="font-mono">{r.reference_code}</span>
                      {r.category?.name ? ` · ${r.category.name}` : ""}
                      {` · submitted ${formatDate(r.created_at)}`}
                      {r.updated_at !== r.created_at
                        ? ` · updated ${formatDate(r.updated_at)}`
                        : ""}
                      {r.lga_id || r.ward_id
                        ? ` · ${
                            [
                              r.lga_id ? lgaNames.get(r.lga_id) : null,
                              r.ward_id ? wardNames.get(r.ward_id) : null,
                            ]
                              .filter(Boolean)
                              .join(", ")
                          }`
                        : ""}
                    </p>
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
