"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
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

import {
  createCampaignActivity,
  deleteCampaignActivity,
  getAllCampaignActivities,
  getCampaignActivitiesForAssignments,
  updateCampaignActivity,
} from "@/lib/firebase/campaignActivities";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type {
  CampaignActivity,
  CampaignActivityStatus,
  CampaignActivityType,
  OrganizationalAssignment,
} from "@/types";

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function formatScopeType(
  scopeType: OrganizationalAssignment["scope_type"],
): string {
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

function formatActivityType(type: CampaignActivityType): string {
  switch (type) {
    case "meeting":
      return "Meeting";

    case "rally":
      return "Rally";

    case "community_engagement":
      return "Community Engagement";

    case "training":
      return "Training";

    case "coordination":
      return "Coordination";

    case "stakeholder_meeting":
      return "Stakeholder Meeting";

    case "other":
      return "Other";

    default:
      return type;
  }
}

function formatStatus(status: CampaignActivityStatus): string {
  switch (status) {
    case "scheduled":
      return "Scheduled";

    case "completed":
      return "Completed";

    case "cancelled":
      return "Cancelled";

    case "ongoing":
      return "Ongoing";

    default:
      return status;
  }
}

/*
 * ============================================================
 * PAGE
 * ============================================================
 */

export default function CampaignActivitiesPage() {
  const { user, profile, assignments, accessLoading, hasPermission } =
    useAuth();

  const isAdmin =
    profile?.access_role === "admin" ||
    profile?.access_role === "tenant_super_admin" ||
    profile?.access_role === "platform_super_admin";

  const canViewCampaignActivities = hasPermission("view_activities");
  const canCreateCampaignActivity = hasPermission("create_activity");
  const canManageCampaignActivities = hasPermission("manage_activity");

  const [activities, setActivities] = useState<CampaignActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Filters
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  /*
   * ----------------------------------------------------------
   * ACTIVE ASSIGNMENTS
   * ----------------------------------------------------------
   */

  const activeAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.status === "active"),
    [assignments],
  );

  const canCreateActivity = canCreateCampaignActivity;

  /*
   * ----------------------------------------------------------
   * LOAD ACTIVITIES
   * ----------------------------------------------------------
   */

  const loadActivities = async () => {
    if (!profile) {
      setActivities([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const data = isAdmin
        ? await getAllCampaignActivities()
        : await getCampaignActivitiesForAssignments(assignments);

      setActivities(data);
    } catch (loadError) {
      console.error("Failed to load campaign activities:", loadError);

      setActivities([]);
      setError(
        "Unable to load campaign activities right now. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  const filteredActivities = useMemo(() => {
    return activities.filter((act) => {
      if (filterType !== "all" && act.activity_type !== filterType) {
        return false;
      }
      if (filterStatus !== "all" && act.status !== filterStatus) {
        return false;
      }
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

  useEffect(() => {
    if (!accessLoading) {
      void (async () => {
        await loadActivities();
      })();
    }
  }, [accessLoading, assignments, canViewCampaignActivities, isAdmin, profile]);

  /*
   * ----------------------------------------------------------
   * AUTH LOADING
   * ----------------------------------------------------------
   */

  if (accessLoading || !profile || !user) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading campaign activities...</span>
        </div>
      </div>
    );
  }

  /*
   * ----------------------------------------------------------
   * PAGE
   * ----------------------------------------------------------
   */

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* ======================================================
          HEADER
          ====================================================== */}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/portal/campaign"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-apc-primary mb-3"
          >
            <ChevronLeft className="h-4 w-4" />
            Campaign Dashboard
          </Link>

          <h1 className="text-2xl font-bold text-gray-900">
            Campaign Activities
          </h1>

          <p className="mt-1 text-sm text-gray-500">
            Meetings, rallies, outreach, training and other activities within
            your organizational scope.
          </p>
        </div>

        {canCreateActivity && (
          <button
            type="button"
            onClick={() => {
              setShowCreateForm(true);
              setCreateError("");
              setSuccessMessage("");
            }}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors"
          >
            <Plus className="h-4 w-4" />
            Create Activity
          </button>
        )}
      </div>

      {/* ======================================================
          SUCCESS
          ====================================================== */}

      {successMessage && (
        <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {isAdmin && !hasPermission("view_activities") && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          Your admin account is not currently registered as a campaign member,
          so campaign activity administration is restricted.
        </div>
      )}

      {/* ======================================================
          ERROR
          ====================================================== */}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ======================================================
          NO ASSIGNMENT
          ====================================================== */}

      {!isAdmin && activeAssignments.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <MapPin className="mx-auto h-10 w-10 text-gray-300" />

            <h2 className="mt-4 text-lg font-semibold text-gray-900">
              No active organizational assignment
            </h2>

            <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
              Campaign activities are scoped to your organizational assignment.
              You currently do not have an active assignment determining an
              activity scope.
            </p>

            <Link
              href="/portal/campaign/area"
              className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-apc-primary hover:underline"
            >
              View Campaign Area
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ======================================================
          AUTHORIZED SCOPES
          ====================================================== */}

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
                  className="inline-flex items-center gap-2 rounded-full bg-apc-primary/10 px-3 py-1.5 text-xs font-medium text-apc-primary"
                >
                  <MapPin className="h-3.5 w-3.5" />

                  {formatScopeType(assignment.scope_type)}

                  <span className="text-apc-primary/60">•</span>

                  {assignment.scope_id}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ======================================================
          CREATE FORM
          ====================================================== */}

      {showCreateForm && (
        <CreateActivityForm
          assignments={activeAssignments}
          profileId={profile.id ?? ""}
          profileName={profile.full_name ?? ""}
          isAdmin={isAdmin}
          creating={creating}
          error={createError}
          onCancel={() => {
            if (!creating) {
              setShowCreateForm(false);
              setCreateError("");
            }
          }}
          onSubmit={async (input) => {
            setCreating(true);
            setCreateError("");
            setSuccessMessage("");

            try {
              await createCampaignActivity(input);

              setShowCreateForm(false);

              setSuccessMessage("Campaign activity created successfully.");

              await loadActivities();
            } catch (creationError) {
              console.error(
                "Failed to create campaign activity:",
                creationError,
              );

              setCreateError(
                creationError instanceof Error
                  ? creationError.message
                  : "Unable to create campaign activity.",
              );
            } finally {
              setCreating(false);
            }
          }}
        />
      )}

      {/* ======================================================
          ACTIVITIES
          ====================================================== */}

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
                <option value="meeting">Meeting</option>
                <option value="rally">Rally</option>
                <option value="community_engagement">Community Engagement</option>
                <option value="training">Training</option>
                <option value="coordination">Coordination</option>
                <option value="stakeholder_meeting">Stakeholder Meeting</option>
                <option value="other">Other</option>
              </select>

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-xs"
              >
                <option value="all">All Statuses</option>
                <option value="scheduled">Scheduled</option>
                <option value="ongoing">Ongoing</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>

              <button
                type="button"
                onClick={() => void loadActivities()}
                disabled={loading}
                className="text-xs font-semibold text-apc-primary hover:underline disabled:opacity-50 border px-3 py-1.5 rounded-lg bg-gray-50"
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
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-medium text-white hover:bg-apc-dark"
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
                  canManage={canManageCampaignActivities}
                  profileId={profile?.id ?? ""}
                  profileName={profile?.full_name ?? ""}
                  onEdit={async (updated) => {
                    if (!activity.id) return;

                    try {
                      setError("");
                      setSuccessMessage("");
                      await updateCampaignActivity(activity.id, updated);
                      await loadActivities();
                      setSuccessMessage(
                        "Campaign activity updated successfully.",
                      );
                    } catch (updateError) {
                      console.error(
                        "Failed to update campaign activity:",
                        updateError,
                      );
                      setError(
                        updateError instanceof Error
                          ? updateError.message
                          : "Unable to update campaign activity.",
                      );
                    }
                  }}
                  onDelete={async () => {
                    try {
                      setError("");
                      setSuccessMessage("");
                      await deleteCampaignActivity(activity.id);
                      await loadActivities();
                      setSuccessMessage(
                        "Campaign activity deleted successfully.",
                      );
                    } catch (deleteError) {
                      console.error(
                        "Failed to delete campaign activity:",
                        deleteError,
                      );
                      setError(
                        deleteError instanceof Error
                          ? deleteError.message
                          : "Unable to delete campaign activity.",
                      );
                    }
                  }}
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
  profileId,
  profileName,
  isAdmin,
  creating,
  error,
  onCancel,
  onSubmit,
}: {
  assignments: OrganizationalAssignment[];
  profileId: string;
  profileName: string;
  isAdmin: boolean;
  creating: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (
    input: Parameters<typeof createCampaignActivity>[0],
  ) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [activityType, setActivityType] =
    useState<CampaignActivityType>("meeting");

  const [status, setStatus] = useState<CampaignActivityStatus>("scheduled");

  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const [venue, setVenue] = useState("");

  const [scopeKey, setScopeKey] = useState(
    assignments.length > 0
      ? `${assignments[0].scope_type}:${assignments[0].scope_id}`
      : "",
  );

  const [adminScopeType, setAdminScopeType] =
    useState<OrganizationalAssignment["scope_type"]>("campaign");

  const [adminScopeId, setAdminScopeId] = useState("");

  const [organizerName, setOrganizerName] = useState(profileName);
  const [expectedAttendance, setExpectedAttendance] = useState("");

  const selectedAssignment = assignments.find(
    (assignment) =>
      `${assignment.scope_type}:${assignment.scope_id}` === scopeKey,
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    let scopeType: OrganizationalAssignment["scope_type"];
    let scopeId: string;

    /*
     * --------------------------------------------------------
     * ADMIN SCOPE
     * --------------------------------------------------------
     */

    if (isAdmin) {
      scopeId = adminScopeId.trim();

      if (!scopeId) {
        return;
      }

      scopeType = adminScopeType;
    } else {
      /*
       * --------------------------------------------------------
       * MEMBER SCOPE
       * --------------------------------------------------------
       */
      if (!selectedAssignment) {
        return;
      }

      scopeType = selectedAssignment.scope_type;
      scopeId = selectedAssignment.scope_id;
    }

    await onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,

      activity_type: activityType,
      status,

      date,
      start_time: startTime || undefined,
      end_time: endTime || undefined,

      venue: venue.trim() || undefined,

      scope_type: scopeType,
      scope_id: scopeId,

      created_by: profileId,

      organizer_id: profileId,
      organizer_name: organizerName.trim() || undefined,

      expected_attendance: expectedAttendance
        ? Number(expectedAttendance)
        : undefined,
    });
  };

  return (
    <Card className="border-apc-primary/20">
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
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2">
            {/* Title */}
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Activity Title *
              </label>

              <input
                required
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Ward 3 Volunteer Meeting"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm outline-none focus:border-apc-primary focus:ring-1 focus:ring-apc-primary"
              />
            </div>

            {/* Type */}
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
                <option value="meeting">Meeting</option>
                <option value="rally">Rally</option>
                <option value="community_engagement">
                  Community Engagement
                </option>
                <option value="training">Training</option>
                <option value="coordination">Coordination</option>
                <option value="stakeholder_meeting">Stakeholder Meeting</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/* Status */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Status
              </label>

              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as CampaignActivityStatus)
                }
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              >
                <option value="scheduled">Scheduled</option>
                <option value="ongoing">Ongoing</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            {/* Date */}
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

            {/* Scope */}
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
                      setAdminScopeType(
                        event.target
                          .value as OrganizationalAssignment["scope_type"],
                      )
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
                        {formatScopeType(assignment.scope_type)} —{" "}
                        {assignment.scope_id}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* Start */}
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

            {/* End */}
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

            {/* Venue */}
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

            {/* Organizer */}
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Organizer
              </label>

              <input
                value={organizerName}
                onChange={(event) => setOrganizerName(event.target.value)}
                placeholder="Organizer name"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm"
              />
            </div>

            {/* Attendance */}
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

            {/* Description */}
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

          {/* Form Actions */}
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
                creating ||
                (isAdmin ? !adminScopeId.trim() : !selectedAssignment)
              }
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-apc-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark disabled:cursor-not-allowed disabled:opacity-50"
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
  canManage,
  profileId,
  profileName,
  onEdit,
  onDelete,
}: {
  activity: CampaignActivity;
  canManage: boolean;
  profileId: string;
  profileName: string;
  onEdit: (
    updated: Partial<Parameters<typeof createCampaignActivity>[0]>,
  ) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const statusClass =
    activity.status === "completed"
      ? "bg-green-100 text-green-700"
      : activity.status === "cancelled"
        ? "bg-red-100 text-red-700"
        : activity.status === "ongoing"
          ? "bg-yellow-100 text-yellow-700"
          : "bg-blue-100 text-blue-700";

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(activity.title);
  const [description, setDescription] = useState(activity.description ?? "");
  const [activityType, setActivityType] = useState(activity.activity_type);
  const [status, setStatus] = useState(activity.status);
  const [date, setDate] = useState(activity.date);
  const [startTime, setStartTime] = useState(activity.start_time ?? "");
  const [endTime, setEndTime] = useState(activity.end_time ?? "");
  const [venue, setVenue] = useState(activity.venue ?? "");
  const [organizerName, setOrganizerName] = useState(
    activity.organizer_name ?? "",
  );
  const [expectedAttendance, setExpectedAttendance] = useState(
    activity.expected_attendance?.toString() ?? "",
  );

  const handleSave = async () => {
    if (!title.trim()) return;

    await onEdit({
      title: title.trim(),
      description: description.trim() || undefined,
      activity_type: activityType,
      status,
      date,
      start_time: startTime || undefined,
      end_time: endTime || undefined,
      venue: venue.trim() || undefined,
      organizer_name: organizerName.trim() || undefined,
      expected_attendance: expectedAttendance
        ? Number(expectedAttendance)
        : undefined,
      scope_type: activity.scope_type,
      scope_id: activity.scope_id,
      organizer_id: activity.organizer_id,
    });

    setIsEditing(false);
  };

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
                  <option value="meeting">Meeting</option>
                  <option value="rally">Rally</option>
                  <option value="community_engagement">
                    Community Engagement
                  </option>
                  <option value="training">Training</option>
                  <option value="coordination">Coordination</option>
                  <option value="stakeholder_meeting">
                    Stakeholder Meeting
                  </option>
                  <option value="other">Other</option>
                </select>

                <select
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as CampaignActivityStatus)
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="scheduled">Scheduled</option>
                  <option value="ongoing">Ongoing</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>

                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />

                <input
                  type="number"
                  min="0"
                  value={expectedAttendance}
                  onChange={(event) =>
                    setExpectedAttendance(event.target.value)
                  }
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

              <input
                value={organizerName}
                onChange={(event) => setOrganizerName(event.target.value)}
                placeholder="Organizer name"
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
                  onClick={handleSave}
                  className="rounded-lg bg-apc-primary px-3 py-2 text-sm font-semibold text-white"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold text-gray-900">
                  {activity.title}
                </h3>

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
                  <CalendarDays className="h-4 w-4 text-apc-primary" />
                  <span>{activity.date}</span>
                </div>

                {(activity.start_time || activity.end_time) && (
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-apc-primary" />

                    <span>
                      {activity.start_time ?? ""}
                      {activity.end_time ? ` – ${activity.end_time}` : ""}
                    </span>
                  </div>
                )}

                {activity.venue && (
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-apc-primary" />

                    <span className="truncate">{activity.venue}</span>
                  </div>
                )}

                {activity.expected_attendance !== undefined && (
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-apc-primary" />

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

          <p className="max-w-[220px] truncate text-gray-500">
            {activity.scope_id}
          </p>
        </div>
      </div>

      {/* RSVP Controls & Attendance Tracker */}
      <div className="mt-4 border-t pt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-gray-700">Your RSVP:</span>
          {["Going", "Interested", "Not Going"].map((rsvpState) => (
            <button
              key={rsvpState}
              onClick={async () => {
                const currentParticipants = (activity as any).participants || [];
                const updatedParticipants = currentParticipants.filter(
                  (p: any) => p.user_id !== profileId
                );
                if (rsvpState !== "Not Going") {
                  updatedParticipants.push({
                    user_id: profileId,
                    name: profileName,
                    rsvp: rsvpState,
                    updated_at: new Date().toISOString(),
                  });
                }
                await onEdit({
                  ...activity,
                  participants: updatedParticipants,
                } as any);
              }}
              className={`px-2.5 py-1 rounded-lg border font-semibold transition-colors ${
                ((activity as any).participants || []).some(
                  (p: any) => p.user_id === profileId && p.rsvp === rsvpState
                )
                  ? "bg-apc-primary text-white font-bold"
                  : "bg-gray-50 text-gray-700 hover:bg-gray-100"
              }`}
            >
              {rsvpState}
            </button>
          ))}
        </div>

        <div className="text-gray-500 font-medium">
          RSVP Count: <span className="font-bold text-gray-900">{((activity as any).participants || []).length} Going/Interested</span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
        {activity.organizer_name && (
          <div className="text-xs text-gray-500">
            Organizer:{" "}
            <span className="font-medium text-gray-700">
              {activity.organizer_name}
            </span>
          </div>
        )}

        {canManage && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50"
            >
              Edit
            </button>

            <button
              type="button"
              onClick={() => void onDelete()}
              className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
