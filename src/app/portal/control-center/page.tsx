"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  LayoutDashboard,
  Loader2,
  Power,
  RefreshCw,
  Settings,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { useAuth } from "@/contexts/AuthContext";
import {
  SERVICE_LABELS,
  getControlCenterOverview,
  serviceStateLabel,
  setServiceEnabled,
  type ServiceCode,
  type ServiceStatus,
} from "@/lib/supabase/controlCenter";
import { MODULE_ADMIN_LINKS } from "@/lib/control-center/admin-registry";

/** Existing authoritative administration surfaces — Control Center links, never re-implements (Phase 26 §11: one canonical mapping). */
const SERVICE_ADMIN_LINKS = MODULE_ADMIN_LINKS;

type ConfirmState =
  | { kind: "none" }
  | { kind: "confirm"; module: ServiceCode; target: boolean };

export default function ControlCenterPage() {
  const toast = useToast();
  const { loading: authLoading, accessLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [busyModule, setBusyModule] = useState<ServiceCode | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: "none" });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const overview = await getControlCenterOverview();
      setServices(overview.services);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const overview = await getControlCenterOverview();
        setServices(overview.services);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    if (authLoading || accessLoading) return;
    void load();
  }, [authLoading, accessLoading]);

  async function applyToggle(module: ServiceCode, target: boolean) {
    setBusyModule(module);
    setConfirm({ kind: "none" });
    try {
      const result = await setServiceEnabled(module, target);
      setServices((prev) =>
        prev.map((s) => (s.module === module ? { ...s, ...result } : s))
      );
      toast.success(`${SERVICE_LABELS[module]} ${target ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
      void reload();
    } finally {
      setBusyModule(null);
    }
  }

  const enabledCount = services.filter((s) => s.enabled).length;
  const entitledCount = services.filter((s) => s.entitled).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <LayoutDashboard className="h-6 w-6 text-green-700" aria-hidden />
            Control Center
          </h1>
          <p className="text-sm text-gray-600">
            Configure the platform for this tenant. Services own their domain operations.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-800">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden />
            {error}
          </CardContent>
        </Card>
      )}

      {/* Overview summary (§23 — intentionally small) */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600">
              <Activity className="h-4 w-4" aria-hidden /> Services
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-gray-900">{services.length || 4} services</p>
            <p className="text-xs text-gray-500">
              {enabledCount} enabled · {entitledCount} entitled
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600">
              <Settings className="h-4 w-4" aria-hidden /> Website Experience
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Link href="/portal/control-center/website/branding" className="block text-green-700 hover:underline">
              Branding &amp; Theme <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
            </Link>
            <Link href="/portal/control-center/website/seo" className="block text-green-700 hover:underline">
              SEO &amp; metadata <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
            </Link>
            <p className="text-xs text-gray-500">Draft / published · revision-guarded</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600">
              <Users className="h-4 w-4" aria-hidden /> Administration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Link href="/portal/control-center/administration" className="block text-green-700 hover:underline">
              Administration overview <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
            </Link>
            <Link href="/portal/admin/members" className="block text-green-700 hover:underline">
              People &amp; access <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
            </Link>
            <Link href="/portal/admin/health" className="block text-green-700 hover:underline">
              System health <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Services (§9) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Services</CardTitle>
          <p className="text-sm text-gray-600">
            Activation is tenant-global, entitlement-checked, non-destructive and audited.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && services.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              <span className="ml-2 text-sm">Loading service status…</span>
            </div>
          ) : (
            services.map((s) => {
              const state = serviceStateLabel(s);
              const adminLink = SERVICE_ADMIN_LINKS[s.module];
              const confirming =
                confirm.kind === "confirm" && confirm.module === s.module;
              return (
                <div
                  key={s.module}
                  className="flex flex-col gap-3 rounded-lg border border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">{s.label}</span>
                      <Badge
                        variant={
                          state === "Active" ? "default" : state === "Dormant" ? "secondary" : "outline"
                        }
                      >
                        {state}
                      </Badge>
                      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                        {s.entitled ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden /> Entitled
                          </>
                        ) : (
                          <>
                            <XCircle className="h-3.5 w-3.5 text-gray-400" aria-hidden /> Not entitled
                          </>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                        {s.enabled ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden /> Enabled
                          </>
                        ) : (
                          <>
                            <XCircle className="h-3.5 w-3.5 text-gray-400" aria-hidden /> Disabled
                          </>
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {adminLink ? (
                        <>
                          Domain administration:{" "}
                          <Link href={adminLink.href} className="text-green-700 hover:underline">
                            {adminLink.label} <ArrowUpRight className="inline h-3 w-3" aria-hidden />
                          </Link>
                        </>
                      ) : (
                        "Domain administration remains with the service."
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {s.entitled ? (
                      confirming ? (
                        <>
                          <Button
                            size="sm"
                            variant={confirm.target ? "default" : "destructive"}
                            onClick={() => void applyToggle(s.module, confirm.target)}
                            disabled={busyModule !== null}
                          >
                            {busyModule === s.module ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            ) : (
                              <Power className="h-4 w-4" aria-hidden />
                            )}
                            {confirm.target ? `Enable ${s.label}` : `Disable ${s.label}`}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirm({ kind: "none" })}
                            disabled={busyModule !== null}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant={s.enabled ? "outline" : "default"}
                          onClick={() => setConfirm({ kind: "confirm", module: s.module, target: !s.enabled })}
                          disabled={busyModule !== null}
                        >
                          <Power className="h-4 w-4" aria-hidden />
                          {s.enabled ? "Disable" : "Enable"}
                        </Button>
                      )
                    ) : (
                      <span className="text-xs text-gray-500" title="Activation requires platform entitlement">
                        Activation unavailable
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
          {/* §11 semantics, surfaced once for all toggles */}
          {confirm.kind === "confirm" && (
            <p className="rounded-md bg-gray-50 p-3 text-xs text-gray-600">
              {confirm.target
                ? "Enabling makes this service operational again — existing data becomes available. Nothing is created or restored."
                : "Disabling makes this service unavailable — existing data remains intact and the service can be re-enabled later. Nothing is deleted or archived."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Website Experience (Phases 23–25 — all six editors are live) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Website Experience</CardTitle>
          <p className="text-sm text-gray-600">
            Configure branding, theme tokens, SEO, homepage composition, navigation,
            header and footer — each behind draft/publish with bounded history.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <ShieldCheck className="h-4 w-4 text-green-700" aria-hidden />
          <Link
            href="/portal/control-center/website/branding"
            className="text-green-700 hover:underline"
          >
            Branding &amp; Theme <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
          </Link>
          <Link
            href="/portal/control-center/website/seo"
            className="text-green-700 hover:underline"
          >
            SEO &amp; metadata <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
          </Link>
          <Link
            href="/portal/control-center/website/homepage"
            className="text-green-700 hover:underline"
          >
            Homepage <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
          </Link>
          <Link
            href="/portal/control-center/website/navigation"
            className="text-green-700 hover:underline"
          >
            Navigation <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
          </Link>
          <Link
            href="/portal/control-center/website/footer"
            className="text-green-700 hover:underline"
          >
            Footer <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
