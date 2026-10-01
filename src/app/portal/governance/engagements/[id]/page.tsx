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
  getEngagement,
  listEngagementScopes,
  listEngagementStakeholders,
  listEngagementAttendance,
  listEngagementIssues,
  listEngagementUpdates,
  updateEngagement,
  setEngagementStatus,
  setEngagementVisibility,
  linkEngagementEvent,
  unlinkEngagementEvent,
  addEngagementScope,
  removeEngagementScope,
  addEngagementStakeholder,
  removeEngagementStakeholder,
  recordEngagementAttendance,
  createEngagementIssue,
  updateEngagementIssue,
  createEngagementUpdate,
  removeEngagementAttendance,
  resolveGovernanceAccess,
  GOVERNANCE_ENGAGEMENT_STATUS_LABELS,
  type GovernanceAccess,
  type GovernanceEngagement,
  type GovernanceEngagementScope,
  type GovernanceEngagementStakeholder,
  type GovernanceEngagementAttendance,
  type GovernanceEngagementIssue,
  type GovernanceEngagementUpdate,
} from "@/lib/supabase";
import type { ScopeSpec } from "@/lib/supabase";

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

const SECTION_TABS = ["overview", "agenda", "stakeholders", "attendance", "issues", "updates"] as const;
type SectionTab = (typeof SECTION_TABS)[number];

const SECTION_LABELS: Record<SectionTab, string> = {
  overview: "Overview",
  agenda: "Agenda",
  stakeholders: "Stakeholders",
  attendance: "Attendance",
  issues: "Issues",
  updates: "Updates",
};

