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
  createEngagement,
  resolveGovernanceAccess,
  type GovernanceAccess,
  type CreateEngagementInput,
  type GovernanceEngagementAgendaItem,
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

const BLANK_ITEM: GovernanceEngagementAgendaItem = { id: "", title: "", detail: "" };

export default function GovernanceEngagementNewPage() {
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [eventId, setEventId] = useState("");
  const [agenda, setAgenda] = useState<GovernanceEngagementAgendaItem[]>([{ ...BLANK_ITEM }]);
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

  const buildScopesPayload = (): CreateEngagementInput["scopes"] =>
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

  const buildAgendaPayload = (): GovernanceEngagementAgendaItem[] =>
    agenda
      .filter((a) => a.id.trim() && a.title.trim())
      .map((a, i) => ({
        id: a.id.trim() || `item-${i + 1}`,
        title: a.title.trim(),
        ...(a.detail?.trim() ? { detail: a.detail.trim() } : {}),
      }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required.");
      return;
    }
    const ids = buildAgendaPayload().map((a) => a.id);
    if (new Set(ids).size !== ids.length) {
      toast.error("Agenda item ids must be unique.");
      return;
    }
    setSubmitting(true);
    try {
      const id = await createEngagement({
        title: title.trim(),
        description,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        location,
        agenda: buildAgendaPayload(),
        eventId: eventId.trim() || undefined,
        scopes: buildScopesPayload(),
      });
      toast.success("Engagement created as a draft.");
      router.push(`/portal/governance/engagements/${id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create engagement."));
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
          manage_participation is required to create engagements.
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/portal/governance/engagements"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-brand-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Engagements
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-gray-900">New Engagement</h1>
        <p className="text-sm text-gray-500">
          The Governance process record — the Event link is optional and the Event is never modified.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Engagement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="e-title">Title *</Label>
            <Input
              id="e-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Ward 5 constituency town hall"
              required
            />
          </div>
          <div>
            <Label htmlFor="e-desc">Description / purpose</Label>
            <textarea
              id="e-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="What this engagement is for"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-scheduled">Scheduled for</Label>
              <Input
                id="e-scheduled"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="e-location">Location</Label>
              <Input
                id="e-location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Venue or meeting point"
                maxLength={300}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="e-event">Event link (optional)</Label>
            <Input
              id="e-event"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              placeholder="Event id from the Events module (public calendar presence)"
            />
            <p className="mt-1 text-xs text-gray-400">
              Optional one-way link — the Event stays untouched and keeps its own visibility.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Agenda</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {agenda.map((item, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-500">Item {i + 1}</span>
                <button
                  type="button"
                  aria-label={`Remove agenda item ${i + 1}`}
                  onClick={() => setAgenda((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  disabled={agenda.length <= 1}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-1 grid gap-2 sm:grid-cols-[1fr_2fr]">
                <Input
                  value={item.id}
                  onChange={(e) =>
                    setAgenda((prev) => prev.map((a, j) => (j === i ? { ...a, id: e.target.value } : a)))
                  }
                  placeholder="id (e.g. item-1)"
                  maxLength={64}
                />
                <Input
                  value={item.title}
                  onChange={(e) =>
                    setAgenda((prev) => prev.map((a, j) => (j === i ? { ...a, title: e.target.value } : a)))
                  }
                  placeholder="Agenda item title"
                  maxLength={200}
                />
              </div>
              <Input
                value={item.detail ?? ""}
                onChange={(e) =>
                  setAgenda((prev) => prev.map((a, j) => (j === i ? { ...a, detail: e.target.value } : a)))
                }
                placeholder="Optional detail"
                maxLength={1000}
                className="mt-2"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setAgenda((prev) => [...prev, { ...BLANK_ITEM, id: `item-${prev.length + 1}` }])}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-primary hover:underline"
          >
            <Plus className="h-4 w-4" />
            Add agenda item
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
                <Label htmlFor={`e-scope-type-${i}`}>Scope {i + 1}</Label>
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
                id={`e-scope-type-${i}`}
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
                    <Label htmlFor={`e-scope-${i}-${col}`}>{col.replace("_id", "").replace("_", " ")}</Label>
                    <Input
                      id={`e-scope-${i}-${col}`}
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
            Leave empty for a tenant-wide engagement. Scope-scoped managers must attach at least one scope within their authority.
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
          Create engagement
        </button>
        <Link href="/portal/governance/engagements" className="text-sm text-gray-500 hover:text-brand-primary">
          Cancel
        </Link>
      </div>
    </form>
  );
}
