"use client";

/**
 * POLITICORE — Campaign Assignments (Phase C cutover: PostgreSQL/Supabase).
 *
 * A client of the Campaign foundation through src/lib/supabase/campaign.ts:
 *   * listing is ONE RLS-scoped query — the legacy client-side
 *     expandAssignmentToScopes()/getAssignmentsForAssignmentScope fan-out
 *     is gone (D1); the database decides what this user sees;
 *   * creation flows the create_campaign_assignment RPC — tenant, creator
 *     and initial status are server-resolved (never payload fields);
 *   * the assignee picker flows campaign_assignable_members (0024) —
 *     server-side eligibility/scope resolution replaces the legacy
 *     tenant-wide member-directory download (D2);
 *   * edits and reassignment flow update_campaign_assignment_details
 *     (0024); status transitions flow campaign_assignment_transition —
 *     the legacy client-writable status dropdown is gone (§13/§15);
 *   * deletion is supervisor-only and blocked on completed work (0024).
 *
 * The route gate is resolveCampaignAccess (database-resolved, fail-closed);
 * the RPCs, view RLS, and policies remain the authoritative boundary.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Flag,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";

import {
  CampaignError,
  createAssignment,
  deleteAssignment,
  getAssignableMembers,
  getAssignments,
  resubmitAssignment,
  reviewAssignment,
  startAssignment,
  submitAssignment,
  updateAssignmentDetails,
  resolveCampaignAccess,
  ensureSupabaseSession,
  getSupabaseClient,
  type CampaignAssignment as SupabaseAssignment,
  type CampaignAssignmentPriority,
  type CampaignAssignmentStatus,
  type CampaignAuthority,
  type CampaignScopeType,
} from "@/lib/supabase";

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

const PRIORITIES: Array<{ value: CampaignAssignmentPriority; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const SCOPE_TYPES: Array<{ value: CampaignScopeType; label: string }> = [
  { value: "campaign", label: "Campaign" },
  { value: "state", label: "State" },
  { value: "senatorial_zone", label: "Zone" },
  { value: "lga", label: "LGA" },
  { value: "ward", label: "Ward" },
  { value: "polling_unit", label: "Polling Unit" },
];

function formatScopeType(scopeType: CampaignScopeType): string {
  return SCOPE_TYPES.find((s) => s.value === scopeType)?.label ?? scopeType;
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

export default function CampaignAssignmentsPage() {
  const { user, profile, assignments: orgAssignments } = useAuth();
  const toast = useToast();

  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");

  const [mine, setMine] = useState<SupabaseAssignment[]>([]);
  const [visible, setVisible] = useState<SupabaseAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SupabaseAssignment | null>(null);
  const [saving, setSaving] = useState(false);

  const [memberOptions, setMemberOptions] = useState<
    Array<{ id: string; full_name: string; email: string }>
  >([]);
  const [membersLoading, setMembersLoading] = useState(false);

  /** One RLS-scoped query per refresh; the database decides visibility. */
  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getSupabaseClient();
      const [mineRows, visibleRows] = await Promise.all([
        getAssignments(supabase, { mine: true }),
        getAssignments(supabase),
      ]);
      setMine(mineRows);
      setVisible(visibleRows);
    } catch (err) {
      console.error("Failed to load campaign assignments:", err);
      setLoadError(
        campaignErrorMessage(err, "We couldn't load campaign assignments right now."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

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

  // Initial load: cancelled-flag async pattern (same as Phase B).
  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const supabase = getSupabaseClient();
        const [mineRows, visibleRows] = await Promise.all([
          getAssignments(supabase, { mine: true }),
          getAssignments(supabase),
        ]);
        if (cancelled) return;
        setMine(mineRows);
        setVisible(visibleRows);
      } catch (err) {
        console.error("Failed to load campaign assignments:", err);
        if (cancelled) return;
        setLoadError(
          campaignErrorMessage(err, "We couldn't load campaign assignments right now."),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  // ── form state (ordinary fields only — status is never a form field) ─
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAssignedTo, setFormAssignedTo] = useState("");
  const [formScopeType, setFormScopeType] = useState<CampaignScopeType>("ward");
  const [formScopeId, setFormScopeId] = useState("");
  const [formPriority, setFormPriority] = useState<CampaignAssignmentPriority>("medium");
  const [formDueDate, setFormDueDate] = useState("");
  const [formLocation, setFormLocation] = useState("");

  const isAdmin = authority === "admin";
  const canCreate = authority === "admin" || authority === "scoped";

  /** Default create-scope: the coordinator's primary organizational
   * assignment (display context only — the server re-authorizes). */
  const primaryScope = useMemo(() => {
    const active = orgAssignments.filter((a) => a.status === "active");
    const first = active[0];
    return first
      ? { scopeType: first.scope_type as CampaignScopeType, scopeId: first.scope_id }
      : { scopeType: "ward" as CampaignScopeType, scopeId: "" };
  }, [orgAssignments]);

  const loadMemberOptions = useCallback(
    async (scopeType: CampaignScopeType, scopeId: string) => {
      if (!scopeId) {
        setMemberOptions([]);
        return;
      }
      setMembersLoading(true);
      try {
        const members = await getAssignableMembers(
          getSupabaseClient(),
          scopeType,
          scopeId,
        );
        setMemberOptions(members);
      } catch (err) {
        console.error("Failed to load eligible assignees:", err);
        setMemberOptions([]);
      } finally {
        setMembersLoading(false);
      }
    },
    [],
  );

  function openCreateForm() {
    setEditing(null);
    setFormTitle("");
    setFormDescription("");
    setFormAssignedTo("");
    setFormScopeType(primaryScope.scopeType);
    setFormScopeId(primaryScope.scopeId);
    setFormPriority("medium");
    setFormDueDate("");
    setFormLocation("");
    setShowForm(true);
    void loadMemberOptions(primaryScope.scopeType, primaryScope.scopeId);
  }

  function openEditForm(assignment: SupabaseAssignment) {
    setEditing(assignment);
    setFormTitle(assignment.title);
    setFormDescription(assignment.description ?? "");
    setFormAssignedTo(assignment.assigned_to);
    setFormScopeType(assignment.scope_type);
    setFormScopeId(assignment.scope_id);
    setFormPriority(assignment.priority);
    setFormDueDate(assignment.due_date ?? "");
    setFormLocation(assignment.location ?? "");
    setShowForm(true);
    void loadMemberOptions(assignment.scope_type, assignment.scope_id);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
  }

  const handleScopeChange = (scopeType: CampaignScopeType, scopeId: string) => {
    setFormScopeType(scopeType);
    setFormScopeId(scopeId);
    setMemberOptions([]);
    setFormAssignedTo("");
    void loadMemberOptions(scopeType, scopeId);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const supabase = getSupabaseClient();
    setSaving(true);
    try {
      if (editing) {
        await updateAssignmentDetails(supabase, editing.id, {
          title: formTitle.trim(),
          description: formDescription.trim() || undefined,
          priority: formPriority,
          due_date: formDueDate || undefined,
          location: formLocation.trim() || undefined,
          reassign_to: formAssignedTo !== editing.assigned_to ? formAssignedTo : undefined,
        });
        toast.success("Assignment updated successfully.");
      } else {
        await createAssignment(supabase, {
          title: formTitle.trim(),
          description: formDescription.trim() || undefined,
          assigned_to: formAssignedTo,
          scope_type: formScopeType,
          scope_id: formScopeId.trim(),
          priority: formPriority,
          due_date: formDueDate || undefined,
          location: formLocation.trim() || undefined,
        });
        toast.success("Assignment created successfully.");
      }
      closeForm();
      await loadAssignments();
    } catch (err) {
      console.error("Failed to save assignment:", err);
      toast.error(campaignErrorMessage(err, "We couldn't save the assignment. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (
    assignment: SupabaseAssignment,
    action: "start" | "submit" | "resubmit" | "accept" | "return",
  ) => {
    const supabase = getSupabaseClient();
    const labels: Record<typeof action, string> = {
      start: "started",
      submit: "submitted",
      resubmit: "resubmitted",
      accept: "accepted",
      return: "returned for rework",
    };
    try {
      if (action === "start") await startAssignment(supabase, assignment.id);
      else if (action === "submit") await submitAssignment(supabase, assignment.id);
      else if (action === "resubmit") await resubmitAssignment(supabase, assignment.id);
      else await reviewAssignment(supabase, assignment.id, action);
      toast.success(`Assignment ${labels[action]}.`);
    } catch (err) {
      console.error("Assignment transition failed:", err);
      toast.error(campaignErrorMessage(err, "The assignment update was not permitted."));
    }
  };

  const handleDelete = async (assignment: SupabaseAssignment) => {
    const supabase = getSupabaseClient();
    try {
      await deleteAssignment(supabase, assignment.id);
      toast.success("Assignment deleted.");
      await loadAssignments();
    } catch (err) {
      console.error("Failed to delete assignment:", err);
      toast.error(campaignErrorMessage(err, "We couldn't delete the assignment."));
    }
  };

  const counts = useMemo(
    () => ({
      total: mine.length,
      pending: mine.filter(
        (a) => a.status === "not_started" || a.status === "in_progress",
      ).length,
      submitted: mine.filter(
        (a) => a.status === "submitted" || a.status === "under_review",
      ).length,
      completed: mine.filter((a) => a.status === "completed").length,
      urgent: mine.filter((a) => a.priority === "urgent" && a.status !== "completed")
        .length,
    }),
    [mine],
  );

  const filteredVisible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return visible;
    return visible.filter((a) =>
      [a.title, a.description ?? "", a.scope_id, a.status, a.priority]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [visible, search]);

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
          <span>Loading campaign assignments...</span>
        </div>
      </div>
    );
  }

  if (gate === "no_session" || !user) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900">Sign in required</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to view your campaign assignments.
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
            : "You do not have access to Campaign assignments.";
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

  const uid = profile?.id ?? user.id;

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

          <p className="text-sm font-semibold text-apc-primary">Campaign Council</p>

          <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
            Campaign Assignments
          </h1>

          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
            Manage and track campaign responsibilities within your organizational
            authority.
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
                  Access Level
                </p>

                <p className="mt-1 font-semibold text-gray-900">
                  {isAdmin
                    ? "Tenant-wide administration"
                    : authority === "scoped"
                      ? "Scoped coordinator authority"
                      : "Campaign member"}
                </p>

                <p className="mt-1 text-sm text-gray-500">
                  {primaryScope.scopeId
                    ? `${formatScopeType(primaryScope.scopeType)} · ${primaryScope.scopeId}`
                    : "Visibility is determined by your organizational authority."}
                </p>
              </div>
            </div>

            {canCreate && (
              <button
                type="button"
                onClick={openCreateForm}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-apc-dark"
              >
                <Plus className="h-4 w-4" />
                Create Assignment
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {showForm && canCreate && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">
                {editing ? "Edit Assignment" : "Create Assignment"}
              </CardTitle>

              <button
                type="button"
                onClick={closeForm}
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

                  {membersLoading ? (
                    <div className="flex items-center gap-2 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-sm text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading eligible members...
                    </div>
                  ) : (
                    <select
                      value={formAssignedTo}
                      onChange={(event) => setFormAssignedTo(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      required
                    >
                      <option value="">Select an eligible campaign member</option>
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
                      setFormPriority(event.target.value as CampaignAssignmentPriority)
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Scope Type
                  </label>
                  <select
                    value={formScopeType}
                    onChange={(event) =>
                      handleScopeChange(
                        event.target.value as CampaignScopeType,
                        formScopeId,
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                  >
                    {SCOPE_TYPES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Scope ID
                  </label>
                  <input
                    value={formScopeId}
                    onChange={(event) =>
                      handleScopeChange(formScopeType, event.target.value)
                    }
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

              <p className="text-xs text-gray-400">
                {editing
                  ? "Scope changes are made by creating a new assignment; reassignment and edits are audited."
                  : "Assignees are limited to eligible campaign members within the selected scope."}
              </p>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
                >
                  {saving
                    ? "Saving..."
                    : editing
                      ? "Update Assignment"
                      : "Save Assignment"}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard icon={<Flag className="h-5 w-5" />} label="Total" value={counts.total} />
        <SummaryCard icon={<Clock3 className="h-5 w-5" />} label="Pending" value={counts.pending} />
        <SummaryCard icon={<CalendarDays className="h-5 w-5" />} label="Submitted" value={counts.submitted} />
        <SummaryCard icon={<CheckCircle2 className="h-5 w-5" />} label="Completed" value={counts.completed} />
        <SummaryCard icon={<TriangleAlert className="h-5 w-5" />} label="Urgent" value={counts.urgent} />
      </div>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">
                {isAdmin ? "All Assignments" : "Assignments Within My Area"}
              </CardTitle>
              <p className="text-sm text-gray-500">
                Visibility is determined by the database — no client-side scope
                expansion.
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
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading assignments...
            </div>
          ) : filteredVisible.length === 0 ? (
            <EmptyState
              title="No assignments found"
              description="There are no assignments in this view or the current filter has no matches."
            />
          ) : (
            <div className="space-y-3">
              {filteredVisible.map((assignment) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  showAssignee={canCreate}
                  canManage={canCreate}
                  isReviewer={canCreate}
                  currentUserId={uid}
                  onEdit={() => openEditForm(assignment)}
                  onDelete={() => void handleDelete(assignment)}
                  onTransition={(action) => void handleTransition(assignment, action)}
                  memberName={memberOptions.find((m) => m.id === assignment.assigned_to)?.full_name}
                />
              ))}
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
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : mine.length === 0 ? (
            <EmptyState
              title="No assignments yet"
              description="You currently have no campaign responsibilities assigned to you."
            />
          ) : (
            <div className="space-y-3">
              {mine.map((assignment) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  currentUserId={uid}
                  onTransition={(action) => void handleTransition(assignment, action)}
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
 * ASSIGNMENT ROW
 * ============================================================
 */

function AssignmentRow({
  assignment,
  showAssignee = false,
  canManage = false,
  isReviewer = false,
  currentUserId,
  onEdit,
  onDelete,
  onTransition,
  memberName,
}: {
  assignment: SupabaseAssignment;
  showAssignee?: boolean;
  canManage?: boolean;
  isReviewer?: boolean;
  currentUserId: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onTransition: (action: "start" | "submit" | "resubmit" | "accept" | "return") => void;
  memberName?: string;
}) {
  const isAssignee = assignment.assigned_to === currentUserId;
  const actions: Array<{
    label: string;
    action: "start" | "submit" | "resubmit" | "accept" | "return";
    style: string;
    icon: React.ReactNode;
  }> = [];

  if (isAssignee && assignment.status === "not_started") {
    actions.push({
      label: "Start",
      action: "start",
      style: "border-apc-primary/30 text-apc-primary hover:bg-apc-primary/5",
      icon: <Play className="h-3 w-3" />,
    });
  }
  if (isAssignee && (assignment.status === "not_started" || assignment.status === "in_progress")) {
    actions.push({
      label: "Submit",
      action: "submit",
      style: "border-apc-primary bg-apc-primary text-white hover:bg-apc-dark",
      icon: <Send className="h-3 w-3" />,
    });
  }
  if (isAssignee && assignment.status === "under_review") {
    actions.push({
      label: "Resubmit",
      action: "resubmit",
      style: "border-apc-primary bg-apc-primary text-white hover:bg-apc-dark",
      icon: <Undo2 className="h-3 w-3" />,
    });
  }
  if (isReviewer && (assignment.status === "submitted" || assignment.status === "under_review")) {
    actions.push({
      label: "Accept",
      action: "accept",
      style: "border-green-200 bg-green-50 text-green-700 hover:bg-green-100",
      icon: <CheckCircle2 className="h-3 w-3" />,
    });
    if (assignment.status === "submitted") {
      actions.push({
        label: "Return",
        action: "return",
        style: "border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100",
        icon: <Undo2 className="h-3 w-3" />,
      });
    }
  }

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
              {formatScopeType(assignment.scope_type)}: {assignment.scope_id}
            </span>

            {assignment.due_date && (
              <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                Due {formatDate(assignment.due_date)}
              </span>
            )}

            {showAssignee && (
              <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                Assigned to: {memberName ?? assignment.assigned_to.slice(0, 8)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Campaign
          </span>

          {actions.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {actions.map((a) => (
                <button
                  key={a.action}
                  type="button"
                  onClick={() => onTransition(a.action)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium ${a.style}`}
                >
                  {a.icon}
                  {a.label}
                </button>
              ))}
            </div>
          )}

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

              {assignment.status !== "completed" && (
                <button
                  type="button"
                  onClick={onDelete}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              )}
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
 * PRIORITY / STATUS
 * ============================================================
 */

function PriorityBadge({ priority }: { priority: CampaignAssignmentPriority }) {
  const classes: Record<CampaignAssignmentPriority, string> = {
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

function StatusBadge({ status }: { status: CampaignAssignmentStatus }) {
  const labels: Record<CampaignAssignmentStatus, string> = {
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
 * EMPTY STATE / DATE / LOADING
 * ============================================================
 */

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <CheckCircle2 className="mx-auto h-8 w-8 text-gray-300" />

      <p className="mt-3 font-semibold text-gray-900">{title}</p>

      <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">{description}</p>
    </div>
  );
}

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
