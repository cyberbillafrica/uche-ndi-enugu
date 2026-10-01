"use client";

/**
 * POLITICORE — PUBLIC GOVERNANCE HUB (Phase 18).
 *
 * Accountability discovery over the 0057 narrow SECURITY DEFINER
 * projections. Only explicitly published records appear (is_public +
 * per-domain eligibility, enforced by the RPCs — never base tables).
 * Tenant resolves server-side by public site slug; the browser never
 * supplies a tenant id or any authority value.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban, Handshake, Landmark, Loader2, MessageSquareText, ScrollText, UsersRound } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  listPublicGovernanceHub,
  listPublicGovernanceProjects,
  listPublicGovernanceCommitments,
  listPublicGovernanceEngagements,
  type PublicGovernanceHub,
  type PublicGovernanceProjectSummary,
  type PublicGovernanceCommitmentSummary,
  type PublicGovernanceEngagementSummary,
} from "@/lib/supabase/governance";
import { useToast } from "@/components/ui/toast";

export default function GovernanceHubPage() {
  const [hub, setHub] = useState<PublicGovernanceHub | null>(null);
  const [projects, setProjects] = useState<PublicGovernanceProjectSummary[]>([]);
  const [commitments, setCommitments] = useState<PublicGovernanceCommitmentSummary[]>([]);
  const [engagements, setEngagements] = useState<PublicGovernanceEngagementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        const [h, p, c, e] = await Promise.all([
          listPublicGovernanceHub(siteSlug),
          listPublicGovernanceProjects(siteSlug),
          listPublicGovernanceCommitments(siteSlug),
          listPublicGovernanceEngagements(siteSlug),
        ]);
        setHub(h[0] ?? null);
        setProjects(p);
        setCommitments(c);
        setEngagements(e);
      } catch (err: unknown) {
        console.error("Error loading governance hub:", err);
        toast.error("Unable to load governance records. Please check your connection and try again.");
      } finally {
        setLoading(false);
      }
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <section className="bg-[#008751] py-16 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Landmark className="h-8 w-8" />
            <h1 className="text-3xl font-bold sm:text-4xl">Governance</h1>
          </div>
          <p className="mt-3 max-w-3xl text-white/90">
            Published accountability records — projects, commitments, participation
            and engagements. Only records deliberately published for public
            accountability appear here. Participation intake lives at{" "}
            <Link href="/request" className="underline">Submit a Request</Link>{" "}
            and open instruments at{" "}
            <Link href="/governance/participate" className="underline">Participate</Link>.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading published records…
          </div>
        ) : (
          <div className="space-y-12">
            {projects.length > 0 && (
              <section>
                <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-gray-900">
                  <FolderKanban className="h-5 w-5 text-[#008751]" /> Projects ({projects.length})
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {projects.map((p) => (
                    <Link key={p.reference_code} href={`/governance/projects/${p.reference_code}`}>
                      <Card className="h-full transition-shadow hover:shadow-md">
                        <CardContent className="p-5">
                          <p className="text-xs font-medium tracking-wide text-gray-500">{p.reference_code}</p>
                          <h3 className="mt-1 font-semibold text-gray-900">{p.title}</h3>
                          <p className="mt-2 line-clamp-2 text-sm text-gray-600">{p.description}</p>
                          <div className="mt-3">
                            <div className="h-1.5 w-full rounded-full bg-gray-200">
                              <div className="h-1.5 rounded-full bg-[#008751]" style={{ width: `${p.progress_percent}%` }} />
                            </div>
                            <p className="mt-1 text-xs text-gray-500">{p.progress_percent}% · {p.status}</p>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {commitments.length > 0 && (
              <section>
                <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-gray-900">
                  <Handshake className="h-5 w-5 text-[#008751]" /> Commitments ({commitments.length})
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {commitments.map((c) => (
                    <Link key={c.reference_code} href={`/governance/commitments/${c.reference_code}`}>
                      <Card className="h-full transition-shadow hover:shadow-md">
                        <CardContent className="p-5">
                          <p className="text-xs font-medium tracking-wide text-gray-500">{c.reference_code}</p>
                          <h3 className="mt-1 font-semibold text-gray-900">{c.title}</h3>
                          <p className="mt-2 line-clamp-2 text-sm text-gray-600">{c.details}</p>
                          <p className="mt-3 text-xs text-gray-500">{c.progress_percent}% · {c.status}</p>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {engagements.length > 0 && (
              <section>
                <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-gray-900">
                  <UsersRound className="h-5 w-5 text-[#008751]" /> Engagements ({engagements.length})
                </h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {engagements.map((e) => (
                    <Link key={e.reference_code} href={`/governance/engagements/${e.reference_code}`}>
                      <Card className="h-full transition-shadow hover:shadow-md">
                        <CardContent className="p-5">
                          <p className="text-xs font-medium tracking-wide text-gray-500">{e.reference_code}</p>
                          <h3 className="mt-1 font-semibold text-gray-900">{e.title}</h3>
                          <p className="mt-2 line-clamp-2 text-sm text-gray-600">{e.description}</p>
                          <p className="mt-3 text-xs text-gray-500">
                            {e.location} · {e.held_at ? `Held` : e.status}
                            {e.attendance_count > 0 ? ` · ${e.attendance_count} attended` : ""}
                          </p>
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {hub && (hub.open_consultations > 0 || hub.published_petitions > 0 || hub.published_poll_results > 0) && (
              <section>
                <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-gray-900">
                  <MessageSquareText className="h-5 w-5 text-[#008751]" /> Participation
                </h2>
                <Card>
                  <CardContent className="p-5">
                    <p className="text-sm text-gray-600">
                      {hub.open_consultations > 0 && `${hub.open_consultations} open consultation(s) · `}
                      {hub.published_petitions > 0 && `${hub.published_petitions} published petition(s) · `}
                      {hub.published_poll_results > 0 && `${hub.published_poll_results} published poll result(s)`}
                    </p>
                    <Link href="/governance/participate" className="mt-2 inline-block text-sm font-medium text-[#008751] hover:underline">
                      View open participation →
                    </Link>
                  </CardContent>
                </Card>
              </section>
            )}

            {hub && hub.stats_available && (
              <section>
                <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-gray-900">
                  <ScrollText className="h-5 w-5 text-[#008751]" /> Request statistics
                </h2>
                <Card>
                  <CardContent className="p-5">
                    <p className="text-sm text-gray-600">
                      Aggregate, privacy-bucketed request statistics for this area — counts only, never case details.
                    </p>
                    <Link href="/governance/statistics" className="mt-2 inline-block text-sm font-medium text-[#008751] hover:underline">
                      View request statistics →
                    </Link>
                  </CardContent>
                </Card>
              </section>
            )}

            {!hub && (
              <Card>
                <CardContent className="p-10 text-center text-gray-500">
                  No published governance records are available yet.
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
