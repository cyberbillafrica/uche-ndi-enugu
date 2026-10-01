"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Loader2, ShieldAlert, Vote } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getPoll,
  getMyParticipant,
  getMyPollVote,
  submitPollVote,
  resolveGovernanceAccess,
  type GovernanceAccess,
  type GovernancePoll,
  type GovernancePollVote,
} from "@/lib/supabase";

export default function GovernancePollVotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [poll, setPoll] = useState<GovernancePoll | null>(null);
  const [myVote, setMyVote] = useState<GovernancePollVote | null>(null);
  const [loadError, setLoadError] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const p = await getPoll(id);
    if (!p) {
      setLoadError("Poll not found (or not open to you).");
      return;
    }
    setPoll(p);
    let participantId: string | undefined;
    try {
      const gp = await getMyParticipant();
      participantId = gp?.id;
    } catch {
      // unauthenticated or no participant row — nothing submitted yet
    }
    if (participantId) {
      setMyVote(await getMyPollVote(id, participantId));
    }
  }, [id]);

  // Presentation-only guard — the FORCE RLS read policy is the real
  // boundary: this page returns only what the caller may see.
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
        await load();
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load poll.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access, load]);

  const handleVote = async (choice: string) => {
    setSubmitting(true);
    try {
      await submitPollVote(id, choice);
      toast.success("Your vote has been recorded.");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not record your vote."));
    } finally {
      setSubmitting(false);
    }
  };

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

  if (loadError || !poll) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-gray-600">
          {loadError || "Loading…"}
          <div className="mt-4">
            <Link href="/portal/governance/participate" className="text-brand-primary hover:underline">
              ← Back to Open Instruments
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  // closes_at is enforced server-side (the vote RPC rejects expired
  // polls) — the UI treats open status as the only presentation gate and
  // surfaces the server's rejection through the toast.
  const canVote = poll.status === "open";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/portal/governance/participate"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Open Instruments
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">{poll.title}</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">Poll</span>
        </div>
        <p className="font-mono text-xs text-gray-400">{poll.reference_code}</p>
        {poll.closes_at && (
          <p className="mt-1 text-xs text-gray-500">Closes {new Date(poll.closes_at).toLocaleString()}</p>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">The question</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm font-medium text-gray-800">{poll.question}</p>
          {poll.description && (
            <p className="mt-2 whitespace-pre-wrap text-sm text-gray-500">{poll.description}</p>
          )}
        </CardContent>
      </Card>

      {myVote ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="text-sm font-medium text-gray-900">
              You voted: {myVote.choice}
            </p>
            <p className="text-xs text-gray-500">
              Voted {new Date(myVote.submitted_at).toLocaleString()} · one vote per person — votes cannot be changed.
            </p>
          </CardContent>
        </Card>
      ) : canVote ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Vote className="h-4 w-4 text-brand-primary" />
              Cast your vote
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {poll.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  disabled={submitting}
                  onClick={() => handleVote(o)}
                  className="flex w-full items-center justify-between rounded-lg border border-gray-300 px-4 py-3 text-left text-sm font-medium text-gray-800 hover:border-brand-primary hover:bg-brand-primary/5 disabled:opacity-60"
                >
                  <span>{o}</span>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin text-brand-primary" />}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-gray-500">
              One vote per person. Your individual choice is private — only aggregate counts are ever published.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-600">
            {poll.results
              ? `This poll has concluded. Results: ${Object.entries(poll.results)
                  .map(([k, v]) => `${k} ${String(v)}`)
                  .join(" · ")}`
              : "This poll is not open for voting."}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
