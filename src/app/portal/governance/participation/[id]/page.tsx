"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Trash2, ShieldAlert } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getConsultation,
  listConsultationScopes,
  listConsultationResponses,
  updateConsultation,
  setConsultationStatus,
  publishConsultationResults,
  setConsultationVisibility,
  addConsultationScope,
  removeConsultationScope,
  resolveGovernanceAccess,
  GOVERNANCE_CONSULTATION_STATUS_LABELS,
  GOVERNANCE_CONSULTATION_KIND_LABELS,
  type GovernanceAccess,
  type GovernanceConsultation,
  type GovernanceConsultationScope,
  type GovernanceConsultationResponse,
} from "@/lib/supabase";

interface ScopeDraft {
  scope_type: "polling_unit" | "ward" | "lga" | "senatorial_zone" | "state";
  state_id: string;
  zone_id: string;
  lga_id: string;
  ward_id: string;
  polling_unit_id: string;
}

const EMPTY_SCOPE: ScopeDraft = {
  scope_type: "lga",
  state_id: "",
  zone_id: "",
  lga_id: "",
  ward_id: "",
  polling_unit_id: "",
};

const SCOPE_COLUMNS: Record<ScopeDraft["scope_type"], string[]> = {
  state: ["state_id"],
  senatorial_zone: ["state_id", "zone_id"],
  lga: ["state_id", "zone_id", "lga_id"],
  ward: ["state_id", "zone_id", "lga_id", "ward_id"],
  polling_unit: ["state_id", "zone_id", "lga_id", "ward_id", "polling_unit_id"],
};

