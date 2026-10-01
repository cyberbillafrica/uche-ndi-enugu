"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, ShieldAlert, CheckCircle2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getConsultation,
  getMyParticipant,
  getMyConsultationResponse,
  submitConsultationResponse,
  resolveGovernanceAccess,
  GOVERNANCE_CONSULTATION_KIND_LABELS,
  type GovernanceAccess,
  type GovernanceConsultation,
  type GovernanceConsultationResponse,
} from "@/lib/supabase";

type Answers = Record<string, string | string[] | number>;

export default function GovernanceInstrumentRespondPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [instrument, setInstrument] = useState<GovernanceConsultation | null>(null);
  const [existing, setExisting] = useState<GovernanceConsultationResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [answers, setAnswers] = useState<Answers>({});
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

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

  const load = useCallback(async () => {
    try {
      const c = await getConsultation(id);
      if (!c) {
        router.replace("/portal/governance/participate");
        return;
      }
      setInstrument(c);
      // Own-response check via the participant row (RLS admits only the
      // caller's own row for non-staff; the participant filter keeps the
      // maybeSingle targeted for staff callers too).
      try {
        const me = await getMyParticipant();
        if (me) {
          const own = await getMyConsultationResponse(id, me.id);
          if (own) {
            setExisting(own);
            setSubmitted(true);
          }
        }
      } catch {
        // no participant row yet — nothing submitted
      }
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load instrument.");
      setLoaded(true);
    }
  }, [id, router]);

  useEffect(() => {
    if (!guardDone || !access?.moduleEnabled) return;
    const cancelled = false;
    (async () => {
      try {
        await load();
      } catch {
        if (!cancelled) {
          setLoadError("Failed to load instrument.");
          setLoaded(true);
        }
      }
    })();
  }, [guardDone, access, load]);

  const setAnswer = (qid: string, value: string | string[] | number) =>
    setAnswers((prev) => ({ ...prev, [qid]: value }));

  const toggleMulti = (qid: string, option: string) => {
    setAnswers((prev) => {
      const current = (prev[qid] as string[] | undefined) ?? [];
      return {
        ...prev,
        [qid]: current.includes(option) ? current.filter((o) => o !== option) : [...current, option],
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instrument) return;
    setSubmitting(true);
    try {
      await submitConsultationResponse(id, {
        answers,
        freeText: freeText || undefined,
      });
      toast.success("Response submitted — thank you.");
      setSubmitted(true);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to submit your response."));
    } finally {
      setSubmitting(false);
    }
  };

  if (!guardDone || !loaded) {
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

  if (loadError || !instrument) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-red-600">{loadError || "Instrument not found."}</CardContent>
      </Card>
    );
  }

  if (instrument.status !== "open") {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-gray-600">
          This instrument is not open for participation.
          <div className="mt-4">
            <Link
              href="/portal/governance/participate"
              className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline"
            >
              <ArrowLeft className="h-4 w-4" />
              Open instruments
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (submitted) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-600" />
          <p className="text-sm font-medium text-gray-900">Your response has been recorded.</p>
          <p className="max-w-md text-sm text-gray-600">
            Responses are confidential. Only aggregate results may be published — never individual
            responses.
          </p>
          <Link
            href="/portal/governance/participate"
            className="mt-2 inline-flex items-center gap-1 text-sm text-brand-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Open instruments
          </Link>
        </CardContent>
      </Card>
    );
  }

  const closed = instrument.closes_at ? new Date(instrument.closes_at) < new Date() : false;

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/portal/governance/participate"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Open instruments
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">{instrument.title}</h1>
          <span className="rounded-full bg-brand-primary/10 px-2 py-0.5 text-xs text-brand-primary">
            {GOVERNANCE_CONSULTATION_KIND_LABELS[instrument.kind]}
          </span>
          {instrument.closes_at && (
            <span className="text-xs text-gray-500">
              closes {new Date(instrument.closes_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {instrument.description && (
        <Card>
          <CardContent className="py-4 text-sm text-gray-700">{instrument.description}</CardContent>
        </Card>
      )}

      {instrument.instructions && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-700">Instructions</CardTitle>
          </CardHeader>
          <CardContent className="py-3 text-sm text-gray-600">{instrument.instructions}</CardContent>
        </Card>
      )}

      {closed ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-600">
            This instrument closed on {new Date(instrument.closes_at as string).toLocaleString()}.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Your response</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {(instrument.questions ?? []).map((q, i) => (
              <div key={q.id} className="space-y-2">
                <Label htmlFor={`a-${q.id}`}>
                  {i + 1}. {q.prompt}
                </Label>
                {q.kind === "single_choice" && (
                  <div className="space-y-1.5">
                    {(q.options ?? []).map((opt) => (
                      <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="radio"
                          name={`q-${q.id}`}
                          value={opt}
                          checked={answers[q.id] === opt}
                          onChange={() => setAnswer(q.id, opt)}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === "multi_choice" && (
                  <div className="space-y-1.5">
                    {(q.options ?? []).map((opt) => (
                      <label key={opt} className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={((answers[q.id] as string[] | undefined) ?? []).includes(opt)}
                          onChange={() => toggleMulti(q.id, opt)}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === "likert" && (
                  <div className="flex items-center gap-3">
                    {Array.from({ length: q.scale ?? 5 }, (_, k) => k + 1).map((v) => (
                      <label key={v} className="flex items-center gap-1 text-sm text-gray-700">
                        <input
                          type="radio"
                          name={`q-${q.id}`}
                          value={v}
                          checked={answers[q.id] === v}
                          onChange={() => setAnswer(q.id, v)}
                        />
                        {v}
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === "short_text" && (
                  <Input
                    id={`a-${q.id}`}
                    value={(answers[q.id] as string | undefined) ?? ""}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                  />
                )}
              </div>
            ))}

            <div>
              <Label htmlFor="a-free">Additional comments (optional)</Label>
              <textarea
                id="a-free"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={4}
                maxLength={8000}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Submit response"}
            </button>
            {existing && (
              <p className="text-xs text-amber-600">
                You have already responded to this instrument.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </form>
  );
}
