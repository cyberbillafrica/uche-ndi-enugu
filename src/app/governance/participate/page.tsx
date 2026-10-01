"use client";

/**
 * POLITICORE — PUBLIC PARTICIPATION HUB (Phase 18).
 *
 * Open consultations/surveys, published petitions with aggregate support,
 * and published poll results — via the 0057 narrow SECURITY DEFINER
 * projections only. Individual responses, signatures and votes are never
 * exposed by the underlying RPCs; the aggregate counts shown here are the
 * server-published results.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, MessageSquareText, ScrollText, Vote } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  listPublicGovernanceParticipate,
  type PublicGovernanceParticipateItem,
} from "@/lib/supabase/governance";
import { useToast } from "@/components/ui/toast";

const KIND_LABEL: Record<string, string> = {
  consultation: "Consultation",
  survey: "Survey",
  petition: "Petition",
  poll: "Poll results",
};

export default function GovernanceParticipatePage() {
  const [items, setItems] = useState<PublicGovernanceParticipateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        setItems(await listPublicGovernanceParticipate(siteSlug));
      } catch (err: unknown) {
        console.error("Error loading participation:", err);
        toast.error("Unable to load open participation. Please check your connection and try again.");
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
      <section className="bg-[#008751] py-12 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h1 className="flex items-center gap-3 text-3xl font-bold">
            <Vote className="h-7 w-7" /> Participate
          </h1>
          <p className="mt-2 max-w-3xl text-white/90">
            Open consultations, petitions and published poll results from the
            Governance module. Have a civic issue? Use{" "}
            <Link href="/request" className="underline">Submit a Request</Link>{" "}
            instead — requests stay private with aggregated public statistics.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-gray-500">
              No open participation instruments right now.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((it) => (
              <Link
                key={`${it.kind}-${it.reference_code}`}
                href={`/governance/participate/${it.kind}/${it.reference_code}`}
              >
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardContent className="p-5">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      {KIND_LABEL[it.kind] ?? it.kind}
                    </p>
                    <h3 className="mt-1 font-semibold text-gray-900">{it.title}</h3>
                    <p className="mt-2 line-clamp-2 text-sm text-gray-600">{it.description}</p>
                    <p className="mt-3 text-xs text-gray-500">
                      {it.status}
                      {it.closes_at ? ` · closes ${new Date(it.closes_at).toLocaleDateString()}` : ""}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <p className="mt-8 flex items-center gap-2 text-xs text-gray-400">
          <ScrollText className="h-3.5 w-3.5" /> Petition signatures, poll votes and
          survey responses are never public — only aggregate outcomes.
        </p>
        <p className="mt-2 flex items-center gap-2 text-xs text-gray-400">
          <MessageSquareText className="h-3.5 w-3.5" /> Governance participation is
          distinct from campaign activity.
        </p>
      </main>
      <Footer />
    </div>
  );
}
