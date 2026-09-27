"use client";

/**
 * POLITICORE — Campaign Member Directory (Phase E cutover: PostgreSQL/Supabase).
 *
 * A client of the Campaign foundation through src/lib/supabase/campaign.ts:
 *   * the directory population is resolved by the DATABASE —
 *     campaign_members_page composes over the authoritative
 *     campaign_members_in_scope RPC (0021/0024/0026). No tenant-wide
 *     download, no client scope fan-out, no browser filtering (the
 *     legacy useScopedCampaignMembers expansion pattern is gone — D2);
 *   * search and geographic filters run SERVER-side and can only
 *     narrow the already-authorized set — an unauthorized ward/LGA
 *     filter yields an empty page, never an unauthorized population;
 *   * pagination is scope-safe by construction (every page re-enters
 *     the same authority gate inside the definer RPC).
 *
 * The route gate is resolveCampaignAccess (database-resolved,
 * fail-closed); the RPC and the profiles RLS remain the authoritative
 * boundary. Contact fields are additionally gated server-side by
 * view_member_contacts — the UI only renders what the database returned.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import {
  CampaignError,
  getMembersPaged,
  resolveCampaignAccess,
  resolveIdentity,
  ensureSupabaseSession,
  getSupabaseClient,
  resolveScopeLabels,
  type CampaignAuthority,
  type CampaignDirectoryMember,
  type ScopeRef,
} from "@/lib/supabase";

const PAGE_SIZE = 20;

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
      return "Registered member";
  }
}

function campaignErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof CampaignError) return err.message;
  return fallback;
}

type Gate = "loading" | "no_session" | "denied" | "ready";

interface RowLabels {
  lga: string | null;
  ward: string | null;
  pu: string | null;
}

export default function CampaignMembersPage() {
  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");
  const [scopes, setScopes] = useState<ScopeRef[]>([]);

  const [members, setMembers] = useState<CampaignDirectoryMember[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Labels for the current page's distinct registered locations (≤ 3/page-size queries, batched). */
  const [labels, setLabels] = useState<Record<string, RowLabels>>({});

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
      setScopes(identity?.scopes ?? []);
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** One server-scoped, paged directory query — the database decides visibility. */
  const loadPage = useCallback(
    async (nextPage: number, nextSearch: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const supabase = getSupabaseClient();
        const result = await getMembersPaged(supabase, {
          search: nextSearch || undefined,
          limit: PAGE_SIZE,
          offset: nextPage * PAGE_SIZE,
        });
        setMembers(result.members);
        setTotal(result.total);
        setPage(nextPage);
      } catch (err) {
        console.error("Failed to load campaign member directory:", err);
        setLoadError(
          campaignErrorMessage(err, "We couldn't load the member directory right now."),
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (gate !== "ready") return;
    void (async () => {
      await loadPage(0, "");
    })();
  }, [gate, loadPage]);

  // Resolve display labels for the current page's registered locations.
  useEffect(() => {
    if (members.length === 0) return;
    let cancelled = false;
    (async () => {
      const supabase = getSupabaseClient();
      const lgaIds = [...new Set(members.map((m) => m.lga_id).filter(Boolean))] as string[];
      const wardIds = [...new Set(members.map((m) => m.ward_id).filter(Boolean))] as string[];
      const puIds = [...new Set(members.map((m) => m.polling_unit_id).filter(Boolean))] as string[];
      const next: Record<string, RowLabels> = {};
      await Promise.all([
        ...lgaIds.map(async (id) => {
          const parts = await resolveScopeLabels("lga", id, supabase);
          next[`lga:${id}`] = { lga: parts[parts.length - 1] ?? id, ward: null, pu: null };
        }),
        ...wardIds.map(async (id) => {
          const parts = await resolveScopeLabels("ward", id, supabase);
          next[`ward:${id}`] = { lga: null, ward: parts[parts.length - 1] ?? id, pu: null };
        }),
        ...puIds.map(async (id) => {
          const parts = await resolveScopeLabels("polling_unit", id, supabase);
          next[`pu:${id}`] = { lga: null, ward: null, pu: parts[parts.length - 1] ?? id };
        }),
      ]);
      if (!cancelled) setLabels((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [members]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const primaryScope: ScopeRef | null = scopes[0] ?? null;

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
          Sign in to view the campaign member directory.
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
            : "You do not have access to the campaign member directory.";
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
    <div className="space-y-6 pb-8">
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
          Member Directory
        </h1>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
          Campaign members within your authorized organizational area.
          Visibility is decided by the database — not by this page.
        </p>
      </div>

      {/* SCOPE SUMMARY */}
      <Card className="border-apc-primary/10">
        <CardContent className="p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
                <ShieldCheck className="h-6 w-6" />
              </div>

              <div>
                <p className="text-sm text-gray-500">
                  {authority === "admin"
                    ? "Tenant-wide directory authority"
                    : primaryScope
                      ? "Your authorized organizational scope"
                      : "Registered campaign member"}
                </p>

                <h2 className="mt-1 text-xl font-bold text-gray-900">
                  {authority === "admin"
                    ? "Administrator Directory"
                    : primaryScope
                      ? `${formatScopeType(primaryScope.scope_type)} · ${primaryScope.scope_id}`
                      : "Directory access"}
                </h2>

                {primaryScope && (
                  <p className="mt-1 text-sm text-gray-600">
                    {primaryScope.position_name.replace(/_/g, " ")}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-gray-50 px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Members in scope
              </p>

              <p className="mt-1 text-2xl font-bold text-gray-900">
                {loading && total === 0 ? "..." : total}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* DIRECTORY */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg">Campaign Member Directory</CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                {authority === "admin"
                  ? "All registered campaign members across your organization."
                  : "Members whose registered location falls within your coverage."}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void loadPage(page, search)}
              disabled={loading}
              className="inline-flex w-fit items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </CardHeader>

        <CardContent>
          {/* Server-side search (§30) — submitted to the RPC, not the browser. */}
          <form
            className="relative"
            onSubmit={(event) => {
              event.preventDefault();
              const term = searchInput.trim();
              setSearch(term);
              void (async () => {
                await loadPage(0, term);
              })();
            }}
          >
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search members by name, email or phone..."
              className="w-full rounded-xl border bg-white py-3 pl-10 pr-4 text-sm outline-none transition focus:border-apc-primary focus:ring-2 focus:ring-apc-primary/10"
            />
          </form>

          {loadError && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <p className="text-sm font-medium text-red-800">{loadError}</p>
            </div>
          )}

          {loading ? (
            <div className="mt-5 space-y-3">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="h-20 animate-pulse rounded-xl bg-gray-100" />
              ))}
            </div>
          ) : members.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="mx-auto h-12 w-12 text-gray-300" />
              <p className="mt-4 font-semibold text-gray-900">
                {search ? "No matching members" : "No campaign members found"}
              </p>
              <p className="mt-2 text-sm text-gray-500">
                {search
                  ? "Try a different search term."
                  : "There are currently no campaign members in your authorized scope."}
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {members.map((member) => (
                <MemberRow key={member.id} member={member} labels={labels} />
              ))}
            </div>
          )}

          {/* PAGINATION (§31) — scope-safe by construction; every page re-enters the authority gate. */}
          {total > PAGE_SIZE && !loading && (
            <div className="mt-6 flex items-center justify-between border-t pt-4">
              <button
                type="button"
                onClick={() => void loadPage(page - 1, search)}
                disabled={page === 0 || loading}
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>

              <p className="text-sm text-gray-500">
                Page {page + 1} of {pageCount} · {total} members
              </p>

              <button
                type="button"
                onClick={() => void loadPage(page + 1, search)}
                disabled={page + 1 >= pageCount || loading}
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MemberRow({
  member,
  labels,
}: {
  member: CampaignDirectoryMember;
  labels: Record<string, RowLabels>;
}) {
  const lga = member.lga_id ? labels[`lga:${member.lga_id}`]?.lga ?? null : null;
  const ward = member.ward_id ? labels[`ward:${member.ward_id}`]?.ward ?? null : null;
  const pu = member.polling_unit_id
    ? labels[`pu:${member.polling_unit_id}`]?.pu ?? null
    : null;

  return (
    <div className="rounded-xl border p-4 transition-colors hover:bg-gray-50">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3 min-w-[200px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-apc-primary/10 font-bold text-apc-primary">
            {member.full_name?.charAt(0)?.toUpperCase() ?? "M"}
          </div>

          <div>
            <p className="font-bold text-gray-900 text-base">
              {member.full_name || "Member"}
            </p>

            {member.position_name && (
              <p className="mt-0.5 text-xs font-semibold text-apc-primary">
                {formatScopeType(member.scope_type)} ·{" "}
                {member.position_name.replace(/_/g, " ")}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1 text-sm text-gray-700 min-w-[180px]">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-apc-primary shrink-0" />
            <span className="font-semibold text-gray-900">
              {member.phone || "No phone listed"}
            </span>
          </div>

          {member.email && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{member.email}</span>
            </div>
          )}
        </div>

        {/* Registered location (§11/§16) — distinct from any organizational position above. */}
        <div className="text-sm space-y-0.5 min-w-[220px]">
          <div className="flex items-center gap-2 text-gray-700">
            <MapPin className="h-4 w-4 text-emerald-600 shrink-0" />
            <span className="font-medium text-xs">
              Ward: {ward ?? "Not set"}
            </span>
          </div>
          <p className="pl-6 text-xs text-gray-500 font-medium">
            LGA: {lga ?? "Not set"}
          </p>
          <p className="pl-6 text-xs text-gray-500 font-medium">
            PU: {pu ?? "Not set"}
          </p>
        </div>
      </div>
    </div>
  );
}
