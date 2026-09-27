"use client";

/**
 * POLITICORE — Campaign Field Reports (Phase D cutover: PostgreSQL/Supabase).
 *
 * A client of the Campaign foundation through src/lib/supabase/campaign.ts:
 *   * listing is ONE RLS-scoped query per view — the legacy client-side
 *     getScopedCampaignReportsForAssignment fan-out is gone (D1); the
 *     database decides what this user sees;
 *   * submission flows the submit_campaign_report RPC — tenant, reporter
 *     and initial status are server-resolved (never payload fields);
 *   * review flows review_campaign_report (accept/return) with
 *     reviewer ≠ submitter enforced server-side;
 *   * resubmission of returned reports flows resubmit_campaign_report —
 *     the original submitter only, reset for a fresh review cycle.
 *
 * Evidence: the legacy free-text evidence URL is intentionally dropped —
 * evidence normalizes to media_assets through the Media Service in a
 * later gate (documented in the Phase D report).
 *
 * The route gate is resolveCampaignAccess (database-resolved, fail-closed);
 * the RPCs, view RLS, and policies remain the authoritative boundary.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";

import {
  CampaignError,
  getReports,
  resubmitReport,
  reviewReport,
  submitReport,
  resolveCampaignAccess,
  ensureSupabaseSession,
  getSupabaseClient,
  type CampaignFieldReport as SupabaseReport,
  type CampaignAuthority,
  type CampaignReportStatus,
  type CampaignReportType,
  type CampaignScopeType,
} from "@/lib/supabase";

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

const REPORT_TYPES: Array<{ value: CampaignReportType; label: string }> = [
  { value: "field", label: "Field Report" },
  { value: "activity", label: "Activity Report" },
  { value: "community", label: "Community Report" },
  { value: "mobilization", label: "Mobilization Report" },
  { value: "meeting", label: "Meeting Report" },
  { value: "other", label: "Other" },
];

const STATUS_LABELS: Record<CampaignReportStatus, string> = {
  submitted: "Submitted",
  under_review: "Under Review",
  accepted: "Accepted",
  returned: "Returned",
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/*
 * ============================================================
 * PAGE
 * ============================================================
 */

type Gate = "loading" | "no_session" | "denied" | "ready";

