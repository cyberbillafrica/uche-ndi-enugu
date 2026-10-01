"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  createCommitment,
  resolveGovernanceAccess,
  GOVERNANCE_COMMITMENT_SOURCE_LABELS,
  type GovernanceAccess,
  type CreateCommitmentInput,
  type GovernanceCommitmentSourceType,
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

export default function GovernanceCommitmentNewPage() {
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [categoryLabel, setCategoryLabel] = useState("");
  const [sourceType, setSourceType] = useState<GovernanceCommitmentSourceType>("independent");
  const [sourceRef, setSourceRef] = useState("");
  const [targetDescription, setTargetDescription] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [scopes, setScopes] = useState<ScopeDraft[]>([{ ...EMPTY_SCOPE }]);

  const [submitting, setSubmitting] = useState(false);

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

  const updateScope = (index: number, patch: Partial<ScopeDraft>) => {
    setScopes((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const next = { ...s, ...patch };
        // Changing a higher level invalidates the deeper ids.
        const order = ["state_id", "zone_id", "lga_id", "ward_id", "polling_unit_id"];
        let clear = false;
        for (const col of order) {
          if (clear) (next as unknown as Record<string, string>)[col] = "";
          if (patch[col as keyof ScopeDraft] !== undefined) clear = true;
        }
        return next;
      }),
    );
  };

  const buildScopesPayload = (): CreateCommitmentInput["scopes"] =>
    scopes
      .filter((s) => SCOPE_COLUMNS[s.scope_type].every((c) => (s as unknown as Record<string, string>)[c]))
      .map((s) => ({
        scope_type: s.scope_type,
        state_id: s.state_id || null,
        zone_id: s.scope_type === "state" ? null : s.zone_id || null,
        lga_id: ["state", "senatorial_zone"].includes(s.scope_type) ? null : s.lga_id || null,
        ward_id: ["state", "senatorial_zone", "lga"].includes(s.scope_type) ? null : s.ward_id || null,
        polling_unit_id: s.scope_type === "polling_unit" ? s.polling_unit_id : null,
      }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSubmitting(true);
    try {
      const id = await createCommitment({
        title: title.trim(),
        details,
        categoryLabel,
        sourceType,
        sourceRef: sourceRef || undefined,
        targetDescription,
        plannedStart: plannedStart || undefined,
        targetDate: targetDate || undefined,
        scopes: buildScopesPayload(),
      });
      toast.success("Commitment created.");
      router.push(`/portal/governance/projects/commitments/${id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create commitment."));
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

  if (!access?.canViewGovernance) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-gray-600">
          You do not have access to Governance Commitments.
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/portal/governance/projects/commitments"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Commitments
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-gray-900">New Commitment</h1>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Commitment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="c-title">Title *</Label>
            <Input
              id="c-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Deliver 10 primary healthcare facilities"
              required
            />
          </div>
          <div>
            <Label htmlFor="c-details">Details</Label>
            <textarea
              id="c-details"
              className="min-h-[96px] w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="c-cat">Category label</Label>
              <Input
                id="c-cat"
                value={categoryLabel}
                onChange={(e) => setCategoryLabel(e.target.value)}
                placeholder="Tenant-defined label"
              />
            </div>
            <div>
              <Label htmlFor="c-target">Target / delivery definition</Label>
              <Input
                id="c-target"
                value={targetDescription}
                onChange={(e) => setTargetDescription(e.target.value)}
                placeholder="What delivery means"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Source lineage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-gray-500">
            Lineage is recorded as a label plus a human-readable reference. The Manifesto module is
            never queried — an independent commitment needs no source record.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="c-source">Source type</Label>
              <select
                id="c-source"
                className="block h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as GovernanceCommitmentSourceType)}
              >
                {Object.entries(GOVERNANCE_COMMITMENT_SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="c-sourceref">Source reference</Label>
              <Input
                id="c-sourceref"
                value={sourceRef}
                onChange={(e) => setSourceRef(e.target.value)}
                placeholder="e.g. Manifesto §Water, item 3"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Plan</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="c-start">Planned start</Label>
            <Input
              id="c-start"
              type="date"
              value={plannedStart}
              onChange={(e) => setPlannedStart(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="c-targetdate">Target completion</Label>
            <Input
              id="c-targetdate"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            Geographic scope
            <button
              type="button"
              onClick={() => setScopes((prev) => [...prev, { ...EMPTY_SCOPE }])}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add scope
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-gray-500">
            Core Geography scope rows. Scopes outside your authority are rejected server-side.
          </p>
          {scopes.map((scope, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 p-3">
              <div>
                <Label>Type</Label>
                <select
                  className="block h-10 rounded-md border border-gray-300 bg-white px-2 text-sm"
                  value={scope.scope_type}
                  onChange={(e) => updateScope(i, { scope_type: e.target.value as ScopeDraft["scope_type"] })}
                >
                  <option value="state">State</option>
                  <option value="senatorial_zone">Senatorial zone</option>
                  <option value="lga">LGA</option>
                  <option value="ward">Ward</option>
                  <option value="polling_unit">Polling unit</option>
                </select>
              </div>
              {SCOPE_COLUMNS[scope.scope_type].map((col) => (
                <div key={col}>
                  <Label>{col.replace("_id", "").replace("_", " ")}</Label>
                  <Input
                    className="w-36"
                    value={(scope as unknown as Record<string, string>)[col]}
                    onChange={(e) => updateScope(i, { [col]: e.target.value } as Partial<ScopeDraft>)}
                    placeholder="id"
                  />
                </div>
              ))}
              {scopes.length > 1 && (
                <button
                  type="button"
                  onClick={() => setScopes((prev) => prev.filter((_, j) => j !== i))}
                  className="mb-0.5 rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-500"
                  aria-label="Remove scope"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Link
          href="/portal/governance/projects/commitments"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Create commitment
        </button>
      </div>
    </form>
  );
}
