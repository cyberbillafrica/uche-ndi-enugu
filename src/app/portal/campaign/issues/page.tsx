"use client";

import Link from "next/link";

import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useAuth } from "@/contexts/AuthContext";

import {
  createCampaignIssue,
  getScopedCampaignIssues,
  getAllCampaignIssues,
  type CampaignIssue,
  type CampaignIssuePriority,
  type CampaignIssueType,
} from "@/lib/firebase/campaignIssues";
import { isAdminUser } from "@/lib/permissions";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";

import {
  formatScopeType,
  getPrimaryOrganizationalScope,
} from "@/lib/organization";

import type { OrganizationalAssignment } from "@/types";

export default function CampaignIssuesPage() {
  const {
    profile,
    assignments: authAssignments,
    hasPermission,
    accessLoading,
  } = useAuth();
  const toast = useToast();

  const assignments: OrganizationalAssignment[] = Array.isArray(authAssignments)
    ? authAssignments
    : [];

  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "active",
  );

  const primaryScope = getPrimaryOrganizationalScope(activeAssignments);

  const assignment = primaryScope.assignment;

  const canReport = hasPermission("report_issue");

  const canManage = hasPermission("manage_issue");

  const [issues, setIssues] = useState<CampaignIssue[]>([]);

  const [loading, setLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);

  const [showForm, setShowForm] = useState(false);

  /*
   * ----------------------------------------------------------
   * LOAD
   * ----------------------------------------------------------
   */

  const isAdmin = isAdminUser(profile);

  const loadIssues = async () => {
    if (!profile) return;

    try {
      if (isAdmin) {
        const data = await getAllCampaignIssues();
        setIssues(data);
      } else if (assignment) {
        const data = await getScopedCampaignIssues(assignment);
        setIssues(data);
      } else {
        setIssues([]);
      }
    } catch (err) {
      console.error("Failed to load campaign issues:", err);
      toast.error("We couldn't load the issues for your organizational scope. Please try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (accessLoading) return;

    loadIssues();
  }, [accessLoading, assignment?.id, isAdmin]);

  /*
   * ----------------------------------------------------------
   * COUNTS
   * ----------------------------------------------------------
   */

  const counts = useMemo(() => {
    return {
      total: issues.length,

      reported: issues.filter((issue) => issue.status === "reported").length,

      inProgress: issues.filter((issue) => issue.status === "in_progress")
        .length,

      resolved: issues.filter(
        (issue) => issue.status === "resolved" || issue.status === "closed",
      ).length,

      urgent: issues.filter(
        (issue) =>
          issue.priority === "urgent" &&
          issue.status !== "resolved" &&
          issue.status !== "closed",
      ).length,
    };
  }, [issues]);

  if (!profile) {
    return null;
  }

  /*
   * ----------------------------------------------------------
   * AUTH LOADING
   * ----------------------------------------------------------
   */

  if (accessLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-apc-primary" />

        <p className="text-sm text-gray-500">Loading your campaign access...</p>
      </div>
    );
  }

  /*
   * ----------------------------------------------------------
   * NO ASSIGNMENT
   * ----------------------------------------------------------
   */

  if (!assignment && !isAdmin) {
    return (
      <div className="space-y-6 pb-8">
        <BackLink />

        <Card>
          <CardContent className="p-8 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-yellow-500" />

            <h2 className="mt-4 text-lg font-semibold">
              No organizational scope assigned
            </h2>

            <p className="mx-auto mt-2 max-w-lg text-sm text-gray-500">
              An administrator must assign you to a campaign organizational
              position before scoped campaign issues can be displayed.
            </p>
          </CardContent>
        </Card>
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
      <BackLink />

      {/* HEADER */}

      <section className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-apc-primary">
              Campaign Operations
            </p>

            <h1 className="mt-1 text-2xl font-bold text-gray-900">
              Scoped Issues
            </h1>

            <p className="mt-2 text-sm text-gray-500">
              Report and monitor operational issues within your assigned
              campaign area.
            </p>
          </div>

          <div className="rounded-xl bg-apc-primary/5 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              Your Scope
            </p>

            <p className="mt-1 font-semibold text-gray-900">
              {isAdmin
                ? "Global Campaign Scope"
                : formatScopeType(assignment?.scope_type || null)}
            </p>

            <p className="text-sm text-gray-500">
              {isAdmin ? "State-Wide" : assignment?.scope_id}
            </p>
          </div>
        </div>
      </section>

      {/* SUMMARY */}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Total" value={counts.total} />

        <StatCard label="Reported" value={counts.reported} />

        <StatCard label="In Progress" value={counts.inProgress} />

        <StatCard label="Resolved" value={counts.resolved} />

        <StatCard label="Urgent" value={counts.urgent} danger />
      </div>

      {/* ACTIONS */}

      <div className="flex flex-wrap gap-3">
        {canReport && (
          <button
            type="button"
            onClick={() => setShowForm((value) => !value)}
            className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            <Plus className="h-4 w-4" />

            {showForm ? "Close Form" : "Report Issue"}
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            loadIssues();
          }}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {/* REPORT FORM */}

      {showForm && canReport && (
        <IssueForm
          profileId={profile.id ?? ""}
          assignment={
            assignment || {
              id: "admin-global",
              tenant_id: profile.tenant_id || CURRENT_TENANT_ID,
              user_id: profile.id || "",
              position: "state_coordinator",
              scope_type: "campaign",
              scope_id: "enugu-state",
              status: "active",
              assigned_by: "system",
            }
          }
          onCreated={async () => {
            setShowForm(false);
            await loadIssues();
          }}
        />
      )}

      {/* ISSUES */}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Issues in My Area</CardTitle>

          <p className="text-sm text-gray-500">
            Issues reported against your current organizational scope.
          </p>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12 gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-apc-primary" />

              <span className="text-sm text-gray-500">Loading issues...</span>
            </div>
          ) : issues.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <TriangleAlert className="mx-auto h-8 w-8 text-gray-300" />

              <p className="mt-3 font-semibold text-gray-900">
                No issues reported
              </p>

              <p className="mt-1 text-sm text-gray-500">
                There are currently no campaign issues recorded for this
                organizational area.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} canManage={canManage} />
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
 * ISSUE FORM
 * ============================================================
 */

