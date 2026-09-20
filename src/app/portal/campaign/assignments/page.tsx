"use client";

import Link from "next/link";

import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Flag,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useAuth } from "@/contexts/AuthContext";

import {
  createCampaignAssignment,
  deleteCampaignAssignment,
  getAllCampaignAssignments,
  getMyCampaignAssignments,
  getAssignmentsForAssignmentScope,
  updateCampaignAssignment,
  type CampaignAssignment,
} from "@/lib/firebase/campaignAssignments";
import { getAllLGAs } from "@/lib/constants";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";

import {
  getAllCampaignMembersForTenant,
  getScopedCampaignMembers,
} from "@/lib/firebase/campaignMembers";

import {
  formatScopeType,
  getPrimaryOrganizationalScope,
  formatOrganizationalPosition,
} from "@/lib/organization";

/*
 * ============================================================
 * PAGE
 * ============================================================
 */

export default function CampaignAssignmentsPage() {
  const { user, profile, assignments, accessLoading, hasPermission } =
    useAuth();
  const toast = useToast();

  const [myAssignments, setMyAssignments] = useState<CampaignAssignment[]>([]);
  const [areaAssignments, setAreaAssignments] = useState<CampaignAssignment[]>(
    [],
  );
  const [allAssignments, setAllAssignments] = useState<CampaignAssignment[]>(
    [],
  );
  const [memberOptions, setMemberOptions] = useState<
    Array<{ id: string; full_name: string; email?: string }>
  >([]);

  const [loading, setLoading] = useState(true);
  const [areaLoading, setAreaLoading] = useState(false);
  const [memberOptionsLoading, setMemberOptionsLoading] = useState(false);
  const [search, setSearch] = useState("");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(
    null,
  );
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAssignedTo, setFormAssignedTo] = useState("");
  const [formScopeType, setFormScopeType] = useState("ward");
  const [formScopeId, setFormScopeId] = useState("");
  const [formPriority, setFormPriority] =
    useState<CampaignAssignment["priority"]>("medium");
  const [formStatus, setFormStatus] =
    useState<CampaignAssignment["status"]>("not_started");
  const [formDueDate, setFormDueDate] = useState("");
  const [formLocation, setFormLocation] = useState("");


  const primaryScope = getPrimaryOrganizationalScope(assignments);
  const primaryAssignment = primaryScope.assignment;

  const isAdmin =
    profile?.access_role === "admin" ||
    profile?.access_role === "tenant_super_admin" ||
    profile?.access_role === "platform_super_admin";

  const canViewAssignments = hasPermission("view_assignments");
  const canCreateAssignments = hasPermission("create_assignment");
  const canAssignTask = hasPermission("assign_task");
  const canReviewAssignments = hasPermission("review_assignment");
  const canManageAssignments =
    canCreateAssignments || canAssignTask || canReviewAssignments;

  const allAssignmentsForDisplay = useMemo(() => {
    const source =
      isAdmin && canManageAssignments ? allAssignments : areaAssignments;
    const term = search.trim().toLowerCase();

    if (!term) {
      return source;
    }

    return source.filter((assignment) => {
      const haystack = [
        assignment.title,
        assignment.description ?? "",
        assignment.assigned_to,
        assignment.scope_id,
        assignment.status,
        assignment.priority,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(term);
    });
  }, [allAssignments, areaAssignments, canManageAssignments, isAdmin, search]);

  function resetForm() {
    setFormTitle("");
    setFormDescription("");
    setFormAssignedTo("");
    setFormScopeType(primaryAssignment?.scope_type ?? "ward");
    setFormScopeId(primaryAssignment?.scope_id ?? "");
    setFormPriority("medium");
    setFormStatus("not_started");
    setFormDueDate("");
    setFormLocation("");
    setEditingAssignmentId(null);
  }

  function startEditAssignment(assignment: CampaignAssignment) {
    setEditingAssignmentId(assignment.id);
    setFormTitle(assignment.title);
    setFormDescription(assignment.description ?? "");
    setFormAssignedTo(assignment.assigned_to);
    setFormScopeType(assignment.scope_type || "ward");
    setFormScopeId(assignment.scope_id || "");
    setFormPriority(assignment.priority);
    setFormStatus(assignment.status);
    setFormDueDate(assignment.due_date ?? "");
    setFormLocation(assignment.location ?? "");
    setShowCreateForm(true);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!profile?.tenant_id) {
      toast.error("Your account session is missing its campaign context. Please sign in again.");
      return;
    }

    const title = formTitle.trim();
    const assignedTo = formAssignedTo.trim();
    const scopeId = formScopeId.trim();

    if (!title || !assignedTo || !scopeId) {
      toast.warning("Please provide a title, an assignee, and a scope for the assignment.");
      return;
    }

    const payload = {
      tenant_id: profile.tenant_id,
      title,
      description: formDescription.trim() || undefined,
      assigned_to: assignedTo,
      assigned_by: user?.uid ?? profile.id ?? profile.email,
      scope_type: formScopeType,
      scope_id: scopeId,
      priority: formPriority,
      due_date: formDueDate || null,
      location: formLocation.trim() || null,
    };

    try {
      setCreating(true);

      if (editingAssignmentId) {
        await updateCampaignAssignment(editingAssignmentId, {
          ...payload,
          status: formStatus,
        });
      } else {
        await createCampaignAssignment(payload);
      }

      resetForm();
      setShowCreateForm(false);
      await loadAssignments();
      toast.success(
        editingAssignmentId
          ? "Assignment updated successfully."
          : "Assignment created successfully.",
      );
    } catch (err) {
      console.error("Failed to save assignment:", err);
      toast.error(
        getErrorMessage(
          err,
          editingAssignmentId
            ? "We couldn't update the assignment. Please try again."
            : "We couldn't create the assignment. Please try again.",
        ),
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteAssignment(assignmentId: string) {
    try {
      await deleteCampaignAssignment(assignmentId);
      await loadAssignments();
      toast.success("Assignment deleted successfully.");
    } catch (err) {
      console.error("Failed to delete assignment:", err);
      toast.error(getErrorMessage(err, "We couldn't delete the assignment. Please try again."));
    }
  }

  const loadAssigneeOptions = useCallback(async () => {
    if (!profile?.tenant_id) {
      setMemberOptions([]);
      return;
    }

    try {
      setMemberOptionsLoading(true);

      if (isAdmin && canManageAssignments) {
        const allMembers = await getAllCampaignMembersForTenant(
          profile.tenant_id,
        );
        setMemberOptions(
          allMembers.map((member) => ({
            id: member.id,
            full_name: member.full_name || "Unknown member",
            email: member.email,
          })),
        );
        return;
      }

      if (
        primaryAssignment &&
        primaryAssignment.scope_type &&
        primaryAssignment.scope_id
      ) {
        const scopedMembers = await getScopedCampaignMembers(primaryAssignment);
        setMemberOptions(
          scopedMembers.members.map((member) => ({
            id: member.id,
            full_name: member.full_name || "Unknown member",
            email: member.email,
          })),
        );
        return;
      }

      setMemberOptions([]);
    } catch (err) {
      console.error("Failed to load campaign member options:", err);
      setMemberOptions([]);
    } finally {
      setMemberOptionsLoading(false);
    }
  }, [canManageAssignments, isAdmin, primaryAssignment, profile?.tenant_id]);

  const loadAssignments = useCallback(async () => {
    if (!user?.uid || !profile) {
      setMyAssignments([]);
      setAreaAssignments([]);
      setAllAssignments([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);

      const mine = await getMyCampaignAssignments(
        user.uid,
        user.email ?? undefined,
      );
      setMyAssignments(mine);

      if (!canViewAssignments || !profile.tenant_id) {
        setAreaAssignments([]);
        setAllAssignments([]);
        return;
      }

      if (isAdmin && canManageAssignments) {
        setAreaLoading(true);
        try {
          const all = await getAllCampaignAssignments(profile.tenant_id);
          setAllAssignments(all);
          setAreaAssignments([]);
        } finally {
          setAreaLoading(false);
        }
        return;
      }

      if (
        primaryAssignment &&
        primaryAssignment.scope_type &&
        primaryAssignment.scope_id
      ) {
        setAreaLoading(true);

        try {
          const lgas = await getAllLGAs();
          const scoped = await getAssignmentsForAssignmentScope(
            primaryAssignment,
            lgas,
          );

          setAreaAssignments(scoped);
          setAllAssignments([]);
        } finally {
          setAreaLoading(false);
        }
      } else {
        setAreaAssignments([]);
        setAllAssignments([]);
      }
    } catch (err) {
      console.error("Failed to load campaign assignments:", err);
      toast.error("We couldn't load campaign assignments. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, [
    canViewAssignments,
    canManageAssignments,
    isAdmin,
    primaryAssignment,
    profile,
    user?.email,
    user?.uid,
  ]);

  useEffect(() => {
    if (!accessLoading) {
      void loadAssignments();
    }
  }, [accessLoading, loadAssignments]);

  useEffect(() => {
    if (!accessLoading && profile?.tenant_id) {
      void loadAssigneeOptions();
    }
  }, [accessLoading, loadAssigneeOptions]);

  const counts = useMemo(() => {
    return {
      total: myAssignments.length,
      pending: myAssignments.filter(
        (item) =>
          item.status === "not_started" || item.status === "in_progress",
      ).length,
      submitted: myAssignments.filter(
        (item) => item.status === "submitted" || item.status === "under_review",
      ).length,
      completed: myAssignments.filter((item) => item.status === "completed")
        .length,
      urgent: myAssignments.filter(
        (item) => item.priority === "urgent" && item.status !== "completed",
      ).length,
    };
  }, [myAssignments]);

  if (!profile) {
    return null;
  }

  if (accessLoading || loading) {
    return <AssignmentsLoading />;
  }

  const visibleAssignments =
    isAdmin && canManageAssignments
      ? allAssignmentsForDisplay
      : areaAssignments;

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/portal/dashboard"
            className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-apc-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            Campaign Dashboard
          </Link>

          <p className="text-sm font-semibold text-apc-primary">
            Campaign Council
          </p>

          <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
            Campaign Assignments
          </h1>

          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
            Manage and track campaign responsibilities within your
            organizational authority.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAssignments()}
          className="inline-flex w-fit items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <Card className="border-apc-primary/10">
        <CardContent className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
                <ShieldCheck className="h-5 w-5" />
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Organizational Scope
                </p>

                <p className="mt-1 font-semibold text-gray-900">
                  {primaryAssignment
                    ? formatOrganizationalPosition(primaryAssignment.position)
                    : "Campaign Member"}
                </p>

                <p className="mt-1 text-sm text-gray-500">
                  {primaryAssignment
                    ? `${formatScopeType(primaryAssignment.scope_type)} · ${primaryAssignment.scope_id}`
                    : "No organizational assignment"}
                </p>
              </div>
            </div>

            {canManageAssignments && (
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowCreateForm((current) => !current);
                }}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-apc-dark"
              >
                <Plus className="h-4 w-4" />
                {showCreateForm ? "Close" : "Create Assignment"}
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {showCreateForm && canManageAssignments && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">
                {editingAssignmentId ? "Edit Assignment" : "Create Assignment"}
              </CardTitle>

              <button
                type="button"
                onClick={() => {
                  setShowCreateForm(false);
                  resetForm();
                }}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                aria-label="Close assignment form"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Title
                  </label>
                  <input
                    value={formTitle}
                    onChange={(event) => setFormTitle(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="Roadshow visibility update"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Description
                  </label>
                  <textarea
                    rows={3}
                    value={formDescription}
                    onChange={(event) => setFormDescription(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="What needs to be done?"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Assignee
                  </label>

                  {memberOptionsLoading ? (
                    <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-sm text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading members...
                    </div>
                  ) : (
                    <select
                      value={formAssignedTo}
                      onChange={(event) =>
                        setFormAssignedTo(event.target.value)
                      }
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      required
                    >
                      <option value="">Select a campaign member</option>
                      {memberOptions.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.full_name}
                          {member.email ? ` — ${member.email}` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Priority
                  </label>
                  <select
                    value={formPriority}
                    onChange={(event) =>
                      setFormPriority(
                        event.target.value as CampaignAssignment["priority"],
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Scope Type
                  </label>
                  <select
                    value={formScopeType}
                    onChange={(event) => setFormScopeType(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
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
                    Scope ID
                  </label>
                  <input
                    value={formScopeId}
                    onChange={(event) => setFormScopeId(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="ward-01"
                    required
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Due Date
                  </label>
                  <input
                    type="date"
                    value={formDueDate}
                    onChange={(event) => setFormDueDate(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Status
                  </label>
                  <select
                    value={formStatus}
                    onChange={(event) =>
                      setFormStatus(
                        event.target.value as CampaignAssignment["status"],
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                  >
                    <option value="not_started">Not Started</option>
                    <option value="in_progress">In Progress</option>
                    <option value="submitted">Submitted</option>
                    <option value="under_review">Under Review</option>
                    <option value="completed">Completed</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Location
                  </label>
                  <input
                    value={formLocation}
                    onChange={(event) => setFormLocation(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="Ward office or meeting venue"
                  />
                </div>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false);
                    resetForm();
                  }}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={creating}
                  className="rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
                >
                  {creating
                    ? "Saving..."
                    : editingAssignmentId
                      ? "Update Assignment"
                      : "Save Assignment"}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard
          icon={<Flag className="h-5 w-5" />}
          label="Total"
          value={counts.total}
        />
        <SummaryCard
          icon={<Clock3 className="h-5 w-5" />}
          label="Pending"
          value={counts.pending}
        />
        <SummaryCard
          icon={<CalendarDays className="h-5 w-5" />}
          label="Submitted"
          value={counts.submitted}
        />
        <SummaryCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Completed"
          value={counts.completed}
        />
        <SummaryCard
          icon={<TriangleAlert className="h-5 w-5" />}
          label="Urgent"
          value={counts.urgent}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">
                {isAdmin && canManageAssignments
                  ? "All Assignments"
                  : "Assignments Within My Area"}
              </CardTitle>
              <p className="text-sm text-gray-500">
                {isAdmin && canManageAssignments
                  ? "Campaign-member admins can manage every assignment in the tenant."
                  : "Operational assignments associated with your organization scope."}
              </p>
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter assignments..."
                className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-apc-primary"
              />
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {areaLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading assignments...
            </div>
          )}

          {!areaLoading && visibleAssignments.length === 0 ? (
            <EmptyState
              title="No assignments found"
              description="There are no assignments in this view or the current filter has no matches."
            />
          ) : (
            <div className="space-y-3">
              {visibleAssignments.map((assignment) => {
                const assigneeName =
                  memberOptions.find(
                    (member) => member.id === assignment.assigned_to,
                  )?.full_name ?? assignment.assigned_to;

                return (
                  <AssignmentRow
                    key={assignment.id}
                    assignment={assignment}
                    showAssignee={isAdmin || canManageAssignments}
                    canManage={canManageAssignments}
                    assigneeName={assigneeName}
                    onEdit={() => startEditAssignment(assignment)}
                    onDelete={() => void handleDeleteAssignment(assignment.id)}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">My Assignments</CardTitle>
          <p className="text-sm text-gray-500">
            Campaign responsibilities assigned directly to you.
          </p>
        </CardHeader>

        <CardContent>
          {myAssignments.length === 0 ? (
            <EmptyState
              title="No assignments yet"
              description="You currently have no campaign responsibilities assigned to you."
            />
          ) : (
            <div className="space-y-3">
              {myAssignments.map((assignment) => (
                <AssignmentRow key={assignment.id} assignment={assignment} />
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
 * ASSIGNMENT ROW
 * ============================================================
 */

function AssignmentRow({
  assignment,
  showAssignee = false,
  canManage = false,
  assigneeName,
  onEdit,
  onDelete,
}: {
  assignment: CampaignAssignment;
  showAssignee?: boolean;
  canManage?: boolean;
  assigneeName?: string;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="rounded-xl border bg-white p-4 transition hover:shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-gray-900">{assignment.title}</h3>

            <PriorityBadge priority={assignment.priority} />

            <StatusBadge status={assignment.status} />
          </div>

          {assignment.description && (
            <p className="mt-2 text-sm leading-6 text-gray-500">
              {assignment.description}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
            <span className="rounded-lg bg-gray-100 px-2.5 py-1">
              {formatScopeType(assignment.scope_type as never)}:{" "}
              {assignment.scope_id}
            </span>

            {assignment.due_date && (
              <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                Due {formatDate(assignment.due_date)}
              </span>
            )}

            {showAssignee && (
              <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                Assigned to: {assigneeName ?? assignment.assigned_to}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Campaign
          </span>

          {canManage && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onEdit}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>

              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * SUMMARY CARD
 * ============================================================
 */

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-apc-primary/10 text-apc-primary">
            {icon}
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              {label}
            </p>

            <p className="mt-1 text-xl font-bold text-gray-900">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * PRIORITY
 * ============================================================
 */

function PriorityBadge({
  priority,
}: {
  priority: CampaignAssignment["priority"];
}) {
  const classes = {
    low: "bg-gray-100 text-gray-600",
    medium: "bg-blue-100 text-blue-700",
    high: "bg-orange-100 text-orange-700",
    urgent: "bg-red-100 text-red-700",
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${classes[priority]}`}
    >
      {priority}
    </span>
  );
}

/*
 * ============================================================
 * STATUS
 * ============================================================
 */

function StatusBadge({ status }: { status: CampaignAssignment["status"] }) {
  const labels = {
    not_started: "Not Started",
    in_progress: "In Progress",
    submitted: "Submitted",
    under_review: "Under Review",
    completed: "Completed",
    overdue: "Overdue",
  };

  return (
    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
      {labels[status]}
    </span>
  );
}

/*
 * ============================================================
 * EMPTY STATE
 * ============================================================
 */

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <CheckCircle2 className="mx-auto h-8 w-8 text-gray-300" />

      <p className="mt-3 font-semibold text-gray-900">{title}</p>

      <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
        {description}
      </p>
    </div>
  );
}

/*
 * ============================================================
 * DATE
 * ============================================================
 */

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/*
 * ============================================================
 * LOADING
 * ============================================================
 */

function AssignmentsLoading() {
  return (
    <div className="space-y-6 pb-10">
      <div className="h-28 animate-pulse rounded-2xl bg-gray-100" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="h-20 animate-pulse rounded-xl bg-gray-100"
          />
        ))}
      </div>

      <div className="h-64 animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
