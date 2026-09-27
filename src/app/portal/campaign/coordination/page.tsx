"use client";

/**
 * POLITICORE — Campaign Coordination (Phase E cutover: PostgreSQL/Supabase).
 *
 * An ORGANIZATIONAL OPERATIONAL VIEW (§13/§14) — a composition over the
 * already-migrated Campaign data, NOT a second implementation of any
 * module, and NOT a management console for Core data:
 *   * summary aggregates come from campaign_coordination_summary (0026),
 *     scoped by the database to the caller's authorized coverage;
 *   * the displayed organizational structure is the caller's own Core
 *     organizational_assignments (plus admins' tenant rows) read through
 *     the security_invoker view — READ-ONLY display (§26): creating,
 *     editing or deleting organizational assignments and permission
 *     grants remains a Core operation outside Campaign (the legacy
 *     page's assignment/permission-grant CRUD and its user_access index
 *     writes are intentionally gone);
 *   * no route parameter can grant authority (§15) — every number on
 *     this page is resolved server-side.
 *
 * The route gate is resolveCampaignAccess (database-resolved,
 * fail-closed); the RPC/RLS remain the authoritative boundary.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  ClipboardList,
  Flag,
  Loader2,
  MapPin,
  RefreshCw,
  TriangleAlert,
  Users,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import {
  CampaignError,
  getCoordinationSummary,
  resolveCampaignAccess,
  ensureSupabaseSession,
  getSupabaseClient,
  type CampaignAuthority,
  type CampaignCoordinationSummary,
} from "@/lib/supabase";

function campaignErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof CampaignError) return err.message;
  return fallback;
}

function formatScopeType(scopeType: string | null): string {
  switch (scopeType) {
    case "campaign":
      return "Campaign";
    case "state":
      return "State";
    case "senatorial_zone":
      return "Senatorial Zone";
    case "lga":
      return "LGA";
    case "ward":
      return "Ward";
    case "polling_unit":
      return "Polling Unit";
    default:
      return "Organizational scope";
  }
}

interface OrgAssignmentRow {
  id: string;
  user_id: string;
  position: string;
  scope_type: string;
  scope_id: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
}

type Gate = "loading" | "no_session" | "denied" | "ready";

export default function CampaignCoordinationPage() {
  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");

  const [summary, setSummary] = useState<CampaignCoordinationSummary | null>(null);
  const [assignments, setAssignments] = useState<OrgAssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── gate: bridged session + database-resolved campaign access ────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bridge = await ensureSupabaseSession();
      if (cancelled) return;
      if (!bridge.sessionReady) {
        setGate(bridge.reason === "no_session" ? "no_session" : "denied");
        return;
      }
      const supabase = bridge.supabase;
      const access = await resolveCampaignAccess(supabase);
      if (cancelled) return;
      if (!access.allowed) {
        setDenyReason(access.reason);
        setGate("denied");
        return;
      }
      setAuthority(access.authority);
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Server-scoped composition: summary RPC + read-only Core assignment display. */
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getSupabaseClient();
      const [summaryData, assignmentRows] = await Promise.all([
        getCoordinationSummary(supabase),
        supabase
          .from("organizational_assignments")
          .select(
            "id, user_id, position, scope_type, scope_id, status, starts_at, ends_at",
          )
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      setSummary(summaryData);
      setAssignments((assignmentRows.data ?? []) as OrgAssignmentRow[]);
    } catch (err) {
      console.error("Failed to load campaign coordination:", err);
      setLoadError(
        campaignErrorMessage(err, "We couldn't load the coordination view right now."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gate !== "ready") return;
    void (async () => {
      await load();
    })();
  }, [gate, load]);

  if (gate === "loading") {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading...
      </div>
    );
  }

  if (gate === "no_session") {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900">Sign in required</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to view campaign coordination.
        </p>
      </div>
    );
  }

  if (gate === "denied") {
    const message =
      denyReason === "module_disabled"
        ? "The Campaign module is not enabled for your organization."
        : denyReason === "social_only"
          ? "Social accounts do not have access to Campaign."
          : denyReason === "not_a_member"
            ? "Your account is not linked to an organization."
            : "You do not have access to campaign coordination.";
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900">Access restricted</h1>
        <p className="mt-2 text-sm text-gray-500">{message}</p>
        <Link
          href="/portal"
          className="mt-6 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Back to portal
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-10">
      {/* HEADER */}
      <div>
        <Link
          href="/portal/dashboard"
          className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-apc-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Campaign Dashboard
        </Link>

        <p className="text-sm font-semibold text-apc-primary">Campaign Council</p>

        <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
          Coordination
        </h1>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
          Your organization&apos;s campaign at a glance — aggregated within
          your authorized coverage.
        </p>
      </div>

      {/* SUMMARY TILES */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          icon={<Users className="h-5 w-5" />}
          label="Members"
          value={summary?.members}
          detail="Registered campaign members in your coverage"
        />
        <SummaryTile
          icon={<Flag className="h-5 w-5" />}
          label="Activities"
          value={summary?.activities.total}
          detail={`${summary?.activities.scheduled ?? 0} scheduled · ${summary?.activities.completed ?? 0} completed`}
        />
        <SummaryTile
          icon={<ClipboardList className="h-5 w-5" />}
          label="Assignments"
          value={summary?.assignments.total}
          detail={`${summary?.assignments.in_progress ?? 0} in progress · ${summary?.assignments.submitted ?? 0} submitted · ${summary?.assignments.overdue ?? 0} overdue`}
        />
        <SummaryTile
          icon={<TriangleAlert className="h-5 w-5" />}
          label="Issues"
          value={summary?.issues.total}
          detail={`${summary?.issues.open ?? 0} open · ${summary?.issues.resolved ?? 0} resolved · ${summary?.issues.verified ?? 0} verified`}
        />
      </div>

      {/* FIELD REPORTS STRIP */}
      {summary && (
        <Card className="border-apc-primary/10">
          <CardContent className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
                <Flag className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">Field reports</p>
                <p className="text-xs text-gray-500">
                  {summary.reports.submitted} submitted · {summary.reports.under_review} under review ·{" "}
                  {summary.reports.accepted} accepted · {summary.reports.returned} returned
                </p>
              </div>
            </div>
            <Link
              href="/portal/campaign/reports"
              className="text-xs font-bold text-apc-primary hover:underline"
            >
              Open Field Reports →
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ORGANIZATIONAL STRUCTURE — read-only display of Core data (§26) */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg">Organizational structure</CardTitle>
              <p className="mt-1 text-sm text-gray-500">
                {authority === "admin"
                  ? "Organizational assignments across your organization (read-only — managed through Core administration)."
                  : "Your organizational assignments (read-only display of Core data)."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex w-fit items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </CardHeader>

        <CardContent>
          {loadError && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <p className="text-sm font-medium text-red-800">{loadError}</p>
            </div>
          )}

          {assignments.length === 0 ? (
            <div className="py-10 text-center">
              <Building2 className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 font-semibold text-gray-900">
                No organizational assignments visible
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {authority === "admin"
                  ? "No assignments exist in your organization yet."
                  : "You hold no organizational assignment."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {assignments.map((a) => (
                <div
                  key={a.id}
                  className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-bold capitalize text-gray-900">
                        {a.position.replace(/_/g, " ")}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
                        <MapPin className="h-3.5 w-3.5" />
                        {formatScopeType(a.scope_type)} · {a.scope_id}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${
                        a.status === "active"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {a.status.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-gray-400">
                      {a.ends_at
                        ? `ends ${new Date(a.ends_at).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}`
                        : "no end date"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  detail: string;
}) {
  return (
    <Card className="border-apc-primary/10">
      <CardContent className="p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              {label}
            </p>
            <p className="text-2xl font-bold text-gray-900">
              {value === undefined ? "..." : value}
            </p>
          </div>
        </div>
        <p className="mt-2 truncate text-xs text-gray-500">{detail}</p>
      </CardContent>
    </Card>
  );
}
