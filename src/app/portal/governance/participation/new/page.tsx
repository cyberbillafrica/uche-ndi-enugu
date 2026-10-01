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
  createConsultation,
  resolveGovernanceAccess,
  type GovernanceAccess,
  type CreateConsultationInput,
  type GovernanceConsultationKind,
  type GovernanceConsultationQuestion,
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

const QUESTION_KINDS: Array<{ value: GovernanceConsultationQuestion["kind"]; label: string }> = [
  { value: "single_choice", label: "Single choice" },
  { value: "multi_choice", label: "Multiple choice" },
  { value: "likert", label: "Rating scale (Likert)" },
  { value: "short_text", label: "Short text" },
];

const BLANK_QUESTION: GovernanceConsultationQuestion = {
  id: "",
  kind: "single_choice",
  prompt: "",
  options: ["", ""],
};

export default function GovernanceParticipationNewPage() {
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [kind, setKind] = useState<GovernanceConsultationKind>("consultation");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [questions, setQuestions] = useState<GovernanceConsultationQuestion[]>([]);
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

  const buildScopesPayload = (): CreateConsultationInput["scopes"] =>
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

  const updateQuestion = (index: number, patch: Partial<GovernanceConsultationQuestion>) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const buildQuestionsPayload = (): GovernanceConsultationQuestion[] =>
    questions
      .filter((q) => q.prompt.trim() && q.id.trim())
      .map((q) => {
        const base: GovernanceConsultationQuestion = {
          id: q.id.trim(),
          kind: q.kind,
          prompt: q.prompt.trim(),
        };
        if (q.kind === "single_choice" || q.kind === "multi_choice") {
          base.options = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
        }
        if (q.kind === "likert") {
          base.scale = q.scale && q.scale >= 2 && q.scale <= 7 ? q.scale : 5;
        }
        return base;
      });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    setSubmitting(true);
    try {
      const id = await createConsultation({
        kind,
        title: title.trim(),
        description,
        instructions,
        questions: buildQuestionsPayload(),
        closesAt: closesAt || null,
        scopes: buildScopesPayload(),
      });
      toast.success("Instrument created as a draft.");
      router.push(`/portal/governance/participation/${id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create instrument."));
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
          manage_participation is required to create instruments.
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
          Participation
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-gray-900">New Instrument</h1>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Instrument</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="i-kind">Type *</Label>
              <select
                id="i-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as GovernanceConsultationKind)}
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="consultation">Consultation</option>
                <option value="survey">Survey</option>
              </select>
            </div>
            <div>
              <Label htmlFor="i-closes">Closes at (optional)</Label>
              <Input
                id="i-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="i-title">Title *</Label>
            <Input id="i-title" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" required />
          </div>
          <div>
            <Label htmlFor="i-desc">Description</Label>
            <textarea
              id="i-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="i-instr">Instructions for participants</Label>
            <textarea
              id="i-instr"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            Questions
            <button
              type="button"
              onClick={() =>
                setQuestions((prev) => [
                  ...prev,
                  { ...BLANK_QUESTION, id: `q${prev.length + 1}-${Math.random().toString(36).slice(2, 6)}` },
                ])
              }
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add question
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {questions.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-500">
              No questions yet — a consultation may open with an invitation for free-text input only.
            </p>
          )}
          {questions.map((q, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Question {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => setQuestions((prev) => prev.filter((_, j) => j !== i))}
                  className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove question"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <Label htmlFor={`q-prompt-${i}`}>Prompt *</Label>
                  <Input
                    id={`q-prompt-${i}`}
                    value={q.prompt}
                    onChange={(e) => updateQuestion(i, { prompt: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`q-kind-${i}`}>Answer type</Label>
                    <select
                      id={`q-kind-${i}`}
                      value={q.kind}
                      onChange={(e) => updateQuestion(i, { kind: e.target.value as GovernanceConsultationQuestion["kind"] })}
                      className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    >
                      {QUESTION_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {q.kind === "likert" && (
                    <div>
                      <Label htmlFor={`q-scale-${i}`}>Scale (2–7)</Label>
                      <Input
                        id={`q-scale-${i}`}
                        type="number"
                        min={2}
                        max={7}
                        value={q.scale ?? 5}
                        onChange={(e) => updateQuestion(i, { scale: Number(e.target.value) })}
                        className="mt-1"
                      />
                    </div>
                  )}
                </div>
                {(q.kind === "single_choice" || q.kind === "multi_choice") && (
                  <div>
                    <Label>Options (at least two)</Label>
                    <div className="mt-1 space-y-2">
                      {(q.options ?? []).map((opt, oi) => (
                        <div key={oi} className="flex items-center gap-2">
                          <Input
                            value={opt}
                            onChange={(e) =>
                              updateQuestion(i, {
                                options: (q.options ?? []).map((o, j) => (j === oi ? e.target.value : o)),
                              })
                            }
                            placeholder={`Option ${oi + 1}`}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateQuestion(i, { options: (q.options ?? []).filter((_, j) => j !== oi) })
                            }
                            className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                            aria-label="Remove option"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => updateQuestion(i, { options: [...(q.options ?? []), ""] })}
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-primary hover:underline"
                      >
                        <Plus className="h-3 w-3" />
                        Add option
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Geographic scope (optional)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-gray-500">
            Leave empty for a tenant-wide instrument. Scope-scoped managers must include at least one
            scope within their authority.
          </p>
          {scopes.map((s, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Scope {i + 1}</span>
                {scopes.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setScopes((prev) => prev.filter((_, j) => j !== i))}
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                    aria-label="Remove scope"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`s-type-${i}`}>Level</Label>
                  <select
                    id={`s-type-${i}`}
                    value={s.scope_type}
                    onChange={(e) => updateScope(i, { scope_type: e.target.value as ScopeDraft["scope_type"] })}
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="state">State</option>
                    <option value="senatorial_zone">Senatorial Zone</option>
                    <option value="lga">LGA</option>
                    <option value="ward">Ward</option>
                    <option value="polling_unit">Polling Unit</option>
                  </select>
                </div>
                {SCOPE_COLUMNS[s.scope_type].map((col) => (
                  <div key={col}>
                    <Label htmlFor={`s-${col}-${i}`}>
                      {col.replace("_id", "").replace("state", "State").replace("zone", "Zone").replace("lga", "LGA").replace("ward", "Ward").replace("polling_unit", "Polling Unit")} ID
                    </Label>
                    <Input
                      id={`s-${col}-${i}`}
                      value={(s as unknown as Record<string, string>)[col]}
                      onChange={(e) => updateScope(i, { [col]: e.target.value } as Partial<ScopeDraft>)}
                      className="mt-1"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setScopes((prev) => [...prev, { ...EMPTY_SCOPE }])}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-primary hover:underline"
          >
            <Plus className="h-4 w-4" />
            Add scope
          </button>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-50"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Create draft
        </button>
        <Link href="/portal/governance/participation" className="text-sm text-gray-500 hover:text-gray-700">
          Cancel
        </Link>
      </div>
    </form>
  );
}
