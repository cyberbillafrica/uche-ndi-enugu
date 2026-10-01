"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  ExternalLink,
  History,
  Loader2,
  Send,
  Star,
  X,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { HelpLink } from "@/components/help/HelpLink";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveSocialAccess,
  SocialForceError,
  getSocialTasks,
  getMySubmissions,
  getMySubmissionsForTask,
  submitSocialTask,
  type SocialTask,
  type SocialTaskSubmission,
} from "@/lib/supabase";

// --------------------------------------------------
// Page
// --------------------------------------------------

export default function TasksPage() {
  const { profile, loading: authLoading } = useAuth();

  const [tasks, setTasks] = useState<SocialTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [denied, setDenied] = useState<string | null>(null);

  const [mySubmissions, setMySubmissions] = useState<SocialTaskSubmission[]>([]);
  const [submittingTaskId, setSubmittingTaskId] = useState<string | null>(null);
  const [proofUrls, setProofUrls] = useState<Record<string, string>>({});
  const [memberError, setMemberError] = useState("");

  // Submission-history panel state (§14).
  const [showHistory, setShowHistory] = useState(false);

  // RLS already restricts member visibility to active, unexpired tasks;
  // indexing the caller's own submissions by task is presentation only.
  const submissionsByTask = new Map(
    mySubmissions.map((s) => [s.task_id, s]),
  );

  const getSubmissionForTask = (taskId: string) =>
    submissionsByTask.get(taskId);

  const loadTasks = async () => {
    setLoadingTasks(true);
    setLoadError("");

    try {
      const data = await getSocialTasks(getSupabaseClient());
      setTasks(data);
    } catch (error) {
      console.error("Failed to load tasks:", error);
      setLoadError(
        error instanceof SocialForceError
          ? error.message
          : "Unable to load tasks right now.",
      );
    } finally {
      setLoadingTasks(false);
    }
  };

  const loadMySubmissions = async () => {
    try {
      const data = await getMySubmissions(getSupabaseClient());
      setMySubmissions(data);
    } catch (error) {
      console.error("Failed to load your submissions:", error);
      setMemberError("Unable to load your task history right now.");
    }
  };

  useEffect(() => {
    if (authLoading || !profile) return;
    let cancelled = false;

    async function bootstrap() {
      const bridge = await ensureSupabaseSession();
      if (cancelled) return;
      if (!bridge.sessionReady) {
        setDenied("Your session has expired. Please sign in again.");
        setLoadingTasks(false);
        return;
      }
      const supabase = getSupabaseClient();

      const access = await resolveSocialAccess(supabase);
      if (cancelled) return;
      if (!access.allowed) {
        setDenied(
          access.reason === "module_disabled"
            ? "The Social Force module is not enabled for your organization."
            : access.reason === "not_a_member"
              ? "You are not a member of an organization with Social Force access."
              : "You do not have permission to view Social Tasks.",
        );
        setLoadingTasks(false);
        return;
      }

      await loadTasks();
      await loadMySubmissions();
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile]);

  const handleSubmitCompletion = async (task: SocialTask) => {
    setMemberError("");

    const existingSubmission = getSubmissionForTask(task.id);

    if (existingSubmission && existingSubmission.status === "verified") {
      // Verified submissions are immutable (Phase A guard) — never offer
      // a resubmission path against a verified row (§18).
      setMemberError("This task has already been verified.");
      return;
    }

    const needsProof = task.proof_required;
    const proofUrl = proofUrls[task.id]?.trim() ?? "";

    if (needsProof && !proofUrl) {
      setMemberError(
        task.action === "make_post"
          ? "Please provide the direct URL to your post."
          : "Please provide the direct URL to your shared post.",
      );
      return;
    }

    setSubmittingTaskId(task.id);

    try {
      // Phase A upsert contract: a pending submission's proof is
      // overwritten in place; a verified one is refused server-side.
      await submitSocialTask(getSupabaseClient(), task.id, needsProof ? proofUrl : undefined);

      await loadMySubmissions();

      setProofUrls((previous) => {
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
    } catch (error: unknown) {
      console.error("Failed to submit task:", error);
      setMemberError(
        error instanceof SocialForceError
          ? error.message
          : "Unable to submit task. Please try again.",
      );
    } finally {
      setSubmittingTaskId(null);
    }
  };

  const handleOpenResubmit = async (task: SocialTask) => {
    // Refresh the caller's row for this task before letting them edit
    // the proof (§8 pending-only resubmission).
    setMemberError("");
    try {
      const rows = await getMySubmissionsForTask(getSupabaseClient(), task.id);
      const mine = rows[0] ?? null;
      if (mine) {
        setMySubmissions((prev) => [
          ...prev.filter((s) => s.task_id !== task.id),
          mine,
        ]);
        setProofUrls((previous) => ({
          ...previous,
          [task.id]: mine.proof_url ?? "",
        }));
      }
    } catch (error) {
      console.error("Failed to load your submission:", error);
      setMemberError("Unable to load your submission right now.");
    }
  };

  if (authLoading || !profile) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading tasks…
      </div>
    );
  }

  if (denied) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Social Tasks</h1>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {denied}
        </div>
      </div>
    );
  }

  const pendingCount = mySubmissions.filter((s) => s.status === "pending").length;
  const verifiedCount = mySubmissions.filter((s) => s.status === "verified").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Social Tasks</h1>
            <HelpLink article="social-tasks" label="How tasks work" />
          </div>
          <p className="mt-1 text-gray-600">
            Complete active social campaign tasks, submit proof where required, and earn points for your profile.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/portal/points"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            <Star className="h-4 w-4" />
            My Points
          </Link>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            <History className="h-4 w-4" />
            My Submissions
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
              {pendingCount} pending · {verifiedCount} verified
            </span>
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {memberError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {memberError}
        </div>
      )}

      {/* SUBMISSION HISTORY (§14) — one RLS-scoped query, no per-task fanout. */}
      {showHistory && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>My Submission History</CardTitle>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="rounded p-1 hover:bg-gray-100"
                aria-label="Close submission history"
              >
                <X className="h-4 w-4 text-gray-400" />
              </button>
            </div>
          </CardHeader>
          <CardContent>
            {mySubmissions.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500">
                You have not submitted any tasks yet.
              </p>
            ) : (
              <div className="divide-y">
                {mySubmissions.map((sub) => {
                  const task = tasks.find((t) => t.id === sub.task_id);
                  return (
                    <div key={sub.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">
                          {task?.title ?? "Task"}
                        </p>
                        <p className="text-xs text-gray-500">
                          {task
                            ? `${task.platform === "x" ? "X" : task.platform} · ${task.action === "make_post" ? "Make Post" : task.action}`
                            : ""}{" "}
                          · Submitted{" "}
                          {new Date(sub.submitted_at).toLocaleDateString("en-NG", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                        {sub.proof_url && (
                          <a
                            href={sub.proof_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-primary hover:underline"
                          >
                            View submitted proof
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-bold capitalize ${
                            sub.status === "verified"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {sub.status}
                        </span>
                        {task && sub.status === "pending" && (
                          <button
                            type="button"
                            onClick={() => handleOpenResubmit(task)}
                            className="rounded-lg border px-3 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50"
                          >
                            Update proof
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Available Tasks</CardTitle>
            <span className="text-sm text-gray-500">
              {tasks.length} available
            </span>
          </div>
        </CardHeader>

        <CardContent>
          {loadingTasks ? (
            <div className="flex items-center justify-center gap-2 py-12 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading tasks…
            </div>
          ) : tasks.length === 0 ? (
            <div className="py-12 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-gray-300" />
              <p className="mt-3 text-gray-500">
                No active social tasks available right now.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {tasks.map((task) => {
                const existingSubmission = getSubmissionForTask(task.id);
                const isSubmitting = submittingTaskId === task.id;
                const needsProof = task.proof_required;
                const isVerified = existingSubmission?.status === "verified";

                return (
                  <div
                    key={task.id}
                    className="overflow-hidden rounded-xl border bg-white"
                  >
                    <div className="p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-brand-surface px-3 py-1 text-xs font-semibold text-brand-primary capitalize">
                              {task.platform === "x" ? "X" : task.platform}
                            </span>

                            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700 capitalize">
                              {task.action === "make_post" ? "Make Post" : task.action}
                            </span>

                            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                              +{task.points ?? 0} points
                            </span>
                          </div>

                          <h3 className="mt-3 font-semibold text-gray-900">
                            {task.title}
                          </h3>

                          {task.description && (
                            <p className="mt-1 text-sm text-gray-500">
                              {task.description}
                            </p>
                          )}

                          <p className="mt-1 text-sm text-gray-500">
                            {task.expiration_date
                              ? `Deadline: ${new Date(task.expiration_date).toLocaleDateString("en-NG", { month: "short", day: "numeric", year: "numeric" })}`
                              : "No deadline"}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          {task.target_url && (
                            <a
                              href={task.target_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-2 rounded-lg border border-brand-primary px-3 py-2 text-sm font-medium text-brand-primary transition-colors hover:bg-brand-surface"
                            >
                              Open Post
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="mt-5 border-t pt-5">
                        {existingSubmission ? (
                          <div
                            className={
                              isVerified
                                ? "flex flex-col gap-3 rounded-lg bg-green-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                                : "flex flex-col gap-3 rounded-lg bg-yellow-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                            }
                          >
                            <div className="flex items-center gap-3">
                              {isVerified ? (
                                <CheckCircle2 className="h-5 w-5 text-green-600" />
                              ) : (
                                <Loader2 className="h-5 w-5 text-yellow-600" />
                              )}

                              <div>
                                <p
                                  className={
                                    isVerified
                                      ? "font-medium text-green-800"
                                      : "font-medium text-yellow-800"
                                  }
                                >
                                  {isVerified
                                    ? "Task verified"
                                    : "Submitted for review"}
                                </p>

                                <p className="text-xs text-gray-500">
                                  Submitted{" "}
                                  {new Date(
                                    existingSubmission.submitted_at,
                                  ).toLocaleDateString("en-NG", {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                  })}
                                </p>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-3">
                              {existingSubmission.proof_url && (
                                <a
                                  href={existingSubmission.proof_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-sm font-medium text-brand-primary hover:underline"
                                >
                                  View submitted proof
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}

                              {!isVerified && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenResubmit(task)}
                                  className="inline-flex items-center gap-2 rounded-lg border border-brand-primary px-3 py-2 text-sm font-medium text-brand-primary transition-colors hover:bg-brand-surface"
                                >
                                  Update proof
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            {needsProof && (
                              <div>
                                <label className="mb-2 block text-sm font-medium text-gray-700">
                                  {task.action === "make_post"
                                    ? "Your Post URL *"
                                    : "Shared Post URL *"}
                                </label>

                                <input
                                  type="url"
                                  value={proofUrls[task.id] ?? ""}
                                  onChange={(e) =>
                                    setProofUrls((previous) => ({
                                      ...previous,
                                      [task.id]: e.target.value,
                                    }))
                                  }
                                  placeholder={
                                    task.action === "make_post"
                                      ? "https://facebook.com/your-post..."
                                      : "https://facebook.com/..."
                                  }
                                  className="w-full rounded-lg border px-4 py-3 text-sm"
                                />

                                <p className="mt-1 text-xs text-gray-500">
                                  Submit the direct URL to the post so an
                                  admin can verify it.
                                </p>
                              </div>
                            )}

                            {!needsProof && (
                              <p className="text-sm text-gray-600">
                                Open the original post above, complete the{" "}
                                <span className="font-semibold">
                                  {task.action === "make_post" ? "Make Post" : task.action}
                                </span>{" "}
                                action, then mark the task completed. No proof
                                URL is required.
                              </p>
                            )}

                            <button
                              type="button"
                              onClick={() => handleSubmitCompletion(task)}
                              disabled={isSubmitting}
                              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isSubmitting ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Send className="h-4 w-4" />
                              )}

                              {isSubmitting
                                ? "Submitting..."
                                : "Mark Completed"}
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
    </div>
  );
}
