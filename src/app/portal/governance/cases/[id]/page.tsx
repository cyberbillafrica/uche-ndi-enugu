"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Lock,
  MessageSquare,
  ShieldAlert,
  UserCheck,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getSupabaseClient,
  resolveGovernanceAccess,
  getCase,
  acknowledgeCase,
  assignCase,
  changeCaseStatus,
  addStaffResponse,
  listMembers,
  GOVERNANCE_STATUS_LABELS,
  GOVERNANCE_EVENT_LABELS,
  GovernanceError,
  type GovernanceAccess,
  type GovernanceRequest,
  type GovernanceRequestEvent,
  type GovernanceAssignment,
  type GovernanceRequestStatus,
  type DirectoryMember,
} from "@/lib/supabase";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("en-NG", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Staff transition menu per the approved status ladder (server re-verifies). */
const TRANSITIONS: Record<GovernanceRequestStatus, GovernanceRequestStatus[]> = {
  submitted: ["acknowledged", "rejected"],
  acknowledged: ["assigned", "in_progress"],
  assigned: ["in_progress", "awaiting_information"],
  in_progress: ["awaiting_information", "resolved"],
  awaiting_information: ["in_progress", "resolved"],
  resolved: ["closed", "in_progress", "awaiting_information"],
  closed: [],
  rejected: [],
};

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [request, setRequest] = useState<GovernanceRequest | null>(null);
  const [events, setEvents] = useState<GovernanceRequestEvent[]>([]);
  const [assignments, setAssignments] = useState<GovernanceAssignment[]>([]);
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [acting, setActing] = useState(false);
  const [note, setNote] = useState("");
  const [makePublic, setMakePublic] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigneeId, setAssigneeId] = useState("");
  const [assignScopeType, setAssignScopeType] = useState("");
  const [assignScopeId, setAssignScopeId] = useState("");
  const [assignNote, setAssignNote] = useState("");

  const requestId = params?.id;

  const reload = async (id: string) => {
    const data = await getCase(id, getSupabaseClient());
    if (!data.request) {
      setNotFound(true);
      return;
    }
    setRequest(data.request);
    setEvents(data.events);
    setAssignments(data.assignments);
  };

  // ─── ROUTE GUARD (fail closed: staff authority required) ───
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
        if (!a.moduleEnabled || !a.canViewGovernance || !a.isStaff) {
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
    if (!guardDone || !access?.isStaff || !requestId) return;
    let cancelled = false;
    void (async () => {
      try {
        await reload(requestId);
      } catch (err) {
        console.error("Failed to load case:", err);
        if (!cancelled) setLoadError("Unable to load this case right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access?.isStaff, requestId]);

  const openAssign = async () => {
    setAssignOpen(true);
    if (members.length === 0) {
      try {
        const m = await listMembers();
        setMembers(m);
      } catch {
        toast.error("Unable to load the member list for assignment.");
      }
    }
  };

  const runAction = async (fn: () => Promise<void>, successMessage: string) => {
    setActing(true);
    try {
      await fn();
      await reload(requestId!);
      toast.success(successMessage);
      setNote("");
      setMakePublic(false);
    } catch (err) {
      console.error("Governance action failed:", err);
      if (err instanceof GovernanceError) {
        toast.error(err.message);
      } else {
        toast.error(getErrorMessage(err, "The action could not be completed."));
      }
    } finally {
      setActing(false);
    }
  };

  const handleAcknowledge = () =>
    runAction(
      () => acknowledgeCase(requestId!, note.trim()),
      "Case acknowledged.",
    );

  const handleTransition = (status: GovernanceRequestStatus, isPublic = false) =>
    runAction(
      () => changeCaseStatus(requestId!, status, note.trim(), isPublic),
      `Case moved to ${GOVERNANCE_STATUS_LABELS[status]}.`,
    );

  const handleRespond = (isPublic: boolean) =>
    runAction(
      () => addStaffResponse(requestId!, note.trim(), isPublic),
      isPublic ? "Public response added." : "Internal response added.",
    );

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assigneeId) return;
    setActing(true);
    try {
      await assignCase(requestId!, assigneeId, {
        scopeType: assignScopeType || null,
        scopeId: assignScopeId || null,
        note: assignNote.trim(),
      });
      await reload(requestId!);
      toast.success("Case assigned.");
      setAssignOpen(false);
      setAssigneeId("");
      setAssignScopeType("");
      setAssignScopeId("");
      setAssignNote("");
    } catch (err) {
      console.error("Assignment failed:", err);
      if (err instanceof GovernanceError) {
        toast.error(err.message);
      } else {
        toast.error(getErrorMessage(err, "The assignment could not be completed."));
      }
    } finally {
      setActing(false);
    }
  };

  if (authLoading || !guardDone) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
      </div>
    );
  }

  if (access && !access.moduleEnabled) {
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

  if (notFound || (!request && !loading && !loadError)) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">Case not found</h1>
        <p className="mt-2 text-sm text-gray-600">
          This case does not exist or you do not have access to it.
        </p>
        <Link
          href="/portal/governance/cases"
          className="mt-4 inline-block text-sm font-medium text-apc-primary hover:underline"
        >
          ← Back to Case Queue
        </Link>
      </div>
    );
  }

  if (loading || !request) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
      </div>
    );
  }

  const status = request.status;
  const nextStates = TRANSITIONS[status] ?? [];
  const isManage = Boolean(access?.canManageCases);
  const isAssigner = Boolean(access?.canAssignCases);
  const canAct = isManage || isAssigner;
  const canRespond = isManage;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/portal/governance/cases"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ArrowLeft className="h-4 w-4" />
        Case Queue
      </Link>

      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{request.title}</h1>
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700">
            {GOVERNANCE_STATUS_LABELS[status]}
          </span>
        </div>
        <p className="font-mono text-sm text-gray-500">
          {request.reference_code}
          {request.participant?.full_name
            ? ` · ${request.participant.display_label}: ${request.participant.full_name}`
            : ""}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold text-gray-900">
                Case details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-400">Category</p>
                  <p className="text-gray-900">{request.category?.name ?? "General"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-400">Submitted</p>
                  <p className="text-gray-900">{formatDateTime(request.created_at)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-400">Assignee</p>
                  <p className="text-gray-900">
                    {request.assigned_profile_id
                      ? members.find((m) => m.id === request.assigned_profile_id)
                        ?.full_name ?? "Assigned staff member"
                      : "Unassigned"}
                  </p>
                </div>
                {request.resolved_at ? (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-400">Resolved</p>
                    <p className="text-gray-900">{formatDateTime(request.resolved_at)}</p>
                  </div>
                ) : null}
                {request.feedback_rating !== null ? (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-gray-400">Feedback</p>
                    <p className="text-amber-500">
                      {"★".repeat(request.feedback_rating)}
                      <span className="text-gray-300">
                        {"★".repeat(5 - (request.feedback_rating ?? 0))}
                      </span>
                    </p>
                  </div>
                ) : null}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-400">Description</p>
                <p className="whitespace-pre-wrap text-gray-900">{request.details}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold text-gray-900">
                Event trail
              </CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-500">
                  No events recorded yet.
                </p>
              ) : (
                <ol className="space-y-3">
                  {events.map((ev) => (
                    <li key={ev.id} className="rounded-lg border border-gray-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="flex items-center gap-2 text-sm font-medium text-gray-900">
                          {GOVERNANCE_EVENT_LABELS[ev.kind]}
                          {ev.status_to
                            ? ` → ${GOVERNANCE_STATUS_LABELS[ev.status_to]}`
                            : ""}
                          {ev.kind === "staff_response" && !ev.is_public ? (
                            <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                              <Lock className="h-3 w-3" />
                              Internal
                            </span>
                          ) : null}
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

              {canRespond ? (
                <div className="mt-4 space-y-2 rounded-lg border border-gray-200 p-3">
                  <Label htmlFor="gov-staff-note">Response / note</Label>
                  <textarea
                    id="gov-staff-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    placeholder="Operational note, response to the participant, or transition reason…"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={acting || !note.trim()}
                      onClick={() => handleRespond(true)}
                      className="inline-flex items-center gap-2 rounded-lg border border-apc-primary px-3 py-2 text-sm font-semibold text-apc-primary hover:bg-apc-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <MessageSquare className="h-4 w-4" />
                      Public response
                    </button>
                    <button
                      type="button"
                      disabled={acting || !note.trim()}
                      onClick={() => handleRespond(false)}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Lock className="h-4 w-4" />
                      Internal note
                    </button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          {canAct ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold text-gray-900">
                  Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {status === "submitted" && isManage ? (
                  <button
                    type="button"
                    disabled={acting}
                    onClick={handleAcknowledge}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white hover:bg-apc-primary/90 disabled:opacity-50"
                  >
                    {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Acknowledge
                  </button>
                ) : null}

                {(status === "acknowledged" || status === "resolved") && isAssigner ? (
                  <button
                    type="button"
                    disabled={acting}
                    onClick={openAssign}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-apc-primary px-4 py-2 text-sm font-semibold text-apc-primary hover:bg-apc-primary/5 disabled:opacity-50"
                  >
                    <UserCheck className="h-4 w-4" />
                    {status === "resolved" ? "Reassign" : "Assign"}
                  </button>
                ) : null}

                {nextStates.filter((s) => s !== "closed" || status === "resolved").length > 0 ? (
                  <div className="space-y-2 border-t border-gray-100 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                      Move to
                    </p>
                    {nextStates.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={acting || !isManage}
                        onClick={() => handleTransition(s, s === "resolved" ? makePublic : false)}
                        className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>{GOVERNANCE_STATUS_LABELS[s]}</span>
                        <ChevronRight className="h-4 w-4 text-gray-400" />
                      </button>
                    ))}
                  </div>
                ) : null}

                {status === "in_progress" && isManage ? (
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={makePublic}
                      onChange={(e) => setMakePublic(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-apc-primary focus:ring-apc-primary"
                    />
                    Publish resolution publicly
                  </label>
                ) : null}

                {!isManage ? (
                  <p className="text-xs text-gray-500">
                    You can view this case but cannot manage it (manage_cases required).
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {assignments.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-semibold text-gray-900">
                  Assignment history
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {assignments.map((a) => (
                  <div key={a.id} className="rounded-lg border border-gray-200 p-2.5">
                    <p className="text-gray-900">
                      {members.find((m) => m.id === a.assigned_to)?.full_name ??
                        "Staff member"}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {a.scope_type ? `${a.scope_type} · ${a.scope_id} · ` : ""}
                      {formatDateTime(a.created_at)}
                    </p>
                    {a.note ? (
                      <p className="mt-1 text-xs text-gray-600">{a.note}</p>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {assignOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="text-base font-semibold text-gray-900">
                Assign case
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAssign} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="gov-assignee">Assign to</Label>
                  <select
                    id="gov-assignee"
                    value={assigneeId}
                    onChange={(e) => setAssigneeId(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
                    required
                  >
                    <option value="">Select a staff member…</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name} ({m.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="gov-scope-type">Scope (optional)</Label>
                    <select
                      id="gov-scope-type"
                      value={assignScopeType}
                      onChange={(e) => {
                        setAssignScopeType(e.target.value);
                        setAssignScopeId("");
                      }}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
                    >
                      <option value="">None</option>
                      <option value="lga">LGA</option>
                      <option value="ward">Ward</option>
                      <option value="polling_unit">Polling Unit</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="gov-scope-id">Scope id</Label>
                    <Input
                      id="gov-scope-id"
                      value={assignScopeId}
                      onChange={(e) => setAssignScopeId(e.target.value)}
                      disabled={!assignScopeType}
                      placeholder={assignScopeType ? "Geography id…" : "—"}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="gov-assign-note">Note (optional)</Label>
                  <Input
                    id="gov-assign-note"
                    value={assignNote}
                    onChange={(e) => setAssignNote(e.target.value)}
                    maxLength={300}
                  />
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setAssignOpen(false)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={acting || !assigneeId}
                    className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white hover:bg-apc-primary/90 disabled:opacity-50"
                  >
                    {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
                    Assign
                  </button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
