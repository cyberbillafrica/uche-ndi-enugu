"use client";

/**
 * POLITICORE — Campaign Issues (Phase D cutover: PostgreSQL/Supabase).
 *
 * A client of the Campaign foundation through src/lib/supabase/campaign.ts:
 *   * listing is ONE RLS-scoped query — the legacy client-side
 *     getScopedCampaignIssues fan-out is gone (D1); the database decides
 *     what this user sees;
 *   * creation flows the policy-guarded insert (reporter/tenant/status
 *     server-pinned — the D3 fix);
 *   * the full lifecycle flows campaign_issue_transition (0025) —
 *     acknowledge/assign/start/resolve/verify/close; the distinct
 *     resolver/verifier/closer actors are enforced server-side;
 *   * assignment uses the eligible-members picker (0024 RPC) — the
 *     legacy tenant-wide directory download is gone (D2).
 *
 * The route gate is resolveCampaignAccess (database-resolved, fail-closed);
 * the RPCs, view RLS, and policies remain the authoritative boundary.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  Lock,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  UserPlus,
  X,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";

import {
  CampaignError,
  assignIssue,
  createIssue,
  getAssignableMembers,
  getIssues,
  updateIssueStatus,
  resolveCampaignAccess,
  ensureSupabaseSession,
  getSupabaseClient,
  type CampaignAuthority,
  type CampaignDirectoryMember,
  type CampaignIssue as SupabaseIssue,
  type CampaignIssuePriority,
  type CampaignIssueStatus,
  type CampaignIssueType,
  type CampaignScopeType,
} from "@/lib/supabase";

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

const ISSUE_TYPES: Array<{ value: CampaignIssueType; label: string }> = [
  { value: "logistics", label: "Logistics" },
  { value: "campaign_activity", label: "Campaign Activity" },
  { value: "community_concern", label: "Community Concern" },
  { value: "volunteer", label: "Volunteer" },
  { value: "communication", label: "Communication" },
  { value: "security", label: "Security" },
  { value: "infrastructure", label: "Infrastructure / Community" },
  { value: "other", label: "Other" },
];

const STATUS_LABELS: Record<CampaignIssueStatus, string> = {
  reported: "Reported",
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  in_progress: "In Progress",
  resolved: "Resolved",
  verified: "Verified",
  closed: "Closed",
};

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

export default function CampaignIssuesPage() {
  const { user, profile, assignments: orgAssignments } = useAuth();
  const toast = useToast();

  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");

  const [issues, setIssues] = useState<SupabaseIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const isAdmin = authority === "admin";
  const canReport = authority === "admin" || authority === "scoped" || authority === "member";
  const canManage = authority === "admin" || authority === "scoped";

  /** One RLS-scoped query; the database decides visibility. */
  const loadIssues = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await getIssues(getSupabaseClient());
      setIssues(rows);
    } catch (err) {
      console.error("Failed to load campaign issues:", err);
      setLoadError(campaignErrorMessage(err, "We couldn't load campaign issues right now."));
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

  // Initial load: cancelled-flag async pattern (same as Phases B/C).
  useEffect(() => {
    if (gate !== "ready") return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await getIssues(getSupabaseClient());
        if (cancelled) return;
        setIssues(rows);
      } catch (err) {
        console.error("Failed to load campaign issues:", err);
        if (cancelled) return;
        setLoadError(campaignErrorMessage(err, "We couldn't load campaign issues right now."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  const primaryScope = useMemo(() => {
    const active = orgAssignments.filter((a) => a.status === "active");
    const first = active[0];
    return first
      ? { scopeType: first.scope_type as CampaignScopeType, scopeId: first.scope_id }
      : null;
  }, [orgAssignments]);

  const counts = useMemo(
    () => ({
      total: issues.length,
      reported: issues.filter((i) => i.status === "reported").length,
      inProgress: issues.filter((i) => i.status === "in_progress").length,
      resolved: issues.filter(
        (i) => i.status === "resolved" || i.status === "verified" || i.status === "closed",
      ).length,
      urgent: issues.filter(
        (i) =>
          i.priority === "urgent" &&
          i.status !== "resolved" &&
          i.status !== "verified" &&
          i.status !== "closed",
      ).length,
    }),
    [issues],
  );

  const filteredIssues = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return issues;
    return issues.filter((i) =>
      [i.title, i.description, i.issue_type, i.scope_id, i.status, i.priority]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [issues, search]);

  const uid = profile?.id ?? user?.id ?? "";

  // ── form state (ordinary fields only — status is never a form field) ─
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formType, setFormType] = useState<CampaignIssueType>("community_concern");
  const [formPriority, setFormPriority] = useState<CampaignIssuePriority>("medium");
  const [formLocation, setFormLocation] = useState("");
  const [adminScopeType, setAdminScopeType] = useState<CampaignScopeType>("campaign");
  const [adminScopeId, setAdminScopeId] = useState("enugu-state");

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let scopeType: CampaignScopeType;
    let scopeId: string;
    if (isAdmin) {
      scopeId = adminScopeId.trim();
      if (!scopeId) return;
      scopeType = adminScopeType;
    } else {
      if (!primaryScope) {
        toast.error("You need an active campaign organizational assignment before reporting a scoped issue.");
        return;
      }
      scopeType = primaryScope.scopeType;
      scopeId = primaryScope.scopeId;
    }
    if (!formTitle.trim() || !formDescription.trim()) return;

    const supabase = getSupabaseClient();
    setSaving(true);
    try {
      await createIssue(supabase, {
        title: formTitle.trim(),
        description: formDescription.trim(),
        issue_type: formType,
        priority: formPriority,
        scope_type: scopeType,
        scope_id: scopeId,
        location: formLocation.trim() || undefined,
      });
      toast.success("Issue reported.");
      setShowForm(false);
      setFormTitle("");
      setFormDescription("");
      setFormLocation("");
      await loadIssues();
    } catch (err) {
      console.error("Failed to create issue:", err);
      toast.error(campaignErrorMessage(err, "We couldn't submit the issue. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const handleAction = async (
    issue: SupabaseIssue,
    action: "acknowledge" | "start" | "resolve" | "verify" | "close",
    notes?: string,
  ) => {
    const supabase = getSupabaseClient();
    try {
      const next = await updateIssueStatus(supabase, issue.id, action, notes);
      toast.success(`Issue is now ${STATUS_LABELS[next as CampaignIssueStatus] ?? next}.`);
      await loadIssues();
    } catch (err) {
      console.error("Issue transition failed:", err);
      toast.error(campaignErrorMessage(err, "The issue action was not permitted."));
    }
  };

  const handleAssign = async (issue: SupabaseIssue, assignee: string) => {
    const supabase = getSupabaseClient();
    try {
      await assignIssue(supabase, issue.id, assignee);
      toast.success("Issue assigned.");
      await loadIssues();
    } catch (err) {
      console.error("Issue assignment failed:", err);
      toast.error(campaignErrorMessage(err, "The assignment was not permitted."));
    }
  };

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
          <span>Loading campaign issues...</span>
        </div>
      </div>
    );
  }

  if (gate === "no_session" || !user) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900">Sign in required</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to view campaign issues.
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
            : "You do not have access to Campaign issues.";
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

  /*
   * ----------------------------------------------------------
   * PAGE
   * ----------------------------------------------------------
   */

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

          <p className="text-sm font-semibold text-apc-primary">Campaign Operations</p>

          <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
            Scoped Issues
          </h1>

          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
            Report and monitor operational issues within your assigned campaign
            area.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void loadIssues()}
            className="inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>

          {canReport && (
            <button
              type="button"
              onClick={() => setShowForm((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-apc-dark"
            >
              <Plus className="h-4 w-4" />
              Report Issue
            </button>
          )}
        </div>
      </div>

      <Card className="border-apc-primary/10">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Issue Scope
              </p>

              <p className="mt-1 font-semibold text-gray-900">
                {isAdmin
                  ? "Tenant-wide administration"
                  : primaryScope
                    ? "Scoped authority"
                    : "Campaign member"}
              </p>

              <p className="mt-1 text-sm text-gray-500">
                {primaryScope
                  ? `${formatScopeType(primaryScope.scopeType)} · ${primaryScope.scopeId}`
                  : "Issues you reported or are assigned remain visible to you."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total" value={counts.total} />
        <StatCard label="Reported" value={counts.reported} />
        <StatCard label="In Progress" value={counts.inProgress} />
        <StatCard label="Resolved" value={counts.resolved} />
        <StatCard label="Urgent" value={counts.urgent} danger />
      </div>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {showForm && canReport && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">Report Campaign Issue</CardTitle>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                aria-label="Close issue form"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Issue Title
                  </label>
                  <input
                    required
                    value={formTitle}
                    onChange={(event) => setFormTitle(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="Briefly describe the issue"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Issue Type
                  </label>
                  <select
                    value={formType}
                    onChange={(event) => setFormType(event.target.value as CampaignIssueType)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                  >
                    {ISSUE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Priority
                  </label>
                  <select
                    value={formPriority}
                    onChange={(event) =>
                      setFormPriority(event.target.value as CampaignIssuePriority)
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
                    Location
                  </label>
                  <input
                    value={formLocation}
                    onChange={(event) => setFormLocation(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="Community, venue or other location"
                  />
                </div>

                {!isAdmin && primaryScope ? (
                  <div className="md:col-span-2">
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Issue Scope
                    </label>
                    <div className="rounded-lg bg-gray-50 px-3 py-2.5 text-sm text-gray-600">
                      {formatScopeType(primaryScope.scopeType)} · {primaryScope.scopeId}{" "}
                      <span className="text-gray-400">(from your organizational assignment)</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-gray-700">
                        Scope Type
                      </label>
                      <select
                        value={adminScopeType}
                        onChange={(event) =>
                          setAdminScopeType(event.target.value as CampaignScopeType)
                        }
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
                        required
                        value={adminScopeId}
                        onChange={(event) => setAdminScopeId(event.target.value)}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                        placeholder="enugu-state"
                      />
                    </div>
                  </>
                )}

                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium text-gray-700">
                    Description
                  </label>
                  <textarea
                    required
                    rows={4}
                    value={formDescription}
                    onChange={(event) => setFormDescription(event.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    placeholder="Describe what happened, where it happened and what assistance is required."
                  />
                </div>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
                >
                  {saving ? "Submitting..." : "Submit Issue"}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">Issues in My Area</CardTitle>
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
                placeholder="Filter issues..."
                className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-apc-primary"
              />
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading issues...
            </div>
          ) : filteredIssues.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <TriangleAlert className="mx-auto h-8 w-8 text-gray-300" />
              <p className="mt-3 font-semibold text-gray-900">No issues found</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
                There are currently no campaign issues recorded for this view.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredIssues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  canManage={canManage}
                  currentUserId={uid}
                  onAction={handleAction}
                  onAssign={handleAssign}
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
 * ISSUE ROW — workflow actions are permission-aware UI; the RPC is
 * the authoritative enforcement point for every transition.
 * ============================================================
 */

function IssueRow({
  issue,
  canManage,
  currentUserId,
  onAction,
  onAssign,
}: {
  issue: SupabaseIssue;
  canManage: boolean;
  currentUserId: string;
  onAction: (
    issue: SupabaseIssue,
    action: "acknowledge" | "start" | "resolve" | "verify" | "close",
    notes?: string,
  ) => void;
  onAssign: (issue: SupabaseIssue, assignee: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [members, setMembers] = useState<CampaignDirectoryMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

  const isAssignee = issue.assigned_to === currentUserId;

  const actions: Array<{
    label: string;
    action: "acknowledge" | "start" | "resolve" | "verify" | "close";
    style: string;
    needsNotes?: boolean;
  }> = [];

  if (canManage && issue.status === "reported") {
    actions.push({
      label: "Acknowledge",
      action: "acknowledge",
      style: "border-apc-primary/30 text-apc-primary hover:bg-apc-primary/5",
    });
  }
  if (canManage && (issue.status === "reported" || issue.status === "acknowledged")) {
    actions.push({
      label: "Assign",
      action: "acknowledge", // placeholder — rendered as the picker toggle below
      style: "hidden",
    });
  }
  if (isAssignee && (issue.status === "assigned" || issue.status === "in_progress")) {
    actions.push({
      label: issue.status === "assigned" ? "Start Work" : "Resolve",
      action: issue.status === "assigned" ? "start" : "resolve",
      style: "border-apc-primary bg-apc-primary text-white hover:bg-apc-dark",
      needsNotes: issue.status === "in_progress",
    });
  }
  if (canManage && issue.status === "resolved") {
    actions.push({
      label: "Verify",
      action: "verify",
      style: "border-green-200 bg-green-50 text-green-700 hover:bg-green-100",
    });
  }
  if (canManage && (issue.status === "resolved" || issue.status === "verified")) {
    actions.push({
      label: "Close",
      action: "close",
      style: "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100",
    });
  }

  const openPicker = async () => {
    if (picking) {
      setPicking(false);
      return;
    }
    setPicking(true);
    setMembersLoading(true);
    try {
      const rows = await getAssignableMembers(
        getSupabaseClient(),
        issue.scope_type,
        issue.scope_id,
      );
      setMembers(rows);
    } catch {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  };

  return (
    <div className="rounded-xl border bg-white p-4 transition hover:shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-gray-900">{issue.title}</h3>

            <StatusBadge status={issue.status} />

            <PriorityBadge priority={issue.priority} />

            {canManage && (
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                Management View
              </span>
            )}
          </div>

          <p className="mt-2 text-sm leading-6 text-gray-600">{issue.description}</p>

          <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
            <span className="rounded-lg bg-gray-100 px-2.5 py-1">
              {issue.issue_type.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            </span>

            <span className="rounded-lg bg-gray-100 px-2.5 py-1">
              {formatScopeType(issue.scope_type)}: {issue.scope_id}
            </span>

            {issue.location && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2.5 py-1">
                <MapPin className="h-3 w-3" />
                {issue.location}
              </span>
            )}
          </div>

          {issue.resolution_notes && (
            <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Resolution: {issue.resolution_notes}
            </p>
          )}

          {(issue.resolved_by || issue.verified_by) && (
            <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-gray-400">
              <Lock className="h-3 w-3" />
              resolver/verifier recorded server-side
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {canManage &&
            (issue.status === "reported" || issue.status === "acknowledged") && (
              <button
                type="button"
                onClick={() => void openPicker()}
                className="inline-flex items-center gap-1 rounded-md border border-apc-primary/30 px-2 py-1.5 text-xs font-medium text-apc-primary hover:bg-apc-primary/5"
              >
                <UserPlus className="h-3 w-3" />
                {picking ? "Cancel" : "Assign"}
              </button>
            )}

          {actions
            .filter((a) => a.style !== "hidden")
            .map((a) => (
              <div key={a.action} className="flex flex-col items-end gap-1">
                {a.needsNotes && notesOpen ? (
                  <div className="flex w-64 flex-col gap-1">
                    <textarea
                      rows={2}
                      value={resolutionNotes}
                      onChange={(event) => setResolutionNotes(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs outline-none focus:border-apc-primary"
                      placeholder="Resolution notes (optional)..."
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setNotesOpen(false);
                        onAction(issue, a.action, resolutionNotes.trim() || undefined);
                        setResolutionNotes("");
                      }}
                      className="self-end rounded-md bg-apc-primary px-2 py-1 text-xs font-medium text-white hover:bg-apc-dark"
                    >
                      Confirm
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (a.needsNotes) setNotesOpen(true);
                      else onAction(issue, a.action);
                    }}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium ${a.style}`}
                  >
                    {a.label}
                  </button>
                )}
              </div>
            ))}

          {picking && (
            <div className="w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-sm">
              {membersLoading ? (
                <div className="flex items-center gap-2 p-2 text-xs text-gray-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading eligible members...
                </div>
              ) : members.length === 0 ? (
                <p className="p-2 text-xs text-gray-500">
                  No eligible campaign members in this scope.
                </p>
              ) : (
                <select
                  defaultValue=""
                  onChange={(event) => {
                    if (!event.target.value) return;
                    onAssign(issue, event.target.value);
                    setPicking(false);
                  }}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                >
                  <option value="">Select an eligible member…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name}
                    </option>
                  ))}
                </select>
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
 * BADGES / STATS
 * ============================================================
 */

function StatusBadge({ status }: { status: CampaignIssueStatus }) {
  const styles: Record<CampaignIssueStatus, string> = {
    reported: "bg-blue-100 text-blue-700",
    acknowledged: "bg-yellow-100 text-yellow-700",
    assigned: "bg-purple-100 text-purple-700",
    in_progress: "bg-indigo-100 text-indigo-700",
    resolved: "bg-green-100 text-green-700",
    verified: "bg-emerald-100 text-emerald-700",
    closed: "bg-gray-200 text-gray-600",
  };

  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: CampaignIssuePriority }) {
  const styles: Record<CampaignIssuePriority, string> = {
    low: "bg-gray-100 text-gray-600",
    medium: "bg-blue-100 text-blue-700",
    high: "bg-orange-100 text-orange-700",
    urgent: "bg-red-100 text-red-700",
  };

  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[priority]}`}>
      {priority}
    </span>
  );
}

function StatCard({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>
        <p className={`mt-1 text-xl font-bold ${danger ? "text-red-600" : "text-gray-900"}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
