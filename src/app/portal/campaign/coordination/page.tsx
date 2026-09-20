"use client";

import { useEffect, useMemo, useState } from "react";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";

import { collection, getDocs, orderBy, query } from "firebase/firestore";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useAuth } from "@/contexts/AuthContext";

import { db } from "@/lib/firebase/config";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";

import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  createOrganizationalAssignment,
  deleteOrganizationalAssignment,
  updateOrganizationalAssignment,
} from "@/lib/firebase/organizationalAssignments";

import {
  createPermissionGrant,
  deletePermissionGrant,
} from "@/lib/firebase/permissionGrants";

import type {
  OrganizationalAssignment,
  OrganizationalPosition,
  Permission,
  PermissionGrant,
  ScopeType,
  UserProfile,
} from "@/types";

/*
 * ============================================================
 * CAMPAIGN COORDINATION / ADMIN TOOLS
 * ============================================================
 *
 * This page is deliberately kept as ONE page.
 *
 * It manages:
 *
 *   1. Organizational assignments
 *   2. Permission grants
 *
 * IMPORTANT:
 *
 * access_role answers:
 *
 *   "What application-level access does this account have?"
 *
 * OrganizationalAssignment answers:
 *
 *   "Where does this person operate?"
 *
 * PermissionGrant answers:
 *
 *   "What explicit exception/additional permission has been
 *    granted or denied?"
 *
 * ALL MUTATIONS go through the service functions in
 * organizationalAssignments.ts and permissionGrants.ts.
 *
 * Those functions are responsible for keeping the user_access
 * security index in sync. This page MUST NOT write to Firestore
 * directly, otherwise the security index drifts and non-admin
 * users silently lose access.
 *
 * Firestore security rules remain the real security boundary.
 * ============================================================
 */

const POSITIONS: OrganizationalPosition[] = [
  "campaign_member",
  "ward_coordinator",
  "lga_coordinator",
  "zone_coordinator",
  "state_coordinator",
  "campaign_manager",
  "council_chairman",
];

const SCOPE_TYPES: ScopeType[] = [
  "polling_unit",
  "ward",
  "lga",
  "senatorial_zone",
  "state",
  "campaign",
];

const PERMISSIONS: Permission[] = [
  "view_dashboard",
  "view_area",
  "view_members",
  "view_member_contacts",
  "manage_members",
  "view_assignments",
  "create_assignment",
  "assign_task",
  "review_assignment",
  "view_activities",
  "create_activity",
  "manage_activity",
  "view_activity_reports",
  "submit_field_report",
  "review_field_report",
  "report_issue",
  "manage_issue",
  "view_notices",
  "send_notice",
  "view_documents",
  "manage_documents",
  "view_analytics",
  "manage_organization",
  "manage_permissions",
  "manage_campaign_settings",
  "submit_election_pu_report",
  "submit_election_incident",
  "upload_election_result",
  "view_election_dashboard",
  "manage_election_settings",
  "view_private_donations",
  "manage_private_donations",
  "view_public_donations",
  "manage_public_donations",
];

/*
 * ============================================================
 * LABEL HELPERS
 * ============================================================
 */

function humanize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function positionLabel(position: OrganizationalPosition) {
  return humanize(position);
}

function scopeLabel(scope: ScopeType) {
  return humanize(scope);
}

function permissionLabel(permission: Permission) {
  return humanize(permission);
}

/*
 * ============================================================
 * PAGE
 * ============================================================
 */