export default function CampaignReportsPage() {
  const { user, profile, assignments: orgAssignments } = useAuth();
  const toast = useToast();

  const [gate, setGate] = useState<Gate>("loading");
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [authority, setAuthority] = useState<CampaignAuthority>("member");

  const [mine, setMine] = useState<SupabaseReport[]>([]);
  const [visible, setVisible] = useState<SupabaseReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resubmitting, setResubmitting] = useState<string | null>(null);
  const [resubmitText, setResubmitText] = useState("");

  const isAdmin = authority === "admin";
  const canSubmit = authority === "admin" || authority === "scoped" || authority === "member";
  const canReview = authority === "admin" || authority === "scoped";

  /** One RLS-scoped query per view; the database decides visibility. */
  const loadReports = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getSupabaseClient();
      const [mineRows, visibleRows] = await Promise.all([
        getReports(supabase, { mine: true }),
        getReports(supabase),
      ]);
      setMine(mineRows);
      setVisible(visibleRows);
    } catch (err) {
      console.error("Failed to load campaign reports:", err);
      setLoadError(campaignErrorMessage(err, "We couldn't load campaign field reports right now."));
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
        const supabase = getSupabaseClient();
        const [mineRows, visibleRows] = await Promise.all([
          getReports(supabase, { mine: true }),
          getReports(supabase),
        ]);
        if (cancelled) return;
        setMine(mineRows);
        setVisible(visibleRows);
      } catch (err) {
        console.error("Failed to load campaign reports:", err);
        if (cancelled) return;
        setLoadError(campaignErrorMessage(err, "We couldn't load campaign field reports right now."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate]);

  // ── form state (ordinary fields only — status is never a form field) ─
  const [formType, setFormType] = useState<CampaignReportType>("field");
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formLocation, setLocation] = useState("");
  const [formParticipants, setFormParticipants] = useState("");
  const [formIssues, setFormIssues] = useState("");
  const [formFeedback, setFormFeedback] = useState("");
  const [formRequests, setFormRequests] = useState("");
  const [formFollowUp, setFormFollowUp] = useState(false);
  const [adminScopeType, setAdminScopeType] = useState<CampaignScopeType>("campaign");
  const [adminScopeId, setAdminScopeId] = useState("enugu-state");

  const primaryScope = useMemo(() => {
    const active = orgAssignments.filter((a) => a.status === "active");
    const first = active[0];
    return first
      ? { scopeType: first.scope_type as CampaignScopeType, scopeId: first.scope_id }
      : null;
  }, [orgAssignments]);

  const counts = useMemo(
    () => ({
      total: mine.length,
      submitted: mine.filter((r) => r.status === "submitted").length,
      review: mine.filter((r) => r.status === "under_review").length,
      accepted: mine.filter((r) => r.status === "accepted").length,
      returned: mine.filter((r) => r.status === "returned").length,
    }),
    [mine],
  );

  const uid = profile?.id ?? user?.id ?? "";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let scopeType: CampaignScopeType;
    let scopeId: string;
    if (isAdmin) {
      scopeId = adminScopeId.trim();
      if (!scopeId) return;
      scopeType = adminScopeType;
    } else {
      if (!primaryScope) {
        toast.error("You need an active campaign organizational assignment before submitting a scoped field report.");
        return;
      }
      scopeType = primaryScope.scopeType;
      scopeId = primaryScope.scopeId;
    }
    if (!formTitle.trim() || !formDescription.trim()) return;

    const supabase = getSupabaseClient();
    setSaving(true);
    try {
      await submitReport(supabase, {
        report_type: formType,
        title: formTitle.trim(),
        description: formDescription.trim(),
        scope_type: scopeType,
        scope_id: scopeId,
        location: formLocation.trim() || undefined,
        participants: formParticipants ? Number(formParticipants) : undefined,
        issues: formIssues.trim() || undefined,
        community_feedback: formFeedback.trim() || undefined,
        requests: formRequests.trim() || undefined,
        follow_up_required: formFollowUp,
      });
      toast.success("Field report submitted for review.");
      setShowForm(false);
      setFormTitle("");
      setFormDescription("");
      setLocation("");
      setFormParticipants("");
      setFormIssues("");
      setFormFeedback("");
      setFormRequests("");
      setFormFollowUp(false);
      await loadReports();
    } catch (err) {
      console.error("Failed to submit report:", err);
      toast.error(campaignErrorMessage(err, "We couldn't submit the report. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const handleReview = async (
    report: SupabaseReport,
    action: "accept" | "return",
  ) => {
    const supabase = getSupabaseClient();
    try {
      await reviewReport(supabase, report.id, action);
      toast.success(action === "accept" ? "Report accepted." : "Report returned for rework.");
      await loadReports();
    } catch (err) {
      console.error("Report review failed:", err);
      toast.error(campaignErrorMessage(err, "The review action was not permitted."));
    }
  };

  const handleResubmit = async (report: SupabaseReport) => {
    if (!resubmitText.trim()) {
      toast.error("Please describe the updated report before resubmitting.");
      return;
    }
    const supabase = getSupabaseClient();
    setResubmitting(report.id);
    try {
      await resubmitReport(supabase, report.id, resubmitText.trim());
      toast.success("Report resubmitted for review.");
      setResubmitting(null);
      setResubmitText("");
      await loadReports();
    } catch (err) {
      console.error("Report resubmission failed:", err);
      toast.error(campaignErrorMessage(err, "The resubmission was not permitted."));
    } finally {
      setResubmitting(null);
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
          <span>Loading campaign reports...</span>
        </div>
      </div>
    );
  }

  if (gate === "no_session" || !user) {
    return (
      <div className="max-w-xl mx-auto py-16 text-center">
        <h1 className="text-xl font-bold text-gray-900">Sign in required</h1>
        <p className="mt-2 text-sm text-gray-500">
          Sign in to view your campaign field reports.
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
            : "You do not have access to Campaign field reports.";
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

          <p className="text-sm font-semibold text-apc-primary">Campaign Council</p>

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
            onClick={() => void loadReports()}
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
                {isAdmin
                  ? "Tenant-wide administration"
                  : primaryScope
                    ? "Scoped coordinator authority"
                    : "Campaign member"}
              </p>

              <p className="mt-1 text-sm text-gray-500">
                {isAdmin
                  ? "Reports across the tenant are visible to you."
                  : primaryScope
                    ? `${formatScopeType(primaryScope.scopeType)} · ${primaryScope.scopeId}`
                    : "Your own reports are visible to you."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <ReportStat label="My Reports" value={counts.total} />
        <ReportStat label="Submitted" value={counts.submitted} />
        <ReportStat label="Under Review" value={counts.review} />
        <ReportStat label="Accepted" value={counts.accepted} />
        <ReportStat label="Returned" value={counts.returned} />
      </div>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {showForm && canSubmit && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-lg">Submit Field Report</CardTitle>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                aria-label="Close report form"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </CardHeader>

          <CardContent>
            {!isAdmin && !primaryScope ? (
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
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Report Type
                    </label>
                    <select
                      value={formType}
                      onChange={(event) => setFormType(event.target.value as CampaignReportType)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                    >
                      {REPORT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Report Title
                    </label>
                    <input
                      required
                      value={formTitle}
                      onChange={(event) => setFormTitle(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="e.g. Ward meeting report"
                    />
                  </div>

                  {!isAdmin && primaryScope ? (
                    <div className="md:col-span-2">
                      <label className="mb-2 block text-sm font-medium text-gray-700">
                        Report Scope
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

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Location
                    </label>
                    <input
                      value={formLocation}
                      onChange={(event) => setLocation(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="Venue / community"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Participants
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={formParticipants}
                      onChange={(event) => setFormParticipants(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="0"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      What happened?
                    </label>
                    <textarea
                      required
                      rows={4}
                      value={formDescription}
                      onChange={(event) => setFormDescription(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="Describe the activity, engagement or field situation."
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Community Feedback
                    </label>
                    <textarea
                      rows={3}
                      value={formFeedback}
                      onChange={(event) => setFormFeedback(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="What did members of the community say?"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Issues Encountered
                    </label>
                    <textarea
                      rows={3}
                      value={formIssues}
                      onChange={(event) => setFormIssues(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="Problems, obstacles or concerns."
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="mb-2 block text-sm font-medium text-gray-700">
                      Requests / Follow-up
                    </label>
                    <textarea
                      rows={3}
                      value={formRequests}
                      onChange={(event) => setFormRequests(event.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-apc-primary"
                      placeholder="What action or support is required?"
                    />
                  </div>

                  <label className="md:col-span-2 flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={formFollowUp}
                      onChange={(event) => setFormFollowUp(event.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    This report requires follow-up action
                  </label>
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
                    {saving ? "Submitting..." : "Submit Report"}
                  </button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <ReportListCard
        title="Reports Within My Area"
        subtitle="Visibility is determined by the database — no client-side scope expansion."
        reports={visible}
        loading={loading}
        emptyTitle="No reports found"
        emptyDescription="There are no reports in your organizational coverage yet."
        currentUserId={uid}
        canReview={canReview}
        resubmitting={resubmitting}
        resubmitText={resubmitText}
        onResubmitText={setResubmitText}
        onReview={handleReview}
        onResubmit={handleResubmit}
      />

      <ReportListCard
        title="My Reports"
        subtitle="Field reports you submitted."
        reports={mine}
        loading={loading}
        emptyTitle="No reports yet"
        emptyDescription="You have not submitted any campaign field reports."
        currentUserId={uid}
        canReview={false}
        resubmitting={resubmitting}
        resubmitText={resubmitText}
        onResubmitText={setResubmitText}
        onReview={handleReview}
        onResubmit={handleResubmit}
      />
    </div>
  );
}

/*
 * ============================================================
 * REPORT LIST CARD
 * ============================================================
 */

function ReportListCard({
  title,
  subtitle,
  reports,
  loading,
  emptyTitle,
  emptyDescription,
  currentUserId,
  canReview,
  resubmitting,
  resubmitText,
  onResubmitText,
  onReview,
  onResubmit,
}: {
  title: string;
  subtitle: string;
  reports: SupabaseReport[];
  loading: boolean;
  emptyTitle: string;
  emptyDescription: string;
  currentUserId: string;
  canReview: boolean;
  resubmitting: string | null;
  resubmitText: string;
  onResubmitText: (value: string) => void;
  onReview: (report: SupabaseReport, action: "accept" | "return") => void;
  onResubmit: (report: SupabaseReport) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <p className="text-sm text-gray-500">{subtitle}</p>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading reports...
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-3 font-semibold text-gray-900">{emptyTitle}</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
              {emptyDescription}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((report) => {
              const isReviewer =
                canReview &&
                (report.status === "submitted" || report.status === "under_review") &&
                report.submitted_by !== currentUserId;
              const isMine = report.submitted_by === currentUserId;
              return (
                <div
                  key={report.id}
                  className="rounded-xl border bg-white p-4 transition hover:shadow-sm"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-gray-900">{report.title}</h3>

                        <StatusBadge status={report.status} />
                      </div>

                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-gray-500">
                        {report.description}
                      </p>

                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500">
                        <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                          {formatScopeType(report.scope_type)}: {report.scope_id}
                        </span>

                        {report.location && (
                          <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                            {report.location}
                          </span>
                        )}

                        {report.participants !== null && (
                          <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                            {report.participants} participants
                          </span>
                        )}

                        {report.follow_up_required && (
                          <span className="rounded-lg bg-orange-100 px-2.5 py-1 font-medium text-orange-700">
                            Follow-up required
                          </span>
                        )}

                        <span className="rounded-lg bg-gray-100 px-2.5 py-1">
                          {formatDate(report.created_at)}
                        </span>
                      </div>

                      {report.review_comment && (
                        <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                          Reviewer: {report.review_comment}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      {isReviewer && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onReview(report, "accept")}
                            className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => onReview(report, "return")}
                            className="inline-flex items-center gap-1 rounded-md border border-orange-200 bg-orange-50 px-2 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100"
                          >
                            <Undo2 className="h-3 w-3" />
                            Return
                          </button>
                        </div>
                      )}

                      {isMine && report.status === "returned" && (
                        <div className="w-full space-y-2">
                          <textarea
                            rows={2}
                            value={resubmitting === report.id ? resubmitText : ""}
                            onChange={(event) => onResubmitText(event.target.value)}
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs outline-none focus:border-apc-primary"
                            placeholder="Describe what changed or add the missing detail..."
                          />
                          <button
                            type="button"
                            disabled={resubmitting === report.id}
                            onClick={() => onResubmit(report)}
                            className="inline-flex items-center gap-1 rounded-md border border-apc-primary bg-apc-primary px-2 py-1.5 text-xs font-medium text-white hover:bg-apc-dark disabled:opacity-50"
                          >
                            <Send className="h-3 w-3" />
                            Resubmit
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * BADGES / STATS
 * ============================================================
 */

function StatusBadge({ status }: { status: CampaignReportStatus }) {
  const styles: Record<CampaignReportStatus, string> = {
    submitted: "bg-blue-100 text-blue-700",
    under_review: "bg-yellow-100 text-yellow-700",
    accepted: "bg-green-100 text-green-700",
    returned: "bg-orange-100 text-orange-700",
  };

  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function ReportStat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>
        <p className="mt-1 text-xl font-bold text-gray-900">{value}</p>
      </CardContent>
    </Card>
  );
}
