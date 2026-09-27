// src/app/portal/announcements/page.tsx

"use client";

import { useState, useEffect } from "react";
import { Loader2, Megaphone, Users, Target, Shield, UserCog } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { listAnnouncements, type PortalAnnouncement, type AnnouncementScope } from "@/lib/supabase";

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

/**
 * Authenticated portal announcements. Rows are RLS-scoped: the member sees
 * published announcements in their membership scope, inside their own
 * tenant. Anonymous visitors have no grant on the table at all.
 */
export default function PortalAnnouncementsPage() {
  const { loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<PortalAnnouncement[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await listAnnouncements();
        if (!cancelled) setItems(data);
      } catch (err) {
        console.error("Failed to load announcements:", err);
        if (!cancelled) setError("We couldn't load the announcements. Please refresh and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading]);

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading...</span>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
        <p className="text-sm text-gray-500">
          Updates shared with you by the campaign team.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-100 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="rounded-2xl bg-white border-2 border-dashed border-gray-300 p-12 text-center">
          <Megaphone className="h-12 w-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No announcements right now.</p>
        </div>
      )}

      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-gray-900">{item.title}</h2>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                {SCOPE_ICONS[item.scope]}
                {SCOPE_LABELS[item.scope]}
              </span>
            </div>
            <p className="mt-2 text-sm text-gray-700 whitespace-pre-line">{item.content}</p>
            <p className="mt-3 text-xs text-gray-400">
              {new Date(item.created_at).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
