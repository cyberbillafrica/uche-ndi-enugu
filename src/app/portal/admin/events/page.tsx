// src/app/portal/admin/events/page.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Trash2,
  Edit2,
  Save,
  Calendar,
  MapPin,
  Clock,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  listLgas,
  listAllWards,
  type SiteEvent,
  type EventInput,
} from "@/lib/supabase";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";

// ─── DEFAULTS ───

const DEFAULT_EVENT: EventInput = {
  title: "",
  description: "",
  eventDate: new Date().toISOString().split("T")[0],
  eventTime: "10:00",
  venue: "",
  wardId: null,
  // Default to published so new events appear on the public website
  // immediately; admins can untick "Publish now" to keep a draft.
  status: "published",
};

// ─── PAGE ───

export default function AdminEventsPage() {
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<SiteEvent[]>([]);
  const [wardOptions, setWardOptions] = useState<{ value: string; label: string }[]>([]);

  // Form state
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eventForm, setEventForm] = useState<EventInput>(DEFAULT_EVENT);

  // ─── AUTH GUARD ───

  useEffect(() => {
    if (authLoading) return;
    if (!profile || profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  // ─── LOAD ───

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true);
      const [data, lgaData, wardData] = await Promise.all([
        listEvents(),
        listLgas(),
        listAllWards(),
      ]);
      setEvents(data);
      const lgaNames = new Map(lgaData.map((l) => [l.id, l.name]));
      setWardOptions(
        wardData.map((w) => ({
          value: w.id,
          label: `${lgaNames.get(w.lga_id) ?? w.lga_id} — ${w.code} — ${w.name}`,
        })),
      );
    } catch (err) {
      console.error("Failed to load events:", err);
      toast.error("We couldn't load the events. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      void Promise.resolve().then(loadEvents);
    }
  }, [authLoading, profile, loadEvents]);

  // ─── FORM HANDLERS ───

  const resetForm = () => {
    setEventForm(DEFAULT_EVENT);
    setIsEditing(false);
    setEditingId(null);
  };

  const startEdit = (item: SiteEvent) => {
    setEventForm({
      title: item.title,
      description: item.description || "",
      eventDate: item.event_date,
      eventTime: item.event_time,
      venue: item.venue,
      wardId: item.ward_id,
      status: item.status === "cancelled" ? "draft" : item.status,
    });
    setIsEditing(true);
    setEditingId(item.id);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventForm.title.trim()) {
      toast.warning("Please enter a title for the event.");
      return;
    }
    if (!eventForm.venue.trim()) {
      toast.warning("Please enter a venue for the event.");
      return;
    }
    if (!eventForm.wardId) {
      toast.warning("Please select the ward where this event takes place.");
      return;
    }

    setSaving(true);

    try {
      if (isEditing && editingId) {
        await updateEvent(editingId, eventForm);
        toast.success("Event updated successfully.");
      } else {
        await createEvent(eventForm);
        toast.success("Event added successfully.");
      }
      resetForm();
      await loadEvents();
    } catch (err) {
      console.error("Failed to save event:", err);
      toast.error(getErrorMessage(err, "We couldn't save the event. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this event?")) return;
    try {
      await deleteEvent(id);
      await loadEvents();
      toast.success("Deleted successfully.");
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error(getErrorMessage(err, "We couldn't delete the event. Please try again."));
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

  const showEventForm = isEditing;

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Events</h1>
          <p className="text-sm text-gray-500">
            Public website events. Published events appear on the public site and homepage.
          </p>
        </div>
        {!isEditing && (
          <button
            onClick={() => {
              setIsEditing(true);
              setEditingId(null);
              setEventForm(DEFAULT_EVENT);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-secondary px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-secondary/80 transition-colors"
          >
            <Calendar className="h-4 w-4" />
            New Event
          </button>
        )}
      </div>

      {/* ─── FORM ─── */}
      {showEventForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {editingId ? "Edit Event" : "New Event"}
            </h2>
            <button onClick={resetForm} className="text-sm text-gray-500 hover:text-gray-700">
              Cancel
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Event Title *
              </label>
              <input
                value={eventForm.title}
                onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
                placeholder="e.g. Ward-to-Ward Campaign Tour"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-transparent"
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-transparent"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date *
                </label>
                <input
                  type="date"
                  value={eventForm.eventDate}
                  onChange={(e) => setEventForm({ ...eventForm, eventDate: e.target.value })}
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
                  value={eventForm.eventTime}
                  onChange={(e) => setEventForm({ ...eventForm, eventTime: e.target.value })}
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
                value={eventForm.wardId ?? ""}
                onChange={(e) => setEventForm({ ...eventForm, wardId: e.target.value || null })}
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
                  className="rounded border-gray-300 text-brand-primary focus:ring-brand-primary"
                />
                <span className="text-sm text-gray-700">Publish now (shown on the public site)</span>
              </label>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving..." : editingId ? "Update Event" : "Create Event"}
            </button>
          </form>
        </div>
      )}

      {/* ─── LIST ─── */}
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
                        : item.status === "cancelled"
                          ? "bg-red-100 text-red-700"
                          : "bg-yellow-100 text-yellow-700"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-sm text-gray-500">
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" />
                    {formatDate(item.event_date)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {item.event_time}
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

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
