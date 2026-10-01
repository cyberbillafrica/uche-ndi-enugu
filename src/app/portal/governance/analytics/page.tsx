"use client";

/**
 * POLITICORE — GOVERNANCE ANALYTICS & INSTITUTIONAL MEMORY (Phase 19).
 *
 * Staff surface over the 0058 DERIVED RPCs. Every number is computed
 * server-side from canonical records inside SECURITY DEFINER functions
 * that resolve tenant + authority + geographic scope themselves — the
 * page supplies nothing and can send nothing that widens its view.
 * Participation counts are bucketed; identities never appear.
 */

import { useEffect, useState } from "react";
import { Activity, ChartBar, Inbox, Landmark, Loader2, ScrollText, UsersRound } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAccountabilityAnalytics,
  getDeliveryAnalytics,
  getEngagementsAnalytics,
  getParticipationAnalytics,
  getRequestsAnalytics,
  listGovernanceMemoryTimeline,
  GOVERNANCE_MEMORY_KINDS,
  type GovernanceAccountabilityAnalytics,
  type GovernanceDeliveryAnalytics,
  type GovernanceEngagementsAnalytics,
  type GovernanceParticipationAnalytics,
  type GovernanceRequestsAnalytics,
  type GovernanceMemoryEntry,
} from "@/lib/supabase/governance";
import { useToast } from "@/components/ui/toast";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}

