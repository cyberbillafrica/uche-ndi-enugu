"use client";

/**
 * POLITICORE — PUBLIC REQUEST STATISTICS (Phase 18).
 *
 * Aggregate-only, privacy-bucketed request statistics (0057 resolution of
 * Phase 11 §29 Open Decision 4). The RPC returns buckets — never raw
 * counts — and no case contents. A "1–5" bucket deliberately cannot be
 * distinguished from zero-ish density to prevent reidentification of the
 * single citizen behind a small ward count.
 */

import { useEffect, useState } from "react";
import { Loader2, ScrollText } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  listPublicGovernanceRequestStats,
  type PublicGovernanceRequestStat,
} from "@/lib/supabase/governance";
import { useToast } from "@/components/ui/toast";

const LEVEL_LABEL: Record<string, string> = {
  ward: "Ward",
  lga: "LGA",
  state: "State",
};

export default function GovernanceStatisticsPage() {
  const [stats, setStats] = useState<PublicGovernanceRequestStat[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        setStats(await listPublicGovernanceRequestStats(siteSlug));
      } catch (err: unknown) {
        console.error("Error loading statistics:", err);
        toast.error("Unable to load request statistics. Please check your connection and try again.");
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
            <ScrollText className="h-7 w-7" /> Request statistics
          </h1>
          <p className="mt-2 max-w-3xl text-white/90">
            Aggregate accountability statistics for citizen requests. Counts are
            privacy-bucketed (0 · 1–5 · 6–20 · 21–50 · 51+) so no individual
            case can be identified; case details are never published.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : stats.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-gray-500">
              No request statistics are available yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="px-4 py-3">Area</th>
                    <th className="px-4 py-3">Level</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">Open</th>
                    <th className="px-4 py-3">Resolved</th>
                    <th className="px-4 py-3">Median resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={`${s.scope_level}-${s.scope_name}`} className="border-b border-gray-100">
                      <td className="px-4 py-3 font-medium text-gray-900">{s.scope_name}</td>
                      <td className="px-4 py-3 text-gray-600">{LEVEL_LABEL[s.scope_level] ?? s.scope_level}</td>
                      <td className="px-4 py-3 text-gray-600">{s.total_bucket}</td>
                      <td className="px-4 py-3 text-gray-600">{s.open_bucket}</td>
                      <td className="px-4 py-3 text-gray-600">{s.resolved_bucket}</td>
                      <td className="px-4 py-3 text-gray-600">{s.resolution_days_bucket === "-" ? "—" : `${s.resolution_days_bucket} days`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>
      <Footer />
    </div>
  );
}
