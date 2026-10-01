"use client";

/**
 * POLITICORE — PUBLIC PARTICIPATION DETAIL (Phase 18).
 *
 * One discriminated route for the participation instruments (Phase 11 §22
 * rejected separate per-instrument routes). Renders through the 0057
 * projections:
 *   consultation/survey — the instrument; results ONLY when the server has
 *                         published them (aggregate jsonb; no response rows)
 *   petition            — title, demand, aggregate support, results; the
 *                         signer table is structurally unreachable
 *   poll                — aggregate published results on a closed poll;
 *                         no individual vote exists in the projection
 * Unpublished/unknown references → "not available" (no existence oracle).
 */

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  GOVERNANCE_CONSULTATION_STATUS_LABELS,
  GOVERNANCE_PETITION_STATUS_LABELS,
  getPublicGovernanceConsultation,
  getPublicGovernancePetition,
  getPublicGovernancePoll,
  type PublicGovernanceConsultation,
  type PublicGovernancePetition,
  type PublicGovernancePoll,
} from "@/lib/supabase/governance";

interface QuestionOption {
  text?: string;
  label?: string;
}

interface AggRow {
  label?: string;
  option?: string;
  count?: number;
}

function ResultsTable({ results, summary }: { results: Record<string, unknown> | null; summary: string }) {
  const rows: AggRow[] = Array.isArray((results as { rows?: AggRow[] })?.rows)
    ? ((results as { rows: AggRow[] }).rows)
    : Array.isArray(results)
      ? (results as AggRow[])
      : [];
  if (rows.length === 0 && !summary) return null;
  return (
    <div className="mt-4">
      <h2 className="mb-2 font-semibold text-gray-900">Published results (aggregate)</h2>
      {summary && <p className="mb-2 text-sm text-gray-600">{summary}</p>}
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-2 pr-3 text-gray-800">{r.label ?? r.option ?? `Option ${i + 1}`}</td>
                <td className="py-2 text-right font-medium text-gray-900">{typeof r.count === "number" ? r.count : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-gray-400">
        Aggregate totals only — individual responses/signatures/votes are never public.
      </p>
    </div>
  );
}

export default function PublicParticipationDetailPage({
  params,
}: {
  params: Promise<{ kind: string; reference: string }>;
}) {
  const { kind, reference } = use(params);
  const [consultation, setConsultation] = useState<PublicGovernanceConsultation | null>(null);
  const [petition, setPetition] = useState<PublicGovernancePetition | null>(null);
  const [poll, setPoll] = useState<PublicGovernancePoll | null>(null);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";
        if (kind === "consultation" || kind === "survey") {
          setConsultation((await getPublicGovernanceConsultation(siteSlug, reference))[0] ?? null);
        } else if (kind === "petition") {
          setPetition((await getPublicGovernancePetition(siteSlug, reference))[0] ?? null);
        } else if (kind === "poll") {
          setPoll((await getPublicGovernancePoll(siteSlug, reference))[0] ?? null);
        }
      } catch (err: unknown) {
        console.error("Error loading participation record:", err);
      } finally {
        setLoading(false);
        setChecked(true);
      }
    }
    void load();
  }, [kind, reference]);

  const notAvailable = checked && !consultation && !petition && !poll;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : notAvailable ? (
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
        ) : (
          <div className="space-y-6">
            <Link href="/governance/participate" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-800">
              <ArrowLeft className="mr-1 h-4 w-4" /> Participate
            </Link>

            {consultation && (
              <div className="space-y-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    {consultation.kind === "survey" ? "Survey" : "Consultation"} · {consultation.reference_code}
                  </p>
                  <h1 className="mt-1 text-2xl font-bold text-gray-900">{consultation.title}</h1>
                  <p className="mt-1 text-sm text-gray-500">
                    {(GOVERNANCE_CONSULTATION_STATUS_LABELS as Record<string, string>)[consultation.status] ?? consultation.status}
                    {consultation.closes_at ? ` · closes ${new Date(consultation.closes_at).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <Card>
                  <CardContent className="p-5">
                    {consultation.description && <p className="whitespace-pre-wrap text-sm text-gray-700">{consultation.description}</p>}
                    {consultation.instructions && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{consultation.instructions}</p>
                    )}
                    {consultation.status !== "results_published" && (
                      <p className="mt-3 text-sm text-gray-500">
                        Responses are collected through the authenticated portal while this instrument is open; results appear here only after they are published.
                      </p>
                    )}
                    <ResultsTable results={consultation.results} summary={consultation.results_summary} />
                  </CardContent>
                </Card>
              </div>
            )}

            {petition && (
              <div className="space-y-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    {petition.origin === "community_proposal" ? "Community proposal" : "Petition"} · {petition.reference_code}
                  </p>
                  <h1 className="mt-1 text-2xl font-bold text-gray-900">{petition.title}</h1>
                  <p className="mt-1 text-sm text-gray-500">
                    {(GOVERNANCE_PETITION_STATUS_LABELS as Record<string, string>)[petition.status] ?? petition.status}
                    {petition.verified_count != null ? ` · ${petition.verified_count} verified support(s)` : ""}
                    {petition.target_signatures != null ? ` of ${petition.target_signatures} target` : ""}
                  </p>
                </div>
                <Card>
                  <CardContent className="p-5">
                    {petition.demand && <p className="whitespace-pre-wrap text-sm text-gray-700">{petition.demand}</p>}
                    <p className="mt-3 text-xs text-gray-400">
                      Signatures are verified and counted — signer identities are never public.
                    </p>
                    <ResultsTable results={petition.results} summary={petition.results_summary} />
                  </CardContent>
                </Card>
              </div>
            )}

            {poll && (
              <div className="space-y-6">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Poll · {poll.reference_code}</p>
                  <h1 className="mt-1 text-2xl font-bold text-gray-900">{poll.title}</h1>
                  <p className="mt-1 text-sm text-gray-500">{poll.question}</p>
                </div>
                <Card>
                  <CardContent className="p-5">
                    {poll.description && <p className="whitespace-pre-wrap text-sm text-gray-700">{poll.description}</p>}
                    {Array.isArray(poll.options) && (
                      <ul className="mt-3 list-disc pl-5 text-sm text-gray-700">
                        {(poll.options as (string | QuestionOption)[]).map((o, i) => (
                          <li key={i}>{typeof o === "string" ? o : (o.text ?? o.label ?? `Option ${i + 1}`)}</li>
                        ))}
                      </ul>
                    )}
                    <ResultsTable results={poll.results} summary={poll.results_summary} />
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
