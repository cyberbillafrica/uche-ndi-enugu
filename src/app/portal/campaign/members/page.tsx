"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { getWardById, getPollingUnitById } from "@/lib/constants";
import { useOrganizationalAssignments } from "@/hooks/useOrganizationalAssignments";
import { useScopedCampaignMembers } from "@/hooks/useScopedCampaignMembers";
import { isAdminUser } from "@/lib/permissions";
import {
  formatScopeType,
  getPrimaryOrganizationalScope,
  formatOrganizationalPosition,
} from "@/lib/organization";

export default function CampaignMembersPage() {
  const { profile } = useAuth();
  const { assignments, loading: assignmentsLoading } = useOrganizationalAssignments();

  const isAdmin = isAdminUser(profile);
  const primaryScope = getPrimaryOrganizationalScope(assignments);
  const assignment = primaryScope.assignment;

  const {
    members,
    loading: membersLoading,
    error,
    scopeSupported,
    refresh,
  } = useScopedCampaignMembers(assignment, profile);

  const [search, setSearch] = useState("");

  const filteredMembers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return members;

    return members.filter((member) => {
      return (
        member.full_name?.toLowerCase().includes(term) ||
        member.email?.toLowerCase().includes(term) ||
        member.phone?.toLowerCase().includes(term)
      );
    });
  }, [members, search]);

  if (!profile) return null;

  if (assignmentsLoading && !isAdmin) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-apc-primary" />
        <p className="text-sm text-gray-500">
          Loading your organizational scope...
        </p>
      </div>
    );
  }


  return (
    <div className="space-y-6 pb-8">
      <BackLink />
      <PageHeader />

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
                  {isAdmin ? "Global Campaign Scope" : "Your authorized organizational scope"}
                </p>

                <h2 className="mt-1 text-xl font-bold text-gray-900">
                  {isAdmin
                    ? "Administrator Directory"
                    : formatOrganizationalPosition(assignment?.position || null)}
                </h2>

                <p className="mt-1 text-sm text-gray-600">
                  {isAdmin
                    ? "State-Wide — All LGAs, Wards & Polling Units"
                    : `${formatScopeType(assignment?.scope_type || null)} · ${assignment?.scope_id}`}
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-gray-50 px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Members in scope
              </p>

              <p className="mt-1 text-2xl font-bold text-gray-900">
                {membersLoading ? "..." : members.length}
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
              <CardTitle className="text-lg">
                Campaign Member Directory
              </CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                {isAdmin
                  ? "Displaying all registered campaign members state-wide."
                  : "Members within your authorized campaign area."}
              </p>
            </div>

            <button
              type="button"
              onClick={refresh}
              disabled={membersLoading}
              className="inline-flex w-fit items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${membersLoading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
        </CardHeader>

        <CardContent>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search members by name, email or phone..."
              className="w-full rounded-xl border bg-white py-3 pl-10 pr-4 text-sm outline-none transition focus:border-apc-primary focus:ring-2 focus:ring-apc-primary/10"
            />
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">{error}</p>
            </div>
          )}

          {membersLoading ? (
            <DirectoryLoading />
          ) : filteredMembers.length === 0 ? (
            <div className="py-12 text-center">
              <Users className="mx-auto h-12 w-12 text-gray-300" />
              <p className="mt-4 font-semibold text-gray-900">
                {search ? "No matching members" : "No campaign members found"}
              </p>
              <p className="mt-2 text-sm text-gray-500">
                {search
                  ? "Try a different search term."
                  : "There are currently no campaign members in this scope."}
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {filteredMembers.map((member) => (
                <MemberRow key={member.id} member={member} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <p className="text-sm font-semibold text-apc-primary">Campaign Council</p>
      <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
        Member Directory
      </h1>
      <p className="mt-2 text-gray-600">
        View campaign members within your organizational area.
      </p>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/portal/dashboard"
      className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-apc-primary"
    >
      <ArrowLeft className="h-4 w-4" />
      Campaign Dashboard
    </Link>
  );
}

function MemberRow({ member }: { member: any }) {
  const ward = getWardById(member.ward_id);
  const pollingUnit = getPollingUnitById(member.ward_id, member.polling_unit_id);

  const puName = pollingUnit
    ? `${pollingUnit.code} — ${pollingUnit.name}`
    : member.polling_unit_id
    ? member.polling_unit_id
    : "Not set";

  const wardName = ward
    ? `${ward.code} — ${ward.name}`
    : member.ward_id
    ? member.ward_id
    : "Not set";

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

            <div className="mt-1 flex flex-wrap gap-2">
              {member.membership_types?.map((type: string) => (
                <span
                  key={type}
                  className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-semibold text-gray-600 capitalize"
                >
                  {type.replace("_", " ")}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-1 text-sm text-gray-700 min-w-[180px]">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-apc-primary shrink-0" />
            <span className="font-semibold text-gray-900">{member.phone || "No phone listed"}</span>
          </div>

          {member.email && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{member.email}</span>
            </div>
          )}
        </div>

        <div className="text-sm space-y-0.5 min-w-[220px]">
          <div className="flex items-center gap-2 text-gray-700">
            <MapPin className="h-4 w-4 text-emerald-600 shrink-0" />
            <span className="font-medium text-xs">Ward: {wardName}</span>
          </div>
          <p className="pl-6 text-xs text-gray-500 font-medium">
            PU: {puName}
          </p>
        </div>

        <Link
          href={`/portal/campaign/members/${member.id}`}
          className="inline-flex items-center gap-1 text-xs font-bold text-apc-primary hover:underline bg-apc-primary/5 px-3 py-1.5 rounded-lg border border-apc-primary/20 shrink-0"
        >
          View Profile
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}

function DirectoryLoading() {
  return (
    <div className="mt-5 space-y-3">
      {[1, 2, 3, 4].map((item) => (
        <div key={item} className="h-24 animate-pulse rounded-xl bg-gray-100" />
      ))}
    </div>
  );
}
