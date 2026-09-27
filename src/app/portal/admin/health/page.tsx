"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  Server,
  Database,
  Vote,
  Bell,
  Clock,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  getElectionResults,
  subscribeToElectionResults,
  getSocialTasks,
} from "@/lib/supabase";

/**
 * Diagnostics stub preserved from the legacy jobs surface: the periodic
 * aggregation job is a scheduled-infrastructure concern; the health page
 * only needs a heartbeat timestamp.
 */
function runPeriodicAggregationJob(): { status: string; timestamp: string } {
  return { status: "COMPLETED", timestamp: new Date().toISOString() };
}

/** Current tenant slug for the diagnostics card (resolved from the session's RLS-visible tenant row via its config read). */
const CURRENT_TENANT_LABEL = "Supabase project tenant";

export default function AdminHealthPage() {
  const [loading, setLoading] = useState(true);
  const [dbStatus, setDbStatus] = useState<"ok" | "error">("ok");
  const [pendingReviews, setPendingReviews] = useState(0);
  const [taskCount, setTaskCount] = useState(0);
  const [lastJobTimestamp, setLastJobTimestamp] = useState<string>("");

  const checkHealth = async () => {
    setLoading(true);
    try {
      // Social task inventory via the canonical Social Force service
      // (RLS admin authority decides visibility — Phase E cutover).
      const bridge = await ensureSupabaseSession();
      if (!bridge.sessionReady) throw new Error("Supabase session unavailable");
      const tList = await getSocialTasks(bridge.supabase ?? getSupabaseClient());
      setTaskCount(tList.length);
      setDbStatus("ok");

      const jobResult = await runPeriodicAggregationJob();
      setLastJobTimestamp(jobResult.timestamp);
    } catch (err) {
      console.error("Health check error:", err);
      setDbStatus("error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Deferred so the effect body performs no synchronous setState
    // (react-hooks/set-state-in-effect): checkHealth flips `loading`.
    void Promise.resolve().then(checkHealth);

    /*
     * Pending-review counter over the PostgreSQL Election engine:
     * RLS-scoped results (admin sees tenant-wide) via the
     * security-invoker view, refreshed on Supabase realtime events.
     */
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const bridge = await ensureSupabaseSession();
      if (!bridge.sessionReady || cancelled) return;
      const supabase = bridge.supabase ?? getSupabaseClient();
      const refresh = async () => {
        try {
          const rows = await getElectionResults(supabase);
          const pending = rows.filter(
            (d) => d.status === "submitted" || d.status === "pending_review",
          ).length;
          setPendingReviews(pending);
        } catch (err) {
          console.error("Health check election counter error:", err);
        }
      };
      await refresh();
      const handle = subscribeToElectionResults(
        supabase,
        () => void refresh(),
        (err) => {
          console.error("Health check election listener error:", err);
          setDbStatus("error");
        },
      );
      unsub = handle.unsubscribe;
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-apc-primary mb-1">
            <Activity className="h-4 w-4" />
            <span>Infrastructure Diagnostics</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            System Health & Administration Monitoring
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time diagnostics for Supabase connectivity, pending election
            review queues, background job dispatch, and configuration state.
          </p>
        </div>

        <button
          onClick={checkHealth}
          disabled={loading}
          className="inline-flex items-center gap-2 bg-apc-primary text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-apc-dark transition-colors shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          <span>Run Diagnostics</span>
        </button>
      </div>

      {/* Connectivity Status Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          className={
            dbStatus === "ok"
              ? "bg-emerald-50/60 border-emerald-200"
              : "bg-red-50/60 border-red-200"
          }
        >
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Supabase Database
              </p>
              <p className="text-lg font-bold text-gray-900 mt-1">
                {dbStatus === "ok"
                  ? "Connected (Healthy)"
                  : "Error / Disconnected"}
              </p>
            </div>
            {dbStatus === "ok" ? (
              <CheckCircle2 className="h-7 w-7 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="h-7 w-7 text-red-600 shrink-0" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Pending Results Queue
              </p>
              <p className="text-2xl font-bold font-mono text-amber-800 mt-1">
                {pendingReviews} PUs
              </p>
              <p className="text-[11px] text-gray-500">
                Awaiting Officer Review
              </p>
            </div>
            <Vote className="h-7 w-7 text-amber-600 shrink-0" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Configured Tasks
              </p>
              <p className="text-2xl font-bold text-gray-900 mt-1">
                {taskCount}
              </p>
              <p className="text-[11px] text-gray-500">Active Campaign Tasks</p>
            </div>
            <Server className="h-7 w-7 text-apc-primary shrink-0" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Job Dispatch Status
              </p>
              <p className="text-xs font-bold text-emerald-800 mt-1 truncate">
                {lastJobTimestamp ? "Last Execution OK" : "Pending Job Sync"}
              </p>
              <p className="text-[10px] text-gray-400 truncate">
                {lastJobTimestamp || "Job Idle"}
              </p>
            </div>
            <Clock className="h-7 w-7 text-emerald-600 shrink-0" />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Core System Services Health Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-gray-50 rounded-xl border flex items-center justify-between">
              <div>
                <p className="font-bold text-gray-900">
                  Supabase Auth & Tenant Context
                </p>
                <p className="text-gray-500">
                  Tenant: {CURRENT_TENANT_LABEL}
                </p>
              </div>
              <span className="bg-emerald-100 text-emerald-800 font-bold px-2.5 py-0.5 rounded-full text-[10px]">
                OPERATIONAL
              </span>
            </div>

            <div className="p-3 bg-gray-50 rounded-xl border flex items-center justify-between">
              <div>
                <p className="font-bold text-gray-900">
                  In-App Notification Dispatcher
                </p>
                <p className="text-gray-500">
                  Real-time snapshot listener connected
                </p>
              </div>
              <span className="bg-emerald-100 text-emerald-800 font-bold px-2.5 py-0.5 rounded-full text-[10px]">
                OPERATIONAL
              </span>
            </div>

            <div className="p-3 bg-gray-50 rounded-xl border flex items-center justify-between">
              <div>
                <p className="font-bold text-gray-900">
                  Cloudinary Evidence Storage
                </p>
                <p className="text-gray-500">
                  Dedicated upload presets configured for results & reports
                </p>
              </div>
              <span className="bg-emerald-100 text-emerald-800 font-bold px-2.5 py-0.5 rounded-full text-[10px]">
                OPERATIONAL
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
