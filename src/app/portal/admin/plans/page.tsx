"use client";

/**
 * POLITICORE — Commercial Plans (Phase 28, SaaS A).
 *
 * Minimal platform-admin catalog view: plans and their immutable versions,
 * with activate/retire lifecycle actions. Authority is enforced entirely
 * server-side (SECURITY DEFINER RPCs); this UI mirrors it for presentation
 * only and never decides it. No tenant Control Center surface — plans are
 * a platform concern, not a tenant setting.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import {
  PLAN_MODULE_LABELS,
  activatePlanVersion,
  getPlanCatalogAdmin,
  retirePlanVersion,
  type PlanCatalogVersionRow,
  type PlanModule,
  type PlanVersionStatus,
} from "@/lib/supabase";
import { CreditCard, Loader2, ShieldAlert } from "lucide-react";

const STATUS_STYLES: Record<PlanVersionStatus, string> = {
  draft: "bg-amber-100 text-amber-800 border-amber-200",
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  retired: "bg-gray-100 text-gray-600 border-gray-200",
};

/** Integer minor units → display string. Presentation only. */
function formatMoney(amount: number, currency: string): string {
  const symbol = currency === "NGN" ? "₦" : `${currency} `;
  return `${symbol}${(amount / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
}

function formatLimit(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unlimited";
  return value.toLocaleString("en-NG");
}

const LIMIT_LABELS: Array<[string, string]> = [
  ["max_members", "Members"],
  ["max_storage_bytes", "Storage (bytes)"],
  ["max_custom_domains", "Custom domains"],
  ["max_governance_requests", "Governance requests"],
  ["max_social_tasks", "Social tasks"],
  ["max_campaign_activities", "Campaign activities"],
  ["max_election_records", "Election records"],
  ["max_notifications", "Notifications"],
];

const FEATURE_LABELS: Array<[string, string]> = [
  ["governance_projects", "Governance projects"],
  ["governance_participation", "Governance participation"],
  ["governance_accountability", "Governance accountability"],
  ["custom_domains", "Custom domains"],
  ["advanced_analytics", "Advanced analytics"],
];

export default function AdminPlansPage() {
  const { profile } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<PlanCatalogVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);

  const isPlatformAdmin = profile?.access_role === "platform_super_admin";

  const load = useCallback(async () => {
    try {
      setRows(await getPlanCatalogAdmin());
    } catch (err) {
      console.error("Failed to load the plan catalog:", err);
      toast.error("We couldn't load the plan catalog. Please refresh and try again.");
    }
  }, [toast]);

  useEffect(() => {
    if (!isPlatformAdmin) return;
    let cancelled = false;
    async function loadCatalog() {
      setLoading(true);
      try {
        const catalog = await getPlanCatalogAdmin();
        if (!cancelled) setRows(catalog);
      } catch (err) {
        console.error("Failed to load the plan catalog:", err);
        if (!cancelled) toast.error("We couldn't load the plan catalog. Please refresh and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, [isPlatformAdmin, toast]);

  /** Group catalog rows by plan identity, keeping server sort order. */
  const plans = useMemo(() => {
    const byPlan = new Map<string, PlanCatalogVersionRow[]>();
    for (const row of rows) {
      const list = byPlan.get(row.plan_id) ?? [];
      list.push(row);
      byPlan.set(row.plan_id, list);
    }
    return Array.from(byPlan.entries()).map(([planId, versions]) => ({
      planId,
      plan: versions[0],
      versions: versions.sort((a, b) => b.version - a.version),
    }));
  }, [rows]);

  async function onActivate(versionId: string) {
    setBusyVersionId(versionId);
    try {
      await activatePlanVersion(versionId, "Activated from the platform plans console");
      toast.success("Plan version activated.");
      await load();
    } catch (err) {
      console.error("Failed to activate plan version:", err);
      toast.error(err instanceof Error ? err.message : "Activation failed.");
    } finally {
      setBusyVersionId(null);
    }
  }

  async function onRetire(versionId: string) {
    setBusyVersionId(versionId);
    try {
      await retirePlanVersion(versionId, "Retired from the platform plans console");
      toast.success("Plan version retired.");
      await load();
    } catch (err) {
      console.error("Failed to retire plan version:", err);
      toast.error(err instanceof Error ? err.message : "Retirement failed.");
    } finally {
      setBusyVersionId(null);
    }
  }

  if (!isPlatformAdmin) {
    return (
      <div className="max-w-7xl mx-auto pb-12">
        <Card>
          <CardContent className="p-8 text-center">
            <ShieldAlert className="h-10 w-10 mx-auto text-gray-400" />
            <h1 className="mt-3 text-lg font-bold text-gray-900">Platform administration only</h1>
            <p className="mt-1 text-sm text-gray-500">
              Commercial plans are managed by platform administrators.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading the commercial plan catalog...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto">
      <div>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-brand-primary mb-1">
          <CreditCard className="h-4 w-4" />
          <span>Commercial Plans &amp; Entitlements</span>
        </div>
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Plan Catalog</h1>
        <p className="text-sm text-gray-500 mt-1">
          Immutable plan versions with pricing, modules, features and limits. Activation and
          retirement are lifecycle edges enforced by the database; historical versions are never
          rewritten.
        </p>
      </div>

      {plans.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-gray-500">
            No plans have been created yet.
          </CardContent>
        </Card>
      ) : (
        plans.map(({ planId, plan, versions }) => (
          <Card key={planId}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>
                  {plan.plan_name}
                  <span className="ml-2 text-xs font-mono text-gray-400">{plan.plan_code}</span>
                </span>
                <span
                  className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${
                    plan.is_active
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-gray-50 text-gray-500 border-gray-200"
                  }`}
                >
                  {plan.is_active ? "listed" : "unlisted"}
                </span>
              </CardTitle>
              {plan.description ? (
                <p className="text-xs text-gray-500">{plan.description}</p>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {versions.map((v) => (
                <div key={v.version_id} className="rounded-xl border p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900">Version {v.version}</span>
                      <span
                        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${STATUS_STYLES[v.status]}`}
                      >
                        {v.status}
                      </span>
                      {v.trial_enabled ? (
                        <span className="text-[10px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded">
                          {v.trial_days}-day trial
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {v.status === "draft" ? (
                        <button
                          type="button"
                          disabled={busyVersionId === v.version_id}
                          onClick={() => void onActivate(v.version_id)}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand-primary text-white disabled:opacity-50"
                        >
                          {busyVersionId === v.version_id ? "Working..." : "Activate"}
                        </button>
                      ) : null}
                      {v.status === "active" ? (
                        <button
                          type="button"
                          disabled={busyVersionId === v.version_id}
                          onClick={() => void onRetire(v.version_id)}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 disabled:opacity-50"
                        >
                          {busyVersionId === v.version_id ? "Working..." : "Retire"}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <div className="text-gray-500">Monthly</div>
                      <div className="font-semibold text-gray-900">
                        {v.prices.monthly != null
                          ? formatMoney(v.prices.monthly, v.currency)
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Annual</div>
                      <div className="font-semibold text-gray-900">
                        {v.prices.annual != null ? formatMoney(v.prices.annual, v.currency) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Effective from</div>
                      <div className="font-semibold text-gray-900">
                        {v.effective_from ? new Date(v.effective_from).toLocaleDateString() : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-500">Effective to</div>
                      <div className="font-semibold text-gray-900">
                        {v.effective_to ? new Date(v.effective_to).toLocaleDateString() : "—"}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {v.included_modules.map((m: PlanModule) => (
                      <span
                        key={m}
                        className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-brand-primary/10 text-brand-primary"
                      >
                        {PLAN_MODULE_LABELS[m]}
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[11px] text-gray-600">
                    {LIMIT_LABELS.map(([key, label]) => (
                      <div key={key} className="flex justify-between border-b border-dashed border-gray-100 py-0.5">
                        <span>{label}</span>
                        <span className="font-semibold text-gray-800">
                          {formatLimit(v.limits?.[key as keyof typeof v.limits] ?? null)}
                        </span>
                      </div>
                    ))}
                    {FEATURE_LABELS.map(([key, label]) => (
                      <div key={key} className="flex justify-between border-b border-dashed border-gray-100 py-0.5">
                        <span>{label}</span>
                        <span className="font-semibold text-gray-800">
                          {v.feature_entitlements?.[key as keyof typeof v.feature_entitlements]
                            ? "Included"
                            : "Not included"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
