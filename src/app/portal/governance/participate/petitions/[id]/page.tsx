"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Loader2, PenLine, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getPetition,
  getMyParticipant,
  getMyPetitionSignature,
  signPetition,
  resolveGovernanceAccess,
  GOVERNANCE_PETITION_ORIGIN_LABELS,
  type GovernanceAccess,
  type GovernancePetition,
  type GovernancePetitionSupport,
} from "@/lib/supabase";

export default function GovernancePetitionSignPage({
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

  const [petition, setPetition] = useState<GovernancePetition | null>(null);
  const [mySignature, setMySignature] = useState<GovernancePetitionSupport | null>(null);
  const [loadError, setLoadError] = useState("");

  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const p = await getPetition(id);
    if (!p) {
      setLoadError("Petition not found (or not open to you).");
      return;
    }
    setPetition(p);
    let participantId: string | undefined;
    try {
      const gp = await getMyParticipant();
      participantId = gp?.id;
    } catch {
      // unauthenticated or no participant row — nothing submitted yet
    }
    if (participantId) {
      setMySignature(await getMyPetitionSignature(id, participantId));
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
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load petition.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access, load]);

  const handleSign = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await signPetition(id, comment.trim() || undefined);
      toast.success("Your signature has been added.");
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not add your signature."));
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

  if (loadError || !petition) {
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

  const isOpen = petition.status === "open";

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
          <h1 className="text-xl font-semibold text-gray-900">{petition.title}</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            {GOVERNANCE_PETITION_ORIGIN_LABELS[petition.origin]}
          </span>
        </div>
        <p className="font-mono text-xs text-gray-400">{petition.reference_code}</p>
        {petition.closes_at && (
          <p className="mt-1 text-xs text-gray-500">Closes {new Date(petition.closes_at).toLocaleString()}</p>
        )}
      </div>

      {petition.demand && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">The demand</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-gray-700">{petition.demand}</p>
          </CardContent>
        </Card>
      )}

      {mySignature ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="text-sm font-medium text-gray-900">You have signed this petition.</p>
            <p className="text-xs text-gray-500">
              Signed {new Date(mySignature.created_at).toLocaleString()} · signatures are verified by staff before results are published.
            </p>
          </CardContent>
        </Card>
      ) : isOpen ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PenLine className="h-4 w-4 text-brand-primary" />
              Add your signature
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSign} className="space-y-4">
              <div>
                <Label htmlFor="pp-comment">Optional comment (public-safe, max 2000 chars)</Label>
                <textarea
                  id="pp-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={2000}
                  rows={4}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Why this matters to you (optional)"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                Sign this petition
              </button>
              <p className="text-xs text-gray-500">
                One signature per person. Signatures are private and verified before any results are published.
              </p>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-600">
            {petition.status === "results_published"
              ? "This petition has concluded and its results are published."
              : "This petition is not open for signatures."}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