export default function GovernanceParticipationDetailPage({
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
  const [scopes, setScopes] = useState<GovernanceConsultationScope[]>([]);
  const [responses, setResponses] = useState<GovernanceConsultationResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [resultsSummary, setResultsSummary] = useState("");
  const [busy, setBusy] = useState(false);

  // Draft editing state (content is only editable while in draft —
  // the RPC re-verifies server-side).
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editClosesAt, setEditClosesAt] = useState("");

  const [newScope, setNewScope] = useState<ScopeDraft>({ ...EMPTY_SCOPE });

  const load = useCallback(async () => {
    try {
      const [c, s, r] = await Promise.all([
        getConsultation(id),
        listConsultationScopes(id),
        listConsultationResponses(id),
      ]);
      if (!c) {
        router.replace("/portal/governance/participation");
        return;
      }
      setInstrument(c);
      setScopes(s);
      setResponses(r);
      setResultsSummary(c.results_summary ?? "");
      setEditTitle(c.title);
      setEditDescription(c.description ?? "");
      setEditInstructions(c.instructions ?? "");
      setEditClosesAt(c.closes_at ? c.closes_at.slice(0, 16) : "");
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load instrument.");
      setLoaded(true);
    }
  }, [id, router]);

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

  useEffect(() => {
    if (!guardDone || !access?.canViewGovernance) return;
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

  const run = async (fn: () => Promise<void>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      toast.success(message);
    } catch (err) {
      toast.error(getErrorMessage(err, "The operation failed."));
    } finally {
      setBusy(false);
    }
  };

  if (!guardDone || (authLoading ?? false)) {
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
          <p className="text-sm text-gray-600">You do not have access to Governance Participation.</p>
        </CardContent>
      </Card>
    );
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-brand-primary" />
      </div>
    );
  }

  if (loadError || !instrument) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-red-600">{loadError || "Instrument not found."}</CardContent>
      </Card>
    );
  }

  const isDraft = instrument.status === "draft";
  const canManage = access.canManageParticipation || access.isAdmin;
  const scopeKey = (s: GovernanceConsultationScope) =>
    [s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id].filter(Boolean).join(" / ");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href="/portal/governance/participation"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Participation
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-gray-900">{instrument.title}</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            {GOVERNANCE_CONSULTATION_STATUS_LABELS[instrument.status]}
          </span>
          <span className="rounded-full bg-brand-primary/10 px-2 py-0.5 text-xs text-brand-primary">
            {GOVERNANCE_CONSULTATION_KIND_LABELS[instrument.kind]}
          </span>
          <span className="font-mono text-xs text-gray-400">{instrument.reference_code}</span>
        </div>
      </div>

      {isDraft && canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Draft content</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="d-title">Title</Label>
              <Input id="d-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label htmlFor="d-desc">Description</Label>
              <textarea
                id="d-desc"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="d-instr">Instructions</Label>
              <textarea
                id="d-instr"
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="d-closes">Closes at</Label>
              <Input
                id="d-closes"
                type="datetime-local"
                value={editClosesAt}
                onChange={(e) => setEditClosesAt(e.target.value)}
                className="mt-1"
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await updateConsultation(id, {
                    title: editTitle.trim(),
                    description: editDescription,
                    instructions: editInstructions,
                    closesAt: editClosesAt || null,
                  });
                }, "Draft updated.")
              }
              className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-50"
            >
              Save draft
            </button>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {instrument.status === "draft" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(async () => { await setConsultationStatus(id, "open"); }, "Instrument opened — participants invited.")}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Open for participation
              </button>
            )}
            {instrument.status === "open" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(async () => { await setConsultationStatus(id, "closed"); }, "Instrument closed.")}
                className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                Close participation
              </button>
            )}
            {instrument.status === "closed" && (
              <div className="flex flex-1 flex-wrap items-end gap-3">
                <div className="min-w-64 flex-1">
                  <Label htmlFor="d-results">Results summary (published as aggregates only)</Label>
                  <textarea
                    id="d-results"
                    value={resultsSummary}
                    onChange={(e) => setResultsSummary(e.target.value)}
                    rows={2}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const counts: Record<string, unknown> = {};
                      for (const r of responses) {
                        counts[r.id] = { submitted_at: r.submitted_at };
                      }
                      await publishConsultationResults(id, {
                        summary: resultsSummary,
                        results: { response_count: responses.length },
                      });
                    }, "Results published.")
                  }
                  className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-50"
                >
                  Publish results
                </button>
              </div>
            )}
            <label className="ml-auto flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={instrument.is_public}
                disabled={busy || !access.isAdmin}
                onChange={(e) =>
                  void run(async () => {
                    await setConsultationVisibility(id, e.target.checked);
                  }, e.target.checked ? "Instrument marked public." : "Instrument retracted to private.")
                }
              />
              Public (publish_accountability)
            </label>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Questions ({instrument.questions?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(instrument.questions ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">Free-text input only.</p>
          ) : (
            (instrument.questions ?? []).map((q, i) => (
              <div key={q.id || i} className="rounded-lg border border-gray-200 p-3 text-sm">
                <div className="font-medium text-gray-800">
                  {i + 1}. {q.prompt}
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {q.kind === "likert" ? `Rating scale 1–${q.scale ?? 5}` : q.kind.replace("_", " ")}
                  {q.options?.length ? ` · ${q.options.join(" · ")}` : ""}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Geographic scopes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {scopes.length === 0 && <p className="text-sm text-gray-500">Tenant-wide (no geographic restriction).</p>}
            {scopes.length > 0 && (
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 text-sm">
                {scopes.map((s) => (
                  <li key={s.id} className="flex items-center justify-between px-4 py-2.5">
                    <span className="text-gray-700">
                      <span className="font-medium">{s.scope_type.replace("_", " ")}</span> · {scopeKey(s)}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await removeConsultationScope(s.id);
                        }, "Scope removed.")
                      }
                      className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                      aria-label="Remove scope"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-3 rounded-lg border border-dashed border-gray-300 p-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="ns-type">Attach scope</Label>
                <select
                  id="ns-type"
                  value={newScope.scope_type}
                  onChange={(e) => setNewScope({ ...EMPTY_SCOPE, scope_type: e.target.value as ScopeDraft["scope_type"] })}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="state">State</option>
                  <option value="senatorial_zone">Senatorial Zone</option>
                  <option value="lga">LGA</option>
                  <option value="ward">Ward</option>
                  <option value="polling_unit">Polling Unit</option>
                </select>
              </div>
              {SCOPE_COLUMNS[newScope.scope_type].map((col) => (
                <div key={col}>
                  <Label htmlFor={`ns-${col}`}>
                    {col.replace("_id", "").replace("state", "State").replace("zone", "Zone").replace("lga", "LGA").replace("ward", "Ward").replace("polling_unit", "Polling Unit")} ID
                  </Label>
                  <Input
                    id={`ns-${col}`}
                    value={(newScope as unknown as Record<string, string>)[col]}
                    onChange={(e) => setNewScope((prev) => ({ ...prev, [col]: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              ))}
              <div className="sm:col-span-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await addConsultationScope(id, {
                        scope_type: newScope.scope_type,
                        state_id: newScope.state_id || null,
                        zone_id: newScope.scope_type === "state" ? null : newScope.zone_id || null,
                        lga_id: ["state", "senatorial_zone"].includes(newScope.scope_type) ? null : newScope.lga_id || null,
                        ward_id: ["state", "senatorial_zone", "lga"].includes(newScope.scope_type) ? null : newScope.ward_id || null,
                        polling_unit_id: newScope.scope_type === "polling_unit" ? newScope.polling_unit_id : null,
                      });
                      setNewScope({ ...EMPTY_SCOPE });
                    }, "Scope attached.")
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  Attach
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Responses ({responses.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-gray-500">
              Responses are confidential — visible only to authorized staff, and publishable only as
              aggregates. Individual responses are never shown to participants or the public.
            </p>
            {responses.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500">No responses yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 text-sm">
                {responses.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
                    <span className="font-mono text-xs text-gray-500">{r.id.slice(0, 8)}…</span>
                    <span className="text-xs text-gray-600">{new Date(r.submitted_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