export default function CampaignCoordinationPage() {
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();

  const [members, setMembers] = useState<UserProfile[]>([]);
  const [assignments, setAssignments] = useState<OrganizationalAssignment[]>(
    [],
  );
  const [grants, setGrants] = useState<PermissionGrant[]>([]);

  const [loading, setLoading] = useState(true);


  const [search, setSearch] = useState("");

  /*
   * ------------------------------------------------------------
   * ASSIGNMENT FORM
   * ------------------------------------------------------------
   */

  const [selectedUserId, setSelectedUserId] = useState("");

  const [selectedPosition, setSelectedPosition] =
    useState<OrganizationalPosition>("campaign_member");

  const [selectedScopeType, setSelectedScopeType] = useState<ScopeType>("ward");

  const [selectedScopeId, setSelectedScopeId] = useState("");

  const [creatingAssignment, setCreatingAssignment] = useState(false);

  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(
    null,
  );

  /*
   * ------------------------------------------------------------
   * GRANT FORM
   * ------------------------------------------------------------
   */

  const [grantUserId, setGrantUserId] = useState("");

  const [grantPermission, setGrantPermission] =
    useState<Permission>("view_dashboard");

  const [grantScopeType, setGrantScopeType] = useState<ScopeType | "">("");

  const [grantScopeId, setGrantScopeId] = useState("");

  const [grantValue, setGrantValue] = useState(true);

  const [creatingGrant, setCreatingGrant] = useState(false);

  /*
   * ------------------------------------------------------------
   * LOAD
   * ------------------------------------------------------------
   */

  async function loadData() {
    if (!profile || profile.access_role !== "admin") {
      return;
    }

    try {
      setLoading(true);

      const usersQuery = query(
        collection(db, "users"),
        orderBy("created_at", "desc"),
      );

      const assignmentsQuery = query(
        collection(db, "organizational_assignments"),
        orderBy("created_at", "desc"),
      );

      const grantsQuery = query(
        collection(db, "permission_grants"),
        orderBy("created_at", "desc"),
      );

      const [usersSnap, assignmentsSnap, grantsSnap] = await Promise.all([
        getDocs(usersQuery),
        getDocs(assignmentsQuery),
        getDocs(grantsQuery),
      ]);

      setMembers(
        usersSnap.docs.map(
          (item) =>
            ({
              id: item.id,
              ...item.data(),
            }) as UserProfile,
        ),
      );

      setAssignments(
        assignmentsSnap.docs.map(
          (item) =>
            ({
              id: item.id,
              ...item.data(),
            }) as OrganizationalAssignment,
        ),
      );

      setGrants(
        grantsSnap.docs.map(
          (item) =>
            ({
              id: item.id,
              ...item.data(),
            }) as PermissionGrant,
        ),
      );
    } catch (err) {
      console.error("Failed to load campaign coordination data:", err);

      toast.error("We couldn't load the coordination data. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      loadData();
    }
  }, [authLoading, profile?.access_role]);

  /*
   * ------------------------------------------------------------
   * MEMBER LOOKUP
   * ------------------------------------------------------------
   */

  function memberName(userId: string) {
    return (
      members.find((member) => member.id === userId)?.full_name ??
      "Unknown member"
    );
  }

  function memberEmail(userId: string) {
    return members.find((member) => member.id === userId)?.email ?? "";
  }

  /*
   * ------------------------------------------------------------
   * FILTERED ASSIGNMENTS
   * ------------------------------------------------------------
   */

  const filteredAssignments = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) {
      return assignments;
    }

    return assignments.filter((assignment) => {
      const name = memberName(assignment.user_id).toLowerCase();

      return (
        name.includes(term) ||
        assignment.position.toLowerCase().includes(term) ||
        assignment.scope_type.toLowerCase().includes(term) ||
        assignment.scope_id.toLowerCase().includes(term)
      );
    });
  }, [assignments, search, members]);

  /*
   * ------------------------------------------------------------
   * CREATE / UPDATE ASSIGNMENT
   * ------------------------------------------------------------
   */

  function resetAssignmentForm() {
    setSelectedUserId("");
    setSelectedPosition("campaign_member");
    setSelectedScopeType("ward");
    setSelectedScopeId("");
    setEditingAssignmentId(null);
  }

  function startEditAssignment(assignment: OrganizationalAssignment) {
    setEditingAssignmentId(assignment.id);
    setSelectedUserId(assignment.user_id);
    setSelectedPosition(assignment.position);
    setSelectedScopeType(assignment.scope_type);
    setSelectedScopeId(assignment.scope_id);
  }

  async function createAssignment() {
    if (!profile?.id) return;

    if (!selectedUserId || !selectedScopeId.trim()) {
      toast.warning("Please select a member and provide a scope for the assignment.");
      return;
    }

    try {
      setCreatingAssignment(true);

      if (editingAssignmentId) {
        await updateOrganizationalAssignment(editingAssignmentId, {
          position: selectedPosition,
          scope_type: selectedScopeType,
          scope_id: selectedScopeId.trim(),
        });
      } else {
        await createOrganizationalAssignment({
          tenant_id: profile.tenant_id || CURRENT_TENANT_ID,
          user_id: selectedUserId,
          position: selectedPosition,
          scope_type: selectedScopeType,
          scope_id: selectedScopeId.trim(),
          status: "active",
          assigned_by: profile.id,
        });
      }

      resetAssignmentForm();
      await loadData();
      toast.success(
        editingAssignmentId
          ? "Organizational assignment updated."
          : "Organizational assignment created.",
      );
    } catch (err) {
      console.error("Failed to save assignment:", err);

      toast.error(
        getErrorMessage(
          err,
          editingAssignmentId
            ? "We couldn't update the organizational assignment. Please try again."
            : "We couldn't create the organizational assignment. Please try again.",
        ),
      );
    } finally {
      setCreatingAssignment(false);
    }
  }

  /*
   * ------------------------------------------------------------
   * TOGGLE ASSIGNMENT STATUS
   * ------------------------------------------------------------
   *
   * Delegates to updateOrganizationalAssignment so that the
   * user_access index is added or removed consistently with
   * the assignment status change.
   */

  async function toggleAssignment(assignment: OrganizationalAssignment) {
    try {
      const nextStatus = assignment.status === "active" ? "inactive" : "active";

      await updateOrganizationalAssignment(assignment.id, {
        status: nextStatus,
      });

      await loadData();
      toast.success(`Assignment marked as ${nextStatus}.`);
    } catch (err) {
      console.error("Failed to update assignment:", err);

      toast.error(getErrorMessage(err, "We couldn't update the assignment. Please try again."));
    }
  }

  /*
   * ------------------------------------------------------------
   * DELETE ASSIGNMENT
   * ------------------------------------------------------------
   */

  async function removeAssignment(assignmentId: string) {
    try {
      await deleteOrganizationalAssignment(assignmentId);

      await loadData();
      toast.success("Organizational assignment removed.");
    } catch (err) {
      console.error("Failed to delete assignment:", err);

      toast.error(getErrorMessage(err, "We couldn't remove the assignment. Please try again."));
    }
  }

  /*
   * ------------------------------------------------------------
   * CREATE PERMISSION GRANT
   * ------------------------------------------------------------
   *
   * Delegates to createPermissionGrant so that the user_access
   * index is written alongside the grant.
   */

  async function createGrant() {
    if (!profile?.id) return;

    if (!grantUserId) {
      toast.warning("Please select a member for the permission grant.");
      return;
    }

    try {
      setCreatingGrant(true);

      await createPermissionGrant({
        tenant_id: profile.tenant_id || CURRENT_TENANT_ID,
        user_id: grantUserId,
        permission: grantPermission,
        granted: grantValue,
        scope_type: grantScopeType || null,
        scope_id:
          grantScopeType && grantScopeId.trim() ? grantScopeId.trim() : null,
        granted_by: profile.id,
      });

      setGrantUserId("");
      setGrantScopeId("");
      setGrantScopeType("");

      await loadData();
      toast.success("Permission grant saved.");
    } catch (err) {
      console.error("Failed to create permission grant:", err);

      toast.error(getErrorMessage(err, "We couldn't create the permission grant. Please try again."));
    } finally {
      setCreatingGrant(false);
    }
  }

  /*
   * ------------------------------------------------------------
   * DELETE GRANT
   * ------------------------------------------------------------
   *
   * Delegates to deletePermissionGrant so the user_access index
   * entry is removed cleanly.
   */

  async function removeGrant(grantId: string) {
    try {
      await deletePermissionGrant(grantId);

      await loadData();
      toast.success("Permission grant removed.");
    } catch (err) {
      console.error("Failed to delete permission grant:", err);

      toast.error(getErrorMessage(err, "We couldn't remove the permission grant. Please try again."));
    }
  }

  /*
   * ------------------------------------------------------------
   * AUTH GUARD
   * ------------------------------------------------------------
   */

  if (authLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading...
      </div>
    );
  }

  if (!profile) {
    return null;
  }

  if (profile.access_role !== "admin") {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-red-600" />

          <div>
            <p className="font-semibold text-red-900">Access restricted</p>

            <p className="mt-1 text-sm text-red-700">
              Campaign coordination administration is currently available to
              administrators only.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /*
   * ------------------------------------------------------------
   * DASHBOARD
   * ------------------------------------------------------------
   */

  return (
    <div className="space-y-6 pb-10">
      {/* ======================================================
          HEADER
          ====================================================== */}

      <section className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-apc-primary">
              Campaign Administration
            </p>

            <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
              Coordination &amp; Organization
            </h1>

            <p className="mt-2 max-w-3xl text-gray-600">
              Manage campaign organizational positions, scopes and explicit
              permissions without changing application-level access roles.
            </p>
          </div>

          <button
            type="button"
            onClick={loadData}
            disabled={loading}
            className="inline-flex w-fit items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </section>


      {/* ======================================================
          SUMMARY
          ====================================================== */}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          icon={<Users className="h-5 w-5" />}
          label="Campaign Members"
          value={members.length}
        />

        <SummaryCard
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Assignments"
          value={assignments.length}
        />

        <SummaryCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Active Assignments"
          value={assignments.filter((item) => item.status === "active").length}
        />

        <SummaryCard
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Permission Grants"
          value={grants.length}
        />
      </div>

      {/* ======================================================
          CREATE ASSIGNMENT
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Plus className="h-5 w-5 text-apc-primary" />
            Assign Organizational Position
          </CardTitle>

          <p className="text-sm text-gray-500">
            Assign a campaign member to a position and organizational scope.
            This writes the assignment and updates the security index.
          </p>
        </CardHeader>

        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <SelectField
              label="Member"
              value={selectedUserId}
              onChange={setSelectedUserId}
              options={[
                {
                  value: "",
                  label: "Select member",
                },
                ...members.map((member) => ({
                  value: member.id ?? "",
                  label: member.full_name,
                })),
              ]}
            />

            <SelectField
              label="Position"
              value={selectedPosition}
              onChange={(value) =>
                setSelectedPosition(value as OrganizationalPosition)
              }
              options={POSITIONS.map((position) => ({
                value: position,
                label: positionLabel(position),
              }))}
            />

            <SelectField
              label="Scope Type"
              value={selectedScopeType}
              onChange={(value) => setSelectedScopeType(value as ScopeType)}
              options={SCOPE_TYPES.map((scope) => ({
                value: scope,
                label: scopeLabel(scope),
              }))}
            />

            <TextField
              label="Scope ID"
              value={selectedScopeId}
              onChange={setSelectedScopeId}
              placeholder="e.g. nkanu-west-ward-01"
            />
          </div>

          <div className="mt-4 flex justify-end gap-3">
            {editingAssignmentId && (
              <button
                type="button"
                onClick={resetAssignmentForm}
                className="rounded-lg border px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50"
              >
                Cancel Edit
              </button>
            )}

            <button
              type="button"
              onClick={createAssignment}
              disabled={creatingAssignment}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
            >
              {creatingAssignment ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editingAssignmentId ? (
                <Pencil className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {editingAssignmentId ? "Update Assignment" : "Assign Position"}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          ASSIGNMENTS
          ====================================================== */}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-xl">
                Organizational Assignments
              </CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Manage who is responsible for each campaign organizational
                scope.
              </p>
            </div>

            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search assignments..."
                className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm outline-none focus:border-apc-primary"
              />
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {loading ? (
            <LoadingRow />
          ) : filteredAssignments.length === 0 ? (
            <EmptyState text="No organizational assignments found." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px]">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-400">
                    <th className="px-3 py-3">Member</th>

                    <th className="px-3 py-3">Position</th>

                    <th className="px-3 py-3">Scope</th>

                    <th className="px-3 py-3">Status</th>

                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredAssignments.map((assignment) => (
                    <tr key={assignment.id} className="border-b last:border-0">
                      <td className="px-3 py-4">
                        <p className="font-semibold text-gray-900">
                          {memberName(assignment.user_id)}
                        </p>

                        <p className="text-xs text-gray-500">
                          {memberEmail(assignment.user_id)}
                        </p>
                      </td>

                      <td className="px-3 py-4">
                        <span className="rounded-full bg-apc-primary/10 px-3 py-1 text-xs font-semibold text-apc-primary">
                          {positionLabel(assignment.position)}
                        </span>
                      </td>

                      <td className="px-3 py-4">
                        <p className="text-sm font-medium text-gray-900">
                          {scopeLabel(assignment.scope_type)}
                        </p>

                        <p className="text-xs text-gray-500">
                          {assignment.scope_id}
                        </p>
                      </td>

                      <td className="px-3 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            assignment.status === "active"
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {humanize(assignment.status)}
                        </span>
                      </td>

                      <td className="px-3 py-4">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => startEditAssignment(assignment)}
                            className="rounded-lg border border-blue-200 p-2 text-blue-600 hover:bg-blue-50"
                            aria-label={`Edit assignment for ${memberName(
                              assignment.user_id,
                            )}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>

                          <button
                            type="button"
                            onClick={() => toggleAssignment(assignment)}
                            className="rounded-lg border px-3 py-2 text-xs font-semibold hover:bg-gray-50"
                          >
                            {assignment.status === "active"
                              ? "Deactivate"
                              : "Activate"}
                          </button>

                          <button
                            type="button"
                            onClick={() => removeAssignment(assignment.id)}
                            className="rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"
                            aria-label={`Delete assignment for ${memberName(
                              assignment.user_id,
                            )}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================
          PERMISSION GRANTS
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Explicit Permission Grants</CardTitle>

          <p className="text-sm text-gray-500">
            Grant or deny a specific capability independently of the
            member&apos;s organizational position.
          </p>
        </CardHeader>

        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
            <SelectField
              label="Member"
              value={grantUserId}
              onChange={setGrantUserId}
              options={[
                {
                  value: "",
                  label: "Select member",
                },
                ...members.map((member) => ({
                  value: member.id ?? "",
                  label: member.full_name,
                })),
              ]}
            />

            <SelectField
              label="Permission"
              value={grantPermission}
              onChange={(value) => setGrantPermission(value as Permission)}
              options={PERMISSIONS.map((permission) => ({
                value: permission,
                label: permissionLabel(permission),
              }))}
            />

            <SelectField
              label="Scope"
              value={grantScopeType}
              onChange={(value) => setGrantScopeType(value as ScopeType | "")}
              options={[
                {
                  value: "",
                  label: "Global",
                },
                ...SCOPE_TYPES.map((scope) => ({
                  value: scope,
                  label: scopeLabel(scope),
                })),
              ]}
            />

            <TextField
              label="Scope ID"
              value={grantScopeId}
              onChange={setGrantScopeId}
              placeholder="Optional scope ID"
            />

            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Decision
              </label>

              <button
                type="button"
                onClick={() => setGrantValue((value) => !value)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm font-semibold ${
                  grantValue
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                <span>{grantValue ? "Granted" : "Denied"}</span>

                {grantValue ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={createGrant}
              disabled={creatingGrant}
              className="rounded-lg bg-apc-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
            >
              {creatingGrant ? "Saving..." : "Save Permission Grant"}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          GRANTS LIST
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Current Permission Grants</CardTitle>
        </CardHeader>

        <CardContent>
          {grants.length === 0 ? (
            <EmptyState text="No explicit permission grants have been created." />
          ) : (
            <div className="space-y-3">
              {grants.map((grant) => (
                <div
                  key={grant.id}
                  className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-semibold text-gray-900">
                      {memberName(grant.user_id)}
                    </p>

                    <p className="mt-1 text-sm text-gray-600">
                      {permissionLabel(grant.permission)}
                    </p>

                    {grant.scope_type && (
                      <p className="mt-1 text-xs text-gray-500">
                        Scope: {scopeLabel(grant.scope_type)}
                        {grant.scope_id ? ` — ${grant.scope_id}` : ""}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        grant.granted
                          ? "bg-green-100 text-green-700"
                          : "bg-red-100 text-red-700"
                      }`}
                    >
                      {grant.granted ? "Granted" : "Denied"}
                    </span>

                    <button
                      type="button"
                      onClick={() => removeGrant(grant.id)}
                      className="rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
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
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
          {icon}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            {label}
          </p>

          <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * SELECT FIELD
 * ============================================================
 */

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: {
    value: string;
    label: string;
  }[];
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700">
        {label}
      </label>

      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full appearance-none rounded-lg border bg-white px-3 py-2.5 pr-9 text-sm outline-none focus:border-apc-primary"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      </div>
    </div>
  );
}

/*
 * ============================================================
 * TEXT FIELD
 * ============================================================
 */

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700">
        {label}
      </label>

      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
      />
    </div>
  );
}

/*
 * ============================================================
 * EMPTY STATE
 * ============================================================
 */

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center text-sm text-gray-500">
      {text}
    </div>
  );
}

/*
 * ============================================================
 * LOADING
 * ============================================================
 */

function LoadingRow() {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-500">
      <Loader2 className="h-5 w-5 animate-spin" />
      Loading campaign organization...
    </div>
  );
}
