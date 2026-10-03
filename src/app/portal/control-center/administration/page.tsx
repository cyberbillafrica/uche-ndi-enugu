"use client";

/**
 * POLITICORE — Control Center Administration (Phase 26).
 *
 * The administrative ORIENTATION surface (prompt §21): a navigational control
 * plane over the authoritative consoles — never a duplicate domain console.
 *
 *   CONTROL CENTER CONFIGURES THE PLATFORM; MODULES OWN THEIR DOMAIN
 *   OPERATIONS.
 *
 * Authority: every data read flows through server-resolved, tenant-admin
 * RPCs (control_center_overview, control_center_site_config_status). The
 * access mirrors useAuth().isAdmin for presentation only — RPC authority is
 * the boundary (§15/§16). All destinations come from the typed code-side
 * registry; no database-driven routes (§11/§12/§34).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Globe,
  HeartPulse,
  LayoutDashboard,
  Loader2,
  Puzzle,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { useAuth } from "@/contexts/AuthContext";
import {
  getControlCenterOverview,
  getSiteConfigStatus,
  serviceStateLabel,
  type ServiceStatus,
  type SiteConfigAreaStatus,
} from "@/lib/supabase/controlCenter";
import {
  AREA_EDITOR_LINKS,
  CORE_ADMIN_LINKS,
  MODULE_ADMIN_LINKS,
  type AdminModule,
} from "@/lib/control-center/admin-registry";

const MODULE_ORDER: AdminModule[] = ["social", "campaign", "election", "governance"];

export default function ControlCenterAdministrationPage() {
  const toast = useToast();
  const { loading: authLoading, accessLoading, profile } = useAuth();

  // Presentation mirror of the AuthContext admin check — the RPC layer
  // (is_tenant_admin) remains the authority (§15/§16).
  const adminPresentation =
    profile?.access_role === "admin" ||
    profile?.access_role === "tenant_super_admin" ||
    profile?.access_role === "platform_super_admin";

  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [configStatus, setConfigStatus] = useState<SiteConfigAreaStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [overview, status] = await Promise.all([
        getControlCenterOverview(),
        getSiteConfigStatus(),
      ]);
      setServices(overview.services);
      setConfigStatus(status);
      setError(null);
    } catch (err) {
      // Fail closed on authority errors (member/platform surfaces get a
      // clear denial rather than a partial status picture — §16).
      const message = getErrorMessage(err);
      if (/authority|resolved/i.test(message)) {
        setDenied(true);
      } else {
        toast.error(message);
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    // Deferred so the effect body performs no synchronous setState
    // (react-hooks/set-state-in-effect). Presentation denial is derived
    // during render (below); only the async load flips state.
    if (authLoading || accessLoading) return;
    if (!adminPresentation) return;
    void Promise.resolve().then(load);
  }, [authLoading, accessLoading, adminPresentation, load]);

  // Derived presentation denial — authority itself remains RPC-resolved
  // (load() flips `denied` asynchronously when the server refuses).
  const presentationDenied = !authLoading && !accessLoading && !adminPresentation;

  const byModule = new Map(services.map((s) => [s.module, s]));
  const publishedCount = configStatus.filter((c) => c.published).length;

  if (denied || presentationDenied) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <XCircle className="mx-auto h-10 w-10 text-red-500" aria-hidden />
        <h1 className="mt-4 text-xl font-bold text-gray-900">Administration unavailable</h1>
        <p className="mt-2 text-sm text-gray-600">
          Tenant administration authority is required for the Control Center.
        </p>
        <Link href="/portal/dashboard" className="mt-6 inline-block text-sm text-green-700 hover:underline">
          Return to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <LayoutDashboard className="h-6 w-6 text-green-700" aria-hidden />
            Administration
          </h1>
          <p className="text-sm text-gray-600">
            Orientation and entry points. Each console below remains the authoritative owner of its domain.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      {error && !denied && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-800">
            <XCircle className="h-4 w-4 shrink-0" aria-hidden />
            {error}
          </CardContent>
        </Card>
      )}

      {/* Platform */}
      <section aria-labelledby="cc-admin-platform" className="space-y-3">
        <h2 id="cc-admin-platform" className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Platform
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600">
                <Puzzle className="h-4 w-4" aria-hidden /> Services
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-gray-900">
                {services.filter((s) => s.enabled).length}/{services.length || 4}
              </p>
              <p className="text-xs text-gray-500">activated · entitlement-gated</p>
              <Link href="/portal/control-center" className="mt-2 inline-block text-sm text-green-700 hover:underline">
                Manage services <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600">
                <Globe className="h-4 w-4" aria-hidden /> Website configuration
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-gray-900">
                {publishedCount}/{configStatus.length || 5}
              </p>
              <p className="text-xs text-gray-500">areas published</p>
              <Link href="#website" className="mt-2 inline-block text-sm text-green-700 hover:underline">
                Review website areas
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-gray-600">
                <HeartPulse className="h-4 w-4" aria-hidden /> System health
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700">Diagnostics and service availability.</p>
              <Link href="/portal/admin/health" className="mt-2 inline-block text-sm text-green-700 hover:underline">
                Open health <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Business modules — status + link-out (§3/§4/§10) */}
      <section aria-labelledby="cc-admin-modules" className="space-y-3">
        <h2 id="cc-admin-modules" className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Services
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {loading && services.length === 0
            ? (
              <div className="flex items-center justify-center py-10 text-gray-500 sm:col-span-2">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                <span className="ml-2 text-sm">Loading service status…</span>
              </div>
            )
            : MODULE_ORDER.map((code) => {
                const s = byModule.get(code);
                const state = s ? serviceStateLabel(s) : "Not available";
                const link = MODULE_ADMIN_LINKS[code];
                return (
                  <Card key={code}>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center justify-between text-base">
                        <span>{s?.label ?? link.label}</span>
                        <Badge
                          variant={state === "Active" ? "default" : state === "Dormant" ? "secondary" : "outline"}
                        >
                          {state}
                        </Badge>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <p className="flex items-center gap-1.5 text-xs text-gray-600">
                        {s?.entitled
                          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
                          : <XCircle className="h-3.5 w-3.5 text-gray-400" aria-hidden />}
                        Entitled: {s?.entitled ? "Yes" : "No"}
                      </p>
                      <p className="flex items-center gap-1.5 text-xs text-gray-600">
                        {s?.enabled
                          ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
                          : <XCircle className="h-3.5 w-3.5 text-gray-400" aria-hidden />}
                        Activated: {s?.enabled ? "Yes" : s?.entitled ? "No" : "unavailable"}
                      </p>
                      <p className="text-xs text-gray-500">{link.description}</p>
                      <Link
                        href={link.href}
                        className="inline-flex items-center gap-1 text-sm font-medium text-green-700 hover:underline"
                        aria-label={`Open ${s?.label ?? link.label} administration`}
                      >
                        Open Administration <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </CardContent>
                  </Card>
                );
              })}
        </div>
      </section>

      {/* Core administration (§5/§12) */}
      <section aria-labelledby="cc-admin-core" className="space-y-3">
        <h2 id="cc-admin-core" className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Core administration
        </h2>
        <Card>
          <CardContent className="grid gap-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
            {CORE_ADMIN_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="group rounded-lg border border-gray-200 p-4 transition-colors hover:border-green-300 hover:bg-green-50"
              >
                <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                  <Building2 className="h-4 w-4 text-green-700" aria-hidden />
                  {l.label}
                  <ArrowUpRight className="h-3.5 w-3.5 text-gray-400 transition-colors group-hover:text-green-700" aria-hidden />
                </p>
                <p className="mt-1 text-xs text-gray-500">{l.description}</p>
              </Link>
            ))}
          </CardContent>
        </Card>
        <p className="text-xs text-gray-500">
          Notifications, media and geography administration are exercised through their canonical
          flows (Core Notifications delivery, Core Media references in editors, tenant geography
          provisioning); no duplicate consoles exist by design.
        </p>
      </section>

      {/* Website configuration status (§14/§20) */}
      <section aria-labelledby="cc-admin-website" className="space-y-3">
        <h2 id="cc-admin-website" className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Website
        </h2>
        <Card>
          <CardContent className="py-2">
            {loading && configStatus.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                <span className="ml-2 text-sm">Loading configuration status…</span>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {configStatus.map((c) => {
                  const href = AREA_EDITOR_LINKS[c.area];
                  return (
                    <li key={c.area} className="flex items-center justify-between py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize text-gray-900">{c.area}</p>
                        <p className="text-xs text-gray-500">
                          {c.published
                            ? `Published${c.published_at ? ` · ${new Date(c.published_at).toLocaleString()}` : ""}`
                            : c.has_config
                              ? "Draft saved — not published"
                              : "Not configured"}
                        </p>
                      </div>
                      {href ? (
                        <Link href={href} className="shrink-0 text-sm text-green-700 hover:underline">
                          Open editor <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
                        </Link>
                      ) : (
                        <span className="shrink-0 text-xs text-gray-400">—</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
