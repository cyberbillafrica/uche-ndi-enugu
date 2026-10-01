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
  createPoll,
  resolveGovernanceAccess,
  type GovernanceAccess,
  type CreatePollInput,
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

export default function GovernancePollNewPage() {
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
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
      if (!a.moduleEnabled || !a.canManageParticipation) {
        router.replace("/portal/governance");
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

  const buildScopesPayload = (): CreatePollInput["scopes"] =>
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
    if (!question.trim()) {
      toast.error("The poll question is required.");
      return;
    }
    const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
    if (cleanOptions.length < 2) {
      toast.error("A poll requires at least two options.");
      return;
    }
    if (new Set(cleanOptions).size !== cleanOptions.length) {
      toast.error("Poll options must be unique.");
      return;
    }
    setSubmitting(true);
    try {
      const id = await createPoll({
        title: title.trim(),
        question: question.trim(),
        options: cleanOptions,
        description,
        closesAt: closesAt || undefined,
        scopes: buildScopesPayload(),
      });
      toast.success("Poll created as a draft.");
      router.push(`/portal/governance/participation/polls/${id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create poll."));
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
        <CardContent className="py-16 text-center text-sm text-gray-600">
          manage_participation is required to create polls.
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/portal/governance/participation"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Participation
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-gray-900">New Poll</h1>
        <p className="text-sm text-gray-500">
          One question, fixed options, one vote per member. Content freezes once the poll opens.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Poll</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="pl-title">Title *</Label>
            <Input
              id="pl-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Ward road priority poll"
              required
            />
          </div>
          <div>
            <Label htmlFor="pl-question">Question *</Label>
            <Input
              id="pl-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="The single question voters will answer"
              required
            />
          </div>
          <div>
            <Label htmlFor="pl-desc">Description</Label>
            <textarea
              id="pl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="Optional context shown to voters"
            />
          </div>
          <div>
            <Label htmlFor="pl-closes">Closes at (optional)</Label>
            <Input
              id="pl-closes"
              type="datetime-local"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Options *</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={opt}
                onChange={(e) =>
                  setOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))
                }
                placeholder={`Option ${i + 1}`}
                maxLength={200}
              />
              <button
                type="button"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions((prev) => (prev.length > 2 ? prev.filter((_, j) => j !== i) : prev))}
                className="rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                disabled={options.length <= 2}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setOptions((prev) => [...prev, ""])}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-primary hover:underline"
          >
            <Plus className="h-4 w-4" />
            Add option
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Geographic scope</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {scopes.map((s, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`pl-scope-type-${i}`}>Scope {i + 1}</Label>
                <button
                  type="button"
                  aria-label={`Remove scope ${i + 1}`}
                  onClick={() => setScopes((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  disabled={scopes.length <= 1}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <select
                id={`pl-scope-type-${i}`}
                value={s.scope_type}
                onChange={(e) => updateScope(i, { scope_type: e.target.value as ScopeDraft["scope_type"] })}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="state">State (tenant-wide)</option>
                <option value="senatorial_zone">Senatorial zone</option>
                <option value="lga">LGA</option>
                <option value="ward">Ward</option>
                <option value="polling_unit">Polling unit</option>
              </select>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {SCOPE_COLUMNS[s.scope_type].map((col) => (
                  <div key={col}>
                    <Label htmlFor={`pl-scope-${i}-${col}`}>{col.replace("_id", "").replace("_", " ")}</Label>
                    <Input
                      id={`pl-scope-${i}-${col}`}
                      value={(s as unknown as Record<string, string>)[col] ?? ""}
                      onChange={(e) => updateScope(i, { [col]: e.target.value } as Partial<ScopeDraft>)}
                      placeholder={`${col.replace("_id", "").replace("_", " ")} id`}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setScopes((prev) => [...prev, { ...EMPTY_SCOPE, scope_type: prev[prev.length - 1].scope_type }])}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-primary hover:underline"
          >
            <Plus className="h-4 w-4" />
            Add scope
          </button>
          <p className="text-xs text-gray-400">
            Leave empty for a tenant-wide poll. Scope-scoped managers must attach at least one scope within their authority.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Create poll
        </button>
        <Link href="/portal/governance/participation" className="text-sm text-gray-500 hover:text-brand-primary">
          Cancel
        </Link>
      </div>
    </form>
  );
}
