"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveSocialAccess,
  SocialForceError,
  getSocialTasks,
  createSocialTask,
  updateSocialTask,
  setSocialTaskStatus,
  getSubmissionsForTask,
  getSubmissionsCount,
  verifySocialSubmission,
  type SocialTask,
  type SocialSubmissionWithSubmitter,
  type SocialTaskPlatform,
  type SocialTaskAction,
  type SocialTaskStatus,
} from "@/lib/supabase";
import {
  Plus,
  Loader2,
  X,
  ExternalLink,
  Pencil,
  Power,
  ShieldCheck,
  Eye,
} from "lucide-react";

interface TaskItem {
  id: string;
  title: string;
  description?: string;
  platform: string;
  action: string;
  points: number;
  status: SocialTaskStatus;
  target_url?: string;
  proof_required?: boolean;
  expiration_date?: string;
}

export default function AdminTasksPage() {
  const { profile } = useAuth();
  const toast = useToast();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);

  // Create/Edit Task Modal State
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    title: "",
    description: "",
    platform: "facebook",
    action: "share",
    points: 50,
    status: "active" as SocialTaskStatus,
    target_url: "",
    proof_required: true,
    expiration_date: "",
  });

  // Review Submissions Modal State
  const [reviewTask, setReviewTask] = useState<TaskItem | null>(null);
  const [submissions, setSubmissions] = useState<SocialSubmissionWithSubmitter[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  // §15: per-task pending/verified counts for the listing badges — ONE
  // grouped query over the RLS-scoped view (never a per-task fanout).
  const [submissionCounts, setSubmissionCounts] = useState<Map<string, { pending: number; verified: number }>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      try {
        const bridge = await ensureSupabaseSession();
        if (!bridge.sessionReady || !profile) {
          setDenied("Your session has expired. Please sign in again.");
          return;
        }
        const supabase = getSupabaseClient();

        const access = await resolveSocialAccess(supabase);
        if (cancelled) return;
        if (!access.allowed) {
          setDenied(
            access.reason === "module_disabled"
              ? "The Social Force module is not enabled for your organization."
              : "You do not have permission to manage Social Tasks.",
          );
          return;
        }

        await loadTasksList(supabase);
      } catch (err: unknown) {
        console.error("Failed to load tasks:", err);
        if (!cancelled) {
          toast.error("We couldn't load the tasks. Please refresh the page.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  async function loadTasksList(supabase = getSupabaseClient()) {
    const data = await getSocialTasks(supabase);
    setTasks(
      data.map((t: SocialTask) => ({
        id: t.id,
        title: t.title,
        description: t.description ?? undefined,
        platform: t.platform,
        action: t.action,
        points: t.points,
        status: t.status,
        target_url: t.target_url ?? undefined,
        proof_required: t.proof_required,
        expiration_date: t.expiration_date
          ? t.expiration_date.slice(0, 10)
          : undefined,
      })),
    );
    setSubmissionCounts(await getSubmissionsCount(supabase, data.map((t) => t.id)));
  }

  const handleOpenCreateModal = () => {
    setEditingTask(null);
    setForm({
      title: "",
      description: "",
      platform: "facebook",
      action: "share",
      points: 50,
      status: "active",
      target_url: "",
      proof_required: true,
      expiration_date: "",
    });
    setShowModal(true);
  };

  const handleOpenEditModal = (task: TaskItem) => {
    setEditingTask(task);
    setForm({
      title: task.title,
      description: task.description || "",
      platform: task.platform || "facebook",
      action: task.action || "share",
      points: task.points || 50,
      status: task.status || "active",
      target_url: task.target_url || "",
      proof_required: task.proof_required ?? true,
      expiration_date: task.expiration_date || "",
    });
    setShowModal(true);
  };

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.warning("Please enter a title for the task.");
      return;
    }

    setSaving(true);

    try {
      const supabase = getSupabaseClient();
      if (editingTask) {
        await updateSocialTask(supabase, editingTask.id, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          platform: form.platform as SocialTaskPlatform,
          action: form.action as SocialTaskAction,
          points: Number(form.points) || 0,
          status: form.status,
          target_url: form.target_url.trim() || null,
          proof_required: form.proof_required,
          expiration_date: form.expiration_date || null,
        });
        toast.success("Task updated successfully.");
      } else {
        await createSocialTask(supabase, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          platform: form.platform as SocialTaskPlatform,
          action: form.action as SocialTaskAction,
          points: Number(form.points) || 0,
          status: form.status,
          target_url: form.target_url.trim() || null,
          proof_required: form.proof_required,
          expiration_date: form.expiration_date || null,
        });
        toast.success("Task created successfully.");
      }

      setShowModal(false);
      await loadTasksList();
    } catch (err: unknown) {
      console.error("Failed to save task:", err);
      const message =
        err instanceof SocialForceError
          ? err.message
          : getErrorMessage(err, "We couldn't save the task. Please try again.");
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (task: TaskItem) => {
    const newStatus: SocialTaskStatus =
      task.status === "active" ? "inactive" : "active";
    try {
      await setSocialTaskStatus(getSupabaseClient(), task.id, newStatus);
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)),
      );
      toast.success(`Task marked as ${newStatus}`);
    } catch (err: unknown) {
      console.error("Failed to toggle task status:", err);
      const message =
        err instanceof SocialForceError
          ? err.message
          : getErrorMessage(
              err,
              "We couldn't update the task status. Please try again.",
            );
      toast.error(message);
    }
  };

  const handleOpenReviewModal = async (task: TaskItem) => {
    setReviewTask(task);
    setLoadingSubmissions(true);
    try {
      const subs = await getSubmissionsForTask(getSupabaseClient(), task.id);
      setSubmissions(subs);
    } catch (err: unknown) {
      console.error("Failed to load submissions:", err);
      setSubmissions([]);
    } finally {
      setLoadingSubmissions(false);
    }
  };

  const handleVerifySubmission = async (submissionId: string) => {
    setVerifyingId(submissionId);
    try {
      await verifySocialSubmission(getSupabaseClient(), submissionId);
      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === submissionId ? { ...s, status: "verified" as const } : s,
        ),
      );
      if (reviewTask) {
        setSubmissionCounts((prev) => {
          const next = new Map(prev);
          const c = next.get(reviewTask.id) ?? { pending: 0, verified: 0 };
          next.set(reviewTask.id, {
            pending: Math.max(0, c.pending - 1),
            verified: c.verified + 1,
          });
          return next;
        });
      }
      toast.success("Submission verified and points awarded.");
    } catch (err: unknown) {
      console.error("Failed to verify submission:", err);
      const message =
        err instanceof SocialForceError
          ? err.message
          : getErrorMessage(
              err,
              "We couldn't update the submission status. Please try again.",
            );
      toast.error(message);
    } finally {
      setVerifyingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading tasks...</span>
      </div>
    );
  }

  if (denied) {
    return (
      <div className="pb-12 max-w-6xl mx-auto">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {denied}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Task Management Desk</h1>
          <p className="text-sm text-gray-500">
            Create, edit, activate social media tasks and review member submissions.
          </p>
        </div>

        <button
          onClick={handleOpenCreateModal}
          className="inline-flex items-center gap-2 bg-apc-primary text-white px-4 py-2.5 rounded-xl font-bold text-sm hover:bg-apc-dark transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" />
          <span>Create New Task</span>
        </button>
      </div>

      {/* Task Listing */}
      <Card>
        <CardHeader>
          <CardTitle>All Social Tasks ({tasks.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-center py-8 text-sm text-gray-500">
              No social tasks created yet. Click &quot;Create New Task&quot; above.
            </p>
          ) : (
            <div className="divide-y">
              {tasks.map((task) => {
                const isPastDeadline =
                  task.expiration_date && new Date(task.expiration_date) < new Date();
                const computedStatus = isPastDeadline ? "expired" : task.status;

                return (
                  <div key={task.id} className="py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-900 text-base">{task.title}</span>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-xs font-bold capitalize ${
                            computedStatus === "active"
                              ? "bg-emerald-100 text-emerald-800"
                              : computedStatus === "expired"
                              ? "bg-red-100 text-red-800"
                              : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {computedStatus}
                        </span>
                      </div>

                      <p className="text-xs text-gray-500">
                        Platform: <span className="font-semibold uppercase text-gray-700">{task.platform}</span> · Action: <span className="font-semibold uppercase text-gray-700">{task.action}</span> · Award: <span className="font-bold text-apc-primary">{task.points} pts</span>
                        {task.expiration_date ? (
                          <span className={isPastDeadline ? "text-red-600 font-bold ml-1" : "ml-1"}>
                            · Deadline: {task.expiration_date} {isPastDeadline ? "(Expired)" : ""}
                          </span>
                        ) : (
                          " · No Deadline"
                        )}
                      </p>

                      {task.target_url && (
                        <a
                          href={task.target_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-apc-primary font-semibold hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> Open Task Link
                        </a>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {task.target_url && (
                        <a
                          href={task.target_url}
                          target="_blank"
                          rel="noreferrer"
                          className="px-3 py-1.5 bg-apc-primary/10 text-apc-primary hover:bg-apc-primary/20 rounded-lg text-xs font-bold flex items-center gap-1"
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Open Task
                        </a>
                      )}

                      <button
                        onClick={() => handleOpenReviewModal(task)}
                        className="px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg text-xs font-bold flex items-center gap-1"
                      >
                        <Eye className="h-3.5 w-3.5" /> Submissions
                        {(() => {
                          const c = submissionCounts.get(task.id);
                          if (!c) return null;
                          return (
                            <span className="flex items-center gap-1">
                              {c.pending > 0 && (
                                <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">
                                  {c.pending} pending
                                </span>
                              )}
                              {c.verified > 0 && (
                                <span className="rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-800">
                                  {c.verified} verified
                                </span>
                              )}
                            </span>
                          );
                        })()}
                      </button>

                      <button
                        onClick={() => handleOpenEditModal(task)}
                        className="px-3 py-1.5 border rounded-lg text-xs font-bold text-gray-700 hover:bg-gray-50 flex items-center gap-1"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </button>

                      <button
                        onClick={() => handleToggleStatus(task)}
                        disabled={!!isPastDeadline}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ${
                          task.status === "active"
                            ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                            : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        <Power className="h-3.5 w-3.5" />
                        {task.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* CREATE / EDIT TASK MODAL */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-lg font-bold text-gray-900">
                {editingTask ? "Edit Task" : "Create Social Task"}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <form onSubmit={handleSaveTask} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-gray-700 mb-1">Task Title *</label>
                <input
                  type="text"
                  required
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g. Share campaign announcement video"
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>

              <div>
                <label className="block font-semibold text-gray-700 mb-1">Description / Instructions</label>
                <textarea
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Specific guidelines for volunteers..."
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Platform</label>
                  <select
                    value={form.platform}
                    onChange={(e) => setForm({ ...form, platform: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="facebook">Facebook</option>
                    <option value="x">X (Twitter)</option>
                    <option value="instagram">Instagram</option>
                    <option value="tiktok">TikTok</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Action Type</label>
                  <select
                    value={form.action}
                    onChange={(e) => setForm({ ...form, action: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="like">Like</option>
                    <option value="comment">Comment</option>
                    <option value="share">Share</option>
                    <option value="make_post">Create Post</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Award Points *</label>
                  <input
                    type="number"
                    min="1"
                    value={form.points}
                    onChange={(e) => setForm({ ...form, points: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-xs font-bold"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as SocialTaskStatus })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-gray-700 mb-1">Target Post/Video URL</label>
                <input
                  type="url"
                  value={form.target_url}
                  onChange={(e) => setForm({ ...form, target_url: e.target.value })}
                  placeholder="https://facebook.com/..."
                  className="w-full px-3 py-2 border rounded-lg text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Expiration Date</label>
                  <input
                    type="date"
                    value={form.expiration_date}
                    onChange={(e) => setForm({ ...form, expiration_date: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  />
                </div>

                <div className="flex items-center pt-5">
                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-gray-700">
                    <input
                      type="checkbox"
                      checked={form.proof_required}
                      onChange={(e) => setForm({ ...form, proof_required: e.target.checked })}
                      className="rounded text-apc-primary"
                    />
                    Proof Link Required
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t pt-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 font-semibold text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-apc-primary text-white font-bold rounded-lg hover:bg-apc-dark disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Task"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REVIEW SUBMISSIONS MODAL */}
      {reviewTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Task Submissions</h3>
                <p className="text-xs text-gray-500">{reviewTask.title}</p>
              </div>
              <button onClick={() => setReviewTask(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 p-1">
              {loadingSubmissions ? (
                <div className="flex items-center justify-center py-10 text-xs text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading submissions...
                </div>
              ) : submissions.length === 0 ? (
                <p className="text-center py-8 text-xs text-gray-500">
                  No submissions submitted for this task yet.
                </p>
              ) : (
                submissions.map((sub) => (
                  <div key={sub.id} className="p-3 border rounded-xl bg-gray-50 flex items-center justify-between text-xs gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-bold text-gray-900">{sub.submitter?.full_name || sub.submitter_id}</p>
                      <p className="text-gray-500">{sub.submitter?.email || ""}</p>
                      {sub.status === "verified" && sub.verified_at && (
                        <p className="text-[10px] font-semibold text-emerald-700">
                          Verified {new Date(sub.verified_at).toLocaleDateString("en-NG", { month: "short", day: "numeric", year: "numeric" })}
                          {sub.verified_by && sub.verified_by === profile?.id ? " by you" : ""}
                        </p>
                      )}
                      {sub.proof_url && (
                        <a
                          href={sub.proof_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-apc-primary font-semibold hover:underline inline-flex items-center gap-1"
                        >
                          View Proof Link <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {reviewTask.target_url && (
                        <a
                          href={reviewTask.target_url}
                          target="_blank"
                          rel="noreferrer"
                          className="px-2.5 py-1 bg-apc-primary/10 text-apc-primary rounded text-xs font-bold hover:bg-apc-primary/20 flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3" /> Open Task
                        </a>
                      )}

                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          sub.status === "verified" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {sub.status}
                      </span>

                      {sub.status === "pending" && (
                        <button
                          onClick={() => handleVerifySubmission(sub.id)}
                          disabled={verifyingId === sub.id}
                          className="px-3 py-1.5 rounded-lg font-bold disabled:opacity-50 flex items-center gap-1 text-xs bg-emerald-600 text-white hover:bg-emerald-700"
                        >
                          {verifyingId === sub.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3 w-3" />
                          )}
                          {`Approve & Award ${reviewTask.points} pts`}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="border-t pt-3 flex justify-end">
              <button
                onClick={() => setReviewTask(null)}
                className="px-4 py-2 bg-gray-100 text-gray-700 font-semibold rounded-lg text-xs hover:bg-gray-200"
              >
                Close Submissions
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
