"use client";

/**
 * POLITICORE — Campaign Area (Phase E cutover: PostgreSQL/Supabase).
 *
 * The user's operating area, derived ONLY from (§15):
 *   * Core identity — registered location (ward/LGA/PU) and active
 *     organizational assignments (my_scopes), and
 *   * Core geography — live relational reference data.
 *
 * No route parameter can grant authority: this page reads no scope from
 * the URL at all. Registered location and organizational assignment are
 * displayed as the DISTINCT concepts they are (§16) — one describes
 * where the person is registered, the other where they operate.
 *
 * The route gate is resolveCampaignAccess (database-resolved,
 * fail-closed); the RPC/RLS remain the authoritative boundary.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  MapPin,
  ShieldCheck,
  Users,
  Vote,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import {
  resolveCampaignAccess,
  resolveIdentity,
  ensureSupabaseSession,
  getSupabaseClient,
  getGeographyCounts,
  resolveScopeLabels,
  type CampaignAuthority,
  type ScopeRef,
} from "@/lib/supabase";

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

interface AreaIdentity {
  wardId: string | null;
  lgaId: string | null;
  puId: string | null;
  scopes: ScopeRef[];
}

type Gate = "loading" | "no_session" | "denied" | "ready";

export default function CampaignAreaPage() {
  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");
  const [area, setArea] = useState<AreaIdentity | null>(null);

  const [labels, setLabels] = useState<{ lga?: string; ward?: string; pu?: string }>({});
  const [counts, setCounts] = useState<{ lgas: number; wards: number; pollingUnits: number } | null>(
    null,
  );

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

      const identity = await resolveIdentity(supabase);
      if (cancelled) return;
      setArea({
        wardId: identity?.profile?.ward_id ?? null,
        lgaId: identity?.profile?.lga_id ?? null,
        puId: identity?.profile?.polling_unit_id ?? null,
        scopes: identity?.scopes ?? [],
      });
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Labels for the registered location + structural counts (live geography).
  useEffect(() => {
    if (gate !== "ready" || !area) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      const [countData, lgaParts, wardParts, puParts] = await Promise.all([
        getGeographyCounts(supabase),
        area.lgaId ? resolveScopeLabels("lga", area.lgaId, supabase) : Promise.resolve(null),
        area.wardId ? resolveScopeLabels("ward", area.wardId, supabase) : Promise.resolve(null),
        area.puId ? resolveScopeLabels("polling_unit", area.puId, supabase) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setCounts(countData);
      setLabels({
        lga: lgaParts ? lgaParts[lgaParts.length - 1] : undefined,
        ward: wardParts ? wardParts[wardParts.length - 1] : undefined,
        pu: puParts ? puParts[puParts.length - 1] : undefined,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, area]);

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
        <p className="mt-2 text-sm text-gray-500">Sign in to view your campaign area.</p>
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
            : "You do not have access to campaign areas.";
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

  const primaryScope = area?.scopes[0] ?? null;

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
          My Campaign Area
        </h1>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
          Your registered location and organizational operating area — resolved
          from the Core identity system.
        </p>
      </div>

      {/* REGISTERED LOCATION (§16 — distinct from organizational assignment) */}
      <Card className="border-apc-primary/10">
        <CardHeader>
          <CardTitle className="text-lg">Registered location</CardTitle>
          <p className="mt-1 text-sm text-gray-500">
            Where you are registered — not an organizational position.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">LGA</p>
              <p className="mt-1 font-bold text-gray-900">{labels.lga ?? "Not set"}</p>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Ward</p>
              <p className="mt-1 font-bold text-gray-900">{labels.ward ?? "Not set"}</p>
            </div>
            <div className="rounded-xl bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Polling Unit
              </p>
              <p className="mt-1 font-bold text-gray-900">{labels.pu ?? "Not set"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ORGANIZATIONAL ASSIGNMENTS (§16 — where the person operates) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Organizational assignments</CardTitle>
          <p className="mt-1 text-sm text-gray-500">
            Where you operate — active positions from the Core organizational
            model (read-only display).
          </p>
        </CardHeader>
        <CardContent>
          {(area?.scopes.length ?? 0) === 0 ? (
            <div className="py-8 text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 font-semibold text-gray-900">
                No organizational assignment
              </p>
              <p className="mt-1 text-sm text-gray-500">
                You hold no active organizational position.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {area!.scopes.map((s: ScopeRef) => (
                <div
                  key={`${s.scope_type}:${s.scope_id}`}
                  className="flex items-center justify-between rounded-xl border p-4"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
                      <ShieldCheck className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-bold capitalize text-gray-900">
                        {s.position_name.replace(/_/g, " ")}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {formatScopeType(s.scope_type)} · {s.scope_id}
                      </p>
                    </div>
                  </div>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                    active
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* COVERAGE SNAPSHOT — live relational geography, never client constants */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {primaryScope ? "Coverage snapshot" : "State structure"}
          </CardTitle>
          <p className="mt-1 text-sm text-gray-500">
            {authority === "admin" || primaryScope?.scope_type === "state"
              ? "The full organizational geography of the deployment."
              : primaryScope
                ? `The geography beneath ${formatScopeType(primaryScope.scope_type)} level.`
                : "The deployment's organizational geography."}
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-4">
              <MapPin className="h-5 w-5 text-apc-primary" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  LGAs
                </p>
                <p className="text-xl font-bold text-gray-900">
                  {counts?.lgas ?? "..."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-4">
              <Vote className="h-5 w-5 text-apc-primary" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Wards
                </p>
                <p className="text-xl font-bold text-gray-900">
                  {counts?.wards ?? "..."}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-gray-50 p-4">
              <Users className="h-5 w-5 text-apc-primary" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Polling Units
                </p>
                <p className="text-xl font-bold text-gray-900">
                  {counts?.pollingUnits ?? "..."}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