export default function GovernanceEngagementDetailPage({
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

  const [engagement, setEngagement] = useState<GovernanceEngagement | null>(null);
  const [scopes, setScopes] = useState<GovernanceEngagementScope[]>([]);
  const [stakeholders, setStakeholders] = useState<GovernanceEngagementStakeholder[]>([]);
  const [attendance, setAttendance] = useState<GovernanceEngagementAttendance[]>([]);
  const [issues, setIssues] = useState<GovernanceEngagementIssue[]>([]);
  const [updates, setUpdates] = useState<GovernanceEngagementUpdate[]>([]);
  const [loadError, setLoadError] = useState("");

  const [tab, setTab] = useState<SectionTab>("overview");
  const [busy, setBusy] = useState("");

  // Overview editing
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editScheduledAt, setEditScheduledAt] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editAgenda, setEditAgenda] = useState("");
  const [editOutcomes, setEditOutcomes] = useState("");
  const [editEventId, setEditEventId] = useState("");

  // Child forms
  const [newScope, setNewScope] = useState<ScopeDraft>({ ...EMPTY_SCOPE });
  const [stakeholderParticipantId, setStakeholderParticipantId] = useState("");
  const [stakeholderRole, setStakeholderRole] = useState("");
  const [stakeholderNote, setStakeholderNote] = useState("");
  const [attendanceParticipantId, setAttendanceParticipantId] = useState("");
  const [attendanceNote, setAttendanceNote] = useState("");
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [newIssueDetail, setNewIssueDetail] = useState("");
  const [newUpdateBody, setNewUpdateBody] = useState("");
  const [newUpdateIsPublic, setNewUpdateIsPublic] = useState(false);

  const load = useCallback(async () => {
    const e = await getEngagement(id);
    if (!e) {
      setLoadError("Engagement not found (or outside your tenant/visibility).");
      return;
    }
    const [s, st, att, iss, ups] = await Promise.all([
      listEngagementScopes(id),
      listEngagementStakeholders(id),
      listEngagementAttendance(id),
      listEngagementIssues(id),
      listEngagementUpdates(id),
    ]);
    setEngagement(e);
    setScopes(s);
    setStakeholders(st);
    setAttendance(att);
    setIssues(iss);
    setUpdates(ups);
    setEditTitle(e.title);
    setEditDescription(e.description);
    setEditScheduledAt(e.scheduled_at ? e.scheduled_at.slice(0, 16) : "");
    setEditLocation(e.location);
    setEditAgenda(JSON.stringify(e.agenda, null, 2));
    setEditOutcomes(e.outcomes);
    setEditEventId(e.event_id ?? "");
  }, [id]);

  // Presentation-only guard (every mutation is re-verified server-side by
  // the 0056 authority RPCs).
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
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load engagement.");
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

  if (loadError || !engagement) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-gray-600">
          {loadError || "Loading…"}
          <div className="mt-4">
            <Link href="/portal/governance/engagements" className="text-brand-primary hover:underline">
              ← Back to Engagements
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const canManage = access.canManageParticipation;
  const status = engagement.status;
  const sealed = status === "concluded";

  const attachScope = (scope: ScopeSpec) =>
    withBusy("add-scope", async () => {
      await addEngagementScope(id, scope);
      setNewScope({ ...EMPTY_SCOPE });
      toast.success("Scope attached.");
    });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/portal/governance/engagements"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Engagements
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-gray-900">{engagement.title}</h1>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            {GOVERNANCE_ENGAGEMENT_STATUS_LABELS[status]}
          </span>
          {engagement.is_public && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">Public</span>
          )}
        </div>
        <p className="font-mono text-xs text-gray-400">{engagement.reference_code}</p>
        {engagement.event_id && (
          <p className="text-xs text-gray-500">
            Linked Event: <span className="font-mono">{engagement.event_id}</span>
          </p>
        )}
      </div>

      {/* Section tabs — process sections, not separate modules */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200">
        {SECTION_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${
              tab === t ? "border-b-2 border-brand-primary text-brand-primary" : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {SECTION_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Engagement process</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-gray-700">
              {engagement.description && (
                <p className="whitespace-pre-wrap text-gray-600">{engagement.description}</p>
              )}
              <p>
                <span className="font-medium">Scheduled:</span>{" "}
                {engagement.scheduled_at ? new Date(engagement.scheduled_at).toLocaleString() : "—"}
                {engagement.held_at && (
                  <>
                    {" · "}
                    <span className="font-medium">Held:</span> {new Date(engagement.held_at).toLocaleString()}
                  </>
                )}
              </p>
              {engagement.location && (
                <p>
                  <span className="font-medium">Location:</span> {engagement.location}
                </p>
              )}
              {engagement.outcomes && (
                <p className="whitespace-pre-wrap">
                  <span className="font-medium">Outcomes:</span> {engagement.outcomes}
                </p>
              )}
              <p className="text-xs text-gray-400">
                Event content is managed in the Events module — this link never mutates the Event.
              </p>
            </CardContent>
          </Card>

          {canManage && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Lifecycle &amp; editing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {status === "draft" && (
                  <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="ge-edit-title">Title</Label>
                        <Input id="ge-edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                      </div>
                      <div>
                        <Label htmlFor="ge-edit-scheduled">Scheduled for</Label>
                        <Input
                          id="ge-edit-scheduled"
                          type="datetime-local"
                          value={editScheduledAt}
                          onChange={(e) => setEditScheduledAt(e.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="ge-edit-location">Location</Label>
                      <Input id="ge-edit-location" value={editLocation} onChange={(e) => setEditLocation(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="ge-edit-desc">Description</Label>
                      <textarea
                        id="ge-edit-desc"
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        rows={3}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <Label htmlFor="ge-edit-agenda">Agenda (JSON array — ids must be unique)</Label>
                      <textarea
                        id="ge-edit-agenda"
                        value={editAgenda}
                        onChange={(e) => setEditAgenda(e.target.value)}
                        rows={5}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={busy !== ""}
                      onClick={() =>
                        withBusy("save", async () => {
                          let parsedAgenda: GovernanceEngagement["agenda"] | undefined;
                          try {
                            parsedAgenda = JSON.parse(editAgenda) as GovernanceEngagement["agenda"];
                          } catch {
                            throw new Error("Agenda is not valid JSON.");
                          }
                          await updateEngagement(id, {
                            title: editTitle.trim(),
                            description: editDescription,
                            scheduledAt: editScheduledAt ? new Date(editScheduledAt).toISOString() : undefined,
                            clearScheduledAt: !editScheduledAt,
                            location: editLocation,
                            agenda: parsedAgenda,
                          });
                          toast.success("Draft updated.");
                        })
                      }
                      className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                    >
                      {busy === "save" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                      Save draft changes
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {status === "draft" && (
                    <>
                      <div className="flex items-end gap-2">
                        <div>
                          <Label htmlFor="ge-link-event">Link Event (optional)</Label>
                          <Input
                            id="ge-link-event"
                            value={editEventId}
                            onChange={(e) => setEditEventId(e.target.value)}
                            placeholder="Event id (same tenant)"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={busy !== ""}
                          onClick={() =>
                            withBusy("link-event", async () => {
                              await linkEngagementEvent(id, editEventId.trim());
                              toast.success("Event linked.");
                            })
                          }
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                        >
                          {busy === "link-event" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                          Link
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== ""}
                        onClick={() =>
                          withBusy("schedule", async () => {
                            await setEngagementStatus(id, "scheduled");
                            toast.success("Engagement scheduled.");
                          })
                        }
                        className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white hover:bg-brand-primary/90 disabled:opacity-60"
                      >
                        {busy === "schedule" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                        Schedule
                      </button>
                    </>
                  )}
                  {status === "scheduled" && (
                    <>
                      {engagement.event_id && (
                        <button
                          type="button"
                          disabled={busy !== ""}
                          onClick={() =>
                            withBusy("unlink-event", async () => {
                              await unlinkEngagementEvent(id);
                              toast.success("Event link removed.");
                            })
                          }
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                        >
                          {busy === "unlink-event" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                          Unlink Event
                        </button>
                      )}
                      <div className="w-full">
                        <Label htmlFor="ge-edit-outcomes">Outcomes (recorded at conclusion)</Label>
                        <textarea
                          id="ge-edit-outcomes"
                          value={editOutcomes}
                          onChange={(e) => setEditOutcomes(e.target.value)}
                          rows={3}
                          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={busy !== ""}
                        onClick={() =>
                          withBusy("conclude", async () => {
                            await setEngagementStatus(id, "concluded", editOutcomes);
                            toast.success("Engagement concluded — content is now sealed.");
                          })
                        }
                        className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                      >
                        {busy === "conclude" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                        Conclude engagement
                      </button>
                    </>
                  )}
                  {sealed && (
                    <div className="w-full rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      Concluded — the engagement record is sealed. Follow-up updates remain the live narrative.
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() =>
                      withBusy("visibility", async () => {
                        await setEngagementVisibility(id, !engagement.is_public);
                        toast.success(engagement.is_public ? "Removed from public projection." : "Added to public projection (opt-in).");
                      })
                    }
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                  >
                    {busy === "visibility" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                    {engagement.is_public ? "Make private" : "Publish engagement publicly (opt-in)"}
                  </button>
                  <p className="mt-1 text-xs text-gray-500">
                    Requires publish_accountability. Event visibility is independent — a public Event never exposes this
                    process record, its stakeholders, attendance, issues or follow-ups.
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
                              await removeEngagementScope(s.id);
                              toast.success("Scope removed.");
                            })
                          }
                          className="text-gray-400 hover:text-red-600 disabled:opacity-40"
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
                        <Label htmlFor={`ge-add-${col}`}>
                          {col.replace("_id", "").replace("_", " ")} ID
                        </Label>
                        <Input
                          id={`ge-add-${col}`}
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
                      attachScope({
                        scope_type: newScope.scope_type,
                        state_id: newScope.state_id || null,
                        zone_id: newScope.scope_type === "state" ? null : newScope.zone_id || null,
                        lga_id: ["state", "senatorial_zone"].includes(newScope.scope_type) ? null : newScope.lga_id || null,
                        ward_id: ["state", "senatorial_zone", "lga"].includes(newScope.scope_type) ? null : newScope.ward_id || null,
                        polling_unit_id: newScope.scope_type === "polling_unit" ? newScope.polling_unit_id : null,
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
        </div>
      )}

      {tab === "agenda" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Agenda</CardTitle>
          </CardHeader>
          <CardContent>
            {engagement.agenda.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No agenda items yet.</p>
            ) : (
              <ol className="list-inside list-decimal space-y-1 text-sm text-gray-700">
                {engagement.agenda.map((item) => (
                  <li key={item.id}>
                    <span className="font-medium">{item.title}</span>
                    {item.detail && <span className="text-gray-500"> — {item.detail}</span>}
                  </li>
                ))}
              </ol>
            )}
            {canManage && status === "draft" && (
              <p className="mt-3 text-xs text-gray-400">
                Edit the agenda on the Overview tab while the engagement is a draft. Sealing is server-enforced.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "stakeholders" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stakeholders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-500">
              Internal participants referenced by the existing Governance participant model — no new identity layer.
              Role labels are free text, never new roles.
            </p>
            {stakeholders.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No stakeholders recorded.</p>
            ) : (
              <ul className="space-y-1 text-sm text-gray-700">
                {stakeholders.map((s) => (
                  <li key={s.id} className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
                    <span>
                      <span className="font-medium">{s.role_label}</span>
                      {" · "}
                      <span className="font-mono text-xs">{s.participant_id}</span>
                      {s.note && <span className="text-gray-500"> — {s.note}</span>}
                    </span>
                    {canManage && (
                      <button
                        type="button"
                        disabled={busy !== ""}
                        onClick={() =>
                          withBusy(`stake-${s.id}`, async () => {
                            await removeEngagementStakeholder(s.id);
                            toast.success("Stakeholder removed.");
                          })
                        }
                        className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                        aria-label="Remove stakeholder"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && (
              <div className="rounded-lg border border-gray-200 p-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="ge-stake-participant">Participant ID</Label>
                    <Input
                      id="ge-stake-participant"
                      value={stakeholderParticipantId}
                      onChange={(e) => setStakeholderParticipantId(e.target.value)}
                      placeholder="governance participant id"
                    />
                  </div>
                  <div>
                    <Label htmlFor="ge-stake-role">Role label</Label>
                    <Input
                      id="ge-stake-role"
                      value={stakeholderRole}
                      onChange={(e) => setStakeholderRole(e.target.value)}
                      placeholder="e.g. Ward chair"
                      maxLength={80}
                    />
                  </div>
                  <div>
                    <Label htmlFor="ge-stake-note">Note (optional)</Label>
                    <Input
                      id="ge-stake-note"
                      value={stakeholderNote}
                      onChange={(e) => setStakeholderNote(e.target.value)}
                      maxLength={300}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("add-stakeholder", async () => {
                      await addEngagementStakeholder(id, stakeholderParticipantId.trim(), stakeholderRole.trim(), stakeholderNote);
                      setStakeholderParticipantId("");
                      setStakeholderRole("");
                      setStakeholderNote("");
                      toast.success("Stakeholder added.");
                    })
                  }
                  className="mt-3 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {busy === "add-stakeholder" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  <Plus className="h-4 w-4" /> Add stakeholder
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "attendance" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Attendance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-500">
              Staff-recorded roster against existing Governance participants. Attendance is never public and never an
              Event RSVP.
            </p>
            {attendance.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No attendance recorded.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Recorded</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Participant</th>
                      <th className="px-4 py-2 text-left font-medium text-gray-500">Note</th>
                      {canManage && <th className="px-4 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {attendance.map((a) => (
                      <tr key={a.id}>
                        <td className="px-4 py-2 text-gray-600">{new Date(a.recorded_at).toLocaleString()}</td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-700">{a.participant_id}</td>
                        <td className="px-4 py-2 text-gray-600">{a.note || "—"}</td>
                        {canManage && (
                          <td className="px-4 py-2 text-right">
                            <button
                              type="button"
                              disabled={busy !== ""}
                              onClick={() =>
                                withBusy(`att-${a.id}`, async () => {
                                  await removeEngagementAttendance(a.id);
                                  toast.success("Attendance entry removed.");
                                })
                              }
                              className="text-gray-400 hover:text-red-600 disabled:opacity-40"
                              aria-label="Remove attendance entry"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canManage && (
              <div className="rounded-lg border border-gray-200 p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ge-att-participant">Participant ID</Label>
                    <Input
                      id="ge-att-participant"
                      value={attendanceParticipantId}
                      onChange={(e) => setAttendanceParticipantId(e.target.value)}
                      placeholder="governance participant id"
                    />
                  </div>
                  <div>
                    <Label htmlFor="ge-att-note">Note (optional)</Label>
                    <Input
                      id="ge-att-note"
                      value={attendanceNote}
                      onChange={(e) => setAttendanceNote(e.target.value)}
                      maxLength={300}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("add-attendance", async () => {
                      await recordEngagementAttendance(id, attendanceParticipantId.trim(), attendanceNote);
                      setAttendanceParticipantId("");
                      setAttendanceNote("");
                      toast.success("Attendance recorded.");
                    })
                  }
                  className="mt-3 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {busy === "add-attendance" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  <Plus className="h-4 w-4" /> Record attendance
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "issues" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Issues raised</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-500">
              Engagement-local records. Linking to a Governance Request is an explicit, staff-authorized act — never
              automatic.
            </p>
            {issues.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No issues recorded.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {issues.map((i) => (
                  <li key={i.id} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-800">{i.title}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          i.status === "open"
                            ? "bg-amber-50 text-amber-700"
                            : i.status === "addressed"
                              ? "bg-blue-50 text-blue-700"
                              : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {i.status}
                      </span>
                    </div>
                    {i.detail && <p className="mt-1 text-gray-600">{i.detail}</p>}
                    {i.request_id && (
                      <p className="mt-1 font-mono text-xs text-gray-400">request: {i.request_id}</p>
                    )}
                    {canManage && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {(["open", "addressed", "closed"] as const)
                          .filter((s) => s !== i.status)
                          .map((s) => (
                            <button
                              key={s}
                              type="button"
                              disabled={busy !== ""}
                              onClick={() =>
                                withBusy(`issue-${i.id}-${s}`, async () => {
                                  await updateEngagementIssue(i.id, { status: s });
                                  toast.success(`Issue marked ${s}.`);
                                })
                              }
                              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                            >
                              Mark {s}
                            </button>
                          ))}
                        {!i.request_id && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={busy !== ""}
                              onClick={() => {
                                const rid = window.prompt("Governance Request id to link");
                                if (!rid) return;
                                void withBusy(`issue-${i.id}-link`, async () => {
                                  await updateEngagementIssue(i.id, { linkRequest: true, requestId: rid.trim() });
                                  toast.success("Issue linked to request.");
                                });
                              }}
                              className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                            >
                              Link request
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && (
              <div className="rounded-lg border border-gray-200 p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="ge-issue-title">Issue title</Label>
                    <Input
                      id="ge-issue-title"
                      value={newIssueTitle}
                      onChange={(e) => setNewIssueTitle(e.target.value)}
                      maxLength={200}
                    />
                  </div>
                  <div>
                    <Label htmlFor="ge-issue-detail">Detail (optional)</Label>
                    <Input
                      id="ge-issue-detail"
                      value={newIssueDetail}
                      onChange={(e) => setNewIssueDetail(e.target.value)}
                      maxLength={2000}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("add-issue", async () => {
                      await createEngagementIssue(id, { title: newIssueTitle.trim(), detail: newIssueDetail });
                      setNewIssueTitle("");
                      setNewIssueDetail("");
                      toast.success("Issue recorded.");
                    })
                  }
                  className="mt-3 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {busy === "add-issue" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  <Plus className="h-4 w-4" /> Record issue
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "updates" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Updates &amp; follow-ups</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-500">
              Follow-ups are updates — the canonical governance_updates substrate with engagement as its fifth subject.
            </p>
            {updates.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No updates yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {updates.map((u: GovernanceEngagementUpdate) => (
                  <li key={u.id} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-800">{u.title || "Update"}</span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{u.kind}</span>
                      {u.is_public && (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">public</span>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-gray-600">{u.body}</p>
                    <p className="mt-1 text-xs text-gray-400">{new Date(u.created_at).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
            )}
            {canManage && (
              <div className="rounded-lg border border-gray-200 p-3">
                <div>
                  <Label htmlFor="ge-update-body">Follow-up / update</Label>
                  <textarea
                    id="ge-update-body"
                    value={newUpdateBody}
                    onChange={(e) => setNewUpdateBody(e.target.value)}
                    rows={3}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    placeholder="Delivery narrative for this engagement"
                  />
                </div>
                <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={newUpdateIsPublic}
                    onChange={(e) => setNewUpdateIsPublic(e.target.checked)}
                  />
                  Publish this update publicly (requires publish_accountability)
                </label>
                <button
                  type="button"
                  disabled={busy !== ""}
                  onClick={() =>
                    withBusy("add-update", async () => {
                      await createEngagementUpdate(id, {
                        body: newUpdateBody,
                        isPublic: newUpdateIsPublic,
                      });
                      setNewUpdateBody("");
                      setNewUpdateIsPublic(false);
                      toast.success("Update recorded.");
                    })
                  }
                  className="mt-3 inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {busy === "add-update" && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                  <Plus className="h-4 w-4" /> Add update
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
