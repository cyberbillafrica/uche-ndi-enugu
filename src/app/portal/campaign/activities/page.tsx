"use client";

/**
 * POLITICORE — Campaign Activities (Phase B cutover: PostgreSQL/Supabase).
 *
 * A client of the Campaign foundation through src/lib/supabase/campaign.ts:
 *   * listing is ONE RLS-scoped query — the legacy client-side
 *     expandAssignmentToScopes() per-scope fan-out is gone (D1);
 *   * creation flows the policy-guarded insert (tenant/creator/status are
 *     server-resolved, never payload fields);
 *   * detail edits flow the update_campaign_activity RPC (0022) — direct
 *     UPDATE is revoked; authority-bearing fields are not editable here;
 *   * status changes flow set_campaign_activity_status only;
 *   * RSVP flows join_campaign_activity (own row, UNIQUE(activity,user));
 *   * attendance flows record_campaign_attendance — an OPERATIONAL FACT
 *     recorded by an authorized supervisor. The legacy self-service
 *     "Check In Now" (embedded participant arrays) had no authority model
 *     and is deliberately replaced by supervisor recording (§9/§10).
 *
 * The route gate is resolveCampaignAccess (database-resolved, fail-closed);
 * the RPCs, view RLS, and policies remain the authoritative boundary.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Loader2,
  MapPin,
  Plus,
  Users,
  X,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

import {
  CampaignError,
  createActivity,
  deleteActivity,
  getActivities,
  getParticipants,
  recordAttendance,
  setRsvp,
  transitionActivity,
  updateActivity,
  resolveCampaignAccess,
  ensureSupabaseSession,
  getSupabaseClient,
  type CampaignActivity as SupabaseActivity,
  type CampaignActivityParticipant,
  type CampaignActivityStatus,
  type CampaignActivityType,
  type CampaignAttendanceState,
  type CampaignRsvp,
  type CampaignScopeType,
  type CampaignAuthority,
} from "@/lib/supabase";

import type { OrganizationalAssignment } from "@/types";

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

const ACTIVITY_TYPES: Array<{ value: CampaignActivityType; label: string }> = [
  { value: "meeting", label: "Meeting" },
  { value: "rally", label: "Rally" },
  { value: "community_engagement", label: "Community Engagement" },
  { value: "training", label: "Training" },
  { value: "stakeholder_engagement", label: "Stakeholder Engagement" },
  { value: "ward_meeting", label: "Ward Meeting" },
  { value: "lga_meeting", label: "LGA Meeting" },
  { value: "campaign_outreach", label: "Campaign Outreach" },
  { value: "other", label: "Other" },
];

function formatActivityType(type: CampaignActivityType): string {
  return ACTIVITY_TYPES.find((t) => t.value === type)?.label ?? type;
}

function formatStatus(status: CampaignActivityStatus): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";
    case "postponed":
      return "Postponed";
    case "cancelled":
      return "Cancelled";
    case "completed":
      return "Completed";
    default:
      return status;
  }
}

function formatScopeType(scopeType: CampaignScopeType): string {
  switch (scopeType) {
    case "campaign":
      return "Campaign";
    case "state":
      return "State";
    case "senatorial_zone":
      return "Zone";
    case "lga":
      return "LGA";
    case "ward":
      return "Ward";
    case "polling_unit":
      return "Polling Unit";
    default:
      return scopeType;
  }
}

/** Compose date + optional times into an ISO timestamp (local time). */
function composeTimestamp(date: string, time?: string, fallbackTime = "00:00"): string {
  return new Date(`${date}T${time || fallbackTime}`).toISOString();
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function campaignErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof CampaignError) return err.message;
  return fallback;
}

/*
 * ============================================================
 * PAGE
 * ============================================================
 */

type Gate = "loading" | "no_session" | "denied" | "ready";

