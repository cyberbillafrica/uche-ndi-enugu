"use client";

/**
 * POLITICORE — Platform Tenant Lifecycle Console (Phase 31, SaaS D).
 *
 * Control Center surface for the tenant lifecycle: state, subscription
 * and restriction status, suspension reason, lifecycle timestamps,
 * history, and the authorized suspend/restore/archive actions. Every
 * mutation is a platform authority op with a MANDATORY reason — enforced
 * server-side by the SECURITY DEFINER RPCs; this UI mirrors it for
 * presentation only. NO new roles/permissions: platform_super_admin
 * authority is required by the server for every mutation.
 *
 * It extends the EXISTING administration surface family (billing/plans
 * consoles) — it does not duplicate any console.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import {
  getPlatformSubscriptions,
  getTenantLifecycleHistory,
  getTenantLifecycleStatus,
  restoreTenant,
  runLifecycleTransitions,
  suspendTenant,
  TENANT_LIFECYCLE_LABELS,
  archiveTenant,
  type LifecycleHistoryRow,
  type PlatformSubscriptionRow,
  type TenantLifecycleStatus,
} from "@/lib/supabase";
import { Loader2, ShieldAlert } from "lucide-react";

const LIFECYCLE_STYLES: Record<TenantLifecycleStatus, string> = {
  provisioning: "bg-sky-100 text-sky-800 border-sky-200",
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  past_due: "bg-amber-100 text-amber-800 border-amber-200",
  restricted: "bg-orange-100 text-orange-800 border-orange-200",
  suspended: "bg-red-100 text-red-800 border-red-200",
  cancellation_pending: "bg-purple-100 text-purple-800 border-purple-200",
  cancelled: "bg-gray-100 text-gray-600 border-gray-200",
  archived: "bg-gray-200 text-gray-700 border-gray-300",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminLifecyclePage() {
  const { profile } = useAuth();
  const toast = useToast();
  const [subscriptions, setSubscriptions] = useState<PlatformSubscriptionRow[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TenantLifecycleStatus>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<LifecycleHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const isPlatformAdmin = profile?.access_role === "platform_super_admin";

  const load = useCallback(async () => {
    const subs = await getPlatformSubscriptions();
    setSubscriptions(subs);
    const entries = await Promise.all(
      subs.map(async (s) => {
        try {
          return [s.tenant_id, await getTenantLifecycleStatus(s.tenant_id)] as const;
        } catch {
          return [s.tenant_id, "active"] as const;
        }
      })
    );
    setStatuses(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await load();
      } catch (err) {
        console.error("Failed to load lifecycle data:", err);
        if (!cancelled) toast.error("We couldn't load the lifecycle data. Please refresh.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, toast, load]);

  const act = async (
    key: string,
    tenantId: string,
    op: "suspend" | "restore" | "archive" | "sweep"
  ) => {
    const reason = (reasons[tenantId] ?? "").trim();
    if (op !== "sweep" && reason.length < 5) {
      toast.error("A reason of at least 5 characters is required.");
      return;
    }
    setBusy(key);
    try {
      if (op === "suspend") await suspendTenant(tenantId, reason);
      else if (op === "restore") await restoreTenant(tenantId, reason);
      else if (op === "archive") await archiveTenant(tenantId, reason);
      else await runLifecycleTransitions();
      toast.success(
        op === "sweep"
          ? "Lifecycle sweep completed."
          : `Tenant ${op === "suspend" ? "suspended" : op === "restore" ? "restored" : "archived"}.`
      );
      setReasons((r) => ({ ...r, [tenantId]: "" }));
      await load();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "The operation failed.");
    } finally {
      setBusy(null);
    }
  };

  const openHistory = async (tenantId: string) => {
    setHistoryFor(tenantId);
    try {
      setHistory(await getTenantLifecycleHistory(tenantId));
    } catch {
      setHistory([]);
    }
  };

  if (!isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-12 w-12 text-red-500" />
        <h1 className="text-xl font-bold text-gray-900">Platform authority required</h1>
        <p className="mt-2 text-gray-600">
          Tenant lifecycle management is a platform administration surface.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tenant lifecycle</h1>
          <p className="mt-1 text-sm text-gray-600">
            Restriction, suspension, cancellation and archival — distinct from subscription
            status and entitlements. All actions are audited with the reason you provide.
          </p>
        </div>
        <button
          type="button"
          disabled={busy === "sweep"}
          onClick={() => act("sweep", "", "sweep")}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
        >
          {busy === "sweep" && <Loader2 className="h-4 w-4 animate-spin" />}
          Run lifecycle sweep
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : subscriptions.length === 0 ? (
        <p className="rounded-xl bg-white p-8 text-center text-gray-500 shadow">
          No tenants with subscriptions found.
        </p>
      ) : (
        <div className="space-y-4">
          {subscriptions.map((s) => {
            const life = statuses[s.tenant_id] ?? "active";
            const operational = life === "active" || life === "past_due";
            return (
              <Card key={s.subscription_id}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-3 text-base">
                    <span className="font-bold">{s.tenant_name}</span>
                    <span className="text-xs text-gray-500">@{s.tenant_slug}</span>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${LIFECYCLE_STYLES[life]}`}
                    >
                      {TENANT_LIFECYCLE_LABELS[life]}
                    </span>
                    <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-semibold text-gray-600">
                      subscription: {s.status}
                    </span>
                    {!operational && (
                      <span className="text-xs font-semibold text-red-600">
                        operational access blocked
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-2 text-xs text-gray-600 sm:grid-cols-3">
                    <p>Plan: <span className="font-semibold">{s.plan_code} v{s.plan_version}</span></p>
                    <p>Failed payments: <span className="font-semibold">{s.failed_payment_count}</span></p>
                    <p>Past due since: <span className="font-semibold">{formatDate(s.past_due_since)}</span></p>
                  </div>

                  <input
                    type="text"
                    value={reasons[s.tenant_id] ?? ""}
                    onChange={(e) => setReasons((r) => ({ ...r, [s.tenant_id]: e.target.value }))}
                    placeholder="Reason (min 5 characters, recorded in the audit ledger)"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
                  />

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy === `${s.tenant_id}:suspend` || life === "suspended"}
                      onClick={() => act(`${s.tenant_id}:suspend`, s.tenant_id, "suspend")}
                      className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
                    >
                      Suspend
                    </button>
                    <button
                      type="button"
                      disabled={busy === `${s.tenant_id}:restore` || life === "active"}
                      onClick={() => act(`${s.tenant_id}:restore`, s.tenant_id, "restore")}
                      className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      disabled={busy === `${s.tenant_id}:archive` || !(life === "active" || life === "cancelled")}
                      onClick={() => act(`${s.tenant_id}:archive`, s.tenant_id, "archive")}
                      className="rounded-lg bg-gray-700 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-40"
                    >
                      Archive
                    </button>
                    <button
                      type="button"
                      onClick={() => openHistory(s.tenant_id)}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50"
                    >
                      History
                    </button>
                  </div>

                  {historyFor === s.tenant_id && (
                    <div className="rounded-lg bg-gray-50 p-3 text-xs">
                      {history.length === 0 ? (
                        <p className="text-gray-500">No lifecycle events recorded.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {history.map((h) => (
                            <li key={h.event_id} className="text-gray-700">
                              <span className="font-semibold">{formatDate(h.occurred_at)}</span>{" "}
                              {h.from_status ?? "?"} → {h.to_status ?? "?"}{" "}
                              <span className="text-gray-500">
                                by {h.actor_name ?? h.actor_email ?? "system"}
                                {h.reason ? ` — ${h.reason}` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
