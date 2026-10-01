"use client";

/**
 * POLITICORE — PUBLIC PROJECT DETAIL (Phase 18).
 *
 * Renders a PUBLISHED project through the 0057 projection. An unpublished
 * or nonexistent reference behaves identically (empty result → not
 * available) — no existence oracle. Explicit column allowlists only;
 * internal management fields (owner, budgets-in-progress, scopes) never
 * appear.
 */

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  GOVERNANCE_PROJECT_STATUS_LABELS,
  getPublicGovernanceProject,
  listPublicGovernanceProjectMilestones,
  listPublicGovernanceProjectUpdates,
  type PublicGovernanceProject,
  type PublicGovernanceMilestone,
  type PublicGovernanceUpdate,
} from "@/lib/supabase/governance";

export default function PublicProjectPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = use(params);
  const [project, setProject] = useState<PublicGovernanceProject | null>(null);
  const [milestones, setMilestones] = useState<PublicGovernanceMilestone[]>([]);
  const [updates, setUpdates] = useState<PublicGovernanceUpdate[]>([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        const [p, m, u] = await Promise.all([
          getPublicGovernanceProject(siteSlug, reference),
          listPublicGovernanceProjectMilestones(siteSlug, reference),
          listPublicGovernanceProjectUpdates(siteSlug, reference),
        ]);
        setProject(p[0] ?? null);
        setMilestones(m);
        setUpdates(u);
      } catch (err: unknown) {
        console.error("Error loading project:", err);
      } finally {
        setLoading(false);
        setChecked(true);
      }
    }
    void load();
  }, [reference]);

  const statusLabel = (s: string) =>
    (GOVERNANCE_PROJECT_STATUS_LABELS as Record<string, string>)[s] ?? s;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : !project ? (
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
              <p className="text-xs font-medium tracking-wide text-gray-500">{project.reference_code}</p>
              <h1 className="mt-1 text-2xl font-bold text-gray-900">{project.title}</h1>
              <p className="mt-1 text-sm text-gray-500">
                {statusLabel(project.status)} · {project.progress_percent}% complete
                {project.category_label ? ` · ${project.category_label}` : ""}
              </p>
            </div>

            <div className="h-2 w-full rounded-full bg-gray-200">
              <div className="h-2 rounded-full bg-[#008751]" style={{ width: `${project.progress_percent}%` }} />
            </div>

            {project.description && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-2 font-semibold text-gray-900">About</h2>
                  <p className="whitespace-pre-wrap text-sm text-gray-700">{project.description}</p>
                </CardContent>
              </Card>
            )}

            {(project.planned_start || project.planned_end || project.actual_start || project.actual_end || project.implementing_org || project.funding_source) && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-3 font-semibold text-gray-900">Delivery</h2>
                  <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    {project.implementing_org && (<><dt className="text-gray-500">Implementing</dt><dd className="text-gray-900">{project.implementing_org}</dd></>)}
                    {project.funding_source && (<><dt className="text-gray-500">Funding source</dt><dd className="text-gray-900">{project.funding_source}</dd></>)}
                    {project.planned_start && (<><dt className="text-gray-500">Planned start</dt><dd className="text-gray-900">{project.planned_start}</dd></>)}
                    {project.planned_end && (<><dt className="text-gray-500">Planned end</dt><dd className="text-gray-900">{project.planned_end}</dd></>)}
                    {project.actual_start && (<><dt className="text-gray-500">Actual start</dt><dd className="text-gray-900">{project.actual_start}</dd></>)}
                    {project.actual_end && (<><dt className="text-gray-500">Actual end</dt><dd className="text-gray-900">{project.actual_end}</dd></>)}
                    {project.beneficiaries_estimated != null && (<><dt className="text-gray-500">Estimated beneficiaries</dt><dd className="text-gray-900">{project.beneficiaries_estimated.toLocaleString()}</dd></>)}
                  </dl>
                  {project.beneficiary_summary && (
                    <p className="mt-3 text-sm text-gray-600">{project.beneficiary_summary}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {milestones.length > 0 && (
              <Card>
                <CardContent className="p-5">
                  <h2 className="mb-3 font-semibold text-gray-900">Milestones</h2>
                  <ul className="space-y-3">
                    {milestones.map((m, i) => (
                      <li key={i} className="border-l-2 border-[#008751] pl-3">
                        <p className="font-medium text-gray-900">{m.title}</p>
                        {m.description && <p className="text-sm text-gray-600">{m.description}</p>}
                        <p className="text-xs text-gray-500">
                          {m.status}{m.due_date ? ` · due ${m.due_date}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

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
