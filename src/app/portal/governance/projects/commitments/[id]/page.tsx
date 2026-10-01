"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Link2, Loader2, Plus, ShieldAlert, Trash2, Unlink } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getCommitment,
  resolveGovernanceAccess,
  listCommitmentScopes,
  listCommitmentProjects,
  listCommitmentUpdates,
  listProjects,
  updateCommitment,
  setCommitmentStatus,
  setCommitmentProgress,
  setCommitmentVisibility,
  removeCommitmentScope,
  linkProjectToCommitment,
  unlinkProjectFromCommitment,
  createCommitmentUpdate,
  setProjectUpdateVisibility,
  GOVERNANCE_COMMITMENT_STATUS_LABELS,
  GOVERNANCE_COMMITMENT_SOURCE_LABELS,
  GOVERNANCE_PROJECT_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceCommitment,
  type GovernanceCommitmentScope,
  type GovernanceCommitmentProjectLink,
  type GovernanceUpdate,
  type GovernanceProject,
  type GovernanceCommitmentStatus,
} from "@/lib/supabase";

const NEXT_STATUS: Partial<Record<GovernanceCommitmentStatus, GovernanceCommitmentStatus[]>> = {
  declared: ["in_progress", "dropped"],
  in_progress: ["partially_delivered", "delivered", "dropped"],
  partially_delivered: ["in_progress", "delivered", "dropped"],
};

