"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getPetition,
  listPetitionScopes,
  listPetitionSupports,
  updatePetition,
  setPetitionStatus,
  verifyPetition,
  publishPetitionResults,
  setPetitionVisibility,
  addPetitionScope,
  removePetitionScope,
  resolveGovernanceAccess,
  GOVERNANCE_PETITION_STATUS_LABELS,
  GOVERNANCE_PETITION_ORIGIN_LABELS,
  type GovernanceAccess,
  type GovernancePetition,
  type GovernancePetitionScope,
  type GovernancePetitionSupport,
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

export default function GovernancePetitionDetailPage({
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
  const [scopes, setScopes] = useState<GovernancePetitionScope[]>([]);
  const [supports, setSupports] = useState<GovernancePetitionSupport[]>([]);
  const [loadError, setLoadError] = useState("");

  const [busy, setBusy] = useState("");
  const [newScope, setNewScope] = useState<ScopeDraft>({ ...EMPTY_SCOPE });
  const [resultsSummary, setResultsSummary] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editDemand, setEditDemand] = useState("");

  const load = useCallback(async () => {
    const p = await getPetition(id);
    if (!p) {
      setLoadError("Petition not found (or outside your tenant/visibility).");
      return;
    }
    const [s, sup] = await Promise.all([listPetitionScopes(id), listPetitionSupports(id)]);
    setPetition(p);
    setScopes(s);
    setSupports(sup);
    setResultsSummary(p.results_summary ?? "");
    setEditTitle(p.title);
    setEditDemand(p.demand ?? "");
  }, [id]);

  // Presentation-only guard (every mutation is re-verified server-side by
  // the 0052 authority RPCs).
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
    let cancelled = false;
    (async () => {
      try {
        await load();
        if (cancelled) return;
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load petition.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access, load]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "The action failed."));
    } finally {
      setBusy("");
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
          <p className="text-sm text-gray-600">You do not have access to Governance.</p>
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
            <Link href="/portal/governance/participation" className="text-brand-primary hover:underline">
              ← Back to Participation
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const canManage = access.canManageParticipation;
  const status = petition.status;
  const signatureCount = supports.length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/portal/governance/participation"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Participation
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900">{petition.title}</h1>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
              {GOVERNANCE_PETITION_ORIGIN_LABELS[petition.origin]}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
              {GOVERNANCE_PETITION_STATUS_LABELS[status]}
            </span>
            {petition.is_public && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Public</span>
            )}
          </div>
          <p className="font-mono text-xs text-gray-400">{petition.reference_code}</p>
        </div>
      </div>

      {petition.demand && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Demand / proposal</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-gray-700">{petition.demand}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-4 text-center">
            <p className="text-2xl font-semibold text-gray-900">{signatureCount}</p>
            <p className="text-xs text-gray-500">Signatures collected</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <p className="text-2xl font-semibold text-gray-900">{petition.verified_count ?? "—"}</p>
            <p className="text-xs text-gray-500">Verified at closure</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 text-center">
            <p className="text-2xl font-semibold text-gray-900">{petition.target_signatures ?? "—"}</p>
            <p className="text-xs text-gray-500">Target</p>
          </CardContent>
        </Card>
      </div>

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(status === "draft" || status === "pending") && (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">
                  {status === "pending"
                    ? "This community proposal awaits moderation approval before signatures open."
                    : "This petition is drafted and has not been opened."}
                </p>
                <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                  <div>
                    <Label htmlFor="pp-edit-title">Title</Label>
                    <Input id="pp-edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="pp-edit-demand">Demand / proposal text</Label>
                    <textarea
                      id="pp-edit-demand"
                      value={editDemand}
                      onChange={(e) => setEditDemand(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() =>
                      withBusy("save", async () => {
                        await updatePetition(id, { title: editTitle.trim(), demand: editDemand.trim() });
                        toast.success("Draft updated.");
                      })
                    }
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    {busy === "save" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                    Save draft changes
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {(status === "draft" || status === "pending") && (
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("open", async () => {
                      await setPetitionStatus(id, "open");
                      toast.success("Petition opened for signatures.");
                    })
                  }
                  className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
                >
                  {busy === "open" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  Open for signatures
                </button>
              )}
              {status === "open" && (
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("close", async () => {
                      await setPetitionStatus(id, "closed");
                      toast.success("Petition closed.");
                    })
                  }
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {busy === "close" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  Close signature collection
                </button>
              )}
              {status === "closed" && (
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("verify", async () => {
                      const n = await verifyPetition(id);
                      toast.success(`Verification complete — ${n} signatures verified.`);
                    })
                  }
                  className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
                >
                  {busy === "verify" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  Verify signatures
                </button>
              )}
              {status === "verified" && (
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Label htmlFor="pp-results">Results summary (published aggregate)</Label>
                    <Input
                      id="pp-results"
                      value={resultsSummary}
                      onChange={(e) => setResultsSummary(e.target.value)}
                      placeholder="e.g. 482 verified signatures — demand referred to Public Works"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() =>
                      withBusy("publish", async () => {
                        await publishPetitionResults(id, { summary: resultsSummary });
                        toast.success("Results published.");
                      })
                    }
                    className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
                  >
                    {busy === "publish" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                    Publish results
                  </button>
                </div>
              )}
              {status === "results_published" && (
                <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  {petition.results_summary || "Results published."}
                </div>
              )}
            </div>

            <div className="border-t border-gray-100 pt-3">
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() =>
                  withBusy("visibility", async () => {
                    await setPetitionVisibility(id, !petition.is_public);
                    toast.success(petition.is_public ? "Removed from public projection." : "Added to public projection (opt-in).");
                  })
                }
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                {busy === "visibility" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                {petition.is_public ? "Make private" : "Publish title/demand/count publicly (opt-in)"}
              </button>
              <p className="mt-1 text-xs text-gray-500">
                Requires publish_accountability. Signatures are never public — only title, demand, support count and status.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Geographic scopes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {scopes.length === 0 ? (
              <p className="text-sm text-gray-500">Tenant-wide (no geographic restriction).</p>
            ) : (
              <ul className="space-y-1 text-sm text-gray-700">
                {scopes.map((s) => (
                  <li key={s.id} className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
                    <span>
                      <span className="font-medium">{s.scope_type.replace("_", " ")}</span>
                      {" · "}
                      {[s.state_id, s.zone_id, s.lga_id, s.ward_id, s.polling_unit_id].filter(Boolean).join(" / ")}
                    </span>
                    <button
                      type="button"
                      disabled={busy !== ""}
                      onClick={() =>
                        withBusy(`scope-${s.id}`, async () => {
                          await removePetitionScope(s.id);
                          toast.success("Scope removed.");
                        })
                      }
                      className="text-gray-400 hover:text-red-600"
                      aria-label="Remove scope"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <select
                  value={newScope.scope_type}
                  onChange={(e) => setNewScope({ ...newScope, scope_type: e.target.value as ScopeDraft["scope_type"] })}
                  className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                >
                  <option value="state">State</option>
                  <option value="senatorial_zone">Senatorial Zone</option>
                  <option value="lga">LGA</option>
                  <option value="ward">Ward</option>
                  <option value="polling_unit">Polling Unit</option>
                </select>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {SCOPE_COLUMNS[newScope.scope_type].map((col) => (
                  <div key={col}>
                    <Label htmlFor={`pp-add-${col}`}>
                      {col.replace("_id", "").replace("state", "State").replace("zone", "Zone").replace("lga", "LGA").replace("ward", "Ward").replace("polling_unit", "Polling Unit")} ID
                    </Label>
                    <Input
                      id={`pp-add-${col}`}
                      value={(newScope as unknown as Record<string, string>)[col] ?? ""}
                      onChange={(e) => setNewScope({ ...newScope, [col]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={busy !== ""}
                onClick={() =>
                  withBusy("add-scope", async () => {
                    await addPetitionScope(id, {
                      scope_type: newScope.scope_type,
                      state_id: newScope.state_id || null,
                      zone_id: newScope.scope_type === "state" ? null : newScope.zone_id || null,
                      lga_id: ["state", "senatorial_zone"].includes(newScope.scope_type) ? null : newScope.lga_id || null,
                      ward_id: ["state", "senatorial_zone", "lga"].includes(newScope.scope_type) ? null : newScope.ward_id || null,
                      polling_unit_id: newScope.scope_type === "polling_unit" ? newScope.polling_unit_id : null,
                    });
                    setNewScope({ ...EMPTY_SCOPE });
                    toast.success("Scope attached.");
                  })
                }
                className="mt-3 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                {busy === "add-scope" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                <Plus className="h-4 w-4" /> Attach scope
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Signature register (confidential)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-gray-500">
              Staff-only view. Signatures are never public; participants see only their own row.
            </p>
            {supports.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No signatures yet.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Signed</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Comment</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Verified</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {supports.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-2 text-gray-600">{new Date(s.created_at).toLocaleString()}</td>
                        <td className="px-4 py-2 text-gray-700">{s.comment || "—"}</td>
                        <td className="px-4 py-2 text-gray-600">
                          {s.verified_at ? new Date(s.verified_at).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
