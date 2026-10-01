// src/app/portal/admin/announcements/page.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Trash2,
  Edit2,
  Save,
  Megaphone,
  Users,
  Target,
  Shield,
  UserCog,
  Archive,
  Send,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import {
  listAllAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  type PortalAnnouncement,
  type AnnouncementScope,
  type AnnouncementInput,
} from "@/lib/supabase";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";

// ─── DEFAULTS ───

const DEFAULT_ANNOUNCEMENT: AnnouncementInput = {
  title: "",
  content: "",
  scope: "general",
  status: "draft",
};

const SCOPE_LABELS: Record<AnnouncementScope, string> = {
  general: "All Members",
  campaign_members: "Campaign Members",
  social_members: "Social Members",
  election_officers: "Election Officers",
  admins: "Admins",
};

const SCOPE_ICONS: Record<AnnouncementScope, React.ReactNode> = {
  general: <Users className="h-4 w-4" />,
  campaign_members: <Target className="h-4 w-4" />,
  social_members: <Users className="h-4 w-4" />,
  election_officers: <Shield className="h-4 w-4" />,
  admins: <UserCog className="h-4 w-4" />,
};

// ─── PAGE ───

export default function AdminAnnouncementsPage() {
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<PortalAnnouncement[]>([]);

  // Form state
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [announcementForm, setAnnouncementForm] = useState(DEFAULT_ANNOUNCEMENT);

  // ─── AUTH GUARD ───

  useEffect(() => {
    if (authLoading) return;
    if (!profile || profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  // ─── LOAD ───

  const loadContent = useCallback(async () => {
    try {
      setLoading(true);
      setItems(await listAllAnnouncements());
    } catch (err) {
      console.error("Failed to load announcements:", err);
      toast.error("We couldn't load the announcements. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      void Promise.resolve().then(loadContent);
    }
  }, [authLoading, profile, loadContent]);

  // ─── FORM HANDLERS ───

  const resetForm = () => {
    setAnnouncementForm(DEFAULT_ANNOUNCEMENT);
    setIsEditing(false);
    setEditingId(null);
  };

  const startEdit = (item: PortalAnnouncement) => {
    setAnnouncementForm({
      title: item.title,
      content: item.content,
      scope: item.scope,
      status: item.status,
    });
    setIsEditing(true);
    setEditingId(item.id);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!announcementForm.title.trim()) {
      toast.warning("Please enter a title for the announcement.");
      return;
    }
    if (!announcementForm.content.trim()) {
      toast.warning("Please write the announcement content.");
      return;
    }

    setSaving(true);

    try {
      if (isEditing && editingId) {
        await updateAnnouncement(editingId, announcementForm);
        toast.success("Announcement updated successfully.");
      } else {
        await createAnnouncement(announcementForm);
        toast.success("Announcement added successfully.");
      }
      resetForm();
      await loadContent();
    } catch (err) {
      console.error("Failed to save announcement:", err);
      toast.error(getErrorMessage(err, "We couldn't save the announcement. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this announcement?")) return;
    try {
      await deleteAnnouncement(id);
      await loadContent();
      toast.success("Deleted successfully.");
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error(getErrorMessage(err, "We couldn't delete the announcement. Please try again."));
    }
  };

  // ─── LOADING ───

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading...</span>
      </div>
    );
  }

  if (!profile || profile.access_role !== "admin") {
    return null;
  }

  const showAnnouncementForm = isEditing;

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
          <p className="text-sm text-gray-500">
            Authenticated member communications. Published announcements are visible to eligible
            members in the portal — never on the public site.
          </p>
        </div>
        {!isEditing && (
          <button
            onClick={() => {
              setIsEditing(true);
              setEditingId(null);
              setAnnouncementForm(DEFAULT_ANNOUNCEMENT);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors"
          >
            <Megaphone className="h-4 w-4" />
            New Announcement
          </button>
        )}
      </div>

      {/* ─── FORM ─── */}
      {showAnnouncementForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? "Edit Announcement" : "New Announcement"}
            </h2>
            <button onClick={resetForm} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Title *
              </label>
              <input
                value={announcementForm.title}
                onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                placeholder="e.g. Volunteer Meeting Saturday"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Content *
              </label>
              <textarea
                rows={4}
                value={announcementForm.content}
                onChange={(e) => setAnnouncementForm({ ...announcementForm, content: e.target.value })}
                placeholder="Write the announcement details..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Audience
              </label>
              <select
                value={announcementForm.scope}
                onChange={(e) => setAnnouncementForm({ ...announcementForm, scope: e.target.value as AnnouncementScope })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                {Object.entries(SCOPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={announcementForm.status === "published"}
                  onChange={(e) =>
                    setAnnouncementForm({
                      ...announcementForm,
                      status: e.target.checked ? "published" : "draft",
                    })
                  }
                  className="rounded border-gray-300 text-brand-primary focus:ring-brand-primary"
                />
                <span className="text-sm text-gray-700">Publish to eligible members</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : editingId ? "Update Announcement" : "Create Announcement"}
            </button>
          </form>
        </div>
      )}

      {/* ─── LIST ─── */}
      <div className="space-y-4">
        {items.length === 0 ? (
          <div className="rounded-2xl bg-white border-2 border-dashed border-gray-300 p-12 text-center">
            <Megaphone className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500">No announcements created yet.</p>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-gray-900">{item.title}</h3>
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {SCOPE_ICONS[item.scope]}
                    {SCOPE_LABELS[item.scope]}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      item.status === "published"
                        ? "bg-green-100 text-green-700"
                        : item.status === "archived"
                          ? "bg-gray-200 text-gray-600"
                          : "bg-yellow-100 text-yellow-700"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-600 line-clamp-2">{item.content}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                {item.status === "published" ? (
                  <button
                    onClick={() => updateAnnouncement(item.id, { status: "archived" }).then(loadContent)}
                    title="Archive"
                    className="p-2 text-gray-500 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                ) : item.status === "draft" ? (
                  <button
                    onClick={() => updateAnnouncement(item.id, { status: "published" }).then(loadContent)}
                    title="Publish"
                    className="p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                ) : null}
                <button
                  onClick={() => startEdit(item)}
                  className="p-2 text-gray-500 hover:text-brand-primary hover:bg-brand-primary/10 rounded-lg transition-colors"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