function IssueForm({
  profileId,
  assignment,
  onCreated,
}: {
  profileId: string;
  assignment: OrganizationalAssignment;
  onCreated: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");

  const [description, setDescription] = useState("");

  const [issueType, setIssueType] =
    useState<CampaignIssueType>("community_concern");

  const [priority, setPriority] = useState<CampaignIssuePriority>("medium");

  const [location, setLocation] = useState("");

  const [evidenceUrl, setEvidenceUrl] = useState("");

  const [saving, setSaving] = useState(false);

  const toast = useToast();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!title.trim() || !description.trim()) {
      toast.warning("Please provide a title and a description for the issue.");
      return;
    }

    try {
      setSaving(true);

      await createCampaignIssue({
        title,
        description,
        issue_type: issueType,
        priority,

        scope_type: assignment.scope_type,
        scope_id: assignment.scope_id,

        reported_by: profileId,

        location,
        evidence_url: evidenceUrl,

        tenant_id: undefined,
      });

      setTitle("");
      setDescription("");
      setLocation("");
      setEvidenceUrl("");

      await onCreated();
    } catch (err) {
      console.error("Failed to create issue:", err);

      toast.error(getErrorMessage(err, "We couldn't submit this issue. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-apc-primary/20">
      <CardHeader>
        <CardTitle className="text-lg">Report Campaign Issue</CardTitle>

        <p className="text-sm text-gray-500">
          The issue will be recorded against your current organizational scope.
        </p>
      </CardHeader>

      <CardContent>
        <form onSubmit={submit} className="space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <Field
              label="Issue title"
              value={title}
              onChange={setTitle}
              placeholder="Briefly describe the issue"
            />

            <div>
              <label className="text-sm font-medium text-gray-700">
                Issue type
              </label>

              <select
                value={issueType}
                onChange={(event) =>
                  setIssueType(event.target.value as CampaignIssueType)
                }
                className="mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm"
              >
                <option value="logistics">Logistics</option>
                <option value="campaign_activity">Campaign Activity</option>
                <option value="community_concern">Community Concern</option>
                <option value="volunteer">Volunteer</option>
                <option value="communication">Communication</option>
                <option value="security">Security</option>
                <option value="infrastructure">
                  Infrastructure / Community
                </option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">
              Description
            </label>

            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              placeholder="Describe what happened, where it happened and what assistance is required."
              className="mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm"
            />
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-gray-700">
                Priority
              </label>

              <select
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as CampaignIssuePriority)
                }
                className="mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>

            <Field
              label="Location"
              value={location}
              onChange={setLocation}
              placeholder="Community, venue or other location"
            />
          </div>

          <Field
            label="Evidence URL (optional)"
            value={evidenceUrl}
            onChange={setEvidenceUrl}
            placeholder="https://..."
          />

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit Issue
            </button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * ISSUE ROW
 * ============================================================
 */

function IssueRow({
  issue,
  canManage,
}: {
  issue: CampaignIssue;
  canManage: boolean;
}) {
  return (
    <div className="rounded-xl border p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-gray-900">{issue.title}</h3>

            <StatusBadge status={issue.status} />

            <PriorityBadge priority={issue.priority} />
          </div>

          <p className="mt-2 text-sm leading-6 text-gray-600">
            {issue.description}
          </p>

          <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-500">
            <span className="rounded-full bg-gray-100 px-2.5 py-1">
              {formatIssueType(issue.issue_type)}
            </span>

            {issue.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" />
                {issue.location}
              </span>
            )}

            <span>
              {formatScopeType(issue.scope_type)}: {issue.scope_id}
            </span>
          </div>
        </div>

        {canManage && (
          <span className="shrink-0 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700">
            Management View
          </span>
        )}
      </div>
    </div>
  );
}

/*
 * ============================================================
 * SMALL COMPONENTS
 * ============================================================
 */

function Field({
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
      <label className="text-sm font-medium text-gray-700">{label}</label>

      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-lg border px-3 py-2.5 text-sm"
      />
    </div>
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
      <CardContent className="p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>

        <p
          className={`mt-2 text-2xl font-bold ${
            danger ? "text-red-600" : "text-gray-900"
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: CampaignIssue["status"] }) {
  const labels: Record<CampaignIssue["status"], string> = {
    reported: "Reported",
    acknowledged: "Acknowledged",
    assigned: "Assigned",
    in_progress: "In Progress",
    resolved: "Resolved",
    closed: "Closed",
  };

  return (
    <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
      {labels[status]}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: CampaignIssuePriority }) {
  const labels: Record<CampaignIssuePriority, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
  };

  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
        priority === "urgent"
          ? "bg-red-100 text-red-700"
          : priority === "high"
            ? "bg-orange-100 text-orange-700"
            : "bg-gray-100 text-gray-600"
      }`}
    >
      {labels[priority]}
    </span>
  );
}

function formatIssueType(type: CampaignIssueType) {
  return type
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function BackLink() {
  return (
    <Link
      href="/portal/dashboard"
      className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-apc-primary"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Dashboard
    </Link>
  );
}
