"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Send,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { HelpLink } from "@/components/help/HelpLink";

import {
  getActiveTasks,
  getUserTaskSubmissions,
  submitTaskCompletion,
} from "@/lib/firebase/firestore";

// --------------------------------------------------
// Types
// --------------------------------------------------

type TaskAction = "Like" | "Comment" | "Share" | "Make Post";

type TaskPlatform = "Facebook" | "X" | "Instagram" | "TikTok";

interface FirestoreTask {
  id: string;
  platform?: TaskPlatform;
  action?: TaskAction;
  points?: number;
  url?: string;
  deadline?: string | null;
  status?: string;
  created_at?: unknown;
  [key: string]: unknown;
}

interface UserSubmission {
  id: string;
  task_id: string;
  status: "pending" | "verified";
  proof_url?: string | null;
  submitted_at?: unknown;
  [key: string]: unknown;
}

// Only these actions require the member to provide a proof URL.
function requiresProof(action?: TaskAction) {
  return action === "Share" || action === "Make Post";
}

function formatDate(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date })
      .toDate()
      .toLocaleDateString("en-NG", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
  }

  return "Recently";
}

// --------------------------------------------------
// Page
// --------------------------------------------------

export default function TasksPage() {
  const { profile, loading: authLoading } = useAuth();

  const [tasks, setTasks] = useState<FirestoreTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [mySubmissions, setMySubmissions] = useState<UserSubmission[]>([]);
  const [submittingTaskId, setSubmittingTaskId] = useState<string | null>(null);
  const [proofUrls, setProofUrls] = useState<Record<string, string>>({});
  const [memberError, setMemberError] = useState("");

  const loadTasks = async () => {
    if (!profile) return;

    setLoadingTasks(true);
    setLoadError("");

    try {
      const data = await getActiveTasks();
      setTasks(data as FirestoreTask[]);
    } catch (error) {
      console.error("Failed to load tasks:", error);
      setLoadError("Unable to load tasks right now.");
    } finally {
      setLoadingTasks(false);
    }
  };

  const loadMySubmissions = async () => {
    if (!profile?.id) return;

    try {
      const data = await getUserTaskSubmissions(profile.id);
      setMySubmissions(data as UserSubmission[]);
    } catch (error) {
      console.error("Failed to load your submissions:", error);
      setMemberError("Unable to load your task history right now.");
    }
  };

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (authLoading || !profile) return;

    loadTasks();
    loadMySubmissions();
  }, [authLoading, profile?.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const getSubmissionForTask = (taskId: string) => {
    return mySubmissions.find((submission) => submission.task_id === taskId);
  };

  const handleSubmitCompletion = async (task: FirestoreTask) => {
    if (!profile?.id) return;

    setMemberError("");

    const existingSubmission = getSubmissionForTask(task.id);

    if (existingSubmission) {
      setMemberError("You have already submitted this task.");
      return;
    }

    const needsProof = requiresProof(task.action);
    const proofUrl = proofUrls[task.id]?.trim() ?? "";

    if (needsProof && !proofUrl) {
      setMemberError(
        task.action === "Make Post"
          ? "Please provide the direct URL to your post."
          : "Please provide the direct URL to your shared post.",
      );
      return;
    }

    setSubmittingTaskId(task.id);

    try {
      await submitTaskCompletion(
        task.id,
        profile.id,
        needsProof ? proofUrl : undefined,
      );

      const updated = await getUserTaskSubmissions(profile.id);
      setMySubmissions(updated as UserSubmission[]);

      setProofUrls((previous) => {
        const next = { ...previous };
        delete next[task.id];
        return next;
      });
    } catch (error: unknown) {
      console.error("Failed to submit task:", error);
      setMemberError(
        error instanceof Error
          ? error.message
          : "Unable to submit task. Please try again.",
      );
    } finally {
      setSubmittingTaskId(null);
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
                const needsProof = requiresProof(task.action);

                return (
                  <div
                    key={task.id}
                    className="overflow-hidden rounded-xl border bg-white"
                  >
                    <div className="p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-apc-light px-3 py-1 text-xs font-semibold text-apc-primary">
                              {task.platform}
                            </span>

                            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                              {task.action}
                            </span>

                            <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                              +{task.points ?? 0} points
                            </span>
                          </div>

                          <h3 className="mt-3 font-semibold text-gray-900">
                            {task.action} on {task.platform}
                          </h3>

                          <p className="mt-1 text-sm text-gray-500">
                            {task.deadline
                              ? `Deadline: ${task.deadline}`
                              : "No deadline"}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          {task.url && (
                            <a
                              href={task.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-2 rounded-lg border border-apc-primary px-3 py-2 text-sm font-medium text-apc-primary transition-colors hover:bg-apc-light"
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
                              existingSubmission.status === "verified"
                                ? "flex flex-col gap-3 rounded-lg bg-green-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                                : "flex flex-col gap-3 rounded-lg bg-yellow-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                            }
                          >
                            <div className="flex items-center gap-3">
                              {existingSubmission.status === "verified" ? (
                                <CheckCircle2 className="h-5 w-5 text-green-600" />
                              ) : (
                                <Loader2 className="h-5 w-5 text-yellow-600" />
                              )}

                              <div>
                                <p
                                  className={
                                    existingSubmission.status === "verified"
                                      ? "font-medium text-green-800"
                                      : "font-medium text-yellow-800"
                                  }
                                >
                                  {existingSubmission.status === "verified"
                                    ? "Task verified"
                                    : "Submitted for review"}
                                </p>

                                <p className="text-xs text-gray-500">
                                  Submitted{" "}
                                  {formatDate(existingSubmission.submitted_at)}
                                </p>
                              </div>
                            </div>

                            {existingSubmission.proof_url && (
                              <a
                                href={existingSubmission.proof_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-sm font-medium text-apc-primary hover:underline"
                              >
                                View submitted proof
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-4">
                            {needsProof && (
                              <div>
                                <label className="mb-2 block text-sm font-medium text-gray-700">
                                  {task.action === "Make Post"
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
                                    task.action === "Make Post"
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
                                  {task.action}
                                </span>{" "}
                                action, then mark the task completed. No proof
                                URL is required.
                              </p>
                            )}

                            <button
                              type="button"
                              onClick={() => handleSubmitCompletion(task)}
                              disabled={isSubmitting}
                              className="inline-flex items-center gap-2 rounded-lg bg-apc-green px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
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
