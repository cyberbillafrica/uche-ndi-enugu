"use client";

import Link from "next/link";

import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useAuth } from "@/contexts/AuthContext";

import {
  createCampaignFieldReport,
  getMyCampaignReports,
  getScopedCampaignReportsForAssignment,
  getAllCampaignReportsForTenant,
  type CampaignFieldReport,
  type CampaignReportType,
} from "@/lib/firebase/campaignReports";
import { getAllLGAs } from "@/lib/constants";
import { isAdminUser } from "@/lib/permissions";
import { useToast } from "@/components/ui/toast";

import {
  formatScopeType,
  getPrimaryOrganizationalScope,
  formatOrganizationalPosition,
} from "@/lib/organization";

const REPORT_TYPES: {
  value: CampaignReportType;
  label: string;
}[] = [
  {
    value: "activity",
    label: "Campaign Activity",
  },
  {
    value: "community",
    label: "Community Engagement",
  },
  {
    value: "mobilization",
    label: "Mobilization",
  },
  {
    value: "meeting",
    label: "Meeting",
  },
  {
    value: "field",
    label: "General Field Report",
  },
  {
    value: "community",
    label: "Community Feedback",
  },
  {
    value: "other",
    label: "Other",
  },
];

export default function CampaignReportsPage() {
  const { user, profile, assignments, accessLoading, hasPermission } =
    useAuth();
  const toast = useToast();

  const [myReports, setMyReports] = useState<CampaignFieldReport[]>([]);

  const [scopedReports, setScopedReports] = useState<CampaignFieldReport[]>([]);

  const [loading, setLoading] = useState(true);
  const [scopeLoading, setScopeLoading] = useState(false);


  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [formError, setFormError] = useState("");

  const [form, setForm] = useState({
    report_type: "field" as CampaignReportType,
    title: "",
    description: "",
    location: "",
    participants: "",
    issues: "",
    community_feedback: "",
    requests: "",
    follow_up_required: false,
    evidence_url: "",
  });

  /*
   * ============================================================
   * ORGANIZATIONAL SCOPE
   * ============================================================
   */

  const primaryScope = getPrimaryOrganizationalScope(assignments);

  const primaryAssignment = primaryScope.assignment;

  /*
   * ============================================================
   * PERMISSIONS
   * ============================================================
   */

  const canSubmit = hasPermission("submit_field_report");

  const canReview = hasPermission("review_field_report");

  /*
   * ============================================================
   * LOAD
   * ============================================================
   */

  async function loadReports() {
    if (!user?.uid || !profile) {
      setMyReports([]);
      setScopedReports([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);

      const mine = await getMyCampaignReports(user.uid);
      setMyReports(mine);

      const isAdmin = isAdminUser(profile);

      if (isAdmin && profile.tenant_id) {
        setScopeLoading(true);
        try {
          const allReports = await getAllCampaignReportsForTenant(profile.tenant_id);
          setScopedReports(allReports);
        } finally {
          setScopeLoading(false);
        }
      } else if (canReview && primaryAssignment && profile.tenant_id) {
        setScopeLoading(true);
        try {
          const lgas = await getAllLGAs();
          const scoped = await getScopedCampaignReportsForAssignment(
            primaryAssignment,
            lgas,
          );
          setScopedReports(scoped);
        } finally {
          setScopeLoading(false);
        }
      } else {
        setScopedReports([]);
      }
    } catch (err) {
      console.error("Failed to load campaign reports:", err);
      toast.error("We couldn't load your campaign field reports. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (accessLoading) {
      return;
    }

    loadReports();
  }, [
    accessLoading,
    user?.uid,
    profile?.tenant_id,
    primaryAssignment?.id,
    canReview,
  ]);

  /*
   * ============================================================
   * COUNTS
   * ============================================================
   */

  const counts = useMemo(
    () => ({
      total: myReports.length,

      submitted: myReports.filter((report) => report.status === "submitted")
        .length,

      review: myReports.filter((report) => report.status === "under_review")
        .length,

      accepted: myReports.filter((report) => report.status === "accepted")
        .length,

      returned: myReports.filter((report) => report.status === "returned")
        .length,
    }),
    [myReports],
  );

  /*
   * ============================================================
   * SUBMIT REPORT
   * ============================================================
   */

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!user?.uid || !profile?.tenant_id) {
      return;
    }

    if (!primaryAssignment) {
      setFormError(
        "You need an active campaign organizational assignment before submitting a scoped field report.",
      );

      return;
    }

    if (!form.title.trim()) {
      setFormError("Please enter a report title.");
      return;
    }

    if (!form.description.trim()) {
      setFormError("Please describe what happened in the field.");

      return;
    }

    try {
      setSubmitting(true);
      setFormError("");

      await createCampaignFieldReport({
        tenant_id: profile.tenant_id,

        submitted_by: user.uid,

        report_type: form.report_type,

        title: form.title.trim(),

        description: form.description.trim(),

        scope_type: primaryAssignment.scope_type,

        scope_id: primaryAssignment.scope_id,

        location: form.location.trim() || null,

        participants: form.participants ? Number(form.participants) : null,

        issues: form.issues.trim() || null,

        community_feedback: form.community_feedback.trim() || null,

        requests: form.requests.trim() || null,

        follow_up_required: form.follow_up_required,

        evidence_url: form.evidence_url.trim() || null,
      });

      setForm({
        report_type: "field",
        title: "",
        description: "",
        location: "",
        participants: "",
        issues: "",
        community_feedback: "",
        requests: "",
        follow_up_required: false,
        evidence_url: "",
      });

      setShowForm(false);

      await loadReports();
    } catch (err) {
      console.error("Failed to submit campaign report:", err);

      setFormError("Unable to submit the report. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  /*
   * ============================================================
   * GUARDS
   * ============================================================
   */

  if (!profile) {
    return null;
  }

  if (accessLoading || loading) {
    return <ReportsLoading />;
  }

  /*
   * ============================================================
   * PAGE
   * ============================================================
   */

  return (
    <div className="space-y-6 pb-10">
      {/* ======================================================
          HEADER
          ====================================================== */}

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
            Field Reports
          </h1>

          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
            Report what is happening on the ground and keep your campaign
            organization informed.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={loadReports}
            className="inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>

          {canSubmit && (
            <button
              type="button"
              onClick={() => setShowForm((value) => !value)}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-apc-dark"
            >
              <Plus className="h-4 w-4" />
              Submit Report
            </button>
          )}
        </div>
      </div>

      {/* ======================================================
          SCOPE
          ====================================================== */}

      <Card className="border-apc-primary/10">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Report Scope
              </p>

              <p className="mt-1 font-semibold text-gray-900">
                {primaryAssignment
                  ? formatOrganizationalPosition(primaryAssignment.position)
                  : "Campaign Member"}
              </p>

              <p className="mt-1 text-sm text-gray-500">
                {primaryAssignment
                  ? `${formatScopeType(
                      primaryAssignment.scope_type,
                    )} · ${primaryAssignment.scope_id}`
                  : "No organizational scope assigned"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          SUMMARY
          ====================================================== */}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <ReportStat label="My Reports" value={counts.total} />

        <ReportStat label="Submitted" value={counts.submitted} />

        <ReportStat label="Under Review" value={counts.review} />

        <ReportStat label="Accepted" value={counts.accepted} />

        <ReportStat label="Returned" value={counts.returned} />
      </div>

      {/* ======================================================
          FORM
          ====================================================== */}

      {showForm && canSubmit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Submit Field Report</CardTitle>

            <p className="text-sm text-gray-500">
              This report will be associated with your current organizational
              scope.
            </p>
          </CardHeader>

          <CardContent>
            {!primaryAssignment ? (
              <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
                <div className="flex gap-3">
                  <TriangleAlert className="h-5 w-5 shrink-0 text-yellow-600" />

                  <div>
                    <p className="font-semibold text-yellow-900">
                      No organizational assignment
                    </p>

                    <p className="mt-1 text-sm text-yellow-800">
                      An administrator must assign you to a campaign
                      organizational area before you can submit a scoped report.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="grid gap-5 md:grid-cols-2">
                  <FormField label="Report Type">
                    <select
                      value={form.report_type}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          report_type: event.target.value as CampaignReportType,
                        }))
                      }
                      className="w-full rounded-lg border px-4 py-3"
                    >
                      {REPORT_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </FormField>

                  <FormField label="Report Title">
                    <input
                      required
                      value={form.title}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          title: event.target.value,
                        }))
                      }
                      className="w-full rounded-lg border px-4 py-3"
                      placeholder="e.g. Ward meeting report"
                    />
                  </FormField>
                </div>

                <FormField label="What happened?">
                  <textarea
                    required
                    rows={5}
                    value={form.description}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        description: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="Describe the activity, engagement or field situation."
                  />
                </FormField>

                <div className="grid gap-5 md:grid-cols-2">
                  <FormField label="Location">
                    <input
                      value={form.location}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          location: event.target.value,
                        }))
                      }
                      className="w-full rounded-lg border px-4 py-3"
                      placeholder="Venue / community"
                    />
                  </FormField>

                  <FormField label="Participants">
                    <input
                      type="number"
                      min="0"
                      value={form.participants}
                      onChange={(event) =>
                        setForm((previous) => ({
                          ...previous,
                          participants: event.target.value,
                        }))
                      }
                      className="w-full rounded-lg border px-4 py-3"
                      placeholder="0"
                    />
                  </FormField>
                </div>

                <FormField label="Community Feedback">
                  <textarea
                    rows={3}
                    value={form.community_feedback}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        community_feedback: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="What did members of the community say?"
                  />
                </FormField>

                <FormField label="Issues Encountered">
                  <textarea
                    rows={3}
                    value={form.issues}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        issues: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="Problems, obstacles or concerns."
                  />
                </FormField>

                <FormField label="Requests / Follow-up">
                  <textarea
                    rows={3}
                    value={form.requests}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        requests: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="What action or support is required?"
                  />
                </FormField>

                <FormField label="Supporting Evidence URL">
                  <input
                    type="url"
                    value={form.evidence_url}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        evidence_url: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="https://..."
                  />
                </FormField>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={form.follow_up_required}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        follow_up_required: event.target.checked,
                      }))
                    }
                    className="h-4 w-4"
                  />

                  <span className="text-sm font-medium text-gray-700">
                    Follow-up is required
                  </span>
                </label>

                {formError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {formError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-5 py-3 font-semibold text-white hover:bg-apc-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}

                  {submitting ? "Submitting..." : "Submit Field Report"}
                </button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* ======================================================
          MY REPORTS
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">My Reports</CardTitle>

          <p className="text-sm text-gray-500">
            Reports you have submitted from your campaign organizational area.
          </p>
        </CardHeader>

        <CardContent>
          {myReports.length === 0 ? (
            <EmptyReports
              title="No reports submitted"
              description="Your submitted field reports will appear here."
            />
          ) : (
            <div className="space-y-3">
              {myReports.map((report) => (
                <ReportRow key={report.id} report={report} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ======================================================
          SCOPED REPORTS
          ====================================================== */}

      {canReview && primaryAssignment && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">
                  Reports Within My Area
                </CardTitle>

                <p className="text-sm text-gray-500">
                  Field reports submitted within your organizational authority.
                </p>
              </div>

              {scopeLoading && (
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              )}
            </div>
          </CardHeader>

          <CardContent>
            {scopedReports.length === 0 ? (
              <EmptyReports
                title="No area reports"
                description="There are currently no field reports recorded within this scope."
              />
            ) : (
              <div className="space-y-3">
                {scopedReports.map((report) => (
                  <ReportRow key={report.id} report={report} showSubmitter />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/*
 * ============================================================
 * STAT
 * ============================================================
 */

function ReportStat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>

        <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * REPORT ROW
 * ============================================================
 */

function ReportRow({
  report,
  showSubmitter = false,
}: {
  report: CampaignFieldReport;
  showSubmitter?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="h-4 w-4 text-apc-primary" />

            <h3 className="font-semibold text-gray-900">{report.title}</h3>

            <ReportStatus status={report.status} />
          </div>

          <p className="mt-2 line-clamp-2 text-sm text-gray-500">
            {report.description}
          </p>

          <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
            <span className="rounded-lg bg-gray-100 px-2.5 py-1">
              {formatScopeType(report.scope_type as never)}: {report.scope_id}
            </span>

            {report.location && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2.5 py-1">
                <MapPin className="h-3 w-3" />
                {report.location}
              </span>
            )}

            {showSubmitter && (
              <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                Submitted by: {report.submitted_by}
              </span>
            )}
          </div>
        </div>

        <span className="shrink-0 text-xs font-medium text-gray-400">
          {formatReportType(report.report_type)}
        </span>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * STATUS
 * ============================================================
 */

function ReportStatus({ status }: { status: CampaignFieldReport["status"] }) {
  const styles = {
    submitted: "bg-blue-100 text-blue-700",
    under_review: "bg-yellow-100 text-yellow-700",
    accepted: "bg-green-100 text-green-700",
    returned: "bg-red-100 text-red-700",
  };

  const labels = {
    submitted: "Submitted",
    under_review: "Under Review",
    accepted: "Accepted",
    returned: "Returned",
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

/*
 * ============================================================
 * TYPE LABEL
 * ============================================================
 */

function formatReportType(type: CampaignReportType) {
  return type
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/*
 * ============================================================
 * FORM FIELD
 * ============================================================
 */

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700">
        {label}
      </label>

      {children}
    </div>
  );
}

/*
 * ============================================================
 * EMPTY
 * ============================================================
 */

function EmptyReports({
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
 * LOADING
 * ============================================================
 */

function ReportsLoading() {
  return (
    <div className="space-y-6 pb-10">
      <div className="h-24 animate-pulse rounded-2xl bg-gray-100" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="h-20 animate-pulse rounded-xl bg-gray-100"
          />
        ))}
      </div>

      <div className="h-72 animate-pulse rounded-xl bg-gray-100" />
    </div>
  );
}
