// src/app/portal/admin/announcements/page.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Trash2,
  AlertCircle,
  CheckCircle,
  X,
  Edit2,
  Save,
  Calendar,
  MapPin,
  Clock,
  Megaphone,
  Users,
  Target,
  Shield,
  UserCog,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import {
  getPortalContent,
  addAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  addEvent,
  updateEvent,
  deleteEvent,
} from "@/lib/firebase/portal-content";
import { getCurrentTenant } from "@/lib/firebase/tenants";
import { getAllLGAs } from "@/lib/constants";
import type { Announcement, AnnouncementScope, EventData, LGA } from "@/types";

// ─── DEFAULTS ───

const DEFAULT_ANNOUNCEMENT: Omit<Announcement, "id" | "type" | "created_at" | "updated_at"> = {
  title: "",
  content: "",
  scope: "general",
};

const DEFAULT_EVENT: Omit<EventData, "id" | "type" | "created_at" | "updated_at"> = {
  title: "",
  description: "",
  date: new Date().toISOString().split("T")[0],
  time: "10:00",
  venue: "",
  ward: "",
  // Default to published so new events appear on the public homepage
  // immediately; admins can untick "Publish now" to keep a draft.
  status: "published",
};

type Tab = "announcements" | "events";

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
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<(Announcement | EventData)[]>([]);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [tenantId, setTenantId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("announcements");

  // Form state
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState<"announcement" | "event">("announcement");
  const [announcementForm, setAnnouncementForm] = useState(DEFAULT_ANNOUNCEMENT);
  const [eventForm, setEventForm] = useState(DEFAULT_EVENT);

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
      setError(null);
      const tenant = await getCurrentTenant();
      setTenantId(tenant.id);
      const [data, lgasData] = await Promise.all([
        getPortalContent(tenant.id),
        getAllLGAs(),
      ]);
      setItems(data);
      setLgas(lgasData);
    } catch (err) {
      console.error("Failed to load content:", err);
      setError("Unable to load content. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      loadContent();
    }
  }, [authLoading, profile, loadContent]);

  // ─── FILTERS ───

  const announcements = items.filter((item): item is Announcement => item.type === "announcement");
  const events = items.filter((item): item is EventData => item.type === "event");

  // ─── FORM HANDLERS ───

  const resetForms = () => {
    setAnnouncementForm(DEFAULT_ANNOUNCEMENT);
    setEventForm(DEFAULT_EVENT);
    setIsEditing(false);
    setEditingId(null);
  };

  const startEditAnnouncement = (item: Announcement) => {
    setFormType("announcement");
    setAnnouncementForm({
      title: item.title,
      content: item.content,
      scope: item.scope,
    });
    setIsEditing(true);
    setEditingId(item.id);
  };

  const startEditEvent = (item: EventData) => {
    setFormType("event");
    setEventForm({
      title: item.title,
      description: item.description || "",
      date: item.date,
      time: item.time,
      venue: item.venue,
      ward: item.ward,
      status: item.status,
    });
    setIsEditing(true);
    setEditingId(item.id);
  };

  const handleSubmitAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!announcementForm.title.trim()) {
      setError("Announcement title is required.");
      return;
    }
    if (!announcementForm.content.trim()) {
      setError("Announcement content is required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isEditing && editingId) {
        await updateAnnouncement(tenantId, editingId, {
          ...announcementForm,
        });
        setSuccess("Announcement updated successfully!");
      } else {
        await addAnnouncement(tenantId, {
          type: "announcement",
          ...announcementForm,
        });
        setSuccess("Announcement added successfully!");
      }
      resetForms();
      await loadContent();
    } catch (err) {
      console.error("Failed to save announcement:", err);
      setError("Failed to save announcement.");
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventForm.title.trim()) {
      setError("Event title is required.");
      return;
    }
    if (!eventForm.venue.trim()) {
      setError("Venue is required.");
      return;
    }
    if (!eventForm.ward) {
      setError("Ward is required.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isEditing && editingId) {
        await updateEvent(tenantId, editingId, eventForm);
        setSuccess("Event updated successfully!");
      } else {
        await addEvent(tenantId, eventForm);
        setSuccess("Event added successfully!");
      }
      resetForms();
      await loadContent();
    } catch (err) {
      console.error("Failed to save event:", err);
      setError("Failed to save event.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this item?")) return;
    try {
      // Check if it's an announcement or event
      const item = items.find((i) => i.id === id);
      if (!item) return;

      if (item.type === "announcement") {
        await deleteAnnouncement(tenantId, id);
      } else {
        await deleteEvent(tenantId, id);
      }
      await loadContent();
      setSuccess("Deleted successfully.");
    } catch (err) {
      console.error("Failed to delete:", err);
      setError("Failed to delete.");
    }
  };

  // ─── LOADING ───

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading...</span>
      </div>
    );
  }

  if (!profile || profile.access_role !== "admin") {
    return null;
  }

  const wardOptions = lgas.flatMap((lga) =>
    lga.wards.map((ward) => ({
      value: ward.id,
      label: `${lga.name} — ${ward.code} — ${ward.name}`,
    }))
  );

  const showAnnouncementForm = isEditing && formType === "announcement";
  const showEventForm = isEditing && formType === "event";

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Announcements & Events</h1>
          <p className="text-sm text-gray-500">
            Manage portal announcements and public homepage events.
          </p>
        </div>
        {!isEditing && (
          <div className="flex gap-2">
            <button
              onClick={() => {
                setFormType("announcement");
                setIsEditing(true);
                setEditingId(null);
                setAnnouncementForm(DEFAULT_ANNOUNCEMENT);
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors"
            >
              <Megaphone className="h-4 w-4" />
              New Announcement
            </button>
            <button
              onClick={() => {
                setFormType("event");
                setIsEditing(true);
                setEditingId(null);
                setEventForm(DEFAULT_EVENT);
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-secondary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-secondary/80 transition-colors"
            >
              <Calendar className="h-4 w-4" />
              New Event
            </button>
          </div>
        )}
      </div>

      {/* ─── NOTIFICATIONS ─── */}
      {error && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {success && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 shrink-0" />
            <span>{success}</span>
          </div>
          <button onClick={() => setSuccess(null)} className="text-green-500 hover:text-green-700">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ─── FORMS ─── */}
      {showAnnouncementForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? "Edit Announcement" : "New Announcement"}
            </h2>
            <button onClick={resetForms} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>

          <form onSubmit={handleSubmitAnnouncement} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Title *
              </label>
              <input
                value={announcementForm.title}
                onChange={(e) => setAnnouncementForm({ ...announcementForm, title: e.target.value })}
                placeholder="e.g. Volunteer Meeting Saturday"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
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

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : editingId ? "Update Announcement" : "Create Announcement"}
            </button>
          </form>
        </div>
      )}

      {showEventForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? "Edit Event" : "New Event"}
            </h2>
            <button onClick={resetForms} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>

          <form onSubmit={handleSubmitEvent} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Event Title *
              </label>
              <input
                value={eventForm.title}
                onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
                placeholder="e.g. Ward-to-Ward Campaign Tour"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                rows={3}
                value={eventForm.description}
                onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
                placeholder="Describe the event..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date *
                </label>
                <input
                  type="date"
                  value={eventForm.date}
                  onChange={(e) => setEventForm({ ...eventForm, date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Time *
                </label>
                <input
                  type="time"
                  value={eventForm.time}
                  onChange={(e) => setEventForm({ ...eventForm, time: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Venue *
              </label>
              <input
                value={eventForm.venue}
                onChange={(e) => setEventForm({ ...eventForm, venue: e.target.value })}
                placeholder="e.g. Agbani Town Hall"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ward *
              </label>
              <select
                value={eventForm.ward}
                onChange={(e) => setEventForm({ ...eventForm, ward: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                required
              >
                <option value="">Select ward</option>
                {wardOptions.map((ward) => (
                  <option key={ward.value} value={ward.value}>
                    {ward.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={eventForm.status === "published"}
                  onChange={(e) =>
                    setEventForm({ ...eventForm, status: e.target.checked ? "published" : "draft" })
                  }
                  className="rounded border-gray-300 text-apc-primary focus:ring-apc-primary"
                />
                <span className="text-sm text-gray-700">Publish now (shown on homepage)</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : editingId ? "Update Event" : "Create Event"}
            </button>
          </form>
        </div>
      )}

      {/* ─── TABS ─── */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab("announcements")}
            className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "announcements"
                ? "border-apc-primary text-apc-primary"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Announcements ({announcements.length})
          </button>
          <button
            onClick={() => setActiveTab("events")}
            className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "events"
                ? "border-apc-primary text-apc-primary"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Events ({events.length})
          </button>
        </nav>
      </div>

      {/* ─── LIST ─── */}
      {activeTab === "announcements" && (
        <div className="space-y-4">
          {announcements.length === 0 ? (
            <div className="rounded-2xl bg-white border-2 border-dashed border-gray-300 p-12 text-center">
              <Megaphone className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No announcements created yet.</p>
            </div>
          ) : (
            announcements.map((item) => (
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
                  </div>
                  <p className="mt-1 text-sm text-gray-600 line-clamp-2">{item.content}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEditAnnouncement(item)}
                    className="p-2 text-gray-500 hover:text-apc-primary hover:bg-apc-primary/10 rounded-lg transition-colors"
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
      )}

      {activeTab === "events" && (
        <div className="space-y-4">
          {events.length === 0 ? (
            <div className="rounded-2xl bg-white border-2 border-dashed border-gray-300 p-12 text-center">
              <Calendar className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No events created yet.</p>
            </div>
          ) : (
            events.map((item) => (
              <div
                key={item.id}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-gray-900">{item.title}</h3>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        item.status === "published"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" />
                      {formatDate(item.date)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {item.time}
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" />
                      {item.venue}
                    </span>
                  </div>
                  {item.description && (
                    <p className="mt-1 text-sm text-gray-600 line-clamp-1">{item.description}</p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => startEditEvent(item)}
                    className="p-2 text-gray-500 hover:text-apc-primary hover:bg-apc-primary/10 rounded-lg transition-colors"
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
      )}
    </div>
  );
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
