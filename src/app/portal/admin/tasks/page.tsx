"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAllTasks,
  createTask,
  getSubmissionsForTaskWithUsers,
  verifyTaskSubmission,
} from "@/lib/firebase/firestore";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/contexts/AuthContext";
import {
  Plus,
  CheckCircle2,
  AlertCircle,
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
  action_type: string;
  points: number;
  status: "active" | "inactive" | "expired";
  target_url?: string;
  proof_required?: boolean;
  expiration_date?: string;
  created_at?: any;
}

export default function AdminTasksPage() {
  const { profile } = useAuth();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Create/Edit Task Modal State
  const [showModal, setShowModal] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    title: "",
    description: "",
    platform: "facebook",
    action_type: "share",
    points: 50,
    status: "active" as TaskItem["status"],
    target_url: "",
    proof_required: true,
    expiration_date: "",
  });

  // Review Submissions Modal State
  const [reviewTask, setReviewTask] = useState<TaskItem | null>(null);
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  useEffect(() => {
    loadTasksList();
  }, []);

  async function loadTasksList() {
    setLoading(true);
    try {
      const data = await getAllTasks();
      setTasks(data as TaskItem[]);
    } catch (err: unknown) {
      const errorObj = err as Error;
      console.error("Failed to load tasks:", err);
      setError(errorObj.message || "Failed to load tasks.");
    } finally {
      setLoading(false);
    }
  }

  const handleOpenCreateModal = () => {
    setEditingTask(null);
    setForm({
      title: "",
      description: "",
      platform: "facebook",
      action_type: "share",
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
      action_type: task.action_type || "share",
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
      setError("Task title is required.");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      if (editingTask) {
        // Update
        const taskRef = doc(db, "tasks", editingTask.id);
        await updateDoc(taskRef, {
          title: form.title.trim(),
          description: form.description.trim() || null,
          platform: form.platform,
          action_type: form.action_type,
          points: Number(form.points) || 0,
          status: form.status,
          target_url: form.target_url.trim() || null,
          proof_required: form.proof_required,
          expiration_date: form.expiration_date || null,
          updated_at: serverTimestamp(),
        });
        setSuccess("Task updated successfully!");
      } else {
        // Create
        await createTask({
          title: form.title.trim(),
          description: form.description.trim() || null,
          platform: form.platform,
          action_type: form.action_type,
          points: Number(form.points) || 0,
          status: form.status,
          target_url: form.target_url.trim() || null,
          proof_required: form.proof_required,
          expiration_date: form.expiration_date || null,
        });
        setSuccess("Task created successfully!");
      }

      setShowModal(false);
      await loadTasksList();
    } catch (err: unknown) {
      const errorObj = err as Error;
      console.error("Failed to save task:", err);
      setError(errorObj.message || "Failed to save task.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (task: TaskItem) => {
    const newStatus = task.status === "active" ? "inactive" : "active";
    try {
      const taskRef = doc(db, "tasks", task.id);
      await updateDoc(taskRef, {
        status: newStatus,
        updated_at: serverTimestamp(),
      });
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t))
      );
      setSuccess(`Task marked as ${newStatus}`);
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "Failed to update task status.");
    }
  };

  const handleOpenReviewModal = async (task: TaskItem) => {
    setReviewTask(task);
    setLoadingSubmissions(true);
    try {
      const subs = await getSubmissionsForTaskWithUsers(task.id);
      setSubmissions(subs);
    } catch (err: unknown) {
      console.error("Failed to load submissions:", err);
    } finally {
      setLoadingSubmissions(false);
    }
  };

  const handleVerifySubmission = async (submissionId: string, currentStatus: string) => {
    if (!profile?.id) return;
    setVerifyingId(submissionId);
    try {
      const newStatus = currentStatus === "verified" ? "pending" : "verified";
      const subRef = doc(db, "task_submissions", submissionId);
      await updateDoc(subRef, {
        status: newStatus,
        verified_by: newStatus === "verified" ? profile.id : null,
        verified_at: newStatus === "verified" ? serverTimestamp() : null,
      });
      setSubmissions((prev) =>
        prev.map((s) => (s.id === submissionId ? { ...s, status: newStatus } : s))
      );
      setSuccess(
        newStatus === "verified"
          ? "Submission verified and points awarded!"
          : "Submission unverified successfully."
      );
    } catch (err: unknown) {
      const errorObj = err as Error;
      alert(errorObj.message || "Failed to update submission status.");
    } finally {
      setVerifyingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading campaign tasks...</span>
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

      {success && (
        <div className="flex items-center gap-2 p-4 bg-green-50 text-green-700 rounded-xl border border-green-200 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-4 bg-red-50 text-red-700 rounded-xl border border-red-200 text-sm">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Task Listing */}
      <Card>
        <CardHeader>
          <CardTitle>All Campaign Tasks ({tasks.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-center py-8 text-sm text-gray-500">
              No campaign tasks created yet. Click &quot;Create New Task&quot; above.
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
                        Platform: <span className="font-semibold uppercase text-gray-700">{task.platform}</span> · Action: <span className="font-semibold uppercase text-gray-700">{task.action_type}</span> · Award: <span className="font-bold text-apc-primary">{task.points} pts</span>
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
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Action Type</label>
                  <select
                    value={form.action_type}
                    onChange={(e) => setForm({ ...form, action_type: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="like">Like</option>
                    <option value="comment">Comment</option>
                    <option value="share">Share</option>
                    <option value="post">Create Post</option>
                    <option value="follow">Follow</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Award Points *</label>
                  <input
                    type="number"
                    min="5"
                    value={form.points}
                    onChange={(e) => setForm({ ...form, points: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-xs font-bold"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 mb-1">Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                    className="w-full px-3 py-2 border rounded-lg text-xs"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="expired">Expired</option>
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
                      <p className="font-bold text-gray-900">{sub.user?.full_name || sub.user_id}</p>
                      <p className="text-gray-500">{sub.user?.email || ""}</p>
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

                      <button
                        onClick={() => handleVerifySubmission(sub.id, sub.status)}
                        disabled={verifyingId === sub.id}
                        className={`px-3 py-1.5 rounded-lg font-bold disabled:opacity-50 flex items-center gap-1 text-xs ${
                          sub.status === "verified"
                            ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                            : "bg-emerald-600 text-white hover:bg-emerald-700"
                        }`}
                      >
                        {verifyingId === sub.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3 w-3" />
                        )}
                        {sub.status === "verified" ? "Unverify Submission" : `Approve & Award ${reviewTask.points} pts`}
                      </button>
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
