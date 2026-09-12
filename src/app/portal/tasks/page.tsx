"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Plus,
  Send,
  X,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";

import {
  createTask,
  getActiveTasks,
  getAllTasks,
  getSubmissionsForTaskWithUsers,
  getUserTaskSubmissions,
  submitTaskCompletion,
  verifyTaskSubmission,
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

interface SubmissionWithUser {
  id: string;
  task_id: string;
  user_id: string;
  status: "pending" | "verified";
  proof_url?: string | null;
  submitted_at?: unknown;
  verified_at?: unknown;
  user: {
    id?: string;
    full_name?: string;
    facebook_username?: string;
    x_username?: string;
    instagram_username?: string;
    tiktok_username?: string;
    facebook_profile_url?: string;
    x_profile_url?: string;
    instagram_profile_url?: string;
    tiktok_profile_url?: string;
    [key: string]: unknown;
  } | null;
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

// --------------------------------------------------
// Constants
// --------------------------------------------------

const PLATFORM_OPTIONS: TaskPlatform[] = [
  "Facebook",
  "X",
  "Instagram",
  "TikTok",
];

const ACTION_OPTIONS: TaskAction[] = ["Like", "Comment", "Share", "Make Post"];

const PLATFORM_NAME_FIELD: Record<TaskPlatform, string> = {
  Facebook: "facebook_username",
  X: "x_username",
  Instagram: "instagram_username",
  TikTok: "tiktok_username",
};

const PLATFORM_PROFILE_FIELD: Record<TaskPlatform, string> = {
  Facebook: "facebook_profile_url",
  X: "x_profile_url",
  Instagram: "instagram_profile_url",
  TikTok: "tiktok_profile_url",
};

// Only these actions require the member to provide a proof URL.
function requiresProof(action?: TaskAction) {
  return action === "Share" || action === "Make Post";
}

function getMemberSocialName(
  user: SubmissionWithUser["user"],
  platform?: TaskPlatform,
) {
  if (!user || !platform) return null;

  const field = PLATFORM_NAME_FIELD[platform];

  return field ? ((user[field] as string | undefined) ?? null) : null;
}

function getMemberProfileUrl(
  user: SubmissionWithUser["user"],
  platform?: TaskPlatform,
) {
  if (!user || !platform) return null;

  const field = PLATFORM_PROFILE_FIELD[platform];

  return field ? ((user[field] as string | undefined) ?? null) : null;
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

  const isAdmin = profile?.access_role === "admin";
  const isMember = profile?.access_role === "member";

  // ------------------------------------------------
  // Shared task state
  // ------------------------------------------------

  const [tasks, setTasks] = useState<FirestoreTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadError, setLoadError] = useState("");

  // ------------------------------------------------
  // Admin create-task state
  // ------------------------------------------------

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const [createForm, setCreateForm] = useState({
    platform: "Facebook" as TaskPlatform,
    action: "Like" as TaskAction,
    points: "",
    url: "",
    deadline: "",
  });

  // ------------------------------------------------
  // Admin submissions state
  // ------------------------------------------------

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const [submissionsByTask, setSubmissionsByTask] = useState<
    Record<string, SubmissionWithUser[]>
  >({});

  const [loadingSubmissionsFor, setLoadingSubmissionsFor] = useState<
    string | null
  >(null);

  const [submissionsError, setSubmissionsError] = useState("");

  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  // ------------------------------------------------
  // Member submission state
  // ------------------------------------------------

  const [mySubmissions, setMySubmissions] = useState<UserSubmission[]>([]);

  const [submittingTaskId, setSubmittingTaskId] = useState<string | null>(null);

  const [proofUrls, setProofUrls] = useState<Record<string, string>>({});

  const [memberError, setMemberError] = useState("");

  // ------------------------------------------------
  // Load tasks
  // ------------------------------------------------

  const loadTasks = async () => {
    if (!profile) return;

    setLoadingTasks(true);
    setLoadError("");

    try {
      const data = isAdmin ? await getAllTasks() : await getActiveTasks();

      setTasks(data as FirestoreTask[]);
    } catch (error) {
      console.error("Failed to load tasks:", error);
      setLoadError("Unable to load tasks right now.");
    } finally {
      setLoadingTasks(false);
    }
  };

  // ------------------------------------------------
  // Load member submissions
  // ------------------------------------------------

  const loadMySubmissions = async () => {
    if (!profile?.id || !isMember) return;

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

    if (isMember) {
      loadMySubmissions();
    }
  }, [authLoading, profile?.id, profile?.access_role]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ------------------------------------------------
  // Submission lookup
  // ------------------------------------------------

  const getSubmissionForTask = (taskId: string) => {
    return mySubmissions.find((submission) => submission.task_id === taskId);
  };

  // ------------------------------------------------
  // Admin: Create task
  // ------------------------------------------------

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isAdmin) return;

    setCreateError("");

    const pointsNumber = Number(createForm.points);

    if (!createForm.url.trim()) {
      setCreateError("The original post URL is required.");
      return;
    }

    if (!pointsNumber || pointsNumber <= 0) {
      setCreateError("Points must be a positive number.");
      return;
    }

    setCreating(true);

    try {
      await createTask({
        platform: createForm.platform,
        action: createForm.action,
        points: pointsNumber,
        url: createForm.url.trim(),
        deadline: createForm.deadline || null,
      });

      setCreateForm({
        platform: "Facebook",
        action: "Like",
        points: "",
        url: "",
        deadline: "",
      });

      setShowCreateForm(false);

      await loadTasks();
    } catch (error: unknown) {
      console.error("Failed to create task:", error);

      setCreateError(
        error instanceof Error
          ? error.message
          : "Failed to create task. Please try again.",
      );
    } finally {
      setCreating(false);
    }
  };

  // ------------------------------------------------
  // Admin: Toggle submissions
  // ------------------------------------------------

  const toggleSubmissions = async (taskId: string) => {
    if (!isAdmin) return;

    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
      return;
    }

    setExpandedTaskId(taskId);
    setSubmissionsError("");

    if (submissionsByTask[taskId]) {
      return;
    }

    setLoadingSubmissionsFor(taskId);

    try {
      const data = await getSubmissionsForTaskWithUsers(taskId);

      setSubmissionsByTask((previous) => ({
        ...previous,
        [taskId]: data as SubmissionWithUser[],
      }));
    } catch (error) {
      console.error("Failed to load submissions:", error);

      setSubmissionsError("Unable to load submissions for this task.");
    } finally {
      setLoadingSubmissionsFor(null);
    }
  };

  // ------------------------------------------------
  // Admin: Verify submission
  // ------------------------------------------------

  const handleVerify = async (taskId: string, submissionId: string) => {
    if (!isAdmin || !profile?.id) return;

    setSubmissionsError("");
    setVerifyingId(submissionId);

    try {
      await verifyTaskSubmission(submissionId, profile.id);

      setSubmissionsByTask((previous) => ({
        ...previous,
        [taskId]: (previous[taskId] ?? []).map((submission) =>
          submission.id === submissionId
            ? {
                ...submission,
                status: "verified",
              }
            : submission,
        ),
      }));
    } catch (error: unknown) {
      console.error("Failed to verify submission:", error);

      setSubmissionsError(
        error instanceof Error
          ? error.message
          : "Verification failed. Please try again.",
      );
    } finally {
      setVerifyingId(null);
    }
  };

  // ------------------------------------------------
  // Member: Submit completion
  // ------------------------------------------------

  const handleSubmitCompletion = async (task: FirestoreTask) => {
    if (!isMember || !profile?.id) return;

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

  // ------------------------------------------------
  // Loading
  // ------------------------------------------------

  if (authLoading || !profile) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading tasks…
      </div>
    );
  }

  // ------------------------------------------------
  // Main
  // ------------------------------------------------

  return (
    <div className="space-y-6">
      {/* --------------------------------------------
          Header
      --------------------------------------------- */}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Social Tasks</h1>

          <p className="mt-1 text-gray-600">
            {isAdmin
              ? "Create social tasks and review member submissions."
              : "Complete social tasks, submit proof where required, and earn points."}
          </p>
        </div>

        {/* ADMIN ONLY */}
        {isAdmin && (
          <button
            type="button"
            onClick={() => {
              setShowCreateForm((value) => !value);
              setCreateError("");
            }}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2 font-medium text-white transition-colors hover:bg-apc-dark"
          >
            {showCreateForm ? (
              <X className="h-5 w-5" />
            ) : (
              <Plus className="h-5 w-5" />
            )}

            {showCreateForm ? "Cancel" : "Create Task"}
          </button>
        )}
      </div>

      {/* --------------------------------------------
          Errors
      --------------------------------------------- */}

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {memberError && !isAdmin && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {memberError}
        </div>
      )}

      {/* --------------------------------------------
          ADMIN CREATE FORM
      --------------------------------------------- */}

      {isAdmin && showCreateForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Social Task</CardTitle>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleCreateTask} className="space-y-5">
              {createError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {createError}
                </div>
              )}

              <div className="grid gap-5 md:grid-cols-2">
                {/* Platform */}

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Platform *
                  </label>

                  <select
                    value={createForm.platform}
                    onChange={(e) =>
                      setCreateForm((previous) => ({
                        ...previous,
                        platform: e.target.value as TaskPlatform,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                  >
                    {PLATFORM_OPTIONS.map((platform) => (
                      <option key={platform} value={platform}>
                        {platform}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Action */}

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Action *
                  </label>

                  <select
                    value={createForm.action}
                    onChange={(e) =>
                      setCreateForm((previous) => ({
                        ...previous,
                        action: e.target.value as TaskAction,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                  >
                    {ACTION_OPTIONS.map((action) => (
                      <option key={action} value={action}>
                        {action}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Points */}

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Points *
                  </label>

                  <input
                    type="number"
                    min="1"
                    required
                    value={createForm.points}
                    onChange={(e) =>
                      setCreateForm((previous) => ({
                        ...previous,
                        points: e.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="e.g. 50"
                  />
                </div>

                {/* Deadline */}

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Deadline
                  </label>

                  <input
                    type="date"
                    value={createForm.deadline}
                    onChange={(e) =>
                      setCreateForm((previous) => ({
                        ...previous,
                        deadline: e.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                  />
                </div>

                {/* Original post URL */}

                <div className="md:col-span-2">
                  <label className="mb-2 block text-sm font-medium">
                    Original Post URL *
                  </label>

                  <input
                    type="url"
                    required
                    value={createForm.url}
                    onChange={(e) =>
                      setCreateForm((previous) => ({
                        ...previous,
                        url: e.target.value,
                      }))
                    }
                    className="w-full rounded-lg border px-4 py-3"
                    placeholder="https://facebook.com/..."
                  />

                  <p className="mt-1 text-xs text-gray-500">
                    This is the post members should interact with. For Like and
                    Comment tasks, members do not need to submit another URL.
                  </p>
                </div>
              </div>

              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-6 py-3 font-semibold text-white transition-colors hover:bg-apc-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}

                {creating ? "Creating..." : "Create Task"}
              </button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------
          TASK LIST
      --------------------------------------------- */}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{isAdmin ? "All Tasks" : "Available Tasks"}</CardTitle>

            {!isAdmin && (
              <span className="text-sm text-gray-500">
                {tasks.length} available
              </span>
            )}
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
                {isAdmin
                  ? "No tasks created yet."
                  : "No active social tasks available right now."}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {tasks.map((task) => {
                const existingSubmission = getSubmissionForTask(task.id);

                const isExpanded = expandedTaskId === task.id;

                const submissions = submissionsByTask[task.id] ?? [];

                const isLoadingSubmissions = loadingSubmissionsFor === task.id;

                const isSubmitting = submittingTaskId === task.id;

                const needsProof = requiresProof(task.action);

                return (
                  <div
                    key={task.id}
                    className="overflow-hidden rounded-xl border bg-white"
                  >
                    {/* Task summary */}

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
                          {/* Original post */}

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

                          {/* ADMIN ONLY */}

                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => toggleSubmissions(task.id)}
                              className="inline-flex items-center gap-1 rounded-lg bg-apc-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-apc-dark"
                            >
                              Submissions
                              {isExpanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* ----------------------------------
                          MEMBER ACTION AREA
                      ----------------------------------- */}

                      {isMember && (
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
                                    {formatDate(
                                      existingSubmission.submitted_at,
                                    )}
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
                      )}
                    </div>

                    {/* ----------------------------------
                        ADMIN SUBMISSIONS
                    ----------------------------------- */}

                    {isAdmin && isExpanded && (
                      <div className="border-t bg-gray-50 p-5">
                        {submissionsError && (
                          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                            {submissionsError}
                          </div>
                        )}

                        {isLoadingSubmissions ? (
                          <div className="flex items-center justify-center gap-2 py-8 text-gray-500">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Loading submissions…
                          </div>
                        ) : submissions.length === 0 ? (
                          <div className="py-8 text-center">
                            <p className="text-sm text-gray-500">
                              No members have submitted this task yet.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="mb-3">
                              <h4 className="font-semibold text-gray-900">
                                Member Submissions
                              </h4>

                              <p className="text-xs text-gray-500">
                                {submissions.length} submission
                                {submissions.length === 1 ? "" : "s"}
                              </p>
                            </div>

                            {submissions.map((submission) => {
                              const socialName = getMemberSocialName(
                                submission.user,
                                task.platform,
                              );

                              const profileUrl = getMemberProfileUrl(
                                submission.user,
                                task.platform,
                              );

                              const isVerified =
                                submission.status === "verified";

                              const isVerifying = verifyingId === submission.id;

                              return (
                                <div
                                  key={submission.id}
                                  className="rounded-lg border bg-white p-4"
                                >
                                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                                    <div>
                                      <p className="font-semibold text-gray-900">
                                        {submission.user?.full_name ??
                                          "Unknown member"}
                                      </p>

                                      <p className="mt-1 text-sm text-gray-500">
                                        {task.platform} name:{" "}
                                        <span className="font-medium text-gray-700">
                                          {socialName ?? "Not provided"}
                                        </span>
                                      </p>

                                      {profileUrl && (
                                        <a
                                          href={profileUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-apc-primary hover:underline"
                                        >
                                          Open member profile
                                          <ExternalLink className="h-3 w-3" />
                                        </a>
                                      )}

                                      <p className="mt-1 text-xs text-gray-400">
                                        Submitted{" "}
                                        {formatDate(submission.submitted_at)}
                                      </p>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-3">
                                      {submission.proof_url && (
                                        <a
                                          href={submission.proof_url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                                        >
                                          View Proof
                                          <ExternalLink className="h-3 w-3" />
                                        </a>
                                      )}

                                      {isVerified ? (
                                        <span className="inline-flex items-center gap-1 rounded-lg bg-green-100 px-3 py-2 text-xs font-semibold text-green-700">
                                          <CheckCircle2 className="h-4 w-4" />
                                          Verified
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            handleVerify(task.id, submission.id)
                                          }
                                          disabled={isVerifying}
                                          className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-3 py-2 text-xs font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
                                        >
                                          {isVerifying && (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                          )}

                                          {isVerifying
                                            ? "Verifying..."
                                            : "Verify & Award Points"}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
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