export default function GovernanceAnalyticsPage() {
  const [delivery, setDelivery] = useState<GovernanceDeliveryAnalytics | null>(null);
  const [requests, setRequests] = useState<GovernanceRequestsAnalytics | null>(null);
  const [participation, setParticipation] = useState<GovernanceParticipationAnalytics | null>(null);
  const [engagements, setEngagements] = useState<GovernanceEngagementsAnalytics | null>(null);
  const [accountability, setAccountability] = useState<GovernanceAccountabilityAnalytics | null>(null);
  const [memory, setMemory] = useState<GovernanceMemoryEntry[]>([]);
  const [memoryKind, setMemoryKind] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const toast = useToast();

  useEffect(() => {
    async function load() {
      try {
        const [d, r, p, e, a] = await Promise.all([
          getDeliveryAnalytics(),
          getRequestsAnalytics(),
          getParticipationAnalytics(),
          getEngagementsAnalytics(),
          getAccountabilityAnalytics(),
        ]);
        setDelivery(d[0] ?? null);
        setRequests(r[0] ?? null);
        setParticipation(p[0] ?? null);
        setEngagements(e[0] ?? null);
        setAccountability(a[0] ?? null);
      } catch (err: unknown) {
        if (String((err as Error).message).includes("view_governance")) setDenied(true);
        else toast.error("Unable to load governance analytics.");
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function loadMemory() {
      try {
        setMemory(await listGovernanceMemoryTimeline(memoryKind || undefined, 60, 0));
      } catch (err: unknown) {
        console.error(err);
      }
    }
    if (!loading && !denied) void loadMemory();
  }, [memoryKind, loading, denied]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Computing derived analytics…
      </div>
    );
  }

  if (denied) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-gray-500">
          Governance analytics are available to Governance staff (view_governance) only.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
          <ChartBar className="h-6 w-6 text-brand-primary" /> Governance Analytics
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Derived live from canonical Governance records — never stored counters.
          Counts respect your geographic authority; participation totals are
          privacy-bucketed.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox className="h-4 w-4 text-[#008751]" /> Requests / Cases
            </CardTitle>
          </CardHeader>
          <CardContent>
            {requests && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Total" value={requests.total} />
                  <Stat label="Open" value={requests.submitted + requests.acknowledged + requests.assigned + requests.in_progress + requests.awaiting_information} />
                  <Stat label="Resolved" value={requests.resolved} />
                  <Stat label="Closed" value={requests.closed} />
                  <Stat label="Rejected" value={requests.rejected} />
                  <Stat label="Resolved band" value={requests.resolved_bucket} />
                </div>
                <p className="mt-3 text-xs text-gray-500">
                  Median resolution: <span className="font-medium text-gray-700">{requests.median_resolution_days === "-" ? "no resolved cases yet" : `${requests.median_resolution_days} days`}</span>
                  {" · "}by-category: {Object.keys(requests.by_category).length} categories
                  {" · "}trend: {Object.keys(requests.by_month).length} months
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Landmark className="h-4 w-4 text-[#008751]" /> Delivery
            </CardTitle>
          </CardHeader>
          <CardContent>
            {delivery && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Projects" value={delivery.projects_total} />
                  <Stat label="Active" value={delivery.projects_active} />
                  <Stat label="Concluded" value={delivery.projects_concluded} />
                  <Stat label="Milestones" value={`${delivery.milestones_done}/${delivery.milestones_total}`} />
                  <Stat label="Commitments" value={delivery.commitments_total} />
                  <Stat label="Delivered" value={delivery.commitments_delivered} />
                  <Stat label="Commitments linked" value={delivery.commitments_with_projects} />
                  <Stat label="Unlinked" value={delivery.commitments_without_projects} />
                  <Stat label="Published" value={delivery.projects_published + delivery.commitments_published} />
                </div>
                <p className="mt-3 text-xs text-gray-500">
                  Ward-scoped projects: {Object.keys(delivery.projects_by_ward).length} wards
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UsersRound className="h-4 w-4 text-[#008751]" /> Participation
            </CardTitle>
          </CardHeader>
          <CardContent>
            {participation && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Consultations" value={participation.consultations_total} />
                <Stat label="Open" value={participation.consultations_open} />
                <Stat label="Results published" value={participation.consultations_results_published} />
                <Stat label="Responses band" value={participation.consultation_responses_bucket} />
                <Stat label="Surveys" value={participation.surveys_total} />
                <Stat label="Petitions" value={participation.petitions_total} />
                <Stat label="Petitions open" value={participation.petitions_open} />
                <Stat label="Verified support" value={participation.petitions_verified_support_bucket} />
                <Stat label="Proposals" value={participation.proposals_total} />
                <Stat label="Polls" value={participation.polls_total} />
                <Stat label="Results published" value={participation.polls_closed_published} />
                <Stat label="Votes band" value={participation.poll_votes_bucket} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-[#008751]" /> Engagements & Accountability
            </CardTitle>
          </CardHeader>
          <CardContent>
            {engagements && accountability && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Engagements" value={engagements.total} />
                  <Stat label="Concluded" value={engagements.concluded} />
                  <Stat label="Attendance" value={engagements.attendance_count} />
                  <Stat label="Issues addressed" value={engagements.issues_addressed + engagements.issues_closed} />
                  <Stat label="Follow-ups" value={engagements.followups} />
                  <Stat label="Public objects" value={accountability.published_projects + accountability.published_commitments + accountability.published_consultations + accountability.published_petitions + accountability.published_polls + accountability.published_engagements} />
                </div>
                <p className="mt-3 text-xs text-gray-500">
                  Public updates: {accountability.public_updates}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4 text-[#008751]" /> Institutional memory
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMemoryKind("")}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${memoryKind === "" ? "border-[#008751] bg-[#008751] text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
            >
              All
            </button>
            {GOVERNANCE_MEMORY_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setMemoryKind(k)}
                className={`rounded-full border px-3 py-1 text-xs font-medium capitalize ${memoryKind === k ? "border-[#008751] bg-[#008751] text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
              >
                {k}
              </button>
            ))}
          </div>
          {memory.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">
              No governance records yet — the timeline fills as the organization plans, consults, receives and delivers.
            </p>
          ) : (
            <ul className="space-y-2">
              {memory.map((m, i) => (
                <li key={`${m.kind}-${m.reference_code}-${i}`} className="flex items-center justify-between border-b border-gray-100 py-2 text-sm last:border-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">
                      <span className="mr-2 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">{m.kind}</span>
                      {m.title || "(untitled)"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {m.reference_code?.startsWith(/^[A-Z]{2}-/.source ? "" : "")}
                      {m.reference_code && !m.reference_code.match(/^[0-9a-f-]{36}$/) ? m.reference_code : ""}
                      {m.status ? ` · ${m.status}` : ""}
                      {" · "}
                      {new Date(m.occurred_at).toLocaleDateString()}
                      {m.published ? " · published" : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
