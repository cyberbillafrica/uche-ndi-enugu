"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, MessageSquare, ShieldAlert, Star } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getSupabaseClient,
  resolveGovernanceAccess,
  getMyRequest,
  getRequestEvents,
  addParticipantResponse,
  submitFeedback,
  GOVERNANCE_STATUS_LABELS,
  GOVERNANCE_EVENT_LABELS,
  GovernanceError,
  type GovernanceAccess,
  type GovernanceRequest,
  type GovernanceRequestEvent,
} from "@/lib/supabase";
import { listLgas, listAllWards } from "@/lib/supabase";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ParticipantRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [request, setRequest] = useState<GovernanceRequest | null>(null);
  const [events, setEvents] = useState<GovernanceRequestEvent[]>([]);
  const [lgaNames, setLgaNames] = useState<Map<string, string>>(new Map());
  const [wardNames, setWardNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [responseBody, setResponseBody] = useState("");
  const [responding, setResponding] = useState(false);
  const [rating, setRating] = useState(0);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  const requestId = params?.id;

  // ─── ROUTE GUARD (fail closed) ───
  useEffect(() => {
    if (authLoading) return;
    if (!profile) {
      router.replace("/portal/dashboard");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const a = await resolveGovernanceAccess();
        if (!cancelled) setAccess(a);
        if (!a.moduleEnabled || !a.canViewGovernance || !a.isParticipant) {
          router.replace("/portal/dashboard");
        }
      } catch {
        router.replace("/portal/dashboard");
      } finally {
        if (!cancelled) setGuardDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  // ─── LOAD ───
  useEffect(() => {
    if (!guardDone || !access?.isParticipant || !requestId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [r, lgaData, wardData] = await Promise.all([
          getMyRequest(requestId, getSupabaseClient()),
          listLgas(),
          listAllWards(),
        ]);
        if (cancelled) return;
        if (!r) {
          setNotFound(true);
        } else {
          const evs = await getRequestEvents(requestId, getSupabaseClient());
          if (!cancelled) {
            setRequest(r);
            setEvents(evs);
            setLgaNames(new Map(lgaData.map((l) => [l.id, l.name])));
            setWardNames(new Map(wardData.map((w) => [w.id, w.name])));
          }
        }
      } catch (err) {
        console.error("Failed to load request:", err);
        if (!cancelled) setLoadError("Unable to load this request right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access?.isParticipant, requestId]);

  const handleRespond = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!responseBody.trim() || !requestId) return;
    setResponding(true);
    try {
      await addParticipantResponse(requestId, responseBody.trim());
      const evs = await getRequestEvents(requestId, getSupabaseClient());
      setEvents(evs);
      setResponseBody("");
      toast.success("Your response has been added.");
    } catch (err) {
      console.error("Participant response failed:", err);
      toast.error(getErrorMessage(err, "Unable to add your response."));
    } finally {
      setResponding(false);
    }
  };

  const handleFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!requestId || rating === 0) return;
    setSubmittingFeedback(true);
    try {
      await submitFeedback(requestId, rating, feedbackComment.trim());
      const updated = await getMyRequest(requestId, getSupabaseClient());
      setRequest(updated);
      const evs = await getRequestEvents(requestId, getSupabaseClient());
      setEvents(evs);
      toast.success("Thank you — your feedback has been recorded.");
    } catch (err) {
      console.error("Feedback failed:", err);
      if (err instanceof GovernanceError) {
        toast.error(err.message);
      } else {
        toast.error(getErrorMessage(err, "Unable to record your feedback."));
      }
    } finally {
      setSubmittingFeedback(false);
    }
  };

  if (authLoading || (loading && guardDone && access?.isParticipant)) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
      </div>
    );
  }

  if (!access?.moduleEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">
          Governance is not available
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          The Governance module is not enabled for your organization.
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-gray-600">{loadError}</p>
        <Link
          href="/portal/governance/requests"
          className="mt-4 inline-block text-sm font-medium text-apc-primary hover:underline"
        >
          ← Back to My Requests
        </Link>
      </div>
    );
  }

  if (notFound || !request) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">
          Request not found
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          This request does not exist or you do not have access to it.
        </p>
        <Link
          href="/portal/governance/requests"
          className="mt-4 inline-block text-sm font-medium text-apc-primary hover:underline"
        >
          ← Back to My Requests
        </Link>
      </div>
    );
  }

  const isTerminal = ["resolved", "closed"].includes(request.status);
  const feedbackEligible =
    request.status === "resolved" && request.feedback_rating === null;

  const locationLabel =
    [
      request.lga_id ? lgaNames.get(request.lga_id) : null,
      request.ward_id ? wardNames.get(request.ward_id) : null,
    ]
      .filter(Boolean)
      .join(", ") || null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/portal/governance/requests"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" />
        My Requests
      </Link>

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{request.title}</h1>
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
            {GOVERNANCE_STATUS_LABELS[request.status]}
          </span>
        </div>
        <p className="font-mono text-sm text-gray-500">
          {request.reference_code}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-gray-900">
            Request details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-400">
                Category
              </p>
              <p className="text-gray-900">
                {request.category?.name ?? "General"}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-gray-400">
                Submitted
              </p>
              <p className="text-gray-900">{formatDate(request.created_at)}</p>
            </div>
            {locationLabel ? (
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400">
                  Location
                </p>
                <p className="text-gray-900">{locationLabel}</p>
              </div>
            ) : null}
            {request.resolved_at ? (
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400">
                  Resolved
                </p>
                <p className="text-gray-900">
                  {formatDate(request.resolved_at)}
                </p>
              </div>
            ) : null}
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-400">
              Description
            </p>
            <p className="whitespace-pre-wrap text-gray-900">{request.details}</p>
          </div>
          {request.feedback_rating !== null ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs uppercase tracking-wide text-gray-400">
                Your feedback
              </p>
              <p className="mt-1 text-amber-500">
                {"★".repeat(request.feedback_rating)}
                <span className="text-gray-300">
                  {"★".repeat(5 - (request.feedback_rating ?? 0))}
                </span>
              </p>
              {request.feedback_comment ? (
                <p className="mt-1 text-sm text-gray-700">
                  {request.feedback_comment}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-gray-900">
            Updates & responses
          </CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-500">
              No updates yet. You will see responses from the team here.
            </p>
          ) : (
            <ol className="space-y-3">
              {events.map((ev) => (
                <li
                  key={ev.id}
                  className="rounded-lg border border-gray-200 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-900">
                      {GOVERNANCE_EVENT_LABELS[ev.kind]}
                      {ev.status_to ? ` → ${GOVERNANCE_STATUS_LABELS[ev.status_to]}` : ""}
                    </p>
                    <p className="text-xs text-gray-400">
                      {formatDateTime(ev.created_at)}
                    </p>
                  </div>
                  {ev.body ? (
                    <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-700">
                      {ev.body}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}

          {request.status !== "closed" && request.status !== "rejected" ? (
            <form onSubmit={handleRespond} className="mt-4 space-y-2">
              <Label htmlFor="gov-response">Add a response</Label>
              <textarea
                id="gov-response"
                value={responseBody}
                onChange={(e) => setResponseBody(e.target.value)}
                rows={3}
                placeholder="Add more information for the team…"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
              />
              <button
                type="submit"
                disabled={responding || !responseBody.trim()}
                className="inline-flex items-center gap-2 rounded-lg border border-apc-primary px-4 py-2 text-sm font-semibold text-apc-primary hover:bg-apc-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {responding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )}
                {responding ? "Sending…" : "Send response"}
              </button>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {isTerminal ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-gray-900">
              Feedback
            </CardTitle>
          </CardHeader>
          <CardContent>
            {feedbackEligible ? (
              <form onSubmit={handleFeedback} className="space-y-3">
                <p className="text-sm text-gray-600">
                  How well was this request handled?
                </p>
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setRating(n)}
                      aria-label={`${n} star${n > 1 ? "s" : ""}`}
                      className="p-0.5"
                    >
                      <Star
                        className={`h-7 w-7 ${
                          n <= rating
                            ? "fill-amber-400 text-amber-400"
                            : "text-gray-300"
                        }`}
                      />
                    </button>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gov-feedback">Comment (optional)</Label>
                  <textarea
                    id="gov-feedback"
                    value={feedbackComment}
                    onChange={(e) => setFeedbackComment(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submittingFeedback || rating === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white hover:bg-apc-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submittingFeedback ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Star className="h-4 w-4" />
                  )}
                  {submittingFeedback ? "Recording…" : "Submit feedback"}
                </button>
              </form>
            ) : request.feedback_rating !== null ? (
              <p className="text-sm text-gray-500">
                Feedback already recorded — thank you.
              </p>
            ) : (
              <p className="text-sm text-gray-500">
                Feedback can be provided once the request is resolved.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
