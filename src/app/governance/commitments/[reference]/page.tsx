"use client";

/**
 * POLITICORE — PUBLIC COMMITMENT DETAIL (Phase 18).
 *
 * Published commitment through the 0057 projection: status, progress,
 * source lineage and PUBLIC updates. Publication never implies delivery;
 * source_ref is a human-readable anchor, never an internal id.
 */

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  GOVERNANCE_COMMITMENT_STATUS_LABELS,
  getPublicGovernanceCommitment,
  listPublicGovernanceCommitmentProjects,
  type PublicGovernanceCommitment,
  type PublicGovernanceLinkedProject,
} from "@/lib/supabase/governance";

export default function PublicCommitmentPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = use(params);
  const [commitment, setCommitment] = useState<PublicGovernanceCommitment | null>(null);
  const [projects, setProjects] = useState<PublicGovernanceLinkedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        const [c, p] = await Promise.all([
          getPublicGovernanceCommitment(siteSlug, reference),
          listPublicGovernanceCommitmentProjects(siteSlug, reference),
        ]);
        setCommitment(c[0] ?? null);
        setProjects(p);
      } catch (err: unknown) {
        console.error("Error loading commitment:", err);
      } finally {
        setLoading(false);
        setChecked(true);
      }
    }
    void load();
  }, [reference]);

  const statusLabel = (s: string) =>
    (GOVERNANCE_COMMITMENT_STATUS_LABELS as Record<string, string>)[s] ?? s;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : !commitment ? (
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
              <p className="text-xs font-medium tracking-wide text-gray-500">{commitment.reference_code}</p>
              <h1 className="mt-1 text-2xl font-bold text-gray-900">{commitment.title}</h1>
              <p className="mt-1 text-sm text-gray-500">
                {statusLabel(commitment.status)} · {commitment.progress_percent}%
                {commitment.category_label ? ` · ${commitment.category_label}` : ""}
              </p>
            </div>

            <div className="h-2 w-full rounded-full bg-gray-200">
              <div className="h-2 rounded-full bg-[#008751]" style={{ width: `${commitment.progress_percent}%` }} />
            </div>

            <Card>
              <CardContent className="p-5">
                <p className="whitespace-pre-wrap text-sm text-gray-700">{commitment.details}</p>
                <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  {commitment.source_ref && (<><dt className="text-gray-500">Source</dt><dd className="text-gray-900">{commitment.source_ref}</dd></>)}
                  {commitment.target_description && (<><dt className="text-gray-500">What delivery means</dt><dd className="text-gray-900">{commitment.target_description}</dd></>)}
                  {commitment.target_date && (<><dt className="text-gray-500">Target date</dt><dd className="text-gray-900">{commitment.target_date}</dd></>)}
                  {commitment.completed_at && (<><dt className="text-gray-500">Delivered</dt><dd className="text-gray-900">{commitment.completed_at}</dd></>)}
                </dl>
              </CardContent>
            </Card>

            {projects.length > 0 && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-3 font-semibold text-gray-900">Delivery projects</h2>
                  <ul className="space-y-3">
                    {projects.map((p) => (
                      <li key={p.reference_code}>
                        <Link href={`/governance/projects/${p.reference_code}`} className="font-medium text-[#008751] hover:underline">
                          {p.title}
                        </Link>
                        <p className="text-xs text-gray-500">{p.status} · {p.progress_percent}%</p>
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