export default function CampaignActivitiesPage() {
  const { user, profile, assignments } = useAuth();
  const toast = useToast();

  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");

  const [activities, setActivities] = useState<SupabaseActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);

  const activeAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.status === "active"),
    [assignments],
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
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── load: one RLS-scoped query (database determines visibility) ──────
  const loadActivities = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getActivities(getSupabaseClient());
      setActivities(data);
    } catch (err) {
      console.error("Failed to load campaign activities:", err);
      setLoadError(
        campaignErrorMessage(err, "We couldn't load campaign activities right now."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: cancelled-flag async pattern (setState never fires
  // synchronously in the effect body); loadActivities stays for the
  // interactive refresh path.
  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getActivities(getSupabaseClient());
        if (cancelled) return;
        setActivities(data);
        setLoading(false);
      } catch (err) {
        console.error("Failed to load campaign activities:", err);
        if (cancelled) return;
        setLoadError(
          campaignErrorMessage(err, "We couldn't load campaign activities right now."),
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  const filteredActivities = useMemo(() => {
    return activities.filter((act) => {
      if (filterType !== "all" && act.activity_type !== filterType) return false;
      if (filterStatus !== "all" && act.status !== filterStatus) return false;
      if (search.trim()) {
        const term = search.trim().toLowerCase();
        return (
          act.title.toLowerCase().includes(term) ||
          (act.venue && act.venue.toLowerCase().includes(term)) ||
          (act.description && act.description.toLowerCase().includes(term))
        );
      }
      return true;
    });
  }, [activities, filterType, filterStatus, search]);

  /*
   * ----------------------------------------------------------
   * GATE STATES
   * ----------------------------------------------------------
   */

  if (gate === "loading" || (!profile && gate !== "denied")) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading campaign activities...</span>
        </div>
      </div>
    );
  }

  if (gate === "no_session" || !user) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900">Sign in required</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to view your campaign activities.
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
            : "You do not have access to Campaign activities.";
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

  const canCreateActivity = authority === "admin" || authority === "scoped";
  const canManageActivities = authority === "admin";

  /*
   * ----------------------------------------------------------
   * PAGE
   * ----------------------------------------------------------
   */

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* HEADER */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/portal/campaign"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary mb-3"
          >
            <ChevronLeft className="h-4 w-4" />
            Campaign Dashboard
          </Link>

          <h1 className="text-2xl font-bold text-gray-900">Campaign Activities</h1>

          <p className="mt-1 text-sm text-gray-500">
            Meetings, rallies, outreach, training and other activities within
            your organizational scope.
          </p>
        </div>

        {canCreateActivity && (
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Activity
          </button>
        )}
      </div>

      {/* AUTHORIZED SCOPES (informational; the database decides visibility) */}
      {activeAssignments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your Activity Scope</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {activeAssignments.map((assignment) => (
                <span
                  key={assignment.id}
                  className="inline-flex items-center gap-2 rounded-full bg-brand-primary/10 px-3 py-1.5 text-xs font-medium text-brand-primary"
                >
                  <MapPin className="h-3.5 w-3.5" />
                  {formatScopeType(assignment.scope_type as CampaignScopeType)}
                  <span className="text-brand-primary/60">•</span>
                  {assignment.scope_id}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* CREATE FORM */}
      {showCreateForm && (
        <CreateActivityForm
          assignments={activeAssignments}
          isAdmin={authority === "admin"}
          creating={creating}
          onCancel={() => {
            if (!creating) setShowCreateForm(false);
          }}
          onSubmit={async (input) => {
            setCreating(true);
            try {
              await createActivity(getSupabaseClient(), input);
              setShowCreateForm(false);
              toast.success("Campaign activity created successfully.");
              await loadActivities();
            } catch (creationError) {
              console.error("Failed to create campaign activity:", creationError);
              toast.error(
                campaignErrorMessage(
                  creationError,
                  "We couldn't create the campaign activity. Please try again.",
                ),
              );
            } finally {
              setCreating(false);
            }
          }}
        />
      )}

      {/* ACTIVITIES */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <CardTitle>
              Activities
              {!loading && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({filteredActivities.length})
                </span>
              )}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search activities..."
                className="px-3 py-1.5 border rounded-lg text-xs"
              />

              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-xs"
              >
                <option value="all">All Types</option>
                {ACTIVITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-xs"
              >
                <option value="all">All Statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="postponed">Postponed</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>

              <button
                type="button"
                onClick={() => void loadActivities()}
                disabled={loading}
                className="text-xs font-semibold text-brand-primary hover:underline disabled:opacity-50 border px-3 py-1.5 rounded-lg bg-gray-50"
              >
                Refresh
              </button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-3 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Loading activities...</span>
            </div>
          ) : loadError ? (
            <div className="py-12 text-center">
              <CalendarDays className="mx-auto h-10 w-10 text-gray-300" />
              <h3 className="mt-4 font-semibold text-gray-900">
                Couldn&apos;t load activities
              </h3>
              <p className="mt-1 text-sm text-gray-500">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadActivities()}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary"
              >
                Try again
              </button>
            </div>
          ) : filteredActivities.length === 0 ? (
            <div className="py-12 text-center">
              <CalendarDays className="mx-auto h-10 w-10 text-gray-300" />
              <h3 className="mt-4 font-semibold text-gray-900">
                No matching activities
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {search || filterType !== "all" || filterStatus !== "all"
                  ? "Try adjusting your search or filter settings."
                  : "There are no campaign activities in your authorized scope."}
              </p>
              {canCreateActivity && (
                <button
                  type="button"
                  onClick={() => setShowCreateForm(true)}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary"
                >
                  <Plus className="h-4 w-4" />
                  Create First Activity
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredActivities.map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  profileId={profile?.id ?? ""}
                  canManage={canManageActivities}
                  onChanged={loadActivities}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/*
 * ============================================================
 * CREATE ACTIVITY FORM
 * ============================================================
 */

function CreateActivityForm({
  assignments,
  isAdmin,
  creating,
  onCancel,
  onSubmit,
}: {
  assignments: OrganizationalAssignment[];
  isAdmin: boolean;
  creating: boolean;
  onCancel: () => void;
  onSubmit: (input: Parameters<typeof createActivity>[1]) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [activityType, setActivityType] = useState<CampaignActivityType>("meeting");
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [venue, setVenue] = useState("");
  const [expectedAttendance, setExpectedAttendance] = useState("");

  const [scopeKey, setScopeKey] = useState(
    assignments.length > 0
      ? `${assignments[0].scope_type}:${assignments[0].scope_id}`
      : "",
  );
  const [adminScopeType, setAdminScopeType] = useState<CampaignScopeType>("campaign");
  const [adminScopeId, setAdminScopeId] = useState("");

  const selectedAssignment = assignments.find(
    (assignment) =>
      `${assignment.scope_type}:${assignment.scope_id}` === scopeKey,
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    let scopeType: CampaignScopeType;
    let scopeId: string;
    if (isAdmin) {
      scopeId = adminScopeId.trim();
      if (!scopeId) return;
      scopeType = adminScopeType;
    } else {
      if (!selectedAssignment) return;
      scopeType = selectedAssignment.scope_type as CampaignScopeType;
      scopeId = selectedAssignment.scope_id;
    }
    if (!date) return;

    await onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      activity_type: activityType,
      venue: venue.trim() || undefined,
      scheduled_start: composeTimestamp(date, startTime),
      scheduled_end: endTime ? composeTimestamp(date, endTime) : undefined,
      expected_attendance: expectedAttendance
        ? Number(expectedAttendance)
        : undefined,
      scope_type: scopeType,
      scope_id: scopeId,
    });
  };

  return (
    <Card className="border-brand-primary/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Create Campaign Activity</CardTitle>
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
            aria-label="Close form"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Activity Title *
              </label>
              <input
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Ward 3 Volunteer Meeting"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Activity Type *
              </label>
              <select
                required
                value={activityType}
                onChange={(event) =>
                  setActivityType(event.target.value as CampaignActivityType)
                }
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              >
                {ACTIVITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Date *
              </label>
              <input
                required
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>

            {isAdmin ? (
              <div className="md:col-span-2 grid grid-cols-1 gap-5 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Scope Type *
                  </label>
                  <select
                    required
                    value={adminScopeType}
                    onChange={(event) =>
                      setAdminScopeType(event.target.value as CampaignScopeType)
                    }
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
                  >
                    <option value="campaign">Campaign</option>
                    <option value="state">State</option>
                    <option value="senatorial_zone">Zone</option>
                    <option value="lga">LGA</option>
                    <option value="ward">Ward</option>
                    <option value="polling_unit">Polling Unit</option>
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Scope ID *
                  </label>
                  <input
                    required
                    value={adminScopeId}
                    onChange={(event) => setAdminScopeId(event.target.value)}
                    placeholder="e.g. nkanu-west-ward-01"
                    className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  Organizational Scope *
                </label>
                <select
                  required
                  value={scopeKey}
                  onChange={(event) => setScopeKey(event.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
                >
                  {assignments.map((assignment) => {
                    const key = `${assignment.scope_type}:${assignment.scope_id}`;
                    return (
                      <option key={key} value={key}>
                        {formatScopeType(assignment.scope_type as CampaignScopeType)}{" "}
                        — {assignment.scope_id}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Start Time
              </label>
              <input
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                End Time
              </label>
              <input
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Venue
              </label>
              <input
                value={venue}
                onChange={(event) => setVenue(event.target.value)}
                placeholder="Activity location"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Expected Attendance
              </label>
              <input
                type="number"
                min="0"
                value={expectedAttendance}
                onChange={(event) => setExpectedAttendance(event.target.value)}
                placeholder="e.g. 100"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Description
              </label>
              <textarea
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe the purpose, agenda or expected outcome..."
                className="w-full resize-none rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>
          </div>

          <div className="flex flex-col-reverse gap-3 border-t pt-5 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={creating}
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={
                creating || (isAdmin ? !adminScopeId.trim() : !selectedAssignment)
              }
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {creating ? "Creating..." : "Create Activity"}
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * ACTIVITY CARD
 * ============================================================
 */

function ActivityCard({
  activity,
  profileId,
  canManage,
  onChanged,
}: {
  activity: SupabaseActivity;
  profileId: string;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [participants, setParticipants] = useState<CampaignActivityParticipant[]>([]);

  // Editable detail state (authority-bearing fields are not editable here).
  const [title, setTitle] = useState(activity.title);
  const [description, setDescription] = useState(activity.description ?? "");
  const [activityType, setActivityType] = useState<CampaignActivityType>(activity.activity_type);
  const [day, setDay] = useState(activity.scheduled_start.slice(0, 10));
  const [startTime, setStartTime] = useState(
    activity.scheduled_start.slice(11, 16),
  );
  const [endTime, setEndTime] = useState(
    activity.scheduled_end ? activity.scheduled_end.slice(11, 16) : "",
  );
  const [venue, setVenue] = useState(activity.venue ?? "");
  const [expectedAttendance, setExpectedAttendance] = useState(
    activity.expected_attendance?.toString() ?? "",
  );

  const myParticipation = participants.find((p) => p.user_id === profileId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await getParticipants(getSupabaseClient(), activity.id);
        if (!cancelled) setParticipants(rows);
      } catch {
        // Participant panel is supplementary; listing itself already succeeded.
        if (!cancelled) setParticipants([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activity.id]);

  const goingCount = participants.filter((p) => p.rsvp === "going").length;
  const checkedInCount = participants.filter(
    (p) => p.attendance === "present" && p.checked_in_at !== null,
  ).length;

  const statusClass =
    activity.status === "completed"
      ? "bg-green-100 text-green-700"
      : activity.status === "cancelled"
        ? "bg-red-100 text-red-700"
        : activity.status === "postponed"
          ? "bg-yellow-100 text-yellow-700"
          : "bg-blue-100 text-blue-700";

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      console.error(failure, err);
      toast.error(campaignErrorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  };

  const handleRsvp = (rsvp: CampaignRsvp) =>
    run(async () => {
      await setRsvp(getSupabaseClient(), activity.id, rsvp);
      setParticipants(await getParticipants(getSupabaseClient(), activity.id));
    }, "We couldn't save your RSVP. Please try again.");

  const handleStatus = (to: "postpone" | "cancel" | "complete") =>
    run(async () => {
      await transitionActivity(getSupabaseClient(), activity.id, to);
      await onChanged();
    }, "We couldn't update the activity status.");

  const handleAttendance = (
    participant: CampaignActivityParticipant,
    attendance: CampaignAttendanceState,
    checkIn?: boolean,
    checkOut?: boolean,
  ) =>
    run(async () => {
      await recordAttendance(
        getSupabaseClient(),
        activity.id,
        participant.user_id,
        attendance,
        { checkIn, checkOut },
      );
      setParticipants(await getParticipants(getSupabaseClient(), activity.id));
    }, "We couldn't record attendance.");

  const handleSave = () =>
    run(async () => {
      if (!title.trim()) return;
      await updateActivity(getSupabaseClient(), activity.id, {
        title: title.trim(),
        description: description.trim() || undefined,
        activity_type: activityType,
        venue: venue.trim() || undefined,
        scheduled_start: composeTimestamp(day, startTime),
        scheduled_end: endTime ? composeTimestamp(day, endTime) : undefined,
        expected_attendance: expectedAttendance
          ? Number(expectedAttendance)
          : undefined,
      });
      setIsEditing(false);
      await onChanged();
      toast.success("Campaign activity updated successfully.");
    }, "We couldn't update the campaign activity.");

  const handleDelete = () =>
    run(async () => {
      await deleteActivity(getSupabaseClient(), activity.id);
      await onChanged();
      toast.success("Campaign activity deleted successfully.");
    }, "We couldn't delete the campaign activity.");

  return (
    <div className="rounded-xl border border-gray-200 p-5 transition-shadow hover:shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div className="space-y-4">
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base font-semibold text-gray-900"
              />

              <div className="grid gap-3 md:grid-cols-2">
                <select
                  value={activityType}
                  onChange={(event) =>
                    setActivityType(event.target.value as CampaignActivityType)
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  {ACTIVITY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>

                <input
                  type="date"
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />

                <input
                  type="number"
                  min="0"
                  value={expectedAttendance}
                  onChange={(event) => setExpectedAttendance(event.target.value)}
                  placeholder="Expected attendance"
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />

                <input
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />

                <input
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <input
                value={venue}
                onChange={(event) => setVenue(event.target.value)}
                placeholder="Venue"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />

              <textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Description"
                className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={busy}
                  className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-gray-900">{activity.title}</h3>

                <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                  {formatActivityType(activity.activity_type)}
                </span>

                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${statusClass}`}
                >
                  {formatStatus(activity.status)}
                </span>
              </div>

              {activity.description && (
                <p className="mt-2 text-sm leading-6 text-gray-600">
                  {activity.description}
                </p>
              )}

              <div className="mt-4 grid gap-2 text-sm text-gray-500 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-brand-primary" />
                  <span>{formatDay(activity.scheduled_start)}</span>
                </div>

                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-brand-primary" />
                  <span>
                    {formatTime(activity.scheduled_start)}
                    {activity.scheduled_end
                      ? ` – ${formatTime(activity.scheduled_end)}`
                      : ""}
                  </span>
                </div>

                {activity.venue && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-brand-primary" />
                    <span className="truncate">{activity.venue}</span>
                  </div>
                )}

                {activity.expected_attendance !== null && (
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-brand-primary" />
                    <span>
                      Expected attendance:{" "}
                      {activity.expected_attendance.toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 rounded-lg bg-gray-50 px-3 py-2 text-xs">
          <p className="font-medium text-gray-500">Scope</p>
          <p className="mt-1 font-semibold text-gray-700">
            {formatScopeType(activity.scope_type)}
          </p>
          <p className="max-w-[220px] truncate text-gray-500">{activity.scope_id}</p>
        </div>
      </div>

      {/* RSVP — a declaration of intent (own row only, via the RPC) */}
      <div className="mt-4 border-t pt-3 space-y-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-gray-700">Your RSVP:</span>
            {(
              [
                ["going", "Going"],
                ["interested", "Interested"],
                ["not_going", "Not Going"],
              ] as Array<[CampaignRsvp, string]>
            ).map(([value, label]) => {
              const isSelected = myParticipation?.rsvp === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRsvp(value)}
                  className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors disabled:opacity-50 ${
                    isSelected
                      ? "bg-brand-primary text-white font-bold"
                      : "bg-gray-50 text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {myParticipation?.attendance && (
            <span className="rounded-lg bg-gray-100 px-2.5 py-1 font-semibold text-gray-700">
              Attendance recorded: {myParticipation.attendance}
              {myParticipation.checked_in_at
                ? ` · checked in ${formatTime(myParticipation.checked_in_at)}`
                : ""}
            </span>
          )}
        </div>

        {/* Attendance statistics */}
        <div className="p-3 bg-gray-50 rounded-xl border flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="font-bold text-gray-700">Attendance Statistics: </span>
            <span className="text-gray-600">
              {checkedInCount} Checked-In · {goingCount} RSVP Going
            </span>
          </div>

          <span className="font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded">
            {activity.expected_attendance
              ? `${Math.round((checkedInCount / activity.expected_attendance) * 100)}% Turnout Rate`
              : "Live Attendance"}
          </span>
        </div>

        {/* Supervisor attendance recording — an operational fact, recorded
            by an authorized supervisor via the RPC (never self-service). */}
        {canManage && participants.length > 0 && (
          <div className="rounded-xl border border-gray-200 divide-y">
            {participants.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span className="max-w-[220px] truncate font-medium text-gray-600">
                  {p.user_id === profileId ? "You" : p.user_id.slice(0, 8) + "…"}
                </span>

                <div className="flex items-center gap-1.5">
                  {(
                    [
                      ["present", "Present"],
                      ["excused", "Excused"],
                      ["absent", "Absent"],
                    ] as Array<[CampaignAttendanceState, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={busy}
                      onClick={() => void handleAttendance(p, value, value === "present")}
                      className={`px-2 py-0.5 rounded border font-semibold disabled:opacity-50 ${
                        p.attendance === value
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : "bg-white text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {label}
                    </button>
                  ))}

                  {p.checked_in_at && !p.checked_out_at && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void handleAttendance(p, p.attendance ?? "present", false, true)
                      }
                      className="px-2 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-800 font-semibold disabled:opacity-50"
                    >
                      Check Out
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status management + organizer + edit/delete */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <div className="text-xs text-gray-500">
          {activity.organizer_id === profileId
            ? "Organizer: You"
            : activity.created_by === profileId
              ? "Created by you"
              : null}
        </div>

        <div className="flex items-center gap-2">
          {canManage && activity.status === "scheduled" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatus("postpone")}
              className="rounded-lg border border-yellow-200 px-3 py-2 text-xs font-semibold text-yellow-700 hover:bg-yellow-50 disabled:opacity-50"
            >
              Postpone
            </button>
          )}

          {canManage && activity.status !== "cancelled" && activity.status !== "completed" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatus("cancel")}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          )}

          {canManage && activity.status !== "completed" && activity.status !== "cancelled" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStatus("complete")}
              className="rounded-lg border border-green-200 px-3 py-2 text-xs font-semibold text-green-700 hover:bg-green-50 disabled:opacity-50"
            >
              <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
              Mark Completed
            </button>
          )}

          {canManage && (
            <>
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50"
              >
                Edit
              </button>

              <button
                type="button"
                onClick={() => void handleDelete()}
                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
