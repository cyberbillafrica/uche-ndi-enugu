"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert, MessageSquareText, PenLine, Vote } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import {
  resolveGovernanceAccess,
  listConsultations,
  listPetitions,
  listPolls,
  GOVERNANCE_CONSULTATION_KIND_LABELS,
  GOVERNANCE_PETITION_ORIGIN_LABELS,
  type GovernanceAccess,
  type GovernanceConsultation,
  type GovernancePetition,
  type GovernancePoll,
} from "@/lib/supabase";

export default function GovernanceParticipatePage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [instruments, setInstruments] = useState<GovernanceConsultation[]>([]);
  const [petitions, setPetitions] = useState<GovernancePetition[]>([]);
  const [polls, setPolls] = useState<GovernancePoll[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  // Presentation-only guard — the FORCE RLS read policy is the real
  // boundary: this list returns only what the caller may see.
  useEffect(() => {
    if (authLoading || !profile) return;
    let cancelled = false;
    (async () => {
      const a = await resolveGovernanceAccess();
      if (cancelled) return;
      setAccess(a);
      setGuardDone(true);
      if (!a.moduleEnabled) {
        router.replace("/portal");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  useEffect(() => {
    if (!guardDone || !access?.moduleEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const [rows, pRows, pollRows] = await Promise.all([listConsultations({ onlyOpen: true }), listPetitions({ onlyOpen: true }), listPolls({ onlyOpen: true })]);
        if (!cancelled) {
          setInstruments(rows);
          setPetitions(pRows);
          setPolls(pollRows);
          setListLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load open instruments.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access]);

  if (!guardDone) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!access?.moduleEnabled) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldAlert className="h-10 w-10 text-amber-500" />
          <p className="text-sm text-gray-600">The Governance module is not enabled.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Open Instruments</h1>
        <p className="text-sm text-gray-500">
          Consultations, surveys, polls and petitions currently open for your input. One response or vote per instrument.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareText className="h-4 w-4 text-brand-primary" />
            Open now
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>
          ) : !listLoaded ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-brand-primary" />
            </div>
          ) : instruments.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">
              Nothing is open for participation right now.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {instruments.map((c) => (
                <li key={c.id} className="py-4">
                  <Link
                    href={`/portal/governance/participate/${c.id}`}
                    className="font-medium text-brand-primary hover:underline"
                  >
                    {c.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">
                      {GOVERNANCE_CONSULTATION_KIND_LABELS[c.kind]}
                    </span>
                    <span className="font-mono">{c.reference_code}</span>
                    {c.closes_at && <span>· closes {new Date(c.closes_at).toLocaleDateString()}</span>}
                    {(c.questions?.length ?? 0) > 0 && <span>· {c.questions.length} questions</span>}
                  </div>
                  {c.description && <p className="mt-1 line-clamp-2 text-sm text-gray-600">{c.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {polls.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Vote className="h-4 w-4 text-brand-primary" />
              Open polls
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-gray-100">
              {polls.map((poll) => (
                <li key={poll.id} className="py-4">
                  <Link
                    href={`/portal/governance/participate/polls/${poll.id}`}
                    className="font-medium text-brand-primary hover:underline"
                  >
                    {poll.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">Poll</span>
                    <span className="font-mono">{poll.reference_code}</span>
                    {poll.closes_at && <span>· closes {new Date(poll.closes_at).toLocaleDateString()}</span>}
                    <span>· {poll.options?.length ?? 0} options</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{poll.question}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {petitions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PenLine className="h-4 w-4 text-brand-primary" />
              Open petitions & community proposals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-gray-100">
              {petitions.map((p) => (
                <li key={p.id} className="py-4">
                  <Link
                    href={`/portal/governance/participate/petitions/${p.id}`}
                    className="font-medium text-brand-primary hover:underline"
                  >
                    {p.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5">
                      {GOVERNANCE_PETITION_ORIGIN_LABELS[p.origin]}
                    </span>
                    <span className="font-mono">{p.reference_code}</span>
                    {p.closes_at && <span>· closes {new Date(p.closes_at).toLocaleDateString()}</span>}
                    {p.target_signatures != null && <span>· target {p.target_signatures} signatures</span>}
                  </div>
                  {p.demand && <p className="mt-1 line-clamp-2 text-sm text-gray-600">{p.demand}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
