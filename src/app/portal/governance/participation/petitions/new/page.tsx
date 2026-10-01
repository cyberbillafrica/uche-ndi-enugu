"use client";

import { useEffect, useState } from "react";
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
  createPetition,
  resolveGovernanceAccess,
  type GovernanceAccess,
  type GovernancePetitionOrigin,
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

export default function GovernancePetitionNewPage() {
  const router = useRouter();
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [origin, setOrigin] = useState<GovernancePetitionOrigin>("petition");
  const [title, setTitle] = useState("");
  const [demand, setDemand] = useState("");
  const [targetSignatures, setTargetSignatures] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [scopes, setScopes] = useState<ScopeDraft[]>([{ ...EMPTY_SCOPE }]);
  const [submitting, setSubmitting] = useState(false);

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
      if (!a.moduleEnabled || !a.canManageParticipation) {
        router.replace("/portal/governance/participation");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  const buildScopesPayload = () =>
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
      const id = await createPetition({
        origin,
        title: title.trim(),
        demand: demand.trim(),
        targetSignatures: targetSignatures ? Number(targetSignatures) : undefined,
        closesAt: closesAt ? new Date(closesAt).toISOString() : undefined,
        scopes: buildScopesPayload(),
      });
      toast.success(origin === "community_proposal" ? "Community proposal submitted for review." : "Petition created as a draft.");
      router.push(`/portal/governance/participation/${id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create the petition."));
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

  if (!access?.canManageParticipation) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <ShieldAlert />
          <p className="text-sm text-gray-600">You do not have access to manage Governance participation instruments.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/portal/governance/participation"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Participation
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-gray-900">New Petition / Community Proposal</h1>
        <p className="text-sm text-gray-500">
          Petitions are staff-drafted; community proposals are submitted by members and await moderation before opening.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Instrument</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="pp-origin">Origin</Label>
                <select
                  id="pp-origin"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value as GovernancePetitionOrigin)}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="petition">Petition</option>
                  <option value="community_proposal">Community Proposal</option>
                </select>
              </div>
              <div>
                <Label htmlFor="pp-target">Target signatures (optional)</Label>
                <Input
                  id="pp-target"
                  type="number"
                  min={1}
                  value={targetSignatures}
                  onChange={(e) => setTargetSignatures(e.target.value)}
                  placeholder="e.g. 500"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="pp-title">Title *</Label>
              <Input
                id="pp-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What is being demanded or proposed"
                required
              />
            </div>

            <div>
              <Label htmlFor="pp-demand">Demand / proposal text</Label>
              <textarea
                id="pp-demand"
                value={demand}
                onChange={(e) => setDemand(e.target.value)}
                rows={5}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                placeholder="The full text supporters are asked to back"
              />
            </div>

            <div>
              <Label htmlFor="pp-closes">Closes at (optional)</Label>
              <Input
                id="pp-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Geographic scopes (optional)</Label>
                <button
                  type="button"
                  onClick={() => setScopes((prev) => [...prev, { ...EMPTY_SCOPE }])}
                  className="inline-flex items-center gap-1 text-sm text-brand-primary hover:underline"
                >
                  <Plus className="h-4 w-4" /> Add scope
                </button>
              </div>
              {scopes.map((scope, idx) => (
                <div key={idx} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center justify-between">
                    <select
                      value={scope.scope_type}
                      onChange={(e) =>
                        setScopes((prev) =>
                          prev.map((s, i) => (i === idx ? { ...s, scope_type: e.target.value as ScopeDraft["scope_type"] } : s)),
                        )
                      }
                      className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                    >
                      <option value="state">State</option>
                      <option value="senatorial_zone">Senatorial Zone</option>
                      <option value="lga">LGA</option>
                      <option value="ward">Ward</option>
                      <option value="polling_unit">Polling Unit</option>
                    </select>
                    {scopes.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setScopes((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-gray-400 hover:text-red-600"
                        aria-label="Remove scope"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {SCOPE_COLUMNS[scope.scope_type].map((col) => (
                      <div key={col}>
                        <Label htmlFor={`pp-scope-${idx}-${col}`}>
                          {col.replace("_id", "").replace("state", "State").replace("zone", "Zone").replace("lga", "LGA").replace("ward", "Ward").replace("polling_unit", "Polling Unit")} ID
                        </Label>
                        <Input
                          id={`pp-scope-${idx}-${col}`}
                          value={(scope as unknown as Record<string, string>)[col] ?? ""}
                          onChange={(e) =>
                            setScopes((prev) =>
                              prev.map((s, i) => (i === idx ? { ...s, [col]: e.target.value } : s)),
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {origin === "community_proposal" ? "Submit proposal" : "Create petition"}
              </button>
              <Link href="/portal/governance/participation" className="text-sm text-gray-500 hover:text-gray-800">
                Cancel
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