export default function GovernanceCommitmentDetailPage() {
  const params = useParams<{ id: string }>();
  const commitmentId = params.id;
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [commitment, setCommitment] = useState<GovernanceCommitment | null>(null);
  const [scopes, setScopes] = useState<GovernanceCommitmentScope[]>([]);
  const [links, setLinks] = useState<GovernanceCommitmentProjectLink[]>([]);
  const [updates, setUpdates] = useState<GovernanceUpdate[]>([]);
  const [projects, setProjects] = useState<GovernanceProject[]>([]);
  const [loadError, setLoadError] = useState("");

  const [progressInput, setProgressInput] = useState("");
  const [sourceRefInput, setSourceRefInput] = useState("");
  const [updateTitle, setUpdateTitle] = useState("");
  const [updateBody, setUpdateBody] = useState("");
  const [linkProjectId, setLinkProjectId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authLoading || !profile) return;
    let cancelled = false;
    (async () => {
      const a = await resolveGovernanceAccess();
      if (cancelled) return;
      setAccess(a);
      setGuardDone(true);
      if (!a.moduleEnabled || !a.canViewGovernance) {
        router.replace("/portal");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  const reload = useCallback(async () => {
    const c = await getCommitment(commitmentId);
    if (!c) {
      setLoadError("Commitment not found.");
      return;
    }
    setCommitment(c);
    setProgressInput(String(c.progress_percent));
    setSourceRefInput(c.source_ref ?? "");
    const [s, l, u] = await Promise.all([
      listCommitmentScopes(commitmentId),
      listCommitmentProjects(commitmentId),
      listCommitmentUpdates(commitmentId),
    ]);
    setScopes(s);
    setLinks(l);
    setUpdates(u);
  }, [commitmentId]);

  useEffect(() => {
    if (!guardDone || !access?.canViewGovernance) return;
    let cancelled = false;
    (async () => {
      try {
        await reload();
        const rows = await listProjects();
        if (!cancelled) setProjects(rows);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load commitment.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access, reload]);

  const run = async (fn: () => Promise<void>, okMessage?: string) => {
    setBusy(true);
    try {
      await fn();
      await reload();
      if (okMessage) toast.success(okMessage);
    } catch (err) {
      toast.error(getErrorMessage(err, "Operation failed."));
    } finally {
      setBusy(false);
    }
  };

  if (!guardDone) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (!access?.canViewGovernance) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldAlert className="h-10 w-10 text-amber-500" />
          <p className="text-sm text-gray-600">You do not have access to Governance Commitments.</p>
        </CardContent>
      </Card>
    );
  }

  if (loadError || !commitment) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-gray-600">
          {loadError || "Commitment not found."}
        </CardContent>
      </Card>
    );
  }

  const linkable = projects.filter((p) => !links.some((l) => l.project_id === p.id));
  const nextStatuses = NEXT_STATUS[commitment.status] ?? [];
  const terminal = nextStatuses.length === 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/portal/governance/projects/commitments"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Commitments
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">{commitment.title}</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            {GOVERNANCE_COMMITMENT_STATUS_LABELS[commitment.status]}
          </span>
          {commitment.is_public && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Public</span>
          )}
        </div>
        <p className="font-mono text-xs text-gray-400">
          {commitment.reference_code} · {GOVERNANCE_COMMITMENT_SOURCE_LABELS[commitment.source_type]}
          {commitment.source_ref ? ` · ${commitment.source_ref}` : ""}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Commitment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-gray-700">
            {commitment.details && <p className="whitespace-pre-line">{commitment.details}</p>}
            {commitment.target_description && (
              <p>
                <span className="font-medium text-gray-500">Target:</span>{" "}
                {commitment.target_description}
              </p>
            )}
            <p>
              <span className="font-medium text-gray-500">Planned start:</span>{" "}
              {commitment.planned_start ?? "—"}
            </p>
            <p>
              <span className="font-medium text-gray-500">Target completion:</span>{" "}
              {commitment.target_date ?? "—"}
            </p>
            {commitment.completed_at && (
              <p>
                <span className="font-medium text-gray-500">Completed:</span> {commitment.completed_at}
              </p>
            )}
            {commitment.owner && (
              <p>
                <span className="font-medium text-gray-500">Owner:</span> {commitment.owner.full_name}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Reported progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-brand-primary"
                  style={{ width: `${commitment.progress_percent}%` }}
                />
              </div>
              <span className="text-xs text-gray-500">{commitment.progress_percent}%</span>
            </div>
            <p className="text-xs text-gray-500">
              Progress is explicitly reported — the single authority (audited on every change).
              Linked projects are evidence, never a computation input.
            </p>
            {!terminal && (
              <div className="flex items-end gap-2">
                <div className="w-24">
                  <Label htmlFor="c-progress">Set %</Label>
                  <Input
                    id="c-progress"
                    type="number"
                    min="0"
                    max="100"
                    value={progressInput}
                    onChange={(e) => setProgressInput(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await setCommitmentProgress(commitment.id, Number(progressInput));
                    }, "Progress updated.")
                  }
                  className="h-10 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
                >
                  Save
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          {terminal ? (
            <p className="text-xs text-gray-500">
              This commitment is in a terminal state and is retained for institutional memory.
            </p>
          ) : (
            nextStatuses.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await setCommitmentStatus(commitment.id, s);
                  }, "Status updated.")
                }
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Mark {GOVERNANCE_COMMITMENT_STATUS_LABELS[s]}
              </button>
            ))
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await setCommitmentVisibility(commitment.id, !commitment.is_public);
              }, commitment.is_public ? "Commitment set to private." : "Commitment published.")
            }
            className="ml-auto rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            {commitment.is_public ? "Unpublish" : "Publish"}
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Geographic scope</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {scopes.length === 0 ? (
            <p className="text-xs text-gray-500">No scopes attached.</p>
          ) : (
            <ul className="space-y-1">
              {scopes.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="text-gray-700">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{s.scope_type}</span>{" "}
                    {s.polling_unit_id ?? s.ward_id ?? s.lga_id ?? s.zone_id ?? s.state_id}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Remove scope"
                    onClick={() =>
                      run(async () => {
                        await removeCommitmentScope(s.id);
                      }, "Scope removed.")
                    }
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-gray-500">
            Scopes are attached during creation; server-side authority validates every attachment.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="h-4 w-4 text-brand-primary" />
            Linked projects
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {links.length === 0 ? (
            <p className="text-xs text-gray-500">
              No linked projects — a commitment can be delivered and evidenced without any project.
            </p>
          ) : (
            <ul className="space-y-1">
              {links.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-2">
                  <Link
                    href={`/portal/governance/projects/${l.project_id}`}
                    className="text-brand-primary hover:underline"
                  >
                    {l.project?.title ?? l.project_id}
                  </Link>
                  <div className="flex items-center gap-2">
                    {l.project?.status && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {GOVERNANCE_PROJECT_STATUS_LABELS[l.project.status]}
                      </span>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      aria-label="Unlink project"
                      onClick={() =>
                        run(async () => {
                          await unlinkProjectFromCommitment(commitment.id, l.project_id);
                        }, "Project unlinked.")
                      }
                      className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <div className="max-w-xs flex-1">
              <Label htmlFor="c-link">Link an existing project</Label>
              <select
                id="c-link"
                className="block h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
                value={linkProjectId}
                onChange={(e) => setLinkProjectId(e.target.value)}
              >
                <option value="">Select a project…</option>
                {linkable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference_code} — {p.title}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={busy || !linkProjectId}
              onClick={() =>
                run(async () => {
                  await linkProjectToCommitment(commitment.id, linkProjectId);
                  setLinkProjectId("");
                }, "Project linked.")
              }
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" />
              Link
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Links are data relationships only — they never grant authority.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Lineage reference</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-gray-500">
            A human-readable anchor for the {GOVERNANCE_COMMITMENT_SOURCE_LABELS[commitment.source_type].toLowerCase()}{" "}
            origin. The source system is never queried.
          </p>
          <div className="flex items-end gap-2">
            <div className="max-w-sm flex-1">
              <Label htmlFor="c-sr">Source reference</Label>
              <Input
                id="c-sr"
                value={sourceRefInput}
                onChange={(e) => setSourceRefInput(e.target.value)}
                placeholder="e.g. Manifesto §Water, item 3"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await updateCommitment(commitment.id, { sourceRef: sourceRefInput });
                }, "Source reference updated.")
              }
              className="h-10 rounded-lg bg-brand-primary px-3 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
            >
              Save
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Updates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="space-y-2">
            <Input
              value={updateTitle}
              onChange={(e) => setUpdateTitle(e.target.value)}
              placeholder="Update title (optional)"
            />
            <textarea
              className="min-h-[72px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={updateBody}
              onChange={(e) => setUpdateBody(e.target.value)}
              placeholder="Share progress on this commitment…"
            />
            <button
              type="button"
              disabled={busy || !updateBody.trim()}
              onClick={() =>
                run(async () => {
                  await createCommitmentUpdate(commitment.id, { title: updateTitle, body: updateBody });
                  setUpdateTitle("");
                  setUpdateBody("");
                }, "Update posted.")
              }
              className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
            >
              Post update
            </button>
          </div>
          {updates.length === 0 ? (
            <p className="text-xs text-gray-500">No updates yet.</p>
          ) : (
            <ul className="space-y-3 border-t border-gray-100 pt-3">
              {updates.map((u) => (
                <li key={u.id} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5">{u.kind}</span>
                    {u.is_public && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">public</span>
                    )}
                    <span>{new Date(u.created_at).toLocaleDateString()}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        // The canonical RPC resolves authority by the update's
                        // subject (commitment updates included — 0048).
                        run(async () => {
                          await setProjectUpdateVisibility(u.id, !u.is_public);
                        })
                      }
                      className="text-brand-primary hover:underline"
                    >
                      {u.is_public ? "unpublish" : "publish"}
                    </button>
                  </div>
                  {u.title && <p className="font-medium text-gray-800">{u.title}</p>}
                  <p className="whitespace-pre-line text-gray-700">{u.body}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
