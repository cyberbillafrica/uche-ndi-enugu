"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, Plus, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  resolveGovernanceAccess,
  getProject,
  listProjectMilestones,
  listProjectScopes,
  listProjectUpdates,
  createProjectMilestone,
  updateProjectMilestone,
  setProjectStatus,
  setProjectVisibility,
  setProjectUpdateVisibility,
  createProjectUpdate,
  GOVERNANCE_PROJECT_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceProject,
  type GovernanceProjectMilestone,
  type GovernanceProjectScope,
  type GovernanceUpdate,
  type GovernanceProjectStatus,
} from "@/lib/supabase";

const NEXT_STATUSES: Record<GovernanceProjectStatus, GovernanceProjectStatus[]> = {
  planned: ["active", "cancelled"],
  active: ["suspended", "completed", "cancelled"],
  suspended: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

export default function GovernanceProjectDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [project, setProject] = useState<GovernanceProject | null>(null);
  const [milestones, setMilestones] = useState<GovernanceProjectMilestone[]>([]);
  const [scopes, setScopes] = useState<GovernanceProjectScope[]>([]);
  const [updates, setUpdates] = useState<GovernanceUpdate[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");
  const [updateBody, setUpdateBody] = useState("");
  const [updatePublic, setUpdatePublic] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const [p, ms, sc, us] = await Promise.all([
        getProject(projectId),
        listProjectMilestones(projectId),
        listProjectScopes(projectId),
        listProjectUpdates(projectId),
      ]);
      setProject(p);
      setMilestones(ms);
      setScopes(sc);
      setUpdates(us);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load project.");
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (authLoading || !profile) return;
    let cancelled = false;
    (async () => {
      const a = await resolveGovernanceAccess();
      if (cancelled) return;
      setAccess(a);
      setGuardDone(true);
      if (!a.moduleEnabled || !a.canViewGovernance) {
        router.replace("/portal/governance/projects");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  useEffect(() => {
    if (!guardDone || !access?.canViewGovernance) return;
    let cancelled = false;
    void (async () => {
      try {
        const [p, ms, sc, us] = await Promise.all([
          getProject(projectId as string),
          listProjectMilestones(projectId as string),
          listProjectScopes(projectId as string),
          listProjectUpdates(projectId as string),
        ]);
        if (cancelled) return;
        setProject(p);
        setMilestones(ms);
        setScopes(sc);
        setUpdates(us);
        setLoadError("");
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load project.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access, projectId]);

  const derivedProgress = useMemo(() => {
    const counted = milestones.filter((m) => m.status !== "cancelled");
    if (counted.length === 0) return null;
    const done = counted.filter((m) => m.status === "done").length;
    return Math.round((done * 100) / counted.length);
  }, [milestones]);

  const run = async (fn: () => Promise<unknown>, okMessage: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(okMessage);
      await reload();
    } catch (err) {
      toast.error(getErrorMessage(err, "Action failed."));
    } finally {
      setBusy(false);
    }
  };

  if (!guardDone || (!loaded && access?.canViewGovernance)) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!access?.canViewGovernance) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-gray-600">
          You do not have access to Governance Projects.
        </CardContent>
      </Card>
    );
  }

  if (loadError || !project) {
    return (
      <Card>
        <CardContent className="space-y-3 py-16 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-amber-500" />
          <p className="text-sm text-gray-600">{loadError || "Project not found."}</p>
          <Link href="/portal/governance/projects" className="text-sm text-brand-primary hover:underline">
            Back to Projects
          </Link>
        </CardContent>
      </Card>
    );
  }

  const nextStatuses = NEXT_STATUSES[project.status];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/portal/governance/projects"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Projects
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">{project.title}</h1>
            <p className="font-mono text-xs text-gray-400">{project.reference_code}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
              {GOVERNANCE_PROJECT_STATUS_LABELS[project.status]}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(
                  () => setProjectVisibility(project.id, !project.is_public),
                  project.is_public ? "Project retracted to private." : "Project marked public.",
                )
              }
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {project.is_public ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {project.is_public ? "Retract" : "Make public"}
            </button>
            {nextStatuses.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() =>
                  run(
                    () => setProjectStatus(project.id, s),
                    `Project moved to ${GOVERNANCE_PROJECT_STATUS_LABELS[s]}.`,
                  )
                }
                className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                → {GOVERNANCE_PROJECT_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-gray-700">
            {project.description && <p className="whitespace-pre-line">{project.description}</p>}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-1">
              <dt className="text-gray-500">Category</dt>
              <dd>{project.category_label || "—"}</dd>
              <dt className="text-gray-500">Implementing org</dt>
              <dd>{project.implementing_org || "—"}</dd>
              <dt className="text-gray-500">Owner</dt>
              <dd>{project.owner?.full_name ?? "—"}</dd>
              <dt className="text-gray-500">Planned</dt>
              <dd>
                {project.planned_start ?? "—"} → {project.planned_end ?? "—"}
              </dd>
              {(project.actual_start || project.actual_end) && (
                <>
                  <dt className="text-gray-500">Actual</dt>
                  <dd>
                    {project.actual_start ?? "—"} → {project.actual_end ?? "—"}
                  </dd>
                </>
              )}
              {project.planned_budget != null && (
                <>
                  <dt className="text-gray-500">Budget</dt>
                  <dd>
                    {project.currency} {project.planned_budget.toLocaleString()}
                    {project.funding_source ? ` · ${project.funding_source}` : ""}
                  </dd>
                </>
              )}
              {(project.beneficiary_summary || project.beneficiaries_estimated != null) && (
                <>
                  <dt className="text-gray-500">Beneficiaries</dt>
                  <dd>
                    {project.beneficiary_summary || ""}
                    {project.beneficiaries_estimated != null
                      ? `${project.beneficiary_summary ? " · " : ""}~${project.beneficiaries_estimated.toLocaleString()}`
                      : ""}
                  </dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-brand-primary transition-all"
                  style={{ width: `${project.progress_percent}%` }}
                />
              </div>
              <span className="text-sm font-medium text-gray-700">{project.progress_percent}%</span>
            </div>
            <p className="text-xs text-gray-500">
              {derivedProgress === null
                ? "No milestones yet — progress is set manually by authorized staff."
                : `Derived from milestones: ${milestones.filter((m) => m.status === "done").length}/${milestones.filter((m) => m.status !== "cancelled").length} done (database is authoritative).`}
            </p>
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
                Geographic scope
              </p>
              {scopes.length === 0 ? (
                <p className="text-sm text-gray-500">Tenant-wide (no geographic scope rows).</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {scopes.map((s) => (
                    <li key={s.id} className="rounded bg-gray-50 px-2 py-1 font-mono text-xs text-gray-600">
                      {s.scope_type}: {s.polling_unit_id ?? s.ward_id ?? s.lga_id ?? s.zone_id ?? s.state_id}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Milestones</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {milestones.length === 0 ? (
            <p className="text-sm text-gray-500">No milestones yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {milestones.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{m.title}</p>
                    <p className="text-xs text-gray-500">
                      {m.due_date ? `Due ${m.due_date}` : "No due date"}
                      {m.completed_at ? ` · Completed ${new Date(m.completed_at).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{m.status}</span>
                    {m.status !== "done" && m.status !== "cancelled" && (
                      <>
                        {m.status === "pending" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => updateProjectMilestone(m.id, { status: "in_progress" }),
                                "Milestone started.",
                              )
                            }
                            className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-60"
                          >
                            Start
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => updateProjectMilestone(m.id, { status: "done" }),
                              "Milestone completed — progress re-derived.",
                            )
                          }
                          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Done
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => updateProjectMilestone(m.id, { status: "cancelled" }),
                              "Milestone cancelled.",
                            )
                          }
                          className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!milestoneTitle.trim()) return;
              void run(
                () =>
                  createProjectMilestone(project.id, {
                    title: milestoneTitle.trim(),
                    sortOrder: milestones.length + 1,
                    dueDate: milestoneDue || null,
                  }),
                "Milestone added.",
              ).then(() => {
                setMilestoneTitle("");
                setMilestoneDue("");
              });
            }}
          >
            <div className="min-w-[200px] flex-1">
              <Label htmlFor="m-title">Add milestone</Label>
              <Input
                id="m-title"
                value={milestoneTitle}
                onChange={(e) => setMilestoneTitle(e.target.value)}
                placeholder="Milestone title"
              />
            </div>
            <div>
              <Label htmlFor="m-due">Due</Label>
              <Input
                id="m-due"
                type="date"
                className="w-40"
                value={milestoneDue}
                onChange={(e) => setMilestoneDue(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Updates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {updates.length === 0 ? (
            <p className="text-sm text-gray-500">No updates posted.</p>
          ) : (
            <ul className="space-y-3">
              {updates.map((u) => (
                <li key={u.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-gray-800">
                      {u.title || u.kind}
                      <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-500">
                        {u.kind}
                      </span>
                      {u.is_public && (
                        <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-normal text-emerald-700">
                          public
                        </span>
                      )}
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => setProjectUpdateVisibility(u.id, !u.is_public),
                          u.is_public ? "Update retracted." : "Update published.",
                        )
                      }
                      className="text-xs text-gray-500 hover:text-brand-primary disabled:opacity-60"
                    >
                      {u.is_public ? "Retract" : "Publish"}
                    </button>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-gray-600">{u.body}</p>
                  <p className="mt-1 text-xs text-gray-400">
                    {u.author?.full_name ?? "Staff"} · {new Date(u.created_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <form
            className="space-y-2 border-t border-gray-100 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!updateBody.trim()) return;
              void run(
                () =>
                  createProjectUpdate(project.id, {
                    body: updateBody.trim(),
                    isPublic: updatePublic,
                  }),
                "Update posted.",
              ).then(() => {
                setUpdateBody("");
                setUpdatePublic(false);
              });
            }}
          >
            <Label htmlFor="u-body">Post update</Label>
            <textarea
              id="u-body"
              className="min-h-[72px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={updateBody}
              onChange={(e) => setUpdateBody(e.target.value)}
              placeholder="Progress note…"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={updatePublic}
                  onChange={(e) => setUpdatePublic(e.target.checked)}
                />
                Publish immediately (public accountability surface)
              </label>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
              >
                Post update
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
