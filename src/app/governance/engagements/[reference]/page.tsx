"use client";

/**
 * POLITICORE — PUBLIC ENGAGEMENT DETAIL (Phase 18).
 *
 * Published Engagement PROCESS record via the 0057 projection: summary,
 * agenda, outcomes, attendance COUNT, public updates and the optional
 * linked public Event's title/date/venue (one-way, content-only). The
 * stakeholder roster, attendance roster and internal issues are structurally
 * absent from the RPC — they cannot leak through this page.
 */

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  GOVERNANCE_ENGAGEMENT_STATUS_LABELS,
  getPublicGovernanceEngagement,
  listPublicGovernanceEngagementUpdates,
  type PublicGovernanceEngagement,
  type PublicGovernanceUpdate,
} from "@/lib/supabase/governance";

interface AgendaItem {
  title?: string;
  description?: string;
  start?: string;
}

export default function PublicEngagementPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = use(params);
  const [engagement, setEngagement] = useState<PublicGovernanceEngagement | null>(null);
  const [updates, setUpdates] = useState<PublicGovernanceUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        const [e, u] = await Promise.all([
          getPublicGovernanceEngagement(siteSlug, reference),
          listPublicGovernanceEngagementUpdates(siteSlug, reference),
        ]);
        setEngagement(e[0] ?? null);
        setUpdates(u);
      } catch (err: unknown) {
        console.error("Error loading engagement:", err);
      } finally {
        setLoading(false);
        setChecked(true);
      }
    }
    void load();
  }, [reference]);

  const statusLabel = (s: string) =>
    (GOVERNANCE_ENGAGEMENT_STATUS_LABELS as Record<string, string>)[s] ?? s;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : !engagement ? (
          checked && (
            <Card>
              <CardContent className="p-10 text-center">
                <p className="font-medium text-gray-900">Record not available</p>
                <p className="mt-1 text-sm text-gray-500">
                  This governance record is not published for public view.
                </p>
                <Link href="/governance" className="mt-4 inline-block text-sm font-medium text-[#008751] hover:underline">
                  <ArrowLeft className="mr-1 inline h-4 w-4" /> Back to Governance
                </Link>
              </CardContent>
            </Card>
          )
        ) : (
          <div className="space-y-6">
            <Link href="/governance" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-800">
              <ArrowLeft className="mr-1 h-4 w-4" /> Governance
            </Link>
            <div>
              <p className="text-xs font-medium tracking-wide text-gray-500">{engagement.reference_code}</p>
              <h1 className="mt-1 text-2xl font-bold text-gray-900">{engagement.title}</h1>
              <p className="mt-1 text-sm text-gray-500">
                {statusLabel(engagement.status)}
                {engagement.location ? ` · ${engagement.location}` : ""}
                {engagement.scheduled_at ? ` · ${new Date(engagement.scheduled_at).toLocaleString()}` : ""}
                {engagement.held_at ? ` · held ${new Date(engagement.held_at).toLocaleDateString()}` : ""}
              </p>
            </div>

            {engagement.description && (
              <Card>
                <CardContent className="p-5">
                  <p className="whitespace-pre-wrap text-sm text-gray-700">{engagement.description}</p>
                </CardContent>
              </Card>
            )}

            {engagement.event_title && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-1 font-semibold text-gray-900">Related event</h2>
                  <p className="text-sm text-gray-700">
                    {engagement.event_title}
                    {engagement.event_date ? ` · ${engagement.event_date}` : ""}
                    {engagement.event_venue ? ` · ${engagement.event_venue}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    Event content lives in the Events section; this link is informational only.
                  </p>
                </CardContent>
              </Card>
            )}

            {Array.isArray(engagement.agenda) && engagement.agenda.length > 0 && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-3 font-semibold text-gray-900">Agenda</h2>
                  <ul className="space-y-3">
                    {(engagement.agenda as AgendaItem[]).map((a, i) => (
                      <li key={i} className="border-l-2 border-[#008751] pl-3">
                        <p className="font-medium text-gray-900">{a.title ?? `Item ${i + 1}`}</p>
                        {a.description && <p className="text-sm text-gray-600">{a.description}</p>}
                        {a.start && <p className="text-xs text-gray-500">{a.start}</p>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {engagement.outcomes && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-2 font-semibold text-gray-900">Outcomes</h2>
                  <p className="whitespace-pre-wrap text-sm text-gray-700">{engagement.outcomes}</p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="p-5">
                <h2 className="mb-1 font-semibold text-gray-900">Attendance</h2>
                <p className="text-sm text-gray-700">
                  {engagement.attendance_count > 0
                    ? `${engagement.attendance_count} participant(s) attended.`
                    : "No attendance recorded."}
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Only the aggregate count is public — individual attendance is never published.
                </p>
              </CardContent>
            </Card>

            {updates.length > 0 && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-3 font-semibold text-gray-900">Public updates</h2>
                  <ul className="space-y-4">
                    {updates.map((u, i) => (
                      <li key={i} className="border-b border-gray-100 pb-3 last:border-0">
                        <p className="font-medium text-gray-900">{u.title || u.kind}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{u.body}</p>
                        <p className="mt-1 text-xs text-gray-400">{new Date(u.created_at).toLocaleDateString()}</p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
