"use client";

import { useEffect, useState } from "react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { Calendar, MapPin, Clock, Loader2, AlertCircle } from "lucide-react";
import { listPublishedEvents, type SiteEvent } from "@/lib/supabase";
import { useToast } from "@/components/ui/toast";

export default function EventsPage() {
  const [events, setEvents] = useState<SiteEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    async function loadEvents() {
      try {
        setLoading(true);
        const data = await listPublishedEvents();
        setEvents(data);
      } catch (err: unknown) {
        console.error("Error loading events:", err);
        toast.error("Unable to load events. Please check your connection and try again.");
      } finally {
        setLoading(false);
      }
    }

    loadEvents();
  }, []);

  function formatDate(dateStr: string) {
    if (!dateStr) return "";
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function formatTime(timeStr: string) {
    if (!timeStr) return "";
    const [h, m] = timeStr.split(":").map(Number);
    if (Number.isNaN(h)) return timeStr;
    const ampm = h >= 12 ? "PM" : "AM";
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${String(m ?? 0).padStart(2, "0")} ${ampm}`;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-10 text-center sm:text-left">
          <h1 className="text-3xl font-bold text-brand-primary sm:text-4xl">Upcoming Events</h1>
          <p className="mt-2 text-gray-600 text-lg">
            Town halls, ward engagements and campaign activities you can join.
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <Calendar className="h-10 w-10 mx-auto mb-3 text-gray-300" />
            <p className="text-lg">No upcoming events at this time. Please check back soon.</p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {events.map((event) => (
              <article
                key={event.id}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center gap-2 text-sm text-brand-primary font-semibold">
                  <Calendar className="h-4 w-4" />
                  <time dateTime={`${event.event_date}T${event.event_time}`}>
                    {formatDate(event.event_date)}
                  </time>
                </div>
                <h2 className="mt-3 text-xl font-semibold text-gray-900">{event.title}</h2>
                {event.description ? (
                  <p className="mt-2 text-gray-600 line-clamp-3">{event.description}</p>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-500">
                  {event.event_time ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="h-4 w-4" />
                      {formatTime(event.event_time)}
                    </span>
                  ) : null}
                  {event.venue ? (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="h-4 w-4" />
                      {event.venue}
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="mt-10 flex items-center justify-center gap-2 text-sm text-gray-400">
          <AlertCircle className="h-4 w-4" />
          Event details are published by the campaign and may be updated or cancelled.
        </div>
      </main>

      <Footer />
    </div>
  );
}
